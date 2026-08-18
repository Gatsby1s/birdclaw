import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getNativeDb } from "#/lib/db";
import {
	xRemarkBearerToken,
	xRemarkBridgeCorsHeaders,
	xRemarkBridgeJsonResponse,
	xRemarkBridgeRequestDenied,
} from "#/lib/xremark-bridge-http";
import { isValidXRemarkPairingToken } from "#/lib/xremark-live";
import {
	acknowledgeXRemarkChanges,
	listPendingXRemarkChanges,
} from "#/lib/xremark";

const acknowledgementSchema = z.object({
	applied: z.array(z.number().int().nonnegative()).max(5000).default([]),
	conflicts: z.array(z.number().int().nonnegative()).max(5000).default([]),
});

const MAX_ACK_BYTES = 256 * 1024;

function authenticatedDb(request: Request) {
	const denied = xRemarkBridgeRequestDenied(request);
	if (denied) return { denied } as const;
	const token = xRemarkBearerToken(request);
	const db = getNativeDb({ seedDemoData: false });
	if (!token || !isValidXRemarkPairingToken(token, db)) {
		return {
			denied: xRemarkBridgeJsonResponse(
				{ ok: false, message: "Invalid X Remark pairing token." },
				{ status: 401 },
			),
		} as const;
	}
	return { db } as const;
}

export const Route = createFileRoute("/api/integrations/xremark/changes")({
	server: {
		handlers: {
			OPTIONS: ({ request }) => {
				const denied = xRemarkBridgeRequestDenied(request);
				if (denied) return denied;
				return new Response(null, {
					status: 204,
					headers: xRemarkBridgeCorsHeaders(),
				});
			},
			GET: ({ request }) => {
				const authenticated = authenticatedDb(request);
				if ("denied" in authenticated) return authenticated.denied;
				return xRemarkBridgeJsonResponse({
					ok: true,
					...listPendingXRemarkChanges(authenticated.db),
				});
			},
			POST: async ({ request }) => {
				const authenticated = authenticatedDb(request);
				if ("denied" in authenticated) return authenticated.denied;
				const contentLength = Number(
					request.headers.get("content-length") ?? 0,
				);
				if (contentLength > MAX_ACK_BYTES) {
					return xRemarkBridgeJsonResponse(
						{ ok: false, message: "X Remark acknowledgement is too large." },
						{ status: 413 },
					);
				}
				let input: unknown;
				try {
					input = await request.json();
				} catch {
					return xRemarkBridgeJsonResponse(
						{ ok: false, message: "Invalid X Remark acknowledgement." },
						{ status: 400 },
					);
				}
				const parsed = acknowledgementSchema.safeParse(input);
				if (!parsed.success) {
					return xRemarkBridgeJsonResponse(
						{ ok: false, message: "Invalid X Remark acknowledgement." },
						{ status: 400 },
					);
				}
				try {
					return xRemarkBridgeJsonResponse({
						ok: true,
						...acknowledgeXRemarkChanges(parsed.data, authenticated.db),
					});
				} catch (error) {
					return xRemarkBridgeJsonResponse(
						{
							ok: false,
							message:
								error instanceof Error
									? error.message
									: "X Remark acknowledgement failed.",
						},
						{ status: 409 },
					);
				}
			},
		},
	},
});
