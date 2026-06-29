import {
    BeachForecast,
} from "../../models/BeachConditions";
import {
    NOAAFeature,
} from "./client";

export function mapNOAAForecast(feature: NOAAFeature): BeachForecast {
    const attributes = feature.attributes;

    return {
        ripCurrentRisk: attributes.rip ?? "",
        uvIndex: attributes.uv ?? "",
        surf: attributes.surf ?? "",
        weather: attributes.weather ?? "",
        winds: attributes.winds ?? "",
        waterTemperature: attributes.wtemp ?? "",
        maxTemperature: attributes.maxtemp ?? "",
        thunderstormRisk: attributes.tstorm ?? "",
        waterspoutRisk: attributes.wspout ?? "",
        period: attributes.period ?? "",
        issuedAt: `${attributes.productdat ?? ""} ${attributes.producttim ?? ""}`.trim(),
    };
}
