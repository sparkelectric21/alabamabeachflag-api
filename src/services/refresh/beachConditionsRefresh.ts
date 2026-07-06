import { normalizeWeatherCondition } from "../weather/normalizeWeatherCondition";
import {
	BEACH_CONDITIONS_CACHE_KEY,
	writeCache,
} from "../cache/kv";
import { beaches as BEACH_REGISTRY } from "../../config/BeachRegistry";
import { fetchForecast, fetchPoint } from "../nws/client";
import { refreshWaterTemperatures } from "../waterTemperature/refresh";
import { getBeachForecasts } from "../beachForecast/service";
import { fetchCurrentUV } from "../beachForecast/openMeteoClient";
import { elapsedMs, logError, logInfo } from "../../utils/logger";

async function safeFetchCurrentUV(
	latitude: number,
	longitude: number,
): Promise<number | undefined> {
	try {
		const value = await fetchCurrentUV(latitude, longitude);
		return value == null ? undefined : Math.round(value);
	} catch (error) {
		logError("Beach Conditions", "Open-Meteo UV failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function getUVCategory(uv: number | undefined): string | undefined {
	if (uv === undefined) {
		return undefined;
	}

	if (uv < 3) {
		return "Low";
	}

	if (uv < 6) {
		return "Moderate";
	}

	if (uv < 8) {
		return "High";
	}

	if (uv < 11) {
		return "Very High";
	}

	return "Extreme";
}

export async function refreshBeachConditions(env: Env) {
	const startedAt = Date.now();
	logInfo("Beach Conditions", "Starting refresh");

	const regionalUV = {
		orangeBeach: await safeFetchCurrentUV(30.248108, -87.71726),
		fortMorgan: await safeFetchCurrentUV(30.2285, -88.0243),
		dauphinIsland: await safeFetchCurrentUV(30.2506, -88.1096),
	};

	logInfo("Beach Conditions", "Regional UV refreshed", {
		orangeBeach: regionalUV.orangeBeach,
		fortMorgan: regionalUV.fortMorgan,
		dauphinIsland: regionalUV.dauphinIsland,
	});

	const beachConditions = [];
	const errors = [];
	const waterTemperatures = await refreshWaterTemperatures();
	const beachForecasts = await getBeachForecasts();

	for (const beach of BEACH_REGISTRY) {
		try {
			const point = await fetchPoint(
				beach.weather.latitude,
				beach.weather.longitude,
			);
			const forecast = await fetchForecast(point.properties.forecastHourly);
			const current = forecast.properties.periods[0];
			const beachForecast = beach.beachForecast
				? beachForecasts.get(beach.beachForecast.siteId)
				: undefined;

			const uvValue = beach.uv
				? regionalUV[beach.uv.region]
				: undefined;

			if (!current) {
				throw new Error("NWS hourly forecast did not include any periods.");
			}

			beachConditions.push({
				beachId: beach.id,
				displayName: beach.displayName,
				temperature: current.temperature,
				temperatureUnit: current.temperatureUnit,
				condition: normalizeWeatherCondition(current.shortForecast),
				windSpeed: current.windSpeed,
				windDirection: current.windDirection,
				waterTemperature: waterTemperatures[beach.id] ?? null,
				forecast: beach.beachForecast
					? {
						...(beachForecast ?? {}),
						uvValue,
						uvCategory: getUVCategory(uvValue),
					}
					: null,
			});
		} catch (error) {
			logError("Beach Conditions", `${beach.displayName} failed`, {
				error: error instanceof Error ? error.message : String(error),
			});

			errors.push({
				beachId: beach.id,
				displayName: beach.displayName,
				message: error instanceof Error ? error.message : "Unknown weather refresh error.",
			});
		}
	}

	const payload = {
		status: beachConditions.length > 0 ? "ok" : "unavailable",
		apiVersion: "1.0.0",
		source: "NOAA",
		generatedAt: new Date().toISOString(),
		count: beachConditions.length,
		beachConditions,
		errors,
	};

	if (!env.BEACH_DATA) {
		throw new Error("Missing KV binding: BEACH_DATA");
	}

	await writeCache(env.BEACH_DATA, BEACH_CONDITIONS_CACHE_KEY, payload);

	logInfo("Beach Conditions", "Finished refresh", {
		durationMs: elapsedMs(startedAt),
		count: beachConditions.length,
		errors: errors.length,
	});

	return payload;
}