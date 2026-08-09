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
	retryFailedTwillotHistoryJob,
	verifyTwillotHistoryJobComplete,
} from "#/lib/twillot-history-queue";
import { getTwillotProviderStatus } from "#/lib/twillot-status";

const actionSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("pair") }),
	z.object({ action: z.literal("disconnect") }),
	z.object({ action: z.literal("verify"), jobId: z.string().uuid() }),
	z.object({ action: z.literal("retry"), jobId: z.string().uuid() }),
]);

const LOCAL_COMPANION_ENDPOINT =
	"http://127.0.0.1:3001/api/integrations/twillot-history";

function managementAvailable(request: Request) {
	const hostname = new URL(request.url).hostname;
	return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
}

function managementResponse(request: Request) {
	return {
		endpoint: LOCAL_COMPANION_ENDPOINT,
		localQueueExecutor: true as const,
		managementAvailable: managementAvailable(request),
	};
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
				if (!managementAvailable(request)) {
					return jsonResponse(
						{
							ok: false,
							message:
								"Manage the Twillot companion from local BirdClaw on 127.0.0.1:3001.",
						},
						{ status: 409 },
					);
				}
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
					} else {
						retryFailedTwillotHistoryJob(db, {
							jobId: parsed.data.jobId,
						});
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
