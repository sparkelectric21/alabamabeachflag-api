

import { BEACH_FLAGS_CACHE_KEY, writeCache } from "../cache/kv";
import { BeachFlagReport } from "./types";
import { getDauphinIslandFlags } from "./providers/dauphinIsland";
import { getFortMorganFlags } from "./providers/fortMorgan";
import { getGulfShoresFlags } from "./providers/gulfshores";
import { getOrangeBeachFlags } from "./providers/orangeBeach";

export async function refreshBeachFlags(env: Env) {
	const generatedAt = new Date().toISOString();

	const gulfShores = await getGulfShoresFlags(generatedAt);
	const orangeBeach = await getOrangeBeachFlags(generatedAt);
	const dauphinIsland = await getDauphinIslandFlags();

	const gulfReference = gulfShores.reports.find(
		(report) => report.beachId === "gulf-shores-public-beach",
	);

	const fortMorgan = getFortMorganFlags(generatedAt, gulfReference);

	const beachFlags: BeachFlagReport[] = [
		...gulfShores.reports,
		...orangeBeach.reports,
		...fortMorgan,
		...dauphinIsland.reports,
	];

	const errors = [
		...gulfShores.errors,
		...orangeBeach.errors,
		...dauphinIsland.errors,
	];

	const payload = {
		status: beachFlags.length > 0 ? "ok" : "unavailable",
		apiVersion: "1.0.0",
		source: "Official municipal beach flag sources",
		generatedAt,
		lastSuccessfulRefresh: generatedAt,
		count: beachFlags.length,
		beachFlags,
		errors,
	};

	if (!env.BEACH_DATA) {
		throw new Error("Missing KV binding: BEACH_DATA");
	}

	await writeCache(env.BEACH_DATA, BEACH_FLAGS_CACHE_KEY, payload);

	return payload;
}