import { getReadDb } from "./db";
import { toFtsSearchQuery } from "./query-read-model-shared";
import type { Database } from "./sqlite";
import type { XRemarkAnnotation } from "./types";
import { createXRemarkAnnotationResolver } from "./xremark";

const MAX_SEARCH_RESULTS = 10;
const MAX_SEARCH_CANDIDATES = 160;
const MAX_CONTEXT_REPLIES = 16;

const ENGLISH_STOP_WORDS = new Set([
	"about",
	"and",
	"are",
	"can",
	"could",
	"does",
	"find",
	"for",
	"from",
	"how",
	"please",
	"show",
	"tell",
	"that",
	"the",
	"this",
	"what",
	"when",
	"where",
	"which",
	"who",
	"why",
	"with",
]);

const CHINESE_STOP_FRAGMENTS = new Set([
	"一个",
	"什么",
	"你能",
	"可以",
	"告诉",
	"如何",
	"怎么",
	"想要",
	"我想",
	"是否",
	"最近",
	"这个",
	"那个",
	"请问",
	"说了",
	"了吗",
	"的是",
	"有什",
	"是什么",
]);

interface SearchCandidateRow {
	id: string;
	text: string;
	created_at: string;
	like_count: number;
	author_profile_id: string;
	handle: string;
	display_name: string;
	annotation_search_text: string;
	bookmarked: number;
	liked: number;
}

interface TweetDocumentRow extends SearchCandidateRow {
	reply_to_id: string | null;
	quoted_tweet_id: string | null;
	media_count: number;
}

export interface RagSearchResult {
	id: string;
	title: string;
	url: string;
	author_context: RagAuthorContext;
}

export interface RagFetchResult {
	id: string;
	title: string;
	text: string;
	url: string;
	metadata: Record<string, unknown>;
}

export interface RagAuthorContext {
	handle: string;
	display_name: string;
	label_status: "recorded" | "unlabeled";
	labels: string[];
	tags: string[];
	category: string | null;
	personal_note: string | null;
	follow_reason: string | null;
	source_updated_at: string | null;
}

function normalizeHandle(handle: string) {
	return handle.trim().replace(/^@/, "");
}

function tweetUrl(row: Pick<SearchCandidateRow, "handle" | "id">) {
	return `https://x.com/${encodeURIComponent(normalizeHandle(row.handle))}/status/${encodeURIComponent(row.id)}`;
}

function compactText(value: string) {
	return value.replace(/\s+/g, " ").trim();
}

function codePointLength(value: string) {
	return Array.from(value).length;
}

function sliceCodePoints(value: string, start: number, length?: number) {
	return Array.from(value)
		.slice(start, length ? start + length : undefined)
		.join("");
}

function makeSnippet(text: string, terms: string[]) {
	const compact = compactText(text);
	const lowered = compact.toLocaleLowerCase();
	const firstMatch = terms
		.map((term) => lowered.indexOf(term.toLocaleLowerCase()))
		.filter((index) => index >= 0)
		.sort((left, right) => left - right)[0];
	const start = Math.max(0, (firstMatch ?? 0) - 56);
	const snippet = sliceCodePoints(compact, start, 180);
	return `${start > 0 ? "…" : ""}${snippet}${codePointLength(compact) > start + 180 ? "…" : ""}`;
}

function compactContextValue(value: string, limit = 140) {
	const compact = compactText(value);
	return codePointLength(compact) > limit
		? `${sliceCodePoints(compact, 0, limit)}…`
		: compact;
}

function authorContextForRow(
	resolveAnnotation: (lookup: {
		identifier?: string;
		handle?: string;
	}) => XRemarkAnnotation | null,
	row: Pick<
		SearchCandidateRow,
		"author_profile_id" | "handle" | "display_name"
	>,
): RagAuthorContext {
	const annotation = resolveAnnotation({
		identifier: row.author_profile_id,
		handle: row.handle,
	});
	if (!annotation) {
		return {
			handle: normalizeHandle(row.handle),
			display_name: row.display_name,
			label_status: "unlabeled",
			labels: [],
			tags: [],
			category: null,
			personal_note: null,
			follow_reason: null,
			source_updated_at: null,
		};
	}
	const category = annotation.category?.trim() || null;
	const tags = unique(annotation.tags.map((tag) => tag.trim()).filter(Boolean));
	return {
		handle: normalizeHandle(row.handle),
		display_name: row.display_name,
		label_status: "recorded",
		labels: unique([...(category ? [category] : []), ...tags]),
		tags,
		category,
		personal_note: annotation.remark.trim() || null,
		follow_reason: annotation.description.trim() || null,
		source_updated_at: annotation.sourceUpdatedAt ?? null,
	};
}

function authorContextSummary(context: RagAuthorContext) {
	if (context.label_status === "unlabeled") return "作者标注：未标注";
	const parts = [
		context.labels.length > 0
			? `标签：${context.labels.join(" / ")}`
			: "标签：无",
		context.personal_note
			? `备注：${compactContextValue(context.personal_note)}`
			: "",
		context.follow_reason
			? `关注原因：${compactContextValue(context.follow_reason)}`
			: "",
	].filter(Boolean);
	return `作者标注：${parts.join("；")}`;
}

function titleForTweet(
	row: SearchCandidateRow,
	terms: string[],
	authorContext: RagAuthorContext,
) {
	const date = row.created_at.slice(0, 10);
	return `@${normalizeHandle(row.handle)} · ${date} · ${authorContextSummary(authorContext)} — ${makeSnippet(row.text, terms)}`;
}

function unique<T>(items: T[]) {
	return [...new Set(items)];
}

function extractSearchTerms(query: string) {
	const normalized = compactText(query).toLocaleLowerCase();
	const runs = normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}_@.-]+/gu) ?? [];
	const terms: string[] = [];

	for (const run of runs) {
		if (/\p{Script=Han}/u.test(run)) {
			const points = Array.from(run);
			if (points.length <= 4) {
				if (!CHINESE_STOP_FRAGMENTS.has(run)) terms.push(run);
				continue;
			}
			for (const size of [4, 3, 2]) {
				for (let index = 0; index <= points.length - size; index += 1) {
					const term = points.slice(index, index + size).join("");
					if (!CHINESE_STOP_FRAGMENTS.has(term)) terms.push(term);
				}
			}
			continue;
		}

		const term = run.replace(/^@/, "");
		if (
			term.length >= 2 &&
			!ENGLISH_STOP_WORDS.has(term) &&
			!/^\d{1,2}$/.test(term)
		) {
			terms.push(term);
		}
	}

	return unique(terms).slice(0, 24);
}

function extractFtsTerms(query: string) {
	return unique(
		(query.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(
			(term) =>
				!/[\p{Script=Han}]/u.test(term) &&
				term.length >= 2 &&
				!ENGLISH_STOP_WORDS.has(term),
		),
	).slice(0, 12);
}

function collectionStateSelect() {
	return `
		exists (
			select 1 from tweet_collections collection
			where collection.tweet_id = t.id and collection.kind = 'bookmarks'
		) as bookmarked,
		exists (
			select 1 from tweet_collections collection
			where collection.tweet_id = t.id and collection.kind = 'likes'
		) as liked
	`;
}

function searchFts(db: Database, query: string) {
	const terms = extractFtsTerms(query);
	if (terms.length === 0) return [];
	const match = terms
		.map((term) => toFtsSearchQuery(term))
		.filter(Boolean)
		.join(" OR ");
	if (!match) return [];

	return db
		.prepare(
			`
			select
				t.id,
				t.text,
				t.created_at,
				t.like_count,
				t.author_profile_id,
				p.handle,
				p.display_name,
				'' as annotation_search_text,
				${collectionStateSelect()},
				bm25(tweets_fts) as fts_rank
			from tweets_fts
			join tweets t on t.id = tweets_fts.tweet_id
			join profiles p on p.id = t.author_profile_id
			where tweets_fts match ?
			order by fts_rank asc
			limit ?
			`,
		)
		.all(match, MAX_SEARCH_CANDIDATES) as SearchCandidateRow[];
}

function termWeight(term: string) {
	const length = codePointLength(term);
	return Math.max(2, Math.min(12, length * length));
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function haystackHasTerm(haystack: string, term: string) {
	if (/^[a-z0-9_]+$/i.test(term)) {
		return new RegExp(
			`(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(term)}(?:$|[^\\p{L}\\p{N}_])`,
			"iu",
		).test(haystack);
	}
	return haystack.includes(term.toLocaleLowerCase());
}

function searchSubstrings(db: Database, query: string) {
	const terms = extractSearchTerms(query);
	if (terms.length === 0) return [];
	const score = terms
		.map(
			(term) =>
				`case when instr(search_text, ?) > 0 then ${String(termWeight(term))} else 0 end`,
		)
		.join(" + ");
	return db
		.prepare(
			`
			with annotated_profiles as (
				select
					p.*,
					lower(coalesce((
						select coalesce(note.category_name, '') || ' ' || note.tags_json || ' ' ||
						       note.remark || ' ' || note.description
						from xremark_profile_notes note
						where p.id = note.identifier
						   or p.id = 'profile_user_' || note.identifier
						   or (
							lower(p.handle) = lower(note.additional_name)
							and not exists (
								select 1 from profiles stable
								where stable.id = note.identifier
								   or stable.id = 'profile_user_' || note.identifier
							)
						   )
						limit 1
					), '')) as annotation_search_text
				from profiles p
			), candidates as (
				select
					t.id,
					t.text,
					t.created_at,
					t.like_count,
					t.author_profile_id,
					p.handle,
					p.display_name,
					p.annotation_search_text,
					${collectionStateSelect()},
					lower(t.text || ' ' || p.handle || ' ' || p.display_name ||
					      ' ' || p.annotation_search_text) as search_text
				from tweets t
				join annotated_profiles p on p.id = t.author_profile_id
			), ranked as (
				select *, ${score} as term_score from candidates
			)
			select id, text, created_at, like_count, author_profile_id, handle, display_name,
				annotation_search_text, bookmarked, liked
			from ranked
			where term_score > 0
			order by term_score desc, bookmarked desc, liked desc, like_count desc,
				created_at desc
			limit ?
			`,
		)
		.all(...terms, MAX_SEARCH_CANDIDATES) as SearchCandidateRow[];
}

function relevanceScore(
	row: SearchCandidateRow,
	query: string,
	terms: string[],
) {
	const haystack =
		`${row.text} ${row.handle} ${row.display_name} ${row.annotation_search_text}`.toLocaleLowerCase();
	const exact = compactText(query).toLocaleLowerCase();
	let score =
		exact.length >= 3 &&
		(exact.includes(" ")
			? haystack.includes(exact)
			: haystackHasTerm(haystack, exact))
			? 40
			: 0;
	for (const term of terms) {
		if (haystackHasTerm(haystack, term)) score += termWeight(term);
	}
	if (row.bookmarked) score += 3;
	if (row.liked) score += 2;
	score += Math.min(2, Math.log10(Math.max(1, row.like_count + 1)) / 2);
	return score;
}

export function searchRagTweets(query: string): RagSearchResult[] {
	const normalized = compactText(query);
	if (!normalized) return [];
	const db = getReadDb({ seedDemoData: false });
	const resolveAnnotation = createXRemarkAnnotationResolver(db);
	const terms = extractSearchTerms(normalized);
	const candidates = new Map<string, SearchCandidateRow>();
	for (const row of [
		...searchFts(db, normalized),
		...searchSubstrings(db, normalized),
	]) {
		candidates.set(row.id, row);
	}

	return [...candidates.values()]
		.map((row) => ({ row, score: relevanceScore(row, normalized, terms) }))
		.filter(({ score }) => score > 0)
		.sort(
			(left, right) =>
				right.score - left.score ||
				right.row.created_at.localeCompare(left.row.created_at),
		)
		.slice(0, MAX_SEARCH_RESULTS)
		.map(({ row }) => {
			const authorContext = authorContextForRow(resolveAnnotation, row);
			return {
				id: `tweet:${row.id}`,
				title: titleForTweet(row, terms, authorContext),
				url: tweetUrl(row),
				author_context: authorContext,
			};
		});
}

function getTweetDocumentRow(db: Database, tweetId: string) {
	return db
		.prepare(
			`
			select
				t.id,
				t.text,
				t.created_at,
				t.reply_to_id,
				t.quoted_tweet_id,
				t.like_count,
				t.media_count,
				t.author_profile_id,
				p.handle,
				p.display_name,
				${collectionStateSelect()}
			from tweets t
			join profiles p on p.id = t.author_profile_id
			where t.id = ?
			`,
		)
		.get(tweetId) as TweetDocumentRow | undefined;
}

function getParentRows(db: Database, row: TweetDocumentRow) {
	const parents: TweetDocumentRow[] = [];
	const seen = new Set([row.id]);
	let parentId = row.reply_to_id;
	while (parentId && parents.length < 6 && !seen.has(parentId)) {
		seen.add(parentId);
		const parent = getTweetDocumentRow(db, parentId);
		if (!parent) break;
		parents.push(parent);
		parentId = parent.reply_to_id;
	}
	return parents.reverse();
}

function getReplyRows(db: Database, tweetId: string) {
	return db
		.prepare(
			`
			with recursive reply_tree(id, depth) as (
				select child.id, 1
				from tweets child
				where child.reply_to_id = ?
				union all
				select child.id, reply_tree.depth + 1
				from tweets child
				join reply_tree on child.reply_to_id = reply_tree.id
				where reply_tree.depth < 3
			)
			select
				t.id,
				t.text,
				t.created_at,
				t.reply_to_id,
				t.quoted_tweet_id,
				t.like_count,
				t.media_count,
				t.author_profile_id,
				p.handle,
				p.display_name,
				${collectionStateSelect()}
			from reply_tree
			join tweets t on t.id = reply_tree.id
			join profiles p on p.id = t.author_profile_id
			order by t.created_at asc
			limit ?
			`,
		)
		.all(tweetId, MAX_CONTEXT_REPLIES) as TweetDocumentRow[];
}

function formatAuthorContext(context: RagAuthorContext) {
	if (context.label_status === "unlabeled") {
		return [
			"### Author judgment context (must not be omitted)",
			"- Label status: unlabeled in X Remark",
			"- Labels: none recorded",
		].join("\n");
	}
	return [
		"### Author judgment context (must not be omitted)",
		"- Label status: recorded",
		`- Labels: ${context.labels.length > 0 ? context.labels.join(", ") : "none recorded"}`,
		`- Category: ${context.category ?? "none recorded"}`,
		`- Tags: ${context.tags.length > 0 ? context.tags.join(", ") : "none recorded"}`,
		`- Personal note: ${context.personal_note ?? "none recorded"}`,
		`- Why followed / context: ${context.follow_reason ?? "none recorded"}`,
		...(context.source_updated_at
			? [`- Annotation updated at: ${context.source_updated_at}`]
			: []),
	].join("\n");
}

function formatTweetSection(
	resolveAnnotation: ReturnType<typeof createXRemarkAnnotationResolver>,
	row: TweetDocumentRow,
	heading: string,
) {
	const authorContext = authorContextForRow(resolveAnnotation, row);
	return [
		`## ${heading}`,
		`@${normalizeHandle(row.handle)} (${row.display_name}) · ${row.created_at}`,
		"",
		formatAuthorContext(authorContext),
		"",
		row.text.trim(),
		"",
		`Source: ${tweetUrl(row)}`,
	].join("\n");
}

function normalizeFetchId(id: string) {
	const trimmed = id.trim();
	if (trimmed.startsWith("tweet:")) return trimmed.slice("tweet:".length);
	const urlMatch = trimmed.match(
		/(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/i,
	);
	return urlMatch?.[1] ?? trimmed;
}

export function fetchRagTweet(id: string): RagFetchResult | null {
	const tweetId = normalizeFetchId(id);
	if (!tweetId) return null;
	const db = getReadDb({ seedDemoData: false });
	const resolveAnnotation = createXRemarkAnnotationResolver(db);
	const row = getTweetDocumentRow(db, tweetId);
	if (!row) return null;
	const parents = getParentRows(db, row);
	const quoted = row.quoted_tweet_id
		? getTweetDocumentRow(db, row.quoted_tweet_id)
		: undefined;
	const replies = getReplyRows(db, row.id);
	const authorContext = authorContextForRow(resolveAnnotation, row);
	const sections = [
		`# @${normalizeHandle(row.handle)} — ${row.created_at}`,
		"",
		formatAuthorContext(authorContext),
		"",
		row.text.trim(),
		"",
		`Canonical source: ${tweetUrl(row)}`,
	];
	if (parents.length > 0) {
		sections.push(
			"",
			"# Parent context",
			"",
			...parents.map((parent, index) =>
				formatTweetSection(
					resolveAnnotation,
					parent,
					`Parent ${String(index + 1)}`,
				),
			),
		);
	}
	if (quoted) {
		sections.push(
			"",
			"# Quoted tweet",
			"",
			formatTweetSection(resolveAnnotation, quoted, "Quote"),
		);
	}
	if (replies.length > 0) {
		sections.push(
			"",
			"# Replies in the archive",
			"",
			...replies.map((reply, index) =>
				formatTweetSection(
					resolveAnnotation,
					reply,
					`Reply ${String(index + 1)}`,
				),
			),
		);
	}

	const collectionRows = db
		.prepare(
			`select distinct account_id, kind from tweet_collections
			 where tweet_id = ? order by account_id, kind`,
		)
		.all(row.id) as Array<{ account_id: string; kind: string }>;

	return {
		id: `tweet:${row.id}`,
		title: titleForTweet(row, [], authorContext),
		text: sections.join("\n"),
		url: tweetUrl(row),
		metadata: {
			type: "tweet",
			tweet_id: row.id,
			author: row.display_name,
			handle: normalizeHandle(row.handle),
			author_context: authorContext,
			context_authors: [
				...parents.map((contextRow) => ({
					relation: "parent",
					tweet_id: contextRow.id,
					author_context: authorContextForRow(resolveAnnotation, contextRow),
				})),
				...(quoted
					? [
							{
								relation: "quote",
								tweet_id: quoted.id,
								author_context: authorContextForRow(resolveAnnotation, quoted),
							},
						]
					: []),
				...replies.map((contextRow) => ({
					relation: "reply",
					tweet_id: contextRow.id,
					author_context: authorContextForRow(resolveAnnotation, contextRow),
				})),
			],
			created_at: row.created_at,
			like_count: row.like_count,
			media_count: row.media_count,
			bookmarked: Boolean(row.bookmarked),
			liked: Boolean(row.liked),
			collections: collectionRows,
			parent_count: parents.length,
			reply_count: replies.length,
			quoted_tweet_id: row.quoted_tweet_id,
		},
	};
}
