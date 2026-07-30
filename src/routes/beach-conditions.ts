import {
	BEACH_CONDITIONS_CACHE_KEY,
	readCache,
} from "../services/cache/kv";
import type { Env } from "../types";
import { evaluateVibrioAwarenessControl, readOperationalControl } from "../operationalControl/store";
import {
	classifyDirectObservation,
	directObservationAgeMs,
	sourceFreshnessThresholds,
} from "../services/waterTemperature/freshness";

export function withCurrentWaterTemperatureFreshness(payload: unknown, now = new Date()): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const record = payload as Record<string, unknown>;
	if (!Array.isArray(record.beachConditions)) return payload;
	return {
		...record,
		beachConditions: record.beachConditions.map((item) => {
			if (!item || typeof item !== "object") return item;
			const beach = item as Record<string, unknown>;
			const water = beach.waterTemperature;
			if (!water || typeof water !== "object") return item;
			const observation = water as Record<string, unknown>;
			if (typeof observation.observedAt !== "string") return { ...beach, waterTemperature: null };
			const thresholds = sourceFreshnessThresholds(
				typeof observation.provider === "string" ? observation.provider : "",
				typeof observation.stationId === "string" ? observation.stationId : "",
			);
			const freshness = classifyDirectObservation(
				observation.observedAt,
				now,
				thresholds.freshAfterMinutes * 60_000,
				thresholds.unavailableAfterMinutes * 60_000,
			);
			if (freshness !== "current" && freshness !== "stale") return { ...beach, waterTemperature: null };
			return {
				...beach,
				waterTemperature: {
					...observation,
					freshnessStatus: freshness,
					ageMinutes: Math.max(0, Math.round((directObservationAgeMs(observation.observedAt, now) ?? 0) / 60_000)),
					staleAfterMinutes: thresholds.freshAfterMinutes,
					unavailableAfterMinutes: thresholds.unavailableAfterMinutes,
				},
			};
		}),
	};
}

export function enforceVibrioAwarenessControl(payload: unknown, enabled: boolean): unknown {
	if (enabled || !payload || typeof payload !== "object") return payload;
	const record = payload as Record<string, unknown>;
	if (!Array.isArray(record.beachConditions)) return payload;
	return {
		...record,
		beachConditions: record.beachConditions.map((item) => {
			if (!item || typeof item !== "object") return item;
			const { vibrioConditions: _vibrioConditions, ...beach } = item as Record<string, unknown>;
			return beach;
		}),
	};
}

export async function handleBeachConditionsRequest(env: Env): Promise<Response> {
	if (!env.BEACH_DATA) {
		return Response.json(
			{
				status: "error",
				message: "Beach conditions cache is not configured.",
			},
			{ status: 500 },
		);
	}

	const cachedBeachConditions = await readCache<unknown>(
		env.BEACH_DATA,
		BEACH_CONDITIONS_CACHE_KEY,
	);

	if (cachedBeachConditions) {
		const now = new Date();
		const control = evaluateVibrioAwarenessControl(await readOperationalControl(env, now), now);
		const controlled = enforceVibrioAwarenessControl(
			cachedBeachConditions,
			env.VIBRIO_CONDITIONS_ENABLED === "true" && control.state === "enabled",
		);
		return Response.json(withCurrentWaterTemperatureFreshness(controlled, now), { headers: { "Cache-Control": "public, max-age=300" } });
	}

	return Response.json(
		{
			status: "unavailable",
			message: "Beach conditions cache is unavailable. Please try again shortly.",
		},
		{ status: 503 },
	);
}
