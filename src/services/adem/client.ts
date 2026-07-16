import { CONTENT_TYPES, UPSTREAM_LIMITS, validateAdemReportUrl } from "../../config/upstreamSecurity";
import { fetchWithRetry, readResponseBytes } from "../../utils/http";

export async function fetchWaterQualityReport(reportUrl: string): Promise<ArrayBuffer> {
	const response = await fetchWithRetry(reportUrl, {
		validateUrl: validateAdemReportUrl,
		headers: {
			Accept: "application/vnd.ms-excel, application/octet-stream, */*",
		},
	});

	if (!response.ok) {
		throw new Error(
			`Failed to download ADEM report (${response.status} ${response.statusText})`,
		);
	}

	const bytes = await readResponseBytes(response, {
		maxBytes: UPSTREAM_LIMITS.ademReportBytes,
		contentTypes: CONTENT_TYPES.excel,
	});
	return new Uint8Array(bytes).buffer;
}
