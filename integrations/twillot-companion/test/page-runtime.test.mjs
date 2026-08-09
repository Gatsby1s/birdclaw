import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = await readFile(
	path.join(HERE, "..", "birdclaw-twillot-page.js"),
	"utf8",
);

test("page companion is prompt-only and cannot read Twillot or X storage", () => {
	assert.equal(SOURCE.includes("indexedDB"), false);
	assert.equal(SOURCE.includes("chrome.storage"), false);
	assert.equal(SOURCE.includes("document.cookie"), false);
	assert.equal(SOURCE.includes("x.com/i/api"), false);
	assert.match(SOURCE, /Please click Start in Twillot/);
	assert.match(SOURCE, /caught_up_unverified/);
});

test("page companion never automates a Twillot start control", () => {
	assert.equal(SOURCE.includes(".click("), false);
	assert.equal(SOURCE.includes("dispatchEvent"), false);
	assert.equal(SOURCE.includes("WebPageMessage"), false);
});
