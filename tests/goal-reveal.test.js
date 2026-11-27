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

test('goal reveal lock is strictly restricted to today 2026-11-27', () => {
  assert.equal(TARGET_27_11, 717684);
  assert.equal(goalReveal.isGoalRevealActive('2026-11-27', '2026-11-27'), true);
  assert.equal(goalReveal.isGoalRevealActive('2026-11-26', '2026-11-27'), false);
  assert.equal(goalReveal.isGoalRevealActive('2026-11-27', '2026-11-28'), false);
  assert.equal(goalReveal.isGoalRevealActive('2026-11-28', '2026-11-28'), false);

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
  assert.equal(nextDayViewing27.goalReveal.canReveal, false);
  assert.equal(goalReveal.snapshotTotalGmv(nextDayViewing27.snapshotsForPayload.at(-1)), 750000);

  const overTarget26 = [makeSnapshot('2026-11-26', '18:00', 400000)];
  const viewing26On27 = goalReveal.resolveGoalReveal(overTarget26, {
    requestedDate: '2026-11-26',
    todayDate: '2026-11-27',
    target: getDailyTargetValue('2026-11-26'),
    state: null,
    summarizeFinancial
  });
  assert.equal(viewing26On27.goalReveal.enabled, false);
  assert.equal(viewing26On27.goalReveal.locked, false);
  assert.equal(goalReveal.snapshotTotalGmv(viewing26On27.snapshotsForPayload.at(-1)), 400000);
});

test('locks dashboard to last pre-goal snapshot on 2026-11-27, handles cancellation drop, and unlocks on reveal', () => {
  const prevDay = makeSnapshot('2026-11-26', '23:30', 320000);
  const s1 = makeSnapshot('2026-11-27', '17:30', 690000);
  const s2 = makeSnapshot('2026-11-27', '18:00', 712500);

  // 1. Pre-goal: records pre-goal snapshots and stays unlocked/disabled
  let state = goalReveal.createEmptyGoalRevealState('2026-11-27');
  let res = goalReveal.resolveGoalReveal([prevDay, s1, s2], {
    requestedDate: '2026-11-27',
    todayDate: '2026-11-27',
    target: TARGET_27_11,
    state,
    summarizeFinancial
  });
  assert.equal(res.goalReveal.enabled, true);
  assert.equal(res.goalReveal.goalReached, false);
  assert.equal(res.goalReveal.locked, false);
  assert.equal(res.goalReveal.canReveal, false);
  assert.equal(res.stateChanged, true);
  state = res.nextState;
  assert.equal(goalReveal.snapshotTotalGmv(res.snapshotsForPayload.at(-1)), 712500);

  // 2. Goal crossed in same slot (18:00 overwritten to 725000): locks at 712500 and enables reveal button
  const s2Crossed = makeSnapshot('2026-11-27', '18:00', 725000, { reachedAt: '2026-11-27T18:10:00-03:00' });
  res = goalReveal.resolveGoalReveal([prevDay, s1, s2Crossed], {
    requestedDate: '2026-11-27',
    todayDate: '2026-11-27',
    target: TARGET_27_11,
    state,
    summarizeFinancial
  });
  assert.equal(res.goalReveal.enabled, true);
  assert.equal(res.goalReveal.goalReached, true);
  assert.equal(res.goalReveal.locked, true);
  assert.equal(res.goalReveal.canReveal, true);
  assert.equal(res.goalReveal.revealed, false);
  const frozenDay = res.snapshotsForPayload.filter(s => s.dataDate === '2026-11-27');
  const frozenPrev = res.snapshotsForPayload.filter(s => s.dataDate === '2026-11-26');
  assert.equal(frozenPrev.length, 1, 'preserves previous-day closing for comparison');
  assert.equal(goalReveal.snapshotTotalGmv(frozenDay.at(-1)), 712500);
  assert.equal(frozenDay.at(-1).goalReached, undefined);

  // 3. Real GMV drops back below target due to cancellation before reveal: reverts to unlocked pre-goal
  const s2Cancelled = makeSnapshot('2026-11-27', '18:00', 710000);
  res = goalReveal.resolveGoalReveal([prevDay, s1, s2Cancelled], {
    requestedDate: '2026-11-27',
    todayDate: '2026-11-27',
    target: TARGET_27_11,
    state,
    summarizeFinancial
  });
  assert.equal(res.goalReveal.locked, false);
  assert.equal(res.goalReveal.canReveal, false);
  assert.equal(goalReveal.snapshotTotalGmv(res.snapshotsForPayload.at(-1)), 710000);
  state = res.nextState;

  // 4. Crosses target again (740000): locks at 710000 and enables button
  const s3Crossed = makeSnapshot('2026-11-27', '18:30', 740000, { reachedAt: '2026-11-27T18:30:00-03:00' });
  res = goalReveal.resolveGoalReveal([prevDay, s1, s2Cancelled, s3Crossed], {
    requestedDate: '2026-11-27',
    todayDate: '2026-11-27',
    target: TARGET_27_11,
    state,
    summarizeFinancial
  });
  assert.equal(res.goalReveal.locked, true);
  assert.equal(res.goalReveal.canReveal, true);
  assert.equal(goalReveal.snapshotTotalGmv(res.snapshotsForPayload.filter(s => s.dataDate === '2026-11-27').at(-1)), 710000);

  // 5. After reveal button is clicked: unlocks and returns real 740000 with goalReached preserved
  state = { ...state, revealed: true, revealedAt: '2026-11-27T21:35:00.000Z' };
  res = goalReveal.resolveGoalReveal([prevDay, s1, s2Cancelled, s3Crossed], {
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
  assert.equal(goalReveal.snapshotTotalGmv(unlockedDay.at(-1)), 740000);
  assert.equal(unlockedDay.at(-1).goalReached.reachedAt.Consolidado, '2026-11-27T18:30:00-03:00');
});

test('fallbacks stay strictly below target when no saved pre-goal state existed yet', () => {
  // Subcase A: earlier slot in history is below target
  const earlier = makeSnapshot('2026-11-27', '17:30', 680000, { withAnalytics: false });
  const crossed = makeSnapshot('2026-11-27', '18:00', 735000, { reachedAt: '2026-11-27T18:00:00-03:00' });
  const fromHistory = goalReveal.resolveGoalReveal([earlier, crossed], {
    requestedDate: '2026-11-27',
    todayDate: '2026-11-27',
    target: TARGET_27_11,
    state: null,
    summarizeFinancial
  });
  assert.equal(fromHistory.goalReveal.locked, true);
  assert.equal(fromHistory.stateChanged, true);
  assert.equal(goalReveal.snapshotTotalGmv(fromHistory.snapshotsForPayload.at(-1)), 680000);

  // Subcase B: only a single already-crossed snapshot with analytics
  const singleWithAnalytics = {
    dataDate: '2026-11-27',
    slot: '18:00',
    at: '2026-11-27T18:00:00-03:00',
    channels: { Meli: 500000, Shopee: 240000 },
    orders: { Meli: 2, Shopee: 2 },
    business: [
      { empresa: 'Oficial', canal: 'Meli', gmv: 500000, pedidos: 2 },
      { empresa: 'Prioriza', canal: 'Shopee', gmv: 240000, pedidos: 2 }
    ],
    analytics: [
      { pedido: '1', empresa: 'Oficial', canal: 'Meli', valor: 400000, situacao: 'Faturado', contabilizado: true },
      { pedido: '2', empresa: 'Prioriza', canal: 'Shopee', valor: 200000, situacao: 'Faturado', contabilizado: true },
      { pedido: '3', empresa: 'Oficial', canal: 'Meli', valor: 100000, situacao: 'Faturado', contabilizado: true },
      { pedido: '4', empresa: 'Prioriza', canal: 'Shopee', valor: 40000, situacao: 'Faturado', contabilizado: true }
    ]
  };
  const syntheticAnalytics = goalReveal.resolveGoalReveal([singleWithAnalytics], {
    requestedDate: '2026-11-27',
    todayDate: '2026-11-27',
    target: TARGET_27_11,
    state: null,
    summarizeFinancial
  });
  assert.equal(syntheticAnalytics.goalReveal.locked, true);
  const synGmv = goalReveal.snapshotTotalGmv(syntheticAnalytics.snapshotsForPayload.at(-1));
  assert.ok(synGmv > 0 && synGmv < TARGET_27_11, `expected synthetic GMV below target, got ${synGmv}`);

  // Subcase C: only a single already-crossed legacy snapshot without analytics
  const singleLegacy = makeSnapshot('2026-11-27', '18:00', 740000, { withAnalytics: false });
  const syntheticLegacy = goalReveal.resolveGoalReveal([singleLegacy], {
    requestedDate: '2026-11-27',
    todayDate: '2026-11-27',
    target: TARGET_27_11,
    state: null,
    summarizeFinancial
  });
  const synLegacyGmv = goalReveal.snapshotTotalGmv(syntheticLegacy.snapshotsForPayload.at(-1));
  assert.ok(synLegacyGmv > 0 && synLegacyGmv < TARGET_27_11, `expected scaled legacy GMV below target, got ${synLegacyGmv}`);
});

test('frontend replaces Importar base on 27/11, unlocks button on goal hit, and reveals achieved goal on click', async () => {
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

  let nextApiResponse = makePayload('2026-11-27', '2026-11-27', 712500, {
    enabled: true, date: '2026-11-27', target: TARGET_27_11, goalReached: false, locked: false, revealed: false, revealedAt: null, canReveal: false
  });
  const revealResponse = makePayload('2026-11-27', '2026-11-27', 730000, {
    enabled: true, date: '2026-11-27', target: TARGET_27_11, goalReached: true, locked: false, revealed: true, revealedAt: '2026-11-27T21:20:00.000Z', canReveal: false
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

  // 1. Pre-goal on 27/11: Importar base hidden, reveal button visible & disabled
  assert.equal(await vm.runInContext('loadBigQuery(false)', context), true);
  const uploadBtn = elements.get('#uploadBaseBtn');
  const revealBtn = elements.get('#goalRevealBtn');
  const revealLabel = elements.get('#goalRevealLabel');
  assert.equal(uploadBtn.hidden, true);
  assert.equal(revealBtn.hidden, false);
  assert.equal(revealBtn.disabled, true);
  assert.equal(revealLabel.textContent, 'Aguardando meta');
  assert.equal(elements.get('#totalGMV').textContent, 'R$ 712.500');
  assert.equal(elements.get('#targetValue').textContent, '99.3%');
  assert.match(elements.get('#targetGap').textContent, /Faltam/);

  // 2. Goal reached while locked: values stay at 712.500, button unlocks and highlights
  nextApiResponse = makePayload('2026-11-27', '2026-11-27', 712500, {
    enabled: true, date: '2026-11-27', target: TARGET_27_11, goalReached: true, locked: true, revealed: false, revealedAt: null, canReveal: true
  });
  await vm.runInContext('loadBigQuery(false)', context);
  assert.equal(uploadBtn.hidden, true);
  assert.equal(revealBtn.hidden, false);
  assert.equal(revealBtn.disabled, false);
  assert.equal(revealBtn.classList.contains('ready'), true);
  assert.equal(revealLabel.textContent, 'Mostrar meta batida');
  assert.equal(elements.get('#totalGMV').textContent, 'R$ 712.500');
  assert.equal(elements.get('#targetValue').style.color, '');

  // 3. Click button: posts /api/goal-reveal, updates dashboard to achieved goal, marks revealed
  await revealBtn.listeners.click();
  assert.deepEqual(revealRequest, {
    url: '/api/goal-reveal',
    method: 'POST',
    body: { date: '2026-11-27' }
  });
  assert.equal(elements.get('#totalGMV').textContent, 'R$ 730.000');
  assert.equal(elements.get('#targetValue').textContent, '101.7%');
  assert.equal(elements.get('#targetValue').style.color, 'var(--green)');
  assert.match(elements.get('#targetGap').textContent, /Meta batida às 18:10.*Valor acima da meta: R\$\s*12\.316/);
  assert.equal(revealBtn.disabled, true);
  assert.equal(revealBtn.classList.contains('ready'), false);
  assert.equal(revealBtn.classList.contains('revealed'), true);
  assert.equal(revealLabel.textContent, 'Meta batida!');
  assert.equal(elements.get('#toast').textContent, 'Meta diária batida revelada!');

  // 4. Outside 27/11 (e.g., viewing 26/11 or next day 28/11): Importar base returns, reveal button hides
  nextApiResponse = makePayload('2026-11-26', '2026-11-27', 350000, {
    enabled: false, date: '2026-11-27', target: getDailyTargetValue('2026-11-26'), goalReached: false, locked: false, revealed: false, revealedAt: null, canReveal: false
  });
  await vm.runInContext('loadBigQuery(false)', context);
  assert.equal(uploadBtn.hidden, false);
  assert.equal(revealBtn.hidden, true);
});

test('HTTP server locks values on 2026-11-27 when Tiny sync crosses target and unlocks via POST /api/goal-reveal', async t => {
  if (brDateIso() !== '2026-11-27') return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-goal-reveal-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const snapshotsFile = path.join(tmpDir, 'snapshots.json');
  const sqliteFile = path.join(tmpDir, 'dashboard.sqlite');
  const cacheFile = path.join(tmpDir, 'cache.json');
  const dailyStateFile = path.join(tmpDir, 'daily-orders-state.json');
  const revealStateFile = path.join(tmpDir, 'goal-reveal-state.json');

  let phase = 'before_goal';
  const mockTiny = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const token = params.get('token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/pesquisa') {
        if (token === 'tok_of') {
          const pedidos = phase === 'before_goal'
            ? [{ pedido: { id: '1', numero: '1001', data_pedido: '27/11/2026', situacao: 'Faturado', valor: '710000.00' } }]
            : [
                { pedido: { id: '1', numero: '1001', data_pedido: '27/11/2026', situacao: 'Faturado', valor: '710000.00' } },
                { pedido: { id: '2', numero: '1002', data_pedido: '27/11/2026', situacao: 'Faturado', valor: '25000.00' } }
              ];
          return res.end(JSON.stringify({ retorno: { status: 'OK', numero_paginas: 1, pedidos } }));
        }
        return res.end(JSON.stringify({ retorno: { status: 'Erro', codigo_erro: 20, erros: [{ erro: 'A consulta não retornou registros' }] } }));
      }
      const id = params.get('id');
      const details = {
        '1': { id: '1', numero: '1001', data_pedido: '27/11/2026', situacao: 'Faturado', total_pedido: '710000.00', ecommerce: { nomeEcommerce: 'Mercado Livre' }, marcadores: [] },
        '2': { id: '2', numero: '1002', data_pedido: '27/11/2026', situacao: 'Faturado', total_pedido: '25000.00', ecommerce: { nomeEcommerce: 'Shopee' }, marcadores: [] }
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

  // 1. Pre-goal update: 710.000 < 717.684
  const preRes = await fetch(`${baseUrl}/api/update-data?mode=full`);
  assert.equal(preRes.status, 200);
  const preBody = await preRes.json();
  assert.equal(preBody.metrics.totalGmv, 710000);
  assert.equal(preBody.goalReveal.enabled, true);
  assert.equal(preBody.goalReveal.locked, false);
  assert.equal(preBody.goalReveal.canReveal, false);

  // Attempting to reveal before hitting goal must return 409
  const earlyReveal = await fetch(`${baseUrl}/api/goal-reveal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-11-27' })
  });
  assert.equal(earlyReveal.status, 409);

  // 2. Goal crossed (735.000 >= 717.684): both /api/update-data and /api/data stay locked at 710.000
  phase = 'after_goal';
  const crossedRes = await fetch(`${baseUrl}/api/update-data?mode=full`);
  assert.equal(crossedRes.status, 200);
  const crossedBody = await crossedRes.json();
  assert.equal(crossedBody.metrics.totalGmv, 710000);
  assert.equal(crossedBody.goalReveal.locked, true);
  assert.equal(crossedBody.goalReveal.canReveal, true);
  assert.equal(crossedBody.goalReachedAt.Consolidado, undefined);

  const lockedData = await (await fetch(`${baseUrl}/api/data?date=2026-11-27`)).json();
  assert.equal(lockedData.metrics.totalGmv, 710000);
  assert.equal(lockedData.goalReveal.locked, true);
  assert.equal(lockedData.goalReveal.canReveal, true);

  // 3. Click reveal button -> POST /api/goal-reveal returns real 735.000 and unlocks future /api/data calls
  const revealRes = await fetch(`${baseUrl}/api/goal-reveal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-11-27' })
  });
  assert.equal(revealRes.status, 200);
  const revealBody = await revealRes.json();
  assert.equal(revealBody.ok, true);
  assert.equal(revealBody.metrics.totalGmv, 735000);
  assert.equal(revealBody.goalReveal.locked, false);
  assert.equal(revealBody.goalReveal.revealed, true);
  assert.equal(revealBody.goalReveal.canReveal, false);
  assert.ok(revealBody.goalReachedAt.Consolidado, 'real goalReachedAt timestamp is exposed once revealed');

  const afterRevealData = await (await fetch(`${baseUrl}/api/data?date=2026-11-27`)).json();
  assert.equal(afterRevealData.metrics.totalGmv, 735000);
  assert.equal(afterRevealData.goalReveal.revealed, true);
});
