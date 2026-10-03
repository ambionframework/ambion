/*---
description: Look through a camera process. Returns the refs to cite, the measurement time, and the export path of the frame.
uses: [fetch]
args:
  type: object
  additionalProperties: false
  required: [process]
  properties:
    process: { type: string, pattern: '^[a-z][a-z0-9-]*$' }
---*/
const get = (path) => tools.fetch({ process: args.process, path });
const index = await get('/');
if (index.json?.api !== 2)
  throw new Error(`${args.process} serves sensor API ${index.json?.api}; this macro reads API 2.`);
const sensor = index.json.sensors?.find((one) => one.name === 'camera');
if (sensor === undefined) throw new Error(`${args.process} lists no sensor named camera.`);
const read = await get(`/${sensor.name}/observe`);
const observation = read.json?.observations?.[0];
const part = observation?.parts?.find((one) => one.kind === 'frame');
if (part === undefined) throw new Error(`${args.process} gave no frame at ${read.file}.`);
const frame = await get(`/files/${part.file}`);
if (frame.sha256 !== part.file) throw new Error(`File ${part.file} arrived as ${frame.sha256}.`);
if (new Set([index.handle, read.handle, frame.handle]).size !== 1)
  throw new Error(`${args.process} was replaced during the read.`);
return {
  handle: read.handle,
  source: index.json.source,
  at: observation.at,
  observation: { path: read.file, ref: read.ref },
  frame: { digest: part.file, path: frame.file, ref: frame.ref },
  refs: [read.ref, frame.ref],
};
