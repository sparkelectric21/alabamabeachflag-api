import { BeachForecast } from "../../models/BeachConditions";
import { fetchBeachForecast } from "./client";
import { mapNOAAForecast } from "./mapper";

export async function getBeachForecasts(): Promise<Map<string, BeachForecast>> {
    const response = await fetchBeachForecast();

    const forecasts = new Map<string, BeachForecast>();

    for (const feature of response.features) {
        const attributes = feature.attributes;

        if (!attributes.id) {
            continue;
        }

        forecasts.set(attributes.id.toLowerCase(), mapNOAAForecast(feature));
    }

    return forecasts;
}