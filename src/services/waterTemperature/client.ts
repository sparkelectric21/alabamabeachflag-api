

const NOAA_COOPS_BASE_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";

export interface WaterTemperatureObservation {
	temperature: number;
	temperatureUnit: "F";
	observedAt: string;
}

interface NOAAResponse {
	data?: Array<{
		t: string;
		v: string;
	}>;
	error?: {
		message: string;
	};
}

export async function fetchWaterTemperature(
	stationId: string,
): Promise<WaterTemperatureObservation> {
	const url = new URL(NOAA_COOPS_BASE_URL);

	url.searchParams.set("product", "water_temperature");
	url.searchParams.set("application", "alabama-beach-flag");
	url.searchParams.set("station", stationId);
	url.searchParams.set("time_zone", "gmt");
	url.searchParams.set("units", "english");
	url.searchParams.set("format", "json");
	url.searchParams.set("date", "latest");

	const response = await fetch(url.toString(), {
		headers: {
			"User-Agent": "Alabama Beach Flag",
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch water temperature (${response.status})`);
	}

	const json = (await response.json()) as NOAAResponse;

	if (json.error) {
		throw new Error(json.error.message);
	}

	const latest = json.data?.[0];

	if (!latest) {
		throw new Error(`No water temperature available for station ${stationId}`);
	}

	return {
		temperature: Number(latest.v),
		temperatureUnit: "F",
		observedAt: latest.t,
	};
}