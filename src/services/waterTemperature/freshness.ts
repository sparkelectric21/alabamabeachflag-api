export const DIRECT_OBSERVATION_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
export const DIRECT_OBSERVATION_FUTURE_TOLERANCE_MS = 10 * 60 * 1_000;

export function directObservationAgeMs(observedAt: string, now: Date): number | undefined {
	const observedMs = new Date(observedAt).getTime();
	return Number.isFinite(observedMs) ? now.getTime() - observedMs : undefined;
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
