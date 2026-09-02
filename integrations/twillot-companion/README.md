# BirdClaw Twillot history companion

This integration builds two local copies of the user-installed official Twillot Chrome extension:

- a BirdClaw bridge that claims queued history jobs and reads Twillot's extension-origin IndexedDB **read-only**;
- a vanilla rollback copy with the official Twillot code and no BirdClaw assets.

The builder never edits or overwrites Chrome's managed extension directory. Both generated copies preserve the official manifest `key`, so Chrome derives Twillot's audited extension ID `flkokionhgagpmnhlngldhbfnblmenen`. That exact origin is the only extension origin accepted by BirdClaw's companion endpoint.

## Safety boundary

The companion:

- supports only the audited official Twillot `11.0.8` package and checks the official key, localized-name file, service-worker loader hash, and worker-chunk hash before building;
- expects IndexedDB `twillot` version `41`, stores `posts` and `settings`, key path `id`, and the audited `public_index` schema; an unexpected version/store/index stops the job without writing to the database;
- opens all IndexedDB transactions as `readonly` and never calls `put`, `add`, `delete`, or `clear`;
- never reads `chrome.storage.session`, X authorization headers, cookies, or Twillot/X private APIs;
- never clicks Twillot's **Start** button. The page companion only shows a lightweight prompt and tells the worker that the matching page is open;
- sends data only to BirdClaw's exact production HTTPS endpoint or a configured uncredentialed `http://127.0.0.1`, `http://localhost`, or `http://[::1]` development endpoint;
- stores the pairing token only in the generated extension's `chrome.storage.local` and never displays or logs it;
- records the existing per-user `lastSyncTime` when a job is claimed and does not open the export page until that baseline read succeeds; it then waits for a strictly newer value that remains unchanged across two scans at least five seconds apart before it reads any posts;
- keeps freshness baselines/approvals isolated by BirdClaw job and target, so interleaved queue jobs cannot overwrite one another;
- projects every IndexedDB row onto BirdClaw's explicit post/media whitelist; raw rows, `_data`, `conversations`, unknown fields, and other private nested data are never uploaded. Quoted posts use a separate strict one-level whitelist;
- excludes `video` and `animated_gif` media plus all `video_info` variants while retaining the surrounding post text and references;
- persists one exact batch in a local outbox before POST and retries the same stable `batchId` with exponential backoff from 30 seconds to a 15-minute ceiling;
- discards the batch lease after every accepted batch and reclaims the server-owned cursor before reading the next batch; a `409 STALE_LEASE` safely drops only the stale outbox/lease and also reclaims;
- treats storage-not-ready and temporary IndexedDB read failures as retryable. Only audited version/schema, missing cursor, record-limit, or body-size violations are reported as permanent job errors;
- limits a batch to 200 records and 1.5 MB, below BirdClaw's 500-record/16 MB server bounds;
- reports the terminal state only as `caught_up_unverified`. It never claims `verified_complete`.

The copied official Twillot code retains its existing X/Twillot permissions because the copy must remain a functioning Twillot extension. The BirdClaw injection adds only `alarms`, loopback host access, an options page, and a prompt content script. It does not use the official extension's X credentials.

The upload projection permits only `id`, `tweet_id`, `conversation_id`, `owner_id`, `user_id`, `category_name`, `sort_index`, `created_at`, `full_text`, `screen_name`, `username`, `avatar_url`, `lang`, `views_count`, `bookmark_count`, `favorite_count`, `quote_count`, `reply_count`, `retweet_count`, `is_reply`, `is_quote`, `reply_to_id`, `quoted_tweet_id`, normalized `entities`, normalized photo `media_items`, and a one-level normalized `quoted_tweet`. Each photo item permits only `media_key`, `id`, `type`, `url`, `preview_image_url`, `media_url`, `media_url_https`, `width`, and `height`.

`tweet_id` must come from an audited Twillot tweet identifier (`tweet_id`, `rest_id`, legacy `id_str`, or a bare numeric primary ID). A composite IndexedDB key such as `<tweet>_<owner>_public-post` is never used as `tweet_id`; a row without a valid identifier fails closed. Distinct media `media_key` and `id` values remain distinct.

## Before building

1. Keep the official Twillot extension installed. Do **not** uninstall or click **Remove**; uninstalling an extension can delete its extension-origin IndexedDB.
2. Open `chrome://extensions`, enable **Developer mode**, and confirm Twillot is version `11.0.8` with ID `flkokionhgagpmnhlngldhbfnblmenen`.
3. Open `chrome://version` and note the active **Profile Path**. Extension storage is profile-specific.
4. Open BirdClaw Cloud Settings and create a Twillot companion pairing token.

The official version directory normally looks like:

```text
<Profile Path>/Extensions/flkokionhgagpmnhlngldhbfnblmenen/11.0.8_0
```

Never choose that managed directory in Chrome's **Load unpacked** dialog. The builder treats it as read-only and creates safe copies elsewhere.

## Build

From the BirdClaw repository:

```bash
node integrations/twillot-companion/build.mjs \
  --source "/absolute/path/to/Extensions/flkokionhgagpmnhlngldhbfnblmenen/11.0.8_0"
```

Defaults:

```text
Bridge:   ~/.birdclaw/twillot-bridge
Rollback: ~/.birdclaw/twillot-official-rollback
```

Custom output paths are supported:

```bash
node integrations/twillot-companion/build.mjs \
  --source "/absolute/path/to/the/official/11.0.8_0" \
  --destination "/absolute/path/to/twillot-bridge" \
  --rollback-destination "/absolute/path/to/twillot-official-rollback"
```

The builder refuses symlinks/special files, nested source/output paths, an unrecognized official package, or an existing output without the matching BirdClaw marker. Rebuilding marked outputs uses staged copies and rollback-safe replacement.

## Load and pair

1. In `chrome://extensions`, click **Load unpacked** and select `~/.birdclaw/twillot-bridge`.
2. Chrome may replace the active code for the same extension ID. That is expected; do not click **Remove**.
3. Open the extension's **Options** page.
4. Keep the default endpoint `https://birdclaw-production.up.railway.app/api/integrations/twillot-history`, paste BirdClaw's pairing token, and choose **Save and check queue**.

The worker creates one stable `sourceId`, then:

1. claims at most 200 records from `GET /api/integrations/twillot-history?sourceId=…&requestedCap=200`;
2. reads and persists the queued account's pre-export `lastSyncTime` baseline; if Twillot storage is temporarily unavailable, it retains the job and retries without opening the export page;
3. only after the baseline is safe, opens the queued account's official Twillot export page and waits for the user to click Twillot's **Start** control;
4. compares the matching `public-post_<externalUserId>_*_lastSyncTime` with the baseline captured at claim; an old cached value cannot start or complete an import;
5. after a strictly newer value is observed, waits for the same value in a second scan at least five seconds later, then streams only `category_name="public-post"` rows whose `user_id` and `screen_name` match the leased BirdClaw job;
6. posts `heartbeat`, `batch`, or `error` actions to the same companion endpoint;
7. sends only `id`, tweet/account identifiers, counts/flags, text metadata, normalized `entities`, photo media, and one-level quoted-post context; it never serializes the full IndexedDB row or video media;
8. after BirdClaw accepts a stable batch, drops the old lease and issues a new GET so the server returns the authoritative next cursor and allowance;
9. stops when the day's lease allowance is exhausted. The persistent server queue makes the account eligible again after the next Asia/Shanghai quota reset.

## Roll back

Use **Load unpacked** again and select `~/.birdclaw/twillot-official-rollback`. It preserves the official extension key and worker byte-for-byte, apart from unpacked-incompatible `update_url` and `_metadata`, and contains no BirdClaw injection.

Do not load the Chrome-managed source directory and do not uninstall Twillot during rollback.

## Verify

```bash
for test_file in integrations/twillot-companion/test/*.test.mjs; do
  node --test "$test_file" || exit 1
done
```

The tests cover audited-source build/rollback, key preservation, permissions, single-endpoint claim/batch protocol, stable source identity, exponential outbox retry, stale-lease recovery, fresh-sync gating, per-batch cursor reclaim, strict payload projection, trusted-page matching, database version/store/index fail-closed checks, exact public-user filtering, cursor resume, allowance bounds, and the prompt-only page boundary.

## Data completeness

Only tweets Twillot can still retrieve and store as public data can be imported. Deleted tweets, protected-account content, platform omissions, and Twillot/X-side gaps cannot be reconstructed. `lastSyncTime` is evidence that Twillot recorded a local sync, not proof that every historical tweet exists, so BirdClaw intentionally records `caught_up_unverified`.
