import { getLatestWaterQuality } from "../services/adem/service";
import {
	readCache,
	writeCache,
	WATER_QUALITY_CACHE_KEY,
} from "../services/cache/kv";

export async function handleWaterQualityRequest(env: Env): Promise<Response> {
	try {
		const hasCache = Boolean(env.BEACH_DATA);

		if (hasCache) {
			const cached = await readCache<unknown>(
				env.BEACH_DATA,
				WATER_QUALITY_CACHE_KEY,
			);

			if (cached) {
				return Response.json(cached);
			}
		}

		const waterQuality = await getLatestWaterQuality();

		const payload = {
			source: "Alabama Beach Flag Water Quality Service",
			generatedAt: new Date().toISOString(),
			count: waterQuality.length,
			waterQuality,
		};

		if (hasCache) {
			await writeCache(env.BEACH_DATA, WATER_QUALITY_CACHE_KEY, payload);
		}

		return Response.json(payload);
	} catch (error) {
		return Response.json(
			{
				error: "Failed to load water quality",
				message: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}