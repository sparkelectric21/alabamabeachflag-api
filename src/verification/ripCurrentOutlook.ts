import type { Env } from "../types";
const VERIFICATION_TIMEOUT_MS = 5_000;

async function verificationFetch(url: URL, timeoutMs: number): Promise<Response> {
	return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

export async function runRipCurrentOutlookVerification(env: Env, now = new Date(), timeoutMs = VERIFICATION_TIMEOUT_MS) {
	const checks: Array<{ name: string; status: "pass" | "warning" | "fail"; message: string }> = [];
	try {
		const metadataResponse = await verificationFetch(new URL("/v1/rip-current-outlook", env.VERIFICATION_API_BASE_URL), timeoutMs);
		if (!metadataResponse.ok) throw new Error("metadata_unavailable");
		const metadata = await metadataResponse.json<{ provider?: string; sourceUrl?: string; revision?: string; freshness?: string; usingCachedImage?: boolean }>();
		checks.push({ name: "schema", status: metadata.revision ? "pass" : "fail", message: metadata.revision ? "metadata schema valid" : "missing revision" });
		checks.push({ name: "provider", status: metadata.provider === "National Weather Service Mobile/Pensacola" ? "pass" : "fail", message: metadata.provider ?? "missing provider" });
		let official = false; try { official = new URL(metadata.sourceUrl ?? "").hostname === "www.weather.gov"; } catch { official = false; }
		checks.push({ name: "source", status: official ? "pass" : "fail", message: official ? "official weather.gov source" : "source is not official weather.gov" });
		const reported = metadata.freshness === "current" || (metadata.freshness === "stale" && metadata.usingCachedImage === true);
		checks.push({ name: "freshness", status: reported ? (metadata.freshness === "current" ? "pass" : "warning") : "fail", message: metadata.freshness === "current" ? "current outlook" : "cached fallback explicitly reported" });
		const imageResponse = await verificationFetch(new URL("/v1/rip-current-outlook/image", env.VERIFICATION_API_BASE_URL), timeoutMs);
		const imageType = imageResponse.headers.get("Content-Type")?.toLowerCase() ?? "";
		const etag = imageResponse.headers.get("ETag")?.replaceAll('"', "");
		checks.push({ name: "image", status: imageResponse.ok && imageType.startsWith("image/") ? "pass" : "fail", message: imageResponse.ok && imageType.startsWith("image/") ? imageType : "image unavailable or invalid" });
		checks.push({ name: "revision", status: etag === metadata.revision ? "pass" : "fail", message: etag === metadata.revision ? "image and metadata revisions agree" : "revision mismatch" });
	} catch (error) { checks.push({ name: "availability", status: "fail", message: error instanceof Error ? error.message : "verification_failed" }); }
	const status = checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "warning") ? "warning" : "pass";
	const report = { version: 1, checkedAt: now.toISOString(), status, checks };
	await env.BEACH_DATA.put("verification:rip-current-outlook:latest", JSON.stringify(report));
	return report;
}
