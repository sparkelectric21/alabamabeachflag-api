import { refreshWaterQuality } from "../services/refresh/waterQualityRefresh";
import {
	readCache,
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

		const payload = await refreshWaterQuality(env);

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