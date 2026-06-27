const BEACH_MONITORING_URL =
	"https://gis.adem.alabama.gov/arcgis/rest/services/BeachMonitoring/MapServer/15/query?where=1%3D1&outFields=*&f=json";

export interface ArcGISBeachLocation {
	id: string;
	code: string;
	name: string;
	waterbody: string;
	latitude: number;
	longitude: number;
	reportUrl: string;
}

interface ArcGISFeature {
	attributes: {
		ID: string;
		Name: string;
		Descriptio: string;
		WaterbodyN: string;
		Latitude: number;
		Longitude: number;
		URL: string;
	};
}

interface ArcGISResponse {
	features: ArcGISFeature[];
}

export async function fetchBeachMonitoringLocations(): Promise<ArcGISBeachLocation[]> {
	const response = await fetch(BEACH_MONITORING_URL);

	if (!response.ok) {
		throw new Error(
			`Failed to fetch ArcGIS beach locations (${response.status})`,
		);
	}

	const data = (await response.json()) as ArcGISResponse;

	return data.features.map((feature) => ({
		id: feature.attributes.ID,
		code: feature.attributes.Name,
		name: feature.attributes.Descriptio,
		waterbody: feature.attributes.WaterbodyN,
		latitude: feature.attributes.Latitude,
		longitude: feature.attributes.Longitude,
		reportUrl: feature.attributes.URL,
	}));
}