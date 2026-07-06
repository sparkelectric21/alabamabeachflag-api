import { handleWaterQualityRequest } from "./routes/waterQuality";
import { handleBeachesRequest } from "./routes/beaches";
import { handleRefreshWaterQualityRequest } from "./routes/refreshWaterQuality";
import { handleBeachConditionsRequest } from "./routes/beach-conditions";
import { handleRefreshBeachConditionsRequest } from "./routes/refreshBeachConditions";
import { handleBeachFlagsRequest } from "./routes/beachflags";
import { handleRefreshBeachFlagsRequest } from "./routes/refreshBeachFlag";
import type { Env as AppEnv } from "./types";

import { refreshWaterQuality } from "./services/refresh/waterQualityRefresh";
import { refreshBeachConditions } from "./services/refresh/beachConditionsRefresh";
import { refreshBeachFlags } from "./services/refresh/beachFlagRefresh";
import { fetchCurrentWeather } from "./services/weather/weatherKitClient";
import { API_PATH_VERSION, API_VERSION, APP_VERSION } from "./config/version";



function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
	return Response.json(data, {
		...init,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			...init.headers,
		},
	});
}

function handleHealthRequest(method: string, version: string, apiVersion: string): Response {
	const headers = {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	};

	if (method === "HEAD") {
		return new Response(null, {
			status: 200,
			headers,
		});
	}

	return jsonResponse(
		{
			status: "ok",
			service: "Alabama Beach Flag API",
			version,
			apiVersion,
			environment: "production",
			timestamp: new Date().toISOString(),
		},
		{
			headers,
		},
	);
}

function methodNotAllowed(allow: string): Response {
	return jsonResponse(
		{
			error: "Method Not Allowed",
		},
		{
			status: 405,
			headers: {
				Allow: allow,
			},
		},
	);
}

async function handleWeatherCompatibilityRequest(env: AppEnv): Promise<Response> {
	const response = await handleBeachConditionsRequest(env);

	if (!response.ok) {
		return response;
	}

	const payload = (await response.json()) as {
		status?: string;
		apiVersion?: string;
		source?: string;
		generatedAt?: string;
		count?: number;
		beachConditions?: Array<{
			beachId: string;
			displayName: string;
			temperature: number;
			temperatureUnit: string;
			condition: string;
			windSpeed: string;
			windDirection: string;
		}>;
		errors?: unknown[];
	};

	const weather = (payload.beachConditions ?? []).map((beach) => ({
		beachId: beach.beachId,
		displayName: beach.displayName,
		temperature: beach.temperature,
		temperatureUnit: beach.temperatureUnit,
		condition: beach.condition,
		windSpeed: beach.windSpeed,
		windDirection: beach.windDirection,
	}));

	return jsonResponse({
		status: weather.length > 0 ? "ok" : "unavailable",
		apiVersion: payload.apiVersion ?? API_VERSION,
		source: payload.source ?? "NOAA",
		generatedAt: payload.generatedAt ?? new Date().toISOString(),
		count: weather.length,
		weather,
		errors: payload.errors ?? [],
	});
}

export default {
	async fetch(request: Request, env: AppEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health" || url.pathname === "/v1/health") {
			if (request.method === "GET" || request.method === "HEAD") {
				return handleHealthRequest(request.method, APP_VERSION, API_PATH_VERSION);
			}

			return methodNotAllowed("GET, HEAD");
		}

		if (url.pathname === "/internal/debug/weatherkit") {
			const secret = request.headers.get("x-refresh-secret");

			if (secret !== env.REFRESH_SECRET) {
				return jsonResponse({ error: "Unauthorized" }, { status: 401 });
			}

			try {
				const result = await fetchCurrentWeather(
					env,
					{
						latitude: 30.2460,
						longitude: -87.7008,
					},
				);

				return jsonResponse(result);
			} catch (error) {
				return jsonResponse(
					{
						error: error instanceof Error ? error.message : String(error),
					},
					{ status: 500 },
				);
			}
		}

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

		if (
			url.pathname === "/internal/refresh/beach-flags" &&
			request.method === "POST"
		) {
			return await handleRefreshBeachFlagsRequest(request, env);
		}


		if (request.method !== "GET") {
			return methodNotAllowed("GET, POST");
		}

		if (url.pathname === "/") {
			return jsonResponse({
				service: "Alabama Beach Flag API",
				version: APP_VERSION,
				status: "online",
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

		if (url.pathname === "/v1/beach-flags") {
			return await handleBeachFlagsRequest(env);
		}

		if (url.pathname === "/v1/weather") {
			// Temporary compatibility route for existing app versions.
			return await handleWeatherCompatibilityRequest(env);
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

	async scheduled(controller: ScheduledController, env: AppEnv): Promise<void> {
		const cron = controller.cron;

		if (cron === "*/5 * * * *") {
			console.log("[Cron] Running 5-minute refresh...");

			try {
				await refreshBeachFlags(env);
			} catch (error) {
				console.error("Scheduled beach flags refresh failed:", error);
			}

			return;
		}

		if (cron === "*/15 * * * *") {
			console.log("[Cron] Running 15-minute weather refresh...");

			try {
				await refreshBeachConditions(env);
			} catch (error) {
				console.error("Scheduled beach conditions refresh failed:", error);
			}

			return;
		}

		if (cron === "0 */6 * * *") {
			console.log("[Cron] Running 6-hour water quality refresh...");

			try {
				await refreshWaterQuality(env);
			} catch (error) {
				console.error("Scheduled water quality refresh failed:", error);
			}
		}
	},
} satisfies ExportedHandler<AppEnv>;
