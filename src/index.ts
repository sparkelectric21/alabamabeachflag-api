import { handleWaterQualityRequest } from "./routes/waterQuality";
import { handleBeachesRequest } from "./routes/beaches";
import { handleRefreshWaterQualityRequest } from "./routes/refreshWaterQuality";
import { handleBeachConditionsRequest } from "./routes/beach-conditions";
import { handleRefreshBeachConditionsRequest } from "./routes/refreshBeachConditions";
import { handleBeachFlagsRequest } from "./routes/beachflags";
import { handleRefreshBeachFlagsRequest } from "./routes/refreshBeachFlag";
import { handleRipCurrentOutlookImageRequest, handleRipCurrentOutlookRequest } from "./routes/ripCurrentOutlook";
import { handleAdminRefreshRequest } from "./routes/adminRefresh";
import type { Env as AppEnv } from "./types";

import { API_PATH_VERSION, API_VERSION, APP_VERSION } from "./config/version";
import { authenticateAdminRequest, forbiddenAdminResponse } from "./services/admin/auth";
import { dispatchRefresh, scheduledIdempotencyKey } from "./services/refresh/dispatch";
import type { RefreshJob } from "./services/refresh/types";
import { dispatchVerification, handleLatestVerification, monitorVerificationReports } from "./routes/verification";
import { isVerificationHour } from "./verification/run";
import { handleAnnouncementOptions, handleAppAnnouncementRequest, handleDeleteAppAnnouncementRequest, handlePutAppAnnouncementRequest, hasTrustedAnnouncementOrigin, withAnnouncementCors } from "./routes/appAnnouncement";
import { handleProviderHealthAdminRequest } from "./routes/providerHealthAdmin";
import { handleProviderCatalogUpdate } from "./providerHealth/catalog";

export { RefreshCoordinator } from "./services/refresh/coordinator";
export { VerificationCoordinator } from "./verification/coordinator";



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
		const sameOriginAdminPrefix = "/admin/service";
		const pathname = url.pathname.startsWith(`${sameOriginAdminPrefix}/`)
			? url.pathname.slice(sameOriginAdminPrefix.length)
			: url.pathname;
		if (pathname === "/internal/app-announcement" && request.method === "OPTIONS") {
			return handleAnnouncementOptions(request);
		}
		if (pathname === "/admin/provider-health") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method !== "GET") return methodNotAllowed("GET");
			return await handleProviderHealthAdminRequest(env);
		}
		if (pathname === "/admin/provider-catalog") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method !== "PATCH") return methodNotAllowed("PATCH");
			return await handleProviderCatalogUpdate(request, env, identity);
		}
		if (url.pathname === "/health" || url.pathname === "/v1/health") {
			if (request.method === "GET" || request.method === "HEAD") {
				return handleHealthRequest(request.method, APP_VERSION, API_PATH_VERSION);
			}

			return methodNotAllowed("GET, HEAD");
		}

			if (pathname.startsWith("/internal/")) {
				const identity = await authenticateAdminRequest(request, env);
				if (!identity) return pathname === "/internal/app-announcement"
					? withAnnouncementCors(forbiddenAdminResponse(), request)
					: forbiddenAdminResponse();

				if (pathname === "/internal/app-announcement") {
					if (!hasTrustedAnnouncementOrigin(request)) return withAnnouncementCors(forbiddenAdminResponse(), request);
					if (request.method === "PUT") return withAnnouncementCors(await handlePutAppAnnouncementRequest(request, env), request);
					if (request.method === "DELETE") return withAnnouncementCors(await handleDeleteAppAnnouncementRequest(env), request);
					return withAnnouncementCors(methodNotAllowed("PUT, DELETE"), request);
				}

				if (pathname === "/internal/verification/latest") {
					if (request.method !== "GET") return methodNotAllowed("GET");
					return await handleLatestVerification(env);
				}

				if (pathname === "/internal/verification/run") {
					if (request.method !== "POST") return methodNotAllowed("POST");
					return await dispatchVerification(env);
				}

				if (request.method !== "POST") return methodNotAllowed("POST");

				if (pathname === "/internal/refresh/water-quality") {
					return await handleRefreshWaterQualityRequest(request, env, identity);
				}

				if (pathname === "/internal/refresh/beach-conditions") {
					return await handleRefreshBeachConditionsRequest(request, env, identity);
				}

				if (pathname === "/internal/refresh/weather") {
					return await handleRefreshBeachConditionsRequest(request, env, identity);
				}

				if (pathname === "/internal/refresh/beach-flags") {
					return await handleRefreshBeachFlagsRequest(request, env, identity);
				}
				if (pathname === "/internal/refresh/rip-current-outlook") return await handleAdminRefreshRequest(request, env, "rip-current-outlook", identity);

				return jsonResponse({ error: "Not Found" }, { status: 404 });
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

		if (pathname === "/v1/app-announcement") return withAnnouncementCors(await handleAppAnnouncementRequest(request, env), request);

		if (url.pathname === "/v1/water-quality") {
			return await handleWaterQualityRequest(env);
		}

		if (url.pathname === "/v1/beach-conditions") {
			return await handleBeachConditionsRequest(env);
		}

		if (url.pathname === "/v1/beach-flags") {
			return await handleBeachFlagsRequest(env);
		}
		if (url.pathname === "/v1/rip-current-outlook") return await handleRipCurrentOutlookRequest(env);
		if (url.pathname === "/v1/rip-current-outlook/image") return await handleRipCurrentOutlookImageRequest(request, env);

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
			const runScheduled = async (job: RefreshJob): Promise<void> => {
				const result = await dispatchRefresh(env, {
					job,
					trigger: "scheduled",
					idempotencyKey: scheduledIdempotencyKey(job, controller.scheduledTime),
				});
				if (result.outcome === "failed") console.error(`[Cron] ${job} refresh failed`);
			};

		if (cron === "*/5 * * * *") {
			console.log("[Cron] Running 5-minute refresh...");

			try {
					await runScheduled("beach-flags");
			} catch (error) {
				console.error("Scheduled beach flags refresh failed");
			}

			return;
		}

		if (cron === "*/15 * * * *") {
			console.log("[Cron] Running 15-minute weather refresh...");

			try {
					await runScheduled("beach-conditions");
			} catch (error) {
				console.error("Scheduled beach conditions refresh failed");
			}

			try {
				await monitorVerificationReports(env, new Date(controller.scheduledTime));
			} catch {
				console.error("[Verification alerts] missing-report monitor failed");
			}

			return;
		}

		if (cron === "0 */6 * * *") {
			console.log("[Cron] Running 6-hour water quality refresh...");

			try {
					await runScheduled("water-quality");
			} catch (error) {
				console.error("Scheduled water quality refresh failed");
			}
			try { await runScheduled("rip-current-outlook"); } catch { console.error("Scheduled rip current outlook refresh failed"); }
			return;
		}

		if (cron === "0 * * * *" && isVerificationHour(new Date(controller.scheduledTime))) {
			const response = await dispatchVerification(env, new Date(controller.scheduledTime));
			if (!response.ok && response.status !== 409) console.error("[Cron] factual verification failed");
		}
	},
} satisfies ExportedHandler<AppEnv>;
