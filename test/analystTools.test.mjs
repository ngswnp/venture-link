import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatInstitutionalEntityName,
  formatInstitutionalPath,
  cleanInstitutionalProseNames,
  filterAndSortLedgerRecords,
  buildCrossEntityOverlapMatrix,
  buildOverlapMatrixCsv,
  buildChronologicalCatalystTimeline,
  matchClaudeFindingToRecord,
  computeMapUniqueProvenance,
  connectionStarKey,
  escapeCsvCell,
  buildVerifiedConnectionsCsv,
  buildIcDiligenceMemoMarkdown,
  buildShareableWorkspaceUrl,
  parseShareableWorkspaceParams,
  searchMappedGraphNodes,
  findShortestVerifiedPaths,
  buildDiligenceScopeKey,
  normalizeDiligenceState,
  computeDiligenceProgress,
  buildDossierEntityConfig,
  humanizeCalaRelation,
  organizeDossierConnections,
  organizeDossierPeople,
  organizeDossierTimeline,
  organizeDossierSources
} from '../public/analystTools.js';

test('formatInstitutionalEntityName normalizes raw 13F ALL-CAPS while preserving mixed-case & acronyms', () => {
  assert.equal(formatInstitutionalEntityName('BAILLIE GIFFORD & CO'), 'Baillie Gifford & Co');
  assert.equal(formatInstitutionalEntityName('BLAIR WILLIAM & CO/IL'), 'Blair William & Co/IL');
  assert.equal(formatInstitutionalEntityName('MONETARY MANAGEMENT GROUP INC'), 'Monetary Management Group Inc');
  assert.equal(formatInstitutionalEntityName('CISCO SYSTEMS, INC.'), 'Cisco Systems, Inc.');
  assert.equal(formatInstitutionalEntityName('NVIDIA CORPORATION'), 'NVIDIA Corporation');
  assert.equal(formatInstitutionalEntityName('SANDS CAPITAL MANAGEMENT, LLC'), 'Sands Capital Management, LLC');
  assert.equal(formatInstitutionalEntityName('OpenAI'), 'OpenAI');
  assert.equal(formatInstitutionalEntityName('xAI'), 'xAI');
  assert.equal(formatInstitutionalEntityName('SERIES_G_ROUND'), 'SERIES_G_ROUND');
});

test('formatInstitutionalPath preserves arrows and formats ALL-CAPS entity segments', () => {
  assert.equal(
    formatInstitutionalPath('BAILLIE GIFFORD & CO → Nvidia & Anthropic'),
    'Baillie Gifford & Co → Nvidia & Anthropic'
  );
  assert.equal(
    formatInstitutionalPath('Sequoia Capital → Anthropic & NVIDIA CORPORATION'),
    'Sequoia Capital → Anthropic & NVIDIA Corporation'
  );
});

test('matchClaudeFindingToRecord rejects mismatched multi-hop bridge entities (Sequoia -> xAI -> Anthropic vs Sequoia -> Anthropic & NVIDIA)', () => {
  const findings = [
    {
      connection: 'Sequoia Capital → xAI → Anthropic',
      meaning: 'xAI invested in Anthropic, creating a warm bridge from Sequoia existing xAI position.'
    },
    {
      connection: 'xAI → Anthropic & Sequoia Capital',
      meaning: 'xAI holds an overlapping investor relationship linking Anthropic and Sequoia.'
    }
  ];

  const wrongCandidateRec = {
    path: 'Sequoia Capital → Anthropic & NVIDIA CORPORATION',
    canonicalFrom: 'Sequoia Capital',
    canonicalTo: 'Anthropic & NVIDIA CORPORATION',
    sharedHubs: ['Anthropic', 'NVIDIA CORPORATION']
  };
  assert.equal(
    matchClaudeFindingToRecord(wrongCandidateRec, findings, { factorGroup: 'access', isPerson: false }),
    '',
    'Must NOT misattribute xAI finding onto Sequoia Capital -> Anthropic & NVIDIA CORPORATION'
  );

  const exactRec = {
    path: 'xAI → Anthropic & Sequoia Capital',
    canonicalFrom: 'xAI',
    canonicalTo: 'Anthropic & Sequoia Capital',
    sharedHubs: ['Anthropic', 'Sequoia Capital']
  };
  assert.equal(
    matchClaudeFindingToRecord(exactRec, findings, { factorGroup: 'access', isPerson: false }),
    'xAI holds an overlapping investor relationship linking Anthropic and Sequoia.'
  );
});

test('computeMapUniqueProvenance deduplicates shared source IDs across edges, timing, and factors', () => {
  const sourceById = new Map([
    ['s1', { id: 's1', sourceRank: 'FILING' }],
    ['s2', { id: 's2', sourceRank: 'PRIMARY' }],
    ['s3', { id: 's3', sourceRank: 'PRESS' }],
    ['s4', { id: 's4', sourceRank: 'AGGREGATOR' }]
  ]);
  const bridgeMap = {
    edges: [
      { id: 'tree-spoke-1', sourceIds: ['s4'] }, // spoke ignored
      { id: 'e1', sourceIds: ['s1', 's2'] },
      { id: 'e2', sourceIds: ['s1', 's3'] } // s1 repeated across edges
    ],
    timingEventsByEntity: {
      hub1: [{ sourceIds: ['s2', 's4'] }]
    },
    decisionIntelligence: {
      factors: {
        access: { sourceIds: ['s1', 's2'], rankedRecords: [] }
      }
    }
  };
  const mix = computeMapUniqueProvenance(bridgeMap, sourceById);
  assert.deepEqual(mix, {
    filing: 1,
    primary: 1,
    press: 1,
    aggregator: 1,
    total: 4,
    verifiedSharePct: 50
  });
});

test('buildVerifiedConnectionsCsv & buildIcDiligenceMemoMarkdown include starred flags, RFC-4180 escaping, and Cala gaps', () => {
  const sourceById = new Map([
    ['s1', { id: 's1', publisher: 'fintel.io', sourceRank: 'FILING', url: 'https://fintel.io/nvda' }],
    ['s2', { id: 's2', publisher: 'anthropic.com', sourceRank: 'PRIMARY', url: 'https://anthropic.com/news' }]
  ]);
  const rec1 = {
    id: 'r1',
    canonicalFrom: 'BAILLIE GIFFORD & CO',
    canonicalTo: 'Nvidia',
    path: 'BAILLIE GIFFORD & CO → Nvidia & Anthropic',
    nodeEntityType: 'Organization',
    sharedHubs: ['Nvidia', 'Anthropic'],
    structuralRole: 'capital',
    sourceRank: 'FILING',
    date: '2026-04-15',
    isRecentCatalyst: true,
    sourceIds: ['s1']
  };
  const rec2 = {
    id: 'r2',
    canonicalFrom: 'Daniela Amodei',
    canonicalTo: 'OpenAI & Anthropic',
    path: 'Daniela Amodei → OpenAI & Anthropic',
    nodeEntityType: 'Person',
    sharedHubs: ['OpenAI', 'Anthropic'],
    structuralRole: 'governance',
    sourceRank: 'PRIMARY',
    date: '',
    sourceIds: ['s2']
  };
  const starredKeys = new Set([connectionStarKey(rec1)]);
  const summary = {
    overall: { label: 'Actionable · Verify Risks' },
    investmentEffect: 'Shared institutional backers connect OpenAI, Nvidia, and Anthropic.',
    executive: {
      analysisMode: 'ecosystem_compare',
      modeLabel: 'Ecosystem & Peer Map (2 entities)',
      verifiedSharePct: 100,
      quarantinedCount: 12,
      missingDisclosures: ['No commercial customer breakdown indexed in Cala.'],
      dataAnomalies: []
    },
    factors: [
      { group: 'access', displayLabel: 'Shared Backers & Bottlenecks', shortTabLabel: 'Backers & Stack', count: 1, effect: 'Strong signal', line: 'Dual backers mapped', rankedRecords: [rec1] },
      { group: 'lineage', displayLabel: 'Talent & Corporate Lineage', shortTabLabel: 'Talent & M&A', count: 1, effect: 'Positive signal', line: 'Shared exec mapped', rankedRecords: [rec2] }
    ]
  };
  const bridgeMap = {
    focalEntities: [{ id: '1', name: 'Nvidia' }, { id: '2', name: 'Anthropic' }],
    edges: [{ id: 'e1', sourceIds: ['s1'] }, { id: 'e2', sourceIds: ['s2'] }]
  };

  assert.equal(escapeCsvCell('Hello, "World"'), '"Hello, ""World"""');
  const csv = buildVerifiedConnectionsCsv({
    summary,
    sourceById,
    factorEvidenceByGroup: { access: [rec1], lineage: [rec2] },
    starredKeys,
    deriveInsight: (r) => `Verified ${r.structuralRole} link.`
  });
  assert.ok(csv.startsWith('\uFEFFFactor,Path,'), 'CSV starts with UTF-8 BOM and expected header');
  assert.ok(csv.includes('Baillie Gifford & Co'), 'CSV formats ALL-CAPS institutional names');
  assert.ok(csv.includes('Yes'), 'CSV marks starred connection');
  assert.ok(csv.includes('https://fintel.io/nvda'), 'CSV includes direct source URL');

  const md = buildIcDiligenceMemoMarkdown({
    summary,
    bridgeMap,
    sourceById,
    factorEvidenceByGroup: { access: [rec1], lineage: [rec2] },
    starredKeys,
    deriveInsight: (r) => `Verified ${r.structuralRole} link.`,
    generatedAt: '2026-11-20'
  });
  assert.ok(md.includes('# VentureLink · Investment Committee Diligence Memo'));
  assert.ok(md.includes('## Flagged Connections for IC (1)'));
  assert.ok(md.includes('[fintel.io](https://fintel.io/nvda)'));
  assert.ok(md.includes('## Cala Disclosure Gaps & Data Hygiene Flags'));
  assert.ok(md.includes('No commercial customer breakdown indexed in Cala.'));
});

test('buildShareableWorkspaceUrl & parseShareableWorkspaceParams round-trip cleanly', () => {
  const url = buildShareableWorkspaceUrl(
    'http://127.0.0.1:4173',
    '/',
    [{ name: 'OpenAI' }, { name: 'Anthropic' }],
    { name: 'Sequoia Capital' }
  );
  assert.equal(url, 'http://127.0.0.1:4173/?map=OpenAI%2CAnthropic&perspective=Sequoia+Capital');
  const parsed = parseShareableWorkspaceParams(new URL(url).search);
  assert.deepEqual(parsed, {
    mapTerms: ['OpenAI', 'Anthropic'],
    perspectiveTerm: 'Sequoia Capital'
  });
  assert.deepEqual(parseShareableWorkspaceParams(''), {
    mapTerms: [],
    perspectiveTerm: null
  });
});

test('cleanInstitutionalProseNames normalizes multi-word ALL-CAPS entities without touching short acronyms', () => {
  const input = 'Shared backers (BAILLIE GIFFORD & CO, CISCO SYSTEMS, INC.) filed SEC 13F forms with M&A disclosures.';
  const cleaned = cleanInstitutionalProseNames(input);
  assert.equal(
    cleaned,
    'Shared backers (Baillie Gifford & Co, Cisco Systems, Inc.) filed SEC 13F forms with M&A disclosures.'
  );
});

test('filterAndSortLedgerRecords supports keyword search, tier/shared/recent/starred filters, and sorts', () => {
  const recA = {
    path: 'Sequoia Capital → OpenAI & Anthropic',
    canonicalFrom: 'Sequoia Capital',
    canonicalTo: 'OpenAI & Anthropic',
    relation: 'INVESTED_IN',
    date: '2026-07-03',
    sourceRank: 'PRIMARY',
    isSharedBridge: true,
    isRecentCatalyst: true,
    sharedHubs: ['OpenAI', 'Anthropic'],
    signalWeight: 1.4
  };
  const recB = {
    path: 'BAILLIE GIFFORD & CO → Nvidia',
    canonicalFrom: 'BAILLIE GIFFORD & CO',
    canonicalTo: 'Nvidia',
    relation: '13F Holding',
    date: '2024-04-15',
    sourceRank: 'FILING',
    isSharedBridge: false,
    isHistoricalMilestone: true,
    sharedHubs: ['Nvidia'],
    signalWeight: 1.0
  };
  const starred = new Set([connectionStarKey(recB)]);

  assert.equal(filterAndSortLedgerRecords([recA, recB], { query: 'baillie' }).length, 1);
  assert.equal(filterAndSortLedgerRecords([recA, recB], { filter: 'shared' }).length, 1);
  assert.equal(filterAndSortLedgerRecords([recA, recB], { filter: 'filing' })[0].canonicalFrom, 'BAILLIE GIFFORD & CO');
  assert.equal(filterAndSortLedgerRecords([recA, recB], { filter: 'starred', starredKeys: starred }).length, 1);
  assert.equal(filterAndSortLedgerRecords([recA, recB], { sort: 'date' })[0].date, '2026-07-03');
  assert.equal(filterAndSortLedgerRecords([recA, recB], { sort: 'signal', starredKeys: starred })[0].canonicalFrom, 'BAILLIE GIFFORD & CO');
});

test('buildCrossEntityOverlapMatrix & buildOverlapMatrixCsv compute intersection counts and clean CSV', () => {
  const bridgeMap = {
    focalEntities: [
      { id: 'f1', name: 'OpenAI' },
      { id: 'f2', name: 'Nvidia' },
      { id: 'f3', name: 'Anthropic' }
    ],
    nodes: [
      { id: 'f1', label: 'OpenAI', isFocalEntity: true },
      { id: 'f2', label: 'Nvidia', isFocalEntity: true },
      { id: 'f3', label: 'Anthropic', isFocalEntity: true },
      { id: 'inv1', label: 'Sequoia Capital', entityType: 'Organization' },
      { id: 'inv2', label: 'BAILLIE GIFFORD & CO', entityType: 'Organization' }
    ],
    edges: [
      { id: 'e1', from: 'inv1', to: 'f1', label: 'Invested', structuralRole: 'capital', topSourceRank: 'PRIMARY', date: '2026-07-03' },
      { id: 'e2', from: 'inv1', to: 'f2', label: 'Invested', structuralRole: 'capital', topSourceRank: 'PRIMARY' },
      { id: 'e3', from: 'inv1', to: 'f3', label: 'Invested', structuralRole: 'capital', topSourceRank: 'FILING' },
      { id: 'e4', from: 'inv2', to: 'f2', label: '13F Holder', structuralRole: 'capital', topSourceRank: 'FILING', date: '2026-03-31' }
    ]
  };
  const matrix = buildCrossEntityOverlapMatrix(bridgeMap);
  assert.equal(matrix.sharedRowCount, 1);
  assert.equal(matrix.totalRowCount, 2);
  assert.equal(matrix.rows[0].name, 'Sequoia Capital');
  assert.equal(matrix.rows[0].sharedCount, 3);
  assert.equal(matrix.rows[1].name, 'Baillie Gifford & Co');
  assert.equal(matrix.rows[1].sharedCount, 1);

  const csv = buildOverlapMatrixCsv(matrix);
  assert.ok(csv.includes('Sequoia Capital,Organization,capital,3/3,FILING'));
  assert.ok(csv.includes('Baillie Gifford & Co,Organization,capital,1/3,FILING,—,'));
});

test('buildChronologicalCatalystTimeline splits <=18m active vs >18m historical and extracts strict Cala amounts', () => {
  const bridgeMap = {
    referenceDate: '2026-11-20',
    focalEntities: [{ id: 'f1', name: 'Anthropic' }],
    nodes: [{ id: 'f1', label: 'Anthropic', isFocalEntity: true }],
    timingEventsByEntity: {
      f1: [
        { title: 'Series G $30B Financing', date: '2026-02-12', topSourceRank: 'PRIMARY', sourceIds: ['s1'] },
        { title: 'Seed Round Financing', date: '2021-05-01', topSourceRank: 'PRESS', sourceIds: ['s2'] }
      ]
    },
    edges: []
  };
  const tl = buildChronologicalCatalystTimeline(bridgeMap, '2026-11-20');
  assert.equal(tl.active.length, 1);
  assert.equal(tl.active[0].amount, '$30B');
  assert.equal(tl.historical.length, 1);
  assert.equal(tl.historical[0].amount, '');
});

test('searchMappedGraphNodes excludes group hubs and ranks shared high-tier matches first', () => {
  const bridgeMap = {
    focalEntityIds: ['f1', 'f2'],
    nodes: [
      { id: 'f1', label: 'OpenAI', kind: 'anchor', isFocalEntity: true },
      { id: 'f2', label: 'Anthropic', kind: 'anchor', isFocalEntity: true },
      { id: 'group-hub:access', label: 'Capital', kind: 'group-hub' },
      { id: 'seq', label: 'Sequoia Capital', entityType: 'Organization' },
      { id: 'minor', label: 'Sequoia Partner Note', entityType: 'Person' }
    ],
    edges: [
      { id: 'tree-spoke-1', from: 'group-hub:access', to: 'f1', topSourceRank: 'FILING' },
      { id: 'e1', from: 'seq', to: 'f1', label: 'Invested in', topSourceRank: 'FILING' },
      { id: 'e2', from: 'seq', to: 'f2', label: 'Invested in', topSourceRank: 'PRIMARY' },
      { id: 'e3', from: 'minor', to: 'f1', label: 'Mentioned', topSourceRank: 'AGGREGATOR' }
    ]
  };
  const all = searchMappedGraphNodes(bridgeMap, '');
  assert.equal(all.some((r) => r.id.startsWith('group-hub:')), false);
  assert.equal(all.length, 4);
  const seqMatches = searchMappedGraphNodes(bridgeMap, 'Sequoia');
  assert.equal(seqMatches[0].id, 'seq');
  assert.equal(seqMatches[0].sharedCount, 2);
  assert.equal(seqMatches[0].strongestTier, 'FILING');
});

test('findShortestVerifiedPaths computes minimum-hop verified BFS paths & provenance ranking', () => {
  const bridgeMap = {
    nodes: [
      { id: 'a', label: 'OpenAI' },
      { id: 'b', label: 'Sequoia Capital' },
      { id: 'c', label: 'Dario Amodei' },
      { id: 'd', label: 'Anthropic' },
      { id: 'isolated', label: 'Isolated Corp' }
    ],
    edges: [
      { id: 'tree-spoke-skip', from: 'a', to: 'd', topSourceRank: 'FILING' },
      { id: 'e1', from: 'a', to: 'b', label: 'Backed by', topSourceRank: 'FILING', date: '2026-07-03' },
      { id: 'e2', from: 'b', to: 'd', label: 'Invested in', topSourceRank: 'PRIMARY', date: '2026-06-01' },
      { id: 'e3', from: 'a', to: 'c', label: 'Former VP', topSourceRank: 'PRESS' },
      { id: 'e4', from: 'c', to: 'd', label: 'Co-founder', topSourceRank: 'PRESS' }
    ]
  };
  const res = findShortestVerifiedPaths(bridgeMap, 'a', 'd');
  assert.equal(res.found, true);
  assert.equal(res.hopCount, 2);
  assert.equal(res.paths.length, 2);
  // Higher provenance FILING+PRIMARY path ranks ahead of PRESS+PRESS path
  assert.deepEqual(res.paths[0].nodeIds, ['a', 'b', 'd']);
  assert.deepEqual(res.paths[0].edgeIds, ['e1', 'e2']);

  const none = findShortestVerifiedPaths(bridgeMap, 'a', 'isolated');
  assert.equal(none.found, false);
  assert.equal(none.paths.length, 0);
});

test('diligence state normalization, progress counts, and IC memo embedding work cleanly', () => {
  assert.equal(buildDiligenceScopeKey(['f2', 'f1', 'F2']), 'f1|f2');
  const norm = normalizeDiligenceState({
    access: { status: 'verified', note: 'Verified separate committees.', updatedAt: '2026-11-20' },
    caution: { status: 'blocked', note: 'Pending FTC filing check.' },
    lineage: { status: 'bogus', note: 'Fallback status' }
  });
  assert.equal(norm.access.status, 'verified');
  assert.equal(norm.lineage.status, 'open');

  const factors = [{ group: 'access', shortTabLabel: 'Backers' }, { group: 'lineage', shortTabLabel: 'Talent' }, { group: 'caution', shortTabLabel: 'Risks' }];
  const prog = computeDiligenceProgress(factors, norm);
  assert.equal(prog.verified, 1);
  assert.equal(prog.blocked, 1);
  assert.equal(prog.open, 1);
  assert.equal(prog.resolved, 2);

  const md = buildIcDiligenceMemoMarkdown({
    summary: {
      overall: { label: 'Proceed' },
      investmentEffect: 'Thesis',
      factors: [
        { group: 'access', displayLabel: 'Backers & Stack', shortTabLabel: 'Backers', effect: 'Strong', count: 3, actionableCheck: 'Check LP firewalls' },
        { group: 'lineage', displayLabel: 'Talent & M&A', shortTabLabel: 'Talent', effect: 'Moderate', count: 1, actionableCheck: 'Check founder overlap' },
        { group: 'caution', displayLabel: 'Rivalry & Risk', shortTabLabel: 'Risks', effect: 'Flag', count: 1, actionableCheck: 'Check FTC review' }
      ]
    },
    bridgeMap: { focalEntities: [{ id: 'f1', name: 'OpenAI' }], nodes: [], edges: [] },
    diligenceChecks: norm
  });
  assert.ok(md.includes('## IC Diligence Verification Tracker (1 Verified · 1 Blocked · 1 Open)'));
  assert.ok(md.includes('**Diligence Question [VERIFIED]:** Check LP firewalls'));
  assert.ok(md.includes('**Analyst Note:** Verified separate committees.'));
});

test('buildDossierEntityConfig adapts tabs, KPIs, and profile headings per entity type', () => {
  const personNoInv = buildDossierEntityConfig('Person', { peopleCount: 0, portfolioCount: 0, roundsCount: 0, investorsCount: 0 });
  assert.equal(personNoInv.archetype, 'person');
  assert.equal(personNoInv.profileCardTitle, 'Executive Profile');
  assert.deepEqual(personNoInv.visibleTabs.map((t) => t.key), ['overview', 'connections', 'timeline', 'sources']);
  assert.equal(personNoInv.visibleTabs.some((t) => t.key === 'people' || t.key === 'funding'), false);

  const personAngel = buildDossierEntityConfig('Person', { portfolioCount: 3 });
  assert.deepEqual(personAngel.visibleTabs.map((t) => t.key), ['overview', 'connections', 'funding', 'timeline', 'sources']);

  const investor = buildDossierEntityConfig('Fund', { peopleCount: 4, portfolioCount: 12 });
  assert.equal(investor.archetype, 'investor');
  assert.equal(investor.profileCardTitle, 'Firm Profile');
  assert.equal(investor.visibleTabs.find((t) => t.key === 'funding')?.label, 'Portfolio');
  assert.equal(investor.visibleTabs.find((t) => t.key === 'people')?.label, 'Team');

  const roundEv = buildDossierEntityConfig('Round', { investorsCount: 5 });
  assert.equal(roundEv.archetype, 'event');
  assert.equal(roundEv.kpis.length, 3);
  assert.equal(roundEv.visibleTabs.some((t) => t.key === 'people' || t.key === 'timeline'), false);

  const company = buildDossierEntityConfig('Company', { peopleCount: 8, roundsCount: 3, investorsCount: 12 });
  assert.equal(company.archetype, 'company');
  assert.equal(company.profileCardTitle, 'Company Profile');
  assert.deepEqual(company.visibleTabs.map((t) => t.key), ['overview', 'people', 'funding', 'connections', 'timeline', 'sources']);
});

test('humanizeCalaRelation translates single and compound 2-hop Cala enums cleanly', () => {
  assert.equal(humanizeCalaRelation('IS_CEO_OF'), 'Chief Executive Officer');
  assert.equal(humanizeCalaRelation('FOUNDED', 'outgoing'), 'Founder');
  assert.equal(humanizeCalaRelation('FOUNDED', 'incoming'), 'Founded by');
  assert.equal(humanizeCalaRelation('INVESTED_IN', 'incoming'), 'Backed by');
  assert.equal(humanizeCalaRelation('INVESTED_IN', 'outgoing'), 'Invested in');
  assert.equal(humanizeCalaRelation('WORKS_AT / WORKS_AT'), 'Shared Leadership / Alumni');
  assert.equal(humanizeCalaRelation('OPERATES_IN_INDUSTRY / OPERATES_IN_INDUSTRY'), 'Shared Sector');
  assert.equal(humanizeCalaRelation('IS_CEO_OF / INVESTED_IN', 'outgoing / incoming'), 'Chief Executive Officer · Backed by');
});

test('organizeDossierConnections consolidates duplicates, isolates contextual overlaps, and orders direct before bridge', () => {
  const remoteConns = [
    { entityId: 'e-us', entityName: 'United States', connectionType: 'shared_bridge', relation: 'HAS_HEADQUARTERS_IN / HAS_HEADQUARTERS_IN', direction: 'outgoing / outgoing', bridge: { id: 'b-us', name: 'United States' }, sourceTier: 'PRIMARY' },
    { entityId: 'e-anth', entityName: 'Anthropic', connectionType: 'direct', relation: 'IS_CMO_OF', direction: 'outgoing', sourceTier: 'PRIMARY' },
    { entityId: 'e-anth', entityName: 'Anthropic', connectionType: 'direct', relation: 'IS_CEO_OF', direction: 'outgoing', eventDate: '2025-02-10', sourceTier: 'FILING' },
    { entityId: 'e-xai', entityName: 'xAI', connectionType: 'shared_bridge', relation: 'INVESTED_IN / INVESTED_IN', bridge: { id: 'b-seq', name: 'SEQUOIA CAPITAL' }, sourceTier: 'PRESS' }
  ];
  const mapEdges = [
    { id: 'edge-anth', from: 'self-da', to: 'e-anth', relation: 'WORKS_AT', topSourceRank: 'PRESS' },
    { id: 'tree-spoke-x', from: 'self-da', to: 'group-hub:lineage', relation: 'IS_MEMBER_OF' }
  ];
  const mapNodes = [
    { id: 'self-da', label: 'Daniela Amodei' },
    { id: 'e-anth', label: 'Anthropic' },
    { id: 'group-hub:lineage', kind: 'group-hub', label: 'Lineage' }
  ];

  const org = organizeDossierConnections(remoteConns, mapEdges, { selfId: 'self-da', selfName: 'Daniela Amodei', mapNodes });
  assert.equal(org.stats.contextualCount, 1);
  assert.equal(org.stats.totalSubstantive, 2);
  assert.equal(org.stats.directCount, 1);
  assert.equal(org.stats.bridgeCount, 1);
  assert.equal(org.substantiveItems[0].targetName, 'Anthropic');
  assert.equal(org.substantiveItems[0].bestTier, 'FILING');
  assert.equal(org.substantiveItems[0].onMap, true);
  assert.equal(org.substantiveItems[0].focusEdgeId, 'edge-anth');
  assert.ok(org.substantiveItems[0].roles.includes('Chief Executive Officer'));
  assert.ok(org.substantiveItems[0].roles.includes('Chief Marketing Officer'));
  assert.equal(org.substantiveItems[1].bridgeName, 'Sequoia Capital');
  assert.equal(org.contextualItems[0].isContextual, true);
});

test('organizeDossierPeople deduplicates multi-role executives and sorts leadership first', () => {
  const people = [
    { id: 'p-ez', name: 'Eric Zelikman', relation: 'WORKS_AT', role: 'AI researcher' },
    { id: 'p-em', name: 'Elon Musk', relation: 'FOUNDED', role: 'Founder', sourceTier: 'PRIMARY' },
    { id: 'p-em', name: 'Elon Musk', relation: 'IS_CEO_OF', role: 'Chief Executive Officer', validSince: '2023-07-12', sourceTier: 'FILING' },
    { id: 'p-kf', name: 'Kieran Flanagan', relation: 'IS_MEMBER_OF', role: 'Executive / Operator', validSince: '2021-09-01' }
  ];
  const res = organizeDossierPeople(people);
  assert.equal(res.stats.total, 3);
  assert.equal(res.stats.executiveCount, 2);
  assert.equal(res.stats.teamCount, 1);
  assert.equal(res.items[0].name, 'Elon Musk');
  assert.equal(res.items[0].bestTier, 'FILING');
  assert.deepEqual(res.items[0].roles, ['Founder', 'Chief Executive Officer']);
  assert.equal(res.items[1].name, 'Kieran Flanagan');
  assert.deepEqual(res.items[1].roles, ['Board / Member']);
});

test('organizeDossierTimeline sorts newest first, assigns archetype categories, and avoids empty MISSING badges', () => {
  const data = {
    corporateEvents: [{ id: 'ev1', name: 'Series G Announced', type: 'FUNDING', eventDate: '2026-07-01', sourceTier: 'FILING' }],
    relationships: {
      outgoing: {
        IS_CEO_OF: [{ id: 'c1', name: 'Anthropic', role: 'Chief Executive Officer', eventDate: '2021-01-01' }],
        SPOKE_AT: [{ id: 's1', name: 'AI Summit', eventDate: '2026-09-10', sourceTier: 'PRESS' }],
        SPOKE_AT_DUP: []
      },
      incoming: {
        CREATED_BY: [{ id: 'p1', name: 'Grok 3', entityType: 'Product' }]
      }
    }
  };
  const personTl = organizeDossierTimeline(data, 'person', '2026-11-20');
  assert.equal(personTl.items[0].title, 'AI Summit');
  assert.equal(personTl.items[0].isRecent, true);
  assert.equal(personTl.items.every((it) => it.tier !== 'Not found in Cala'), true);
  assert.ok(personTl.categories.some((c) => c.key === 'roles'));
  assert.ok(personTl.categories.some((c) => c.key === 'press'));

  const companyTl = organizeDossierTimeline(data, 'company', '2026-11-20');
  assert.equal(companyTl.items[companyTl.items.length - 1].category, 'products');
});

test('organizeDossierSources ranks FILING > PRIMARY > PRESS > AGGREGATOR > CALA GRAPH', () => {
  const res = organizeDossierSources([
    { id: 's1', title: 'Wiki summary', sourceRank: 'AGGREGATOR', date: '2025-01-01' },
    { id: 's2', title: 'SEC Form D', sourceTier: 'FILING', date: '2026-02-01' },
    { id: 's2', title: 'SEC Form D dup', sourceTier: 'FILING', date: '2026-02-01' },
    { id: 's3', title: 'Company Blog', sourceRank: 'PRIMARY', date: '2026-05-01' }
  ]);
  assert.equal(res.counts.all, 3);
  assert.equal(res.counts.FILING, 1);
  assert.equal(res.counts.PRIMARY, 1);
  assert.equal(res.items[0].tier, 'FILING');
  assert.equal(res.items[1].tier, 'PRIMARY');
  assert.equal(res.items[2].tier, 'AGGREGATOR');
});
