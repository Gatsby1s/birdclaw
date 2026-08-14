# BirdClaw cloud deployment with free FxTwitter recovery and 6551 reserve

BirdClaw can run as one persistent Railway service. The web server and the
Twitter recovery worker intentionally share one process and one SQLite database.
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
BIRDCLAW_FXTWITTER_ENABLED=1
BIRDCLAW_FXTWITTER_BACKFILL_MINUTES=30
BIRDCLAW_6551_ENABLED=0
BIRDCLAW_6551_ACCOUNT_ID=acct_primary
BIRDCLAW_6551_WATCH_USERS=TingHu888
BIRDCLAW_6551_TARGET_TWEETS=2082353480547660173
BIRDCLAW_6551_BACKFILL_MINUTES=240
BIRDCLAW_6551_REST_ONLY=1
BIRDCLAW_6551_FAILOVER_MODE=1
BIRDCLAW_LOCAL_STALE_SECONDS=180
BIRDCLAW_LOCAL_BRIDGE_TOKEN=<a separate random bridge token>
TWITTER_TOKEN=<optional 6551 API token kept only for explicit paid recovery>
DEEPSEEK_API_KEY=<the DeepSeek API key used only for translation>
BIRDCLAW_TRANSLATION_MODEL=deepseek-v4-flash
```

`PORT` is supplied by Railway automatically. Never put tokens or provider API
keys in Git, `config.json`, a Docker image, or logs.

Open the Railway domain and sign in through `/login`. BirdClaw stores a signed,
HttpOnly, Secure, SameSite cookie for 30 days. `/logout` clears it.

On the Mac, set the matching bridge destination and token:

```text
BIRDCLAW_CLOUD_BRIDGE_URL=https://<railway-domain>
BIRDCLAW_CLOUD_BRIDGE_TOKEN=<the same random bridge token>
BIRDCLAW_CLOUD_BRIDGE_INTERVAL_SECONDS=60
BIRDCLAW_CLOUD_BRIDGE_LOOKBACK_HOURS=24
BIRDCLAW_LOCAL_COLLECTOR_ENABLED=1
BIRDCLAW_LOCAL_COLLECTOR_HOME_TIMELINE_ENABLED=1
BIRDCLAW_LOCAL_COLLECTOR_WATCH_USERS=TingHu888
BIRDCLAW_LOCAL_COLLECTOR_TARGET_TWEETS=2082353480547660173
BIRDCLAW_LOCAL_COLLECTOR_INTERVAL_SECONDS=120
BIRDCLAW_LOCAL_COLLECTOR_MAX_RESULTS=100
```

While the Mac is online, its BirdClaw production server refreshes the complete
Following home timeline, watched account, target thread, and quote tweets
through the local `bird` session every 120 seconds without depending on an open
browser tab. Normalized timeline increments continue uploading when a
supplemental target fails, so one partial failure cannot freeze the cloud Home
feed. The cloud accepts a heartbeat when it carries a fresh successful full
timeline attestation; supplemental watched-account or target failures stay
visible without forcing a recovery takeover. A watched-account-only success
cannot keep recovery on standby when the full timeline is stale. After the
configured stale window without a healthy heartbeat, free FxTwitter recovery
refreshes only the configured watched accounts and target threads. It does not
claim to rebuild the complete Following Home. A returning Mac replays the last
24 hours idempotently before the cloud process returns FxTwitter to standby.
Paid 6551 remains disabled unless an operator explicitly chooses it instead.

## Recovery behavior

- Local, FxTwitter, and 6551 writes share canonical tweet IDs, so handoff overlap
  is deduplicated.
- WebSocket events are written to `twitter6551_events` before processing.
- Duplicate events and tweets are idempotent.
- When `BIRDCLAW_FXTWITTER_ENABLED=1`, BirdClaw uses the public, no-key
  FxTwitter v2 API instead of paid 6551. It identifies itself with a BirdClaw
  User-Agent and performs no Watch or WebSocket calls.
- BirdClaw fetches the latest 100 public tweets for each watched account at the
  configured recovery interval and after reconnecting.
- Target posts, best-effort conversation search results, and quote tweets are
  also refreshed.
- Free recovery is fill-only: existing canonical tweets and Home edges from
  authenticated bird or archives are never overwritten by public FxTwitter
  data.
- Each watched account and target endpoint is isolated. Successful results are
  ingested when another target fails, and runtime status reports the partial
  failure as degraded.
- Native repost rows are skipped because the public API does not expose their
  wrapper ID or repost timestamp; treating the original post as the repost
  would create a false author and Home position.
- With `BIRDCLAW_6551_REST_ONLY=1`, BirdClaw never adds Watch entries or opens
  WebSocket connections. Settings reports healthy recovery polling after a
  successful REST sync and reserves error state for an actual REST failure.
- A failover worker recreated before `BIRDCLAW_6551_BACKFILL_MINUTES` elapses
  keeps the original next recovery due time instead of repeating the full REST
  poll immediately.

FxTwitter targeted recovery does not provide an authenticated Following Home,
protected-account content, or lossless native-retweet events. It must never
renew `homeTimelineSyncedAt` or be described as a complete Home feed. 6551 also
does not guarantee every third-party reply to a particular post, so neither
recovery source is a full conversation archive.

## Private RAG MCP

The cloud service also exposes the tweet archive as a read-only Streamable HTTP
MCP at `/mcp`. It deliberately provides no Ask page or hosted answer model:
ChatGPT supplies the conversation and reasoning, while BirdClaw supplies two
retrieval tools:

- `search(query)` returns up to 10 stable tweet document IDs, canonical X
  source URLs, and mandatory author judgment context from X Remark.
- `fetch(id)` returns the archived tweet plus available parent, quote, and reply
  context for grounded answers and citations. Every included author carries
  their own X Remark category, tags, personal note, and follow reason. An
  author without a record is explicitly marked `unlabeled`; missing annotation
  context must never be silently presented as neutral.

The local cloud bridge sends the authoritative X Remark snapshot after it has
caught up with tweet uploads, so cloud retrieval keeps labels such as `反指`
even when the author has not posted recently. Any future embedding/chunk index
must copy this author context into every chunk and include it in the chunk
content hash. Editing an author annotation must therefore invalidate and
rebuild affected derived chunks.

Private archive access uses a separate OAuth 2.1 resource-server boundary. Do
not reuse `BIRDCLAW_WEB_TOKEN` or the local bridge token. Configure an
established identity provider that supports MCP discovery and client
registration, then set:

```text
BIRDCLAW_MCP_ISSUER=https://<identity-provider-issuer>/
BIRDCLAW_MCP_RESOURCE_URL=https://<railway-domain>/mcp
BIRDCLAW_MCP_AUDIENCE=https://<railway-domain>/mcp
BIRDCLAW_MCP_JWKS_URL=https://<identity-provider-issuer>/.well-known/jwks.json
BIRDCLAW_MCP_SCOPE=birdclaw:read
BIRDCLAW_MCP_ALLOWED_SUBJECTS=<authorized OAuth subject IDs, comma-separated>
```

The MCP fails closed until all required authentication settings and at least
one subject allowlist entry are present. Its protected-resource metadata is at
`/.well-known/oauth-protected-resource`. Tokens are verified for signature,
issuer, audience, expiry, scope, and subject on every request.

## Operations

The anonymous `/healthz` endpoint returns only web/worker health. The Settings
page shows realtime connection, last recovery sync, errors, and a manual sync
button.

Enable Railway volume backups. Use a private Git backup as a one-way disaster
recovery copy from the cloud writer; do not let local and cloud databases both
push divergent backup histories.
