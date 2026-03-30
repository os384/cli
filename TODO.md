# TODO — cli

Need to sort out / finalize build pipe - we're using 'deno install'
which is fine but it does aggressive caching, so, we need to finalize
how we cache bust so that the correct lib384 is loaded by 384.ts.
if anything in lib384 is changed for 384's use, both need to cache
bust and deno reinstall. can't just reinstall same file name
(convention is having version numbers in path for jsr libraries
for example).

(NOTE: below AI thoughts, not vetted yet, ignore)

## High priority (RC3 blocker)

- [ ] **Test CLI runs** — `deno task run --help` should work. Verify against
      a local running stack (storage + channel servers).
- [ ] **Strip proprietary notices** — replace any "Copyright 384 Inc" comments
      with GPL-3.0 headers.
- [ ] **Verify lib384 import** — confirm `@os384/lib384` resolves correctly
      in the Deno workspace.

## Medium priority

- [ ] **Implement `mint-tokens` command** — generate pre-signed storage tokens
      for the paywall pool. Requires storage server's private key (from env).
      Output: array of signed token strings suitable for paywall admin API.
- [ ] **Update os384.land configuration** — the install URL
      `https://os384.land/cli/384.ts` needs to serve this repo's `src/384.ts`.
- [ ] **Homebrew formula** — update `384co/homebrew-os384-cli` to point at
      `os384/cli` releases once first tag is cut.

## Lower priority / future

- [ ] Compiled binary releases (GitHub Actions → `deno compile` → attach to release)
- [ ] Shell completion (Cliffy supports this)
