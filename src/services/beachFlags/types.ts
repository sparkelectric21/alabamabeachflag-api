
export type BeachFlagColor = "green" | "yellow" | "red" | "doubleRed";

export type BeachFlagSourceType =
	| "official"
	| "estimated"
	| "unavailable";

export interface BeachFlagReport {
	beachId: string;
	displayName: string;
	primaryFlag: BeachFlagColor | null;
	hasPurpleFlag: boolean;
	lastUpdated: string;
	sourceType: BeachFlagSourceType;
	sourceName: string;
}

export interface BeachFlagProviderResult {
	reports: BeachFlagReport[];
	errors: Array<{
		beachId: string;
		displayName: string;
		message: string;
	}>;
}