import {
	defineAgent,
	defineHuman,
	defineTool,
	defineWorkspace,
	startSession,
	type Message,
	type SessionEvent,
	type Visit,
} from '@ambionframework/ambion';

void [defineAgent, defineHuman, defineTool, defineWorkspace, startSession];
void ((value: Message | SessionEvent | Visit) => value);
