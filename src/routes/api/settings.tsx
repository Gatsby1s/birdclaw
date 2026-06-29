import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
	birdclawSettingsSchema,
	updateBirdclawSettingsSchema,
} from "#/lib/api-contracts";
import {
	jsonResponse,
	requestJsonEffect,
	runRouteEffect,
	sensitiveRequestErrorResponse,
} from "#/lib/http-effect";
import { getBirdclawSettings, updateBirdclawSettings } from "#/lib/settings";

export const Route = createFileRoute("/api/settings")({
	server: {
		handlers: {
			GET: ({ request }) => {
				const denied = sensitiveRequestErrorResponse(request);
				if (denied) return denied;

				return jsonResponse(
					birdclawSettingsSchema.parse(getBirdclawSettings()),
				);
			},
			POST: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const denied = sensitiveRequestErrorResponse(request);
						if (denied) return denied;

						const input = yield* requestJsonEffect<unknown>(request);
						const parsed = updateBirdclawSettingsSchema.safeParse(input);
						if (!parsed.success) {
							return jsonResponse(
								{ ok: false, message: "Unknown settings payload" },
								{ status: 400 },
							);
						}

						return jsonResponse(
							birdclawSettingsSchema.parse(updateBirdclawSettings(parsed.data)),
						);
					}),
				),
		},
	},
});
