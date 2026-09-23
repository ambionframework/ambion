#!/usr/bin/env node
/**
 * Checks the publishable packages for release hygiene.
 *
 * Run it after a build. Every finding is an error and the process exits
 * nonzero when there is one.
 *
 *   node scripts/package-hygiene.mjs
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { publishablePackages, ROOT, sharedVersion } from './packages.mjs';

const run = promisify(execFile);

/** One finding names its rule, its package, and what is wrong. */
function finding(rule, name, message) {
	return { rule, package: name, message };
}

/** (a) The lockfile resolves one typebox version. */
export function checkTypebox(lockText) {
	const versions = [...lockText.matchAll(/^ {2}typebox@([^:\s(]+):/gm)].map((match) => match[1]);
	const unique = [...new Set(versions)].sort();
	if (unique.length <= 1) return [];
	return [finding('typebox', '(lockfile)', `typebox resolves to ${unique.join(', ')}.`)];
}

/** Every string target in an exports value, with the path of keys that led to it. */
function exportTargets(value, path = []) {
	if (typeof value === 'string') return [{ path, target: value }];
	if (value === null || typeof value !== 'object') return [];
	return Object.entries(value).flatMap(([key, child]) => exportTargets(child, [...path, key]));
}

/** True for an exports object whose keys are conditions and not subpaths. */
function isConditionMap(value) {
	return (
		value !== null &&
		typeof value === 'object' &&
		Object.keys(value).every((key) => !key.startsWith('.'))
	);
}

/** Every condition map inside an exports value, with its subpath. */
function conditionMaps(value, subpath = '.') {
	if (value === null || typeof value !== 'object') return [];
	if (isConditionMap(value)) {
		const nested = Object.values(value).flatMap((child) => conditionMaps(child, subpath));
		return [{ subpath, map: value }, ...nested];
	}
	return Object.entries(value).flatMap(([key, child]) => conditionMaps(child, key));
}

/** (b) The package is ESM only. */
export function checkEsm(manifest) {
	const name = manifest.name;
	const found = [];
	if (manifest.type !== 'module') found.push(finding('esm', name, 'type is not "module".'));
	for (const { path, target } of exportTargets(manifest.exports)) {
		if (path.includes('require')) {
			found.push(finding('esm', name, `exports has a require condition (${path.join(' > ')}).`));
		}
		if (/\.c[jt]s$/.test(target)) {
			found.push(finding('esm', name, `exports target ${target} is CommonJS.`));
		}
	}
	if (typeof manifest.main === 'string' && /\.c[jt]s$/.test(manifest.main)) {
		found.push(finding('esm', name, `main ${manifest.main} is CommonJS.`));
	}
	return found;
}

/** (c) Every export and types path exists, and each entry has a types target. */
export function checkExports(manifest, exists) {
	const name = manifest.name;
	const targets = exportTargets(manifest.exports).map(({ target }) => target);
	const fields = ['main', 'types'].map((field) => manifest[field]);
	const paths = [...new Set([...targets, ...fields])]
		.filter((path) => typeof path === 'string' && !path.includes('*'))
		.sort();
	const missing = paths
		.filter((path) => !exists(path))
		.map((path) => finding('exports', name, `${path} does not exist.`));
	const untyped = conditionMaps(manifest.exports)
		.filter(({ map }) => hasUntypedRuntime(map))
		.map(({ subpath }) => finding('types', name, `export ${subpath} has no types condition.`));
	return [...missing, ...untyped];
}

/** True for a condition map with a JavaScript target and no types condition. */
function hasUntypedRuntime(map) {
	const runtime = map.import ?? map.default;
	return typeof runtime === 'string' && /\.m?js$/.test(runtime) && !('types' in map);
}

const FORBIDDEN =
	/^(src\/|test\/|tests\/|tsconfig[^/]*\.json$|tsdown\.config\.|vitest[^/]*\.config\.|biome\.jsonc?$|knip\.json$|.*\.test\.[cm]?[jt]s$)/;

/** (d) The pack list holds dist, the README and the license, and no source or config. */
export function checkPack(name, files) {
	const found = [];
	if (!files.some((file) => file.startsWith('dist/'))) {
		found.push(finding('pack', name, 'pack list has no dist file.'));
	}
	if (!files.some((file) => /^README(\.md)?$/i.test(file))) {
		found.push(finding('pack', name, 'pack list has no README.'));
	}
	if (!files.some((file) => /^LICEN[CS]E(\.md|\.txt)?$/i.test(file))) {
		found.push(finding('pack', name, 'pack list has no license.'));
	}
	for (const file of files.filter((entry) => FORBIDDEN.test(entry))) {
		found.push(finding('pack', name, `pack list holds ${file}.`));
	}
	return found;
}

/** (e) Versions agree, and an internal dependency is workspace:* or the same version. */
export function checkLockstep(manifests) {
	const found = [];
	let version;
	try {
		version = sharedVersion(manifests.map((manifest) => ({ manifest })));
	} catch (error) {
		found.push(finding('version', '(all)', error.message.split('. ')[0]));
	}
	return [...found, ...checkRanges(manifests, version)];
}

/** The internal dependencies of one manifest, as [name, range] pairs. */
function internalDependencies(manifest, names) {
	const fields = ['dependencies', 'peerDependencies', 'optionalDependencies'];
	return fields
		.flatMap((field) => Object.entries(manifest[field] ?? {}))
		.filter(([dependency]) => names.has(dependency));
}

/** A finding for each internal range that is neither workspace:* nor the version. */
function checkRanges(manifests, version) {
	const names = new Set(manifests.map((manifest) => manifest.name));
	return manifests.flatMap((manifest) =>
		internalDependencies(manifest, names)
			.filter(([, range]) => range !== 'workspace:*' && range !== (version ?? manifest.version))
			.map(([dependency, range]) =>
				finding('range', manifest.name, `${dependency} has range ${range}.`),
			),
	);
}

/** (f) engines.node is the same in every package. */
export function checkEngines(manifests) {
	const values = new Set(manifests.map((manifest) => manifest.engines?.node));
	if (values.size <= 1) return [];
	const list = [...values].map((value) => value ?? 'missing').sort();
	return [finding('engines', '(all)', `engines.node differs: ${list.join(', ')}.`)];
}

/** The package name of a bare import specifier, or undefined for a path, a scheme, or a `#` import. */
function packageOf(specifier) {
	if (/^[./#]/.test(specifier) || /^[a-z][a-z0-9+.-]*:/.test(specifier)) return undefined;
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** A static import or export statement, a side-effect import, or a dynamic import. */
const SPECIFIER =
	/(?:^\s*(?:import|export)\b[^'"();=]*?\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*)["']([^"']+)["']/gm;
/** A block comment, or a line that holds only a comment. */
const COMMENT = /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm;
/** A region of bundled code whose source lies outside the package's own `src`. */
const OUTSIDE = /^\/\/#region (?!src\/)(\S+)/gm;
/** The package that a node_modules path names. */
const MODULE = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//;

/**
 * (g) A built file imports only the package itself and what the manifest
 * declares in dependencies, peerDependencies, or optionalDependencies. A
 * built file holds no code from outside the package's own `src`. tsdown
 * inlines a package that the manifest declares only in devDependencies.
 * Thus a runtime import of such a package gives an inlined region.
 */
export function checkDist(manifest, files) {
	const declared = new Set([
		manifest.name,
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
		...Object.keys(manifest.optionalDependencies ?? {}),
	]);
	const found = new Map();
	for (const { path, text } of files) {
		for (const dependency of undeclaredImports(text, declared)) {
			found.set(
				`import ${dependency}`,
				`${path} imports ${dependency}, which is not a dependency.`,
			);
		}
		for (const source of inlinedSources(text)) {
			found.set(`inline ${source}`, `${path} inlines ${source}.`);
		}
	}
	return [...found.values()].map((message) => finding('dist', manifest.name, message));
}

/** The packages a built file imports that are not in `declared`. */
function undeclaredImports(text, declared) {
	return [...text.replace(COMMENT, '').matchAll(SPECIFIER)]
		.map(([, specifier]) => packageOf(specifier))
		.filter((dependency) => dependency !== undefined && !declared.has(dependency));
}

/** What each inlined region holds: a node_modules package by name, or else its path. */
function inlinedSources(text) {
	return [...text.matchAll(OUTSIDE)].map(([, path]) => {
		const module = path.match(MODULE);
		return module ? `${module[1]} from node_modules` : path;
	});
}

/** Every JavaScript and declaration file of a built dist, with its text. No dist gives none. */
async function distFiles(dir) {
	const root = join(dir, 'dist');
	if (!existsSync(root)) return [];
	const names = (await readdir(root)).filter((file) => /\.d?\.?m?[jt]s$/.test(file));
	return Promise.all(
		names.map(async (file) => ({
			path: `dist/${file}`,
			text: await readFile(join(root, file), 'utf8'),
		})),
	);
}

/** The files `npm pack` would put in the tarball, without writing one. */
async function packList(dir) {
	const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
		cwd: dir,
	});
	return JSON.parse(stdout)[0].files.map((file) => file.path);
}

/** Every finding for the current tree. */
export async function checkTree() {
	const packages = await publishablePackages();
	const manifests = packages.map((entry) => entry.manifest);
	const found = [
		...checkTypebox(await readFile(join(ROOT, 'pnpm-lock.yaml'), 'utf8')),
		...checkLockstep(manifests),
		...checkEngines(manifests),
	];
	const perPackage = await Promise.all(
		packages.map(async ({ dir, manifest }) => [
			...checkEsm(manifest),
			...checkExports(manifest, (path) => existsSync(join(dir, path))),
			...checkPack(manifest.name, await packList(dir)),
			...checkDist(manifest, await distFiles(dir)),
		]),
	);
	return [...found, ...perPackage.flat()];
}

async function main() {
	const found = await checkTree();
	for (const entry of found) console.error(`${entry.rule}: ${entry.package}: ${entry.message}`);
	if (found.length > 0) {
		console.error(`${found.length} package hygiene finding(s).`);
		process.exitCode = 1;
		return;
	}
	console.log('Package hygiene: no findings.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
