

export interface BeachConditions {
    beachId: string;
    displayName: string;
    weather: WeatherConditions;
    waterTemperature?: WaterTemperature;
    forecast?: BeachForecast;
}

export interface BeachConditionsResponse {
    status: "ok" | "unavailable";
    apiVersion: string;
    source: string;
    generatedAt: string;
    count: number;
    beachConditions: BeachConditions[];
}

export interface WeatherConditions {
    temperature: number;
    temperatureUnit: string;
    condition: string;
    windSpeed: string;
    windDirection: string;
}

export interface WaterTemperature {
    temperature: number;
    temperatureUnit: string;
    observedAt: string;
    provider: string;
    stationId: string;
}

export interface BeachForecast {
    ripCurrentRisk?: string;
    uvIndex?: string;
    surf?: string;
    weather?: string;
    winds?: string;
    maxTemperature?: string;
    thunderstormRisk?: string;
    waterspoutRisk?: string;
    period?: string;
    issuedAt?: string;
}