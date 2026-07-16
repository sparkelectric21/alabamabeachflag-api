import { CONTENT_TYPES, UPSTREAM_LIMITS, validateNwsUrl } from "../../config/upstreamSecurity";
import { fetchWithRetry, readResponseJson } from "../../utils/http";
const BASE_URL = "https://api.weather.gov";

export interface NWSPointResponse {
	properties: {
		forecast: string;
		forecastHourly: string;
		forecastGridData: string;
		gridId: string;
		gridX: number;
		gridY: number;
	};
}

export async function fetchPoint(
	latitude: number,
	longitude: number,
): Promise<NWSPointResponse> {
	const response = await fetchWithRetry(
		`${BASE_URL}/points/${latitude},${longitude}`,
		{
			validateUrl: validateNwsUrl,
			headers: {
				"User-Agent": "Alabama Beach Flag (support@albeachflag.com)",
				Accept: "application/geo+json",
			},
		},
	);

	if (!response.ok) {
		throw new Error(
			`Failed to fetch NWS point (${response.status})`,
		);
	}

	return await readResponseJson<NWSPointResponse>(response, {
		maxBytes: UPSTREAM_LIMITS.nwsJsonBytes,
		contentTypes: CONTENT_TYPES.nwsJson,
	});
}

export interface NWSForecastResponse {
	properties: {
		periods: Array<{
			name: string;
			temperature: number;
			temperatureUnit: string;
			windSpeed: string;
			windDirection: string;
			shortForecast: string;
			icon: string;
		}>;
	};
}

export async function fetchForecast(
	forecastUrl: string,
): Promise<NWSForecastResponse> {
	const response = await fetchWithRetry(forecastUrl, {
		validateUrl: validateNwsUrl,
		headers: {
			"User-Agent": "Alabama Beach Flag (support@albeachflag.com)",
			Accept: "application/geo+json",
		},
	});

	if (!response.ok) {
		throw new Error(
			`Failed to fetch NWS forecast (${response.status})`,
		);
	}

	return await readResponseJson<NWSForecastResponse>(response, {
		maxBytes: UPSTREAM_LIMITS.nwsJsonBytes,
		contentTypes: CONTENT_TYPES.nwsJson,
	});
}
