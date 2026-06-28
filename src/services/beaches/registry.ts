

export interface BeachLocation {
	id: string;
	displayName: string;
	latitude: number;
	longitude: number;
}

export const BEACH_REGISTRY: BeachLocation[] = [
	{
		id: "gulf-shores-public-beach",
		displayName: "Gulf Shores Public Beach",
		latitude: 30.2499,
		longitude: -87.6847,
	},
	{
		id: "gulf-state-park-pavilion",
		displayName: "Gulf State Park Pavilion",
		latitude: 30.2499,
		longitude: -87.6847,
	},
	{
		id: "cotton-bayou",
		displayName: "Cotton Bayou",
		latitude: 30.2796,
		longitude: -87.5608,
	},
	{
		id: "alabama-point",
		displayName: "Alabama Point",
		latitude: 30.2804,
		longitude: -87.5585,
	},
	{
		id: "florida-point",
		displayName: "Florida Point",
		latitude: 30.2809,
		longitude: -87.5482,
	},
	{
		id: "little-lagoon-pass",
		displayName: "Little Lagoon Pass",
		latitude: 30.2328,
		longitude: -87.7428,
	},
	{
		id: "fort-morgan-public-beach",
		displayName: "Fort Morgan Public Beach",
		latitude: 30.2285,
		longitude: -88.0243,
	},
	{
		id: "dauphin-island-public-beach",
		displayName: "Dauphin Island Public Beach",
		latitude: 30.2506,
		longitude: -88.1096,
	},
	{
		id: "dauphin-island-east-end",
		displayName: "Dauphin Island East End",
		latitude: 30.2509,
		longitude: -88.0755,
	},
];