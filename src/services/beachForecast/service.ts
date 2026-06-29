import { BeachForecast } from "../../models/BeachConditions";
import { fetchBeachForecast } from "./client";
import { mapNOAAForecast } from "./mapper";

export async function getBeachForecasts(): Promise<Map<string, BeachForecast>> {
    const response = await fetchBeachForecast();

    for (const feature of response.features) {
    console.log(JSON.stringify({
        id: feature.attributes.id,
        siteId: feature.attributes.siteid,
        beachName: feature.attributes.beachname,
    }, null, 2));
}

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