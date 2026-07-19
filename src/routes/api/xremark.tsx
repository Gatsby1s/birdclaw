import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { xRemarkSyncStatusSchema } from "#/lib/api-contracts";
import {
	jsonResponse,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import {
	getXRemarkSyncStatus,
	importXRemarkBackup,
	XRemarkImportError,
	xRemarkBackupSchema,
} from "#/lib/xremark";

const MAX_BACKUP_BYTES = 25 * 1024 * 1024;

type BoundedJsonResult =
	| { ok: true; value: unknown }
	| { ok: false; reason: "invalid" | "too-large" };

async function readBoundedJson(request: Request): Promise<BoundedJsonResult> {
	if (!request.body) return { ok: false, reason: "invalid" };
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > MAX_BACKUP_BYTES) {
				await reader.cancel();
				return { ok: false, reason: "too-large" };
			}
			chunks.push(value);
		}
	} catch {
		return { ok: false, reason: "invalid" };
	}

	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
	} catch {
		return { ok: false, reason: "invalid" };
	}
}

function backupTooLargeResponse() {
	return jsonResponse(
		{
			ok: false,
			message:
				"X Remark backup is too large. Export Remarks, Tags, and Categories only.",
		},
		{ status: 413 },
	);
}

export const Route = createFileRoute("/api/xremark")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return denied;

				const url = new URL(request.url);
				const handle = url.searchParams.get("handle")?.trim();
				const identifier = url.searchParams.get("identifier")?.trim();
				return jsonResponse(
					xRemarkSyncStatusSchema.parse(
						getXRemarkSyncStatus({
							...(handle ? { handle: handle.slice(0, 100) } : {}),
							...(identifier ? { identifier: identifier.slice(0, 128) } : {}),
						}),
					),
				);
			},
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const contentLength = Number(
							request.headers.get("content-length") ?? 0,
						);
						if (contentLength > MAX_BACKUP_BYTES) {
							return backupTooLargeResponse();
						}

						const input = yield* Effect.promise(() => readBoundedJson(request));
						if (!input.ok) {
							return input.reason === "too-large"
								? backupTooLargeResponse()
								: jsonResponse(
										{ ok: false, message: "This is not valid JSON." },
										{ status: 400 },
									);
						}
						const parsed = xRemarkBackupSchema.safeParse(input.value);
						if (!parsed.success) {
							return jsonResponse(
								{
									ok: false,
									message:
										"Choose an X Remark JSON backup that includes Remarks, Tags, and Categories.",
								},
								{ status: 400 },
							);
						}

						try {
							return jsonResponse(
								xRemarkSyncStatusSchema.parse(importXRemarkBackup(parsed.data)),
							);
						} catch (error) {
							if (error instanceof XRemarkImportError) {
								return jsonResponse(
									{ ok: false, message: error.message },
									{ status: 409 },
								);
							}
							throw error;
						}
					}),
				),
		},
	},
});
