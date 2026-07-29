import type { MatchMethod } from "./types";

export interface VenueMapping {
	beachId: string;
	venues: string[];
	addresses: string[];
	sourceAliases?: Record<string, string[]>;
	excludes?: string[];
}

export type ExclusionReason = "inlandVenue" | "citywideOrBroadLocation" | "nearbyNotAtBeach" | "unsupportedVenue" | "unsupportedBeach" | "unknownVenue" | "ambiguousLocation" | "exactBeachNotRepresented";

export interface MatchExplanation {
	beachId?: string;
	method?: MatchMethod;
	confidence: "exact" | "none";
	ruleId: string;
	reason: string;
	exclusionReason?: ExclusionReason;
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
		venues: ["Gulf State Park Beach Pavilion", "Gulf State Park Pavilion", "Beach Pavilion"],
		addresses: ["22250 East Beach Blvd, Gulf Shores, AL 36542", "22250 E Beach Blvd, Gulf Shores, AL 36542"],
		sourceAliases: { gulfStatePark: [
			"Gulf State Park Beach Pavillion",
			"Gulf State Park Pavillion, 22250 E Beach Blvd, Gulf Shores, AL 36542, USA",
			"Gulf State Park Beach Pavilion, 22250 E Beach Blvd, Gulf Shores, AL 36542, USA",
			"Beach Pavilion, 22250 E Beach Blvd, Gulf Shores, AL 36542, USA",
		] },
		excludes: ["Gulf State Park Nature Center", "Gulf State Park Learning Campus", "Gulf State Park Campground", "Lake Shelby Picnic Area", "Gulf State Park Pier", "Lake Shelby Playground"],
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
		sourceAliases: { orangeBeachCoastalResources: ["Cotton Bayou Beach"] },
	},
	{
		beachId: "alabama-point",
		venues: ["Alabama Point East", "Alabama Point East Beach", "Perdido Pass Beach"],
		addresses: ["28105 Perdido Beach Blvd, Orange Beach, AL 36561"],
		sourceAliases: { orangeBeachCoastalResources: ["Alabama Point"] },
	},
	{
		beachId: "florida-point",
		venues: ["Florida Point Beach", "Florida Point"],
		addresses: [],
	},
	{
		beachId: "fort-morgan-public-beach",
		venues: ["Fort Morgan Public Beach", "Fort Morgan Beach", "Fort Morgan Beach Access"],
		addresses: [],
		sourceAliases: { alabamaCoastalCleanup: ["Fort Morgan Public Beach Cleanup Zone"] },
		excludes: ["Fort Morgan Historic Site", "Fort Morgan State Historic Site", "Mobile Bay Ferry - Fort Morgan", "Fort Morgan Campground"],
	},
	{
		beachId: "dauphin-island-public-beach",
		venues: ["Dauphin Island Public Beach", "Dauphin Island Middle Beach"],
		addresses: ["1501 Bienville Blvd, Dauphin Island, AL 36528"],
		sourceAliases: { alabamaCoastalCleanup: ["Dauphin Island Public Beach Cleanup Zone"], alabamaAudubon: ["Dauphin Island Middle Beach"] },
		excludes: ["Dauphin Island Sea Lab", "Alabama Aquarium", "Audubon Bird Sanctuary", "Fort Gaines", "Dauphin Island Town Hall"],
	},
	{
		beachId: "dauphin-island-east-end",
		venues: ["Dauphin Island East End Beach", "East End Beach"],
		addresses: ["51 Bienville Blvd, Dauphin Island, AL 36528"],
		sourceAliases: { alabamaCoastalCleanup: ["Dauphin Island East End Beach Cleanup Zone"] },
	},
];

const normalize = (value = "") => value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

const broadLocations = ["gulf shores", "orange beach", "dauphin island", "fort morgan", "various locations", "citywide", "alabama coast", "gulf coast"];
const unsupportedWestEnd = ["dauphin island west end beach", "west end beach"];
const inlandOrUnsupported = [
	"gulf state park nature center", "gulf state park learning campus", "gulf state park campground", "lake shelby picnic area", "lake shelby playground",
	"gulf state park pier", "fort morgan historic site", "fort morgan state historic site", "mobile bay ferry fort morgan", "fort morgan campground",
	"dauphin island sea lab", "alabama aquarium", "audubon bird sanctuary", "fort gaines", "dauphin island town hall", "the wharf",
	"gulf state park nature center orange beach al 36561 usa", "gulf state park nature center 22120 campground rd orange beach al 36561 usa",
	"gulf state park pier 20800 e beach blvd gulf shores al 36542 usa",
];

export function explainBeachMatch(input: { providerId: string; venue?: string; address?: string }): MatchExplanation {
	const venue = normalize(input.venue);
	const address = normalize(input.address);
	if (!venue && !address) return { confidence: "none", ruleId: "missing-location", reason: "No venue or address was supplied", exclusionReason: "unknownVenue" };
	if (unsupportedWestEnd.includes(venue)) return { confidence: "none", ruleId: "unsupported-dauphin-west-end", reason: "The exact beach is not represented in the app", exclusionReason: "exactBeachNotRepresented" };
	if (broadLocations.includes(venue)) return { confidence: "none", ruleId: "broad-location", reason: "City, island, or regional locations do not identify an exact beach", exclusionReason: "citywideOrBroadLocation" };
	if (inlandOrUnsupported.includes(venue)) return { confidence: "none", ruleId: `excluded-${venue.replace(/ /g, "-")}`, reason: "Known inland or unsupported venue", exclusionReason: "inlandVenue" };
	for (const mapping of VENUE_MAPPINGS) {
		if (mapping.excludes?.some((item) => normalize(item) === venue)) return { confidence: "none", ruleId: `excluded-${mapping.beachId}`, reason: "Known inland or unsupported venue", exclusionReason: "inlandVenue" };
		if (mapping.sourceAliases?.[input.providerId]?.some((item) => normalize(item) === venue)) return { beachId: mapping.beachId, method: "sourceAlias", confidence: "exact", ruleId: `${input.providerId}-${mapping.beachId}-venue-alias`, reason: "Exact source venue alias" };
		if (mapping.venues.some((item) => normalize(item) === venue)) return { beachId: mapping.beachId, method: "exactVenue", confidence: "exact", ruleId: `${mapping.beachId}-exact-venue`, reason: "Exact approved venue" };
		if (address && mapping.addresses.some((item) => normalize(item) === address)) return { beachId: mapping.beachId, method: "exactAddress", confidence: "exact", ruleId: `${mapping.beachId}-exact-address`, reason: "Exact approved address" };
	}
	return { confidence: "none", ruleId: "unknown-venue", reason: "Venue is not an approved exact beach alias", exclusionReason: "unknownVenue" };
}

export function exactBeachMatch(input: { providerId: string; venue?: string; address?: string }): { beachId: string; method: MatchMethod } | null {
	const explanation = explainBeachMatch(input);
	return explanation.beachId && explanation.method ? { beachId: explanation.beachId, method: explanation.method } : null;
}

export function dedupeKey(event: { title: string; startAt: string; beachId: string }): string {
	return `${normalize(event.title)}|${event.startAt.slice(0, 16)}|${event.beachId}`;
}
