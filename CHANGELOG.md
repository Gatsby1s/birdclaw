# CHANGELOG

## 0.8.39 - 2026-07-22

### Added

- Play single tweet videos directly in the timeline with native controls, inline playback, responsive sizing, and the existing expanded media viewer.
- Preserve Bird video and animated-GIF URLs, posters, dimensions, duration, and media attachments during timeline synchronization.

### Fixed

- Keep GIF playback user-controlled and ensure expanding media leaves only one active player while restoring keyboard focus on close.

## 0.8.38 - 2026-07-22

### Fixed

- Treat fallback `t.co` links as opaque short codes so adjacent Chinese prose stays readable instead of becoming a percent-encoded blue URL.
- Reuse the same URL boundaries for background expansion, Links insights, and research exports to prevent malformed links from spreading beyond the timeline.

## 0.8.37 - 2026-07-20

### Added

- Add loopback-only real-time X Remark synchronization with one-time pairing tokens, persistent retry, full-snapshot deletion semantics, and immediate BirdClaw UI refresh.
- Ship a local bridge builder that preserves the official extension ID, observes committed IndexedDB remark changes without writing to X Remark, and produces a separate vanilla rollback copy.

### Security

- Restrict live snapshots to `127.0.0.1`, the exact X Remark extension origin, and a hashed high-entropy pairing token while rejecting forwarded requests and oversized payloads.
- Keep Chrome's managed X Remark installation untouched and forbid loading it as an unpacked extension; generated bridge and rollback directories are isolated and overwrite-protected.

## 0.8.36 - 2026-07-19

### Added

- Import X Remark JSON backups from Settings and match profile annotations by stable X user ID, with a guarded handle fallback for notes whose profile has not reached BirdClaw yet.
- Show private remarks, descriptions, categories, and tags across timelines, profile pages, previews, embedded posts, and conversation threads without adding them to AI analysis contexts or portable Git backups.

### Fixed

- Reject oversized or older X Remark snapshots before they can replace current local notes, and avoid attaching a note to a reused former handle when its stable profile is already known.

## 0.8.35 - 2026-07-19

### Fixed

- Show the source post beside Home media in a desktop X-style detail rail, with author, body, timestamp, known like/save state, and original-post access while retaining the full-screen media stage.
- Carry the same post context into quoted, reply-thread, native repost, and manual repost media; preserve the canonical original-post URL and keep media-only short links out of the detail body.

## 0.8.34 - 2026-07-19

### Fixed

- Open tweet media in a true full-viewport portal so Home timeline card containment can no longer clip the viewer or move it off-screen after scrolling.
- Add an X-style black media stage with close and gallery navigation controls, keyboard shortcuts, original-media access, 100–500% image zoom, and drag-to-pan while restoring page scroll and focus on close.

## 0.8.33 - 2026-07-19

### Fixed

- Size complete-PDF tweet media from its loaded proportions instead of fixed-height thumbnails, keeping ordinary images readable without letting them dominate the page.
- Split ultra-tall screenshots into ordered 55 mm print columns, prefer full-resolution image sources, and retain the prepared readable layout if Paged.js falls back.

## 0.8.32 - 2026-07-19

### Added

- Add a persistent Discuss history rail with time-grouped topics, summaries, theme labels, source and DM counts, pin/delete actions, search, and a responsive narrow-screen drawer.
- Restore saved discussions from a direct `run` URL without another model call, keep regenerated results as versions, and include cited source snapshots in the portable JSONL backup.

### Fixed

- Cancel active generation and stale restore requests when switching history entries, preventing late stream results from replacing the selected saved discussion.

## 0.8.31 - 2026-07-19

### Fixed

- Include cited tweet images and available video or GIF covers in both Today and Discuss complete PDF exports, using compact non-cropping grids and printing repeated sources' media only once.
- Bound image preparation before Paged.js pagination, retry original images when thumbnails fail, and replace unreachable media with a compact placeholder so one bad URL cannot stall the entire export.

## 0.8.30 - 2026-07-19

### Added

- Add `Export PDF` and `导出完整 PDF` actions to Discuss, preserving the existing on-screen summary export while building an A4 reference booklet from the completed discussion without rerunning it.
- Recover cited tweets and DMs from structured results and Markdown references, include complete cited private context, fill final Paged.js page references, and omit raw tweet URLs and like counts from the booklet.

## 0.8.29 - 2026-07-19

### Added

- Add a custom local date-and-time range to Today and Discuss, store the applied window in the URL, preserve it on refresh, and keep every existing preset available.
- Validate custom ranges before requests and keep the picker and preset controls usable in narrow layouts.

## 0.8.28 - 2026-07-19

### Fixed

- Keep complete reference PDF pagination working in production builds by feeding Paged.js only the dedicated print rules instead of the minified site-wide stylesheets.

## 0.8.27 - 2026-07-19

### Fixed

- Match Today's complete reference PDF to the approved print booklet: A4 cover, detailed contents, source matrix, topic summaries, prominent author identities, source cards, running footers, and a compact source index.
- Print the already paginated booklet so every contents and source-index page number matches the final PDF, while preserving uncited webpage text and full topic titles.

## 0.8.26 - 2026-07-18

### Added

- Add a `导出完整 PDF` action to Today that turns the currently rendered digest and its cited posts into a print-ready reference collection with reading navigation, topic grouping, page numbers, author/date metadata, and a source index, while preserving the existing summary PDF export.
- Keep the reference collection focused on reading by omitting like counts, original tweet links, and exact times while retaining shared external materials.

## 0.8.25 - 2026-07-18

### Fixed

- Render tweet citations wrapped in Chinese full-width punctuation as compact `source` links instead of exposing blue raw tweet IDs, while keeping the surrounding Discuss prose at the normal text color.

## 0.8.24 - 2026-07-18

### Fixed

- Hydrate avatars for text-only `RT @handle:` reposts across Bird, Xurl, and cached Home timeline syncs, including recent historical rows that no longer appear in the latest payload.
- Prefer hydrated and canonical profiles when legacy handle rows differ only by letter casing, preventing blank placeholders from winning timeline reads.

## 0.8.23 - 2026-07-18

### Added

- Add All, Today, 24h, Yesterday, and Week date-range filters to Discuss, with refreshes preserving the submitted time window.

### Fixed

- Scope Discuss citation links to trailing `source` labels so generated prose and ordinary Markdown links keep the normal text color, matching Today.
- Keep local Discuss sources local instead of running an unused live keyword sync before reading Home, Mentions, Authored, Likes, or Bookmarks.

## 0.8.22 - 2026-07-18

### Fixed

- Place Today topic headings inline before their matching discussion groups instead of collecting every topic in a separate summary at the top.
- Recover the same inline structure for cached flat-Markdown reports by matching cited tweet IDs, while requiring future reports to emit corresponding level-3 headings directly.

## 0.8.21 - 2026-07-18

### Fixed

- Preserve Chinese and other IME composition text in both Discuss inputs, syncing the URL only after the candidate text is committed.

## 0.8.20 - 2026-07-18

### Fixed

- Restore the Today digest's structured key-topic headings and summaries, including cached reports whose generated Markdown omits headings.
- Require future Today reports to use Markdown section headings and concise bold topic labels.

## 0.8.19 - 2026-07-18

### Fixed

- Hydrate original authors in reposts from bird raw user data, with a bounded `user-tweets` fallback for non-followed accounts and failed following-list lookups, so reposted posts render real avatars.

## 0.8.18 - 2026-06-30

### Fixed

- Hydrate Home timeline author profiles from bird profile/following data so newly followed accounts render real avatars instead of blank initials-only placeholders.

## 0.8.17 - 2026-06-29

### Added

- Add a global Settings page control for Profile Analyse sources: Local, XURL refresh, and 6551 refresh.
- Make Profile Analyse default to local archived tweets and replies for both the Analyse page and profile routes, with xurl kept as an explicit refresh source.

## 0.8.16 - 2026-06-29

### Fixed

- Keep ordinary Markdown title links in the Today digest body at the normal text color instead of the blue accent link color.

## 0.8.15 - 2026-06-29

### Fixed

- Keep Today digest citation links scoped to `source` labels so cited body text no longer turns blue.

## 0.8.14 - 2026-06-28

### Changed

- Replace the Home timeline auto-refresh minute input with fixed hourly choices from 1 to 24 hours, migrate legacy minute settings to at least 1 hour, and verify scheduled syncs refresh local timeline data.

## 0.8.13 - 2026-06-28

### Fixed

- Make the Home timeline `open` reply pill a real external link to the original X post, including hover/focus feedback.

## 0.8.12 - 2026-06-27

### Fixed

- Keep Home timeline auto-refresh timers on schedule across page rerenders, show a compact next-run status, and group the refresh controls into one toolbar.
- Restore the active Today digest period segment to the accent blue background with white text even when Tailwind utility order would otherwise keep the inactive transparent style.

## 0.8.11 - 2026-06-27

### Fixed

- Keep custom page numbers in exported Today digest PDFs while suppressing browser date and URL print chrome.

## 0.8.10 - 2026-06-27

### Fixed

- Route Today/digest and inbox OpenAI requests through `OPENAI_BASE_URL` again so local OpenAI-compatible gateways work.
- Redact OpenAI API keys from surfaced HTTP error messages.

## 0.8.9 - 2026-06-27

### Added

- Restore the Home timeline auto-refresh controls with a persisted custom minute interval next to `Sync timeline`.

## 0.8.8 - 2026-06-27

### Added

- Reload already-open local web tabs when the source-served 3001 app is rebuilt from a newer `Gatsby1s/birdclaw` commit.

## 0.8.7 - 2026-06-27

### Changed

- Point repository metadata, documentation links, docs-site links, backup examples, and request user-agent URLs at `Gatsby1s/birdclaw`.
- Restrict the Homebrew tap updater to manual dispatch for the `Gatsby1s` fork instead of firing automatically on every release.

## 0.8.6 - 2026-06-27

### Added

- Add a Home filter for replies to other accounts, including query/read-model support and route coverage.
- Add PDF export for digest summaries.

### Fixed

- Show full tweet text in Today citation popovers instead of truncating long posts after six lines.
- Show inline tweet images in Today citation popovers instead of leaving media-only `t.co` links in the preview text.
- Hydrate quoted and retweeted tweets so embedded timeline cards render the referenced post content.
- Keep yesterday digest cache lookups from reusing the wrong period summary.
- Normalize tweet timestamps before sorting timelines.

## 0.8.5 - 2026-06-21

### Fixed

- Keep large Likes, Bookmarks, and Today digest reads on indexed tweet lookups instead of blocking the web server with quadratic SQLite scans.
- Normalize legacy tweet URL entities at the API boundary so saved and quoted tweets remain readable without expanded-link metadata.

## 0.8.4 - 2026-06-19

### Changed

- Ship compiled CLI and production SSR/static artifacts, remove runtime TypeScript and Vite requirements, and validate installed npm tarballs end to end.
- Normalize tweet ownership and saved state into account edges and collections, add transactional schema migrations, and preserve older databases and backups through boundary adapters.
- Consolidate API schemas, NDJSON clients, React Query caches, profile codecs, moderation state, scheduled jobs, and live pagination while deleting superseded runtime paths.
- Split archive import, portable backup codecs, and CLI command registration into domain-owned modules with shared contract tests.
- Refresh runtime and development dependencies and resolve esbuild 0.28.1, clearing the active dependency advisory.
- Rank link insights with a lightweight first pass and hydrate only the requested top groups, substantially reducing all-time Links latency.

### Fixed

- Preserve backup JSONL rows containing Unicode line or paragraph separators during export and import. (#62 - thanks @uwe-schwarz)
- Derive unauthenticated local API access from the production server peer socket so spoofed host headers cannot bypass remote-access controls.
- Normalize legacy stored media types at the API boundary so older archives and backups remain readable through typed response contracts.

## 0.8.3 - 2026-06-15

### Changed

- Centralize SQLite writes and migrations, unify live-sync ingestion, and move retained web server state to TanStack Query for faster sidebar navigation and fewer duplicate reads.
- Isolate web reads onto query-only SQLite connections while serializing action and sync writes through one measured writer queue.
- Share page caps, cursor progression, delays, and repeated-cursor protection across live timeline, DM, and follow-graph sync.
- Stream archive arrays and backup JSONL records through resumable batches instead of buffering entire source files.
- Split query access into typed timeline, DM, status, resource, and action modules while retaining the existing compatibility import.
- Retain Blocks, Inbox, Data Sources, and Rate Limits server state in TanStack Query across sidebar navigation and targeted refreshes.
- Split compose, inbox, follow-graph, database, and backup CLI registration into domain-owned command modules.

### Fixed

- Preload hover-preview avatars after page load so citation and profile cards open with cached thumbnails.

## 0.8.2 - 2026-06-15

### Fixed

- Wait for concurrent SQLite writers before starting write transactions and avoid unnecessary legacy backfill writes during normal startup.
- Retain timeline and DM data across sidebar navigation, deduplicate status reads, debounce searches, skip unused Spotlight archive scans in web status, and remove TanStack debug controls.
- Keep tweet and profile hover previews outside wrapped links, flip them to the roomier vertical side, and constrain them to the viewport.
- Expand Twitter Articles into titled preview cards and citation popovers instead of showing bare `t.co` links.

## 0.8.1 - 2026-06-13

### Changed

- Refresh dependency backstop updates for `@steipete/sweet-cookie`, `@types/node`, the adopted TypeScript native-preview toolchain, and the pnpm 10 package-manager pin.
- Remove the separate public read-only web profile; deployments can expose the full private app behind an external authentication boundary.
- Show recent web timestamps as live relative time, then switch to calendar dates with exact local time on hover.

### Fixed

- Open long-running AI streams immediately, keep the Today digest within proxy limits by using the locally synchronized archive, and show actionable retry errors when a connection is interrupted.
- Reuse freshly generated Today reports across reloads while background sync updates the archive, and hydrate locally stored cited tweets so source hovercards remain available outside the selected time window.

## 0.8.0 - 2026-06-10

### Added

- Add localized Today/digest reports through `--language <locale-id>`, `BIRDCLAW_DIGEST_LANGUAGE`, and the period-digest API, with canonical locale validation and separate caches. (#47 - thanks @yujiawei)

### Changed

- Update runtime and development dependencies, align TanStack Start packages, and move pnpm's native build allowlist into workspace configuration.

### Fixed

- Add accurate archive-first Sign in and archive-request onboarding, including account-binding requirements, current xurl/bird setup, scoped transport selection, and clean autolink rendering. (#46 - thanks @peetzweg)
- Respect `OPENAI_BASE_URL` when sending Today/digest requests to OpenAI-compatible API endpoints.
- Anchor Link Insights' Today range to UTC midnight so it matches stored `created_at` timestamps across local time zones.

## 0.7.0 - 2026-06-01

### Added

- Stream live `birdclaw import archive` progress to stderr: per-slice parsing ticks (tweets, DMs, likes, bookmarks, follows, media) and chunked write-phase progress every 1,000 rows for profiles, tweets, likes+bookmarks, and DM messages. `--json` still keeps stdout clean for scripting.
- Add `birdclaw discuss <query>` and a Discuss web view for live keyword search via `bird`/`xurl`, persisted search-result tweets, and streaming OpenAI summaries with optional private DM context.
- Add `birdclaw profile-analyze <handle>` plus a Profile Analyse web view that backfills profile timelines and conversation context through `xurl`, caches the fetched context and AI result in SQLite, and exposes Analyse actions on tweet cards.
- Add canonical `/profiles/:handle` pages with profile headers and cached Profile Analyse output.
- Add a Rate Limits web view for observed `xurl` profile-analysis calls, 429s, local throttle settings, and documented X API recent-search windows.
- Add a Network Map web view for current followers/following, with SQLite geocode caching, OpenCage refreshes, Mapbox rendering, and a local fallback map.
- Render Network Map clusters as avatar stacks with relationship-weighted rings and avatar-rich profile/cluster overlays.
- Make the Network Map people list follow the current viewport with an in-view search panel.
- Add a Data Sources web view showing Birdclaw, bird, and xurl health, authenticated accounts, and automatic fallback order.
- Prefetch cached avatars for Discuss hover citations so source previews avoid fallback initials once profile metadata includes an avatar URL.
- Refresh Today digests from live `xurl` home timelines, mentions, and mention conversations before AI analysis so reports see more current context and reply parents.

### Changed

- Let Today and Discuss fetch much deeper live `xurl` data for the selected time window while keeping the AI prompt constrained to a large model-context budget.

### Fixed

- Implement `birdclaw auth use <auto|bird|xurl>` so the documented command persists the preferred moderation action transport. (#45 - thanks @peetzweg)
- Keep `birdclaw init` alive when the macOS Downloads scan is blocked, falling back to the other archive discovery paths. (#44 - thanks @peetzweg)
- Show live Today fetch progress while Birdclaw pulls X home timeline, mentions, and reply context before the first AI tokens arrive.
- Include live fetch counts and page/thread progress in Today status messages before AI summary streaming begins.
- Recover live `xurl` sync when the valid OAuth token is stored under a different local xurl username label than the Birdclaw account handle.
- Keep Profile Analyse citation hover cards linked to real tweet/avatar sources, throttle `xurl` conversation searches, and retry 429s before continuing AI summaries with partial context.
- Open `/profiles/:handle` analysis streams immediately, use same-origin profile fetches, and let `BIRDCLAW_PROFILE_ANALYSIS_ACCOUNT` select the xurl account used for profile backfills.
- Keep Profile Analyse headers from slicing through loaded avatars/names and turn unresolved numeric tweet citations into safe X source links without leaking raw IDs.
- Group adjacent Profile Analyse tweet citations so cached AI reports show numbered source links instead of repeated generic `source` labels.
- Highlight hydrated Profile Analyse `@handle` mentions with profile previews and link multi-source citations to readable clauses when possible.
- Hydrate Profile Analyse header bio `@handle` mentions as soon as the profile context loads, so affiliation-style bios show profile hover previews.
- Flip tweet and profile hover previews above their trigger when there is not enough room below.
- Show expanded URLs instead of `t.co` shortlinks in tweet citation hover previews whenever tweet URL entities are available.
- Show expanded URLs instead of `t.co` shortlinks in Profile Analyse account bios when X description URL entities are available.
- Keep emoji-bearing profile bios and media tweets aligned with X entity ranges, and route `@handle` profile-preview links to internal `/profiles/:handle` analysis pages.
- Make Discuss search source/mode controls look like dropdowns in one row, raise live tweet search depth to 20,000 results / 200 pages, combine bird plus xurl in auto mode, and include matching local timeline/saved tweets in Live search discussions.
- Default Discuss live mode to xurl now that OAuth2 search is authorized.
- Use the default authorized xurl OAuth2 user for Discuss/Profile Analyse recent-search reads instead of the selected Birdclaw account handle.
- Keep Discuss/Profile Analyse recent-search reads from inheriting `BIRDCLAW_XURL_OAUTH2_*` overrides, so account-scoped xurl settings do not force stale app/user auth into global search calls.
- Let normal Discuss web searches reuse cached AI discussions while keeping the Refresh button as the explicit forced-refresh path.
- Keep Discuss Live search scoped to live/search-result tweets instead of sweeping every local timeline bucket before AI streaming starts.
- Link unresolved model-emitted `tweet_<id>` citations in AI reports to X source URLs instead of showing raw citation tokens.
- Tighten AI report line height and first-block spacing in Today and Discuss.
- Keep Network Map profile positions anchored to exact geocoded locations and render dense areas through smarter avatar clusters instead of random scatter.
- Ignore stale configured OAuth2 xurl account overrides for Profile Analyse user lookup and profile timeline reads.

## 0.6.0 - 2026-05-22

### Added

- Add `birdclaw dms sync/list --mode xurl|auto` for recent OAuth2 DM event imports through `xurl`, with bird fallback in auto mode.
- Add an explicit Messages sort toggle for newest conversations or sender follower count.
- Add web DM inbox controls for switching between all, accepted, and message-request conversations.
- Render the `What happened` AI digest as a structured day overview with summary cards, signal topics, highlight tweets, links, people, and hover previews for cited tweet ids and `@handle` mentions.
- Add a streaming `What happened` AI digest in the web UI and CLI (`birdclaw today`, `birdclaw digest`) backed by OpenAI Responses API, GPT-5.5 by default, medium reasoning, priority service tier, local context hashing, and cached final structured results.
- Add a global web account switcher plus `jobs sync-account`/`install-account-launchd` so multi-account Birdclaw installs can refresh home, mentions, likes, bookmarks, and DMs from launchd.

### Changed

- Stream the Today report as one longer Markdown brief with inline hoverable tweet citations instead of adding separate overview and action cards after the model finishes.
- Increase the default Today digest tweet context and accept larger web digest requests so 24-hour reports can see deeper into the local archive.
- Start the Effect rewrite by making `effect` a first-class runtime dependency and moving web API fetches, web sync orchestration, live command helpers, action transport, `bird`/`xurl` JSON/action transports and public adapters, backup export/import/validation and Git orchestration, moderation target resolution, blocks/mutes write helpers, remote block sync, batch blocklist imports, x-web mutations, authored/mentions/mention-thread sync including xurl recent-search and parent-walk fallback internals, conversation loading, home timeline, saved collection, DM live sync, profile hydration/resolution/affiliation/reply inspection, shared tweet lookup, research and whois report generation, follow graph live sync, link preview/index fetches, archive discovery/import subprocesses, avatar/URL caches, OpenAI/inbox scoring, scheduled bookmark sync locking/audit/launchd install, and media-fetch archive reuse/download concurrency onto Effect programs with Promise-compatible public wrappers.

### Fixed

- Deduplicate unscoped timeline rows across accounts so Home does not show the same tweet twice when multiple accounts saw it.
- Render model-emitted Markdown links even when the model inserts a space or line break between the link label and URL.
- Close Today tweet hover previews when opening their source links so command-clicked citations cannot leave stale preview cards stacked on later hovers.
- Keep the Messages shell aligned with the rest of the app while collapsing the sidebar labels, and label optional follower/score DM filters instead of showing default `0` fields.
- Link grouped AI digest tweet citations to nearby readable text instead of showing raw `tweet_...` IDs.
- Expand the Messages web layout into an icon-rail workspace so the DM list and thread panes no longer squeeze into the standard feed width.
- Show DM message requests across accounts instead of filtering them by the active sidebar account.
- Verify the live `bird` account before DM sync, preserve stable account IDs for sparse DM payloads, and pace request-page imports.
- Align DM profile stat labels and values consistently in the web detail panel.
- Keep outbound DM bubble text readable by separating inbound and outbound bubble color classes in the web UI.
- Link AI digest tweet citations on readable text instead of leaking raw `tweet_...` ids when the model cites a local tweet by prefixed id.
- Hydrate profile metadata for Today highlight tweets so real avatar images replace fallback initials after cached digest results render.
- Allow trusted private-proxy web deployments to stream the AI digest remotely without a token, while keeping app-level token enforcement when configured and surfacing API error details in the Today view.
- Harden web write/quota endpoints, URL/avatar fetching, backup imports, archive replacement imports, block sync pruning, and GitHub workflows based on a deepsec security pass.
- Validate compose, tweet-reply, and DM-reply writes before live transport, reject failed xurl sends without leaving local ghost entries, and keep failed web reply drafts visible with the transport error.
- Keep account-scoped manual sync buttons disabled until account metadata loads so saved timelines do not submit accountless collection syncs.
- Cancel failed link preview response bodies promptly so repeated broken preview fetches do not leave sockets open until timeout.
- Harden link preview metadata fetching against private-network redirects, DNS rebinding, oversized or compressed responses, and slow/broken multi-address hosts.
- Link raw `@handle` mentions in archived timeline text and render retweets as embedded original tweets with compact repost attribution.
- Remove the duplicate inline sync account picker now that the global web account switcher controls manual sync account state, and move the theme toggle out of the sidebar footer so the account switcher stays anchored at the bottom.
- Move the one-button theme toggle above the sidebar account picker so the bottom controls align with the active-account avatar.
- Hide unresolved `t.co` placeholders and duplicate preview cards on media tweets, and let single-image media render in a natural image-sized frame.
- Render reposts as native timeline rows with the original author avatar and a single compact repost attribution.
- Hide empty bookmark, media, and account metadata from timeline action rows so the footer only shows useful state.
- Move the theme toggle into the sidebar account footer row so it sits with the active-account controls.

## 0.5.1 - 2026-05-15

### Fixed

- Harden the published CLI wrapper and release checks so the packaged `birdclaw` binary avoids `tsx` CLI IPC startup and stays covered by lint, format, and smoke tests.
- Forward shutdown signals through the published CLI and bundled web server, and include referenced script helpers in npm packages.
- Keep the selected DM conversation visible while its thread refreshes so the reply composer no longer flashes away mid-action.
- Send the selected web account through manual sync controls so multi-account timelines sync the intended profile.
- Run web sync requests as background jobs with status polling so the UI no longer holds one blocking sync request open.
- Add typed web API fetch handling and explicit DMs loading/error/empty states so failed local reads surface cleanly.
- Add explicit web app sync controls for home timeline, mentions, likes, bookmarks, and DMs so fresh live data can be pulled without leaving the UI.
- Refine the web app sidebar tagline and theme selector so the brand chrome reads more clearly in compact layouts.
- Add shared web feed loading/error/empty states with timeline-shaped skeleton rows and move conversation expansion into a cached single-thread surface with hover prefetch.
- Use the Birdclaw crab-bird mark in the web app chrome, loading states, and empty states; soften dark-mode contrast and replace text-only reply warnings with conversation/replied indicators.
- Allow the local web app to respond when Tailscale Serve forwards requests through the `clawmac.sheep-coho.ts.net` hostname.
- Speed up the default home timeline load on large local databases and keep malformed archived media URL entities from crashing the web timeline.
- Preserve tweet media aspect ratios, open timeline media in an inline viewer, and suppress duplicate media URL cards.

## 0.5.0 - 2026-05-15

### Added

- Add `birdclaw import archive --select` for importing targeted archive slices while preserving unselected local data.
- Add `birdclaw sync authored` for filling own-tweet gaps from `xurl` after the archive cutoff. Thanks @cavit99.
- Add live `sync mentions` and `sync mention-threads --mode xurl` ingestion for current mention data and conversation context. Thanks @cavit99.
- Add `birdclaw media fetch` plus archive bundled-media extraction and live media variant persistence for local originals caching. Thanks @cavit99.
- Add a `/links` web lane for Hacker News-style top URL and video-provider insights with today, week, month, year, and all-time ranges.
- Import archive `follower.js`/`following.js` files into the local follow graph and add archive-authored tweet edges so fresh archive imports are immediately queryable without live sync. Thanks @cavit99.
- Add cache-first followers/following sync, local follow graph queries, and backup/export support for graph snapshots and churn events. Thanks @ma08.
- Hydrate missing link-discussion profile avatars through `bird`/`xurl` so hover sheets can upgrade archive placeholders into real profile cards.
- Add inline tweet conversation expansion in the web timeline, preserving the selected reply's parent chain before broad thread context.

### Changed

- Update npm dependencies, including React, Vite, Vitest, Playwright, Tailwind, Kysely, TanStack packages, oxlint, and oxfmt.

### Fixed

- Seed demo link insight data before direct `/links` route loads, so the lane is populated even when it is the first web route opened.
- Isolate the default `bird` command config test from the maintainer's local `~/.birdclaw/config.json`.
- Skip non-numeric archive placeholder IDs such as self-DM conversation IDs when hydrating profiles through X, so one malformed local ID no longer aborts the batch. Thanks @nfarina.
- Include expanded short URLs and link occurrences in Git-friendly backups so linked-tweet search survives backup restore.
- Prefer `bird` for follow graph sync in `auto` mode, keeping `xurl` as an explicit fallback for accounts where OAuth2 follow reads work.
- Update the docs site and app icons to use the Birdclaw crab-bird mark instead of the generic bird logo.

## 0.4.1 - 2026-05-11

### Added

- Add a first-class short-link index for `t.co` URLs, including `links backfill` and `search links` so DM shares can be found through expanded tweet text, authors, dates, and media filters.

## 0.4.0 - 2026-05-09

### Added

- Preserve richer X profile metadata during `bird`/`xurl` profile hydration, including profile URLs, profile URL entities, locations, verification type, raw profile JSON, and X affiliation/highlighted-label metadata.
- Add first-class `profile_affiliations` storage, backup/export/import support, and `whois --json` `profileEvidence` so identity lookups can explain whether a match came from bio text, profile URLs, affiliation badges, DM context, or expanded links.
- Add profile-change snapshots for hydrated profiles, preserving prior bio/profile URL/location/verification/affiliation states so identity searches can surface current and previous affiliation evidence.
- Add first-class bio entity extraction for profile bios and profile URLs, including `@handle`, domain, and company-phrase evidence used by fuzzy identity searches such as `whois "blacksmith guy"`.
- Add a derived `identity_search_index` and `whois` filters for affiliation-oriented identity lookups: `--affiliation`, `--current-affiliation`, and `--exclude-domain-only`.

### Changed

- Use Node's native `node:sqlite` runtime instead of `better-sqlite3`, removing the native npm dependency while preserving the existing synchronous SQLite API surface.
- Allow Node 26.x in the package engine range and update install docs for the native SQLite runtime.
- Improve DM `whois` ranking with Sweetistics-style profile evidence scoring: profile URLs and affiliation badges now boost relevant candidates, while cached profile and URL lookups still avoid repeated API/network work.
- Resolve synthetic X highlighted-label organization badges into real local organization profile ids when `bird` can hydrate the org handle.
- Rank current affiliation and bio identity evidence above plain profile domains in `whois`, group human output into ambiguity buckets, and explain "why this person?" with the strongest typed evidence first.
- Use `bird profiles --json` for batch profile hydration when available, falling back to single-profile `bird user --profile-only --json`.

## 0.3.0 - 2026-05-05

### Added

- Add research mode for turning bookmarked Twitter threads into Markdown briefs, with shared `xurl`/`bird` tweet lookup fallback for thread expansion. Thanks @anupamchugh.
- Add live home timeline and mention-thread sync commands so local triage can pull current `bird` context into the SQLite store.
- Add search snippets for tweet and DM results, including deterministic DM snippets when multiple messages in a conversation match. Thanks @mvanhorn.
- Add `--min-likes` and `--quality-reason` controls for tweet search quality filtering. Thanks @mvanhorn.
- Store Twitter following counts on profiles and include them in JSONL backups.

### Changed

- Use the native TypeScript preview compiler for the `typecheck` script.
- Refresh TypeScript and related development dependencies.

### Fixed

- Use the existing Twitter web cookie fallback as the final `auto` transport for block and unblock actions. Thanks @pejmanjohn.
- Resolve the `bird` transport from `PATH` before falling back to the local development checkout. Thanks @vyctorbrzezowski.
- Stabilize the presenter timestamp test across local time zones. Thanks @pejmanjohn.
- Clean up the DMs route render test so CI does not leave React work running after jsdom teardown.
- Allow Playwright e2e runs to use an alternate local port when `3000` is already occupied.
- Replace maintainer-local documentation links with repo-relative links and align the setup docs with the Node version file. Thanks @stainlu.

## Unreleased

### Fixed

- Fix live `xurl` status detection when the CLI is installed but not authenticated; thanks @kyupark.
- Default local `bird` integration to `bird` on PATH and report stale configured command paths with setup guidance.

## 0.2.1 - 2026-04-27

### Changed

- Use Twitter wording in public descriptions, docs, CLI help, and release notes.

## 0.2.0 - 2026-04-27

### Added

- Add live likes and bookmarks sync through `xurl`/`bird`, local search filters, archive import support, and dedicated Likes/Bookmarks web views.
- Add Git-friendly JSONL backup sync, export, import, validation, and stale-aware auto-sync for rebuilding or merging the local SQLite store from text shards across machines.
- Add a scheduled bookmark sync job with launchd installation, JSONL audit logging, overlap locking, and automatic Git backup sync after each refresh.
- Add launchd env-file support so scheduled bookmark sync can source `bird` credentials without storing secrets in the plist.

### Changed

- Update the README tagline and package description for local Twitter memory across archives, DMs, likes, bookmarks, and moderation.
- Refresh dependencies, including `jsdom` 29.1.0.
- Hide reply state and reply actions in saved likes/bookmarks web lanes.
- Shard backup DMs by year and route unknown tweet dates to `data/tweets/unknown.jsonl` so Git backups stay compact and avoid bogus 1970 files.
- Speed up archive imports plus JSONL backup export, import, and validation for large local datasets.

### Fixed

- Fix live bookmark sync to use stored Twitter user ids, force OAuth2 for `xurl` collection reads, and tolerate large/current `bird` bookmark payloads.
- Fix fresh-machine backup sync so demo data is never exported into Git backups, and keep no-op syncs from creating metadata-only commits.

## 0.1.1 - 2026-04-27

### Added

- Add opt-in low-quality timeline filtering for year-scale tweet review, including date windows, originals-only mode, and CLI/API flags for hiding retweets, tiny replies, and link-only noise.

### Fixed

- Fix fresh npm installs so the packaged `birdclaw` binary includes its TypeScript runtime dependency.

## 0.1.0 - 2026-04-27

### Added

- Add Twitter web cookie fallback for block and unblock actions when the Twitter API rejects OAuth2 block writes.
- Add `profiles replies` so moderation triage can inspect a user's recent reply pattern before blocking.
- Add `blocks import <path>` for one-shot blocklist application from a file.
- Add paged `mentions export --mode xurl --all --max-pages <n>` so moderation loops can scan the full retrievable mentions window.
- Add `actions.transport` config plus shared action transport routing for `bird`, `xurl`, and `auto`.
- Add transport-aware mute/unmute support to the API action route.
- Add the first packaged `birdclaw` CLI release.

### Fixed

- Capture `xurl` mutation error bodies so transport fallbacks can key off the real API failure.
- Make `birdclaw` block and unblock flows succeed remotely again on Peter's current auth setup.
- Verify forced `xurl` mute/block writes through `bird status` before mutating local sqlite.
- Cache authenticated `xurl whoami` lookups so repeated moderation writes do less redundant auth work.
- Strip inherited `--localstorage-file` from the Playwright web-server env to avoid noisy cross-repo test warnings.
- Override Node 25 native web storage in jsdom test setup so Vitest runs stop emitting `--localstorage-file` warnings.

### Docs

- Document block transport behavior and fallback path in the CLI/docs.
- Document the reply-pattern inspection flow for borderline AI/slop accounts.
- Document blocklist import file format and usage.
- Document paged xurl mention export for agent moderation runs.
- Document that mention reads and moderation writes use separate config knobs.
