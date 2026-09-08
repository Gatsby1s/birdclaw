import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { uploadFollowingSnapshot } from "../following-upload.mjs";
import { safeWorkerError } from "../following-runtime.mjs";

const config = {
	endpoint:
		"https://birdclaw-production.up.railway.app/api/integrations/twillot-history",
	token: "synthetic-token",
};
const users = [{ id: "1", username: "testuser", name: "Test User" }];

test("native upload preserves pairing headers and complete snapshot payload", async () => {
	let received;
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		received = {
			url: request.url,
			headers: request.headers,
			body: JSON.parse(body),
		};
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({ ok: true, result: { count: 1 } }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const endpoint = `http://127.0.0.1:${server.address().port}/api/integrations/twillot-history`;
		const result = await uploadFollowingSnapshot(
			{ ...config, endpoint },
			users,
			1,
		);
		assert.equal(result.ok, true);
		assert.equal(received.url, "/api/integrations/twillot-following");
		assert.equal(
			received.headers.origin,
			"chrome-extension://flkokionhgagpmnhlngldhbfnblmenen",
		);
		assert.equal(received.headers.authorization, "Bearer synthetic-token");
		assert.deepEqual(received.body, {
			action: "following_snapshot",
			users,
			pageCount: 1,
			complete: true,
		});
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("rejects unrelated destinations before exposing token", async () => {
	let called = false;
	await assert.rejects(
		uploadFollowingSnapshot(
			{
				...config,
				endpoint: "https://example.com/api/integrations/twillot-history",
			},
			users,
			1,
			{
				fetchImpl: () => {
					called = true;
				},
			},
		),
		{ code: "following_upload_rejected" },
	);
	assert.equal(called, false);
});

test("rejection and network failure expose only fixed diagnostic codes", async () => {
	const logs = [];
	await assert.rejects(
		uploadFollowingSnapshot(config, users, 1, {
			fetchImpl: async (_url, options) => {
				assert.equal(options.redirect, "error");
				assert.ok(options.signal);
				return new Response(
					JSON.stringify({ ok: false, message: "synthetic-token" }),
					{ status: 401 },
				);
			},
			log: (event, detail) => logs.push({ event, ...detail }),
		}),
		(error) => safeWorkerError(error) === "following_upload_rejected",
	);
	assert.deepEqual(logs, [{ event: "following_upload_rejected", status: 401 }]);
	await assert.rejects(
		uploadFollowingSnapshot(config, users, 1, {
			fetchImpl: async () => {
				throw Error("synthetic-token");
			},
		}),
		(error) => safeWorkerError(error) === "following_upload_failed",
	);
	await assert.rejects(
		uploadFollowingSnapshot(config, users, 1, {
			fetchImpl: async () => new Response("not-json"),
		}),
		{ code: "following_upload_rejected" },
	);
});
