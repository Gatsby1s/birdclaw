# BirdClaw cloud deployment with 6551

BirdClaw can run as one persistent Railway service. The web server and the
6551 realtime worker intentionally share one process and one SQLite database.
Keep the service at one replica.

## Railway setup

1. Deploy this repository with the included `Dockerfile`.
2. Add one persistent volume mounted at `/data`.
3. Generate a Railway domain. A custom domain is optional.
4. Set these private variables:

```text
BIRDCLAW_HOME=/data
BIRDCLAW_HOST=0.0.0.0
BIRDCLAW_ALLOW_REMOTE_WEB=1
BIRDCLAW_WEB_TOKEN=<a unique web login passphrase>
BIRDCLAW_DISABLE_LIVE_WRITES=1
BIRDCLAW_6551_ENABLED=1
BIRDCLAW_6551_WATCH_USERS=TingHu888
BIRDCLAW_6551_TARGET_TWEETS=2082353480547660173
BIRDCLAW_6551_BACKFILL_MINUTES=120
TWITTER_TOKEN=<the 6551 API token>
```

`PORT` is supplied by Railway automatically. Never put either token in Git,
`config.json`, a Docker image, or logs.

Open the Railway domain and sign in through `/login`. BirdClaw stores a signed,
HttpOnly, Secure, SameSite cookie for 30 days. `/logout` clears it.

## Recovery behavior

- WebSocket events are written to `twitter6551_events` before processing.
- Duplicate events and tweets are idempotent.
- BirdClaw fetches the latest 100 tweets for each watched account every 120
  minutes and after reconnecting.
- Target posts and their quote tweets are also refreshed.
- If the current 6551 plan does not allow Watch/WebSocket, REST recovery
  polling continues and Settings reports a degraded state.

6551 monitors account activity; it does not guarantee every third-party reply
to a particular post. The public REST API also exposes no complete reply cursor,
so BirdClaw must not describe this feed as a full conversation archive.

## Operations

The anonymous `/healthz` endpoint returns only web/worker health. The Settings
page shows realtime connection, last recovery sync, errors, and a manual sync
button.

Enable Railway volume backups. Use a private Git backup as a one-way disaster
recovery copy from the cloud writer; do not let local and cloud databases both
push divergent backup histories.
