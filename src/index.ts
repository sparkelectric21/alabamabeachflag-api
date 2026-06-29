import { handleWaterQualityRequest } from "./routes/waterQuality";
import { handleBeachesRequest } from "./routes/beaches";
import { handleRefreshWaterQualityRequest } from "./routes/refreshWaterQuality";
import { handleBeachConditionsRequest } from "./routes/beach-conditions";
import { handleRefreshBeachConditionsRequest } from "./routes/refreshBeachConditions";
import { refreshWaterQuality } from "./services/refresh/waterQualityRefresh";

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
	return Response.json(data, {
		...init,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			...init.headers,
		},
	});
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (
			url.pathname === "/internal/refresh/water-quality" &&
			request.method === "POST"
		) {
			return await handleRefreshWaterQualityRequest(
				request,
				env,
			);
		}

		if (
			url.pathname === "/internal/refresh/beach-conditions" &&
			request.method === "POST"
		) {
			return await handleRefreshBeachConditionsRequest(request, env);
		}

		if (
			url.pathname === "/internal/refresh/weather" &&
			request.method === "POST"
		) {
			// Temporary compatibility route for existing automation.
			return await handleRefreshBeachConditionsRequest(request, env);
		}

		if (request.method !== "GET") {
			return jsonResponse(
				{
					error: "Method Not Allowed",
				},
				{
					status: 405,
					headers: {
						Allow: "GET, POST",
					},
				},
			);
		}

		if (url.pathname === "/") {
			return jsonResponse({
				service: "Alabama Beach Flag API",
				version: "1.0.0",
				status: "online",
			});
		}
		if (url.pathname === "/v1/health") {
			return jsonResponse({
				status: "ok",
				service: "Alabama Beach Flag API",
				version: "1.0.0",
				timestamp: new Date().toISOString(),
			});
		}

		if (url.pathname === "/v1/beaches") {
			return await handleBeachesRequest();
		}

		if (url.pathname === "/v1/water-quality") {
			return await handleWaterQualityRequest(env);
		}

		if (url.pathname === "/v1/beach-conditions") {
			return await handleBeachConditionsRequest(env);
		}

		if (url.pathname === "/v1/weather") {
			// Temporary compatibility route for existing app versions.
			return await handleBeachConditionsRequest(env);
		}

		return jsonResponse(
			{
				error: "Not Found",
				path: url.pathname,
			},
			{
				status: 404,
			},
		);
	},

	async scheduled(_event, env): Promise<void> {
		try {
			await refreshWaterQuality(env);
		} catch (error) {
			console.error("Scheduled water quality refresh failed:", error);
		}
	},
} satisfies ExportedHandler<Env>;
