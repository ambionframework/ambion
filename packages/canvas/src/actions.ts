/**
 * The rules of the actions of a widget: what a `show` may declare, and what a press may carry.
 * A function here reads a definition or a set of values, and writes nothing.
 */
import { isName } from '@ambionframework/ambion/names';
import { refuse } from './cast.ts';
import { assertLine, NAME_LIMIT, oneLine } from './port.ts';
import type { WidgetAction, WidgetField, WidgetKind } from './store.ts';

/** The most actions of one widget. */
export const ACTIONS_LIMIT = 8;
/** The most fields of one action. */
export const FIELDS_LIMIT = 8;
/** The most options of one choice field. */
export const OPTIONS_LIMIT = 10;
/** The most characters of a label or an option. */
export const LABEL_LIMIT = 40;
/** The most characters of a text value. */
export const TEXT_LIMIT = 200;

/** The values of one press, by field name. */
export type ActValues = Readonly<Record<string, string | number | boolean>>;

type NumberField = Extract<WidgetField, { type: 'number' }>;

function assertId(what: string, value: string): void {
	if (!isName(value) || value.length > NAME_LIMIT)
		throw refuse(
			`"${value}" is not ${what}. Use lowercase letters, digits, and hyphens, start with a letter, and keep it to ${NAME_LIMIT} characters.`,
		);
}

function assertOptions(where: string, options: readonly string[]): void {
	if (options.length === 0 || options.length > OPTIONS_LIMIT)
		throw refuse(`${where} has ${options.length} options. Give 1 to ${OPTIONS_LIMIT}.`);
	for (const [index, option] of options.entries()) {
		assertLine(`An option of ${where}`, option, LABEL_LIMIT);
		if (options.indexOf(option) !== index) throw refuse(`${where} lists "${option}" twice.`);
	}
}

function assertNumber(where: string, field: NumberField): void {
	if (field.min !== undefined && field.max !== undefined && field.min > field.max)
		throw refuse(`${where} has a min above its max.`);
}

function assertField(where: string, field: WidgetField): void {
	assertId('a field name', field.name);
	assertLine(`The label of ${where}`, field.label, LABEL_LIMIT);
	if (field.type === 'choice') assertOptions(where, field.options);
	else if (field.type === 'number') assertNumber(where, field);
}

function assertAction(action: WidgetAction): void {
	assertId('an action id', action.id);
	assertLine(`The label of the action "${action.id}"`, action.label, LABEL_LIMIT);
	const fields = action.fields ?? [];
	if (fields.length > FIELDS_LIMIT)
		throw refuse(
			`The action "${action.id}" has ${fields.length} fields. The most is ${FIELDS_LIMIT}.`,
		);
	for (const [index, field] of fields.entries()) {
		assertField(`the field "${field.name}" of the action "${action.id}"`, field);
		if (fields.findIndex((one) => one.name === field.name) !== index)
			throw refuse(`The action "${action.id}" has the field "${field.name}" twice.`);
	}
}

/** Refuses actions that the kind cannot draw, a malformed action, and a `for` with no action. */
export function assertActions(
	kind: WidgetKind,
	actions: readonly WidgetAction[],
	person: string | undefined,
): void {
	if (person !== undefined) assertId('a person name', person);
	if (actions.length === 0) {
		if (person !== undefined)
			throw refuse('`for` limits who may act, and the widget has no actions.');
		return;
	}
	if (!kind.actions) throw refuse(`The kind "${kind.name}" draws no actions.`);
	if (actions.length > ACTIONS_LIMIT)
		throw refuse(`The widget has ${actions.length} actions. The most is ${ACTIONS_LIMIT}.`);
	for (const [index, action] of actions.entries()) {
		assertAction(action);
		if (actions.findIndex((one) => one.id === action.id) !== index)
			throw refuse(`The widget has the action "${action.id}" twice.`);
	}
}

const isText = (value: unknown): boolean =>
	typeof value === 'string' && value !== '' && oneLine(value) && value.length <= TEXT_LIMIT;

function isNumber(field: NumberField, value: unknown): boolean {
	if (typeof value !== 'number' || !Number.isFinite(value)) return false;
	return value >= (field.min ?? -Infinity) && value <= (field.max ?? Infinity);
}

/** Whether a value fits its field. */
function fits(field: WidgetField, value: unknown): boolean {
	switch (field.type) {
		case 'text':
			return isText(value);
		case 'number':
			return isNumber(field, value);
		case 'boolean':
			return typeof value === 'boolean';
		case 'choice':
			return typeof value === 'string' && field.options.includes(value);
	}
}

/** Refuses a missing value, a value that breaks its field, and a value for no field. */
export function assertValues(action: WidgetAction, values: ActValues | undefined): void {
	const given = values ?? {};
	const fields = action.fields ?? [];
	for (const key of Object.keys(given))
		if (!fields.some((field) => field.name === key))
			throw refuse(`The action "${action.id}" has no field "${key}".`);
	for (const field of fields) {
		if (!Object.hasOwn(given, field.name))
			throw refuse(`The field "${field.name}" of the action "${action.id}" needs a value.`);
		if (!fits(field, given[field.name]))
			throw refuse(
				`The value of the field "${field.name}" of the action "${action.id}" breaks it.`,
			);
	}
}

/** One `label: value` line for each field, in the order of the fields. */
export function valueLines(action: WidgetAction, values: ActValues | undefined): string[] {
	return (action.fields ?? []).map((field) => `${field.label}: ${String(values?.[field.name])}`);
}
