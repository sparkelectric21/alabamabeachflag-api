import { beaches } from "../../config/BeachRegistry";
import type { WaterQuality } from "../../models/WaterQuality";
import { fetchBeachMonitoringLocations } from "../arcgis/client";
import { fetchWaterQualityReport } from "./client";
import { extractLatestSample } from "./mapper";
import { parseWaterQualityWorkbook } from "./parser";

async function getWaterQualityForBeach(
	beach: (typeof beaches)[number],
	reportUrl: string,
): Promise<WaterQuality> {
	const report = await fetchWaterQualityReport(reportUrl);
	const rows = parseWaterQualityWorkbook(report);
	const latestSample = extractLatestSample(rows);

	return {
		beachId: beach.id,
		displayName: beach.displayName,
		sampleDate: latestSample.sampleDate,
		enterococcus: latestSample.enterococcus,
		advisory: latestSample.advisory,
		status: latestSample.status,
		reportUrl,
	};
}

export async function getLatestWaterQuality(): Promise<WaterQuality[]> {
	const locations = await fetchBeachMonitoringLocations();
	const locationMap = new Map(locations.map((location) => [location.code, location]));

	const supportedBeaches = beaches.filter((beach) => beach.supports.waterQuality);

	return await Promise.all(
		supportedBeaches.map(async (beach) => {
			const location = locationMap.get(beach.ademCode);

			if (!location) {
				return {
					beachId: beach.id,
					displayName: beach.displayName,
					sampleDate: null,
					enterococcus: null,
					advisory: false,
					status: "unavailable",
					reportUrl: "",
				} satisfies WaterQuality;
			}

			try {
				return await getWaterQualityForBeach(beach, location.reportUrl);
			} catch {
				return {
					beachId: beach.id,
					displayName: beach.displayName,
					sampleDate: null,
					enterococcus: null,
					advisory: false,
					status: "unavailable",
					reportUrl: location.reportUrl,
				} satisfies WaterQuality;
			}
		}),
	);
}