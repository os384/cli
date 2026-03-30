# JSR — Future Directions

Notes on adopting JSR (the JavaScript Registry, built by the Deno team) for both
lib384 and the 384 CLI. Not scheduled; captured here so the thinking doesn't drift away.

---

## Background

JSR is the JavaScript registry built by the Deno team and open-sourced under MIT.
It is TypeScript-native, ESM-only, and cross-runtime (Deno, Node, Bun, workerd).
Deno's own standard library (`@std/*`) is published there. The protocol is open and
self-hostable.

The Deno team built it because npm is unsatisfying for a TypeScript-native, ESM-only
world. We agree.

---

## What we want

Two things, which are compatible but distinct:

**1. Publish to JSR proper** — `deno add @os384/lib384` and `deno add @os384/cli`
working natively, with no special configuration, for anyone in the Deno/JS ecosystem.
This is the path of least resistance for external developers who don't know or care
about os384's distribution model.

**2. os384 as a JSR-compatible registry** — c3.384.dev (or any os384 channel server)
serving the JSR metadata protocol, so that a developer can point Deno at an os384
instance and `deno add` packages directly from it. This is the sovereignty angle:
self-hostable, no dependency on jsr.io.

Both can coexist. JSR proper is the public-facing distribution point; os384 native is
the demonstration of what the platform can do and the fallback for self-hosters.

---

## The JSR protocol (what we'd need to implement)

JSR's wire format is minimal. For a package `@os384/lib384` at version `0.3.1`, Deno
fetches:

```
GET /meta.json
  → { "versions": { "0.3.1": {}, "0.3.0": {} }, "latest": "0.3.1" }

GET /0.3.1_meta.json
  → { "exports": { ".": "./src/index.ts" },
      "manifest": { "/src/index.ts": { "checksum": "sha256-..." }, ... } }

GET /0.3.1/src/index.ts
  → <source>
```

Each file in the manifest has a checksum Deno verifies on download. That maps cleanly
onto os384's content-addressing model — shard FNs are already content-derived.

The `meta.json` listing known versions is the only piece that requires dynamic
generation; the per-version manifests and source files are static once published.

---

## Mapping onto os384 concepts

| JSR concept | os384 equivalent |
|---|---|
| Package version | Channel (new version = new key = new channel ID) |
| Source file | Page served from that channel |
| `meta.json` | Dynamically generated from a "releases" channel |
| File checksum | Shard FN / content hash |
| `deno add @os384/cli` | Fetch from jsr.io or from a channel server that speaks the protocol |

The channel-per-version model is a natural fit: cutting a release means generating a
new key, creating a channel, publishing the source files as pages, and updating the
releases manifest. No manual versioning scheme needed — the channel ID is the version
fingerprint.

---

## Current workaround (cache busting)

While JSR support is pending, the install URL includes a version segment in the
filename so Deno treats each release as a new module:

```sh
deno install -f --global -n 384 --allow-read --allow-write --allow-net --allow-env \
  https://c3.384.dev/api/v2/page/<channel-id>/v0.3.1.384.ts
```

os384 returns the same content regardless of the filename — it's an anonymous blob
and the server will pretend whatever name you asked for. So bumping the filename
suffix in the install command is a zero-infrastructure cache bust. Works today;
JSR is the cleaner long-term answer.

---

## Deno workspaces (local co-development)

While iterating on lib384 and the CLI simultaneously, a root `deno.json` workspace
avoids the current `install384lib.sh` copy-dist dance:

```json
{
  "workspaces": ["../lib384", "."]
}
```

`@os384/lib384` then resolves to the local workspace member. When ready to publish,
the import reverts to the versioned JSR URL and the lockfile handles integrity.

---

## Open questions

- Does Deno support `DENO_REGISTRY_URL` (or equivalent) to redirect `jsr:` specifiers
  to a custom host? Needs verification against Deno 2.x docs.
- Scope name: `@os384` on jsr.io — is that claimed? Worth reserving early.
- Should lib384 and the CLI be separate JSR packages, or a monorepo with
  `@os384/lib384` and `@os384/cli` as workspace members published together?
- License: JSR packages are public. Confirm GPL-3.0 is compatible with jsr.io ToS.
