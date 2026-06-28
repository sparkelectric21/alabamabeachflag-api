

import {
	WEATHER_CACHE_KEY,
	readCache,
} from "../services/cache/kv";

export async function handleWeatherRequest(env: Env): Promise<Response> {
	if (!env.BEACH_DATA) {
		return Response.json(
			{
				status: "error",
				message: "Weather cache is not configured.",
			},
			{ status: 500 },
		);
	}

	const cachedWeather = await readCache<unknown>(
		env.BEACH_DATA,
		WEATHER_CACHE_KEY,
	);

	if (cachedWeather) {
		return Response.json(cachedWeather);
	}

	return Response.json(
		{
			status: "unavailable",
			message: "Weather cache is unavailable. Please try again shortly.",
		},
		{ status: 503 },
	);
}