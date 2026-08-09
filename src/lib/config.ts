import {
	accessSync,
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export interface BirdclawPaths {
	rootDir: string;
	dbPath: string;
	mediaOriginalsDir: string;
	mediaThumbsDir: string;
	configPath: string;
}

export type MentionsDataSource = "birdclaw" | "auto" | "xurl" | "bird";
export type ActionsTransport = "auto" | "bird" | "xurl";
export type ProfileAnalysisSource = "local" | "xurl" | "6551";
export type SummaryModelProvider = "openai" | "deepseek";

export const DEFAULT_OPENAI_SUMMARY_MODEL = "gpt-5.5";
export const DEFAULT_DEEPSEEK_SUMMARY_MODEL = "deepseek-v4-flash";
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export interface BirdclawConfig {
	mentions?: {
		dataSource?: MentionsDataSource;
		birdCommand?: string;
	};
	actions?: {
		transport?: ActionsTransport;
	};
	analysis?: {
		profileSource?: ProfileAnalysisSource;
		summaryModels?: {
			primary?: SummaryModelProvider;
			backup?: SummaryModelProvider;
		};
	};
	providers?: {
		openai?: {
			model?: string;
		};
		deepseek?: {
			baseUrl?: string;
			model?: string;
			apiKey?: string;
		};
		twitter6551?: {
			baseUrl?: string;
			tokenEnv?: string;
			accountId?: string;
			watchUsers?: string[];
			targetTweetIds?: string[];
			backfillMinutes?: number;
		};
	};
	backup?: {
		repoPath?: string;
		remote?: string;
		autoSync?: boolean;
		staleAfterSeconds?: number;
	};
}

let cachedPaths: BirdclawPaths | undefined;
let cachedConfig: BirdclawConfig | undefined;

export function getBirdclawPaths(): BirdclawPaths {
	if (cachedPaths) {
		return cachedPaths;
	}

	const testHome =
		process.env.NODE_ENV === "test" || process.env.VITEST === "true"
			? process.env.BIRDCLAW_TEST_HOME?.trim()
			: undefined;
	const rootDir =
		process.env.BIRDCLAW_HOME?.trim() ||
		testHome ||
		path.join(os.homedir(), ".birdclaw");

	cachedPaths = {
		rootDir,
		dbPath: path.join(rootDir, "birdclaw.sqlite"),
		mediaOriginalsDir: path.join(rootDir, "media", "originals"),
		mediaThumbsDir: path.join(rootDir, "media", "thumbs"),
		configPath: path.join(rootDir, "config.json"),
	};

	return cachedPaths;
}

function parseConfigFile(configPath: string): BirdclawConfig {
	if (!existsSync(configPath)) {
		return {};
	}

	const raw = readFileSync(configPath, "utf8").trim();
	if (!raw) {
		return {};
	}

	const parsed = JSON.parse(raw) as BirdclawConfig;
	return parsed && typeof parsed === "object" ? parsed : {};
}

export function getBirdclawConfig(): BirdclawConfig {
	if (cachedConfig) {
		return cachedConfig;
	}

	const configPath =
		process.env.BIRDCLAW_CONFIG?.trim() || getBirdclawPaths().configPath;
	cachedConfig = parseConfigFile(configPath);
	return cachedConfig;
}

function getConfigPath() {
	return process.env.BIRDCLAW_CONFIG?.trim() || getBirdclawPaths().configPath;
}

export function writeBirdclawConfig(config: BirdclawConfig) {
	const configPath = getConfigPath();
	mkdirSync(path.dirname(configPath), { recursive: true });
	const temporaryPath = `${configPath}.${String(process.pid)}.${String(Date.now())}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(
			descriptor,
			`${JSON.stringify(config, null, "\t")}\n`,
			"utf8",
		);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporaryPath, configPath);
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
		throw error;
	}
	chmodSync(configPath, 0o600);
	cachedConfig = config;
	return configPath;
}

function isSummaryModelProvider(
	value: string | undefined,
): value is SummaryModelProvider {
	return value === "openai" || value === "deepseek";
}

export function getSummaryModelConfig() {
	const config = getBirdclawConfig();
	const primary = isSummaryModelProvider(
		config.analysis?.summaryModels?.primary,
	)
		? config.analysis.summaryModels.primary
		: "openai";
	const configuredBackup = config.analysis?.summaryModels?.backup;
	const backup =
		isSummaryModelProvider(configuredBackup) && configuredBackup !== primary
			? configuredBackup
			: primary === "openai"
				? "deepseek"
				: "openai";
	return {
		primary,
		backup,
		openai: {
			model:
				config.providers?.openai?.model?.trim() ||
				process.env.BIRDCLAW_AI_MODEL?.trim() ||
				DEFAULT_OPENAI_SUMMARY_MODEL,
			tokenConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
		},
		deepseek: {
			baseUrl:
				config.providers?.deepseek?.baseUrl?.trim() ||
				process.env.DEEPSEEK_BASE_URL?.trim() ||
				DEFAULT_DEEPSEEK_BASE_URL,
			model:
				config.providers?.deepseek?.model?.trim() ||
				process.env.DEEPSEEK_MODEL?.trim() ||
				DEFAULT_DEEPSEEK_SUMMARY_MODEL,
			tokenConfigured: Boolean(
				process.env.DEEPSEEK_API_KEY?.trim() ||
				config.providers?.deepseek?.apiKey?.trim(),
			),
		},
	};
}

export function getDeepSeekApiKey() {
	return (
		process.env.DEEPSEEK_API_KEY?.trim() ||
		getBirdclawConfig().providers?.deepseek?.apiKey?.trim() ||
		undefined
	);
}

export function setSummaryModelConfig(input: {
	primary?: SummaryModelProvider;
	backup?: SummaryModelProvider;
	deepSeekApiKey?: string;
}) {
	const config = parseConfigFile(getConfigPath());
	const current = getSummaryModelConfig();
	const primary = input.primary ?? current.primary;
	const backup = input.backup ?? current.backup;
	if (primary === backup) {
		throw new Error("Primary and backup summary models must be different");
	}
	const deepSeekApiKey = input.deepSeekApiKey?.trim();
	const nextConfig: BirdclawConfig = {
		...config,
		analysis: {
			...config.analysis,
			summaryModels: { primary, backup },
		},
		providers: {
			...config.providers,
			openai: {
				...config.providers?.openai,
				model:
					config.providers?.openai?.model?.trim() ||
					DEFAULT_OPENAI_SUMMARY_MODEL,
			},
			deepseek: {
				...config.providers?.deepseek,
				baseUrl:
					config.providers?.deepseek?.baseUrl?.trim() ||
					DEFAULT_DEEPSEEK_BASE_URL,
				model:
					config.providers?.deepseek?.model?.trim() ||
					DEFAULT_DEEPSEEK_SUMMARY_MODEL,
				...(deepSeekApiKey ? { apiKey: deepSeekApiKey } : {}),
			},
		},
	};
	const configPath = writeBirdclawConfig(nextConfig);
	return { configPath, primary, backup };
}

export function setActionsTransport(transport: ActionsTransport) {
	const config = getBirdclawConfig();
	const nextConfig: BirdclawConfig = {
		...config,
		actions: {
			...config.actions,
			transport,
		},
	};
	const configPath = writeBirdclawConfig(nextConfig);
	return { configPath, transport };
}

function isProfileAnalysisSource(
	value: string | undefined,
): value is ProfileAnalysisSource {
	return value === "local" || value === "xurl" || value === "6551";
}

export function resolveProfileAnalysisSource(
	requestedMode?: string,
): ProfileAnalysisSource {
	if (isProfileAnalysisSource(requestedMode)) {
		return requestedMode;
	}

	const envMode = process.env.BIRDCLAW_PROFILE_ANALYSIS_SOURCE?.trim();
	if (isProfileAnalysisSource(envMode)) {
		return envMode;
	}

	const configMode = getBirdclawConfig().analysis?.profileSource;
	if (isProfileAnalysisSource(configMode)) {
		return configMode;
	}

	return "local";
}

export function setProfileAnalysisSource(source: ProfileAnalysisSource) {
	const config = parseConfigFile(getConfigPath());
	const nextConfig: BirdclawConfig = {
		...config,
		analysis: {
			...config.analysis,
			profileSource: source,
		},
	};
	const configPath = writeBirdclawConfig(nextConfig);
	return { configPath, source };
}

export function getTwitter6551Config() {
	const configured = getBirdclawConfig().providers?.twitter6551;
	const tokenEnv = configured?.tokenEnv?.trim() || "TWITTER_TOKEN";
	const baseUrl = configured?.baseUrl?.trim() || "https://ai.6551.io";
	const normalizeList = (values: string[] | undefined) => [
		...new Set(
			(values ?? [])
				.map((value) => value.trim().replace(/^@/, ""))
				.filter(Boolean),
		),
	];
	const backfillMinutes = Number(configured?.backfillMinutes);
	return {
		baseUrl,
		tokenEnv,
		tokenDetected: Boolean(
			process.env[tokenEnv]?.trim() || process.env.OPENNEWS_TOKEN?.trim(),
		),
		accountId: configured?.accountId?.trim() || "acct_6551",
		watchUsers: normalizeList(configured?.watchUsers),
		targetTweetIds: normalizeList(configured?.targetTweetIds),
		backfillMinutes:
			Number.isFinite(backfillMinutes) && backfillMinutes > 0
				? backfillMinutes
				: 120,
	};
}

export function resolveMentionsDataSource(
	requestedMode?: string,
): MentionsDataSource {
	if (
		requestedMode === "birdclaw" ||
		requestedMode === "auto" ||
		requestedMode === "xurl" ||
		requestedMode === "bird"
	) {
		return requestedMode;
	}

	const envMode = process.env.BIRDCLAW_MENTIONS_DATA_SOURCE?.trim();
	if (
		envMode === "birdclaw" ||
		envMode === "auto" ||
		envMode === "xurl" ||
		envMode === "bird"
	) {
		return envMode;
	}

	const configMode = getBirdclawConfig().mentions?.dataSource;
	if (
		configMode === "birdclaw" ||
		configMode === "auto" ||
		configMode === "xurl" ||
		configMode === "bird"
	) {
		return configMode;
	}

	return "birdclaw";
}

export function resolveActionsTransport(
	requestedMode?: string,
): ActionsTransport {
	if (
		requestedMode === "auto" ||
		requestedMode === "bird" ||
		requestedMode === "xurl"
	) {
		return requestedMode;
	}

	const envMode = process.env.BIRDCLAW_ACTIONS_TRANSPORT?.trim();
	if (envMode === "auto" || envMode === "bird" || envMode === "xurl") {
		return envMode;
	}

	const configMode = getBirdclawConfig().actions?.transport;
	if (configMode === "auto" || configMode === "bird" || configMode === "xurl") {
		return configMode;
	}

	return "auto";
}

function findCommandOnPath(command: string) {
	const pathValue = process.env.PATH;
	if (!pathValue) {
		return undefined;
	}

	for (const directory of pathValue.split(path.delimiter)) {
		if (!directory) {
			continue;
		}
		const candidate = path.join(directory, command);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			continue;
		}
	}

	return undefined;
}

export function getBirdCommand() {
	const envCommand = process.env.BIRDCLAW_BIRD_COMMAND?.trim();
	if (envCommand) {
		return envCommand;
	}

	const configuredCommand = getBirdclawConfig().mentions?.birdCommand?.trim();
	if (configuredCommand) {
		return configuredCommand;
	}

	const pathCommand = findCommandOnPath("bird");
	if (pathCommand) {
		return pathCommand;
	}

	return "bird";
}

export function ensureBirdclawDirs(): BirdclawPaths {
	const paths = getBirdclawPaths();

	mkdirSync(paths.rootDir, { recursive: true });
	mkdirSync(paths.mediaOriginalsDir, { recursive: true });
	mkdirSync(paths.mediaThumbsDir, { recursive: true });

	return paths;
}

export function resetBirdclawPathsForTests() {
	cachedPaths = undefined;
	cachedConfig = undefined;
}
