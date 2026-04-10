# AGENTS — cli

Read `/os384/AGENTS.md` (workspace root) first for overall context.

## What this is

The `384` command-line tool. Manages channels, uploads/downloads shards,
generates storage tokens, deploys lib384 artifacts to channel pages, and
bootstraps wallets.

## Key facts

- Entry point: `src/384.ts`
- Installed globally as `384` via:
  ```sh
  deno install --global -n 384 --allow-read --allow-write --allow-net --allow-env \
    https://os384.land/cli/384.ts
  ```
  (os384.land not yet configured — will point to this repo's `src/384.ts`)
- Built with [Cliffy](https://cliffy.land/) (`jsr:@cliffy/command`) for arg parsing
- Uses `@os384/lib384` (local workspace path in dev, channel page URL in production)

## Key files

```
cli/
├── src/
│   ├── 384.ts               Main CLI entry point — command definitions
│   ├── publish.page.ts      Deploy content to an os384 channel page
│   ├── read.channel.ts      Read messages from a channel
│   ├── payload.ts           Shard payload helpers
│   ├── LocalStorage.ts      localStorage abstraction (for Deno context)
│   ├── domTypes.ts          DOM type stubs
│   ├── utils.lib.ts         Shared utilities
│   └── generate.random.string.ts
├── deno.json
└── .gitignore
```

## Build & run

```sh
deno task run            # run from source (dev)
deno task dev            # watch mode
deno task build          # compile to bin/384 (standalone binary)
```

## Commands (current, from 384.ts)

Browse `src/384.ts` for current command list. Known commands include:
channel management, shard upload/download, page publish, wallet bootstrap.

## Commands to add

- `mint-tokens --budget 1gb --count 10` — generate pre-signed storage tokens
  for the paywall pool. Requires storage server credentials in env.

## Deno workspace

In the workspace, `@os384/lib384` resolves to `../lib384/src/index.ts`.
For production install (non-workspace), lib384 is loaded from its channel page URL.

## What NOT to do

- Do NOT use the `CLI/` directory in the archive — that is the deprecated
  Snackabra CLI. The source here was copied from `lib-proto-03/cli.tools/`.
- Do NOT import npm packages (no node_modules, no package.json).
- Do NOT commit `env.js` — holds channel keys / server credentials.
