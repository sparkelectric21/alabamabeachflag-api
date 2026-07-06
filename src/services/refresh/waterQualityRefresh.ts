import { elapsedMs, logError, logInfo } from "../../utils/logger";
import { getLatestWaterQuality } from "../adem/service";
import {
	WATER_QUALITY_CACHE_KEY,
	readCache,
	writeCache,
} from "../cache/kv";

export interface WaterQualityCachePayload {
	status: "ok";
	apiVersion: "1.0.0";
	source: "ADEM";
	generatedAt: string;
	lastSuccessfulRefresh: string;
	count: number;
	waterQuality: Awaited<ReturnType<typeof getLatestWaterQuality>>;
}

export async function refreshWaterQuality(
	env: Env,
): Promise<WaterQualityCachePayload> {
	const startedAt = Date.now();
	logInfo("Water Quality", "Starting refresh");
	try {
		const waterQuality = await getLatestWaterQuality();

		const refreshedAt = new Date().toISOString();

		const payload: WaterQualityCachePayload = {
			status: "ok",
			apiVersion: "1.0.0",
			source: "ADEM",
			generatedAt: refreshedAt,
			lastSuccessfulRefresh: refreshedAt,
			count: waterQuality.length,
			waterQuality,
		};

		if (!env.BEACH_DATA) {
			throw new Error("Missing KV binding: BEACH_DATA");
		}

		await writeCache(env.BEACH_DATA, WATER_QUALITY_CACHE_KEY, payload);

		const cachedPayload = await readCache<unknown>(
			env.BEACH_DATA,
			WATER_QUALITY_CACHE_KEY,
		);

		if (!cachedPayload) {
			throw new Error("Water quality cache write verification failed.");
		}

		logInfo("Water Quality", "Finished refresh", {
			durationMs: elapsedMs(startedAt),
			count: waterQuality.length,
		});
		return payload;
	} catch (error) {
		logError("Water Quality", "Refresh failed", {
			error: error instanceof Error ? error.message : String(error),
			durationMs: elapsedMs(startedAt),
		});
		throw error;
	}
}
