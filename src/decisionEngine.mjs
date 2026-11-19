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

function computeTimingRecencyBoost(dateStr = '', referenceDate = null) {
  const rec = resolveTimingRecencyBucket({ date: dateStr }, referenceDate);
  if (rec.isRecentCatalyst) return 1.3;
  if (rec.isHistoricalMilestone) return 0.85;
  return 0.95;
}

function resolveTimingRecencyBucket(record = {}, referenceDate = null) {
  if (record.timingRecency === 'active_catalyst' || record.isRecentCatalyst === true) {
    return { timingRecency: 'active_catalyst', isRecentCatalyst: true, isHistoricalMilestone: false };
  }
  if (record.timingRecency === 'historical_milestone' || record.isHistoricalMilestone === true) {
    return { timingRecency: 'historical_milestone', isRecentCatalyst: false, isHistoricalMilestone: true };
  }
  const raw = String(record.date || '').trim();
  if (!raw) return { timingRecency: 'undated', isRecentCatalyst: false, isHistoricalMilestone: false };
  let norm = raw.slice(0, 10);
  if (/^\d{4}$/.test(raw)) norm = `${raw}-06-15`;
  else if (/^\d{4}-\d{2}$/.test(raw)) norm = `${raw}-15`;
  const evtMs = Date.parse(norm);
  if (!Number.isFinite(evtMs)) return { timingRecency: 'undated', isRecentCatalyst: false, isHistoricalMilestone: false };
  const refMs = Date.parse(referenceDate || new Date().toISOString().slice(0, 10));
  const baseMs = Number.isFinite(refMs) ? refMs : Date.now();
  const monthsAgo = (baseMs - evtMs) / (1000 * 60 * 60 * 24 * 30.4375);
  if (monthsAgo <= 18 && monthsAgo >= -12) {
    return { timingRecency: 'active_catalyst', isRecentCatalyst: true, isHistoricalMilestone: false };
  }
  if (monthsAgo > 18) {
    return { timingRecency: 'historical_milestone', isRecentCatalyst: false, isHistoricalMilestone: true };
  }
  return { timingRecency: 'undated', isRecentCatalyst: false, isHistoricalMilestone: false };
}

function classifyStructuralRoleFromEdge(edge = {}) {
  if (edge.structuralRole) return edge.structuralRole;
  const rel = String(edge.relation || '').toUpperCase();
  if (['INVESTED_IN', 'CO_INVESTED_WITH', 'PARTICIPATES_IN_FUNDING_ROUND', 'HAS_FUNDING_ROUND'].includes(rel)) {
    return 'capital';
  }
  if (['PARTNERED_WITH', 'SUPPLIES', 'SUPPLIED_BY', 'ADVISED'].includes(rel)) {
    return 'commercial';
  }
  if (
    rel === 'ACQUIRED' ||
    rel.startsWith('IS_') ||
    rel.includes('FOUNDED') ||
    rel === 'WORKS_AT' ||
    rel === 'SPUN_OUT_OF'
  ) {
    return 'governance';
  }
  if (edge.contributionGroup === 'access') return 'capital';
  if (edge.contributionGroup === 'lineage') return 'governance';
  return 'strategic_event';
}

function scoreEdgeSignal(edge, group, referenceDate = null) {
  const rank = rankUpper(edge.topSourceRank);
  let weight = PROVENANCE_WEIGHTS[rank] || 0.35;
  if (edge.isSharedBridge) weight *= 1.5;
  if (edge.isLead || EXECUTIVE_RELATIONS.has(String(edge.relation || '').toUpperCase())) {
    weight *= 1.25;
  }
  if (edge.date) weight *= 1.12;
  if (group === 'timing') {
    weight *= computeTimingRecencyBoost(edge.date, referenceDate);
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

function balanceRecordsAcrossHubs(records = [], focalIds = [], maxItems = 8, primaryTargetId = null) {
  const pTarget = primaryTargetId ? String(primaryTargetId) : null;
  const touchesPrimary = (r) => Boolean(pTarget && (r.focalEntityId === pTarget || (r.sharedHubIds || []).includes(pTarget)));
  const sortBySignal = (a, b) =>
    Number(touchesPrimary(b)) - Number(touchesPrimary(a)) ||
    Number(Boolean(b.isSharedBridge)) - Number(Boolean(a.isSharedBridge)) ||
    (b.signalWeight || 0) - (a.signalWeight || 0) ||
    (SOURCE_RANK_ORDER[rankUpper(b.sourceRank)] || 0) - (SOURCE_RANK_ORDER[rankUpper(a.sourceRank)] || 0) ||
    String(b.date || '').localeCompare(String(a.date || ''));

  if (records.length <= maxItems) return [...records].sort(sortBySignal);

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
  anomalies = [],
  analysisMode = null,
  perspectiveEntity = null,
  primaryTargetId = null,
  referenceDate = null
} = {}) {
  const focalList = (Array.isArray(focalEntities) ? focalEntities : []).filter((e) => e?.id && e?.name);
  const focalIds = focalList.map((e) => String(e.id));
  const focalById = new Map(focalList.map((e) => [String(e.id), e]));
  const perspectiveObj = perspectiveEntity?.id && perspectiveEntity?.name ? perspectiveEntity : null;
  const resolvedMode = analysisMode || (perspectiveObj ? 'perspective_triage' : focalList.length <= 1 ? 'single_teardown' : 'ecosystem_compare');
  const resolvedPrimaryTargetId = primaryTargetId && focalById.has(String(primaryTargetId)) ? String(primaryTargetId) : null;
  const primaryTargetName = resolvedPrimaryTargetId ? focalById.get(resolvedPrimaryTargetId)?.name || null : null;
  const refDate = referenceDate || new Date().toISOString().slice(0, 10);
  const nodeById = new Map((Array.isArray(nodes) ? nodes : []).map((n) => [String(n.id), n]));
  const validEdges = (Array.isArray(edges) ? edges : []).filter((e) => e && !String(e.id || '').startsWith('tree-spoke-'));

  const nodeLabel = (id) => normalizeText(nodeById.get(String(id))?.label || nodeById.get(String(id))?.name || focalById.get(String(id))?.name || id);
  const resolveSharedHubNames = (ids = []) => ids.map((id) => focalById.get(String(id))?.name || nodeLabel(id)).filter(Boolean);

  const rawByGroup = { access: [], lineage: [], timing: [], caution: [] };
  for (const edge of validEdges) {
    const relUpper = String(edge.relation || '').toUpperCase();
    const isAcquisition = Boolean(edge.isAcquisition || relUpper === 'ACQUIRED');
    const rawGroup = ['access', 'lineage', 'timing', 'caution'].includes(edge.contributionGroup)
      ? edge.contributionGroup
      : 'access';
    // ACQUIRED is Corporate M&A / Governance, never automatically Caution
    const group = isAcquisition && rawGroup === 'caution' ? 'lineage' : rawGroup;
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
    const structuralRole = classifyStructuralRoleFromEdge(edge);
    const recency = resolveTimingRecencyBucket(edge, refDate);
    const touchesPerspective = Boolean(
      edge.touchesPerspective ||
      edge.isPerspectiveBridge ||
      (perspectiveObj && (fromId === String(perspectiveObj.id) || toId === String(perspectiveObj.id)))
    );
    const nodeEntityType = normalizeText(nodeById.get(nonFocalId)?.entityType || 'Organization');

    rawByGroup[group].push({
      id: String(edge.id || `${group}-${fromId}-${toId}`),
      edgeId: String(edge.id || ''),
      nodeId: nonFocalId,
      nodeEntityType,
      focalEntityId: String(edge.focalEntityId || (focalById.has(fromId) ? fromId : toId)),
      type: normalizeText(edge.relation || edge.bridgeFamily || relationText),
      path: `${fromName} → ${toName}`,
      canonicalFrom: fromName,
      canonicalTo: toName,
      relation: relationText,
      detail: normalizeText(edge.detail || edge.whyMatters || relationText),
      date: edge.date ? String(edge.date).slice(0, 10) : null,
      sourceRank,
      structuralRole,
      isAcquisition,
      timingRecency: recency.timingRecency,
      isRecentCatalyst: recency.isRecentCatalyst,
      isHistoricalMilestone: recency.isHistoricalMilestone,
      touchesPerspective,
      perspectiveChain: Array.isArray(edge.perspectiveChain) ? edge.perspectiveChain : null,
      isSharedBridge: Boolean(edge.isSharedBridge),
      isLead: Boolean(edge.isLead),
      isAnomaly: Boolean(edge.isAnomaly),
      sharedHubIds,
      sharedHubs,
      signalWeight: scoreEdgeSignal(edge, group, refDate),
      sourceIds
    });
  }

  // Include Perspective 2-hop chains into Access if not already covered by direct perspective edges
  if (resolvedMode === 'perspective_triage' && perspectiveObj) {
    const existingAccessEdgeIds = new Set(rawByGroup.access.filter((r) => r.touchesPerspective).map((r) => r.edgeId));
    for (const [idx, chain] of (perspectiveObj.warmIntroChains || []).entries()) {
      const hasMatch = rawByGroup.access.some(
        (r) => r.touchesPerspective && r.canonicalTo === chain.targetLabel && (!chain.bridgeNodeId || r.nodeId === chain.bridgeNodeId)
      );
      if (hasMatch) continue;
      const chainSrcIds = (chain.sourceIds || []).map(String).filter(Boolean);
      const pseudoEdgeId = '';
      if (!existingAccessEdgeIds.has(`${chain.targetId}:${chain.bridgeNodeId || 'direct'}`)) {
        rawByGroup.access.push({
          id: `persp-chain-${idx + 1}`,
          edgeId: pseudoEdgeId,
          nodeId: chain.bridgeNodeId || String(perspectiveObj.id),
          nodeEntityType: normalizeText(nodeById.get(String(chain.bridgeNodeId || perspectiveObj.id))?.entityType || 'Organization'),
          focalEntityId: String(chain.targetId || focalIds[0] || ''),
          type: chain.type === 'direct' ? 'PERSPECTIVE_DIRECT' : 'PERSPECTIVE_WARM_INTRO',
          path: chain.chainText,
          canonicalFrom: chain.bridgeLabel || perspectiveObj.name,
          canonicalTo: chain.targetLabel || focalList[0]?.name || '',
          relation: chain.relationLabel || 'Warm intro bridge',
          detail: chain.chainText,
          date: null,
          sourceRank: rankUpper(chain.topSourceRank || 'PRIMARY'),
          structuralRole: 'capital',
          isAcquisition: false,
          timingRecency: 'undated',
          isRecentCatalyst: false,
          isHistoricalMilestone: false,
          touchesPerspective: true,
          perspectiveChain: [perspectiveObj.name, ...(chain.bridgeLabel ? [chain.bridgeLabel] : []), chain.targetLabel].filter(Boolean),
          isSharedBridge: true,
          isLead: false,
          isAnomaly: false,
          sharedHubIds: chain.targetId ? [String(chain.targetId)] : [],
          sharedHubs: chain.targetLabel ? [chain.targetLabel] : [],
          signalWeight: 1.25,
          sourceIds: chainSrcIds
        });
      }
    }
  }

  // Synthesize analyst-relevant Caution signals (dual-sided investors, shared talent migration, portfolio conflicts, anomalies)
  const syntheticCautionRecords = [];
  const seenCautionKeys = new Set();

  if (resolvedMode === 'perspective_triage' && perspectiveObj) {
    for (const [idx, conflict] of (perspectiveObj.portfolioConflicts || []).entries()) {
      const cKey = `portfolio-conflict:${conflict.targetId}:${conflict.portfolioName}`;
      if (seenCautionKeys.has(cKey)) continue;
      seenCautionKeys.add(cKey);
      syntheticCautionRecords.push({
        id: `caution:portfolio:${idx + 1}`,
        edgeId: '',
        nodeId: String(conflict.portfolioId || ''),
        nodeEntityType: 'Organization',
        focalEntityId: String(conflict.targetId || focalIds[0] || ''),
        type: 'PORTFOLIO_OVERLAP',
        path: `${perspectiveObj.name} (${conflict.portfolioName}) ↔ ${conflict.targetName}`,
        canonicalFrom: conflict.portfolioName,
        canonicalTo: conflict.targetName,
        relation: conflict.kind === 'DIRECT_RIVAL' ? 'Direct portfolio rival' : 'Portfolio sector overlap',
        detail: conflict.reason,
        date: null,
        sourceRank: conflict.kind === 'DIRECT_RIVAL' ? 'PRIMARY' : 'PRESS',
        structuralRole: 'strategic_event',
        isAcquisition: false,
        touchesPerspective: true,
        isSharedBridge: true,
        isLead: false,
        isAnomaly: false,
        sharedHubIds: conflict.targetId ? [String(conflict.targetId)] : [],
        sharedHubs: conflict.targetName ? [conflict.targetName] : [],
        signalWeight: conflict.kind === 'DIRECT_RIVAL' ? 1.3 : 1.05,
        sourceIds: (conflict.sourceIds || []).map(String).filter(Boolean).slice(0, 6)
      });
    }
  }

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
          nodeEntityType: 'Organization',
          focalEntityId: [...firstInv.hubIds][0] || focalIds[0],
          type: 'DUAL_SIDED_INVESTOR_CONFLICT',
          path: `${names} → ${hubList.join(' & ')}`,
          canonicalFrom: names,
          canonicalTo: hubList.join(' & '),
          relation: 'Shared cap-table exposure',
          detail: `${dualInvestors.length} investor(s) (${names}) hold stakes across ${hubList.join(' and ')}; verify Chinese walls and information rights.`,
          date: null,
          sourceRank: firstInv.bestRank,
          structuralRole: 'capital',
          isAcquisition: false,
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
        nodeEntityType: 'Person',
        focalEntityId: [...firstPerson.hubIds][0] || focalIds[0],
        type: 'CROSS_HUB_TALENT_OVERLAP',
        path: `${names} ↔ ${hubList.join(' & ')}`,
        canonicalFrom: names,
        canonicalTo: hubList.join(' & '),
        relation: 'Executive / founder overlap',
        detail: `${talentList.length} founder/executive(s) (${names}) hold mapped roles across ${hubList.join(' and ')}; check IP assignment and non-compete exposure.`,
        date: null,
        sourceRank: firstPerson.bestRank,
        structuralRole: 'governance',
        isAcquisition: false,
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

  // Identify shared commercial bottlenecks across 2+ focal hubs
  const sharedCommercialMap = new Map();
  if (focalIds.length >= 2) {
    for (const rec of rawByGroup.access) {
      if (!rec.isSharedBridge || rec.structuralRole !== 'commercial') continue;
      if (!rec.nodeId || focalById.has(rec.nodeId)) continue;
      if (!sharedCommercialMap.has(rec.nodeId)) {
        sharedCommercialMap.set(rec.nodeId, {
          nodeId: rec.nodeId,
          edgeId: rec.edgeId,
          name: nodeLabel(rec.nodeId),
          relation: rec.relation,
          sharedHubs: new Set(rec.sharedHubs),
          sourceRank: rec.sourceRank,
          sourceIds: new Set(rec.sourceIds)
        });
      } else {
        const b = sharedCommercialMap.get(rec.nodeId);
        for (const h of rec.sharedHubs) b.sharedHubs.add(h);
        for (const s of rec.sourceIds) b.sourceIds.add(s);
      }
    }
  }
  const sharedCommercialBottlenecks = [...sharedCommercialMap.values()]
    .filter((b) => b.sharedHubs.size >= 2)
    .map((b) => ({ ...b, sharedHubs: [...b.sharedHubs], sourceIds: [...b.sourceIds].slice(0, 4) }))
    .slice(0, 5);

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
        structuralRole: 'strategic_event',
        isAcquisition: false,
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

  // In perspective_triage, access reflects ONLY real bridges touching Perspective Firm (never third-party Target investors)
  const accessRecordsForMode =
    resolvedMode === 'perspective_triage' && perspectiveObj
      ? rawByGroup.access.filter((r) => r.touchesPerspective)
      : rawByGroup.access;

  const allGroupRecords = {
    access: accessRecordsForMode,
    lineage: rawByGroup.lineage,
    timing: rawByGroup.timing,
    caution: [...rawByGroup.caution, ...syntheticCautionRecords]
  };

  // Compute timing catalysts split (<=18m vs >18m)
  const timingRecentCatalysts = allGroupRecords.timing.filter((r) => r.isRecentCatalyst);
  const timingHistoricalMilestones = allGroupRecords.timing.filter((r) => r.isHistoricalMilestone);

  // Explicit disclosure gaps for teardown & comparison workflows
  const missingDisclosures = [];
  if (timingRecentCatalysts.length === 0) {
    missingDisclosures.push('No verified dated financing or corporate catalyst within the last 18 months in Cala');
  }
  if (!allGroupRecords.access.some((r) => r.structuralRole === 'commercial')) {
    missingDisclosures.push('No commercial supplier, customer, or strategic partner relationships indexed in Cala');
  }
  if (!allGroupRecords.lineage.some((r) => !r.isAcquisition)) {
    missingDisclosures.push('Limited executive, founder, or board governance records indexed in Cala');
  }
  if (rawByGroup.caution.length === 0) {
    missingDisclosures.push('No direct competitive rivals or litigation flags indexed in Cala (absence is not clearance)');
  }

  const MODE_DISPLAY_LABELS = {
    single_teardown: {
      access: {
        displayLabel: 'Capital & Value Chain',
        shortTabLabel: 'Capital & Stack',
        question: 'Who backs it & who powers its commercial stack?'
      },
      lineage: {
        displayLabel: 'Governance, Leadership & M&A',
        shortTabLabel: 'Gov & M&A',
        question: 'Who leads, controls, or was acquired by it?'
      },
      timing: {
        displayLabel: 'Recent Catalysts vs. History',
        shortTabLabel: 'Catalysts',
        question: 'What happened in the last 18 months vs. historical milestones?'
      },
      caution: {
        displayLabel: 'Rivals, Anomalies & Gaps',
        shortTabLabel: 'Gaps & Rivals',
        question: 'What competitive threats, anomalies, or missing Cala disclosures exist?'
      }
    },
    ecosystem_compare: {
      displayLabel: null,
      access: {
        displayLabel: 'Shared Backers & Bottlenecks',
        shortTabLabel: 'Backers & Stack',
        question: 'Where do cap tables, suppliers, or strategic partnerships converge across targets?'
      },
      lineage: {
        displayLabel: 'Talent & Corporate Lineage',
        shortTabLabel: 'Talent & M&A',
        question: 'Which founders, executives, or M&A links connect the mapped companies?'
      },
      timing: {
        displayLabel: 'Comparative Momentum',
        shortTabLabel: 'Momentum',
        question: 'Which companies carry recent catalysts (<=18m) vs. older financing history?'
      },
      caution: {
        displayLabel: 'Dual-Backer & Rivalry Risk',
        shortTabLabel: 'Rivalry & Risk',
        question: 'What dual-backed conflicts, commercial bottlenecks, or direct rivalries appear?'
      }
    },
    perspective_triage: {
      access: {
        displayLabel: 'Warm Intro Access',
        shortTabLabel: 'Warm Access',
        question: `What verified path connects ${perspectiveObj?.name || 'your firm'} to the target(s)?`
      },
      lineage: {
        displayLabel: 'Team & Spinout Lineage',
        shortTabLabel: 'Lineage',
        question: 'Are founder and executive tenures current, and who gives a direct backchannel?'
      },
      timing: {
        displayLabel: 'Active Timing Window',
        shortTabLabel: 'Timing',
        question: 'Do dated catalysts within 18 months establish an active deal window?'
      },
      caution: {
        displayLabel: 'Portfolio & Risk Flags',
        shortTabLabel: 'Risk Flags',
        question: `What portfolio overlap with ${perspectiveObj?.name || 'your firm'} or competitive risk requires verification?`
      }
    }
  };

  const factorConfigs = {
    access: {
      label: 'Access',
      defaultQuestion: MODE_DISPLAY_LABELS[resolvedMode].access.question
    },
    lineage: {
      label: 'Lineage',
      defaultQuestion: MODE_DISPLAY_LABELS[resolvedMode].lineage.question
    },
    timing: {
      label: 'Timing',
      defaultQuestion: MODE_DISPLAY_LABELS[resolvedMode].timing.question
    },
    caution: {
      label: 'Caution',
      defaultQuestion: MODE_DISPLAY_LABELS[resolvedMode].caution.question
    }
  };

  const factors = {};
  for (const group of ['access', 'lineage', 'timing', 'caution']) {
    const records = allGroupRecords[group] || [];
    const rankedRecords = balanceRecordsAcrossHubs(records, focalIds, 8, resolvedPrimaryTargetId);
    const sharedRecords = records.filter((r) => r.isSharedBridge);
    const uniqueBridgeEntities = [...new Set(records.map((r) => r.canonicalFrom).filter((n) => !focalList.some((f) => f.name === n)))];
    const isPersonRecord = (r) => String(r?.nodeEntityType || nodeById.get(r?.nodeId)?.entityType || '').toLowerCase() === 'person';
    const prioritizeOrgs = (list) => (group === 'access'
      ? [...list].sort((a, b) => Number(isPersonRecord(a)) - Number(isPersonRecord(b)))
      : list);
    const sharedBridgeNames = [...new Set(
      prioritizeOrgs([...rankedRecords.filter((r) => r.isSharedBridge), ...sharedRecords]).map((r) => {
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
      if (records.length >= 3 || (rawByGroup.caution.length > 0 && syntheticCautionRecords.length > 0) || syntheticCautionRecords.some((r) => r.type === 'PORTFOLIO_OVERLAP')) {
        tier = 'Risk · Watch';
        tierClass = 'is-caution';
      } else if (records.length > 0) {
        tier = 'Caution · Check';
        tierClass = 'is-caution';
      } else {
        tier = 'Clear';
        tierClass = 'is-beneficial';
      }
    } else if (group === 'access' && resolvedMode === 'perspective_triage' && records.length === 0) {
      tier = 'Cold Outreach';
      tierClass = 'is-neutral';
    } else if (signalStrength >= 70 || (sharedRecords.length >= 2 && records.length >= 4)) {
      tier = 'Strong';
      tierClass = 'is-beneficial';
    } else if (signalStrength >= 40 || records.length >= 3) {
      tier = group === 'timing' ? (timingRecentCatalysts.length > 0 ? 'Active' : 'Historical') : 'Moderate';
      tierClass = group === 'timing' && timingRecentCatalysts.length === 0 ? 'is-neutral' : 'is-beneficial';
    } else if (records.length > 0) {
      tier = group === 'timing' ? (timingRecentCatalysts.length > 0 ? 'Catalyst' : 'Historical') : 'Signal';
      tierClass = group === 'timing' && timingRecentCatalysts.length === 0 ? 'is-neutral' : 'is-beneficial';
    }

    const hubCoverage = focalList.map((f) => ({
      id: String(f.id),
      name: f.name,
      count: records.filter((r) => r.focalEntityId === String(f.id)).length
    }));
    const uniqueSources = collectSourceIds(records, 32).length;
    const datedCount = records.filter((r) => Boolean(r.date)).length;
    const undatedCount = Math.max(0, records.length - datedCount);

    const structuralBreakdown = {
      capitalCount: records.filter((r) => r.structuralRole === 'capital').length,
      commercialCount: records.filter((r) => r.structuralRole === 'commercial').length,
      governanceCount: records.filter((r) => r.structuralRole === 'governance' && !r.isAcquisition).length,
      acquisitionCount: records.filter((r) => r.isAcquisition).length,
      activeCatalystCount: records.filter((r) => r.isRecentCatalyst).length,
      historicalMilestoneCount: records.filter((r) => r.isHistoricalMilestone).length
    };

    let headline = '';
    let investmentImpact = '';
    let actionableCheck = factorConfigs[group].defaultQuestion;

    if (group === 'access') {
      const leadNames = sharedBridgeNames.slice(0, 2);
      const orderedAccessRecords = prioritizeOrgs([...rankedRecords, ...records]);
      const capitalRecords = orderedAccessRecords.filter((r) => r.structuralRole === 'capital');
      const commercialRecords = orderedAccessRecords.filter((r) => r.structuralRole === 'commercial');
      const directNames = [...new Set(orderedAccessRecords.map((r) => (focalById.has(r.nodeId) ? r.canonicalFrom : nodeLabel(r.nodeId))).filter(Boolean))].slice(0, 2);

      if (resolvedMode === 'perspective_triage' && perspectiveObj) {
        if (records.length > 0) {
          headline = truncateLine(`${records.length} warm path(s) from ${perspectiveObj.name} (${directNames.join(', ')})`);
          investmentImpact = `${perspectiveObj.name} connects directly or via ${leadNames[0] || directNames[0] || 'a shared syndicate bridge'} to the target.`;
          actionableCheck = `Confirm whether ${leadNames[0] || directNames[0] || 'the mapped bridge'} can sponsor a direct partner introduction.`;
        } else {
          headline = `No shared path from ${perspectiveObj.name} — cold outreach`;
          investmentImpact = `No shared co-investor, partner, or executive bridge connects ${perspectiveObj.name} to mapped target(s); plan direct cold origination.`;
          actionableCheck = `Verify outside-Cala relationships or advisor ties from ${perspectiveObj.name} before initiating cold outreach.`;
        }
      } else if (resolvedMode === 'single_teardown') {
        const capCount = structuralBreakdown.capitalCount;
        const comCount = structuralBreakdown.commercialCount;
        if (records.length > 0) {
          const capLead = [...new Set(capitalRecords.map((r) => nodeLabel(r.nodeId)).filter(Boolean))].slice(0, 2);
          const comLead = [...new Set(commercialRecords.map((r) => nodeLabel(r.nodeId)).filter(Boolean))].slice(0, 2);
          headline = truncateLine(
            [capCount ? `${capCount} capital backer${capCount === 1 ? '' : 's'}` : '', comCount ? `${comCount} commercial link${comCount === 1 ? '' : 's'}` : '']
              .filter(Boolean)
              .join(' · ') + (directNames.length ? ` (${[...new Set([...capLead, ...comLead])].slice(0, 2).join(', ')})` : '')
          );
          investmentImpact = [
            capCount ? `Institutional cap-table & ownership links verified (${capLead.join(', ')})` : '',
            comCount ? `commercial supply/partner ecosystem links (${comLead.join(', ')}) — treat commercial ties as value-chain leverage, not warm intro paths` : ''
          ].filter(Boolean).join('; ') + '.';
          actionableCheck = comCount
            ? `Verify contractual depth and concentration risk across ${comLead[0] || 'mapped commercial partners'}.`
            : `Verify current ownership concentration and board rights held by ${capLead[0] || 'mapped backers'}.`;
        } else {
          headline = 'No capital backers or commercial value-chain ties indexed in Cala.';
          investmentImpact = 'Ownership and commercial supplier/customer dependencies remain unindexed in Cala.';
          actionableCheck = 'Pull statutory cap table and key supplier/customer concentration outside Cala.';
        }
      } else if (sharedRecords.length > 0) {
        const bottleneckNote = sharedCommercialBottlenecks.length
          ? ` (including ${sharedCommercialBottlenecks.length} shared commercial bottleneck${sharedCommercialBottlenecks.length === 1 ? '' : 's'}: ${sharedCommercialBottlenecks[0].name})`
          : '';
        headline = truncateLine(`${sharedRecords.length} shared cap-table/value-chain paths (${leadNames.join(', ')})`);
        investmentImpact = `Shared backers and ecosystem nodes (${leadNames.join(', ')}) connect multiple hubs${bottleneckNote}.`;
        actionableCheck = `Verify whether ${leadNames[0]} creates mutual dependency or reference leverage across mapped hubs.`;
      } else if (records.length > 0) {
        headline = truncateLine(`${records.length} direct capital/partner links (${[...new Set(directNames)].join(', ')})`);
        investmentImpact = `Direct institutional and strategic counterparties (${[...new Set(directNames)].join(', ')}) map external leverage across entities.`;
        actionableCheck = `Confirm whether ${directNames[0] || uniqueBridgeEntities[0] || 'a mapped counterparty'} spans multiple peers off-map.`;
      } else {
        headline = 'No investor or strategic partner paths found in Cala.';
        investmentImpact = 'No mapped capital or commercial route surfaced.';
        actionableCheck = 'Verify cap-table backers and strategic partners outside Cala.';
      }
    } else if (group === 'lineage') {
      const execNames = [...new Set(rankedRecords.filter((r) => !r.isAcquisition).map((r) => nodeLabel(r.nodeId)).filter(Boolean))].slice(0, 2);
      const acqNames = [...new Set(rankedRecords.filter((r) => r.isAcquisition).map((r) => nodeLabel(r.nodeId)).filter(Boolean))].slice(0, 2);
      if (resolvedMode === 'single_teardown') {
        if (records.length > 0) {
          const parts = [
            structuralBreakdown.governanceCount ? `${structuralBreakdown.governanceCount} governance/leadership link${structuralBreakdown.governanceCount === 1 ? '' : 's'}` : '',
            structuralBreakdown.acquisitionCount ? `${structuralBreakdown.acquisitionCount} corporate M&A acquisition${structuralBreakdown.acquisitionCount === 1 ? '' : 's'}` : ''
          ].filter(Boolean);
          headline = truncateLine(`${parts.join(' · ')} (${[...execNames, ...acqNames].slice(0, 2).join(', ')})`);
          investmentImpact = structuralBreakdown.acquisitionCount > 0 && !structuralBreakdown.governanceCount
            ? `Mapped M&A activity (${acqNames.join(', ')}) reflects corporate ownership allocation; check integration outcomes separately.`
            : `Documented leadership & corporate structure (${[...execNames, ...acqNames].slice(0, 2).join(', ')}) clarify control and operating lineage.`;
          actionableCheck = structuralBreakdown.acquisitionCount
            ? `Verify strategic rationale and post-merger integration for ${acqNames[0] || 'the mapped acquisition'}.`
            : `Verify whether ${execNames[0] || 'mapped leadership'} holds active statutory authority.`;
        } else {
          headline = 'No founder, governance, or M&A links indexed in Cala.';
          investmentImpact = 'Leadership control and M&A history remain unverified on this map.';
          actionableCheck = 'Confirm founder control rights, subsidiary structure, and executive tenure outside Cala.';
        }
      } else if (sharedRecords.length > 0) {
        headline = truncateLine(`${sharedBridgeNames.length} cross-hub leaders (${sharedBridgeNames.slice(0, 2).join(', ')})`);
        investmentImpact = `Verified founder/executive bridges (${sharedBridgeNames.slice(0, 2).join(', ')}) reveal shared talent spillover across mapped hubs.`;
        actionableCheck = `Confirm whether ${sharedBridgeNames[0]}'s departure and current role dates match statutory records.`;
      } else if (records.length > 0) {
        headline = truncateLine(`${records.length} leadership, governance & M&A links (${[...execNames, ...acqNames].slice(0, 2).join(', ')})`);
        investmentImpact = `Documented leadership and corporate tree links (${[...execNames, ...acqNames].slice(0, 2).join(', ')}) map control and alumni lineage.`;
        actionableCheck = `Verify whether ${execNames[0] || acqNames[0] || 'mapped leadership'} holds active decision authority in current filings.`;
      } else {
        headline = 'No founder or executive lineage links indexed in Cala.';
        investmentImpact = 'Team background and operator ties remain unverified on this map.';
        actionableCheck = 'Confirm founder prior-employment history and technical leadership outside Cala.';
      }
    } else if (group === 'timing') {
      const sortedDated = [...records].filter((r) => r.date).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const latest = sortedDated[0] || rankedRecords[0];
      const latestRecent = [...timingRecentCatalysts].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
      const anomCount = dataAnomalies.filter((a) => a.kind === 'timing_anomaly').length;
      if (timingRecentCatalysts.length > 0 && timingHistoricalMilestones.length > 0) {
        headline = truncateLine(
          `${timingRecentCatalysts.length} active catalyst${timingRecentCatalysts.length === 1 ? '' : 's'} (<=18m) · ${timingHistoricalMilestones.length} historical${anomCount ? ` (${anomCount} flag)` : ''}`
        );
        investmentImpact = `Recent catalysts (${latestRecent?.date || 'within 18m'}) mark active momentum alongside ${timingHistoricalMilestones.length} older milestone(s) (>18m)${anomCount ? '; verify flagged sequence conflict' : ''}.`;
        const cleanRelation = (latestRecent || latest)
          ? String((latestRecent || latest).relation || '').replace(/\s*\(\d{4}(?:-\d{2}-\d{2})?\)\s*$/, '').trim()
          : '';
        actionableCheck = latestRecent
          ? `Confirm whether ${latestRecent.canonicalFrom}'s ${cleanRelation || 'recent catalyst'} (${latestRecent.date || 'recent'}) reflects the latest corporate update.`
          : factorConfigs.timing.defaultQuestion;
      } else if (timingRecentCatalysts.length > 0) {
        headline = truncateLine(
          `${timingRecentCatalysts.length} active catalyst${timingRecentCatalysts.length === 1 ? '' : 's'} (<=18m) · latest ${latestRecent?.date || latest?.date || 'dated'}${anomCount ? ` (${anomCount} flag)` : ''}`
        );
        investmentImpact = `Dated catalysts within 18 months${latestRecent?.date ? ` through ${latestRecent.date}` : ''} establish active operating or financing momentum${anomCount ? '; verify flagged sequence conflict' : ''}.`;
        const cleanRelation = latestRecent
          ? String(latestRecent.relation || '').replace(/\s*\(\d{4}(?:-\d{2}-\d{2})?\)\s*$/, '').trim()
          : '';
        actionableCheck = latestRecent
          ? `Confirm whether ${latestRecent.canonicalFrom}'s ${cleanRelation || 'recent catalyst'} (${latestRecent.date || 'dated'}) reflects the latest completed corporate event.`
          : factorConfigs.timing.defaultQuestion;
      } else if (timingHistoricalMilestones.length > 0) {
        headline = truncateLine(
          `No recent catalysts (<=18m) · ${timingHistoricalMilestones.length} historical milestone${timingHistoricalMilestones.length === 1 ? '' : 's'} (>18m)`
        );
        investmentImpact = `All mapped dated events predate the 18-month active window (latest ${latest?.date || 'historical'}); verify current trajectory outside stale rounds.`;
        actionableCheck = `Confirm any unindexed financings, M&A, or operating catalysts in the past 18 months (${latest?.date || 'historical'} is outdated).`;
      } else if (records.length > 0) {
        headline = truncateLine(`${records.length} dated milestones${latest?.date ? ` · latest ${latest.date}` : ''}${anomCount ? ` (${anomCount} flag)` : ''}`);
        investmentImpact = `Mapped events${latest?.date ? ` through ${latest.date}` : ''} lack recent 18-month recency markers; confirm current status.`;
        actionableCheck = latest
          ? `Confirm whether ${latest.canonicalFrom}'s corporate milestone (${latest.date || 'undated'}) remains current.`
          : factorConfigs.timing.defaultQuestion;
      } else {
        headline = 'No dated funding milestones or corporate events verified in Cala.';
        investmentImpact = 'No mapped timing catalyst to confirm recent momentum or fundraising urgency.';
        actionableCheck = 'Verify most recent financing date and operating catalysts directly with management.';
      }
    } else {
      const topCaution = rankedRecords[0];
      if (records.length > 0) {
        const flags = [];
        if (syntheticCautionRecords.some((r) => r.type === 'PORTFOLIO_OVERLAP')) flags.push('portfolio overlap');
        if (rawByGroup.caution.length > 0) flags.push('industry/rival overlap');
        if (syntheticCautionRecords.some((r) => r.type === 'DUAL_SIDED_INVESTOR_CONFLICT')) flags.push('dual-sided investors');
        if (syntheticCautionRecords.some((r) => r.type === 'CROSS_HUB_TALENT_OVERLAP')) flags.push('shared talent');
        if (syntheticCautionRecords.some((r) => r.type === 'ROUND_SEQUENCE_ANOMALY')) flags.push('round-order flag');
        headline = truncateLine(`${records.length} risk flag(s): ${flags.join(' · ') || topCaution.relation}`);
        investmentImpact = `${topCaution.detail}`;
        actionableCheck = `Verify whether ${topCaution.path} creates competitive conflict, governance restriction, or data inconsistency.`;
      } else {
        headline = resolvedMode === 'single_teardown' && missingDisclosures.length
          ? `${missingDisclosures.length} Cala disclosure gap(s) · 0 competitive flags`
          : 'No competitive conflict, dual-backer, or sequence flags detected.';
        investmentImpact = resolvedMode === 'single_teardown' && missingDisclosures.length
          ? `${missingDisclosures[0]}. Absence of Cala conflict flags does not rule out commercial risk.`
          : 'No mapped conflict surfaced; absence of Cala flags does not rule out commercial risk.';
        actionableCheck = 'Verify customer overlap, litigation, and commercial concentration not indexed in Cala.';
      }
    }

    factors[group] = {
      group,
      label: factorConfigs[group].label,
      displayLabel: MODE_DISPLAY_LABELS[resolvedMode][group].displayLabel,
      shortTabLabel: MODE_DISPLAY_LABELS[resolvedMode][group].shortTabLabel,
      sectionQuestion: MODE_DISPLAY_LABELS[resolvedMode][group].question,
      count: records.length,
      sharedCount: sharedRecords.length,
      signalStrength,
      tier,
      tierClass,
      headline,
      investmentImpact,
      actionableCheck,
      provenanceMix,
      structuralBreakdown,
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
  const hasDirectRisk =
    rawByGroup.caution.length > 0 ||
    syntheticCautionRecords.some((r) => r.type === 'DUAL_SIDED_INVESTOR_CONFLICT' || r.type === 'PORTFOLIO_OVERLAP');
  let verdict = 'Limited Coverage';
  let verdictClass = 'is-neutral';
  let investmentEffect = 'Insufficient verified Cala paths to shift analytical conviction.';

  if (resolvedMode === 'single_teardown') {
    const fName = focalList[0]?.name || 'target entity';
    if (cautionCount > 0 && hasBeneficial) {
      verdict = hasDirectRisk ? 'Rivals Mapped · Verify Gaps' : 'Teardown Complete · Check Gaps';
      verdictClass = 'is-mixed';
      investmentEffect = `Mapped ownership, commercial links, and dated milestones for ${fName} alongside ${cautionCount} flagged risk item(s) and ${missingDisclosures.length} disclosure gap(s).`;
    } else if (hasBeneficial) {
      verdict = timingRecentCatalysts.length > 0 ? 'Active Coverage' : 'Structural Profile Mapped';
      verdictClass = 'is-beneficial';
      investmentEffect = `${fName} shows ${factors.access.count} capital/commercial ties and ${factors.lineage.count} governance/M&A links; check ${missingDisclosures.length} missing Cala disclosure(s) or compare peers.`;
    }
  } else if (resolvedMode === 'perspective_triage' && perspectiveObj) {
    if (cautionCount > 0 && factors.access.count === 0) {
      verdict = 'Cold · Portfolio Overlap';
      verdictClass = 'is-caution';
      investmentEffect = `No shared intro path from ${perspectiveObj.name}; ${cautionCount} competitive/portfolio overlap flag(s) detected.`;
    } else if (cautionCount > 0 && hasBeneficial) {
      verdict = hasDirectRisk ? 'Warm Triage · Verify Overlap' : 'Mixed · Diligence Required';
      verdictClass = 'is-mixed';
      investmentEffect = `${perspectiveObj.name} has ${factors.access.count} warm path(s), balanced against ${cautionCount} risk/portfolio overlap flag(s).`;
    } else if (factors.access.count > 0) {
      verdict = 'Warm Route Mapped';
      verdictClass = 'is-beneficial';
      investmentEffect = `Verified intro chain from ${perspectiveObj.name} supports prioritized origination diligence; clear commercial checks before term-sheet work.`;
    } else if (hasBeneficial) {
      verdict = 'Cold Outreach · Target Mapped';
      verdictClass = 'is-neutral';
      investmentEffect = `No shared intro bridge connects ${perspectiveObj.name} to target(s); use mapped leadership and timing signals for cold origination.`;
    }
  } else {
    if (cautionCount > 0 && hasBeneficial) {
      verdict = hasDirectRisk && evidenceScore >= 60 ? 'Actionable · Verify Risks' : 'Mixed · Diligence Required';
      verdictClass = 'is-mixed';
      investmentEffect = `${sharedCommercialBottlenecks.length ? `${sharedCommercialBottlenecks.length} shared commercial bottleneck(s) and ` : ''}shared backers coexist with mapped overlap or conflict risks${primaryTargetName ? ` (focus: ${primaryTargetName})` : ''}.`;
    } else if (cautionCount > 0) {
      verdict = 'Caution · Verify Risks';
      verdictClass = 'is-caution';
      investmentEffect = 'Mapped competitive or structural risk requires verification before advancing.';
    } else if (evidenceScore >= 72 && hasBeneficial) {
      verdict = 'Strong Multi-Entity Signal';
      verdictClass = 'is-beneficial';
      investmentEffect = `High-provenance capital, commercial, and leadership convergence mapped${primaryTargetName ? ` around ${primaryTargetName}` : ''}; validate customer concentration separately.`;
    } else if (hasBeneficial) {
      verdict = 'Ecosystem Links Mapped';
      verdictClass = 'is-beneficial';
      investmentEffect = `Verified cross-entity links map backers, bottlenecks, and leadership${primaryTargetName ? ` relative to ${primaryTargetName}` : ''}.`;
    }
  }

  // Top Shared Bridge Highlights: diversify top access & lineage hubs before backfilling by weight
  const byGroupSorted = ['access', 'lineage', 'caution'].map((group) =>
    factors[group].rankedRecords
      .filter((r) => r.isSharedBridge && r.nodeId && !r.nodeId.startsWith('caution:'))
      .sort((a, b) => (b.signalWeight || 0) - (a.signalWeight || 0) || a.id.localeCompare(b.id))
      .map((r) => ({ ...r, highlightGroup: group }))
  );
  const sharedHighlightsMap = new Map();
  const maxRows = Math.max(0, ...byGroupSorted.map((list) => list.length));
  for (let i = 0; i < maxRows && sharedHighlightsMap.size < 4; i++) {
    for (const list of byGroupSorted) {
      const r = list[i];
      if (!r || sharedHighlightsMap.has(r.nodeId)) continue;
      const node = nodeById.get(r.nodeId);
      sharedHighlightsMap.set(r.nodeId, {
        nodeId: r.nodeId,
        edgeId: r.edgeId,
        name: node?.label || node?.name || r.canonicalFrom,
        entityType: node?.entityType || 'Entity',
        group: r.highlightGroup,
        structuralRole: r.structuralRole,
        sourceRank: r.sourceRank,
        sharedHubs: r.sharedHubs,
        signalWeight: r.signalWeight,
        summary: `${r.relation}${r.sharedHubs.length ? ` across ${r.sharedHubs.join(' & ')}` : ''}`
      });
      if (sharedHighlightsMap.size >= 4) break;
    }
  }
  const sharedBridgeHighlights = [...sharedHighlightsMap.values()];

  // Top Warm Intro / Structural Routes
  const warmIntroRoutes = factors.access.rankedRecords
    .filter((r) => !focalById.has(r.nodeId) || r.isSharedBridge || r.touchesPerspective)
    .slice(0, 4)
    .map((r) => ({
      entityName: nodeLabel(r.nodeId),
      nodeId: r.nodeId,
      edgeId: r.edgeId,
      focalName: focalById.get(r.focalEntityId)?.name || r.canonicalTo,
      structuralRole: r.structuralRole,
      isLead: r.isLead,
      isSharedBridge: r.isSharedBridge,
      touchesPerspective: r.touchesPerspective,
      sourceRank: r.sourceRank,
      routeLabel: r.perspectiveChain?.length ? r.perspectiveChain.join(' → ') : `${r.canonicalFrom} → ${r.canonicalTo}`
    }));

  // Top Diligence Actions
  const topDiligenceActions = ['caution', 'access', 'lineage', 'timing']
    .map((group) => ({
      factorGroup: group,
      label: factors[group].displayLabel || factors[group].label,
      check: factors[group].actionableCheck,
      targetEdgeId: factors[group].rankedRecords[0]?.edgeId || '',
      targetNodeId: factors[group].rankedRecords[0]?.nodeId || ''
    }))
    .filter((item) => item.check)
    .slice(0, 3);

  const modeLabel =
    resolvedMode === 'perspective_triage'
      ? `Origination Triage · ${perspectiveObj?.name || 'My Firm'}`
      : resolvedMode === 'single_teardown'
        ? `Company Teardown · ${focalList[0]?.name || 'Single Entity'}`
        : `Ecosystem & Peer Map (${focalList.length} entities)`;

  return {
    executive: {
      analysisMode: resolvedMode,
      modeLabel,
      perspectiveEntity: perspectiveObj,
      primaryTargetId: resolvedPrimaryTargetId,
      primaryTargetName,
      verdict,
      verdictClass,
      investmentEffect,
      evidenceScore,
      reliabilityGrade,
      verifiedSharePct: overallProv.verifiedSharePct,
      provenanceMix: overallProv,
      sharedBridgeHighlights,
      sharedCommercialBottlenecks,
      warmIntroRoutes,
      warmIntroChains: perspectiveObj?.warmIntroChains || [],
      isColdOutreach: perspectiveObj ? Boolean(perspectiveObj.isColdOutreach) : false,
      portfolioConflicts: perspectiveObj?.portfolioConflicts || [],
      missingDisclosures,
      dataAnomalies: dataAnomalies.slice(0, 6),
      topDiligenceActions
    },
    factors
  };
}
