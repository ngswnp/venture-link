import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../server.mjs';
import { buildEntityBridgeMap, ingestLiveCalaEntities, runFullAnalysis } from '../src/engine.mjs';
import { COMPANIES } from '../src/data.mjs';

function removeLiveRecords(calaEntityIds) {
  for (let index = COMPANIES.length - 1; index >= 0; index -= 1) {
    if (calaEntityIds.has(COMPANIES[index].calaEntityId)) {
      COMPANIES.splice(index, 1);
    }
  }
}

function createLiveSearchClient() {
  const calls = [];
  const records = {
    'cala-nvidia-test': {
      id: 'cala-nvidia-test',
      name: 'NVIDIA Corporation',
      entity_type: 'Organization',
      description: 'NVIDIA is a publicly traded accelerated computing company.',
      properties: {
        name: {
          value: 'NVIDIA Corporation',
          sources: [{
            name: 'NVIDIA investor relations',
            source: 'NVIDIA',
            document: 'https://investor.nvidia.com',
            published_time: '2026-01-15',
            source_rank: 'PRIMARY'
          }]
        },
        cik: { value: '1045810' },
        website: { value: 'https://www.nvidia.com' },
        founding_date: { value: '1993-04-05' }
      },
      relationships: {
        outgoing: {
          TRADED_ON: [{ id: 'nasdaq', name: 'NASDAQ' }],
          PARTICIPATES_IN_FUNDING_ROUND: [{
            id: 'nvidia-verified-round',
            name: 'Strategic Investment',
            properties: {
              role: 'ISSUER',
              event_date: '2025-02-01',
              transaction_value: 50000000,
              sources: [{
                name: 'NVIDIA investment announcement',
                source: 'NVIDIA',
                document: 'https://investor.nvidia.com/announcement',
                published_time: '2025-02-01',
                source_rank: 'PRIMARY'
              }]
            }
          }],
          PARTNERED_WITH: [{
            id: 'cala-openai-test',
            name: 'OpenAI',
            entity_type: 'Organization',
            properties: {
              sources: [{
                name: 'Verified partnership announcement',
                source: 'NVIDIA',
                document: 'https://www.nvidia.com/partnership',
                published_time: '2025-04-10',
                source_rank: 'PRIMARY'
              }]
            }
          }]
        },
        incoming: {
          IS_CEO_OF: [{
            id: 'jensen-huang-test',
            name: 'Jensen Huang',
            entity_type: 'Person',
            properties: {
              role: 'Chief Executive Officer',
              valid_since: '1993-04-05',
              sources: [{
                name: 'NVIDIA leadership',
                source: 'NVIDIA',
                document: 'https://www.nvidia.com/leadership',
                published_time: '2026-01-15',
                source_rank: 'PRIMARY'
              }]
            }
          }]
        }
      },
      numerical_observations: []
    },
    'cala-openai-test': {
      id: 'cala-openai-test',
      name: 'OpenAI',
      entity_type: 'Organization',
      description: 'OpenAI is an artificial intelligence research and deployment organization.',
      properties: {
        website: { value: 'https://openai.com' },
        founding_date: { value: '2015-12-11' }
      },
      relationships: {
        outgoing: {},
        incoming: {}
      },
      numerical_observations: []
    }
  };

  return {
    calls,
    getBudgetStatus: () => ({ configured: true, liveCallsUsed: calls.length, maxLiveCalls: 25, cacheHits: 0 }),
    async calaEntitySearch(query, limit, entityTypes) {
      calls.push({ query, limit, entityTypes });
      const needle = String(query).toLowerCase();
      const entity = needle.includes('nvidia') ? records['cala-nvidia-test'] : records['cala-openai-test'];
      return {
        data: {
          entities: [{ id: entity.id, name: entity.name, entity_type: entity.entity_type, description: entity.description }]
        }
      };
    },
    async calaIntrospect() {
      return {
        data: {
          properties: ['name', 'description', 'website'],
          relationships: { outgoing: ['TRADED_ON'], incoming: [] },
          numerical_observations: {}
        }
      };
    },
    async calaRetrieveEntity(id) {
      return { data: records[id] };
    },
    async calaKnowledgeSearch() {
      return { data: { entities: [] } };
    }
  };
}

test('live entity search keeps Nvidia and OpenAI available even when they are mature organizations', async () => {
  const calaClient = createLiveSearchClient();
  const server = createAppServer({ calaClient });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const query of ['nvidia', 'openai']) {
      const response = await fetch(`${baseUrl}/api/search?q=${query}&live=1`);
      assert.equal(response.status, 200);
      const payload = await response.json();
      const results = [...(payload.entities || []), ...(payload.liveEntities || [])];
      assert.ok(
        results.some((entity) => entity.name.toLowerCase().includes(query)),
        `Expected live ${query} result, received: ${results.map((entity) => entity.name).join(', ')}`
      );
      assert.ok(
        results.some((entity) => entity.isLiveCalaDiscovered),
        `Expected ${query} to be marked as a live Cala entity`
      );
    }

    assert.equal(calaClient.calls.length, 2);
    for (const call of calaClient.calls) {
      assert.equal(call.limit, 12);
      assert.deepEqual(call.entityTypes, ['Company', 'Organization', 'Person']);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    removeLiveRecords(new Set(['cala-nvidia-test', 'cala-openai-test']));
  }
});

test('entity dossier returns verified profile evidence and explicit Cala gaps', async () => {
  const calaClient = createLiveSearchClient();
  const server = createAppServer({ calaClient });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(
      `${baseUrl}/api/entity-dossier?ref=Organization:cala-nvidia-test&mapEntityIds=cala-openai-test`
    );
    assert.equal(response.status, 200);
    const dossier = await response.json();

    assert.equal(dossier.identity.name, 'NVIDIA Corporation');
    assert.ok(dossier.people.some((person) => person.name === 'Jensen Huang'));
    assert.ok(dossier.rounds.some((round) => round.type));
    assert.ok(dossier.relationships.outgoing.PARTNERED_WITH.some((entity) => entity.name === 'OpenAI'));
    assert.ok(dossier.sources.some((source) => source.sourceRank === 'PRIMARY'));
    assert.ok(Array.isArray(dossier.gaps));
    assert.ok(
      dossier.gaps.some((gap) => gap.status === 'Not found in Cala'),
      'The dossier should state which absent Cala fields need follow-up'
    );
    assert.ok(
      dossier.verifiedConnections.some((connection) => connection.entityId === 'cala-openai-test'),
      'The active map context should surface the verified OpenAI connection'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    removeLiveRecords(new Set(['cala-nvidia-test', 'cala-openai-test']));
  }
});

test('sparse live Cala entities retain unknown employee and funding fields without synthetic defaults', () => {
  const calaEntityId = 'cala-sparse-honest-test';
  try {
    const ingested = ingestLiveCalaEntities([
      {
        id: calaEntityId,
        name: 'Sparse Honest Systems Oy',
        entity_type: 'Company',
        description: 'A newly indexed technology company.',
        properties: {},
        relationships: { outgoing: {}, incoming: {} },
        numerical_observations: []
      }
    ]);

    assert.equal(ingested.ingestedCount, 1);
    const entity = ingested.companies[0];
    assert.equal(entity.employeeCount, null);
    assert.deepEqual(entity.employeeCountSeries, []);
    assert.deepEqual(entity.rounds, []);
    assert.doesNotMatch(JSON.stringify(entity), /2025-04-15|Apr 2025|Mikko Korhonen/i);
  } finally {
    removeLiveRecords(new Set([calaEntityId]));
  }
});

test('entity bridge map draws only verified relationships to its focal entity', () => {
  const anchor = {
    id: 'nvidia',
    name: 'NVIDIA',
    entityType: 'Organization',
    entityCategory: 'established_corp',
    relationships: { outgoing: {}, incoming: {} }
  };
  const unrelated = {
    id: 'openai',
    name: 'OpenAI',
    entityType: 'Organization',
    entityCategory: 'established_corp',
    relationships: { outgoing: {}, incoming: {} }
  };

  const withoutProof = buildEntityBridgeMap(anchor, [unrelated]);
  assert.equal(withoutProof.anchor.id, 'nvidia');
  assert.equal(
    withoutProof.edges.some((edge) =>
      (edge.from === 'nvidia' && edge.to === 'openai') || (edge.from === 'openai' && edge.to === 'nvidia')
    ),
    false,
    'An unrelated live entity must not acquire an anchor edge'
  );

  const verifiedAnchor = {
    ...anchor,
    relationships: {
      outgoing: {
        PARTNERED_WITH: [
          {
            id: 'openai',
            name: 'OpenAI',
            entity_type: 'Organization',
            properties: {
              sources: [{ name: 'Partner announcement', source_rank: 'PRIMARY' }]
            }
          }
        ]
      },
      incoming: {}
    }
  };
  const withProof = buildEntityBridgeMap(verifiedAnchor, [unrelated]);
  const verifiedEdge = withProof.edges.find(
    (edge) =>
      (edge.from === 'nvidia' && edge.to === 'openai') || (edge.from === 'openai' && edge.to === 'nvidia')
  );
  assert.ok(verifiedEdge, 'A verified Cala relationship should render an anchor edge');
  assert.equal(verifiedEdge.topSourceRank, 'PRIMARY');
  assert.match(verifiedEdge.label, /partnered/i);

  const multiCenterMap = buildEntityBridgeMap([verifiedAnchor, unrelated], [], { multiCenter: true });
  assert.deepEqual(multiCenterMap.focalEntityIds, ['nvidia', 'openai']);
  assert.ok(
    multiCenterMap.edges.some((edge) =>
      (edge.from === 'nvidia' && edge.to === 'openai') || (edge.from === 'openai' && edge.to === 'nvidia')
    ),
    'A verified direct relationship should remain visible when both entities are focal centers'
  );
});


test('buildEntityBridgeMap expands FundingRound 2-hop co-investors, filters generic containers, maps unknown relations, and bridges cross-hub people', () => {
  const openai = {
    id: 'focal-openai',
    name: 'OpenAI',
    entity_type: 'Company',
    properties: {},
    relationships: {
      outgoing: {
        PARTICIPATES_IN_CORPORATE_EVENT: [
          { id: 'round-g-openai', name: 'FINANCING_RAISED_OR_FACILITY_ENTERED', entity_type: 'PrivateCompanyFundingRound', properties: { role: 'ISSUER', event_date: '2026-04-21' } },
          { id: 'ev-results', name: 'Results', entity_type: 'CorporateEvent', properties: { event_date: '2026-03-01' } },
          { id: 'ev-other', name: 'Other Material', entity_type: 'CorporateEvent', properties: { event_date: '2026-02-15' } }
        ],
        SUPPLIED_BY: [
          { id: 'org-tsmc', name: 'TSMC', entity_type: 'Company', properties: {} }
        ],
        AFFECTS_SUPPLY_CHAIN: [
          { id: 'org-hbm', name: 'SK Hynix', entity_type: 'Company', properties: {} }
        ]
      },
      incoming: {
        PARTICIPATES_IN_FUNDING_ROUND: [],
        HAS_FUNDING_ROUND: [
          { id: 'round-seed-stub', name: 'Seed', entity_type: 'FundingRound', properties: { event_date: '2020-01-01' } }
        ]
      }
    }
  };

  const anthropic = {
    id: 'focal-anthropic',
    name: 'Anthropic',
    entity_type: 'Company',
    properties: {},
    relationships: {
      outgoing: {
        PARTICIPATES_IN_FUNDING_ROUND: [
          { id: 'round-series-a-anth', name: 'Series A', entity_type: 'FundingRound', properties: { role: 'ISSUER', event_date: '2021-05-28' } }
        ],
        PARTICIPATES_IN_CORPORATE_EVENT: [
          { id: 'ev-10k', name: 'Form 10-K', entity_type: 'CorporateEvent', properties: { event_date: '2026-01-10' } },
          { id: 'ev-curr', name: 'Current Report', entity_type: 'CorporateEvent', properties: { event_date: '2026-01-05' } },
          { id: 'ev-mat', name: 'MATERIAL_AGREEMENT_ANNOUNCED', entity_type: 'CorporateEvent', properties: { event_date: '2023-07-01' } }
        ]
      },
      incoming: {
        FOUNDED: [
          { id: 'person-daniela', name: 'Daniela Amodei', entity_type: 'Person', properties: {} },
          { id: 'person-daniela-dup', name: 'Daniela Amodei', entity_type: 'Person', properties: {} }
        ],
        INVESTED_IN: []
      }
    }
  };

  const roundGOpenAI = {
    id: 'round-g-openai',
    name: 'FINANCING_RAISED_OR_FACILITY_ENTERED',
    entity_type: 'PrivateCompanyFundingRound',
    properties: {
      round_type: { value: 'Series G' },
      transaction_value: { value: 40000000000 },
      transaction_value_units: { value: 'USD' },
      event_date: { value: '2026-04-21' }
    },
    relationships: {
      incoming: {
        PARTICIPATES_IN_CORPORATE_EVENT: [
          { id: 'focal-openai', name: 'OpenAI', entity_type: 'Company', properties: { role: 'ISSUER' } },
          { id: 'inv-shared-vc', name: 'General Catalyst', entity_type: 'Organization', properties: { role: 'INVESTOR', is_lead: true } }
        ]
      },
      outgoing: {}
    }
  };

  const roundSeriesAAnthropic = {
    id: 'round-series-a-anth',
    name: 'Series A',
    entity_type: 'FundingRound',
    properties: {
      round_label: { value: 'Series A' },
      transaction_value: { value: 124000000 },
      transaction_value_units: { value: 'USD' },
      close_date: { value: '2021-05-28' }
    },
    relationships: {
      incoming: {
        PARTICIPATES_IN_FUNDING_ROUND: [
          { id: 'inv-shared-vc', name: 'General Catalyst', entity_type: 'Organization', properties: { role: 'INVESTOR' } }
        ]
      },
      outgoing: {}
    }
  };

  const daniela = {
    id: 'person-daniela',
    name: 'Daniela Amodei',
    entity_type: 'Person',
    properties: {},
    relationships: {
      outgoing: {
        IS_VICEPRESIDENT_OF: [
          { id: 'alt-openai-org', name: 'OpenAI, Inc.', entity_type: 'Organization', properties: {} }
        ],
        FOUNDED: [
          { id: 'alt-anthropic-pbc', name: 'Anthropic, PBC', entity_type: 'Company', properties: {} }
        ]
      },
      incoming: {}
    }
  };

  const bridgeMap = buildEntityBridgeMap(
    [openai, anthropic],
    [roundGOpenAI, roundSeriesAAnthropic, daniela],
    { multiCenter: true }
  );

  const labels = bridgeMap.nodes.map((n) => n.label);
  for (const forbidden of ['Results', 'Other Material', 'Form 10-K', 'Current Report', 'Seed', 'Series A', 'FINANCING_RAISED_OR_FACILITY_ENTERED']) {
    assert.ok(!labels.includes(forbidden), `Expected generic blob "${forbidden}" to be excluded from map nodes`);
  }

  assert.ok(labels.includes('General Catalyst'), 'Expected hydrated FundingRound investor General Catalyst on map');
  assert.ok(labels.includes('Daniela Amodei'), 'Expected hydrated Person Daniela Amodei on map');
  assert.equal(labels.filter((lbl) => lbl === 'Daniela Amodei').length, 1, 'Expected duplicate person UUIDs with same name to coalesce into 1 orb');
  assert.ok(!labels.some((lbl) => /material agreement/i.test(lbl)), 'Expected CorporateEvent container to move out of map orbs');
  assert.ok(labels.includes('TSMC'), 'Expected SUPPLIED_BY target TSMC to be mapped rather than dropped');
  assert.ok(labels.includes('SK Hynix'), 'Expected AFFECTS_SUPPLY_CHAIN target SK Hynix to be mapped rather than dropped');

  const vcNode = bridgeMap.nodes.find((n) => n.label === 'General Catalyst');
  const personNode = bridgeMap.nodes.find((n) => n.label === 'Daniela Amodei');
  assert.equal(vcNode.isSharedBridge, true);
  assert.equal(personNode.isSharedBridge, true);
  assert.equal(vcNode.sharedByFocalEntityIds.length, 2);
  assert.equal(personNode.sharedByFocalEntityIds.length, 2);

  const tsmcEdge = bridgeMap.edges.find((e) => e.from === 'org-tsmc' || e.to === 'org-tsmc');
  const riskEdge = bridgeMap.edges.find((e) => e.from === 'org-hbm' || e.to === 'org-hbm');
  assert.equal(tsmcEdge.contributionGroup, 'access');
  assert.equal(tsmcEdge.label, 'Supplied by');
  assert.equal(riskEdge.contributionGroup, 'caution');
  assert.equal(riskEdge.label, 'Affects supply chain');

  assert.ok(bridgeMap.timingEventsByEntity['focal-openai'].some((ev) => ev.title === 'Results'));
  assert.ok(bridgeMap.timingEventsByEntity['focal-anthropic'].some((ev) => ev.title === 'Form 10-K'));
});

test('buildEntityBridgeMap attaches ranked evidenceSources, syndicatePeers, and clean punctuation on edges', () => {
  const sequoia = {
    id: 'focal-sequoia',
    name: 'Sequoia Capital',
    entity_type: 'Organization',
    properties: {},
    relationships: {
      outgoing: {
        PARTICIPATES_IN_FUNDING_ROUND: [{ id: 'round-h-anth', name: 'Series H', properties: { role: 'INVESTOR' } }]
      },
      incoming: {}
    }
  };
  const elevenLabs = {
    id: 'org-eleven-labs',
    name: 'ELEVEN LABS INC.',
    entity_type: 'Organization',
    properties: {},
    relationships: { outgoing: {}, incoming: {} }
  };
  const nvidia = {
    id: 'focal-nvidia',
    name: 'NVIDIA Corporation',
    entity_type: 'Organization',
    properties: {},
    relationships: {
      outgoing: {
        PARTNERED_WITH: [{
          id: 'org-eleven-labs',
          name: 'ELEVEN LABS INC.',
          entity_type: 'Organization',
          properties: {
            sources: [
              {
                name: 'Press roundup covering partnership',
                document: 'https://techcrunch.com/eleven-nvidia',
                published_time: '2026-02-14',
                source_rank: 'PRESS'
              },
              {
                name: 'NVIDIA 10-K commercial partner disclosure',
                document: 'https://www.sec.gov/Archives/edgar/data/1045810/nvidia10k.htm',
                published_time: '2026-02-26'
              }
            ]
          }
        }],
        PARTICIPATES_IN_FUNDING_ROUND: [{ id: 'round-h-anth', name: 'Series H', properties: { role: 'INVESTOR' } }]
      },
      incoming: {}
    }
  };
  const roundHAnthropic = {
    id: 'round-h-anth',
    name: 'Series H',
    entity_type: 'FundingRound',
    properties: {
      round_label: { value: 'Series H' },
      transaction_value: { value: 30000000000 },
      transaction_value_units: { value: 'USD' },
      event_date: { value: '2026-04-21' }
    },
    relationships: {
      incoming: {
        PARTICIPATES_IN_FUNDING_ROUND: [
          { id: 'co-anthropic', name: 'Anthropic', entity_type: 'Company', properties: { role: 'ISSUER' } },
          {
            id: 'inv-lead-gc',
            name: 'General Catalyst',
            entity_type: 'Organization',
            properties: {
              role: 'LEAD_INVESTOR',
              is_lead: true,
              sources: [{
                name: 'Anthropic Series H announcement',
                source: 'Anthropic Newsroom',
                document: 'https://www.anthropic.com/news/series-h',
                published_time: '2026-04-21'
              }]
            }
          },
          {
            id: 'inv-co-gic',
            name: 'GIC',
            entity_type: 'Organization',
            properties: { role: 'INVESTOR' }
          },
          {
            id: 'focal-sequoia',
            name: 'Sequoia Capital',
            entity_type: 'Organization',
            properties: {
              role: 'INVESTOR',
              sources: [{
                name: 'SEC Form D Series H notice',
                document: 'https://www.sec.gov/Archives/edgar/data/1870000/formd.xml',
                published_time: '2026-04-25'
              }]
            }
          },
          {
            id: 'focal-nvidia',
            name: 'NVIDIA Corporation',
            entity_type: 'Organization',
            properties: { role: 'INVESTOR' }
          }
        ]
      },
      outgoing: {}
    }
  };

  const analysis = runFullAnalysis(
    { mode: 'entity', entities: [nvidia, sequoia], relatedEntities: [elevenLabs, roundHAnthropic] },
    { multiCenter: true }
  );
  const { bridgeMap, sources } = analysis;

  const elevenEdge = bridgeMap.edges.find((e) => e.from === 'org-eleven-labs' || e.to === 'org-eleven-labs');
  assert.ok(elevenEdge, 'Expected verified partnership edge with ELEVEN LABS INC.');
  assert.ok(!elevenEdge.detail.includes('..'), `Expected no double period in edge detail: "${elevenEdge.detail}"`);
  assert.equal(elevenEdge.topSourceRank, 'FILING');
  assert.equal(elevenEdge.sourceCount, 2);
  assert.equal(elevenEdge.evidenceSources[0].sourceRank, 'FILING');
  assert.equal(elevenEdge.evidenceSources[0].publisher, 'SEC EDGAR');
  assert.equal(elevenEdge.evidenceSources[1].sourceRank, 'PRESS');
  assert.ok(elevenEdge.sourceIds.every((id) => Boolean(sources[id])), 'Expected entity-mode analysis.sources to index all edge sourceIds');

  const sequoiaInvestEdge = bridgeMap.edges.find(
    (e) => e.relation === 'INVESTED_IN' && e.from === 'focal-sequoia' && e.to === 'co-anthropic'
  );
  assert.ok(sequoiaInvestEdge, 'Expected Sequoia -> Anthropic expanded INVESTED_IN edge');
  assert.equal(sequoiaInvestEdge.roundType, 'Series H');
  assert.equal(sequoiaInvestEdge.roundAmount, '$30B');
  assert.equal(sequoiaInvestEdge.roundDate, '2026-04-21');
  assert.ok(Array.isArray(sequoiaInvestEdge.syndicatePeers) && sequoiaInvestEdge.syndicatePeers.length >= 2);
  assert.equal(sequoiaInvestEdge.syndicatePeers[0].name, 'General Catalyst');
  assert.equal(sequoiaInvestEdge.syndicatePeers[0].isLead, true);
  assert.equal(sequoiaInvestEdge.syndicatePeers.some((p) => p.name === 'Sequoia Capital'), false);
});

test('short prefix live search merges cached prominent entities above legal-shell noise without raising limit', async () => {
  const baseClient = createLiveSearchClient();
  const cachedAnthropic = {
    id: 'cala-anthropic-test',
    name: 'Anthropic',
    entity_type: 'Company',
    description: 'AI safety and frontier model research company.',
    relationships: {
      outgoing: { HAS_PARTNER: [{ id: 'p-1', name: 'Google' }, { id: 'p-2', name: 'Amazon' }] },
      incoming: { INVESTED_IN: [{ id: 'inv-1', name: 'Sequoia Capital' }, { id: 'inv-2', name: 'Menlo Ventures' }] }
    }
  };
  const calaClient = {
    calls: baseClient.calls,
    getBudgetStatus: baseClient.getBudgetStatus,
    getCachedEntities: () => [cachedAnthropic],
    async calaEntitySearch(query, limit, entityTypes) {
      baseClient.calls.push({ query, limit, entityTypes });
      return {
        data: {
          entities: [
            { id: 'noise-1', name: 'ANTH PAINT LTD', entity_type: 'Organization' },
            { id: 'noise-2', name: 'ANTH Campus LLC', entity_type: 'Organization' },
            { id: 'noise-3', name: 'Anthos Capital Holdings LP', entity_type: 'Company' }
          ]
        }
      };
    },
    calaIntrospect: baseClient.calaIntrospect,
    calaRetrieveEntity: baseClient.calaRetrieveEntity,
    calaKnowledgeSearch: baseClient.calaKnowledgeSearch
  };

  const server = createAppServer({ calaClient });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(`${baseUrl}/api/search?q=Anth&live=1`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    const topNames = (payload.entities || []).map((e) => e.name);
    assert.equal(topNames[0], 'Anthropic', `Expected Anthropic first for prefix "Anth", got: ${topNames.join(', ')}`);
    assert.equal(calaClient.calls[0].limit, 12);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    removeLiveRecords(new Set(['cala-anthropic-test', 'noise-1', 'noise-2', 'noise-3']));
  }
});

test('buildEntityBridgeMap promotes title-only dated Timing events with registered citations', () => {
  const focal = {
    id: 'focal-timing-test',
    name: 'Northstar',
    entity_type: 'Company',
    properties: {},
    relationships: {
      outgoing: {
        PARTICIPATES_IN_FUNDING_ROUND: [
          {
            id: 'round-series-b-test',
            name: 'Funding Round',
            entity_type: 'FundingRound',
            properties: {
              role: 'ISSUER',
              round_label: { value: 'Series B' },
              event_date: '2026-04-12',
              sources: [{
                name: 'Northstar Series B announcement',
                source: 'Northstar IR',
                document: 'https://northstar.example/series-b',
                published_time: '2026-04-12',
                source_rank: 'PRIMARY'
              }]
            }
          },
          {
            id: 'undated-timing-test',
            name: 'Undated milestone',
            entity_type: 'CorporateEvent',
            properties: { sources: [{ name: 'Undated source', document: 'https://northstar.example/undated' }] }
          },
          {
            id: 'uncited-timing-test',
            name: 'Uncited milestone',
            entity_type: 'CorporateEvent',
            properties: { event_date: '2026-04-10' }
          }
        ]
      },
      incoming: {}
    }
  };

  const bridgeMap = buildEntityBridgeMap([focal], [], { multiCenter: true });
  const timingNode = bridgeMap.nodes.find((node) => node.kind === 'event' && node.fullTitle === 'Series B');
  const timingEdge = bridgeMap.edges.find((edge) => edge.isTimingCatalyst && edge.to === timingNode?.id);
  assert.ok(timingNode, 'A dated event with source evidence should become a visible timing node');
  assert.ok(timingEdge, 'The visible timing node should have a map edge');
  assert.ok(timingNode.sourceId);
  assert.deepEqual(timingNode.sourceIds, [timingNode.sourceId]);
  assert.equal(timingNode.evidenceSources[0].title, 'Northstar Series B announcement');
  assert.deepEqual(timingEdge.sourceIds, timingNode.sourceIds);
  assert.deepEqual(timingEdge.evidenceSources, timingNode.evidenceSources);
  assert.ok(!bridgeMap.nodes.some((node) => node.fullTitle === 'Undated milestone'));
  assert.ok(!bridgeMap.nodes.some((node) => node.fullTitle === 'Uncited milestone'));
});

test('buildEntityBridgeMap keeps investor-role FundingRound participation out of investor timingEventsByEntity and suppresses company-to-company IS_MEMBER_OF noise', () => {
  const investor = {
    id: 'inv-focal',
    name: 'Anchor Ventures',
    entity_type: 'Organization',
    properties: {},
    relationships: {
      outgoing: {
        PARTICIPATES_IN_FUNDING_ROUND: [
          {
            id: 'portfolio-round-c',
            name: 'Funding Round',
            entity_type: 'FundingRound',
            properties: {
              role: 'INVESTOR',
              round_label: { value: 'Series C' },
              event_date: '2026-01-15',
              sources: [{ name: 'Portfolio Series C', document: 'https://example.com/c', published_time: '2026-01-15', source_rank: 'PRIMARY' }]
            }
          }
        ]
      },
      incoming: {}
    }
  };
  const companyA = {
    id: 'comp-a',
    name: 'Alpha AI',
    entity_type: 'Company',
    properties: {},
    relationships: {
      outgoing: {
        IS_MEMBER_OF: [
          {
            id: 'comp-b',
            name: 'Beta AI Corp',
            entity_type: 'Company',
            properties: { sources: [{ name: 'Blog post', document: 'https://news.example/post', source_rank: 'PRESS' }] }
          }
        ]
      },
      incoming: {}
    }
  };
  const roundNeighbor = {
    id: 'portfolio-round-c',
    name: 'Funding Round',
    entity_type: 'FundingRound',
    properties: { round_label: { value: 'Series C' }, event_date: '2026-01-15' },
    relationships: {
      incoming: {
        PARTICIPATES_IN_FUNDING_ROUND: [
          { id: 'inv-focal', name: 'Anchor Ventures', entity_type: 'Organization', properties: { role: 'INVESTOR', sources: [{ name: 'Doc', document: 'https://example.com/c' }] } },
          { id: 'comp-a', name: 'Alpha AI', entity_type: 'Company', properties: { role: 'ISSUER', sources: [{ name: 'Doc', document: 'https://example.com/c' }] } }
        ]
      },
      outgoing: {}
    }
  };
  const bridgeMap = buildEntityBridgeMap([investor, companyA], [roundNeighbor], { multiCenter: true });
  assert.equal((bridgeMap.timingEventsByEntity['inv-focal'] || []).length, 0, 'Investor participation in a portfolio round must not become investor timing event');
  assert.ok(!bridgeMap.edges.some((e) => e.relation === 'IS_MEMBER_OF' && e.to === 'comp-b'), 'Unverified company-to-company IS_MEMBER_OF must be quarantined');
  assert.ok(bridgeMap.edges.some((e) => e.relation === 'INVESTED_IN' && e.from === 'inv-focal' && e.to === 'comp-a'), 'Pass 2 should still emit Investor -> Issuer edge');
});
