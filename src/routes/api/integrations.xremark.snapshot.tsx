import { createFileRoute } from "@tanstack/react-router";
import { getNativeDb } from "#/lib/db";
import { jsonResponse } from "#/lib/http-effect";
import {
	applyXRemarkLiveSnapshot,
	isValidXRemarkPairingToken,
	XREMARK_EXTENSION_ORIGIN,
	XRemarkLiveSyncError,
	xRemarkLiveSnapshotSchema,
} from "#/lib/xremark-live";

const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;

function corsHeaders() {
	return {
		"access-control-allow-origin": XREMARK_EXTENSION_ORIGIN,
		"access-control-allow-methods": "POST, OPTIONS",
		"access-control-allow-headers": "authorization, content-type",
		"access-control-max-age": "600",
		vary: "Origin",
	};
}

function jsonBridgeResponse(data: unknown, init?: ResponseInit) {
	return jsonResponse(data, {
		...init,
		headers: { ...corsHeaders(), ...init?.headers },
	});
}

function bridgeRequestDenied(request: Request) {
	const url = new URL(request.url);
	if (url.hostname !== "127.0.0.1") {
		return jsonResponse(
			{ ok: false, message: "X Remark live sync is loopback-only." },
			{ status: 403 },
		);
	}
	if (
		request.headers.has("forwarded") ||
		request.headers.has("x-forwarded-for") ||
		request.headers.has("x-forwarded-host") ||
		request.headers.has("x-forwarded-proto") ||
		request.headers.has("x-real-ip")
	) {
		return jsonResponse(
			{ ok: false, message: "Forwarded X Remark sync requests are disabled." },
			{ status: 403 },
		);
	}
	if (request.headers.get("origin") !== XREMARK_EXTENSION_ORIGIN) {
		return jsonResponse(
			{ ok: false, message: "Untrusted X Remark extension origin." },
			{ status: 403 },
		);
	}
	return null;
}

function bearerToken(request: Request) {
	const authorization = request.headers.get("authorization") ?? "";
	const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{40,128})$/);
	return match?.[1] ?? null;
}

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
				const denied = bridgeRequestDenied(request);
				if (denied) return denied;
				return new Response(null, { status: 204, headers: corsHeaders() });
			},
			POST: async ({ request }) => {
				const denied = bridgeRequestDenied(request);
				if (denied) return denied;
				const contentLength = Number(
					request.headers.get("content-length") ?? 0,
				);
				if (contentLength > MAX_SNAPSHOT_BYTES) {
					return jsonBridgeResponse(
						{ ok: false, message: "X Remark snapshot is too large." },
						{ status: 413 },
					);
				}

				const token = bearerToken(request);
				const db = getNativeDb({ seedDemoData: false });
				if (!token || !isValidXRemarkPairingToken(token, db)) {
					return jsonBridgeResponse(
						{ ok: false, message: "Invalid X Remark pairing token." },
						{ status: 401 },
					);
				}

				const body = await readBoundedJson(request);
				if (!body.ok) {
					return jsonBridgeResponse(
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
					return jsonBridgeResponse(
						{ ok: false, message: "Invalid X Remark snapshot payload." },
						{ status: 400 },
					);
				}

				try {
					return jsonBridgeResponse({
						ok: true,
						...applyXRemarkLiveSnapshot(parsed.data, db),
					});
				} catch (error) {
					if (error instanceof XRemarkLiveSyncError) {
						return jsonBridgeResponse(
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
