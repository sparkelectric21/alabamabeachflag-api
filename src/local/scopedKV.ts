const utf8Length = (value: string) => new TextEncoder().encode(value).byteLength;

function validatePrefix(prefix: string): void {
	if (prefix === "." || prefix === ".." || utf8Length(prefix) > 512) throw new TypeError("invalid_scoped_kv_prefix");
}

function validateKey(key: string, physicalPrefix: string): void {
	if (!key || key === "." || key === ".." || key.startsWith(physicalPrefix) || utf8Length(`${physicalPrefix}${key}`) > 512) {
		throw new TypeError("invalid_scoped_kv_key");
	}
}

/** Present a namespace-relative KV binding while retaining a fixed physical prefix. */
export function createScopedKV(base: KVNamespace, physicalPrefix: string): KVNamespace {
	if (!physicalPrefix || physicalPrefix === "." || physicalPrefix === ".." || utf8Length(physicalPrefix) >= 512) throw new TypeError("invalid_scoped_kv_namespace");
	const physicalKey = (relative: string) => { validateKey(relative, physicalPrefix); return `${physicalPrefix}${relative}`; };
	return {
		get: ((key: string, ...args: unknown[]) => base.get(physicalKey(key), ...(args as [never]))) as KVNamespace["get"],
		getWithMetadata: ((key: string, ...args: unknown[]) => base.getWithMetadata(physicalKey(key), ...(args as [never]))) as KVNamespace["getWithMetadata"],
		put: ((key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, options?: KVNamespacePutOptions) => base.put(physicalKey(key), value, options)) as KVNamespace["put"],
		delete: (key: string) => base.delete(physicalKey(key)),
		list: (async (options: KVNamespaceListOptions = {}) => {
			const relativePrefix = options.prefix ?? "";
			validatePrefix(relativePrefix);
			if (relativePrefix.startsWith(physicalPrefix) || utf8Length(`${physicalPrefix}${relativePrefix}`) > 512) throw new TypeError("invalid_scoped_kv_prefix");
			const result = await base.list({ ...options, prefix: `${physicalPrefix}${relativePrefix}` });
			return {
				...result,
				keys: result.keys.map((item) => {
					if (!item.name.startsWith(physicalPrefix)) throw new Error("scoped_kv_namespace_violation");
					return { ...item, name: item.name.slice(physicalPrefix.length) };
				}),
			};
		}) as KVNamespace["list"],
	} as KVNamespace;
}
