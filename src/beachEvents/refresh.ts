import type { AdminIdentity } from "../services/admin/auth";
import type { Env } from "../types";
import { processProviderHealthObservations } from "../providerHealth/process";
import { readOperationalControl, evaluateBeachEventsControl } from "../operationalControl/store";
import { parseICalendar } from "./ical";
import { BEACH_EVENT_PROVIDERS } from "./providers";
import { BEACH_EVENT_SCHEDULE_DESCRIPTION, nextBeachEventRefresh } from "./schedule";
import { applyImportedEvents, audit, eventNeedsReview, listEvents, normalizedEvent, reconcileProviderSource, saveSnapshot, SNAPSHOT_KEY } from "./store";
import { BEACH_EVENT_REFRESH_STATUS_KEY, type BeachEventProviderRefresh, type BeachEventRefreshStatus } from "./types";
import { fetchTownCrierFacts } from "./townCrier";

export const REFRESH_STATUS_KEY = BEACH_EVENT_REFRESH_STATUS_KEY;
const RUN_LOCK_MS = 10 * 60 * 1000;

interface RefreshOptions {
	trigger?: "scheduled" | "admin";
	identity?: AdminIdentity;
}

const emptyCounts = () => ({ raw: 0, matched: 0, excluded: 0, pendingReview: 0, published: 0, ruleSuppressed: 0, unsupportedOrAmbiguous: 0, newEvents: 0, changed: 0, unchanged: 0, possibleDuplicates: 0, warnings: 0, missingFromSource: 0, restored: 0 });

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
	const priorSnapshot = await env.BEACH_DATA.get(SNAPSHOT_KEY, "json") as { revision?: string } | null;
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
		return { outcome: "disabled" as const, providers: [], snapshot: null, refresh };
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
				? { discovered: 0, newEvents: 0, changed: 0, unchanged: 0, matched: facts.filter((fact) => normalizedEvent(fact, now)).length, excluded: facts.filter((fact) => !normalizedEvent(fact, now)).length, pendingReview: 0, ruleSuppressed: 0, unsupportedOrAmbiguous: facts.filter((fact) => !normalizedEvent(fact, now)).length, possibleDuplicates: 0, warnings: 0, restored: 0 }
				: await applyImportedEvents(env, facts, now, trigger);
			const reconciliation = monitored
				? { missingFromSource: 0, newlyRemoved: 0 }
				: await reconcileProviderSource(env, provider.id, new Set(allFacts.map((fact) => fact.externalId)), now, trigger);
			const providerEvents = (await listEvents(env)).filter((event) => event.sourceFacts.providerId === provider.id);
			providerResults.push({
				providerId: provider.id,
				status: monitored ? "monitored" : "ok",
				fetched: facts.length,
				matched: result.matched,
				excluded: result.excluded,
				pendingReview: providerEvents.filter(eventNeedsReview).length,
				published: providerEvents.filter((event) => event.status === "published" && Date.parse(event.endAt) > now.getTime()).length,
				ruleSuppressed: result.ruleSuppressed,
				unsupportedOrAmbiguous: result.unsupportedOrAmbiguous,
				newEvents: result.newEvents,
				changed: result.changed,
				unchanged: result.unchanged,
				possibleDuplicates: result.possibleDuplicates,
				warnings: result.warnings + reconciliation.newlyRemoved,
				missingFromSource: reconciliation.missingFromSource,
				restored: result.restored,
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
	const failures = providerResults.filter((item) => item.status === "failed");
	const attempted = providerResults.filter((item) => item.status !== "disabled");
	const allAttemptedProvidersFailed = attempted.length > 0 && failures.length === attempted.length;
	// Never extend the last-known-good window when no source succeeded.
	const snapshot = operational.state === "monitorOnly" || allAttemptedProvidersFailed ? null : await saveSnapshot(env, now, { sourceRefresh: true });
	const publicRevisionChanged = Boolean(snapshot && snapshot.revision !== priorSnapshot?.revision);
	const events = await listEvents(env);
	const counts = providerResults.reduce((total, provider) => ({
		raw: total.raw + provider.fetched,
		matched: total.matched + provider.matched,
		excluded: total.excluded + provider.excluded,
		pendingReview: total.pendingReview + provider.pendingReview,
		published: total.published,
		ruleSuppressed: total.ruleSuppressed + provider.ruleSuppressed,
		unsupportedOrAmbiguous: total.unsupportedOrAmbiguous + provider.unsupportedOrAmbiguous,
		newEvents: total.newEvents + (provider.newEvents ?? 0),
		changed: total.changed + (provider.changed ?? 0),
		unchanged: total.unchanged + (provider.unchanged ?? 0),
		possibleDuplicates: total.possibleDuplicates + (provider.possibleDuplicates ?? 0),
		warnings: total.warnings + (provider.warnings ?? 0),
		missingFromSource: total.missingFromSource + (provider.missingFromSource ?? 0),
		restored: total.restored + (provider.restored ?? 0),
	}), { ...emptyCounts(), published: events.filter((event) => event.status === "published" && Date.parse(event.endAt) > now.getTime()).length });
	const status = operational.state === "monitorOnly" ? "monitorOnly" : attempted.length > 0 && failures.length === attempted.length ? "failed" : failures.length ? "warning" : "healthy";
	const completedAt = new Date().toISOString();
	const refresh: BeachEventRefreshStatus = {
		...running, status, completedAt, providers: providerResults, counts, publicRevisionChanged,
		...(failures.length ? { lastFailure: completedAt, lastFailureMessage: failures.map((item) => `${item.providerId}: ${item.error}`).join("; ") } : {}),
		...(status === "healthy" || status === "warning" ? { lastSuccess: completedAt } : {}),
		...(snapshot ? { snapshotGeneratedAt: snapshot.generatedAt, staleUntil: snapshot.staleUntil } : {}),
	};
	await env.BEACH_DATA.put(REFRESH_STATUS_KEY, JSON.stringify(refresh));
	if (options.identity) await audit(env, options.identity, "refresh_event_sources", "beach-events", refresh, now, { changedFields: ["refresh"], publicOutputAffected: publicRevisionChanged, reason: trigger });
	return { outcome: status === "failed" ? "failed" as const : status === "warning" ? "partial" as const : "completed" as const, providers: providerResults, snapshot, refresh };
}
