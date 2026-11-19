import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createCalaClient } from '../src/calaClient.mjs';

test('calaClient persists responses to disk cache and enforces strict live budget', async () => {
  const tmpCache = path.join(os.tmpdir(), `cala-test-cache-${Date.now()}.json`);
  let networkCalls = 0;

  const mockFetch = async (url) => {
    networkCalls += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ url, entities: [{ id: 'uuid-1', name: 'Test Entity' }] })
    };
  };

  try {
    const client = createCalaClient({
      cachePath: tmpCache,
      maxLiveCalls: 2,
      apiKey: 'test-key-123',
      fetchFn: mockFetch
    });

    // 1st call hits mock network
    const res1 = await client.calaEntitySearch('Lifeline', 5);
    assert.equal(res1.fromCache, false);
    assert.equal(networkCalls, 1);
    assert.equal(client.getBudgetStatus().liveCallsUsed, 1);

    // Identical repeat call hits persistent cache (0 network calls!)
    const res2 = await client.calaEntitySearch('Lifeline', 5);
    assert.equal(res2.fromCache, true);
    assert.equal(networkCalls, 1);
    assert.equal(client.getBudgetStatus().cacheHits, 1);

    // 2nd distinct call uses remaining budget
    await client.calaIntrospect('uuid-1');
    assert.equal(networkCalls, 2);
    assert.equal(client.getBudgetStatus().liveCallsUsed, 2);

    // 3rd distinct call exceeds maxLiveCalls=2 and throws 429
    await assert.rejects(
      () => client.calaKnowledgeSearch('Expensive call'),
      (err) => err.statusCode === 429 && /budget reached/i.test(err.message)
    );
    assert.equal(networkCalls, 2);

    // New client instance reads from disk cache with 0 network calls
    const client2 = createCalaClient({
      cachePath: tmpCache,
      maxLiveCalls: 2,
      apiKey: 'test-key-123',
      fetchFn: mockFetch
    });
    const res3 = await client2.calaEntitySearch('Lifeline', 5);
    assert.equal(res3.fromCache, true);
    assert.equal(networkCalls, 2);
  } finally {
    if (fs.existsSync(tmpCache)) fs.unlinkSync(tmpCache);
  }
});
