/*
 * Copyright (C) 2022-2026 384, Inc.
 * AGPLv3 (see LICENSE).
 *
 * DP-04 Phase 1 — PermaFest + release format helpers.
 *
 * A PermaFest is the immutable, content-addressed identity of an app: it binds
 * an app-channel key (key1) to a publisher key (key2) with mutual signatures.
 * Sharding it yields AppId4 (the permanent, clickable app id). Releases are
 * key1-signed records stored as the app channel's Page.
 *
 * This module is the canonical contract. The loader carries a verify-only mirror
 * at loader-v02/src/helpers/PermaFest.ts — keep the two byte-compatible.
 */

import type {} from "./domTypes.ts";

// @deno-types="../dist/384.esm.d.ts"
import {
    SB384,
    sbCrypto,
    assemblePayload,
    extractPayload,
    arrayBufferToBase62,
    base62ToArrayBuffer,
    ObjectHandle,
} from "https://c3.384.dev/api/v2/page/H93wQduy/384.esm.20260330.2.js";

export const PERMAFEST_FMT = "permafest-1";
export const SIG_LEN = 96; // raw ECDSA P-384 signature (r||s, 48+48)

export type Ring = "isolated" | "resident";

export interface PermaFest {
    fmt: string;
    key1: string;          // SBUserPublicKey — app channel identity (owner)
    key2: string;          // SBUserPublicKey — publisher identity (cold)
    defaultServer: string; // UNSIGNED bootstrap hint (transport is untrusted)
    sig1: string;          // b62 ECDSA by key1 over the binding
    sig2: string;          // b62 ECDSA by key2 over the binding
}

export interface ReleaseBody {
    v: number;                 // strictly monotonic per app (anti-rollback basis)
    content: ObjectHandle;     // the v03 fileset shard handle (provided input)
    ring: Ring;
    meta?: Record<string, unknown>;
}

/**
 * Canonical signed binding: exactly {fmt, key1, key2}, in this field order,
 * excluding defaultServer and the signatures. assemblePayload is deterministic,
 * so this is byte-identical on Deno (CLI) and in the browser (loader).
 */
function bindingBytes(fmt: string, key1Pub: string, key2Pub: string): ArrayBuffer {
    const b = assemblePayload({ fmt, key1: key1Pub, key2: key2Pub });
    if (!b) throw new Error("[permafest] assemblePayload(binding) returned null");
    return b;
}

/**
 * Build a PermaFest from two READY private SB384 keys. key1 (app channel) must
 * differ from key2 (publisher). Returns the structure and its assembled payload
 * (shard this payload to obtain AppId4).
 */
export async function buildPermaFest(
    key1: SB384,
    key2: SB384,
    defaultServer: string,
): Promise<{ permafest: PermaFest; payload: ArrayBuffer }> {
    const k1 = key1.userPublicKey;
    const k2 = key2.userPublicKey;
    if (k1 === k2) throw new Error("[permafest] key1 (channel) must differ from key2 (publisher)");
    const bind = bindingBytes(PERMAFEST_FMT, k1, k2);
    const sig1 = arrayBufferToBase62(await sbCrypto.sign(key1.signKey, bind));
    const sig2 = arrayBufferToBase62(await sbCrypto.sign(key2.signKey, bind));
    const permafest: PermaFest = { fmt: PERMAFEST_FMT, key1: k1, key2: k2, defaultServer, sig1, sig2 };
    const payload = assemblePayload(permafest);
    if (!payload) throw new Error("[permafest] assemblePayload(permafest) returned null");
    return { permafest, payload };
}

/**
 * Parse + verify a PermaFest payload. Verifies both cross-signatures over the
 * binding. Throws on any failure. Returns the two public keys + the server hint.
 */
export async function parseVerifyPermaFest(
    buf: ArrayBuffer,
): Promise<{ key1: string; key2: string; defaultServer: string }> {
    const pf = extractPayload(buf).payload as PermaFest;
    if (!pf || pf.fmt !== PERMAFEST_FMT) throw new Error("[permafest] not a permafest-1 payload");
    if (!pf.key1 || !pf.key2) throw new Error("[permafest] missing key1/key2");
    if (pf.key1 === pf.key2) throw new Error("[permafest] key1 must differ from key2");
    const bind = bindingBytes(pf.fmt, pf.key1, pf.key2);
    const k1 = await new SB384(pf.key1).ready;
    const k2 = await new SB384(pf.key2).ready;
    const ok1 = await sbCrypto.verify(k1.signKey, base62ToArrayBuffer(pf.sig1), bind);
    const ok2 = await sbCrypto.verify(k2.signKey, base62ToArrayBuffer(pf.sig2), bind);
    if (!ok1) throw new Error("[permafest] key1 (channel) binding signature invalid");
    if (!ok2) throw new Error("[permafest] key2 (publisher) binding signature invalid");
    return { key1: pf.key1, key2: pf.key2, defaultServer: pf.defaultServer };
}

/**
 * Build a key1-signed release payload: assemblePayload(body) ++ raw key1 sig.
 * Appending the signature byte-wise makes the Page self-certifying against the
 * untrusted channel server. key1 must be a READY private SB384.
 */
export async function buildRelease(key1: SB384, body: ReleaseBody): Promise<ArrayBuffer> {
    const frontBuf = assemblePayload(body);
    if (!frontBuf) throw new Error("[permafest] assemblePayload(release) returned null");
    const front = new Uint8Array(frontBuf);
    const sig = new Uint8Array(await sbCrypto.sign(key1.signKey, frontBuf));
    if (sig.length !== SIG_LEN) throw new Error(`[permafest] unexpected sig length ${sig.length}`);
    const out = new Uint8Array(front.length + sig.length);
    out.set(front, 0);
    out.set(sig, front.length);
    return out.buffer;
}

/**
 * Parse + verify a release payload against key1 (public key string). Splits the
 * trailing raw signature, verifies it, then extracts the body. Throws on failure.
 */
export async function parseVerifyRelease(buf: ArrayBuffer, key1Pub: string): Promise<ReleaseBody> {
    const bytes = new Uint8Array(buf);
    if (bytes.length <= SIG_LEN) throw new Error("[permafest] release payload too short");
    const frontLen = bytes.length - SIG_LEN;
    const front = bytes.slice(0, frontLen);
    const sig = bytes.slice(frontLen);
    const k1 = await new SB384(key1Pub).ready;
    const ok = await sbCrypto.verify(k1.signKey, sig.buffer as ArrayBuffer, front.buffer as ArrayBuffer);
    if (!ok) throw new Error("[permafest] release signature invalid");
    return extractPayload(front.buffer as ArrayBuffer).payload as ReleaseBody;
}
