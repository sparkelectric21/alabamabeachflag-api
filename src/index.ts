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



function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
	return Response.json(data, {
		...init,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			...init.headers,
		},
	});
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
		apiVersion: payload.apiVersion ?? "1.0.0",
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
