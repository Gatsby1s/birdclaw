import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getNativeDb } from "#/lib/db";
import { importTwillotFollowingSnapshot } from "#/lib/follow-graph";
import { jsonResponse } from "#/lib/http-effect";
import { isValidTwillotCompanionToken } from "#/lib/twillot-companion";

export const TWILLOT_FOLLOWING_EXTENSION_ID =
	"flkokionhgagpmnhlngldhbfnblmenen";
export const TWILLOT_FOLLOWING_EXTENSION_ORIGIN = `chrome-extension://${TWILLOT_FOLLOWING_EXTENSION_ID}`;
export const TWILLOT_FOLLOWING_CLOUD_ORIGIN =
	"https://birdclaw-production.up.railway.app";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const userSchema = z.strictObject({
	id: z.union([z.string(), z.number()]),
	username: z.string().trim().min(1).max(128),
	name: z.string().trim().min(1).max(512),
	description: z.string().max(10_000).optional(),
	profileImageUrl: z.string().url().max(4_096).optional(),
});

const snapshotSchema = z.strictObject({
	action: z.literal("following_snapshot"),
	users: z.array(userSchema).min(1).max(5_000),
	pageCount: z.number().int().positive().max(1_000),
	complete: z.literal(true),
});

function corsHeaders() {
	return {
		"access-control-allow-origin": TWILLOT_FOLLOWING_EXTENSION_ORIGIN,
		"access-control-allow-methods": "POST, OPTIONS",
		"access-control-allow-headers": "authorization, content-type",
		"access-control-max-age": "600",
		vary: "Origin",
	};
}

function response(data: unknown, init?: ResponseInit) {
	return jsonResponse(data, {
		...init,
		headers: { ...corsHeaders(), ...init?.headers },
	});
}

function requestDenied(request: Request) {
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
	const cloudHost = new URL(TWILLOT_FOLLOWING_CLOUD_ORIGIN).hostname;
	const isCloud =
		url.origin === TWILLOT_FOLLOWING_CLOUD_ORIGIN ||
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
			{ ok: false, message: "Untrusted Twillot following endpoint." },
			{ status: 403 },
		);
	}
	if (request.headers.get("origin") !== TWILLOT_FOLLOWING_EXTENSION_ORIGIN) {
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
			if (byteLength > MAX_BODY_BYTES) {
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

export const Route = createFileRoute("/api/integrations/twillot-following")({
	server: {
		handlers: {
			OPTIONS: ({ request }) => {
				const denied = requestDenied(request);
				if (denied) return denied;
				return new Response(null, { status: 204, headers: corsHeaders() });
			},
			POST: async ({ request }) => {
				const denied = requestDenied(request);
				if (denied) return denied;
				const db = getNativeDb({ seedDemoData: false });
				const token = bearerToken(request);
				if (!token || !isValidTwillotCompanionToken(token, db)) {
					return response(
						{ ok: false, message: "Invalid Twillot pairing token." },
						{ status: 401 },
					);
				}
				const body = await readBoundedJson(request);
				if (!body.ok) {
					return response(
						{
							ok: false,
							message: body.tooLarge
								? "Twillot following snapshot is too large."
								: "Invalid Twillot following JSON.",
						},
						{ status: body.tooLarge ? 413 : 400 },
					);
				}
				const parsed = snapshotSchema.safeParse(body.value);
				if (!parsed.success) {
					return response(
						{ ok: false, message: "Invalid Twillot following snapshot." },
						{ status: 400 },
					);
				}
				const users = parsed.data.users.map((user) => ({
					id: String(user.id),
					username: user.username.replace(/^@/, ""),
					name: user.name,
					...(user.description ? { description: user.description } : {}),
					...(user.profileImageUrl
						? { profile_image_url: user.profileImageUrl }
						: {}),
				}));
				try {
					const result = importTwillotFollowingSnapshot(db, {
						users,
						pageCount: parsed.data.pageCount,
						complete: true,
					});
					return response({ ok: true, result });
				} catch (error) {
					return response(
						{
							ok: false,
							message: error instanceof Error ? error.message : String(error),
						},
						{ status: 409 },
					);
				}
			},
		},
	},
});
