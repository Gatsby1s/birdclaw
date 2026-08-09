import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	configDefaults,
	coverageConfigDefaults,
	defineConfig,
} from "vitest/config";

const configuredTestHome = process.env.BIRDCLAW_TEST_HOME?.trim();
const automaticTestHome = configuredTestHome
	? null
	: mkdtempSync(path.join(os.tmpdir(), "birdclaw-vitest-config-"));
const testHome = configuredTestHome ?? automaticTestHome;
if (!testHome) throw new Error("Vitest requires an isolated BirdClaw home");
if (automaticTestHome) {
	process.once("exit", () => {
		rmSync(automaticTestHome, { recursive: true, force: true });
	});
}

export default defineConfig({
	resolve: {
		tsconfigPaths: true,
	},
	test: {
		environment: "jsdom",
		env: {
			BIRDCLAW_HOME: testHome,
			BIRDCLAW_TEST_HOME: testHome,
		},
		setupFiles: ["./src/test/setup.ts"],
		include: ["src/**/*.test.{ts,tsx}"],
		exclude: [...configDefaults.exclude, "playwright/**/*"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary", "html"],
			include: ["src/**/*.{ts,tsx}"],
			exclude: [
				...coverageConfigDefaults.exclude,
				"src/routeTree.gen.ts",
				"src/styles.css",
				"src/lib/types.ts",
				"src/routes/network-map.tsx",
				"src/routes/api/data-sources.tsx",
				"src/routes/api/network-map.tsx",
			],
			thresholds: {
				lines: 85,
				functions: 85,
				branches: 80,
				statements: 85,
			},
		},
	},
});
