import type { BirdclawSettings, UpdateBirdclawSettings } from "./api-contracts";
import {
	getTwitter6551Config,
	getSummaryModelConfig,
	resolveProfileAnalysisSource,
	setProfileAnalysisSource,
	setSummaryModelConfig,
} from "./config";
import {
	getTwitter6551RuntimeConfig,
	getTwitter6551RuntimeStatus,
} from "./twitter-6551";

export function getBirdclawSettings(): BirdclawSettings {
	const twitter6551 = getTwitter6551Config();
	const summaryModels = getSummaryModelConfig();
	const runtimeConfig = getTwitter6551RuntimeConfig();
	return {
		analysis: {
			profileSource: resolveProfileAnalysisSource(),
			summaryModels: {
				primary: summaryModels.primary,
				backup: summaryModels.backup,
			},
		},
		providers: {
			openai: {
				label: "ChatGPT",
				model: summaryModels.openai.model,
				tokenConfigured: summaryModels.openai.tokenConfigured,
			},
			deepseek: {
				label: "DeepSeek V4 / Flash",
				baseUrl: summaryModels.deepseek.baseUrl,
				model: summaryModels.deepseek.model,
				tokenConfigured: summaryModels.deepseek.tokenConfigured,
			},
			twitter6551: {
				...twitter6551,
				accountId: runtimeConfig.accountId,
				watchUsers: runtimeConfig.watchUsers,
				targetTweetIds: runtimeConfig.targetTweetIds,
				backfillMinutes: runtimeConfig.backfillMinutes,
				runtime: getTwitter6551RuntimeStatus(),
			},
		},
	};
}

export function updateBirdclawSettings(
	input: UpdateBirdclawSettings,
): BirdclawSettings {
	if (input.analysis?.profileSource) {
		setProfileAnalysisSource(input.analysis.profileSource);
	}
	if (input.analysis?.summaryModels || input.providers?.deepseek?.apiKey) {
		setSummaryModelConfig({
			...input.analysis?.summaryModels,
			deepSeekApiKey: input.providers?.deepseek?.apiKey,
		});
	}
	return getBirdclawSettings();
}
