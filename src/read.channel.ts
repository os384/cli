#!/usr/bin/env -S deno run  --allow-all

/*
 * Copyright (C) 2019-2021 Magnusson Institute
 * Copyright (C) 2022-2026 384, Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

// scratch, for various more advanced capabilities of reading/streaming a channel

// @deno-types="../dist/384.esm.d.ts"
import '../keys.js'
import '../config.js'

import { ChannelApi, ChannelStream, ChannelStreamOptions, Channel, extractPayload } from "../dist/384.esm.js"
import { Command } from "https://deno.land/x/cliffy/command/mod.ts";

const SEP = '\n' + '='.repeat(86) + '\n';
const prefix = "[read.channel.ts] "

async function readChannelRaw(privateKey: string, debug: boolean = false) {
    console.log("===== RAW MESSAGES (keys) =====")
    const c = await new Channel(privateKey).ready
    const m = await c.getMessageKeys()
    console.log(m)
    console.log("==== RAW MESSAGES (binary) ====")
    const messagePayloads = await c.getRawMessageMap(m.keys)
    console.log(messagePayloads)
    console.log("==== RAW MESSAGES (payloads) ====")
    for (const [k, v] of messagePayloads) {
        try {
            console.log(k, extractPayload(v).payload)
            console.log("--------------------------------")
        } catch (e) {
           console.warn(SEP, "[extractPayload] Failed extract and/or to validate message:", SEP, v, SEP, e, SEP)
        }
    }
    console.log("==== RAW MESSAGES (extracted) ====")
    for (const [k, v] of messagePayloads) {
        try {
            console.log(k, await c.extractMessage(extractPayload(v).payload, debug))
            console.log("--------------------------------")
        } catch (e) {
           console.warn(SEP, "[extractPayload] Failed extract and/or to validate message:", SEP, v, SEP, e, SEP)
        }
    }
    console.log("==== END RAW MESSAGES ====")
}

async function displayJpeg(buffer: ArrayBuffer) {
  // Convert ArrayBuffer to Uint8Array
  const uint8Array = new Uint8Array(buffer);
  
  // Create a temporary file
  const tempFile = await Deno.makeTempFile({
    suffix: '.jpg'
  });
  
  try {
    // Write the buffer to the temp file
    await Deno.writeFile(tempFile, uint8Array);
    
    // Use 'open' command on macOS to display the image
    const command = new Deno.Command('open', {
      args: [tempFile],
    });
    
    const { code } = await command.output();
    
    if (code !== 0) {
      throw new Error(`Failed to open image. Exit code: ${code}`);
    }
  } finally {
    // Clean up: remove the temporary file after a delay
    // (giving time for the 'open' command to read it)
    setTimeout(async () => {
      try {
        await Deno.remove(tempFile);
      } catch (error) {
        console.error('Error cleaning up temp file:', error);
      }
    }, 1000);
  }
}

function perMessage(m: any) {
    console.log(m)
    if (m.type && m.type === "thumbNail" && m.data instanceof ArrayBuffer) {
        displayJpeg(m.data)
    }
}

async function readChannel(privateKey: string, quiet: boolean, message: boolean, live: boolean, first: number, last:number, reverse: boolean, json: boolean, raw: boolean, debug = false) {

    if (raw) {
        await readChannelRaw(privateKey, debug)
        return
    }

    const c = await new ChannelStream(privateKey).ready
    const body = !message
    const info = !quiet

    if (live && json) throw new Error("Live streaming not supported with JSON output.");
    if (first && last) throw new Error("Can't use both first and last options.");
    if (reverse && live) throw new Error("Cannot reverse from live feed (do two ops).");

    if (info) console.log(SEP, prefix, "\n", "Channel public keys: \n", await c.getPubKeys(), SEP)
    if (info) console.log(SEP, prefix, "\n", "Channel full handle: \n", c.handle, SEP)
    if (info) console.log(SEP, prefix, "\n", "Reading channel messages from channelId:", c.channelId, SEP)

    const options: ChannelStreamOptions = {}
    if (live) options.live = true
    if (reverse) {
        options.start = Infinity
        options.end = 0
    }

    if (json) {
        if (first || last) throw new Error("Combining JSON with 'first' or 'last' not implemented yet.");
        const messages = await (await c.spawn(options)).toArray();
        console.log(JSON.stringify(messages, null, 2));
    } else {
        if (first) {
            await (await c.spawn(options)).take(first).forEach(async (m) => console.log(body ? m.body : m));
        } else if (last) {
            if (reverse) {
                // if the user wants the results in reverse, then it's easy
                await (await c.spawn(options)).take(last).forEach(async (m) => console.log(body ? m.body : m));
            } else {
                // otherwise, we first have to find the correct server time stamp, and start from there
                options.start = Infinity
                options.end = 0
                options.live = false // override for now to get the Nth message from the end
                const m = await (await c.spawn(options)).take(last).last()
                if (!m) throw new Error("No last message found found.")
                options.start = m.serverTimestamp
                options.end = Infinity
                if (live) {
                    options.live = true // reinstate it
                    await (await c.spawn(options)).forEach(async (m) => perMessage(body ? m.body : m));
                } else {
                    await (await c.spawn(options)).take(last).forEach(async (m) => perMessage(body ? m.body : m));
                }
            }
        } else {
            await (await c.spawn(options)).forEach(async (m) => perMessage(body ? m.body : m));
        }
    }
}
    
await new Command()
    .name("read.channel.ts")
    .version("1.0.0")
    .description(`
        Reads contents of a channel using spawn(). You must provide private key (with which to connect).
        If you provide both '--tail' and '--live', it will be interpreted as the latest 'n' messages,
        and then the live stream will start from there. Note: JSON output can't be live.

  `)
    .option("-k, --key <key:string>", "Private key to use.", { required: true })
    .option("-q, --quiet", "Do not show any output other than just the messages.", { default: false })
    .option("-m, --message", "Whole message (default is just body).", { default: false })
    .option("-l, --live", "Enable live streaming (keep connection).", { default: false })
    .option("-f, --first <first:number>", "Only read FIRST 'n' messages.", { required: false })
    .option("-t, --tail <tail:number>", "Only read LAST 'n' messages.", { required: false })
    .option("-r, --reverse", "Reverse order of messages.", { default: false })
    .option("-j, --json", "Output in JSON format.", { default: false })
    .option("-w, --raw", "Fetch raw messages, no filtering (or unpackaging).", { default: false })
    .option("-d, --debug", "Show debug information.", { default: false })
    .action(async ({ key, quiet, message, live, first, tail, reverse, json, raw, debug }) => {
        new ChannelApi(configuration.channelServer); // for side effect
        await readChannel(key, quiet, message, live, first, tail, reverse, json, raw, debug);
    })
    .parse(Deno.args);
