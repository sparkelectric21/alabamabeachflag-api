import type { Env } from "../types";
import { persistVerifierReport, verifierById } from "./registry";
import { readOfficialOrangeBeachState } from "./orangeBeachOfficial";
import { verificationSlot } from "./run";
import type { VerificationCheck, VerificationReport, VerificationStatus } from "./types";

const DEFINITION = verifierById("orange-beach-flags");
const canonical = (value: string) => value === "double-red" ? "doubleRed" : value;
const flagValue = (flag: string, purple: boolean) => `${canonical(flag)}; purple=${purple}`;
const worst = (checks: VerificationCheck[]): VerificationStatus => checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warning") ? "warning" : "pass";

export async function runOrangeBeachVerification(env: Env, now = new Date()): Promise<VerificationReport & { verifierId: "orange-beach-flags" }> {
	const startedAt = now.toISOString();
	const checks: VerificationCheck[] = [];
	const [official, api] = await Promise.allSettled([
		readOfficialOrangeBeachState(), fetch(new URL("/v1/beach-flags", env.VERIFICATION_API_BASE_URL)),
	]);
	if (official.status === "rejected") checks.push({ name: "official_source", status: "fail", provider: DEFINITION.provider,
		expectedValue: "recognized daily beach report", actualValue: "comparison unavailable",
		message: official.reason instanceof Error ? official.reason.message : "official_source_unavailable" });
	if (api.status === "rejected" || !api.value.ok) checks.push({ name: "public_api", status: "fail", provider: "Alabama Beach Flag API", expectedValue: "HTTP 2xx JSON beach-flag response", actualValue: "unavailable", message: "public_api_unavailable" });
	else try {
		const payload = await api.value.json() as { generatedAt?: string; beachFlags?: Array<{ beachId: string; primaryFlag: string; hasPurpleFlag: boolean }>; errors?: Array<{ beachId?: string }> };
		const generatedAt = payload.generatedAt ? Date.parse(payload.generatedAt) : NaN;
		const age = Number.isFinite(generatedAt) ? (now.getTime() - generatedAt) / 60_000 : Infinity;
		checks.push({ name: "freshness", status: age > 90 ? "fail" : age > 45 ? "warning" : "pass", provider: "Alabama Beach Flag API", expectedValue: "90 minutes old or less", actualValue: Number.isFinite(age) ? `${Math.max(0, Math.round(age))} minutes old` : "invalid generatedAt", message: Number.isFinite(age) ? `${Math.max(0, Math.round(age))} minutes old` : "missing or invalid generatedAt" });
		const errors = (payload.errors ?? []).filter((e) => e.beachId === "orange-beach" || DEFINITION.locations.some((l) => l.id === e.beachId));
		checks.push({ name: "provider_errors", status: errors.length ? "fail" : "pass", provider: DEFINITION.provider, expectedValue: "no Orange Beach provider errors", actualValue: `${errors.length} Orange Beach provider error(s)`, message: errors.length ? "orange_beach_provider_error" : "no Orange Beach provider errors" });
		for (const location of DEFINITION.locations) {
			const published = payload.beachFlags?.find((item) => item.beachId === location.id);
			if (!published) { checks.push({ name: location.id, location: location.id, provider: DEFINITION.provider, status: "fail", expectedValue: "published location", actualValue: "missing", message: "missing_location" }); continue; }
			if (official.status === "rejected") continue;
			const primaryMatches = canonical(published.primaryFlag) === official.value.primaryFlag;
			const purpleMatches = published.hasPurpleFlag === official.value.hasPurpleFlag;
			checks.push({ name: location.id, location: location.id, provider: DEFINITION.provider, status: primaryMatches && purpleMatches ? "pass" : "fail",
				expectedValue: flagValue(official.value.primaryFlag, official.value.hasPurpleFlag), actualValue: flagValue(published.primaryFlag, published.hasPurpleFlag),
				message: !primaryMatches ? "primary_flag_mismatch" : !purpleMatches ? "purple_advisory_mismatch" : "flag and purple advisory match" });
		}
	} catch { checks.push({ name: "public_api", status: "fail", provider: "Alabama Beach Flag API", expectedValue: "valid beach-flag JSON", actualValue: "invalid response", message: "public_api_invalid_response" }); }
	const report = { version: 2 as const, verifierId: "orange-beach-flags" as const, verifierName: DEFINITION.displayName, slot: verificationSlot(now), startedAt, completedAt: new Date().toISOString(), status: worst(checks), checks };
	await persistVerifierReport(env, report);
	return report;
}
