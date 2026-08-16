# 384 CLI

*Part of the [os384 superproject](https://github.com/os384/os384) — start
there for what os384 is, the workspace map, and conventions. This file covers
only what's local to this repo.*

The `384` command: administering os384 servers, managing channels and storage,
minting tokens, and publishing content and apps to channel pages.

## Install

Requires [Deno](https://deno.com) 2.x.

```sh
# Install Deno if you don't have it
brew install deno

# or: curl -fsSL https://deno.land/install.sh | sh

# Install 384 globally. It's always safe to toggle the date version to any value
# (channel pages serve the current build regardless — the date is a cache-buster).
deno install -f --global -n 384 --allow-read --allow-write --allow-net --allow-env \
  https://c3.384.dev/api/v2/page/8yp0Lyfr/384.20260404.0.ts
```

Make sure `~/.deno/bin` is on your PATH:

```sh
export PATH="$HOME/.deno/bin:$PATH"
```

Add that line to your `~/.zshrc` or `~/.bashrc` to make it permanent.

Note that os384 uses os384 for "package management".

## Usage

```sh
384 --help
384 channel create -s https://c3.384.dev
384 publish -k <key> -f <file>
384 storage token -s https://c3.384.dev
```

Subcommands have their own help screens. See the CLI guide in
[../docs/docs/cli.md](../docs/docs/cli.md) for the full reference.

## Development

```sh
# Run from source
deno task run -- --help

# Watch mode (auto-reload on changes)
deno task dev -- --help
```

The CLI imports lib384 from its deployed channel page. For local lib384
development, point the import at the sibling submodule's build
(`../lib/dist/384.esm.js`) instead — and remember lib384 consumers see
`dist/`, not `src/`, so rebuild lib first (see [../lib/](../lib/)).

`src/` holds the merged `384` command (`384.ts`) — most earlier standalone
CLI tools have been refactored into it ("v1" and "v3" historical scripts are
archived); a few specific commands remain as standalone files in `src/`.

## Architecture

The 384 CLI self-hosts its own distribution: `384 publish` is used to deploy
both lib384 and the CLI itself to channel pages on a 384 server. This means
the CLI and its sole dependency are served from the same infrastructure they
manage — no npm, no package registry, no binary releases needed.

## License

Copyright (C) 2022–2026, 384, Inc. "384" and "os384" are registered
trademarks. Released under AGPLv3 — see [LICENSE](LICENSE).
