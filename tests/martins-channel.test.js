const test=require('node:test');
const assert=require('node:assert/strict');
const classifier=require('../site/dist/order-classifier');

test('vendedor Martins é classificado no canal Martins nas formas retornadas pela API',()=>{
  for(const seller of [
    {nome_vendedor:'Martins'},
    {nomeVendedor:'  martins  '},
    {vendedor:{nome:'MARTINS'}},
    {vendedor:{nomeVendedor:'Martins'}},
    {vendedor:'Martins'}
  ]){
    const order={...seller,situacao:'Aprovado',valor:'123.45',ecommerce:{nomeEcommerce:'Mercado Livre'}};
    for(const company of ['Oficial','Prioriza']){
      const row=classifier.analyticRow(order,company,true);
      assert.equal(row.canal,'Martins');
      assert.equal(row.valor,123.45);
      assert.equal(row.contabilizado,true);
    }
  }
});
test('Martins prevalece como canal sem mudar modalidade nem critérios de venda',()=>{
  const row=classifier.analyticRow({nome_vendedor:'Martins',situacao:'Cancelado',valor:100,ecommerce:{nomeEcommerce:'Amazon FBA Classic'}},'Oficial',true);
  assert.equal(row.canal,'Martins');
  assert.equal(row.fulfillment,true);
  assert.equal(row.contabilizado,false);
  assert.equal(classifier.channel({nome_vendedor:'João Martins',ecommerce:{nomeEcommerce:'Shopee'}},'Oficial'),'Shopee');
  assert.equal(classifier.channel({nome_vendedor:'Gabriel Barbosa'},'Oficial'),'Vendas Diretas');
});
