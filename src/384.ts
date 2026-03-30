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

// const VERSION = "20250316.1" ... wow it's been a year
const VERSION = "20260330.2 (1.0.0.rc2.48)" // toggle import below for lib384 as well if needed

const DBG0 = false

import { Command, ValidationError } from "jsr:@cliffy/command@1.0.0-rc.7";

// domTypes.ts was needed for 'deno compile' to handle browser types in lib384.
// Not needed at runtime; commented out so 384.ts can be deployed as a standalone
// file via channel pages without requiring local file resolution.
// import type { } from "./domTypes.ts";

// lib384 deployed via channel page (os384 self-hosts its own dependencies)
// it's always safe to bump the (date based) version (to bust Deno caching as needed)
import {
    SB384, ChannelApi, Channel, ChannelStream, SBServerInfo, SBUserPrivateKey, SBStorageToken,
    browser, utils, isTextLikeMimeType, serverApiCosts, getMimeType, ObjectHandle, stringify_ObjectHandle,
    sbCrypto, base62ToArrayBuffer, arrayBufferToBase62, generatePassPhrase, SBFileSystem, FileSetMeta,
    ChannelHandle, SBFile, extractPayload,
} from "https://c3.384.dev/api/v2/page/H93wQduy/384.esm.20260330.2.js";

// lib384 via JSR (future — pending Deno/TypeScript version compatibility)
// import {
//     SB384, ChannelApi, Channel, ChannelStream, SBServerInfo, SBUserPrivateKey, SBStorageToken,
//     browser, utils, isTextLikeMimeType, serverApiCosts, getMimeType, ObjectHandle, stringify_ObjectHandle,
//     sbCrypto, base62ToArrayBuffer, arrayBufferToBase62, generatePassPhrase, SBFileSystem, FileSetMeta,
//     ChannelHandle, SBFile, extractPayload,
// } from "@384/lib";

// LocalStorage is inlined here (from cli/src/LocalStorage.ts) so that 384.ts
// can be published and installed as a single standalone file via channel pages,
// without needing to resolve relative imports.
class LocalStorage {
    private dbName: string;
    private dbPath: string;
    private data: Record<string, any>;
    private currentVersion: number;
    private journalFile: string;
    private flushPromise: Promise<void> | null = null;
    private initPromise: Promise<void>;
    private journalHandle: Deno.FsFile | null = null;

    constructor(dbName: string, private baseDirectory: string = '.') {
        if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
            throw new Error("Invalid database name (alphanumeric and '_' only)");
        }
        this.dbName = dbName;
        this.dbPath = `${this.baseDirectory}/db/${dbName}`;
        const { version, data, needsFlush } = this.findLatestState();
        this.currentVersion = version;
        this.data = data;
        this.journalFile = `${this.dbPath}.${this.currentVersion + 1}.journal.txt`;
        if (needsFlush) {
            this.initPromise = this.flush();
        } else {
            this.initPromise = Promise.resolve();
        }
    }

    private async openJournal() {
        if (this.journalHandle) {
            this.journalHandle.close();
        }
        this.journalHandle = await Deno.open(this.journalFile, {
            create: true,
            append: true,
            write: true
        });
    }

    private findLatestState(): { version: number, data: Record<string, any>, needsFlush: boolean } {
        try {
            const files = [...Deno.readDirSync(`${this.baseDirectory}/db`)]
                .map(f => f.name)
                .filter(name => name.startsWith(this.dbName));
            let maxDbVersion = 999;
            let maxJournalVersion = 999;
            let latestDb: string | null = null;
            let latestJournal: string | null = null;
            for (const file of files) {
                const dbMatch = file.match(/\.(\d+)\.json$/);
                const journalMatch = file.match(/\.(\d+)\.journal\.txt$/);
                if (dbMatch) {
                    const version = parseInt(dbMatch[1]);
                    if (version > maxDbVersion) {
                        maxDbVersion = version;
                        latestDb = file;
                    }
                }
                if (journalMatch) {
                    const version = parseInt(journalMatch[1]);
                    if (version > maxJournalVersion) {
                        maxJournalVersion = version;
                        latestJournal = file;
                    }
                }
            }
            let data: Record<string, any> = {};
            if (latestDb) {
                data = JSON.parse(Deno.readTextFileSync(`${this.baseDirectory}/db/${latestDb}`));
            }
            const needsFlush = (latestJournal != null) && ((latestDb === null) || maxJournalVersion > maxDbVersion);
            if (latestJournal) {
                const journal = Deno.readTextFileSync(`${this.baseDirectory}/db/${latestJournal}`);
                for (const line of journal.split('\n')) {
                    if (line.trim()) {
                        const { key, value } = JSON.parse(line);
                        if (value === undefined) {
                            delete data[key];
                        } else {
                            data[key] = value;
                        }
                    }
                }
                maxDbVersion = Math.max(maxDbVersion, maxJournalVersion);
            }
            return { version: maxDbVersion, data, needsFlush };
        } catch (e) {
            console.warn('Error loading state:', e);
            return { version: 999, data: {}, needsFlush: false };
        }
    }

    public async setItem(key: string, value: any): Promise<void> {
        await this.initPromise;
        const entry = JSON.stringify({ key, value }) + '\n';
        if (!this.journalHandle) { await this.openJournal(); }
        const encoded = new TextEncoder().encode(entry);
        await this.journalHandle!.write(encoded);
        if (value === undefined) {
            delete this.data[key];
        } else {
            this.data[key] = value;
        }
    }

    public async getItem(key: string): Promise<any> {
        await this.initPromise;
        return this.data[key];
    }

    public async flush(): Promise<void> {
        if (this.flushPromise) {
            await this.flushPromise;
            return;
        }
        if (this.journalHandle) {
            this.journalHandle.close();
            this.journalHandle = null;
        }
        this.flushPromise = (async () => {
            const nextVersion = this.currentVersion + 1;
            const newDbFile = `${this.dbPath}.${nextVersion}.json`;
            await Deno.writeTextFile(newDbFile, JSON.stringify(this.data));
            const files = [...Deno.readDirSync(`${this.baseDirectory}/db`)].map(f => f.name)
                .filter(name => name.startsWith(this.dbName));
            for (const file of files) {
                const match = file.match(/\.(\d+)\.(json|journal\.txt)$/);
                if (match) {
                    const version = parseInt(match[1]);
                    if (match[2] === 'journal.txt' && version <= this.currentVersion) {
                        await Deno.remove(`${this.baseDirectory}/db/${file}`);
                    }
                    if (match[2] === 'json' && version <= nextVersion - 2) {
                        await Deno.remove(`${this.baseDirectory}/db/${file}`);
                    }
                }
            }
            this.currentVersion = nextVersion;
            this.journalFile = `${this.dbPath}.${nextVersion + 1}.journal.txt`;
            this.flushPromise = null;
        })();
        await this.flushPromise;
    }
}

const _SEP_ = '='.repeat(86)
const _SEP = '\n' + _SEP_
const SEP_ = _SEP_ + '\n'
const SEP = _SEP + '\n'

const HOME_DIR_PATH = Deno.build.os === 'windows' ? Deno.env.get('USERPROFILE') : Deno.env.get('HOME');
const OS384_PATH = Deno.env.get('OS384_HOME') || HOME_DIR_PATH + '/.os384';

const BUDGET_KEY = Deno.env.get('OS384_BUDGET_KEY') || Deno.env.get('SB384_BUDGET_CHANNEL_KEY') || null;
const LEDGER_KEY = Deno.env.get('OS384_LEDGER_KEY') || null;

const DEFAULT_CHANNEL_SERVER = Deno.env.get('OS384_CHANNEL_SERVER') || "https://c3.384.dev"
const DEFAULT_STORAGE_SERVER = Deno.env.get('OS384_STORAGE_SERVER') || "https://s3.384.dev"

const MiB = 1024 * 1024;
const TOP_UP_INCREMENT = 16 * MiB;

async function createChannelWithToken(
    channelKey: SBUserPrivateKey,
    token: SBStorageToken | string
): Promise<boolean> {
    try {
        const channel = await new Channel(channelKey).ready;
        await channel.create(token as SBStorageToken);
        return true;
    } catch (error: any) {
        if (error.message?.includes("not authorized")) {
            console.error("Token authorization failed - might need refresh");
        } else {
            console.error("Failed to create channel:", error);
        }
        return false;
    }
}

async function topUpChannelWithToken(
    channelKey: SBUserPrivateKey,
    token: SBStorageToken | string,
    // budgetChannel: ChannelApi
    budgetChannel: Channel
): Promise<boolean> {
    if (DBG0) console.log(SEP, "topUpChannelWithToken", SEP, channelKey, SEP, token, SEP)
    try {
        const channel = await new Channel(channelKey).ready;
        if (DBG0) console.log(SEP, "channel ready", SEP, channel, SEP)
        if (token) {
            if (DBG0) console.log(SEP, "CALLING BUDD", SEP)
            const retHandle = await budgetChannel.budd({
                targetChannel: channel.handle,
                token: token as SBStorageToken
            });
            if (DBG0) console.log(SEP, "++++ budd done", SEP, retHandle, SEP)
        }
        return true;
    } catch (error: any) {
        if (error.message?.includes("not authorized")) {
            console.error("Token authorization failed - might need refresh");
        } else {
            console.error("Failed to top up channel:", error);
        }
        return false;
    }
}

async function printChannelServerInfo(server: string = DEFAULT_CHANNEL_SERVER) {
    try {
        const info: SBServerInfo | undefined = await ChannelApi.getServerInfo(server);
        console.log(SEP, "[printChannelServerInfo] Channel Server info:", SEP, JSON.stringify(info, null, 2), "\n", SEP);
    } catch (error: any) {
        console.error("[printChannelServerInfo] Failed to get channel info:", error);
        denoExit(1);
    }
}

async function printChannelInfo(channelKey: SBUserPrivateKey) {
    try {
        const channel = await new Channel(channelKey).ready;
        const info = await channel.getAdminData();
        console.log(SEP, "Channel information:", SEP, JSON.stringify(info, null, 2), SEP, channel.userPrivateKey);
        // also high level history information
        const historyCount = (await channel.getHistory()).root.count;
        console.log(SEP_, "Channel history count:", historyCount, SEP);
    } catch (error: any) {
        console.error("Failed to get channel history:", error);
        denoExit(1);
    }
}

async function printHistory(channelKey: SBUserPrivateKey) {
    try {
        const channel = await new Channel(channelKey).ready;
        const history = (await channel.getHistory()).root;
        console.log(SEP, "Channel history:", SEP, history, SEP);
    } catch (error: any) {
        console.error("Failed to get channel info:", error);
        denoExit(1);
    }
}


// Each parameter's presence can be represented as a bit
// key (8), amount (4), budget (2), token (1)
enum ChannelOpCase {
    NONE = 0,                    // 0000
    TOKEN = 1,                   // 0001
    BUDGET = 2,                  // 0010
    BUDGET_TOKEN = 3,            // 0011
    AMOUNT = 4,                  // 0100
    AMOUNT_TOKEN = 5,            // 0101
    AMOUNT_BUDGET = 6,           // 0110
    AMOUNT_BUDGET_TOKEN = 7,     // 0111
    KEY = 8,                     // 1000
    KEY_TOKEN = 9,               // 1001
    KEY_BUDGET = 10,             // 1010
    KEY_BUDGET_TOKEN = 11,       // 1011
    KEY_AMOUNT = 12,             // 1100
    KEY_AMOUNT_TOKEN = 13,       // 1101
    KEY_AMOUNT_BUDGET = 14,      // 1110
    KEY_AMOUNT_BUDGET_TOKEN = 15 // 1111
}

// let's define a type for the options object
type Options = {
    budget?: string;   // -b, --budget
    live?: boolean;    // -e, --live
    file?: string;     // -f, --file
    files?: boolean | Array<string>; // -f, --files (for multiple files)
    info?: boolean;    // -i, --info
    key?: string;      // -k, --key
    local?: boolean;   // -l, --local
    minimal?: boolean; // -m, --minimal
    name?: string;     // -n, --name (defaults to 'John Doe')
    output?: string;   // -o, --output
    phrase?: string;   // -p, --phrase  (note, collides with prefix)
    prefix?: number;   // -p, --prefix
    server: string;    // -s, --server
    token?: SBStorageToken | string; // -t, --token
    url?: string;      // -u, --url
    wrapper?: boolean; // -w, --wrapper
    size?: number;     // -z, --size  (amount, accepts MiB, GB, etc)
    // New properties for manifest commands
    input?: string;    // -i, --input
    shortName?: string; // -s, --short-name
    description?: string; // -d, --description
    version?: string;  // -v, --version
    author?: string;   // -a, --author
    publisher?: string; // -p, --publisher
    appid?: string;    // -i, --appid
}

function getOperationCase(params: Options): ChannelOpCase {
    let caseNum = 0;
    if (params.key) caseNum |= 8;
    if (params.size) caseNum |= 4;
    if (params.budget) caseNum |= 2;
    if (params.token) caseNum |= 1;
    return caseNum;
}

function preProcessOptions(options: Options): Options {
    // console.log("preProcessOptions", options)
    if (options.local === true) { options.server = "http://localhost:3845" }
    if (!options.budget && BUDGET_KEY) { options.budget = BUDGET_KEY }
    return options;
}

async function handleInfoCommand(params: Options): Promise<void> {
    await printChannelServerInfo(params.server);
}

async function getOrCreateChannel(params: Options): Promise<string> {
    const opCase = getOperationCase(params);
    const SB = new ChannelApi(params.server, false);
    let tokenToUse = params.token;
    const amountToUse = params.size || TOP_UP_INCREMENT;

    // let budgetChannel: ChannelApi | null = null;
    let budgetChannel: Channel | null = null;
    if (params.budget || BUDGET_KEY) {
        // budgetChannel = SB.connect(params.budget || SB384_BUDGET_CHANNEL_KEY);
        budgetChannel = SB.connect(params.budget || BUDGET_KEY!);
    }

    let channelExists = false;
    let channelKeyToUse = params.key;
    if (channelKeyToUse) {
        if (DBG0) console.log(SEP, "++++ We will use channel key...", SEP, channelKeyToUse, SEP);
        try {
            const channel = await new Channel(channelKeyToUse).ready;
            const _ = await channel.getAdminData();
            channelExists = true;
        } catch (error: any) {
            if (error.message?.includes("No such channel")) {
                if (DBG0) console.log(SEP, "---- Channel does not exist, we will attempt to create", SEP, error, SEP);
                channelKeyToUse = (await new SB384().ready).userPrivateKey;
            } else {
                console.error("Unknown error when checking if channel exists:", error);
                denoExit(1);
            }
        }
    } else {
        channelKeyToUse = (await new SB384().ready).userPrivateKey;
        if (DBG0) console.log(SEP, "++++ We created a new key...", SEP, channelKeyToUse, SEP);
    }
    if (!channelKeyToUse) {
        console.error("---- No channel key available");
        denoExit(1);
    }

    switch (opCase) {

        case ChannelOpCase.KEY: // 1000
            if (channelExists) {
                // break to just print channel info
                break;
            } else if (!budgetChannel) {
                console.error("Channel does not exist and no budget source provided");
                denoExit(1);
            }
        // fall through to create

        case ChannelOpCase.AMOUNT_BUDGET: // 0110
        case ChannelOpCase.AMOUNT_TOKEN: // 0101
        case ChannelOpCase.AMOUNT: // 0100
        case ChannelOpCase.BUDGET: // 0010
        case ChannelOpCase.KEY_AMOUNT_BUDGET: // 1110
        case ChannelOpCase.KEY_AMOUNT: // 1100
        case ChannelOpCase.KEY_BUDGET: // 1010
        case ChannelOpCase.NONE: // 0000
            if (budgetChannel) {
                tokenToUse = await budgetChannel.getStorageToken(amountToUse);
                if (DBG0) console.log(SEP, "Got token to use:", SEP, tokenToUse, SEP);
            } else {
                console.error("Need a budget source to either create or top up a channel");
                denoExit(1);
            }
        /* falls through */
        case ChannelOpCase.KEY_AMOUNT_TOKEN: // 1101
        case ChannelOpCase.KEY_TOKEN: // 1001
        case ChannelOpCase.TOKEN: // 0001
        case ChannelOpCase.BUDGET_TOKEN: // 0011 (silently ignore budget)
        case ChannelOpCase.KEY_BUDGET_TOKEN: // 1011
            let success = false
            if (channelExists) {
                if (!budgetChannel) {
                    // ToDo: this needs to be fixed in lib384/budd
                    console.error("Need a budget *channel* to deposit token (yes this should not be a limitation)");
                    denoExit(1);
                } else if (tokenToUse) {
                    if (DBG0) console.log(SEP, "Topping up existing channel...", SEP, tokenToUse, SEP);
                    success = await topUpChannelWithToken(channelKeyToUse, tokenToUse, budgetChannel);
                } else {
                    console.error("Need storage budget source ...")
                    denoExit(1);
                }
            } else if (tokenToUse) {
                if (amountToUse < TOP_UP_INCREMENT) {
                    console.error("Minimum channel budget is 16 MiB");
                    denoExit(1);
                }
                if (DBG0) console.log(SEP, "Creating new channel...", SEP);
                success = await createChannelWithToken(channelKeyToUse, tokenToUse);
            } else {
                console.error("Need storage budget source ...")
                denoExit(1);
            }
            if (!success) { denoExit(1); }
            break;

        // incorrect combinations
        case ChannelOpCase.AMOUNT_BUDGET_TOKEN: // 0111
        case ChannelOpCase.KEY_AMOUNT_BUDGET_TOKEN: // 1111
            console.error("Cannot provide both budget and token (that's ambiguous)");
            denoExit(1);
            break;

    }
    return channelKeyToUse;
}

// Now we can switch on all possible combinations
async function handleChannelOperation(params: Options): Promise<void> {
    if (DBG0) console.log(SEP, "handleChannelOperation", SEP, params, SEP);
    const channelKeyToUse = await getOrCreateChannel(params);
    await printChannelInfo(channelKeyToUse);
}

function newFileSet(meta: FileSetMeta) {
    console.log(SEP, "New FileSet", SEP, meta, SEP);
}


// Custom File-like class that implements the necessary parts of the File interface
class DenoFile implements File {
    private path: string;
    private _name: string;
    private _lastModified: number;
    private _size: number;
    private _type: string;
    private _webkitRelativePath: string;

    constructor(path: string, options: { type?: string; webkitRelativePath?: string } = {}) {
        this.path = path;

        let fileInfo;
        try {
            fileInfo = Deno.statSync(path);
        } catch {
            throw new Error(`File not found ('${path}')`);
        }

        this._name = path.split('/').pop() || path;
        this._lastModified = fileInfo.mtime?.getTime() || Date.now();
        this._size = fileInfo.size;
        this._type = options.type || '';
        this._webkitRelativePath = options.webkitRelativePath || '';
    }

    get webkitRelativePath(): string {
        return this._webkitRelativePath;
    }

    // Required File interface properties
    get name(): string {
        return this._name;
    }

    get lastModified(): number {
        return this._lastModified;
    }

    get size(): number {
        return this._size;
    }

    get type(): string {
        return this._type;
    }

    // Required Blob interface methods
    async arrayBuffer(): Promise<ArrayBuffer> {
        const data = await Deno.readFile(this.path);
        return data.buffer;
    }

    async bytes(): Promise<Uint8Array> {
        return await Deno.readFile(this.path);
    }

    // Example showing arrayBuffer().slice() is already supported:
    async getSlicedContent(start: number, end: number): Promise<ArrayBuffer> {
        const buffer = await this.arrayBuffer();
        return buffer.slice(start, end);  // This is ArrayBuffer.prototype.slice()
    }

    async text(): Promise<string> {
        return await Deno.readTextFile(this.path);
    }

    slice(start?: number, end?: number, contentType?: string): Blob {
        throw new Error('Slice operation not implemented');
    }

    stream(): ReadableStream {
        const myThis = this;
        return new ReadableStream({
            async start(controller) {
                const file = await Deno.open(myThis.path);
                const reader = file.readable.getReader();

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    controller.enqueue(value);
                }

                controller.close();
                file.close();
            }
        });
    }
}

// Helper function to create a File object from a path
export function createFileFromPath(path: string, options: { type?: string } = {}): File {
    return new DenoFile(path, options);
}

// Example usage:
async function example() {
    // Create a File object from a local path
    const file = createFileFromPath('./example.txt', { type: 'text/plain' });

    // Now you can use this with your existing upload library
    // await yourUploadLibrary.upload(file);

    // You can also access File properties
    console.log(file.name);         // example.txt
    console.log(file.size);         // size in bytes
    console.log(file.type);         // text/plain
    console.log(file.lastModified); // timestamp

    // And read the contents
    const text = await file.text();
    console.log(text);
}

export async function createSBFileFromPath(
    filepath: string,
    options: {
        path?: string;  // Optional override for SBFile.path
    } = {}
): Promise<SBFile> {
    // First create our File object
    const browserFile = createFileFromPath(filepath);

    // Read first chunk for MIME type detection
    const firstChunk = new Uint8Array(await browserFile.arrayBuffer()).slice(0, 512);
    const mimeType = getMimeType(filepath, firstChunk);

    // Get file info from Deno
    const fileInfo = await Deno.stat(filepath);

    // Parse the path components
    const pathParts = filepath.split('/');
    const fileName = pathParts.pop() || filepath;
    const filePath = options.path || pathParts.join('/') || '/';

    // Create the SBFile object using its constructor
    return new SBFile({
        browserFile,
        name: fileName,
        path: filePath,
        fullPath: filepath,
        type: mimeType,
        size: fileInfo.size,
        lastModified: new Date(fileInfo.mtime?.getTime() || Date.now()).toLocaleString(),
        timeStamp: Date.now()
    });
}

// Example usage:
async function example2() {
    const sbFile = await createSBFileFromPath('./example.pdf', {
        path: '/documents/2024'  // optional path override
    });

    console.log(sbFile.name);         // example.pdf
    console.log(sbFile.path);         // /documents/2024
    console.log(sbFile.fullPath);     // ./example.pdf
    console.log(sbFile.type);         // application/pdf
    console.log(sbFile.size);         // size in bytes
    console.log(sbFile.lastModified); // localized date string
    console.log(sbFile.browserFile);  // Our DenoFile implementation
}


async function handleSbfsCommand(params: Options): Promise<void> {
    // console.log(SEP, "sbfs command", SEP, params, SEP, phrase, SEP);

    // const db = new LocalStorage("sbfs");

    if (!params.budget) {
        console.error("Need a budget source to create a channel");
        denoExit(1);
    }

    const sbfsLedgerKey = await getOrCreateChannel(params)
    const sbfsPhrase = params.phrase || await generatePassPhrase();

    console.log(
        SEP, "SBFS parameters (keep track of these if any are new):", SEP,
        `User name:   '${params.name || "John Doe"}'\n`,
        `Phrase:      '${sbfsPhrase}'\n`,
        "Ledger key:  ", sbfsLedgerKey, SEP)

    const sbfs = new SBFileSystem({
        channelServer: params.server,
        ledgerHandle: { userPrivateKey: sbfsLedgerKey },
        ledgerPassPhrase: sbfsPhrase,
        budgetHandle: { userPrivateKey: params.budget! },
        username: params.name || "John Doe"
    }, { newFileSet: newFileSet });
    await sbfs.init();

    console.log(SEP, "SBFS object created and initialized", SEP);

    if (params.files && params.files instanceof Array) {
        let sbFileArray: Array<SBFile> = [];
        for (const file of params.files) {
            try {
                const sbFile = await createSBFileFromPath(file);
                console.log(SEP, "SBFile created", SEP, sbFile, SEP);
                sbFileArray.push(sbFile);
            } catch (error: any) {
                // console.error(`Error trying to create SBFile, skipping ('${error}')`);
                console.error("Error trying to create SBFile, skipping:", error);
                // continue
            }
        }
        console.log("... will try to upload set of files ...");
        await sbfs.uploadNewSet(sbFileArray);
        console.log("... upload done ...");
    }

    // const SB = new ChannelApi(params.server, false);
    // const sbfsLedgerChannel = await SB.connect(sbfsLedgerKey).ready

    // public options: {
    //     // at minimum, we need a channel server
    //     channelServer: string,
    //     // core for full functionality
    //     ledgerHandle?: ChannelHandle,
    //     ledgerPassPhrase?: string,
    //     budgetHandle?: ChannelHandle,
    //     // optional
    //     username?: string,
    //     // advanced, for most cases we can use default fixed value (below)
    //     ledgerKey?: Protocol_KeyInfo
    //     // appServer?: string,
    // },

    // console.log("sbfsLedger: ", sbfsLedgerChannel.handle)
}

function denoExit(num: number) {
    Deno.exit(num);
}

async function newUser(server: string, privateKey?: string) {
    let newUser: SB384
    if (privateKey)
        newUser = await new SB384(privateKey).ready
    else
        newUser = await new SB384().ready

    console.log(SEP, "User info, first in full jwk format (private):", SEP, newUser.jwkPrivate, SEP)
    console.log(SEP, "Next, a few 'perspectives' on the object:", SEP)
    console.log("userId/channelId: ", newUser.userId)
    console.log("userPublicKey:    ", newUser.userPublicKey)
    console.log("userPrivateKey:   ", newUser.userPrivateKey)
    console.log("dehydrated:       ", newUser.userPrivateKeyDehydrated)
    console.log()
    console.log("Notes:")
    console.log("- 'user' in this context just means a root SB384 object")
    console.log("- 'channelId', 'user hash', and 'user ID' are more or less synonyms.")
    console.log("- if you need to store userPublic key anyway, you only")
    console.log("  need the dehydrated version of the private key alongside.")
    if (privateKey)
        console.log(SEP)
    else
        console.log(SEP, "Reminder: all you need is the userPrivateKey, try:", '\n', `384 key -k ${newUser.userPrivateKey}`, SEP)

}

const PREFIX_LENGTH = 8;

function arrayBufferToText(arrayBuffer: ArrayBuffer) {
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(new Uint8Array(arrayBuffer));
}

async function publishFileAsPage(filePath: string, name: string, channelServer: string, prefixLength: number, budgetKey: string | undefined, privateKey?: string) {
    console.log(SEP, "Publishing file as Page: ", filePath, name, channelServer, privateKey, SEP);
    const SB = new ChannelApi(channelServer || DEFAULT_CHANNEL_SERVER, false);

    // Check for budget source
    if (!budgetKey && !BUDGET_KEY) {
        console.error("No budget source provided. Use --budget or set OS384_BUDGET_KEY environment variable");
        denoExit(1);
        return; // This is needed to satisfy TypeScript, even though denoExit will terminate execution
    }

    // Use the provided budget key or fall back to environment variable
    const budgetChannel = SB.connect(budgetKey || BUDGET_KEY!);

    const fileName = name || filePath.split('/').pop();

    let pageChannel: Channel;
    if (privateKey) {
        pageChannel = await new Channel(privateKey).ready;
        pageChannel.channelServer = channelServer || DEFAULT_CHANNEL_SERVER;
        try {
            const channelKeys = await pageChannel.getChannelKeys();
            if (DBG0) console.log("Channel keys: ", channelKeys);
        } catch (e: any) {
            if (e.message && e.message.includes("No such channel")) {
                if (DBG0) console.log(SEP, "Channel not found, registering and funding ...", SEP);
                const storageToken = await budgetChannel.getStorageToken(TOP_UP_INCREMENT);
                pageChannel = await pageChannel.create(storageToken);
                console.log("Channel created: ", pageChannel.handle);
            } else {
                console.log(SEP, "Error connecting to channel with private key: ", e, SEP);
                denoExit(1);
            }
        }
    } else {
        console.log(SEP, "No private key provided, creating a new channel for this file", SEP);
        pageChannel = await SB.connect(await SB.create(budgetChannel)).ready;
    }

    const data = await Deno.readFile(filePath);
    const bytes = new Uint8Array(data.buffer);

    if (bytes.length > 4 * MiB) {
        console.error(SEP, "File is larger than 4 MiB, you shouldn't have large objects as Pages", SEP);
        denoExit(1);
    }

    const type = browser.getMimeType(filePath);
    if (!type) throw new Error("Could not determine file type");

    const prefix = pageChannel.hashB32.slice(0, prefixLength);
    const fileURL = `${channelServer || DEFAULT_CHANNEL_SERVER}/api/v2/page/${prefix}/${fileName}`;

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

    let rez: any;
    try {
        rez = await pageChannel.setPage({ page: bytes, type: type, prefix: prefixLength });
    } catch (e) {
        console.log("Error setting page: \n", e);
        denoExit(1);
    }
    if (!rez) throw new Error("Could not set page");
    console.log(rez);

    if (!privateKey) {
        console.log(
            SEP, "No Page deployment channel provided, created a new one - keep track of this key:\n",
            JSON.stringify({
                userPrivateKey: pageChannel.userPrivateKey,
                channelServer: pageChannel.channelServer
            }, null, 2),
            SEP, "The above private key is what you would give as second parameter to this command to update", SEP
        );
    }
    console.log("\n", SEP,
        "New Page contents succesfully deployed.",
        "Note that it can take a bit of time to take effect.", SEP);

    printUrl();
}

const DOC_CLI = `os384 command line interface

See below for subcommands; each has its own help. The global options below
do not always apply to all subcommands, and they may be interpreted differently.

You will probably want to add two environment variables to your shell startup:

- OS384_BUDGET_KEY will be used as default budget source
- OS384_LEDGER_KEY records any and all metadata

Less commonly you may want these overrides:

- OS384_HOME: where to store various local data (default is ~/.os384)
- OS384_CHANNEL_SERVER sets channel server (default is 'https://c3.384.dev')

(c) 2024, 384 (tm) Inc. Please note this is pre-production beta software.`;


const DOC_PAGE = `Publish a file as a Page

If a private key is provided, it will use that key for the Page (and register
it if needed), otherwise it will create a new key. 

For budget, the command will:
1. Use the --budget parameter if provided
2. Fall back to the OS384_BUDGET_KEY environment variable if available
3. Error if no budget source is found

If the page channel already exists and it does not have enough storage, it will 
top up the storage from the budget channel. Note that it will always check if 
the file is already published, and if so, only update if the file has changed.`;

const DOC_CHANNEL = `Channel operations (various)

If a channel key is not provided, it will be created and the corresponding
channel authorized and funded.

If a channel key is provided and the corresponding channel does not exist,
then that channel will be created.

If a channel key is provided and the corresponding channel exists, then the
channel budget will be 'topped up': either the provided amount taken from
budget channel, or the storage token is consumed.

Generally as budget sources, it will use either provided budget channel, or
provided token, or if neither is provided you need to have set the
environment variable SB384_BUDGET_CHANNEL_KEY. For new channels, amount can
be omitted and the default (minimum) budget will be used; for top-up
operations, either an amount plus a budget channel, or a token must be
provided.

Note that the above implies that if you run '384 channel' without any
parameters, and there's an ENV budget channel, it will create a new channel.`;

const DOC_KEY = `Creates an SB384 object (or parse an existing one)`

const DOC_SHARDIFY = `Uploads a file or URL target as a shard

Note that this is 1:1 storage, eg, not a 'file' per se, (see 'upload').
We have early experimental support for various handle output formats,
by default we output the os384 generic handle, but by default we also
output a nostr format.`;

const DOC_STREAM = `Streams channel messages`;

async function processShardAndOutput(
    channelServer: string,
    budgetKey: string | undefined,
    bytes: Uint8Array,
    contentType: string | null,
    contentLength: string | number,
    output: string,
    minimal: boolean
) {
    const SB = new ChannelApi(channelServer)

    const budgetChannel = budgetKey ? SB.connect(budgetKey) : BUDGET_KEY ? SB.connect(BUDGET_KEY) : null
    if (!budgetChannel) {
        console.error("No budget source provided");
        denoExit(1);
    }

    const storageServer = await SB.getStorageServer()

    if (!contentType) contentType = getMimeType(undefined, bytes)

    // store it as a shard
    const fullHandle = await SB.storage.storeData(bytes, budgetChannel!)
    await fullHandle.verification

    if (minimal) {
        let reducedHandle = {
            version: fullHandle.version, // ... this one is debatable
            id: fullHandle.id,
            key: fullHandle.key,
            verification: fullHandle.verification,
            storageServer: fullHandle.storageServer,
        };
        console.log(SEP, "Reduced handle:", SEP, reducedHandle, _SEP);
        let minimalHandle = {
            id: fullHandle.id,
            key: fullHandle.key,
        };
        console.log("Minimalist handle:", SEP, minimalHandle, SEP);
    } else {
        console.log(SEP, "Complete (full) handle:", SEP, await stringify_ObjectHandle(fullHandle), SEP);
    }

    if (output === "nostr") {
        // create an 'os384' magnet link
        const h = fullHandle
        const magnet = `magnet:?xt=urn:os384:${h.id}&key=${h.key}&verification=${h.verification}&xs=${storageServer}`

        // build the NIP-94 handle:
        const nip94 = {
            "kind": 1063,
            "tags": [
                // ["url", <we might want to add a URL form>],
                ["m", contentType],
                ["size", contentLength],
                ["magnet", magnet],
            ],
        }
        console.log(SEP, "NIP-94 handle", SEP, JSON.stringify(nip94, null, 2), SEP)
    } else {
        console.error("Unrecognized output type: ", output)
    }
}

async function shardifyFromURL(channelServer: string, budgetKey: string | undefined, url: string,
    output: string, minimal: boolean) {
    // read the data from the URL
    const response = await fetch(url)
    const data = await response.arrayBuffer()
    const bytes = new Uint8Array(data)

    // get some meta data
    const contentType = response.headers.get("content-type")
    // const contentLength = response.headers.get("content-length")
    const contentLength = bytes.length

    await processShardAndOutput(channelServer, budgetKey, bytes, contentType, contentLength, output, minimal)
}

async function shardifyFromFILE(channelServer: string, budgetKey: string | undefined, files: Array<string>,
    output: string, minimal: boolean) {
    for (const filePath of files) {
        console.log(SEP, "Shardifying file: ", filePath, SEP)
        // read the data from the local file
        const data = await Deno.readFile(filePath)
        const bytes = new Uint8Array(data)

        // get meta data - mime type and content length
        const contentType = getMimeType(filePath)
        const contentLength = bytes.length

        await processShardAndOutput(channelServer, budgetKey, bytes, contentType, contentLength, output, minimal)
    }
}

export function inspectBinaryData(data: ArrayBuffer | ArrayBufferView) {
    const LINE_WIDTH = 40

    if (!data) return ('******* <empty> ******* (no value provided to inspectBinaryData)')

    let byteArray;
    if (data instanceof ArrayBuffer) {
        byteArray = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
        byteArray = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
        throw new Error('Unsupported data type');
    }
    const hexLine: Array<string> = [];
    const asciiLine: Array<string> = [];
    const lines: Array<string> = [];
    const lineLength = LINE_WIDTH; // You can adjust this as needed
    byteArray.forEach((byte, i) => {
        hexLine.push(byte.toString(16).padStart(2, '0'));
        asciiLine.push(byte >= 32 && byte <= 127 ? String.fromCharCode(byte) : '.');
        if ((i + 1) % lineLength === 0 || i === byteArray.length - 1) {
            // Pad the hex line if it's the last line and not full
            while (hexLine.length < lineLength) {
                hexLine.push('  ');
                asciiLine.push(' ');
            }
            lines.push(hexLine.join(' ') + ' | ' + asciiLine.join(''));
            hexLine.length = 0;
            asciiLine.length = 0;
        }
    });
    return lines.join('\n');
}

async function streamChannel(server: string, channelOwnerKey: string, live = false, detail: boolean = false, wrapper: boolean = false) {
    const SB = new ChannelApi(server)
    try {
        const chan = await SB.connect(channelOwnerKey).ready
        const handle = chan.handle
        const c = await (new ChannelStream(handle /* , protocol if needed */)).ready
        for await (const message of c.start({ prefix: '0', live: live })) {
            if (wrapper)
                console.log(SEP, "MESSAGE", SEP, message, SEP, "BODY", SEP, message.body)
            else
                console.log(SEP, "MESSAGE BODY", SEP, message.body)
            if (detail) {
                const verifySignature = (v: ArrayBuffer) => new Uint32Array(v, 0, 1)[0] === 0xAABBBBAA;
                function inspectProperties(obj: any, parentObject: String = "") {
                    for (const [key, value] of Object.entries(obj)) {
                        // console.log(SEP, `Inspecting '${key}'`, SEP)
                        const objName = parentObject ? parentObject + '.' + key : key
                        if (value instanceof ArrayBuffer && verifySignature(value)) {
                            // console.log(SEP, `Will try to extract '${objName}'`, SEP, value, SEP)
                            try {
                                console.log(SEP_, `We will try to deserialize '${objName}' ...`)
                                const deserialized = extractPayload(value)
                                if (DBG0) console.log(SEP, `... successfully deserialized '${objName}':`, SEP, inspectBinaryData(value))
                                console.log(SEP_, `... into the following object:`, SEP, deserialized)
                                inspectProperties(deserialized, objName)
                            } catch (err) {
                                console.warn(SEP, `... **** FAILED to deserialize '${objName}' (?) ... `, SEP, err, SEP, inspectBinaryData(value))
                                // console.log(SEP, `**** ERROR Contents of '${objName}':`, SEP, inspectBinaryData(value))
                            }
                        } else if (typeof value === 'object') {
                            console.log(SEP_, `Recursing into '${objName}' ...`, SEP, value)
                            inspectProperties(value, objName)
                        }
                    }
                }
                inspectProperties(message.body)
            }
        }
        console.log(SEP)
    } catch (e: any) {
        console.trace("[streamChannel] Error:", e)
    }
}

async function verifyString(publicKey: string, s: string, g: string) {
    const p = await new SB384(publicKey).ready
    if (!p) {
        console.log("Error: could not create SB384 object (could not parse public key)")
        denoExit(1)
    }
    if (p.private) {
        console.log("Error: you need the PUBLIC key to verify.")
        denoExit(1)
    }
    const data = (new TextEncoder()).encode(s)
    const signature = base62ToArrayBuffer(g)
    const result = await sbCrypto.verify(p.signKey, signature, data)
    console.log("Signature was", result ? "valid" : "INVALID")
}

async function signString(privateKey: string, s: string) {
    const p = await new SB384(privateKey).ready
    if (!p) {
        console.log("Error: could not create SB384 object (could not parse private key)")
        denoExit(1)
    }
    if (!p.private) {
        console.log("Error: you need the private key to sign.")
        denoExit(1)
    }
    const data = (new TextEncoder()).encode(s)
    const signature = arrayBufferToBase62(await sbCrypto.sign(p.signKey, data))
    console.log("Signature: ", signature)
}

async function getPubKeys(server: string, channelOwnerKey: string) {
    const SB = new ChannelApi(server)
    try {
        const chan = await SB.connect(channelOwnerKey).ready
        const pubKeys = await chan.getPubKeys()
        console.log(SEP, "Public keys: ", pubKeys, SEP)
        console.log(SEP, "Public keys count: ", pubKeys.size, SEP)
    } catch (e: any) {
        console.log(SEP, "Error connecting to channel with private key: ", e, SEP)
        denoExit(1)
    }
}

async function updateCapacity(server: string, channelOwnerKey: string, newCapacity: number) {
    const SB = new ChannelApi(server)
    try {
        const chan = await SB.connect(channelOwnerKey).ready
        const updatedCapacity = await chan.updateCapacity(newCapacity)
        console.log("Channel capacity updated:", updatedCapacity)
    } catch (e: any) {
        console.log(SEP, "Error connecting to channel with private key: ", e, SEP)
        denoExit(1)
    }
}

// Size units in bytes
const UNITS = {
    // Binary units
    'B': 1,
    'KiB': 1024,
    'MiB': 1024 ** 2,
    'GiB': 1024 ** 3,
    'TiB': 1024 ** 4,
    'PiB': 1024 ** 5,

    // Decimal units
    'KB': 1000,
    'MB': 1000 ** 2,
    'GB': 1000 ** 3,
    'TB': 1000 ** 4,
    'PB': 1000 ** 5,

    // Common aliases
    'K': 1024,
    'M': 1024 ** 2,
    'G': 1024 ** 3,
    'T': 1024 ** 4,
    'P': 1024 ** 5
} as const;

type Unit = keyof typeof UNITS;

/**
 * Parses a string containing a file size with optional units into bytes
 * Example inputs: "1024", "1.5MB", "2.5GiB", "500K"
 */
function parseFileSize(input: string): number {
    // If input is just a number, return it as bytes
    if (/^\d+$/.test(input)) {
        return parseInt(input, 10);
    }

    // Match number and unit parts
    const match = input.match(/^(\d+\.?\d*)\s*([A-Za-z]+)$/);
    if (!match) {
        throw new Error(`Invalid file size format: ${input}`);
    }

    const [, numberPart, unitPart] = match;
    const number = parseFloat(numberPart);
    const unit = unitPart as Unit;

    if (!(unit in UNITS)) {
        console.error(`Unknown unit: ${unit}. Valid units are: ${Object.keys(UNITS).join(', ')}`);
        denoExit(1);
    }

    // make sure we are returning a whole integer
    return Math.round(number * UNITS[unit]);
}

async function handleShardifyCommand(params: Options) {
    // .action(async ({ server, budget, url, output, minimal }, file) => {
    //     if (file) await shardifyFromFILE(server, budget, file, output, minimal)
    //     else if (url) await shardifyFromURL(server, budget, url, output, minimal)
    //     else {
    //         console.error("You must provide either a file or a URL");
    //     }
    // })

    if (params.files && params.files instanceof Array) {
        await shardifyFromFILE(params.server, params.budget, params.files, params.output!, params.minimal!);
    } else if (params.url) {
        await shardifyFromURL(params.server, params.budget, params.url, params.output!, params.minimal!);
    } else {
        console.error("You must provide either a file or a URL");
        denoExit(1);
    }

}

async function handleFetchOperation(params: Options, id: string, verification: string, key: string) {
    const SB = new ChannelApi(params.server)
    const myHandle: ObjectHandle = {
        id: id,
        verification: verification,
        key: key
    };
    // disabled debug output since this command is used with stdout redirect
    // console.log(SEP, "Fetching shard", SEP, myHandle, SEP)
    const fileHandle = await SB.storage.fetchData(myHandle)
    // console.log(SEP, "Fetched shard", SEP, fileHandle, SEP)
    const data = new Uint8Array(await SB.storage.fetchPayload(fileHandle))
    if (params.file) {
        await Deno.writeFile(params.file, data)
    } else {
        // print to stdout
        Deno.stdout.write(data)
    }
}

async function handleMintOperation(params: Options): Promise<void> {
    if (!params.budget && !BUDGET_KEY) {
        console.error("No budget source provided. Use --budget or set OS384_BUDGET_KEY environment variable");
        denoExit(1);
        return;
    }

    const budgetKey = params.budget || BUDGET_KEY;
    const SB = new ChannelApi(params.server);
    const budgetChannel = await new Channel(budgetKey!).ready;

    // The size is already parsed to a number by the command option
    const sizeToMint = params.size || TOP_UP_INCREMENT;

    try {
        const token = await budgetChannel.getStorageToken(sizeToMint);
        console.log(SEP, "Storage token minted:", SEP, token, SEP);
        console.log(`Token size: ${sizeToMint / MiB} MiB`);
    } catch (error: any) {
        console.error("Failed to mint token:", error);
        denoExit(1);
    }
}

// Template for a standard manifest file
interface ManifestChannel {
    name: string;
    size: number;
    handle?: {
        channelId: string;
        userPrivateKey: string;
        channelServer?: string;
        channelData?: {
            channelId: string;
            ownerPublicKey: string;
        };
    };
}

interface SocialProof {
    source: string;
    website?: string;
    twitter?: string;
    github?: string;
}

interface ManifestTemplate {
    lang: string;
    short_name: string;
    name: string;
    description: string;
    version: string;
    author: string;
    publisher?: string;
    appid?: string;
    vault: boolean;
    mode: string;
    keywords: string[];
    channels: ManifestChannel[];
    socialProof: SocialProof[];
    channelServer?: string;
    appServer?: string;
}

const MANIFEST_TEMPLATE: ManifestTemplate = {
    "lang": "en",
    "short_name": "",
    "name": "",
    "description": "",
    "version": "",
    "author": "",
    "vault": true,
    "mode": "development",
    "keywords": [
        "web3",
        "384"
    ],
    "channels": [
        {
            "name": "budget",
            "size": 16000000
        },
        {
            "name": "ledger",
            "size": 4000000
        }
    ],
    "socialProof": [
        {
            "source": "Your Organization",
            "website": "https://example.com",
            "twitter": "@yourhandle",
            "github": "yourgithub"
        }
    ]
};

async function handleManifestInitCommand(options: Options): Promise<void> {
    const manifest: ManifestTemplate = { ...MANIFEST_TEMPLATE };
    
    // Update the manifest with the provided options
    manifest.name = options.name || "My OS384 App";
    manifest.short_name = options.shortName || "MyApp";
    manifest.description = options.description || "A distributed web application";
    manifest.version = options.version || "1.0.0";
    manifest.author = options.author || "Your Name";
    
    if (options.publisher) {
        manifest.publisher = options.publisher;
    }
    
    if (options.appid) {
        manifest.appid = options.appid;
    } else {
        // Generate a simple app ID if not provided
        const randomId = sbCrypto.generateRandomString(16);
        const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        manifest.appid = `${randomId}_${date}_01`;
    }
    
    // Write the manifest to the output file
    const manifestJson = JSON.stringify(manifest, null, 2);
    try {
        await Deno.writeTextFile(options.output || "384.manifest.json", manifestJson);
        console.log(SEP, `Manifest file created at: ${options.output || "384.manifest.json"}`, SEP);
        console.log(manifestJson);
        console.log(SEP);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error writing manifest file: ${errorMessage}`);
        denoExit(1);
    }
}

async function handleManifestResolveCommand(options: Options): Promise<void> {
    // Read the input manifest file
    const inputFile = options.input || "384.manifest.json";
    const outputFile = options.output || ".384.manifest.json";
    
    let manifestText: string;
    try {
        manifestText = await Deno.readTextFile(inputFile);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error reading manifest file: ${errorMessage}`);
        denoExit(1);
        return; // This is needed to satisfy TypeScript, even though denoExit will terminate execution
    }
    
    let manifest: ManifestTemplate;
    try {
        manifest = JSON.parse(manifestText) as ManifestTemplate;
        console.log(SEP, "Manifest loaded successfully", SEP);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error parsing manifest JSON: ${errorMessage}`);
        denoExit(1);
        return; // This is needed to satisfy TypeScript, even though denoExit will terminate execution
    }
    
    // Check if the manifest has channels
    if (!manifest.channels || !Array.isArray(manifest.channels) || manifest.channels.length === 0) {
        console.error("Manifest does not contain any channels to resolve");
        denoExit(1);
        return; // This is needed to satisfy TypeScript, even though denoExit will terminate execution
    }
    
    // Get the budget channel
    if (!options.budget && !BUDGET_KEY) {
        console.error("No budget source provided. Use --budget or set OS384_BUDGET_KEY environment variable");
        denoExit(1);
        return; // This is needed to satisfy TypeScript, even though denoExit will terminate execution
    }
    
    const budgetKey = options.budget || BUDGET_KEY;
    const SB = new ChannelApi(options.server);
    const budgetChannel = await new Channel(budgetKey!).ready;
    
    console.log(SEP, "Resolving manifest channels...", SEP);
    
    // Process each channel in the manifest
    for (const channel of manifest.channels) {
        if (channel.handle) {
            console.log(`Channel '${channel.name}' already has a handle, skipping`);
            continue;
        }
        
        if (!channel.size || channel.size <= 0) {
            console.log(`Channel '${channel.name}' has no size specified, skipping`);
            continue;
        }
        
        console.log(`Creating channel '${channel.name}' with size ${channel.size} bytes...`);
        
        try {
            // Create a new channel
            const storageToken = await budgetChannel.getStorageToken(channel.size);
            const newChannel = await SB.connect(await SB.create(storageToken)).ready;
            
            // Add the channel details to the manifest
            channel.handle = {
                channelId: newChannel.channelData.channelId,
                userPrivateKey: newChannel.userPrivateKey,
                channelServer: options.server,
                channelData: {
                    channelId: newChannel.channelData.channelId,
                    ownerPublicKey: newChannel.channelData.ownerPublicKey
                }
            };
            
            console.log(`Channel '${channel.name}' created successfully`);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Error creating channel '${channel.name}': ${errorMessage}`);
        }
    }
    
    // Add server information to the manifest
    manifest.channelServer = options.server;
    
    // Write the resolved manifest to the output file
    const resolvedManifestJson = JSON.stringify(manifest, null, 2);
    try {
        await Deno.writeTextFile(outputFile, resolvedManifestJson);
        console.log(SEP, `Shadow manifest file created at: ${outputFile}`, SEP);
        console.log(resolvedManifestJson);
        console.log(SEP);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error writing shadow manifest file: ${errorMessage}`);
        denoExit(1);
    }
}

async function handleManifestValidateCommand(options: Options): Promise<void> {
    // Read the manifest file
    const inputFile = options.input || "384.manifest.json";
    
    let manifestText: string;
    try {
        manifestText = await Deno.readTextFile(inputFile);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error reading or parsing manifest file: ${errorMessage}`);
        denoExit(1);
        return; // This is needed to satisfy TypeScript, even though denoExit will terminate execution
    }
    
    let manifest: ManifestTemplate;
    try {
        manifest = JSON.parse(manifestText) as ManifestTemplate;
        console.log(SEP, "Manifest loaded successfully", SEP);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error parsing manifest JSON: ${errorMessage}`);
        denoExit(1);
        return; // This is needed to satisfy TypeScript, even though denoExit will terminate execution
    }
    
    // Define required fields
    const requiredFields = ["lang", "short_name", "name", "description", "version", "author"];
    const missingFields = requiredFields.filter(field => !manifest[field as keyof ManifestTemplate]);
    
    if (missingFields.length > 0) {
        console.error(`Manifest is missing required fields: ${missingFields.join(", ")}`);
    } else {
        console.log("✓ All required fields are present");
    }
    
    // Validate channels
    if (!manifest.channels || !Array.isArray(manifest.channels) || manifest.channels.length === 0) {
        console.error("✗ Manifest does not contain any channels");
    } else {
        console.log(`✓ Manifest contains ${manifest.channels.length} channels`);
        
        // Check each channel
        let validChannels = true;
        for (const channel of manifest.channels) {
            if (!channel.name) {
                console.error(`✗ Channel is missing a name`);
                validChannels = false;
            }
            
            if (channel.size !== undefined) {
                if (typeof channel.size !== 'number' || channel.size <= 0) {
                    console.error(`✗ Channel '${channel.name}' has an invalid size: ${channel.size}`);
                    validChannels = false;
                }
            }
            
            // Check if the channel has a handle (for shadow manifests)
            if (channel.handle) {
                if (!channel.handle.channelId) {
                    console.error(`✗ Channel '${channel.name}' has an incomplete handle (missing channelId)`);
                    validChannels = false;
                }
            }
        }
        
        if (validChannels) {
            console.log("✓ All channels are valid");
        }
    }
    
    // Validate publisher if present
    if (manifest.publisher) {
        const key_regex = /^[0-9A-Za-z]{43,}$/;
        if (!key_regex.test(manifest.publisher)) {
            console.error(`✗ Publisher key is invalid: ${manifest.publisher}`);
        } else {
            console.log("✓ Publisher key format is valid");
        }
        
        // Check for appid if publisher is present
        if (!manifest.appid) {
            console.error("✗ Publisher is specified but appid is missing");
        } else {
            console.log("✓ Application ID is present");
        }
    }
    
    // Validate social proof if present
    if (manifest.socialProof && Array.isArray(manifest.socialProof)) {
        if (manifest.socialProof.length === 0) {
            console.warn("⚠ socialProof array is empty");
        } else {
            console.log(`✓ Manifest contains ${manifest.socialProof.length} social proof entries`);
        }
    }
    
    console.log(SEP, "Manifest validation completed", SEP);
}

interface SchemaProperty {
    type: string;
    description: string;
    required: boolean;
    items?: Record<string, SchemaProperty>;
}

type SchemaDefinition = Record<string, SchemaProperty>;

async function handleManifestSchemaCommand(): Promise<void> {
    const schema: SchemaDefinition = {
        "lang": {
            "type": "string",
            "description": "Language code (e.g., 'en' for English)",
            "required": true
        },
        "short_name": {
            "type": "string",
            "description": "Short name for the application",
            "required": true
        },
        "name": {
            "type": "string",
            "description": "Full name of the application",
            "required": true
        },
        "description": {
            "type": "string",
            "description": "Description of the application",
            "required": true
        },
        "version": {
            "type": "string",
            "description": "Version number (e.g., '1.0.0')",
            "required": true
        },
        "author": {
            "type": "string",
            "description": "Author or organization name",
            "required": true
        },
        "publisher": {
            "type": "string",
            "description": "Publisher public key for verification",
            "required": false
        },
        "appid": {
            "type": "string",
            "description": "Unique application identifier",
            "required": false
        },
        "vault": {
            "type": "boolean",
            "description": "Whether to track information on the global ledger",
            "required": false
        },
        "mode": {
            "type": "string",
            "description": "Application mode ('development' or 'production')",
            "required": false
        },
        "keywords": {
            "type": "array",
            "description": "Keywords for the application",
            "required": false
        },
        "channels": {
            "type": "array",
            "description": "Communication channels required by the app",
            "required": true,
            "items": {
                "name": {
                    "type": "string",
                    "description": "Channel name (e.g., 'budget', 'ledger')",
                    "required": true
                },
                "size": {
                    "type": "number",
                    "description": "Channel size in bytes",
                    "required": false
                },
                "handle": {
                    "type": "object",
                    "description": "Channel handle (in shadow manifest)",
                    "required": false,
                    "items": {
                        "channelId": {
                            "type": "string",
                            "description": "Channel ID",
                            "required": true
                        },
                        "userPrivateKey": {
                            "type": "string",
                            "description": "Private key for the channel",
                            "required": true
                        },
                        "channelServer": {
                            "type": "string",
                            "description": "Channel server URL",
                            "required": false
                        }
                    }
                }
            }
        },
        "socialProof": {
            "type": "array",
            "description": "Verification information about the app publisher",
            "required": false,
            "items": {
                "source": {
                    "type": "string",
                    "description": "Source of verification",
                    "required": true
                },
                "website": {
                    "type": "string",
                    "description": "Website URL",
                    "required": false
                },
                "twitter": {
                    "type": "string",
                    "description": "Twitter handle",
                    "required": false
                },
                "github": {
                    "type": "string",
                    "description": "GitHub username",
                    "required": false
                }
            }
        },
        "channelServer": {
            "type": "string",
            "description": "Channel server URL (added by the loader)",
            "required": false
        },
        "appServer": {
            "type": "string",
            "description": "Application server URL (added by the loader)",
            "required": false
        }
    };
    
    console.log(SEP);
    console.log("OS384 Manifest Schema");
    console.log(SEP);
    
    for (const [key, value] of Object.entries(schema)) {
        console.log(`${key}:`);
        console.log(`  Type: ${value.type}`);
        console.log(`  Description: ${value.description}`);
        console.log(`  Required: ${value.required ? "Yes" : "No"}`);
        
        if (value.type === "array" && value.items) {
            console.log("  Items:");
            for (const [itemKey, itemValue] of Object.entries(value.items)) {
                console.log(`    ${itemKey}:`);
                console.log(`      Type: ${itemValue.type}`);
                console.log(`      Description: ${itemValue.description}`);
                console.log(`      Required: ${itemValue.required ? "Yes" : "No"}`);
            }
        }
        
        console.log();
    }
    
    console.log(SEP);
    console.log("Example Manifest:");
    console.log(SEP);
    console.log(JSON.stringify(MANIFEST_TEMPLATE, null, 2));
    console.log(SEP);
}

// CLI command setup
await new Command()
    .name("384")
    .version(VERSION)
    .description(DOC_CLI)
    .action(function () { this.showHelp(); })
    .globalOption("-k, --key <key:string>", "Channel (user) private key", { required: false })
    .globalOption("-l, --local", "Use local servers", { default: false })
    .globalOption("-s, --server <server:string>", "Channel server to use (optional)", { default: DEFAULT_CHANNEL_SERVER })

    .command("channel")
    .description(DOC_CHANNEL)
    .option("-t, --token <token:string>", "Storage token", { required: false })
    .option("-b, --budget <budget:string>", "Budget channel key", { required: false })
    // .option("-a, --amount <amount:number>", "Budget amount in bytes", { required: false })
    .option(
        "-z, --size <size:string>",
        "Budget amount (size) in bytes (supports units like MB, GiB, K, etc)",
        (value: string): number => {
            const parsed = parseFileSize(value);
            return parsed;
        }
    )
    .action(async (options) => {
        await handleChannelOperation(preProcessOptions(options));
        denoExit(0);
    })

    // let's create a command "mint" which creates a storage token of the requested size
    .command("mint")
    .description("Mint a storage token of the requested size")
    .option(
        "-z, --size <size:string>",
        "Storage token size (defaults to 16 MiB if not provided)",
        (value: string): number => {
            // If no value is provided, use the default
            if (!value) return TOP_UP_INCREMENT;
            const parsed = parseFileSize(value);
            return parsed;
        }
    )
    .action(async (options) => {
        await handleMintOperation(preProcessOptions(options));
        denoExit(0);
    })

    .command("join")
    .description(`Join a channel as a visitor

If you omit the channel key, it'll generate a new one (keep track of it!)`)
    .arguments("<channelId:string>")
    .action(async ({ server, key }, channelId) => {
        const SB = new ChannelApi(server)
        let myKey = await new SB384(key).ready
        if (!key) {
            console.log(SEP, "Note, created new key (keep track of it):", SEP, myKey.userPrivateKey, SEP)
        }
        const h: ChannelHandle = {
            channelId: channelId,
            userPrivateKey: myKey.userPrivateKey
        }
        const channel = await SB.connect(h).ready
        console.log(SEP, "Channel connected:", SEP, channel.handle, SEP)
    })

    .command("send")
    .description(`Send a message to a channel`)
    .globalOption("-k, --key <key:string>", "Private key to join/send with", { required: false })
    .arguments("<channelId:string> <message:string>")
    .action(async ({ server, key }, channelId, message) => {
        const SB = new ChannelApi(server)
        let myKey = await new SB384(key).ready
        const h: ChannelHandle = {
            channelId: channelId,
            userPrivateKey: myKey.userPrivateKey
        }
        const channel = await SB.connect(h).ready
        const result = await channel.send(message)
        console.log(SEP, "Message sent:", SEP, result, SEP)
    })

    // ToDo: we have start, reverse, etc, in the other cli command that we want to migrate here
    .command("stream")
    .description(DOC_STREAM)
    .option("-e, --live", "Enable live streaming.", { default: false })
    .option("-d, --detail", "Enable detailed output (parses payloads).", { default: false })
    .option("-w, --wrapper", "Enable wrapper output (that wraps 'body').", { default: false })
    .action(async ({ server, key, live, detail, wrapper }) => {
        if (key) {
            await streamChannel(server, key, live, detail, wrapper);
        } else {
            console.error("Channel key is required for streaming");
            denoExit(1);
        }
    })

    .command("history")
    .description(`Show channel history`)
    .action(async ({ key }) => {
        if (key) {
            await printHistory(key);
        } else {
            console.error("Channel key is required for history info");
            denoExit(1);
        }
    })

    .command("key", "Create a new user key (or parse an existing one)")
            .description(DOC_KEY)
            .action(async ({ server, key }) => {
                await newUser(server, key);
                denoExit(0);
            })

            .command("sign")
            .description(`Signs provided string with the key (result in base62)`)
            .option("-k, --key <key:string>", "Private (user) key to use for signing", { required: true })
            .arguments("<str:string>")
            .action(async ({ key }, str) => {
                await signString(key, str);
            })

            .command("verify")
            .description(`Verifies a signature

        Takes a public (or private) key and a signature string (base62), and verifies the signature.`)
            .option("-k, --key <key:string>", "Private (user) key to use for signing", { required: true })
            .arguments("<str:string> <signature:string>")
            .action(async ({ key }, str, signature) => {
                await verifyString(key, str, signature);
            })

            .command("info")
            .description("Print (channel) server information")
            .action(async (options) => {
                await handleInfoCommand(preProcessOptions(options));
                denoExit(0);
            })

            .command("visitors")
            .description(`Shows a list of PN keys with the count of said keys

If you provide '--capacity', the this will update the channel to the new value.`)
            .option("-k, --key <key:string>", "Private key to use (for channel)", { required: true })
            .option("-c, --capacity <capacity:number>", "New capacity for the channel", { required: false })
            .action(async ({ server, key, capacity }) => {
                await getPubKeys(server, key);
                if (capacity) { await updateCapacity(server, key, capacity); }
            })

            // ToDo: simplify and align budget storage sources with other subcommands
            .command("publish")
            .description(DOC_PAGE)
            .option("-b, --budget <budget:string>", "Budget channel key (optional, uses OS384_BUDGET_KEY if not provided)", { required: false })
            .option("-f, --file <file:string>", "File to upload", { required: true })
            .option("-n, --name <name:string>", "Name to use for file (if omitted will use filename from -f)", { required: false })
            .option("-p, --prefix <prefix:number>", "Prefix length to use (if omitted will use 8)", { default: PREFIX_LENGTH })
            .action(async (options) => {
                const processedOptions = preProcessOptions(options);
                
                // The file option is marked as required in the command definition,
                // but TypeScript doesn't know that, so we need to check and assert
                if (!processedOptions.file) {
                    console.error("File is required");
                    denoExit(1);
                    return; // This is needed to satisfy TypeScript, even though denoExit will terminate execution
                }
                
                // Extract filename from path if name is not provided
                const filePath = processedOptions.file;
                const fileName = processedOptions.name || filePath.split('/').pop() || filePath;
                
                await publishFileAsPage(
                    filePath, 
                    fileName, 
                    processedOptions.server, 
                    processedOptions.prefix || PREFIX_LENGTH, 
                    processedOptions.budget, 
                    processedOptions.key
                );
                denoExit(0);
            })

            // ToDo: simplify and align budget storage sources with other subcommands
            .command("shardify")
            .description(DOC_SHARDIFY)
            .option("-b, --budget <budget:string>", "Private key to use as budget channel", { required: false })
            .option("-u, --url <key:string>", "URL to read from", { required: false })
            .option("-m, --minimal", "Only output minimal os384 handle", { default: false })
            .option("-o, --output <output:string>", "Output type", { default: "nostr" })
            .option("-f, --files [files...:string]", "One or more files", { required: false })
            // .arguments("<files...:string>")
            .action(async (options) => {
                await handleShardifyCommand(preProcessOptions(options));
                denoExit(0);
            })

            .command("fetch")
            .description("Fetch a shard and decrypt")
            .option("-f, --file <file:string>", "File to write to (default is stdout)", { required: false })
            .arguments("<id:string> <verification:string> <key:string>")
            .action(async (options, id, verification, key) => {
                await handleFetchOperation(preProcessOptions(options), id, verification, key);
                denoExit(0);
            })

            .command("phrase")
            .description(`Generate a random phrase\n
Default for 'n' is three (3), enough for most purposes. The dictionary corresponds to 14 bits
of entropy per word (eg three words is 42 bits, which is a good balance ).`)
            .arguments("[n:number]")
            .action(async (options, n) => {
                console.log(SEP, await generatePassPhrase(n), SEP);
                denoExit(0);
            })

            .command("pin")
            .description(`Generate a 4x4 'strongpin'\n
Generates a pin code of 4x4 chars for a total of 16 chars. Each set has 19 bits of entropy
for a total of 76 bits, which when combined with 42 bits from a 3-word '384 phrase' is strong.`)
            .action(async (options) => {
                console.log(SEP, await sbCrypto.strongpin.generate16(), SEP);
                denoExit(0);
            })

            .command("sbfs-upload")
            .description(`Create (or inspect) an SBFS filesystem (UNDER DEVELOPMENT)\n
This is a work in progress, and the command is not yet fully functional.\n
Key will be used as SBFS ledger key, and phrase as passphrase as additional
security. Other than budget (you need a budget channel source), either key or
phrase will be generated if they are not provided.`)
            .option("-b, --budget <budget:string>", "Budget channel key", { required: false })
            .option("-p, --phrase <phrase:string>", "Passphrase for SBFS", { required: false })
            .option("-n, --name <name:string>", "User name for SBFS", { required: false })
            .option("-f, --files [files...:string]", "One or more files to upload (as a set)", { required: false })
            .action(async (options) => {
                await handleSbfsCommand(preProcessOptions(options));
                denoExit(0);
            })

            // .command("manifest")
            // .description("Manage manifest files for os384 applications")
            // .action(function() { this.showHelp(); })
            
            .command("manifest-init")
            .description("Create a template manifest file (384.manifest.json)")
            .option("-o, --output <output:string>", "Output file path", { default: "384.manifest.json" })
            .option("-n, --name <name:string>", "Application name", { default: "My OS384 App" })
            .option("-s, --short-name <shortName:string>", "Short application name", { default: "MyApp" })
            .option("-d, --description <description:string>", "Application description", { default: "A distributed web application" })
            .option("-v, --version <version:string>", "Application version", { default: "1.0.0" })
            .option("-a, --author <author:string>", "Application author", { default: "Your Name" })
            .option("-p, --publisher <publisher:string>", "Publisher public key", { required: false })
            .option("-i, --appid <appid:string>", "Application ID", { required: false })
            .action(async (options) => {
                await handleManifestInitCommand(options);
                denoExit(0);
            })
            
            .command("manifest-resolve")
            .description("Resolve a manifest file into a shadow manifest file (.384.manifest.json)")
            .option("-i, --input <input:string>", "Input manifest file path", { default: "384.manifest.json" })
            .option("-o, --output <output:string>", "Output shadow manifest file path", { default: ".384.manifest.json" })
            .option("-b, --budget <budget:string>", "Budget channel key", { required: false })
            .option("-s, --server <server:string>", "Channel server to use", { default: DEFAULT_CHANNEL_SERVER })
            .action(async (options) => {
                await handleManifestResolveCommand(preProcessOptions(options));
                denoExit(0);
            })
            
            .command("manifest-validate")
            .description("Validate a manifest file")
            .option("-i, --input <input:string>", "Input manifest file path", { default: "384.manifest.json" })
            .action(async (options) => {
                await handleManifestValidateCommand(options);
                denoExit(0);
            })

            .command("manifest-schema")
            .description("Show the manifest schema with descriptions")
            .action(async () => {
                await handleManifestSchemaCommand();
                denoExit(0);
            })

            .parse(Deno.args);

