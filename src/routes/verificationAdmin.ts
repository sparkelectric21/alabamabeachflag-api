import type { Env } from "../types";
import { verificationSlot } from "../verification/run";
import type { VerificationCheck, VerificationReport, VerificationStatus } from "../verification/types";

const REPORT_PREFIX = "verification:report:";
const LOCATIONS = new Map([
	["gulf-shores-public-beach", "Gulf Shores Public Beach"],
	["gulf-state-park-pavilion", "Gulf State Park Pavilion"],
	["little-lagoon-pass", "Little Lagoon Pass"],
]);

const safeText = (value: unknown, max = 300): string | null => {
	if (typeof value !== "string" || value.length === 0) return null;
	return value.slice(0, max)
		.replace(/https?:\/\/\S+/gi, "[upstream URL redacted]")
		.replace(/\b(?:bearer|token|secret|password|api[_-]?key)\s*[:=]?\s*\S+/gi, "[credential redacted]");
};
const safeIso = (value: unknown): string | null => {
	const text = safeText(value, 64);
	return text && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : null;
};
const isStatus = (value: unknown): value is VerificationStatus => ["pass", "warning", "fail"].includes(String(value));

function sanitizeCheck(value: unknown): VerificationCheck | null {
	if (!value || typeof value !== "object") return null;
	const check = value as Partial<VerificationCheck>;
	const name = safeText(check.name, 100), message = safeText(check.message);
	if (!name || !message || !isStatus(check.status)) return null;
	return {
		name, status: check.status, message,
		...(safeText(check.provider, 100) ? { provider: safeText(check.provider, 100)! } : {}),
		...(safeText(check.location, 100) ? { location: safeText(check.location, 100)! } : {}),
		...(safeText(check.expectedValue, 160) ? { expectedValue: safeText(check.expectedValue, 160)! } : {}),
		...(safeText(check.actualValue, 160) ? { actualValue: safeText(check.actualValue, 160)! } : {}),
	};
}

function sanitizeReport(value: unknown): VerificationReport | null {
	if (!value || typeof value !== "object") return null;
	const report = value as Partial<VerificationReport>;
	const slot = safeText(report.slot, 32), startedAt = safeIso(report.startedAt), completedAt = safeIso(report.completedAt);
	if (report.version !== 1 || !slot || !/^\d{4}-\d{2}-\d{2}T(?:07|12)$/.test(slot) || !startedAt || !completedAt || !isStatus(report.status) || !Array.isArray(report.checks)) return null;
	const checks = report.checks.map(sanitizeCheck).filter((item): item is VerificationCheck => Boolean(item));
	if (checks.length !== report.checks.length) return null;
	return { version: 1, slot, startedAt, completedAt, status: report.status, checks };
}

function parseFlag(value: string | undefined): { flag: string | null; hasPurpleFlag: boolean | null } {
	if (!value) return { flag: null, hasPurpleFlag: null };
	const [flag, purple] = value.split("; ");
	return { flag: flag || null, hasPurpleFlag: purple === "purple=true" ? true : purple === "purple=false" ? false : null };
}

function projectReport(report: VerificationReport) {
	const locations = [...LOCATIONS].map(([id, name]) => {
		const check = report.checks.find((item) => item.location === id || item.name === id);
		const official = parseFlag(check?.expectedValue), published = parseFlag(check?.actualValue);
		return {
			id, name, status: check?.status ?? (report.status === "warning" ? "warning" : "fail"), officialFlag: official.flag, publishedFlag: published.flag,
			officialPurple: official.hasPurpleFlag, publishedPurple: published.hasPurpleFlag,
			matches: check?.status === "pass", message: check?.status === "pass" ? null : check?.message ?? "Location was not present in the report.",
		};
	});
	const officialCheck = report.checks.find((item) => item.name === "official_source");
	const freshness = report.checks.find((item) => item.name === "freshness");
	return {
		slot: report.slot, startedAt: report.startedAt, completedAt: report.completedAt,
		durationMs: Math.max(0, Date.parse(report.completedAt) - Date.parse(report.startedAt)), status: report.status,
		reason: report.checks.find((item) => item.status === "fail")?.message ?? report.checks.find((item) => item.status === "warning")?.message ?? null,
		officialSource: { provider: "City of Gulf Shores", observedAt: null, flag: locations[0]?.officialFlag ?? null, hasPurpleFlag: locations[0]?.officialPurple ?? null },
		publishedResult: { flag: locations[0]?.publishedFlag ?? null, hasPurpleFlag: locations[0]?.publishedPurple ?? null, fetchedAt: freshness ? report.startedAt : null },
		checks: report.checks, locations, wouldAlert: report.status === "fail",
		officialSourceAvailable: !officialCheck, coverageCount: locations.filter((item) => item.publishedFlag !== null).length,
	};
}

function nextExpectedSlot(now: Date): string {
	for (let offset = 1; offset <= 48; offset++) {
		const slot = verificationSlot(new Date(now.getTime() + offset * 60 * 60 * 1000));
		if (slot.endsWith("T07") || slot.endsWith("T12")) return slot;
	}
	return "unavailable";
}

export async function handleVerificationAdminRequest(env: Pick<Env, "BEACH_DATA" | "VERIFICATION_ALERTS_ENABLED" | "VERIFICATION_ALERT_EMAIL">): Promise<Response> {
	const now = new Date();
	const [rawLatest, listed] = await Promise.all([
		env.BEACH_DATA.get<unknown>("verification:latest", "json"),
		env.BEACH_DATA.list({ prefix: REPORT_PREFIX, limit: 100 }),
	]);
	const rawHistory = await Promise.all(listed.keys.map((key) => env.BEACH_DATA.get<unknown>(key.name, "json")));
	const historyReports = rawHistory.map(sanitizeReport).filter((item): item is VerificationReport => Boolean(item))
		.sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, 50);
	const latestReport = sanitizeReport(rawLatest) ?? historyReports[0] ?? null;
	const reports = latestReport && !historyReports.some((item) => item.slot === latestReport.slot) ? [latestReport, ...historyReports] : historyReports;
	const lastSuccess = reports.filter((item) => item.status === "pass").sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0];
	const alertingEnabled = env.VERIFICATION_ALERTS_ENABLED === "true";
	return Response.json({
		schemaVersion: 1, status: "ok", generatedAt: now.toISOString(),
		summary: {
			overallStatus: latestReport?.status ?? "unavailable", coverageLabel: "Gulf Shores flags", coverageCount: 3,
			lastVerificationAt: latestReport?.completedAt ?? null, lastSuccessfulVerificationAt: lastSuccess?.completedAt ?? null,
			latestSlot: latestReport?.slot ?? null, nextExpectedSlot: nextExpectedSlot(now), alertingEnabled,
		},
		latest: latestReport ? projectReport(latestReport) : null,
		history: historyReports.map(projectReport),
		coverage: [
			{ domain: "Gulf Shores official beach flags", status: "active", description: "Gulf Shores Public Beach, Gulf State Park Pavilion, and Little Lagoon Pass are verified against the City of Gulf Shores." },
			{ domain: "Orange Beach flags", status: "planned", description: "Not currently verified." },
			{ domain: "Fort Morgan estimated flags", status: "planned", description: "Not currently verified." },
			{ domain: "Dauphin Island", status: "planned", description: "Not currently verified." },
			{ domain: "Water quality", status: "planned", description: "Not currently verified." },
			{ domain: "Weather", status: "planned", description: "Not currently verified." },
			{ domain: "Marine forecast", status: "planned", description: "Not currently verified." },
			{ domain: "Water temperature", status: "planned", description: "Not currently verified." },
			{ domain: "Other providers", status: "planned", description: "Not currently verified." },
		],
	}, { headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } });
}
