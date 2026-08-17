import type { OfficialAlertCategory } from "./types";

export interface NwsEventPolicy { category: OfficialAlertCategory; priority: number; rationale: string }

export const NWS_EVENT_POLICY = {
	"Rip Current Statement": { category: "ripCurrent", priority: 70, rationale: "Direct surf-zone life-safety hazard." },
	"High Surf Advisory": { category: "surf", priority: 50, rationale: "Dangerous breaking surf relevant to beach access." },
	"High Surf Warning": { category: "surf", priority: 75, rationale: "Severe surf threat relevant to beach access." },
	"Coastal Flood Advisory": { category: "coastalFlood", priority: 45, rationale: "Coastal inundation may affect beaches and access." },
	"Coastal Flood Warning": { category: "coastalFlood", priority: 80, rationale: "Serious coastal inundation threat." },
	"Coastal Flood Watch": { category: "coastalFlood", priority: 55, rationale: "Advance notice of possible coastal inundation." },
	"Storm Surge Warning": { category: "tropical", priority: 100, rationale: "Critical coastal inundation threat." },
	"Storm Surge Watch": { category: "tropical", priority: 75, rationale: "Advance notice of critical coastal inundation." },
	"Tropical Storm Warning": { category: "tropical", priority: 90, rationale: "Tropical wind and coastal hazard." },
	"Tropical Storm Watch": { category: "tropical", priority: 65, rationale: "Advance notice of tropical hazard." },
	"Hurricane Warning": { category: "tropical", priority: 100, rationale: "Critical tropical cyclone hazard." },
	"Hurricane Watch": { category: "tropical", priority: 80, rationale: "Advance notice of hurricane conditions." },
	"Tropical Cyclone Local Statement": { category: "tropical", priority: 60, rationale: "Local impacts and instructions accompanying tropical products." },
	"Extreme Wind Warning": { category: "severeWeather", priority: 100, rationale: "Immediate extreme wind threat." },
	"Flash Flood Warning": { category: "severeWeather", priority: 85, rationale: "Immediate flooding threat at the selected coastal region." },
	"Severe Thunderstorm Warning": { category: "severeWeather", priority: 75, rationale: "Immediate severe storm threat." },
	"Tornado Warning": { category: "severeWeather", priority: 100, rationale: "Immediate tornado threat." },
	"Special Marine Warning": { category: "marineWeather", priority: 80, rationale: "Immediate hazardous marine weather; explicitly not marine life." },
	"Beach Hazards Statement": { category: "surf", priority: 50, rationale: "NWS beach-specific hazard product." },
	"Tsunami Warning": { category: "tsunami", priority: 100, rationale: "Critical coastal inundation/current threat." },
	"Tsunami Advisory": { category: "tsunami", priority: 80, rationale: "Dangerous currents or waves at the coast." },
	"Tsunami Watch": { category: "tsunami", priority: 70, rationale: "Advance notice of possible tsunami threat." },
	"Heat Advisory": { category: "heat", priority: 55, rationale: "Dangerous heat exposure is directly relevant to beach visitors." },
	"Extreme Heat Warning": { category: "heat", priority: 85, rationale: "Critical heat exposure threat." },
	"Extreme Heat Watch": { category: "heat", priority: 65, rationale: "Advance notice of possible critical heat exposure." },
} as const satisfies Record<string, NwsEventPolicy>;

export type SupportedNwsEvent = keyof typeof NWS_EVENT_POLICY;
export function policyFor(event: string): NwsEventPolicy | null {
	return Object.prototype.hasOwnProperty.call(NWS_EVENT_POLICY, event) ? NWS_EVENT_POLICY[event as SupportedNwsEvent] : null;
}
