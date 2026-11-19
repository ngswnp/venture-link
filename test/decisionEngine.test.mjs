import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionIntelligence } from '../src/decisionEngine.mjs';

test('buildDecisionIntelligence computes provenance-weighted scores, hub-balanced records, and dual-sided caution flags', () => {
  const focalEntities = [
    { id: 'hub-a', name: 'Alpha AI' },
    { id: 'hub-b', name: 'Beta Compute' }
  ];
  const nodes = [
    { id: 'hub-a', label: 'Alpha AI', entityType: 'Company', isFocalEntity: true },
    { id: 'hub-b', label: 'Beta Compute', entityType: 'Company', isFocalEntity: true },
    { id: 'inv-1', label: 'Sequoia Capital', entityType: 'Organization', isSharedBridge: true },
    { id: 'inv-2', label: 'North Fund', entityType: 'Organization' },
    { id: 'inv-3', label: 'South Ventures', entityType: 'Organization' },
    { id: 'exec-1', label: 'Jane Doe', entityType: 'Person', isSharedBridge: true },
    { id: 'ev-1', label: 'Series B · $50M', entityType: 'Timing Catalyst', kind: 'event' },
    { id: 'caut-1', label: 'AI Software Rivalry', entityType: 'Competitive Overlap', kind: 'caution' }
  ];
  const edges = [
    {
      id: 'e-seq-a',
      from: 'inv-1',
      to: 'hub-a',
      focalEntityId: 'hub-a',
      relation: 'INVESTED_IN',
      label: 'Invested in',
      contributionGroup: 'access',
      topSourceRank: 'FILING',
      isSharedBridge: true,
      isLead: true,
      sharedByFocalEntityIds: ['hub-a', 'hub-b'],
      date: '2026-03-01',
      sourceIds: ['s1']
    },
    {
      id: 'e-seq-b',
      from: 'inv-1',
      to: 'hub-b',
      focalEntityId: 'hub-b',
      relation: 'INVESTED_IN',
      label: 'Invested in',
      contributionGroup: 'access',
      topSourceRank: 'PRIMARY',
      isSharedBridge: true,
      sharedByFocalEntityIds: ['hub-a', 'hub-b'],
      date: '2026-04-01',
      sourceIds: ['s2']
    },
    {
      id: 'e-inv2-a',
      from: 'inv-2',
      to: 'hub-a',
      focalEntityId: 'hub-a',
      relation: 'INVESTED_IN',
      label: 'Invested in',
      contributionGroup: 'access',
      topSourceRank: 'PRESS',
      sourceIds: ['s3']
    },
    {
      id: 'e-inv3-b',
      from: 'inv-3',
      to: 'hub-b',
      focalEntityId: 'hub-b',
      relation: 'INVESTED_IN',
      label: 'Invested in',
      contributionGroup: 'access',
      topSourceRank: 'FILING',
      sourceIds: ['s4']
    },
    {
      id: 'e-jane-a',
      from: 'exec-1',
      to: 'hub-a',
      focalEntityId: 'hub-a',
      relation: 'IS_CEO_OF',
      label: 'Leads as CEO of',
      contributionGroup: 'lineage',
      topSourceRank: 'FILING',
      isSharedBridge: true,
      sharedByFocalEntityIds: ['hub-a', 'hub-b'],
      date: '2025-01-01',
      sourceIds: ['s5']
    },
    {
      id: 'e-jane-b',
      from: 'exec-1',
      to: 'hub-b',
      focalEntityId: 'hub-b',
      relation: 'IS_VICEPRESIDENT_OF',
      label: 'Served as VP at',
      contributionGroup: 'lineage',
      topSourceRank: 'PRIMARY',
      isSharedBridge: true,
      sharedByFocalEntityIds: ['hub-a', 'hub-b'],
      date: '2022-05-01',
      sourceIds: ['s6']
    },
    {
      id: 'e-time-a',
      from: 'hub-a',
      to: 'ev-1',
      focalEntityId: 'hub-a',
      relation: 'DATED_MILESTONE',
      label: 'Series B · $50M (2026-04-10)',
      contributionGroup: 'timing',
      topSourceRank: 'PRIMARY',
      date: '2026-04-10',
      sourceIds: ['s7']
    },
    {
      id: 'e-caut-a',
      from: 'hub-a',
      to: 'caut-1',
      focalEntityId: 'hub-a',
      relation: 'SECTOR_COMPETITION',
      label: 'Direct AI Software overlap',
      contributionGroup: 'caution',
      topSourceRank: 'PRIMARY',
      isSharedBridge: true,
      sharedByFocalEntityIds: ['hub-a', 'hub-b'],
      sourceIds: ['s8']
    }
  ];
  const anomalies = [
    {
      kind: 'timing_anomaly',
      relation: 'TIMING_EVENT',
      path: 'Alpha AI · Series A',
      detail: 'Out-of-sequence round: Series A (2026-06-01) appears after Series B (2026-04-10).',
      date: '2026-06-01',
      sourceRank: 'PRESS',
      sourceIds: ['s9']
    }
  ];

  const intel = buildDecisionIntelligence({ focalEntities, nodes, edges, anomalies });
  assert.ok(intel.executive.evidenceScore > 40);
  assert.ok(['A', 'B', 'C', 'D'].includes(intel.executive.reliabilityGrade));
  assert.equal(intel.executive.verdictClass, 'is-mixed');
  assert.ok(intel.executive.sharedBridgeHighlights.length >= 2);
  assert.ok(intel.executive.warmIntroRoutes.length >= 2);
  assert.equal(intel.executive.dataAnomalies.length, 1);

  assert.equal(intel.factors.access.coverage.hubCoverage.find((h) => h.id === 'hub-b').count, 2);
  assert.equal(intel.factors.access.rankedRecords[0].path, 'Sequoia Capital → Alpha AI');
  assert.ok(intel.factors.access.provenanceMix.verifiedSharePct >= 75);

  const cautionTypes = new Set(intel.factors.caution.rankedRecords.map((r) => r.type));
  assert.ok(cautionTypes.has('SECTOR_COMPETITION'));
  assert.ok(cautionTypes.has('DUAL_SIDED_INVESTOR_CONFLICT'));
  assert.ok(cautionTypes.has('CROSS_HUB_TALENT_OVERLAP'));
  assert.ok(cautionTypes.has('ROUND_SEQUENCE_ANOMALY'));
  assert.equal(intel.factors.caution.tierClass, 'is-caution');
});

test('buildDecisionIntelligence handles sparse single-entity maps cleanly', () => {
  const intel = buildDecisionIntelligence({
    focalEntities: [{ id: 'solo', name: 'Solo Startup' }],
    nodes: [{ id: 'solo', label: 'Solo Startup', entityType: 'Company', isFocalEntity: true }],
    edges: [],
    anomalies: []
  });
  assert.equal(intel.executive.evidenceScore, 0);
  assert.equal(intel.executive.verdict, 'Limited Coverage');
  assert.equal(intel.executive.verdictClass, 'is-neutral');
  assert.equal(intel.factors.caution.tier, 'Clear');
  assert.equal(intel.factors.access.count, 0);
});

test('buildDecisionIntelligence adapts labels, timing recency, ACQUIRED M&A, cold outreach, and portfolio conflicts per analysisMode', () => {
  const teardown = buildDecisionIntelligence({
    focalEntities: [{ id: 'nvda', name: 'NVIDIA' }],
    nodes: [
      { id: 'nvda', label: 'NVIDIA', entityType: 'Company', isFocalEntity: true },
      { id: 'tsmc', label: 'TSMC', entityType: 'Company' },
      { id: 'mlnx', label: 'Mellanox', entityType: 'Company' },
      { id: 'ev-old', label: 'Series B · $20M', entityType: 'Historical Milestone', kind: 'event' }
    ],
    edges: [
      {
        id: 'e-sup',
        from: 'nvda',
        to: 'tsmc',
        focalEntityId: 'nvda',
        relation: 'SUPPLIED_BY',
        label: 'Supplied by',
        contributionGroup: 'access',
        structuralRole: 'commercial',
        topSourceRank: 'PRIMARY',
        sourceIds: ['s1']
      },
      {
        id: 'e-acq',
        from: 'nvda',
        to: 'mlnx',
        focalEntityId: 'nvda',
        relation: 'ACQUIRED',
        label: 'Acquired',
        contributionGroup: 'caution',
        structuralRole: 'governance',
        isAcquisition: true,
        topSourceRank: 'FILING',
        date: '2020-04-27',
        sourceIds: ['s2']
      },
      {
        id: 'e-old-ev',
        from: 'nvda',
        to: 'ev-old',
        focalEntityId: 'nvda',
        relation: 'DATED_MILESTONE',
        label: 'Series B (2021-05-01)',
        contributionGroup: 'timing',
        structuralRole: 'capital',
        timingRecency: 'historical_milestone',
        isRecentCatalyst: false,
        isHistoricalMilestone: true,
        topSourceRank: 'PRIMARY',
        date: '2021-05-01',
        sourceIds: ['s3']
      }
    ],
    analysisMode: 'single_teardown',
    referenceDate: '2026-11-19'
  });

  assert.equal(teardown.executive.analysisMode, 'single_teardown');
  assert.equal(teardown.factors.access.displayLabel, 'Capital & Value Chain');
  assert.equal(teardown.factors.lineage.displayLabel, 'Governance, Leadership & M&A');
  assert.equal(teardown.factors.caution.count, 0, 'ACQUIRED must never be routed into caution without conflict');
  assert.equal(teardown.factors.lineage.structuralBreakdown.acquisitionCount, 1);
  assert.match(teardown.factors.timing.headline, /No recent catalysts/i);
  assert.ok(teardown.executive.missingDisclosures.length >= 2);

  const triageCold = buildDecisionIntelligence({
    focalEntities: [{ id: 'target-1', name: 'Target Co' }],
    nodes: [
      { id: 'target-1', label: 'Target Co', entityType: 'Company', isFocalEntity: true },
      { id: 'inv-other', label: 'Other VC', entityType: 'Organization' }
    ],
    edges: [
      {
        id: 'e-other-inv',
        from: 'inv-other',
        to: 'target-1',
        focalEntityId: 'target-1',
        relation: 'INVESTED_IN',
        label: 'Invested in',
        contributionGroup: 'access',
        structuralRole: 'capital',
        touchesPerspective: false,
        topSourceRank: 'PRIMARY',
        sourceIds: ['s4']
      }
    ],
    analysisMode: 'perspective_triage',
    perspectiveEntity: {
      id: 'my-vc',
      name: 'Alpha Fund',
      isColdOutreach: true,
      warmIntroChains: [],
      portfolioConflicts: [
        {
          kind: 'SECTOR_OVERLAP',
          portfolioId: 'port-1',
          portfolioName: 'Portfolio Rival',
          targetId: 'target-1',
          targetName: 'Target Co',
          industry: 'AI Software',
          reason: 'Alpha Fund backs Portfolio Rival in AI Software, overlapping Target Co.',
          sourceIds: ['s5']
        }
      ]
    },
    referenceDate: '2026-11-19'
  });

  assert.equal(triageCold.factors.access.count, 0, 'Third-party investors must not count as Access when perspective_triage is active');
  assert.equal(triageCold.factors.access.tier, 'Cold Outreach');
  assert.match(triageCold.factors.access.headline, /No shared path from Alpha Fund/i);
  assert.ok(triageCold.factors.caution.rankedRecords.some((r) => r.type === 'PORTFOLIO_OVERLAP'));

  const eco = buildDecisionIntelligence({
    focalEntities: [
      { id: 'co-a', name: 'OpenAI' },
      { id: 'co-b', name: 'Anthropic' }
    ],
    nodes: [
      { id: 'co-a', label: 'OpenAI', entityType: 'Company', isFocalEntity: true },
      { id: 'co-b', label: 'Anthropic', entityType: 'Company', isFocalEntity: true },
      { id: 'nvda', label: 'NVIDIA', entityType: 'Company', isSharedBridge: true, sharedByFocalEntityIds: ['co-a', 'co-b'] }
    ],
    edges: [
      {
        id: 'e-sup-a',
        from: 'nvda',
        to: 'co-a',
        focalEntityId: 'co-a',
        relation: 'SUPPLIES',
        label: 'Supplies',
        contributionGroup: 'access',
        structuralRole: 'commercial',
        isSharedBridge: true,
        sharedByFocalEntityIds: ['co-a', 'co-b'],
        topSourceRank: 'PRIMARY',
        sourceIds: ['s6']
      },
      {
        id: 'e-sup-b',
        from: 'nvda',
        to: 'co-b',
        focalEntityId: 'co-b',
        relation: 'SUPPLIES',
        label: 'Supplies',
        contributionGroup: 'access',
        structuralRole: 'commercial',
        isSharedBridge: true,
        sharedByFocalEntityIds: ['co-a', 'co-b'],
        topSourceRank: 'PRIMARY',
        sourceIds: ['s7']
      }
    ],
    analysisMode: 'ecosystem_compare',
    primaryTargetId: 'co-b',
    referenceDate: '2026-11-19'
  });

  assert.equal(eco.executive.primaryTargetId, 'co-b');
  assert.equal(eco.executive.primaryTargetName, 'Anthropic');
  assert.equal(eco.executive.sharedCommercialBottlenecks[0]?.name, 'NVIDIA');
});

test('decisionEngine provides concise shortTabLabel across modes, nodeEntityType on records, and prioritizes organizations ahead of persons in access headlines', () => {
  const nodes = [
    { id: 'co-1', label: 'OpenAI', entityType: 'Company', isFocalEntity: true },
    { id: 'co-2', label: 'Anthropic', entityType: 'Company', isFocalEntity: true },
    { id: 'person-1', label: 'Daniela Amodei', entityType: 'Person', isSharedBridge: true, sharedByFocalEntityIds: ['co-1', 'co-2'] },
    { id: 'org-1', label: 'Microsoft Corporation', entityType: 'Organization', isSharedBridge: true, sharedByFocalEntityIds: ['co-1', 'co-2'] }
  ];
  const edges = [
    {
      id: 'e-person-1',
      from: 'person-1',
      to: 'co-1',
      focalEntityId: 'co-1',
      relation: 'PARTICIPATED_IN_FUNDING',
      label: 'Invested in',
      contributionGroup: 'access',
      structuralRole: 'capital',
      isSharedBridge: true,
      sharedByFocalEntityIds: ['co-1', 'co-2'],
      topSourceRank: 'FILING',
      sourceIds: ['s-p1']
    },
    {
      id: 'e-org-1',
      from: 'org-1',
      to: 'co-2',
      focalEntityId: 'co-2',
      relation: 'INVESTED_IN',
      label: 'Invested in',
      contributionGroup: 'access',
      structuralRole: 'capital',
      isSharedBridge: true,
      sharedByFocalEntityIds: ['co-1', 'co-2'],
      topSourceRank: 'PRIMARY',
      sourceIds: ['s-o1']
    }
  ];

  for (const mode of ['single_teardown', 'ecosystem_compare', 'perspective_triage']) {
    const out = buildDecisionIntelligence({
      focalEntities: mode === 'ecosystem_compare'
        ? [{ id: 'co-1', name: 'OpenAI' }, { id: 'co-2', name: 'Anthropic' }]
        : [{ id: 'co-1', name: 'OpenAI' }],
      nodes,
      edges,
      analysisMode: mode,
      perspectiveEntity: mode === 'perspective_triage' ? { id: 'org-1', name: 'Microsoft Corporation', warmIntroChains: [], portfolioConflicts: [] } : null,
      referenceDate: '2026-11-19'
    });
    for (const grp of ['access', 'lineage', 'timing', 'caution']) {
      const f = out.factors[grp];
      assert.ok(f.shortTabLabel && f.shortTabLabel.length <= 18, `${mode}.${grp} shortTabLabel "${f.shortTabLabel}" must be <= 18 chars`);
    }
    if (mode === 'ecosystem_compare') {
      assert.ok(out.factors.access.rankedRecords.every((r) => Boolean(r.nodeEntityType)), 'Every record should carry nodeEntityType');
      assert.match(out.factors.access.headline, /Microsoft Corporation/, 'Organization bridge should headline ahead of Person bridge in access');
    }
  }
});
