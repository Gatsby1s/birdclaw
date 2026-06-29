import type { BirdclawSettings, UpdateBirdclawSettings } from "./api-contracts";
import {
	getTwitter6551Config,
	resolveProfileAnalysisSource,
	setProfileAnalysisSource,
} from "./config";

export function getBirdclawSettings(): BirdclawSettings {
	return {
		analysis: {
			profileSource: resolveProfileAnalysisSource(),
		},
		providers: {
			twitter6551: getTwitter6551Config(),
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
