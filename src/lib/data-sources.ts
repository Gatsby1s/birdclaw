import { Effect } from "effect";
import { getAuthenticatedBirdAccountEffect } from "./bird";
import { getTwitter6551Config, resolveProfileAnalysisSource } from "./config";
import { getNativeDb } from "./db";
import type { LiveDataSourcesResponse } from "./api-contracts";
import type {
	LiveDataSourceAccount,
	LiveDataSourceCapability,
	LiveDataSourceStatus,
} from "./types";
import {
	getTransportStatusEffect,
	lookupAuthenticatedOAuth2UserEffect,
	readXurlOAuth2AccountsEffect,
} from "./xurl";

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function readLocalAccounts(): LiveDataSourceAccount[] {
	const db = getNativeDb();
	const rows = db
		.prepare(
			`
      select id, handle, external_user_id, is_default
      from accounts
      order by is_default desc, lower(handle) asc
      `,
		)
		.all() as Array<{
		id: string;
		handle: string;
		external_user_id: string | null;
		is_default: number;
	}>;
	return rows.map((row) => ({
		id: row.external_user_id ?? row.id,
		handle: row.handle,
		username: row.handle.replace(/^@/, ""),
		isDefault: row.is_default === 1,
	}));
}

function getBirdclawStatusEffect(): Effect.Effect<LiveDataSourceStatus, never> {
	return Effect.try({
		try: () => readLocalAccounts(),
		catch: (error) => error,
	}).pipe(
		Effect.map((accounts) => ({
			source: "birdclaw" as const,
			label: "Birdclaw local",
			works: true,
			installed: true,
			status: "ok" as const,
			detail:
				accounts.length > 0
					? `${accounts.length.toString()} local account${accounts.length === 1 ? "" : "s"}`
					: "local database ready; no accounts imported yet",
			accounts,
		})),
		Effect.catchAll((error) =>
			Effect.succeed({
				source: "birdclaw" as const,
				label: "Birdclaw local",
				works: false,
				installed: true,
				status: "error" as const,
				detail: errorMessage(error),
				accounts: [],
			}),
		),
	);
}

function getBirdStatusEffect(): Effect.Effect<LiveDataSourceStatus, never> {
	return getAuthenticatedBirdAccountEffect().pipe(
		Effect.map((account) => ({
			source: "bird" as const,
			label: "bird",
			works: true,
			installed: true,
			status: "ok" as const,
			detail: `authenticated as @${account.username}`,
			accounts: [
				{
					...(account.id ? { id: account.id } : {}),
					username: account.username,
					handle: `@${account.username}`,
				},
			],
		})),
		Effect.catchAll((error) =>
			Effect.succeed({
				source: "bird" as const,
				label: "bird",
				works: false,
				status: "error" as const,
				detail: errorMessage(error),
				accounts: [],
			}),
		),
	);
}

function getXurlStatusEffect(): Effect.Effect<LiveDataSourceStatus, never> {
	return Effect.gen(function* () {
		const transport = yield* getTransportStatusEffect();
		const oauth2Accounts = yield* readXurlOAuth2AccountsEffect();
		const authenticated = yield* lookupAuthenticatedOAuth2UserEffect().pipe(
			Effect.catchAll(() => Effect.succeed(null)),
		);
		const authenticatedAccount =
			authenticated && typeof authenticated === "object"
				? ({
						...(typeof authenticated.id === "string"
							? { id: authenticated.id }
							: {}),
						...(typeof authenticated.username === "string"
							? {
									username: authenticated.username,
									handle: `@${authenticated.username}`,
								}
							: {}),
					} satisfies LiveDataSourceAccount)
				: undefined;
		const accounts: LiveDataSourceAccount[] = [
			...(authenticatedAccount ? [authenticatedAccount] : []),
			...oauth2Accounts,
		];
		const deduped = accounts.filter(
			(account, index) =>
				accounts.findIndex(
					(candidate) =>
						(candidate.app ?? "") === (account.app ?? "") &&
						(candidate.username ?? candidate.handle ?? "") ===
							(account.username ?? account.handle ?? ""),
				) === index,
		);
		const works = transport.availableTransport === "xurl";
		return {
			source: "xurl" as const,
			label: "xurl",
			works,
			installed: transport.installed,
			status: works ? ("ok" as const) : ("warning" as const),
			detail: transport.statusText,
			accounts: deduped,
		};
	}).pipe(
		Effect.catchAll((error) =>
			Effect.succeed({
				source: "xurl" as const,
				label: "xurl",
				works: false,
				status: "error" as const,
				detail: errorMessage(error),
				accounts: [],
			}),
		),
	);
}

function getTwitter6551StatusEffect(): Effect.Effect<
	LiveDataSourceStatus,
	never
> {
	return Effect.sync(() => {
		const config = getTwitter6551Config();
		return {
			source: "twitter6551" as const,
			label: "6551 Twitter API",
			works: false,
			installed: true,
			status: "warning" as const,
			detail: config.tokenDetected
				? `${config.tokenEnv} detected; Profile Analyse adapter pending`
				: `${config.tokenEnv} not detected`,
			accounts: [],
		};
	});
}

function profileAnalysisSourceKind(): LiveDataSourceCapability["primary"] {
	const source = resolveProfileAnalysisSource();
	if (source === "xurl") return "xurl";
	if (source === "6551") return "twitter6551";
	return "birdclaw";
}

function buildCapabilities(): LiveDataSourceCapability[] {
	const profilePrimary = profileAnalysisSourceKind();
	const profileFallbacks = (
		["birdclaw", "xurl", "twitter6551"] as const
	).filter((source) => source !== profilePrimary);
	return [
		{
			key: "timeline",
			label: "Home timeline",
			primary: "xurl",
			fallbacks: ["bird"],
		},
		{
			key: "mentions",
			label: "Mentions",
			primary: "xurl",
			fallbacks: ["bird", "birdclaw"],
			notes:
				"bird fallback is skipped when a since/start cursor requires xurl.",
		},
		{
			key: "profile-analysis",
			label: "Profile Analyse",
			primary: profilePrimary,
			fallbacks: profileFallbacks,
			notes: "Controlled by Settings; refresh sources are explicit.",
		},
		{
			key: "search",
			label: "Fresh search",
			primary: "bird",
			fallbacks: ["xurl", "birdclaw"],
			notes: "dated searches require xurl.",
		},
		{
			key: "dms",
			label: "DMs",
			primary: "xurl",
			fallbacks: ["bird", "birdclaw"],
			notes: "message requests require bird.",
		},
		{
			key: "follow-graph",
			label: "Followers / following",
			primary: "bird",
			fallbacks: ["xurl", "birdclaw"],
		},
	];
}

export function getLiveDataSourcesEffect(): Effect.Effect<
	LiveDataSourcesResponse,
	never
> {
	return Effect.gen(function* () {
		const sources = yield* Effect.all(
			[
				getBirdclawStatusEffect(),
				getBirdStatusEffect(),
				getXurlStatusEffect(),
				getTwitter6551StatusEffect(),
			],
			{ concurrency: "unbounded" },
		);
		return {
			generatedAt: new Date().toISOString(),
			sources,
			capabilities: buildCapabilities(),
		};
	});
}
