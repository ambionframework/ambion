/** The `/sensors` entry: the wire contract and the client. */
export * from './sensor-api.ts';
export {
	createSensorClient,
	type SensorClient,
	SensorDigestError,
	type SensorFile,
	SensorHttpError,
	SensorProtocolError,
} from './sensor-client.ts';
