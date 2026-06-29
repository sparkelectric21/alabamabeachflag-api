import { refreshBeachFlags } from "../services/beachFlags/refresh";

export async function handleRefreshBeachFlagsRequest(
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
		const payload = await refreshBeachFlags(env);

		return Response.json({
			status: "ok",
			apiVersion: payload.apiVersion,
			message: "Beach flags cache refreshed successfully.",
			source: payload.source,
			generatedAt: payload.generatedAt,
			lastSuccessfulRefresh: payload.lastSuccessfulRefresh,
			count: payload.count,
		});
	} catch (error) {
		return Response.json(
			{
				error: "Failed to refresh beach flags cache",
				message: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}