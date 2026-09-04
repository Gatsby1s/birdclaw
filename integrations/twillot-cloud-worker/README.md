# BirdClaw Twillot cloud worker

This service runs the audited official Twillot 11.0.8 extension in an isolated,
persistent Chromium profile on Railway. It keeps the account scope in sync and
executes BirdClaw history jobs only after FxTwitter leaves a per-account gap.

It does not call an unpublished Twillot API. The official CRX is downloaded from
Google, unpacked, and verified by the same pinned manifest, key, worker, locale,
and chunk hashes used by the desktop companion.

Required Railway setup:

- service config path: `integrations/twillot-cloud-worker/railway.json`
- persistent volume mounted at `/data`
- `BIRDCLAW_TWILLOT_TOKEN`: a dedicated BirdClaw pairing token
- `BIRDCLAW_TWILLOT_ENDPOINT`: normally the production history endpoint
- `BIRDCLAW_TWILLOT_BOOTSTRAP_B64`: one-time, allowlisted X/Twillot cookies and
  local storage; remove this Railway secret after `session_bootstrap_applied`
- a one-time dedicated X/Twillot session bootstrap in the persistent profile

The worker never logs the pairing token, cookies, browser storage, or X request
headers. The main BirdClaw service must enable
`BIRDCLAW_CLOUD_ALL_FOLLOWING_ENABLED=1` and
`BIRDCLAW_TWILLOT_CLOUD_FALLBACK_ENABLED=1`.
