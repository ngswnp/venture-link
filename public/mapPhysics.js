export const DEFAULT_LINK_DISTANCE_FACTOR = 1.85;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function stableDirection(idA, idB) {
  const text = `${idA}|${idB}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const angle = ((hash >>> 0) / 4294967295) * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

export function recomputeMapLayoutBounds(layout, padding = 48) {
  const positions = [...(layout?.posMap?.values?.() || [])];
  if (!positions.length) return layout;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pos of positions) {
    minX = Math.min(minX, pos.x - (pos.halfW || 80));
    minY = Math.min(minY, pos.y - (pos.topPad || 24));
    maxX = Math.max(maxX, pos.x + (pos.halfW || 80));
    maxY = Math.max(maxY, pos.y + (pos.bottomPad || 44));
  }
  layout.bounds = {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding
  };
  return layout;
}

/** Expand the deterministic graph layout around its anchor centroid. */
export function expandMapLayout(layout, factor = DEFAULT_LINK_DISTANCE_FACTOR) {
  if (!layout?.posMap?.size) return layout;
  const safeFactor = clamp(Number(factor) || DEFAULT_LINK_DISTANCE_FACTOR, 1, 2);
  const anchors = [...(layout.anchorIds || [])]
    .map((id) => layout.posMap.get(id))
    .filter(Boolean);
  const center = anchors.length
    ? anchors.reduce((acc, pos) => ({ x: acc.x + pos.x / anchors.length, y: acc.y + pos.y / anchors.length }), { x: 0, y: 0 })
    : {
        x: (layout.bounds.minX + layout.bounds.maxX) / 2,
        y: (layout.bounds.minY + layout.bounds.maxY) / 2
      };

  for (const pos of layout.posMap.values()) {
    pos.x = center.x + (pos.x - center.x) * safeFactor;
    pos.y = center.y + (pos.y - center.y) * safeFactor;
  }
  layout.linkDistanceFactor = safeFactor;
  layout.renderPositions = new Map(
    [...layout.posMap.entries()].map(([id, pos]) => [id, { x: pos.x, y: pos.y }])
  );
  return recomputeMapLayoutBounds(layout);
}

export function createMapPhysics(layout, options = {}) {
  const nodeStates = new Map();
  for (const [id, pos] of layout?.posMap || []) {
    const kind = layout.nodeById?.get(id)?.kind;
    const mass = kind === "anchor" ? 1.8 : kind === "group_hub" ? 1.25 : 1;
    nodeStates.set(id, {
      id,
      mass,
      vx: 0,
      vy: 0,
      homeX: pos.x,
      homeY: pos.y
    });
  }

  const links = (layout?.displayEdges || [])
    .filter((edge) => nodeStates.has(edge.from) && nodeStates.has(edge.to))
    .map((edge) => {
      const from = layout.posMap.get(edge.from);
      const to = layout.posMap.get(edge.to);
      return {
        from: edge.from,
        to: edge.to,
        restLength: Math.max(24, Math.hypot(to.x - from.x, to.y - from.y)),
        strength: edge.isOverviewSpoke ? 0.0038 : edge.isSharedBridge ? 0.003 : 0.0028
      };
    });

  return {
    nodes: nodeStates,
    links,
    draggedNodeId: null,
    frameCount: 0,
    maxFrames: options.maxFrames ?? 720,
    homeStrength: options.homeStrength ?? 0.0012,
    damping: options.damping ?? 0.84,
    collisionGap: options.collisionGap ?? 12,
    collisionIterations: options.collisionIterations ?? 20,
    maxSpeed: options.maxSpeed ?? 30
  };
}

function inverseMass(physics, id) {
  if (physics.draggedNodeId === id) return 0;
  const mass = physics.nodes.get(id)?.mass || 1;
  return 1 / mass;
}

export function resolveMapNodeCollisions(layout, physics) {
  const entries = [...layout.posMap.entries()];
  let maxPenetration = 0;

  for (let iteration = 0; iteration < physics.collisionIterations; iteration += 1) {
    for (let i = 0; i < entries.length; i += 1) {
      const [idA, a] = entries[i];
      for (let j = i + 1; j < entries.length; j += 1) {
        const [idB, b] = entries[j];
        const gap = physics.collisionGap;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const overlapX = (a.halfW || 40) + (b.halfW || 40) + gap - Math.abs(dx);
        const aTop = a.topPad || 20;
        const aBottom = a.bottomPad || 36;
        const bTop = b.topPad || 20;
        const bBottom = b.bottomPad || 36;
        const overlapY = (dy >= 0 ? aBottom + bTop : aTop + bBottom) + gap - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;

        const weightA = inverseMass(physics, idA);
        const weightB = inverseMass(physics, idB);
        const totalWeight = weightA + weightB;
        if (!totalWeight) continue;

        const direction = stableDirection(idA, idB);
        if (overlapX <= overlapY) {
          const sign = Math.abs(dx) > 0.25 ? Math.sign(dx) : direction.x >= 0 ? 1 : -1;
          const correction = Math.min(180, overlapX + 0.25);
          a.x -= sign * correction * (weightA / totalWeight);
          b.x += sign * correction * (weightB / totalWeight);
          physics.nodes.get(idA).vx -= sign * correction * 0.025 * (weightA / totalWeight);
          physics.nodes.get(idB).vx += sign * correction * 0.025 * (weightB / totalWeight);
        } else {
          const sign = Math.abs(dy) > 0.25 ? Math.sign(dy) : direction.y >= 0 ? 1 : -1;
          const correction = Math.min(180, overlapY + 0.25);
          a.y -= sign * correction * (weightA / totalWeight);
          b.y += sign * correction * (weightB / totalWeight);
          physics.nodes.get(idA).vy -= sign * correction * 0.025 * (weightA / totalWeight);
          physics.nodes.get(idB).vy += sign * correction * 0.025 * (weightB / totalWeight);
        }
        maxPenetration = Math.max(maxPenetration, Math.min(overlapX, overlapY));
      }
    }
  }
  return maxPenetration;
}

export function countMapNodeOverlaps(layout, gap = 0) {
  const entries = [...(layout?.posMap?.values?.() || [])];
  let count = 0;
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (boxOverlapAmount(entries[i], entries[j], gap).overlaps) count += 1;
    }
  }
  return count;
}

/** Advance one deterministic, damped spring/collision frame. dt is measured in 60fps frames. */
export function stepMapPhysics(layout, physics, dt = 1) {
  if (!layout?.posMap?.size || !physics?.nodes?.size) return false;
  const step = clamp(Number(dt) || 1, 0.35, 2.2);
  const forces = new Map([...physics.nodes.keys()].map((id) => [id, { x: 0, y: 0 }]));

  for (const [id, node] of physics.nodes) {
    if (physics.draggedNodeId === id) continue;
    const pos = layout.posMap.get(id);
    const force = forces.get(id);
    force.x += (node.homeX - pos.x) * physics.homeStrength;
    force.y += (node.homeY - pos.y) * physics.homeStrength;
  }

  for (const link of physics.links) {
    const from = layout.posMap.get(link.from);
    const to = layout.posMap.get(link.to);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy) || 0.001;
    const error = dist - link.restLength;
    const force = clamp(error * link.strength, -12, 12);
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    forces.get(link.from).x += fx;
    forces.get(link.from).y += fy;
    forces.get(link.to).x -= fx;
    forces.get(link.to).y -= fy;
  }

  const damping = Math.pow(physics.damping, step);
  let maxSpeed = 0;
  for (const [id, node] of physics.nodes) {
    if (physics.draggedNodeId === id) continue;
    const pos = layout.posMap.get(id);
    const force = forces.get(id);
    node.vx = clamp((node.vx + (force.x / node.mass) * step) * damping, -physics.maxSpeed, physics.maxSpeed);
    node.vy = clamp((node.vy + (force.y / node.mass) * step) * damping, -physics.maxSpeed, physics.maxSpeed);
    pos.x += node.vx * step;
    pos.y += node.vy * step;
    maxSpeed = Math.max(maxSpeed, Math.hypot(node.vx, node.vy));
  }

  const maxPenetration = resolveMapNodeCollisions(layout, physics);
  physics.frameCount += step;
  const stillMoving = maxSpeed > 0.16 || maxPenetration > 0.6 || physics.draggedNodeId !== null;
  return stillMoving && physics.frameCount < physics.maxFrames;
}

export function setMapNodeVelocity(physics, id, vx, vy, maxSpeed = 30) {
  const node = physics?.nodes?.get(id);
  if (!node) return false;
  node.vx = clamp(Number(vx) || 0, -maxSpeed, maxSpeed);
  node.vy = clamp(Number(vy) || 0, -maxSpeed, maxSpeed);
  return true;
}

/** Keep a manually placed node at its drop point and retain the new edge lengths. */
export function setMapNodeHome(layout, physics, id) {
  const pos = layout?.posMap?.get(id);
  const node = physics?.nodes?.get(id);
  if (!pos || !node) return false;
  node.homeX = pos.x;
  node.homeY = pos.y;
  for (const link of physics.links) {
    if (link.from !== id && link.to !== id) continue;
    const from = layout.posMap.get(link.from);
    const to = layout.posMap.get(link.to);
    link.restLength = Math.max(24, Math.hypot(to.x - from.x, to.y - from.y));
  }
  return true;
}

export function boxOverlapAmount(a, b, gap = 0) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const overlapX = (a.halfW || 40) + (b.halfW || 40) + gap - Math.abs(dx);
  const overlapY = (dy >= 0
    ? (a.bottomPad || 36) + (b.topPad || 20)
    : (a.topPad || 20) + (b.bottomPad || 36)) + gap - Math.abs(dy);
  return { x: overlapX, y: overlapY, overlaps: overlapX > 0 && overlapY > 0 };
}
