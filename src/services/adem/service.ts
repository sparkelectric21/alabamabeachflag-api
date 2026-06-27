

import { beaches } from "../../config/BeachRegistry";
import { fetchBeachMonitoringLocations } from "../arcgis/client";
import type { WaterQuality } from "../../models/WaterQuality";

export async function getLatestWaterQuality(): Promise<WaterQuality[]> {
	// Temporary implementation.
	// Next milestone: download each ADEM report, parse the latest sample,
	// and populate the remaining WaterQuality fields.

	const locations = await fetchBeachMonitoringLocations();

	const locationMap = new Map(locations.map((location) => [location.code, location]));

	return beaches
		.map((beach) => {
			const location = locationMap.get(beach.ademCode);
			if (!location) {
				return null;
			}

			return {
				beachId: beach.id,
				displayName: beach.displayName,
				sampleDate: null,
				enterococcus: null,
				advisory: false,
				status: "unavailable",
				reportUrl: location.reportUrl,
			} satisfies WaterQuality;
		})
		.filter((item): item is WaterQuality => item !== null);
}