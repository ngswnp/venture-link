import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LINK_DISTANCE_FACTOR,
  boxOverlapAmount,
  countMapNodeOverlaps,
  createMapPhysics,
  expandMapLayout,
  resolveMapNodeCollisions,
  setMapNodeHome,
  setMapNodeVelocity,
  stepMapPhysics
} from '../public/mapPhysics.js';

function makeLayout() {
  const posMap = new Map([
    ['anchor-a', { x: 400, y: 300, halfW: 42, topPad: 30, bottomPad: 58 }],
    ['bridge', { x: 500, y: 300, halfW: 26, topPad: 22, bottomPad: 38 }],
    ['anchor-b', { x: 600, y: 300, halfW: 42, topPad: 30, bottomPad: 58 }]
  ]);
  const nodeById = new Map([
    ['anchor-a', { id: 'anchor-a', kind: 'anchor' }],
    ['bridge', { id: 'bridge', kind: 'entity' }],
    ['anchor-b', { id: 'anchor-b', kind: 'anchor' }]
  ]);
  return {
    posMap,
    nodeById,
    anchorIds: new Set(['anchor-a', 'anchor-b']),
    displayEdges: [
      { id: 'a-bridge', from: 'anchor-a', to: 'bridge' },
      { id: 'bridge-b', from: 'bridge', to: 'anchor-b' }
    ],
    displayNodes: [...nodeById.values()],
    bounds: { minX: 350, minY: 240, maxX: 650, maxY: 360 }
  };
}

test('expanded layout scales each relationship distance by the requested 1.85 factor', () => {
  const layout = makeLayout();
  const initial = Math.hypot(
    layout.posMap.get('anchor-a').x - layout.posMap.get('bridge').x,
    layout.posMap.get('anchor-a').y - layout.posMap.get('bridge').y
  );
  expandMapLayout(layout, DEFAULT_LINK_DISTANCE_FACTOR);
  const expanded = Math.hypot(
    layout.posMap.get('anchor-a').x - layout.posMap.get('bridge').x,
    layout.posMap.get('anchor-a').y - layout.posMap.get('bridge').y
  );
  assert.ok(Math.abs(expanded / initial - 1.85) < 1e-9);
  assert.ok(layout.bounds.maxX - layout.bounds.minX > 1.8 * 300);
});

test('physics resolves entity overlap while keeping the settled positions deterministic', () => {
  const first = makeLayout();
  const second = makeLayout();
  for (const layout of [first, second]) {
    const physics = createMapPhysics(layout);
    layout.posMap.get('bridge').x = layout.posMap.get('anchor-a').x + 12;
    for (let i = 0; i < 180; i += 1) stepMapPhysics(layout, physics, 1);
    for (let i = 0; i < layout.posMap.size; i += 1) {
      const entries = [...layout.posMap.values()];
      for (let j = i + 1; j < entries.length; j += 1) {
        assert.equal(boxOverlapAmount(entries[i], entries[j]).overlaps, false);
      }
    }
  }
  assert.deepEqual(
    [...first.posMap.entries()].map(([id, pos]) => [id, pos.x, pos.y]),
    [...second.posMap.entries()].map(([id, pos]) => [id, pos.x, pos.y])
  );
});

test('release velocity produces inertia and damps to rest', () => {
  const layout = makeLayout();
  const physics = createMapPhysics(layout);
  const node = physics.nodes.get('bridge');
  const startX = layout.posMap.get('bridge').x;
  setMapNodeVelocity(physics, 'bridge', 12, 0);
  for (let i = 0; i < 3; i += 1) stepMapPhysics(layout, physics, 1);
  assert.ok(layout.posMap.get('bridge').x > startX);
  for (let i = 0; i < 180; i += 1) stepMapPhysics(layout, physics, 1);
  assert.ok(Math.hypot(node.vx, node.vy) < 0.5);
});

test('drag sampling preserves the last velocity sample until pointer release', () => {
  const layout = makeLayout();
  const physics = createMapPhysics(layout);
  const node = physics.nodes.get('bridge');
  const startX = layout.posMap.get('bridge').x;
  physics.draggedNodeId = 'bridge';
  setMapNodeVelocity(physics, 'bridge', 10, 0);
  stepMapPhysics(layout, physics, 1);
  assert.equal(node.vx, 10);
  physics.draggedNodeId = null;
  stepMapPhysics(layout, physics, 1);
  assert.ok(layout.posMap.get('bridge').x > startX);
});

test('a dropped node keeps its new home and updates connected spring lengths', () => {
  const layout = makeLayout();
  const physics = createMapPhysics(layout);
  const bridge = layout.posMap.get('bridge');
  bridge.x = 515;
  physics.draggedNodeId = 'bridge';
  assert.equal(setMapNodeHome(layout, physics, 'bridge'), true);
  physics.draggedNodeId = null;
  for (let i = 0; i < 180; i += 1) stepMapPhysics(layout, physics, 1);
  assert.ok(Math.abs(bridge.x - 515) < 0.5);
});

test('dragging through a node separates both labels in the same interaction frame', () => {
  const posMap = new Map([
    ['dragged', { x: 0, y: 0, halfW: 60, topPad: 30, bottomPad: 60 }],
    ['neighbor-a', { x: 0, y: 0, halfW: 60, topPad: 30, bottomPad: 60 }],
    ['neighbor-b', { x: 0, y: 160, halfW: 60, topPad: 30, bottomPad: 60 }]
  ]);
  const nodeById = new Map([...posMap.keys()].map((id) => [id, { id, kind: 'entity' }]));
  const layout = { posMap, nodeById, displayEdges: [] };
  const physics = createMapPhysics(layout);
  physics.draggedNodeId = 'dragged';
  posMap.get('dragged').x = 0;
  posMap.get('dragged').y = 0;

  resolveMapNodeCollisions(layout, physics);
  assert.equal(countMapNodeOverlaps(layout, physics.collisionGap), 0);
});

test('deterministic collision settling clears a compact cluster of labeled entities', () => {
  const posMap = new Map();
  const nodeById = new Map();
  for (let i = 0; i < 30; i += 1) {
    const id = `entity-${i}`;
    posMap.set(id, {
      x: (i % 6) * 35,
      y: Math.floor(i / 6) * 34,
      halfW: 48,
      topPad: 22,
      bottomPad: 52
    });
    nodeById.set(id, { id, kind: 'entity' });
  }
  const layout = { posMap, nodeById, displayEdges: [] };
  const physics = createMapPhysics(layout);
  for (let pass = 0; countMapNodeOverlaps(layout, physics.collisionGap) > 0 && pass < 8; pass += 1) {
    resolveMapNodeCollisions(layout, physics);
  }
  assert.equal(countMapNodeOverlaps(layout, physics.collisionGap), 0);
});
