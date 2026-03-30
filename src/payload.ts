#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env

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

const VERSION = "20250219.0"

const DBG0 = false

import { Command, ValidationError } from "jsr:@cliffy/command@1.0.0-rc.7";

import type { } from "./domTypes.ts"; // to allow Deno to compile various browser code in lib384

// @deno-types="../dist/384.esm.d.ts"
import { 
    assemblePayload, extractPayload
} from "../dist/384.esm.js";


await new Command()
    .name("payload")
    .version(VERSION)
    .description('Translate between 384 "payload" binary wire format and JSON')
    .action(function () { this.showHelp(); })

    .command("encode")
    .description("Encode a JSON object as a 384 binary payload")
    .option("-i, --input <file:string>", "Input file", { required: true})
    .option("-o, --output <file:string>", "Output file", { required: true})
    .action(async (options, _) => {
        console.log("Encoding payload...");
        const input = options.input;
        const output = options.output;

        const data = await Deno.readFile(input);
        // Parse the data as a JSON object
        const contents = JSON.parse(new TextDecoder().decode(data));

        // Echo the contents of the input file to the console
        if (DBG0) { console.log("Encoding:", contents); }

        // Encode the object as a payload
        const payload = await assemblePayload(contents);
        // Ensure that the returned payload is an ArrayBuffer
        if (!(payload instanceof ArrayBuffer)) {
            throw new ValidationError("Payload must be an ArrayBuffer");
        } else {
            if (DBG0) { console.log("👍 Payload is an ArrayBuffer"); }
        }

        // Convert the ArrayBuffer to Uint8Array
        const uint8ArrayPayload = new Uint8Array(payload);

        // Ensure that the payload starts with [0xAA, 0xBB, 0xBB, 0xAA]
        if (uint8ArrayPayload.slice(0, 4).join() !== [0xAA, 0xBB, 0xBB, 0xAA].join()) {
            throw new ValidationError("Payload must start with [0xAA, 0xBB, 0xBB, 0xAA]");
        } else {
            if (DBG0) { console.log("👍 Payload starts with [0xAA, 0xBB, 0xBB, 0xAA]"); }
        }

        // Write the payload to the output file
        await Deno.writeFile(output, uint8ArrayPayload);

        Deno.exit(0);
    })

    .command("decode")
    .description("Decode a 384 binary payload as a JSON object")
    .option("-i, --input <file:string>", "Input file", { required: true})
    .option("-o, --output <file:string>", "Output file", { required: true})
    .action(async (options, _) => {
        console.log("Decoding payload...");
        const input = options.input;
        const output = options.output;

        const data = await Deno.readFile(input);
        // Ensure that the data starts with [0xAA, 0xBB, 0xBB, 0xAA]
        if (data.slice(0, 4).join() !== [0xAA, 0xBB, 0xBB, 0xAA].join()) {
            throw new ValidationError("Data must start with [0xAA, 0xBB, 0xBB, 0xAA]");
        } else {
            if (DBG0) { console.log("👍 Data starts with [0xAA, 0xBB, 0xBB, 0xAA]"); }
        }

        // Convert to an ArrayBuffer
        const buffer = data.buffer;
        // Ensure that the buffer is an ArrayBuffer
        if (!(buffer instanceof ArrayBuffer)) {
            throw new ValidationError("Data must be an ArrayBuffer");
        } else {
            if (DBG0) { console.log("👍 Data is an ArrayBuffer"); }
        }

        // Parse the data as a Payload object
        const payload = await extractPayload(buffer).payload;

        // Echo the payload to the console
        if (DBG0) { console.log("Extracted payload:", payload); }

        // Convert the payload to a JSON object before writing
        const contents = JSON.stringify(payload);
        // Convert the contents to Uint8Array before writing
        const encodedContents = new TextEncoder().encode(contents);
        // Write the contents to the output file
        await Deno.writeFile(output, encodedContents);

        Deno.exit(0);
    })
    .parse(Deno.args);