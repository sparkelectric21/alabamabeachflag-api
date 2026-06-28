

import { refreshWeather } from "../services/refresh/weatherRefresh";

export async function handleRefreshWeatherRequest(
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

	const payload = await refreshWeather(env);

	return Response.json(payload);
}