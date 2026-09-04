import { Effect } from "effect";
import { getAuthenticatedBirdAccountEffect } from "./bird";
import { getTwitter6551Config, resolveProfileAnalysisSource } from "./config";
import { getNativeDb } from "./db";
import { getTwitter6551RuntimeStatus } from "./twitter-6551";
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
		const runtime = getTwitter6551RuntimeStatus();
		const works =
			runtime.activeSource === "local" ||
			runtime.connected ||
			Boolean(runtime.lastBackfillAt && runtime.state !== "error");
		return {
			source: "twitter6551" as const,
			label: "Twitter recovery",
			works,
			installed: true,
			status: (runtime.state === "error"
				? "error"
				: runtime.state === "degraded"
					? "warning"
					: works
						? "ok"
						: "warning") as "ok" | "warning" | "error",
			detail:
				runtime.activeSource === "local"
					? runtime.provider === "fxtwitter"
						? "local bridge online; free FxTwitter recovery is standing by"
						: "local bridge online; 6551 is standing by"
					: runtime.activeSource === "twillot"
						? `Twillot cloud fallback is processing ${String(runtime.twillotPendingCount)} account${runtime.twillotPendingCount === 1 ? "" : "s"} after FxTwitter gaps`
						: runtime.activeSource === "fxtwitter"
							? (runtime.lastError ??
								(runtime.lastBackfillAt
									? `free FxTwitter targeted recovery active; last sync ${runtime.lastBackfillAt}`
									: "free FxTwitter targeted recovery is starting"))
							: runtime.connected
								? `6551 realtime connected; ${String(runtime.watchUsers.length)} watched account${runtime.watchUsers.length === 1 ? "" : "s"}`
								: runtime.activeSource === "waiting"
									? runtime.provider === "fxtwitter"
										? "waiting for the local bridge before free FxTwitter recovery"
										: "waiting for the local bridge before 6551 takeover"
									: runtime.lastBackfillAt
										? `6551 recovery polling active; last sync ${runtime.lastBackfillAt}`
										: runtime.provider === "fxtwitter"
											? (runtime.lastError ??
												"free FxTwitter recovery is not active")
											: config.tokenDetected
												? (runtime.lastError ??
													"token detected; worker is not connected")
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
