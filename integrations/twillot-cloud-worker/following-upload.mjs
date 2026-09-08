import { FollowingSyncError } from "./following-runtime.mjs";
import { followingEndpoint } from "./worker-core.mjs";

const EXTENSION_ORIGIN = "chrome-extension://flkokionhgagpmnhlngldhbfnblmenen";
const CLOUD_ORIGIN = "https://birdclaw-production.up.railway.app";

export async function uploadFollowingSnapshot(
	config,
	users,
	pageCount,
	{ fetchImpl = fetch, timeoutMs = 30_000, signal, log = () => {} } = {},
) {
	const url = new URL(followingEndpoint(config.endpoint));
	const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
		url.hostname,
	);
	if (
		url.username ||
		url.password ||
		(url.origin !== CLOUD_ORIGIN && !loopback)
	)
		throw new FollowingSyncError("following_upload_rejected");
	try {
		// The cloud process owns this token and snapshot. Keep transfer independent
		// of extension-page lifetime while preserving the server's pairing gate.
		const response = await fetchImpl(url, {
			method: "POST",
			redirect: "error",
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
				: AbortSignal.timeout(timeoutMs),
			headers: {
				Origin: EXTENSION_ORIGIN,
				Accept: "application/json",
				Authorization: `Bearer ${config.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				action: "following_snapshot",
				users,
				pageCount,
				complete: true,
			}),
		});
		const data = await response.json().catch(() => null);
		if (!response.ok || data?.ok !== true) {
			log("following_upload_rejected", { status: response.status });
			throw new FollowingSyncError("following_upload_rejected");
		}
		log("following_uploaded", { count: users.length, pageCount });
		return data;
	} catch (error) {
		if (error instanceof FollowingSyncError) throw error;
		throw new FollowingSyncError("following_upload_failed");
	}
}
