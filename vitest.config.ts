import {
	configDefaults,
	coverageConfigDefaults,
	defineConfig,
} from "vitest/config";

export default defineConfig({
	resolve: {
		tsconfigPaths: true,
	},
	test: {
		environment: "jsdom",
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
