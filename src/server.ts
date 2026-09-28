import { openDatabase } from './db.js';
import { createApiServer, listen } from './api.js';

const databasePath = process.env.AIR_DB ?? 'air-local.sqlite';
const port = Number(process.env.PORT ?? '0');
const db = openDatabase(databasePath);
const server = createApiServer(db);

listen(server, port).then((actualPort) => {
  console.log(`fictional air backend listening on http://127.0.0.1:${actualPort}`);
  console.log(`database: ${databasePath}`);
});

function shutdown(): void {
  server.close(() => db.close());
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
