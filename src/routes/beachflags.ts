import {
	BEACH_FLAGS_CACHE_KEY,
	readCache,
} from "../services/cache/kv";
import type { Env } from "../types";
import { evaluateFlagControl, readOperationalControl } from "../operationalControl/store";
import type { AvailabilityReason, FlagProvider, OperationalControlDocument } from "../operationalControl/types";

const IOS_1_2_DOUBLE_RED_VALUE = "double-red";

export function withIos12DoubleRedCompatibility(payload: unknown, enabled: boolean): unknown {
	if (!enabled || !payload || typeof payload !== "object") return payload;

	const beachFlags = (payload as { beachFlags?: unknown }).beachFlags;
	if (!Array.isArray(beachFlags)) return payload;

	return {
		...payload,
		beachFlags: beachFlags.map((flag) => {
			if (!flag || typeof flag !== "object") return flag;
			if ((flag as { primaryFlag?: unknown }).primaryFlag !== "doubleRed") return flag;

			return {
				...flag,
				// Temporary App Store 1.2.0 compatibility: its lowercased decoder
				// recognizes "double-red", but treats canonical "doubleRed" as Yellow.
				primaryFlag: IOS_1_2_DOUBLE_RED_VALUE,
			};
		}),
	};
}

const GULF_SHORES_BEACHES = new Set(["gulf-shores-public-beach", "gulf-state-park-pavilion", "little-lagoon-pass", "fort-morgan-public-beach"]);
const ORANGE_BEACH_BEACHES = new Set(["cotton-bayou", "alabama-point", "florida-point"]);
const ALL_BEACHES = [
	...GULF_SHORES_BEACHES,
	...ORANGE_BEACH_BEACHES,
	"dauphin-island-public-beach",
	"dauphin-island-east-end",
];
export const FLAG_MAX_AGE_MS = 60 * 60 * 1_000;

function providerForBeach(beachId: string): FlagProvider | null {
	if (GULF_SHORES_BEACHES.has(beachId)) return "gulfShoresFlags";
	if (ORANGE_BEACH_BEACHES.has(beachId)) return "orangeBeachFlags";
	return null;
}

function availabilityReasonForError(message: unknown): AvailabilityReason {
	return message === "validation_failed" ? "validation_failed" : "provider_unavailable";
}

export function enforceBeachFlagPayload(payload: unknown, doc: OperationalControlDocument, now = new Date(), endpoint = "/v2/beach-flags") {
	const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
	const reports = Array.isArray(body.beachFlags) ? body.beachFlags.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object")) : [];
	const errors = Array.isArray(body.errors) ? body.errors.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object")) : [];
	const availability = new Map<string, Record<string, unknown>>();
	const publishable: Record<string, unknown>[] = [];

	for (const report of reports) {
		const beachId = String(report.beachId ?? "");
		const provider = providerForBeach(beachId);
		const control = provider ? evaluateFlagControl(doc, provider, now) : null;
		const lastUpdated = typeof report.lastUpdated === "string" ? new Date(report.lastUpdated) : null;
		const validFlag = ["green", "yellow", "red", "doubleRed"].includes(String(report.primaryFlag));
		const stale = !lastUpdated || Number.isNaN(lastUpdated.valueOf()) || now.valueOf() - lastUpdated.valueOf() > FLAG_MAX_AGE_MS;
		if (control?.state === "monitorOnly") console.log("[Operational Control]", JSON.stringify({ event: "monitor_only_evaluation", endpoint, provider, beaches: [beachId], effectiveState: control.state, revision: control.revision, wouldBlock: true }));
		if (control?.state === "disabled") {
			availability.set(beachId, { beachId, status: "unavailable", reason: "temporarily_disabled", effectiveAt: control.effectiveAt, retryAfter: control.retryAfter, controlRevision: control.revision });
		} else if (!validFlag) {
			availability.set(beachId, { beachId, status: "unavailable", reason: "validation_failed", effectiveAt: report.lastUpdated ?? null, retryAfter: null, controlRevision: doc.revision });
		} else if (stale) {
			availability.set(beachId, { beachId, status: "unavailable", reason: "stale", effectiveAt: report.lastUpdated ?? null, retryAfter: null, controlRevision: doc.revision });
		} else {
			publishable.push(report);
			availability.set(beachId, { beachId, status: "available", reason: null, effectiveAt: report.lastUpdated, retryAfter: null, controlRevision: doc.revision });
		}
	}

	for (const error of errors) {
		const beachId = String(error.beachId ?? "");
		if (beachId && !availability.has(beachId)) availability.set(beachId, { beachId, status: "unavailable", reason: availabilityReasonForError(error.message), effectiveAt: body.generatedAt ?? null, retryAfter: null, controlRevision: doc.revision });
	}
	for (const beachId of ALL_BEACHES) {
		if (availability.has(beachId)) continue;
		const provider = providerForBeach(beachId);
		const control = provider ? evaluateFlagControl(doc, provider, now) : null;
		availability.set(beachId, { beachId, status: "unavailable", reason: control?.state === "disabled" ? "temporarily_disabled" : "provider_unavailable", effectiveAt: control?.effectiveAt ?? body.generatedAt ?? null, retryAfter: control?.retryAfter ?? null, controlRevision: doc.revision });
	}
	return { ...body, status: publishable.length === reports.length && publishable.length > 0 ? "ok" : publishable.length > 0 ? "partial" : "unavailable", count: publishable.length, beachFlags: publishable, availability: [...availability.values()] };
}

export function parseClientIdentification(request: Request) {
	const capabilities = new Set((request.headers.get("X-ABF-Capabilities") ?? "").split(",").map((value) => value.trim()).filter(Boolean));
	const buildText = request.headers.get("X-ABF-App-Build");
	return { version: request.headers.get("X-ABF-App-Version"), build: buildText && /^\d+$/.test(buildText) ? Number(buildText) : null, client: request.headers.get("X-ABF-Client"), capabilities };
}

export async function handleBeachFlagsRequest(request: Request, env: Env, contract: "v1" | "v2" = "v1", now = new Date()): Promise<Response> {
	if (!env.BEACH_DATA) {
		return Response.json(
			{
				status: "unavailable",
				message: "Beach flags cache is unavailable. Please try again shortly.",
			},
			{ status: 503 },
		);
	}

	const payload = await readCache(env.BEACH_DATA, BEACH_FLAGS_CACHE_KEY);

	if (!payload) {
		return Response.json(
			{
				status: "unavailable",
				message: "Beach flags cache is unavailable. Please try again shortly.",
			},
			{ status: 503 },
		);
	}

	const doc = await readOperationalControl(env, now);
	const enforced = enforceBeachFlagPayload(payload, doc, now, contract === "v2" ? "/v2/beach-flags" : "/v1/beach-flags");
	const client = parseClientIdentification(request);
	const responsePayload = contract === "v2"
		? enforced
		: (() => {
			const original = payload as Record<string, unknown>;
			const originalReports = Array.isArray(original.beachFlags) ? original.beachFlags : [];
			if (originalReports.length === 0 || enforced.beachFlags.length === originalReports.length) return original;
			return { ...original, status: enforced.status, count: enforced.count, beachFlags: enforced.beachFlags };
		})();
	return Response.json(withIos12DoubleRedCompatibility(responsePayload, env.IOS_1_2_DOUBLE_RED_COMPATIBILITY === "true" && !client.capabilities.has("flag-availability-v2")), { headers: { "Cache-Control": "no-store" } });
}
