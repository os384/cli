# 384 CLI

Command-line interface for [os384](https://384.dev). Provides the `384` command for
administering os384 servers, managing channels and storage, and publishing content.

## Install

Requires [Deno](https://deno.com) 2.x.

```sh
# Install Deno if you don't have it
brew install deno

# or: curl -fsSL https://deno.land/install.sh | sh

# Install 384 globally. It's always safe to toggle the date version to any value.
deno install -f --global -n 384 --allow-read --allow-write --allow-net --allow-env \
  https://c3.384.dev/api/v2/page/8yp0Lyfr/384.20260409.0.ts
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

## Development

```sh
# Run from source
deno task run -- --help

# Watch mode (auto-reload on changes)
deno task dev -- --help
```

The CLI imports lib384 from its deployed channel page at
`https://c3.384.dev/api/v2/page/H93wQduy/384.esm.js`. For local lib384
development, you can temporarily point the import back to `../dist/384.esm.js`
and use the workspace `deno.json` at `../` for local resolution.

## Architecture

The 384 CLI self-hosts its own distribution: `384 publish` is used to deploy
both lib384 and the CLI itself to channel pages on a 384 server. This means
the CLI and its sole dependency are served from the same infrastructure they
manage — no npm, no package registry, no binary releases needed.

## License

AGPL-3.0