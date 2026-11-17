const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {normalize} = require('../site/dist/dashboard-data');

const payload = {
  dataDate:'2026-11-17', target:262832, updatedAt:'2026-11-17T21:00:00Z',
  currentChannels:{Meli:150,Amazon:50}, previousChannels:{Meli:100},
  metrics:{totalGmv:200,totalOrders:3,ticket:200/3},
  series:[{channel:'Meli',hours:[{hour:'08:00',value:80},{hour:'08:30',value:20},{hour:'18:00',value:50}]},
    {channel:'Amazon',hours:[{hour:'18:00',value:50}]}],
  snapshotHistory:[{slot:'08:00',gmv:80},{slot:'08:30',gmv:100},{slot:'18:00',gmv:200}],
  analytics:[
    {empresa:'Oficial',canal:'Meli',valor:100,contabilizado:true},
    {empresa:'Prioriza',canal:'Meli',valor:50,contabilizado:true},
    {empresa:'Oficial',canal:'Amazon',valor:50,fulfillment:true,contabilizado:true},
    {empresa:'Prioriza',canal:'Meli',valor:900,contabilizado:false}
  ]
};
test('legacy API restores totals, operations and all earlier captures in correct hours',()=>{
  const result=normalize(payload);
  assert.equal(result.views.length,4);
  assert.equal(result.management.find(r=>r.grupo==='Consolidado').gmv,200);
  assert.equal(result.management.find(r=>r.grupo==='Oficial').gmv,150);
  assert.equal(result.management.find(r=>r.grupo==='Full Oficial').gmv,50);
  assert.equal(result.management.find(r=>r.grupo==='Oficial Core').gmv,100);
  assert.equal(result.management.find(r=>r.grupo==='Prioriza').gmv,50);
  assert.equal(result.series[0].hours.length,24);
  assert.equal(result.series[0].hours[8].value,100);
  assert.equal(result.series[0].hours[18].value,50);
  assert.equal(result.series.flatMap(r=>r.hours).reduce((s,p)=>s+p.value,0),200);
  assert.equal(result.metrics.activeHour,18);
  assert(result.views.find(v=>v.scope==='Full').hourlyUnavailable);
});
test('modern views pass through and empty payloads stay empty',()=>{
  const modern={views:[{scope:'Consolidado'}]};
  assert.equal(normalize(modern),modern);
  assert.deepEqual(normalize({}).views[0].series,[]);
});
test('actual frontend consumes legacy response and displays executive KPIs and morning history',async()=>{
  const html=fs.readFileSync('site/dist/index.html','utf8');
  const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>['#'+m[1],{
    textContent:'',innerHTML:'',value:'all',style:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){}
  }]));
  const health={classList:{toggle(){}},querySelector:()=>({textContent:''})};
  const context=vm.createContext({Intl,Date,console,document:{body:{classList:{toggle(){}}},
    querySelector:s=>s==='.stream-health'?health:elements.get(s)||null,querySelectorAll:()=>[]
  },setInterval(){},setTimeout(){},fetch:async()=>({ok:true,json:async()=>payload})});
  vm.runInContext(fs.readFileSync('site/dist/dashboard-data.js','utf8'),context);
  vm.runInContext(fs.readFileSync('site/dist/app.js','utf8'),context);
  assert.equal(await vm.runInContext('loadBigQuery(false)',context),true);
  assert.equal(elements.get('#totalGMV').textContent,'R$ 200');
  assert.equal(elements.get('#ordersKpi').textContent,'3');
  assert.equal(elements.get('#consolidatedGmv').textContent,'R$ 200');
  assert.match(elements.get('#targetLabel').textContent,/262.832/);
  assert.match(elements.get('#ranking').innerHTML,/Meli/);
  assert.match(elements.get('#hourlyChart').innerHTML,/08h: R\$\s*100/);
  assert.equal(vm.runInContext('hours.length',context),24);
  await vm.runInContext('loadBigQuery(false)',context);
  assert.equal(vm.runInContext('activeScope',context),'Consolidado');
  assert.equal(elements.get('#totalGMV').textContent,'R$ 200');
  assert.doesNotMatch(html,/scope-carousel|scopeCountdown|data-scope=/);
});
