import * as Spreadsheet from "@e965/xlsx";

export type SpreadsheetCell = string | number | boolean | Date | null;
export type SpreadsheetRow = SpreadsheetCell[];

export const ADEM_WORKBOOK_LIMITS = {
	// The observed report has one sheet with 1,079 rows and 16 columns.
	maxWorksheets: 2,
	maxRows: 4_096,
	maxColumns: 32,
	maxCells: 65_536,
} as const;

const ADEM_DATASET_TITLE = "ADEM/ADPH Beach Monitoring Program";
const DATE_COLUMN = "Date Collected";
const ENTEROCOCCUS_COLUMN = "Enterococcus Count/100 ml";

function failStructure(): never {
	throw new Error("invalid_adem_report_structure");
}

function validateRequiredStructure(rows: SpreadsheetRow[]): void {
	const firstCells = rows.slice(0, 4).flat().map((cell) => String(cell ?? "").trim());
	if (!firstCells.includes(ADEM_DATASET_TITLE)) failStructure();

	const header = rows.slice(0, 32).find((row) =>
		String(row[0] ?? "").trim() === DATE_COLUMN &&
		String(row[3] ?? "").trim().startsWith(ENTEROCOCCUS_COLUMN),
	);
	if (!header) failStructure();
}

export function parseWaterQualityWorkbook(data: ArrayBuffer): SpreadsheetRow[] {
	const workbook = Spreadsheet.read(data, {
		type: "array",
		cellDates: true,
	});

	if (workbook.SheetNames.length < 1 || workbook.SheetNames.length > ADEM_WORKBOOK_LIMITS.maxWorksheets) {
		failStructure();
	}

	const firstSheetName = workbook.SheetNames[0];
	const worksheet = workbook.Sheets[firstSheetName];
	if (!worksheet || !worksheet["!ref"]) failStructure();

	let range: ReturnType<typeof Spreadsheet.utils.decode_range>;
	try {
		range = Spreadsheet.utils.decode_range(worksheet["!ref"]);
	} catch {
		failStructure();
	}

	const rowCount = range.e.r - range.s.r + 1;
	const columnCount = range.e.c - range.s.c + 1;
	if (
		rowCount < 1 ||
		columnCount < 1 ||
		rowCount > ADEM_WORKBOOK_LIMITS.maxRows ||
		columnCount > ADEM_WORKBOOK_LIMITS.maxColumns ||
		rowCount * columnCount > ADEM_WORKBOOK_LIMITS.maxCells
	) {
		failStructure();
	}

	const rows = Spreadsheet.utils.sheet_to_json<SpreadsheetRow>(worksheet, {
		header: 1,
		defval: null,
		raw: false,
	});
	validateRequiredStructure(rows);
	return rows;
}
