import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeConnectionWithCitationGate,
  applyCitationAndNumericGate,
  compileSearchQuery,
  narrateBriefWithCitationGate,
  validateCompiledFilters
} from '../src/llmControlPlane.mjs';
import { buildStartupBrief } from '../src/engine.mjs';

test('validateCompiledFilters strictly whitelists schema values and strips unsafe/unknown inputs', () => {
  const valid = validateCompiledFilters({
    intent: 'general',
    region: 'Nordics',
    stageFilter: 'pre_seed_seed',
    sectors: ['Climate Tech', 'Invented Sector', 'DeepTech'],
    excludeSector: 'Fintech',
    raisingSoonOnly: true,
    untappedOnly: 'yes', // non-boolean must normalize to false
    slushOnly: true,
    minHeadcountGrowthPct: 45.6,
    requireAlumniFounder: true,
    investorQuery: '  Lifeline Ventures <script> ',
    companyQuery: null,
    whyNotCompany: null,
    entityScope: 'all',
    countryHint: 'Finland',
    expandedKeywords: ['Aiven', 'Grid!', 'Storage-Tech', 'x', 'very-valid-kw']
  });

  assert.equal(valid.intent, 'general');
  assert.equal(valid.region, 'Nordics');
  assert.equal(valid.stageFilter, 'pre_seed_seed');
  assert.deepEqual(valid.sectors, ['Climate Tech', 'DeepTech']);
  assert.equal(valid.excludeSector, 'Fintech');
  assert.equal(valid.raisingSoonOnly, true);
  assert.equal(valid.untappedOnly, false);
  assert.equal(valid.slushOnly, true);
  assert.equal(valid.minHeadcountGrowthPct, 46);
  assert.equal(valid.requireAlumniFounder, true);
  assert.equal(valid.investorQuery, 'Lifeline Ventures script');
  assert.equal(valid.entityScope, 'all');
  assert.equal(valid.countryHint, 'Finland');
  assert.deepEqual(valid.expandedKeywords, ['aiven', 'grid', 'storage-tech', 'very-valid-kw']);

  const badRegion = validateCompiledFilters({
    intent: 'hack_score',
    region: 'Mars',
    stageFilter: 'Series Z',
    excludeSector: 'Bogus',
    entityScope: 'invalid_scope',
    minHeadcountGrowthPct: 9999
  });
  assert.equal(badRegion.intent, 'general');
  assert.equal(badRegion.region, 'all');
  assert.equal(badRegion.stageFilter, 'all');
  assert.equal(badRegion.excludeSector, 'none');
  assert.equal(badRegion.entityScope, 'startups');
  assert.equal(badRegion.minHeadcountGrowthPct, null);
});

test('compileSearchQuery compiles via mocked Anthropic API, sends exact headers, validates JSON, and caches repeats', async () => {
  const calls = [];
  const cache = new Map();
  const mockFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          content: [
            {
              type: 'text',
              text: '```json\n{"intent":"general","region":"Nordics","stageFilter":"pre_seed_seed","sectors":["Climate Tech","Hallucinated"],"excludeSector":"none","raisingSoonOnly":true,"untappedOnly":false,"slushOnly":true,"minHeadcountGrowthPct":30,"requireAlumniFounder":true,"investorQuery":null,"companyQuery":null,"whyNotCompany":null,"expandedKeywords":["aiven","grid","storage"]}\n```'
            }
          ]
        };
      }
    };
  };

  const first = await compileSearchQuery(
    'ex-Aiven founders in grid storage raising soon at Slush',
    { fundId: 'lifeline-ventures', knownInvestors: ['Lifeline Ventures'] },
    { apiKey: 'test-anthropic-key', model: 'claude-3-5-haiku-latest', fetchFn: mockFetch, cache }
  );

  assert.equal(first.controlPlaneMode, 'anthropic-query-compiler');
  assert.equal(first.fromCache, false);
  assert.equal(first.filters.region, 'Nordics');
  assert.deepEqual(first.filters.sectors, ['Climate Tech']);
  assert.equal(first.filters.raisingSoonOnly, true);
  assert.equal(first.filters.slushOnly, true);
  assert.equal(first.filters.requireAlumniFounder, true);
  assert.deepEqual(first.filters.expandedKeywords, ['aiven', 'grid', 'storage']);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], 'test-anthropic-key');
  assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].body.temperature, 0);

  const second = await compileSearchQuery(
    'ex-Aiven founders in grid storage raising soon at Slush',
    { fundId: 'lifeline-ventures' },
    { apiKey: 'test-anthropic-key', fetchFn: mockFetch, cache }
  );
  assert.equal(second.fromCache, true);
  assert.equal(calls.length, 1);
});

test('compileSearchQuery falls back silently on missing key, 401 HTTP error, malformed JSON, and timeout', async () => {
  const noKey = await compileSearchQuery('Nordic seed startups', {}, { apiKey: '' });
  assert.equal(noKey.controlPlaneMode, 'deterministic-parser');
  assert.equal(noKey.filters, null);

  const err401 = await compileSearchQuery(
    'Nordic seed startups',
    {},
    {
      apiKey: 'bad-key',
      cache: new Map(),
      fetchFn: async () => ({ ok: false, status: 401 })
    }
  );
  assert.equal(err401.controlPlaneMode, 'deterministic-parser');
  assert.equal(err401.filters, null);
  assert.equal(err401.fallbackReason, 'http-401');

  const slowTimeout = await compileSearchQuery(
    'Slow query test',
    {},
    {
      apiKey: 'key',
      timeoutMs: 25,
      cache: new Map(),
      fetchFn: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 150))
    }
  );
  assert.equal(slowTimeout.controlPlaneMode, 'deterministic-parser');
  assert.equal(slowTimeout.filters, null);
});

test('applyCitationAndNumericGate & narrateBriefWithCitationGate enforce sourceIds plus numeric and year grounding', async () => {
  const brief = buildStartupBrief('vectormesh', 'lifeline-ventures');
  const validSourceId = brief.sources[0].id;
  const latestRound = brief.rounds[brief.rounds.length - 1];

  const gated = applyCitationAndNumericGate(
    [
      {
        text: `${brief.name} raised €${latestRound.amountEurM}M in ${latestRound.date.slice(0, 4)}.`,
        sourceIds: [validSourceId]
      },
      {
        text: `${brief.name} quietly booked €99.4M ARR from undisclosed customers.`,
        sourceIds: [validSourceId]
      },
      {
        text: `${brief.name} was incorporated back in 2011 in London.`,
        sourceIds: [validSourceId]
      },
      {
        text: `${brief.name} raised €${latestRound.amountEurM}M with fake citation.`,
        sourceIds: ['src-nonexistent-999']
      }
    ],
    brief
  );

  assert.equal(gated.bullets.length, 1);
  assert.equal(gated.droppedUnverifiedCount, 3);
  assert.ok(gated.bullets[0].sources.some((s) => s.id === validSourceId));

  const narrated = await narrateBriefWithCitationGate(brief, {
    apiKey: 'test-anthropic-key',
    cache: new Map(),
    fetchFn: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                bullets: [
                  {
                    text: `${brief.name} closed €${latestRound.amountEurM}M (${latestRound.type}) in ${latestRound.date.slice(0, 4)}.`,
                    sourceIds: [validSourceId]
                  },
                  {
                    text: 'Hallucinated $42M ARR projection.',
                    sourceIds: [validSourceId]
                  }
                ]
              })
            }
          ]
        };
      }
    })
  });

  assert.equal(narrated.controlPlaneMode, 'anthropic-citation-narrator');
  assert.equal(narrated.bullets.length, 1);
  assert.equal(narrated.droppedUnverifiedCount, 1);
  assert.deepEqual(narrated.coverageGaps, brief.notFoundInCala);

  const fallback = await narrateBriefWithCitationGate(brief, {
    apiKey: 'bad-key',
    cache: new Map(),
    fetchFn: async () => ({ ok: false, status: 401 })
  });
  assert.equal(fallback.controlPlaneMode, 'deterministic-fallback');
  assert.ok(fallback.bullets.length >= 1);
});

test('compileSearchQuery sets entityScope "all" cleanly for public/general company queries', async () => {
  const detMcd = await compileSearchQuery("McDonald's", {}, { apiKey: '' });
  assert.equal(detMcd.controlPlaneMode, 'deterministic-parser');
  assert.equal(detMcd.filters, null);

  const mockedClaude = await compileSearchQuery(
    'find KFC corporate parent',
    {},
    {
      apiKey: 'mock-key',
      cache: new Map(),
      fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'claude-haiku-4-5-20251001',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              intent: 'company',
              entityScope: 'all',
              companyQuery: 'KFC',
              countryHint: 'United States',
              region: 'all',
              stageFilter: 'all',
              sectors: [],
              excludeSector: 'none',
              raisingSoonOnly: false,
              untappedOnly: false,
              slushOnly: false,
              minHeadcountGrowthPct: null,
              requireAlumniFounder: false,
              investorQuery: null,
              whyNotCompany: null,
              expandedKeywords: ['kfc', 'restaurant', 'franchise']
            })
          }
        ]
      })
    })
  });
  assert.equal(mockedClaude.controlPlaneMode, 'anthropic-query-compiler');
  assert.equal(mockedClaude.filters.entityScope, 'all');
  assert.equal(mockedClaude.filters.companyQuery, 'KFC');
  assert.equal(mockedClaude.filters.countryHint, 'United States');
});

test('analyzeConnectionWithCitationGate enforces strict sourceIds/year grounding, caches hits, and falls back deterministically', async () => {
  const samplePacket = {
    mode: 'connection',
    title: 'NVIDIA CORPORATION -> Anthropic',
    hopType: '2-hop via FundingRound',
    relation: 'INVESTED_IN',
    roundSummary: 'Series G · $30B · 2026-02',
    date: '2026-02-12',
    whyMatters: 'Strategic compute partner also invested in Anthropic.',
    facts: [
      {
        text: "NVIDIA CORPORATION invested in Anthropic's Series G ($30B) on 2026-02-12.",
        date: '2026-02-12',
        tier: 'PRESS',
        sourceIds: ['src-nvda-1']
      }
    ],
    syndicatePeers: ['OpenAI', 'Amazon'],
    gaps: ['Check size / ownership %'],
    sources: [
      {
        id: 'src-nvda-1',
        title: 'Anthropic Series G',
        publisher: 'news.crunchbase.com',
        date: '2026-05-11',
        sourceRank: 'PRESS'
      }
    ]
  };

  const fallback = await analyzeConnectionWithCitationGate(samplePacket, { apiKey: '' });
  assert.equal(fallback.controlPlaneMode, 'deterministic-fallback');
  assert.equal(fallback.insights.length, 1);
  assert.equal(fallback.insights[0].sourceIds[0], 'src-nvda-1');

  const cache = new Map();
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              summary: 'Nvidia backed Anthropic in 2026-02-12 Series G alongside overlapping ecosystem ties.',
              insights: [
                { text: 'NVIDIA CORPORATION participated in Series G on 2026-02-12.', sourceIds: ['src-nvda-1'] },
                { text: 'Revenue reached $999B in 2099 with secret terms.', sourceIds: ['src-nvda-1'] }
              ],
              question: 'Confirm Nvidia allocation and strategic compute commitments.'
            })
          }
        ]
      })
    };
  };

  const aiFirst = await analyzeConnectionWithCitationGate(samplePacket, { apiKey: 'test-key', cache, fetchFn });
  assert.equal(aiFirst.controlPlaneMode, 'anthropic-connection-analyst');
  assert.equal(aiFirst.insights.length, 1);
  assert.equal(aiFirst.droppedUnverifiedCount, 1);
  assert.equal(calls, 1);

  const aiCached = await analyzeConnectionWithCitationGate(samplePacket, { apiKey: 'test-key', cache, fetchFn });
  assert.equal(aiCached.fromCache, true);
  assert.equal(calls, 1);
});

test('analyzeConnectionWithCitationGate returns detailed, record-grounded factor analyses', async () => {
  const packet = {
    mode: 'entity',
    title: 'Northstar',
    whyMatters: 'Mapped signals improve diligence readiness, but do not establish investment merit.',
    decisionFactors: [
      { group: 'access', label: 'Access', effect: 'Beneficial', impact: 'Improves warm access; it does not establish company quality.', evidence: 'Northstar Capital backs the company.', sourceIds: ['src-access'], records: [{ id: 'access-1', type: 'INVESTED_IN', path: 'Northstar Capital → Northstar', relation: 'Invested in', detail: 'Northstar Capital is listed as an investor.', date: '2025-05-01', sourceIds: ['src-access'] }] },
      { group: 'lineage', label: 'Lineage', effect: 'Beneficial', impact: 'Supports team diligence and references; execution still needs proof.', evidence: 'A founder held an operating role.', sourceIds: ['src-lineage'], records: [{ id: 'lineage-1', type: 'IS_CEO_OF', path: 'Founder → Northstar', relation: 'Chief executive officer', detail: 'The founder is listed as CEO.', date: null, sourceIds: ['src-lineage'] }] },
      { group: 'timing', label: 'Timing', effect: 'Catalyst', impact: 'Adds a catalyst to diligence; confirm it is current before advancing.', evidence: 'A funding event is listed.', sourceIds: ['src-timing'], records: [{ id: 'timing-1', type: 'FUNDING_ROUND', path: 'Northstar', relation: 'Series A', detail: 'A funding event is listed.', date: '2025-04-01', sourceIds: ['src-timing'] }] },
      { group: 'caution', label: 'Caution', effect: 'Risk · Watch', impact: 'Raises diligence risk; investigate before advancing.', evidence: 'A competitor relationship is mapped.', sourceIds: ['src-caution'], records: [{ id: 'caution-1', type: 'COMPETITOR', path: 'Northstar ↔ Rival', relation: 'Competitive overlap', detail: 'A competitor relationship is mapped.', date: null, sourceIds: ['src-caution'] }] }
    ],
    facts: [
      { text: 'Northstar Capital backs the company.', sourceIds: ['src-access'] },
      { text: 'A founder held an operating role.', sourceIds: ['src-lineage'] },
      { text: 'A funding event is listed.', sourceIds: ['src-timing'] },
      { text: 'A competitor relationship is mapped.', sourceIds: ['src-caution'] }
    ],
    sources: ['access', 'lineage', 'timing', 'caution'].map((group) => ({ id: `src-${group}`, title: `${group} source`, publisher: 'Cala', sourceRank: 'PRESS' }))
  };

  const fallback = await analyzeConnectionWithCitationGate(packet, { apiKey: '' });
  assert.equal(fallback.factorSummaries.length, 4);
  assert.equal(fallback.factorAnalyses.length, 4);
  assert.equal(fallback.factorAnalyses[0].decisionEffectSource, 'map-fallback');
  assert.equal(fallback.factorSummaries[0].group, 'access');
  assert.match(fallback.factorSummaries[3].text, /Raises diligence risk/);

  let requestedBody;
  const fetchFn = async (_url, request) => {
    requestedBody = JSON.parse(request.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
        factorAnalyses: [
          { group: 'access', decisionEffect: { text: 'Northstar Capital is listed as an investor in Northstar, giving the team a direct reference path for diligence. This strengthens access and validation planning, but it does not demonstrate product quality, customer demand, or likely returns.', sourceIds: ['src-access'] }, reasoning: [{ text: 'The mapped investor relationship supports a warm reference request focused on the company’s progress and round context.', sourceIds: ['src-access'] }], limitation: 'The relationship alone does not establish investment merit.', nextCheck: 'Ask the investor to verify current traction and round context.' },
          { group: 'lineage', decisionEffect: { text: 'The founder is listed as Northstar’s chief executive, which identifies a direct leadership reference for team diligence. This helps verify operating responsibility, but the record does not establish prior outcomes or the team’s ability to execute.', sourceIds: ['src-lineage'] }, reasoning: [{ text: 'The Cala record connects the founder to the CEO role at Northstar.', sourceIds: ['src-lineage'] }], limitation: 'No prior operating outcomes were supplied.', nextCheck: 'Validate the founder’s role and operating history.' },
          { group: 'timing', decisionEffect: { text: 'A Series A event is listed for Northstar, making financing context relevant to the timing of diligence. The record gives a dated catalyst, but it does not establish that the company is fundraising now or that momentum is current.', sourceIds: ['src-timing'] }, reasoning: [{ text: 'The mapped round supplies a dated financing event to verify with the company.', sourceIds: ['src-timing'] }], limitation: 'A past funding event does not prove an active raise.', nextCheck: 'Confirm the current fundraising status.' },
          { group: 'caution', decisionEffect: { text: 'A competitive overlap is mapped between Northstar and Rival, so differentiation should be tested before advancing. The record establishes a graph relationship only; it does not show product substitutability, customer overlap, or an active commercial conflict.', sourceIds: ['src-caution'] }, reasoning: [{ text: 'The mapped competitor edge identifies Rival as a diligence comparison.', sourceIds: ['src-caution'] }], limitation: 'The edge does not establish direct product competition.', nextCheck: 'Compare products, customers, and win-loss evidence.' }
        ],
        insights: [{ text: 'Use the mapped backer for a focused company reference.', sourceIds: ['src-access'] }],
        question: 'Can the founder validate the mapped operating history?'
      }) }] })
    };
  };

  const result = await analyzeConnectionWithCitationGate(packet, { apiKey: 'test-key', cache: new Map(), fetchFn });
  assert.equal(requestedBody.model, 'claude-haiku-4-5-20251001');
  assert.equal(requestedBody.max_tokens, 1800);
  assert.equal(requestedBody.output_config.format.type, 'json_schema');
  assert.deepEqual(requestedBody.output_config.format.schema.required, ['factorAnalyses', 'insights']);
  assert.equal(result.controlPlaneMode, 'anthropic-connection-analyst');
  assert.equal(result.factorSummaries.length, 4);
  assert.equal(result.factorAnalyses.length, 4);
  assert.equal(result.factorAnalyses[0].decisionEffectSource, 'anthropic');
  assert.match(result.factorSummaries[0].text, /direct reference path/);
  assert.match(result.factorSummaries[3].text, /competitive overlap is mapped/);
  assert.equal(result.factorAnalyses[3].decisionEffectSource, 'anthropic');
  assert.deepEqual(result.factorSummaries[3].sourceIds, ['src-caution']);
  assert.match(requestedBody.messages[0].content, /Northstar Capital → Northstar/);
  assert.doesNotMatch(result.factorAnalyses[0].decisionEffect.text, /Improves warm access/);
  assert.equal(result.insights.length, 1);
});

test('connection analysis reports the provider status when Claude cannot be reached', async () => {
  let calls = 0;
  const options = {
    apiKey: 'test-key',
    cache: new Map(),
    fetchFn: async () => {
      calls += 1;
      return { ok: false, status: 404, text: async () => '{"error":{"type":"not_found_error"}}' };
    }
  };
  const packet = {
    title: 'Northstar status test',
    facts: [{ text: 'Northstar Capital invested in Northstar.', sourceIds: ['status-source'] }],
    decisionFactors: [{ group: 'access', label: 'Access', sourceIds: ['status-source'], records: [] }],
    sources: [{ id: 'status-source', title: 'Northstar investor record' }]
  };
  const result = await analyzeConnectionWithCitationGate(packet, options);
  await analyzeConnectionWithCitationGate(packet, options);

  assert.equal(result.controlPlaneMode, 'deterministic-fallback');
  assert.match(result.fallbackReason, /Claude model \(HTTP 404\)/);
  assert.equal(result.providerStatusCode, 404);
  assert.equal(calls, 2, 'failed analyses must remain retryable instead of caching the fallback');
});

test('four-factor analysis retries truncated structured output and falls back after a second truncation', async () => {
  const packet = {
    mode: 'entity', title: 'Northstar',
    decisionFactors: [{
      group: 'access', label: 'Access', impact: 'Improves warm access; it does not establish company quality.',
      evidence: 'Investor to Company is a verified relation.', sourceIds: ['src-access'],
      records: [{ id: 'access-1', type: 'VERIFIED_RELATION', path: 'Investor → Company', relation: 'Verified relation', detail: 'A sourced relationship record relevant to access diligence.', sourceIds: ['src-access'] }]
    }],
    sources: [{ id: 'src-access', title: 'Investor relationship', publisher: 'Cala' }]
  };
  const valid = JSON.stringify({
    factorAnalyses: [{
      group: 'access',
      decisionEffect: { text: 'A verified relation links Investor to Company.', sourceIds: ['src-access'] },
      reasoning: [{ text: 'The Investor to Company verified relation is recorded in Cala.', sourceIds: ['src-access'] }],
      limitation: 'The relationship does not establish company quality.',
      nextCheck: 'Verify whether the relationship is current.'
    }],
    insights: []
  });
  let calls = 0;
  let secondTokenLimit = 0;
  const retryingFetch = async (_url, request) => {
    calls += 1;
    const body = JSON.parse(request.body);
    assert.equal(body.output_config.format.type, 'json_schema');
    secondTokenLimit = body.max_tokens;
    return {
      ok: true, status: 200,
      json: async () => calls === 1
        ? { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"factorAnalyses":[' }] }
        : { stop_reason: 'end_turn', content: [{ type: 'text', text: valid }] }
    };
  };
  const result = await analyzeConnectionWithCitationGate(packet, { apiKey: 'test-key', cache: new Map(), fetchFn: retryingFetch });
  assert.equal(result.controlPlaneMode, 'anthropic-connection-analyst');
  assert.equal(calls, 2);
  assert.equal(secondTokenLimit, 3600);
  assert.equal(result.factorAnalyses[0].reasoning.length, 1);

  calls = 0;
  const malformedThenValidFetch = async () => {
    calls += 1;
    return {
      ok: true, status: 200,
      json: async () => calls === 1
        ? { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not JSON' }] }
        : { stop_reason: 'end_turn', content: [{ type: 'text', text: valid }] }
    };
  };
  const repaired = await analyzeConnectionWithCitationGate(packet, { apiKey: 'test-key', cache: new Map(), fetchFn: malformedThenValidFetch });
  assert.equal(repaired.controlPlaneMode, 'anthropic-connection-analyst');
  assert.equal(calls, 2);

  calls = 0;
  const malformedTwiceFetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not JSON' }] }) };
  };
  const malformedFallback = await analyzeConnectionWithCitationGate(packet, { apiKey: 'test-key', cache: new Map(), fetchFn: malformedTwiceFetch });
  assert.equal(malformedFallback.controlPlaneMode, 'deterministic-fallback');
  assert.match(malformedFallback.fallbackReason, /invalid factor response twice/);
  assert.equal(calls, 2);

  calls = 0;
  const truncatedTwiceFetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }] }) };
  };
  const fallback = await analyzeConnectionWithCitationGate(packet, { apiKey: 'test-key', cache: new Map(), fetchFn: truncatedTwiceFetch });
  assert.equal(fallback.controlPlaneMode, 'deterministic-fallback');
  assert.match(fallback.fallbackReason, /cut off twice/);
  assert.equal(calls, 2);
});

test('four-factor analysis rejects unsupported claims even when they cite a valid Cala source', async () => {
  const packet = {
    mode: 'entity', title: 'Generic relation check',
    decisionFactors: [{
      group: 'access', label: 'Access', impact: 'A concrete diligence consideration.',
      evidence: 'Investor to Company is a verified relation.', sourceIds: ['src-generic'],
      records: [{ id: 'access-1', type: 'VERIFIED_RELATION', path: 'Investor → Company', relation: 'Verified relation', detail: 'A sourced relationship record relevant to access diligence.', sourceIds: ['src-generic'] }]
    }],
    sources: [{ id: 'src-generic', title: 'Generic relationship record' }]
  };
  const fetchFn = async () => ({
    ok: true, status: 200,
    json: async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({
        factorAnalyses: [{
          group: 'access',
          decisionEffect: { text: 'A verified relation links Investor to Company. This confirms board rights, information access, LP quality, follow-on capacity and deployment velocity.', sourceIds: ['src-generic'] },
          reasoning: [{ text: 'The relation confirms board rights and SEC or FINRA exposure, so governance and disputes need review.', sourceIds: ['src-generic'] }],
          limitation: 'The relation establishes governance rights and fund quality.',
          nextCheck: 'Verify whether board rights and information access are documented.'
        }],
        insights: []
      }) }]
    })
  });
  const result = await analyzeConnectionWithCitationGate(packet, { apiKey: 'test-key', cache: new Map(), fetchFn });
  assert.equal(result.controlPlaneMode, 'anthropic-connection-analyst');
  const analysis = result.factorAnalyses[0];
  assert.match(analysis.decisionEffect.text, /A verified relation links Investor to Company/);
  assert.doesNotMatch(`${analysis.decisionEffect.text} ${analysis.reasoning.map((item) => item.text).join(' ')}`, /board rights|information access|LP quality|follow-on capacity|deployment velocity|SEC|FINRA|governance|disputes/i);
  assert.equal(analysis.reasoning.length, 0);
  assert.doesNotMatch(analysis.limitation, /governance rights|fund quality/i);
  assert.equal(analysis.nextCheck, '');
});

test('four-factor grounding preserves useful interpretation when Cala records identify a concrete connection', async () => {
  const packet = {
    mode: 'entity', title: 'Northstar',
    decisionFactors: [{
      group: 'access', label: 'Access', impact: 'Improves warm access; it does not establish company quality.',
      evidence: 'Northstar Capital led Northstar’s Series A in 2025.', sourceIds: ['src-lead'],
      records: [{ id: 'access-lead', type: 'INVESTED_IN', path: 'Northstar Capital → Northstar', relation: 'Series A lead investor', detail: 'Northstar Capital led Northstar’s Series A round.', date: '2025-03-10', sourceIds: ['src-lead'] }]
    }],
    sources: [{ id: 'src-lead', title: 'Northstar Series A record', publisher: 'Cala' }]
  };
  const answer = {
    factorAnalyses: [{
      group: 'access',
      decisionEffect: { text: 'Northstar Capital’s Series A lead role gives the team a concrete contact for outreach and a starting point for a warm reference. This improves diligence access, but does not establish product quality, customer traction, or likely returns.', sourceIds: ['src-lead'] },
      reasoning: [{ text: 'Because Northstar Capital is recorded as the Series A lead, ask for a reference that tests Northstar’s round context and investor relationship.', sourceIds: ['src-lead'] }],
      limitation: 'The lead investor relationship alone does not establish company quality.',
      nextCheck: 'Verify whether the Northstar Capital Series A record is current.'
    }],
    insights: []
  };
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] }) });
  const result = await analyzeConnectionWithCitationGate(packet, { apiKey: 'test-key', cache: new Map(), fetchFn });
  assert.equal(result.controlPlaneMode, 'anthropic-connection-analyst');
  const access = result.factorAnalyses[0];
  assert.match(access.decisionEffect.text, /Northstar Capital’s Series A lead role gives the team a concrete contact for outreach/);
  assert.equal(access.decisionEffectSource, 'anthropic');
  assert.doesNotMatch(access.decisionEffect.text, /Improves warm access/);
  assert.match(access.reasoning[0].text, /ask for a reference/);
  assert.match(access.nextCheck, /^Verify whether/);
  assert.doesNotMatch(access.decisionEffect.text, /product quality|customer traction|likely returns/i);
});

test('factor grounding rejects unsupported validation, authority, performance and runway claims', async () => {
  const groups = [
    { group: 'access', label: 'Access', impact: 'Improves warm access; it does not establish company quality.', evidence: 'Northstar Capital is listed as an investor.', sourceIds: ['src-access'], records: [{ id: 'access-1', type: 'INVESTED_IN', path: 'Northstar Capital → Northstar', relation: 'Investor', detail: 'Northstar Capital is listed as an investor in Northstar.', sourceIds: ['src-access'] }] },
    { group: 'lineage', label: 'Lineage', impact: 'Supports team diligence and references; execution still needs proof.', evidence: 'A founder is listed as CEO.', sourceIds: ['src-lineage'], records: [{ id: 'lineage-1', type: 'IS_CEO_OF', path: 'Founder → Northstar', relation: 'Chief executive officer', detail: 'The founder is listed as CEO.', sourceIds: ['src-lineage'] }] },
    { group: 'timing', label: 'Timing', impact: 'Adds a catalyst to diligence; confirm it is current before advancing.', evidence: 'A Series A event is dated 2025-03-10.', sourceIds: ['src-timing'], records: [{ id: 'timing-1', type: 'FUNDING_ROUND', path: 'Northstar', relation: 'Series A', detail: 'A Series A event is listed.', date: '2025-03-10', sourceIds: ['src-timing'] }] }
  ];
  const packet = {
    mode: 'entity', title: 'Northstar', decisionFactors: groups,
    sources: groups.map((item) => ({ id: item.sourceIds[0], title: `${item.label} Cala record` }))
  };
  const response = {
    factorAnalyses: [
      { group: 'access', decisionEffect: { text: 'The mapped investor relationship gives a clear contact to verify a reference path.', sourceIds: ['src-access'] }, reasoning: [], limitation: 'This relationship alone does not establish company quality.', nextCheck: 'Verify whether the mapped investor relationship is current.' },
      { group: 'lineage', decisionEffect: { text: 'The CEO role identifies the primary decision-maker and demonstrates strong operating performance.', sourceIds: ['src-lineage'] }, reasoning: [], limitation: 'No outcomes were provided.', nextCheck: 'Confirm whether the listed CEO role is current.' },
      { group: 'timing', decisionEffect: { text: 'The 2025 Series A event shows the company passed early-stage validation and secured institutional capital.', sourceIds: ['src-timing'] }, reasoning: [], limitation: 'The record does not show runway.', nextCheck: 'Verify whether runway and burn support another round.' }
    ],
    insights: []
  };
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(response) }] }) });
  const result = await analyzeConnectionWithCitationGate(packet, { apiKey: 'test-key', cache: new Map(), fetchFn });
  const byGroup = new Map(result.factorAnalyses.map((item) => [item.group, item]));
  assert.equal(byGroup.get('access').decisionEffectSource, 'anthropic');
  assert.match(byGroup.get('access').decisionEffect.text, /clear contact to verify a reference path/);
  assert.equal(byGroup.get('lineage').decisionEffectSource, 'map-fallback');
  assert.equal(byGroup.get('timing').decisionEffectSource, 'map-fallback');
  assert.doesNotMatch(`${byGroup.get('lineage').decisionEffect.text} ${byGroup.get('timing').decisionEffect.text}`, /validation|institutional capital|decision-maker|performance|runway|burn/i);
  assert.equal(byGroup.get('timing').nextCheck, '');
  assert.match(byGroup.get('lineage').nextCheck, /^Confirm whether the listed CEO role/);
});

test('grounding preserves abbreviations, decimals, domains, equivalent acronyms, and valid factor nextChecks', async () => {
  const packet = {
    mode: 'entity',
    title: 'Northstar AI',
    decisionFactors: [
      {
        group: 'lineage',
        label: 'Lineage',
        impact: 'Supports operator reference checks.',
        evidence: 'Jane Doe serves as Chief Executive Officer at Northstar Ltd.',
        sourceIds: ['src-ceo', 'src-cto'],
        records: [
          { id: 'lin-1', type: 'RELATION', path: 'Jane Doe → Northstar Ltd.', relation: 'Chief executive officer', detail: 'Jane Doe serves as chief executive officer at Northstar Ltd.', date: '2025-02-01', sourceIds: ['src-ceo'] },
          { id: 'lin-2', type: 'RELATION', path: 'John Smith → Northstar Ltd.', relation: 'Chief technology officer', detail: 'John Smith leads engineering at Northstar Ltd.', date: '2024-06-01', sourceIds: ['src-cto'] }
        ]
      },
      {
        group: 'timing',
        label: 'Timing',
        impact: 'Dated acquisition milestone.',
        evidence: 'Astral.sh acquisition and $5.0B financing recorded in 2026.',
        sourceIds: ['src-mna'],
        records: [
          { id: 'tim-1', type: 'DATED_MILESTONE', path: 'Northstar → Astral.sh', relation: 'Mna Completed', detail: 'Acquired Astral.sh alongside $5.0B financing in 2026.', date: '2026-03-19', sourceIds: ['src-mna'] }
        ]
      }
    ],
    sources: [
      { id: 'src-ceo', title: 'Northstar Ltd. Officer Registry', publisher: 'Companies House' },
      { id: 'src-cto', title: 'Northstar Ltd. CTO Announcement', publisher: 'Northstar' },
      { id: 'src-mna', title: 'Astral.sh Acquisition Notice', publisher: 'Astral' }
    ]
  };
  const answer = {
    factorAnalyses: [
      {
        group: 'lineage',
        decisionEffect: { text: 'Jane Doe (CEO of Northstar Ltd.) gives a direct executive contact.', sourceIds: ['src-ceo'] },
        reasoning: [{ text: 'Jane Doe is listed at Northstar Ltd. since 2025-02-01.', sourceIds: ['src-ceo'] }],
        limitation: 'Tenure records do not establish commercial execution.',
        nextCheck: 'Confirm whether John Smith remains active alongside Jane Doe at Northstar Ltd.'
      },
      {
        group: 'timing',
        decisionEffect: { text: 'Northstar completed the Astral.sh acquisition on 2026-03-19 alongside $5.0B financing.', sourceIds: ['src-mna'] },
        reasoning: [{ text: 'Astral.sh M&A completed on 2026-03-19 ($5.0B financing).', sourceIds: ['src-mna'] }],
        limitation: 'Acquisition record does not verify integration status.',
        nextCheck: 'Verify whether Astral.sh integration milestones are complete.'
      }
    ],
    insights: []
  };
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] })
  });
  const result = await analyzeConnectionWithCitationGate(packet, { apiKey: 'test-key', cache: new Map(), fetchFn });
  const byGroup = new Map(result.factorAnalyses.map((f) => [f.group, f]));
  assert.match(byGroup.get('lineage').decisionEffect.text, /Northstar Ltd\./);
  assert.match(byGroup.get('lineage').nextCheck, /John Smith.*Northstar Ltd\./);
  assert.match(byGroup.get('timing').decisionEffect.text, /Astral\.sh.*\$5\.0B/);
  assert.match(byGroup.get('timing').reasoning[0].text, /Astral\.sh M&A completed/);
  assert.match(byGroup.get('timing').nextCheck, /Astral\.sh/);
});

test('analyzeConnectionWithCitationGate persists verified results to disk cache and never caches HTTP errors', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-claude-disk-'));
  const diskCachePath = path.join(tmpDir, 'claude-insight-cache.json');
  const packet = {
    mode: 'connection',
    title: 'Northstar -> Apex',
    hopType: '1-hop direct',
    relation: 'INVESTED_IN',
    whyMatters: 'Direct backer.',
    facts: [{ text: 'Northstar invested in Apex in 2025.', sourceIds: ['src-1'] }],
    sources: [{ id: 'src-1', title: 'Apex Form D', publisher: 'SEC EDGAR', sourceRank: 'FILING' }]
  };
  let calls = 0;
  try {
    const failingFetch = async () => {
      calls += 1;
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const errRes = await analyzeConnectionWithCitationGate(packet, { apiKey: 'test-key', diskCachePath, fetchFn: failingFetch });
    assert.equal(errRes.controlPlaneMode, 'deterministic-fallback');
    assert.equal(fs.existsSync(diskCachePath), false, 'Failed HTTP 500 fallback must not write disk cache');

    const okPayload = {
      summary: 'Northstar invested in Apex per Form D.',
      insights: [{ text: 'Verified Form D filing documents Northstar investing in Apex in 2025.', sourceIds: ['src-1'] }],
      question: 'Confirm whether Northstar holds follow-on rights.'
    };
    const okFetch = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(okPayload) }] }) };
    };
    const uniquePacket = { ...packet, title: `Northstar -> Apex ${Date.now()}` };
    const first = await analyzeConnectionWithCitationGate(uniquePacket, { apiKey: 'test-key', diskCachePath, fetchFn: okFetch });
    assert.equal(first.controlPlaneMode, 'anthropic-connection-analyst');
    assert.equal(fs.existsSync(diskCachePath), true);

    // Ensure disk cache works without calling fetch again
    const callsBeforeDisk = calls;
    const saved = JSON.parse(fs.readFileSync(diskCachePath, 'utf8'));
    assert.equal(Object.keys(saved).length, 1);
    assert.equal(callsBeforeDisk, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('compact currency tokens ($30B, $40M) pass while ungrounded $99B drops and record #2 nextCheck passes', async () => {
  const packet = {
    mode: 'entity',
    title: 'Alpha & Beta',
    decisionFactors: [
      {
        group: 'timing',
        label: 'Timing',
        effect: 'Active',
        impact: 'Dated rounds establish cadence.',
        evidence: '2 dated milestones through 2026-02-12',
        sourceIds: ['src-t1'],
        records: [
          { id: 't1', type: 'FUNDING_ROUND', path: 'Alpha → Series B · $40M', relation: 'Series B · $40M (2025-01-01)', detail: 'Raised $40M Series B.', date: '2025-01-01', sourceIds: ['src-t1'] },
          { id: 't2', type: 'FUNDING_ROUND', path: 'Beta → Series G · $30B', relation: 'Series G · $30B (2026-02-12)', detail: 'Beta closed $30B Series G round.', date: '2026-02-12', sourceIds: ['src-t2'] }
        ]
      }
    ],
    sources: [
      { id: 'src-t1', title: 'Alpha Series B filing', publisher: 'SEC', sourceRank: 'FILING', date: '2025-01-01' },
      { id: 'src-t2', title: 'Beta Series G report', publisher: 'Press', sourceRank: 'PRESS', date: '2026-02-12' }
    ]
  };
  const payload = {
    executiveTakeaway: { text: 'Beta $30B Series G and Alpha $40M Series B anchor timing momentum.', sourceIds: ['src-t1', 'src-t2'] },
    factorAnalyses: [
      {
        group: 'timing',
        decisionEffect: { text: 'Alpha $40M Series B and Beta $30B Series G confirm active financing cadence.', sourceIds: ['src-t1', 'src-t2'] },
        reasoning: [
          { text: 'Beta closed its $30B Series G on 2026-02-12 following Alpha $40M Series B.', sourceIds: ['src-t2', 'src-t1'] },
          { text: 'Rumor claims Gamma raised $99B in 2026-02-12.', sourceIds: ['src-t2'] }
        ],
        limitation: 'Closed $30B and $40M financings do not establish current net retention.',
        nextCheck: 'Confirm whether Beta Series G closed on 2026-02-12 per Series G record.'
      }
    ],
    insights: []
  };
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(payload) }] })
  });
  const res = await analyzeConnectionWithCitationGate(packet, { apiKey: 'test-key', cache: new Map(), disableDiskCache: true, fetchFn: mockFetch });
  assert.equal(res.controlPlaneMode, 'anthropic-connection-analyst');
  assert.equal(res.summary, 'Beta $30B Series G and Alpha $40M Series B anchor timing momentum.');
  const timing = res.factorAnalyses.find((f) => f.group === 'timing');
  assert.equal(timing.decisionEffectSource, 'anthropic');
  assert.match(timing.decisionEffect.text, /\$30B/);
  assert.equal(timing.reasoning.length, 1);
  assert.doesNotMatch(timing.reasoning[0].text, /\$99B/);
  assert.match(timing.nextCheck, /Beta Series G/);
});

test('mode connection preserves B2B text without false $2B rejection and grounds summarySourceIds', async () => {
  const packet = {
    mode: 'connection',
    title: 'Sequoia Capital → Samplead',
    hopType: '1-hop direct',
    relation: 'INVESTED_IN',
    whyMatters: 'Direct investor link.',
    facts: [{ text: 'Sequoia Capital invested in Samplead.', date: '2026-08-25', sourceIds: ['src-b2b-long-id-1234567890'] }],
    sources: [{ id: 'src-b2b-long-id-1234567890', title: 'Samplead B2B article', publisher: 'CTech', date: '2026-08-25', sourceRank: 'PRIMARY' }]
  };
  const payload = {
    summary: 'Sequoia Capital backed B2B sales platform Samplead.',
    summarySourceIds: ['s1'],
    insights: [{ text: 'Direct Sequoia backing aligns Samplead with enterprise B2B automation buyers.', sourceIds: ['s1'] }],
    question: 'Confirm whether Sequoia Capital led or co-invested in Samplead.'
  };
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(payload) }] })
  });
  const res = await analyzeConnectionWithCitationGate(packet, { apiKey: 'test-key', cache: new Map(), disableDiskCache: true, fetchFn: mockFetch });
  assert.equal(res.controlPlaneMode, 'anthropic-connection-analyst');
  assert.equal(res.droppedUnverifiedCount, 0);
  assert.equal(res.summary, 'Sequoia Capital backed B2B sales platform Samplead.');
  assert.match(res.insights[0].text, /B2B/);
});
