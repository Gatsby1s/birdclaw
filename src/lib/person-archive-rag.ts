import { getReadDb } from "./db";
import type { Database } from "./sqlite";
import {
	authorContextForRow,
	extractSearchTerms,
	fetchRagTweet,
	searchRagTweets,
	type RagAuthorContext,
	type RagFetchResult,
	type RagSearchResult,
} from "./rag-mcp-store";
import { createXRemarkAnnotationResolver } from "./xremark";
import { toFtsSearchQuery } from "./query-read-model-shared";
const ORIGIN = "https://birdclaw-production.up.railway.app";
interface ChunkRow {
	document_id: string;
	chunk_index: number;
	text: string;
	start_offset: number;
	page_start: number;
	person_id: string;
	person_name: string;
	title: string;
	kind: string;
	published_at: string;
	source_url: string | null;
	source_id: string | null;
	raw_json: string;
	filename: string | null;
	extraction_status: string;
	content_hash: string;
}
function personContext(
	db: Database,
	personId: string,
	name: string,
): RagAuthorContext {
	const x = db
		.prepare(
			"select p.id author_profile_id,p.handle,p.display_name from person_sources s join profiles p on p.id=s.profile_id where s.person_id=? and s.kind='x' order by s.created_at limit 1",
		)
		.get(personId) as
		| { author_profile_id: string; handle: string; display_name: string }
		| undefined;
	if (x) return authorContextForRow(createXRemarkAnnotationResolver(db), x);
	return {
		handle: "",
		display_name: name,
		label_status: "unlabeled",
		labels: [],
		tags: [],
		category: null,
		personal_note: null,
		follow_reason: null,
		source_updated_at: null,
	};
}
function scopeQuery(db: Database, query: string) {
	const match = /(?:^|\s)person:(?:"([^"]+)"|([^\s]+))/i.exec(query);
	if (match) {
		const identifier = match[1] ?? match[2];
		const rows = db
			.prepare(
				"select distinct p.id from people p left join person_sources s on s.person_id=p.id where p.merged_into is null and (p.id=? or lower(p.name)=lower(?) or s.identifier=lower(?)) limit 2",
			)
			.all(identifier, identifier, identifier.replace(/^@/, "")) as Array<{
			id: string;
		}>;
		return {
			query: query.replace(match[0], " ").trim(),
			personId: rows.length === 1 ? rows[0].id : undefined,
			invalid: rows.length !== 1,
		};
	}
	return { query, personId: undefined, invalid: false };
}
function chunkUrl(row: ChunkRow) {
	return (
		row.source_url ??
		`${ORIGIN}/people/${encodeURIComponent(row.person_id)}?document=${encodeURIComponent(row.document_id)}`
	);
}
function chunkId(row: ChunkRow) {
	return `doc:${row.document_id}:chunk:${row.chunk_index}`;
}
function searchDocumentChunks(db: Database, query: string, personId?: string) {
	const terms = extractSearchTerms(query).slice(0, 24);
	const match = terms.map(toFtsSearchQuery).filter(Boolean).join(" OR ");
	const candidates = new Map<string, ChunkRow>();
	const select = `select c.document_id,c.chunk_index,c.text,c.start_offset,c.page_start,d.person_id,p.name person_name,d.title,d.kind,d.published_at,d.source_url,d.source_id,d.raw_json,d.filename,d.extraction_status,d.content_hash from person_document_chunks c join person_documents d on d.id=c.document_id join people p on p.id=d.person_id`;
	if (match) {
		for (const row of db
			.prepare(
				`${select} join person_chunks_fts f on f.rowid=c.sequence where person_chunks_fts match ? and (?='' or d.person_id=?) order by bm25(person_chunks_fts) limit 80`,
			)
			.all(match, personId ?? "", personId ?? "") as ChunkRow[])
			candidates.set(chunkId(row), row);
	}
	const score = terms.length
		? terms
				.map(
					() =>
						"case when instr(lower(c.text||' '||d.title||' '||p.name),?)>0 then 1 else 0 end",
				)
				.join("+")
		: "1";
	for (const row of db
		.prepare(
			`${select} where (?='' or d.person_id=?) and (${score})>0 ${terms.length ? "" : "and c.chunk_index=0"} order by d.published_at desc,c.chunk_index limit 80`,
		)
		.all(personId ?? "", personId ?? "", ...terms) as ChunkRow[])
		candidates.set(chunkId(row), row);
	const results = [...candidates.values()]
		.map((row) => {
			const text = (
				row.text +
				" " +
				row.title +
				" " +
				row.person_name
			).toLowerCase();
			return {
				row,
				score: terms.reduce(
					(sum, term) =>
						sum + (text.includes(term) ? Math.min(12, term.length) : 0),
					terms.length ? 0 : 1,
				),
			};
		})
		.sort(
			(a, b) =>
				b.score - a.score ||
				b.row.published_at.localeCompare(a.row.published_at),
		);
	return results.slice(0, 10).map(({ row }): RagSearchResult => {
		const termsIndex =
			terms
				.map((t) => row.text.toLowerCase().indexOf(t))
				.filter((i) => i >= 0)
				.sort((a, b) => a - b)[0] ?? 0;
		const snippet = row.text
			.slice(Math.max(0, termsIndex - 60), Math.max(0, termsIndex - 60) + 210)
			.replace(/\s+/g, " ");
		const context = personContext(db, row.person_id, row.person_name);
		return {
			id: chunkId(row),
			title: `${row.person_name} · ${row.kind === "telegram" ? "Telegram 频道" : "上传资料"} · ${row.title} · ${row.published_at} · 第${row.page_start}页/片段${row.chunk_index + 1} · ${snippet}`,
			url: chunkUrl(row),
			author_context: context,
		};
	});
}
export function searchPersonArchive(query: string): RagSearchResult[] {
	const db = getReadDb({ seedDemoData: false });
	const scoped = scopeQuery(db, query.trim());
	if (scoped.invalid) return [];
	const tweets = searchRagTweets(scoped.query, scoped.personId);
	const docs = searchDocumentChunks(db, scoped.query, scoped.personId);
	// Interleave platform candidates so one busy X source cannot hide uploaded evidence.
	const results: RagSearchResult[] = [];
	for (
		let i = 0;
		results.length < 10 && (i < tweets.length || i < docs.length);
		i++
	) {
		if (tweets[i]) results.push(tweets[i]);
		if (results.length < 10 && docs[i]) results.push(docs[i]);
	}
	return results;
}
export function fetchPersonArchive(id: string): RagFetchResult | null {
	if (!id.startsWith("doc:")) {
		const tweet = fetchRagTweet(id);
		if (!tweet) return null;
		const db = getReadDb({ seedDemoData: false });
		const tweetId = tweet.id.replace(/^tweet:/, "");
		const person = db
			.prepare(
				"select p.id,p.name,s.id source_id from tweets t join person_sources s on s.profile_id=t.author_profile_id and s.kind='x' join people p on p.id=s.person_id where t.id=?",
			)
			.get(tweetId) as
			| { id: string; name: string; source_id: string }
			| undefined;
		if (person) {
			tweet.metadata.person_id = person.id;
			tweet.metadata.person_name = person.name;
			tweet.metadata.person_source_id = person.source_id;
			tweet.metadata.archived_media = db
				.prepare(
					"select id,kind,status,byte_size from person_assets where tweet_id=? and person_id=?",
				)
				.all(tweetId, person.id);
		}
		return tweet;
	}
	const match = /^doc:([a-f0-9-]{36})(?::chunk:(\d{1,6}))?$/.exec(id);
	if (!match) return null;
	const db = getReadDb({ seedDemoData: false });
	const index = Number(match[2] ?? 0);
	const row = db
		.prepare(
			`select c.document_id,c.chunk_index,c.text,c.start_offset,c.page_start,d.person_id,p.name person_name,d.title,d.kind,d.published_at,d.source_url,d.source_id,d.raw_json,d.filename,d.extraction_status,d.content_hash from person_document_chunks c join person_documents d on d.id=c.document_id join people p on p.id=d.person_id where d.id=? and c.chunk_index=?`,
		)
		.get(match[1], index) as ChunkRow | undefined;
	if (!row) return null;
	const count = (
		db
			.prepare(
				"select count(*) n from person_document_chunks where document_id=?",
			)
			.get(row.document_id) as { n: number }
	).n;
	const context = personContext(db, row.person_id, row.person_name);
	let provenance: unknown = {};
	try {
		provenance = JSON.parse(row.raw_json);
	} catch {
		/* optional */
	}
	const assets = db
		.prepare(
			"select id,kind,status,byte_size from person_assets where document_id=?",
		)
		.all(row.document_id);
	const provenanceNote =
		row.kind === "telegram"
			? "Telegram 频道资料，可能由多人运营或包含转发。人物关联不代表每句话都由该人物原创；保留原文署名核对。"
			: "用户上传的补充资料；人物关联由用户指定，需结合原文件判断作者及上下文。";
	return {
		id: chunkId(row),
		title: `${row.person_name} · ${row.title}`,
		url: chunkUrl(row),
		text: [
			`人物：${row.person_name}`,
			`来源：${row.kind} · ${row.published_at}`,
			provenanceNote,
			`人物标注：${JSON.stringify(context)}`,
			`资料片段 ${index + 1}/${count}，从第 ${row.page_start} 页开始`,
			"",
			row.text,
		].join("\n"),
		metadata: {
			person_id: row.person_id,
			person_name: row.person_name,
			kind: row.kind,
			document_id: row.document_id,
			source_id: row.source_id,
			published_at: row.published_at,
			author_context: context,
			provenance,
			media: assets,
			filename: row.filename,
			extraction_status: row.extraction_status,
			content_hash: row.content_hash,
			chunk_index: index,
			chunk_count: count,
			page_start: row.page_start,
			previous_chunk:
				index > 0 ? `doc:${row.document_id}:chunk:${index - 1}` : null,
			next_chunk:
				index + 1 < count ? `doc:${row.document_id}:chunk:${index + 1}` : null,
			original_file_url: row.filename
				? `${ORIGIN}/api/person-files?id=${row.document_id}`
				: null,
			retrieval: "FTS5 and Unicode lexical search; not vector embeddings",
		},
	};
}
