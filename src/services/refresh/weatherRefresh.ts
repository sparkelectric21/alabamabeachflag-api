import {
	WEATHER_CACHE_KEY,
	writeCache,
} from "../cache/kv";
import { BEACH_REGISTRY } from "../beaches/registry";
import { fetchForecast, fetchPoint } from "../nws/client";

export async function refreshWeather(env: Env) {
	const weather = [];
	const errors = [];

	for (const beach of BEACH_REGISTRY) {
		try {
			const point = await fetchPoint(beach.latitude, beach.longitude);
			const forecast = await fetchForecast(point.properties.forecastHourly);
			const current = forecast.properties.periods[0];

			if (!current) {
				throw new Error("NWS hourly forecast did not include any periods.");
			}

			weather.push({
				beachId: beach.id,
				displayName: beach.displayName,
				temperature: current.temperature,
				temperatureUnit: current.temperatureUnit,
				condition: current.shortForecast,
				windSpeed: current.windSpeed,
				windDirection: current.windDirection,
			});
		} catch (error) {
			console.error(
				`[Weather] Failed to refresh ${beach.displayName}`,
				error,
			);

			errors.push({
				beachId: beach.id,
				displayName: beach.displayName,
				message: error instanceof Error ? error.message : "Unknown weather refresh error.",
			});
		}
	}

	const payload = {
		status: weather.length > 0 ? "ok" : "unavailable",
		apiVersion: "1.0.0",
		source: "NOAA/NWS",
		generatedAt: new Date().toISOString(),
		count: weather.length,
		weather,
		errors,
	};

	if (!env.BEACH_DATA) {
		throw new Error("Missing KV binding: BEACH_DATA");
	}

	await writeCache(env.BEACH_DATA, WEATHER_CACHE_KEY, payload);

	return payload;
}