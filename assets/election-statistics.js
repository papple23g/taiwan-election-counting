(function (global) {
  'use strict';

  const broadcasterAliases = {
    pts: ['pts', '公視'], pts_2016: ['pts', '公視'], pts_2020: ['pts', '公視'], pts_2018: ['pts', '公視'], pts2014: ['pts', '公視'],
    cts: ['cts', '華視'], cts_2020: ['cts', '華視'], cts17_2018: ['cts', '華視'],
    ttv: ['ttv', '台視'], ttv_2018: ['ttv', '台視'],
    sanli: ['sanli', '三立'], setn_2018: ['sanli', '三立'], set2014: ['sanli', '三立'],
    nexttv: ['nexttv', '壹電視'], nexttv2014: ['nexttv', '壹電視'],
    era: ['era', '年代'], era_2024: ['era', '年代'], era_2018: ['era', '年代'],
    ctv: ['ctv', '中視'], ctv_2018: ['ctv', '中視'],
    ftv: ['ftv', '民視'], ftv_2020: ['ftv', '民視'], ftv_2018: ['ftv', '民視'],
    tvbs: ['tvbs', 'TVBS新聞網'], tvbs_2018: ['tvbs', 'TVBS新聞網'], 'tvbs-tv': ['tvbs-tv', 'TVBS新聞台'],
    ebc: ['ebc', '東森'], cti: ['cti', '中天'], hakka2014: ['hakka', '客家電視'],
    udn: ['udn', 'udn聯合影音'], udn_2018: ['udn', 'udn聯合影音'],
    nextmag2014: ['nextmag', '壹週刊／蘋果Live'], ustv2014: ['ustv', '非凡'], ettoday: ['ettoday', 'ETtoday'],
    cec: ['cec', '中選會']
  };

  function median(values) {
    const sorted = values.filter(Number.isFinite).slice().sort((left, right) => left - right);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }

  function clockMillis(value) {
    if (typeof value !== 'string' || !value) return null;
    const millis = Date.parse(/[Zz]$|[+-]\d{2}:\d{2}$/.test(value) ? value : value + 'Z');
    return Number.isFinite(millis) ? millis : null;
  }

  function timeDetails(row, electionDate, archive) {
    const axis = archive.rowAxisX(row);
    const millis = clockMillis(axis);
    const verification = typeof row.timeVerification === 'object' ? row.timeVerification?.status : row.timeVerification;
    let timeQuality = 'missing';
    if (millis !== null) {
      if (row.timeBasis === 'youtube_live_start_unverified' || /unverified|unresolved|metadata_only/.test(verification || '')) timeQuality = 'unverified';
      else if (row.timeEstimate || row.clockPrecision === 'estimated') timeQuality = 'estimated';
      else if (/checked|verified|calibrated|direct_screen_clock/.test(verification || '')
        || ['on_screen_clock', 'screen_clock', 'screen_clock_read', 'same_video_screen_clock_calibrated', 'calibrated_video_offset', 'verified_live_chat_replay', 'youtube_live_chat_timestamp_offset'].includes(row.timeBasis)) timeQuality = 'verified';
      else timeQuality = 'unverified';
    } else if (row.x || row.time || row.rawTime || row.onScreenClock) timeQuality = 'unverified';
    const midnight = clockMillis(electionDate ? electionDate + 'T00:00:00' : null);
    return {time: millis === null ? null : axis, millis, timeQuality,
      clockMinutes: millis === null || midnight === null ? null : (millis - midnight) / 60000};
  }

  function completeVotes(row, candidates, archive) {
    if (!archive.isAnalysisEligible(row) || !candidates.length) return null;
    const values = candidates.map(candidate => row.votes?.[candidate.id]);
    if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) return null;
    const total = values.reduce((sum, value) => sum + value, 0);
    return Number.isSafeInteger(total) && total > 0 ? {values, total} : null;
  }

  function compareObservations(left, right) {
    if (left.video && left.video === right.video && left.offset !== null && right.offset !== null) return Math.sign(left.offset - right.offset);
    if (left.millis !== null && right.millis !== null) return Math.sign(left.millis - right.millis);
    return null;
  }

  function orderedGroups(rows) {
    const parents = rows.map((row, index) => index);
    const root = index => {
      while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; }
      return index;
    };
    for (let index = 0; index < rows.length; index++) {
      for (let other = index + 1; other < rows.length; other++) {
        const comparison = compareObservations(rows[index], rows[other]);
        if (comparison === null) return {reason: '跨影片或缺少影片位置的完整觀測無法確認先後。'};
        if (comparison === 0) parents[root(other)] = root(index);
      }
    }
    const byRoot = new Map();
    rows.forEach((row, index) => {
      const key = root(index);
      if (!byRoot.has(key)) byRoot.set(key, {items: []});
      byRoot.get(key).items.push(row);
    });
    const groups = [...byRoot.values()];
    for (const group of groups) {
      for (let index = 0; index < group.items.length; index++) {
        for (let other = index + 1; other < group.items.length; other++) {
          if (compareObservations(group.items[index], group.items[other]) !== 0) return {reason: '同時畫面無法唯一對齊跨影片時間與同片影片位置的先後，無法判定。'};
        }
      }
    }
    for (const group of groups) group.items.sort((left, right) => String(left.row.id).localeCompare(String(right.row.id)));
    groups.sort((left, right) => compareObservations(left.items[0], right.items[0]));
    for (let index = 0; index < groups.length; index++) {
      for (let other = index + 1; other < groups.length; other++) {
        if (groups[index].items.some(left => groups[other].items.some(right => compareObservations(left, right) > 0))) return {reason: '畫面時間與同片影片位置的先後互相矛盾，無法判定。'};
      }
    }
    for (const group of groups) {
      const values = JSON.stringify(group.items[0].values);
      group.ambiguous = group.items.some(item => JSON.stringify(item.values) !== values);
    }
    return {groups};
  }

  function winnerInfo(context) {
    const candidates = context.candidates || [];
    const votes = candidates.map(candidate => context.ratioPlot?.finalVotes?.[candidate.id]);
    if (!votes.length || !votes.every(value => Number.isSafeInteger(value) && value >= 0)) return null;
    const total = votes.reduce((sum, value) => sum + value, 0);
    const highest = Math.max(...votes);
    if (!Number.isSafeInteger(total) || total <= 0 || votes.filter(value => value === highest).length !== 1) return null;
    const index = votes.indexOf(highest);
    return {index, candidate: candidates[index], total};
  }

  function findThreshold(complete, context, station, winner) {
    if (!complete.length) return {status: 'no-complete', reason: '沒有固定候選人組皆可讀且合計大於零的完整觀測。', threshold: null};
    if (!winner) return {status: 'inconclusive', reason: '官方最終票數不足以確認唯一當選人或固定候選人組總票數。', threshold: null};
    const ordered = orderedGroups(complete);
    if (ordered.reason) return {status: 'inconclusive', reason: ordered.reason, threshold: null};
    const groups = ordered.groups;
    if (groups.length < 2) return {status: 'inconclusive', reason: '只有一個不同觀測時點，無法確認後續是否持續領先。', threshold: null};
    const exclusive = group => !group.ambiguous && group.items[0].values.every((value, index) => index === winner.index || group.items[0].values[winner.index] > value);
    const finalGroup = groups[groups.length - 1];
    if (!exclusive(finalGroup)) return {status: 'inconclusive', reason: finalGroup.ambiguous ? '最後觀測時點有互相衝突的完整票組，無法確認領先者。' : '最後完整觀測仍非官方當選人獨占第一。', threshold: null};
    let lastBarrier = -1;
    groups.forEach((group, index) => { if (!exclusive(group)) lastBarrier = index; });
    const first = groups[lastBarrier + 1].items[0];
    const previous = lastBarrier >= 0 ? groups[lastBarrier].items[0] : null;
    const final = finalGroup.items[0];
    const leftCensored = lastBarrier < 0;
    return {status: 'confirmed', reason: leftCensored ? '首個完整觀測已由當選人獨占第一，且此後完整觀測皆持續領先；實際起點可能更早。' : '最後一次未由當選人獨占第一之後，所有後續完整觀測皆由當選人獨占第一。',
      threshold: {rowId: first.row.id, totalVotes: first.total, progress: first.total * 100 / winner.total,
        time: first.time, clockMinutes: first.clockMinutes, timeQuality: first.timeQuality, leftCensored,
        previousRowId: previous?.row.id ?? null, finalRowId: final.row.id,
        frameHref: first.row.frameHref || null, videoHref: first.video, videoOffset: first.offset,
        previousFrameHref: previous?.row.frameHref || null, finalFrameHref: final.row.frameHref || null}};
  }

  function buildRecords(payload, archive = global.ElectionArchive) {
    if (!archive || typeof archive.trendSummary !== 'function' || typeof archive.rowAxisX !== 'function' || typeof archive.isPrimaryPresentation !== 'function') throw new Error('需要先載入 ElectionArchive 統計共用函數。');
    const elections = payload.elections || {[payload.electionYear || '']: payload};
    const records = [];
    for (const [year, election] of Object.entries(elections)) {
      if (!(Number.parseInt(year, 10) >= 2012)) continue;
      const mayor = Array.isArray(election.counties) || String(year).endsWith('-mayors') || election.kind === 'mayors';
      const counties = mayor ? election.counties || [] : [{id: 'national', name: '全國', ...election}];
      for (const county of counties) {
        const context = {...election, ...county, electionDate: county.electionDate || election.electionDate,
          ratioUnit: county.ratioUnit || election.ratioUnit};
        const candidates = context.candidates || [];
        const winner = winnerInfo(context);
        const countyId = mayor ? county.id : 'national';
        for (const station of context.stations || []) {
          const sourceName = station.name || station.id;
          const broadcaster = broadcasterAliases[station.carrierSourceId] || broadcasterAliases[station.id] || [station.carrierSourceId || station.id, station.carrierName || sourceName];
          const complete = [];
          const readable = [];
          for (const row of station.observations || []) {
            if (!archive.isPrimaryPresentation(row)) continue;
            const time = timeDetails(row, context.electionDate, archive);
            if (candidates.some(candidate => Number.isSafeInteger(row.votes?.[candidate.id]) && row.votes[candidate.id] >= 0)) readable.push(time);
            const votes = completeVotes(row, candidates, archive);
            if (votes) complete.push({...votes, ...time, row, video: row.videoHref || station.videoHref || null,
              offset: Number.isFinite(row.videoOffset) && row.videoOffset >= 0 ? row.videoOffset : null});
          }
          const clocks = readable.filter(time => time.millis !== null).sort((left, right) => left.millis - right.millis);
          const result = findThreshold(complete, context, station, winner);
          const query = new URLSearchParams({year, ...(mayor ? {county: String(countyId)} : {}), source: station.id});
          records.push({key: JSON.stringify([year, countyId, station.id]), year,
            yearLabel: Number.parseInt(year, 10) + ' 年' + (mayor ? '縣市首長' : '總統') + '選舉',
            electionDate: context.electionDate, countyId, countyName: mayor ? county.name : '全國',
            sourceId: station.id, sourceName, sourceLabel: station.tallyOrigin ? sourceName + '(' + station.tallyOrigin + ')' : sourceName,
            broadcasterId: broadcaster[0], broadcasterName: broadcaster[1], isReference: broadcaster[0] === 'cec',
            winnerName: winner?.candidate.name || winner?.candidate.id || null,
            completeCount: complete.length, readableCount: readable.length,
            coverageStart: clocks[0]?.time || null, coverageEnd: clocks[clocks.length - 1]?.time || null,
            ...result, error: archive.trendSummary(context, station), curveHref: 'index.html?' + query.toString()});
        }
      }
    }
    return records;
  }

  function aggregateRankings(records) {
    const broadcasters = new Map();
    for (const record of records) {
      let entry = broadcasters.get(record.broadcasterId);
      if (!entry) {
        entry = {id: record.broadcasterId, name: record.broadcasterName, isReference: record.isReference === true, entries: [], races: new Map()};
        broadcasters.set(entry.id, entry);
      }
      entry.entries.push(record);
      entry.isReference ||= record.isReference === true;
      if (!Number.isFinite(record.error?.value)) continue;
      const raceKey = JSON.stringify([record.year, record.countyId]);
      let race = entry.races.get(raceKey);
      if (!race) { race = {year: record.year, values: [], coverages: []}; entry.races.set(raceKey, race); }
      race.values.push(record.error.value);
      if (Number.isFinite(record.error.coveragePercent)) race.coverages.push(record.error.coveragePercent);
    }
    const ranked = [...broadcasters.values()].map(entry => {
      const races = [...entry.races.values()];
      const values = races.map(race => mean(race.values));
      const coverages = races.map(race => mean(race.coverages)).filter(Number.isFinite);
      return {id: entry.id, name: entry.name, isReference: entry.isReference,
        meanError: mean(values), medianError: median(values), raceCount: races.length,
        years: [...new Set(races.map(race => race.year))].sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10) || String(left).localeCompare(String(right))),
        coveragePercent: mean(coverages), entries: entry.entries, rank: null};
    });
    ranked.sort((left, right) => (left.meanError === null) - (right.meanError === null)
      || (left.meanError ?? 0) - (right.meanError ?? 0) || left.name.localeCompare(right.name, 'zh-Hant'));
    let rank = 0;
    for (const entry of ranked) if (!entry.isReference && entry.meanError !== null) entry.rank = ++rank;
    return ranked;
  }

  global.ElectionStatistics = Object.freeze({buildRecords, aggregateRankings, median});
})(typeof window === 'undefined' ? globalThis : window);
