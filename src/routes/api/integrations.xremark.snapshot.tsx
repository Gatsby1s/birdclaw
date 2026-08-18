import { createFileRoute } from "@tanstack/react-router";
import { getNativeDb } from "#/lib/db";
import {
	xRemarkBearerToken,
	xRemarkBridgeCorsHeaders,
	xRemarkBridgeJsonResponse,
	xRemarkBridgeRequestDenied,
} from "#/lib/xremark-bridge-http";
import {
	applyXRemarkLiveSnapshot,
	isValidXRemarkPairingToken,
	XRemarkLiveSyncError,
	xRemarkLiveSnapshotSchema,
} from "#/lib/xremark-live";

const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;

async function readBoundedJson(request: Request) {
	if (!request.body) return { ok: false as const, reason: "invalid" as const };
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > MAX_SNAPSHOT_BYTES) {
				await reader.cancel();
				return { ok: false as const, reason: "too-large" as const };
			}
			chunks.push(value);
		}
	} catch {
		return { ok: false as const, reason: "invalid" as const };
	}

	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return {
			ok: true as const,
			value: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
		};
	} catch {
		return { ok: false as const, reason: "invalid" as const };
	}
}

export const Route = createFileRoute("/api/integrations/xremark/snapshot")({
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
			POST: async ({ request }) => {
				const denied = xRemarkBridgeRequestDenied(request);
				if (denied) return denied;
				const contentLength = Number(
					request.headers.get("content-length") ?? 0,
				);
				if (contentLength > MAX_SNAPSHOT_BYTES) {
					return xRemarkBridgeJsonResponse(
						{ ok: false, message: "X Remark snapshot is too large." },
						{ status: 413 },
					);
				}

				const token = xRemarkBearerToken(request);
				const db = getNativeDb({ seedDemoData: false });
				if (!token || !isValidXRemarkPairingToken(token, db)) {
					return xRemarkBridgeJsonResponse(
						{ ok: false, message: "Invalid X Remark pairing token." },
						{ status: 401 },
					);
				}

				const body = await readBoundedJson(request);
				if (!body.ok) {
					return xRemarkBridgeJsonResponse(
						{
							ok: false,
							message:
								body.reason === "too-large"
									? "X Remark snapshot is too large."
									: "Invalid X Remark snapshot JSON.",
						},
						{ status: body.reason === "too-large" ? 413 : 400 },
					);
				}
				const parsed = xRemarkLiveSnapshotSchema.safeParse(body.value);
				if (!parsed.success) {
					return xRemarkBridgeJsonResponse(
						{ ok: false, message: "Invalid X Remark snapshot payload." },
						{ status: 400 },
					);
				}

				try {
					return xRemarkBridgeJsonResponse({
						ok: true,
						...applyXRemarkLiveSnapshot(parsed.data, db),
					});
				} catch (error) {
					if (error instanceof XRemarkLiveSyncError) {
						return xRemarkBridgeJsonResponse(
							{ ok: false, message: error.message, code: error.code },
							{ status: 409 },
						);
					}
					throw error;
				}
			},
		},
	},
});
