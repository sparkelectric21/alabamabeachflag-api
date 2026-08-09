import { beaches } from "../config/BeachRegistry";
import type { HistoricalBeachArea } from "./types";

export const SOURCE_CONFIGURATION_VERSION = "beach-source-mappings-2026-08-08-v1";

const explicitAreas: Record<string, HistoricalBeachArea> = {
	"alabama-point": "orangeBeach",
	"cotton-bayou": "orangeBeach",
	"florida-point": "orangeBeach",
	"gulf-shores-public-beach": "gulfShores",
	"gulf-state-park-pavilion": "gulfShores",
	"little-lagoon-pass": "gulfShores",
	"fort-morgan-public-beach": "fortMorgan",
	"dauphin-island-public-beach": "dauphinIsland",
	"dauphin-island-east-end": "dauphinIsland",
};

export function beachAreaForId(beachId: string | undefined): HistoricalBeachArea | undefined {
	if (!beachId) return undefined;
	return explicitAreas[beachId] ?? beaches.find((beach) => beach.id === beachId)?.regionalCondition?.region;
}

export function ademStationForBeach(beachId: string | undefined): string | undefined {
	return beaches.find((beach) => beach.id === beachId)?.ademCode;
}

export function canonicalHistoricalProvider(provider: string, observationType: string): string {
	if (provider === "coops" || provider === "noaa_coops") return "noaa_coops";
	if (provider.toLowerCase() === "adem") return "adem";
	if (observationType === "beach_flag") {
		if (provider === "City of Gulf Shores") return "city_gulf_shores";
		if (provider === "City of Orange Beach") return "city_orange_beach";
		if (provider === "Estimated from nearby Gulf Shores conditions") return "derived_gulf_shores";
	}
	return provider;
}
