import { CONTENT_TYPES, UPSTREAM_LIMITS, validateNoaaMapUrl } from "../../config/upstreamSecurity";
import { fetchWithRetry, readResponseJson } from "../../utils/http";
export interface NOAAFeatureAttributes {
    id: string;
    siteid: string;
    beachname: string;
    rip?: string;
    uv?: string;
    uvindex?: string | number;
    uvcat?: string;
    uvcategory?: string;
    surf?: string;
    weather?: string;
    winds?: string;
    wtemp?: string;
    maxtemp?: string;
    tstorm?: string;
    wspout?: string;
    period?: string;
    productdat?: string;
    producttim?: string;
}

export interface NOAAFeature {
    attributes: NOAAFeatureAttributes;
}

export interface NOAAFeatureResponse {
    features: NOAAFeature[];
}

export interface BeachForecastObservation {
    ripCurrentRisk?: string;
    surfHeight?: string;
    uvValue?: number;
    weather?: string;
    winds?: string;
    waterTemperature?: string;
    maxTemperature?: string;
    thunderstormRisk?: string;
    waterspoutRisk?: string;
    period?: string;
    issuedAt?: string;
}

export async function fetchBeachForecast(): Promise<NOAAFeatureResponse> {
	    const response = await fetchWithRetry(
	        "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/marine_beachforecast_summary/MapServer/0/query?where=1%3D1&outFields=*&returnGeometry=false&f=json",
	        { validateUrl: validateNoaaMapUrl },
	    );

    if (!response.ok) {
        throw new Error(`NOAA Beach Forecast request failed (${response.status})`);
    }

	    return readResponseJson<NOAAFeatureResponse>(response, {
	        maxBytes: UPSTREAM_LIMITS.noaaJsonBytes,
	        contentTypes: CONTENT_TYPES.arcgisJson,
	    });
}
