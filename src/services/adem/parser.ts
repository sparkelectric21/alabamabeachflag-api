

import * as XLSX from "xlsx";

export type SpreadsheetRow = Record<string, unknown>;

export function parseWaterQualityWorkbook(data: ArrayBuffer): SpreadsheetRow[] {
	const workbook = XLSX.read(data, {
		type: "array",
		cellDates: true,
	});

	const firstSheetName = workbook.SheetNames[0];
	if (!firstSheetName) {
		throw new Error("ADEM workbook contains no worksheets.");
	}

	const worksheet = workbook.Sheets[firstSheetName];

	return XLSX.utils.sheet_to_json<SpreadsheetRow>(worksheet, {
		defval: null,
		raw: false,
	});
}