import { beaches } from "../config/BeachRegistry";

export async function handleBeachesRequest(): Promise<Response> {
	return Response.json({
		source: "Alabama Beach Flag Beach Registry",
		generatedAt: new Date().toISOString(),
		count: beaches.length,
		beaches,
	});
}