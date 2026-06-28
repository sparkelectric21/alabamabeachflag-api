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
	const response = await fetch(
		`${BASE_URL}/points/${latitude},${longitude}`,
		{
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

	return (await response.json()) as NWSPointResponse;
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
	const response = await fetch(forecastUrl, {
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

	return (await response.json()) as NWSForecastResponse;
}
