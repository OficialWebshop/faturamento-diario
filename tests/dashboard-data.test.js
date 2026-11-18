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
test('Oficial hourly chart uses company snapshots and excludes Prioriza',()=>{
  const history = [
    {slot:'08:00',business:[{empresa:'Oficial',canal:'Meli',gmv:80},{empresa:'Prioriza',canal:'Meli',gmv:30}]},
    {slot:'08:30',business:[{empresa:'Oficial',canal:'Meli',gmv:100},{empresa:'Prioriza',canal:'Meli',gmv:50}]},
    {slot:'18:00',business:[{empresa:'Oficial',canal:'Meli',gmv:100},{empresa:'Oficial',canal:'Amazon',gmv:50},{empresa:'Prioriza',canal:'Meli',gmv:50}]}
  ];
  const result=normalize({...payload,snapshotHistory:history});
  const official=result.views.find(view=>view.scope==='Oficial');
  assert.equal(official.hourlyUnavailable,undefined);
  assert.equal(official.series.find(row=>row.channel==='Meli').hours[8].value,100);
  assert.equal(official.series.find(row=>row.channel==='Amazon').hours[18].value,50);
  assert.equal(official.series.flatMap(row=>row.hours).reduce((sum,point)=>sum+point.value,0),150);
  assert.deepEqual(official.previousChannels,{Meli:100});
  // Verify the actual server response carries the saved company history.
  const server=fs.readFileSync('server.js','utf8');
  const build=server.slice(server.indexOf('function buildPayload(all)'),server.indexOf('function hasFullDetail'));
  const context=vm.createContext({brDate:()=>payload.dataDate,num:Number,getDailyTargetValue:()=>0,SOURCE_LABEL:'test',slotKey:()=>'',snapshots:history.map((row,i)=>({...row,dataDate:payload.dataDate,at:`2026-11-17T${String(11+i).padStart(2,'0')}:00:00Z`,channels:{Meli:100},orders:{Meli:1}}))});
  vm.runInContext(build,context);
  assert.equal(vm.runInContext('buildPayload(snapshots).snapshotHistory[0].business[0].gmv',context),80);
});
test('Full and Prioriza hourly charts use their own snapshot values',()=>{
  const snapshotHistory = [
    {slot:'08:00',business:[
      {empresa:'Oficial',canal:'Amazon',gmv:300,fullGmv:40},
      {empresa:'OFICIALSP',canal:'Shopee',gmv:20},
      {empresa:'OFICIALSP2',canal:'Meli',gmv:10},
      {empresa:'Prioriza',canal:'Shopee',gmv:30,fullGmv:30}
    ]},
    {slot:'09:30',business:[
      {empresa:'Oficial',canal:'Amazon',gmv:500,fullGmv:70},
      {empresa:'OFICIALSP',canal:'Shopee',gmv:45},
      {empresa:'OFICIALSP2',canal:'Meli',gmv:15},
      {empresa:'Prioriza',canal:'Shopee',gmv:80,fullGmv:80}
    ]}
  ];
  const views=normalize({...payload,snapshotHistory}).views;
  const full=views.find(view=>view.scope==='Full'),prioriza=views.find(view=>view.scope==='Prioriza');
  assert.equal(full.hourlyUnavailable,undefined);
  assert.equal(prioriza.hourlyUnavailable,undefined);
  const totalAt=(view,hour)=>view.series.reduce((sum,row)=>sum+row.hours[hour].value,0);
  assert.equal(totalAt(full,8),70);
  assert.equal(totalAt(full,9),60);
  assert.equal(totalAt(prioriza,8),30);
  assert.equal(totalAt(prioriza,9),50);
  assert.equal(full.series.find(row=>row.channel==='Amazon').hours[9].value,30);
});

test('actual frontend consumes legacy response and displays executive KPIs and morning history',async()=>{
  const html=fs.readFileSync('site/dist/index.html','utf8');
  const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>['#'+m[1],{
    textContent:'',innerHTML:'',value:'all',style:{},classList:{add(){},remove(){},toggle(){}},setAttribute(){},listeners:{},addEventListener(type,callback){this.listeners[type]=callback}
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
  assert.match(html,/data-scope="Full"/);
  assert.doesNotMatch(html,/scopeCountdown/);
  for(const name of ['Oficial','Prioriza','OFICIALSP','OFICIALSP2'])assert(elements.get('#analyticCompany').innerHTML.includes(name));
  vm.runInContext("applyScope('Prioriza')",context);
  assert.equal(elements.get('#totalGMV').textContent,'R$ 50');
  await vm.runInContext('loadBigQuery(false)',context);
  assert.equal(vm.runInContext('activeScope',context),'Prioriza');
  vm.runInContext("applyScope('Consolidado'); selectedDate='2026-11-18'; todayDate='';",context);
  const RealDate=Date;
  context.Date=class extends RealDate{constructor(...args){super(...(args.length?args:['2026-11-18T17:15:00Z']))}};
  vm.runInContext('renderChart()',context);
  assert.match(elements.get('#hourlyChart').innerHTML,/14h/);
  assert.doesNotMatch(elements.get('#hourlyChart').innerHTML,/15h|23h/);
  context.Date=class extends RealDate{constructor(...args){super(...(args.length?args:['2026-11-18T18:01:00Z']))}};
  vm.runInContext('renderChart()',context);
  assert.match(elements.get('#hourlyChart').innerHTML,/15h/);
  assert.doesNotMatch(elements.get('#hourlyChart').innerHTML,/16h/);
  context.document.documentElement={clientWidth:375,clientHeight:667};
  const page=vm.runInContext("pageRows(Array.from({length:419},(_,i)=>i),'analytic')",context);
  assert.equal(page.rows.length,1);
  assert.equal(elements.get('#analyticNext').disabled,false);
  for(const availableHeight of [176,220,352]){
    elements.get('#ranking').clientHeight=availableHeight;
    const result=vm.runInContext("pageRows(Array.from({length:30},(_,i)=>i),'rank')",context);
    assert(result.rows.length*44<=availableHeight);
    assert.equal(result.rows.length,Math.floor(availableHeight/44));
  }
  const chart=elements.get('#hourlyChart');
  chart.listeners.click({target:{closest:()=>({dataset:{hourIndex:'8'}})}});
  assert.match(elements.get('#chartLegend').textContent,/08h.*Consolidado.*100,00/);
  vm.runInContext("activeChannel='Amazon'; renderChart()",context);
  assert.match(elements.get('#chartLegend').textContent,/08h.*Amazon.*0,00/);
  let prevented=false;
  chart.listeners.keydown({key:'Enter',preventDefault(){prevented=true},target:{closest:()=>({dataset:{hourIndex:'18'}})}});
  assert(prevented);
  // An unavailable future hour cannot overwrite the selected hour.
  assert.match(elements.get('#chartLegend').textContent,/08h/);
  vm.runInContext("activeChannel='all';renderChart()",context);
  assert.match(elements.get('#hourlyChart').innerHTML,/data-hour-index="8" role="button" tabindex="0"/);

});
