import { describe, it, expect } from "vitest";
import worker from "../src/index";

const testEnv = {} as Env;

describe("Alabama Beach Flag API worker", () => {
	it("responds with API status (unit style)", async () => {
		const request = new Request("https://example.com");
		const response = await worker.fetch(request, testEnv);
		expect(await response.text()).toMatchInlineSnapshot(`"{\"service\":\"Alabama Beach Flag API\",\"version\":\"1.2.0\",\"status\":\"online\"}"`);
	});

	it("responds with API status (integration style)", async () => {
		const response = await worker.fetch(new Request("https://example.com"), testEnv);
		expect(await response.text()).toMatchInlineSnapshot(`"{\"service\":\"Alabama Beach Flag API\",\"version\":\"1.2.0\",\"status\":\"online\"}"`);
	});
});
