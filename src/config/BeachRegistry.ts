

export interface BeachDefinition {
	id: string;
	ademCode: string;
	displayName: string;
	waterbody: string;
	supports: {
		beachFlags: "official" | "unavailable" | "future";
		waterQuality: boolean;
		weather: boolean;
		alerts: boolean;
	};
}

export const beaches: BeachDefinition[] = [
	{
		id: "alabama-point",
		ademCode: "AL_PT",
		displayName: "Alabama Point",
		waterbody: "Gulf of Mexico",
		supports: {
			beachFlags: "official",
			waterQuality: true,
			weather: true,
			alerts: true,
		},
	},
	{
		id: "cotton-bayou",
		ademCode: "COT_BYOU",
		displayName: "Cotton Bayou",
		waterbody: "Gulf of Mexico",
		supports: {
			beachFlags: "official",
			waterQuality: true,
			weather: true,
			alerts: true,
		},
	},
	{
		id: "gulf-shores-public-beach",
		ademCode: "CITY_GS",
		displayName: "Gulf Shores Public Beach",
		waterbody: "Gulf of Mexico",
		supports: {
			beachFlags: "official",
			waterQuality: true,
			weather: true,
			alerts: true,
		},
	},
	{
		id: "gulf-state-park-pavilion",
		ademCode: "GSP_PAV",
		displayName: "Gulf State Park Pavilion",
		waterbody: "Gulf of Mexico",
		supports: {
			beachFlags: "official",
			waterQuality: true,
			weather: true,
			alerts: true,
		},
	},
	{
		id: "little-lagoon-pass",
		ademCode: "LL_PASS",
		displayName: "Little Lagoon Pass",
		waterbody: "Gulf of Mexico",
		supports: {
			beachFlags: "official",
			waterQuality: true,
			weather: true,
			alerts: true,
		},
	},
	{
		id: "florida-point",
		ademCode: "FL_PT",
		displayName: "Florida Point",
		waterbody: "Perdido Pass",
		supports: {
			beachFlags: "official",
			waterQuality: true,
			weather: true,
			alerts: true,
		},
	},
	{
		id: "fort-morgan-public-beach",
		ademCode: "FRT_MGN",
		displayName: "Fort Morgan Public Beach",
		waterbody: "Gulf of Mexico",
		supports: {
			beachFlags: "future",
			waterQuality: true,
			weather: true,
			alerts: true,
		},
	},
	{
		id: "dauphin-island-public-beach",
		ademCode: "DI_PIER",
		displayName: "Dauphin Island Public Beach",
		waterbody: "Gulf of Mexico",
		supports: {
			beachFlags: "unavailable",
			waterQuality: true,
			weather: true,
			alerts: true,
		},
	},
	{
		id: "dauphin-island-east-end",
		ademCode: "DI_EAST",
		displayName: "Dauphin Island East End",
		waterbody: "Gulf of Mexico",
		supports: {
			beachFlags: "unavailable",
			waterQuality: true,
			weather: true,
			alerts: true,
		},
	},
];