// @vitest-environment node
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ensureBirdclawDirs,
	getBirdCommand,
	getBirdclawConfig,
	getBirdclawPaths,
	getTwitter6551Config,
	resetBirdclawPathsForTests,
	resolveActionsTransport,
	resolveMentionsDataSource,
	resolveProfileAnalysisSource,
	setActionsTransport,
	setProfileAnalysisSource,
} from "./config";

const tempRoots: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
	resetBirdclawPathsForTests();
	process.env.PATH = originalPath;
	delete process.env.BIRDCLAW_HOME;
	delete process.env.BIRDCLAW_CONFIG;
	delete process.env.BIRDCLAW_ACTIONS_TRANSPORT;
	delete process.env.BIRDCLAW_BIRD_COMMAND;
	delete process.env.BIRDCLAW_MENTIONS_DATA_SOURCE;
	delete process.env.BIRDCLAW_PROFILE_ANALYSIS_SOURCE;
	delete process.env.BIRDCLAW_6551_TOKEN;
	delete process.env.TWITTER_TOKEN;

	for (const tempRoot of tempRoots.splice(0)) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

describe("config", () => {
	it("uses BIRDCLAW_HOME when set", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		process.env.BIRDCLAW_HOME = tempRoot;

		const paths = getBirdclawPaths();

		expect(paths.rootDir).toBe(tempRoot);
		expect(paths.dbPath).toBe(path.join(tempRoot, "birdclaw.sqlite"));
		expect(paths.configPath).toBe(path.join(tempRoot, "config.json"));
	});

	it("creates expected media directories", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		process.env.BIRDCLAW_HOME = path.join(tempRoot, "custom-home");

		const paths = ensureBirdclawDirs();

		expect(paths.mediaOriginalsDir).toContain(path.join("media", "originals"));
		expect(paths.mediaThumbsDir).toContain(path.join("media", "thumbs"));
	});

	it("reads config from the homedir root", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		process.env.BIRDCLAW_HOME = tempRoot;
		writeFileSync(
			path.join(tempRoot, "config.json"),
			JSON.stringify({
				actions: {
					transport: "xurl",
				},
				mentions: {
					dataSource: "bird",
					birdCommand: "/tmp/custom-bird",
				},
			}),
		);

		expect(getBirdclawConfig()).toEqual({
			actions: {
				transport: "xurl",
			},
			mentions: {
				dataSource: "bird",
				birdCommand: "/tmp/custom-bird",
			},
		});
		expect(resolveMentionsDataSource()).toBe("bird");
		expect(resolveActionsTransport()).toBe("xurl");
		expect(getBirdCommand()).toBe("/tmp/custom-bird");
	});

	it("resolves bird from PATH before using the shell fallback", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		const birdPath = path.join(tempRoot, "bird");
		writeFileSync(birdPath, "#!/bin/sh\n");
		chmodSync(birdPath, 0o755);
		process.env.BIRDCLAW_HOME = tempRoot;
		process.env.PATH = tempRoot;

		expect(getBirdCommand()).toBe(birdPath);
	});

	it("lets env override config for the datasource", () => {
		process.env.BIRDCLAW_MENTIONS_DATA_SOURCE = "xurl";
		process.env.BIRDCLAW_ACTIONS_TRANSPORT = "bird";
		process.env.BIRDCLAW_BIRD_COMMAND = "/tmp/env-bird";

		expect(resolveMentionsDataSource()).toBe("xurl");
		expect(resolveActionsTransport()).toBe("bird");
		expect(getBirdCommand()).toBe("/tmp/env-bird");
	});

	it("sets actions transport in the active config file", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		process.env.BIRDCLAW_HOME = tempRoot;
		writeFileSync(
			path.join(tempRoot, "config.json"),
			JSON.stringify({
				mentions: {
					dataSource: "bird",
				},
			}),
		);

		expect(setActionsTransport("xurl")).toEqual({
			configPath: path.join(tempRoot, "config.json"),
			transport: "xurl",
		});
		expect(getBirdclawConfig()).toEqual({
			actions: {
				transport: "xurl",
			},
			mentions: {
				dataSource: "bird",
			},
		});
		expect(resolveActionsTransport()).toBe("xurl");
	});

	it("resolves profile analysis source from config and env", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		process.env.BIRDCLAW_HOME = tempRoot;
		writeFileSync(
			path.join(tempRoot, "config.json"),
			JSON.stringify({
				analysis: {
					profileSource: "xurl",
				},
			}),
		);

		expect(resolveProfileAnalysisSource()).toBe("xurl");
		process.env.BIRDCLAW_PROFILE_ANALYSIS_SOURCE = "6551";
		expect(resolveProfileAnalysisSource()).toBe("6551");
		expect(resolveProfileAnalysisSource("local")).toBe("local");
	});

	it("sets profile analysis source in the active config file", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		process.env.BIRDCLAW_HOME = tempRoot;

		expect(setProfileAnalysisSource("local")).toEqual({
			configPath: path.join(tempRoot, "config.json"),
			source: "local",
		});
		expect(getBirdclawConfig()).toEqual({
			analysis: {
				profileSource: "local",
			},
		});
		expect(resolveProfileAnalysisSource()).toBe("local");
	});

	it("preserves config fields written after the in-process cache was loaded", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		process.env.BIRDCLAW_HOME = tempRoot;
		const configPath = path.join(tempRoot, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				actions: {
					transport: "xurl",
				},
			}),
		);
		expect(getBirdclawConfig()).toEqual({
			actions: {
				transport: "xurl",
			},
		});
		writeFileSync(
			configPath,
			JSON.stringify({
				actions: {
					transport: "xurl",
				},
				providers: {
					twitter6551: {
						baseUrl: "https://example.test",
						tokenEnv: "BIRDCLAW_6551_TOKEN",
					},
				},
			}),
		);

		setProfileAnalysisSource("local");

		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			actions: {
				transport: "xurl",
			},
			analysis: {
				profileSource: "local",
			},
			providers: {
				twitter6551: {
					baseUrl: "https://example.test",
					tokenEnv: "BIRDCLAW_6551_TOKEN",
				},
			},
		});
	});

	it("detects the configured 6551 token env without storing token values", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		process.env.BIRDCLAW_HOME = tempRoot;
		process.env.BIRDCLAW_CONFIG = path.join(tempRoot, "custom-config.json");
		process.env.BIRDCLAW_6551_TOKEN = "secret";
		writeFileSync(
			process.env.BIRDCLAW_CONFIG,
			JSON.stringify({
				providers: {
					twitter6551: {
						baseUrl: "https://example.test",
						tokenEnv: "BIRDCLAW_6551_TOKEN",
					},
				},
			}),
		);

		expect(getTwitter6551Config()).toEqual({
			baseUrl: "https://example.test",
			tokenEnv: "BIRDCLAW_6551_TOKEN",
			tokenDetected: true,
		});
		delete process.env.BIRDCLAW_6551_TOKEN;
	});

	it("defaults bird command to PATH lookup", () => {
		const tempRoot = mkdtempSync(path.join(os.tmpdir(), "birdclaw-config-"));
		tempRoots.push(tempRoot);
		process.env.BIRDCLAW_HOME = tempRoot;
		process.env.PATH = "";

		expect(getBirdCommand()).toBe("bird");
	});
});
