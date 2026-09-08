import assert from "node:assert/strict";
import test from "node:test";
import { extractCrxZip } from "../prepare-extension.mjs";
import { parseSessionBootstrap } from "../session-bootstrap.mjs";
import {
	createBrowserShutdown,
	followingEndpoint,
	normalizeEndpoint,
} from "../worker-core.mjs";

test("normalizes only the dedicated secure BirdClaw history endpoint", () => {
	assert.equal(
		normalizeEndpoint(
			"https://birdclaw-production.up.railway.app/api/integrations/twillot-history?x=1",
		),
		"https://birdclaw-production.up.railway.app/api/integrations/twillot-history",
	);
	assert.equal(
		followingEndpoint(
			"https://birdclaw-production.up.railway.app/api/integrations/twillot-history",
		),
		"https://birdclaw-production.up.railway.app/api/integrations/twillot-following",
	);
	assert.throws(
		() =>
			normalizeEndpoint("http://example.com/api/integrations/twillot-history"),
		/HTTPS/,
	);
	assert.throws(
		() => normalizeEndpoint("https://example.com/api/other"),
		/unexpected path/,
	);
});

test("extracts a bounded CRX3 ZIP payload", () => {
	const zip = Buffer.from("504b0304aabb", "hex");
	const crx = Buffer.alloc(13 + zip.length);
	crx.write("Cr24", 0, "ascii");
	crx.writeUInt32LE(3, 4);
	crx.writeUInt32LE(1, 8);
	crx[12] = 0;
	zip.copy(crx, 13);
	assert.deepEqual(extractCrxZip(crx), zip);
	assert.throws(() => extractCrxZip(Buffer.from("bad")), /not a CRX/);
});

test("accepts only an allowlisted X and Twillot session bootstrap", () => {
	const encoded = Buffer.from(
		JSON.stringify({
			version: 1,
			cookies: [
				{
					name: "auth_token",
					value: "opaque",
					domain: ".x.com",
					path: "/",
					httpOnly: true,
					secure: true,
					sameSite: "None",
				},
			],
			origins: [
				{
					origin: "https://www.twillot.com",
					localStorage: [{ name: "session", value: "opaque" }],
				},
			],
		}),
	).toString("base64");
	assert.deepEqual(parseSessionBootstrap(encoded), {
		version: 1,
		cookies: [
			{
				name: "auth_token",
				value: "opaque",
				domain: ".x.com",
				path: "/",
				httpOnly: true,
				secure: true,
				sameSite: "None",
			},
		],
		origins: [
			{
				origin: "https://www.twillot.com",
				localStorage: [{ name: "session", value: "opaque" }],
			},
		],
	});
	const bad = Buffer.from(
		JSON.stringify({
			version: 1,
			cookies: [
				{ name: "sid", value: "nope", domain: ".example.com", path: "/" },
			],
		}),
	).toString("base64");
	assert.throws(() => parseSessionBootstrap(bad), /invalid cookie/);
});

test("shutdown closes the browser immediately to interrupt a blocked collection", async () => {
	let releaseBlockedCall;
	const blockedCall = new Promise((resolve) => {
		releaseBlockedCall = resolve;
	});
	let closes = 0;
	const shutdown = createBrowserShutdown({
		close: async () => {
			closes += 1;
			releaseBlockedCall("browser closed");
		},
	});
	assert.equal(shutdown.stopping, false);
	shutdown.stop();
	assert.equal(shutdown.stopping, true);
	assert.equal(closes, 1);
	assert.equal(await blockedCall, "browser closed");
	shutdown.stop();
	await shutdown.close();
	assert.equal(closes, 1);
});

test("shutdown and final cleanup share a single rejection-safe close operation", async () => {
	let closes = 0;
	const shutdown = createBrowserShutdown({
		close: async () => {
			closes += 1;
			throw new Error("already closed");
		},
	});
	shutdown.stop();
	const first = shutdown.close();
	assert.equal(shutdown.close(), first);
	await first;
	assert.equal(closes, 1);
});
