import {
	BEACH_CONDITIONS_CACHE_KEY,
	readCache,
} from "../services/cache/kv";

export async function handleBeachConditionsRequest(env: Env): Promise<Response> {
	if (!env.BEACH_DATA) {
		return Response.json(
			{
				status: "error",
				message: "Beach conditions cache is not configured.",
			},
			{ status: 500 },
		);
	}

	const cachedBeachConditions = await readCache<unknown>(
		env.BEACH_DATA,
		BEACH_CONDITIONS_CACHE_KEY,
	);

	if (cachedBeachConditions) {
		return Response.json(cachedBeachConditions);
	}

	return Response.json(
		{
			status: "unavailable",
			message: "Beach conditions cache is unavailable. Please try again shortly.",
		},
		{ status: 503 },
	);
}