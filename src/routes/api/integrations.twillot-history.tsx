import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
	applyTwillotCompanionSubmission,
	claimTwillotCompanionJob,
	isValidTwillotCompanionToken,
	TwillotCompanionError,
	twillotCompanionSubmissionSchema,
} from "#/lib/twillot-companion";
import { getNativeDb } from "#/lib/db";
import { jsonResponse } from "#/lib/http-effect";
import { TwillotHistoryQueueError } from "#/lib/twillot-history-queue";

export const TWILLOT_EXTENSION_ID = "flkokionhgagpmnhlngldhbfnblmenen";
export const TWILLOT_EXTENSION_ORIGIN = `chrome-extension://${TWILLOT_EXTENSION_ID}`;
export const TWILLOT_CLOUD_ORIGIN =
	"https://birdclaw-production.up.railway.app";
const MAX_BATCH_BYTES = 16 * 1024 * 1024;

function corsHeaders() {
	return {
		"access-control-allow-origin": TWILLOT_EXTENSION_ORIGIN,
		"access-control-allow-methods": "GET, POST, OPTIONS",
		"access-control-allow-headers": "authorization, content-type",
		"access-control-max-age": "600",
		vary: "Origin",
	};
}

function bridgeResponse(data: unknown, init?: ResponseInit) {
	return jsonResponse(data, {
		...init,
		headers: { ...corsHeaders(), ...init?.headers },
	});
}

function bridgeRequestDenied(request: Request) {
	const url = new URL(request.url);
	const isLoopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
		url.hostname,
	);
	const forwardedHost = request.headers
		.get("x-forwarded-host")
		?.split(",")[0]
		?.trim()
		.toLowerCase();
	const forwardedProto = request.headers
		.get("x-forwarded-proto")
		?.split(",")[0]
		?.trim()
		.toLowerCase();
	const cloudHost = new URL(TWILLOT_CLOUD_ORIGIN).hostname;
	const isCloud =
		url.origin === TWILLOT_CLOUD_ORIGIN ||
		(forwardedHost === cloudHost && forwardedProto === "https");
	const hasForwardingHeaders = [
		"forwarded",
		"x-forwarded-for",
		"x-forwarded-host",
		"x-forwarded-proto",
		"x-real-ip",
	].some((header) => request.headers.has(header));
	if (
		(!isLoopback && !isCloud) ||
		(isLoopback && hasForwardingHeaders && !isCloud)
	) {
		return jsonResponse(
			{ ok: false, message: "Untrusted Twillot companion endpoint." },
			{ status: 403 },
		);
	}
	if (request.headers.get("origin") !== TWILLOT_EXTENSION_ORIGIN) {
		return jsonResponse(
			{ ok: false, message: "Untrusted Twillot extension origin." },
			{ status: 403 },
		);
	}
	return null;
}

function bearerToken(request: Request) {
	const authorization = request.headers.get("authorization") ?? "";
	return authorization.match(/^Bearer ([A-Za-z0-9_-]{40,128})$/)?.[1] ?? null;
}

async function readBoundedJson(request: Request) {
	if (!request.body) return { ok: false as const, tooLarge: false };
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > MAX_BATCH_BYTES) {
				await reader.cancel();
				return { ok: false as const, tooLarge: true };
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(byteLength);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return {
			ok: true as const,
			value: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
		};
	} catch {
		return { ok: false as const, tooLarge: false };
	}
}

function errorStatus(error: unknown) {
	if (error instanceof TwillotCompanionError) return 409;
	if (error instanceof TwillotHistoryQueueError) {
		return error.code === "STALE_LEASE" ? 409 : 400;
	}
	if (error instanceof z.ZodError) return 400;
	return 500;
}

function errorCode(error: unknown) {
	if (error instanceof TwillotCompanionError) return error.code;
	if (error instanceof TwillotHistoryQueueError) return error.code;
	if (error instanceof z.ZodError) return "INVALID_PAYLOAD";
	return "INTERNAL_ERROR";
}

export const Route = createFileRoute("/api/integrations/twillot-history")({
	server: {
		handlers: {
			OPTIONS: ({ request }) => {
				const denied = bridgeRequestDenied(request);
				if (denied) return denied;
				return new Response(null, { status: 204, headers: corsHeaders() });
			},
			GET: ({ request }) => {
				const denied = bridgeRequestDenied(request);
				if (denied) return denied;
				const db = getNativeDb({ seedDemoData: false });
				const token = bearerToken(request);
				if (!token || !isValidTwillotCompanionToken(token, db)) {
					return bridgeResponse(
						{ ok: false, message: "Invalid Twillot pairing token." },
						{ status: 401 },
					);
				}
				const url = new URL(request.url);
				const parsed = z
					.object({
						sourceId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
						requestedCap: z.coerce
							.number()
							.int()
							.positive()
							.max(500)
							.default(500),
					})
					.safeParse({
						sourceId: url.searchParams.get("sourceId"),
						requestedCap: url.searchParams.get("requestedCap") ?? 500,
					});
				if (!parsed.success) {
					return bridgeResponse(
						{ ok: false, message: "Invalid Twillot claim request." },
						{ status: 400 },
					);
				}
				try {
					return bridgeResponse({
						ok: true,
						job: claimTwillotCompanionJob(db, parsed.data),
					});
				} catch (error) {
					return bridgeResponse(
						{
							ok: false,
							message: error instanceof Error ? error.message : String(error),
							code: errorCode(error),
						},
						{ status: errorStatus(error) },
					);
				}
			},
			POST: async ({ request }) => {
				const denied = bridgeRequestDenied(request);
				if (denied) return denied;
				const contentLength = Number(
					request.headers.get("content-length") ?? 0,
				);
				if (contentLength > MAX_BATCH_BYTES) {
					return bridgeResponse(
						{ ok: false, message: "Twillot batch is too large." },
						{ status: 413 },
					);
				}
				const db = getNativeDb({ seedDemoData: false });
				const token = bearerToken(request);
				if (!token || !isValidTwillotCompanionToken(token, db)) {
					return bridgeResponse(
						{ ok: false, message: "Invalid Twillot pairing token." },
						{ status: 401 },
					);
				}
				const body = await readBoundedJson(request);
				if (!body.ok) {
					return bridgeResponse(
						{
							ok: false,
							message: body.tooLarge
								? "Twillot batch is too large."
								: "Invalid Twillot batch JSON.",
						},
						{ status: body.tooLarge ? 413 : 400 },
					);
				}
				const parsed = twillotCompanionSubmissionSchema.safeParse(body.value);
				if (!parsed.success) {
					return bridgeResponse(
						{ ok: false, message: "Invalid Twillot companion payload." },
						{ status: 400 },
					);
				}
				try {
					return bridgeResponse(
						applyTwillotCompanionSubmission(db, parsed.data),
					);
				} catch (error) {
					return bridgeResponse(
						{
							ok: false,
							message: error instanceof Error ? error.message : String(error),
							code: errorCode(error),
						},
						{ status: errorStatus(error) },
					);
				}
			},
		},
	},
});
