import { beaches } from "../config/BeachRegistry";
import { VENUE_MAPPINGS } from "./matching";
import { BEACH_EVENT_PROVIDERS } from "./providers";

const area = (id: string) => id.startsWith("dauphin-island") ? "Dauphin Island" : id === "fort-morgan-public-beach" ? "Fort Morgan" : ["cotton-bayou", "alabama-point", "florida-point"].includes(id) ? "Orange Beach" : "Gulf Shores";

export const beachReferences = beaches.map((beach) => {
	const mapping = VENUE_MAPPINGS.find((item) => item.beachId === beach.id);
	const providers = BEACH_EVENT_PROVIDERS.filter((provider) => provider.supportedBeachIds.includes(beach.id));
	const limitations = [
		beach.supports.beachFlags === "future" ? "The app currently estimates flag conditions; an official beach flag source is planned." : null,
		beach.supports.beachFlags === "unavailable" ? "No official beach-specific flag source is currently available." : null,
		beach.tide?.stationType === "subordinate" ? "Tide predictions use a subordinate NOAA station." : null,
		beach.vibrioConditions.eligible ? beach.vibrioConditions.limitation : beach.vibrioConditions.reason,
		beach.id.startsWith("dauphin-island") ? "West End Beach is not represented by a current app/backend beach ID and must not be mapped here." : null,
	].filter((value): value is string => Boolean(value));
	return {
		id: beach.id,
		canonicalName: beach.displayName,
		area: area(beach.id),
		address: mapping?.addresses[0] ?? null,
		coordinates: beach.location,
		venueAliases: mapping?.venues ?? [],
		addressAliases: mapping?.addresses ?? [],
		sourceSpecificAliases: mapping?.sourceAliases ?? {},
		excludedVenues: mapping?.excludes ?? [],
		accessNotes: "No verified parking or access note is recorded in current project configuration.",
		sources: {
			flags: beach.supports.beachFlags,
			weather: `National Weather Service forecast at ${beach.weather.latitude}, ${beach.weather.longitude}`,
			waterQuality: `Alabama Department of Environmental Management site ${beach.ademCode}`,
			waterTemperature: beach.waterTemperature?.sources.map((source) => `${source.provider.toUpperCase()} ${source.stationId}`) ?? [],
			tide: beach.tide ? `NOAA ${beach.tide.stationName} (${beach.tide.stationId}, ${beach.tide.stationType})` : null,
			ripCurrent: beach.ripCurrent ? `National Weather Service zone ${beach.ripCurrent.forecastZone}` : null,
			events: providers.map((provider) => ({ id: provider.id, name: provider.name, mode: provider.mode, sourceURL: provider.feedURL })),
		},
		sourceURLs: {
			weather: "https://api.weather.gov/",
			waterQuality: "https://gis.adem.alabama.gov/arcgis/rest/services/BeachMonitoring/MapServer/15",
			waterTemperatureAndTides: "https://tidesandcurrents.noaa.gov/",
			ripCurrent: "https://www.weather.gov/beach/mob",
		},
		limitations,
		exactLocationNote: "Only an exact approved venue/address alias, a source-specific alias, or an explicit administrator assignment may match this beach.",
	};
});
