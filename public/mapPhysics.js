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

function stableScalar(id) {
  const text = String(id || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
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
  const posEntries = [...(layout?.posMap?.entries?.() || [])];
  const anchorPositions = posEntries
    .filter(([id]) => {
      const node = layout?.nodeById?.get(id);
      return layout?.anchorIds?.has?.(id) || node?.kind === "anchor" || node?.isFocalEntity;
    })
    .map(([, pos]) => pos);
  const centerPool = anchorPositions.length ? anchorPositions : posEntries.map(([, pos]) => pos);
  const centroid = centerPool.length
    ? centerPool.reduce(
        (acc, p) => ({ x: acc.x + p.x / centerPool.length, y: acc.y + p.y / centerPool.length }),
        { x: 0, y: 0 }
      )
    : { x: 0, y: 0 };

  let maxRadius = 120;
  for (const [, pos] of posEntries) {
    maxRadius = Math.max(maxRadius, Math.hypot(pos.x - centroid.x, pos.y - centroid.y));
  }

  const nodeStates = new Map();
  for (const [id, pos] of posEntries) {
    const nodeMeta = layout.nodeById?.get(id);
    const kind = nodeMeta?.kind || "entity";
    const isAnchor = kind === "anchor" || Boolean(nodeMeta?.isFocalEntity) || Boolean(layout?.anchorIds?.has?.(id));
    const isHub = kind === "group_hub";
    const isShared = Boolean(nodeMeta?.isSharedOverlap);
    const radialDist = Math.hypot(pos.x - centroid.x, pos.y - centroid.y);
    const radialRatio = clamp(radialDist / maxRadius, 0, 1);
    const seed = stableScalar(id);

    const mass = isAnchor
      ? 2.3
      : isHub
        ? 0.92
        : isShared
          ? 0.62 + seed * 0.10
          : 0.44 + (1 - radialRatio) * 0.16 + seed * 0.08;

    const homeK = isAnchor
      ? 3.1
      : isHub
        ? 1.15
        : isShared
          ? 0.92 + seed * 0.10
          : 0.68 + (1 - radialRatio) * 0.24 + seed * 0.08;

    const inertiaWeight = isAnchor
      ? 0.36
      : isHub
        ? 0.68
        : isShared
          ? 0.82
          : 0.88 + radialRatio * 0.34 + seed * 0.10;

    nodeStates.set(id, {
      id,
      kind,
      mass,
      homeK,
      inertiaWeight,
      radialRatio,
      degree: 0,
      vx: 0,
      vy: 0,
      tiltDeg: 0,
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
        strength: edge.isOverviewSpoke ? 0.0032 : edge.isSharedBridge ? 0.0028 : 0.0024
      };
    });

  for (const link of links) {
    const fromNode = nodeStates.get(link.from);
    const toNode = nodeStates.get(link.to);
    if (fromNode) fromNode.degree = (fromNode.degree || 0) + 1;
    if (toNode) toNode.degree = (toNode.degree || 0) + 1;
  }

  return {
    nodes: nodeStates,
    links,
    draggedNodeId: null,
    frameCount: 0,
    maxFrames: options.maxFrames ?? 720,
    homeStrength: options.homeStrength ?? 0.0155,
    damping: options.damping ?? 0.87,
    linkDamping: options.linkDamping ?? 0.04,
    maxDisplacement: options.maxDisplacement ?? 122,
    collisionGap: options.collisionGap ?? 12,
    collisionIterations: options.collisionIterations ?? 20,
    maxSpeed: options.maxSpeed ?? 24,
    tiltScale: options.tiltScale ?? 0.20,
    pendingPanX: 0,
    pendingPanY: 0,
    pendingZoom: 1,
    reducedMotion: false,
    camVx: 0,
    camVy: 0,
    edgeBows: new Map(),
    sleepFrames: 0,
    centroidX: centroid.x,
    centroidY: centroid.y,
    maxRadius
  };
}

function inverseMass(physics, id) {
  if (physics.draggedNodeId === id) return 0;
  const mass = physics.nodes.get(id)?.mass || 1;
  return 1 / mass;
}

export function resolveMapNodeCollisions(layout, physics, options = {}) {
  const soft = Boolean(options.soft);
  const maxIter = soft ? Math.min(4, physics.collisionIterations) : physics.collisionIterations;
  const sepFactor = soft ? 0.24 : 1;
  const velKick = soft ? 0.005 : 0.025;
  const entries = [...layout.posMap.entries()];
  let maxPenetration = 0;

  for (let iteration = 0; iteration < maxIter; iteration += 1) {
    let iterMaxPenetration = 0;
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
          const correction = Math.min(180, overlapX + (soft ? 0 : 0.25)) * sepFactor;
          a.x -= sign * correction * (weightA / totalWeight);
          b.x += sign * correction * (weightB / totalWeight);
          physics.nodes.get(idA).vx -= sign * correction * velKick * (weightA / totalWeight);
          physics.nodes.get(idB).vx += sign * correction * velKick * (weightB / totalWeight);
        } else {
          const sign = Math.abs(dy) > 0.25 ? Math.sign(dy) : direction.y >= 0 ? 1 : -1;
          const correction = Math.min(180, overlapY + (soft ? 0 : 0.25)) * sepFactor;
          a.y -= sign * correction * (weightA / totalWeight);
          b.y += sign * correction * (weightB / totalWeight);
          physics.nodes.get(idA).vy -= sign * correction * velKick * (weightA / totalWeight);
          physics.nodes.get(idB).vy += sign * correction * velKick * (weightB / totalWeight);
        }
        const pen = Math.min(overlapX, overlapY);
        iterMaxPenetration = Math.max(iterMaxPenetration, pen);
        maxPenetration = Math.max(maxPenetration, pen);
      }
    }
    if (iterMaxPenetration === 0) break;
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

  // Consume frame-accumulated viewport delta ONCE per RAF step for rock-steady, smooth non-inertial lag & braking.
  const pendX = Number(physics.pendingPanX) || 0;
  const pendY = Number(physics.pendingPanY) || 0;
  const hasInput = Math.hypot(pendX, pendY) > 0.01;
  physics.pendingPanX = 0;
  physics.pendingPanY = 0;

  const zoomScale = Math.pow(clamp(Number(physics.pendingZoom) || 1, 0.25, 1.5), 0.82);
  const rawVx = hasInput ? (pendX / zoomScale) / step : 0;
  const rawVy = hasInput ? (pendY / zoomScale) / step : 0;
  const prevCamVx = Number(physics.camVx) || 0;
  const prevCamVy = Number(physics.camVy) || 0;

  let nextCamVx = hasInput ? prevCamVx * 0.55 + rawVx * 0.45 : prevCamVx * Math.pow(0.76, step);
  let nextCamVy = hasInput ? prevCamVy * 0.55 + rawVy * 0.45 : prevCamVy * Math.pow(0.76, step);
  if (!hasInput && Math.hypot(nextCamVx, nextCamVy) < 0.02) {
    nextCamVx = 0;
    nextCamVy = 0;
  }

  const camAx = (nextCamVx - prevCamVx) / step;
  const camAy = (nextCamVy - prevCamVy) / step;
  physics.camVx = nextCamVx;
  physics.camVy = nextCamVy;

  if (hasInput || Math.hypot(camAx, camAy) > 0.01 || Math.hypot(nextCamVx, nextCamVy) > 0.02) {
    const motionScale = physics.reducedMotion ? 0.22 : 1;
    const rawDriveX = -(camAx * 0.13 + nextCamVx * 0.017) * motionScale;
    const rawDriveY = -(camAy * 0.13 + nextCamVy * 0.017) * motionScale;
    const driveX = Math.tanh(rawDriveX / 4.8) * 4.8;
    const driveY = Math.tanh(rawDriveY / 4.8) * 4.8;
    for (const [id, node] of physics.nodes) {
      if (physics.draggedNodeId === id) continue;
      const ratio = (node.inertiaWeight ?? 1) / Math.max(0.25, node.mass || 1);
      node.vx = clamp(node.vx + driveX * ratio * step, -physics.maxSpeed, physics.maxSpeed);
      node.vy = clamp(node.vy + driveY * ratio * step, -physics.maxSpeed, physics.maxSpeed);
    }
  }

  const forces = new Map([...physics.nodes.keys()].map((id) => [id, { x: 0, y: 0 }]));
  const maxDisp = physics.maxDisplacement ?? 122;
  const softLimit = maxDisp * 0.58;

  for (const [id, node] of physics.nodes) {
    if (physics.draggedNodeId === id) continue;
    const pos = layout.posMap.get(id);
    if (!pos) continue;
    const force = forces.get(id);
    const hdx = node.homeX - pos.x;
    const hdy = node.homeY - pos.y;
    const k = physics.homeStrength * (node.homeK ?? 1);
    force.x += hdx * k;
    force.y += hdy * k;

    const distHome = Math.hypot(hdx, hdy);
    if (distHome > softLimit && distHome > 0.001) {
      const extraMag = (distHome - softLimit) * physics.homeStrength * 2.8;
      force.x += (hdx / distHome) * extraMag;
      force.y += (hdy / distHome) * extraMag;
    }
  }

  for (const link of physics.links) {
    const from = layout.posMap.get(link.from);
    const to = layout.posMap.get(link.to);
    if (!from || !to) continue;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy) || 0.001;
    const ux = dx / dist;
    const uy = dy / dist;
    const error = dist - link.restLength;
    const springF = error * link.strength;
    const vFrom = physics.nodes.get(link.from);
    const vTo = physics.nodes.get(link.to);
    const relVelAlong = ((vTo?.vx || 0) - (vFrom?.vx || 0)) * ux + ((vTo?.vy || 0) - (vFrom?.vy || 0)) * uy;
    const totalF = clamp(springF + relVelAlong * (physics.linkDamping ?? 0.04), -12, 12);
    const fx = ux * totalF;
    const fy = uy * totalF;
    const fromGain = 1 / Math.max(1, vFrom?.degree || 1);
    const toGain = 1 / Math.max(1, vTo?.degree || 1);
    forces.get(link.from).x += fx * fromGain;
    forces.get(link.from).y += fy * fromGain;
    forces.get(link.to).x -= fx * toGain;
    forces.get(link.to).y -= fy * toGain;
  }

  const damping = Math.pow(physics.damping, step);
  const tiltScale = physics.tiltScale ?? 0.20;
  let maxSpeed = 0;
  let maxStepDelta = 0;
  let maxHomeOffset = 0;
  let maxTilt = 0;

  for (const [id, node] of physics.nodes) {
    if (physics.draggedNodeId === id) {
      node.tiltDeg = 0;
      continue;
    }
    const pos = layout.posMap.get(id);
    if (!pos) continue;
    const force = forces.get(id);
    const ax = force.x / node.mass;
    const ay = force.y / node.mass;

    node.vx = clamp((node.vx + ax * step) * damping, -physics.maxSpeed, physics.maxSpeed);
    node.vy = clamp((node.vy + ay * step) * damping, -physics.maxSpeed, physics.maxSpeed);
    const prevX = pos.x;
    const prevY = pos.y;
    pos.x += node.vx * step;
    pos.y += node.vy * step;

    const offX = pos.x - node.homeX;
    const offY = pos.y - node.homeY;
    const offDist = Math.hypot(offX, offY);
    if (offDist > maxDisp && offDist > 0.001) {
      const nx = offX / offDist;
      const ny = offY / offDist;
      pos.x = node.homeX + nx * maxDisp;
      pos.y = node.homeY + ny * maxDisp;
      const outVel = node.vx * nx + node.vy * ny;
      if (outVel > 0) {
        node.vx -= outVel * nx;
        node.vy -= outVel * ny;
      }
    }

    const targetTilt = clamp(-node.vx * tiltScale, -3.2, 3.2);
    node.tiltDeg = (node.tiltDeg || 0) * 0.82 + targetTilt * 0.18;
    if (Math.abs(node.tiltDeg) < 0.04 && Math.abs(targetTilt) < 0.04) node.tiltDeg = 0;

    maxSpeed = Math.max(maxSpeed, Math.hypot(node.vx, node.vy));
    maxStepDelta = Math.max(maxStepDelta, Math.hypot(pos.x - prevX, pos.y - prevY));
    maxHomeOffset = Math.max(maxHomeOffset, Math.hypot(pos.x - node.homeX, pos.y - node.homeY));
    maxTilt = Math.max(maxTilt, Math.abs(node.tiltDeg || 0));
  }

  const maxPenetration = resolveMapNodeCollisions(layout, physics, {
    soft: physics.draggedNodeId === null
  });

  // Update low-pass smoothed curved edge bows
  if (!(physics.edgeBows instanceof Map)) physics.edgeBows = new Map();
  let maxBow = 0;
  for (const edge of layout?.displayEdges || []) {
    const key = edge.id || `${edge.from}->${edge.to}`;
    const targetBow = rawEdgeNormalBow(edge, layout.posMap, physics);
    const prevBow = physics.edgeBows.get(key) || 0;
    let nextBow = prevBow * 0.80 + targetBow * 0.20;
    if (Math.abs(nextBow) < 0.05 && Math.abs(targetBow) < 0.05) {
      physics.edgeBows.delete(key);
      nextBow = 0;
    } else {
      physics.edgeBows.set(key, nextBow);
      maxBow = Math.max(maxBow, Math.abs(nextBow));
    }
  }

  physics.frameCount += step;
  const camSpeed = Math.hypot(physics.camVx || 0, physics.camVy || 0);
  if (
    maxStepDelta < 0.03 &&
    maxSpeed < 0.04 &&
    maxHomeOffset <= 0.18 &&
    maxTilt <= 0.05 &&
    maxBow <= 0.12 &&
    camSpeed <= 0.04 &&
    maxPenetration <= 0.4 &&
    physics.draggedNodeId === null
  ) {
    physics.sleepFrames = (physics.sleepFrames || 0) + 1;
  } else {
    physics.sleepFrames = 0;
  }

  const needsContinue =
    physics.draggedNodeId !== null ||
    maxSpeed > 0.04 ||
    maxHomeOffset > 0.18 ||
    maxTilt > 0.05 ||
    maxBow > 0.12 ||
    camSpeed > 0.04 ||
    maxPenetration > 0.4;

  const stillMoving =
    needsContinue &&
    (physics.sleepFrames || 0) < 8 &&
    physics.frameCount < physics.maxFrames;

  if (!stillMoving) {
    physics.camVx = 0;
    physics.camVy = 0;
    physics.pendingPanX = 0;
    physics.pendingPanY = 0;
    physics.edgeBows.clear();
    for (const node of physics.nodes.values()) {
      if (physics.draggedNodeId !== node.id) {
        node.vx = 0;
        node.vy = 0;
        node.tiltDeg = 0;
      }
    }
  }
  return stillMoving;
}

/** Queue screen-space pan delta to be integrated once cleanly on the next RAF physics step. */
export function applyMapViewportPanImpulse(
  layout,
  physics,
  deltaScreenX,
  deltaScreenY,
  { zoom = 1, reducedMotion = false } = {}
) {
  if (!layout?.posMap?.size || !physics?.nodes?.size) return false;
  const dxScreen = Number(deltaScreenX) || 0;
  const dyScreen = Number(deltaScreenY) || 0;
  if (Math.hypot(dxScreen, dyScreen) < 0.05) return false;

  physics.pendingPanX = (Number(physics.pendingPanX) || 0) + dxScreen;
  physics.pendingPanY = (Number(physics.pendingPanY) || 0) + dyScreen;
  physics.pendingZoom = clamp(Number(zoom) || 1, 0.18, 1.6);
  physics.reducedMotion = Boolean(reducedMotion);
  physics.frameCount = 0;
  physics.sleepFrames = 0;
  return true;
}

/** Apply a gentle radial breathing impulse when zooming the viewport around a pivot point. */
export function applyMapViewportZoomImpulse(
  layout,
  physics,
  pivotWorldX,
  pivotWorldY,
  zoomFactorRatio,
  { reducedMotion = false } = {}
) {
  if (!layout?.posMap?.size || !physics?.nodes?.size) return false;
  const zRatio = Number(zoomFactorRatio) || 0;
  if (Math.abs(zRatio) < 0.002) return false;
  const px = Number(pivotWorldX) ?? physics.centroidX ?? 0;
  const py = Number(pivotWorldY) ?? physics.centroidY ?? 0;
  const motionScale = reducedMotion ? 0.2 : 1;

  for (const [id, node] of physics.nodes) {
    if (physics.draggedNodeId === id) continue;
    const pos = layout.posMap.get(id);
    if (!pos) continue;
    const dx = pos.x - px;
    const dy = pos.y - py;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) continue;
    const ratio = (node.inertiaWeight ?? 1) / Math.max(0.25, node.mass || 1);
    const pulse = clamp(zRatio * (node.radialRatio ?? 0.5) * 9.5 * ratio * motionScale, -6.5, 6.5);
    node.vx = clamp(node.vx + (dx / dist) * pulse, -physics.maxSpeed, physics.maxSpeed);
    node.vy = clamp(node.vy + (dy / dist) * pulse, -physics.maxSpeed, physics.maxSpeed);
  }

  physics.frameCount = 0;
  physics.sleepFrames = 0;
  return true;
}

function rawEdgeNormalBow(edge, posMap, physics) {
  if (!edge || !posMap || !physics?.nodes) return 0;
  const p1 = posMap.get(edge.from);
  const p2 = posMap.get(edge.to);
  if (!p1 || !p2) return 0;
  const v1 = physics.nodes.get(edge.from);
  const v2 = physics.nodes.get(edge.to);
  if (!v1 && !v2) return 0;

  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return 0;
  const nx = -(dy / dist);
  const ny = dx / dist;
  const mvx = ((v1?.vx || 0) + (v2?.vx || 0)) * 0.5;
  const mvy = ((v1?.vy || 0) + (v2?.vy || 0)) * 0.5;
  const normalVel = mvx * nx + mvy * ny;
  if (Math.abs(normalVel) < 0.02) return 0;
  return clamp(normalVel * 2.2, -26, 26);
}

/** Return low-pass smoothed midpoint lateral bow offset for curved SVG edges during motion (0 when stationary). */
export function computeEdgeDynamicBowOffset(edge, posMap, physics) {
  if (!edge || !posMap || !physics?.nodes) return 0;
  const key = edge.id || `${edge.from}->${edge.to}`;
  if (physics.edgeBows instanceof Map && physics.edgeBows.has(key)) {
    return physics.edgeBows.get(key);
  }
  return rawEdgeNormalBow(edge, posMap, physics);
}

/** Step camera pan momentum glide after releasing a mouse/touch pan drag. */
export function stepViewportPanGlide(glide, dt = 1) {
  if (!glide) return { dx: 0, dy: 0, moving: false };
  const step = clamp(Number(dt) || 1, 0.35, 2.2);
  const decay = Math.pow(0.915, step);
  glide.vx = (Number(glide.vx) || 0) * decay;
  glide.vy = (Number(glide.vy) || 0) * decay;
  const dx = glide.vx * step;
  const dy = glide.vy * step;
  const moving = Math.hypot(glide.vx, glide.vy) > 0.18;
  if (!moving) {
    glide.vx = 0;
    glide.vy = 0;
  }
  return { dx, dy, moving };
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
