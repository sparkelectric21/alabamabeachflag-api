export const MAP_POI_SCHEMA_VERSION = 1 as const;
export const MAP_POI_CATALOG_VERSION = "2026-08-10.1";
export const MAP_POI_REGIONS = ["gulfShores", "orangeBeach", "fortMorgan", "dauphinIsland"] as const;
export const MAP_POI_CATEGORIES = ["beachAccess", "pier", "pavilion", "lifeguardTower", "waterAccess"] as const;

export type MapPOIRegion = typeof MAP_POI_REGIONS[number];
export type MapPOICategory = typeof MAP_POI_CATEGORIES[number];

export interface MapPOI {
	id: string;
	region: MapPOIRegion;
	category: MapPOICategory;
	enabled: boolean;
	coordinate: { latitude: number; longitude: number };
	display: {
		title: string;
		subtitle?: string;
		accessibilityLabel?: string;
		directionsEnabled?: boolean;
	};
	behavior?: {
		seasonal: boolean;
		staffingStatus: "notProvided";
	};
	relationships?: { beachGuideAccessPointID: string };
	provenance: {
		authority: string;
		sourceID: string;
		sourceTitle: string;
		sourceURL: string;
		coordinateSourceTitle?: string;
		verifiedOn: string;
		verificationMethod?: string;
	};
}

export interface MapPOICatalog {
	schemaVersion: typeof MAP_POI_SCHEMA_VERSION;
	catalogVersion: string;
	count: number;
	regions: MapPOIRegion[];
	pois: MapPOI[];
}

export class MapPOICatalogValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MapPOICatalogValidationError";
	}
}

const sources = {
	gsBeaches: ["gs-beaches", "Beaches", "City of Gulf Shores", "https://www.gulfshoresal.gov/beaches"],
	gspBeaches: ["gsp-beaches", "Gulf State Park Beaches", "Alabama State Parks", "https://www.alapark.com/parks/gulf-state-park/beaches"],
	gspPier: ["gsp-pier", "Gulf State Park Fishing and Education Pier", "Alabama State Parks", "https://www.alapark.com/parks/gulf-state-park/fishing-and-education-pier"],
	gspPavilion: ["gsp-pavilion", "Gulf State Park Beach Pavilion", "Alabama State Parks", "https://www.alapark.com/parks/gulf-state-park/beach-pavilion"],
	bonSecour: ["usfws-bon-secour", "Bon Secour National Wildlife Refuge — Visit Us", "U.S. Fish and Wildlife Service", "https://www.fws.gov/refuge/bon-secour/visit-us"],
	diBeaches: ["di-beaches", "Beaches", "Town of Dauphin Island", "https://www.townofdauphinisland.org/beaches"],
	diWestEnd: ["di-west-end", "West End Beach", "Town of Dauphin Island", "https://www.townofdauphinisland.org/things-to-do/west-end-beach"],
} as const;

type Source = readonly [id: string, title: string, authority: string, url: string];

function accessPOI(
	id: string,
	title: string,
	region: MapPOIRegion,
	category: MapPOICategory,
	latitude: number,
	longitude: number,
	coordinateSourceTitle: string,
	source: Source,
): MapPOI {
	return {
		id,
		region,
		category,
		enabled: true,
		coordinate: { latitude, longitude },
		display: { title, subtitle: source[2], directionsEnabled: true },
		relationships: { beachGuideAccessPointID: id },
		provenance: {
			authority: source[2],
			sourceID: source[0],
			sourceTitle: source[1],
			sourceURL: source[3],
			coordinateSourceTitle,
			verifiedOn: "2026-08-10",
		},
	};
}

const beachGuidePOIs: MapPOI[] = [
	accessPOI("gs-lagoon-pass", "Lagoon Pass", "gulfShores", "beachAccess", 30.241812, -87.737364, "Apple Maps — 1660 West Beach Boulevard", sources.gsBeaches),
	accessPOI("gs-west-13th", "West 13th Street Beach Access", "gulfShores", "beachAccess", 30.242293, -87.730888, "Apple Maps — 1499 West Beach Boulevard", sources.gsBeaches),
	accessPOI("gs-west-12th", "West 12th Street Beach Access", "gulfShores", "beachAccess", 30.243331, -87.722356, "Apple Maps — West Beach Boulevard at West 12th Street", sources.gsBeaches),
	accessPOI("gs-west-10th", "West 10th Street Beach Access", "gulfShores", "beachAccess", 30.244027, -87.716654, "Apple Maps — 1199 West Beach Boulevard", sources.gsBeaches),
	accessPOI("gs-west-6th", "West 6th Street Beach Access", "gulfShores", "beachAccess", 30.246446, -87.700218, "Apple Maps — 699 West Beach Boulevard", sources.gsBeaches),
	accessPOI("gs-west-5th", "West 5th Street Beach Access", "gulfShores", "beachAccess", 30.246770, -87.698568, "Apple Maps — 599 West Beach Boulevard", sources.gsBeaches),
	accessPOI("gs-west-4th", "West 4th Street Beach Access", "gulfShores", "beachAccess", 30.247182, -87.696941, "Apple Maps — West Beach Boulevard at West 4th Street", sources.gsBeaches),
	accessPOI("gs-gulf-place", "Gulf Place West and East", "gulfShores", "beachAccess", 30.248332, -87.688653, "Apple Maps — Gulf Place parking", sources.gsBeaches),
	accessPOI("gsp-fishing-education-pier", "Gulf State Park Pier", "gulfShores", "pier", 30.249960, -87.668190, "Alabama DCNR Public Access Sites — FID 99", sources.gspPier),
	accessPOI("gsp-beach-pavilion", "Gulf State Park Beach Pavilion", "gulfShores", "pavilion", 30.25517036, -87.64240986, "Geographic Response Plan AL-25", sources.gspPavilion),
	accessPOI("ob-romar", "Romar Beach Access", "orangeBeach", "beachAccess", 30.264641, -87.606820, "Apple Maps — 24450 Perdido Beach Boulevard", sources.gspBeaches),
	accessPOI("ob-cotton-bayou", "Cotton Bayou Beach Access", "orangeBeach", "beachAccess", 30.269777, -87.582456, "Apple Maps — 25900 Perdido Beach Boulevard", sources.gspBeaches),
	accessPOI("ob-alabama-point-east", "Alabama Point East", "orangeBeach", "beachAccess", 30.276754, -87.550816, "Apple Maps — 28100 Perdido Beach Boulevard", sources.gspBeaches),
	accessPOI("ob-shell-beach", "Shell Beach Access", "orangeBeach", "beachAccess", 30.277784, -87.555281, "Apple Maps — 28282 Perdido Beach Boulevard", sources.gspBeaches),
	accessPOI("fort-morgan-mobile-street", "Fort Morgan Beach — Mobile Street Access", "fortMorgan", "beachAccess", 30.229833, -87.831410, "Mobile Street Beach Access parking lot", sources.bonSecour),
	accessPOI("di-east-end", "Dauphin Island East End Beach", "dauphinIsland", "beachAccess", 30.246850, -88.075680, "Apple Maps — East End Beach Public Parking", sources.diBeaches),
	accessPOI("di-middle", "Middle Beach", "dauphinIsland", "beachAccess", 30.250144, -88.127458, "Apple Maps — 1551 Bienville Boulevard", sources.diBeaches),
	accessPOI("di-bienville", "Bienville Beach", "dauphinIsland", "beachAccess", 30.250645, -88.136241, "Apple Maps — 1917 Bienville Boulevard", sources.diBeaches),
	accessPOI("di-west-end", "West End Beach", "dauphinIsland", "beachAccess", 30.248769, -88.191554, "Apple Maps — public entrance at 2941 Bienville Boulevard", sources.diWestEnd),
];

const specialPOIs: MapPOI[] = [{
	id: "di-east-end-landing",
	region: "dauphinIsland",
	category: "pier",
	enabled: true,
	coordinate: { latitude: 30.2508027778, longitude: -88.0758944444 },
	display: { title: "Dauphin Island East End Landing", subtitle: "Town of Dauphin Island", directionsEnabled: true },
	provenance: {
		authority: "Town of Dauphin Island",
		sourceID: "di-beaches",
		sourceTitle: "Town of Dauphin Island Beaches",
		sourceURL: "https://www.townofdauphinisland.org/beaches",
		coordinateSourceTitle: "Town-published coordinate: 30° 15′02.89″ N, 88° 04′33.22″ W",
		verifiedOn: "2026-08-10",
	},
}];

const towerLocations = [
	[1, "Shell Beach", 30.2756149, -87.5423135],
	[2, "Alabama Point East", 30.2763488, -87.5524452],
	[3, "Cotton Bayou", 30.2691727, -87.5824031],
	[4, "Orange Beach Resident Beach", 30.2678412, -87.5874991],
	[5, "Romar Beach", 30.2625391, -87.6070963],
	[6, "Near The Oasis at Orange Beach", 30.2580614, -87.6252913],
] as const;

const lifeguardPOIs: MapPOI[] = towerLocations.map(([number, location, latitude, longitude]) => ({
	id: `orange-beach-tower-${number}`,
	region: "orangeBeach",
	category: "lifeguardTower",
	enabled: true,
	coordinate: { latitude, longitude },
	display: {
		title: `Lifeguard Tower ${number}`,
		subtitle: location,
		accessibilityLabel: `Lifeguard Tower ${number}, Seasonal Lifeguard Tower, ${location}`,
		directionsEnabled: false,
	},
	behavior: { seasonal: true, staffingStatus: "notProvided" },
	provenance: {
		authority: "City of Orange Beach",
		sourceID: "orange-beach-surf-rescue-tower-map",
		sourceTitle: "City of Orange Beach Surf Rescue tower map",
		sourceURL: "https://www.orangebeachal.gov/170/Beach-Safety-Mollys-Patrol",
		verifiedOn: "2026-08-08",
	},
}));

export const mapPOICatalog: MapPOICatalog = {
	schemaVersion: MAP_POI_SCHEMA_VERSION,
	catalogVersion: MAP_POI_CATALOG_VERSION,
	regions: [...MAP_POI_REGIONS],
	count: beachGuidePOIs.length + specialPOIs.length + lifeguardPOIs.length,
	pois: [...beachGuidePOIs, ...specialPOIs, ...lifeguardPOIs],
};

export const VERIFIED_BEACH_GUIDE_ACCESS_POINT_IDS = new Set(beachGuidePOIs.map(({ id }) => id));

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_POIS = 500;
const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 500;
const COAST_BOUNDS = { south: 29.5, north: 31.5, west: -89.5, east: -86.0 };
const LIVE_STAFFING_PATTERN = /\b(on[ -]?duty|currently staffed|staffed now|live staffing|lifeguard present)\b/i;

function requiredText(value: unknown, name: string, maximum = MAX_TEXT_LENGTH): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
		throw new MapPOICatalogValidationError(`${name} must be nonempty and at most ${maximum} characters.`);
	}
}

function validDate(value: string): boolean {
	const match = DATE_PATTERN.exec(value);
	if (!match) return false;
	const date = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function validateMapPOICatalog(value: unknown): asserts value is MapPOICatalog {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new MapPOICatalogValidationError("Catalog must be an object.");
	const catalog = value as MapPOICatalog;
	if (catalog.schemaVersion !== MAP_POI_SCHEMA_VERSION) throw new MapPOICatalogValidationError("Unsupported schemaVersion.");
	requiredText(catalog.catalogVersion, "catalogVersion", 64);
	if (!Array.isArray(catalog.regions) || catalog.regions.length !== MAP_POI_REGIONS.length || new Set(catalog.regions).size !== MAP_POI_REGIONS.length || catalog.regions.some((region) => !MAP_POI_REGIONS.includes(region))) {
		throw new MapPOICatalogValidationError("regions must contain each supported schema-1 region exactly once.");
	}
	if (!Array.isArray(catalog.pois) || catalog.pois.length > MAX_POIS) throw new MapPOICatalogValidationError(`pois must contain at most ${MAX_POIS} records.`);
	if (!Number.isSafeInteger(catalog.count) || catalog.count !== catalog.pois.length) throw new MapPOICatalogValidationError("count must equal pois.length.");
	const ids = new Set<string>();
	const enabledRelationships = new Set<string>();
	for (const [index, poi] of catalog.pois.entries()) {
		const prefix = `pois[${index}]`;
		requiredText(poi?.id, `${prefix}.id`, MAX_ID_LENGTH);
		if (!ID_PATTERN.test(poi.id)) throw new MapPOICatalogValidationError(`${prefix}.id has an invalid stable-ID format.`);
		if (ids.has(poi.id)) throw new MapPOICatalogValidationError(`Duplicate POI id: ${poi.id}.`);
		ids.add(poi.id);
		if (!MAP_POI_REGIONS.includes(poi.region)) throw new MapPOICatalogValidationError(`${prefix}.region is unsupported.`);
		if (!MAP_POI_CATEGORIES.includes(poi.category)) throw new MapPOICatalogValidationError(`${prefix}.category is unsupported.`);
		if (typeof poi.enabled !== "boolean") throw new MapPOICatalogValidationError(`${prefix}.enabled must be boolean.`);
		const { latitude, longitude } = poi.coordinate ?? {};
		if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new MapPOICatalogValidationError(`${prefix}.coordinate must be finite.`);
		if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new MapPOICatalogValidationError(`${prefix}.coordinate exceeds global bounds.`);
		if (latitude < COAST_BOUNDS.south || latitude > COAST_BOUNDS.north || longitude < COAST_BOUNDS.west || longitude > COAST_BOUNDS.east) throw new MapPOICatalogValidationError(`${prefix}.coordinate is outside the Alabama Gulf Coast sanity envelope.`);
		requiredText(poi.display?.title, `${prefix}.display.title`, 160);
		if (poi.display.subtitle !== undefined) requiredText(poi.display.subtitle, `${prefix}.display.subtitle`, 160);
		if (poi.display.accessibilityLabel !== undefined) requiredText(poi.display.accessibilityLabel, `${prefix}.display.accessibilityLabel`, 240);
		if (poi.display.directionsEnabled !== undefined && typeof poi.display.directionsEnabled !== "boolean") throw new MapPOICatalogValidationError(`${prefix}.display.directionsEnabled must be boolean.`);
		const provenance = poi.provenance;
		requiredText(provenance?.authority, `${prefix}.provenance.authority`, 160);
		requiredText(provenance?.sourceID, `${prefix}.provenance.sourceID`, MAX_ID_LENGTH);
		requiredText(provenance?.sourceTitle, `${prefix}.provenance.sourceTitle`, 240);
		requiredText(provenance?.sourceURL, `${prefix}.provenance.sourceURL`, MAX_TEXT_LENGTH);
		let sourceURL: URL;
		try { sourceURL = new URL(provenance.sourceURL); } catch { throw new MapPOICatalogValidationError(`${prefix}.provenance.sourceURL is invalid.`); }
		if (sourceURL.protocol !== "https:") throw new MapPOICatalogValidationError(`${prefix}.provenance.sourceURL must use HTTPS.`);
		if (!validDate(provenance.verifiedOn)) throw new MapPOICatalogValidationError(`${prefix}.provenance.verifiedOn must be a real YYYY-MM-DD date.`);
		if (provenance.coordinateSourceTitle !== undefined) requiredText(provenance.coordinateSourceTitle, `${prefix}.provenance.coordinateSourceTitle`, 240);
		if (provenance.verificationMethod !== undefined) requiredText(provenance.verificationMethod, `${prefix}.provenance.verificationMethod`, 240);
		const relationship = poi.relationships?.beachGuideAccessPointID;
		if (relationship !== undefined) {
			requiredText(relationship, `${prefix}.relationships.beachGuideAccessPointID`, MAX_ID_LENGTH);
			if (!VERIFIED_BEACH_GUIDE_ACCESS_POINT_IDS.has(relationship)) throw new MapPOICatalogValidationError(`${prefix} references an unknown bundled Beach Guide access point.`);
			if (poi.enabled && enabledRelationships.has(relationship)) throw new MapPOICatalogValidationError(`Duplicate enabled Beach Guide relationship: ${relationship}.`);
			if (poi.enabled) enabledRelationships.add(relationship);
		}
		if (poi.category === "lifeguardTower") {
			if (poi.behavior?.seasonal !== true || poi.behavior.staffingStatus !== "notProvided") throw new MapPOICatalogValidationError(`${prefix} must preserve seasonal, informational-only lifeguard semantics.`);
			const wording = [poi.display.title, poi.display.subtitle, poi.display.accessibilityLabel].filter(Boolean).join(" ");
			if (LIVE_STAFFING_PATTERN.test(wording)) throw new MapPOICatalogValidationError(`${prefix} must not imply live lifeguard staffing.`);
		}
	}
}

function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
}

export function canonicalMapPOICatalogContent(catalog: MapPOICatalog): string {
	return canonicalize({
		schemaVersion: catalog.schemaVersion,
		catalogVersion: catalog.catalogVersion,
		count: catalog.count,
		regions: catalog.regions,
		pois: catalog.pois,
	});
}

export async function mapPOICatalogFingerprint(catalog: MapPOICatalog): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalMapPOICatalogContent(catalog));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
