import { fetchWaterQualityReport } from "../services/adem/client";
import { parseWaterQualityWorkbook } from "../services/adem/parser";

const GULF_SHORES_REPORT_URL = "https://adem.alabama.gov/media/18617/download";

export async function handleDebugWaterQualityRequest(): Promise<Response> {
	try {
		const report = await fetchWaterQualityReport(GULF_SHORES_REPORT_URL);
		const rows = parseWaterQualityWorkbook(report);

		return Response.json({
			source: "ADEM Gulf Shores Public Beach report debug",
			generatedAt: new Date().toISOString(),
			rowCount: rows.length,
			rows: rows.slice(0, 40),
		});
	} catch (error) {
		return Response.json(
			{
				error: "Failed to debug water quality report",
				message: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}