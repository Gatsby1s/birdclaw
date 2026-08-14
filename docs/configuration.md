---
title: Configuration
description: "birdclaw config files, env vars, transport precedence, and multi-account profiles."
---

# Configuration

birdclaw reads configuration from these layers:

1. **Command flags** — for example `--account`, `--mode`, and `--transport`.
2. **Environment variables** — global paths plus feature-specific overrides.
3. **User config** — `~/.birdclaw/config.json`, or the file selected by `BIRDCLAW_CONFIG`.

## Storage root

The default root is `~/.birdclaw`. It holds:

```text
~/.birdclaw/
  birdclaw.sqlite              # canonical local truth
  config.json                  # user config
  media/                       # original media cache
  media/thumbs/avatars/        # avatar cache
  audit/                       # JSONL audit logs (e.g. bookmarks-sync.jsonl)
  logs/                        # launchd stdout/stderr
  locks/                       # job lock files
```

Override the root for one process:

```bash
export BIRDCLAW_HOME=/path/to/custom/root
```

The Playwright test home is `.playwright-home` in the repo, which is why CI never touches the production root.

## Config file

`~/.birdclaw/config.json` controls live transport, scheduled jobs, mention sourcing, and backup auto-sync.

```json
{
	"actions": {
		"transport": "auto"
	},
	"mentions": {
		"dataSource": "bird",
		"birdCommand": "/Users/steipete/Projects/bird/bird"
	},
	"backup": {
		"repoPath": "/Users/bijiben/Projects/backup-birdclaw",
		"remote": "https://github.com/Gatsby1s/backup-birdclaw.git",
		"autoSync": true,
		"staleAfterSeconds": 900
	}
}
```

### `actions.transport`

- `auto` — try `bird` first for block/unblock/mute, then fall back to verified `xurl`
- `bird` — force `bird`
- `xurl` — force `xurl`; verifies through `bird status` before mutating SQLite

Twitter still rejects pure OAuth2 block writes for many accounts, so `auto` is the safe default.

### `mentions.dataSource`

- `birdclaw` — local cache only
- `bird` — refresh through `bird mentions --json`, normalize, cache in SQLite
- `xurl` — refresh through `xurl mentions`, cache the response shape

`mentions.birdCommand` overrides the `bird` binary path when you want to point at a non-`PATH` build.

### `backup.*`

See [Backup](backup.md). When `autoSync` is enabled, read commands pull + merge from Git only when the last check is stale, and data-changing commands push back automatically. Set `BIRDCLAW_BACKUP_AUTO_SYNC=0` to disable for one process.

## Environment variables

| Variable                                    | Purpose                                                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BIRDCLAW_HOME`                             | Override the storage root (`~/.birdclaw` by default)                                                                                                 |
| `BIRDCLAW_CONFIG`                           | Read and write config at a non-default path                                                                                                          |
| `BIRDCLAW_ACTIONS_TRANSPORT`                | Override moderation action transport with `auto`, `xurl`, or `bird` for one process                                                                  |
| `BIRDCLAW_HOST`                             | Host interface for the production `birdclaw serve` listener; defaults to `127.0.0.1`                                                                 |
| `BIRDCLAW_PORT`                             | Port for the production `birdclaw serve` listener; defaults to `3000`                                                                                |
| `BIRDCLAW_ALLOWED_HOSTS`                    | Comma-separated extra hostnames accepted by the source `pnpm dev` server                                                                             |
| `BIRDCLAW_LOCAL_WEB`                        | Internal local-server mode; production derives local access from the peer socket, while forwarded/proxied requests still require remote-token config |
| `BIRDCLAW_WEB_TOKEN`                        | App-level token for remote login; browsers receive a signed HttpOnly session, while API clients may send `x-birdclaw-token`                          |
| `BIRDCLAW_ALLOW_REMOTE_WEB`                 | Set to `1` to allow remote access through a trusted private proxy                                                                                    |
| `BIRDCLAW_DISABLE_LIVE_WRITES`              | Set to `1` to block any live mutation (used by tests and CI)                                                                                         |
| `BIRDCLAW_FXTWITTER_ENABLED`                | Set to `1` to use the free public FxTwitter API instead of paid 6551 for watched-account and target-thread recovery                                 |
| `BIRDCLAW_FXTWITTER_BACKFILL_MINUTES`       | Minutes between free FxTwitter targeted recovery polls; defaults to the configured recovery interval                                                |
| `BIRDCLAW_6551_ENABLED`                     | Set to `1` to run the 6551 realtime worker in the production web process                                                                             |
| `BIRDCLAW_6551_ACCOUNT_ID`                  | BirdClaw account scope used by 6551; set it to the same account ID uploaded by the local bridge                                                      |
| `BIRDCLAW_6551_WATCH_USERS`                 | Comma-separated X handles to monitor and recovery-sync                                                                                               |
| `BIRDCLAW_6551_TARGET_TWEETS`               | Comma-separated tweet IDs to preserve and refresh with quote tweets                                                                                  |
| `BIRDCLAW_6551_BACKFILL_MINUTES`            | Minutes between latest-100 recovery polls; defaults to `120`                                                                                         |
| `BIRDCLAW_6551_REST_ONLY`                   | Set to `1` to skip Watch/WebSocket entirely and run only periodic REST recovery polling                                                              |
| `BIRDCLAW_6551_FAILOVER_MODE`               | Set to `1` to keep 6551 on standby while an authenticated local bridge heartbeat is fresh                                                            |
| `BIRDCLAW_LOCAL_STALE_SECONDS`              | Seconds without a local heartbeat before the configured Twitter recovery source takes over; defaults to `180`                                        |
| `BIRDCLAW_LOCAL_BRIDGE_TOKEN`               | Cloud-side secret accepted only by the local bridge ingest endpoint                                                                                  |
| `BIRDCLAW_CLOUD_BRIDGE_URL`                 | Local Mac destination URL for heartbeat and incremental timeline upload                                                                              |
| `BIRDCLAW_CLOUD_BRIDGE_TOKEN`               | Local Mac copy of the cloud bridge secret                                                                                                            |
| `BIRDCLAW_CLOUD_BRIDGE_INTERVAL_SECONDS`    | Local heartbeat and upload interval; defaults to `60`                                                                                                |
| `BIRDCLAW_CLOUD_BRIDGE_LOOKBACK_HOURS`      | Bounded replay window used when no acknowledged local cursor exists; defaults to `24`                                                                |
| `BIRDCLAW_LOCAL_COLLECTOR_ENABLED`          | Set to `1` on the Mac to collect watched accounts and target threads through the local `bird` session before heartbeating                            |
| `BIRDCLAW_LOCAL_COLLECTOR_HOME_TIMELINE_ENABLED` | Set to `1` with the local collector to refresh the complete Following home timeline in the background before heartbeating                        |
| `BIRDCLAW_LOCAL_COLLECTOR_WATCH_USERS`      | Local comma-separated account watch list; may mirror the 6551 watch list                                                                             |
| `BIRDCLAW_LOCAL_COLLECTOR_TARGET_TWEETS`    | Local comma-separated target posts whose threads and quote tweets are refreshed                                                                      |
| `BIRDCLAW_LOCAL_COLLECTOR_ACCOUNT_ID`       | Optional local account scope to collect and upload; defaults to BirdClaw's default account                                                           |
| `BIRDCLAW_LOCAL_COLLECTOR_INTERVAL_SECONDS` | Local collection interval; defaults to `120`                                                                                                         |
| `BIRDCLAW_LOCAL_COLLECTOR_MAX_RESULTS`      | Result limit for each local collector request, including the Following timeline; defaults to `100`                                                   |
| `TWITTER_TOKEN`                             | 6551 Bearer token; `OPENNEWS_TOKEN` is accepted as a compatibility fallback                                                                          |
| `BIRDCLAW_BACKUP_AUTO_SYNC`                 | Set to `0` to disable auto-sync for one process                                                                                                      |
| `NO_COLOR`                                  | Disable ANSI color in human output                                                                                                                   |
| `OPENAI_API_KEY`                            | Enable inbox scoring and low-signal filtering                                                                                                        |
| `DEEPSEEK_API_KEY`                          | Enable automatic tweet translation through the dedicated DeepSeek API                                                                                |
| `DEEPSEEK_BASE_URL`                         | Optional DeepSeek-compatible base URL; defaults to `https://api.deepseek.com`                                                                        |
| `BIRDCLAW_TRANSLATION_MODEL`                | Automatic translation model; defaults to `deepseek-v4-flash`                                                                                         |

`BIRDCLAW_DISABLE_LIVE_WRITES=1` is set automatically in CI and Playwright runs so test code can never publish a tweet, send a DM, or block an account.

## Multi-account

birdclaw was built around multiple accounts in a single shared database from day one. Pass `--account <id>` on commands that support account selection, including moderation, mentions, DMs, and live sync commands.

Per-account state — cursors, transport preferences, last-sync watermarks, OpenAI score caches — lives inside the same `birdclaw.sqlite`. There is no per-account directory tree.

## Transport selection

There is no single global transport order:

- Archive imports and local reads need no live transport.
- Sync commands select their source with `--mode`; supported modes and defaults vary by command.
- Mentions export resolves its data source separately.
- Moderation writes use command `--transport`, then `BIRDCLAW_ACTIONS_TRANSPORT`, then `actions.transport`, then `auto`.

For moderation, `auto` tries bird first and falls back to xurl. Persist that choice with `birdclaw auth use <auto|bird|xurl>`.

## Disabling live writes

For dry runs, demos, or development against a fresh archive:

```bash
export BIRDCLAW_DISABLE_LIVE_WRITES=1
birdclaw compose post "this will not actually post"
birdclaw blocks add @someone --account acct_primary
```

Both commands record the intent locally where applicable but skip every transport call. Tests and CI rely on this exact mechanism.
