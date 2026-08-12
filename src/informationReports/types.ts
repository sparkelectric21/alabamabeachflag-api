export const INFORMATION_REPORT_CATEGORIES = [
	"beachOrAccessInformation", "mapPinOrDirections", "facilityOrAmenity",
	"officialSourceOrWebsiteLink", "beachConditionDisplay", "appDisplayOrTechnicalProblem", "somethingElse",
] as const;
export type InformationReportCategory = typeof INFORMATION_REPORT_CATEGORIES[number];
export const INFORMATION_REPORT_STATUSES = ["new", "inReview", "resolved", "dismissed", "duplicate"] as const;
export type InformationReportStatus = typeof INFORMATION_REPORT_STATUSES[number];

export interface InformationReportInput {
	schemaVersion: 1; clientReportId: string; category: InformationReportCategory; message: string;
	contactEmail?: string; clientCreatedAt: string; beachId?: string; beachAccessId?: string;
	mapPoiId?: string; sourceId?: string; learnArticleId?: string; screenId: string;
	appVersion: string; appBuild: string; platform: "iOS"; catalogVersion?: string; contextTitle?: string;
}

export interface InformationReportRecord extends InformationReportInput {
	id: string; status: InformationReportStatus; receivedAt: string; updatedAt: string;
	resolutionNote: string | null; duplicateOfReportId: string | null; notificationStatus: "pending" | "sent" | "failed";
}
