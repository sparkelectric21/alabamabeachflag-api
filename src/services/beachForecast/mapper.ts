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
        surf: attributes.surf ?? "",
        weather: attributes.weather ?? "",
        winds: attributes.winds ?? "",
        waterTemperature: attributes.wtemp ?? "",
        maxTemperature: attributes.maxtemp ?? "",
        thunderstormRisk: attributes.tstorm ?? "",
        waterspoutRisk: attributes.wspout ?? "",
        uvValue:
            attributes.uvindex != null
                ? Number(attributes.uvindex)
                : attributes.uv != null
                    ? Number(attributes.uv)
                    : undefined,
        uvCategory: attributes.uvcat ?? attributes.uvcategory ?? undefined,
        period: attributes.period ?? "",
        issuedAt: `${attributes.productdat ?? ""} ${attributes.producttim ?? ""}`.trim(),
    };
}
