import type { TidePredictionConfiguration } from "../../config/BeachRegistry";
import { fetchTideEvents, fetchTidePoints } from "./client";
import type { TideDirection, TideEvent, TidePrediction, TidePredictionPoint } from "./models";
import { beachDate, noaaDate } from "./time";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { expiresAt: number; value: TidePrediction }>();

export function deriveTideDirection(points: TidePredictionPoint[], now: Date): TideDirection | undefined {
	if (points.length < 2) return undefined;
	const after = points.findIndex((point) => Date.parse(point.time) >= now.getTime());
	const exact = after >= 0 && Date.parse(points[after].time) === now.getTime();
	const left = exact && after < points.length - 1 ? after : after <= 0 ? 0 : after === -1 ? points.length - 2 : after - 1;
	const right = left + 1;
	const delta = points[right].height - points[left].height;
	return delta > 0 ? "rising" : delta < 0 ? "falling" : undefined;
}

export function selectNextTideEvent(events: TideEvent[], now: Date): TideEvent | undefined {
	return events.find((event) => Date.parse(event.time) >= now.getTime());
}

export async function fetchTidePrediction(
	configuration: TidePredictionConfiguration,
	now: Date = new Date(),
): Promise<TidePrediction> {
	const predictionDate = beachDate(now);
	const key = `${configuration.stationId}:${predictionDate}`;
	const cached = cache.get(key);
	if (cached && cached.expiresAt > now.getTime()) {
		return { ...cached.value, direction: deriveTideDirection(cached.value.points, now), nextEvent: selectNextTideEvent(cached.value.events, now) };
	}

	const date = noaaDate(now);
	const [events, points] = await Promise.all([
		fetchTideEvents(configuration.stationId, date),
		configuration.stationType === "harmonic" ? fetchTidePoints(configuration.stationId, date) : Promise.resolve([]),
	]);
	if (!events.every((event) => beachDate(new Date(event.time)) === predictionDate) ||
		!points.every((point) => beachDate(new Date(point.time)) === predictionDate)) {
		throw new Error("NOAA returned tide predictions for the wrong date");
	}
	const fetchedAt = new Date();
	const value: TidePrediction = {
		...configuration, predictionDate, timeZone: "America/Chicago", datum: "MLLW", units: "feet",
		points, events, direction: deriveTideDirection(points, now), nextEvent: selectNextTideEvent(events, now),
		fetchedAt: fetchedAt.toISOString(),
		stationUrl: `https://tidesandcurrents.noaa.gov/noaatidepredictions.html?id=${configuration.stationId}`,
	};
	cache.set(key, { expiresAt: now.getTime() + CACHE_TTL_MS, value });
	return value;
}

export function clearTideMemoryCacheForTests(): void { cache.clear(); }
