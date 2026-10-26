(() => {
  'use strict';

  const state = { year: 'all', county: 'all', view: 'progress', verifiedOnly: false, records: [], filtered: [], selectedBin: null, loaded: false };
  const formatNumber = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });
  let countyDefinitions = [];
  let plotly;
  let statistics;
  let rendering = false;
  let pending = false;
  let pendingFull = false;

  const byId = id => document.getElementById(id);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const count = value => formatNumber.format(value);
  const decimal = (value, digits = 2) => finite(value) ? value.toLocaleString('zh-TW', { minimumFractionDigits: 0, maximumFractionDigits: digits }) : '缺值';
  const percent = value => finite(value) ? decimal(value, value !== 0 && Math.abs(value) < .01 ? Math.min(8, Math.ceil(-Math.log10(Math.abs(value))) + 1) : 2) + '%' : '缺值';
  const sourceName = record => record.sourceLabel || record.sourceName || record.sourceId || '未註明來源';
  const yearName = record => record.yearLabel || String(record.year);
  const hasThreshold = record => Boolean(record.threshold);
  const thresholdRecords = records => records.filter(hasThreshold);
  const median = values => values.length ? statistics.median(values) : null;
  const raceCount = records => new Set(records.map(record => String(record.year) + '|' + record.countyId)).size;
  const filterKey = snapshot => snapshot.year + '|' + snapshot.county;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function safeHref(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const parsed = new URL(value, window.location.href);
      return ['http:', 'https:', 'file:'].includes(parsed.protocol) ? value : null;
    } catch (_) {
      return null;
    }
  }

  function appendLink(parent, label, href) {
    const safe = safeHref(href);
    if (!safe) return;
    const link = element('a', label);
    link.href = safe;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    parent.append(link);
  }

  function videoAtOffset(href, offset) {
    if (typeof href !== 'string' || !finite(offset)) return href;
    const hashIndex = href.indexOf('#');
    const hash = hashIndex < 0 ? '' : href.slice(hashIndex);
    const withoutHash = hashIndex < 0 ? href : href.slice(0, hashIndex);
    const queryIndex = withoutHash.indexOf('?');
    const path = queryIndex < 0 ? withoutHash : withoutHash.slice(0, queryIndex);
    const query = new URLSearchParams(queryIndex < 0 ? '' : withoutHash.slice(queryIndex + 1));
    query.set('t', String(Math.max(0, Math.floor(offset))) + 's');
    return path + '?' + query.toString() + hash;
  }

  function coverageLabel(value) {
    if (typeof value !== 'string' || !value) return '缺少時間';
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? value.slice(0, 16).replace('T', ' ') : value;
  }

  function clockLabel(value) {
    if (!finite(value)) return '缺少時間';
    const minute = Math.round(value);
    const day = Math.floor(minute / 1440);
    const inDay = ((minute % 1440) + 1440) % 1440;
    const clock = String(Math.floor(inDay / 60)).padStart(2, '0') + ':' + String(inDay % 60).padStart(2, '0');
    const prefix = day === 0 ? '' : day === 1 ? '翌日 ' : day === -1 ? '前日 ' : day > 1 ? day + ' 日後 ' : Math.abs(day) + ' 日前 ';
    return prefix + clock;
  }

  function qualityLabel(value) {
    return ({ verified: '已核對', estimated: '估計', unverified: '未核對', missing: '缺少時間' })[value] || '未註明品質';
  }

  function statusLabel(record) {
    return ({ confirmed: '可判定', inconclusive: '無法判定', 'no-complete': '無完整可讀畫面' })[record.status] || (record.threshold ? '可判定' : '無法判定');
  }

  function recordRow(record) {
    const row = element('tr');
    row.append(element('td', yearName(record)), element('td', record.countyName), element('td', sourceName(record)));
    const status = element('td', statusLabel(record));
    if (record.reason) status.append(element('span', record.reason, 'reason'));
    status.append(element('span', '完整票組 ' + (finite(record.completeCount) ? count(record.completeCount) : '缺值') + ' 筆／可讀 ' + (finite(record.readableCount) ? count(record.readableCount) : '缺值') + ' 筆', 'reason'));
    status.append(element('span', '已收錄時間範圍：' + coverageLabel(record.coverageStart) + '～' + coverageLabel(record.coverageEnd), 'reason'));
    row.append(status, element('td', record.winnerName || '缺值'));
    const threshold = record.threshold;
    row.append(element('td', finite(threshold?.totalVotes) ? count(threshold.totalVotes) : '缺值', 'numeric'));
    row.append(element('td', percent(threshold?.progress), 'numeric'));
    row.append(element('td', threshold && finite(threshold.clockMinutes) ? clockLabel(threshold.clockMinutes) + ' · ' + qualityLabel(threshold.timeQuality) : '缺少時間'));
    row.append(element('td', threshold ? (threshold.leftCensored ? '左設限（上限）' : '換手後穩定') : '—'));
    const evidenceCell = element('td');
    const evidence = element('div', undefined, 'evidence');
    appendLink(evidence, '各場曲線', record.curveHref);
    if (threshold) {
      appendLink(evidence, '首個穩定影格', threshold.frameHref);
      appendLink(evidence, '前一完整影格', threshold.previousFrameHref);
      appendLink(evidence, '最後完整影格', threshold.finalFrameHref);
      appendLink(evidence, '影片', videoAtOffset(threshold.videoHref, threshold.videoOffset));
    }
    if (!evidence.childNodes.length) evidence.textContent = '缺少連結';
    evidenceCell.append(evidence);
    row.append(evidenceCell);
    return row;
  }

  function renderRecordRows(target, records) {
    const body = byId(target);
    const fragment = document.createDocumentFragment();
    for (const record of records) fragment.append(recordRow(record));
    if (!records.length) {
      const cell = element('td', '目前篩選沒有紀錄。', 'empty-message');
      cell.colSpan = 10;
      const row = element('tr');
      row.append(cell);
      fragment.append(row);
    }
    body.replaceChildren(fragment);
  }

  function clearBin() {
    state.selectedBin = null;
    byId('bin-description').textContent = '點選任一直方圖的柱狀，即可查看該區間的原始紀錄與證據。';
    byId('bin-table-wrap').hidden = true;
    byId('clear-bin').hidden = true;
    byId('bin-records-body').replaceChildren();
    byId('bin-details-section').open = false;
  }

  function openBin(model, bin) {
    if (model.filterKey !== filterKey(state) || (model.kind === 'time' && model.verifiedOnly !== state.verifiedOnly)) return;
    if (model.kind !== 'time' && model.viewKey !== state.view) return;
    state.selectedBin = { chartId: model.id, lower: bin.lower, upper: bin.upper, count: bin.records.length };
    byId('bin-description').textContent = model.title + ' · ' + rangeLabel(model.kind, bin.lower, bin.upper) + ' · ' + count(bin.records.length) + ' 筆紀錄（來源 × 場次）';
    renderRecordRows('bin-records-body', bin.records);
    byId('bin-table-wrap').hidden = false;
    byId('clear-bin').hidden = false;
    byId('bin-details-section').open = true;
    byId('bin-details-section').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  function updateSummary(records) {
    const thresholds = thresholdRecords(records);
    const left = thresholds.filter(record => record.threshold.leftCensored).length;
    byId('limits-story').textContent = thresholds.length
      ? '可判定的 ' + count(thresholds.length) + ' 筆紀錄中，有 ' + count(left) + ' 筆從第一個完整畫面就由最終當選人持續領先，門檻只能視為上限。另有 ' + count(records.length - thresholds.length) + ' 筆無法判定，可在原始紀錄查看原因。'
      : '目前篩選沒有可判定的觀測門檻；' + (records.length ? '原始紀錄保留無法判定的原因與影格。' : '這個年份與選區組合沒有收錄紀錄。');
    const elections = new Set(records.map(record => record.year)).size;
    byId('filter-scope').textContent = '目前範圍：' + count(elections) + ' 屆選舉、' + count(raceCount(records)) + ' 場選舉、' + count(records.length) + ' 筆來源紀錄。';
    byId('all-records-summary').textContent = '查看所有來源紀錄與影格證據（' + count(records.length) + ' 筆，含無法判定）';
    renderRecordRows('all-records-body', records);
  }

  function rankingLabel(ranking) {
    const labels = (ranking.entries || []).map(record => record.sourceLabel?.startsWith(record.sourceName) ? record.sourceLabel.slice(record.sourceName.length) : '');
    const origin = labels.length && labels.every(label => label && label === labels[0]) ? labels[0] : '';
    return (ranking.name || ranking.id || '未註明來源') + origin;
  }

  function rankingDetail(entries) {
    const wrapper = element('div');
    wrapper.append(element('p', '各場偏差分數與進度覆蓋情況；缺值保留為缺值。'));
    const table = element('table');
    const head = element('thead');
    const headers = element('tr');
    ['選舉', '選區', '來源', '偏差（百分點）', '有效點數 n', '實際進度範圍', '10–90% 覆蓋率', '查看'].forEach(label => headers.append(element('th', label)));
    head.append(headers);
    const body = element('tbody');
    for (const record of entries) {
      const row = element('tr');
      const error = record.error;
      row.append(element('td', yearName(record)), element('td', record.countyName), element('td', sourceName(record)));
      row.append(element('td', decimal(error?.value), 'numeric'), element('td', finite(error?.pointCount) ? count(error.pointCount) : '缺值', 'numeric'));
      row.append(element('td', finite(error?.minProgress) && finite(error?.maxProgress) ? percent(error.minProgress) + '–' + percent(error.maxProgress) : '缺值'));
      row.append(element('td', percent(error?.coveragePercent), 'numeric'));
      const evidence = element('td');
      appendLink(evidence, '各場曲線', record.curveHref);
      row.append(evidence);
      body.append(row);
    }
    table.append(head, body);
    wrapper.append(table);
    return wrapper;
  }

  function renderRankings(records) {
    const rankings = statistics.aggregateRankings(records).slice().sort((left, right) => Number(Boolean(left.isReference)) - Number(Boolean(right.isReference)));
    const fragment = document.createDocumentFragment();
    rankings.forEach((ranking, index) => {
      const row = element('tr');
      row.append(element('td', ranking.isReference ? '參考' : finite(ranking.rank) ? ranking.rank : '未排名'));
      const source = element('td');
      const toggle = element('button', rankingLabel(ranking), 'source-toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', 'false');
      const detailId = 'ranking-detail-' + index;
      toggle.setAttribute('aria-controls', detailId);
      source.append(toggle);
      row.append(source, element('td', decimal(ranking.meanError), 'numeric'), element('td', decimal(ranking.medianError), 'numeric'));
      row.append(element('td', finite(ranking.raceCount) ? count(ranking.raceCount) : '缺值', 'numeric'));
      const rankingYears = Array.isArray(ranking.years) ? [...new Set(ranking.years.map(year => Number.parseInt(year, 10)).filter(Number.isFinite))].join('、') : '缺值';
      row.append(element('td', rankingYears || '缺值'));
      row.append(element('td', percent(ranking.coveragePercent), 'numeric'));
      const detail = element('tr', undefined, 'ranking-detail');
      detail.id = detailId;
      detail.hidden = true;
      const detailCell = element('td');
      detailCell.colSpan = 7;
      detailCell.append(rankingDetail(ranking.entries || []));
      detail.append(detailCell);
      toggle.addEventListener('click', () => {
        detail.hidden = !detail.hidden;
        toggle.setAttribute('aria-expanded', String(!detail.hidden));
      });
      fragment.append(row, detail);
    });
    if (!rankings.length) {
      const row = element('tr');
      const cell = element('td', '目前篩選沒有可計算偏差的紀錄。', 'empty-message');
      cell.colSpan = 7;
      row.append(cell);
      fragment.append(row);
    }
    byId('rankings-body').replaceChildren(fragment);
    byId('rankings-note').textContent = '目前可計算偏差的來源紀錄：' + count(records.filter(record => finite(record.error?.value)).length) + ' 筆。';
    return rankings;
  }

  async function renderRankingChart(rankings) {
    const ranked = rankings.filter(ranking => !ranking.isReference && finite(ranking.meanError));
    const best = ranked[0];
    byId('ranking-story').textContent = best
      ? '目前收錄中，' + rankingLabel(best) + ' 的平均偏差 ' + decimal(best.meanError) + ' 百分點，為此範圍最低；來自 ' + count(best.raceCount) + ' 場選舉，進度覆蓋率 ' + percent(best.coveragePercent) + '。這個名次也受樣本涵蓋影響。'
      : '目前篩選沒有可比較的電視臺偏差分數；缺值不視為零，個別原因保留在完整總表。';
    const graph = byId('ranking-chart');
    const height = Math.max(300, ranked.length * 34 + 86);
    graph.style.height = height + 'px';
    graph.setAttribute('aria-label', '電視臺平均偏差，越小越接近最後結果；' + ranked.length + ' 個來源。' + (best ? rankingLabel(best) + ' ' + decimal(best.meanError) + ' 百分點。完整數據可展開下方總表。' : '目前沒有可比較分數。'));
    await plotly.react(graph, ranked.length ? [{type:'bar',orientation:'h',x:ranked.map(item=>item.meanError),y:ranked.map(rankingLabel),
      marker:{color:ranked.map((_,index)=>index===0?'#8de1b8':'#82c9ff')},text:ranked.map(item=>decimal(item.meanError)),textposition:'outside',cliponaxis:false,
      customdata:ranked.map(item=>[item.raceCount,percent(item.coveragePercent)]),hovertemplate:'%{y}<br>平均偏差 %{x:.2f} 百分點<br>有效場數 %{customdata[0]}<br>進度覆蓋率 %{customdata[1]}<extra></extra>'}] : [],
      {autosize:true,height,paper_bgcolor:'#121619',plot_bgcolor:'#121619',font:{color:'#a8b7be',family:'Microsoft JhengHei, PingFang TC, sans-serif',size:12},
        margin:{l:132,r:48,t:12,b:62},xaxis:{title:{text:'距最終得票率的平均偏差（百分點）',font:{size:12}},range:[0,Math.max(.1,...ranked.map(item=>item.meanError))*1.2],gridcolor:'#29343b',zeroline:false,automargin:true},
        yaxis:{autorange:'reversed',automargin:true,tickfont:{size:12}},bargap:.32,showlegend:false,dragmode:false,
        annotations:ranked.length?[]:[{xref:'paper',yref:'paper',x:.5,y:.5,text:'此篩選沒有可比較分數',showarrow:false}]},
      {responsive:true,displaylogo:false,displayModeBar:false});
  }

  function viewDefinition() {
    const countyId = state.view.startsWith('votes:') ? state.view.slice(6) : null;
    const countyName = countyDefinitions.find(item=>item[0]===countyId)?.[1];
    return {id:'threshold-hist',kind:countyId?'votes':'progress',countyId,viewKey:state.view,title:countyId?countyName+' · 票數分布':'開票比例分布'};
  }

  function syncViewTabs(records) {
    const available = new Set(records.map(record=>record.countyId));
    const buttons = [...byId('threshold-tabs').querySelectorAll('[role="tab"]')];
    for(const button of buttons) button.disabled = Boolean(button.dataset.countyId) && !available.has(button.dataset.countyId);
    if(buttons.find(button=>button.dataset.view===state.view)?.disabled) state.view='progress';
    for(const button of buttons) {
      const selected=button.dataset.view===state.view;
      button.setAttribute('aria-selected',String(selected));
      button.tabIndex=selected?0:-1;
      button.title=button.disabled?'目前閱讀範圍沒有此選區資料':'';
      if(selected) byId('threshold-panel').setAttribute('aria-labelledby',button.id);
    }
  }

  function selectView(value) {
    if(state.view===value) return;
    state.view=value;
    clearBin();
    requestRender();
  }

  function populateViewTabs() {
    const definitions=[{key:'progress',label:'開票比例'},...countyDefinitions.map(([id,name])=>({key:'votes:'+id,label:name==='全國'?'全國票數':name+'票數',countyId:id}))];
    definitions.forEach((definition,index)=>{
      const button=element('button',definition.label);
      button.id='threshold-tab-'+index;
      button.type='button';
      button.setAttribute('role','tab');
      button.setAttribute('aria-controls','threshold-panel');
      button.dataset.view=definition.key;
      if(definition.countyId) button.dataset.countyId=definition.countyId;
      button.addEventListener('click',()=>selectView(definition.key));
      button.addEventListener('keydown',event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault();
        const enabled=[...byId('threshold-tabs').querySelectorAll('[role="tab"]:not(:disabled)')];
        const current=enabled.indexOf(button);
        const next=event.key==='Home'?0:event.key==='End'?enabled.length-1:(current+(event.key==='ArrowRight'?1:-1)+enabled.length)%enabled.length;
        enabled[next].focus();
        selectView(enabled[next].dataset.view);
      });
      byId('threshold-tabs').append(button);
    });
  }

  function niceStep(value) {
    if (!(value > 0)) return 1;
    const power = 10 ** Math.floor(Math.log10(value));
    const fraction = value / power;
    const multiplier = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
    return multiplier * power;
  }

  function rangeLabel(kind, lower, upper) {
    if (kind === 'time') return clockLabel(lower) + ' ≤ 時間 < ' + clockLabel(upper);
    if (kind === 'votes') return count(lower) + ' ≤ 票數 < ' + count(upper) + ' 票';
    return decimal(lower) + '% ≤ 比例 < ' + decimal(upper) + '%';
  }

  function voteBinWidth(values) {
    if(!values.length) return 10000;
    const low = Math.min(...values), high = Math.max(...values);
    if(values.length < 3 || high === low) return high > low ? Math.max(1,Math.ceil(high-low)) : Math.max(1,niceStep(Math.max(high*.12,1000)));
    const power = Math.floor(Math.log10((high-low)/20));
    const candidates = [];
    for(let exponent=power-2;exponent<=power+2;exponent++) {
      for(const multiplier of [1,2,2.5,5,10]) {
        const width = multiplier * 10**exponent;
        if(!Number.isSafeInteger(width) || width<1) continue;
        const number = Math.floor(high/width)-Math.floor(low/width)+1;
        if(number>=12 && number<=30) candidates.push({width,number});
      }
    }
    candidates.sort((left,right)=>Math.abs(left.number-20)-Math.abs(right.number-20) || right.width-left.width);
    return candidates[0]?.width || 1;
  }

  function makeModel(definition, snapshot) {
    const records = snapshot.records.filter(record => record.threshold && (!definition.countyId || record.countyId === definition.countyId));
    const usable = records.map(record => ({ record, value: definition.kind === 'progress' ? record.threshold.progress : definition.kind === 'votes' ? record.threshold.totalVotes : record.threshold.clockMinutes }))
      .filter(item => finite(item.value) && (definition.kind !== 'time' || item.record.threshold.timeQuality !== 'missing') && (definition.kind !== 'time' || !snapshot.verifiedOnly || item.record.threshold.timeQuality === 'verified'));
    const values = usable.map(item => item.value);
    const lowest = values.length ? Math.min(...values) : definition.kind === 'time' ? 960 : 0;
    const highest = values.length ? Math.max(...values) : definition.kind === 'time' ? 1320 : definition.kind === 'progress' ? 100 : 100000;
    const width = definition.kind === 'progress' ? 5 : definition.kind === 'time' ? 10 : voteBinWidth(values);
    const start = Math.floor((definition.kind === 'progress' ? Math.min(0, lowest) : lowest) / width) * width;
    const end = Math.max(start + width, (Math.floor((definition.kind === 'progress' ? Math.max(100, highest) : highest) / width) + 1) * width);
    const numberOfBins = Math.max(1, Math.round((end - start) / width));
    const bins = Array.from({ length: numberOfBins }, (_, index) => ({ lower: start + index * width, upper: start + (index + 1) * width, records: [], left: 0, changed: 0 }));
    for (const item of usable) {
      const index = Math.min(bins.length - 1, Math.max(0, Math.floor((item.value - start) / width)));
      bins[index].records.push(item.record);
      bins[index][item.record.threshold.leftCensored ? 'left' : 'changed'] += 1;
    }
    return { ...definition, bins, values, width, start, end, median: median(values), filterKey: filterKey(snapshot), verifiedOnly: snapshot.verifiedOnly, usable };
  }

  function graphTraces(model) {
    const scale = model.kind === 'votes' && model.end >= 10000 ? 10000 : 1;
    model.scale = scale;
    const traces = [
      { key: 'left', name: '起始即領先（左設限）', color: '#82c9ff' },
      { key: 'changed', name: '觀測到換手後穩定', color: '#d09bfa' }
    ].map(group => ({
      type: 'bar', name: group.name,
      x: model.bins.map(bin => (bin.lower + bin.upper) / 2 / scale),
      y: model.bins.map(bin => bin[group.key]),
      width: model.width / scale * (model.kind === 'votes' ? .8 : .92),
      marker: { color: group.color, line: { width: 0 } },
      customdata: model.bins.map(bin => [rangeLabel(model.kind, bin.lower, bin.upper), bin.records.length]),
      hovertemplate: '%{customdata[0]}<br>' + group.name + '：%{y} 筆<br>區間總計：%{customdata[1]} 筆<extra></extra>'
    }));
    if(model.kind === 'votes' && model.usable.length) {
      const totals = new Map(), seen = new Map();
      for(const item of model.usable) totals.set(item.value,(totals.get(item.value)||0)+1);
      const levels = model.usable.map(item => {
        const level = seen.get(item.value)||0;
        seen.set(item.value,level+1);
        return level;
      });
      model.rugLevels = Math.max(...levels);
      traces.push({type:'scatter',mode:'markers',name:'原始觀測',yaxis:'y2',meta:{kind:'observations'},
        x:model.usable.map(item=>item.value/scale),y:levels,
        marker:{symbol:'line-ns',size:9,color:model.usable.map(item=>item.record.threshold.leftCensored?'#82c9ff':'#d09bfa'),line:{width:1.5,color:model.usable.map(item=>item.record.threshold.leftCensored?'#82c9ff':'#d09bfa')}},
        customdata:model.usable.map(item=>[yearName(item.record),item.record.countyName,sourceName(item.record),item.value,Math.min(model.bins.length-1,Math.max(0,Math.floor((item.value-model.start)/model.width))),totals.get(item.value)]),
        hovertemplate:'%{customdata[0]}／%{customdata[1]}<br>%{customdata[2]}<br>已收錄候選人票數合計 %{customdata[3]:,d} 票<br>同票數 %{customdata[5]} 筆<extra></extra>'});
    }
    return traces;
  }

  function graphLayout(model) {
    const valueLabel = model.kind === 'time' ? clockLabel(model.median) : model.kind === 'votes' ? decimal(model.median, 1) + ' 票' : percent(model.median);
    const range = [model.start / model.scale, model.end / model.scale];
    const axisTitle = model.kind === 'time' ? '選舉日時間（每 10 分鐘）' : model.kind === 'progress' ? '開票比例（每 5 百分點）' : '已收錄候選人票數合計（' + (model.scale === 10000 ? '萬票' : '票') + '）';
    const xaxis = { title: { text: axisTitle, font: { size: 11 }, standoff: 12 }, range, gridcolor: '#29343b', zeroline: false, linecolor: '#3d4b52', tickfont: { size: 11 }, nticks: 5, automargin: true };
    if (model.kind === 'time') {
      const tickStep = niceStep((model.end - model.start) / 4 / 10) * 10;
      xaxis.tickvals = [];
      for (let value = Math.ceil(model.start / tickStep) * tickStep; value <= model.end; value += tickStep) xaxis.tickvals.push(value);
      xaxis.ticktext = xaxis.tickvals.map(clockLabel);
    } else {
      const digits = model.kind === 'votes' ? Math.min(2, Math.max(0, -Math.floor(Math.log10(model.width / model.scale)))) : 0;
      xaxis.tickformat = ',.' + digits + 'f';
      if (model.kind === 'progress') xaxis.ticksuffix = '%';
    }
    const highestCount = Math.max(1, ...model.bins.map(bin => bin.records.length));
    const layout = {
      autosize: true, paper_bgcolor: '#121619', plot_bgcolor: '#121619', font: { color: '#a8b7be', family: 'Microsoft JhengHei, PingFang TC, sans-serif', size: 11 },
      margin: { l: 54, r: 14, t: 44, b: 68 }, xaxis,
      yaxis: { title: { text: '紀錄數（來源×場次）', font: { size: 11 }, standoff: 8 }, range: [0, highestCount * 1.2], gridcolor: '#29343b', zeroline: false, automargin: true, dtick: highestCount <= 5 ? 1 : undefined, tickformat: ',d' },
      barmode: 'stack', bargap: .08, showlegend: false, hovermode: 'closest', dragmode: false,
      shapes: [], annotations: []
    };
    if (finite(model.median)) {
      layout.shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: model.median / model.scale, x1: model.median / model.scale, y0: 0, y1: 1, line: { color: '#8de1b8', width: 2, dash: 'solid' } });
      layout.annotations.push({ xref: 'x', yref: 'paper', x: model.median / model.scale, y: 1, yshift: 12, text: '中位數 ' + valueLabel + ' · n=' + model.values.length, showarrow: false, xanchor: model.median > (model.start + model.end) / 2 ? 'right' : 'left', yanchor: 'bottom', font: { color: '#8de1b8', size: 11 } });
    } else {
      layout.annotations.push({ xref: 'paper', yref: 'paper', x: .5, y: .5, text: '此篩選沒有可用紀錄（n=0）', showarrow: false, font: { color: '#a8b7be', size: 12 } });
    }
    if(model.kind === 'votes' && model.usable.length) {
      layout.yaxis.domain = [.2,1];
      layout.yaxis2 = {domain:[0,.1],range:[-.7,(model.rugLevels||0)+.7],anchor:'x',visible:false,fixedrange:true};
      layout.xaxis.anchor = 'free';
      layout.xaxis.position = 0;
    }
    return layout;
  }

  async function renderGraph(definition, snapshot) {
    const model = makeModel(definition, snapshot);
    const graph = byId(definition.id);
    const traces = graphTraces(model);
    const layout = graphLayout(model);
    const value = !finite(model.median) ? '缺值' : model.kind === 'time' ? clockLabel(model.median) : model.kind === 'votes' ? decimal(model.median, 1) + ' 票' : percent(model.median);
    byId(definition.id + '-summary').textContent = '觀測門檻中位數：' + value + ' · 有效 n=' + count(model.values.length);
    if (model.kind === 'time') {
      const qualities = ['verified', 'estimated', 'unverified'].map(quality => qualityLabel(quality) + ' ' + model.usable.filter(item => item.record.threshold.timeQuality === quality).length);
      byId('time-hist-extra').textContent = qualities.join('／') + '；缺少時間不納入。';
      byId('time-story').textContent=model.values.length
        ? '在 '+count(model.values.length)+' 筆'+(snapshot.verifiedOnly?'已核對時間的':'具有時間的')+'紀錄中，第一名開始持續領先的觀測門檻，中位數是 '+clockLabel(model.median)+'。'
        : '目前篩選沒有'+(snapshot.verifiedOnly?'已核對的':'可採用的')+'時間，無法判定時間中位數；票數紀錄仍保留。';
    } else {
      byId('threshold-view-title').textContent=definition.title;
      const limited = model.values.length && (model.values.length<3 || new Set(model.values).size===1);
      byId('threshold-hist-extra').textContent=model.kind==='votes'
        ? (model.values.length?'每箱 '+count(model.width)+' 票，共 '+count(model.bins.length)+' 箱；下方每條短線代表一筆原始觀測，可懸停或點選回查。'+(limited?'樣本或不同票數太少，無法判讀分布形狀。':''):'目前沒有可用票數觀測。')
        : '比例分母採相同候選人組的最終票數。';
      byId('threshold-story').textContent=model.values.length
        ? (model.kind==='votes'?definition.title.replace(' · 票數分布','')+'的觀測門檻，中位數是已收錄候選人合計 '+decimal(model.median,1)+' 票。':'這些畫面中的觀測門檻，中位數落在開票比例 '+percent(model.median)+'。')+'共 '+count(model.values.length)+' 筆可計算紀錄。'
        : '目前篩選沒有可計算的'+(model.kind==='votes'?'票數':'比例')+'觀測門檻；缺讀及無法判定的原因可在文末紀錄查看。';
    }
    graph.setAttribute('aria-label', definition.title + '；觀測門檻中位數 ' + value + '；有效 ' + model.values.length + ' 筆；下方所有來源紀錄可查看完整文字資料。');
    await plotly.react(graph, traces, layout, { responsive: true, displaylogo: false, displayModeBar: false });
    if (typeof graph.removeAllListeners === 'function') graph.removeAllListeners('plotly_click');
    if (typeof graph.on === 'function') graph.on('plotly_click', event => {
      const point = event?.points?.[0];
      const index = point?.data?.meta?.kind === 'observations' ? point.customdata?.[4] : point?.pointIndex ?? point?.pointNumber;
      if (Number.isInteger(index) && model.bins[index]) openBin(model, model.bins[index]);
    });
  }

  async function renderLoop() {
    if (rendering) return;
    rendering = true;
    byId('article-charts').setAttribute('aria-busy', 'true');
    try {
      while (pending) {
        const full = pendingFull;
        pending = false;
        pendingFull = false;
        const snapshot = { year: state.year, county: state.county, verifiedOnly: state.verifiedOnly, records: state.records.filter(record => (state.year === 'all' || String(record.year) === state.year) && (state.county === 'all' || record.countyId === state.county)) };
        state.filtered = snapshot.records;
        byId('load-status').textContent = '正在更新圖表…';
        let rankings;
        if (full) {
          clearBin();
          syncViewTabs(snapshot.records);
          updateSummary(snapshot.records);
          rankings = renderRankings(snapshot.records);
        } else if (state.selectedBin?.chartId === 'time-hist') clearBin();
        const selected = [{id:'time-hist',kind:'time',title:'第一名不再換人的時間分布'}];
        if(full) selected.push(viewDefinition());
        const jobs = selected.map(definition => renderGraph(definition, snapshot));
        if(full) jobs.push(renderRankingChart(rankings));
        const results = await Promise.allSettled(jobs);
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      }
      byId('load-status').textContent = '圖表已更新。點選柱狀可查看區間紀錄與證據。';
      byId('load-status').classList.remove('error');
    } catch (error) {
      showError(error);
    } finally {
      rendering = false;
      byId('article-charts').setAttribute('aria-busy', 'false');
      if (pending) void renderLoop();
    }
  }

  function requestRender(full = true) {
    pending = true;
    pendingFull = pendingFull || full;
    void renderLoop();
  }

  function populateFilters() {
    const years = new Map();
    const counties = new Map();
    for (const record of state.records) {
      if (!years.has(String(record.year))) years.set(String(record.year), yearName(record));
      if (!counties.has(record.countyId)) counties.set(record.countyId, record.countyName || record.countyId);
    }
    [...years.entries()].sort((a, b) => b[0].localeCompare(a[0], 'en')).forEach(([id, name]) => {
      const option = element('option', name);
      option.value = id;
      byId('year-filter').append(option);
    });
    const canonical = ['全國', '臺北', '新北', '桃園', '臺中', '臺南', '高雄'];
    const countyOrder = item => {
      if (item[0] === 'national') return 0;
      const normalized = String(item[1]).replaceAll('台', '臺');
      const index = canonical.findIndex(name => normalized.includes(name));
      return index < 0 ? 99 : index;
    };
    countyDefinitions = [...counties.entries()].sort((a, b) => countyOrder(a) - countyOrder(b));
    for (const [id, name] of countyDefinitions) {
      const option = element('option', name);
      option.value = id;
      byId('county-filter').append(option);
    }
    byId('year-filter').disabled = false;
    byId('county-filter').disabled = false;
    byId('year-filter').addEventListener('change', event => { state.year = event.target.value; requestRender(); });
    byId('county-filter').addEventListener('change', event => { state.county = event.target.value; requestRender(); });
  }

  function showError(error) {
    const status = byId('load-status');
    status.textContent = '統計載入或圖表更新失敗：' + (error instanceof Error ? error.message : String(error));
    status.classList.add('error');
    console.error(error);
  }

  window.StatisticsPage = Object.freeze({
    getState: () => ({ loaded: state.loaded, year: state.year, county: state.county, view: state.view, verifiedOnly: state.verifiedOnly, recordCount: state.records.length, filteredRecordCount: state.filtered.length, raceCount: raceCount(state.filtered), thresholdCount: thresholdRecords(state.filtered).length, rankingRecordCount: state.filtered.filter(record => finite(record.error?.value)).length, selectedBin: state.selectedBin ? { ...state.selectedBin } : null, chartCount: 3, rendering })
  });

  function setupNavigation() {
    const sidebar = byId('election-sidebar');
    const menu = byId('election-menu');
    const close = byId('close-election-menu');
    const backdrop = byId('nav-backdrop');
    const desktop = window.matchMedia('(min-width:1024px)');
    function setMenu(open, restoreFocus = false) {
      const active = Boolean(open && !desktop.matches);
      sidebar.classList.toggle('open', active);
      sidebar.inert = !desktop.matches && !active;
      sidebar.toggleAttribute('aria-modal', active);
      if (active) sidebar.setAttribute('role', 'dialog');
      else sidebar.removeAttribute('role');
      menu.setAttribute('aria-expanded', String(active));
      backdrop.hidden = !active;
      document.body.classList.toggle('nav-open', active);
      byId('statistics-main').inert = active;
      if (active) close.focus();
      else if (restoreFocus && !desktop.matches) menu.focus();
    }
    menu.addEventListener('click', () => setMenu(true));
    close.addEventListener('click', () => setMenu(false, true));
    backdrop.addEventListener('click', () => setMenu(false, true));
    desktop.addEventListener('change', () => setMenu(false));
    sidebar.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); setMenu(false, true); }
      if (event.key !== 'Tab' || !sidebar.classList.contains('open')) return;
      const items = [...sidebar.querySelectorAll('button:not([disabled]),a[href]')];
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    setMenu(false);
  }

  function populateNavigation(master) {
    const years = (master.electionYears || Object.keys(master.elections || {})).filter(year => Number.parseInt(year, 10) >= 2012);
    const nav = byId('election-nav');
    nav.replaceChildren();
    for (const year of years) {
      const label = Number.parseInt(year, 10) + (String(year).includes('mayors') ? ' 年縣市首長選舉' : ' 年總統選舉');
      const link = element('a', label, 'year-tab');
      link.href = 'index.html?year=' + encodeURIComponent(year);
      nav.append(link);
    }
  }

  async function initialize() {
    if (!window.ElectionArchive || !window.ElectionStatistics) throw new Error('缺少共用資料載入或統計計算元件。');
    statistics = window.ElectionStatistics;
    const [master, library] = await Promise.all([window.ElectionArchive.loadData(), window.ElectionArchive.loadPlotly()]);
    const builtAt = typeof master.builtAt === 'string' ? new Date(master.builtAt) : null;
    if (builtAt && Number.isFinite(builtAt.getTime())) {
      const date = byId('data-updated-time');
      date.dateTime = builtAt.toISOString();
      date.textContent = new Intl.DateTimeFormat('zh-TW', {timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(builtAt);
      byId('data-updated').hidden = false;
    }
    populateNavigation(master);
    plotly = library?.react ? library : window.Plotly;
    if (!plotly?.react) throw new Error('Plotly 尚未載入。');
    const result = await statistics.buildRecords(master);
    const records = Array.isArray(result) ? result : result?.records;
    if (!Array.isArray(records)) throw new Error('統計紀錄格式不符。');
    state.records = records.filter(record => Number.parseInt(record.year, 10) >= 2012);
    populateFilters();
    populateViewTabs();
    byId('verified-time-only').addEventListener('change',event=>{state.verifiedOnly=event.target.checked;requestRender(false);});
    byId('clear-bin').addEventListener('click', clearBin);
    state.loaded = true;
    requestRender();
  }

  setupNavigation();
  void initialize().catch(showError);
})();
