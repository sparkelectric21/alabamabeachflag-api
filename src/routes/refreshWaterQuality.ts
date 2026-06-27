

import { refreshWaterQuality } from "../services/refresh/waterQualityRefresh";

export async function handleRefreshWaterQualityRequest(
	env: Env,
): Promise<Response> {
	try {
		const payload = await refreshWaterQuality(env);

		return Response.json({
			status: "ok",
			message: "Water quality cache refreshed successfully.",
			generatedAt: payload.generatedAt,
			count: payload.count,
		});
	} catch (error) {
		return Response.json(
			{
				error: "Failed to refresh water quality cache",
				message: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}