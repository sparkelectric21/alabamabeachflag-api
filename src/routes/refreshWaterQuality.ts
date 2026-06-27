import { refreshWaterQuality } from "../services/refresh/waterQualityRefresh";

export async function handleRefreshWaterQualityRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	const secret = request.headers.get("x-refresh-secret");

	if (secret !== env.REFRESH_SECRET) {
		return Response.json(
			{
				error: "Unauthorized",
			},
			{ status: 401 },
		);
	}
	try {
		const payload = await refreshWaterQuality(env);

		return Response.json({
			status: "ok",
			apiVersion: payload.apiVersion,
			message: "Water quality cache refreshed successfully.",
			source: payload.source,
			generatedAt: payload.generatedAt,
			lastSuccessfulRefresh: payload.lastSuccessfulRefresh,
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