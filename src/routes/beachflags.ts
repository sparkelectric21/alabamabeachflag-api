import {
	BEACH_FLAGS_CACHE_KEY,
	readCache,
} from "../services/cache/kv";
import type { Env } from "../types";

export async function handleBeachFlagsRequest(env: Env): Promise<Response> {
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

	return Response.json(payload);
}
