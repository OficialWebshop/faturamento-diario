const test=require('node:test');
const assert=require('node:assert/strict');
const {goalState}=require('../site/dist/dashboard-data');
const date='2026-11-24';
const snapshot=(time,official,prioriza)=>({dataDate:date,at:`2026-11-24T${time}:00-03:00`,channels:{Meli:official+prioriza},business:[{empresa:'Oficial',canal:'Meli',gmv:official},{empresa:'Prioriza',canal:'Meli',gmv:prioriza}]});
test('records the first observed crossing independently per operation',()=>{
  const state=goalState([snapshot('17:00',700,200),snapshot('17:30',800,200),snapshot('17:35',1600,415)],1000,date);
  assert.equal(state.reachedAt.Consolidado,'2026-11-24T17:30:00-03:00');
  assert.equal(state.reachedAt.Oficial,'2026-11-24T17:35:00-03:00');
  assert.equal(state.reachedAt.Prioriza,undefined);
  assert.equal(state.reachedAt.Full,undefined);
});
test('preserves first crossing through snapshot replacement, refreshes and decreases',()=>{
  const first=snapshot('17:31',1200,0);
  const later={...snapshot('17:50',900,0),goalReached:goalState([first],1000,date)};
  const restored=goalState([JSON.parse(JSON.stringify(later))],1000,date);
  assert.equal(restored.reachedAt.Consolidado,first.at);
  const next={...snapshot('18:00',2000,0),goalReached:restored};
  assert.equal(goalState([next],1000,date).reachedAt.Consolidado,first.at);
});
test('goal state resets on another date or another target and never invents a time',()=>{
  const first=snapshot('17:31',1200,0);first.goalReached=goalState([first],1000,date);
  assert.equal(goalState([first],2000,date).reachedAt.Consolidado,undefined);
  assert.deepEqual(goalState([first],1000,'2026-11-25').reachedAt,{});
  assert.deepEqual(goalState([first],0,date).reachedAt,{});
  assert.deepEqual(goalState([{gmv:2000,at:'invalid'}],1000,date).reachedAt,{});
});
test('Full target uses fulfillment values rather than the entire Oficial total',()=>{
  const first={...snapshot('17:30',5000,100),business:[{empresa:'Oficial',canal:'Amazon',gmv:5000,fullGmv:500}]};
  const later={...snapshot('17:45',6000,100),business:[{empresa:'Oficial',canal:'Amazon',gmv:6000,fullGmv:1000}]};
  assert.equal(goalState([first,later],1000,date).reachedAt.Full,later.at);
});
