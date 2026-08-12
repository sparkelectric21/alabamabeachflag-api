import { handleWaterQualityRequest } from "./routes/waterQuality";
import { handleBeachesRequest } from "./routes/beaches";
import { handleMapPOIsRequest } from "./routes/mapPOIs";
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
import { handleAnnouncementOptions, handleAppAnnouncementAdminRequest, handleAppAnnouncementRequest, handleDeleteAppAnnouncementRequest, handlePutAppAnnouncementRequest, hasTrustedAnnouncementOrigin, withAnnouncementCors } from "./routes/appAnnouncement";
import { handleProviderHealthAdminRequest } from "./routes/providerHealthAdmin";
import { handleVerificationAdminRequest } from "./routes/verificationAdmin";
import { handleProviderCatalogUpdate } from "./providerHealth/catalog";
import { handleAppConfiguration, handleOperationalControlAudit, handleOperationalControlGet, handleOperationalControlPatch, handleOperationalControlRollback } from "./routes/operationalControl";
import { recordJobAttempt, recordJobCompletion } from "./monitoring/jobHealth";
import { handleBeachActivityNotificationPreferences, handleBeachActivityNotificationSend, handleBeachEventRuleCreate, handleBeachEventSuggest, handleBeachEventsAdminCreate, handleBeachEventsAdminDelete, handleBeachEventsAdminGet, handleBeachEventsAdminNormalize, handleBeachEventsAdminUpdate, handleBeachEventsRequest, handleExcludedEventAssign } from "./routes/beachEvents";
import { refreshBeachEvents } from "./beachEvents/refresh";
import { isBeachEventRefreshHour } from "./beachEvents/schedule";
import { evaluateBeachActivityNotifications, isBeachActivityReminderTime, readBeachActivityNotificationConfig } from "./beachEvents/notifications";
import { readProviderHealthNotificationConfig, readProviderHealthNotificationState, sendProviderHealthNotificationTest, updateProviderHealthNotificationConfig } from "./providerHealth/notifications";
import { handleHistoricalDiagnostics } from "./history/diagnostics";
import { handleHistoricalObservations } from "./history/observations";
import { handleInformationReportCreate, handleInformationReportsAdmin, isInformationReportSubmissionHost } from "./routes/informationReports";

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
		if (pathname === "/v1/information-reports") {
			if (request.method !== "POST") return methodNotAllowed("POST");
			if (!isInformationReportSubmissionHost(url, env)) return new Response(null, { status: 404 });
			return handleInformationReportCreate(request, env);
		}
		if (pathname.startsWith("/v1/information-reports")) return new Response(null, { status: 404 });
		if (pathname === "/admin/information-reports" || pathname.startsWith("/admin/information-reports/")) {
			const identity = await authenticateAdminRequest(request, env); if (!identity) return forbiddenAdminResponse();
			if (request.method !== "GET" && request.method !== "PATCH") return methodNotAllowed("GET, PATCH");
			const id = pathname === "/admin/information-reports" ? undefined : decodeURIComponent(pathname.slice("/admin/information-reports/".length));
			return handleInformationReportsAdmin(request, env, identity, id);
		}
		if (pathname === "/internal/app-announcement" && request.method === "OPTIONS") {
			return handleAnnouncementOptions(request);
		}
		if (pathname === "/admin/provider-health") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method !== "GET") return methodNotAllowed("GET");
			return await handleProviderHealthAdminRequest(env);
		}
		if (pathname === "/admin/app-announcement") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method !== "GET") return methodNotAllowed("GET");
			return await handleAppAnnouncementAdminRequest(env);
		}
		if (pathname === "/admin/provider-health/notifications") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method === "GET") return jsonResponse({
				configuration: await readProviderHealthNotificationConfig(env),
				state: await readProviderHealthNotificationState(env),
				bindingReady: Boolean(env.VERIFICATION_ALERT_EMAIL),
			}, { headers: { "Cache-Control": "no-store" } });
			if (request.method === "PATCH") return await updateProviderHealthNotificationConfig(request, env, identity);
			return methodNotAllowed("GET, PATCH");
		}
		if (pathname === "/admin/provider-health/notifications/test") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method !== "POST") return methodNotAllowed("POST");
			return await sendProviderHealthNotificationTest(env, identity);
		}
		if (pathname === "/admin/verification") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method !== "GET") return methodNotAllowed("GET");
			return await handleVerificationAdminRequest(env);
		}
		if (pathname === "/admin/historical-data") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method !== "GET") return methodNotAllowed("GET");
			return await handleHistoricalDiagnostics(env);
		}
		if (pathname === "/admin/historical-data/observations") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method !== "GET") return methodNotAllowed("GET");
			return await handleHistoricalObservations(request, env);
		}
		if (pathname === "/admin/provider-catalog") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method !== "PATCH") return methodNotAllowed("PATCH");
			return await handleProviderCatalogUpdate(request, env, identity);
		}
		if (pathname === "/admin/beach-events") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method === "GET") return await handleBeachEventsAdminGet(request, env);
			if (request.method === "POST") return await handleBeachEventsAdminCreate(request, env, identity);
			return methodNotAllowed("GET, POST");
		}
		if (pathname === "/admin/beach-events/notifications") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method !== "PATCH") return methodNotAllowed("PATCH");
			return await handleBeachActivityNotificationPreferences(request, env, identity);
		}
		if (pathname === "/admin/beach-events/normalize" && request.method === "POST") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			return await handleBeachEventsAdminNormalize(request, env, identity);
		}
		if (pathname === "/admin/beach-events/notifications/send") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method !== "POST") return methodNotAllowed("POST");
			return await handleBeachActivityNotificationSend(request, env, identity, "manual");
		}
		if (pathname === "/admin/beach-events/notifications/test") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method !== "POST") return methodNotAllowed("POST");
			return await handleBeachActivityNotificationSend(request, env, identity, "test");
		}
		if (pathname === "/admin/beach-events/rules") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method !== "POST") return methodNotAllowed("POST");
			return await handleBeachEventRuleCreate(request, env, identity);
		}
		if (pathname === "/admin/beach-events/suggest") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method !== "POST") return methodNotAllowed("POST");
			return await handleBeachEventSuggest(request);
		}
		if (pathname.startsWith("/admin/beach-events/exclusions/")) {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			const id = decodeURIComponent(pathname.slice("/admin/beach-events/exclusions/".length));
			if (request.method === "POST") return await handleExcludedEventAssign(request, env, identity, id);
			return methodNotAllowed("POST");
		}
		if (pathname.startsWith("/admin/beach-events/")) {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			const id = decodeURIComponent(pathname.slice("/admin/beach-events/".length));
			if (request.method === "PATCH") return await handleBeachEventsAdminUpdate(request, env, identity, id);
			if (request.method === "DELETE") return await handleBeachEventsAdminDelete(env, identity, id);
			return methodNotAllowed("PATCH, DELETE");
		}
		if (pathname === "/admin/operational-control") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method === "GET") return await handleOperationalControlGet(env);
			if (request.method === "PATCH") return await handleOperationalControlPatch(request, env, identity);
			return methodNotAllowed("GET, PATCH");
		}
		if (pathname === "/admin/operational-control/rollback") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method !== "POST") return methodNotAllowed("POST");
			return await handleOperationalControlRollback(request, env, identity);
		}
		if (pathname === "/admin/operational-control/audit") {
			const identity = await authenticateAdminRequest(request, env);
			if (!identity) return forbiddenAdminResponse();
			if (request.method !== "GET") return methodNotAllowed("GET");
			return await handleOperationalControlAudit(request, env);
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
					if (request.method === "DELETE") return withAnnouncementCors(await handleDeleteAppAnnouncementRequest(request, env), request);
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
				if (pathname === "/internal/refresh/beach-events") return jsonResponse(await refreshBeachEvents(env, new Date(), fetch, { trigger: "admin", identity }));
				if (pathname === "/internal/refresh/rip-current-outlook") return await handleAdminRefreshRequest(request, env, "rip-current-outlook", identity);

				return jsonResponse({ error: "Not Found" }, { status: 404 });
			}


		if (url.pathname === "/v1/map-pois") {
			if (request.method !== "GET") return methodNotAllowed("GET");
			return await handleMapPOIsRequest(request);
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
		if (pathname === "/v1/app-configuration") return await handleAppConfiguration(env);
		if (pathname === "/v1/beach-events") return await handleBeachEventsRequest(request, env);

		if (url.pathname === "/v1/water-quality") {
			return await handleWaterQualityRequest(env);
		}

		if (url.pathname === "/v1/beach-conditions") {
			return await handleBeachConditionsRequest(env);
		}

		if (url.pathname === "/v1/beach-flags") {
			return await handleBeachFlagsRequest(request, env, "v1");
		}
		if (url.pathname === "/v2/beach-flags") return await handleBeachFlagsRequest(request, env, "v2");
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
				const heartbeat = await recordJobAttempt(env, job, new Date(controller.scheduledTime));
				const result = await dispatchRefresh(env, {
					job,
					trigger: "scheduled",
					idempotencyKey: scheduledIdempotencyKey(job, controller.scheduledTime),
				});
				await recordJobCompletion(env, heartbeat, result.outcome === "completed" ? "completed" : result.outcome === "duplicate" ? "duplicate" : "failed", new Date(), result.outcome === "failed" ? "refresh_failed" : undefined);
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

			try {
				const scheduledAt = new Date(controller.scheduledTime);
				const preferences = await readBeachActivityNotificationConfig(env);
				if (isBeachActivityReminderTime(scheduledAt, preferences.reminderTime)) {
					await evaluateBeachActivityNotifications(env, scheduledAt, { kind: "reminder" });
				}
			} catch {
				console.error("[Beach activity notifications] reminder evaluation failed");
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

		if (cron === "0 * * * *") {
			const scheduledAt = new Date(controller.scheduledTime);
			if (isBeachEventRefreshHour(scheduledAt)) {
				try { await refreshBeachEvents(env, scheduledAt, fetch, { trigger: "scheduled" }); } catch { console.error("Scheduled beach events refresh failed"); }
			}
			if (isVerificationHour(scheduledAt)) {
				const heartbeat = await recordJobAttempt(env, "factual-verification", scheduledAt);
				const response = await dispatchVerification(env, scheduledAt);
				await recordJobCompletion(env, heartbeat, response.ok ? "completed" : response.status === 409 ? "duplicate" : "failed", new Date(), !response.ok && response.status !== 409 ? "verification_failed" : undefined);
				if (!response.ok && response.status !== 409) console.error("[Cron] factual verification failed");
			}
		}
	},
} satisfies ExportedHandler<AppEnv>;
