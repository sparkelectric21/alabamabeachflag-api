export const ANNOUNCEMENT_ACTION_RULES = new Map<string, string | null>([
	['alabamabeachflag.com', null],
	['www.alabamabeachflag.com', null],
	['www.redcross.org', '/take-a-class/resources/learn-first-aid/'],
]);

export const ANNOUNCEMENT_ACTION_URL_ERROR = 'actionUrl must use an approved HTTPS link without credentials, a port, or a fragment.';

export function isApprovedAnnouncementActionUrl(value: string): boolean {
	try {
		const url = new URL(value);
		const hostname = url.hostname.toLowerCase();
		if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !ANNOUNCEMENT_ACTION_RULES.has(hostname))
			return false;
		const pathPrefix = ANNOUNCEMENT_ACTION_RULES.get(hostname);
		return pathPrefix === null || (typeof pathPrefix === 'string' && url.pathname.startsWith(pathPrefix));
	} catch {
		return false;
	}
}
