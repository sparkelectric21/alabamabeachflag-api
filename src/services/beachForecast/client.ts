export interface NOAAFeatureAttributes {
    id: string;
    siteid: string;
    beachname: string;
    rip?: string;
    uv?: string;
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
    uvIndex?: string;
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
    const response = await fetch(
        "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/marine_beachforecast_summary/MapServer/0/query?where=1%3D1&outFields=*&returnGeometry=false&f=json"
    );

    if (!response.ok) {
        throw new Error(`NOAA Beach Forecast request failed (${response.status})`);
    }

    return response.json();
}