import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase, withTransaction } from '../src/core/db.ts';

test('transaction rolls back all writes when one statement fails', () => {
  const db = openDatabase(':memory:');
  db.exec(`INSERT INTO stations(code,name,x_m,y_m) VALUES('S','S',0,0);
    INSERT INTO pollutants(code,name,unit) VALUES('P','P','u');`);
  assert.throws(() => withTransaction(db, () => {
    db.prepare(`INSERT INTO observations(station_id,pollutant_id,observed_at,raw_value,corrected_value,quality_flag)
      VALUES(1,1,'2026-01-01T00:00:00.000Z',1,1,'ok')`).run();
    db.prepare(`INSERT INTO observations(station_id,pollutant_id,observed_at,raw_value,corrected_value,quality_flag)
      VALUES(999,1,'2026-01-01T00:00:00.000Z',1,1,'ok')`).run();
  }));
  const count = db.prepare('SELECT COUNT(*) AS c FROM observations').get() as { c: number };
  assert.equal(count.c, 0);
});
