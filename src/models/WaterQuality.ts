export type WaterQualityStatus =
	| "excellent"
	| "elevated"
	| "advisory"
	| "unavailable";

export interface WaterQuality {
	beachId: string;
	displayName: string;
	sampleDate: string | null;
	enterococcus: number | null;
	advisory: boolean;
	status: WaterQualityStatus;
	reportUrl: string;
}