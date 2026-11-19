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
