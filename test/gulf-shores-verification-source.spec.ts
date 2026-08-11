import { afterEach, describe, expect, it, vi } from "vitest";
import {
	parseOfficialGulfShoresState,
	readOfficialGulfShoresState,
} from "../src/verification/officialSource";

const section = (content: string) => `<div id="surfTS"><div class="nested">${content}</div></div>`;
const image = (id: string) => `<img src="/ImageRepository/Document?documentID=${id}">`;

afterEach(() => vi.restoreAllMocks());

describe("Gulf Shores independent official-source parsing", () => {
	it("recognizes the current CivicPlus semantic representation and ignores its CSS asset ID", () => {
		expect(parseOfficialGulfShoresState(section(`
			<p>Surf Conditions:</p><p>Medium Hazard&nbsp;</p>
			<style>.fancyButton { background-image: url('/ImageRepository/Document?documentID=10356'); }</style>
		`))).toEqual({ primaryFlag: "yellow", hasPurpleFlag: false });
	});

	it.each([
		["Low Hazard", "green"],
		["Medium Hazard", "yellow"],
		["High Hazard", "red"],
		["Water Closed", "doubleRed"],
		["Water Closure", "doubleRed"],
		["Closed to the Public", "doubleRed"],
	] as const)("maps semantic %s wording to %s", (wording, primaryFlag) => {
		expect(parseOfficialGulfShoresState(section(`<p>Surf Conditions:</p><p>${wording}</p>`)))
			.toEqual({ primaryFlag, hasPurpleFlag: false });
	});

	it.each(["Purple Flag", "Dangerous Marine Life"])("detects scoped %s wording", (advisory) => {
		expect(parseOfficialGulfShoresState(section(`<p>Medium Hazard</p><p>${advisory}</p>`)))
			.toEqual({ primaryFlag: "yellow", hasPurpleFlag: true });
	});

	it("does not infer purple from educational content outside #surfTS", () => {
		const html = `${section("<p>Medium Hazard</p>")}<section><p>Purple Flag - Dangerous Marine Life</p></section>`;
		expect(parseOfficialGulfShoresState(html)).toEqual({ primaryFlag: "yellow", hasPurpleFlag: false });
	});

	it("gives explicit semantic wording precedence over a legacy image", () => {
		expect(parseOfficialGulfShoresState(section(`<p>High Hazard</p>${image("3022")}`)))
			.toEqual({ primaryFlag: "red", hasPurpleFlag: false });
	});

	it.each([
		["3006", "doubleRed", false], ["3007", "doubleRed", false],
		["4339", "doubleRed", false], ["4340", "doubleRed", false],
		["3010", "red", false], ["3011", "red", true],
		["3012", "green", true], ["3013", "green", true],
		["3014", "green", false], ["3015", "green", false],
		["3016", "yellow", true], ["3017", "yellow", true],
		["3018", "red", false], ["3019", "red", true],
		["3020", "yellow", true], ["3021", "yellow", true],
		["3022", "yellow", false], ["3023", "yellow", false],
	] as const)("retains legacy status image %s", (id, primaryFlag, hasPurpleFlag) => {
		expect(parseOfficialGulfShoresState(section(image(id)))).toEqual({ primaryFlag, hasPurpleFlag });
	});

	it.each([
		section("<style>.status { background-image: url('/ImageRepository/Document?documentID=3022'); }</style>"),
		section(image("10356")),
		section("<p>Surf Conditions:</p><p>Moderate surf</p>"),
		"<html><p>Medium Hazard</p></html>",
		'<div id="surfTS"><p>Medium Hazard</p>',
	])("fails safely for unrecognized or malformed presentation", (html) => {
		expect(() => parseOfficialGulfShoresState(html)).toThrow("official_source_format_changed");
	});
});

describe("Gulf Shores official-source failure classification", () => {
	it("classifies a non-success response as unavailable", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
		await expect(readOfficialGulfShoresState()).rejects.toThrow("official_source_unavailable");
	});

	it("classifies an unsupported content type as unavailable", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: "ok" })));
		await expect(readOfficialGulfShoresState()).rejects.toThrow("official_source_unavailable");
	});

	it("classifies an oversized response as unavailable", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", {
			headers: { "Content-Type": "text/html", "Content-Length": String(2 * 1024 * 1024 + 1) },
		})));
		await expect(readOfficialGulfShoresState()).rejects.toThrow("official_source_unavailable");
	});

	it("classifies a fetch failure as unavailable", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network failure")));
		await expect(readOfficialGulfShoresState()).rejects.toThrow("official_source_unavailable");
	});

	it("classifies an aborted timeout request as unavailable", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("timed out", "AbortError")));
		await expect(readOfficialGulfShoresState()).rejects.toThrow("official_source_unavailable");
	});

	it("keeps successful but unrecognized HTML classified as format changed", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>changed</html>", {
			headers: { "Content-Type": "text/html" },
		})));
		await expect(readOfficialGulfShoresState()).rejects.toThrow("official_source_format_changed");
	});

	it("follows a validated same-URL redirect and parses the final HTML", async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "/1136/Beach-Safety/" } }))
			.mockResolvedValueOnce(new Response(section("<p>Medium Hazard</p>"), {
				headers: { "Content-Type": "text/html" },
			}));
		vi.stubGlobal("fetch", fetchMock);
		await expect(readOfficialGulfShoresState()).resolves.toEqual({ primaryFlag: "yellow", hasPurpleFlag: false });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("classifies a rejected redirect as unavailable", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, {
			status: 302, headers: { Location: "https://example.com/changed" },
		})));
		await expect(readOfficialGulfShoresState()).rejects.toThrow("official_source_unavailable");
	});

	it("classifies a redirect loop as unavailable", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, {
			status: 302, headers: { Location: "/1136/Beach-Safety" },
		})));
		await expect(readOfficialGulfShoresState()).rejects.toThrow("official_source_unavailable");
	});

	it("classifies a redirect-limit failure as unavailable", async () => {
		let step = 0;
		vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(null, {
			status: 302, headers: { Location: `/1136/Beach-Safety?step=${++step}` },
		}))));
		await expect(readOfficialGulfShoresState()).rejects.toThrow("official_source_unavailable");
		expect(step).toBe(4);
	});
});
