import { fetchCoopsJson } from "./coopsClient";

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
	const json = await fetchCoopsJson<NOAAResponse>({
		product: "water_temperature", station: stationId, time_zone: "gmt",
		units: "english", date: "latest",
	});

	const latest = json.data?.[0];

	if (!latest) {
		throw new Error(`No water temperature available for station ${stationId}`);
	}

	const observedAt = new Date(
		latest.t.replace(" ", "T") + ":00Z",
	).toISOString();

	return {
		temperature: Number(latest.v),
		temperatureUnit: "F",
		observedAt,
	};
}
