import * as XLSX from "xlsx";

export type SpreadsheetCell = string | number | boolean | Date | null;
export type SpreadsheetRow = SpreadsheetCell[];

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
		header: 1,
		defval: null,
		raw: false,
	});
}