export async function resolve(specifier, context, nextResolve) {
	const result = await nextResolve(specifier, context);
	if (result.url.includes('/pi-ai/dist/providers/all.')) {
		process.stderr.write(`AMBION_PROVIDER_IMPORT:${result.url}\n`);
	}
	return result;
}
