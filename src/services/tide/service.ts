import type { TidePredictionConfiguration } from "../../config/BeachRegistry";
import { logWarn } from "../../utils/logger";
import { fetchTideEvents, fetchTidePoints } from "./client";
import type { TideDirection, TideEvent, TidePrediction, TidePredictionPoint } from "./models";
import { beachDate, noaaDate } from "./time";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { expiresAt: number; value: TidePrediction }>();

export function fitTideCurveFromEvents(events: TideEvent[], intervalMinutes = 15): TidePredictionPoint[] {
	if (events.length < 2 || events.some((event, index) =>
		index > 0 && (event.type === events[index - 1].type || Date.parse(event.time) <= Date.parse(events[index - 1].time))
	)) return [];
	const points: TidePredictionPoint[] = [];
	for (let index = 0; index < events.length - 1; index++) {
		const left = events[index];
		const right = events[index + 1];
		const start = Date.parse(left.time);
		const end = Date.parse(right.time);
		if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
		if (index === 0) points.push({ time: left.time, height: left.height });
		for (let time = start + intervalMinutes * 60_000; time < end; time += intervalMinutes * 60_000) {
			const progress = (time - start) / (end - start);
			const eased = (1 - Math.cos(Math.PI * progress)) / 2;
			points.push({ time: new Date(time).toISOString(), height: left.height + (right.height - left.height) * eased });
		}
		points.push({ time: right.time, height: right.height });
	}
	return points;
}

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
	let events: TideEvent[];
	try {
		events = await fetchTideEvents(configuration.stationId, date);
	} catch (error) {
		if (cached) {
			logWarn("Tide", "Using expired same-day tide prediction after event request failure", {
				stationId: configuration.stationId, stationType: configuration.stationType,
				reason: "events_request_failed", error: error instanceof Error ? error.message : String(error),
			});
			return { ...cached.value, direction: deriveTideDirection(cached.value.points, now), nextEvent: selectNextTideEvent(cached.value.events, now) };
		}
		throw error;
	}

	let points: TidePredictionPoint[] = [];
	let curveMethod: TidePrediction["curveMethod"] = "eventOnly";
	if (configuration.stationType === "harmonic") {
		try {
			points = await fetchTidePoints(configuration.stationId, date);
			curveMethod = "noaaInterval";
		} catch (error) {
			logWarn("Tide", "Interval predictions unavailable; preserving high/low events", {
				stationId: configuration.stationId, stationType: configuration.stationType,
				reason: "interval_points_failed", error: error instanceof Error ? error.message : String(error),
			});
		}
	} else {
		points = fitTideCurveFromEvents(events);
		if (points.length >= 2) curveMethod = "fittedFromHighLow";
	}
	if (!events.every((event) => beachDate(new Date(event.time)) === predictionDate) ||
		!points.every((point) => beachDate(new Date(point.time)) === predictionDate)) {
		throw new Error("NOAA returned tide predictions for the wrong date");
	}
	const fetchedAt = new Date();
	const value: TidePrediction = {
		...configuration, predictionDate, timeZone: "America/Chicago", datum: "MLLW", units: "feet",
		points, events, curveMethod, direction: deriveTideDirection(points, now), nextEvent: selectNextTideEvent(events, now),
		fetchedAt: fetchedAt.toISOString(),
		stationUrl: `https://tidesandcurrents.noaa.gov/noaatidepredictions.html?id=${configuration.stationId}`,
	};
	cache.set(key, { expiresAt: now.getTime() + CACHE_TTL_MS, value });
	return value;
}

export function clearTideMemoryCacheForTests(): void { cache.clear(); }
