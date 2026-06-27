import { getLatestWaterQuality } from "../services/adem/service";

export async function handleWaterQualityRequest(): Promise<Response> {
	try {
		const waterQuality = await getLatestWaterQuality();

		return Response.json({
			source: "Alabama Beach Flag Water Quality Service",
			generatedAt: new Date().toISOString(),
			count: waterQuality.length,
			waterQuality,
		});
	} catch (error) {
		return Response.json(
			{
				error: "Failed to load water quality",
				message: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}