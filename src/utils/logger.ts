

export interface LogFields {
	[key: string]: string | number | boolean | null | undefined;
}

function formatFields(fields?: LogFields): string {
	if (!fields) {
		return "";
	}

	const entries = Object.entries(fields)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${String(value)}`);

	return entries.length > 0 ? ` ${entries.join(" ")}` : "";
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