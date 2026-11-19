import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRegistryClient,
  inferRegistrySector,
  normalizeGleifRecords,
  normalizePrhCompanies,
  normalizeUkCompaniesHouseItems
} from '../src/registryClient.mjs';

function makeTempCacheFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rte-reg-cache-'));
  return path.join(dir, 'registry-cache.json');
}

test('normalizePrhCompanies and inferRegistrySector map PRH v3 records accurately', () => {
  const rawPrh = [
    {
      businessId: { value: '3512345-6', registrationDate: '2025-03-10' },
      euId: { value: 'FI.PRH.3512345-6' },
      names: [
        { name: 'Aurora Grid AI Oy', type: '1', registrationDate: '2025-03-10' }
      ],
      mainBusinessLine: {
        type: '62010',
        descriptions: [
          { languageCode: '1', description: 'Ohjelmistojen suunnittelu ja valmistus' },
          { languageCode: '3', description: 'Computer programming activities' }
        ]
      },
      companyForms: [{ type: 'OY' }],
      addresses: [{ city: 'HELSINKI', postCode: '00100' }],
      tradeRegisterStatus: '2',
      website: { url: 'auroragrid.ai' }
    }
  ];

  const normalized = normalizePrhCompanies(rawPrh);
  assert.equal(normalized.length, 1);
  const comp = normalized[0];
  assert.equal(comp.name, 'Aurora Grid AI Oy');
  assert.equal(comp.country, 'Finland');
  assert.equal(comp.region, 'Nordics');
  assert.equal(comp.hqCity, 'Helsinki');
  assert.equal(comp.entityCategory, 'startup');
  assert.equal(comp.registryInfo.registryName, 'Finnish Trade Register (PRH / YTJ)');
  assert.equal(comp.registryInfo.registrationNumber, '3512345-6');
  assert.equal(comp.registryInfo.industryCode, '62010');
  assert.equal(comp.registryInfo.industryDescription, 'Computer programming activities');
  assert.equal(comp.source.sourceRank, 'FILING');
  assert.equal(comp.website, 'auroragrid.ai');
  assert.equal(inferRegistrySector('62010', 'Autonomous AI battery software', 'Aurora Grid AI Oy'), 'AI & ML');
});

test('normalizeGleifRecords normalizes corporate records and deprioritizes benefit/trust funds', () => {
  const rawGleif = [
    {
      id: 'TRUSTLEI000000000001',
      attributes: {
        lei: 'TRUSTLEI000000000001',
        entity: {
          legalName: { name: "McDonald's Global Profit Sharing Trust" },
          legalAddress: { city: 'Chicago', country: 'US' },
          status: 'ACTIVE',
          category: 'FUND',
          creationDate: '2010-01-01T00:00:00Z'
        }
      }
    },
    {
      id: '549300MCDSCORP123456',
      attributes: {
        lei: '549300MCDSCORP123456',
        entity: {
          legalName: { name: "McDonald's Corporation" },
          legalAddress: { city: 'Chicago', country: 'US' },
          status: 'ACTIVE',
          category: 'GENERAL',
          legalForm: { id: 'X888' },
          creationDate: '1965-03-01T00:00:00Z'
        }
      }
    }
  ];

  const normalized = normalizeGleifRecords(rawGleif);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].name, "McDonald's Corporation");
  assert.equal(normalized[0].entityCategory, 'established_corp');
  assert.equal(normalized[0].country, 'United States');
  assert.equal(normalized[0].registryInfo.registryName, 'Global LEI Registry (GLEIF)');
  assert.equal(normalized[0].source.sourceRank, 'FILING');
});

test('normalizeUkCompaniesHouseItems normalizes UK Companies House items cleanly', () => {
  const items = [
    {
      title: 'VECTOR MESH COMPUTE LTD',
      company_number: '15432198',
      company_status: 'active',
      company_type: 'ltd',
      date_of_creation: '2024-06-15',
      address_snippet: '22 Bishopsgate, London, United Kingdom'
    }
  ];
  const normalized = normalizeUkCompaniesHouseItems(items);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].companiesHouseNumber, '15432198');
  assert.equal(normalized[0].country, 'United Kingdom');
  assert.equal(normalized[0].hqCity, 'London');
  assert.equal(normalized[0].source.sourceRank, 'FILING');
});

test('createRegistryClient fans out to mocked PRH/GLEIF/UK CH and reuses disk cache', async () => {
  const cacheFile = makeTempCacheFile();
  let fetchCount = 0;

  const mockFetch = async (url) => {
    fetchCount += 1;
    const u = String(url);
    if (u.includes('avoindata.prh.fi')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          totalResults: 1,
          companies: [
            {
              businessId: { value: '3499001-2', registrationDate: '2025-02-01' },
              names: [{ name: "McDonald's Suomi Oy", type: '1', registrationDate: '1984-12-01' }],
              mainBusinessLine: {
                type: '56101',
                descriptions: [{ languageCode: '3', description: 'Restaurants' }]
              },
              companyForms: [{ type: 'OY' }],
              addresses: [{ city: 'HELSINKI' }],
              tradeRegisterStatus: '2'
            }
          ]
        })
      };
    }
    if (u.includes('api.gleif.org')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: '549300MCDS1111111111',
              attributes: {
                lei: '549300MCDS1111111111',
                entity: {
                  legalName: { name: "McDonald's Corporation" },
                  legalAddress: { city: 'Chicago', country: 'US' },
                  status: 'ACTIVE',
                  category: 'GENERAL',
                  creationDate: '1965-03-01T00:00:00Z'
                }
              }
            }
          ]
        })
      };
    }
    if (u.includes('company-information.service.gov.uk')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              title: "MCDONALD'S RESTAURANTS LIMITED",
              company_number: '01002769',
              company_status: 'active',
              company_type: 'ltd',
              date_of_creation: '1974-01-01',
              address_snippet: 'East Finchley, London'
            }
          ]
        })
      };
    }
    throw new Error(`Unexpected URL: ${u}`);
  };

  try {
    const client = createRegistryClient({
      cacheFile,
      fetchFn: mockFetch,
      companiesHouseApiKey: 'mock-uk-key'
    });

    const first = await client.discoverFromRegistries({
      queryText: "McDonald's",
      companyQuery: "McDonald's",
      mode: 'query',
      maxResults: 6
    });
    assert.equal(fetchCount, 3);
    assert.equal(first.companies.length, 3);
    assert.equal(first.cacheHits, 0);
    assert.ok(first.sourcesUsed.includes('prh_v3'));
    assert.ok(first.sourcesUsed.includes('gleif'));
    assert.ok(first.sourcesUsed.includes('uk_ch'));

    // Second identical call reads strictly from disk cache (0 external HTTP requests)
    const second = await client.discoverFromRegistries({
      queryText: "McDonald's",
      companyQuery: "McDonald's",
      mode: 'query',
      maxResults: 6
    });
    assert.equal(fetchCount, 3);
    assert.equal(second.companies.length, 3);
    assert.equal(second.cacheHits, 3);
    assert.equal(client.getCachedCompanies().length, 3);
  } finally {
    fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true });
  }
});
