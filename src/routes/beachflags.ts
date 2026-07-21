import {
	BEACH_FLAGS_CACHE_KEY,
	readCache,
} from "../services/cache/kv";
import type { Env } from "../types";

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

	return Response.json(withIos12DoubleRedCompatibility(
		payload,
		env.IOS_1_2_DOUBLE_RED_COMPATIBILITY === "true",
	));
}
