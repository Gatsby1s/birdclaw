import { createHash, randomUUID } from "node:crypto";
import type { Database } from "./sqlite";
import type {
	PersonDetail,
	PersonItem,
	PersonMedia,
	PersonSource,
	PersonSourceKind,
	PersonSummary,
} from "./person-archive-types";
import { enqueueTwillotHistoryJob } from "./twillot-history-queue";
import { getExternalUserId, upsertProfileFromXUser } from "./x-profile";

export interface PersonSourceRow {
	id: string;
	person_id: string;
	kind: PersonSourceKind;
	identifier: string;
	url: string;
	profile_id: string | null;
	enabled: number;
	history_status: string;
	history_cursor: string | null;
	latest_cursor: string | null;
	media_cursor: number;
	next_poll_at: string;
	last_synced_at: string | null;
	last_error: string | null;
	created_at: string;
}
interface PersonRow {
	merged_into: string | null;
	id: string;
	name: string;
	description: string;
	read_sequence: number;
	created_at: string;
	updated_at: string;
}
export interface PersonDocumentRow {
	sequence: number;
	id: string;
	person_id: string;
	source_id: string | null;
	external_id: string | null;
	kind: "telegram" | "document";
	title: string;
	text: string;
	published_at: string;
	ingested_at: string;
	source_url: string | null;
	filename: string | null;
	mime_type: string | null;
	storage_key: string | null;
	byte_size: number;
	extraction_status: string;
	raw_json: string;
	content_hash: string;
}
export function personContentHash(value: string | Uint8Array) {
	return createHash("sha256").update(value).digest("hex");
}
export function requirePerson(db: Database, id: string): PersonRow {
	const person = db.prepare("select * from people where id=?").get(id) as
		| PersonRow
		| undefined;
	if (!person) throw new Error("人物不存在。");
	if (person.merged_into) throw new Error("此人物已合并到另一份档案。");
	return person;
}
export function normalizePersonSource(kind: PersonSourceKind, value: string) {
	let identifier = value.trim().replace(/^@/, "");
	if (/^https?:\/\//i.test(identifier)) {
		const url = new URL(identifier);
		if (url.username || url.password || url.port)
			throw new Error("请填写标准的账号或频道链接。");
		const allowed =
			kind === "x"
				? ["x.com", "twitter.com", "www.x.com", "www.twitter.com"]
				: ["t.me", "telegram.me", "www.t.me"];
		if (!allowed.includes(url.hostname.toLowerCase()))
			throw new Error("来源链接的平台不匹配。");
		const parts = url.pathname.split("/").filter(Boolean);
		identifier =
			kind === "telegram" && parts[0] === "s"
				? (parts[1] ?? "")
				: (parts[0] ?? "");
		if (parts.length > (kind === "telegram" && parts[0] === "s" ? 2 : 1))
			throw new Error("请填写人物主页或频道链接，不是单条消息链接。");
	}
	const pattern =
		kind === "x" ? /^[A-Za-z0-9_]{1,15}$/ : /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
	if (
		!pattern.test(identifier) ||
		["s", "c", "joinchat", "share", "login", "intent", "home", "i"].includes(
			identifier.toLowerCase(),
		)
	) {
		throw new Error(
			kind === "telegram"
				? "请填写公开 Telegram 频道链接（t.me/频道名）。私有邀请链接需要账号授权后才能读取。"
				: "请填写有效的 X 用户名或人物主页链接。",
		);
	}
	identifier = identifier.toLowerCase();
	return {
		identifier,
		url:
			kind === "x"
				? `https://x.com/${identifier}`
				: `https://t.me/${identifier}`,
	};
}
export function createPerson(db: Database, name: string, description = "") {
	if (!name.trim() || name.trim().length > 120 || description.length > 4000)
		throw new Error("人物名称需为 1–120 个字符，简介最多 4000 字。");
	const id = randomUUID();
	const now = new Date().toISOString();
	db.prepare(
		"insert into people(id,name,description,created_at,updated_at) values(?,?,?,?,?)",
	).run(id, name.trim(), description.trim(), now, now);
	return id;
}
export function addPersonSource(
	db: Database,
	personId: string,
	kind: PersonSourceKind,
	value: string,
	options: { queueHistory?: boolean } = {},
) {
	requirePerson(db, personId);
	const normalized = normalizePersonSource(kind, value);
	const existing = db
		.prepare("select * from person_sources where kind=? and identifier=?")
		.get(kind, normalized.identifier) as PersonSourceRow | undefined;
	if (existing) {
		if (existing.person_id !== personId)
			throw new Error(
				"这个来源已属于另一个人物，请打开已有档案，避免同一内容归错人。",
			);
		return existing.id;
	}
	const profile =
		kind === "x"
			? (db
					.prepare("select id from profiles where lower(handle)=?")
					.get(normalized.identifier) as { id: string } | undefined)
			: undefined;
	if (profile) {
		const linked = db
			.prepare(
				"select id,person_id from person_sources where kind='x' and profile_id=?",
			)
			.get(profile.id) as { id: string; person_id: string } | undefined;
		if (linked) {
			if (linked.person_id !== personId)
				throw new Error("此 X 账号已关联其他人物，请先合并人物档案。");
			return linked.id;
		}
	}
	const id = randomUUID();
	const now = new Date().toISOString();
	db.prepare(
		`insert into person_sources(id,person_id,kind,identifier,url,profile_id,history_status,next_poll_at,created_at) values(?,?,?,?,?,?,?,?,?)`,
	).run(
		id,
		personId,
		kind,
		normalized.identifier,
		normalized.url,
		profile?.id ?? null,
		options.queueHistory === false ? "existing_archive" : "queued",
		now,
		now,
	);
	db.prepare("update people set updated_at=? where id=?").run(now, personId);
	return id;
}
export function resolvePersonForHandle(db: Database, handle: string) {
	const { identifier } = normalizePersonSource("x", handle);
	const profile = db
		.prepare("select id,display_name from profiles where lower(handle)=?")
		.get(identifier) as { id: string; display_name: string } | undefined;
	const source = profile
		? (db
				.prepare(
					"select person_id from person_sources where kind='x' and profile_id=?",
				)
				.get(profile.id) as { person_id: string } | undefined)
		: undefined;
	if (source) return source.person_id;
	const byHandle = db
		.prepare(
			"select person_id,profile_id from person_sources where kind='x' and identifier=?",
		)
		.get(identifier) as
		| { person_id: string; profile_id: string | null }
		| undefined;
	if (byHandle) {
		if (profile && byHandle.profile_id && byHandle.profile_id !== profile.id)
			throw new Error("此用户名归属已变化，请在原人物档案核对 X 来源。");
		return byHandle.person_id;
	}
	return db.transaction(() => {
		const id = createPerson(db, profile?.display_name || identifier);
		addPersonSource(db, id, "x", identifier);
		return id;
	})();
}
// Link existing follows without unexpectedly spending a full historical quota on all legacy follows.
// Existing/new Twillot jobs retain their own queue state; explicitly adding a source always queues history.
export function ensureFollowedPeople(db: Database) {
	const rows = db
		.prepare(`select distinct p.id,p.handle,p.display_name,
    exists(select 1 from twillot_history_jobs j where j.profile_id=p.id) has_job
    from follow_edges e join profiles p on p.id=e.profile_id
    where e.direction='following' and e.current=1 and not exists
    (select 1 from person_sources s where s.kind='x' and (s.profile_id=p.id or s.identifier=lower(p.handle)))
    order by e.updated_at desc limit 100`)
		.all() as Array<{
		id: string;
		handle: string;
		display_name: string;
		has_job: number;
	}>;
	db.transaction(() => {
		for (const row of rows) {
			if (!/^[A-Za-z0-9_]{1,15}$/.test(row.handle)) continue;
			const id = createPerson(db, row.display_name || row.handle);
			addPersonSource(db, id, "x", row.handle, {
				queueHistory: Boolean(row.has_job),
			});
		}
	})();
	return rows.length;
}
export async function queuePersonXSource(db: Database, sourceId: string) {
	const source = db
		.prepare("select * from person_sources where id=? and kind='x'")
		.get(sourceId) as PersonSourceRow | undefined;
	if (!source || !source.enabled) return;
	let profile = db
		.prepare(
			"select id,handle from profiles where id=? or lower(handle)=? order by case when id=? then 0 else 1 end limit 1",
		)
		.get(source.profile_id, source.identifier, source.profile_id) as
		| { id: string; handle: string }
		| undefined;
	let externalId = profile ? getExternalUserId(profile.id) : null;
	if (!externalId && profile) {
		const edge = db
			.prepare(
				"select external_user_id from follow_edges where profile_id=? limit 1",
			)
			.get(profile.id) as { external_user_id: string } | undefined;
		externalId = edge?.external_user_id ?? null;
	}
	if (!externalId) {
		const { createBudgetedTwitter6551Client, twitter6551UserToXurl } =
			await import("./twitter-6551");
		const user = await createBudgetedTwitter6551Client().getUser(
			source.identifier,
		);
		const resolved = upsertProfileFromXUser(db, twitter6551UserToXurl(user));
		profile = { id: resolved.profile.id, handle: resolved.profile.handle };
		externalId = resolved.externalUserId;
	}
	const account = db
		.prepare(
			"select id from accounts order by is_default desc,created_at,id limit 1",
		)
		.get() as { id: string } | undefined;
	if (!account || !profile)
		throw new Error("尚未连接 X 采集账号，历史任务已保留。");
	// A source may have been paused while resolving its X identity.
	if (
		!(
			db
				.prepare("select enabled from person_sources where id=?")
				.get(sourceId) as { enabled: number }
		)?.enabled
	)
		return;
	const linked = db
		.prepare(
			"select id from person_sources where kind='x' and profile_id=? and id<>?",
		)
		.get(profile.id, sourceId);
	if (linked)
		throw new Error("此 X 账号已关联其他人物，请合并人物档案后重试。");
	const job = enqueueTwillotHistoryJob(db, {
		accountId: account.id,
		profileId: profile.id,
		handle: profile.handle,
		externalUserId: externalId,
	});
	db.prepare(
		"update person_sources set profile_id=?,history_status=?,last_error=null where id=?",
	).run(profile.id, job.captureStatus, sourceId);
}
export function recordPersonEvent(
	db: Database,
	personId: string,
	itemId: string,
	now = new Date().toISOString(),
) {
	db.prepare(
		"insert or ignore into person_events(person_id,item_id,created_at) values(?,?,?)",
	).run(personId, itemId, now);
	db.prepare("update people set updated_at=? where id=?").run(now, personId);
}
export interface PersonDocumentInput {
	personId: string;
	sourceId?: string | null;
	externalId?: string | null;
	kind: "telegram" | "document";
	title: string;
	text: string;
	publishedAt: string;
	sourceUrl?: string | null;
	rawJson?: unknown;
	filename?: string | null;
	mimeType?: string | null;
	storageKey?: string | null;
	byteSize?: number;
	extractionStatus?: string;
	contentHash?: string;
	isHistorical?: boolean;
}
export function upsertPersonDocument(db: Database, input: PersonDocumentInput) {
	requirePerson(db, input.personId);
	if (input.sourceId) {
		const source = db
			.prepare("select person_id from person_sources where id=?")
			.get(input.sourceId) as { person_id: string } | undefined;
		if (source?.person_id !== input.personId)
			throw new Error("资料来源与人物不匹配。");
	}
	const hash =
		input.contentHash ??
		personContentHash(
			JSON.stringify([input.title, input.text, input.rawJson ?? {}]),
		);
	const existing = (
		input.sourceId && input.externalId
			? db
					.prepare(
						"select * from person_documents where source_id=? and external_id=?",
					)
					.get(input.sourceId, input.externalId)
			: input.kind === "document"
				? db
						.prepare(
							"select * from person_documents where person_id=? and kind='document' and content_hash=?",
						)
						.get(input.personId, hash)
				: undefined
	) as PersonDocumentRow | undefined;
	if (existing?.content_hash === hash)
		return { id: existing.id, inserted: false, sequence: existing.sequence };
	const id = existing?.id ?? randomUUID();
	const now = new Date().toISOString();
	return db.transaction(() => {
		if (existing) {
			db.prepare(
				"update person_documents set title=?,text=?,published_at=?,source_url=?,raw_json=?,content_hash=?,extraction_status=? where id=?",
			).run(
				input.title,
				input.text,
				input.publishedAt,
				input.sourceUrl ?? null,
				JSON.stringify(input.rawJson ?? {}),
				hash,
				input.extractionStatus ?? "indexed",
				id,
			);
		} else {
			db.prepare(
				`insert into person_documents(id,person_id,source_id,external_id,kind,title,text,published_at,ingested_at,source_url,filename,mime_type,storage_key,byte_size,extraction_status,raw_json,content_hash) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			).run(
				id,
				input.personId,
				input.sourceId ?? null,
				input.externalId ?? null,
				input.kind,
				input.title,
				input.text,
				input.publishedAt,
				now,
				input.sourceUrl ?? null,
				input.filename ?? null,
				input.mimeType ?? null,
				input.storageKey ?? null,
				input.byteSize ?? 0,
				input.extractionStatus ?? "indexed",
				JSON.stringify(input.rawJson ?? {}),
				hash,
			);
			if (!input.isHistorical)
				recordPersonEvent(db, input.personId, `doc:${id}`, now);
		}
		db.prepare("delete from person_document_chunks where document_id=?").run(
			id,
		);
		if ((input.extractionStatus ?? "indexed") === "indexed" && input.text) {
			const insert = db.prepare(
				"insert into person_document_chunks(document_id,chunk_index,text,start_offset,page_start) values(?,?,?,?,?)",
			);
			let page = 1;
			let previousStart = 0;
			for (
				let start = 0, index = 0;
				start < input.text.length;
				start += 3700, index++
			) {
				page += (input.text.slice(previousStart, start).match(/\f/g) ?? [])
					.length;
				insert.run(
					id,
					index,
					input.text.slice(start, start + 4000),
					start,
					page,
				);
				previousStart = start;
				if (start + 4000 >= input.text.length) break;
			}
		}
		db.prepare("update people set updated_at=? where id=?").run(
			now,
			input.personId,
		);
		const row = db
			.prepare("select sequence from person_documents where id=?")
			.get(id) as { sequence: number };
		return { id, inserted: !existing, sequence: row.sequence };
	})();
}
export interface PersonAssetInput {
	personId: string;
	sourceId: string;
	documentId?: string | null;
	tweetId?: string | null;
	remoteUrl: string;
	kind: string;
	mimeType?: string | null;
}
export function enqueuePersonAsset(db: Database, input: PersonAssetInput) {
	const id = randomUUID();
	const now = new Date().toISOString();
	db.prepare(
		`insert or ignore into person_assets(id,person_id,source_id,document_id,tweet_id,remote_url,kind,mime_type,next_attempt_at,created_at) values(?,?,?,?,?,?,?,?,?,?)`,
	).run(
		id,
		input.personId,
		input.sourceId,
		input.documentId ?? null,
		input.tweetId ?? null,
		input.remoteUrl,
		input.kind,
		input.mimeType ?? null,
		now,
		now,
	);
	return (
		db
			.prepare(
				"select id from person_assets where source_id=? and remote_url=? and document_id is ? and tweet_id is ?",
			)
			.get(
				input.sourceId,
				input.remoteUrl,
				input.documentId ?? null,
				input.tweetId ?? null,
			) as { id: string }
	).id;
}
function scalar(db: Database, sql: string, ...params: unknown[]) {
	return Number(
		(db.prepare(sql).get(...params) as { n: number } | undefined)?.n ?? 0,
	);
}
export function personLatestSequence(db: Database, id: string) {
	return scalar(
		db,
		"select max(sequence) n from person_events where person_id=?",
		id,
	);
}
export function markPersonRead(db: Database, id: string, through: number) {
	requirePerson(db, id);
	if (
		!Number.isSafeInteger(through) ||
		through < 0 ||
		through > personLatestSequence(db, id)
	)
		throw new Error("无效的阅读位置。");
	db.prepare(
		"update people set read_sequence=max(read_sequence,?) where id=?",
	).run(through, id);
}
export function personSources(db: Database, personId: string): PersonSource[] {
	const sources = db
		.prepare(
			"select * from person_sources where person_id=? order by created_at,id",
		)
		.all(personId) as PersonSourceRow[];
	return sources.map((row) => {
		const itemCount =
			row.kind === "x"
				? scalar(
						db,
						"select count(*) n from tweets where author_profile_id=?",
						row.profile_id,
					)
				: scalar(
						db,
						"select count(*) n from person_documents where source_id=?",
						row.id,
					);
		const counts = db
			.prepare(
				"select status,count(*) n from person_assets where source_id=? group by status",
			)
			.all(row.id) as Array<{ status: string; n: number }>;
		const status =
			row.kind === "x" && row.profile_id
				? (db
						.prepare(
							"select capture_status,last_error from twillot_history_jobs where profile_id=? order by updated_at desc limit 1",
						)
						.get(row.profile_id) as
						| { capture_status: string; last_error: string | null }
						| undefined)
				: undefined;
		return {
			id: row.id,
			personId: row.person_id,
			kind: row.kind,
			identifier: row.identifier,
			url: row.url,
			enabled: Boolean(row.enabled),
			historyStatus: status?.capture_status ?? row.history_status,
			lastSyncedAt: row.last_synced_at,
			lastError: row.last_error ?? status?.last_error ?? null,
			itemCount,
			mediaStoredCount: counts.find((c) => c.status === "stored")?.n ?? 0,
			mediaPendingCount: counts
				.filter((c) => ["pending", "downloading", "retry"].includes(c.status))
				.reduce((n, c) => n + c.n, 0),
			mediaFailedCount: counts
				.filter(
					(c) =>
						!["stored", "pending", "downloading", "retry"].includes(c.status),
				)
				.reduce((n, c) => n + c.n, 0),
			coverage: row.kind === "telegram" ? "public_web" : "twillot",
		};
	});
}
export function getPersonDetail(db: Database, id: string): PersonDetail {
	const person = requirePerson(db, id);
	const sources = personSources(db, id);
	const documents = scalar(
		db,
		"select count(*) n from person_documents where person_id=? and kind='document'",
		id,
	);
	const itemCount = sources.reduce((n, s) => n + s.itemCount, 0) + documents;
	const unreadCount = scalar(
		db,
		"select count(*) n from person_events where person_id=? and sequence>?",
		id,
		person.read_sequence,
	);
	const avatar = db
		.prepare(
			"select p.avatar_url from person_sources s join profiles p on p.id=s.profile_id where s.person_id=? and p.avatar_url is not null limit 1",
		)
		.get(id) as { avatar_url: string } | undefined;
	return {
		id,
		name: person.name,
		description: person.description,
		avatarUrl: avatar?.avatar_url ?? null,
		sources,
		itemCount,
		unreadCount,
		updatedAt: person.updated_at,
		createdAt: person.created_at,
		latestSequence: personLatestSequence(db, id),
		stats: {
			items: itemCount,
			media: sources.reduce((n, s) => n + s.mediaStoredCount, 0),
			documents,
			unread: unreadCount,
		},
	};
}
export function listPeoplePage(
	db: Database,
	options: {
		q?: string;
		handle?: string;
		before?: string;
		unread?: boolean;
	} = {},
) {
	const q = options.q?.trim().toLowerCase() ?? "";
	const handle = options.handle?.replace(/^@/, "").toLowerCase() ?? "";
	let cursor: [string, string] | null = null;
	if (options.before) {
		try {
			const c = JSON.parse(
				Buffer.from(options.before, "base64url").toString("utf8"),
			);
			if (
				!Array.isArray(c) ||
				c.length !== 2 ||
				!c.every((x) => typeof x === "string" && x.length < 200)
			)
				throw new Error();
			cursor = c as [string, string];
		} catch {
			throw new Error("无效的翻页位置。");
		}
	}
	const where = `p.merged_into is null and (?='' or instr(lower(p.name||' '||p.description),?)>0 or exists(select 1 from person_sources s where s.person_id=p.id and instr(s.identifier,?)>0)) and (?='' or exists(select 1 from person_sources s where s.person_id=p.id and s.kind='x' and s.identifier=?)) and (?=0 or exists(select 1 from person_events e where e.person_id=p.id and e.sequence>p.read_sequence))`;
	const params = [q, q, q, handle, handle, options.unread ? 1 : 0];
	const total = scalar(
		db,
		`select count(*) n from people p where ${where}`,
		...params,
	);
	const rows = db
		.prepare(
			`select p.id,p.updated_at from people p where ${where} and (?='' or p.updated_at<? or (p.updated_at=? and p.id<?)) order by p.updated_at desc,p.id desc limit 51`,
		)
		.all(
			...params,
			cursor?.[0] ?? "",
			cursor?.[0] ?? "",
			cursor?.[0] ?? "",
			cursor?.[1] ?? "",
		) as Array<{ id: string; updated_at: string }>;
	const page = rows.slice(0, 50);
	const last = page.at(-1);
	return {
		people: page.map((row) => getPersonDetail(db, row.id)),
		total,
		nextCursor:
			rows.length > 50 && last
				? Buffer.from(JSON.stringify([last.updated_at, last.id])).toString(
						"base64url",
					)
				: null,
	};
}
export function listPeople(
	db: Database,
	options: { q?: string; handle?: string } = {},
): PersonSummary[] {
	return listPeoplePage(db, options).people;
}
export function mergePeople(db: Database, sourceId: string, targetId: string) {
	if (sourceId === targetId) throw new Error("请选择另一位人物。");
	const source = requirePerson(db, sourceId);
	const target = requirePerson(db, targetId);
	const now = new Date().toISOString();
	db.transaction(() => {
		for (const table of ["person_sources", "person_documents", "person_assets"])
			db.prepare(`update ${table} set person_id=? where person_id=?`).run(
				targetId,
				sourceId,
			);
		const unread = db
			.prepare(
				"select item_id,created_at from person_events where person_id=? and sequence>?",
			)
			.all(sourceId, source.read_sequence) as Array<{
			item_id: string;
			created_at: string;
		}>;
		for (const event of unread)
			recordPersonEvent(db, targetId, event.item_id, event.created_at);
		const description = [
			target.description,
			`合并档案：${source.name}${source.description ? "\n" + source.description : ""}`,
		]
			.filter(Boolean)
			.join("\n\n");
		db.prepare("update people set description=?,updated_at=? where id=?").run(
			description,
			now,
			targetId,
		);
		db.prepare("update people set merged_into=?,updated_at=? where id=?").run(
			targetId,
			now,
			sourceId,
		);
	})();
	return targetId;
}
function mediaForItem(
	db: Database,
	column: "document_id" | "tweet_id",
	id: string,
): PersonMedia[] {
	const rows = db
		.prepare(
			`select id,kind,mime_type,remote_url,status,storage_key from person_assets where ${column}=? order by created_at,id`,
		)
		.all(id) as Array<{
		id: string;
		kind: string;
		mime_type: string | null;
		remote_url: string;
		status: string;
		storage_key: string | null;
	}>;
	return rows.map((row) => ({
		id: row.id,
		kind: row.kind,
		mimeType: row.mime_type,
		url:
			row.status === "stored" && row.storage_key
				? `/api/person-files?id=${encodeURIComponent(row.id)}`
				: null,
		remoteUrl: row.remote_url,
		storageStatus: row.status,
	}));
}
export function personDocumentItem(
	db: Database,
	row: PersonDocumentRow,
): PersonItem {
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(row.raw_json);
	} catch {
		/* optional provenance */
	}
	return {
		id: `doc:${row.id}`,
		personId: row.person_id,
		sourceId: row.source_id,
		kind: row.kind,
		title: row.title,
		text: row.text.slice(0, 6000),
		textTruncated: row.text.length > 6000,
		publishedAt: row.published_at,
		ingestedAt: row.ingested_at,
		sourceUrl: row.source_url,
		media: mediaForItem(db, "document_id", row.id),
		...(row.filename
			? {
					document: {
						filename: row.filename,
						downloadUrl: `/api/person-files?id=${encodeURIComponent(row.id)}`,
						extractionStatus: row.extraction_status,
					},
				}
			: {}),
		ragStatus: row.extraction_status,
		attribution:
			typeof raw.attribution === "string"
				? raw.attribution
				: row.kind === "telegram"
					? "频道内容，可能包含转发；以原文署名为准。"
					: null,
	};
}
export function getPersonItems(
	db: Database,
	options: {
		personId: string;
		kind?: string;
		q?: string;
		before?: string;
		itemId?: string;
	},
) {
	requirePerson(db, options.personId);
	const kind = options.kind ?? "all";
	const q = options.q?.trim().toLowerCase() ?? "";
	let cursor: [string, string] | null = null;
	if (options.before) {
		try {
			const value = JSON.parse(
				Buffer.from(options.before, "base64url").toString("utf8"),
			);
			if (
				Array.isArray(value) &&
				value.length === 2 &&
				value.every((v) => typeof v === "string" && v.length < 200)
			)
				cursor = value as [string, string];
			else throw new Error();
		} catch {
			throw new Error("无效的翻页位置。");
		}
	}
	const rows = db
		.prepare(`select * from (
    select 'tweet:'||t.id item_id,t.id record_id,'x' kind,t.created_at published_at,s.id source_id
    from tweets t join person_sources s on s.profile_id=t.author_profile_id and s.kind='x'
    where s.person_id=? and (?='all' or ?='x') and (?='' or instr(lower(t.text),?)>0)
    union all
    select 'doc:'||d.id item_id,d.id record_id,d.kind,d.published_at,d.source_id from person_documents d
    where d.person_id=? and (?='all' or ?=d.kind) and (?='' or instr(lower(d.title||' '||d.text),?)>0)
  ) where (?='' or item_id=?) and (?='' or published_at<? or (published_at=? and item_id<?))
  order by published_at desc,item_id desc limit 51`)
		.all(
			options.personId,
			kind,
			kind,
			q,
			q,
			options.personId,
			kind,
			kind,
			q,
			q,
			options.itemId ?? "",
			options.itemId ?? "",
			cursor?.[0] ?? "",
			cursor?.[0] ?? "",
			cursor?.[0] ?? "",
			cursor?.[1] ?? "",
		) as Array<{
		item_id: string;
		record_id: string;
		kind: string;
		published_at: string;
		source_id: string | null;
	}>;
	const page = rows.slice(0, 50);
	const items: PersonItem[] = page.map((row) => {
		if (row.kind !== "x")
			return personDocumentItem(
				db,
				db
					.prepare("select * from person_documents where id=?")
					.get(row.record_id) as PersonDocumentRow,
			);
		const t = db
			.prepare(
				"select t.*,p.handle,p.display_name from tweets t join profiles p on p.id=t.author_profile_id where t.id=?",
			)
			.get(row.record_id) as {
			text: string;
			created_at: string;
			handle: string;
			display_name: string;
		};
		return {
			id: row.item_id,
			personId: options.personId,
			sourceId: row.source_id,
			kind: "x",
			title: `${t.display_name} · @${t.handle}`,
			text: t.text,
			publishedAt: t.created_at,
			ingestedAt: t.created_at,
			sourceUrl: `https://x.com/${encodeURIComponent(t.handle)}/status/${encodeURIComponent(row.record_id)}`,
			media: mediaForItem(db, "tweet_id", row.record_id),
			ragStatus: "indexed",
			attribution: null,
		};
	});
	const last = page.at(-1);
	return {
		items,
		nextCursor:
			rows.length > 50 && last
				? Buffer.from(
						JSON.stringify([last.published_at, last.item_id]),
					).toString("base64url")
				: null,
		latestSequence: personLatestSequence(db, options.personId),
	};
}
