# BirdClaw X Remark bridge

This builder creates two local copies of the user-installed official X Remark Chrome extension: a BirdClaw bridge and a separate vanilla rollback copy. It does **not** edit or overwrite the Chrome-managed official installation directory.

Both generated copies keep the official manifest `key`, so Chrome derives the same extension ID. The bridge removes `update_url`, adds only the permissions required for local sync, injects a same-page IndexedDB observer before the official sidepanel module, and is written to `~/.birdclaw/xremark-bridge` by default. The vanilla copy preserves the official loader, sidepanel, and application code, removes only unpacked-incompatible `update_url` and `_metadata`, adds no bridge assets or options, and is written to `~/.birdclaw/xremark-official-rollback`.

## Before starting

1. Use X Remark's own backup/export feature once. Keeping a fresh backup is the safest rollback.
2. Keep the official extension installed. Do **not** uninstall or remove it: Chrome can delete extension-origin IndexedDB data during uninstall.
3. Start BirdClaw on `http://127.0.0.1:3001` and create/copy an X Remark pairing token from BirdClaw.
4. Use the same Chrome profile in which the X Remark notes already exist. Extension storage is profile-specific.

## Locate the official extension directory

Open `chrome://extensions`, enable **Developer mode**, and copy the X Remark extension ID. Then open `chrome://version` and note **Profile Path**.

The installed directory is normally:

```text
<Profile Path>/Extensions/<X Remark extension ID>/<installed version>
```

Select the version directory that directly contains `manifest.json` and `service-worker-loader.js`.

> **Never select this Chrome-managed directory in “Load unpacked.”** Chromium's unpacked installer removes `_metadata` from the selected directory. The builder reads this directory only and creates safe copies elsewhere; always load one of those copies.

## Build the bridge

From the BirdClaw repository:

```bash
node integrations/xremark-bridge/build.mjs \
  --source "/absolute/path/to/the/official/X-Remark/version-directory"
```

To choose another generated destination:

```bash
node integrations/xremark-bridge/build.mjs \
  --source "/absolute/path/to/the/official/X-Remark/version-directory" \
  --destination "/absolute/path/to/xremark-bridge" \
  --rollback-destination "/absolute/path/to/xremark-official-rollback"
```

If only `--destination` is customized, the rollback copy is created as its sibling directory named `xremark-official-rollback`.

The builder refuses to:

- use nested source, bridge, or rollback directories;
- copy symlinks or special files from the source;
- continue if the official manifest key cannot be preserved;
- overwrite either output unless it carries the matching BirdClaw bridge or rollback marker.

Re-running the builder performs rollback-safe atomic replacement of both marked outputs. This is useful after X Remark updates: point `--source` at the newest managed version directory, rebuild both copies, and reload the bridge copy. The source manifest, loader, sidepanel, application code, `_metadata/computed_hashes.json`, and `_metadata/verified_contents.json` remain untouched.

## Load and pair

1. Keep `chrome://extensions` open with **Developer mode** enabled.
2. Click **Load unpacked** and choose `~/.birdclaw/xremark-bridge` (or the custom destination).
3. Chrome may replace the active code for the same extension ID; that is expected. Do not click **Remove** on the extension entry.
4. Open the extension's **Options** page.
5. Paste the pairing token from BirdClaw and click **Save & sync**.

The options page shows whether the token is configured, current sequence, sync state, last successful sync, and the last safe error message. It never displays the stored token.

## Roll back safely

To return to vanilla official code without uninstalling the extension, use **Load unpacked** again and select only `~/.birdclaw/xremark-official-rollback` (or the explicit `--rollback-destination`). It has the same extension key and official code but contains no BirdClaw injection.

Never select the Chrome-managed source directory shown under `<Profile Path>/Extensions/...`, even for rollback. Never click **Remove** on the extension entry until an X Remark export has been confirmed.

## Sync behavior

The injected background bridge:

- listens for X Remark's existing remark, tag, and category mutation messages;
- observes direct sidepanel IndexedDB `add`, `put`, `delete`, `clear`, cursor `update`, and cursor `delete` calls without changing their return values. Multiple writes in one transaction produce one notification, only after that transaction completes successfully;
- debounces bursts for 800 ms and reads a full, read-only IndexedDB snapshot from `xRemark` stores `remarks`, `tags`, and `categories`;
- persists pending mutation state before the debounce, preventing heartbeat, retry, pairing, or manual-sync paths from sending a pre-mutation snapshot. Pending mutation counts advance the persistent `sequence` only when the post-debounce snapshot is captured;
- persists the latest full snapshot in a local outbox before sending it;
- posts to `http://127.0.0.1:3001/api/integrations/xremark/snapshot` with `Authorization: Bearer <token>`;
- retries failures with a Chrome alarm and keeps the outbox until BirdClaw accepts it;
- sends a fresh full-snapshot heartbeat at least every five minutes while paired. Heartbeats keep the existing sequence; a newer `capturedAt` lets BirdClaw reapply the current full snapshot and update `lastSeenAt` without advancing the mutation sequence.

The snapshot body has this shape:

```json
{
	"sourceId": "persistent UUID",
	"sequence": 1,
	"capturedAt": 1770000000000,
	"database": {
		"name": "xRemark",
		"version": 1,
		"backupID": "birdclaw:<sourceId>:<sequence>",
		"backupTime": 1770000000000
	},
	"remarks": [],
	"tags": [],
	"categories": []
}
```

The bridge never writes to X Remark's IndexedDB. If database enumeration is unavailable, an unexpected `onupgradeneeded` event is aborted so opening a missing database cannot create one. The bridge does not log snapshots, note contents, or pairing tokens. A failed snapshot remains only in the generated extension's local `chrome.storage.local` outbox so it can be retried.

## Verify

The tests use synthetic fixtures only:

```bash
node --test integrations/xremark-bridge/test/*.test.mjs
```

They verify manifest-key preservation, byte-identical managed-source metadata, vanilla rollback output, independent marker/overwrite safety, permission patching, worker and pre-module sidepanel injection, direct/bulk IndexedDB transactions, mutation debounce, alarm/manual-sync race gates, missing-database aborts, the API contract, private-data-free status/logging, persistent retry, pairing, and the five-minute same-sequence heartbeat.

## Compatibility notes

- The bridge expects Manifest V3, `service-worker-loader.js`, and a module script in `sidepanel.html`, matching the currently supported official X Remark packaging.
- If a future X Remark release renames its database stores or worker loader, the builder/runtime stops with a visible error instead of modifying unknown data.
- The generated copy intentionally has no Web Store `update_url`; rebuild it from a newly installed official release when upgrading.
