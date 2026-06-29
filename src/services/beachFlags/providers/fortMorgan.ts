import { BeachFlagReport } from "../types";

export function getFortMorganFlags(
	generatedAt: string,
	gulfShoresReference: BeachFlagReport | undefined,
): BeachFlagReport[] {
	return [
		{
			beachId: "fort-morgan-public-beach",
			displayName: "Fort Morgan Public Beach",
			primaryFlag: gulfShoresReference?.primaryFlag ?? null,
			hasPurpleFlag: gulfShoresReference?.hasPurpleFlag ?? false,
			lastUpdated: generatedAt,
			sourceType: "estimated",
			sourceName: "Estimated from nearby Gulf Shores conditions",
		},
	];
}