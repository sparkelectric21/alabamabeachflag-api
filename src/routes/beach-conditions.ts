import {
	BEACH_CONDITIONS_CACHE_KEY,
	readCache,
} from "../services/cache/kv";
import type { Env } from "../types";
import { classifyDirectObservation, directObservationAgeMs } from "../services/waterTemperature/freshness";

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
			const freshness = classifyDirectObservation(observation.observedAt, now);
			if (freshness !== "current" && freshness !== "stale") return { ...beach, waterTemperature: null };
			return {
				...beach,
				waterTemperature: {
					...observation,
					freshnessStatus: freshness,
					ageMinutes: Math.max(0, Math.round((directObservationAgeMs(observation.observedAt, now) ?? 0) / 60_000)),
					staleAfterMinutes: 120,
					unavailableAfterMinutes: 360,
				},
			};
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
		return Response.json(withCurrentWaterTemperatureFreshness(cachedBeachConditions), { headers: { "Cache-Control": "public, max-age=300" } });
	}

	return Response.json(
		{
			status: "unavailable",
			message: "Beach conditions cache is unavailable. Please try again shortly.",
		},
		{ status: 503 },
	);
}
