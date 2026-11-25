(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.FINANCIAL_REPORT=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const statuses=new Set(['FATURADO','APROVADO','PREPARANDO PARA ENVIO','ENVIADO','ENTREGUE','PRONTO PARA ENVIO','DADOS INCOMPLETOS','NAO ENTREGUE']);
  function financialSale(order){
    let status=String(order?.situacao || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toUpperCase();
    if(status==='PREPARANDO ENVIO')status='PREPARANDO PARA ENVIO';
    return statuses.has(status);
  }
  function summarize(analytics){
    const selected=analytics.filter(financialSale).map(row=>({...row,contabilizado:true}));
    const channels={},orders={},companies=new Map();
    for(const row of selected){
      const value=Number(row.valor || 0),key=JSON.stringify([row.empresa,row.canal]);
      channels[row.canal]=(channels[row.canal] || 0)+value;
      orders[row.canal]=(orders[row.canal] || 0)+1;
      if(!companies.has(key))companies.set(key,{empresa:row.empresa,canal:row.canal,gmv:0,pedidos:0,fullGmv:0});
      const company=companies.get(key);company.gmv+=value;company.pedidos++;
      if(row.fulfillment)company.fullGmv+=value;
    }
    return {channels,orders,business:[...companies.values()],analytics:selected};
  }
  function projectSnapshot(snapshot){
    if(snapshot.financial)return {...snapshot,...snapshot.financial,goalReached:snapshot.financial.goalReached};
    if(Array.isArray(snapshot.analytics))return {...snapshot,...summarize(snapshot.analytics),goalReached:undefined};
    return null;
  }
  // Compatibility for an API response that has not yet exposed financial snapshots.
  function fromPayload(payload){
    if(payload.financial)return payload.financial;
    const snapshot={...summarize(payload.analytics || []),at:payload.updatedAt,dataDate:payload.dataDate};
    const valid=Number.isFinite(new Date(snapshot.at).getTime());
    const slot=valid?new Intl.DateTimeFormat('en-GB',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(snapshot.at)):null;
    const totalGmv=Object.values(snapshot.channels).reduce((sum,value)=>sum+value,0),totalOrders=snapshot.analytics.length;
    return {dataDate:payload.dataDate,target:payload.target,updatedAt:payload.updatedAt,accounts:payload.accounts || [],
      currentChannels:snapshot.channels,previousChannels:{},business:snapshot.business,analytics:snapshot.analytics,
      series:valid?Object.entries(snapshot.channels).map(([channel,value])=>({channel,hours:[{hour:slot,value}]})):[],
      snapshotHistory:valid?[{at:snapshot.at,slot,gmv:totalGmv,business:snapshot.business,isBaseline:true}]:[],
      metrics:{totalGmv,totalOrders,ticket:totalOrders?totalGmv/totalOrders:0,hourIsReconciled:true}};
  }
  return {financialSale,summarize,projectSnapshot,fromPayload};
});
