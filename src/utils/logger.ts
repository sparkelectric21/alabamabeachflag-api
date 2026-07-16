

export interface LogFields {
	[key: string]: string | number | boolean | null | undefined;
}

function formatFields(fields?: LogFields): string {
	if (!fields) {
		return "";
	}

	const entries = Object.entries(fields)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${sanitizeLogValue(value)}`);

	return entries.length > 0 ? ` ${entries.join(" ")}` : "";
}

function sanitizeLogValue(value: LogFields[string]): string {
	return String(value)
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
		.replace(/[\r\n\t]+/g, " ")
		.slice(0, 500);
}

export function logInfo(scope: string, message: string, fields?: LogFields): void {
	console.log(`[${scope}] ${message}${formatFields(fields)}`);
}

export function logWarn(scope: string, message: string, fields?: LogFields): void {
	console.warn(`[${scope}] ${message}${formatFields(fields)}`);
}

export function logError(scope: string, message: string, fields?: LogFields): void {
	console.error(`[${scope}] ${message}${formatFields(fields)}`);
}

export function elapsedMs(startedAt: number): number {
	return Date.now() - startedAt;
}
