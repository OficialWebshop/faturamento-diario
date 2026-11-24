const test=require('node:test');
const assert=require('node:assert/strict');
const {dayComparison,retainDayClosings}=require('../site/dist/dashboard-data');
const snapshot=(date,hour,official,prioriza)=>({dataDate:date,at:`${date}T${hour}:00-03:00`,channels:{Meli:official+prioriza},business:[{empresa:'Oficial',canal:'Meli',gmv:official,fullGmv:10},{empresa:'Prioriza',canal:'Meli',gmv:prioriza}]});
test('GMV comparison uses the latest snapshot of exactly the previous calendar day per operation',()=>{
  const history=[snapshot('2026-11-23','17:00',500,100),snapshot('2026-11-23','23:59',1000,200),snapshot('2026-11-24','17:00',1500,300)];
  const comparison=dayComparison(history,'2026-11-24');
  assert.equal(comparison.previousDayDate,'2026-11-23');
  assert.equal(comparison.byScope.Consolidado.previousDayGmv,1200);
  assert.equal(comparison.byScope.Oficial.previousDayGmv,1000);
  assert.equal(comparison.byScope.Prioriza.previousDayGmv,200);
  assert.equal(comparison.byScope.Full.previousDayGmv,10);
});
test('missing previous day is not replaced with another day or a zero percentage',()=>{
  const missing=dayComparison([snapshot('2026-11-22','23:59',1000,200)],'2026-11-24');
  assert.equal(missing.byScope.Consolidado.previousDayGmv,null);
  assert.equal(dayComparison([],'2026-03-01').previousDayDate,'2026-02-28');
});
test('day rollover retains one closing per previous day and all current snapshots',()=>{
  const saved=[snapshot('2026-11-23','17:00',500,100),snapshot('2026-11-23','23:59',1000,200),snapshot('2026-11-24','10:00',200,30)];
  const current=[saved[2],snapshot('2026-11-24','10:30',300,50)];
  const retained=retainDayClosings(saved,'2026-11-24',current);
  assert.equal(retained.length,3);
  assert.equal(retained[0].at,'2026-11-23T23:59:00-03:00');
  assert.equal(dayComparison(retained,'2026-11-24').byScope.Consolidado.previousDayGmv,1200);
  const next=retainDayClosings(retained,'2026-11-25',[snapshot('2026-11-25','00:05',10,1)]);
  assert.equal(dayComparison(next,'2026-11-25').byScope.Consolidado.previousDayGmv,350);
});
