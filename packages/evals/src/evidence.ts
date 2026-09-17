import type { JsonValue } from './json.ts';
import { toJsonValue } from './json.ts';
import type { Artifacts, EvidenceKind, EvidenceValue, SealedEvidence } from './types.ts';

export function evidence<T extends JsonValue>(
	value: T,
	options: Omit<EvidenceValue<T>, 'value' | '$evidence'> = {},
): EvidenceValue<T> {
	return { $evidence: true, value, ...options };
}

export function sealArtifacts(artifacts: Artifacts | undefined): {
	values: Readonly<Record<EvidenceKind, JsonValue>>;
	collections: Readonly<Record<EvidenceKind, SealedEvidence>>;
} {
	const values: Record<string, JsonValue> = {};
	const collections: Record<string, SealedEvidence> = {};
	if (artifacts === undefined) return { values, collections };
	for (const [kind, raw] of Object.entries(artifacts)) {
		const sealed = sealArtifact(kind, raw);
		values[kind] = sealed.value;
		collections[kind] = sealed.collection;
	}
	return { values, collections };
}

function sealArtifact(
	kind: string,
	raw: JsonValue | EvidenceValue,
): {
	value: JsonValue;
	collection: SealedEvidence;
} {
	const wrapped = isEvidenceValue(raw);
	const value = toJsonValue(wrapped ? wrapped.value : raw, `evidence ${kind}`);
	const refs = wrapped?.refs === undefined ? [kind] : [...wrapped.refs];
	if (refs.length === 0 || refs.some((ref) => ref.length === 0))
		throw new TypeError(`Evidence ${kind} has invalid references.`);
	return {
		value,
		collection: {
			kind,
			value,
			complete: wrapped?.complete ?? true,
			...(wrapped?.provenance === undefined ? {} : { provenance: wrapped.provenance }),
			refs,
		},
	};
}

function isEvidenceValue(value: JsonValue | EvidenceValue): EvidenceValue | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
	if (!('$evidence' in value) || value.$evidence !== true || !('value' in value)) return undefined;
	return value as EvidenceValue;
}

export function validEvidenceRefs(
	collections: Readonly<Record<EvidenceKind, SealedEvidence>>,
): string[] {
	return Object.values(collections).flatMap((item) => [item.kind, ...item.refs]);
}

export function hasValidEvidenceRefs(refs: readonly string[], valid: ReadonlySet<string>): boolean {
	return refs.length > 0 && refs.every((ref) => valid.has(ref));
}
