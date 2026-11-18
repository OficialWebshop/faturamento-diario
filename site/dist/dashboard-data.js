(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DASHBOARD_DATA = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const sum = values => Object.values(values || {}).reduce((a, b) => a + Number(b || 0), 0);
  const labels = Array.from({length:24}, (_, h) => String(h).padStart(2, '0') + 'h');
  function hourly(series) {
    return (series || []).map(row => {
      const values = Array(24).fill(0);
      for (const point of row.hours || []) {
        const hour = Number(String(point.hour).match(/^\d{1,2}/)?.[0]);
        if (Number.isInteger(hour) && hour >= 0 && hour < 24) values[hour] += Number(point.value || 0);
      }
      return {channel:row.channel, hours:labels.map((hour, i) => ({hour, value:values[i]}))};
    });
  }
  function normalize(payload) {
    if (payload.views?.length) return payload;
    const rows = (payload.analytics || []).filter(row => row.contabilizado === true);
    const business = payload.business?.length ? payload.business : rows.map(row => ({
      empresa:row.empresa, canal:row.canal, gmv:row.valor, pedidos:1
    }));
    const full = row => ['OFICIALSP','OFICIALSP2'].includes(row.empresa) || row.fulfillment === true;
    const groups = [
      ['Consolidado', () => true], ['Oficial', row => row.empresa !== 'Prioriza'],
      ['Oficial Core', row => row.empresa === 'Oficial' && !full(row)],
      ['Full Oficial', row => row.empresa !== 'Prioriza' && full(row)],
      ['Prioriza', row => row.empresa === 'Prioriza']
    ];
    const source = rows.length ? rows.map(row => ({...row, gmv:row.valor, pedidos:1})) : business;
    const management = groups.map(([grupo, include]) => {
      const selected = source.filter(include), gmv = selected.reduce((s,r) => s + Number(r.gmv || 0),0),
        pedidos = selected.reduce((s,r) => s + Number(r.pedidos || 0),0);
      return {grupo, gmv, pedidos, ticket:pedidos ? gmv / pedidos : 0};
    });
    const current = payload.currentChannels || {}, series = hourly(payload.series);
    const consolidated = management[0];
    // The accumulated API values remain authoritative, including channels with no detail yet.
    consolidated.gmv = Number(payload.metrics?.totalGmv ?? sum(current));
    consolidated.pedidos = Number(payload.metrics?.totalOrders ?? consolidated.pedidos);
    consolidated.ticket = consolidated.pedidos ? consolidated.gmv / consolidated.pedidos : 0;
    const views = ['Consolidado','Oficial','Full','Prioriza'].map(scope => {
      if (scope === 'Consolidado') return {scope, series, currentChannels:current, previousChannels:payload.previousChannels || {}};
      const group = groups.find(([name]) => name === (scope === 'Full' ? 'Full Oficial' : scope));
      const channels = {};
      for (const row of source.filter(group[1])) channels[row.canal] = (channels[row.canal] || 0) + Number(row.gmv || 0);
      if (scope === 'Oficial' && payload.snapshotHistory?.some(snapshot => snapshot.business?.length)) {
        const history = payload.snapshotHistory.filter(snapshot => Array.isArray(snapshot.business));
        const accumulated = history.map(snapshot => {
          const channels = {};
          for (const row of snapshot.business.filter(group[1])) {
            channels[row.canal] = (channels[row.canal] || 0) + Number(row.gmv || 0);
          }
          return {slot:snapshot.slot, channels};
        });
        const names = [...new Set(accumulated.flatMap(snapshot => Object.keys(snapshot.channels)))];
        const operationSeries = names.map(channel => {
          let previous = 0;
          return {channel, hours:accumulated.map(snapshot => {
            const current = Number(snapshot.channels[channel] || 0), value = Math.max(0, current - previous);
            previous = current;
            return {hour:snapshot.slot, value};
          })};
        });
        return {scope, currentChannels:channels, previousChannels:accumulated.at(-2)?.channels || {}, series:hourly(operationSeries)};
      }
      // Legacy snapshots have no hourly breakdown per operation. Do not invent one.
      return {scope, currentChannels:channels, previousChannels:{}, series:Object.keys(channels).map(channel => ({channel, hours:labels.map(hour => ({hour,value:0}))})), hourlyUnavailable:true};
    });
    const latest = payload.snapshotHistory?.at(-1), activeHour = latest ? Number(String(latest.slot).slice(0,2)) : 0;
    return {...payload, series, management, views, metrics:{...payload.metrics, activeHour}, legacyHourly:true};
  }
  return {normalize, hourly};
});
