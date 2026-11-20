import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LINK_DISTANCE_FACTOR,
  applyMapViewportPanImpulse,
  applyMapViewportZoomImpulse,
  boxOverlapAmount,
  computeEdgeDynamicBowOffset,
  countMapNodeOverlaps,
  createMapPhysics,
  expandMapLayout,
  resolveMapNodeCollisions,
  setMapNodeHome,
  setMapNodeVelocity,
  stepMapPhysics,
  stepViewportPanGlide
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

function makeRichInertiaLayout() {
  const posMap = new Map([
    ['anchor-main', { x: 500, y: 500, halfW: 54, topPad: 34, bottomPad: 62 }],
    ['sat-outer', { x: 860, y: 500, halfW: 36, topPad: 22, bottomPad: 40 }],
    ['sat-north', { x: 500, y: 180, halfW: 36, topPad: 22, bottomPad: 40 }]
  ]);
  const nodeById = new Map([
    ['anchor-main', { id: 'anchor-main', kind: 'anchor', isFocalEntity: true }],
    ['sat-outer', { id: 'sat-outer', kind: 'entity' }],
    ['sat-north', { id: 'sat-north', kind: 'entity' }]
  ]);
  return {
    posMap,
    nodeById,
    anchorIds: new Set(['anchor-main']),
    displayEdges: [
      { id: 'e-outer', from: 'anchor-main', to: 'sat-outer' },
      { id: 'e-north', from: 'anchor-main', to: 'sat-north' }
    ],
    displayNodes: [...nodeById.values()],
    bounds: { minX: 400, minY: 120, maxX: 920, maxY: 600 }
  };
}

test('applyMapViewportPanImpulse creates opposite lag with differential mass/inertia and settles to rest', () => {
  const layout = makeRichInertiaLayout();
  const physics = createMapPhysics(layout);
  const satStartX = layout.posMap.get('sat-outer').x;
  const anchorStartX = layout.posMap.get('anchor-main').x;

  // Pan viewport right (+36px): non-inertial frame pushes nodes left (-x)
  assert.equal(applyMapViewportPanImpulse(layout, physics, 36, 0, { zoom: 1, dt: 1 }), true);
  stepMapPhysics(layout, physics, 1);

  const satLag = layout.posMap.get('sat-outer').x - satStartX;
  const anchorLag = layout.posMap.get('anchor-main').x - anchorStartX;
  assert.ok(satLag < -1, `Expected outer satellite to trail left during rightward pan (got ${satLag})`);
  assert.ok(anchorLag < 0, `Expected anchor to lag slightly left (got ${anchorLag})`);
  assert.ok(Math.abs(satLag) > Math.abs(anchorLag) * 1.5, 'Light satellite must displace more than heavy anchor');
  assert.notEqual(physics.nodes.get('sat-outer').tiltDeg, 0, 'Moving satellite should subtly tilt');

  // Step until completely settled
  let moving = true;
  for (let i = 0; i < 240 && moving; i += 1) {
    moving = stepMapPhysics(layout, physics, 1);
  }
  assert.equal(moving, false);
  assert.ok(Math.abs(layout.posMap.get('sat-outer').x - satStartX) < 0.25);
  assert.ok(Math.abs(layout.posMap.get('anchor-main').x - anchorStartX) < 0.25);
  assert.equal(physics.nodes.get('sat-outer').tiltDeg, 0);
  assert.equal(countMapNodeOverlaps(layout, physics.collisionGap), 0);
});

test('braking deceleration produces gentle forward overshoot before springing home', () => {
  const layout = makeRichInertiaLayout();
  const physics = createMapPhysics(layout);
  const satStartX = layout.posMap.get('sat-outer').x;

  // Drive sustained rightward viewport pan for 6 frames
  for (let f = 0; f < 6; f += 1) {
    applyMapViewportPanImpulse(layout, physics, 22, 0, { zoom: 1, dt: 1 });
    stepMapPhysics(layout, physics, 1);
  }
  const minXDuringPan = layout.posMap.get('sat-outer').x;
  assert.ok(minXDuringPan < satStartX - 5);

  // Stop panning and track maximum rightward overshoot past homeX
  let maxXAfterStop = minXDuringPan;
  let moving = true;
  for (let f = 0; f < 240 && moving; f += 1) {
    moving = stepMapPhysics(layout, physics, 1);
    maxXAfterStop = Math.max(maxXAfterStop, layout.posMap.get('sat-outer').x);
  }
  assert.ok(maxXAfterStop > satStartX + 1.5, `Expected velvety braking overshoot past home (maxX=${maxXAfterStop}, home=${satStartX})`);
  assert.ok(Math.abs(layout.posMap.get('sat-outer').x - satStartX) < 0.25);
});

test('applyMapViewportZoomImpulse breathes radially outward on zoom-in and inward on zoom-out', () => {
  const layout = makeRichInertiaLayout();
  const physics = createMapPhysics(layout);
  const satStartX = layout.posMap.get('sat-outer').x;

  assert.equal(applyMapViewportZoomImpulse(layout, physics, 500, 500, 0.2), true);
  stepMapPhysics(layout, physics, 1);
  assert.ok(layout.posMap.get('sat-outer').x > satStartX, 'Zoom in should breathe outer satellite radially outward');

  for (let i = 0; i < 180; i += 1) stepMapPhysics(layout, physics, 1);
  assert.ok(Math.abs(layout.posMap.get('sat-outer').x - satStartX) < 0.25);

  assert.equal(applyMapViewportZoomImpulse(layout, physics, 500, 500, -0.2), true);
  stepMapPhysics(layout, physics, 1);
  assert.ok(layout.posMap.get('sat-outer').x < satStartX, 'Zoom out should gently contract satellite inward');
});

test('computeEdgeDynamicBowOffset bends curved edges during lateral motion and returns 0 at rest', () => {
  const layout = makeRichInertiaLayout();
  const physics = createMapPhysics(layout);
  const northEdge = layout.displayEdges[1]; // vertical from (500,500) -> (500,180), normal points right (+x) or left (-x)
  assert.equal(computeEdgeDynamicBowOffset(northEdge, layout.posMap, physics), 0);

  setMapNodeVelocity(physics, 'sat-north', 12, 0);
  const bowRight = computeEdgeDynamicBowOffset(northEdge, layout.posMap, physics);
  setMapNodeVelocity(physics, 'sat-north', -12, 0);
  const bowLeft = computeEdgeDynamicBowOffset(northEdge, layout.posMap, physics);
  assert.notEqual(bowRight, 0);
  assert.equal(Math.sign(bowRight), -Math.sign(bowLeft));
});

test('stepViewportPanGlide damps flick momentum cleanly to rest', () => {
  const glide = { vx: 16, vy: -8 };
  const first = stepViewportPanGlide(glide, 1);
  assert.equal(first.moving, true);
  assert.ok(first.dx > 10 && first.dy < -5);

  let state = first;
  for (let i = 0; i < 80 && state.moving; i += 1) {
    state = stepViewportPanGlide(glide, 1);
  }
  assert.equal(state.moving, false);
  assert.equal(glide.vx, 0);
  assert.equal(glide.vy, 0);
});
