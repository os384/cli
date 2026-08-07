/*
 * Copyright (C) 2022-2026 384, Inc.  AGPLv3 (see LICENSE).
 *
 * DP-04 Phase 1 — `384 app` command group.
 *
 *   384 app init     — create an app: mint key1 (app channel), fund it, build +
 *                      cross-sign the PermaFest, shard it -> AppId4, save a record,
 *                      print the launcher link.
 *   384 app release  — publish a version: key1-signed release on the app channel Page
 *                      (+ a channel message for history). Content shard is provided.
 *   384 app info     — fetch + verify a PermaFest link and resolve its current release.
 *
 * Attached to the root `384` command in 384.ts via `.command("app", appCommand)`.
 */

import type {} from "./domTypes.ts";

import { Command } from "jsr:@cliffy/command@1.0.0-rc.7";

// @deno-types="../dist/384.esm.d.ts"
import {
    SB384, ChannelApi, Channel, ObjectHandle,
} from "https://c3.384.dev/api/v2/page/H93wQduy/384.esm.20260330.2.js";

import {
    buildPermaFest, buildRelease, parseVerifyPermaFest, parseVerifyRelease,
    ReleaseBody, Ring,
} from "./permafest.ts";

const MiB = 1024 * 1024;
const TOP_UP_INCREMENT = 16 * MiB;
const SEP = "\n" + "=".repeat(80) + "\n";

const HOME = (Deno.build.os === "windows" ? Deno.env.get("USERPROFILE") : Deno.env.get("HOME")) || ".";
const OS384_CONFIG_PATH = Deno.env.get("OS384_CONFIG_HOME") || (HOME + "/.os384");
const APPS_DIR = OS384_CONFIG_PATH + "/apps";

const BUDGET_KEY = Deno.env.get("OS384_BUDGET_KEY") || Deno.env.get("SB384_BUDGET_CHANNEL_KEY");
const DEFAULT_CHANNEL_SERVER = Deno.env.get("OS384_CHANNEL_SERVER") || "https://c3.384.dev";
const DEFAULT_STORAGE_SERVER = Deno.env.get("OS384_STORAGE_SERVER") || "https://s3.384.dev";
const DEFAULT_LOADER = Deno.env.get("OS384_LOADER") || "https://384.dev";

function denoExit(n: number): never {
    Deno.exit(n);
}

interface AppRecord {
    appId4: { id: string; key: string; verification: string; storageServer?: string };
    key1Private: string;   // app channel owner private key
    channelServer: string;
    lastVersion: number;
}

/**
 * Parse an `id_verification_key[_auto]` fragment (or a full launcher URL that
 * contains one after `#`) into an ObjectHandle (minus server).
 */
function parseHandleFragment(frag: string, storageServer: string): ObjectHandle {
    const hashIdx = frag.lastIndexOf("#");
    const tail = hashIdx >= 0 ? frag.slice(hashIdx + 1) : frag;
    const parts = tail.split("_").filter((p) => p && p !== "auto");
    if (parts.length < 3) throw new Error(`bad handle fragment: ${frag}`);
    const [id, verification, key] = parts;
    return { id, verification, key, storageServer } as ObjectHandle;
}

function launcherLink(h: { id: string; verification: string; key: string }, loader: string): string {
    return `${loader}/#${h.id}_${h.verification}_${h.key}_auto`;
}

async function readRecord(appId: string): Promise<AppRecord> {
    const path = `${APPS_DIR}/${appId}.json`;
    return JSON.parse(await Deno.readTextFile(path)) as AppRecord;
}

async function writeRecord(rec: AppRecord): Promise<void> {
    await Deno.mkdir(APPS_DIR, { recursive: true });
    await Deno.writeTextFile(`${APPS_DIR}/${rec.appId4.id}.json`, JSON.stringify(rec, null, 2));
}

// ---------------------------------------------------------------------------

async function appInit(opts: {
    publisher?: string; budget?: string; server: string; loader: string;
}): Promise<void> {
    const publisherKey = opts.publisher;
    const budgetKey = opts.budget || BUDGET_KEY;
    if (!publisherKey) { console.error("--publisher (key2 private key) is required"); denoExit(1); }
    if (!budgetKey) { console.error("No budget source (--budget or OS384_BUDGET_KEY)"); denoExit(1); }

    const server = opts.server;
    const SB = new ChannelApi(server);
    const budget = await new Channel(budgetKey!).ready;

    // key2 — the (cold) publisher identity
    const key2 = await new SB384(publisherKey!, true).ready;
    // key1 — a fresh app channel identity (warm)
    const key1 = await new SB384().ready;
    if (key1.userPublicKey === key2.userPublicKey) { console.error("key1 == key2 (internal)"); denoExit(1); }

    // create + fund the app channel (owned by key1)
    console.log(SEP, "Creating + funding app channel ...", SEP);
    let appChannel = await new Channel(key1.userPrivateKey).ready;
    appChannel.channelServer = server;
    const token = await budget.getStorageToken(TOP_UP_INCREMENT);
    appChannel = await appChannel.create(token);
    console.log("App channel:", appChannel.handle.channelId);

    // build + cross-sign the PermaFest, shard it -> AppId4
    const { payload } = await buildPermaFest(key1, key2, server);
    const appId4: ObjectHandle = await SB.storage.storeData(new Uint8Array(payload), budget);
    const id = appId4.id!;
    const key = appId4.key!;
    const verification = await appId4.verification!;
    const storageServer = appId4.storageServer || DEFAULT_STORAGE_SERVER;

    const rec: AppRecord = {
        appId4: { id, key, verification, storageServer },
        key1Private: key1.userPrivateKey,
        channelServer: server,
        lastVersion: 0,
    };
    await writeRecord(rec);

    const link = launcherLink({ id, verification, key }, opts.loader);
    console.log(SEP, "App created.", SEP);
    console.log("AppId4 :", id);
    console.log("Record :", `${APPS_DIR}/${id}.json`);
    console.log("Publisher (key2):", key2.userPublicKey);
    console.log(SEP, "Launcher link (share this):\n", link, SEP);
    console.log("Next: `384 app release --app", id, "--content <id_verification_key> --ring resident`");
}

async function appRelease(opts: {
    app?: string; content?: string; ring: string; version?: number;
    name?: string; icon?: string; description?: string;
    budget?: string; storageServer: string;
}): Promise<void> {
    if (!opts.app) { console.error("--app <AppId4> is required"); denoExit(1); }
    if (!opts.content) { console.error("--content <id_verification_key> is required"); denoExit(1); }
    if (opts.ring !== "isolated" && opts.ring !== "resident") {
        console.error("--ring must be 'isolated' or 'resident'"); denoExit(1);
    }

    const rec = await readRecord(opts.app!);
    const key1 = await new SB384(rec.key1Private, true).ready;
    const appChannel = await new Channel(rec.key1Private).ready;
    appChannel.channelServer = rec.channelServer;

    const content = parseHandleFragment(opts.content!, opts.storageServer);
    const v = opts.version ?? (rec.lastVersion + 1);
    if (v <= rec.lastVersion) {
        console.error(`version ${v} is not greater than last published version ${rec.lastVersion}`);
        denoExit(1);
    }

    const meta: Record<string, unknown> = {};
    if (opts.name) meta.name = opts.name;
    if (opts.icon) meta.icon = opts.icon;
    if (opts.description) meta.description = opts.description;

    const body: ReleaseBody = { v, content, ring: opts.ring as Ring, meta };
    const releaseBytes = await buildRelease(key1, body);

    console.log(SEP, `Publishing release v${v} (ring=${opts.ring}) ...`, SEP);
    const setPageOnce = async () =>
        appChannel.setPage({ page: new Uint8Array(releaseBytes), type: "application/x-os384-release" });
    try {
        await setPageOnce();
    } catch (e) {
        // most likely insufficient channel storage — top up once and retry
        const budgetKey = opts.budget || BUDGET_KEY;
        if (!budgetKey) throw e;
        console.log(".. setPage failed, topping up channel storage and retrying ...");
        const budget = await new Channel(budgetKey).ready;
        await budget.budd({ targetChannel: appChannel.handle, size: TOP_UP_INCREMENT });
        await setPageOnce();
    }

    // also append the release as a channel message (verifiable monotonic history)
    try {
        await appChannel.send(body);
    } catch (e) {
        console.warn(".. (warning) could not append release history message:", (e as Error).message);
    }

    rec.lastVersion = v;
    await writeRecord(rec);

    console.log(SEP, `Release v${v} published. Existing launcher links now resolve to it.`, SEP);
}

async function appInfo(link: string, opts: { storageServer: string }): Promise<void> {
    const handle = parseHandleFragment(link, opts.storageServer);
    const SB = new ChannelApi(DEFAULT_CHANNEL_SERVER);
    const fetched = await SB.storage.fetchData(handle);
    const raw = await SB.storage.fetchPayload(fetched as ObjectHandle) as ArrayBuffer;

    const pf = await parseVerifyPermaFest(raw);
    console.log(SEP, "PermaFest verified.", SEP);
    console.log("key1 (app channel):", pf.key1);
    console.log("key2 (publisher)  :", pf.key2);
    console.log("defaultServer     :", pf.defaultServer);

    const key1 = await new SB384(pf.key1).ready;
    const releaseServer = pf.defaultServer || DEFAULT_CHANNEL_SERVER;
    const page = await new ChannelApi(releaseServer).getPage(key1.hashB32);
    if (!page || !page.payload) { console.log("\n(no release published yet)"); return; }
    const release = await parseVerifyRelease(page.payload as ArrayBuffer, pf.key1);
    console.log(SEP, `Current release: v${release.v} (ring=${release.ring})`, SEP);
    console.log("content :", release.content);
    console.log("meta    :", release.meta);
}

// ---------------------------------------------------------------------------

export const appCommand = new Command()
    .description("DP-04 app publishing (PermaFest / AppId4)")
    .action(function (this: Command) { this.showHelp(); })

    .command("init", "Create a new app: mint key1, fund channel, build + shard the PermaFest")
    .option("-p, --publisher <key:string>", "Publisher (key2) private key", { required: false })
    .option("-b, --budget <key:string>", "Budget channel private key (or OS384_BUDGET_KEY)", { required: false })
    .option("-s, --server <server:string>", "Channel server", { default: DEFAULT_CHANNEL_SERVER })
    .option("--loader <url:string>", "Loader origin for the launcher link", { default: DEFAULT_LOADER })
    .action(async (opts) => { await appInit(opts as any); denoExit(0); })

    .command("release", "Publish a new version (key1-signed release on the app channel Page)")
    .option("-a, --app <appId4:string>", "AppId4 (the app record id)", { required: true })
    .option("-c, --content <handle:string>", "Content fileset shard: id_verification_key", { required: true })
    .option("-r, --ring <ring:string>", "'isolated' or 'resident'", { default: "isolated" })
    .option("-v, --version <n:number>", "Version (default: last + 1)", { required: false })
    .option("--name <name:string>", "App display name", { required: false })
    .option("--icon <icon:string>", "App icon (url/data)", { required: false })
    .option("--description <text:string>", "App description", { required: false })
    .option("-b, --budget <key:string>", "Budget key for storage top-up (or OS384_BUDGET_KEY)", { required: false })
    .option("--storage-server <url:string>", "Storage server for the content handle", { default: DEFAULT_STORAGE_SERVER })
    .action(async (opts) => {
        await appRelease({ ...(opts as any), storageServer: (opts as any).storageServer });
        denoExit(0);
    })

    .command("info", "Fetch + verify a PermaFest link and resolve its current release")
    .option("--storage-server <url:string>", "Storage server for the AppId4 shard", { default: DEFAULT_STORAGE_SERVER })
    .arguments("<link:string>")
    .action(async (opts, link) => { await appInfo(link, { storageServer: (opts as any).storageServer }); denoExit(0); });
