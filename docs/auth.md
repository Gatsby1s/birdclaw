---
title: Sign in
description: "How birdclaw connects to your Twitter/X account: pick a transport, set it up once, verify with auth status."
---

# Sign in

birdclaw does **not** run its own OAuth flow. It piggybacks on credentials that already exist on your machine via one of three pluggable *transports*. Pick the one that fits your use case, set it up once, and `birdclaw` will use it for live reads and writes.

If you only want to import an exported archive ZIP and read it locally, you can skip this page entirely — archive import works with no credentials at all.

## Pick a transport

| Transport | Auth model | What it covers | When to pick it |
|---|---|---|---|
| **xurl** | Official X API v2, OAuth2 | likes, bookmarks, blocks, mutes, authored tweets, posting | First choice. Most "above board". Revocable from x.com app settings. |
| **bird** | Session cookies extracted from your logged-in browser | DMs, mentions, timeline, block fallback — surfaces xurl can't reach or where it gets rate-limited | Add alongside xurl for full coverage. |
| **archive-only** | None | Whatever is in the archive ZIP you import | Pick this if you'd rather not wire live access at all. |

You can have xurl, bird, both, or neither. The `auto` transport mode used by most commands tries xurl first and falls back to bird.

## Set up xurl

birdclaw shells out to the external [`xurl`](https://github.com/xdevplatform/xurl) CLI; it does not own `~/.xurl` itself.

```bash
brew install xdevplatform/tap/xurl
xurl auth login
```

Full install options and notes are in [Install → Optional: xurl](install.md#optional-xurl).

## Set up bird

bird extracts `auth_token` and `ct0` cookies from your already-logged-in browser (Safari, Chrome, or Firefox) and caches them under `~/.bird`. birdclaw shells out to it the same way it does for xurl.

```bash
brew install steipete/tap/bird
bird auth import-cookies
```

Full install options, scheduled-job caveats, and the env-var override for `launchd` are in [Install → Optional: bird](install.md#optional-bird).

## Verify

```bash
birdclaw auth status --json
```

What to look for in the output:

- **Nothing wired** — `transport` is `archive` (or `local`). Live sync will skip with a warning, archive import still works.
- **xurl active** — `transport` is `xurl` and an account id is listed. Live sync uses the official API.
- **bird active** — `transport` shows bird is available; it'll be used as a fallback or as the primary for surfaces xurl can't reach.

If `auth status` looks wrong, re-run the matching transport's auth command (`xurl auth login` or `bird auth import-cookies`) and try again.

## Change the default transport

Most commands accept `--mode <auto|xurl|bird>` (or `--transport`) and `auto` is the default. To change the default for every run, pick one:

- **For a single shell session** — `export BIRDCLAW_ACTIONS_TRANSPORT=xurl` (or `bird`, `auto`).
- **Persistently** — edit `~/.birdclaw/config.json` and set `actions.transport`:

  ```json
  {
    "actions": { "transport": "xurl" }
  }
  ```

  Allowed values: `auto`, `xurl`, `bird`. See `resolveActionsTransport` in `src/lib/config.ts` for the resolution order (per-command flag → env var → config file → `auto`).

## Privacy notes

The non-OAuth transports work by re-using your existing browser session. That's worth being explicit about:

- **bird** reads `auth_token` and `ct0` cookies from your browser cookie store once at `import-cookies` time and caches them in `~/.bird`. These are full session credentials — anyone with read access to that file can act as you on x.com until the session expires.
- **x-web** (an experimental transport noted in [Configuration → Transport precedence](configuration.md#transport-precedence)) reads the same cookies on every request via [`@steipete/sweet-cookie`](https://www.npmjs.com/package/@steipete/sweet-cookie). See `src/lib/x-web.ts` for the exact request shape.
- Both paths are revoked the moment you log out of x.com in the browser they were extracted from.
- **xurl** is the only path with proper scopes and an app-revocation flow at <https://x.com/settings/connected_apps>.

If any of that feels wrong, stick to xurl, or run in archive-only mode.

## Multiple accounts

Per-account profiles, `BIRDCLAW_ACCOUNT`, and config-driven transport overrides are in [Configuration](configuration.md). The same transport setup applies — bird and xurl each manage their own credentials, and birdclaw picks the right one per command.
