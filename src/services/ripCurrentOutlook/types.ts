export type RipCurrentFreshness = "current" | "stale";
export interface RipCurrentOutlookMetadata {
	status: "ok" | "stale";
	apiVersion: string;
	provider: "National Weather Service Mobile/Pensacola";
	title: "Rip Current Outlook";
	imageUrl: "/v1/rip-current-outlook/image";
	sourceUrl: "https://www.weather.gov/beach/mob";
	upstreamFetchTime: string;
	upstreamLastModified?: string;
	upstreamETag?: string;
	revision: string;
	contentType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
	freshness: RipCurrentFreshness;
	usingCachedImage: boolean;
	lastRefreshAttempt: string;
	generatedAt: string;
	count: 1;
}
