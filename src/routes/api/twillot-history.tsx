import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { twillotProviderStatusSchema } from "#/lib/api-contracts";
import {
	createTwillotCompanionPairing,
	disconnectTwillotCompanion,
} from "#/lib/twillot-companion";
import { getNativeDb } from "#/lib/db";
import { jsonResponse, sensitiveRequestErrorResponse } from "#/lib/http-effect";
import {
	enqueueTwillotHistoryJob,
	retryFailedTwillotHistoryJob,
	verifyTwillotHistoryJobComplete,
} from "#/lib/twillot-history-queue";
import { getTwillotProviderStatus } from "#/lib/twillot-status";

const actionSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("pair") }),
	z.object({ action: z.literal("disconnect") }),
	z.object({ action: z.literal("verify"), jobId: z.string().uuid() }),
	z.object({ action: z.literal("retry"), jobId: z.string().uuid() }),
	z.object({
		action: z.literal("enqueue"),
		handle: z
			.string()
			.trim()
			.regex(/^@?[A-Za-z0-9_]{1,64}$/),
		externalUserId: z
			.string()
			.trim()
			.regex(/^\d{1,32}$/),
	}),
]);

const LOCAL_COMPANION_ENDPOINT =
	"http://127.0.0.1:3001/api/integrations/twillot-history";
const CLOUD_COMPANION_ENDPOINT =
	"https://birdclaw-production.up.railway.app/api/integrations/twillot-history";

function managementAvailable(request: Request) {
	const hostname = new URL(request.url).hostname;
	return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
}

function managementResponse(request: Request) {
	const localQueueExecutor = managementAvailable(request);
	return {
		endpoint: localQueueExecutor
			? LOCAL_COMPANION_ENDPOINT
			: CLOUD_COMPANION_ENDPOINT,
		localQueueExecutor,
		managementAvailable: true,
	};
}

function enqueueTarget(
	db: ReturnType<typeof getNativeDb>,
	input: { handle: string; externalUserId: string },
) {
	const handle = input.handle.replace(/^@/, "");
	const account = db
		.prepare(
			"select id from accounts order by is_default desc, created_at asc, id limit 1",
		)
		.get() as { id: string } | undefined;
	if (!account)
		throw new Error("BirdClaw has no account for this history job.");
	const canonicalProfileId = `profile_user_${input.externalUserId}`;
	let profile = db
		.prepare(
			`select id from profiles
			 where id = ? or lower(handle) = lower(?)
			 order by case when id = ? then 0 else 1 end, created_at asc, id
			 limit 1`,
		)
		.get(canonicalProfileId, handle, canonicalProfileId) as
		| { id: string }
		| undefined;
	if (!profile) {
		db.prepare(
			`insert into profiles (
				id, handle, display_name, bio, followers_count, following_count,
				public_metrics_json, avatar_hue, avatar_url, location, url,
				verified_type, entities_json, raw_json, created_at
			) values (?, ?, ?, '', 0, 0, '{}', 0, null, null, null, null, '{}', ?, ?)`,
		).run(
			canonicalProfileId,
			handle,
			handle,
			JSON.stringify({ id: input.externalUserId, username: handle }),
			new Date().toISOString(),
		);
		profile = { id: canonicalProfileId };
	}
	return enqueueTwillotHistoryJob(db, {
		accountId: account.id,
		profileId: profile.id,
		externalUserId: input.externalUserId,
		handle,
	});
}

export const Route = createFileRoute("/api/twillot-history")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return denied;
				const db = getNativeDb({ seedDemoData: false });
				return jsonResponse({
					ok: true,
					...managementResponse(request),
					status: twillotProviderStatusSchema.parse(
						getTwillotProviderStatus(db),
					),
				});
			},
			POST: async ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return denied;
				const parsed = actionSchema.safeParse(
					await request.json().catch(() => null),
				);
				if (!parsed.success) {
					return jsonResponse(
						{ ok: false, message: "Unknown Twillot history action." },
						{ status: 400 },
					);
				}
				const db = getNativeDb({ seedDemoData: false });
				let token: string | undefined;
				try {
					if (parsed.data.action === "pair") {
						token = createTwillotCompanionPairing(db).token;
					} else if (parsed.data.action === "disconnect") {
						disconnectTwillotCompanion(db);
					} else if (parsed.data.action === "verify") {
						verifyTwillotHistoryJobComplete(db, {
							jobId: parsed.data.jobId,
						});
					} else if (parsed.data.action === "retry") {
						retryFailedTwillotHistoryJob(db, {
							jobId: parsed.data.jobId,
						});
					} else {
						enqueueTarget(db, parsed.data);
					}
				} catch (error) {
					return jsonResponse(
						{
							ok: false,
							message: error instanceof Error ? error.message : String(error),
						},
						{ status: 409 },
					);
				}
				return jsonResponse({
					ok: true,
					...managementResponse(request),
					...(token ? { token } : {}),
					status: twillotProviderStatusSchema.parse(
						getTwillotProviderStatus(db),
					),
				});
			},
		},
	},
});
