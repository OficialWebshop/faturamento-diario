const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
    Number.isFinite(Date.parse(value + 'T12:00:00Z')) &&
    new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
}

async function openSnapshotStore(filename, legacyFile) {
  const SQL = await initSqlJs();
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new SQL.Database(fs.existsSync(filename) ? fs.readFileSync(filename) : undefined);
  db.run(`CREATE TABLE IF NOT EXISTS snapshots (
    data_date TEXT NOT NULL,
    slot TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (data_date, slot)
  ); CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);`);

  function persist() {
    const temporary = filename + '.tmp';
    fs.writeFileSync(temporary, Buffer.from(db.export()));
    fs.renameSync(temporary, filename);
  }

  function save(snapshots, migration = false) {
    db.run('BEGIN TRANSACTION');
    const insert = db.prepare(`INSERT INTO snapshots (data_date, slot, captured_at, payload)
      VALUES (?, ?, ?, ?) ON CONFLICT(data_date, slot) DO UPDATE SET
      captured_at = excluded.captured_at, payload = excluded.payload
      WHERE excluded.captured_at >= snapshots.captured_at`);
    try {
      for (const snapshot of snapshots) {
        if (!validDate(snapshot.dataDate) || !Number.isFinite(Date.parse(snapshot.at))) continue;
        const time = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false
        }).format(new Date(snapshot.at));
        const [hour, minute] = time.split(':');
        const slot = snapshot.slot || `${hour}:${Number(minute) < 30 ? '00' : '30'}`;
        insert.run([snapshot.dataDate, slot, new Date(snapshot.at).toISOString(), JSON.stringify(snapshot)]);
      }
      if (migration) db.run("INSERT INTO migrations (name) VALUES ('legacy-json')");
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    } finally {
      insert.free();
    }
    persist();
  }

  function readForDate(date) {
    if (!validDate(date)) throw new Error('Data inválida');
    const previous = new Date(Date.parse(date + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
    const query = db.prepare('SELECT payload FROM snapshots WHERE data_date IN (?, ?) ORDER BY captured_at');
    const snapshots = [];
    try {
      query.bind([previous, date]);
      while (query.step()) snapshots.push(JSON.parse(query.get()[0]));
    } finally {
      query.free();
    }
    return snapshots;
  }

  if (!db.exec("SELECT name FROM migrations WHERE name = 'legacy-json'").length) {
    const legacy = legacyFile && fs.existsSync(legacyFile) ? JSON.parse(fs.readFileSync(legacyFile, 'utf8')) : [];
    if (!Array.isArray(legacy)) throw new Error('Histórico JSON inválido');
    save(legacy, true);
  }
  return { save, readForDate, close: () => db.close() };
}

module.exports = { openSnapshotStore, validDate };
