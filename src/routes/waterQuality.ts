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
		return Response.json(
			{
				status: "unavailable",
				message:
					"Water quality cache is unavailable. Please try again shortly.",
			},
			{ status: 503 },
		);
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