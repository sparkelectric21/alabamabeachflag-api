import type { Env } from "../../types";
import { createWeatherKitToken } from "./auth";

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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json"
            },
            signal: controller.signal
        });

        const body = await response.text();

        console.log("WeatherKit Status:", response.status);
        console.log("WeatherKit Headers:", Object.fromEntries(response.headers));
        console.log("WeatherKit Response:", body);

        if (!response.ok) {
            throw new Error(`WeatherKit request failed (${response.status})`);
        }

        return JSON.parse(body);
    } finally {
        clearTimeout(timeout);
    }
}