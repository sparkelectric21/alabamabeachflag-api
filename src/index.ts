import { handleWaterQualityRequest } from "./routes/waterQuality";

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
	return Response.json(data, {
		...init,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			...init.headers,
		},
	});
}

export default {
	async fetch(request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method !== "GET") {
			return jsonResponse(
				{
					error: "Method Not Allowed",
				},
				{
					status: 405,
					headers: {
						Allow: "GET",
					},
				},
			);
		}

		if (url.pathname === "/") {
			return jsonResponse({
				service: "Alabama Beach Flag API",
				version: "1.0.0",
				status: "online",
			});
		}

		if (url.pathname === "/v1/health") {
			return jsonResponse({
				status: "ok",
				service: "Alabama Beach Flag API",
				version: "1.0.0",
				timestamp: new Date().toISOString(),
			});
		}

		if (url.pathname === "/v1/water-quality") {
			return await handleWaterQualityRequest();
		}

		return jsonResponse(
			{
				error: "Not Found",
				path: url.pathname,
			},
			{
				status: 404,
			},
		);
	},
} satisfies ExportedHandler<Env>;
