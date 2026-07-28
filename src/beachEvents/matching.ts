import type { MatchMethod } from "./types";

export interface VenueMapping {
	beachId: string;
	venues: string[];
	addresses: string[];
	sourceAliases?: Record<string, string[]>;
	excludes?: string[];
}

// Only aliases proven to refer to an existing backend beach are listed. Coordinates
// are intentionally absent: they may validate a future proposal but never create one.
export const VENUE_MAPPINGS: VenueMapping[] = [
	{
		beachId: "gulf-shores-public-beach",
		venues: ["Gulf Shores Public Beach", "Gulf Shores Main Public Beach", "Gulf Place", "Town Green at Gulf Place", "Gulf Shores Public Beach/The Hangout"],
		addresses: ["101 E Beach Blvd, Gulf Shores, AL 36542", "101 East Beach Boulevard, Gulf Shores, AL 36542"],
		sourceAliases: { gulfShoresCity: ["Gulf Place Town Green", "Gulf Place Public Beach"] },
		excludes: ["Meyer Park", "Erie H. Meyer Civic Center", "Gulf Shores Museum", "Gulf Shores Public Library"],
	},
	{
		beachId: "gulf-state-park-pavilion",
		venues: ["Gulf State Park Beach Pavilion", "Gulf State Park Pavilion"],
		addresses: ["22250 East Beach Blvd, Gulf Shores, AL 36542", "22250 E Beach Blvd, Gulf Shores, AL 36542"],
		excludes: ["Gulf State Park Nature Center", "Gulf State Park Learning Campus", "Gulf State Park Campground"],
	},
	{
		beachId: "little-lagoon-pass",
		venues: ["Little Lagoon Pass", "Little Lagoon Pass Park"],
		addresses: ["1660 W Beach Blvd, Gulf Shores, AL 36542"],
	},
	{
		beachId: "cotton-bayou",
		venues: ["Cotton Bayou Public Beach", "Cotton Bayou Beach Access"],
		addresses: ["25900 Perdido Beach Blvd, Orange Beach, AL 36561"],
	},
	{
		beachId: "alabama-point",
		venues: ["Alabama Point East", "Alabama Point East Beach", "Perdido Pass Beach"],
		addresses: ["28105 Perdido Beach Blvd, Orange Beach, AL 36561"],
	},
	{
		beachId: "florida-point",
		venues: ["Florida Point Beach", "Florida Point"],
		addresses: [],
	},
	{
		beachId: "fort-morgan-public-beach",
		venues: ["Fort Morgan Public Beach", "Fort Morgan Beach"],
		addresses: [],
		excludes: ["Fort Morgan Historic Site"],
	},
	{
		beachId: "dauphin-island-public-beach",
		venues: ["Dauphin Island Public Beach", "Dauphin Island Middle Beach"],
		addresses: ["1501 Bienville Blvd, Dauphin Island, AL 36528"],
		excludes: ["Dauphin Island Sea Lab", "Alabama Aquarium"],
	},
	{
		beachId: "dauphin-island-east-end",
		venues: ["Dauphin Island East End Beach", "East End Beach"],
		addresses: ["51 Bienville Blvd, Dauphin Island, AL 36528"],
	},
];

const normalize = (value = "") => value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

export function exactBeachMatch(input: { providerId: string; venue?: string; address?: string }): { beachId: string; method: MatchMethod } | null {
	const venue = normalize(input.venue);
	const address = normalize(input.address);
	for (const mapping of VENUE_MAPPINGS) {
		if (mapping.excludes?.some((item) => normalize(item) === venue)) return null;
		if (mapping.sourceAliases?.[input.providerId]?.some((item) => normalize(item) === venue)) return { beachId: mapping.beachId, method: "sourceAlias" };
		if (mapping.venues.some((item) => normalize(item) === venue)) return { beachId: mapping.beachId, method: "exactVenue" };
		if (address && mapping.addresses.some((item) => normalize(item) === address)) return { beachId: mapping.beachId, method: "exactAddress" };
	}
	return null;
}

export function dedupeKey(event: { title: string; startAt: string; beachId: string }): string {
	return `${normalize(event.title)}|${event.startAt.slice(0, 16)}|${event.beachId}`;
}
