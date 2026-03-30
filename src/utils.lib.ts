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

import '../env.js'
import '../config.js'
const configuration = (globalThis as any).configuration

export const SEP = '\n' + '='.repeat(86) + '\n'
export const SEP_ = '-'.repeat(86) + '\n'

// @deno-types="../dist/384.esm.d.ts"
import {
    ChannelApi, SBStorageToken, generateStorageToken,
} from "../dist/384.esm.js"

// no this needs to be on a per-command basis
// export const SB = new ChannelApi(configuration.channelServer, /* configuration.DBG */ true)


// we have our own mock version of this for test management
export class LocalStorage {
    private filePath: string;
    private data: Record<string, any>;
    constructor(filePath: string) {
        this.filePath = filePath;
        this.data = this.loadData();
    }
    private loadData(): Record<string, any> {
        try {
            const text = Deno.readTextFileSync(this.filePath);
            return JSON.parse(text);
        } catch {
            return {};
        }
    }
    private saveData(): void {
        Deno.writeTextFileSync(this.filePath, JSON.stringify(this.data));
    }
    public getItem(key: string): any {
        return this.data[key];
    }
    public setItem(key: string, value: any): void {
        this.data[key] = value;
        this.saveData();
    }
    public removeItem(key: string): void {
        delete this.data[key];
        this.saveData();
    }
    public clear(): void {
        this.data = {};
        this.saveData();
    }
}


/**
 * Storage token related utilities.
 */

// default size of token created
export const DEFAULT_STORAGE_TOKEN_SIZE = 60 * 1024 * 1024 * 1024 // 60 GB

const CHANNEL_SERVER_WORKING_DIRECTORY = "../channels-cloudflare"

export interface RefreshTokenOptions {
    local?: boolean // local or remote server
    size?: number // bytes requested
    tokenHash?: string // if provided, this is refreshed (and returned)
}

/**
 * If token is provided, 'refreshes' (re-authorizes) it, otherwise creates a new
 * one. If size isn't provided, defaults to above default. Must be run from
 * channel server directory.
 */
export async function refreshToken(options: RefreshTokenOptions): Promise<string | null> {
    // will execute something like this:
    //
    //   wrangler kv:key put --preview false --binding=LEDGER_NAMESPACE "LM2r...." '{"hash": "LM2r...", "used":false,"size":60000000000, "motherChannel": "<WRANGLER Command Line>"}'
    //
    // (optionally with '--local' flag)

    // if you have channel server running off a parallel directory, then this should
    // work. upon success returns the token hash (which will be new if you didn't
    // provide one)

    try {
        const SB = new ChannelApi(configuration.channelServer, configuration.DBG)
        console.log(SEP_, "Running refresh token. SB version", SB.version, SEP_)
        const {
            local = configuration.configServerType === 'local',
            size = DEFAULT_STORAGE_TOKEN_SIZE,
            tokenHash = generateStorageToken()
        } = options
        // this is the format that the servers use for tracking status of tokens
        const token: SBStorageToken = {
            hash: tokenHash!,
            used: false,
            size: size,
            motherChannel: "<WRANGLER/CLI>", // since we're command line
        }
        console.log(SEP, "Will set token to:\n", JSON.stringify(token, null, 2), '\n', SEP)
        const tokenString = JSON.stringify(token)
        let process: any
        if (local) {
            console.log(`Refreshing storage token - local (${configuration.channelServer})`)
            process = Deno.run({
                cmd: ["wrangler", "kv:key", "put", "--preview", "--binding=LEDGER_NAMESPACE", "--local", tokenHash, tokenString],
                stdout: "piped",
                stderr: "piped",
                cwd: CHANNEL_SERVER_WORKING_DIRECTORY,
            });
        } else {
            console.log(`Refreshing storage token - NOT local (${configuration.channelServer})`)
            // this will hit the ledger name space in [env.development] and preview
            process = Deno.run({
                cmd: ["wrangler", "kv:key", "put", "--preview", "false", "--binding=LEDGER_NAMESPACE", tokenHash, tokenString],
                stdout: "piped",
                stderr: "piped",
                cwd: CHANNEL_SERVER_WORKING_DIRECTORY,
            });
        }

        const { code } = await process.status();
        console.log("Refreshed storage token - process status:", code)
        if (code !== 0) {
            const rawErrorOutput = await process.stderrOutput();
            const errorOutput = new TextDecoder().decode(rawErrorOutput);
            console.error(`Refreshing storage token failed: ${errorOutput}`);
            // process.stdout.close();
            // process.stderr.close();
            process.close();
            throw new Error("Refreshing storage token failed");
        } else {
            // If the process completes successfully, also ensure to close all streams
            console.log("Refreshed storage token - successful")
            // and i want to output the stdout results
            const rawOutput = await process.output();
            const output = new TextDecoder().decode(rawOutput);
            console.log(output);
            // process.stdout.close();
            process.stderr.close();
            process.close();
            return tokenHash!
        }

    } catch (error: any) {
        // if it's "No such file or directory" then we need to tell the user what directory to run the test script from
        if (error.message && error.message.includes("No such file or directory")) {
            console.info(
                "\n",
                "================================================================================\n",
                "This needs to run from channel server directory (or token generation won't work)\n",
                "================================================================================\n")
        } else {
            console.error("Got an error trying to run wrangler command line, and it wasn't 'no such file':", error)
            throw (error)
        }
        return null
    }
}
