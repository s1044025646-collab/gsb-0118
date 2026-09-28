import { openDatabase } from '../core/db.js';
import { startApiServer } from './server.js';

const dbPath = process.env.AIRQS_DB ?? 'data/airqs.db';
const requestedPort = Number(process.env.PORT ?? '0');
const db = openDatabase(dbPath);
const runtime = await startApiServer(db, Number.isFinite(requestedPort) ? requestedPort : 0);
console.log(JSON.stringify({ status: 'listening', url: `http://127.0.0.1:${runtime.port}`, dbPath }));

function shutdown() {
  runtime.close().then(() => {
    db.close();
    process.exit(0);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
