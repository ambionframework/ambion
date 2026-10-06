import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const blob = readFileSync(new URL('./blob.png', import.meta.url));
const digest = createHash('sha256').update(blob).digest('hex');

// The workspace sets PORT for every process.
const server = createServer((request, response) => {
	if (request.method !== 'GET') {
		response.writeHead(405).end();
	} else if (request.url === '/reading') {
		response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
		response.end(JSON.stringify({ name: 'reading', value: 21.5 }));
	} else if (request.url === `/files/${digest}`) {
		response.writeHead(200, { 'content-type': 'image/png', 'content-length': blob.length });
		response.end(blob);
	} else {
		response.writeHead(404).end();
	}
});
server.listen(Number(process.env.PORT), '127.0.0.1');
