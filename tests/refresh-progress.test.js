const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('manual refresh shows queue progress and stops spinning after asynchronous completion or failure', async () => {
  const app = fs.readFileSync('site/dist/app.js', 'utf8');
  const start = app.indexOf('function startRefreshProgress(');
  const end = app.indexOf("document.querySelector('#dashboardDate').addEventListener", start);
  const nodes = new Map();
  for (const id of ['refreshBtn', 'refreshProgress', 'refreshProgressBar', 'refreshProgressLabel']) {
    const classes = new Set();
    nodes.set('#' + id, { hidden: true, disabled: false, value: 0, textContent: '',
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      addEventListener(type, callback) { this[type] = callback; } });
  }
  let poll, resolveUpdate, cleared = 0;
  const messages = [];
  const context = vm.createContext({
    selectedDate: '2026-11-24', todayDate: '2026-11-26',
    document: { querySelector: selector => nodes.get(selector) },
    setInterval: callback => { poll = callback; return 1; }, clearInterval: () => { cleared++; },
    fetch: async url => url === '/api/queue'
      ? { ok: true, json: async () => ({ status: 'running', accounts: [
        { status: 'completed' }, { status: 'enriching', processedOrders: 1, foundOrders: 2 },
        { status: 'pending' }, { status: 'pending' }
      ] }) }
      : new Promise(resolve => { resolveUpdate = resolve; }),
    loadBigQuery: async () => true,
    toast: message => messages.push(message)
  });
  vm.runInContext(app.slice(start, end), context);
  const button = nodes.get('#refreshBtn');
  const event = { currentTarget: button };
  const update = button.click(event);
  event.currentTarget = null; // Native click events clear currentTarget after dispatch.
  assert.equal(button.disabled, true);
  assert.equal(button.classList.contains('loading'), true);
  assert.equal(nodes.get('#refreshProgress').hidden, false);
  await poll();
  assert.equal(nodes.get('#refreshProgressBar').value, 35);
  assert.match(nodes.get('#refreshProgressLabel').textContent, /Faltam 65%/);
  resolveUpdate({ ok: true, status: 200 });
  await update;
  assert.equal(nodes.get('#refreshProgressBar').value, 100);
  assert.match(nodes.get('#refreshProgressLabel').textContent, /Carregamento concluído/);
  assert.equal(button.classList.contains('loading'), false);
  assert.equal(button.disabled, false);
  assert.equal(cleared, 1);
  await poll();
  assert.equal(nodes.get('#refreshProgressBar').value, 100, 'late polling cannot overwrite completion');
  const failure = button.click({ currentTarget: button });
  resolveUpdate({ ok: false, json: async () => ({ error: 'Tiny indisponível' }) });
  await failure;
  assert.match(nodes.get('#refreshProgressLabel').textContent, /Falha/);
  assert.equal(button.classList.contains('loading'), false);
  assert.equal(button.disabled, false);
  assert.match(messages.at(-1), /Tiny indisponível/);
});
