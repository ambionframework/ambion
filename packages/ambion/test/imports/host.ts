import {
	createRuntime,
	directoryBackend,
	type Clock,
	type SessionOpener,
	type Transport,
} from '@ambionframework/ambion/host';

void [createRuntime, directoryBackend];
void ((value: Clock | SessionOpener | Transport) => value);
