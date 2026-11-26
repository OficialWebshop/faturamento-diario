const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const vm = require('node:vm');
const { openSnapshotStore } = require('../snapshot-store');
const { brDateIso } = require('../site/dist/daily-targets');

test('historical refresh queries Tiny, refreshes cached details and persists only the selected closing', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-reconcile-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const date = '2026-11-24', today = brDateIso();
  const snapshot = (dataDate, slot, value) => ({ dataDate, slot,
    at: `${dataDate}T${slot}:00-03:00`, channels: { Meli: value }, orders: { Meli: 1 },
    business: [{ empresa: 'Oficial', canal: 'Meli', gmv: value, pedidos: 1 }], analytics: [] });
  const snapshots = path.join(directory, 'snapshots.json');
  const database = path.join(directory, 'dashboard.sqlite');
  const cache = path.join(directory, 'cache.json');
  const dailyState = path.join(directory, 'state.json');
  fs.writeFileSync(snapshots, JSON.stringify([
    snapshot(date, '10:00', 50), snapshot(date, '23:30', 999), snapshot(today, '10:00', 700)
  ]));
  const originalState = JSON.stringify({ dataDate: today, bootstrapped: true, ordersByAccount: {} });
  fs.writeFileSync(dailyState, originalState);
  fs.writeFileSync(cache, JSON.stringify({ 'Oficial:1': {
    id: '1', numero: '1', data_pedido: '24/11/2026', situacao: 'Aprovado',
    total_pedido: '999', ecommerce: { nomeEcommerce: 'Meli' }, _tinyDetail: true
  } }));
  const requests = [], details = [];
  let phase = 'success';
  const tiny = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/search') {
      requests.push(Object.fromEntries(params));
      const token = params.get('token'), marker = params.get('marcador');
      const rows = token === 'of' ? [
        { id: '1', situacao: 'Aprovado', valor: '200' },
        { id: '2', situacao: 'Cancelado', valor: '900' },
        { id: '3', situacao: 'Em aberto', valor: '10' },
        { id: 'wrong-date', situacao: 'Aprovado', valor: '500', data_pedido: '23/11/2026' }
      ] : token === 'pr' ? [{ id: '4', situacao: 'Faturado', valor: '50' }]
        : token === 'sp' && marker === 'Magalu Fulfillment' ? [{ id: '5', situacao: 'Faturado', valor: '30' }] : [];
      return res.end(JSON.stringify({ retorno: { status: 'OK', numero_paginas: 1,
        pedidos: rows.map(row => ({ pedido: { numero: row.id, data_pedido: '24/11/2026', ...row } })) } }));
    }
    const id = params.get('id'); details.push(id);
    if (phase === 'failure' && id === '4') { res.statusCode = 500; return res.end('{}'); }
    if (phase === 'rate-limit' && id === '4') {
      return res.end(JSON.stringify({ retorno: { status: 'Erro', codigo_erro: 6,
        erros: [{ erro: 'Excedido o número de acessos' }] } }));
    }
    const values = { '1': 200, '2': 900, '3': 10, '4': 50, '5': 30 };
    const order = { id, numero: id, data_pedido: '24/11/2026',
      situacao: id === '2' ? 'Cancelado' : id === '3' ? 'Em aberto' : 'Faturado',
      total_pedido: String(values[id]), ecommerce: { nomeEcommerce: id === '1' ? 'Shopee' : 'Magalu' },
      ...(id === '5' ? { marcadores: [{ marcador: { descricao: 'Magalu Fulfillment' } }] } : {}) };
    return res.end(JSON.stringify({ retorno: { status: 'OK', pedido: order } }));
  });
  await new Promise(resolve => tiny.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => tiny.close(resolve)));
  const endpoint = `http://127.0.0.1:${tiny.address().port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DISABLE_AUTO_UPDATE: '1', READ_ONLY_PREVIEW: '0',
      SNAPSHOTS_FILE: snapshots, SQLITE_FILE: database, DETAIL_CACHE_FILE: cache, DAILY_STATE_FILE: dailyState,
      TINY_PESQUISA_ENDPOINT: endpoint + '/search', TINY_OBTER_ENDPOINT: endpoint + '/detail',
      TINY_OFICIAL_TOKEN: 'of', TINY_PRIORIZA_TOKEN: 'pr', TINY_OFICIALSP_TOKEN: 'sp', TINY_OFICIALSP2_TOKEN: 'sp2',
      TINY_DETAIL_DELAY_MS: '0' }
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output || 'Server startup timeout')), 15000);
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      const match = String(chunk).match(/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code + ': ' + output)); });
  });
  const get = async route => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`);
    return { status: response.status, body: await response.json() };
  };
  const result = await get(`/api/update-data?date=${date}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.dataDate, date);
  assert.equal(result.body.metrics.totalGmv, 290);
  assert.equal(result.body.metrics.totalOrders, 4);
  assert.equal(result.body.currentChannels.Shopee, 200, 'refreshes stale channel details');
  assert.equal(result.body.financial.metrics.totalGmv, 280);
  assert.equal(result.body.reconciliation.status, 'ok');
  assert.equal(result.body.snapshotHistory.length, 2);
  assert.equal(result.body.snapshotHistory[0].gmv, 50);
  assert.equal(result.body.snapshotHistory[1].gmv, 290);
  assert.equal(requests.length, 5, 'all accounts and fulfillment marker searches');
  assert.ok(requests.every(row => row.dataInicial === '24/11/2026' && row.dataFinal === '24/11/2026' && !row.dataAtualizacao));
  assert.ok(details.includes('1'), 'fetches detail even when already cached');
  assert.ok(!details.includes('wrong-date'));
  assert.equal((await get(`/api/data?date=${today}`)).body.metrics.totalGmv, 700);
  assert.equal(fs.readFileSync(dailyState, 'utf8'), originalState, 'does not touch current-day sync state');
  assert.equal((await get(`/api/data?date=${date}`)).body.metrics.totalGmv, 290);
  const store = await openSnapshotStore(database, snapshots);
  assert.equal(store.readForDate(date).at(-1).channels.Shopee, 200);
  store.close();
  const pending = await get(`/api/update-data?date=${date}&background=1`);
  assert.equal(pending.status, 202, 'returns promptly so long reconciliations do not time out at the proxy');
  let job;
  for (let attempt = 0; attempt < 100; attempt++) {
    job = (await get(`/api/data?date=${date}`)).body.historicalReconciliation;
    if (job.status !== 'pending') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(job.status, 'completed');
  phase = 'rate-limit';
  const rateLimited = await get(`/api/update-data?date=${date}`);
  assert.equal(rateLimited.status, 500, 'must not accept stale cached details when Tiny rate-limits');
  assert.match(rateLimited.body.error, /aguardando detalhe/);
  assert.equal((await get(`/api/data?date=${date}`)).body.metrics.totalGmv, 290);
  phase = 'failure';
  const failed = await get(`/api/update-data?date=${date}`);
  assert.equal(failed.status, 500);
  assert.equal(failed.body.reconciliation.status, 'failed');
  assert.equal((await get(`/api/data?date=${date}`)).body.metrics.totalGmv, 290, 'keeps saved closing on partial failure');
  assert.equal((await get(`/api/data?date=${today}`)).body.metrics.totalGmv, 700);
});

test('frontend waits for the historical save and reports reconciliation errors', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../site/dist/app.js'), 'utf8');
  const start = source.indexOf('async function waitHistoricalReconciliation(');
  const end = source.indexOf("document.querySelector('#refreshBtn')", start);
  let responses = [{ status: 'pending' }, { status: 'completed' }];
  const urls = [];
  const context = vm.createContext({
    setTimeout: callback => queueMicrotask(callback),
    fetch: async url => {
      urls.push(url);
      return { ok: true, json: async () => ({ historicalReconciliation: responses.shift() }) };
    }
  });
  vm.runInContext(source.slice(start, end), context);
  await vm.runInContext("waitHistoricalReconciliation('2026-11-24')", context);
  assert.equal(urls.length, 2);
  assert.ok(urls.every(url => url === '/api/data?date=2026-11-24'));
  responses = [{ status: 'failed', error: 'Tiny indisponível' }];
  await assert.rejects(vm.runInContext("waitHistoricalReconciliation('2026-11-24')", context), /Tiny indisponível/);
});
