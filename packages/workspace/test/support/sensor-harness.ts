import type {
	SensorConformanceHarness,
	SensorConformanceProbe,
	SensorConformanceReply,
} from '../../src/conformance.ts';

export function httpSensorHarness(name: string, origin: string): SensorConformanceHarness {
	return {
		name,
		async open(): Promise<SensorConformanceProbe> {
			return {
				async request(method, path, body): Promise<SensorConformanceReply> {
					const response = await fetch(`${origin}${path}`, {
						method,
						...(body === undefined
							? {}
							: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
					});
					const contentType = response.headers.get('content-type');
					if (contentType?.includes('application/json')) {
						return { status: response.status, contentType, body: await response.json() };
					}
					return {
						status: response.status,
						contentType,
						bytes: new Uint8Array(await response.arrayBuffer()),
					};
				},
				async dispose() {},
			};
		},
	};
}
