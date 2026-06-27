import { getLatestWaterQuality } from "../adem/service";
import {
	WATER_QUALITY_CACHE_KEY,
	writeCache,
} from "../cache/kv";

export interface WaterQualityCachePayload {
	source: string;
	generatedAt: string;
	count: number;
	waterQuality: Awaited<ReturnType<typeof getLatestWaterQuality>>;
}

export async function refreshWaterQuality(
	env: Env,
): Promise<WaterQualityCachePayload> {
	const waterQuality = await getLatestWaterQuality();

	const payload: WaterQualityCachePayload = {
		source: "Alabama Beach Flag Water Quality Service",
		generatedAt: new Date().toISOString(),
		count: waterQuality.length,
		waterQuality,
	};

	if (env.BEACH_DATA) {
		await writeCache(env.BEACH_DATA, WATER_QUALITY_CACHE_KEY, payload);
	}

	return payload;
}
