import { getLatestWaterQuality } from "../adem/service";
import {
	WATER_QUALITY_CACHE_KEY,
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

	if (env.BEACH_DATA) {
		await writeCache(env.BEACH_DATA, WATER_QUALITY_CACHE_KEY, payload);
	}

	return payload;
}
