import { estimateVibrioConditions, type VibrioConditionsResult } from "../services/vibrio/estimator";
import { logInfo } from "../utils/logger";

export type VibrioQaFixtureMode = "seasonalAwareness" | "unavailable";

export interface LocalFixtureConfiguration {
	featureEnabled: boolean;
	isLocalDevelopment: boolean;
	value?: string;
}

export function resolveLocalVibrioQaFixture(
	configuration: LocalFixtureConfiguration,
): VibrioQaFixtureMode | undefined {
	if (!configuration.featureEnabled || !configuration.isLocalDevelopment) return undefined;
	if (configuration.value === "seasonalAwareness" || configuration.value === "unavailable") {
		return configuration.value;
	}
	return undefined;
}

export function buildLocalVibrioQaFixture(
	mode: VibrioQaFixtureMode,
	now: Date,
): Omit<VibrioConditionsResult, "diagnosticCode"> {
	const result = mode === "seasonalAwareness"
		? estimateVibrioConditions({
			enabled: true,
			now,
			observation: {
				waterTemperature: 84,
				waterTemperatureUnit: "F",
				observedAt: now.toISOString(),
				provider: "fixture",
				stationId: "LOCAL-QA",
			},
		})
		: estimateVibrioConditions({ enabled: true, now, observation: null });

	const { diagnosticCode: _diagnosticCode, ...publicResult } = result;
	return publicResult;
}

export function applyLocalVibrioQaFixture<
	T extends { beachConditions: Array<{ vibrioConditions?: unknown; waterTemperature?: unknown }> },
>(payload: T, mode: VibrioQaFixtureMode, now: Date): T {
	const fixture = buildLocalVibrioQaFixture(mode, now);
	logInfo("Vibrio Conditions", "Applying LOCAL QA fixture", {
		mode,
		provider: fixture.source.provider,
		stationId: fixture.source.stationId,
		count: payload.beachConditions.length,
	});
	return {
		...payload,
		beachConditions: payload.beachConditions.map((beach) => ({
			...beach,
			vibrioConditions: fixture,
		})),
	};
}
