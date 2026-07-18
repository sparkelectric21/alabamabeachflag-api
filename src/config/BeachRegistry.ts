export type BeachUVRegion = "orangeBeach" | "fortMorgan" | "dauphinIsland";

export interface WaterTemperatureSourceConfiguration {
	sources: Array<{
		provider: "coops" | "ndbc";
		stationId: string;
	}>;
}

export type VibrioCoveragePolicy =
	| {
		eligible: true;
		waterTemperature: WaterTemperatureSourceConfiguration;
		limitation: string;
	}
	| {
		eligible: false;
		reason: string;
		mappingLocation?: {
			latitude: number;
			longitude: number;
			source: string;
		};
	};

export interface BeachDefinition {
	id: string;
	ademCode: string;
	displayName: string;
	waterbody: string;
	location: {
		latitude: number;
		longitude: number;
	};
	weather: {
		latitude: number;
		longitude: number;
	};
	uv?: {
		region: BeachUVRegion;
		latitude: number;
		longitude: number;
	};
	waterTemperature?: WaterTemperatureSourceConfiguration;
	vibrioConditions: VibrioCoveragePolicy;
	beachForecast?: {
		siteId: string;
	};
	ripCurrent?: {
		forecastZone: string;
	};
	alerts?: {
		nwsZone: string;
	};
	supports: {
		beachFlags: "official" | "unavailable" | "future";
		waterQuality: boolean;
		weather: boolean;
		alerts: boolean;
		uv: boolean;
		waterTemperature: boolean;
		ripCurrent: boolean;
	};
}

export const beaches: BeachDefinition[] = [
	{
		id: "alabama-point",
		ademCode: "AL_PT",
		displayName: "Alabama Point",
		waterbody: "Gulf of Mexico",
		location: {
			latitude: 30.2804,
			longitude: -87.5585,
		},
		weather: {
			latitude: 30.2804,
			longitude: -87.5585,
		},
		uv: {
			region: "orangeBeach",
			latitude: 30.248108,
			longitude: -87.71726,
		},
		waterTemperature: {
			sources: [
				{ provider: "ndbc", stationId: "PPTA1" },
				{ provider: "coops", stationId: "8735180" },
			],
		},
		vibrioConditions: {
			eligible: true,
			waterTemperature: { sources: [
				{ provider: "ndbc", stationId: "PPTA1" },
				{ provider: "coops", stationId: "8735180" },
			] },
			limitation: "Perdido Pass observations are nearby proxies, not measurements at this beach.",
		},
		beachForecast: {
			siteId: "alz266",
		},
		ripCurrent: {
			forecastZone: "ALZ266",
		},
		supports: {
			beachFlags: "official",
			waterQuality: true,
			weather: true,
			alerts: true,
			uv: true,
			waterTemperature: true,
			ripCurrent: true,
		},
	},
	{
		id: "cotton-bayou",
		ademCode: "COT_BYOU",
		displayName: "Cotton Bayou",
		waterbody: "Gulf of Mexico",
		location: {
			latitude: 30.2796,
			longitude: -87.5608,
		},
		weather: {
			latitude: 30.2796,
			longitude: -87.5608,
		},
		uv: {
			region: "orangeBeach",
			latitude: 30.248108,
			longitude: -87.71726,
		},
		waterTemperature: {
			sources: [
				{ provider: "ndbc", stationId: "PPTA1" },
				{ provider: "coops", stationId: "8735180" },
			],
		},
		vibrioConditions: {
			eligible: true,
			waterTemperature: { sources: [
				{ provider: "ndbc", stationId: "PPTA1" },
				{ provider: "coops", stationId: "8735180" },
			] },
			limitation: "Perdido Pass observations are nearby proxies, not measurements at this beach.",
		},
		beachForecast: {
			siteId: "alz266",
		},
		ripCurrent: {
			forecastZone: "ALZ266",
		},
		supports: {
			beachFlags: "official",
			waterQuality: true,
			weather: true,
			alerts: true,
			uv: true,
			waterTemperature: true,
			ripCurrent: true,
		},
	},
	{
		id: "gulf-shores-public-beach",
		ademCode: "CITY_GS",
		displayName: "Gulf Shores Public Beach",
		waterbody: "Gulf of Mexico",
		location: {
			latitude: 30.2499,
			longitude: -87.6847,
		},
		weather: {
			latitude: 30.2499,
			longitude: -87.6847,
		},
		uv: {
			region: "orangeBeach",
			latitude: 30.248108,
			longitude: -87.71726,
		},
		waterTemperature: {
			sources: [
				{ provider: "ndbc", stationId: "BSCA1" },
				{ provider: "ndbc", stationId: "PPTA1" },
				{ provider: "coops", stationId: "8735180" },
			],
		},
		vibrioConditions: {
			eligible: true,
			waterTemperature: { sources: [
				{ provider: "ndbc", stationId: "PPTA1" },
				{ provider: "coops", stationId: "8735180" },
			] },
			limitation: "Perdido Pass and Mobile Bay entrance observations are proxies, not Gulf Shores beach measurements.",
		},
		beachForecast: {
			siteId: "alz266",
		},
		ripCurrent: {
			forecastZone: "ALZ266",
		},
		supports: {
			beachFlags: "official",
			waterQuality: true,
			weather: true,
			alerts: true,
			uv: true,
			waterTemperature: true,
			ripCurrent: true,
		},
	},
	{
		id: "gulf-state-park-pavilion",
		ademCode: "GSP_PAV",
		displayName: "Gulf State Park Pavilion",
		waterbody: "Gulf of Mexico",
		location: {
			latitude: 30.2499,
			longitude: -87.6847,
		},
		weather: {
			latitude: 30.2499,
			longitude: -87.6847,
		},
		uv: {
			region: "orangeBeach",
			latitude: 30.248108,
			longitude: -87.71726,
		},
		waterTemperature: {
			sources: [
				{ provider: "ndbc", stationId: "BSCA1" },
				{ provider: "ndbc", stationId: "PPTA1" },
				{ provider: "coops", stationId: "8735180" },
			],
		},
		vibrioConditions: {
			eligible: false,
			reason: "Corrected Pavilion coordinates and NOAA proxy mapping require external validation before public output.",
			mappingLocation: {
				latitude: 30.25517036,
				longitude: -87.64240986,
				source: "Alabama State Parks address; federal Geographic Response Plan site AL-25 coordinates",
			},
		},
		beachForecast: {
			siteId: "alz266",
		},
		ripCurrent: {
			forecastZone: "ALZ266",
		},
		supports: {
			beachFlags: "official",
			waterQuality: true,
			weather: true,
			alerts: true,
			uv: true,
			waterTemperature: true,
			ripCurrent: true,
		},
	},
	{
		id: "little-lagoon-pass",
		ademCode: "LL_PASS",
		displayName: "Little Lagoon Pass",
		waterbody: "Gulf of Mexico",
		location: {
			latitude: 30.2328,
			longitude: -87.7428,
		},
		weather: {
			latitude: 30.2328,
			longitude: -87.7428,
		},
		uv: {
			region: "orangeBeach",
			latitude: 30.248108,
			longitude: -87.71726,
		},
		waterTemperature: {
			sources: [
				{ provider: "ndbc", stationId: "BSCA1" },
				{ provider: "ndbc", stationId: "PPTA1" },
				{ provider: "coops", stationId: "8735180" },
			],
		},
		vibrioConditions: {
			eligible: false,
			reason: "The lagoon-pass environment lacks a validated approved direct-observation proxy.",
		},
		beachForecast: {
			siteId: "alz266",
		},
		ripCurrent: {
			forecastZone: "ALZ266",
		},
		supports: {
			beachFlags: "official",
			waterQuality: true,
			weather: true,
			alerts: true,
			uv: true,
			waterTemperature: true,
			ripCurrent: true,
		},
	},
	{
		id: "florida-point",
		ademCode: "FL_PT",
		displayName: "Florida Point",
		waterbody: "Perdido Pass",
		location: {
			latitude: 30.2809,
			longitude: -87.5482,
		},
		weather: {
			latitude: 30.2809,
			longitude: -87.5482,
		},
		uv: {
			region: "orangeBeach",
			latitude: 30.248108,
			longitude: -87.71726,
		},
		waterTemperature: {
			sources: [
				{ provider: "ndbc", stationId: "PPTA1" },
				{ provider: "coops", stationId: "8735180" },
			],
		},
		vibrioConditions: {
			eligible: true,
			waterTemperature: { sources: [
				{ provider: "ndbc", stationId: "PPTA1" },
				{ provider: "coops", stationId: "8735180" },
			] },
			limitation: "Perdido Pass observations are nearby proxies, not measurements at this beach.",
		},
		beachForecast: {
			siteId: "alz266",
		},
		ripCurrent: {
			forecastZone: "ALZ266",
		},
		supports: {
			beachFlags: "official",
			waterQuality: true,
			weather: true,
			alerts: true,
			uv: true,
			waterTemperature: true,
			ripCurrent: true,
		},
	},
	{
		id: "fort-morgan-public-beach",
		ademCode: "FRT_MGN",
		displayName: "Fort Morgan Public Beach",
		waterbody: "Gulf of Mexico",
		location: {
			latitude: 30.2285,
			longitude: -88.0243,
		},
		weather: {
			latitude: 30.2285,
			longitude: -88.0243,
		},
		uv: {
			region: "fortMorgan",
			latitude: 30.2285,
			longitude: -88.0243,
		},
		waterTemperature: {
			sources: [
				{ provider: "ndbc", stationId: "DPHA1" },
				{ provider: "coops", stationId: "8735180" },
				{ provider: "ndbc", stationId: "PPTA1" },
			],
		},
		vibrioConditions: {
			eligible: true,
			waterTemperature: { sources: [
				{ provider: "ndbc", stationId: "DPHA1" },
				{ provider: "coops", stationId: "8735180" },
			] },
			limitation: "Dauphin Island/Mobile Bay entrance observations are proxies, not Fort Morgan beach measurements.",
		},
		beachForecast: {
			siteId: "alz266",
		},
		ripCurrent: {
			forecastZone: "ALZ266",
		},
		supports: {
			beachFlags: "future",
			waterQuality: true,
			weather: true,
			alerts: true,
			uv: true,
			waterTemperature: true,
			ripCurrent: true,
		},
	},
	{
		id: "dauphin-island-public-beach",
		ademCode: "DI_PIER",
		displayName: "Dauphin Island Public Beach",
		waterbody: "Gulf of Mexico",
		location: {
			latitude: 30.2506,
			longitude: -88.1096,
		},
		weather: {
			latitude: 30.2506,
			longitude: -88.1096,
		},
		uv: {
			region: "dauphinIsland",
			latitude: 30.2506,
			longitude: -88.1096,
		},
		waterTemperature: {
			sources: [
				{ provider: "coops", stationId: "8735180" },
				{ provider: "ndbc", stationId: "DPHA1" },
			],
		},
		vibrioConditions: {
			eligible: true,
			waterTemperature: { sources: [
				{ provider: "coops", stationId: "8735180" },
				{ provider: "ndbc", stationId: "DPHA1" },
			] },
			limitation: "East-end Dauphin Island observations are proxies for the public beach farther west.",
		},
		beachForecast: {
			siteId: "alz265",
		},
		ripCurrent: {
			forecastZone: "ALZ265",
		},
		supports: {
			beachFlags: "unavailable",
			waterQuality: true,
			weather: true,
			alerts: true,
			uv: true,
			waterTemperature: true,
			ripCurrent: true,
		},
	},
	{
		id: "dauphin-island-east-end",
		ademCode: "DI_EAST",
		displayName: "Dauphin Island East End",
		waterbody: "Gulf of Mexico",
		location: {
			latitude: 30.2509,
			longitude: -88.0755,
		},
		weather: {
			latitude: 30.2509,
			longitude: -88.0755,
		},
		uv: {
			region: "dauphinIsland",
			latitude: 30.2506,
			longitude: -88.1096,
		},
		waterTemperature: {
			sources: [
				{ provider: "ndbc", stationId: "DPHA1" },
				{ provider: "coops", stationId: "8735180" },
			],
		},
		vibrioConditions: {
			eligible: true,
			waterTemperature: { sources: [
				{ provider: "ndbc", stationId: "DPHA1" },
				{ provider: "coops", stationId: "8735180" },
			] },
			limitation: "These east-end Dauphin Island stations are a strong spatial match but remain point observations.",
		},
		beachForecast: {
			siteId: "alz265",
		},
		ripCurrent: {
			forecastZone: "ALZ265",
		},
		supports: {
			beachFlags: "unavailable",
			waterQuality: true,
			weather: true,
			alerts: true,
			uv: true,
			waterTemperature: true,
			ripCurrent: true,
		},
	},
];
