import { describe, expect, it, vi } from "vitest";
import { beaches } from "../src/config/BeachRegistry";
import { buildBeachConditionsPayload } from "../src/services/refresh/beachConditionsRefresh";
import type { TidePrediction } from "../src/services/tide/models";
import type { WaterTemperatureResults } from "../src/services/waterTemperature/refresh";

const NOW = new Date("2026-07-21T18:00:00.000Z");

function waterTemperatures(): WaterTemperatureResults {
	return Object.fromEntries(beaches.map((beach) => [beach.id, {
		temperature: 84,
		temperatureUnit: "F" as const,
		observedAt: NOW.toISOString(),
		provider: "ndbc" as const,
		stationId: "PPTA1",
		freshnessStatus: "current" as const,
		ageMinutes: 5,
		staleAfterMinutes: 120,
		unavailableAfterMinutes: 360,
	}]));
}

function tidePrediction(beachId: string): TidePrediction {
	const station = beaches.find((beach) => beach.id === beachId)?.tide;
	return {
		stationId: station?.stationId ?? "8731439",
		stationName: station?.stationName ?? "Test Station",
		stationType: station?.stationType ?? "harmonic",
		predictionDate: "2026-07-21",
		timeZone: "America/Chicago",
		datum: "MLLW",
		units: "feet",
		points: station?.stationType === "subordinate" ? [] : [
			{ time: "2026-07-21T12:00:00-05:00", height: 0.5 },
			{ time: "2026-07-21T18:00:00-05:00", height: 1.5 },
		],
		events: [
			{ time: "2026-07-21T12:00:00-05:00", height: 0.5, type: "low" },
			{ time: "2026-07-21T18:00:00-05:00", height: 1.5, type: "high" },
		],
		fetchedAt: NOW.toISOString(),
		stationUrl: "https://tidesandcurrents.noaa.gov/noaatidepredictions.html?id=8731439",
	};
}

function dependencies(failingWeatherKeys: Set<string>) {
	const tidePredictions = new Map(beaches.map((beach) => [beach.id, tidePrediction(beach.id)]));
	return {
		refreshWaterTemperatureSelections: vi.fn().mockResolvedValue({ general: waterTemperatures(), vibrio: {} }),
		getBeachForecasts: vi.fn().mockResolvedValue(new Map()),
		getTidePredictions: vi.fn().mockResolvedValue(tidePredictions),
		fetchCurrentUV: vi.fn().mockResolvedValue(7.2),
		fetchPoint: vi.fn(async (latitude: number, longitude: number) => ({ properties: {
			forecast: "https://api.weather.gov/gridpoints/MOB/1,1/forecast",
			forecastHourly: `https://api.weather.gov/gridpoints/${latitude},${longitude}/hourly`,
			forecastGridData: "https://api.weather.gov/gridpoints/MOB/1,1",
			gridId: "MOB",
			gridX: 1,
			gridY: 1,
		} })),
		fetchForecast: vi.fn(async (url: string) => {
			if ([...failingWeatherKeys].some((key) => url.includes(key))) throw new Error("Failed to fetch NWS forecast (500)");
			return { properties: { periods: [{
				name: "Now",
				temperature: 88,
				temperatureUnit: "F",
				windSpeed: "10 mph",
				windDirection: "S",
				shortForecast: "Sunny",
				icon: "https://api.weather.gov/icons/test",
			}] } };
		}),
	};
}

describe("beach conditions refresh provider isolation", () => {
	it("publishes tide, water temperature, and identity for every beach during a total NWS outage", async () => {
		const allWeatherKeys = new Set(beaches.map((beach) => `${beach.weather.latitude},${beach.weather.longitude}`));
		const payload = await buildBeachConditionsPayload({ now: NOW, dependencies: dependencies(allWeatherKeys) });

		expect(payload).toMatchObject({ status: "ok", count: beaches.length });
		expect(payload.errors).toHaveLength(beaches.length);
		expect(payload.refreshDiagnostics).toMatchObject({ expectedBeachCount: beaches.length, providerFailures: { nws: beaches.length } });
		expect(payload.refreshDiagnostics.providerHealth).toContainEqual({
			provider: "nws",
			domain: "hourly_forecast",
			affectedBeachCount: beaches.length,
			expectedBeachCount: beaches.length,
			errorReason: "request_failed",
		});
		for (const beach of payload.beachConditions) {
			expect(beach).toMatchObject({
				beachId: expect.any(String),
				displayName: expect.any(String),
				waterTemperature: { temperature: 84 },
				tide: { events: expect.arrayContaining([expect.objectContaining({ type: "high" })]) },
			});
			expect(beach).not.toHaveProperty("temperature");
			expect(beach).not.toHaveProperty("windSpeed");
		}
	});

	it("keeps one NWS failure local to that beach while publishing valid marine domains", async () => {
		const affected = beaches[0];
		const weatherKey = `${affected.weather.latitude},${affected.weather.longitude}`;
		const payload = await buildBeachConditionsPayload({ now: NOW, dependencies: dependencies(new Set([weatherKey])) });
		const failedBeach = payload.beachConditions.find((beach) => beach.beachId === affected.id);
		const healthyBeach = payload.beachConditions.find((beach) => beach.beachId !== affected.id);

		expect(payload.count).toBe(beaches.length);
		expect(payload.errors).toEqual([{ beachId: affected.id, displayName: affected.displayName, message: "provider_unavailable" }]);
		expect(failedBeach).toMatchObject({ waterTemperature: { temperature: 84 }, tide: { events: expect.any(Array) } });
		expect(failedBeach).not.toHaveProperty("temperature");
		expect(healthyBeach).toMatchObject({ temperature: 88, waterTemperature: { temperature: 84 }, tide: { points: expect.any(Array) } });
	});
});
