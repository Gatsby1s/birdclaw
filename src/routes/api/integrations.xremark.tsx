import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
	xRemarkLiveSyncStatusSchema,
	xRemarkPairingResultSchema,
} from "#/lib/api-contracts";
import { jsonResponse, sensitiveRequestErrorResponse } from "#/lib/http-effect";
import {
	createXRemarkPairing,
	disconnectXRemarkLiveSync,
	getXRemarkLiveSyncStatus,
} from "#/lib/xremark-live";

const actionSchema = z.object({
	action: z.enum(["pair", "disconnect"]),
});

const MAX_ACTION_BYTES = 4_096;

async function readAction(request: Request) {
	if (!request.body) return null;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > MAX_ACTION_BYTES) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(byteLength);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		return null;
	}
}

export const Route = createFileRoute("/api/integrations/xremark")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return denied;
				return jsonResponse(
					xRemarkLiveSyncStatusSchema.parse(getXRemarkLiveSyncStatus()),
				);
			},
			POST: async ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return denied;
				const parsed = actionSchema.safeParse(await readAction(request));
				if (!parsed.success) {
					return jsonResponse(
						{ ok: false, message: "Unknown X Remark live sync action." },
						{ status: 400 },
					);
				}
				if (parsed.data.action === "disconnect") {
					return jsonResponse(
						xRemarkLiveSyncStatusSchema.parse(disconnectXRemarkLiveSync()),
					);
				}
				return jsonResponse(
					xRemarkPairingResultSchema.parse(createXRemarkPairing()),
				);
			},
		},
	},
});
