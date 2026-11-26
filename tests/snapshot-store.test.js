const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { openSnapshotStore, validDate } = require('../snapshot-store');

function snapshot(date, slot, value) {
  return {
    dataDate: date, slot, at: `${date}T${slot}:00-03:00`,
    channels: { Meli: value }, orders: { Meli: 1 },
    business: [{ empresa: 'Oficial', canal: 'Meli', gmv: value, pedidos: 1 }],
    analytics: [{ empresa: 'Oficial', canal: 'Meli', valor: value, situacao: 'Faturado', contabilizado: true }],
    financial: { channels: { Meli: value }, orders: { Meli: 1 }, business: [], analytics: [] }
  };
}

test('SQLite migrates once, preserves daily history and survives reopening', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-sqlite-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'dashboard.sqlite');
  const legacy = path.join(directory, 'legacy.json');
  fs.writeFileSync(legacy, JSON.stringify([snapshot('2026-11-24', '10:00', 100)]));
  let store = await openSnapshotStore(filename, legacy);
  store.save([snapshot('2026-11-24', '11:00', 150), snapshot('2026-11-25', '10:00', 300)]);
  store.save([snapshot('2026-11-25', '10:00', 350)]);
  store.close();
  // A stale JSON file must never overwrite the SQLite history on restart.
  fs.writeFileSync(legacy, JSON.stringify([snapshot('2026-11-25', '10:00', 1)]));
  store = await openSnapshotStore(filename, legacy);
  try {
    const history = store.readForDate('2026-11-25');
    assert.equal(history.length, 3);
    assert.deepEqual(history.map(row => row.channels.Meli), [100, 150, 350]);
    assert.equal(history[1].analytics[0].valor, 150);
    assert.equal(history[2].financial.channels.Meli, 350);
    assert.deepEqual(store.readForDate('2026-11-20'), []);
    assert.equal(fs.readFileSync(filename).subarray(0, 15).toString(), 'SQLite format 3');
    assert.equal(validDate('2026-02-30'), false);
    assert.equal(validDate("2026-11-25' OR 1=1"), false);
  } finally { store.close(); }
});

test('date API returns the selected day, including financial data, without changing it on update', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-date-api-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacy = path.join(directory, 'snapshots.json');
  fs.writeFileSync(legacy, JSON.stringify([
    snapshot('2026-11-23', '10:00', 50),
    snapshot('2026-11-24', '10:00', 100),
    snapshot('2026-11-24', '11:00', 150),
    snapshot('2026-11-25', '10:00', 350)
  ]));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: '0', SNAPSHOTS_FILE: legacy,
      SQLITE_FILE: path.join(directory, 'dashboard.sqlite'),
      DISABLE_AUTO_UPDATE: '1', READ_ONLY_PREVIEW: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start: ' + output)), 15000);
    child.on('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code + ' ' + output)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const get = async route => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`);
    return { status: response.status, body: await response.json() };
  };
  const first = (await get('/api/data?date=2026-11-24')).body;
  assert.equal(first.dataDate, '2026-11-24');
  assert.equal(first.isHistorical, true);
  assert.equal(first.metrics.totalGmv, 150);
  assert.equal(first.analytics[0].valor, 150);
  assert.equal(first.snapshotHistory.length, 2);
  assert.equal(first.comparisons.byScope.Consolidado.previousDayGmv, 50);
  assert.equal(first.financial.metrics.totalGmv, 150);
  assert.equal((await get('/api/data?date=2026-11-25')).body.metrics.totalGmv, 350);
  const empty = (await get('/api/data?date=2026-11-20')).body;
  assert.equal(empty.dataDate, '2026-11-20');
  assert.equal(empty.metrics.totalGmv, 0);
  assert.equal((await get('/api/update-data?date=2026-11-24')).body.metrics.totalGmv, 150);
  assert.equal((await get('/api/data?date=2026-02-30')).status, 400);
});
