const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { getDailyTargetValue, brDateIso } = require('../site/dist/daily-targets');
const { summarize: summarizeFinancial } = require('../site/dist/financial-report');
const goalReveal = require('../site/dist/goal-reveal');

const ROOT = path.resolve(__dirname, '..');
const TARGET_27_11 = getDailyTargetValue('2026-11-27');
const LOCK_THRESHOLD = goalReveal.GOAL_LOCK_THRESHOLD;

function makeSnapshot(date, slot, gmv, { reachedAt = null, withAnalytics = true } = {}) {
  const analytics = withAnalytics ? [
    { pedido: `${slot}-1`, empresa: 'Oficial', canal: 'Meli', valor: Math.floor(gmv * 0.6), situacao: 'Faturado', detalhe: 'Completo', contabilizado: true },
    { pedido: `${slot}-2`, empresa: 'Prioriza', canal: 'Shopee', valor: gmv - Math.floor(gmv * 0.6), situacao: 'Aprovado', detalhe: 'Completo', contabilizado: true }
  ] : undefined;
  const channels = { Meli: Math.floor(gmv * 0.6), Shopee: gmv - Math.floor(gmv * 0.6) };
  const orders = { Meli: 1, Shopee: 1 };
  const business = [
    { empresa: 'Oficial', canal: 'Meli', gmv: channels.Meli, fullGmv: 0, pedidos: 1 },
    { empresa: 'Prioriza', canal: 'Shopee', gmv: channels.Shopee, fullGmv: 0, pedidos: 1 }
  ];
  return {
    dataDate: date,
    slot,
    at: `${date}T${slot}:00-03:00`,
    channels,
    orders,
    business,
    ...(analytics ? { analytics, financial: summarizeFinancial(analytics) } : {}),
    ...(reachedAt ? { goalReached: { date, target: TARGET_27_11, reachedAt: { Consolidado: reachedAt } } } : {})
  };
}

test('goal reveal lock is strictly restricted to today 2026-11-27 with 700k threshold and resets prior threshold state', () => {
  assert.equal(TARGET_27_11, 717684);
  assert.equal(LOCK_THRESHOLD, 700000);
  assert.equal(goalReveal.isGoalRevealActive('2026-11-27', '2026-11-27'), true);
  assert.equal(goalReveal.isGoalRevealActive('2026-11-26', '2026-11-27'), false);
  assert.equal(goalReveal.isGoalRevealActive('2026-11-27', '2026-11-28'), false);
  assert.equal(goalReveal.isGoalRevealActive('2026-11-28', '2026-11-28'), false);

  // Stale revealed state from old 690k threshold must re-lock at 700k
  const staleState = { dataDate: '2026-11-27', lockThreshold: 690000, revealed: true, revealedAt: '2026-11-27T21:40:00.000Z', preGoalSnapshots: [] };
  const relocked = goalReveal.resolveGoalReveal([
    makeSnapshot('2026-11-27', '18:00', 698000),
    makeSnapshot('2026-11-27', '18:30', 705000)
  ], {
    requestedDate: '2026-11-27',
    todayDate: '2026-11-27',
    target: TARGET_27_11,
    state: staleState,
    summarizeFinancial
  });
  assert.equal(relocked.goalReveal.locked, true);
  assert.equal(relocked.goalReveal.revealed, false);
  assert.equal(relocked.goalReveal.goalReached, false);
  assert.equal(goalReveal.snapshotTotalGmv(relocked.snapshotsForPayload.at(-1)), 698000);

  const overTarget27 = [makeSnapshot('2026-11-27', '18:00', 750000, { reachedAt: '2026-11-27T18:00:00-03:00' })];
  const nextDayViewing27 = goalReveal.resolveGoalReveal(overTarget27, {
    requestedDate: '2026-11-27',
    todayDate: '2026-11-28',
    target: TARGET_27_11,
    state: null,
    summarizeFinancial
  });
  assert.equal(nextDayViewing27.goalReveal.enabled, false);
  assert.equal(nextDayViewing27.goalReveal.locked, false);
  assert.equal(goalReveal.snapshotTotalGmv(nextDayViewing27.snapshotsForPayload.at(-1)), 750000);
});

test('locks dashboard from 700k on 2026-11-27, handles drop below 700k, and resumes normally after reveal', () => {
  const prevDay = makeSnapshot('2026-11-26', '23:30', 320000);
  const s1 = makeSnapshot('2026-11-27', '17:30', 650000);
  const s2 = makeSnapshot('2026-11-27', '18:00', 698500);

  // 1. Below 700k: updates normally and saves pre-lock snapshot
  let state = goalReveal.createEmptyGoalRevealState('2026-11-27');
  let res = goalReveal.resolveGoalReveal([prevDay, s1, s2], {
    requestedDate: '2026-11-27',
    todayDate: '2026-11-27',
    target: TARGET_27_11,
    state,
    summarizeFinancial
  });
  assert.equal(res.goalReveal.enabled, true);
  assert.equal(res.goalReveal.lockReached, false);
  assert.equal(res.goalReveal.goalReached, false);
  assert.equal(res.goalReveal.locked, false);
  assert.equal(res.goalReveal.canReveal, false);
  assert.equal(res.stateChanged, true);
  state = res.nextState;
  assert.equal(goalReveal.snapshotTotalGmv(res.snapshotsForPayload.at(-1)), 698500);

  // 2. Reaches 700k (705.000 < 717.684): locks at 698.500, canReveal=true, goalReached=false
  const s2At705 = makeSnapshot('2026-11-27', '18:00', 705000);
  res = goalReveal.resolveGoalReveal([prevDay, s1, s2At705], {
    requestedDate: '2026-11-27',
    todayDate: '2026-11-27',
    target: TARGET_27_11,
    state,
    summarizeFinancial
  });
  assert.equal(res.goalReveal.enabled, true);
  assert.equal(res.goalReveal.lockReached, true);
  assert.equal(res.goalReveal.goalReached, false);
  assert.equal(res.goalReveal.locked, true);
  assert.equal(res.goalReveal.canReveal, true);
  assert.equal(res.goalReveal.revealed, false);
  const frozenDay = res.snapshotsForPayload.filter(s => s.dataDate === '2026-11-27');
  assert.equal(goalReveal.snapshotTotalGmv(frozenDay.at(-1)), 698500);

  // 3. Crosses daily goal (725.000): stays locked at 698.500 with goalReached=true and no leaked reachedAt
  const s2Crossed = makeSnapshot('2026-11-27', '18:00', 725000, { reachedAt: '2026-11-27T18:10:00-03:00' });
  res = goalReveal.resolveGoalReveal([prevDay, s1, s2Crossed], {
    requestedDate: '2026-11-27',
    todayDate: '2026-11-27',
    target: TARGET_27_11,
    state,
    summarizeFinancial
  });
  assert.equal(res.goalReveal.locked, true);
  assert.equal(res.goalReveal.lockReached, true);
  assert.equal(res.goalReveal.goalReached, true);
  assert.equal(res.goalReveal.canReveal, true);
  const frozenDay2 = res.snapshotsForPayload.filter(s => s.dataDate === '2026-11-27');
  assert.equal(goalReveal.snapshotTotalGmv(frozenDay2.at(-1)), 698500);
  assert.equal(frozenDay2.at(-1).goalReached, undefined);

  // 4. Drops below 700k (692.000) before reveal: reverts to unlocked pre-lock
  const s2Cancelled = makeSnapshot('2026-11-27', '18:00', 692000);
  res = goalReveal.resolveGoalReveal([prevDay, s1, s2Cancelled], {
    requestedDate: '2026-11-27',
    todayDate: '2026-11-27',
    target: TARGET_27_11,
    state,
    summarizeFinancial
  });
  assert.equal(res.goalReveal.locked, false);
  assert.equal(res.goalReveal.lockReached, false);
  assert.equal(res.goalReveal.canReveal, false);
  assert.equal(goalReveal.snapshotTotalGmv(res.snapshotsForPayload.at(-1)), 692000);
  state = res.nextState;

  // 5. After reveal button is clicked: unlocks and continues updating normally
  state = { ...state, revealed: true, revealedAt: '2026-11-27T21:35:00.000Z' };
  const s3Later = makeSnapshot('2026-11-27', '19:00', 765000, { reachedAt: '2026-11-27T18:30:00-03:00' });
  res = goalReveal.resolveGoalReveal([prevDay, s1, s2Cancelled, s3Later], {
    requestedDate: '2026-11-27',
    todayDate: '2026-11-27',
    target: TARGET_27_11,
    state,
    summarizeFinancial
  });
  assert.equal(res.goalReveal.locked, false);
  assert.equal(res.goalReveal.revealed, true);
  assert.equal(res.goalReveal.canReveal, false);
  const unlockedDay = res.snapshotsForPayload.filter(s => s.dataDate === '2026-11-27');
  assert.equal(goalReveal.snapshotTotalGmv(unlockedDay.at(-1)), 765000);
  assert.equal(unlockedDay.at(-1).goalReached.reachedAt.Consolidado, '2026-11-27T18:30:00-03:00');
});

test('fallbacks stay strictly below 700k when no saved pre-lock state existed yet', () => {
  const earlier = makeSnapshot('2026-11-27', '17:30', 695000, { withAnalytics: false });
  const crossed = makeSnapshot('2026-11-27', '18:00', 705000);
  const fromHistory = goalReveal.resolveGoalReveal([earlier, crossed], {
    requestedDate: '2026-11-27',
    todayDate: '2026-11-27',
    target: TARGET_27_11,
    state: null,
    summarizeFinancial
  });
  assert.equal(fromHistory.goalReveal.locked, true);
  assert.equal(fromHistory.stateChanged, true);
  assert.equal(goalReveal.snapshotTotalGmv(fromHistory.snapshotsForPayload.at(-1)), 695000);

  const singleLegacy = makeSnapshot('2026-11-27', '18:00', 740000, { withAnalytics: false });
  const syntheticLegacy = goalReveal.resolveGoalReveal([singleLegacy], {
    requestedDate: '2026-11-27',
    todayDate: '2026-11-27',
    target: TARGET_27_11,
    state: null,
    summarizeFinancial
  });
  const synLegacyGmv = goalReveal.snapshotTotalGmv(syntheticLegacy.snapshotsForPayload.at(-1));
  assert.ok(synLegacyGmv > 0 && synLegacyGmv < LOCK_THRESHOLD, `expected scaled legacy GMV below 700k, got ${synLegacyGmv}`);
});

test('frontend stays neutral when locked at 700k and only turns green when daily goal is beaten', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'site', 'dist', 'index.html'), 'utf8');
  assert.match(html, /id="uploadBaseBtn"/);
  assert.match(html, /id="goalRevealBtn"/);
  assert.match(html, /<script src="goal-reveal\.js"><\/script>/);

  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => {
    const classes = new Set();
    return ['#' + match[1], {
      textContent: '',
      innerHTML: '',
      value: 'all',
      title: '',
      hidden: match[1] === 'goalRevealBtn',
      disabled: match[1] === 'goalRevealBtn',
      style: {},
      dataset: {},
      classList: {
        add(...names) { for (const n of names) classes.add(n); },
        remove(...names) { for (const n of names) classes.delete(n); },
        toggle(name, force) {
          const next = force === undefined ? !classes.has(name) : Boolean(force);
          if (next) classes.add(name); else classes.delete(name);
        },
        contains: name => classes.has(name)
      },
      setAttribute() {},
      open: false,
      showModal() { this.open = true; },
      close() { this.open = false; },
      listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }
    }];
  }));

  const health = { classList: { toggle() {} }, querySelector: () => ({ textContent: '' }) };
  const makePayload = (dataDate, today, gmv, revealMeta, reachedAt = {}) => ({
    updatedAt: `${dataDate}T21:15:00.000Z`,
    dataDate,
    today,
    isHistorical: dataDate !== today,
    target: getDailyTargetValue(dataDate),
    goalReachedAt: reachedAt,
    comparisons: { byScope: { Consolidado: { previousDayGmv: 320000 } } },
    series: [{ channel: 'Meli', hours: [{ hour: '18:00', value: gmv }] }],
    currentChannels: { Meli: gmv },
    previousChannels: { Meli: gmv - 10000 },
    snapshotHistory: [{ at: `${dataDate}T21:15:00.000Z`, slot: '18:00', gmv, orders: 500, business: [{ empresa: 'Oficial', canal: 'Meli', gmv, pedidos: 500 }] }],
    accounts: [{ empresa: 'Oficial', pedidos: 500 }],
    business: [{ empresa: 'Oficial', canal: 'Meli', gmv, pedidos: 500 }],
    analytics: [{ pedido: '100', empresa: 'Oficial', canal: 'Meli', valor: gmv, situacao: 'Faturado', detalhe: 'Completo', contabilizado: true }],
    metrics: { totalGmv: gmv, totalOrders: 500, ticket: gmv / 500 },
    goalReveal: revealMeta
  });

  let nextApiResponse = makePayload('2026-11-27', '2026-11-27', 698500, {
    enabled: true, date: '2026-11-27', target: TARGET_27_11, lockThreshold: LOCK_THRESHOLD, lockReached: false, goalReached: false, locked: false, revealed: false, revealedAt: null, canReveal: false
  });
  const revealResponse = makePayload('2026-11-27', '2026-11-27', 730000, {
    enabled: true, date: '2026-11-27', target: TARGET_27_11, lockThreshold: LOCK_THRESHOLD, lockReached: true, goalReached: true, locked: false, revealed: true, revealedAt: '2026-11-27T21:20:00.000Z', canReveal: false
  }, { Consolidado: '2026-11-27T21:10:00.000Z' });
  let revealRequest = null;

  const context = vm.createContext({
    Intl,
    Date,
    console,
    document: {
      body: { classList: { toggle() {} } },
      querySelector: selector => selector === '.stream-health' ? health : elements.get(selector) || null,
      querySelectorAll: () => []
    },
    localStorage: { getItem: () => null, setItem() {} },
    setInterval() {},
    setTimeout() {},
    fetch: async (url, options = {}) => {
      if (url === '/api/goal-reveal') {
        revealRequest = { url, method: options.method, body: JSON.parse(options.body) };
        return { ok: true, status: 200, json: async () => revealResponse };
      }
      return { ok: true, status: 200, json: async () => nextApiResponse };
    }
  });

  for (const file of ['financial-report.js', 'dashboard-data.js', 'goal-reveal.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'site', 'dist', file), 'utf8'), context);
  }

  // 1. Below 700k: disabled neutral button
  assert.equal(await vm.runInContext('loadBigQuery(false)', context), true);
  const uploadBtn = elements.get('#uploadBaseBtn');
  const revealBtn = elements.get('#goalRevealBtn');
  const revealLabel = elements.get('#goalRevealLabel');
  assert.equal(uploadBtn.hidden, true);
  assert.equal(revealBtn.hidden, false);
  assert.equal(revealBtn.disabled, true);
  assert.equal(revealBtn.classList.contains('ready'), false);
  assert.equal(revealBtn.classList.contains('unlockable'), false);
  assert.equal(revealLabel.textContent, 'Aguardando R$ 700 mil');

  // 2. Locked at 700k..717.683 (goal NOT yet beaten): button clickable (unlockable), NOT green (.ready=false)
  nextApiResponse = makePayload('2026-11-27', '2026-11-27', 698500, {
    enabled: true, date: '2026-11-27', target: TARGET_27_11, lockThreshold: LOCK_THRESHOLD, lockReached: true, goalReached: false, locked: true, revealed: false, revealedAt: null, canReveal: true
  });
  await vm.runInContext('loadBigQuery(false)', context);
  assert.equal(revealBtn.disabled, false);
  assert.equal(revealBtn.classList.contains('unlockable'), true);
  assert.equal(revealBtn.classList.contains('ready'), false, 'must NOT turn green before daily goal is beaten');
  assert.equal(revealLabel.textContent, 'Liberar valores');
  assert.equal(elements.get('#totalGMV').textContent, 'R$ 698.500');

  // 3. Goal beaten (>= 717.684) while still locked: button turns GREEN (.ready=true)
  nextApiResponse = makePayload('2026-11-27', '2026-11-27', 698500, {
    enabled: true, date: '2026-11-27', target: TARGET_27_11, lockThreshold: LOCK_THRESHOLD, lockReached: true, goalReached: true, locked: true, revealed: false, revealedAt: null, canReveal: true
  });
  await vm.runInContext('loadBigQuery(false)', context);
  assert.equal(revealBtn.disabled, false);
  assert.equal(revealBtn.classList.contains('unlockable'), false);
  assert.equal(revealBtn.classList.contains('ready'), true, 'turns green once daily goal is beaten');
  assert.equal(elements.get('#totalGMV').textContent, 'R$ 698.500');

  // 4. Click button: posts /api/goal-reveal, reveals 730k and goal achieved
  await revealBtn.listeners.click();
  assert.deepEqual(revealRequest, {
    url: '/api/goal-reveal',
    method: 'POST',
    body: { date: '2026-11-27' }
  });
  assert.equal(elements.get('#totalGMV').textContent, 'R$ 730.000');
  assert.equal(elements.get('#targetValue').textContent, '101.7%');
  assert.equal(elements.get('#targetValue').style.color, 'var(--green)');
  assert.equal(revealBtn.disabled, true);
  assert.equal(revealBtn.classList.contains('ready'), false);
  assert.equal(revealBtn.classList.contains('revealed'), true);
  assert.equal(revealLabel.textContent, 'Painel liberado');

  // 5. Outside 27/11: Importar base returns, reveal button hides
  nextApiResponse = makePayload('2026-11-26', '2026-11-27', 350000, {
    enabled: false, date: '2026-11-27', target: getDailyTargetValue('2026-11-26'), lockThreshold: LOCK_THRESHOLD, lockReached: false, goalReached: false, locked: false, revealed: false, revealedAt: null, canReveal: false
  });
  await vm.runInContext('loadBigQuery(false)', context);
  assert.equal(uploadBtn.hidden, false);
  assert.equal(revealBtn.hidden, true);
});

test('HTTP server locks values from 700k on 2026-11-27 and resumes normal updates after POST /api/goal-reveal', async t => {
  if (brDateIso() !== '2026-11-27') return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-goal-reveal-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const snapshotsFile = path.join(tmpDir, 'snapshots.json');
  const sqliteFile = path.join(tmpDir, 'dashboard.sqlite');
  const cacheFile = path.join(tmpDir, 'cache.json');
  const dailyStateFile = path.join(tmpDir, 'daily-orders-state.json');
  const revealStateFile = path.join(tmpDir, 'goal-reveal-state.json');

  // Simulate an old revealed state from the previous 690k lock to verify automatic re-lock at 700k
  fs.writeFileSync(revealStateFile, JSON.stringify({
    dataDate: '2026-11-27',
    lockThreshold: 690000,
    revealed: true,
    revealedAt: '2026-11-27T21:40:00.000Z',
    preGoalSnapshots: []
  }));

  let phase = 'below_700k';
  const mockTiny = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const token = params.get('token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/pesquisa') {
        if (token === 'tok_of') {
          const pedidos = phase === 'below_700k'
            ? [{ pedido: { id: '1', numero: '1001', data_pedido: '27/11/2026', situacao: 'Faturado', valor: '695000.00' } }]
            : phase === 'above_700k'
              ? [
                  { pedido: { id: '1', numero: '1001', data_pedido: '27/11/2026', situacao: 'Faturado', valor: '695000.00' } },
                  { pedido: { id: '2', numero: '1002', data_pedido: '27/11/2026', situacao: 'Faturado', valor: '10000.00' } }
                ]
              : [
                  { pedido: { id: '1', numero: '1001', data_pedido: '27/11/2026', situacao: 'Faturado', valor: '695000.00' } },
                  { pedido: { id: '2', numero: '1002', data_pedido: '27/11/2026', situacao: 'Faturado', valor: '10000.00' } },
                  { pedido: { id: '3', numero: '1003', data_pedido: '27/11/2026', situacao: 'Faturado', valor: '35000.00' } }
                ];
          return res.end(JSON.stringify({ retorno: { status: 'OK', numero_paginas: 1, pedidos } }));
        }
        return res.end(JSON.stringify({ retorno: { status: 'Erro', codigo_erro: 20, erros: [{ erro: 'A consulta não retornou registros' }] } }));
      }
      const id = params.get('id');
      const details = {
        '1': { id: '1', numero: '1001', data_pedido: '27/11/2026', situacao: 'Faturado', total_pedido: '695000.00', ecommerce: { nomeEcommerce: 'Mercado Livre' }, marcadores: [] },
        '2': { id: '2', numero: '1002', data_pedido: '27/11/2026', situacao: 'Faturado', total_pedido: '10000.00', ecommerce: { nomeEcommerce: 'Shopee' }, marcadores: [] },
        '3': { id: '3', numero: '1003', data_pedido: '27/11/2026', situacao: 'Faturado', total_pedido: '35000.00', ecommerce: { nomeEcommerce: 'Amazon' }, marcadores: [] }
      };
      return res.end(JSON.stringify({ retorno: { status: 'OK', pedido: details[id] } }));
    });
  });

  await new Promise(resolve => mockTiny.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => mockTiny.close(resolve)));

  const tinyEndpoint = `http://127.0.0.1:${mockTiny.address().port}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '0',
      DISABLE_AUTO_UPDATE: '1',
      READ_ONLY_PREVIEW: '0',
      SNAPSHOTS_FILE: snapshotsFile,
      SQLITE_FILE: sqliteFile,
      DETAIL_CACHE_FILE: cacheFile,
      DAILY_STATE_FILE: dailyStateFile,
      GOAL_REVEAL_STATE_FILE: revealStateFile,
      TINY_PESQUISA_ENDPOINT: `${tinyEndpoint}/pesquisa`,
      TINY_OBTER_ENDPOINT: `${tinyEndpoint}/obter`,
      TINY_OFICIAL_TOKEN: 'tok_of',
      TINY_PRIORIZA_TOKEN: 'tok_pr',
      TINY_OFICIALSP_TOKEN: 'tok_sp1',
      TINY_OFICIALSP2_TOKEN: 'tok_sp2',
      TINY_DETAIL_DELAY_MS: '0'
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

  // 1. Below 700k (695.000): old 690k revealed state is ignored, normal updates continue
  const preRes = await fetch(`${baseUrl}/api/update-data?mode=full`);
  assert.equal(preRes.status, 200);
  const preBody = await preRes.json();
  assert.equal(preBody.metrics.totalGmv, 695000);
  assert.equal(preBody.goalReveal.locked, false);
  assert.equal(preBody.goalReveal.revealed, false);

  // 2. Crosses 700k (705.000 < 717.684): locks at 695.000, canReveal=true, goalReached=false (not green yet)
  phase = 'above_700k';
  const lockedRes = await fetch(`${baseUrl}/api/update-data?mode=full`);
  assert.equal(lockedRes.status, 200);
  const lockedBody = await lockedRes.json();
  assert.equal(lockedBody.metrics.totalGmv, 695000);
  assert.equal(lockedBody.goalReveal.locked, true);
  assert.equal(lockedBody.goalReveal.canReveal, true);
  assert.equal(lockedBody.goalReveal.goalReached, false);

  // 3. Crosses daily goal (740.000 >= 717.684): still locked at 695.000, goalReached=true (button turns green)
  phase = 'goal_reached';
  const goalRes = await fetch(`${baseUrl}/api/update-data?mode=full`);
  assert.equal(goalRes.status, 200);
  const goalBody = await goalRes.json();
  assert.equal(goalBody.metrics.totalGmv, 695000);
  assert.equal(goalBody.goalReveal.locked, true);
  assert.equal(goalBody.goalReveal.canReveal, true);
  assert.equal(goalBody.goalReveal.goalReached, true);

  // 4. Click reveal button -> unlocks to 740.000 with goalReachedAt exposed
  const revealRes = await fetch(`${baseUrl}/api/goal-reveal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-11-27' })
  });
  assert.equal(revealRes.status, 200);
  const revealBody = await revealRes.json();
  assert.equal(revealBody.ok, true);
  assert.equal(revealBody.metrics.totalGmv, 740000);
  assert.equal(revealBody.goalReveal.locked, false);
  assert.equal(revealBody.goalReveal.revealed, true);
  assert.ok(revealBody.goalReachedAt.Consolidado);
});
