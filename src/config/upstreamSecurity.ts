import { UpstreamError, type UpstreamUrlValidator } from "../utils/http";

export const UPSTREAM_LIMITS = {
	// Current ADEM BIFF reports are about 172 KiB; 1 MiB leaves nearly 6x headroom.
	ademReportBytes: 1 * 1024 * 1024,
	// Current ArcGIS location metadata is about 14 KiB.
	arcgisJsonBytes: 256 * 1024,
	// Observed municipal pages are 110-180 KiB, including site chrome.
	municipalHtmlBytes: 2 * 1024 * 1024,
	// NOAA's nationwide beach dataset is larger than per-location forecasts.
	noaaJsonBytes: 4 * 1024 * 1024,
	nwsJsonBytes: 2 * 1024 * 1024,
	// Observed NDBC station text is about 100 KiB.
	ndbcTextBytes: 512 * 1024,
	// CO-OPS latest observations and Open-Meteo current UV are small JSON documents.
	coopsJsonBytes: 256 * 1024,
	openMeteoJsonBytes: 128 * 1024,
	// WeatherKit currentWeather is bounded separately from unrequested datasets.
	weatherKitJsonBytes: 1 * 1024 * 1024,
} as const;

function policy(hostnames: readonly string[], path: RegExp): UpstreamUrlValidator {
	return (url) => {
		if (!hostnames.includes(url.hostname.toLowerCase()) || !path.test(url.pathname)) {
			throw new UpstreamError("unsafe_upstream_url");
		}
	};
}

export const validateAdemReportUrl = policy(["adem.alabama.gov"], /^\/media\/\d+\/download\/?$/);
export const validateArcGisUrl = policy(["gis.adem.alabama.gov"], /^\/arcgis\/rest\/services\/BeachMonitoring\/MapServer\/15\/query$/);
export const validateGulfShoresUrl = policy(["www.gulfshoresal.gov"], /^\/1136\/Beach-Safety\/?$/);
export const validateOrangeBeachUrl = policy(["www.orangebeachal.gov"], /^\/170\/Beach-Safety-Mollys-Patrol\/?$/);
export const validateNwsUrl = policy(["api.weather.gov"], /^\/(?:points|gridpoints)\//);
export const validateNoaaMapUrl = policy(["mapservices.weather.noaa.gov"], /^\/vector\/rest\/services\/outlooks\/marine_beachforecast_summary\/MapServer\/0\/query$/);
export const validateOpenMeteoUrl = policy(["api.open-meteo.com"], /^\/v1\/forecast$/);
export const validateCoopsUrl = policy(["api.tidesandcurrents.noaa.gov"], /^\/api\/prod\/datagetter$/);
export const validateNdbcUrl = policy(["www.ndbc.noaa.gov"], /^\/data\/realtime2\/[A-Za-z0-9_-]+\.txt$/);
export const validateWeatherKitUrl = policy(["weatherkit.apple.com"], /^\/api\/v1\/weather\/en\/-?\d+(?:\.\d+)?\/-?\d+(?:\.\d+)?$/);

export const CONTENT_TYPES = {
	json: ["application/json"],
	arcgisJson: ["application/json", "text/plain"],
	nwsJson: ["application/geo+json", "application/ld+json", "application/json"],
	html: ["text/html", "application/xhtml+xml"],
	text: ["text/plain"],
	excel: ["application/vnd.ms-excel", "application/octet-stream"],
} as const;
