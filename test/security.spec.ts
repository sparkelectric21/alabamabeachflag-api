import * as Spreadsheet from "@e965/xlsx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateAdemReportUrl } from "../src/config/upstreamSecurity";
import { fetchWaterQualityReport } from "../src/services/adem/client";
import { extractLatestSample } from "../src/services/adem/mapper";
import { ADEM_WORKBOOK_LIMITS, parseWaterQualityWorkbook } from "../src/services/adem/parser";
import {
	fetchWithRetry,
	readResponseBytes,
	UpstreamError,
	validateSafeHttpsUrl,
	type UpstreamUrlValidator,
} from "../src/utils/http";
import { ADEM_CITY_GULF_SHORES_ROWS } from "./fixtures/adem-citygs";

afterEach(() => vi.unstubAllGlobals());

function expectCode(code: string) {
	return expect.objectContaining({ code });
}

function workbookBuffer(rows: readonly (readonly unknown[])[], sheetCount = 1): ArrayBuffer {
	const workbook = Spreadsheet.utils.book_new();
	for (let index = 0; index < sheetCount; index++) {
		Spreadsheet.utils.book_append_sheet(workbook, Spreadsheet.utils.aoa_to_sheet(rows), `CityGS${index || ""}`);
	}
	const bytes = Spreadsheet.write(workbook, { type: "array", bookType: "biff8" }) as ArrayBuffer;
	return bytes;
}

async function fetchAdem(url: string): Promise<Response> {
	return fetchWithRetry(url, { retries: 0, validateUrl: validateAdemReportUrl });
}

describe("ADEM URL policy", () => {
	it("accepts the current ADEM report URL", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		await fetchAdem("https://adem.alabama.gov/media/18617/download");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it.each([
		"http://adem.alabama.gov/media/18617/download",
		"https://example.com/media/18617/download",
		"https://127.0.0.1/media/18617/download",
		"https://user:password@adem.alabama.gov/media/18617/download",
		"https://adem.alabama.gov:8443/media/18617/download",
		"https://adem.alabama.gov/unexpected/18617",
	])("rejects unsafe report URL %s before fetching", async (url) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(fetchAdem(url)).rejects.toEqual(expectCode("unsafe_upstream_url"));
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("controlled redirects", () => {
	it("allows a relative redirect within the ADEM policy", async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "/media/18618/download" } }))
			.mockResolvedValueOnce(new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		const response = await fetchAdem("https://adem.alabama.gov/media/18617/download");
		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rejects a cross-host redirect", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
			new Response(null, { status: 302, headers: { Location: "https://example.com/report.xls" } }),
		));
		await expect(fetchAdem("https://adem.alabama.gov/media/18617/download"))
			.rejects.toEqual(expectCode("unsafe_redirect"));
	});

	it("detects redirect loops", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
			new Response(null, { status: 302, headers: { Location: "/media/18617/download" } }),
		));
		await expect(fetchAdem("https://adem.alabama.gov/media/18617/download"))
			.rejects.toEqual(expectCode("unsafe_redirect"));
	});

	it("enforces the redirect limit", async () => {
		let id = 18617;
		vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
			Promise.resolve(new Response(null, { status: 302, headers: { Location: `/media/${++id}/download` } })),
		));
		await expect(fetchWithRetry("https://adem.alabama.gov/media/18617/download", {
			retries: 0,
			maxRedirects: 2,
			validateUrl: validateAdemReportUrl,
		})).rejects.toEqual(expectCode("redirect_limit_exceeded"));
	});

	it("does not forward Authorization across origins", async () => {
		const validator: UpstreamUrlValidator = (url) => {
			validateSafeHttpsUrl(url);
			if (!["one.example", "two.example"].includes(url.hostname)) throw new UpstreamError("unsafe_upstream_url");
		};
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://two.example/final" } }))
			.mockResolvedValueOnce(new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		await fetchWithRetry("https://one.example/start", {
			retries: 0,
			validateUrl: validator,
			headers: { Authorization: "Bearer test-value" },
		});
		const secondHeaders = new Headers(fetchMock.mock.calls[1][1].headers);
		expect(secondHeaders.has("Authorization")).toBe(false);
	});
});

describe("bounded response reading", () => {
	const options = { maxBytes: 4, contentTypes: ["text/plain"] } as const;

	it("rejects an oversized streamed body without Content-Length", async () => {
		const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); controller.close(); } });
		const response = new Response(stream, { headers: { "Content-Type": "text/plain" } });
		await expect(readResponseBytes(response, options)).rejects.toEqual(expectCode("upstream_response_too_large"));
	});

	it("rejects a body larger than its false Content-Length", async () => {
		const response = new Response("12345", { headers: { "Content-Type": "text/plain", "Content-Length": "4" } });
		await expect(readResponseBytes(response, options)).rejects.toEqual(expectCode("upstream_response_too_large"));
	});

	it("rejects a declared oversized response", async () => {
		const response = new Response("", { headers: { "Content-Type": "text/plain", "Content-Length": "5" } });
		await expect(readResponseBytes(response, options)).rejects.toEqual(expectCode("upstream_response_too_large"));
	});

	it("rejects an unexpected content type", async () => {
		await expect(readResponseBytes(new Response("1234", { headers: { "Content-Type": "text/html" } }), options))
			.rejects.toEqual(expectCode("unexpected_content_type"));
	});

	it("accepts a valid response at the byte limit", async () => {
		const bytes = await readResponseBytes(new Response("1234", { headers: { "Content-Type": "text/plain" } }), options);
		expect(new TextDecoder().decode(bytes)).toBe("1234");
	});
});

describe("ADEM workbook boundaries", () => {
	it("preserves the current normalized ADEM mapping", () => {
		const rows = parseWaterQualityWorkbook(workbookBuffer(ADEM_CITY_GULF_SHORES_ROWS));
		expect(extractLatestSample(rows)).toEqual({
			sampleDate: "2026-07-13",
			enterococcus: 10,
			advisory: false,
			status: "excellent",
			rawEnterococcus: "<10",
		});
	});

	it("rejects excessive worksheets", () => {
		expect(() => parseWaterQualityWorkbook(workbookBuffer(ADEM_CITY_GULF_SHORES_ROWS, 3)))
			.toThrow("invalid_adem_report_structure");
	});

	it("rejects excessive rows", () => {
		const rows = Array.from({ length: ADEM_WORKBOOK_LIMITS.maxRows + 1 }, () => ["x"]);
		expect(() => parseWaterQualityWorkbook(workbookBuffer(rows))).toThrow("invalid_adem_report_structure");
	});

	it("rejects excessive columns", () => {
		const rows = [[...Array.from({ length: ADEM_WORKBOOK_LIMITS.maxColumns + 1 }, () => "x")]];
		expect(() => parseWaterQualityWorkbook(workbookBuffer(rows))).toThrow("invalid_adem_report_structure");
	});

	it("rejects excessive total cells", () => {
		const rowCount = Math.floor(ADEM_WORKBOOK_LIMITS.maxCells / ADEM_WORKBOOK_LIMITS.maxColumns) + 1;
		const rows = Array.from({ length: rowCount }, () =>
			Array.from({ length: ADEM_WORKBOOK_LIMITS.maxColumns }, () => "x"),
		);
		expect(() => parseWaterQualityWorkbook(workbookBuffer(rows))).toThrow("invalid_adem_report_structure");
	});

	it("rejects an oversized workbook response", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
			new Uint8Array(1_048_577),
			{ headers: { "Content-Type": "application/vnd.ms-excel" } },
		)));
		await expect(fetchWaterQualityReport("https://adem.alabama.gov/media/18617/download"))
			.rejects.toEqual(expectCode("upstream_response_too_large"));
	});

	it("rejects missing required ADEM columns", () => {
		expect(() => parseWaterQualityWorkbook(workbookBuffer([["ADEM/ADPH Beach Monitoring Program"], ["wrong"]])))
			.toThrow("invalid_adem_report_structure");
	});

	it("does not fetch after ADEM URL validation fails", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(fetchWaterQualityReport("https://example.com/media/1/download"))
			.rejects.toEqual(expectCode("unsafe_upstream_url"));
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
