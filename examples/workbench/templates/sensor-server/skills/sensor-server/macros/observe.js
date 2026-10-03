/*---
description: Read one sensor of a sensor-server process. Returns the refs to cite, the measurement times, and the export paths.
uses: [fetch]
args:
  type: object
  additionalProperties: false
  required: [process, sensor]
  properties:
    process: { type: string, pattern: '^[a-z][a-z0-9-]*$' }
    sensor: { type: string, pattern: '^[a-z][a-z0-9-]*$' }
    from: { type: string, maxLength: 24 }
    to: { type: string, maxLength: 24 }
  dependentRequired: { from: [to], to: [from] }
---*/
const get = (path) => tools.fetch({ process: args.process, path });
const index = await get('/');
if (index.json?.api !== 2)
  throw new Error(`${args.process} serves sensor API ${index.json?.api}; this macro reads API 2.`);
const query = args.from === undefined ? '' :
  `?from=${encodeURIComponent(args.from)}&to=${encodeURIComponent(args.to)}`;
const read = await get(`/${args.sensor}/observe${query}`);
if (read.json === undefined)
  throw new Error(`The observation is larger than 4 MiB; read it at ${read.file}.`);
const digests = new Set(
  read.json.observations.flatMap((o) => o.parts).flatMap((p) => (p.file ? [p.file] : [])),
);
const files = [];
for (const digest of digests) {
  const file = await get(`/files/${digest}`);
  if (file.sha256 !== digest) throw new Error(`File ${digest} arrived as ${file.sha256}.`);
  files.push({ digest, handle: file.handle, path: file.file, ref: file.ref });
}
if (new Set([index.handle, read.handle, ...files.map((file) => file.handle)]).size !== 1)
  throw new Error(`${args.process} was replaced during the read.`);
return {
  handle: read.handle,
  source: index.json.source,
  observations: read.json.observations.length,
  times: read.json.observations.map((o) => o.at).slice(0, 50),
  observation: { path: read.file, ref: read.ref },
  files: files.map(({ digest, path, ref }) => ({ digest, path, ref })),
  refs: [read.ref, ...files.map((file) => file.ref)],
};
