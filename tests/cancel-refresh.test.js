const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { brDateIso } = require('../site/dist/daily-targets');

const ROOT = path.resolve(__dirname, '..');

function brTodayDdMmYyyy() {
  const [yyyy, mm, dd] = brDateIso().split('-');
  return `${dd}/${mm}/${yyyy}`;
}

test('frontend button cancels an in-flight refresh, posts /api/queue/cancel with mode=auto and forces a fresh load', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'site', 'dist', 'index.html'), 'utf8');
  assert.match(html, /id="cancelRefreshBtn"/);

  const app = fs.readFileSync(path.join(ROOT, 'site', 'dist', 'app.js'), 'utf8');
  const start = app.indexOf('async function waitHistoricalReconciliation(');
  const end = app.indexOf("document.querySelector('#dashboardDate').addEventListener", start);

  const nodes = new Map();
  for (const id of ['refreshBtn', 'cancelRefreshBtn', 'refreshProgress', 'refreshProgressBar', 'refreshProgressLabel']) {
    const classes = new Set();
    nodes.set('#' + id, {
      hidden: true,
      disabled: false,
      value: 0,
      textContent: '',
      classList: {
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        toggle: (name, force) => {
          const next = force === undefined ? !classes.has(name) : Boolean(force);
          if (next) classes.add(name); else classes.delete(name);
        },
        contains: name => classes.has(name)
      },
      addEventListener(type, callback) { this[type] = callback; }
    });
  }

  let firstAborted = false;
  let cancelRequest = null;
  let clearedTimers = 0;
  let loadCalls = 0;
  const messages = [];

  const context = vm.createContext({
    AbortController,
    selectedDate: '2026-11-27',
    todayDate: '2026-11-27',
    document: { querySelector: selector => nodes.get(selector) },
    setInterval: () => 1,
    clearInterval: () => { clearedTimers += 1; },
    setTimeout: cb => queueMicrotask(cb),
    fetch: async (url, options = {}) => {
      if (url.startsWith('/api/update-data')) {
        return new Promise((_, reject) => {
          options.signal?.addEventListener('abort', () => {
            firstAborted = true;
            reject(new Error('Aborted'));
          });
        });
      }
      if (url === '/api/queue/cancel') {
        cancelRequest = { url, method: options.method, body: JSON.parse(options.body) };
        return { ok: true, status: 200, json: async () => ({ ok: true, cancelled: true }) };
      }
      throw new Error('Unexpected fetch: ' + url);
    },
    loadBigQuery: async () => { loadCalls += 1; return true; },
    toast: message => messages.push(message)
  });

  vm.runInContext(app.slice(start, end), context);

  const refreshBtn = nodes.get('#refreshBtn');
  const cancelBtn = nodes.get('#cancelRefreshBtn');

  // 1. Start a normal refresh that hangs in-flight
  const firstRun = refreshBtn.click({ currentTarget: refreshBtn });
  assert.equal(refreshBtn.disabled, true);
  assert.equal(cancelBtn.disabled, false);

  // 2. Click "Cancelar e atualizar" while the first refresh is still running
  await cancelBtn.click({ currentTarget: cancelBtn });
  await firstRun;

  assert.equal(firstAborted, true, 'must abort the previous client refresh fetch');
  assert.deepEqual(cancelRequest, {
    url: '/api/queue/cancel',
    method: 'POST',
    body: { forceRefresh: true, mode: 'auto', background: true, date: '2026-11-27' }
  });
  assert.equal(loadCalls, 1);
  assert.equal(clearedTimers, 2, 'stops both the superseded progress timer and the completed one');
  assert.equal(nodes.get('#refreshProgressBar').value, 100);
  assert.equal(refreshBtn.disabled, false);
  assert.equal(cancelBtn.disabled, false);
  assert.equal(messages.length, 1, 'aborted first run must not emit a spurious error toast');
  assert.match(messages[0], /Eventos cancelados e Tiny atualizado para 27\/11\/2026/);
});

test('POST /api/queue/cancel aborts hung Tiny fetch, cancels retries/historical jobs and forces a new mode=auto update', async t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cancel-refresh-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const snapshotsFile = path.join(tmpDir, 'snapshots.json');
  const sqliteFile = path.join(tmpDir, 'dashboard.sqlite');
  const cacheFile = path.join(tmpDir, 'cache.json');
  const dailyStateFile = path.join(tmpDir, 'daily-orders-state.json');

  const todayIso = brDateIso();
  const todayBr = brTodayDdMmYyyy();
  const historicalDate = '2026-11-24';
  const historicalBr = '24/11/2026';

  let phase = 'bootstrap';
  let hangSearchCount = 0;
  let abortedRequests = 0;
  let notifyHungRequest = null;
  const searchLog = [];
  const openHungResponses = [];

  const mockTiny = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const token = params.get('token');
      const dataInicial = params.get('dataInicial');
      const dataAtualizacao = params.get('dataAtualizacao');

      if (req.url === '/pesquisa') {
        searchLog.push({ phase, token, dataInicial, dataAtualizacao });

        if ((phase === 'hang_today' || phase === 'hang_historical') && token === 'tok_of') {
          hangSearchCount += 1;
          openHungResponses.push(res);
          req.on('close', () => {
            if (!res.writableEnded) abortedRequests += 1;
          });
          if (notifyHungRequest) {
            const resolve = notifyHungRequest;
            notifyHungRequest = null;
            resolve();
          }
          return; // Intentionally hang until aborted by cancellation
        }

        if (phase === 'fail_retry' && token === 'tok_of') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ retorno: { status: 'Erro', erros: [{ erro: 'Falha temporária simulada' }] } }));
          return;
        }

        if (phase === 'bootstrap' && token === 'tok_of') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            retorno: {
              status: 'OK',
              numero_paginas: 1,
              pedidos: [{ pedido: { id: '1', numero: '1001', data_pedido: todayBr, situacao: 'Aprovado', valor: '100.00' } }]
            }
          }));
          return;
        }

        if (phase === 'after_cancel_today' && token === 'tok_of') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            retorno: {
              status: 'OK',
              numero_paginas: 1,
              pedidos: [{ pedido: { id: '2', numero: '1002', data_pedido: todayBr, situacao: 'Faturado', valor: '250.00' } }]
            }
          }));
          return;
        }

        if (phase === 'after_cancel_historical' && token === 'tok_of') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            retorno: {
              status: 'OK',
              numero_paginas: 1,
              pedidos: [{ pedido: { id: '3', numero: '1003', data_pedido: historicalBr, situacao: 'Faturado', valor: '420.00' } }]
            }
          }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          retorno: { status: 'Erro', codigo_erro: 20, erros: [{ erro: 'A consulta não retornou registros' }] }
        }));
        return;
      }

      if (req.url === '/obter') {
        const id = params.get('id');
        const details = {
          '1': { id: '1', numero: '1001', data_pedido: todayBr, situacao: 'Aprovado', total_pedido: '100.00', ecommerce: { nomeEcommerce: 'Shopee' }, marcadores: [] },
          '2': { id: '2', numero: '1002', data_pedido: todayBr, situacao: 'Faturado', total_pedido: '250.00', ecommerce: { nomeEcommerce: 'Mercado Livre' }, marcadores: [] },
          '3': { id: '3', numero: '1003', data_pedido: historicalBr, situacao: 'Faturado', total_pedido: '420.00', ecommerce: { nomeEcommerce: 'Magalu' }, marcadores: [] }
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ retorno: { status: 'OK', pedido: details[id] } }));
      }
    });
  });

  await new Promise(resolve => mockTiny.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const res of openHungResponses) {
      if (!res.writableEnded) res.destroy();
    }
    return new Promise(resolve => mockTiny.close(resolve));
  });

  const tinyEndpoint = `http://127.0.0.1:${mockTiny.address().port}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '0',
      DISABLE_AUTO_UPDATE: '1',
      READ_ONLY_PREVIEW: '0',
      QUEUE_CONTROL_TOKEN: 'segredo-teste',
      SNAPSHOTS_FILE: snapshotsFile,
      SQLITE_FILE: sqliteFile,
      DETAIL_CACHE_FILE: cacheFile,
      DAILY_STATE_FILE: dailyStateFile,
      TINY_PESQUISA_ENDPOINT: `${tinyEndpoint}/pesquisa`,
      TINY_OBTER_ENDPOINT: `${tinyEndpoint}/obter`,
      TINY_OFICIAL_TOKEN: 'tok_of',
      TINY_PRIORIZA_TOKEN: 'tok_pr',
      TINY_OFICIALSP_TOKEN: 'tok_sp1',
      TINY_OFICIALSP2_TOKEN: 'tok_sp2',
      TINY_DETAIL_DELAY_MS: '0',
      TINY_RETRY_BASE_MS: '5000',
      TINY_FULL_RECONCILE_INTERVAL_MS: '3600000'
    }
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  });

  let stderr = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr || 'Timeout iniciando server.js')), 15000);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      const match = String(chunk).match(/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server.js saiu (${code}): ${stderr}`)); });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const authHeaders = { 'Content-Type': 'application/json', 'x-queue-token': 'segredo-teste' };

  // Auth & validation checks
  const forbidden = await fetch(`${baseUrl}/api/queue/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(forbidden.status, 403);
  const invalidDate = await fetch(`${baseUrl}/api/queue/cancel`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ date: '27/11/2026' }) });
  assert.equal(invalidDate.status, 400);
  const futureDate = await fetch(`${baseUrl}/api/queue/cancel`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ forceRefresh: true, date: '2099-12-31' }) });
  assert.equal(futureDate.status, 400);

  // 1. Bootstrap today so watermarks exist
  const bootRes = await fetch(`${baseUrl}/api/update-data`);
  assert.equal(bootRes.status, 200);
  const bootBody = await bootRes.json();
  assert.equal(bootBody.metrics.totalGmv, 100);

  // 2. Start a hung update for today, then cancel and force a fresh mode=auto (incremental) update
  phase = 'hang_today';
  const hungReached = new Promise(resolve => { notifyHungRequest = resolve; });
  const hungUpdatePromise = fetch(`${baseUrl}/api/update-data`);
  await hungReached;

  const queueDuringHang = await (await fetch(`${baseUrl}/api/queue`)).json();
  assert.equal(queueDuringHang.updating, true);
  assert.equal(queueDuringHang.status, 'running');

  phase = 'after_cancel_today';
  const startedCancelMs = Date.now();
  const cancelForceRes = await fetch(`${baseUrl}/api/queue/cancel`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ forceRefresh: true, mode: 'auto', date: todayIso })
  });
  const elapsedMs = Date.now() - startedCancelMs;
  assert.equal(cancelForceRes.status, 200);
  assert.ok(elapsedMs < 5000, `cancellation should abort immediately instead of waiting 30s timeout (took ${elapsedMs}ms)`);

  const cancelForceBody = await cancelForceRes.json();
  assert.equal(cancelForceBody.cancelled, true);
  assert.equal(cancelForceBody.hadActiveUpdate, true);
  assert.equal(cancelForceBody.metrics.totalGmv, 350, 'preserves bootstrapped order 100 and adds incremental order 250');
  assert.equal(cancelForceBody.queue.status, 'idle');

  const hungRes = await hungUpdatePromise;
  assert.equal(hungRes.status, 409, 'cancelled in-flight /api/update-data returns 409');
  assert.ok(abortedRequests >= 1, 'hung Tiny fetch socket must be aborted');

  const afterCancelSearches = searchLog.filter(entry => entry.phase === 'after_cancel_today');
  assert.ok(afterCancelSearches.length >= 4);
  assert.ok(afterCancelSearches.every(entry => Boolean(entry.dataAtualizacao) && !entry.dataInicial),
    'mode=auto forced refresh for today uses incremental dataAtualizacao');

  // 3. Cancel pending retry backoff timer without forcing a new refresh
  phase = 'fail_retry';
  const failedRes = await fetch(`${baseUrl}/api/update-data`);
  assert.equal(failedRes.status, 500);
  const failedBody = await failedRes.json();
  assert.equal(failedBody.queue.status, 'waiting_retry');
  assert.equal(failedBody.queue.attempt, 1);

  const cancelRetryRes = await fetch(`${baseUrl}/api/queue/cancel`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ forceRefresh: false })
  });
  assert.equal(cancelRetryRes.status, 200);
  const cancelRetryBody = await cancelRetryRes.json();
  assert.equal(cancelRetryBody.cancelled, true);
  assert.equal(cancelRetryBody.hadPendingRetry, true);
  assert.equal(cancelRetryBody.queue.status, 'idle');
  assert.equal(cancelRetryBody.queue.attempt, 0);
  assert.equal(cancelRetryBody.queue.nextRetryAt, null);

  // 4. Cancel a hung historical background reconciliation and force a new historical one
  phase = 'hang_historical';
  const hungHistReached = new Promise(resolve => { notifyHungRequest = resolve; });
  const histPendingRes = await fetch(`${baseUrl}/api/update-data?date=${historicalDate}&background=1`);
  assert.equal(histPendingRes.status, 202);
  await hungHistReached;

  phase = 'after_cancel_historical';
  const cancelHistRes = await fetch(`${baseUrl}/api/queue/cancel`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ forceRefresh: true, date: historicalDate, mode: 'auto', background: true })
  });
  assert.equal(cancelHistRes.status, 202);
  const cancelHistBody = await cancelHistRes.json();
  assert.equal(cancelHistBody.cancelled, true);
  assert.equal(cancelHistBody.hadActiveUpdate, true);
  assert.equal(cancelHistBody.cancelledHistoricalJobs, 1);
  assert.equal(cancelHistBody.historicalReconciliation.status, 'pending');

  let finalHistJob = null;
  for (let i = 0; i < 100; i++) {
    const poll = await (await fetch(`${baseUrl}/api/data?date=${historicalDate}`)).json();
    finalHistJob = poll.historicalReconciliation;
    if (finalHistJob?.status !== 'pending') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(finalHistJob?.status, 'completed');
  const histData = await (await fetch(`${baseUrl}/api/data?date=${historicalDate}`)).json();
  assert.equal(histData.metrics.totalGmv, 420);
  assert.equal(hangSearchCount, 2);
});
