import type { Env } from "../types";
import { readOfficialGulfShoresState } from "./officialSource";
import type { VerificationCheck, VerificationReport, VerificationStatus } from "./types";

const BEACHES = [
	"gulf-shores-public-beach",
	"gulf-state-park-pavilion",
	"little-lagoon-pass",
];

const PROVIDER = "City of Gulf Shores";

function canonicalPrimaryFlag(value: string): string {
	return value === "double-red" ? "doubleRed" : value;
}

function flagValue(primaryFlag: string, hasPurpleFlag: boolean): string {
	return `${canonicalPrimaryFlag(primaryFlag)}; purple=${hasPurpleFlag}`;
}

function worst(checks: VerificationCheck[]): VerificationStatus {
	return checks.some((check) => check.status === "fail")
		? "fail"
		: checks.some((check) => check.status === "warning") ? "warning" : "pass";
}

export function verificationSlot(date: Date): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "America/Chicago",
		year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
	return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}`;
}

export function isVerificationHour(date: Date): boolean {
	const hour = verificationSlot(date).slice(-2);
	return hour === "07" || hour === "12";
}

export async function runVerification(env: Env, now = new Date()): Promise<VerificationReport> {
	const startedAt = now.toISOString();
	const checks: VerificationCheck[] = [];
	const [officialResult, apiResult] = await Promise.allSettled([
		readOfficialGulfShoresState(),
		fetch(new URL("/v1/beach-flags", env.VERIFICATION_API_BASE_URL)),
	]);
	if (officialResult.status === "rejected") {
		checks.push({
			name: "official_source",
			status: "warning",
			provider: PROVIDER,
			message: officialResult.reason instanceof Error
				? officialResult.reason.message
				: "official_source_unavailable",
		});
	}
	if (apiResult.status === "rejected" || !apiResult.value.ok) {
		checks.push({
			name: "public_api", status: "fail", provider: "Alabama Beach Flag API",
			expectedValue: "HTTP 2xx JSON beach-flag response", actualValue: "unavailable",
			message: "public_api_unavailable",
		});
	} else {
		try {
			const payload = await apiResult.value.json() as {
			generatedAt?: string;
			beachFlags?: Array<{ beachId: string; primaryFlag: string; hasPurpleFlag: boolean }>;
				errors?: Array<{ beachId?: string; message?: string }>;
			};
			const generatedAt = payload.generatedAt ? Date.parse(payload.generatedAt) : Number.NaN;
			const ageMinutes = Number.isFinite(generatedAt)
				? (now.getTime() - generatedAt) / 60_000
				: Number.POSITIVE_INFINITY;
			checks.push({
				name: "freshness",
				provider: "Alabama Beach Flag API",
				expectedValue: "90 minutes old or less",
				actualValue: Number.isFinite(ageMinutes) ? `${Math.max(0, Math.round(ageMinutes))} minutes old` : "invalid generatedAt",
				status: ageMinutes > 90 ? "fail" : ageMinutes > 45 ? "warning" : "pass",
				message: Number.isFinite(ageMinutes)
					? `${Math.max(0, Math.round(ageMinutes))} minutes old`
					: "missing or invalid generatedAt",
			});
			const providerErrors = (payload.errors ?? []).filter((error) =>
				typeof error.beachId === "string"
				&& (BEACHES.includes(error.beachId) || error.beachId === "gulf-shores"));
			checks.push({
				name: "provider_errors",
				provider: PROVIDER,
				expectedValue: "no Gulf Shores provider errors",
				actualValue: `${providerErrors.length} Gulf Shores provider error(s)`,
				status: providerErrors.length > 0 ? "fail" : "pass",
				message: providerErrors.length > 0
					? `Gulf Shores provider reported ${providerErrors.length} error(s)`
					: "no Gulf Shores provider errors",
			});
			for (const beachId of BEACHES) {
				const published = payload.beachFlags?.find((item) => item.beachId === beachId);
				if (!published) {
					checks.push({
						name: beachId, status: "fail", provider: PROVIDER, location: beachId,
						expectedValue: "published location", actualValue: "missing",
						message: "missing_location",
					});
					continue;
				}
				if (officialResult.status === "rejected") continue;
				const actualPrimaryFlag = canonicalPrimaryFlag(published.primaryFlag);
				const matches = actualPrimaryFlag === officialResult.value.primaryFlag
					&& published.hasPurpleFlag === officialResult.value.hasPurpleFlag;
				checks.push({
					name: beachId,
					provider: PROVIDER,
					location: beachId,
					status: matches ? "pass" : "fail",
					message: matches ? "flag and purple advisory match" : "published result differs from official source",
					expectedValue: flagValue(officialResult.value.primaryFlag, officialResult.value.hasPurpleFlag),
					actualValue: flagValue(actualPrimaryFlag, published.hasPurpleFlag),
				});
			}
		} catch {
			checks.push({
				name: "public_api", status: "fail", provider: "Alabama Beach Flag API",
				expectedValue: "valid beach-flag JSON", actualValue: "invalid response",
				message: "public_api_invalid_response",
			});
		}
	}
	const report: VerificationReport = {
		version: 1,
		slot: verificationSlot(now),
		startedAt,
		completedAt: new Date().toISOString(),
		status: worst(checks),
		checks,
	};
	await Promise.all([
		env.BEACH_DATA.put("verification:latest", JSON.stringify(report)),
		env.BEACH_DATA.put(`verification:report:${report.startedAt.slice(0, 10)}:${report.slot.slice(-2)}`, JSON.stringify(report), {
			expirationTtl: 30 * 24 * 60 * 60,
		}),
	]);
	return report;
}
