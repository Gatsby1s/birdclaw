// @vitest-environment node
import { readFileSync } from "node:fs";
import { configDefaults, coverageConfigDefaults } from "vitest/config";
import { describe, expect, it } from "vitest";
import vitestConfig from "../vitest.config";

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
	version: string;
	bin: Record<string, string>;
	scripts: Record<string, string>;
	files: string[];
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
};

function resolvedVitestConfig() {
	return vitestConfig;
}

describe("package configuration", () => {
	it("launches the compiled CLI without source or tsx", () => {
		const launcher = readFileSync(
			new URL("../bin/birdclaw.mjs", import.meta.url),
			"utf8",
		);
		expect(launcher).toContain("../dist/cli/birdclaw.js");
		expect(launcher).not.toContain("tsx");
		expect(launcher).not.toContain("src/cli");
		expect(packageJson.dependencies).not.toHaveProperty("tsx");
	});

	it("keeps published bin files in lint and format script coverage", () => {
		const binTargets = Object.values(packageJson.bin);
		for (const scriptName of ["lint", "format", "format:check"]) {
			const script = packageJson.scripts[scriptName];
			for (const binTarget of binTargets) {
				expect(binTarget).toMatch(/^bin\//);
				expect(script).toMatch(/\bbin\b/);
			}
		}
	});

	it("uses the Node vitest wrapper directly for portable test scripts", () => {
		expect(packageJson.scripts.test).toBe("node ./scripts/run-vitest.mjs run");
		expect(packageJson.scripts.coverage).toBe(
			"node ./scripts/run-vitest.mjs run --coverage",
		);
	});

	it("marks source dev server as local-only for token-free loopback APIs", () => {
		expect(packageJson.scripts.dev).toContain("BIRDCLAW_LOCAL_WEB=1");
		expect(packageJson.scripts.dev).toContain("--host 127.0.0.1");
	});

	it("publishes only compiled runtime trees", () => {
		expect(packageJson.files).toEqual(
			expect.arrayContaining([
				"bin/",
				"dist/cli/",
				"dist/client/",
				"dist/server/",
			]),
		);
		expect(packageJson.files).not.toContain("src/");
		expect(packageJson.files).not.toContain("scripts/");
		expect(packageJson.devDependencies).toHaveProperty("tsx");
		expect(packageJson.devDependencies).toHaveProperty("vite");
		expect(packageJson.dependencies).not.toHaveProperty("vite");
	});

	it("preserves Vitest default excludes while adding project excludes", () => {
		const config = resolvedVitestConfig();
		expect(config.test?.exclude).toEqual([
			...configDefaults.exclude,
			"playwright/**/*",
		]);
		expect(config.test?.coverage?.exclude).toEqual([
			...coverageConfigDefaults.exclude,
			"src/routeTree.gen.ts",
			"src/styles.css",
			"src/lib/types.ts",
			"src/routes/network-map.tsx",
			"src/routes/api/data-sources.tsx",
			"src/routes/api/network-map.tsx",
		]);
	});
});
