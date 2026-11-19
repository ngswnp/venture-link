import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatInstitutionalEntityName,
  formatInstitutionalPath,
  matchClaudeFindingToRecord,
  computeMapUniqueProvenance,
  connectionStarKey,
  escapeCsvCell,
  buildVerifiedConnectionsCsv,
  buildIcDiligenceMemoMarkdown,
  buildShareableWorkspaceUrl,
  parseShareableWorkspaceParams
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
