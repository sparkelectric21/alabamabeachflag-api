import type { Env } from "../../types";
import { createWeatherKitToken } from "./auth";
import { CONTENT_TYPES, UPSTREAM_LIMITS, validateWeatherKitUrl } from "../../config/upstreamSecurity";
import { fetchWithRetry, readResponseText } from "../../utils/http";

export interface WeatherKitRequest {
    latitude: number;
    longitude: number;
}

export async function fetchCurrentWeather(
    env: Env,
    request: WeatherKitRequest
): Promise<unknown> {
    const token = await createWeatherKitToken(env);

    const language = "en";

    const url = new URL(
        `https://weatherkit.apple.com/api/v1/weather/${language}/${request.latitude}/${request.longitude}`
    );

    url.searchParams.set("dataSets", "currentWeather");
    url.searchParams.set("countryCode", "US");
    url.searchParams.set("timezone", "America/Chicago");

	    const response = await fetchWithRetry(url, {
	        validateUrl: validateWeatherKitUrl,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json"
        }
    });

	    const body = await readResponseText(response, {
	        maxBytes: UPSTREAM_LIMITS.weatherKitJsonBytes,
	        contentTypes: CONTENT_TYPES.json,
	    });

    if (!response.ok) {
	        throw new Error(`WeatherKit request failed (${response.status})`);
    }

    return JSON.parse(body);
}
