import type { BirdclawSettings, UpdateBirdclawSettings } from "./api-contracts";
import {
	getTwitter6551Config,
	resolveProfileAnalysisSource,
	setProfileAnalysisSource,
} from "./config";
import {
	getTwitter6551RuntimeConfig,
	getTwitter6551RuntimeStatus,
} from "./twitter-6551";

export function getBirdclawSettings(): BirdclawSettings {
	const twitter6551 = getTwitter6551Config();
	const runtimeConfig = getTwitter6551RuntimeConfig();
	return {
		analysis: {
			profileSource: resolveProfileAnalysisSource(),
		},
		providers: {
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
	return getBirdclawSettings();
}
