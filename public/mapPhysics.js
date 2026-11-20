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
        ? 1.55
        : isShared
          ? 1.35 + seed * 0.2
          : 0.85 + (1 - radialRatio) * 0.25 + seed * 0.2;

    const homeK = isAnchor
      ? 1.65
      : isHub
        ? 1.25
        : 0.78 + (1 - radialRatio) * 0.35 + seed * 0.15;

    const inertiaWeight = isAnchor
      ? 0.45
      : isHub
        ? 0.78
        : isShared
          ? 0.95
          : 1.05 + radialRatio * 0.45 + seed * 0.15;

    nodeStates.set(id, {
      id,
      kind,
      mass,
      homeK,
      inertiaWeight,
      radialRatio,
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
        strength: edge.isOverviewSpoke ? 0.0085 : edge.isSharedBridge ? 0.0075 : 0.0065
      };
    });

  return {
    nodes: nodeStates,
    links,
    draggedNodeId: null,
    frameCount: 0,
    maxFrames: options.maxFrames ?? 720,
    homeStrength: options.homeStrength ?? 0.028,
    damping: options.damping ?? 0.85,
    linkDamping: options.linkDamping ?? 0.045,
    maxDisplacement: options.maxDisplacement ?? 130,
    collisionGap: options.collisionGap ?? 12,
    collisionIterations: options.collisionIterations ?? 20,
    maxSpeed: options.maxSpeed ?? 34,
    tiltScale: options.tiltScale ?? 0.22,
    camVx: 0,
    camVy: 0,
    viewportInputTtl: 0,
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

export function resolveMapNodeCollisions(layout, physics) {
  const entries = [...layout.posMap.entries()];
  let maxPenetration = 0;

  for (let iteration = 0; iteration < physics.collisionIterations; iteration += 1) {
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

  // When viewport input pauses or releases, inject braking deceleration overshoot in the prior pan direction.
  if (physics.viewportInputTtl > 0) {
    physics.viewportInputTtl = Math.max(0, physics.viewportInputTtl - step);
  } else if (Math.hypot(physics.camVx || 0, physics.camVy || 0) > 0.05) {
    const camDecay = Math.pow(0.68, step);
    const nextCamVx = physics.camVx * camDecay;
    const nextCamVy = physics.camVy * camDecay;
    const dCamVx = nextCamVx - physics.camVx;
    const dCamVy = nextCamVy - physics.camVy;
    physics.camVx = Math.abs(nextCamVx) < 0.05 ? 0 : nextCamVx;
    physics.camVy = Math.abs(nextCamVy) < 0.05 ? 0 : nextCamVy;
    for (const [id, node] of physics.nodes) {
      if (physics.draggedNodeId === id) continue;
      const ratio = (node.inertiaWeight ?? 1) / Math.max(0.25, node.mass || 1);
      node.vx = clamp(node.vx - dCamVx * ratio * 0.42, -physics.maxSpeed, physics.maxSpeed);
      node.vy = clamp(node.vy - dCamVy * ratio * 0.42, -physics.maxSpeed, physics.maxSpeed);
    }
  }

  const forces = new Map([...physics.nodes.keys()].map((id) => [id, { x: 0, y: 0 }]));
  const maxDisp = physics.maxDisplacement ?? 130;
  const softLimit = maxDisp * 0.65;

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
      const extraMag = (distHome - softLimit) * physics.homeStrength * 2.4;
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
    const totalF = clamp(springF + relVelAlong * (physics.linkDamping ?? 0.045), -14, 14);
    const fx = ux * totalF;
    const fy = uy * totalF;
    forces.get(link.from).x += fx;
    forces.get(link.from).y += fy;
    forces.get(link.to).x -= fx;
    forces.get(link.to).y -= fy;
  }

  const damping = Math.pow(physics.damping, step);
  const tiltScale = physics.tiltScale ?? 0.22;
  let maxSpeed = 0;
  let maxStepDelta = 0;
  let maxHomeOffset = 0;
  let maxAccel = 0;

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
    maxAccel = Math.max(maxAccel, Math.hypot(ax, ay));

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
    node.tiltDeg = (node.tiltDeg || 0) * 0.72 + targetTilt * 0.28;
    if (Math.abs(node.tiltDeg) < 0.04 && Math.abs(node.vx) < 0.08) node.tiltDeg = 0;

    maxSpeed = Math.max(maxSpeed, Math.hypot(node.vx, node.vy));
    maxStepDelta = Math.max(maxStepDelta, Math.hypot(pos.x - prevX, pos.y - prevY));
    maxHomeOffset = Math.max(maxHomeOffset, Math.hypot(pos.x - node.homeX, pos.y - node.homeY));
  }

  const maxPenetration = resolveMapNodeCollisions(layout, physics);
  physics.frameCount += step;

  if (maxStepDelta < 0.03 && maxSpeed < 0.06 && maxPenetration <= 0.6 && physics.draggedNodeId === null) {
    physics.sleepFrames = (physics.sleepFrames || 0) + 1;
  } else {
    physics.sleepFrames = 0;
  }

  const hasCamInertia = Math.hypot(physics.camVx || 0, physics.camVy || 0) > 0.08 || physics.viewportInputTtl > 0;
  const springTurning = maxHomeOffset > 0.45 && (maxAccel > 0.02 || maxStepDelta > 0.05);
  const stillMoving =
    (physics.draggedNodeId !== null ||
      maxSpeed > 0.08 ||
      maxPenetration > 0.6 ||
      springTurning ||
      hasCamInertia) &&
    (physics.sleepFrames || 0) < 8 &&
    physics.frameCount < physics.maxFrames;

  if (!stillMoving) {
    physics.camVx = 0;
    physics.camVy = 0;
    physics.viewportInputTtl = 0;
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

/** Inject a non-inertial viewport pan impulse scaled by each entity's mass and differential inertiaWeight. */
export function applyMapViewportPanImpulse(
  layout,
  physics,
  deltaScreenX,
  deltaScreenY,
  { zoom = 1, dt = 1, reducedMotion = false } = {}
) {
  if (!layout?.posMap?.size || !physics?.nodes?.size) return false;
  const dxScreen = Number(deltaScreenX) || 0;
  const dyScreen = Number(deltaScreenY) || 0;
  if (Math.hypot(dxScreen, dyScreen) < 0.05) return false;

  const safeDt = clamp(Number(dt) || 1, 0.4, 3);
  const zoomScale = Math.pow(clamp(Number(zoom) || 1, 0.18, 1.6), 0.72);
  const vxWorld = (dxScreen / zoomScale) / safeDt;
  const vyWorld = (dyScreen / zoomScale) / safeDt;
  const ax = vxWorld - (physics.camVx || 0);
  const ay = vyWorld - (physics.camVy || 0);

  const motionScale = reducedMotion ? 0.25 : 1;
  const driveX = clamp(-(ax * 0.52 + vxWorld * 0.16) * motionScale, -14, 14);
  const driveY = clamp(-(ay * 0.52 + vyWorld * 0.16) * motionScale, -14, 14);

  for (const [id, node] of physics.nodes) {
    if (physics.draggedNodeId === id) continue;
    const ratio = (node.inertiaWeight ?? 1) / Math.max(0.25, node.mass || 1);
    node.vx = clamp(node.vx + driveX * ratio, -physics.maxSpeed, physics.maxSpeed);
    node.vy = clamp(node.vy + driveY * ratio, -physics.maxSpeed, physics.maxSpeed);
  }

  physics.camVx = vxWorld;
  physics.camVy = vyWorld;
  physics.viewportInputTtl = 2.2;
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
    const pulse = clamp(zRatio * (node.radialRatio ?? 0.5) * 14 * ratio * motionScale, -6.5, 6.5);
    node.vx = clamp(node.vx + (dx / dist) * pulse, -physics.maxSpeed, physics.maxSpeed);
    node.vy = clamp(node.vy + (dy / dist) * pulse, -physics.maxSpeed, physics.maxSpeed);
  }

  physics.frameCount = 0;
  physics.sleepFrames = 0;
  return true;
}

/** Return dynamic midpoint lateral bow offset for curved SVG edges during motion (0 when stationary). */
export function computeEdgeDynamicBowOffset(edge, posMap, physics) {
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
  return clamp(normalVel * 2.1, -28, 28);
}

/** Step camera pan momentum glide after releasing a mouse/touch pan drag. */
export function stepViewportPanGlide(glide, dt = 1) {
  if (!glide) return { dx: 0, dy: 0, moving: false };
  const step = clamp(Number(dt) || 1, 0.35, 2.2);
  const decay = Math.pow(0.90, step);
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
