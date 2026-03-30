#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env

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

// even though 384cli subsumes this function, we leave this as standalone since
// the build pipe for 384cli itself depends on this, so if 384cli is at any
// point broken, then lib384 can't be built

import '../env.js'
import '../config.js'

// @deno-types="../dist/384.esm.d.ts"
import { ChannelApi, Channel, browser, utils, isTextLikeMimeType, serverApiCosts } from "../dist/384.esm.js";

// import { Command } from "https://deno.land/x/cliffy/command/mod.ts";
//import { Command } from "@cliffy/command";
import { Command } from "jsr:@cliffy/command@1.0.0-rc.7";


const PREFIX_LENGTH = 8;

const MiB = 1024 * 1024;
const TOP_UP_INCREMENT = 16 * MiB;

const SEP = '\n' + '='.repeat(86) + '\n';

function arrayBufferToText(arrayBuffer: ArrayBuffer) {
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(new Uint8Array(arrayBuffer));
}

async function publishFileAsPage(filePath: string, name: string, channelServer: string, prefixLength: number, privateKey?: string) {
    console.log("Publishing file as Page: ", filePath, name, channelServer, privateKey);
    const SB = new ChannelApi(channelServer || configuration.channelServer, false);
    const budgetChannel = SB.connect(configuration.budgetKey);

    const fileName = name || filePath.split('/').pop();

    let pageChannel: Channel;
    if (privateKey) {
        pageChannel = await new Channel(privateKey).ready;
        pageChannel.channelServer = channelServer || configuration.channelServer;
        try {
            const channelKeys = await pageChannel.getChannelKeys();
            console.log("Channel keys: ", channelKeys);
        } catch (e: any) {
            if (e.message && e.message.includes("No such channel")) {
                console.log(SEP, "Channel not found, registering and funding ...", SEP);
                const storageToken = await budgetChannel.getStorageToken(TOP_UP_INCREMENT);
                pageChannel = await pageChannel.create(storageToken);
                console.log("Channel created: ", pageChannel.handle);
            } else {
                console.log(SEP, "Error connecting to channel with private key: ", e, SEP);
                Deno.exit(1);
            }
        }
    } else {
        console.log(SEP, "No private key provided, creating a new channel for this file", SEP);
        pageChannel = await SB.connect(await SB.create(budgetChannel)).ready;
    }

    const data = await Deno.readFile(filePath);
    const bytes = new Uint8Array(data.buffer);
    const type = browser.getMimeType(filePath);
    if (!type) throw new Error("Could not determine file type");

    const prefix = pageChannel.hashB32.slice(0, prefixLength);
    const fileURL = `${channelServer || configuration.channelServer}/api/v2/page/${prefix}/${fileName}`;

    const printUrl = () => {
        console.log(SEP, `Working full URL (file type '${type}')\n`, fileURL, SEP);
    };

    const result = await fetch(fileURL);
    if (isTextLikeMimeType(type)) {
        const fetchedFile = await result.text();
        const newFile = arrayBufferToText(bytes);
        if (fetchedFile === newFile) {
            console.log("File is already deployed (text) and unchanged");
            printUrl();
            return;
        }
    } else {
        const fetchedFile = await result.arrayBuffer();
        if (utils.compareBuffers(fetchedFile, bytes)) {
            console.log("File is already deployed (binary) and unchanged");
            printUrl();
            return;
        }
    }

    let availableStorage = (await pageChannel.getStorageLimit()).storageLimit;
    const costOfNewPage = bytes.length * serverApiCosts.CHANNEL_STORAGE_MULTIPLIER;
    if (availableStorage < costOfNewPage) {
        console.log(`.. available storage (${availableStorage / MiB} MiB) a bit low ... topping up`);
        const topUpAmount = Math.max(TOP_UP_INCREMENT, costOfNewPage * 2);
        console.log(`.. will try to top up from budgetChannel by ${topUpAmount / MiB} MiB ...`);
        const reply = await budgetChannel.budd({ targetChannel: pageChannel.handle, size: topUpAmount });
        // if (DBG0) console.log("Topped up storage reply: ", reply);
        availableStorage = (await pageChannel.getStorageLimit()).storageLimit;
    }
    console.log("Available storage (possibly after topup): ", availableStorage / MiB, "MiB");

    let rez;
    try {
        rez = await pageChannel.setPage({ page: bytes, type: type, prefix: prefixLength });
    } catch (e) {
        console.log("Error setting page: \n", e);
        Deno.exit(1);
    }
    if (!rez) throw new Error("Could not set page");
    console.log(rez);

    if (!privateKey) {
        console.log(
            SEP, "No Page deployment channel provided, create a new one - keep track of this key:\n",
            JSON.stringify({
                userPrivateKey: pageChannel.userPrivateKey,
                channelServer: pageChannel.channelServer
            }, null, 2),
            SEP, "The above private key is what you would give as second parameter to this command to update", SEP
        );
    } else {
        console.log("\n", SEP, "New Page contents succesfully deployed.",
            "Note that it can take several seconds or even\na minute for the file to be updated", SEP);
    }

    printUrl();
}

await new Command()
    .name("publish.page.ts")
    .version("1.0.0")
    .description(`
    Publish a file as a Page on the channel server.
    If a private key is provided, it will use that key.
    Otherwise, it will generate a new key.
    If the key does not correspond to an existing channel, it will register it.
    If there's not enough storage, the budget will be topped up.
    Note that it will always check if the file is already published.
    If the page already exists, then it will only update if the file has changed.
  `)
    .option("-k, --key <key:string>", "Private key to use (optional)", { default: undefined })
    .option("-f, --file <file:string>", "File to upload", { required: true })
    .option("-n, --name <name:string>", "Name to use for file (if omitted will use '-f' value)", { default: undefined })
    .option("-c, --channelServer <channelServer:string>", "Channel server to use (if omitted will use configuration)", { default: configuration.channelServer })
    .option("-p, --prefix <prefix:number>", "Prefix length to use (if omitted will use 8)", { default: PREFIX_LENGTH })
    .action(async ({ file, name, channelServer, key, prefix }) => {
        name = name ? name : file;
        console.log("----\n", file, '\n', name,'\n', channelServer, '\n', key, "\n----")
        await publishFileAsPage(file, name ? name : file, channelServer, prefix, key );
    })
    .parse(Deno.args);

