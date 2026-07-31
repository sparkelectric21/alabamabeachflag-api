

import type { WaterTemperatureObservation } from "./client";
import { CONTENT_TYPES, UPSTREAM_LIMITS, validateNdbcUrl } from "../../config/upstreamSecurity";
import { fetchWithRetry, readResponseText } from "../../utils/http";

const NDBC_THREDDS_BASE_URL = "https://dods.ndbc.noaa.gov/thredds/dodsC/data/stdmet";
const NDBC_REQUEST_HEADERS = {
	"Accept": "text/plain",
	"User-Agent": "AlabamaBeachFlagAPI/1.0 (operations@alabamabeachflag.com)",
};

async function fetchNDBCText(url: string, stationId: string): Promise<string> {
	const response = await fetchWithRetry(url, {
		validateUrl: validateNdbcUrl,
		cache: "no-store",
		headers: NDBC_REQUEST_HEADERS,
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch NDBC station ${stationId} (${response.status})`);
	}
	return readResponseText(response, {
		maxBytes: UPSTREAM_LIMITS.ndbcTextBytes,
		contentTypes: CONTENT_TYPES.ndbcText,
	});
}

export async function fetchNDBCWaterTemperature(
	stationId: string,
): Promise<WaterTemperatureObservation> {
	if (!/^[A-Za-z0-9_-]+$/.test(stationId)) {
		throw new Error("Invalid NDBC station identifier");
	}
	const normalizedStationId = stationId.toLowerCase();
	const datasetUrl = `${NDBC_THREDDS_BASE_URL}/${normalizedStationId}/${normalizedStationId}h9999.nc`;
	const schema = await fetchNDBCText(`${datasetUrl}.dds`, stationId);
	const dimensionMatch = schema.match(/\bInt32 time\[time = (\d+)\];/);
	const dimension = Number(dimensionMatch?.[1]);
	if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 1_000_000) {
		throw new Error(`Unexpected NDBC schema for station ${stationId}`);
	}

	const lastIndex = dimension - 1;
	const query = `time[${lastIndex}:1:${lastIndex}],sea_surface_temperature[${lastIndex}:1:${lastIndex}][0:1:0][0:1:0]`;
	const observation = await fetchNDBCText(`${datasetUrl}.ascii?${query}`, stationId);
	const temperatureMatch = observation.match(
		/sea_surface_temperature\.sea_surface_temperature\[1\]\[1\]\[1\]\s*\n\[0\]\[0\],\s*(-?\d+(?:\.\d+)?)/,
	);
	const timeMatch = observation.match(/(?:^|\n)time\[1\]\s*\n(\d+)(?:\n|$)/);
	const waterTempC = Number(temperatureMatch?.[1]);
	const observedEpochSeconds = Number(timeMatch?.[1]);
	if (
		!Number.isFinite(waterTempC)
		|| waterTempC < -5
		|| waterTempC > 45
		|| !Number.isSafeInteger(observedEpochSeconds)
		|| observedEpochSeconds < 946684800
	) {
		throw new Error(`No valid water temperature for station ${stationId}`);
	}

	const waterTempF = Math.round((waterTempC * 9) / 5 + 32);

	return {
		temperature: waterTempF,
		temperatureUnit: "F",
		observedAt: new Date(observedEpochSeconds * 1000).toISOString(),
	};
}
