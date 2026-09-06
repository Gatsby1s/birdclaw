# Person archives

BirdClaw stores one person independently of any platform account. `/people` manages identities; a person can own several X accounts, public Telegram channels and uploaded source documents. Merging people keeps originals and source IDs, transfers outstanding unread events and preserves the former record with `merged_into`.

## Collection and coverage

- Existing follows become people without automatically spending a full-history quota on every legacy account. Explicitly adding an X source starts its Twillot history queue. Later new follows reuse the existing following-snapshot queue. Discovery follows the existing Twillot sync cadence; an X follow is not detected instantly.
- X identity uses the numeric profile identity where available. Missing numeric IDs are resolved through the configured, budgeted 6551 client before Twillot can run. Existing cloud collection also watches enabled person sources; pausing a source prevents new history claims. A batch already in progress may finish.
- Twillot reaching its available export means `caught_up_unverified`, never proof of all X history. Deleted/protected/unavailable content, vendor quota, expired sessions and provider limits remain observable constraints.
- Telegram collection reads public `t.me/s` pages. Historical pagination and incremental catch-up have independent durable cursors, including multi-page catch-up. Public-page exhaustion means only the visible public archive has been read. Private/invite-only channels and content/media unavailable on the public page require an authorized Telegram user API integration; this release does not include that credentialed collector.
- Telegram channel ownership is user-assigned. Forwarded attribution is preserved; a channel item is not automatically treated as a person's original statement.
- Media are separately queued and downloaded into the persistent volume. URLs alone never count as stored originals. The downloader has host/redirect restrictions, time and file-size limits, low-space protection and resumable retry state. Files over 100 MiB and unsupported content are explicitly unavailable. Media are not OCR/transcribed automatically.

## Uploaded sources and retrieval

Uploads accept PDF, UTF-8 TXT/Markdown/CSV/JSON, up to 20 MiB per file. Original bytes are retained in `/data/person-archive/documents`. PDF extraction uses `pdftotext` with a 30-second timeout and 8 MiB extracted-text ceiling. Scanned/no-text PDFs are marked `needs_ocr`; parse errors retain the original with `failed` status. No external model is called during upload.

`person_documents` is authoritative. Derived text chunks preserve page separators, have overlap and are replaced transactionally on content changes. FTS5 plus Unicode lexical matching serves the existing OAuth-protected, read-only `/mcp` search/fetch interface. This is lexical RAG, not vector/embedding retrieval. Examples:

- `search({query: 'person:"Person Name" topic'})`
- `search({query: 'person:PERSON_UUID topic'})`
- `fetch({id: 'doc:DOCUMENT_UUID:chunk:0'})`, then follow `metadata.next_chunk`

Tweet IDs remain compatible. Retrieval carries X Remark context and person/source provenance. Uploaded-file citations deep-link to the exact document in the person panel. Long document timeline responses contain bounded previews; retrieval indexes the extracted full text.

## Updates and operations

`person_events` provides monotone unread positions independent of publication dates. Historical initialization is not a new-message burst. Web clients receive authenticated SSE `archive-updated` notices and retain visible-only polling as a fallback; archive rows do not move under the reader. This release provides in-app push, not external Telegram/email/browser-background delivery.

The singleton production process owns source and media workers. `BIRDCLAW_PERSON_ARCHIVE_ENABLED=0` disables them. SQLite remains a single-writer database; do not add another process writing the volume. Source errors, history state, media success/pending/unavailable counts are visible in the panel. Low free space pauses safe writes rather than removing original evidence.

Schema version 22 is additive. `bin/migration-backup.mjs` requires a verified pre-v22 SQLite backup before opening the writable production database. Confirm enough volume capacity and an independent Railway volume backup before deployment. Rollback uses a forward-moving code fix/release; do not open schema 22 with a binary that only understands schema 21, and do not remove captured records to downgrade.
