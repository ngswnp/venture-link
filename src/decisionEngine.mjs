const PROVENANCE_WEIGHTS = {
  FILING: 1.0,
  PRIMARY: 0.82,
  PRESS: 0.45,
  AGGREGATOR: 0.35
};

const SOURCE_RANK_ORDER = {
  FILING: 4,
  PRIMARY: 3,
  PRESS: 2,
  AGGREGATOR: 1
};

const EXECUTIVE_RELATIONS = new Set([
  'FOUNDED',
  'CO_FOUNDED',
  'IS_CEO_OF',
  'IS_CTO_OF',
  'IS_COO_OF',
  'IS_CFO_OF',
  'IS_PRESIDENT_OF',
  'IS_VICEPRESIDENT_OF',
  'IS_BOARD_MEMBER_OF'
]);

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateLine(text = '', maxLen = 95) {
  const s = normalizeText(text);
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1).trimEnd()}…`;
}

function rankUpper(rank) {
  const r = String(rank || 'AGGREGATOR').toUpperCase();
  return PROVENANCE_WEIGHTS[r] ? r : 'AGGREGATOR';
}

function computeTimingRecencyBoost(dateStr = '') {
  const yr = Number(String(dateStr || '').slice(0, 4));
  if (!Number.isFinite(yr) || yr <= 0) return 0.9;
  if (yr >= 2026) return 1.3;
  if (yr >= 2025) return 1.15;
  if (yr >= 2024) return 1.0;
  return 0.85;
}

function scoreEdgeSignal(edge, group) {
  const rank = rankUpper(edge.topSourceRank);
  let weight = PROVENANCE_WEIGHTS[rank] || 0.35;
  if (edge.isSharedBridge) weight *= 1.5;
  if (edge.isLead || EXECUTIVE_RELATIONS.has(String(edge.relation || '').toUpperCase())) {
    weight *= 1.25;
  }
  if (edge.date) weight *= 1.12;
  if (group === 'timing') {
    weight *= computeTimingRecencyBoost(edge.date);
    if (edge.isAnomaly) weight *= 0.5;
  }
  return Math.round(weight * 100) / 100;
}

function buildProvenanceMix(records = []) {
  const counts = { filing: 0, primary: 0, press: 0, aggregator: 0, total: 0, verifiedSharePct: 0 };
  for (const r of records) {
    const rank = rankUpper(r.sourceRank);
    counts.total += 1;
    if (rank === 'FILING') counts.filing += 1;
    else if (rank === 'PRIMARY') counts.primary += 1;
    else if (rank === 'PRESS') counts.press += 1;
    else counts.aggregator += 1;
  }
  if (counts.total > 0) {
    counts.verifiedSharePct = Math.round(((counts.filing + counts.primary) / counts.total) * 100);
  }
  return counts;
}

function balanceRecordsAcrossHubs(records = [], focalIds = [], maxItems = 8) {
  if (records.length <= maxItems) return records;
  const sortBySignal = (a, b) =>
    Number(Boolean(b.isSharedBridge)) - Number(Boolean(a.isSharedBridge)) ||
    (b.signalWeight || 0) - (a.signalWeight || 0) ||
    (SOURCE_RANK_ORDER[rankUpper(b.sourceRank)] || 0) - (SOURCE_RANK_ORDER[rankUpper(a.sourceRank)] || 0) ||
    String(b.date || '').localeCompare(String(a.date || ''));

  const shared = records.filter((r) => r.isSharedBridge).sort(sortBySignal);
  const selected = [];
  const seenIds = new Set();
  const seenActorHubPairs = new Set();
  const actorHubKey = (r) => `${r.canonicalFrom}=>${r.canonicalTo}`;

  for (const item of shared) {
    if (selected.length >= Math.min(maxItems, Math.max(4, Math.ceil(maxItems * 0.65)))) break;
    const pk = actorHubKey(item);
    if (seenActorHubPairs.has(pk)) continue;
    seenActorHubPairs.add(pk);
    selected.push(item);
    seenIds.add(item.id);
  }

  const perHubQueues = focalIds.map((fid) =>
    records
      .filter((r) => !seenIds.has(r.id) && (r.focalEntityId === fid || (r.sharedHubIds || []).includes(fid)))
      .sort(sortBySignal)
  );
  let idx = 0;
  let guard = 0;
  while (selected.length < maxItems && perHubQueues.some((q) => q.length > 0) && guard < records.length * 3) {
    guard += 1;
    const queue = perHubQueues[idx % perHubQueues.length];
    idx += 1;
    if (!queue || !queue.length) continue;
    const next = queue.shift();
    if (next && !seenIds.has(next.id) && !seenActorHubPairs.has(actorHubKey(next))) {
      seenActorHubPairs.add(actorHubKey(next));
      selected.push(next);
      seenIds.add(next.id);
    }
  }

  if (selected.length < maxItems) {
    for (const item of [...records].sort(sortBySignal)) {
      if (selected.length >= maxItems) break;
      if (!seenIds.has(item.id)) {
        selected.push(item);
        seenIds.add(item.id);
      }
    }
  }
  return selected;
}

function computeSaturatedSignalScore(records = [], sharedCount = 0) {
  if (!records.length) return 0;
  const weightedSum = records.reduce((sum, r) => sum + (Number(r.signalWeight) || 0.35), 0);
  const base = 100 * (1 - Math.exp(-weightedSum / 3.4));
  const sharedBoost = Math.min(12, sharedCount * 3);
  return Math.max(8, Math.min(98, Math.round(base * 0.88 + sharedBoost)));
}

function collectSourceIds(items = [], limit = 12) {
  const out = [];
  const seen = new Set();
  const maxDepth = Math.max(0, ...items.map((item) => (item?.sourceIds || []).length));
  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const item of items) {
      const sid = item?.sourceIds?.[depth];
      const id = String(sid || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Builds deterministic, provenance-weighted 4-factor investment decision intelligence
 * from a verified entity bridge graph (`buildEntityBridgeMap` nodes, edges, timing, anomalies).
 */
export function buildDecisionIntelligence({
  focalEntities = [],
  nodes = [],
  edges = [],
  timingEventsByEntity = {},
  sourcesById = {},
  anomalies = []
} = {}) {
  const focalList = (Array.isArray(focalEntities) ? focalEntities : []).filter((e) => e?.id && e?.name);
  const focalIds = focalList.map((e) => String(e.id));
  const focalById = new Map(focalList.map((e) => [String(e.id), e]));
  const nodeById = new Map((Array.isArray(nodes) ? nodes : []).map((n) => [String(n.id), n]));
  const validEdges = (Array.isArray(edges) ? edges : []).filter((e) => e && !String(e.id || '').startsWith('tree-spoke-'));

  const nodeLabel = (id) => normalizeText(nodeById.get(String(id))?.label || nodeById.get(String(id))?.name || focalById.get(String(id))?.name || id);
  const resolveSharedHubNames = (ids = []) => ids.map((id) => focalById.get(String(id))?.name || nodeLabel(id)).filter(Boolean);

  const rawByGroup = { access: [], lineage: [], timing: [], caution: [] };
  for (const edge of validEdges) {
    const group = ['access', 'lineage', 'timing', 'caution'].includes(edge.contributionGroup)
      ? edge.contributionGroup
      : 'access';
    const fromId = String(edge.from || '');
    const toId = String(edge.to || '');
    const fromName = nodeLabel(fromId);
    const toName = nodeLabel(toId);
    const nonFocalId = !focalById.has(toId) ? toId : !focalById.has(fromId) ? fromId : toId;
    const sharedHubIds = Array.isArray(edge.sharedByFocalEntityIds) ? edge.sharedByFocalEntityIds.map(String) : [];
    const sharedHubs = resolveSharedHubNames(sharedHubIds);
    const sourceIds = [...new Set([...(Array.isArray(edge.sourceIds) ? edge.sourceIds : []), edge.sourceId].filter(Boolean).map(String))];
    const sourceRank = rankUpper(edge.topSourceRank);
    const relationText = normalizeText(edge.label || edge.relation || 'Verified link');

    rawByGroup[group].push({
      id: String(edge.id || `${group}-${fromId}-${toId}`),
      edgeId: String(edge.id || ''),
      nodeId: nonFocalId,
      focalEntityId: String(edge.focalEntityId || (focalById.has(fromId) ? fromId : toId)),
      type: normalizeText(edge.relation || edge.bridgeFamily || relationText),
      path: `${fromName} → ${toName}`,
      canonicalFrom: fromName,
      canonicalTo: toName,
      relation: relationText,
      detail: normalizeText(edge.detail || edge.whyMatters || relationText),
      date: edge.date ? String(edge.date).slice(0, 10) : null,
      sourceRank,
      isSharedBridge: Boolean(edge.isSharedBridge),
      isLead: Boolean(edge.isLead),
      isAnomaly: Boolean(edge.isAnomaly),
      sharedHubIds,
      sharedHubs,
      signalWeight: scoreEdgeSignal(edge, group),
      sourceIds
    });
  }

  // Synthesize analyst-relevant Caution signals (dual-sided investors, shared talent migration, anomalies)
  const syntheticCautionRecords = [];
  const seenCautionKeys = new Set();

  if (focalIds.length >= 2) {
    // 1. Dual-sided investor conflict exposure
    const investorHubs = new Map();
    for (const rec of rawByGroup.access) {
      if (!rec.isSharedBridge || !/invest|lead|back/i.test(`${rec.type} ${rec.relation}`)) continue;
      const invNode = nodeById.get(rec.nodeId);
      if (!invNode || String(invNode.entityType || '').toLowerCase() === 'person') continue;
      const key = `dual-inv:${invNode.id}`;
      if (!investorHubs.has(key)) {
        investorHubs.set(key, {
          nodeId: invNode.id,
          name: nodeLabel(invNode.id),
          hubs: new Set(rec.sharedHubs),
          hubIds: new Set(rec.sharedHubIds),
          edgeId: rec.edgeId,
          sourceIds: new Set(rec.sourceIds),
          bestRank: rec.sourceRank
        });
      } else {
        const entry = investorHubs.get(key);
        for (const h of rec.sharedHubs) entry.hubs.add(h);
        for (const hid of rec.sharedHubIds) entry.hubIds.add(hid);
        for (const sid of rec.sourceIds) entry.sourceIds.add(sid);
        if ((SOURCE_RANK_ORDER[rec.sourceRank] || 0) > (SOURCE_RANK_ORDER[entry.bestRank] || 0)) {
          entry.bestRank = rec.sourceRank;
        }
      }
    }
    const dualInvestors = [...investorHubs.values()].filter((v) => v.hubs.size >= 2);
    if (dualInvestors.length > 0) {
      const topInvestors = dualInvestors
        .sort((a, b) => (SOURCE_RANK_ORDER[b.bestRank] || 0) - (SOURCE_RANK_ORDER[a.bestRank] || 0))
        .slice(0, 3);
      const names = topInvestors.map((i) => i.name).join(', ');
      const firstInv = topInvestors[0];
      const hubList = [...firstInv.hubs];
      const cKey = `dual-investors:${hubList.join('|')}`;
      if (!seenCautionKeys.has(cKey)) {
        seenCautionKeys.add(cKey);
        syntheticCautionRecords.push({
          id: `caution:dual-investors`,
          edgeId: firstInv.edgeId,
          nodeId: firstInv.nodeId,
          focalEntityId: [...firstInv.hubIds][0] || focalIds[0],
          type: 'DUAL_SIDED_INVESTOR_CONFLICT',
          path: `${names} → ${hubList.join(' & ')}`,
          canonicalFrom: names,
          canonicalTo: hubList.join(' & '),
          relation: 'Shared cap-table exposure',
          detail: `${dualInvestors.length} investor(s) (${names}) hold stakes across ${hubList.join(' and ')}; verify Chinese walls and information rights.`,
          date: null,
          sourceRank: firstInv.bestRank,
          isSharedBridge: true,
          isLead: false,
          isAnomaly: false,
          sharedHubIds: [...firstInv.hubIds],
          sharedHubs: hubList,
          signalWeight: 1.25,
          sourceIds: [...firstInv.sourceIds].slice(0, 6)
        });
      }
    }

    // 2. Cross-hub founder/executive overlap
    const sharedPeople = new Map();
    for (const rec of rawByGroup.lineage) {
      if (!rec.isSharedBridge) continue;
      const pNode = nodeById.get(rec.nodeId);
      if (!pNode || String(pNode.entityType || '').toLowerCase() !== 'person') continue;
      if (!sharedPeople.has(pNode.id)) {
        sharedPeople.set(pNode.id, {
          nodeId: pNode.id,
          name: nodeLabel(pNode.id),
          hubs: new Set(rec.sharedHubs),
          hubIds: new Set(rec.sharedHubIds),
          edgeId: rec.edgeId,
          sourceIds: new Set(rec.sourceIds),
          bestRank: rec.sourceRank
        });
      } else {
        const entry = sharedPeople.get(pNode.id);
        for (const h of rec.sharedHubs) entry.hubs.add(h);
        for (const sid of rec.sourceIds) entry.sourceIds.add(sid);
      }
    }
    const talentList = [...sharedPeople.values()].filter((p) => p.hubs.size >= 2);
    if (talentList.length > 0) {
      const names = talentList.slice(0, 3).map((p) => p.name).join(', ');
      const firstPerson = talentList[0];
      const hubList = [...firstPerson.hubs];
      syntheticCautionRecords.push({
        id: 'caution:talent-overlap',
        edgeId: firstPerson.edgeId,
        nodeId: firstPerson.nodeId,
        focalEntityId: [...firstPerson.hubIds][0] || focalIds[0],
        type: 'CROSS_HUB_TALENT_OVERLAP',
        path: `${names} ↔ ${hubList.join(' & ')}`,
        canonicalFrom: names,
        canonicalTo: hubList.join(' & '),
        relation: 'Executive / founder overlap',
        detail: `${talentList.length} founder/executive(s) (${names}) hold mapped roles across ${hubList.join(' and ')}; check IP assignment and non-compete exposure.`,
        date: null,
        sourceRank: firstPerson.bestRank,
        isSharedBridge: true,
        isLead: false,
        isAnomaly: false,
        sharedHubIds: [...firstPerson.hubIds],
        sharedHubs: hubList,
        signalWeight: 1.15,
        sourceIds: [...firstPerson.sourceIds].slice(0, 6)
      });
    }
  }

  // 3. Analyst-relevant provenance & round-sequence anomalies
  const relevantAnomalyKinds = new Set(['timing_anomaly', 'quarantined_comention', 'low_confidence_comention']);
  const dataAnomalies = [];
  const seenAnomalyPaths = new Set();
  for (const rawAnom of Array.isArray(anomalies) ? anomalies : []) {
    if (!rawAnom || !relevantAnomalyKinds.has(rawAnom.kind)) continue;
    const key = `${rawAnom.kind}:${normalizeText(rawAnom.path)}`;
    if (seenAnomalyPaths.has(key)) continue;
    seenAnomalyPaths.add(key);
    const cleaned = {
      kind: rawAnom.kind,
      relation: rawAnom.relation || 'DATA_ANOMALY',
      path: normalizeText(rawAnom.path || 'Cala record'),
      detail: normalizeText(rawAnom.detail || 'Flagged Cala data inconsistency.'),
      date: rawAnom.date || null,
      sourceRank: rankUpper(rawAnom.sourceRank || 'PRESS'),
      sourceIds: Array.isArray(rawAnom.sourceIds) ? rawAnom.sourceIds.map(String).filter(Boolean).slice(0, 4) : []
    };
    dataAnomalies.push(cleaned);
    if (rawAnom.kind === 'timing_anomaly' && cleaned.sourceIds.length > 0 && syntheticCautionRecords.length < 5) {
      syntheticCautionRecords.push({
        id: `caution:anom:${dataAnomalies.length}`,
        edgeId: '',
        nodeId: '',
        focalEntityId: focalIds[0] || '',
        type: 'ROUND_SEQUENCE_ANOMALY',
        path: cleaned.path,
        canonicalFrom: cleaned.path,
        canonicalTo: 'Chronology conflict',
        relation: 'Round sequence anomaly',
        detail: cleaned.detail,
        date: cleaned.date,
        sourceRank: cleaned.sourceRank,
        isSharedBridge: false,
        isLead: false,
        isAnomaly: true,
        sharedHubIds: [],
        sharedHubs: [],
        signalWeight: 0.85,
        sourceIds: cleaned.sourceIds
      });
    }
  }

  const allGroupRecords = {
    access: rawByGroup.access,
    lineage: rawByGroup.lineage,
    timing: rawByGroup.timing,
    caution: [...rawByGroup.caution, ...syntheticCautionRecords]
  };

  // Build per-factor quantitative outputs
  const factorConfigs = {
    access: {
      label: 'Access',
      defaultQuestion: 'Which shared syndicate investor or strategic partner offers the cleanest warm intro?'
    },
    lineage: {
      label: 'Lineage',
      defaultQuestion: 'Are the mapped founder and executive tenures current, and who provides a direct reference?'
    },
    timing: {
      label: 'Timing',
      defaultQuestion: 'Do the latest dated financings and corporate milestones create an actionable entry window?'
    },
    caution: {
      label: 'Caution',
      defaultQuestion: 'What competitive overlap, shared cap-table conflict, or sequence anomaly requires verification?'
    }
  };

  const factors = {};
  for (const group of ['access', 'lineage', 'timing', 'caution']) {
    const records = allGroupRecords[group] || [];
    const rankedRecords = balanceRecordsAcrossHubs(records, focalIds, 8);
    const sharedRecords = records.filter((r) => r.isSharedBridge);
    const uniqueBridgeEntities = [...new Set(records.map((r) => r.canonicalFrom).filter((n) => !focalList.some((f) => f.name === n)))];
    const sharedBridgeNames = [...new Set(
      [...rankedRecords.filter((r) => r.isSharedBridge), ...sharedRecords].map((r) => {
        const n = nodeById.get(r.nodeId);
        return n?.label || n?.name || r.canonicalFrom;
      }).filter(Boolean)
    )];
    const provenanceMix = buildProvenanceMix(records);
    const signalStrength = group === 'caution'
      ? Math.min(95, records.length ? Math.max(28, computeSaturatedSignalScore(records, sharedRecords.length)) : 0)
      : computeSaturatedSignalScore(records, sharedRecords.length);

    let tier = 'No Signal';
    let tierClass = 'is-neutral';
    if (group === 'caution') {
      if (records.length >= 3 || rawByGroup.caution.length > 0 && syntheticCautionRecords.length > 0) {
        tier = 'Risk · Watch';
        tierClass = 'is-caution';
      } else if (records.length > 0) {
        tier = 'Caution · Check';
        tierClass = 'is-caution';
      } else {
        tier = 'Clear';
        tierClass = 'is-beneficial';
      }
    } else if (signalStrength >= 70 || (sharedRecords.length >= 2 && records.length >= 4)) {
      tier = 'Strong';
      tierClass = 'is-beneficial';
    } else if (signalStrength >= 40 || records.length >= 3) {
      tier = group === 'timing' ? 'Active' : 'Moderate';
      tierClass = 'is-beneficial';
    } else if (records.length > 0) {
      tier = group === 'timing' ? 'Catalyst' : 'Signal';
      tierClass = 'is-beneficial';
    }

    const hubCoverage = focalList.map((f) => ({
      id: String(f.id),
      name: f.name,
      count: records.filter((r) => r.focalEntityId === String(f.id)).length
    }));
    const uniqueSources = collectSourceIds(records, 32).length;
    const datedCount = records.filter((r) => Boolean(r.date)).length;
    const undatedCount = Math.max(0, records.length - datedCount);

    let headline = '';
    let investmentImpact = '';
    let actionableCheck = factorConfigs[group].defaultQuestion;

    if (group === 'access') {
      const leadNames = sharedBridgeNames.slice(0, 2);
      const directNames = rankedRecords.slice(0, 2).map((r) => (focalById.has(r.nodeId) ? r.canonicalFrom : nodeLabel(r.nodeId)));
      if (sharedRecords.length > 0) {
        headline = truncateLine(`${sharedRecords.length} shared investor/partner paths (${leadNames.join(', ')})`);
        investmentImpact = `Shared cap-table & strategic backers (${leadNames.join(', ')}) create verified warm-intro leverage across mapped hubs.`;
        actionableCheck = `Verify whether ${leadNames[0]} can provide a warm reference and confirm current board/observer status.`;
      } else if (records.length > 0) {
        headline = truncateLine(`${records.length} direct backer/partner links (${[...new Set(directNames)].join(', ')})`);
        investmentImpact = `Direct institutional and strategic backers (${[...new Set(directNames)].join(', ')}) establish concrete outreach routes.`;
        actionableCheck = `Confirm whether ${directNames[0] || uniqueBridgeEntities[0] || 'a mapped backer'} remains active for introductions.`;
      } else {
        headline = 'No investor or strategic partner paths found in Cala.';
        investmentImpact = 'No mapped access route to influence outreach.';
        actionableCheck = 'Verify cap-table backers and strategic partners outside Cala before outreach.';
      }
    } else if (group === 'lineage') {
      const execNames = [...new Set(rankedRecords.map((r) => nodeLabel(r.nodeId)).filter(Boolean))].slice(0, 2);
      if (sharedRecords.length > 0) {
        headline = truncateLine(`${sharedBridgeNames.length} cross-hub leaders (${sharedBridgeNames.slice(0, 2).join(', ')})`);
        investmentImpact = `Verified founder/executive bridges (${sharedBridgeNames.slice(0, 2).join(', ')}) give direct back-channel team diligence.`;
        actionableCheck = `Confirm whether ${sharedBridgeNames[0]}'s departure and current role dates match statutory records.`;
      } else if (records.length > 0) {
        headline = truncateLine(`${records.length} leadership & founder links (${execNames.join(', ')})`);
        investmentImpact = `Documented leadership roles (${execNames.join(', ')}) support operator reference checks; execution still requires proof.`;
        actionableCheck = `Verify whether ${execNames[0] || 'mapped leadership'} holds active decision authority in current filings.`;
      } else {
        headline = 'No founder or executive lineage links indexed in Cala.';
        investmentImpact = 'Team background and operator ties remain unverified on this map.';
        actionableCheck = 'Confirm founder prior-employment history and technical leadership outside Cala.';
      }
    } else if (group === 'timing') {
      const sortedDated = [...records].filter((r) => r.date).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const latest = sortedDated[0] || rankedRecords[0];
      const latestLabel = latest ? `${latest.canonicalFrom} ${latest.relation}`.trim() : '';
      const anomCount = dataAnomalies.filter((a) => a.kind === 'timing_anomaly').length;
      if (records.length > 0) {
        headline = truncateLine(
          `${records.length} dated milestones${latest?.date ? ` · latest ${latest.date}` : ''}${anomCount ? ` (${anomCount} flag)` : ''}`
        );
        investmentImpact = `Dated catalysts${latest?.date ? ` through ${latest.date}` : ''} establish financing cadence${anomCount ? '; verify flagged sequence conflict' : ''}.`;
        const cleanRelation = latest
          ? String(latest.relation || '').replace(/\s*\(\d{4}(?:-\d{2}-\d{2})?\)\s*$/, '').trim()
          : '';
        actionableCheck = latest
          ? `Confirm whether ${latest.canonicalFrom}'s ${cleanRelation || 'corporate milestone'} (${latest.date || 'dated'}) reflects the latest completed corporate event.`
          : factorConfigs.timing.defaultQuestion;
      } else {
        headline = 'No dated funding milestones or corporate events verified in Cala.';
        investmentImpact = 'No mapped timing catalyst to confirm fundraising urgency.';
        actionableCheck = 'Verify most recent financing date and cash runway directly with management.';
      }
    } else {
      const topCaution = rankedRecords[0];
      if (records.length > 0) {
        const flags = [];
        if (rawByGroup.caution.length > 0) flags.push('industry overlap');
        if (syntheticCautionRecords.some((r) => r.type === 'DUAL_SIDED_INVESTOR_CONFLICT')) flags.push('dual-sided investors');
        if (syntheticCautionRecords.some((r) => r.type === 'CROSS_HUB_TALENT_OVERLAP')) flags.push('shared talent');
        if (syntheticCautionRecords.some((r) => r.type === 'ROUND_SEQUENCE_ANOMALY')) flags.push('round-order flag');
        headline = truncateLine(`${records.length} risk flag(s): ${flags.join(' · ') || topCaution.relation}`);
        investmentImpact = `${topCaution.detail}`;
        actionableCheck = `Verify whether ${topCaution.path} creates competitive conflict, governance restriction, or data inconsistency.`;
      } else {
        headline = 'No competitive conflict, dual-backer, or sequence flags detected.';
        investmentImpact = 'No mapped conflict surfaced; absence of Cala flags does not rule out commercial risk.';
        actionableCheck = 'Verify customer overlap and IP disputes not indexed in Cala.';
      }
    }

    factors[group] = {
      group,
      label: factorConfigs[group].label,
      count: records.length,
      sharedCount: sharedRecords.length,
      signalStrength,
      tier,
      tierClass,
      headline,
      investmentImpact,
      actionableCheck,
      provenanceMix,
      coverage: {
        totalPaths: records.length,
        sharedBridgeCount: sharedRecords.length,
        hubCoverage,
        uniqueSources,
        datedCount,
        undatedCount
      },
      sourceIds: collectSourceIds(rankedRecords, 12),
      rankedRecords
    };
  }

  // Executive Synthesis
  const allNonCautionRecords = [...allGroupRecords.access, ...allGroupRecords.lineage, ...allGroupRecords.timing];
  const overallProv = buildProvenanceMix([...allNonCautionRecords, ...allGroupRecords.caution]);
  const evidenceScore = Math.min(
    98,
    Math.round(
      factors.access.signalStrength * 0.35 +
      factors.lineage.signalStrength * 0.30 +
      factors.timing.signalStrength * 0.20 +
      overallProv.verifiedSharePct * 0.15
    )
  );
  let reliabilityGrade = 'D';
  if (evidenceScore >= 72 && overallProv.verifiedSharePct >= 45) reliabilityGrade = 'A';
  else if (evidenceScore >= 52 && overallProv.verifiedSharePct >= 25) reliabilityGrade = 'B';
  else if (evidenceScore >= 28 || allNonCautionRecords.length > 0) reliabilityGrade = 'C';

  const hasBeneficial = factors.access.count > 0 || factors.lineage.count > 0 || factors.timing.count > 0;
  const cautionCount = factors.caution.count;
  const hasDirectRisk = rawByGroup.caution.length > 0 || syntheticCautionRecords.some((r) => r.type === 'DUAL_SIDED_INVESTOR_CONFLICT');
  let verdict = 'Limited Coverage';
  let verdictClass = 'is-neutral';
  let investmentEffect = 'Insufficient verified Cala paths to shift investment conviction.';
  if (cautionCount > 0 && hasBeneficial) {
    verdict = hasDirectRisk && evidenceScore >= 60 ? 'Actionable · Verify Risks' : 'Mixed · Diligence Required';
    verdictClass = 'is-mixed';
    investmentEffect = 'Strong access and lineage signals coexist with mapped overlap or conflict risks — clear caution checks before advancing.';
  } else if (cautionCount > 0) {
    verdict = 'Caution · Verify Risks';
    verdictClass = 'is-caution';
    investmentEffect = 'Mapped competitive or structural risk requires verification before advancing.';
  } else if (evidenceScore >= 72 && hasBeneficial) {
    verdict = 'Strong Multi-Factor Signal';
    verdictClass = 'is-beneficial';
    investmentEffect = 'High-provenance access, leadership, and timing signals support priority outreach; commercial traction still requires proof.';
  } else if (hasBeneficial) {
    verdict = 'Beneficial Signals';
    verdictClass = 'is-beneficial';
    investmentEffect = 'Verified Cala paths guide outreach and reference diligence; fundamentals remain unindexed.';
  }

  // Top Shared Bridge Highlights
  const sharedHighlightsMap = new Map();
  for (const group of ['access', 'lineage', 'caution']) {
    for (const r of factors[group].rankedRecords) {
      if (!r.isSharedBridge || !r.nodeId || r.nodeId.startsWith('caution:')) continue;
      if (!sharedHighlightsMap.has(r.nodeId)) {
        const node = nodeById.get(r.nodeId);
        sharedHighlightsMap.set(r.nodeId, {
          nodeId: r.nodeId,
          edgeId: r.edgeId,
          name: node?.label || node?.name || r.canonicalFrom,
          entityType: node?.entityType || 'Entity',
          group,
          sourceRank: r.sourceRank,
          sharedHubs: r.sharedHubs,
          signalWeight: r.signalWeight,
          summary: `${r.relation}${r.sharedHubs.length ? ` across ${r.sharedHubs.join(' & ')}` : ''}`
        });
      }
    }
  }
  const sharedBridgeHighlights = [...sharedHighlightsMap.values()]
    .sort((a, b) => (b.signalWeight || 0) - (a.signalWeight || 0))
    .slice(0, 4);

  // Top Warm Intro Routes
  const warmIntroRoutes = factors.access.rankedRecords
    .filter((r) => !focalById.has(r.nodeId) || r.isSharedBridge)
    .slice(0, 4)
    .map((r) => ({
      entityName: nodeLabel(r.nodeId),
      nodeId: r.nodeId,
      edgeId: r.edgeId,
      focalName: focalById.get(r.focalEntityId)?.name || r.canonicalTo,
      isLead: r.isLead,
      isSharedBridge: r.isSharedBridge,
      sourceRank: r.sourceRank,
      routeLabel: `${r.canonicalFrom} → ${r.canonicalTo}`
    }));

  // Top Diligence Actions
  const topDiligenceActions = ['caution', 'access', 'lineage', 'timing']
    .map((group) => ({
      factorGroup: group,
      label: factors[group].label,
      check: factors[group].actionableCheck,
      targetEdgeId: factors[group].rankedRecords[0]?.edgeId || '',
      targetNodeId: factors[group].rankedRecords[0]?.nodeId || ''
    }))
    .filter((item) => item.check)
    .slice(0, 3);

  return {
    executive: {
      verdict,
      verdictClass,
      investmentEffect,
      evidenceScore,
      reliabilityGrade,
      verifiedSharePct: overallProv.verifiedSharePct,
      provenanceMix: overallProv,
      sharedBridgeHighlights,
      warmIntroRoutes,
      dataAnomalies: dataAnomalies.slice(0, 6),
      topDiligenceActions
    },
    factors
  };
}
