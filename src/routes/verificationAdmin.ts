import type { Env } from "../types";
import { dueVerificationSlot } from "../alerting/schedule";
import { verificationSlot } from "../verification/run";
import { historyPrefix, latestReportKey, VERIFIERS } from "../verification/registry";
import type { VerificationCheck, VerificationReport, VerificationStatus, VerifierId } from "../verification/types";

const LEGACY_PREFIX = "verification:report:";
const safeText = (value: unknown, max = 300): string | null => typeof value !== "string" || !value ? null : value.slice(0, max)
	.replace(/https?:\/\/\S+/gi, "[upstream URL redacted]").replace(/\b(?:bearer|token|secret|password|api[_-]?key)\s*[:=]?\s*\S+/gi, "[credential redacted]");
const safeIso = (value: unknown) => { const text = safeText(value, 64); return text && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : null; };
const isStatus = (value: unknown): value is VerificationStatus => ["pass", "warning", "fail"].includes(String(value));

function sanitizeCheck(value: unknown): VerificationCheck | null {
	if (!value || typeof value !== "object") return null;
	const check = value as Partial<VerificationCheck>; const name = safeText(check.name, 100), message = safeText(check.message);
	if (!name || !message || !isStatus(check.status)) return null;
	const optional = (key: "provider" | "location" | "expectedValue" | "actualValue", max: number) => safeText(check[key], max);
	return { name, status: check.status, message,
		...(optional("provider", 100) ? { provider: optional("provider", 100)! } : {}), ...(optional("location", 100) ? { location: optional("location", 100)! } : {}),
		...(optional("expectedValue", 160) ? { expectedValue: optional("expectedValue", 160)! } : {}), ...(optional("actualValue", 160) ? { actualValue: optional("actualValue", 160)! } : {}) };
}

function sanitizeReport(value: unknown, fallbackId: VerifierId): (VerificationReport & { verifierId: VerifierId }) | null {
	if (!value || typeof value !== "object") return null;
	const report = value as Partial<VerificationReport>; const slot = safeText(report.slot, 32), startedAt = safeIso(report.startedAt), completedAt = safeIso(report.completedAt);
	if (![1, 2].includes(Number(report.version)) || !slot || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3])$/.test(slot) || !startedAt || !completedAt || !isStatus(report.status) || !Array.isArray(report.checks)) return null;
	const checks = report.checks.map(sanitizeCheck).filter((item): item is VerificationCheck => Boolean(item)); if (checks.length !== report.checks.length) return null;
	const id = VERIFIERS.some((item) => item.id === report.verifierId) ? report.verifierId! : fallbackId;
	return { version: report.version as 1 | 2, verifierId: id, verifierName: safeText(report.verifierName, 100) ?? undefined, slot, startedAt, completedAt, status: report.status, checks };
}

function parseFlag(value?: string) { const [flag, purple] = value?.split("; ") ?? []; return { flag: flag || null, purple: purple === "purple=true" ? true : purple === "purple=false" ? false : null }; }
function nextExpectedSlot(now: Date): string { for (let h = 1; h <= 48; h++) { const slot = verificationSlot(new Date(now.getTime() + h * 3_600_000)); if (/T(?:07|12)$/.test(slot)) return slot; } return "unavailable"; }
function project(report: VerificationReport & { verifierId: VerifierId }) {
	const definition = VERIFIERS.find((item) => item.id === report.verifierId)!;
	const locations = definition.locations.map((location) => { const check = report.checks.find((item) => item.location === location.id || item.name === location.id); const expected = parseFlag(check?.expectedValue), actual = parseFlag(check?.actualValue); return { id: location.id, name: location.name, status: check?.status ?? "fail", officialFlag: expected.flag, publishedFlag: actual.flag, officialPurple: expected.purple, publishedPurple: actual.purple, matches: check?.status === "pass", message: check?.status === "pass" ? null : check?.message ?? "Location was not compared." }; });
	return { verifierId: report.verifierId, verifierName: definition.displayName, slot: report.slot, startedAt: report.startedAt, completedAt: report.completedAt, durationMs: Math.max(0, Date.parse(report.completedAt) - Date.parse(report.startedAt)), status: report.status, reason: report.checks.find((c) => c.status === "fail")?.message ?? report.checks.find((c) => c.status === "warning")?.message ?? null, checks: report.checks, locations, coverageCount: locations.filter((l) => l.publishedFlag !== null).length };
}

async function readReports(env: Env, id: VerifierId, includeLegacy: boolean) {
	const prefixes = [historyPrefix(id), ...(includeLegacy ? [LEGACY_PREFIX] : [])];
	const [latest, ...lists] = await Promise.all([env.BEACH_DATA.get<unknown>(latestReportKey(id), "json"), ...prefixes.map((prefix) => env.BEACH_DATA.list({ prefix, limit: 100 }))]);
	const keys = [...new Set(lists.flatMap((list) => list.keys.map((key) => key.name)))];
	const raw = await Promise.all(keys.map((key) => env.BEACH_DATA.get<unknown>(key, "json")));
	const history = raw.map((value) => sanitizeReport(value, id)).filter((r): r is VerificationReport & { verifierId: VerifierId } => Boolean(r) && r!.verifierId === id)
		.sort((a, b) => b.completedAt.localeCompare(a.completedAt)).filter((r, index, all) => all.findIndex((x) => x.slot === r.slot) === index).slice(0, 50);
	const current = sanitizeReport(latest, id) ?? history[0] ?? (includeLegacy ? sanitizeReport(await env.BEACH_DATA.get("verification:latest", "json"), id) : null);
	return { latest: current, history, legacyHistoryAvailable: includeLegacy && keys.some((key) => key.startsWith(LEGACY_PREFIX)) };
}

export async function handleVerificationAdminRequest(env: Env): Promise<Response> {
	const now = new Date(); const datasets = await Promise.all(VERIFIERS.map((v) => readReports(env, v.id, v.id === "gulf-shores-flags")));
	let alertEntries: any[] = [];
	try { const id = env.VERIFICATION_COORDINATOR.idFromName("fleet"); const response = await env.VERIFICATION_COORDINATOR.get(id).fetch("https://verification.internal/state", { method: "POST", body: JSON.stringify({ action: "state", now: now.toISOString() }) }); if (response.ok) alertEntries = ((await response.json()) as any).entries ?? []; } catch { /* admin data remains available */ }
	alertEntries = alertEntries.map((entry) => ({ verifierId: VERIFIERS.some((v) => v.id === entry?.verifierId) ? entry.verifierId : null, state: entry?.state?.active ? { active: { id: safeText(entry.state.active.id, 180), openedAt: safeIso(entry.state.active.openedAt), lastObservedAt: safeIso(entry.state.active.lastObservedAt), status: isStatus(entry.state.active.status) ? entry.state.active.status : "fail", signature: safeText(entry.state.active.signature, 300) } } : null, delivery: entry?.delivery ? { kind: ["incident", "update", "recovery"].includes(entry.delivery.kind) ? entry.delivery.kind : null, at: safeIso(entry.delivery.at), outcome: ["delivered", "failed", "disabled"].includes(entry.delivery.outcome) ? entry.delivery.outcome : null } : null }));
	const enabled = env.VERIFICATION_ALERTS_ENABLED === "true", configured = Boolean(env.VERIFICATION_ALERTS_ENABLED), ready = Boolean(env.VERIFICATION_ALERT_EMAIL);
	const dueSlot = dueVerificationSlot(now);
	const verifiers = VERIFIERS.map((definition, index) => { const data = datasets[index], latest = data.latest, reports = latest && !data.history.some((r) => r.slot === latest.slot) ? [latest, ...data.history] : data.history; const lastSuccess = reports.find((r) => r.status === "pass"); const alert = alertEntries.find((entry) => entry.verifierId === definition.id) ?? {}; return { id: definition.id, displayName: definition.displayName, provider: definition.provider, coverage: definition.locations, latest: latest ? project(latest) : null, history: data.history.map(project), lastRun: latest?.completedAt ?? null, lastSuccessfulRun: lastSuccess?.completedAt ?? null, nextExpectedRun: nextExpectedSlot(now), durationMs: latest ? project(latest).durationMs : null, reason: latest ? project(latest).reason : "No report available", scheduleHealth: { status: dueSlot && latest?.slot !== dueSlot ? "missing" : "healthy", expectedCadence: "07:00 and 12:00 America/Chicago", nextExpectedSlot: nextExpectedSlot(now) }, alerting: { enabled, configured, bindingReady: ready, activeIncident: alert.state?.active ?? null, suppressed: Boolean(alert.state?.active), recoveryPending: Boolean(alert.state?.active), lastNotification: alert.delivery ? { kind: alert.delivery.kind, timestamp: alert.delivery.at, deliveryOutcome: alert.delivery.outcome } : null }, legacyHistoryAvailable: data.legacyHistoryAvailable }; });
	const statuses = verifiers.map((v) => v.latest?.status ?? "unavailable"); const overallStatus = statuses.includes("fail") || statuses.includes("unavailable") ? "fail" : statuses.includes("warning") ? "warning" : "pass";
	const gulf = verifiers[0];
	return Response.json({ schemaVersion: 2, status: "ok", generatedAt: now.toISOString(), fleet: { overallStatus, verifierCount: verifiers.length, failingVerifierIds: verifiers.filter((v) => v.latest?.status === "fail" || !v.latest).map((v) => v.id) }, verifiers,
		emailOperations: { enabled, configured, bindingReady: ready, activationNote: "Activation requires a separately approved Worker configuration deployment." },
		// Backward-compatible v1 projection.
		summary: { overallStatus: gulf.latest?.status ?? "unavailable", coverageLabel: "Gulf Shores flags", coverageCount: 3, lastVerificationAt: gulf.lastRun, lastSuccessfulVerificationAt: gulf.lastSuccessfulRun, latestSlot: gulf.latest?.slot ?? null, nextExpectedSlot: gulf.nextExpectedRun, alertingEnabled: enabled }, latest: gulf.latest, history: gulf.history,
		coverage: [
			{ domain: "Gulf Shores official beach flags", status: "active", description: "Three Gulf Shores locations are independently verified." },
			{ domain: "Orange Beach flags", status: "active", description: "Cotton Bayou, Alabama Point, and Florida Point are independently verified." },
			...(["Fort Morgan estimated flags", "Dauphin Island", "Water quality", "Weather", "Marine forecast", "Water temperature", "Other providers"].map((domain) => ({ domain, status: "planned", description: "Not currently verified." }))),
		] }, { headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } });
}
