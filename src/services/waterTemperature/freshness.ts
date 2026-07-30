export const DIRECT_OBSERVATION_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
export const DIRECT_OBSERVATION_UNAVAILABLE_AFTER_MS = 6 * 60 * 60 * 1_000;
export const DIRECT_OBSERVATION_FUTURE_TOLERANCE_MS = 10 * 60 * 1_000;

export type DirectObservationFreshness = "current" | "stale" | "unavailable" | "invalid" | "future";

export interface SourceFreshnessThresholds {
	freshAfterMinutes: number;
	unavailableAfterMinutes: number;
}

const SOURCE_THRESHOLDS: Record<string, SourceFreshnessThresholds> = {
	"coops:8735180": { freshAfterMinutes: 30, unavailableAfterMinutes: 90 },
	"ndbc:42012": { freshAfterMinutes: 60, unavailableAfterMinutes: 180 },
	"ndbc:PPTA1": { freshAfterMinutes: 90, unavailableAfterMinutes: 180 },
	"ndbc:DPHA1": { freshAfterMinutes: 90, unavailableAfterMinutes: 180 },
	"ndbc:42357": { freshAfterMinutes: 120, unavailableAfterMinutes: 240 },
};

export function sourceFreshnessThresholds(provider: string, stationId: string): SourceFreshnessThresholds {
	return SOURCE_THRESHOLDS[`${provider}:${stationId}`] ?? {
		freshAfterMinutes: DIRECT_OBSERVATION_MAX_AGE_MS / 60_000,
		unavailableAfterMinutes: DIRECT_OBSERVATION_UNAVAILABLE_AFTER_MS / 60_000,
	};
}

export function directObservationMaxAgeMs(provider: string, stationId: string): number {
	return sourceFreshnessThresholds(provider, stationId).freshAfterMinutes * 60_000;
}

export function directObservationAgeMs(observedAt: string, now: Date): number | undefined {
	const observedMs = new Date(observedAt).getTime();
	return Number.isFinite(observedMs) ? now.getTime() - observedMs : undefined;
}

export function classifyDirectObservation(
	observedAt: string,
	now: Date,
	staleAfterMs = DIRECT_OBSERVATION_MAX_AGE_MS,
	unavailableAfterMs = DIRECT_OBSERVATION_UNAVAILABLE_AFTER_MS,
	futureToleranceMs = DIRECT_OBSERVATION_FUTURE_TOLERANCE_MS,
): DirectObservationFreshness {
	const ageMs = directObservationAgeMs(observedAt, now);
	if (ageMs === undefined) return "invalid";
	if (ageMs < -futureToleranceMs) return "future";
	if (ageMs <= staleAfterMs) return "current";
	if (ageMs <= unavailableAfterMs) return "stale";
	return "unavailable";
}

export function isFreshDirectObservation(
	observedAt: string,
	now: Date,
	maxAgeMs = DIRECT_OBSERVATION_MAX_AGE_MS,
	futureToleranceMs = DIRECT_OBSERVATION_FUTURE_TOLERANCE_MS,
): boolean {
	const ageMs = directObservationAgeMs(observedAt, now);
	return ageMs !== undefined && ageMs <= maxAgeMs && ageMs >= -futureToleranceMs;
}
