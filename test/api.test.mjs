import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.mjs';
import { createCalaClient } from '../src/calaClient.mjs';
import { createRegistryClient } from '../src/registryClient.mjs';
import { COMPANIES } from '../src/data.mjs';

test('HTTP API endpoints handle bootstrap, search, analyze, brief, refine, and error states', async () => {
  const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'rte-api-base-'));
  const server = createAppServer({
    calaClient: createCalaClient({
      apiKey: '',
      cacheFile: path.join(tmpDir1, 'cala-cache.json')
    }),
    registryClient: createRegistryClient({
      cachePath: path.join(tmpDir1, 'reg-cache.json')
    })
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Bootstrap
    const bootRes = await fetch(`${baseUrl}/api/bootstrap`);
    assert.equal(bootRes.status, 200);
    const boot = await bootRes.json();
    assert.ok(boot.funds.length >= 6);
    assert.ok(boot.companies.length >= 28);

    // 2. Search disambiguation
    const searchRes = await fetch(`${baseUrl}/api/search?q=Ventures`);
    assert.equal(searchRes.status, 200);
    const search = await searchRes.json();
    assert.equal(search.ambiguousFunds, true);
    assert.equal(search.funds.length, 3);

    // 3. Analyze fund + cache verification
    const analyzeRes = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'fund', fundId: 'lifeline-ventures', rankingMode: 'balanced' })
    });
    assert.equal(analyzeRes.status, 200);
    const analysis = await analyzeRes.json();
    assert.equal(analysis.thesis.fundId, 'lifeline-ventures');
    assert.ok(analysis.shortlist.length >= 10);
    assert.ok(analysis.backtest.hitsInTop15 >= 2);

    // 4. Brief (on-demand 10-minute view)
    const briefRes = await fetch(`${baseUrl}/api/brief?startupId=voltgrid&fundId=lifeline-ventures`);
    assert.equal(briefRes.status, 200);
    const brief = await briefRes.json();
    assert.equal(brief.name, 'VoltGrid');
    assert.ok(brief.notFoundInCala.length >= 4);

    // 5. Layer-2 refine
    const refineRes = await fetch(`${baseUrl}/api/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'fund',
        fundId: 'lifeline-ventures',
        queryText: 'why not Oura?'
      })
    });
    assert.equal(refineRes.status, 200);
    const refined = await refineRes.json();
    assert.match(refined.explanation, /existing portfolio/i);

    // 5b. Stage filter & free-text city refine (control plane returns controlPlaneMode + compiledQuery)
    const cityStageRes = await fetch(`${baseUrl}/api/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'fund',
        fundId: 'lifeline-ventures',
        queryText: 'Helsinki',
        stageFilter: 'pre_seed_seed',
        minHeadcountGrowthPct: 20
      })
    });
    assert.equal(cityStageRes.status, 200);
    const cityStageData = await cityStageRes.json();
    assert.ok(Array.isArray(cityStageData.shortlist));
    assert.ok(['anthropic-query-compiler', 'deterministic-parser'].includes(cityStageData.controlPlaneMode));

    // 5c. Analyze exposes timeTravelProfile, upstreamFeeders & dataConfidence; brief?narrate=1 runs citation gate
    const analyzeCheck = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'fund', fundId: 'lifeline-ventures', rankingMode: 'balanced' })
    });
    assert.equal(analyzeCheck.status, 200);
    const analyzePayload = await analyzeCheck.json();
    assert.ok(analyzePayload.timeTravelProfile);
    assert.ok(Array.isArray(analyzePayload.upstreamFeeders));
    assert.ok(analyzePayload.shortlist[0].dataConfidence?.grade);

    const narratedBriefRes = await fetch(
      `${baseUrl}/api/brief?startupId=vectormesh&fundId=lifeline-ventures&narrate=1`
    );
    assert.equal(narratedBriefRes.status, 200);
    const narratedBrief = await narratedBriefRes.json();
    assert.ok(narratedBrief.narrative);
    assert.ok(Array.isArray(narratedBrief.narrative.bullets));
    assert.ok(narratedBrief.narrative.bullets.length >= 1);

    // 6. Error cases (unknown fund -> 404, missing startupId -> 400)
    const err404 = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'fund', fundId: 'missing-fund-xyz' })
    });
    assert.equal(err404.status, 404);

    const err400 = await fetch(`${baseUrl}/api/brief`);
    assert.equal(err400.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir1, { recursive: true, force: true });
  }
});

test('Hybrid official registry discovery endpoint & /api/refine auto-fallback spend 0 Cala credits', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rte-api-reg-'));
  const calaClient = createCalaClient({
    apiKey: '',
    cacheFile: path.join(tmpDir, 'cala-cache.json'),
    maxLiveCalls: 250
  });
  const registryClient = createRegistryClient({
    cacheFile: path.join(tmpDir, 'reg-cache.json'),
    fetchFn: async (url) => {
      const u = String(url);
      if (u.includes('api.gleif.org')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: '549300MOCKKFC000001',
                attributes: {
                  lei: '549300MOCKKFC000001',
                  entity: {
                    legalName: { name: 'KFC Holdings Mock Corp' },
                    legalAddress: { city: 'Louisville', country: 'US' },
                    status: 'ACTIVE',
                    category: 'GENERAL',
                    creationDate: '1991-05-01T00:00:00Z'
                  }
                }
              }
            ]
          })
        };
      }
      if (u.includes('avoindata.prh.fi')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ totalResults: 0, companies: [] })
        };
      }
      throw new Error(`Unexpected external fetch in API test: ${u}`);
    }
  });

  const server = createAppServer({ calaClient, registryClient });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const refRes = await fetch(`${baseUrl}/api/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'fund',
        fundId: 'lifeline-ventures',
        queryText: 'KFC'
      })
    });
    assert.equal(refRes.status, 200);
    const refData = await refRes.json();
    assert.equal(refData.entityScope, 'all');
    assert.equal(refData.calaBudget.liveCallsUsed, 0);
    assert.equal(refData.registryDiscovery.triggered, true);
    assert.ok(refData.registryDiscovery.discoveredCount >= 1);
    assert.ok(refData.shortlist.some((item) => /KFC Holdings Mock Corp/i.test(item.name)));
    const kfc = refData.shortlist.find((item) => /KFC Holdings Mock Corp/i.test(item.name));
    assert.equal(kfc.isRegistryDiscovered, true);
    assert.equal(kfc.lastRoundAmountEurM, null);
    assert.equal(kfc.dataConfidence.topSourceRank, 'FILING');

    const syncRes = await fetch(`${baseUrl}/api/discover-registries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queryText: 'KFC', mode: 'query' })
    });
    assert.equal(syncRes.status, 200);
    const syncData = await syncRes.json();
    assert.equal(syncData.calaBudget.liveCallsUsed, 0);
    assert.ok(syncData.companies.length >= 1);
  } finally {
    const idx = COMPANIES.findIndex((c) => /KFC Holdings Mock Corp/i.test(c.name));
    if (idx !== -1) COMPANIES.splice(idx, 1);
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('POST /api/analyze, POST /api/refine (hideMegaHubs/bridgeFamily), and GET /api/brief return evidenceFolders & bridgeMap', async () => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const analyzeRes = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'fund', fundId: 'lifeline-ventures' })
    });
    assert.equal(analyzeRes.status, 200);
    const analyzeData = await analyzeRes.json();
    assert.ok(analyzeData.bridgeMap);
    assert.ok(analyzeData.bridgeMap.stats.renderedStartups <= 12);
    assert.equal(analyzeData.bridgeMap.clusters.length, 5);
    assert.ok(Array.isArray(analyzeData.bridgeMap.peerEdges));
    const apiNodeIds = new Set(analyzeData.bridgeMap.nodes.map((n) => n.id));
    for (const pe of analyzeData.bridgeMap.peerEdges) {
      assert.ok(apiNodeIds.has(pe.from));
      assert.ok(apiNodeIds.has(pe.to));
    }
    assert.ok(analyzeData.shortlist[0].evidenceFolders);
    assert.ok(analyzeData.shortlist[0].evidenceFolders.hiddenBridges);
    assert.ok(analyzeData.shortlist[0].evidenceFolders.observedActivity);
    assert.ok(analyzeData.shortlist[0].evidenceFolders.proofAndGaps);
    assert.ok(analyzeData.shortlist[0].diligencePacket);
    assert.ok(analyzeData.shortlist[0].diligencePacket.conflictRisk);
    assert.ok(Array.isArray(analyzeData.shortlist[0].diligencePacket.callQuestions));

    const refineTwinRes = await fetch(`${baseUrl}/api/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'fund',
        fundId: 'lifeline-ventures',
        bridgeFamily: 'portfolio_twin',
        hideMegaHubs: true
      })
    });
    assert.equal(refineTwinRes.status, 200);
    const refineTwinData = await refineTwinRes.json();
    assert.equal(refineTwinData.appliedFilters.bridgeFamily, 'portfolio_twin');
    assert.ok(refineTwinData.shortlist.length >= 1);
    assert.ok(refineTwinData.bridgeMap.clusters.find((c) => c.bridgeFamily === 'portfolio_twin').nodeCount >= 1);

    const refineStrictEmptyRes = await fetch(`${baseUrl}/api/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'fund',
        fundId: 'lifeline-ventures',
        slush2026Only: true,
        bridgeFamily: 'portfolio_twin',
        hideMegaHubs: true
      })
    });
    assert.equal(refineStrictEmptyRes.status, 200);
    const refineStrictEmptyData = await refineStrictEmptyRes.json();
    assert.equal(refineStrictEmptyData.shortlist.length, 0);
    assert.equal(refineStrictEmptyData.usedSoftFallback, false);
    assert.ok(Array.isArray(refineStrictEmptyData.relaxSuggestions) && refineStrictEmptyData.relaxSuggestions.length >= 1);

    const refineAlumniRes = await fetch(`${baseUrl}/api/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'fund',
        fundId: 'lifeline-ventures',
        bridgeFamily: 'alumni_spinout',
        hideMegaHubs: true
      })
    });
    assert.equal(refineAlumniRes.status, 200);
    const refineAlumniData = await refineAlumniRes.json();
    assert.equal(refineAlumniData.appliedFilters.bridgeFamily, 'alumni_spinout');
    assert.equal(refineAlumniData.appliedFilters.hideMegaHubs, true);
    assert.ok(refineAlumniData.shortlist.length >= 1);
    assert.ok(refineAlumniData.bridgeMap);
    assert.ok(refineAlumniData.bridgeMap.clusters.find((c) => c.bridgeFamily === 'alumni_spinout').nodeCount >= 1);

    const calaDiscoverRes = await fetch(`${baseUrl}/api/cala-discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'fund',
        fundId: 'lifeline-ventures',
        queryText: 'Pleo',
        hideMegaHubs: true
      })
    });
    assert.equal(calaDiscoverRes.status, 200);
    const calaDiscoverData = await calaDiscoverRes.json();
    assert.ok(calaDiscoverData.bridgeMap);
    assert.ok(Array.isArray(calaDiscoverData.relaxSuggestions));

    const refineRevealRes = await fetch(`${baseUrl}/api/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'fund',
        fundId: 'lifeline-ventures',
        hideMegaHubs: false
      })
    });
    assert.equal(refineRevealRes.status, 200);
    const refineRevealData = await refineRevealRes.json();
    assert.equal(refineRevealData.appliedFilters.hideMegaHubs, false);
    assert.equal(refineRevealData.bridgeMap.stats.hideMegaHubsApplied, false);
    assert.equal(refineRevealData.bridgeMap.stats.suppressedMegaHubCount, 0);
    assert.equal(refineRevealData.bridgeMap.contributionClusters.length, 4);
    assert.equal(refineRevealData.bridgeMap.clusters.length, 5);

    const refineTimingRes = await fetch(`${baseUrl}/api/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'fund',
        fundId: 'lifeline-ventures',
        contributionGroup: 'timing',
        hideMegaHubs: true
      })
    });
    assert.equal(refineTimingRes.status, 200);
    const refineTimingData = await refineTimingRes.json();
    assert.equal(refineTimingData.appliedFilters.contributionGroup, 'timing');
    assert.ok(refineTimingData.shortlist.length >= 1);
    assert.ok(refineTimingData.bridgeMap.nodes.filter((n) => n.kind === 'bridge').every((n) => n.contributionGroup === 'timing'));

    const refineCautionRes = await fetch(`${baseUrl}/api/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'fund',
        fundId: 'lifeline-ventures',
        contributionGroup: 'caution',
        hideMegaHubs: false
      })
    });
    assert.equal(refineCautionRes.status, 200);
    const refineCautionData = await refineCautionRes.json();
    assert.equal(refineCautionData.appliedFilters.contributionGroup, 'caution');
    assert.ok(refineCautionData.shortlist.length >= 1);

    const briefRes = await fetch(`${baseUrl}/api/brief?startupId=voltgrid&fundId=lifeline-ventures`);
    assert.equal(briefRes.status, 200);
    const briefData = await briefRes.json();
    assert.ok(briefData.evidenceFolders);
    assert.ok(briefData.evidenceFolders.hiddenBridges.paths.some((p) => p.bridgeFamily === 'alumni_spinout'));
    assert.ok(briefData.evidenceFolders.hiddenBridges.paths.every((p) => p.formulaBreakdown && p.formulaBreakdown.inputs));
    assert.ok(typeof briefData.evidenceFolders.observedActivity.velocityFormula === 'string');
    assert.ok(briefData.diligencePacket);
    assert.ok(typeof briefData.diligencePacket.timingFormula === 'string');
    assert.ok(typeof briefData.signalTier === 'string');
    assert.ok(briefData.diligencePacket.callQuestions.length >= 3);
    assert.ok(Array.isArray(briefData.notFoundInCala) && briefData.notFoundInCala.length >= 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/refine with discoverLive queries Company+Organization+Person, expands Person bridges, unpacks nested numerical observations, and degrades gracefully offline', async () => {
  const searchCalls = [];
  const introspectCalls = [];
  const retrieveBodies = [];
  const ksCalls = [];

  const mockPersonId = 'mock-person-sara-1';
  const mockDirectCoId = 'mock-co-kinetix-1';
  const mockKsCoId = 'mock-co-quantgrid-2';
  const mockAngelCoId = 'mock-co-solarflow-3';

  const mockEntities = {
    [mockPersonId]: {
      id: mockPersonId,
      name: 'Sara Lindqvist',
      entity_type: 'Person',
      description: 'Founder and angel backer across Nordic deeptech startups.',
      relationships: {
        outgoing: {
          WORKS_AT: [
            {
              id: 'mock-org-prev-0',
              name: 'Spotify AB',
              entity_type: 'Company',
              properties: { role: 'VP Engineering', valid_since: '2018-01-01', valid_until: '2022-06-01' }
            }
          ],
          FOUNDED: [
            {
              id: mockDirectCoId,
              name: 'Kinetix Robotics Oy',
              entity_type: 'Company',
              properties: { valid_since: '2023-02-01' }
            }
          ],
          INVESTED_IN: [
            {
              id: mockAngelCoId,
              name: 'SolarFlow AB',
              entity_type: 'Company',
              properties: { role: 'Angel Investor', valid_since: '2024-09-01' }
            }
          ]
        },
        incoming: {}
      }
    },
    [mockDirectCoId]: {
      id: mockDirectCoId,
      name: 'Kinetix Robotics Oy',
      entity_type: 'Company',
      description: 'Industrial autonomous assembly robotics founded in 2023 in Helsinki, Finland.',
      properties: {
        website: { value: 'https://kinetix.fi' }
      },
      relationships: {
        outgoing: {
          OPERATES_IN_INDUSTRY: [{ id: 'ind-1', name: 'Robotics & Automation' }],
          PARTICIPATES_IN_FUNDING_ROUND: [
            { id: 'rnd-mock-1', name: 'Pre-Seed Round', properties: { role: 'ISSUER' } }
          ]
        },
        incoming: {
          FOUNDED: [{ id: mockPersonId, name: 'Sara Lindqvist', properties: { valid_since: '2023-02-01' } }]
        }
      },
      numerical_observations: [
        {
          type: 'ObservableProperty',
          id: 'obs-emp-1',
          name: 'AverageNumberEmployeesDuringPeriod',
          properties: { unit: 'Count' },
          data: [
            {
              time: '2023-12-31T00:00:00Z',
              value: 9,
              origin: { name: 'Finnish Trade Register PRH', source: 'PRH', url: 'https://prh.fi/kinetix', published_time: '2024-02-15T00:00:00Z' }
            },
            {
              time: '2025-12-31T00:00:00Z',
              value: 24,
              origin: { name: 'Finnish Trade Register PRH', source: 'PRH', url: 'https://prh.fi/kinetix-2025', published_time: '2026-02-15T00:00:00Z' }
            }
          ]
        },
        {
          type: 'FinancialMetric',
          id: 'obs-cash-1',
          name: 'CashBankOnHand',
          properties: { unit: 'EUR' },
          data: [
            {
              time: '2025-12-31T00:00:00Z',
              value: 1850000,
              origin: { name: 'Finnish Trade Register PRH Filing', source: 'FILING', url: 'https://prh.fi/kinetix-bs', published_time: '2026-03-01T00:00:00Z' }
            }
          ]
        }
      ]
    },
    [mockKsCoId]: {
      id: mockKsCoId,
      name: 'QuantGrid Labs Oy',
      entity_type: 'Company',
      description: 'Grid control optimization platform founded in 2024 in Espoo, Finland.',
      relationships: { outgoing: {}, incoming: {} },
      numerical_observations: []
    },
    [mockAngelCoId]: {
      id: mockAngelCoId,
      name: 'SolarFlow AB',
      entity_type: 'Company',
      description: 'Grid storage software founded in 2024 in Stockholm, Sweden.',
      relationships: { outgoing: {}, incoming: {} },
      numerical_observations: []
    }
  };

  const mockCalaClient = {
    getBudgetStatus: () => ({ liveCallsUsed: searchCalls.length + ksCalls.length, liveCallsRemaining: 240, maxLiveCalls: 250, hasApiKey: true }),
    async calaEntitySearch(query, limit, entityTypes) {
      searchCalls.push({ query, limit, entityTypes });
      return {
        fromCache: false,
        data: {
          entities: [
            { id: mockPersonId, name: 'Sara Lindqvist', entity_type: 'Person', description: 'Founder and angel backer.' },
            { id: mockDirectCoId, name: 'Kinetix Robotics Oy', entity_type: 'Company', description: 'Robotics in Helsinki.' }
          ]
        }
      };
    },
    async calaKnowledgeSearch(query, opts) {
      ksCalls.push({ query, opts });
      return {
        fromCache: false,
        data: {
          answer: 'Sara Lindqvist founded Kinetix Robotics Oy and angel-backed SolarFlow AB.',
          entities: [
            { id: mockKsCoId, name: 'QuantGrid Labs Oy', entity_type: 'Company', description: 'Grid platform in Espoo.' },
            { id: mockPersonId, name: 'Sara Lindqvist', entity_type: 'Person', description: 'Founder.' }
          ]
        }
      };
    },
    async calaIntrospect(id) {
      introspectCalls.push(id);
      if (id === mockDirectCoId) {
        return {
          fromCache: false,
          data: {
            properties: ['name', 'description', 'website'],
            relationships: { outgoing: ['OPERATES_IN_INDUSTRY', 'PARTICIPATES_IN_FUNDING_ROUND'], incoming: ['FOUNDED'] },
            numerical_observations: {
              ObservableProperty: [{ id: 'obs-emp-1', name: 'AverageNumberEmployeesDuringPeriod' }],
              FinancialMetric: [{ id: 'obs-cash-1', name: 'CashBankOnHand' }]
            }
          }
        };
      }
      if (id === mockPersonId) {
        return {
          fromCache: false,
          data: {
            properties: ['name', 'description'],
            relationships: { outgoing: ['WORKS_AT', 'FOUNDED', 'INVESTED_IN'], incoming: [] },
            numerical_observations: {}
          }
        };
      }
      return {
        fromCache: false,
        data: { properties: ['name', 'description'], relationships: { outgoing: [], incoming: [] }, numerical_observations: {} }
      };
    },
    async calaRetrieveEntity(id, body) {
      retrieveBodies.push({ id, body });
      return { fromCache: false, data: mockEntities[id] || { id, name: 'Unknown', entity_type: 'Company' } };
    }
  };

  const tmpDirOnline = fs.mkdtempSync(path.join(os.tmpdir(), 'rte-api-live-cala-'));
  const serverOnline = createAppServer({
    calaClient: mockCalaClient,
    registryClient: createRegistryClient({ cachePath: path.join(tmpDirOnline, 'reg.json') })
  });
  await new Promise((resolve) => serverOnline.listen(0, '127.0.0.1', resolve));
  const onlineUrl = `http://127.0.0.1:${serverOnline.address().port}`;

  const tmpDirOffline = fs.mkdtempSync(path.join(os.tmpdir(), 'rte-api-offline-'));
  const serverOffline = createAppServer({
    calaClient: createCalaClient({ apiKey: '', cacheFile: path.join(tmpDirOffline, 'cala-empty.json') }),
    registryClient: createRegistryClient({ cachePath: path.join(tmpDirOffline, 'reg.json') })
  });
  await new Promise((resolve) => serverOffline.listen(0, '127.0.0.1', resolve));
  const offlineUrl = `http://127.0.0.1:${serverOffline.address().port}`;

  try {
    const refineRes = await fetch(`${onlineUrl}/api/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'fund',
        fundId: 'lifeline-ventures',
        queryText: 'Sara Lindqvist',
        discoverLive: true,
        discoverRegistries: false
      })
    });
    assert.equal(refineRes.status, 200);
    const data = await refineRes.json();

    assert.equal(searchCalls.length, 1);
    assert.deepEqual(searchCalls[0].entityTypes, ['Company', 'Organization', 'Person']);
    assert.ok(searchCalls[0].limit >= 12);
    assert.equal(ksCalls.length, 1);

    // Must combine BOTH directHits AND KS hits (QuantGrid Labs Oy) without skipping KS deep hydration
    assert.ok(introspectCalls.includes(mockDirectCoId));
    assert.ok(introspectCalls.includes(mockKsCoId));
    assert.ok(introspectCalls.includes(mockPersonId));
    assert.ok(introspectCalls.includes(mockAngelCoId));

    // Verify numerical_observations object was mapped to { ObservableProperty: [...ids], FinancialMetric: [...ids] }
    const directRetrieve = retrieveBodies.find((r) => r.id === mockDirectCoId);
    assert.deepEqual(directRetrieve.body.numerical_observations, {
      ObservableProperty: ['obs-emp-1'],
      FinancialMetric: ['obs-cash-1']
    });

    // Connected companies Kinetix Robotics Oy + SolarFlow AB appear for Person search Sara Lindqvist
    const names = data.shortlist.map((c) => c.name);
    assert.ok(names.includes('Kinetix Robotics Oy'), `Expected Kinetix in shortlist, got: ${names.join(', ')}`);
    assert.ok(names.includes('SolarFlow AB'), `Expected SolarFlow AB in shortlist, got: ${names.join(', ')}`);

    // Kinetix unpacks real nested series & financialMetrics and keeps null round date/amount honest
    const kinetix = data.shortlist.find((c) => c.name === 'Kinetix Robotics Oy');
    assert.equal(kinetix.employeeCountSeries.length, 2);
    assert.equal(kinetix.employeeCount, 24);
    assert.ok(kinetix.financialMetrics.some((m) => m.metric === 'CashBankOnHand' && m.value === 1850000));
    assert.equal(kinetix.lastRoundDate, null);
    assert.equal(kinetix.lastRoundAmountEurM, null);
    assert.ok(
      kinetix.evidenceFolders.hiddenBridges.paths.some((p) => /Spotify|Sara Lindqvist/i.test(p.bridgeEntityName)),
      'Expected Person/Alumni bridge in Kinetix paths'
    );

    const solar = data.shortlist.find((c) => c.name === 'SolarFlow AB');
    assert.ok(
      solar.evidenceFolders.hiddenBridges.paths.some((p) => p.bridgeEntityName === 'Sara Lindqvist'),
      'Expected Sara Lindqvist Person bridge on angel-backed SolarFlow AB'
    );

    // Offline graceful degradation when CALA_API_KEY is unset and discoverLive: true
    const offlineRes = await fetch(`${offlineUrl}/api/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'fund',
        fundId: 'lifeline-ventures',
        queryText: 'Helsinki',
        discoverLive: true,
        discoverRegistries: false
      })
    });
    assert.equal(offlineRes.status, 200);
    const offlineData = await offlineRes.json();
    assert.ok(Array.isArray(offlineData.shortlist));
    assert.equal(offlineData.liveDiscoveredCount, 0);
  } finally {
    for (const calaId of [mockDirectCoId, mockKsCoId, mockAngelCoId]) {
      const idx = COMPANIES.findIndex((c) => c.calaEntityId === calaId);
      if (idx !== -1) COMPANIES.splice(idx, 1);
    }
    await new Promise((resolve) => serverOnline.close(resolve));
    await new Promise((resolve) => serverOffline.close(resolve));
  }
});

test('POST /api/connection-insight validates packet and returns grounded response', async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = '';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rte-api-insight-'));
  const server = createAppServer({
    calaClient: createCalaClient({ apiKey: '', cacheFile: path.join(tmpDir, 'cala.json') }),
    registryClient: createRegistryClient({ cachePath: path.join(tmpDir, 'reg.json') })
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const badRes = await fetch(`${url}/api/connection-insight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(badRes.status, 400);

    const okRes = await fetch(`${url}/api/connection-insight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'connection',
        title: 'Sequoia Capital -> OpenAI',
        hopType: '1-hop direct',
        relation: 'INVESTED_IN',
        whyMatters: 'Direct backer of OpenAI.',
        facts: [{ text: 'Sequoia Capital invested in OpenAI', sourceIds: ['src-api-1'] }],
        sources: [{ id: 'src-api-1', title: 'OpenAI Investor Record', publisher: 'Cala', sourceRank: 'PRIMARY' }]
      })
    });
    assert.equal(okRes.status, 200);
    const data = await okRes.json();
    assert.equal(data.controlPlaneMode, 'deterministic-fallback');
    assert.equal(data.anthropicConfigured, false);
    assert.ok(Array.isArray(data.insights) && data.insights.length === 1);
    assert.deepEqual(data.insights[0].sourceIds, ['src-api-1']);
  } finally {
    process.env.ANTHROPIC_API_KEY = prevKey || '';
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/analyze supports neutral teardown and perspective_triage mode with perspectiveEntity', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rte-api-persp-'));
  const targetEntity = {
    id: 'ent-target-api',
    name: 'Anthropic Test Co',
    entity_type: 'Company',
    relationships: {
      outgoing: { OPERATES_IN_INDUSTRY: [{ id: 'ind-ai', name: 'Foundation Models' }] },
      incoming: {
        INVESTED_IN: [
          {
            id: 'ent-persp-api',
            name: 'Sequoia Test Fund',
            entity_type: 'Organization',
            properties: { sources: [{ name: 'Press', document: 'https://example.com/seq-anth', published_time: '2026-05-01' }] }
          }
        ]
      }
    }
  };
  const perspEntity = {
    id: 'ent-persp-api',
    name: 'Sequoia Test Fund',
    entity_type: 'Organization',
    relationships: {
      outgoing: {
        INVESTED_IN: [
          {
            id: 'ent-target-api',
            name: 'Anthropic Test Co',
            entity_type: 'Company',
            properties: { sources: [{ name: 'Press', document: 'https://example.com/seq-anth', published_time: '2026-05-01' }] }
          }
        ]
      },
      incoming: {}
    }
  };

  const server = createAppServer({
    calaClient: createCalaClient({ apiKey: '', cacheFile: path.join(tmpDir, 'cala.json') }),
    registryClient: createRegistryClient({ cachePath: path.join(tmpDir, 'reg.json') })
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const neutralRes = await fetch(`${url}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'entity', entities: [targetEntity] })
    });
    assert.equal(neutralRes.status, 200);
    const neutralData = await neutralRes.json();
    assert.equal(neutralData.analysisMode, 'single_teardown');
    assert.equal(neutralData.perspectiveEntity, null);

    const triageRes = await fetch(`${url}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'entity',
        entities: [targetEntity],
        perspectiveEntity: perspEntity,
        primaryTargetId: targetEntity.id
      })
    });
    assert.equal(triageRes.status, 200);
    const triageData = await triageRes.json();
    assert.equal(triageData.analysisMode, 'perspective_triage');
    assert.equal(triageData.perspectiveEntity?.id, perspEntity.id);
    assert.equal(triageData.bridgeMap.perspectiveEntity?.isColdOutreach, false);
    assert.equal(triageData.bridgeMap.primaryTargetId, targetEntity.id);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
