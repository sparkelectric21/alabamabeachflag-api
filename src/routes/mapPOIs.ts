import { mapPOICatalog, mapPOICatalogFingerprint, validateMapPOICatalog } from "../config/MapPOICatalog";

export const MAP_POI_CACHE_CONTROL = "public, max-age=300, must-revalidate";

function ifNoneMatchMatches(value: string | null, etag: string): boolean {
	if (!value) return false;
	return value.split(",").map((candidate) => candidate.trim()).some((candidate) => candidate === etag || candidate === `W/${etag}` || candidate === "*");
}

export async function handleMapPOIsRequest(request: Request): Promise<Response> {
	validateMapPOICatalog(mapPOICatalog);
	const fingerprint = await mapPOICatalogFingerprint(mapPOICatalog);
	const etag = `"${fingerprint}"`;
	const headers = {
		"Cache-Control": MAP_POI_CACHE_CONTROL,
		"Content-Type": "application/json; charset=utf-8",
		ETag: etag,
		"X-Content-Type-Options": "nosniff",
	};
	if (ifNoneMatchMatches(request.headers.get("If-None-Match"), etag)) return new Response(null, { status: 304, headers });
	return Response.json(mapPOICatalog, { headers });
}
