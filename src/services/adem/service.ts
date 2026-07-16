import { beaches } from "../../config/BeachRegistry";
import type { WaterQuality } from "../../models/WaterQuality";
import { fetchBeachMonitoringLocations } from "../arcgis/client";
import { fetchWaterQualityReport } from "./client";
import { extractLatestSample } from "./mapper";
import { parseWaterQualityWorkbook } from "./parser";
import { logError } from "../../utils/logger";

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

	const results: WaterQuality[] = [];

	for (const beach of supportedBeaches) {
		const location = locationMap.get(beach.ademCode);

		if (!location) {
			results.push({
				beachId: beach.id,
				displayName: beach.displayName,
				sampleDate: null,
				enterococcus: null,
				advisory: false,
				status: "unavailable",
				reportUrl: "",
			});
			continue;
		}

		try {
			results.push(await getWaterQualityForBeach(beach, location.reportUrl));
		} catch (error) {
			logError("Water Quality", "Beach report unavailable", {
				beachId: beach.id,
				error: error instanceof Error ? error.message : "unknown_error",
			});

			results.push({
				beachId: beach.id,
				displayName: beach.displayName,
				sampleDate: null,
				enterococcus: null,
				advisory: false,
				status: "unavailable",
				reportUrl: location.reportUrl,
			});
		}
	}

	return results;
}
