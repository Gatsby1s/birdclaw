import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import {
	getBirdclawPaths,
	resetBirdclawPathsForTests,
	type BirdclawPaths,
} from "../lib/config";
import { resetDatabaseWriterForTests } from "../lib/database-writer";
import { getNativeDb, resetDatabaseForTests } from "../lib/db";
import type { Database } from "../lib/sqlite";

const DEFAULT_TIMESTAMP = "2026-01-01T00:00:00.000Z";

export interface TestHomeOptions {
	prefix?: string;
	seedDemoData?: boolean;
}

export interface TestHome {
	readonly root: string;
	readonly paths: BirdclawPaths;
	readonly db: Database;
	makeTempDir(prefix?: string): string;
	switchHome(prefix?: string): TestHome;
	cleanup(): void;
}

function restoreEnvironment(snapshot: NodeJS.ProcessEnv) {
	for (const key of Object.keys(process.env)) {
		if (!(key in snapshot)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(snapshot)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

export function createTestHome(options: TestHomeOptions = {}): TestHome {
	const environment = { ...process.env };
	const directories = new Set<string>();
	const seedDemoData = options.seedDemoData ?? false;
	let activeRoot = "";
	let cleaned = false;

	const makeTempDir = (prefix = "birdclaw-test-") => {
		if (cleaned) throw new Error("Test home already cleaned up");
		const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
		directories.add(directory);
		return directory;
	};

	const activate = (root: string) => {
		resetDatabaseWriterForTests();
		resetDatabaseForTests();
		resetBirdclawPathsForTests();
		activeRoot = root;
		process.env.BIRDCLAW_HOME = root;
		delete process.env.BIRDCLAW_CONFIG;
	};

	const home: TestHome = {
		get root() {
			return activeRoot;
		},
		get paths() {
			return getBirdclawPaths();
		},
		get db() {
			return getNativeDb({ seedDemoData });
		},
		makeTempDir,
		switchHome(prefix = options.prefix ?? "birdclaw-home-") {
			activate(makeTempDir(prefix));
			return home;
		},
		cleanup() {
			if (cleaned) return;
			cleaned = true;
			resetDatabaseWriterForTests();
			resetDatabaseForTests();
			resetBirdclawPathsForTests();
			restoreEnvironment(environment);
			for (const directory of directories) {
				rmSync(directory, { recursive: true, force: true });
			}
			directories.clear();
		},
	};

	activate(makeTempDir(options.prefix ?? "birdclaw-home-"));
	return home;
}

export async function withTestHome<T>(
	run: (home: TestHome) => T | Promise<T>,
	options: TestHomeOptions = {},
) {
	const home = createTestHome(options);
	try {
		return await run(home);
	} finally {
		home.cleanup();
	}
}

export function useTestHome(options: TestHomeOptions = {}) {
	let home: TestHome | undefined;
	beforeEach(() => {
		home = createTestHome(options);
	});
	afterEach(() => {
		home?.cleanup();
		home = undefined;
	});
	return () => {
		if (!home) throw new Error("Test home is only available during a test");
		return home;
	};
}

export interface TestAccount {
	id: string;
	name: string;
	handle: string;
	externalUserId: string | null;
	transport: string;
	isDefault: number;
	createdAt: string;
}

export function buildTestAccount(
	overrides: Partial<TestAccount> = {},
): TestAccount {
	return {
		id: "account:test",
		name: "Test Account",
		handle: "@test",
		externalUserId: "1000",
		transport: "archive",
		isDefault: 1,
		createdAt: DEFAULT_TIMESTAMP,
		...overrides,
	};
}

export function insertTestAccount(
	db: Database,
	overrides: Partial<TestAccount> = {},
) {
	const row = buildTestAccount(overrides);
	db.prepare(
		`insert into accounts
      (id, name, handle, external_user_id, transport, is_default, created_at)
      values (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		row.id,
		row.name,
		row.handle,
		row.externalUserId,
		row.transport,
		row.isDefault,
		row.createdAt,
	);
	return row;
}

export interface TestProfile {
	id: string;
	handle: string;
	displayName: string;
	bio: string;
	followersCount: number;
	followingCount: number;
	publicMetricsJson: string;
	avatarHue: number;
	avatarUrl: string | null;
	location: string | null;
	url: string | null;
	verifiedType: string | null;
	entitiesJson: string;
	rawJson: string;
	createdAt: string;
}

export function buildTestProfile(
	overrides: Partial<TestProfile> = {},
): TestProfile {
	return {
		id: "profile:test",
		handle: "test",
		displayName: "Test Profile",
		bio: "Test profile bio",
		followersCount: 10,
		followingCount: 5,
		publicMetricsJson: '{"followers_count":10,"following_count":5}',
		avatarHue: 42,
		avatarUrl: null,
		location: null,
		url: null,
		verifiedType: null,
		entitiesJson: "{}",
		rawJson: "{}",
		createdAt: DEFAULT_TIMESTAMP,
		...overrides,
	};
}

export function insertTestProfile(
	db: Database,
	overrides: Partial<TestProfile> = {},
) {
	const row = buildTestProfile(overrides);
	db.prepare(
		`insert into profiles (
      id, handle, display_name, bio, followers_count, following_count,
      public_metrics_json, avatar_hue, avatar_url, location, url,
      verified_type, entities_json, raw_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		row.id,
		row.handle,
		row.displayName,
		row.bio,
		row.followersCount,
		row.followingCount,
		row.publicMetricsJson,
		row.avatarHue,
		row.avatarUrl,
		row.location,
		row.url,
		row.verifiedType,
		row.entitiesJson,
		row.rawJson,
		row.createdAt,
	);
	return row;
}

export interface TestTweet {
	id: string;
	authorProfileId: string;
	text: string;
	createdAt: string;
	isReplied: number;
	replyToId: string | null;
	likeCount: number;
	mediaCount: number;
	entitiesJson: string;
	mediaJson: string;
	quotedTweetId: string | null;
}

export function buildTestTweet(overrides: Partial<TestTweet> = {}): TestTweet {
	return {
		id: "tweet:test",
		authorProfileId: "profile:test",
		text: "Test tweet",
		createdAt: DEFAULT_TIMESTAMP,
		isReplied: 0,
		replyToId: null,
		likeCount: 0,
		mediaCount: 0,
		entitiesJson: "{}",
		mediaJson: "[]",
		quotedTweetId: null,
		...overrides,
	};
}

export function insertTestTweet(
	db: Database,
	overrides: Partial<TestTweet> = {},
) {
	const row = buildTestTweet(overrides);
	db.prepare(
		`insert into tweets (
      id, author_profile_id, text, created_at, is_replied, reply_to_id,
      like_count, media_count, entities_json, media_json, quoted_tweet_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		row.id,
		row.authorProfileId,
		row.text,
		row.createdAt,
		row.isReplied,
		row.replyToId,
		row.likeCount,
		row.mediaCount,
		row.entitiesJson,
		row.mediaJson,
		row.quotedTweetId,
	);
	return row;
}

export interface TestDmConversation {
	id: string;
	accountId: string;
	participantProfileId: string;
	title: string;
	inboxKind: string;
	lastMessageAt: string;
	unreadCount: number;
	needsReply: number;
}

export function buildTestDmConversation(
	overrides: Partial<TestDmConversation> = {},
): TestDmConversation {
	return {
		id: "dm:test",
		accountId: "account:test",
		participantProfileId: "profile:test",
		title: "Test conversation",
		inboxKind: "accepted",
		lastMessageAt: DEFAULT_TIMESTAMP,
		unreadCount: 0,
		needsReply: 0,
		...overrides,
	};
}

export function insertTestDmConversation(
	db: Database,
	overrides: Partial<TestDmConversation> = {},
) {
	const row = buildTestDmConversation(overrides);
	db.prepare(
		`insert into dm_conversations (
      id, account_id, participant_profile_id, title, inbox_kind,
      last_message_at, unread_count, needs_reply
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		row.id,
		row.accountId,
		row.participantProfileId,
		row.title,
		row.inboxKind,
		row.lastMessageAt,
		row.unreadCount,
		row.needsReply,
	);
	return row;
}

export interface TestDmMessage {
	id: string;
	conversationId: string;
	senderProfileId: string;
	text: string;
	createdAt: string;
	direction: string;
	isReplied: number;
	mediaCount: number;
}

export function buildTestDmMessage(
	overrides: Partial<TestDmMessage> = {},
): TestDmMessage {
	return {
		id: "dm-message:test",
		conversationId: "dm:test",
		senderProfileId: "profile:test",
		text: "Test direct message",
		createdAt: DEFAULT_TIMESTAMP,
		direction: "inbound",
		isReplied: 0,
		mediaCount: 0,
		...overrides,
	};
}

export function insertTestDmMessage(
	db: Database,
	overrides: Partial<TestDmMessage> = {},
) {
	const row = buildTestDmMessage(overrides);
	db.prepare(
		`insert into dm_messages (
      id, conversation_id, sender_profile_id, text, created_at, direction,
      is_replied, media_count
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		row.id,
		row.conversationId,
		row.senderProfileId,
		row.text,
		row.createdAt,
		row.direction,
		row.isReplied,
		row.mediaCount,
	);
	return row;
}
