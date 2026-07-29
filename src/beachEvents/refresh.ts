import type { AdminIdentity } from "../services/admin/auth";
import type { Env } from "../types";
import { processProviderHealthObservations } from "../providerHealth/process";
import { readOperationalControl, evaluateBeachEventsControl } from "../operationalControl/store";
import { parseICalendar } from "./ical";
import { BEACH_EVENT_PROVIDERS } from "./providers";
import { BEACH_EVENT_SCHEDULE_DESCRIPTION, nextBeachEventRefresh } from "./schedule";
import { applyImportedEvents, audit, listEvents, normalizedEvent, saveSnapshot } from "./store";
import type { BeachEventProviderRefresh, BeachEventRefreshStatus } from "./types";
import { evaluateBeachActivityNotifications } from "./notifications";
import { fetchTownCrierFacts } from "./townCrier";

export const REFRESH_STATUS_KEY = "beach-events:v1:refresh-status";
const RUN_LOCK_MS = 10 * 60 * 1000;

interface RefreshOptions {
	trigger?: "scheduled" | "admin";
	identity?: AdminIdentity;
}

const emptyCounts = () => ({ raw: 0, matched: 0, excluded: 0, pendingReview: 0, published: 0, ruleSuppressed: 0, unsupportedOrAmbiguous: 0 });

export async function readBeachEventRefreshStatus(env: Pick<Env, "BEACH_DATA">, now = new Date()): Promise<BeachEventRefreshStatus> {
	const stored = await env.BEACH_DATA.get<BeachEventRefreshStatus>(REFRESH_STATUS_KEY, "json");
	return stored ?? {
		schemaVersion: 1,
		status: "neverRun",
		trigger: "scheduled",
		lastAttempt: "",
		nextScheduledRefresh: nextBeachEventRefresh(now),
		scheduleDescription: BEACH_EVENT_SCHEDULE_DESCRIPTION,
		operationalState: "enabled",
		providers: [],
		counts: emptyCounts(),
	};
}

export async function refreshBeachEvents(env: Env, now = new Date(), fetcher: typeof fetch = fetch, options: RefreshOptions = {}) {
	const trigger = options.trigger ?? "scheduled";
	const prior = await env.BEACH_DATA.get<BeachEventRefreshStatus>(REFRESH_STATUS_KEY, "json");
	if (prior?.status === "running" && Date.parse(prior.lastAttempt) + RUN_LOCK_MS > now.getTime()) {
		return { outcome: "duplicate" as const, providers: prior.providers, snapshot: null, refresh: prior };
	}
	const operational = evaluateBeachEventsControl(await readOperationalControl(env, now), now);
	const running: BeachEventRefreshStatus = {
		schemaVersion: 1, status: "running", trigger, lastAttempt: now.toISOString(),
		...(prior?.lastSuccess ? { lastSuccess: prior.lastSuccess } : {}),
		...(prior?.lastFailure ? { lastFailure: prior.lastFailure, lastFailureMessage: prior.lastFailureMessage } : {}),
		nextScheduledRefresh: nextBeachEventRefresh(now),
		scheduleDescription: BEACH_EVENT_SCHEDULE_DESCRIPTION,
		operationalState: operational.state,
		providers: [],
		counts: emptyCounts(),
	};
	await env.BEACH_DATA.put(REFRESH_STATUS_KEY, JSON.stringify(running));

	if (operational.state === "disabled") {
		const refresh = { ...running, status: "disabled" as const, completedAt: now.toISOString() };
		await env.BEACH_DATA.put(REFRESH_STATUS_KEY, JSON.stringify(refresh));
		if (options.identity) await audit(env, options.identity, "refresh_event_sources", "beach-events", refresh, now);
		const notification = await evaluateBeachActivityNotifications(env, now, { kind: "immediate", ...(options.identity ? { identity: options.identity } : {}) });
		return { outcome: "disabled" as const, providers: [], snapshot: null, refresh, notification };
	}

	const observations = [], providerResults: BeachEventProviderRefresh[] = [];
	for (const provider of BEACH_EVENT_PROVIDERS) {
		const priorProvider = prior?.providers.find((item) => item.providerId === provider.id);
		if (provider.mode === "disabled" || provider.mode === "manualOnly") {
			providerResults.push({
				providerId: provider.id, status: "disabled", fetched: 0, matched: 0, excluded: 0, pendingReview: 0, published: 0, ruleSuppressed: 0, unsupportedOrAmbiguous: 0,
				freshness: priorProvider?.lastSuccess ? "stale" : "never", lastAttempt: priorProvider?.lastAttempt ?? "",
				...(priorProvider?.lastSuccess ? { lastSuccess: priorProvider.lastSuccess } : {}),
			});
			continue;
		}
		const providerControl = evaluateBeachEventsControl(
			await readOperationalControl(env, now), now,
			provider.controlId,
		);
		if (providerControl.state === "disabled") {
			providerResults.push({ providerId: provider.id, status: "disabled", fetched: 0, matched: 0, excluded: 0, pendingReview: 0, published: 0, ruleSuppressed: 0, unsupportedOrAmbiguous: 0, freshness: priorProvider?.lastSuccess ? "stale" : "never", lastAttempt: now.toISOString(), ...(priorProvider?.lastSuccess ? { lastSuccess: priorProvider.lastSuccess } : {}) });
			continue;
		}
		try {
			const allFacts = provider.feedType === "PDF Newsletter"
				? await fetchTownCrierFacts(env, provider, now, fetcher)
				: await (async () => {
					const response = await fetcher(provider.feedURL, { headers: { Accept: "text/calendar, text/plain;q=0.8", "User-Agent": "AlabamaBeachFlag/1.0 beach-events" } });
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					return parseICalendar(await response.text(), provider);
				})();
			const facts = allFacts.filter((fact) => Date.parse(fact.endAt) > now.getTime() - 24 * 60 * 60 * 1000 && Date.parse(fact.startAt) < now.getTime() + 400 * 24 * 60 * 60 * 1000);
			const monitored = provider.mode === "monitorOnly" || operational.state === "monitorOnly" || providerControl.state === "monitorOnly";
			const result = monitored
				? { discovered: 0, matched: facts.filter((fact) => normalizedEvent(fact, now)).length, excluded: facts.filter((fact) => !normalizedEvent(fact, now)).length, pendingReview: 0, ruleSuppressed: 0, unsupportedOrAmbiguous: facts.filter((fact) => !normalizedEvent(fact, now)).length }
				: await applyImportedEvents(env, facts, now);
			const providerEvents = (await listEvents(env)).filter((event) => event.sourceFacts.providerId === provider.id);
			providerResults.push({
				providerId: provider.id,
				status: monitored ? "monitored" : "ok",
				fetched: facts.length,
				matched: result.matched,
				excluded: result.excluded,
				pendingReview: result.pendingReview,
				published: providerEvents.filter((event) => event.status === "published" && Date.parse(event.endAt) > now.getTime()).length,
				ruleSuppressed: result.ruleSuppressed,
				unsupportedOrAmbiguous: result.unsupportedOrAmbiguous,
				freshness: "fresh",
				lastAttempt: now.toISOString(),
				lastSuccess: now.toISOString(),
			});
			observations.push({ provider: provider.id, domain: "beach_events", affectedBeachCount: 0, expectedBeachCount: 1 });
		} catch (error) {
			const message = error instanceof Error ? error.message : "provider_failure";
			providerResults.push({ providerId: provider.id, status: "failed", fetched: 0, matched: 0, excluded: 0, pendingReview: 0, published: 0, ruleSuppressed: 0, unsupportedOrAmbiguous: 0, freshness: priorProvider?.lastSuccess ? "stale" : "never", lastAttempt: now.toISOString(), ...(priorProvider?.lastSuccess ? { lastSuccess: priorProvider.lastSuccess } : {}), lastFailure: now.toISOString(), error: message });
			observations.push({ provider: provider.id, domain: "beach_events", affectedBeachCount: 1, expectedBeachCount: 1, errorReason: message });
		}
	}
	await processProviderHealthObservations(env, observations, now.toISOString());
	const snapshot = operational.state === "monitorOnly" ? null : await saveSnapshot(env, now);
	const events = await listEvents(env);
	const counts = providerResults.reduce((total, provider) => ({
		raw: total.raw + provider.fetched,
		matched: total.matched + provider.matched,
		excluded: total.excluded + provider.excluded,
		pendingReview: total.pendingReview + provider.pendingReview,
		published: total.published,
		ruleSuppressed: total.ruleSuppressed + provider.ruleSuppressed,
		unsupportedOrAmbiguous: total.unsupportedOrAmbiguous + provider.unsupportedOrAmbiguous,
	}), { ...emptyCounts(), published: events.filter((event) => event.status === "published" && Date.parse(event.endAt) > now.getTime()).length });
	const failures = providerResults.filter((item) => item.status === "failed");
	const attempted = providerResults.filter((item) => item.status !== "disabled");
	const status = operational.state === "monitorOnly" ? "monitorOnly" : attempted.length > 0 && failures.length === attempted.length ? "failed" : failures.length ? "warning" : "healthy";
	const completedAt = new Date().toISOString();
	const refresh: BeachEventRefreshStatus = {
		...running, status, completedAt, providers: providerResults, counts,
		...(failures.length ? { lastFailure: completedAt, lastFailureMessage: failures.map((item) => `${item.providerId}: ${item.error}`).join("; ") } : {}),
		...(status === "healthy" || status === "warning" ? { lastSuccess: completedAt } : {}),
		...(snapshot ? { snapshotGeneratedAt: snapshot.generatedAt, staleUntil: snapshot.staleUntil } : {}),
	};
	await env.BEACH_DATA.put(REFRESH_STATUS_KEY, JSON.stringify(refresh));
	if (options.identity) await audit(env, options.identity, "refresh_event_sources", "beach-events", refresh, now);
	const notification = await evaluateBeachActivityNotifications(env, now, { kind: "immediate", ...(options.identity ? { identity: options.identity } : {}) });
	return { outcome: status === "failed" ? "failed" as const : status === "warning" ? "partial" as const : "completed" as const, providers: providerResults, snapshot, refresh, notification };
}
