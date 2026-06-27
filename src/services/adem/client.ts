export async function fetchWaterQualityReport(reportUrl: string): Promise<ArrayBuffer> {
	const response = await fetch(reportUrl, {
		headers: {
			Accept: "application/vnd.ms-excel, application/octet-stream, */*",
		},
	});

	if (!response.ok) {
		throw new Error(
			`Failed to download ADEM report (${response.status} ${response.statusText})`,
		);
	}

	return await response.arrayBuffer();
}