import { refreshBeachConditions } from "../services/refresh/beachConditionsRefresh";

export async function handleRefreshBeachConditionsRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	const secret = request.headers.get("x-refresh-secret");

	if (secret !== env.REFRESH_SECRET) {
		return Response.json(
			{ error: "Unauthorized" },
			{ status: 401 },
		);
	}

	const payload = await refreshBeachConditions(env);

	return Response.json(payload);
}