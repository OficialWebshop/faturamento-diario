const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const financial=require('../site/dist/financial-report');
const classifier=require('../site/dist/order-classifier');
const {goalState,dayComparison}=require('../site/dist/dashboard-data');
test('financial statuses are independent of the executive rule',()=>{
  for(const situacao of ['Faturado','Aprovado','Preparando para envio','Enviado','Entregue','Pronto para envio','Dados incompletos','Não entregue'])assert(financial.financialSale({situacao}),situacao);
  assert(financial.financialSale({situacao:' preparando  envio '}));
  for(const situacao of ['Em aberto','Cancelado','Excluído','Reprovado','',null])assert.equal(financial.financialSale({situacao}),false,String(situacao));
  assert(classifier.countableSale({situacao:'Em aberto'}));
  assert.equal(classifier.countableSale({situacao:'Dados incompletos'}),false);
});
function fixture(){
  const row=(pedido,situacao,valor,empresa,canal,fulfillment=false)=>({pedido,situacao,valor,empresa,canal,fulfillment,detalhe:'Completo',contabilizado:classifier.countableSale({situacao})});
  const analytics=[row('open','Em aberto',100,'Oficial','Meli'),row('approved','Aprovado',300,'Oficial','Meli'),row('billed','Faturado',200,'Prioriza','Shopee'),row('incomplete','Dados incompletos',50,'Oficial','Amazon',true),row('undelivered','Não entregue',25,'Oficial','Meli')];
  const earlier={dataDate:'2026-11-25',at:'2026-11-25T15:00:00Z',slot:'12:00',channels:{Meli:200,Shopee:100},orders:{Meli:2,Shopee:1},business:[{empresa:'Oficial',canal:'Meli',gmv:200,pedidos:2},{empresa:'Prioriza',canal:'Shopee',gmv:100,pedidos:1}]};
  earlier.financial=financial.summarize([row('approved','Aprovado',100,'Oficial','Meli'),row('billed','Faturado',100,'Prioriza','Shopee')]);
  const latest={dataDate:'2026-11-25',at:'2026-11-25T17:00:00Z',slot:'14:00',channels:{Meli:400,Shopee:200},orders:{Meli:2,Shopee:1},business:[{empresa:'Oficial',canal:'Meli',gmv:400,pedidos:2},{empresa:'Prioriza',canal:'Shopee',gmv:200,pedidos:1}],analytics,financial:financial.summarize(analytics)};
  return {analytics,earlier,latest};
}
test('financial aggregation includes incomplete and undelivered while excluding open orders',()=>{
  const {analytics}=fixture(),result=financial.summarize(analytics);
  assert.equal(result.analytics.length,4);
  assert.equal(Object.values(result.channels).reduce((s,v)=>s+v,0),575);
  assert.equal(result.channels.Meli,325);
  assert.equal(result.business.find(row=>row.canal==='Amazon').fullGmv,50);
  assert(!result.analytics.some(row=>row.pedido==='open'));
  assert(analytics.find(row=>row.pedido==='incomplete').contabilizado===false);
  assert(result.analytics.every(row=>row.contabilizado));
});
function payload(){
  const {earlier,latest}=fixture(),server=fs.readFileSync('server.js','utf8');
  const build=server.slice(server.indexOf('function buildPayload(all'),server.indexOf('function hasFullDetail'));
  const context=vm.createContext({brDate:()=>latest.dataDate,num:classifier.num,goalState,dayComparison,getDailyTargetValue:()=>1000,SOURCE_LABEL:'test',slotKey:()=>'',financialSnapshot:financial.projectSnapshot,history:[earlier,latest]});
  vm.runInContext(build,context);
  return JSON.parse(vm.runInContext('JSON.stringify(buildPayload(history))',context));
}
test('API provides separate totals and history without changing executive metrics',()=>{
  const result=payload();
  assert.equal(result.metrics.totalGmv,600);
  assert.equal(result.metrics.totalOrders,3);
  assert.equal(result.financial.metrics.totalGmv,575);
  assert.equal(result.financial.metrics.totalOrders,4);
  assert.equal(result.financial.snapshotHistory.length,2);
  assert.equal(result.financial.series.flatMap(row=>row.hours).reduce((s,p)=>s+p.value,0),575);
  assert.equal(result.financial.analytics.some(row=>row.situacao==='Em aberto'),false);
  assert.equal(result.financial.financial,undefined);
});
test('report switches reuse the dashboard and preserve the analytical table and day comparison',async()=>{
  const result=payload();result.comparisons={byScope:{Consolidado:{previousDayGmv:500}}};
  const html=fs.readFileSync('site/dist/index.html','utf8');
  assert.match(html,/data-report="financial">RELATÓRIO FINANCEIRO/);
  const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(match=>['#'+match[1],{textContent:'',innerHTML:'',value:'all',style:{},dataset:{},classList:{add(){},remove(){},toggle(){}},setAttribute(){},open:false,close(){this.open=false},listeners:{},addEventListener(type,fn){this.listeners[type]=fn}}]));
  const health={classList:{toggle(){}},querySelector:()=>({textContent:''})};
  const context=vm.createContext({Intl,Date,console,document:{body:{classList:{toggle(){}}},querySelector:selector=>selector==='.stream-health'?health:nodes.get(selector),querySelectorAll:()=>[]},localStorage:{getItem:()=>null,setItem(){}},setInterval(){},setTimeout(){},fetch:async()=>({ok:true,json:async()=>result})});
  for(const file of ['financial-report.js','dashboard-data.js','app.js'])vm.runInContext(fs.readFileSync('site/dist/'+file,'utf8'),context);
  assert.equal(await vm.runInContext('loadBigQuery()',context),true);
  assert.equal(nodes.get('#totalGMV').textContent,'R$ 600');
  assert.match(nodes.get('#totalDelta').textContent,/20.0% vs. dia anterior/);
  assert.match(nodes.get('#financialDifference').textContent,/-4.2%/);
  vm.runInContext("setReport('financial')",context);
  assert.equal(nodes.get('#totalGMV').textContent,'R$ 575');
  assert.equal(nodes.get('#ordersKpi').textContent,'4');
  assert.equal(nodes.get('#financialDifference').hidden,true);
  assert.equal(vm.runInContext('analyticData.length',context),5);
  vm.runInContext("applyScope('Oficial')",context);
  assert.equal(nodes.get('#totalGMV').textContent,'R$ 375');
  vm.runInContext("applyScope('Full')",context);
  assert.equal(nodes.get('#totalGMV').textContent,'R$ 50');
  vm.runInContext("setReport('executive')",context);
  assert.equal(nodes.get('#totalGMV').textContent,'R$ 0');
  vm.runInContext("applyScope('Consolidado')",context);
  assert.equal(nodes.get('#totalGMV').textContent,'R$ 600');
  assert.match(nodes.get('#totalDelta').textContent,/20.0% vs. dia anterior/);
  assert.equal(nodes.get('#financialDifference').hidden,false);
  vm.runInContext("setReport('financial')",context);
  await vm.runInContext('loadBigQuery()',context);
  assert.equal(nodes.get('#totalGMV').textContent,'R$ 575');
});
