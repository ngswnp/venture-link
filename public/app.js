/**
 * Revealed Thesis - Cala Entity & Bridge Map
 * Zero-crossing 360 Polar Contribution Tree + Free Multi-Entity Explorer Constellation
 * + 6-Tab Verified Cala Entity Dossier (zero synthetic VC shortlist flows)
 */

import {
  DEFAULT_LINK_DISTANCE_FACTOR,
  countMapNodeOverlaps,
  createMapPhysics,
  expandMapLayout,
  recomputeMapLayoutBounds,
  resolveMapNodeCollisions,
  setMapNodeHome,
  setMapNodeVelocity,
  stepMapPhysics
} from "./mapPhysics.js";

const THEME_STORAGE_KEY = "rte_theme_v2";
const MAP_STATE_STORAGE_KEY = "rte_entity_map_v2";
const PERSPECTIVE_STORAGE_KEY = "rte_perspective_v1";
const MISSING = "Not found in Cala";

const STRUCTURAL_ROLE_META = {
  governance: {
    role: "governance",
    label: "Governance & Leadership",
    shortLabel: "Governance",
    groupFallback: "lineage"
  },
  capital: {
    role: "capital",
    label: "Capital & Ownership",
    shortLabel: "Capital",
    groupFallback: "access"
  },
  commercial: {
    role: "commercial",
    label: "Commercial Value Chain",
    shortLabel: "Commercial",
    groupFallback: "access"
  },
  strategic_event: {
    role: "strategic_event",
    label: "M&A, Rivals & Catalysts",
    shortLabel: "Rivals & Catalysts",
    groupFallback: "timing"
  }
};
const STRUCTURAL_SECTOR_ORDER = ["governance", "capital", "commercial", "strategic_event"];

const CONSTELLATION_W = 1960;
const CONSTELLATION_H = 1400;
const CONSTELLATION_CX = 980;
const CONSTELLATION_CY = 700;

const OVERVIEW_ENTITY_CAP = 12;

const ANCHOR_PALETTE = [
  { hex: "#FF6B5B", glow: "rgba(255, 107, 91, 0.48)", edge: "#B83B2E" },
  { hex: "#94B4D8", glow: "rgba(148, 180, 216, 0.44)", edge: "#1F365D" },
  { hex: "#F2B880", glow: "rgba(242, 184, 128, 0.44)", edge: "#9C5221" },
  { hex: "#F4EDE0", glow: "rgba(244, 237, 224, 0.42)", edge: "#35496E" },
  { hex: "#FF8E82", glow: "rgba(255, 142, 130, 0.44)", edge: "#9E352B" },
  { hex: "#C5D5EA", glow: "rgba(197, 213, 234, 0.44)", edge: "#28416B" }
];

const ORBIT_QUADRANTS = [
  { key: "access", group: "access", label: "ACCESS", minDeg: 195, maxDeg: 255, colorFamily: "feeder" },
  { key: "lineage", group: "lineage", label: "LINEAGE", minDeg: 285, maxDeg: 345, colorFamily: "alumni_spinout" },
  { key: "timing", group: "timing", label: "TIMING", minDeg: 15, maxDeg: 75, colorFamily: "event" },
  { key: "caution", group: "caution", label: "CAUTION", minDeg: 105, maxDeg: 165, colorFamily: "portfolio_twin" }
];

const CONTRIBUTION_VISUAL_META = {
  access: {
    group: "access",
    label: "Warm Access",
    headerLabel: "ACCESS",
    shortLabel: "Access",
    subtitle: "Investors, syndicates & partner access",
    darkColor: "#F4EDE0",
    lightColor: "#14213D",
    darkGlow: "rgba(244, 237, 224, 0.42)",
    darkEdge: "#D5C7B0"
  },
  lineage: {
    group: "lineage",
    label: "Team Lineage",
    headerLabel: "LINEAGE",
    shortLabel: "Lineage",
    subtitle: "Founders, leadership & org alumni",
    darkColor: "#94B4D8",
    lightColor: "#2B4C7E",
    darkGlow: "rgba(148, 180, 216, 0.46)",
    darkEdge: "#4A6FA5"
  },
  timing: {
    group: "timing",
    label: "Why Now",
    headerLabel: "TIMING",
    shortLabel: "Timing",
    subtitle: "Funding rounds, filings & dated events",
    darkColor: "#F2B880",
    lightColor: "#C86D2D",
    darkGlow: "rgba(242, 184, 128, 0.46)",
    darkEdge: "#C87D42"
  },
  caution: {
    group: "caution",
    label: "Caution & Gaps",
    headerLabel: "CAUTION",
    shortLabel: "Caution",
    subtitle: "Acquisitions, competitors & proof gaps",
    darkColor: "#FF6B5B",
    lightColor: "#D94838",
    darkGlow: "rgba(255, 107, 91, 0.52)",
    darkEdge: "#C94638"
  }
};

const state = {
  bootstrap: null,
  calaBudget: null,
  workspaceMode: "hero", // "hero" | "map"
  pinnedEntities: [], // up to 20 focal entity refs
  perspectiveEntity: null, // optional clearable My Firm / Buyer seat (default strictly Neutral = null)
  primaryTargetId: null, // optional focal entity focus in ecosystem_compare mode
  perspectivePopoverOpen: false,
  perspectiveSearchTimer: null,
  perspectiveSeq: 0,
  perspectiveResults: [],
  drafts: [],
  resolvingDrafts: new Map(),
  bridgeMap: null,
  analysis: null,
  entityProfile: null,
  entityProfiles: {},
  focalEntities: [],
  comparedEntities: [],
  hideMegaHubs: true,
  contributionGroup: "all", // "all" | "access" | "lineage" | "timing" | "caution"
  sharedOnly: false,
  filingOnly: false,
  expandedGroupKey: null, // null | "access" | "lineage" | "timing" | "caution"
  selectedNodeId: null,
  selectedEdgeId: null,
  hoveredNodeId: null,
  hoveredEdgeId: null,
  mapZoom: 0.85,
  mapPanX: 0,
  mapPanY: 0,
  mapLayoutNodes: null,
  mapPhysics: null,
  mapPhysicsRafId: null,
  mapPhysicsLastFrame: 0,
  mapNodeDrag: null,
  mapNodeClickSuppressUntil: 0,
  pointerPan: null,
  compareBoxOpen: false,
  legendPopoverOpen: false,
  decisionSummaryOpen: false,
  decisionSelectedFactor: "access",
  decisionAnalysisStarted: false,
  decisionDetailView: false,
  decisionPanelExpanded: false,
  decisionAnalysisStatus: "idle",
  decisionAnalysisResult: null,
  decisionAnalysisError: "",
  decisionAnalysisKey: null,
  decisionAnalysisPendingKey: null,
  decisionAnalysisRequestId: 0,
  decisionOpenDrawers: { reasoning: false, connections: false, sources: false },
  decisionExpandedOpenDrawers: { icThesis: false, reasoning: false, sourcesList: false, hygiene: false },
  filtersPanelOpen: false,
  suggestItems: [],
  suggestTimer: null,
  suggestSeq: 0,
  searchSubmitSeq: 0,
  compareSuggestItems: [],
  compareSearchTimer: null,
  compareSeq: 0,
  dossier: null,
  dossierCache: new Map(),
  aiInsightCache: new Map(),
  toastTimer: null,
  analysisLoading: false
};

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  }[ch]));
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s*\u2014\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

function asList(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function normalizedName(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function idOf(item = {}) {
  return cleanText(item.id || item.entityId || item.entity_id || item.calaEntityId || item.cala_entity_id);
}

function nameOf(item = {}) {
  return cleanText(item.name || item.label || item.entityName || item.entity_name || "Unnamed entity");
}

function typeOf(item = {}) {
  return cleanText(item.entityType || item.entity_type || item.type || item.kind || "Entity").replace(/_/g, " ");
}

function typeBadge(item = {}) {
  const t = typeOf(item).toLowerCase();
  const cat = cleanText(item.entityCategory || item.entity_category || item.category).toLowerCase();
  if (t.includes("round") || t.includes("finan")) return "Round";
  if (t.includes("event")) return "Event";
  if (t.includes("person") || t.includes("founder") || t.includes("exec")) return "Person";
  if (cat.includes("fund") || t.includes("fund")) return "Fund";
  if (cat.includes("invest") || t.includes("invest") || t.includes("venture")) return "Investor";
  if (t.includes("organization")) return "Organization";
  if (t.includes("startup")) return "Startup";
  if (t.includes("company")) return "Company";
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}` : "Entity";
}

function populatedValue(v) {
  const t = cleanText(v);
  if (!t) return "";
  if (/^(not found in cala|unknown|n\/a|none)$/i.test(t) || /^not indexed in cala/i.test(t)) return "";
  return t;
}

function metaOf(item = {}) {
  const parts = [
    item.hqCity || item.headquarters || item.country,
    item.sector || item.category || item.entityCategory,
    item.description
  ]
    .map(populatedValue)
    .filter(Boolean);
  return parts.slice(0, 2).join(" · ") || typeBadge(item);
}

function toEntityRef(item = {}) {
  const id = idOf(item);
  return {
    key: id || normalizedName(nameOf(item)),
    type: typeOf(item),
    id,
    calaId: cleanText(item.calaId || item.calaEntityId || id),
    name: nameOf(item),
    entityType: typeOf(item),
    entityCategory: item.entityCategory || null,
    sector: item.sector || null,
    country: item.country || null,
    hqCity: item.hqCity || null,
    description: item.description || null
  };
}

function formatReadableEntityLabel(rawLabel, date = null) {
  let text = cleanText(rawLabel || "Entity");
  if (!text) return "Entity";
  if (/^[A-Z0-9_]{8,}$/.test(text) && text.includes("_")) {
    const words = text
      .toLowerCase()
      .split("_")
      .filter(Boolean)
      .map((w) => (w === "or" ? "/" : `${w.charAt(0).toUpperCase()}${w.slice(1)}`));
    const yr = date && String(date).length >= 4 ? ` (${String(date).slice(0, 4)})` : "";
    return `${words.slice(0, 3).join(" ")}${yr}`;
  }
  return text;
}

function formatCompactEntityName(rawLabel, maxWords = 2, maxChars = 18) {
  let text = formatReadableEntityLabel(rawLabel)
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "Entity";
  const words = text.split(/\s+/);
  if (words.length > maxWords || text.length > maxChars) {
    const stripped = text
      .replace(/\b(?:Oy|Oyj|AB|Ltd\.?|Limited|Inc\.?|Incorporated|Corporation|Corp\.?|GmbH|AG|S\.L\.|SL|SAS|B\.V\.|BV|AS|ApS|LTDA|PTE\.?|PLC)\b\.?/gi, "")
      .replace(/[,]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (stripped) text = stripped;
  }
  const cleanWords = text.split(/\s+/).slice(0, maxWords);
  let out = "";
  for (const w of cleanWords) {
    const cand = out ? `${out} ${w}` : w;
    if (cand.length <= maxChars || !out) {
      out = cand;
    } else {
      break;
    }
  }
  if (out.length > maxChars + 2) {
    out = `${out.slice(0, maxChars).trim()}.`;
  }
  out = out.replace(/[\s,\/&-]+$/g, "").trim();
  return out || words[0] || "Entity";
}

// ---------- Theme, Status & Toast ----------

function getActiveTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch (_) {}
  const btn = $("#themeToggleBtn");
  if (btn) {
    const lbl = btn.querySelector(".theme-toggle-label");
    if (lbl) lbl.textContent = next === "light" ? "Dark" : "Light";
    btn.setAttribute("aria-pressed", String(next === "light"));
  }
  if (state.bridgeMap) {
    renderConstellationMap(undefined, { fit: false });
  }
}

function setStatus(message, isError = false) {
  const el = $("#mapStatus");
  if (el) {
    el.textContent = cleanText(message);
    el.classList.toggle("is-error", Boolean(isError));
  }
}

function showToast(message, isError = false) {
  const el = $("#uiToastBanner");
  if (!el) return;
  el.textContent = cleanText(message);
  el.classList.toggle("is-error", Boolean(isError));
  el.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

function updateLiveStatusPill(loadingMessage = null) {
  const pill = $("#mapLiveStatusPill");
  if (!pill) return;
  if (loadingMessage) {
    pill.innerHTML = `<span class="live-loading-pulse" aria-hidden="true"></span><span>${escapeHtml(cleanText(loadingMessage))}</span>`;
    pill.hidden = false;
  } else {
    pill.hidden = true;
    pill.innerHTML = "";
  }
}

function updateTelemetryPill(budget = null) {
  const b = budget || state.calaBudget;
  const el = $("#telemetryLine");
  if (!el) return;
  if (!b || typeof b.maxLiveCalls !== "number") {
    el.innerHTML = `<span class="dot"></span>Cala ready`;
    return;
  }
  const remaining = Math.max(0, b.maxLiveCalls - (b.liveCallsUsed || 0));
  el.innerHTML = `<span class="dot"></span>${remaining}/${b.maxLiveCalls} Cala`;
}

// ---------- API Helpers ----------

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  let body = {};
  try {
    body = await response.json();
  } catch (_) {}
  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}

function normalizeSearchResults(payload, queryText = "") {
  const rows = [
    ...asList(payload?.entities),
    ...asList(payload?.liveEntities),
    ...asList(payload?.companies),
    ...asList(payload?.organizations),
    ...asList(payload?.people),
    ...asList(payload?.funds),
    ...asList(payload?.results),
    ...asList(payload?.matches)
  ];
  const unique = new Map();
  let idx = 0;
  for (const row of rows) {
    const id = idOf(row);
    const name = nameOf(row);
    if (!id || !name || unique.has(id)) continue;
    unique.set(id, {
      ...row,
      id,
      calaId: cleanText(row.calaEntityId || row.calaId || id),
      name,
      entityType: typeOf(row),
      _orderIdx: idx++
    });
  }
  const needle = normalizedName(queryText);
  if (needle.length >= 2) {
    const rankMatch = (item) => {
      const n = normalizedName(item.name);
      let s = 0;
      if (n === needle) s += 80;
      else if (n.startsWith(`${needle} `)) s += 55;
      else if (n.startsWith(needle)) s += 42;
      else if (n.split(/\s+/).some((w) => w.startsWith(needle))) s += 20;
      if (n !== needle && /\b(llc|ltd|inc|gmbh|corp|lp|llp|plc)\b/i.test(item.name || "")) s -= 8;
      if (cleanText(item.description || item.summary)) s += 4;
      return s;
    };
    return [...unique.values()]
      .sort((a, b) => rankMatch(b) - rankMatch(a) || a._orderIdx - b._orderIdx)
      .slice(0, 10);
  }
  return [...unique.values()].slice(0, 10);
}

async function searchCalaEntities(query) {
  const q = cleanText(query);
  if (q.length < 2) return [];
  const payload = await fetchJson(`/api/search?q=${encodeURIComponent(q)}&live=1`);
  return normalizeSearchResults(payload, q);
}

async function refreshCalaBudget() {
  try {
    const b = await fetchJson("/api/cala-budget");
    state.calaBudget = b;
    updateTelemetryPill(b);
  } catch (_) {}
}

// ---------- Workspace Persistence ----------

function savePinnedEntitiesToStorage() {
  try {
    const minimal = state.pinnedEntities.map((p) => ({
      id: p.id,
      calaId: p.calaId || p.id,
      type: p.type || p.entityType || "Entity",
      name: p.name,
      entityType: p.entityType || p.type || "Entity"
    }));
    localStorage.setItem(MAP_STATE_STORAGE_KEY, JSON.stringify(minimal));
  } catch (_) {}
}

function loadPinnedEntitiesFromStorage() {
  try {
    const raw = localStorage.getItem(MAP_STATE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p) => p && (p.id || p.name))
      .slice(0, 20)
      .map((p) => toEntityRef(p));
  } catch {
    return [];
  }
}

function savePerspectiveToStorage() {
  try {
    if (!state.perspectiveEntity?.id && !state.perspectiveEntity?.name) {
      localStorage.removeItem(PERSPECTIVE_STORAGE_KEY);
      return;
    }
    const p = state.perspectiveEntity;
    localStorage.setItem(PERSPECTIVE_STORAGE_KEY, JSON.stringify({
      id: p.id,
      calaId: p.calaId || p.id,
      type: p.type || p.entityType || "Organization",
      name: p.name,
      entityType: p.entityType || p.type || "Organization"
    }));
  } catch (_) {}
}

function loadPerspectiveFromStorage() {
  try {
    const raw = localStorage.getItem(PERSPECTIVE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || (!parsed.id && !parsed.name)) return null;
    return toEntityRef(parsed);
  } catch {
    return null;
  }
}

function getActiveAnalysisMode(bridgeMap = state.bridgeMap) {
  const explicit = bridgeMap?.analysisMode;
  if (explicit === "single_teardown" || explicit === "perspective_triage" || explicit === "ecosystem_compare") {
    return explicit;
  }
  if (state.perspectiveEntity?.id || bridgeMap?.perspectiveEntity?.id) {
    return "perspective_triage";
  }
  const focalCount = asList(bridgeMap?.focalEntityIds).length || state.pinnedEntities.length;
  return focalCount <= 1 ? "single_teardown" : "ecosystem_compare";
}

function deriveStructuralRoleFrontend(item = {}) {
  if (item.structuralRole && STRUCTURAL_ROLE_META[item.structuralRole]) {
    return item.structuralRole;
  }
  const rel = String(item.relation || item.relationType || "").toUpperCase();
  if (["INVESTED_IN", "CO_INVESTED_WITH", "PARTICIPATES_IN_FUNDING_ROUND", "HAS_FUNDING_ROUND"].includes(rel)) {
    return "capital";
  }
  if (["PARTNERED_WITH", "SUPPLIES", "SUPPLIED_BY", "ADVISED"].includes(rel)) {
    return "commercial";
  }
  if (
    rel === "ACQUIRED" ||
    rel.startsWith("IS_") ||
    rel.includes("FOUNDED") ||
    rel === "WORKS_AT" ||
    rel === "SPUN_OUT_OF"
  ) {
    return "governance";
  }
  const fam = String(item.bridgeFamily || "").toLowerCase();
  const group = String(item.contributionGroup || item.group || "").toLowerCase();
  if (fam === "alumni_spinout" || group === "lineage") return "governance";
  if (group === "access" || fam === "co_investor") return "capital";
  return "strategic_event";
}

function classifyTimingRecencyFrontend(item = {}, referenceDate = null) {
  if (item.timingRecency === "active_catalyst" || item.isRecentCatalyst === true) {
    return { timingRecency: "active_catalyst", isRecentCatalyst: true, isHistoricalMilestone: false };
  }
  if (item.timingRecency === "historical_milestone" || item.isHistoricalMilestone === true) {
    return { timingRecency: "historical_milestone", isRecentCatalyst: false, isHistoricalMilestone: true };
  }
  const raw = String(item.date || item.roundDate || "").trim();
  if (!raw) return { timingRecency: "undated", isRecentCatalyst: false, isHistoricalMilestone: false };
  let norm = raw.slice(0, 10);
  if (/^\d{4}$/.test(raw)) norm = `${raw}-06-15`;
  else if (/^\d{4}-\d{2}$/.test(raw)) norm = `${raw}-15`;
  const evtMs = Date.parse(norm);
  if (!Number.isFinite(evtMs)) return { timingRecency: "undated", isRecentCatalyst: false, isHistoricalMilestone: false };
  const refMs = Date.parse(referenceDate || state.bridgeMap?.referenceDate || new Date().toISOString().slice(0, 10));
  const baseMs = Number.isFinite(refMs) ? refMs : Date.now();
  const monthsAgo = (baseMs - evtMs) / (1000 * 60 * 60 * 24 * 30.4375);
  if (monthsAgo <= 18 && monthsAgo >= -12) {
    return { timingRecency: "active_catalyst", isRecentCatalyst: true, isHistoricalMilestone: false };
  }
  if (monthsAgo > 18) {
    return { timingRecency: "historical_milestone", isRecentCatalyst: false, isHistoricalMilestone: true };
  }
  return { timingRecency: "undated", isRecentCatalyst: false, isHistoricalMilestone: false };
}

function getSharedImpactBadge(node, incidentEdges = []) {
  const mode = getActiveAnalysisMode();
  const rels = asList(incidentEdges);
  if (mode === "perspective_triage" || node?.isPerspectiveBridge || rels.some((e) => e.touchesPerspective || e.isPerspectiveBridge)) {
    return "↔ Warm Intro";
  }
  if (rels.some((e) => e.relation === "COMPETES_WITH" || e.relation === "SECTOR_COMPETITION" || deriveContributionGroupFrontend(e) === "caution")) {
    return "↔ Direct Rivalry";
  }
  if (rels.some((e) => deriveStructuralRoleFrontend(e) === "commercial")) {
    return "↔ Shared Bottleneck";
  }
  if (String(node?.entityType || "").toLowerCase() === "person" || rels.some((e) => deriveStructuralRoleFrontend(e) === "governance")) {
    return "↔ Shared Talent";
  }
  if (rels.some((e) => deriveStructuralRoleFrontend(e) === "capital")) {
    return "↔ Shared Backer";
  }
  return "↔ Shared";
}

function setWorkspaceMode(mode) {
  const isMap = mode === "map";
  state.workspaceMode = isMap ? "map" : "hero";
  document.body.classList.toggle("is-map-workspace", isMap);
  document.body.classList.toggle("is-search-hero", !isMap);
  const stage = $("#constellationStage");
  if (stage) {
    stage.hidden = !isMap;
  }
  if (!isMap) {
    state.filtersPanelOpen = false;
    const ribbon = $("#constellationFilterRibbon");
    if (ribbon) ribbon.hidden = true;
    const toggleBtn = $("#toggleFiltersBtn");
    if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
    hideMapTooltip();
  }
}

// ---------- Tier, Contribution Group & Provenance Helpers ----------

function tierOf(record = {}) {
  const direct =
    record?.topSourceRank ||
    record?.sourceTier ||
    record?.source_tier ||
    record?.sourceRank ||
    record?.source_rank ||
    record?.tier ||
    record?.rank;
  const tiers = [
    direct,
    ...asList(record?.sources).map((s) => s?.sourceRank || s?.source_rank || s?.sourceTier || s?.source_tier || s?.tier || s?.rank)
  ]
    .map((t) => cleanText(t).toUpperCase())
    .filter(Boolean);
  if (tiers.includes("FILING")) return "FILING";
  if (tiers.includes("PRIMARY")) return "PRIMARY";
  if (tiers.includes("PRESS")) return "PRESS";
  if (tiers.includes("AGGREGATOR")) return "AGGREGATOR";
  return MISSING;
}

function strongestTier(records = []) {
  const list = records.map((r) => tierOf(r));
  if (list.includes("FILING")) return "FILING";
  if (list.includes("PRIMARY")) return "PRIMARY";
  if (list.includes("PRESS")) return "PRESS";
  if (list.includes("AGGREGATOR")) return "AGGREGATOR";
  return MISSING;
}

function deriveContributionGroupFrontend(item) {
  if (!item) return "access";
  const relUpper = String(item.relation || item.relationType || "").toUpperCase();
  if (item.isAcquisition || relUpper === "ACQUIRED") return "lineage";
  const explicit = String(item.contributionGroup || item.group || "").toLowerCase();
  if (explicit === "access" || explicit === "lineage" || explicit === "timing" || explicit === "caution") {
    return explicit;
  }
  const fam = String(item.bridgeFamily || "").toLowerCase();
  const bType = String(item.bridgeType || item.relationType || item.entityType || "").toLowerCase();
  const labelLower = String(item.label || item.name || item.detail || "").toLowerCase();
  if (fam === "co_investor" || bType.includes("invest") || bType.includes("fund") || bType.includes("board")) {
    return "access";
  }
  if (fam === "alumni_spinout" || bType.includes("person") || bType.includes("founder") || bType.includes("ceo") || bType.includes("employ") || bType.includes("acquir")) {
    return "lineage";
  }
  if (bType.includes("caution") || bType.includes("compet") || labelLower.includes("conflict") || labelLower.includes("compet")) {
    return "caution";
  }
  if (fam === "event" || bType.includes("event") || bType.includes("round") || bType.includes("metric") || bType.includes("finan")) {
    return "timing";
  }
  return "access";
}

function getNodeContributionGroup(node) {
  return deriveContributionGroupFrontend(node);
}

function getContributionColorHex(group) {
  const meta = CONTRIBUTION_VISUAL_META[group] || CONTRIBUTION_VISUAL_META.access;
  return getActiveTheme() === "light" ? meta.lightColor : meta.darkColor;
}

function getContributionGlowRgba(group) {
  const meta = CONTRIBUTION_VISUAL_META[group] || CONTRIBUTION_VISUAL_META.access;
  return meta.darkGlow || "rgba(56, 189, 248, 0.44)";
}

// ---------- Contribution Weights & Polar Sector Geometry ----------

function computeContributionWeightsFrontend(bridgeMap, explicitNodes = null, explicitEdges = null) {
  const fromPayload = Array.isArray(bridgeMap?.contributionClusters) ? bridgeMap.contributionClusters : [];
  const groups = ["access", "lineage", "timing", "caution"];
  const sigFormula = "topSignalRarity + mean(top3Paths) + min(4.5, FILING_count * 1.5)";

  if (fromPayload.length >= 4 && !explicitNodes && !explicitEdges) {
    const out = {};
    for (const c of fromPayload) {
      const g = String(c.group || c.contributionGroup || "").toLowerCase();
      if (!groups.includes(g)) continue;
      const topR = Number(c.topRarity || 0);
      const top3M = Number(c.top3MeanRarity || 0);
      const fCount = Number(c.filingCount ?? c.filingVerifiedCount ?? 0);
      const fBonus = Number(c.filingBonus ?? Math.min(4.5, fCount * 1.5));
      const sCount = Number(c.startupCount ?? c.nodeCount ?? 0);
      out[g] = {
        significanceScore: Number(c.significanceScore || 0),
        visualWeight: Number(c.visualWeight || 0.6),
        topRarity: topR,
        top3MeanRarity: top3M,
        filingCount: fCount,
        filingBonus: fBonus,
        startupCount: sCount,
        topContributors: Array.isArray(c.topContributors) ? c.topContributors : [],
        significanceFormula: c.significanceFormula || sigFormula,
        significanceInputs:
          c.significanceInputs ||
          `Top: ${topR.toFixed(1)} + Top3 avg: ${top3M.toFixed(1)} + ${fCount} FILING (+${fBonus.toFixed(1)}) = ${Number(c.significanceScore || 0).toFixed(1)} | ${sCount} ${sCount === 1 ? "entity" : "entities"}`
      };
    }
    if (groups.every((g) => out[g])) return out;
  }

  const edges = explicitEdges || bridgeMap?.edges || [];
  const nodes = explicitNodes || (bridgeMap?.nodes || []).filter((n) => n.kind !== "anchor");
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const stats = {};

  for (const g of groups) {
    const groupEdges = edges.filter((e) => getNodeContributionGroup(e) === g);
    const byNode = new Map();
    const filingNodeIds = new Set();

    for (const e of groupEdges) {
      const targetId = e.isAnchorTarget || e.to === bridgeMap?.anchor?.id ? e.from : e.to;
      const node = nodeById.get(targetId) || nodeById.get(e.from) || nodeById.get(e.to);
      if (!node || node.kind === "anchor") continue;
      const rarity = Number(e.rarityScore || node.rarityScore || 6);
      const prev = byNode.get(node.id);
      if (!prev || rarity > prev.rarityScore) {
        byNode.set(node.id, { id: node.id, label: node.label, rarityScore: rarity });
      }
      if (String(e.topSourceRank || "").toUpperCase() === "FILING") {
        filingNodeIds.add(node.id);
      }
    }

    const entries = [...byNode.values()].sort((a, b) => b.rarityScore - a.rarityScore);
    const topR = entries[0]?.rarityScore || 0;
    const top3Slice = entries.slice(0, 3).map((x) => x.rarityScore);
    const top3M = top3Slice.length ? top3Slice.reduce((s, v) => s + v, 0) / top3Slice.length : 0;
    const fCount = filingNodeIds.size;
    const fBonus = Math.min(4.5, fCount * 1.5);
    const sig = entries.length ? Math.round((topR + top3M + fBonus) * 100) / 100 : 0;
    const entityWord = entries.length === 1 ? "entity" : "entities";
    stats[g] = {
      significanceScore: sig,
      visualWeight: entries.length ? 1 : 0.6,
      topRarity: Math.round(topR * 10) / 10,
      top3MeanRarity: Math.round(top3M * 10) / 10,
      filingCount: fCount,
      filingBonus: Math.round(fBonus * 10) / 10,
      startupCount: entries.length,
      topContributors: entries.slice(0, 3),
      significanceFormula: sigFormula,
      significanceInputs: `Top: ${topR.toFixed(1)} + Top3 avg: ${top3M.toFixed(1)} + ${fCount} FILING (+${fBonus.toFixed(1)}) = ${sig.toFixed(1)} | ${entries.length} ${entityWord}`
    };
  }

  const activeSigs = groups.map((g) => stats[g].significanceScore).filter((v) => v > 0);
  const maxSig = activeSigs.length ? Math.max(...activeSigs) : 0;
  const minSig = activeSigs.length ? Math.min(...activeSigs) : 0;
  for (const g of groups) {
    const s = stats[g];
    if (s.significanceScore > 0) {
      s.visualWeight = maxSig > minSig
        ? Math.round((0.88 + ((s.significanceScore - minSig) / (maxSig - minSig)) * 0.77) * 100) / 100
        : 1.15;
    }
  }
  return stats;
}

function allocateProportionalSectorSpans(weights, totalDeg = 360, minSpan = 55, maxSpan = 115) {
  const n = weights.length;
  const safeW = weights.map((w) => Math.max(0.1, Number(w) || 1));
  const fixed = new Array(n).fill(null);
  let remaining = totalDeg;

  for (let iter = 0; iter < n; iter++) {
    let openSum = 0;
    for (let i = 0; i < n; i++) {
      if (fixed[i] === null) openSum += safeW[i];
    }
    if (openSum <= 0) break;

    let worstIdx = -1;
    let worstViolation = 0;
    let worstClamp = 0;
    for (let i = 0; i < n; i++) {
      if (fixed[i] !== null) continue;
      const raw = (safeW[i] / openSum) * remaining;
      if (raw < minSpan && minSpan - raw > worstViolation) {
        worstViolation = minSpan - raw;
        worstIdx = i;
        worstClamp = minSpan;
      } else if (raw > maxSpan && raw - maxSpan > worstViolation) {
        worstViolation = raw - maxSpan;
        worstIdx = i;
        worstClamp = maxSpan;
      }
    }
    if (worstIdx !== -1) {
      fixed[worstIdx] = worstClamp;
      remaining -= worstClamp;
    } else {
      for (let i = 0; i < n; i++) {
        if (fixed[i] === null) fixed[i] = (safeW[i] / openSum) * remaining;
      }
      break;
    }
  }
  return fixed.map((v) => Math.round((v ?? (totalDeg / n)) * 100) / 100);
}

function polarToCartesian(cx, cy, radius, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad)
  };
}

function computeGroupHubOrbSize(visualWeight = 1) {
  const norm = Math.max(0, Math.min(1, ((Number(visualWeight) || 0.6) - 0.6) / 1.05));
  return Math.round(Math.min(34, Math.max(22, 22 + norm * 12)));
}

function computeEntityOrbSize(node, isShared = false) {
  const rarity = Number(node?.rarityScore || 6);
  const norm = Math.max(0, Math.min(1, (rarity - 6) / 20));
  return Math.round(Math.min(28, Math.max(16, 16 + norm * 10 + (isShared ? 2 : 0))));
}

function estimateNodeBoxMetrics(node, kind, isShared = false, customSize = 22) {
  const shortStr =
    kind === "group_hub"
      ? formatCompactEntityName(node.label, 1, 14)
      : formatCompactEntityName(node.label, 2, 20);
  const labelLen = shortStr.length;

  if (kind === "anchor") {
    return { orbR: 28, bridgeSize: 56, halfW: 128, topPad: 36, bottomPad: 96 };
  }
  if (kind === "group_hub") {
    const clampedSize = Math.min(34, Math.max(22, Math.round(Number(customSize) || 26)));
    const orbR = Math.round(clampedSize / 2);
    return {
      orbR,
      bridgeSize: clampedSize,
      halfW: 90,
      topPad: orbR + 6,
      bottomPad: orbR + 66
    };
  }
  const orbSize = Math.min(28, Math.max(14, Math.round(Number(customSize) || (isShared ? 26 : 20))));
  const orbR = Math.round(orbSize / 2);
  return {
    orbR,
    bridgeSize: orbSize,
    halfW: Math.min(102, Math.max(52, labelLen * 3.6 + 22)),
    topPad: orbR + 8 + (isShared ? 22 : 0),
    bottomPad: orbR + 52
  };
}

function resolveOrbAndLabelCollisions(posMap, nodeById, ringOptions = null) {
  const opts = typeof ringOptions === "object" && ringOptions !== null
    ? ringOptions
    : { polarRings: Boolean(ringOptions) };
  const movableIds = [...posMap.keys()].filter((id) => {
    const k = nodeById.get(id)?.kind;
    return k !== "anchor" && !posMap.get(id)?.locked;
  });
  const fixedPositions = [...posMap.entries()]
    .filter(([id, p]) => nodeById.get(id)?.kind === "anchor" || p?.locked)
    .map(([, p]) => p);

  const iterations = 24;
  for (let pass = 0; pass < iterations; pass++) {
    for (let i = 0; i < movableIds.length; i++) {
      const idA = movableIds[i];
      const pA = posMap.get(idA);
      const aL = pA.x - pA.halfW - 7;
      const aR = pA.x + pA.halfW + 7;
      const aT = pA.y - pA.topPad - 5;
      const aB = pA.y + pA.bottomPad + 7;

      for (let j = i + 1; j < movableIds.length; j++) {
        const idB = movableIds[j];
        const pB = posMap.get(idB);
        const bL = pB.x - pB.halfW - 7;
        const bR = pB.x + pB.halfW + 7;
        const bT = pB.y - pB.topPad - 5;
        const bB = pB.y + pB.bottomPad + 7;

        const overlapX = Math.min(aR, bR) - Math.max(aL, bL);
        const overlapY = Math.min(aB, bB) - Math.max(aT, bT);
        if (overlapX > 0 && overlapY > 0) {
          let dx = pA.x - pB.x;
          let dy = pA.y - pB.y;
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
            dx = (i % 2 === 0 ? 1 : -1) * 4;
            dy = (j % 2 === 0 ? 1 : -1) * 4;
          }
          if (overlapY <= overlapX * 0.92) {
            const pushY = overlapY * 0.54 * (dy >= 0 ? 1 : -1);
            const pushX = Math.sign(dx || 1) * Math.min(4.5, overlapX * 0.09);
            pA.y += pushY;
            pB.y -= pushY;
            pA.x += pushX;
            pB.x -= pushX;
          } else {
            const pushX = overlapX * 0.54 * (dx >= 0 ? 1 : -1);
            const pushY = Math.sign(dy || 1) * Math.min(4.5, overlapY * 0.12);
            pA.x += pushX;
            pB.x -= pushX;
            pA.y += pushY;
            pB.y -= pushY;
          }
        }
      }

      for (const fp of fixedPositions) {
        const dx = pA.x - fp.x;
        const dy = pA.y - fp.y;
        const dist = Math.hypot(dx, dy) || 1;
        const minClear = fp.orbR >= 24 ? 120 : 92;
        if (dist < minClear) {
          const push = (minClear - dist) * 0.72;
          pA.x += (dx / dist) * push;
          pA.y += (dy / dist) * push;
        }
      }

      if (opts.polarRings) {
        const dx = pA.x - CONSTELLATION_CX;
        const dy = pA.y - CONSTELLATION_CY;
        let dist = Math.hypot(dx, dy) || 1;
        const minR = pA.minRingR ?? 220;
        const maxR = pA.maxRingR ?? 460;
        if (pass < iterations - 2 && (dist < minR || dist > maxR)) {
          const targetR = Math.max(minR, Math.min(maxR, dist));
          dist = dist + (targetR - dist) * 0.72;
        }
        if (typeof pA.sectorMinDeg === "number" && typeof pA.sectorMaxDeg === "number") {
          let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
          const mid = (pA.sectorMinDeg + pA.sectorMaxDeg) / 2;
          while (ang < mid - 180) ang += 360;
          while (ang > mid + 180) ang -= 360;
          const clampedAng = Math.max(pA.sectorMinDeg, Math.min(pA.sectorMaxDeg, ang));
          const rad = (clampedAng * Math.PI) / 180;
          pA.x = CONSTELLATION_CX + dist * Math.cos(rad);
          pA.y = CONSTELLATION_CY + dist * Math.sin(rad);
        } else if (dist !== Math.hypot(dx, dy)) {
          pA.x = CONSTELLATION_CX + (dx / (Math.hypot(dx, dy) || 1)) * dist;
          pA.y = CONSTELLATION_CY + (dy / (Math.hypot(dx, dy) || 1)) * dist;
        }
      }
    }
  }
}

// ---------- Filter Effective Graph ----------

function countActiveFilters() {
  let n = 0;
  if (state.sharedOnly) n += 1;
  if (state.filingOnly) n += 1;
  if (state.contributionGroup && state.contributionGroup !== "all") n += 1;
  return n;
}

function getEffectiveBridgeMap() {
  const base = state.bridgeMap;
  if (!base) return null;
  const edges = asList(base.edges);
  const allNodes = asList(base.nodes);
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));
  const focalIds = new Set(
    asList(base.focalEntityIds).length
      ? base.focalEntityIds
      : allNodes.filter((n) => n.kind === "anchor" || n.isFocalEntity).map((n) => n.id)
  );
  if (base.anchor?.id) focalIds.add(base.anchor.id);
  const perspId = base.perspectiveEntity?.id || allNodes.find((n) => n.isPerspectiveEntity)?.id || null;

  const hasFilter = state.sharedOnly || state.filingOnly || (state.contributionGroup && state.contributionGroup !== "all");
  if (!hasFilter) return base;

  const filteredEdges = edges.filter((edge) => {
    if (state.sharedOnly && !(edge.isSharedEdge || edge.isSharedBridge || edge.touchesPerspective)) return false;
    if (state.filingOnly && String(edge.topSourceRank || "").toUpperCase() !== "FILING") return false;
    if (state.contributionGroup && state.contributionGroup !== "all") {
      if (getNodeContributionGroup(edge) !== state.contributionGroup) return false;
    }
    return true;
  });

  const keepNodeIds = new Set(focalIds);
  if (perspId) keepNodeIds.add(perspId);
  for (const e of filteredEdges) {
    keepNodeIds.add(e.from);
    keepNodeIds.add(e.to);
  }
  const filteredNodes = allNodes.filter((n) => keepNodeIds.has(n.id));
  const filteredClusters = computeContributionWeightsFrontend(
    { ...base, contributionClusters: null },
    filteredNodes,
    filteredEdges
  );

  return {
    ...base,
    nodes: filteredNodes,
    edges: filteredEdges,
    contributionClusters: Object.entries(filteredClusters).map(([group, stats]) => ({
      group,
      contributionGroup: group,
      ...stats
    }))
  };
}

// ---------- Polar 2-Level Contribution Tree Builder (Single Anchor Mode) ----------

function buildPolarContributionTreeData(bridgeMap) {
  const nodes = asList(bridgeMap?.nodes);
  const edges = asList(bridgeMap?.edges);
  const primaryAnchor =
    nodes.find((n) => n.kind === "anchor" || n.isFocalEntity) ||
    (bridgeMap?.anchor ? { ...bridgeMap.anchor, kind: "anchor" } : null);

  if (!primaryAnchor) {
    return {
      primaryAnchor: null,
      hubNodes: [],
      outerNodes: [],
      displayEdges: [],
      sectorGeometry: {},
      contribWeights: {},
      totalOuterCount: 0,
      hiddenOuterCount: 0,
      treeMode: "overview",
      focusedGroupKey: null
    };
  }

  const anchorId = primaryAnchor.id;
  const connectedNodes = nodes.filter((n) => n.id !== anchorId && n.kind !== "anchor");
  const connectedById = new Map(connectedNodes.map((n) => [n.id, n]));

  // Map each non-anchor node to its incident edges and primary contribution group
  const edgesByTarget = new Map();
  for (const e of edges) {
    const otherId = e.from === anchorId ? e.to : e.to === anchorId ? e.from : null;
    if (!otherId || !connectedById.has(otherId)) continue;
    if (!edgesByTarget.has(otherId)) edgesByTarget.set(otherId, []);
    edgesByTarget.get(otherId).push(e);
  }

  const primaryGroupOfNode = new Map();
  const groupSetOfNode = new Map();
  const bestEdgeOfNodeByGroup = new Map();

  for (const node of connectedNodes) {
    const inc = (edgesByTarget.get(node.id) || [])
      .slice()
      .sort((a, b) => Number(b.rarityScore || 0) - Number(a.rarityScore || 0));
    const groupsForNode = new Set();
    const byGroup = new Map();
    for (const e of inc) {
      const g = getNodeContributionGroup(e);
      groupsForNode.add(g);
      if (!byGroup.has(g)) byGroup.set(g, e);
    }
    if (!groupsForNode.size) {
      groupsForNode.add(getNodeContributionGroup(node));
    }
    const primaryGroup = inc[0] ? getNodeContributionGroup(inc[0]) : getNodeContributionGroup(node);
    primaryGroupOfNode.set(node.id, primaryGroup);
    groupSetOfNode.set(node.id, groupsForNode);
    bestEdgeOfNodeByGroup.set(node.id, byGroup);
  }

  const contribWeights = computeContributionWeightsFrontend(bridgeMap, connectedNodes, edges);
  const quadrantWeights = ORBIT_QUADRANTS.map((q) => contribWeights[q.group]?.visualWeight ?? 0.6);
  const allocatedSpans = allocateProportionalSectorSpans(quadrantWeights, 360, 56, 114);

  let maxSig = 0;
  let strongestGroupKey = null;
  for (const q of ORBIT_QUADRANTS) {
    const sig = contribWeights[q.group]?.significanceScore || 0;
    if (sig > maxSig) {
      maxSig = sig;
      strongestGroupKey = q.group;
    }
  }

  let focusedGroupKey = state.expandedGroupKey;
  if (focusedGroupKey && !ORBIT_QUADRANTS.some((q) => q.group === focusedGroupKey)) {
    focusedGroupKey = null;
  }
  const treeMode = focusedGroupKey ? "drilldown" : "overview";

  // Build Sector Geometry anchored cleanly around quadrants
  const sectorGeometry = {};
  let cursorDeg = 166;
  ORBIT_QUADRANTS.forEach((q, idx) => {
    const span = allocatedSpans[idx] || 90;
    const slotStart = cursorDeg;
    const slotEnd = cursorDeg + span;
    const midDeg = (slotStart + slotEnd) / 2;
    cursorDeg = slotEnd;
    sectorGeometry[q.group] = {
      ...q,
      slotStart,
      slotEnd,
      midDeg,
      minDeg: slotStart + 7,
      maxDeg: slotEnd - 7,
      visualWeight: contribWeights[q.group]?.visualWeight ?? 0.6,
      significanceScore: contribWeights[q.group]?.significanceScore ?? 0,
      isStrongest: q.group === strongestGroupKey && maxSig > 0
    };
  });

  // Sort connected entities by rarity descending
  const sortedConnected = [...connectedNodes].sort((a, b) => {
    const diff = Number(b.rarityScore || 0) - Number(a.rarityScore || 0);
    if (diff !== 0) return diff;
    return nameOf(a).localeCompare(nameOf(b));
  });

  // Pick overview subset (balanced up to OVERVIEW_ENTITY_CAP so sectors never overflow)
  let displayOuter = [];
  let hiddenOuterCount = 0;

  if (treeMode === "overview") {
    const pickedIds = new Set();
    // Reserve up to 3 top entities per active group first, then fill up to OVERVIEW_ENTITY_CAP
    for (const q of ORBIT_QUADRANTS) {
      const groupMatches = sortedConnected.filter((n) => primaryGroupOfNode.get(n.id) === q.group);
      for (const n of groupMatches.slice(0, 3)) {
        if (displayOuter.length < OVERVIEW_ENTITY_CAP && !pickedIds.has(n.id)) {
          pickedIds.add(n.id);
          displayOuter.push(n);
        }
      }
    }
    for (const n of sortedConnected) {
      if (displayOuter.length >= OVERVIEW_ENTITY_CAP) break;
      if (!pickedIds.has(n.id)) {
        pickedIds.add(n.id);
        displayOuter.push(n);
      }
    }
    hiddenOuterCount = Math.max(0, sortedConnected.length - displayOuter.length);
  } else {
    // Drill-down: show ALL entities associated with focusedGroupKey
    displayOuter = sortedConnected.filter((n) => {
      const gSet = groupSetOfNode.get(n.id);
      return primaryGroupOfNode.get(n.id) === focusedGroupKey || (gSet && gSet.has(focusedGroupKey));
    });
  }

  // Group Hubs (4 rings in inner ring)
  const hubNodes = ORBIT_QUADRANTS.map((q) => {
    const cw = contribWeights[q.group] || {};
    const count =
      treeMode === "overview"
        ? sortedConnected.filter((n) => primaryGroupOfNode.get(n.id) === q.group).length
        : sortedConnected.filter((n) => {
            const gSet = groupSetOfNode.get(n.id);
            return primaryGroupOfNode.get(n.id) === q.group || (gSet && gSet.has(q.group));
          }).length;
    const score = Number(cw.significanceScore || 0);
    const clueMetric = count > 0
      ? `${count} verified ${count === 1 ? "path" : "paths"}`
      : "No verified paths";
    const groupEdgeCount = edges.filter((e) => getNodeContributionGroup(e) === q.group).length || count;
    return {
      id: `group_hub:${q.group}`,
      kind: "group_hub",
      groupKey: q.group,
      contributionGroup: q.group,
      label: q.label,
      subtitle: CONTRIBUTION_VISUAL_META[q.group]?.subtitle || "",
      clueMetric,
      entityCount: count,
      edgeCount: groupEdgeCount,
      significanceScore: score,
      visualWeight: Number(cw.visualWeight || 0.6),
      significanceFormula: cw.significanceFormula,
      significanceInputs: cw.significanceInputs,
      topContributors: cw.topContributors || [],
      isStrongest: q.group === strongestGroupKey && maxSig > 0,
      isExpandedHub: treeMode === "drilldown" && focusedGroupKey === q.group,
      isGroupDimmed: treeMode === "drilldown" && focusedGroupKey !== q.group
    };
  });

  // Build Tree Spokes + Outer Radial Curves + Hidden Secondary Cross-Links
  const displayEdges = [];
  for (const hub of hubNodes) {
    const sign = hub.groupKey === "access" || hub.groupKey === "timing" ? 1 : -1;
    displayEdges.push({
      id: `spoke:${anchorId}->${hub.id}`,
      from: anchorId,
      to: hub.id,
      contributionGroup: hub.groupKey,
      topSourceRank: hub.entityCount > 0 ? "PRIMARY" : "AGGREGATOR",
      rarityScore: hub.significanceScore ? Math.min(24, Math.round(hub.significanceScore / 2)) : 4,
      isOverviewSpoke: true,
      isGroupDimmedEdge: hub.isGroupDimmed,
      anchorBow: sign,
      label: `${hub.label} Group Branch`,
      hubEntityCount: hub.entityCount || 0,
      hubEdgeCount: hub.edgeCount || 0,
      hubTopContributors: hub.topContributors || [],
      detail: `${nameOf(primaryAnchor)}: ${hub.entityCount || 0} connected ${hub.entityCount === 1 ? "entity" : "entities"} across ${hub.edgeCount || 0} verified paths in ${hub.label}.`,
      formulaBreakdown: {
        formula: hub.significanceFormula,
        inputs: hub.significanceInputs,
        plainMeaning: `${hub.label}: ${hub.subtitle}`
      }
    });
  }

  for (const outer of displayOuter) {
    const primaryGroup =
      treeMode === "drilldown" ? focusedGroupKey : primaryGroupOfNode.get(outer.id) || "access";
    const byGroup = bestEdgeOfNodeByGroup.get(outer.id) || new Map();
    const primaryOrig = byGroup.get(primaryGroup) || (edgesByTarget.get(outer.id) || [])[0];
    const primaryHubId = `group_hub:${primaryGroup}`;
    const bow = primaryGroup === "access" || primaryGroup === "timing" ? 1 : -1;

    displayEdges.push({
      id: `tree:${primaryHubId}->${outer.id}`,
      from: primaryHubId,
      to: outer.id,
      realNodeId: outer.id,
      contributionGroup: primaryGroup,
      topSourceRank: primaryOrig?.topSourceRank || tierOf(outer) || "PRIMARY",
      rarityScore: primaryOrig?.rarityScore ?? outer.rarityScore ?? 8,
      date: primaryOrig?.date || outer.date || null,
      label: primaryOrig?.label || primaryOrig?.relation || null,
      relation: primaryOrig?.relation || primaryOrig?.relationType || null,
      detail: primaryOrig?.detail || outer.detail || nameOf(outer),
      relationType: primaryOrig?.relationType || outer.relationType || null,
      sourceIds: primaryOrig?.sourceIds || outer.sourceIds || [],
      evidenceSources: primaryOrig?.evidenceSources || outer.evidenceSources || [],
      sourceCount: primaryOrig?.sourceCount ?? 0,
      whyMatters: primaryOrig?.whyMatters || null,
      roundLabel: primaryOrig?.roundLabel || null,
      roundType: primaryOrig?.roundType || null,
      roundAmount: primaryOrig?.roundAmount || null,
      roundDate: primaryOrig?.roundDate || null,
      role: primaryOrig?.role || null,
      isLead: Boolean(primaryOrig?.isLead),
      syndicatePeers: primaryOrig?.syndicatePeers || null,
      syndicateTotalCount: primaryOrig?.syndicateTotalCount || 0,
      formulaBreakdown: primaryOrig?.formulaBreakdown || outer.formulaBreakdown || null,
      anchorBow: bow
    });

    if (treeMode === "overview") {
      const secondaryGroups = [...(groupSetOfNode.get(outer.id) || [])].filter((g) => g !== primaryGroup);
      for (const secGroup of secondaryGroups) {
        const secOrig = byGroup.get(secGroup);
        displayEdges.push({
          id: `sec:${outer.id}<-${secGroup}`,
          from: `group_hub:${secGroup}`,
          to: outer.id,
          realNodeId: outer.id,
          contributionGroup: secGroup,
          topSourceRank: secOrig?.topSourceRank || "PRIMARY",
          rarityScore: secOrig?.rarityScore ?? 8,
          label: secOrig?.label || null,
          detail: secOrig?.detail || `Secondary ${secGroup.toUpperCase()} path`,
          sourceIds: secOrig?.sourceIds || outer.sourceIds || [],
          evidenceSources: secOrig?.evidenceSources || [],
          whyMatters: secOrig?.whyMatters || null,
          formulaBreakdown: secOrig?.formulaBreakdown || null,
          isSecondaryOverviewLink: true
        });
      }
    }
  }

  return {
    primaryAnchor: { ...primaryAnchor, kind: "anchor" },
    hubNodes,
    outerNodes: displayOuter.map((n) => ({
      ...n,
      placedGroup: treeMode === "drilldown" ? focusedGroupKey : primaryGroupOfNode.get(n.id)
    })),
    displayEdges,
    sectorGeometry,
    contribWeights,
    totalOuterCount: sortedConnected.length,
    hiddenOuterCount,
    treeMode,
    focusedGroupKey
  };
}

function layoutAnchorDirectSatellites(aNode, ap, items, spanDeg, posMap, usedSatSet) {
  const ordered = [...asList(items)].sort((a, b) => {
    const ra = STRUCTURAL_SECTOR_ORDER.indexOf(deriveStructuralRoleFrontend(a));
    const rb = STRUCTURAL_SECTOR_ORDER.indexOf(deriveStructuralRoleFrontend(b));
    if (ra !== rb) return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
    return Number(b.rarityScore || 0) - Number(a.rarityScore || 0);
  });
  const count = ordered.length;
  if (!count) return;
  const effectiveSpan = count === 1 ? 0 : Math.min(spanDeg, Math.max(46, count * 20));
  ordered.forEach((sat, idx) => {
    const frac = count === 1 ? 0.5 : idx / (count - 1);
    const deg = count === 1 ? ap.outAngle : ap.outAngle - effectiveSpan / 2 + frac * effectiveSpan;
    const rad = count >= 5 && idx % 2 === 1 ? 286 : 212;
    const pt = polarToCartesian(ap.x, ap.y, rad, deg);
    const sm = estimateNodeBoxMetrics(sat, "entity", false, computeEntityOrbSize(sat, false));
    posMap.set(sat.id, {
      x: pt.x,
      y: pt.y,
      isTopUniqueLabel: idx < 3,
      placedRole: deriveStructuralRoleFrontend(sat),
      ...sm
    });
    usedSatSet.add(sat.id);
  });
}

function layoutBridgeMapNodes(bridgeMap) {
  const allNodes = asList(bridgeMap?.nodes);
  const allEdges = asList(bridgeMap?.edges);
  const analysisMode = getActiveAnalysisMode(bridgeMap);
  const anchorNodes = allNodes.filter((n) => n.kind === "anchor" || n.isFocalEntity);
  if (!anchorNodes.length && bridgeMap?.anchor) {
    anchorNodes.push({ ...bridgeMap.anchor, kind: "anchor" });
  }

  const posMap = new Map();
  const nodeById = new Map();
  const connectedEdgesByNode = new Map();

  const perspectiveAnchor =
    anchorNodes.find((n) => n.isPerspectiveEntity) ||
    (bridgeMap?.perspectiveEntity?.id ? anchorNodes.find((n) => n.id === bridgeMap.perspectiveEntity.id) : null) ||
    null;
  const targetAnchors = perspectiveAnchor
    ? anchorNodes.filter((n) => n.id !== perspectiveAnchor.id)
    : anchorNodes;

  // MODE P: Asymmetric Perspective Deal Triage (My Firm on left -> Warm Spine -> Target(s) on right)
  if (perspectiveAnchor && targetAnchors.length >= 1) {
    const rawNonAnchors = allNodes.filter((n) => n.kind !== "anchor" && !n.isFocalEntity && !n.isPerspectiveEntity);
    const activeNodeIds = new Set(anchorNodes.map((a) => a.id));
    for (const e of allEdges) {
      activeNodeIds.add(e.from);
      activeNodeIds.add(e.to);
    }
    const nonAnchors = rawNonAnchors.filter((n) => activeNodeIds.has(n.id));
    for (const n of [...anchorNodes, ...nonAnchors]) {
      nodeById.set(n.id, n);
      connectedEdgesByNode.set(n.id, []);
    }
    for (const e of allEdges) {
      if (!connectedEdgesByNode.has(e.from)) connectedEdgesByNode.set(e.from, []);
      if (!connectedEdgesByNode.has(e.to)) connectedEdgesByNode.set(e.to, []);
      connectedEdgesByNode.get(e.from).push(e);
      connectedEdgesByNode.get(e.to).push(e);
    }

    const pm = estimateNodeBoxMetrics(perspectiveAnchor, "anchor");
    posMap.set(perspectiveAnchor.id, {
      x: CONSTELLATION_CX - 340,
      y: CONSTELLATION_CY,
      outAngle: 180,
      locked: true,
      ...pm
    });

    const tCount = targetAnchors.length;
    targetAnchors.forEach((tNode, idx) => {
      const yOff = tCount === 1 ? 0 : (idx - (tCount - 1) / 2) * 260;
      const tm = estimateNodeBoxMetrics(tNode, "anchor");
      posMap.set(tNode.id, {
        x: CONSTELLATION_CX + 320,
        y: CONSTELLATION_CY + yOff,
        outAngle: 0,
        locked: true,
        ...tm
      });
    });

    const targetIdSet = new Set(targetAnchors.map((a) => a.id));
    const touchedByPerspective = new Set();
    const touchedByTargets = new Map();
    for (const e of allEdges) {
      if (e.from === perspectiveAnchor.id && !anchorNodes.some((a) => a.id === e.to)) touchedByPerspective.add(e.to);
      if (e.to === perspectiveAnchor.id && !anchorNodes.some((a) => a.id === e.from)) touchedByPerspective.add(e.from);
      if (targetIdSet.has(e.from) && !anchorNodes.some((a) => a.id === e.to)) {
        if (!touchedByTargets.has(e.to)) touchedByTargets.set(e.to, new Set());
        touchedByTargets.get(e.to).add(e.from);
      }
      if (targetIdSet.has(e.to) && !anchorNodes.some((a) => a.id === e.from)) {
        if (!touchedByTargets.has(e.from)) touchedByTargets.set(e.from, new Set());
        touchedByTargets.get(e.from).add(e.to);
      }
    }

    const spineNodes = [];
    const targetUniqueMap = new Map(targetAnchors.map((a) => [a.id, []]));
    for (const n of nonAnchors) {
      const tOwners = touchedByTargets.get(n.id) || new Set();
      const connectsPerspAndTarget = touchedByPerspective.has(n.id) && tOwners.size >= 1;
      const isSpine = Boolean(n.isPerspectiveBridge || connectsPerspAndTarget || tOwners.size >= 2 || n.isSharedBridge);
      n.isSharedOverlap = isSpine;
      if (isSpine) {
        spineNodes.push(n);
      } else if (tOwners.size >= 1) {
        const ownerId = [...tOwners][0];
        if (targetUniqueMap.has(ownerId)) targetUniqueMap.get(ownerId).push(n);
      }
    }

    spineNodes
      .sort((a, b) => Number(Boolean(b.isPerspectiveBridge)) - Number(Boolean(a.isPerspectiveBridge)) || Number(b.rarityScore || 0) - Number(a.rarityScore || 0))
      .slice(0, 14)
      .forEach((n, idx, list) => {
        const offsetIdx = list.length === 1 ? 0 : idx - (list.length - 1) / 2;
        const xShift = idx % 2 === 0 ? -36 : 36;
        const yPos = CONSTELLATION_CY + offsetIdx * 96;
        const sm = estimateNodeBoxMetrics(n, "entity", true, computeEntityOrbSize(n, true));
        posMap.set(n.id, { x: CONSTELLATION_CX - 10 + xShift, y: yPos, ...sm });
      });

    const placedSatSet = new Set();
    targetAnchors.forEach((tNode) => {
      const ap = posMap.get(tNode.id);
      const items = (targetUniqueMap.get(tNode.id) || [])
        .sort((a, b) => Number(b.rarityScore || 0) - Number(a.rarityScore || 0))
        .slice(0, tCount === 1 ? 12 : 7);
      layoutAnchorDirectSatellites(tNode, ap, items, tCount === 1 ? 148 : 112, posMap, placedSatSet);
    });

    resolveOrbAndLabelCollisions(posMap, nodeById, null);

    const placedIds = new Set(posMap.keys());
    const displayNodes = [...anchorNodes, ...nonAnchors].filter((n) => placedIds.has(n.id));
    const displayEdges = allEdges.filter((e) => placedIds.has(e.from) && placedIds.has(e.to));
    const hasPerspConnection =
      spineNodes.length > 0 ||
      displayEdges.some((e) => (e.from === perspectiveAnchor.id && targetIdSet.has(e.to)) || (e.to === perspectiveAnchor.id && targetIdSet.has(e.from)));

    let minX = CONSTELLATION_W;
    let minY = CONSTELLATION_H;
    let maxX = 0;
    let maxY = 0;
    for (const pos of posMap.values()) {
      minX = Math.min(minX, pos.x - (pos.halfW || 80));
      minY = Math.min(minY, pos.y - (pos.topPad || 24));
      maxX = Math.max(maxX, pos.x + (pos.halfW || 80));
      maxY = Math.max(maxY, pos.y + (pos.bottomPad || 44));
    }

    return {
      mode: "perspective",
      analysisMode: "perspective_triage",
      treeMode: "perspective",
      isPerspectiveLayout: true,
      perspectiveAnchorId: perspectiveAnchor.id,
      primaryTargetAnchorId: targetAnchors[0].id,
      isColdOutreach: !hasPerspConnection,
      focusedGroupKey: null,
      anchorCount: anchorNodes.length,
      anchorIds: new Set(anchorNodes.map((a) => a.id)),
      posMap,
      sectorMetaForSvg: [],
      populatedSectors: [],
      nodeById,
      connectedEdgesByNode,
      displayNodes,
      displayEdges,
      totalOuterCount: nonAnchors.length,
      hiddenOuterCount: Math.max(0, nonAnchors.length - (displayNodes.length - anchorNodes.length)),
      bounds: { minX: minX - 54, minY: minY - 48, maxX: maxX + 54, maxY: maxY + 48 }
    };
  }

  // MODE A: Single-Company Teardown (Direct 1-hop/2-hop structural spokes grouped cleanly by non-empty role, ZERO group_hub rings)
  if (anchorNodes.length <= 1) {
    const primaryAnchor = anchorNodes[0] || (bridgeMap?.anchor ? { ...bridgeMap.anchor, kind: "anchor" } : null);
    if (!primaryAnchor) {
      return {
        mode: "teardown",
        analysisMode: "single_teardown",
        treeMode: "teardown",
        focusedGroupKey: null,
        anchorCount: 0,
        anchorIds: new Set(),
        posMap,
        sectorMetaForSvg: [],
        populatedSectors: [],
        nodeById,
        connectedEdgesByNode,
        displayNodes: [],
        displayEdges: [],
        totalOuterCount: 0,
        hiddenOuterCount: 0,
        bounds: { minX: 0, minY: 0, maxX: CONSTELLATION_W, maxY: CONSTELLATION_H }
      };
    }

    const anchorId = primaryAnchor.id;
    const rawConnected = allNodes.filter((n) => n.id !== anchorId && n.kind !== "anchor");
    const activeSatIds = new Set();
    const bestEdgeByNode = new Map();
    for (const e of allEdges) {
      if (e.from !== anchorId && e.to !== anchorId) continue;
      const otherId = e.from === anchorId ? e.to : e.from;
      activeSatIds.add(otherId);
      const prev = bestEdgeByNode.get(otherId);
      if (!prev || Number(e.rarityScore || 0) > Number(prev.rarityScore || 0)) {
        bestEdgeByNode.set(otherId, e);
      }
    }

    const satellites = rawConnected
      .filter((n) => activeSatIds.has(n.id))
      .map((n) => {
        const edge = bestEdgeByNode.get(n.id);
        const sRole = deriveStructuralRoleFrontend(edge || n);
        return {
          ...n,
          structuralRole: sRole,
          placedRole: sRole
        };
      })
      .sort((a, b) => Number(b.rarityScore || 0) - Number(a.rarityScore || 0));

    const cappedSatellites = [];
    const perSectorCap = 8;
    const byRoleBuckets = Object.fromEntries(STRUCTURAL_SECTOR_ORDER.map((r) => [r, []]));
    for (const sat of satellites) {
      const bucket = byRoleBuckets[sat.placedRole] || byRoleBuckets.governance;
      if (bucket.length < perSectorCap) {
        bucket.push(sat);
        cappedSatellites.push(sat);
      }
    }

    const populatedRoles = STRUCTURAL_SECTOR_ORDER.filter((r) => byRoleBuckets[r].length > 0);
    const totalPop = populatedRoles.reduce((sum, r) => sum + byRoleBuckets[r].length, 0) || 1;
    let cursorDeg = -140;
    const sectorGap = populatedRoles.length > 1 ? 12 : 0;
    const usableArc = 360 - sectorGap * populatedRoles.length;
    const sectorAngles = new Map();
    for (const role of populatedRoles) {
      const share = byRoleBuckets[role].length / totalPop;
      const span = Math.max(54, Math.round(share * usableArc));
      const startDeg = cursorDeg;
      const endDeg = startDeg + span;
      sectorAngles.set(role, {
        role,
        label: STRUCTURAL_ROLE_META[role]?.label || role,
        shortLabel: STRUCTURAL_ROLE_META[role]?.shortLabel || role,
        startDeg,
        endDeg,
        midDeg: (startDeg + endDeg) / 2,
        count: byRoleBuckets[role].length
      });
      cursorDeg = endDeg + sectorGap;
    }

    const displayNodes = [{ ...primaryAnchor, kind: "anchor" }, ...cappedSatellites];
    const satIdSet = new Set(displayNodes.map((n) => n.id));
    const displayEdges = allEdges.filter((e) => satIdSet.has(e.from) && satIdSet.has(e.to));

    for (const n of displayNodes) {
      nodeById.set(n.id, n);
      connectedEdgesByNode.set(n.id, []);
    }
    for (const e of displayEdges) {
      if (connectedEdgesByNode.has(e.from)) connectedEdgesByNode.get(e.from).push(e);
      if (connectedEdgesByNode.has(e.to)) connectedEdgesByNode.get(e.to).push(e);
    }

    const am = estimateNodeBoxMetrics(primaryAnchor, "anchor");
    posMap.set(anchorId, { x: CONSTELLATION_CX, y: CONSTELLATION_CY, locked: true, ...am });

    for (const role of populatedRoles) {
      const sec = sectorAngles.get(role);
      const items = byRoleBuckets[role];
      const pad = Math.min(10, Math.max(4, Math.round((sec.endDeg - sec.startDeg) * 0.12)));
      const uMin = sec.startDeg + pad;
      const uMax = sec.endDeg - pad;
      items.forEach((item, idx) => {
        const deg = items.length === 1 ? sec.midDeg : uMin + (idx / Math.max(1, items.length - 1)) * (uMax - uMin);
        const ringR = items.length >= 3 && idx % 2 === 1 ? 336 : 254;
        const pt = polarToCartesian(CONSTELLATION_CX, CONSTELLATION_CY, ringR, deg);
        const sm = estimateNodeBoxMetrics(item, "entity", false, computeEntityOrbSize(item, false));
        posMap.set(item.id, {
          x: pt.x,
          y: pt.y,
          angleDeg: deg,
          sectorMinDeg: uMin,
          sectorMaxDeg: uMax,
          minRingR: 214,
          maxRingR: 396,
          placedRole: role,
          ...sm
        });
      });
    }

    resolveOrbAndLabelCollisions(posMap, nodeById, { polarRings: true });

    let minX = CONSTELLATION_W;
    let minY = CONSTELLATION_H;
    let maxX = 0;
    let maxY = 0;
    for (const p of posMap.values()) {
      minX = Math.min(minX, p.x - (p.halfW || 75));
      minY = Math.min(minY, p.y - (p.topPad || 24));
      maxX = Math.max(maxX, p.x + (p.halfW || 75));
      maxY = Math.max(maxY, p.y + (p.bottomPad || 44));
    }

    return {
      mode: "teardown",
      analysisMode,
      treeMode: "teardown",
      focusedGroupKey: null,
      anchorCount: 1,
      anchorIds: new Set([anchorId]),
      posMap,
      sectorMetaForSvg: [...sectorAngles.values()],
      populatedSectors: [...sectorAngles.values()],
      nodeById,
      connectedEdgesByNode,
      displayNodes,
      displayEdges,
      totalOuterCount: satellites.length,
      hiddenOuterCount: Math.max(0, satellites.length - cappedSatellites.length),
      bounds: {
        minX: minX - 48,
        minY: minY - 48,
        maxX: maxX + 48,
        maxY: maxY + 48
      }
    };
  }

  // MODE B: Multi-Entity Ecosystem & Peer Map (Zero per-anchor group_hub bubbles; clean direct satellites + Center Bridge Spine)
  const rawNonAnchors = allNodes.filter((n) => n.kind !== "anchor" && !n.isFocalEntity);
  const activeEdges = allEdges;
  const activeNodeIds = new Set(anchorNodes.map((a) => a.id));
  for (const e of activeEdges) {
    activeNodeIds.add(e.from);
    activeNodeIds.add(e.to);
  }
  const nonAnchors = rawNonAnchors.filter((n) => activeNodeIds.has(n.id));
  for (const n of [...anchorNodes, ...nonAnchors]) {
    nodeById.set(n.id, n);
    connectedEdgesByNode.set(n.id, []);
  }
  for (const e of activeEdges) {
    if (!connectedEdgesByNode.has(e.from)) connectedEdgesByNode.set(e.from, []);
    if (!connectedEdgesByNode.has(e.to)) connectedEdgesByNode.set(e.to, []);
    connectedEdgesByNode.get(e.from).push(e);
    connectedEdgesByNode.get(e.to).push(e);
  }

  const anchorIdSet = new Set(anchorNodes.map((a) => a.id));
  const ownersOfNode = new Map();
  for (const e of activeEdges) {
    if (anchorIdSet.has(e.from) && nodeById.has(e.to) && !anchorIdSet.has(e.to)) {
      if (!ownersOfNode.has(e.to)) ownersOfNode.set(e.to, new Set());
      ownersOfNode.get(e.to).add(e.from);
    }
    if (anchorIdSet.has(e.to) && nodeById.has(e.from) && !anchorIdSet.has(e.from)) {
      if (!ownersOfNode.has(e.from)) ownersOfNode.set(e.from, new Set());
      ownersOfNode.get(e.from).add(e.to);
    }
  }

  const sharedNodes = [];
  const uniqueByAnchor = new Map(anchorNodes.map((a) => [a.id, []]));
  for (const n of nonAnchors) {
    const owners = ownersOfNode.get(n.id) || new Set();
    const isShared = Boolean(n.isSharedOverlap || n.isSharedBridge || owners.size >= 2);
    n.isSharedOverlap = isShared;
    if (isShared) {
      sharedNodes.push(n);
    } else {
      const ownerId = [...owners][0] || n.primaryAnchorId || anchorNodes[0].id;
      if (!uniqueByAnchor.has(ownerId)) uniqueByAnchor.set(ownerId, []);
      uniqueByAnchor.get(ownerId).push(n);
    }
  }

  const countA = anchorNodes.length;
  const anchorRingRadius = countA === 2 ? 330 : Math.max(360, Math.round(countA * 78));
  const sortedShared = [...sharedNodes].sort((a, b) => Number(b.rarityScore || 0) - Number(a.rarityScore || 0));
  const placedSatIdSet = new Set();

  if (countA === 2) {
    const p0 = { x: CONSTELLATION_CX - 315, y: CONSTELLATION_CY + 100, outAngle: 162 };
    const p1 = { x: CONSTELLATION_CX + 315, y: CONSTELLATION_CY - 100, outAngle: -18 };
    [p0, p1].forEach((pt, idx) => {
      const aNode = anchorNodes[idx];
      const am = estimateNodeBoxMetrics(aNode, "anchor");
      posMap.set(aNode.id, { x: pt.x, y: pt.y, outAngle: pt.outAngle, locked: true, ...am });
    });

    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const dist = Math.hypot(dx, dy) || 1;
    const axisX = dx / dist;
    const axisY = dy / dist;
    const perpX = -dy / dist;
    const perpY = dx / dist;

    sortedShared.slice(0, 14).forEach((n, idx, list) => {
      const t = list.length === 1 ? 0 : idx - (list.length - 1) / 2;
      const along = idx % 2 === 0 ? -56 : 56;
      const perp = t * 84;
      const sm = estimateNodeBoxMetrics(n, "entity", true, computeEntityOrbSize(n, true));
      posMap.set(n.id, {
        x: CONSTELLATION_CX + axisX * along + perpX * perp,
        y: CONSTELLATION_CY + axisY * along + perpY * perp,
        ...sm
      });
    });

    anchorNodes.forEach((aNode) => {
      const ap = posMap.get(aNode.id);
      const items = (uniqueByAnchor.get(aNode.id) || [])
        .sort((a, b) => Number(b.rarityScore || 0) - Number(a.rarityScore || 0))
        .slice(0, 10);
      layoutAnchorDirectSatellites(aNode, ap, items, 138, posMap, placedSatIdSet);
    });
  } else {
    const anchorDegs =
      countA === 4
        ? [-135, -45, 45, 135]
        : anchorNodes.map((_, idx) => -90 + (idx * 360) / countA);
    anchorNodes.forEach((aNode, idx) => {
      const deg = anchorDegs[idx % anchorDegs.length];
      const pt = polarToCartesian(CONSTELLATION_CX, CONSTELLATION_CY, anchorRingRadius, deg);
      const am = estimateNodeBoxMetrics(aNode, "anchor");
      posMap.set(aNode.id, { x: pt.x, y: pt.y, outAngle: deg, locked: true, ...am });
    });

    const maxShared = Math.min(28, Math.max(16, countA * 4));
    const slotByOwnerSig = new Map();
    let universalIdx = 0;
    sortedShared.slice(0, maxShared).forEach((n) => {
      const connectedOwners = [...(ownersOfNode.get(n.id) || [])].filter((id) => posMap.has(id)).sort();
      const sm = estimateNodeBoxMetrics(n, "entity", true, computeEntityOrbSize(n, true));
      if (connectedOwners.length >= 2 && connectedOwners.length < countA) {
        let sumX = 0;
        let sumY = 0;
        for (const oid of connectedOwners) {
          const op = posMap.get(oid);
          sumX += op.x;
          sumY += op.y;
        }
        const cx = sumX / connectedOwners.length;
        const cy = sumY / connectedOwners.length;
        const pull = 0.7;
        const baseX = CONSTELLATION_CX + (cx - CONSTELLATION_CX) * pull;
        const baseY = CONSTELLATION_CY + (cy - CONSTELLATION_CY) * pull;
        const sig = connectedOwners.join("|");
        const slot = slotByOwnerSig.get(sig) || 0;
        slotByOwnerSig.set(sig, slot + 1);
        const spreadAngle = (slot * 137.5) % 360;
        const spreadRad = slot === 0 ? 0 : 44 + Math.floor(slot / 3) * 34;
        const off = polarToCartesian(baseX, baseY, spreadRad, spreadAngle);
        posMap.set(n.id, { x: off.x, y: off.y, ...sm });
      } else {
        const angle = (universalIdx * 137.5) % 360;
        const ring = 44 + (universalIdx % 3) * 44 + Math.floor(universalIdx / 6) * 36;
        universalIdx += 1;
        const pt = polarToCartesian(CONSTELLATION_CX, CONSTELLATION_CY, ring, angle);
        posMap.set(n.id, { x: pt.x, y: pt.y, ...sm });
      }
    });

    const perAnchorLimit = countA <= 4 ? 8 : 6;
    const span = Math.min(130, Math.max(54, Math.round(300 / countA)));
    anchorNodes.forEach((aNode) => {
      const ap = posMap.get(aNode.id);
      const items = (uniqueByAnchor.get(aNode.id) || [])
        .sort((a, b) => Number(b.rarityScore || 0) - Number(a.rarityScore || 0))
        .slice(0, perAnchorLimit);
      layoutAnchorDirectSatellites(aNode, ap, items, span, posMap, placedSatIdSet);
    });
  }

  resolveOrbAndLabelCollisions(posMap, nodeById, null);

  const placedIds = new Set(posMap.keys());
  const placedNodes = [...anchorNodes, ...nonAnchors].filter((n) => placedIds.has(n.id));
  const placedEdges = activeEdges.filter((e) => placedIds.has(e.from) && placedIds.has(e.to));

  let minX = CONSTELLATION_W;
  let minY = CONSTELLATION_H;
  let maxX = 0;
  let maxY = 0;
  for (const pos of posMap.values()) {
    minX = Math.min(minX, pos.x - (pos.halfW || 80));
    minY = Math.min(minY, pos.y - (pos.topPad || 24));
    maxX = Math.max(maxX, pos.x + (pos.halfW || 80));
    maxY = Math.max(maxY, pos.y + (pos.bottomPad || 44));
  }

  return {
    mode: "explorer",
    analysisMode,
    treeMode: "explorer",
    anchorRingRadius,
    focusedGroupKey: null,
    anchorCount: anchorNodes.length,
    anchorIds: anchorIdSet,
    posMap,
    sectorMetaForSvg: [],
    populatedSectors: [],
    nodeById,
    connectedEdgesByNode,
    displayNodes: placedNodes,
    displayEdges: placedEdges,
    totalOuterCount: nonAnchors.length,
    hiddenOuterCount: Math.max(0, nonAnchors.length - (placedNodes.length - anchorNodes.length)),
    bounds: {
      minX: minX - 48,
      minY: minY - 48,
      maxX: maxX + 48,
      maxY: maxY + 48
    }
  };
}

// ---------- SVG Rendering & Curve Construction ----------

function describeSvgArc(cx, cy, radius, startDeg, endDeg) {
  const pStart = polarToCartesian(cx, cy, radius, startDeg);
  const pEnd = polarToCartesian(cx, cy, radius, endDeg);
  const largeArc = Math.abs(endDeg - startDeg) <= 180 ? 0 : 1;
  return `M ${pStart.x.toFixed(1)} ${pStart.y.toFixed(1)} A ${radius} ${radius} 0 ${largeArc} 1 ${pEnd.x.toFixed(1)} ${pEnd.y.toFixed(1)}`;
}

function describeSvgSectorWedge(cx, cy, rInner, rOuter, startDeg, endDeg) {
  const oStart = polarToCartesian(cx, cy, rOuter, startDeg);
  const oEnd = polarToCartesian(cx, cy, rOuter, endDeg);
  const iEnd = polarToCartesian(cx, cy, rInner, endDeg);
  const iStart = polarToCartesian(cx, cy, rInner, startDeg);
  const largeArc = Math.abs(endDeg - startDeg) <= 180 ? 0 : 1;
  return `M ${oStart.x.toFixed(1)} ${oStart.y.toFixed(1)} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${oEnd.x.toFixed(1)} ${oEnd.y.toFixed(1)} L ${iEnd.x.toFixed(1)} ${iEnd.y.toFixed(1)} A ${rInner} ${rInner} 0 ${largeArc} 0 ${iStart.x.toFixed(1)} ${iStart.y.toFixed(1)} Z`;
}

function buildConstellationSvgDefs() {
  const groups = ["access", "lineage", "timing", "caution"];
  const markers = groups
    .map((g) => {
      const col = getContributionColorHex(g);
      return `
        <marker id="arrow-${g}" viewBox="0 0 10 10" refX="7.5" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 1.2 1.8 L 8.8 5 L 1.2 8.2 z" fill="${col}" />
        </marker>
      `;
    })
    .join("");
  const grads = groups
    .map((g) => {
      const col = getContributionColorHex(g);
      return `
        <radialGradient id="halo-grad-${g}" cx="${CONSTELLATION_CX}" cy="${CONSTELLATION_CY}" r="490" gradientUnits="userSpaceOnUse">
          <stop offset="16%" stop-color="${col}" stop-opacity="0.22" />
          <stop offset="68%" stop-color="${col}" stop-opacity="0.08" />
          <stop offset="100%" stop-color="${col}" stop-opacity="0" />
        </radialGradient>
      `;
    })
    .join("");
  return `<defs>${markers}${grads}</defs>`;
}

function buildMapEdgePathData(edge, posMap) {
  const p1 = posMap.get(edge.from);
  const p2 = posMap.get(edge.to);
  if (!p1 || !p2) return null;

  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;

  const r1 = (p1.orbR || 8) + 2;
  const r2 = (p2.orbR || 8) + 5;
  const sx = p1.x + ux * r1;
  const sy = p1.y + uy * r1;
  const ex = p2.x - ux * r2;
  const ey = p2.y - uy * r2;

  const cdx = ex - sx;
  const cdy = ey - sy;
  const chord = Math.max(24, Math.hypot(cdx, cdy));
  const nx = -(cdy / chord);
  const ny = cdx / chord;

  let bowSign = edge.anchorBow ? edge.anchorBow : 1;
  if (edge.isSecondaryOverviewLink) {
    const mx = (sx + ex) / 2;
    const my = (sy + ey) / 2;
    const awayX = mx - CONSTELLATION_CX;
    const awayY = my - CONSTELLATION_CY;
    bowSign = awayX * nx + awayY * ny >= 0 ? 1 : -1;
  }
  const curveScale = edge.isOverviewSpoke ? 0.12 : edge.isSecondaryOverviewLink ? 0.22 : 0.16;
  const curvature = Math.min(82, chord * curveScale) * bowSign;
  const cx = (sx + ex) / 2 + nx * curvature;
  const cy = (sy + ey) / 2 + ny * curvature;

  return `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
}

function buildMapEdgeSvgMarkup(edge, posMap) {
  const d = buildMapEdgePathData(edge, posMap);
  if (!d) return "";
  const rank = String(edge.topSourceRank || "AGGREGATOR").toUpperCase();
  const isSolid = rank === "FILING" || rank === "PRIMARY";
  const cg = getNodeContributionGroup(edge);
  const rarity = Number(edge.rarityScore) || 6;
  const width = Math.min(3.0, Math.max(1.35, 1.25 + rarity * 0.045 + (edge.isSharedEdge ? 0.4 : 0))).toFixed(2);
  const opacity = edge.isGroupDimmedEdge
    ? "0.14"
    : edge.isSecondaryOverviewLink
      ? "0"
      : Math.min(0.86, Math.max(0.42, 0.42 + rarity * 0.015 + (edge.isSharedEdge ? 0.16 : 0))).toFixed(2);
  const color = getContributionColorHex(cg);

  return `
    <g class="edge-group">
      <path
        class="edge-arc ${isSolid ? "is-solid" : "is-dashed"} ${edge.isSharedEdge || edge.isSharedBridge ? "is-shared-edge" : ""} ${edge.isSecondaryOverviewLink ? "is-secondary-overview-link" : ""} ${edge.isGroupDimmedEdge ? "is-group-dimmed" : ""}"
        data-edge-id="${escapeHtml(edge.id)}"
        data-contribution-group="${escapeHtml(cg)}"
        d="${d}"
        stroke="${color}"
        style="color:${color}; stroke-width:${width}px; opacity:${opacity};"
      />
      ${edge.isSecondaryOverviewLink || edge.isGroupDimmedEdge ? "" : `
      <path
        class="edge-hit-target"
        data-edge-id="${escapeHtml(edge.id)}"
        data-edge-from="${escapeHtml(edge.from)}"
        data-edge-to="${escapeHtml(edge.to)}"
        d="${d}"
      />`}
    </g>
  `;
}

function getIsolatedSetForNode(focusNodeId, layout) {
  const activeNodes = new Set();
  const activeEdges = new Set();
  if (!focusNodeId || !layout) return { activeNodes, activeEdges };

  const focusNode = layout.nodeById.get(focusNodeId);
  if (!focusNode) return { activeNodes, activeEdges };
  activeNodes.add(focusNodeId);

  const edges = layout.displayEdges || [];
  if (focusNode.kind === "anchor") {
    const firstHop = new Set();
    for (const e of edges) {
      if (e.from === focusNodeId || e.to === focusNodeId) {
        activeEdges.add(e.id);
        activeNodes.add(e.from);
        activeNodes.add(e.to);
        firstHop.add(e.from === focusNodeId ? e.to : e.from);
      }
    }
    for (const e of edges) {
      if (firstHop.has(e.from) || firstHop.has(e.to)) {
        activeEdges.add(e.id);
        activeNodes.add(e.from);
        activeNodes.add(e.to);
      }
    }
  } else if (focusNode.kind === "group_hub") {
    const downstream = new Set();
    for (const e of edges) {
      if (e.from === focusNodeId || e.to === focusNodeId) {
        activeEdges.add(e.id);
        activeNodes.add(e.from);
        activeNodes.add(e.to);
        downstream.add(e.from === focusNodeId ? e.to : e.from);
      }
    }
    for (const e of edges) {
      if (downstream.has(e.from) && layout.anchorIds.has(e.to)) {
        activeEdges.add(e.id);
      }
    }
  } else {
    const parents = new Set();
    for (const e of edges) {
      if (e.from === focusNodeId || e.to === focusNodeId) {
        activeEdges.add(e.id);
        activeNodes.add(e.from);
        activeNodes.add(e.to);
        parents.add(e.from === focusNodeId ? e.to : e.from);
      }
    }
    for (const e of edges) {
      if (layout.anchorIds.has(e.from) && parents.has(e.to)) {
        activeEdges.add(e.id);
        activeNodes.add(e.from);
      }
    }
  }

  return { activeNodes, activeEdges };
}

function syncClearFocusButton() {
  const btn = $("#mapClearFocusBtn");
  if (!btn) return;
  btn.hidden = !(state.selectedNodeId || state.selectedEdgeId);
}

function restoreDefaultMapStatus() {
  const mappedLabel = state.pinnedEntities.length
    ? `Mapped ${state.pinnedEntities.map((p) => cleanText(p.name)).filter(Boolean).join(" · ")}`
    : "Search any entity above or click a quick pick to map Cala paths.";
  setStatus(mappedLabel);
}

function clearMapIsolation(options = {}) {
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  if (!options.keepHover) {
    state.hoveredNodeId = null;
    state.hoveredEdgeId = null;
  }
  applyPathLaserIsolation();
  const statusText = $("#mapStatus")?.textContent || "";
  if (statusText.includes("Focused signal on constellation map")) {
    restoreDefaultMapStatus();
  }
}

function applyPathLaserIsolation() {
  const svgEl = $("#constellationSvg");
  const nodesLayer = $("#constellationNodesLayer");
  const layout = state.mapLayoutNodes;
  if (!svgEl || !nodesLayer || !layout) {
    syncClearFocusButton();
    return;
  }

  const focusId = state.hoveredNodeId || state.selectedNodeId || null;
  const focusEdgeId = state.hoveredEdgeId || state.selectedEdgeId || null;
  if (!focusId && !focusEdgeId) {
    svgEl.classList.remove("has-isolation");
    svgEl.querySelectorAll(".edge-arc").forEach((el) => el.classList.remove("is-highlighted", "is-path-active"));
    nodesLayer.querySelectorAll(".map-node").forEach((el) => {
      el.classList.remove("is-dimmed", "is-highlighted", "is-path-active");
      if (!el.classList.contains("node-group-hub")) el.classList.remove("is-selected");
    });
    syncClearFocusButton();
    return;
  }

  const activeNodes = new Set();
  const activeEdges = new Set();
  if (focusId) {
    const iso = getIsolatedSetForNode(focusId, layout);
    iso.activeNodes.forEach((id) => activeNodes.add(id));
    iso.activeEdges.forEach((id) => activeEdges.add(id));
  }
  for (const eid of [state.selectedEdgeId, state.hoveredEdgeId]) {
    if (!eid) continue;
    const edge = (layout.displayEdges || []).find((e) => e.id === eid);
    if (edge) {
      activeEdges.add(edge.id);
      activeNodes.add(edge.from);
      activeNodes.add(edge.to);
    }
  }

  svgEl.classList.add("has-isolation");
  svgEl.querySelectorAll(".edge-arc").forEach((el) => {
    const eid = el.getAttribute("data-edge-id");
    const on = activeEdges.has(eid);
    el.classList.toggle("is-highlighted", on);
    el.classList.toggle("is-path-active", on);
  });
  nodesLayer.querySelectorAll(".map-node").forEach((el) => {
    const nid = el.getAttribute("data-node-id");
    const on = activeNodes.has(nid);
    el.classList.toggle("is-highlighted", on);
    el.classList.toggle("is-path-active", on);
    el.classList.toggle("is-dimmed", !on);
    if (!el.classList.contains("node-group-hub")) {
      el.classList.toggle("is-selected", state.selectedNodeId === nid);
    }
  });
  syncClearFocusButton();
}

// ---------- Viewport Pan, Zoom & Fit ----------

function applyMapViewportTransform() {
  const vp = $("#mapPanZoomViewport");
  if (vp) {
    vp.style.transform = `translate(${state.mapPanX}px, ${state.mapPanY}px) scale(${state.mapZoom})`;
  }
  const canvasEl = $("#bridgeMapCanvas");
  if (canvasEl) {
    canvasEl.classList.toggle("is-zoomed-detail", state.mapZoom >= 0.78);
  }
  const readout = $("#mapZoomReadout");
  if (readout) {
    readout.textContent = `${Math.round(state.mapZoom * 100)}%`;
  }
}

function clampZoom(z) {
  return Math.min(1.6, Math.max(0.18, Math.round(z * 100) / 100));
}

function fitConstellationToViewport() {
  const canvasEl = $("#bridgeMapCanvas");
  const layout = state.mapLayoutNodes;
  if (!canvasEl || !layout || !layout.bounds) {
    state.mapZoom = 0.82;
    state.mapPanX = 24;
    state.mapPanY = 20;
    applyMapViewportTransform();
    return;
  }

  const rect = canvasEl.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    state.mapZoom = 0.82;
    state.mapPanX = 24;
    state.mapPanY = 20;
    applyMapViewportTransform();
    return;
  }

  const openLeft = rect.width >= 820 ? 40 : 18;
  const openRight = rect.width - (rect.width >= 820 ? 64 : 18);
  const openTop = rect.width >= 820 ? (state.expandedGroupKey ? 58 : 44) : 34;
  const openBottom = rect.height - 52;

  const availW = Math.max(280, openRight - openLeft);
  const availH = Math.max(240, openBottom - openTop);
  const contentW = Math.max(420, layout.bounds.maxX - layout.bounds.minX);
  const contentH = Math.max(360, layout.bounds.maxY - layout.bounds.minY);

  const maxOverviewFit = layout.mode === "polar" && !state.expandedGroupKey ? 0.86 : 0.94;
  const zoom = clampZoom(Math.min(availW / contentW, availH / contentH, maxOverviewFit));
  const centerContentX = (layout.bounds.minX + layout.bounds.maxX) / 2;
  const centerContentY = (layout.bounds.minY + layout.bounds.maxY) / 2;
  const targetCenterX = (openLeft + openRight) / 2;
  const targetCenterY = (openTop + openBottom) / 2;

  state.mapZoom = zoom;
  state.mapPanX = Math.round(targetCenterX - centerContentX * zoom);
  state.mapPanY = Math.round(targetCenterY - centerContentY * zoom);

  // Guard top-left #exploredEntitiesBox against actual rendered height on desktop
  const boxEl = $("#exploredEntitiesBox");
  if (boxEl && !boxEl.hidden && rect.width >= 820) {
    const boxW = (boxEl.offsetWidth || 260) + 18;
    const boxH = (boxEl.offsetHeight || 42) + 18;
    let pushX = 0;
    let pushY = 0;
    for (const pos of layout.posMap.values()) {
      const syTop = (pos.y - (pos.topPad || 20)) * state.mapZoom + state.mapPanY;
      const sxLeft = (pos.x - (pos.halfW || 60)) * state.mapZoom + state.mapPanX;
      if (syTop < boxH && sxLeft < boxW) {
        pushX = Math.max(pushX, boxW - sxLeft);
        pushY = Math.max(pushY, boxH - syTop);
      }
    }
    if (pushX > 0 && pushY > 0) {
      const rightRoom = Math.max(0, (rect.width - 54) - (layout.bounds.maxX * state.mapZoom + state.mapPanX));
      const bottomRoom = Math.max(0, openBottom - (layout.bounds.maxY * state.mapZoom + state.mapPanY));
      if (pushY <= bottomRoom) state.mapPanY += Math.round(pushY);
      else if (pushX <= rightRoom) state.mapPanX += Math.round(pushX);
    }
  }
  applyMapViewportTransform();
}

function centerConstellationView() {
  const canvasEl = $("#bridgeMapCanvas");
  if (!canvasEl) return;
  const rect = canvasEl.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    fitConstellationToViewport();
    return;
  }
  const layout = state.mapLayoutNodes;
  const cx = layout?.bounds ? (layout.bounds.minX + layout.bounds.maxX) / 2 : CONSTELLATION_CX;
  const cy = layout?.bounds ? (layout.bounds.minY + layout.bounds.maxY) / 2 : CONSTELLATION_CY;
  const openLeft = rect.width >= 820 ? 40 : 18;
  const openRight = rect.width - (rect.width >= 820 ? 64 : 18);
  const openTop = rect.width >= 820 ? (state.expandedGroupKey ? 58 : 44) : 34;
  const openBottom = rect.height - 52;
  state.mapPanX = Math.round((openLeft + openRight) / 2 - cx * state.mapZoom);
  state.mapPanY = Math.round((openTop + openBottom) / 2 - cy * state.mapZoom);
  applyMapViewportTransform();
}

function focusNodeOnMap(nodeId) {
  const canvasEl = $("#bridgeMapCanvas");
  const pos = state.mapLayoutNodes?.posMap?.get(nodeId);
  if (!canvasEl || !pos) return;
  const rect = canvasEl.getBoundingClientRect();
  state.mapPanX = Math.round(rect.width / 2 - pos.x * state.mapZoom);
  state.mapPanY = Math.round(rect.height / 2 - pos.y * state.mapZoom);
  applyMapViewportTransform();
}

function stopMapPhysics() {
  if (state.mapPhysicsRafId !== null) {
    cancelAnimationFrame(state.mapPhysicsRafId);
  }
  for (const element of state.mapLayoutNodes?.nodeElements?.values?.() || []) {
    element.classList.remove("is-physics-running");
  }
  state.mapPhysicsRafId = null;
  state.mapPhysicsLastFrame = 0;
  state.mapPhysics = null;
  state.mapNodeDrag = null;
}

function stabilizeMapLayoutForPhysics(layout, physics) {
  let overlapCount = countMapNodeOverlaps(layout, physics.collisionGap);
  for (let pass = 0; overlapCount > 0 && pass < 8; pass += 1) {
    resolveMapNodeCollisions(layout, physics);
    overlapCount = countMapNodeOverlaps(layout, physics.collisionGap);
  }
  for (const [id, node] of physics.nodes) {
    const pos = layout.posMap.get(id);
    node.homeX = pos.x;
    node.homeY = pos.y;
  }
  for (const link of physics.links) {
    const from = layout.posMap.get(link.from);
    const to = layout.posMap.get(link.to);
    link.restLength = Math.max(24, Math.hypot(to.x - from.x, to.y - from.y));
  }
  layout.renderPositions = new Map(
    [...layout.posMap.entries()].map(([id, pos]) => [id, { x: pos.x, y: pos.y }])
  );
  recomputeMapLayoutBounds(layout, 68);
}

function renderMapPhysicsVisuals(layout = state.mapLayoutNodes) {
  if (!layout?.posMap) return;
  for (const [id, pos] of layout.posMap) {
    const element = layout.nodeElements?.get(id);
    const origin = layout.renderPositions?.get(id);
    if (!element || !origin) continue;
    element.style.setProperty("--physics-dx", `${(pos.x - origin.x).toFixed(2)}px`);
    element.style.setProperty("--physics-dy", `${(pos.y - origin.y).toFixed(2)}px`);
  }
  for (const edge of layout.displayEdges || []) {
    const d = buildMapEdgePathData(edge, layout.posMap);
    if (!d) continue;
    for (const path of layout.edgePathElements?.get(edge.id) || []) path.setAttribute("d", d);
  }
}

function scheduleMapPhysicsFrame() {
  if (state.mapPhysicsRafId !== null || !state.mapPhysics || !state.mapLayoutNodes) return;
  for (const element of state.mapLayoutNodes.nodeElements?.values?.() || []) {
    element.classList.add("is-physics-running");
  }
  state.mapPhysicsRafId = requestAnimationFrame((now) => {
    state.mapPhysicsRafId = null;
    const layout = state.mapLayoutNodes;
    const physics = state.mapPhysics;
    if (!layout || !physics) return;
    const elapsed = state.mapPhysicsLastFrame ? now - state.mapPhysicsLastFrame : 1000 / 60;
    state.mapPhysicsLastFrame = now;
    const stillMoving = stepMapPhysics(layout, physics, elapsed / (1000 / 60));
    renderMapPhysicsVisuals(layout);
    recomputeMapLayoutBounds(layout, 68);
    if (stillMoving) {
      scheduleMapPhysicsFrame();
    } else {
      state.mapPhysicsLastFrame = 0;
      for (const element of layout.nodeElements?.values?.() || []) {
        element.classList.remove("is-physics-running");
      }
    }
  });
}

// ---------- Main Constellation Rendering ----------

function renderConstellationMap(bridgeMapInput = undefined, options = {}) {
  const effMap = bridgeMapInput === undefined ? getEffectiveBridgeMap() : bridgeMapInput;
  const svgEl = $("#constellationSvg");
  const nodesLayer = $("#constellationNodesLayer");
  const emptyEl = $("#constellationEmptyState");
  if (!svgEl || !nodesLayer) return;

  if (!effMap || !asList(effMap.nodes).length) {
    stopMapPhysics();
    svgEl.innerHTML = "";
    nodesLayer.innerHTML = "";
    state.mapLayoutNodes = null;
    const emptyMap = state.workspaceMode === "map" && state.pinnedEntities.length === 0;
    if (emptyEl) {
      emptyEl.hidden = state.workspaceMode !== "map";
      $("#constellationEmptyKicker").textContent = emptyMap ? "Map ready" : "No verified Cala paths in view";
      $("#constellationEmptyTitle").textContent = emptyMap ? "Your map is clear" : "Adjust filters or explore another entity";
      $("#constellationEmptyDesc").textContent = emptyMap
        ? "Search above or use + Add to put another entity on the map."
        : "Only verified Cala relationships with evidence are drawn. Reset active filters or search a new entity above.";
      const resetFiltersBtn = $("#emptyResetFiltersBtn");
      if (resetFiltersBtn) resetFiltersBtn.hidden = emptyMap;
    }
    renderDecisionSummaryWidget();
    return;
  }

  stopMapPhysics();
  const layout = layoutBridgeMapNodes(effMap);
  expandMapLayout(layout, DEFAULT_LINK_DISTANCE_FACTOR);
  state.mapPhysics = createMapPhysics(layout);
  stabilizeMapLayoutForPhysics(layout, state.mapPhysics);
  state.mapLayoutNodes = layout;

  const displayNodes = layout.displayNodes || [];
  const edges = layout.displayEdges || [];
  const anchorNodes = displayNodes.filter((n) => n.kind === "anchor" || n.isFocalEntity);
  const hubNodes = displayNodes.filter((n) => n.kind === "group_hub");
  const outerNodes = displayNodes.filter((n) => n.kind !== "anchor" && !n.isFocalEntity && n.kind !== "group_hub");

  if (emptyEl) {
    emptyEl.hidden = edges.length > 0 || outerNodes.length > 0;
    $("#constellationEmptyKicker").textContent = "No verified Cala paths in view";
    $("#constellationEmptyTitle").textContent = "Adjust filters or explore another entity";
    $("#constellationEmptyDesc").textContent = "Only verified Cala relationships with evidence are drawn. Reset active filters or search a new entity above.";
    const resetFiltersBtn = $("#emptyResetFiltersBtn");
    if (resetFiltersBtn) resetFiltersBtn.hidden = false;
  }

  const backBtnEl = $("#mapDrilldownBackBtn");
  const backBadgeEl = $("#mapDrilldownGroupBadge");
  if (backBtnEl) {
    backBtnEl.hidden = true;
    if (backBadgeEl) backBadgeEl.textContent = "";
  }

  const defsMarkup = buildConstellationSvgDefs();
  let guidesMarkup = "";
  const spacing = layout.linkDistanceFactor || 1;
  if (layout.mode === "teardown" || layout.mode === "polar") {
    const orbitRadii = [
      { r: 248 * spacing, cls: "orbit-guide-ring" },
      { r: 342 * spacing, cls: "orbit-guide-ring is-dashed" }
    ];
    const anchorPos = layout.posMap.get(layout.displayNodes?.[0]?.id) || { x: CONSTELLATION_CX, y: CONSTELLATION_CY };
    const nodeObstacles = outerNodes
      .map((n) => layout.posMap.get(n.id))
      .filter(Boolean)
      .map((p) => ({ x1: p.x - 84, x2: p.x + 84, y1: p.y - 28, y2: p.y + 48 }));
    nodeObstacles.push({ x1: anchorPos.x - 95, x2: anchorPos.x + 95, y1: anchorPos.y - 68, y2: anchorPos.y + 68 });

    const boxesOverlap = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

    const sectorLabelsMarkup = asList(layout.populatedSectors)
      .map((sec) => {
        const sectorNodes = outerNodes.filter((n) => layout.posMap.get(n.id)?.placedRole === sec.role);
        let maxR = 160 * spacing;
        let angleSumSin = 0;
        let angleSumCos = 0;
        for (const n of sectorNodes) {
          const p = layout.posMap.get(n.id);
          if (!p) continue;
          const dx = p.x - anchorPos.x;
          const dy = p.y - anchorPos.y;
          const d = Math.hypot(dx, dy);
          if (d > maxR) maxR = d;
          angleSumCos += Math.cos(Math.atan2(dy, dx));
          angleSumSin += Math.sin(Math.atan2(dy, dx));
        }
        const labelAngle = sectorNodes.length
          ? (Math.atan2(angleSumSin, angleSumCos) * 180) / Math.PI
          : sec.midDeg;
        const anchorAlign = Math.abs(Math.cos((labelAngle * Math.PI) / 180)) < 0.25
          ? "middle"
          : Math.cos((labelAngle * Math.PI) / 180) > 0
            ? "start"
            : "end";
        const labelStr = `${sec.label.toUpperCase()} (${sec.count})`;
        const labelW = labelStr.length * 7.2 + 24;
        let labelR = maxR + 64;
        let pt = polarToCartesian(anchorPos.x, anchorPos.y, labelR, labelAngle);
        for (let pass = 0; pass < 4; pass += 1) {
          const x1 = anchorAlign === "start" ? pt.x : anchorAlign === "end" ? pt.x - labelW : pt.x - labelW / 2;
          const box = { x1, x2: x1 + labelW, y1: pt.y - 16, y2: pt.y + 8 };
          if (!nodeObstacles.some((ob) => boxesOverlap(box, ob))) break;
          labelR += 36;
          pt = polarToCartesian(anchorPos.x, anchorPos.y, labelR, labelAngle);
        }
        return `<text class="sector-cluster-label" x="${pt.x.toFixed(1)}" y="${pt.y.toFixed(1)}" text-anchor="${anchorAlign}">${escapeHtml(labelStr)}</text>`;
      })
      .join("");

    guidesMarkup = `
      ${orbitRadii.map((rg) => `<circle class="${rg.cls}" cx="${anchorPos.x.toFixed(1)}" cy="${anchorPos.y.toFixed(1)}" r="${rg.r}" />`).join("")}
      ${sectorLabelsMarkup}
    `;
  } else if (layout.mode === "perspective") {
    const pPos = layout.posMap.get(layout.perspectiveAnchorId);
    const tPos = layout.posMap.get(layout.primaryTargetAnchorId);
    let coldMarkup = "";
    if (layout.isColdOutreach && pPos && tPos) {
      const mx = (pPos.x + tPos.x) / 2;
      const my = (pPos.y + tPos.y) / 2 - 26;
      coldMarkup = `
        <line class="perspective-cold-line" x1="${pPos.x.toFixed(1)}" y1="${pPos.y.toFixed(1)}" x2="${tPos.x.toFixed(1)}" y2="${tPos.y.toFixed(1)}" />
        <text class="perspective-cold-label" x="${mx.toFixed(1)}" y="${my.toFixed(1)}" text-anchor="middle">COLD OUTREACH · NO SHARED CALA PATH</text>
      `;
    }
    guidesMarkup = `
      <circle class="orbit-guide-ring is-dashed" cx="${CONSTELLATION_CX}" cy="${CONSTELLATION_CY}" r="${420 * spacing}" />
      ${coldMarkup}
    `;
  } else {
    const ringR = Math.round((layout.anchorRingRadius || 360) * spacing);
    if (anchorNodes.length === 2) {
      guidesMarkup = `
        <circle class="orbit-guide-ring is-dashed" cx="${CONSTELLATION_CX}" cy="${CONSTELLATION_CY}" r="${435 * spacing}" />
      `;
    } else {
      const innerR = Math.round(ringR * 0.48);
      guidesMarkup = `
        <circle class="orbit-guide-ring" cx="${CONSTELLATION_CX}" cy="${CONSTELLATION_CY}" r="${innerR}" />
        <circle class="orbit-guide-ring is-dashed" cx="${CONSTELLATION_CX}" cy="${CONSTELLATION_CY}" r="${ringR}" />
      `;
    }
  }

  const edgesMarkup = edges.map((e) => buildMapEdgeSvgMarkup(e, layout.posMap)).join("");
  svgEl.innerHTML = `${defsMarkup}${guidesMarkup}${edgesMarkup}`;

  let nodesHtml = "";
  let targetHubCounter = 0;

  anchorNodes.forEach((aNode, aIdx) => {
    const p = layout.posMap.get(aNode.id);
    if (!p) return;
    const isSel = state.selectedNodeId === aNode.id;
    const isPersp = Boolean(aNode.isPerspectiveEntity || aNode.id === layout.perspectiveAnchorId);
    if (!isPersp) targetHubCounter += 1;
    const pal = isPersp
      ? { hex: "#FF6B5B", glow: "rgba(255, 107, 91, 0.54)", edge: "#B83B2E" }
      : ANCHOR_PALETTE[(aNode.anchorIndex ?? aIdx) % ANCHOR_PALETTE.length];
    const isMultiHub = anchorNodes.length >= 2;
    const fullLabel = formatReadableEntityLabel(nameOf(aNode), aNode.date);
    const conciseLabel = formatCompactEntityName(fullLabel, 2, 18);
    const compareTag = isPersp
      ? `MY PERSPECTIVE · ${typeBadge(aNode)}`
      : isMultiHub
        ? `Target #${targetHubCounter} · ${typeBadge(aNode)}`
        : typeBadge(aNode);

    nodesHtml += `
      <button
        type="button"
        class="map-node is-physics-enabled node-anchor-orb ${isMultiHub ? "is-compare-anchor" : ""} ${isPersp ? "is-perspective-anchor" : ""} ${isSel ? "is-selected" : ""}"
        data-node-kind="anchor"
        data-node-id="${escapeHtml(aNode.id)}"
        aria-label="${escapeHtml(fullLabel)}"
        style="left:${p.x.toFixed(1)}px; top:${p.y.toFixed(1)}px; --orb-color:${pal.hex}; --orb-glow:${pal.glow}; --orb-core-edge:${pal.edge};"
      >
        <span class="orb-core-wrap">
          <span class="orb-halo-ring" aria-hidden="true"></span>
          <span class="orb-core-dot" aria-hidden="true">
            <span class="orb-anchor-inner-name">${escapeHtml(conciseLabel)}</span>
          </span>
        </span>
        <span class="orb-float-label">
          <span class="orb-anchor-kicker">${escapeHtml(compareTag)}</span>
          <span class="orb-label-main"><span class="orb-name-text">${escapeHtml(fullLabel)}</span></span>
        </span>
      </button>
    `;
  });

  for (const hub of hubNodes) {
    const p = layout.posMap.get(hub.id);
    if (!p) continue;
    const cg = hub.groupKey;
    const cgMeta = CONTRIBUTION_VISUAL_META[cg] || CONTRIBUTION_VISUAL_META.access;
    const colHex = getContributionColorHex(cg);
    const colGlow = getContributionGlowRgba(cg);
    const colEdge = cgMeta.darkEdge || colHex;
    const hubSize = p.bridgeSize || computeGroupHubOrbSize(hub.visualWeight);

    nodesHtml += `
      <button
        type="button"
        class="map-node is-physics-enabled node-group-hub ${hub.isExpandedHub ? "is-expanded-hub is-selected" : ""} ${hub.isGroupDimmed ? "is-group-dimmed" : ""} ${hub.isStrongest ? "is-strongest" : ""}"
        data-node-kind="group_hub"
        data-node-id="${escapeHtml(hub.id)}"
        data-group-key="${escapeHtml(cg)}"
        data-contribution-group="${escapeHtml(cg)}"
        aria-label="${escapeHtml(hub.label)} (${escapeHtml(hub.clueMetric)})"
        style="left:${p.x.toFixed(1)}px; top:${p.y.toFixed(1)}px; --orb-color:${colHex}; --orb-glow:${colGlow}; --orb-core-edge:${colEdge}; --hub-size:${hubSize}px;"
      >
        <span class="orb-core-wrap">
          <span class="orb-halo-ring" aria-hidden="true"></span>
          <span class="orb-core-dot" aria-hidden="true"></span>
        </span>
        <span class="orb-float-label hub-float-label">
          <span class="orb-label-main">
            <span class="orb-name-text hub-title-text">${escapeHtml(hub.label)}</span>
          </span>
          <span class="hub-clue-metric">${escapeHtml(hub.clueMetric)}</span>
        </span>
      </button>
    `;
  }

  for (const ent of outerNodes) {
    const p = layout.posMap.get(ent.id);
    if (!p) continue;
    const isSel = state.selectedNodeId === ent.id;
    const cg = (!ent.isSharedOverlap && p.placedGroup) ? p.placedGroup : getNodeContributionGroup(ent);
    const cgMeta = CONTRIBUTION_VISUAL_META[cg] || CONTRIBUTION_VISUAL_META.access;
    const isLight = getActiveTheme() === "light";
    const colHex = ent.isSharedOverlap ? (isLight ? "#D94838" : "#FF6B5B") : getContributionColorHex(cg);
    const colGlow = ent.isSharedOverlap ? "rgba(255, 107, 91, 0.50)" : getContributionGlowRgba(cg);
    const colEdge = cgMeta.darkEdge || colHex;
    const orbSize = p.bridgeSize || computeEntityOrbSize(ent, ent.isSharedOverlap);
    const readable = formatReadableEntityLabel(nameOf(ent), ent.date);
    const shortName = formatCompactEntityName(readable, 2, 19);
    const tTag = typeBadge(ent);
    const sharedBadgeLabel = ent.isSharedOverlap
      ? getSharedImpactBadge(ent, layout.connectedEdgesByNode?.get(ent.id))
      : "";
    const tierClass =
      layout.mode === "teardown"
        ? (outerNodes.length <= 24 ? "is-tier-1" : "is-tier-2")
        : layout.mode === "polar"
          ? "is-tier-2"
          : ent.isSharedOverlap || outerNodes.length <= 36 || p.isTopUniqueLabel
            ? "is-tier-1"
            : "is-tier-2";

    nodesHtml += `
      <button
        type="button"
        class="map-node is-physics-enabled node-startup-orb ${tierClass} ${ent.isSharedOverlap ? "is-shared-overlap" : ""} ${isSel ? "is-selected" : ""}"
        data-node-kind="entity"
        data-node-id="${escapeHtml(ent.id)}"
        data-contribution-group="${escapeHtml(cg)}"
        aria-label="${escapeHtml(ent.isSharedOverlap ? `${sharedBadgeLabel}: ${readable}` : readable)}"
        style="left:${p.x.toFixed(1)}px; top:${p.y.toFixed(1)}px; --orb-color:${colHex}; --orb-glow:${colGlow}; --orb-core-edge:${colEdge}; --entity-orb-size:${orbSize}px;"
      >
        ${ent.isSharedOverlap ? `<span class="orb-shared-bridge-badge" aria-hidden="true">${escapeHtml(sharedBadgeLabel)}</span>` : ""}
        <span class="orb-core-wrap">
          <span class="orb-halo-ring" aria-hidden="true"></span>
          <span class="orb-core-dot" aria-hidden="true"></span>
        </span>
        <span class="orb-float-label">
          <span class="orb-label-main">
            <span class="orb-name-text">${escapeHtml(shortName)}</span>
          </span>
          <span class="orb-entity-type-tag">${escapeHtml(tTag)}</span>
        </span>
      </button>
    `;
  }

  nodesLayer.innerHTML = nodesHtml;
  layout.nodeElements = new Map(
    [...nodesLayer.querySelectorAll(".map-node[data-node-id]")].map((element) => [element.dataset.nodeId, element])
  );
  layout.edgePathElements = new Map();
  for (const path of svgEl.querySelectorAll("[data-edge-id]")) {
    const edgeId = path.dataset.edgeId;
    if (!layout.edgePathElements.has(edgeId)) layout.edgePathElements.set(edgeId, []);
    layout.edgePathElements.get(edgeId).push(path);
  }
  renderMapPhysicsVisuals(layout);
  applyPathLaserIsolation();
  renderDecisionSummaryWidget();
  if (options.fit !== false) {
    fitConstellationToViewport();
  }
}

// ---------- Floating HUD & Filter Controls Sync ----------

function renderExploredEntitiesBox() {
  const listEl = $("#pinnedEntitiesList");
  const drawerEl = $("#exploredCompareDrawer");
  const boxEl = $("#exploredEntitiesBox");
  const toggleBtnEl = $("#toggleCompareBoxBtn");
  const clearQuickBtn = $("#clearMapQuickBtn");
  const modeBadgeEl = $("#anchorModePill");
  if (!listEl) return;

  const count = state.pinnedEntities.length;
  const isDrawerOpen = Boolean(state.compareBoxOpen);
  if (boxEl) boxEl.classList.toggle("is-expanded", isDrawerOpen);
  if (drawerEl) drawerEl.hidden = !isDrawerOpen;
  if (toggleBtnEl) {
    toggleBtnEl.setAttribute("aria-expanded", String(isDrawerOpen));
    toggleBtnEl.classList.toggle("is-active", isDrawerOpen);
    toggleBtnEl.textContent = isDrawerOpen ? "Close" : "+ Add";
  }
  if (clearQuickBtn) {
    clearQuickBtn.hidden = count === 0;
  }
  if (modeBadgeEl) {
    const am = getActiveAnalysisMode();
    modeBadgeEl.textContent =
      am === "perspective_triage"
        ? `Triage · ${state.perspectiveEntity?.name || "Firm"}`
        : am === "single_teardown"
          ? "Company Teardown"
          : `Ecosystem · ${count}`;
  }

  listEl.innerHTML = state.pinnedEntities
    .map((pin, idx) => {
      const pal = ANCHOR_PALETTE[idx % ANCHOR_PALETTE.length];
      const removeBtn = `<button type="button" class="pinned-entity-remove" data-unpin-key="${escapeHtml(pin.id || pin.key)}" aria-label="Remove ${escapeHtml(pin.name)}">x</button>`;
      return `
        <span class="pinned-entity-chip" data-pin-id="${escapeHtml(pin.id || pin.key)}">
          <span class="pinned-entity-dot" style="background:${pal.hex}; color:${pal.hex};"></span>
          <span class="pinned-entity-name" title="${escapeHtml(pin.name)}">${escapeHtml(pin.name)}</span>
          ${isDrawerOpen ? `<span class="pinned-entity-kind">${escapeHtml(typeBadge(pin))}</span>` : ""}
          ${removeBtn}
        </span>
      `;
    })
    .join("");
}

function syncPerspectiveControl() {
  const btn = $("#perspectivePickerBtn");
  const label = $("#perspectivePickerLabel");
  const clearBtn = $("#perspectiveClearBtn");
  const p = state.perspectiveEntity;
  if (label) {
    const shortName = p?.name
      ? (p.name.length > 22 ? `${p.name.slice(0, 20).trimEnd()}…` : p.name)
      : "Neutral";
    label.textContent = `Perspective: ${shortName}`;
  }
  if (btn) btn.classList.toggle("is-active", Boolean(p?.id || p?.name));
  if (clearBtn) clearBtn.hidden = !Boolean(p?.id || p?.name);

  document.querySelectorAll("#perspectiveQuickRow [data-perspective-reset]").forEach((el) => {
    el.classList.toggle("is-selected", !Boolean(p?.id || p?.name));
  });
  document.querySelectorAll("#perspectiveQuickRow [data-perspective-quick]").forEach((el) => {
    const q = String(el.dataset.perspectiveQuick || "").toLowerCase();
    const isMatch = Boolean(p?.name && p.name.toLowerCase().includes(q.split(" ")[0]));
    el.classList.toggle("is-selected", isMatch);
  });
}

function syncLegendForActiveMode() {
  const mode = getActiveAnalysisMode();
  const gridEl = $("#legendPopGrid");
  const ctrlEl = $("#legendPopControls");
  if (gridEl) {
    if (mode === "perspective_triage") {
      const pName = escapeHtml(state.perspectiveEntity?.name || "My Firm");
      gridEl.innerHTML = `
        <span class="leg-item"><span class="fam-dot fam-dot-feeder"></span> Warm Access (Paths from ${pName})</span>
        <span class="leg-item"><span class="fam-dot fam-dot-alumni"></span> Lineage &amp; Governance</span>
        <span class="leg-item"><span class="fam-dot fam-dot-event"></span> Timing (&le;18m Catalyst vs History)</span>
        <span class="leg-item"><span class="fam-dot fam-dot-twin"></span> Caution (Portfolio Overlap &amp; Rivals)</span>
      `;
    } else if (mode === "ecosystem_compare") {
      gridEl.innerHTML = `
        <span class="leg-item"><span class="fam-dot fam-dot-feeder"></span> Capital &amp; Commercial Value Chain</span>
        <span class="leg-item"><span class="fam-dot fam-dot-alumni"></span> Governance, Talent &amp; M&amp;A</span>
        <span class="leg-item"><span class="fam-dot fam-dot-event"></span> Comparative Momentum (&le;18m)</span>
        <span class="leg-item"><span class="fam-dot fam-dot-twin"></span> Dual Backers &amp; Competitive Clashes</span>
      `;
    } else {
      gridEl.innerHTML = `
        <span class="leg-item"><span class="fam-dot fam-dot-feeder"></span> Capital Backers &amp; Value Chain</span>
        <span class="leg-item"><span class="fam-dot fam-dot-alumni"></span> Governance, Leadership &amp; M&amp;A</span>
        <span class="leg-item"><span class="fam-dot fam-dot-event"></span> Catalysts (&le;18m) &amp; History</span>
        <span class="leg-item"><span class="fam-dot fam-dot-twin"></span> Rivals &amp; Disclosure Gaps</span>
      `;
    }
  }
  if (ctrlEl) {
    ctrlEl.textContent =
      mode === "single_teardown"
        ? "Direct structural spokes grouped by role (no artificial rings) · Hover edges for provenance · Click any Entity orb for Cala Dossier"
        : mode === "perspective_triage"
          ? "Asymmetric bridges from your selected firm on left to target(s) on right · Click any Entity orb for full Cala Dossier"
          : "Center spine surfaces shared backers, bottlenecks & talent · Outer spokes show unique direct links · Scroll/trackpad pans & zooms";
  }

  const labelMap = mode === "perspective_triage"
    ? { access: "Access", lineage: "Lineage", timing: "Timing", caution: "Caution" }
    : mode === "single_teardown"
      ? { access: "Capital & Supply", lineage: "Governance & M&A", timing: "Catalysts", caution: "Rivals & Gaps" }
      : { access: "Backers & Chain", lineage: "Talent & M&A", timing: "Momentum", caution: "Risks" };
  document.querySelectorAll("#bridgeFamilySwitcher [data-contribution-group]").forEach((btn) => {
    const cg = btn.dataset.contributionGroup || "all";
    if (cg === "all" || !labelMap[cg]) return;
    const textNodes = [...btn.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (textNodes.length) {
      textNodes[0].textContent = `${labelMap[cg]} `;
    }
  });
}

function syncConstellationControls() {
  const sharedBtn = $("#toggleSharedOnlyBtn");
  if (sharedBtn) {
    sharedBtn.classList.toggle("is-active", state.sharedOnly);
    sharedBtn.setAttribute("aria-pressed", String(state.sharedOnly));
  }
  const filingBtn = $("#chipFilingOnlyBtn");
  if (filingBtn) {
    filingBtn.classList.toggle("is-active", state.filingOnly);
    filingBtn.setAttribute("aria-pressed", String(state.filingOnly));
  }

  document.querySelectorAll("#bridgeFamilySwitcher [data-contribution-group]").forEach((btn) => {
    const cg = btn.dataset.contributionGroup || "all";
    const active = state.contributionGroup === cg;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  });

  const baseEdges = asList(state.bridgeMap?.edges);
  const counts = { all: 0, access: 0, lineage: 0, timing: 0, caution: 0 };
  const seenNodes = { all: new Set(), access: new Set(), lineage: new Set(), timing: new Set(), caution: new Set() };
  for (const e of baseEdges) {
    const cg = getNodeContributionGroup(e);
    const target = e.to;
    if (seenNodes[cg]) {
      seenNodes[cg].add(target);
      seenNodes.all.add(target);
    }
  }
  for (const k of Object.keys(counts)) counts[k] = seenNodes[k].size;

  document.querySelectorAll("[data-contrib-count]").forEach((el) => {
    const k = el.dataset.contribCount;
    el.textContent = counts[k] > 0 ? String(counts[k]) : "";
  });

  const filterPill = $("#filterCountPill");
  const filterCount = countActiveFilters();
  if (filterPill) {
    filterPill.hidden = filterCount === 0;
    filterPill.textContent = String(filterCount);
  }

  syncPerspectiveControl();
  syncLegendForActiveMode();
  renderExploredEntitiesBox();
}

// ---------- Math-First Deterministic Hover Tooltips ----------

function showMapTooltip(clientX, clientY, htmlOrFactory, tipKey = "") {
  const canvasEl = $("#bridgeMapCanvas");
  const tipEl = $("#mapHoverTooltip");
  if (!canvasEl || !tipEl || !htmlOrFactory) return;
  const sameKey = tipKey && !tipEl.hidden && tipEl.dataset.tipKey === tipKey;
  if (!sameKey) {
    const htmlContent = typeof htmlOrFactory === "function" ? htmlOrFactory() : htmlOrFactory;
    if (!htmlContent) return;
    tipEl.innerHTML = htmlContent;
    tipEl.dataset.tipKey = tipKey || "";
    tipEl.hidden = false;
  }

  const rect = canvasEl.getBoundingClientRect();
  const tipW = tipEl.offsetWidth || 340;
  const tipH = tipEl.offsetHeight || 160;
  const minLeft = rect.width >= 900 ? 24 : 12;
  const rightSafePad = document.body.classList.contains("has-rail-open") ? 18 : 68;
  const maxLeft = Math.max(minLeft, rect.width - rightSafePad - tipW - 12);
  const maxTop = Math.max(12, rect.height - tipH - 12);
  const rawLeft = clientX - rect.left + 16;
  const rawTop = clientY - rect.top + 16;
  const flippedLeft = rawLeft > maxLeft ? Math.max(minLeft, clientX - rect.left - tipW - 16) : rawLeft;
  const clampedLeft = Math.max(minLeft, Math.min(maxLeft, flippedLeft));
  const clampedTop = rawTop > maxTop ? Math.max(12, clientY - rect.top - tipH - 16) : Math.max(12, rawTop);
  tipEl.style.left = `${clampedLeft}px`;
  tipEl.style.top = `${Math.min(maxTop, clampedTop)}px`;
}

function hideMapTooltip() {
  const tipEl = $("#mapHoverTooltip");
  if (tipEl) {
    tipEl.hidden = true;
    tipEl.dataset.tipKey = "";
  }
}

const CONTEXT_RELATION_SET = new Set([
  "HEADQUARTERED_IN",
  "LOCATED_IN",
  "OPERATES_IN_COUNTRY",
  "OPERATES_IN_INDUSTRY",
  "CLASSIFIED_AS",
  "HAS_SECTOR",
  "REGISTERED_IN",
  "INCORPORATED_IN"
]);

function deriveEdgeVerdict(edge, targetNode = null) {
  if (!edge) return { key: "context", label: "Neutral Context", shortEffect: "Background metadata." };
  const mode = getActiveAnalysisMode();
  const group = deriveContributionGroupFrontend(edge);
  const rel = String(edge.relation || edge.relationType || "").toUpperCase();
  const structuralRole = deriveStructuralRoleFrontend(edge);
  const isAcquisition = Boolean(edge.isAcquisition || rel.includes("ACQUIRED"));
  const recency = classifyTimingRecencyFrontend(edge);
  const targetType = String(targetNode?.entityType || targetNode?.kind || "").toLowerCase();

  if (
    edge.isCautionFlag ||
    rel.includes("COMPET") ||
    rel.includes("DISPUTE") ||
    rel.includes("LITIGAT") ||
    (group === "caution" && !isAcquisition)
  ) {
    return {
      key: "caution",
      label: "Caution / Risk",
      shortEffect: edge.isSharedBridge
        ? "Direct competitive overlap or conflict - verify differentiation and customer lock-in."
        : "Competitive threat, dispute, or sequence risk flag - verify before proceeding."
    };
  }

  if (isAcquisition) {
    return {
      key: "context",
      label: "Corporate M&A",
      shortEffect: edge.isSharedBridge
        ? "Shared corporate acquisition or subsidiary structure across mapped entities."
        : "Corporate M&A / capital allocation event (not flagged as conflict unless disputed)."
    };
  }

  if (CONTEXT_RELATION_SET.has(rel) || targetType === "country" || targetType === "industry") {
    return {
      key: "context",
      label: "Neutral Context",
      shortEffect: "Geographic or sector metadata - helpful context, not an intro or risk."
    };
  }

  if (structuralRole === "commercial") {
    if (edge.touchesPerspective || edge.isPerspectiveBridge) {
      return {
        key: "beneficial",
        label: "Commercial Bridge (Warm)",
        shortEffect: "Commercial tie connecting your selected firm perspective and target — supports warm reference or ecosystem diligence."
      };
    }
    return {
      key: "context",
      label: "Commercial Value Chain",
      shortEffect: "Supplier, partner, or commercial value-chain tie — evaluate dependency leverage rather than investor warm outreach."
    };
  }

  if (group === "timing" || edge.isTimingCatalyst || recency.isRecentCatalyst || recency.isHistoricalMilestone) {
    if (recency.isRecentCatalyst) {
      return {
        key: "beneficial",
        label: "Active Catalyst (<=18m)",
        shortEffect: `Recent dated catalyst${edge.date ? ` (${edge.date})` : ""} within 18 months indicating active momentum.`
      };
    }
    if (recency.isHistoricalMilestone) {
      return {
        key: "context",
        label: "Historical Milestone (>18m)",
        shortEffect: `Historical capital or corporate milestone${edge.date ? ` (${edge.date})` : ""} older than 18 months.`
      };
    }
    return {
      key: "context",
      label: "Dated Milestone",
      shortEffect: "Verified historical event providing operating timeline context."
    };
  }

  if (edge.touchesPerspective || edge.isPerspectiveBridge) {
    return {
      key: "beneficial",
      label: edge.isLead ? "Warm Access · Lead" : "Warm Route (Perspective)",
      shortEffect: `Direct or 2-hop verified bridge from ${state.perspectiveEntity?.name || "your firm"} supporting warm origination.`
    };
  }

  if (edge.isSharedBridge) {
    return {
      key: "beneficial",
      label: mode === "ecosystem_compare" ? "Shared Ecosystem Tie" : "Beneficial Bridge",
      shortEffect: mode === "ecosystem_compare"
        ? "Shared connection linking multiple mapped entities along the center spine."
        : "Shared connection across mapped companies - strong reference or read-through path."
    };
  }

  if (structuralRole === "governance" || group === "lineage") {
    return {
      key: "beneficial",
      label: "Governance & Leadership",
      shortEffect: "Verified founder, executive, board, or corporate control relationship."
    };
  }

  if (mode === "perspective_triage") {
    return {
      key: edge.isLead ? "beneficial" : "context",
      label: edge.isLead ? "Lead Backer (3rd-Party)" : "Cap-Table Backer",
      shortEffect: edge.isLead
        ? "Lead investor on target's cap table — check syndicate overlap relative to your firm perspective."
        : "Verified external backer on target's cap table."
    };
  }

  return {
    key: "beneficial",
    label: edge.isLead ? "Lead Capital Backer" : "Capital Ownership",
    shortEffect: edge.isLead
      ? "Lead investor stake — high governance influence in ownership structure."
      : "Verified institutional or strategic capital investment link."
  };
}

function buildFourFactorDecisionSummary(bridgeMap) {
  const di = bridgeMap?.decisionIntelligence;
  const quarantinedCount = asList(bridgeMap?.quarantinedAnomalies).length;
  const fallbackMode = getActiveAnalysisMode(bridgeMap);
  const modeDefaultLabels = {
    single_teardown: {
      access: { displayLabel: "Capital & Value Chain", shortTabLabel: "Capital & Stack", question: "Who backs it & who powers its commercial stack?" },
      lineage: { displayLabel: "Governance, Leadership & M&A", shortTabLabel: "Gov & M&A", question: "Who leads, controls, or was acquired by it?" },
      timing: { displayLabel: "Recent Catalysts vs. History", shortTabLabel: "Catalysts", question: "What happened in the last 18 months vs. historical rounds?" },
      caution: { displayLabel: "Rivals, Anomalies & Gaps", shortTabLabel: "Gaps & Rivals", question: "What competitive threats, anomalies, or missing Cala disclosures exist?" }
    },
    ecosystem_compare: {
      access: { displayLabel: "Shared Backers & Bottlenecks", shortTabLabel: "Backers & Stack", question: "Where do cap tables, suppliers, or partnerships converge?" },
      lineage: { displayLabel: "Talent & Corporate Lineage", shortTabLabel: "Talent & M&A", question: "Which leaders, founders, or M&A links span multiple peers?" },
      timing: { displayLabel: "Comparative Momentum", shortTabLabel: "Momentum", question: "Which peers carry recent catalysts (<=18m) vs. older history?" },
      caution: { displayLabel: "Dual-Backer & Rivalry Risk", shortTabLabel: "Rivalry & Risk", question: "What dual-backed conflicts, bottlenecks, or rivalries appear?" }
    },
    perspective_triage: {
      access: { displayLabel: "Warm Intro Access", shortTabLabel: "Warm Access", question: "What verified intro bridge connects your firm to the target(s)?" },
      lineage: { displayLabel: "Team & Spinout Lineage", shortTabLabel: "Lineage", question: "Who founded or leads here, and where are reference backchannels?" },
      timing: { displayLabel: "Active Timing Window", shortTabLabel: "Timing", question: "Do recent <=18m catalysts establish an active deal window?" },
      caution: { displayLabel: "Portfolio & Risk Flags", shortTabLabel: "Risk Flags", question: "What portfolio overlap or competitive conflict needs diligence?" }
    }
  };
  if (di?.factors && di?.executive) {
    const activeM = di.executive.analysisMode || fallbackMode;
    const labelCfg = modeDefaultLabels[activeM] || modeDefaultLabels.ecosystem_compare;
    const factors = ["access", "lineage", "timing", "caution"].map((group) => {
      const f = di.factors[group] || {};
      return {
        group,
        label: f.label || group,
        displayLabel: f.displayLabel || labelCfg[group]?.displayLabel || f.label || group,
        shortTabLabel: f.shortTabLabel || labelCfg[group]?.shortTabLabel || f.label || group,
        sectionQuestion: f.sectionQuestion || labelCfg[group]?.question || GROUP_DECISION_QUESTIONS[group] || "",
        structuralBreakdown: f.structuralBreakdown || null,
        count: Number(f.count || 0),
        sharedCount: Number(f.sharedCount || 0),
        signalStrength: Number(f.signalStrength || 0),
        effect: f.tier || "No Signal",
        effectClass: f.tierClass || "is-neutral",
        line: f.headline || "No verified signal mapped.",
        investmentImpact: f.investmentImpact || "",
        actionableCheck: f.actionableCheck || f.sectionQuestion || GROUP_DECISION_QUESTIONS[group] || "",
        provenanceMix: f.provenanceMix || { filing: 0, primary: 0, press: 0, aggregator: 0, total: 0, verifiedSharePct: 0 },
        coverage: f.coverage || { totalPaths: 0, sharedBridgeCount: 0, hubCoverage: [], uniqueSources: 0, datedCount: 0, undatedCount: 0 },
        sourceIds: asList(f.sourceIds),
        rankedRecords: asList(f.rankedRecords)
      };
    });
    return {
      overall: {
        label: di.executive.verdict || "Limited Coverage",
        cls: di.executive.verdictClass || "is-neutral"
      },
      executive: {
        analysisMode: activeM,
        ...di.executive,
        quarantinedCount
      },
      factors,
      investmentEffect: di.executive.investmentEffect || ""
    };
  }

  const nodes = asList(bridgeMap?.nodes);
  const edges = asList(bridgeMap?.edges);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const byGroup = { access: [], lineage: [], timing: [], caution: [] };
  for (const e of edges) {
    const g = deriveContributionGroupFrontend(e);
    if (byGroup[g]) byGroup[g].push(e);
  }
  const topNames = (list) => {
    const seen = new Set();
    const out = [];
    for (const e of list) {
      const n = nodeById.get(e.to) || nodeById.get(e.from);
      const label = cleanText(n?.label || n?.name || e.label);
      if (label && !seen.has(label) && !n?.isFocalEntity) {
        seen.add(label);
        out.push(label);
      }
      if (out.length >= 2) break;
    }
    return out;
  };
  const accessEdges = byGroup.access.filter((e) => deriveEdgeVerdict(e, nodeById.get(e.to)).key !== "context");
  const accessShared = accessEdges.filter((e) => e.isSharedBridge).length;
  const lineageEdges = byGroup.lineage;
  const lineageShared = lineageEdges.filter((e) => e.isSharedBridge).length;
  const timingEdges = byGroup.timing;
  const totalTiming = timingEdges.length;
  const latestTimingDate = timingEdges.map((e) => e.date).filter(Boolean).sort().pop();
  const cautionEdges = byGroup.caution;
  const idsFrom = (items) => [...new Set(asList(items).flatMap((item) => [
    ...asList(item?.sourceIds),
    item?.sourceId
  ]).filter(Boolean))].slice(0, 4);
  const fallbackLabelCfg = modeDefaultLabels[fallbackMode] || modeDefaultLabels.ecosystem_compare;
  const factors = [
    {
      group: "access",
      label: "Access",
      displayLabel: fallbackLabelCfg.access.displayLabel,
      shortTabLabel: fallbackLabelCfg.access.shortTabLabel,
      count: accessEdges.length,
      sharedCount: accessShared,
      signalStrength: accessEdges.length ? Math.min(95, accessEdges.length * 16 + accessShared * 14) : 0,
      effect: accessShared > 0 ? "Strong" : accessEdges.length > 0 ? "Moderate" : "No Signal",
      effectClass: accessEdges.length > 0 ? "is-beneficial" : "is-neutral",
      line: accessShared > 0
        ? `Shared syndicate bridges (${topNames(accessEdges).join(", ") || accessShared}) unlock warm intros.`
        : accessEdges.length > 0
        ? `Direct backers/partners (${topNames(accessEdges).join(", ") || accessEdges.length}) aid outreach.`
        : "No direct investor or partner paths verified in Cala.",
      investmentImpact: accessEdges.length > 0
        ? "Improves warm access; it does not establish company quality."
        : "No mapped access edge to change the decision.",
      actionableCheck: GROUP_DECISION_QUESTIONS.access,
      provenanceMix: { filing: 0, primary: 0, press: 0, aggregator: 0, total: 0, verifiedSharePct: 0 },
      coverage: { totalPaths: accessEdges.length, sharedBridgeCount: accessShared, hubCoverage: [], uniqueSources: 0, datedCount: 0, undatedCount: accessEdges.length },
      sourceIds: idsFrom(accessEdges),
      rankedRecords: []
    },
    {
      group: "lineage",
      label: "Lineage",
      displayLabel: fallbackLabelCfg.lineage.displayLabel,
      shortTabLabel: fallbackLabelCfg.lineage.shortTabLabel,
      count: lineageEdges.length,
      sharedCount: lineageShared,
      signalStrength: lineageEdges.length ? Math.min(95, lineageEdges.length * 16 + lineageShared * 14) : 0,
      effect: lineageShared > 0 ? "Strong" : lineageEdges.length > 0 ? "Moderate" : "No Signal",
      effectClass: lineageEdges.length > 0 ? "is-beneficial" : "is-neutral",
      line: lineageShared > 0
        ? `Shared founder/exec ties (${topNames(lineageEdges).join(", ") || lineageShared}) give direct reference edge.`
        : lineageEdges.length > 0
        ? `Verified leadership (${topNames(lineageEdges).join(", ") || lineageEdges.length}) supports team diligence.`
        : "No founder or executive lineage links indexed in Cala.",
      investmentImpact: lineageEdges.length > 0
        ? "Supports team diligence and references; execution still needs proof."
        : "Team conviction remains open on this map.",
      actionableCheck: GROUP_DECISION_QUESTIONS.lineage,
      provenanceMix: { filing: 0, primary: 0, press: 0, aggregator: 0, total: 0, verifiedSharePct: 0 },
      coverage: { totalPaths: lineageEdges.length, sharedBridgeCount: lineageShared, hubCoverage: [], uniqueSources: 0, datedCount: 0, undatedCount: lineageEdges.length },
      sourceIds: idsFrom(lineageEdges),
      rankedRecords: []
    },
    {
      group: "timing",
      label: "Timing",
      displayLabel: fallbackLabelCfg.timing.displayLabel,
      shortTabLabel: fallbackLabelCfg.timing.shortTabLabel,
      count: totalTiming,
      sharedCount: 0,
      signalStrength: totalTiming ? Math.min(95, totalTiming * 18) : 0,
      effect: totalTiming >= 3 ? "Active" : totalTiming > 0 ? "Catalyst" : "No Signal",
      effectClass: totalTiming > 0 ? "is-beneficial" : "is-neutral",
      line: totalTiming > 0
        ? `${totalTiming} dated milestones${latestTimingDate ? ` (latest ${latestTimingDate})` : ""} show active momentum.`
        : "No dated funding rounds or milestones verified in Cala.",
      investmentImpact: totalTiming > 0
        ? "Adds a catalyst to diligence; confirm it is current before advancing."
        : "No mapped catalyst to change timing conviction.",
      actionableCheck: GROUP_DECISION_QUESTIONS.timing,
      provenanceMix: { filing: 0, primary: 0, press: 0, aggregator: 0, total: 0, verifiedSharePct: 0 },
      coverage: { totalPaths: totalTiming, sharedBridgeCount: 0, hubCoverage: [], uniqueSources: 0, datedCount: totalTiming, undatedCount: 0 },
      sourceIds: idsFrom(timingEdges),
      rankedRecords: []
    },
    {
      group: "caution",
      label: "Caution",
      displayLabel: fallbackLabelCfg.caution.displayLabel,
      shortTabLabel: fallbackLabelCfg.caution.shortTabLabel,
      count: cautionEdges.length,
      sharedCount: 0,
      signalStrength: cautionEdges.length ? Math.min(95, cautionEdges.length * 22) : 0,
      effect: cautionEdges.length > 0 ? "Risk · Watch" : "Clear",
      effectClass: cautionEdges.length > 0 ? "is-caution" : "is-beneficial",
      line: cautionEdges.length > 0
        ? `${topNames(cautionEdges).join(", ") || `${cautionEdges.length} risk signal(s)`} - check competitive overlap.`
        : "No direct competitor or conflict flags surfaced in Cala.",
      investmentImpact: cautionEdges.length > 0
        ? "Raises diligence risk; investigate before advancing."
        : "No mapped conflict surfaced; this does not rule out risk.",
      actionableCheck: GROUP_DECISION_QUESTIONS.caution,
      provenanceMix: { filing: 0, primary: 0, press: 0, aggregator: 0, total: 0, verifiedSharePct: 0 },
      coverage: { totalPaths: cautionEdges.length, sharedBridgeCount: 0, hubCoverage: [], uniqueSources: 0, datedCount: 0, undatedCount: cautionEdges.length },
      sourceIds: idsFrom(cautionEdges),
      rankedRecords: []
    }
  ];
  const hasBeneficial = accessEdges.length > 0 || lineageEdges.length > 0 || totalTiming > 0;
  const overall = cautionEdges.length > 0 && hasBeneficial
    ? { label: "Actionable · Verify Risks", cls: "is-mixed" }
    : cautionEdges.length > 0
    ? { label: "Caution · Verify Risks", cls: "is-caution" }
    : hasBeneficial
    ? { label: "Beneficial Signals", cls: "is-beneficial" }
    : { label: "Limited Coverage", cls: "is-neutral" };
  return {
    overall,
    executive: {
      verdict: overall.label,
      verdictClass: overall.cls,
      evidenceScore: Math.round(factors.reduce((sum, f) => sum + f.signalStrength, 0) / 4),
      reliabilityGrade: "B",
      verifiedSharePct: 0,
      provenanceMix: { filing: 0, primary: 0, press: 0, aggregator: 0, total: 0, verifiedSharePct: 0 },
      sharedBridgeHighlights: [],
      warmIntroRoutes: [],
      dataAnomalies: [],
      quarantinedCount
    },
    factors,
    investmentEffect: overall.cls === "is-mixed"
      ? "Advance only with targeted diligence: actionable signals coexist with risks."
      : overall.cls === "is-caution"
      ? "Resolve the mapped risk before advancing the investment decision."
      : overall.cls === "is-beneficial"
      ? "Use mapped signals for targeted outreach; verify fundamentals directly."
      : "The map lacks enough evidence to shift the investment decision."
  };
}

function focusDecisionSignalOnMap({ edgeId = "", nodeId = "", group = "" } = {}) {
  if (!state.bridgeMap) return;
  if (state.decisionPanelExpanded) {
    setDecisionPanelExpanded(false);
  }
  state.decisionSummaryOpen = false;
  const pop = $("#decisionSummaryPopover");
  if (pop) pop.hidden = true;
  $("#decisionSummaryToggleBtn")?.setAttribute("aria-expanded", "false");

  const validGroup = ["access", "lineage", "timing", "caution"].includes(group) ? group : "";
  if (validGroup && state.mapLayoutNodes?.mode === "polar" && state.expandedGroupKey !== validGroup) {
    state.expandedGroupKey = validGroup;
    syncConstellationControls();
    renderConstellationMap(undefined, { fit: false });
  }

  const layout = state.mapLayoutNodes;
  const displayEdges = asList(layout?.displayEdges);
  const matchedEdge = edgeId
    ? displayEdges.find((it) => it.id === edgeId)
    : nodeId
    ? displayEdges.find((it) => it.to === nodeId || it.from === nodeId)
    : null;

  if (matchedEdge) {
    state.selectedEdgeId = matchedEdge.id;
    state.selectedNodeId = null;
  } else if (nodeId && layout?.posMap?.has(nodeId)) {
    state.selectedEdgeId = null;
    state.selectedNodeId = nodeId;
  } else if (validGroup && layout?.posMap?.has(`hub-${validGroup}`)) {
    state.selectedEdgeId = null;
    state.selectedNodeId = `hub-${validGroup}`;
  } else {
    state.selectedEdgeId = null;
    state.selectedNodeId = null;
  }

  state.hoveredNodeId = null;
  state.hoveredEdgeId = null;
  applyPathLaserIsolation();
  syncClearFocusButton();

  const focusTarget = matchedEdge
    ? (matchedEdge.realNodeId || (layout?.posMap?.has(matchedEdge.to) ? matchedEdge.to : matchedEdge.from))
    : (nodeId && layout?.posMap?.has(nodeId))
    ? nodeId
    : (validGroup ? `hub-${validGroup}` : null);
  if (focusTarget) focusNodeOnMap(focusTarget);

  renderDecisionSummaryWidget();
  setStatus("Focused signal on constellation map. Click the isolated curve or node to inspect its dossier.");
}

function syncDecisionOverlayBodyClasses() {
  const hasMapNodes = Boolean(state.bridgeMap && asList(state.bridgeMap.nodes).length);
  const isPopOpen = Boolean(state.decisionSummaryOpen && hasMapNodes);
  document.body.classList.toggle("has-decision-popover-open", isPopOpen && !state.decisionPanelExpanded);
  document.body.classList.toggle("has-decision-detail-open", isPopOpen && Boolean(state.decisionDetailView) && !state.decisionPanelExpanded);
}

function resetDecisionPopoverScroll() {
  const pop = $("#decisionSummaryPopover");
  const out = $("#decisionAiOutput");
  const list = $("#decisionFactorList");
  if (pop) pop.scrollTop = 0;
  if (out) out.scrollTop = 0;
  if (list) list.scrollTop = 0;
}

function renderDecisionSummaryWidget() {
  const pillBtn = $("#decisionSummaryToggleBtn");
  const pillDot = $("#decisionPillDot");
  const pillLabel = $("#decisionPillLabel");
  const overallBadge = $("#decisionOverallBadge");
  const gradeBadge = $("#decisionGradeBadge");
  const modeMetaBar = $("#decisionModeMetaBar");
  const factorList = $("#decisionFactorList");
  const bridgeStrip = $("#decisionBridgeStrip");
  const pop = $("#decisionSummaryPopover");
  if (!pillBtn || !factorList) return;

  const bridgeMap = state.bridgeMap;
  if (!bridgeMap || !asList(bridgeMap.nodes).length) {
    pillBtn.disabled = true;
    if (pillLabel) pillLabel.textContent = "Decision · Ready";
    if (pop) pop.hidden = true;
    if (gradeBadge) gradeBadge.hidden = true;
    if (modeMetaBar) {
      modeMetaBar.hidden = true;
      modeMetaBar.innerHTML = "";
    }
    if (bridgeStrip) bridgeStrip.hidden = true;
    $("#decisionAiOutput")?.setAttribute("hidden", "");
    $("#decisionAiPrompt")?.removeAttribute("hidden");
    pop?.classList.remove("has-ai-results");
    setDecisionPanelExpanded(false);
    syncDecisionOverlayBodyClasses();
    return;
  }
  pillBtn.disabled = false;
  syncDecisionOverlayBodyClasses();
  const summary = buildFourFactorDecisionSummary(bridgeMap);
  const activeMode = summary.executive?.analysisMode || getActiveAnalysisMode(bridgeMap);

  const res = currentDecisionAnalysisResult();
  const stance = getOverallStance(summary, res);
  const factorAnalysisMap = new Map(asList(res?.factorAnalyses).map((a) => [a.group, a]));

  if (pillDot) {
    pillDot.className = `decision-pill-dot ${stance.cls}`;
  }
  if (pillLabel) {
    const modePrefix =
      activeMode === "single_teardown"
        ? "Teardown"
        : activeMode === "perspective_triage"
          ? "Triage"
          : "Ecosystem";
    pillLabel.textContent = `${modePrefix} · ${stance.label}`;
  }
  if (overallBadge) {
    overallBadge.className = `decision-verdict-badge ${stance.cls}`;
    overallBadge.textContent = stance.label;
  }
  if (gradeBadge) {
    const hasExec = Boolean(summary.executive && summary.executive.provenanceMix?.total > 0);
    gradeBadge.hidden = !hasExec;
    if (hasExec) {
      const totalPaths = summary.factors.reduce((sum, f) => sum + Number(f.count || 0), 0);
      gradeBadge.textContent = `Real Cala Data · ${sourceQualityPhrase(summary.executive.verifiedSharePct)} · ${totalPaths} paths`;
    }
  }
  if (!summary.factors.some((factor) => factor.group === state.decisionSelectedFactor)) {
    state.decisionSelectedFactor = summary.factors[0]?.group || "access";
  }
  const selectedFactor = summary.factors.find((factor) => factor.group === state.decisionSelectedFactor);
  const title = $(".decision-pop-title");
  if (title) {
    title.textContent = state.decisionDetailView
      ? `${selectedFactor?.displayLabel || selectedFactor?.label || "Factor"} Analysis`
      : activeMode === "single_teardown"
        ? "Company Teardown"
        : activeMode === "perspective_triage"
          ? `Origination Triage · ${state.perspectiveEntity?.name || "Firm"}`
          : "Ecosystem Synthesis";
  }

  if (modeMetaBar) {
    if (state.decisionDetailView) {
      modeMetaBar.hidden = true;
      modeMetaBar.innerHTML = "";
    } else if (activeMode === "single_teardown") {
      const gaps = asList(summary.executive?.missingDisclosures);
      modeMetaBar.hidden = false;
      modeMetaBar.innerHTML = `
        <div class="decision-mode-cta-bar">
          <div class="decision-mode-note">${gaps.length ? `<strong>Cala gaps (${gaps.length}):</strong> ${escapeHtml(gaps[0])}` : "Neutral single-company structural teardown."}</div>
          <div class="decision-cta-actions">
            <button type="button" class="decision-cta-pill" data-cta-add-peer="true">+ Add Peer</button>
            <button type="button" class="decision-cta-pill" data-cta-set-perspective="true">Set Perspective</button>
          </div>
        </div>
      `;
    } else if (activeMode === "ecosystem_compare") {
      const focals = state.pinnedEntities.length ? state.pinnedEntities : asList(bridgeMap.focalEntities);
      const activePrimary = state.primaryTargetId || "";
      const bottlenecks = asList(summary.executive?.sharedCommercialBottlenecks);
      modeMetaBar.hidden = false;
      modeMetaBar.innerHTML = `
        <div class="decision-target-focus-bar">
          <span class="decision-focus-kicker">Evaluate Primary Target:</span>
          <div class="decision-focus-pills" role="group" aria-label="Evaluate mapped entity as primary target">
            <button type="button" class="decision-focus-chip ${!activePrimary ? "is-active" : ""}" data-primary-target-id="">All Peers</button>
            ${focals.slice(0, 4).map((f) => `<button type="button" class="decision-focus-chip ${activePrimary === f.id ? "is-active" : ""}" data-primary-target-id="${escapeHtml(f.id)}">${escapeHtml(f.name)}</button>`).join("")}
          </div>
          ${bottlenecks.length ? `<div class="decision-bottleneck-note"><strong>Shared Bottleneck:</strong> ${escapeHtml(bottlenecks.map((b) => b.name).slice(0, 2).join(", "))}</div>` : ""}
        </div>
      `;
    } else {
      const pName = state.perspectiveEntity?.name || summary.executive?.perspectiveEntity?.name || "My Firm";
      const warmCount = asList(summary.executive?.warmIntroChains).length;
      const conflictCount = asList(summary.executive?.portfolioConflicts).length;
      modeMetaBar.hidden = false;
      modeMetaBar.innerHTML = `
        <div class="decision-mode-cta-bar">
          <div class="decision-mode-note">
            <strong>Seat:</strong> ${escapeHtml(pName)} &middot; ${warmCount > 0 ? `${warmCount} warm intro path${warmCount === 1 ? "" : "s"}` : "Cold outreach"}${conflictCount ? ` &middot; ${conflictCount} portfolio overlap` : ""}
          </div>
          <div class="decision-cta-actions">
            <button type="button" class="decision-cta-pill" data-copy-triage-brief="true">Copy Brief</button>
            <button type="button" class="decision-cta-pill" data-reset-perspective="true">Neutral</button>
          </div>
        </div>
      `;
    }
  }

  factorList.hidden = state.decisionDetailView;
  $("#decisionAiPrompt")?.toggleAttribute("hidden", state.decisionDetailView);
  pop?.classList.toggle("is-expanded", state.decisionPanelExpanded);

  factorList.innerHTML = summary.factors
    .map((f) => {
      const fa = factorAnalysisMap.get(f.group);
      const verdict = getFactorVerdict(f, fa);
      const headline = cleanText(fa?.headline) || f.line;
      const rowLabel = f.displayLabel || f.label;
      return `
      <button
        type="button"
        class="decision-factor-row ${state.decisionSelectedFactor === f.group ? "is-selected" : ""}"
        role="tab"
        id="decisionFactorTab-${escapeHtml(f.group)}"
        aria-controls="decisionAiOutput"
        aria-selected="${state.decisionSelectedFactor === f.group}"
        tabindex="${state.decisionSelectedFactor === f.group ? "0" : "-1"}"
        data-factor-group="${escapeHtml(f.group)}"
      >
        <div class="decision-factor-top">
          <span class="decision-factor-name">
            <span class="fam-dot" style="background:${getContributionColorHex(f.group)}"></span>
            <span>${escapeHtml(rowLabel)}</span>
            <span class="decision-factor-count">(${f.count})</span>
            ${f.sharedCount > 0 ? `<span class="decision-shared-micro">${f.sharedCount} shared</span>` : ""}
          </span>
          <span class="decision-factor-score-wrap">
            <span class="decision-effect-pill ${escapeHtml(verdict.cls)}">${escapeHtml(verdict.label)}</span>
          </span>
        </div>
        <div class="decision-factor-line">${escapeHtml(headline)}</div>
      </button>
    `;
    })
    .join("");

  if (bridgeStrip) {
    const highlights = asList(summary.executive?.sharedBridgeHighlights).slice(0, 2);
    const introFallback = !highlights.length ? asList(summary.executive?.warmIntroRoutes).slice(0, 2) : [];
    const items = highlights.length
      ? highlights.map((h) => ({
          label: h.name,
          sub: `${h.structuralRole === "commercial" ? "Bottleneck" : h.group === "access" ? "Backer" : h.group === "lineage" ? "Lineage" : "Risk"} · ${asList(h.sharedHubs).length || 2} hubs · ${h.sourceRank || "PRIMARY"}`,
          edgeId: h.edgeId || "",
          nodeId: h.nodeId || "",
          group: h.group || "access"
        }))
      : introFallback.map((r) => ({
          label: r.entityName,
          sub: r.touchesPerspective ? `Warm · ${r.focalName}` : r.structuralRole === "commercial" ? `Value Chain · ${r.focalName}` : `${r.isLead ? "Lead" : "Backer"} · ${r.focalName}`,
          edgeId: r.edgeId || "",
          nodeId: r.nodeId || "",
          group: "access"
        }));
    const showStrip = !state.decisionDetailView && items.length > 0;
    bridgeStrip.hidden = !showStrip;
    bridgeStrip.innerHTML = showStrip
      ? `<span class="decision-bridge-kicker">Key Bridges · Click to Locate</span><div class="decision-bridge-chips">${items
          .map(
            (it) => `<button type="button" class="decision-bridge-chip" data-focus-edge-id="${escapeHtml(it.edgeId)}" data-focus-node-id="${escapeHtml(it.nodeId)}" data-focus-group="${escapeHtml(it.group)}"><strong>${escapeHtml(it.label)}</strong><span>${escapeHtml(it.sub)}</span></button>`
          )
          .join("")}</div>`
      : "";
  }
  renderDecisionFactorAnalysis(summary);
}

function setDecisionPanelExpanded(expanded) {
  const pop = $("#decisionSummaryPopover");
  const hud = $("#mapDecisionHud");
  const toggle = $("#decisionSummaryToggleBtn");
  if (!pop) return;
  state.decisionPanelExpanded = Boolean(expanded);
  pop.classList.toggle("is-expanded", state.decisionPanelExpanded);
  pop.setAttribute("aria-modal", String(state.decisionPanelExpanded));
  document.body.classList.toggle("has-expanded-decision", state.decisionPanelExpanded);
  if (state.decisionPanelExpanded) {
    document.body.append(pop);
  } else if (hud && pop.parentElement !== hud) {
    hud.insertBefore(pop, toggle || null);
  }
  syncDecisionOverlayBodyClasses();
}

function fourFactorClaudeCacheKey(summary, bridgeMap) {
  const activeMode = getActiveAnalysisMode(bridgeMap);
  const pId = state.perspectiveEntity?.id || bridgeMap?.perspectiveEntity?.id || "";
  const ptId = state.primaryTargetId || bridgeMap?.primaryTargetId || "";
  const focalNames = asList(bridgeMap?.focalEntities).map((f) => f.name).filter(Boolean);
  const baseNames = focalNames.length ? focalNames : state.pinnedEntities.map((p) => p.name).filter(Boolean);
  const title = baseNames.length
    ? `${baseNames.join(" + ")}${pId ? ` (${state.perspectiveEntity?.name || bridgeMap?.perspectiveEntity?.name || pId})` : ""} · ${activeMode}`
    : `Context Analysis · ${activeMode}`;
  const cacheKey = `4factor:v4:${activeMode}:${pId}:${ptId}:${title}:${JSON.stringify(summary.factors.map((factor) => ({
    group: factor.group,
    count: factor.count,
    signalStrength: factor.signalStrength,
    effect: factor.effect,
    line: factor.line,
    sourceIds: factor.sourceIds,
    records: getDecisionFactorEvidence(bridgeMap, factor).records.slice(0, 6).map((r) => r.path + r.relation)
  })))}`;
  return { title, cacheKey };
}

function collectDecisionSourceMap(bridgeMap, extraSources = []) {
  const sourceObjects = [
    ...asList(extraSources),
    ...(Array.isArray(bridgeMap?.sources) ? bridgeMap.sources : Object.values(bridgeMap?.sources || {})),
    ...(Array.isArray(state.analysis?.sources) ? state.analysis.sources : Object.values(state.analysis?.sources || {}))
  ];
  const map = new Map();
  for (const source of sourceObjects) {
    const id = source?.id || source?.sourceId || source?.source_id;
    if (!id) continue;
    const key = String(id);
    const merged = { ...(map.get(key) || {}), id: key };
    for (const [k, v] of Object.entries(source)) {
      if (v !== undefined && v !== null && v !== "") {
        merged[k] = v;
      }
    }
    map.set(key, merged);
  }
  return map;
}

function getDecisionFactorEvidence(bridgeMap, factor) {
  const sourceById = collectDecisionSourceMap(bridgeMap);
  const ranked = asList(factor?.rankedRecords);
  let records = [];

  const nodeMapForType = new Map(asList(bridgeMap?.nodes).map((n) => [String(n.id), n]));
  if (ranked.length > 0) {
    records = ranked.map((r) => ({
      id: r.id || "",
      edgeId: r.edgeId || "",
      nodeId: r.nodeId || "",
      nodeEntityType: cleanText(r.nodeEntityType || nodeMapForType.get(String(r.nodeId))?.entityType || ""),
      focalEntityId: r.focalEntityId || "",
      type: cleanText(r.type || r.relation || "Mapped path"),
      path: cleanText(r.path || `${r.canonicalFrom || ""} → ${r.canonicalTo || ""}`),
      canonicalFrom: cleanText(r.canonicalFrom || ""),
      canonicalTo: cleanText(r.canonicalTo || ""),
      relation: cleanText(r.relation || "Verified Cala path"),
      detail: cleanText(r.detail || ""),
      date: cleanText(r.date || ""),
      sourceRank: cleanText(r.sourceRank || "AGGREGATOR"),
      structuralRole: r.structuralRole || deriveStructuralRoleFrontend(r),
      isAcquisition: Boolean(r.isAcquisition || String(r.type || r.relation || "").toUpperCase() === "ACQUIRED"),
      timingRecency: r.timingRecency || classifyTimingRecencyFrontend(r).timingRecency,
      isRecentCatalyst: Boolean(r.isRecentCatalyst),
      isHistoricalMilestone: Boolean(r.isHistoricalMilestone),
      touchesPerspective: Boolean(r.touchesPerspective),
      perspectiveChain: asList(r.perspectiveChain).filter(Boolean),
      isSharedBridge: Boolean(r.isSharedBridge),
      isLead: Boolean(r.isLead),
      isAnomaly: Boolean(r.isAnomaly),
      sharedHubs: asList(r.sharedHubs),
      signalWeight: Number(r.signalWeight || 0),
      sourceIds: [...new Set(asList(r.sourceIds).filter(Boolean).map(String))]
    }));
  } else {
    const nodes = new Map(asList(bridgeMap?.nodes).map((node) => [node.id, node]));
    const sourceIdOf = (source) => source?.id || source?.sourceId || source?.source_id || null;
    const readSourceIds = (item) => [...new Set([
      ...asList(item?.sourceIds),
      item?.sourceId,
      ...asList(item?.evidenceSources).map(sourceIdOf)
    ].filter(Boolean).map(String))];
    const edges = asList(bridgeMap?.edges)
      .filter((edge) => !edge.id?.startsWith("tree-spoke-") && deriveContributionGroupFrontend(edge) === factor.group);
    records = edges.map((edge) => {
      const fromNode = nodes.get(edge.from);
      const toNode = nodes.get(edge.to);
      const fromName = cleanText(fromNode?.label || fromNode?.name || edge.from);
      const toName = cleanText(toNode?.label || toNode?.name || edge.to);
      const pathNames = `${fromName} → ${toName}`;
      const relation = cleanText(edge.label || edge.relation || edge.relationType || edge.bridgeFamily || "Verified Cala path");
      const sIds = readSourceIds(edge);
      for (const source of asList(edge.evidenceSources)) {
        const id = sourceIdOf(source);
        if (id && !sourceById.has(String(id))) sourceById.set(String(id), { ...source, id: String(id) });
      }
      const recency = classifyTimingRecencyFrontend(edge);
      const nonFocalNode = (!fromNode?.isFocalEntity && fromNode) || (!toNode?.isFocalEntity && toNode) || toNode || fromNode;
      return {
        id: edge.id || "",
        edgeId: edge.id || "",
        nodeId: nonFocalNode?.id || edge.to || edge.from || "",
        nodeEntityType: cleanText(nonFocalNode?.entityType || "Organization"),
        canonicalFrom: fromName,
        canonicalTo: toName,
        type: cleanText(edge.relationType || edge.relation || edge.bridgeFamily || relation),
        path: pathNames,
        relation,
        detail: cleanText(edge.detail || edge.whyMatters || edge.description),
        date: cleanText(edge.date || edge.asOfDate),
        sourceRank: cleanText(edge.topSourceRank || "AGGREGATOR"),
        structuralRole: deriveStructuralRoleFrontend(edge),
        isAcquisition: Boolean(edge.isAcquisition || String(edge.relation || "").toUpperCase() === "ACQUIRED"),
        timingRecency: recency.timingRecency,
        isRecentCatalyst: recency.isRecentCatalyst,
        isHistoricalMilestone: recency.isHistoricalMilestone,
        touchesPerspective: Boolean(edge.touchesPerspective || edge.isPerspectiveBridge),
        perspectiveChain: asList(edge.perspectiveChain).filter(Boolean),
        isSharedBridge: Boolean(edge.isSharedBridge),
        isLead: Boolean(edge.isLead),
        isAnomaly: Boolean(edge.isAnomaly),
        sourceIds: sIds
      };
    });
  }

  const sourceIds = [...new Set([
    ...asList(factor?.sourceIds).map(String),
    ...records.flatMap((record) => record.sourceIds)
  ])];
  const buckets = new Map();
  for (const record of records) {
    const label = record.type.replace(/_/g, " ").replace(/\s+/g, " ").trim() || "Mapped path";
    buckets.set(label, (buckets.get(label) || 0) + 1);
  }
  const breakdown = [...buckets.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 4);

  return {
    records,
    sources: sourceIds.map((id) => sourceById.get(id)).filter(Boolean),
    sourceIds,
    breakdown
  };
}

function renderProvenanceMixBar(mix = {}) {
  const f = Number(mix.filing || 0);
  const p = Number(mix.primary || 0);
  const r = Number(mix.press || 0);
  const a = Number(mix.aggregator || 0);
  const total = Math.max(1, f + p + r + a);
  const seg = (val, cls, title) => val > 0
    ? `<span class="prov-seg ${cls}" style="width:${Math.max(4, Math.round((val / total) * 100))}%" title="${title}: ${val}"></span>`
    : "";
  const chips = [
    f > 0 ? `<span class="prov-chip is-filing">FILING ${f}</span>` : "",
    p > 0 ? `<span class="prov-chip is-primary">PRIMARY ${p}</span>` : "",
    r > 0 ? `<span class="prov-chip is-press">PRESS ${r}</span>` : "",
    a > 0 ? `<span class="prov-chip is-agg">AGG ${a}</span>` : ""
  ].filter(Boolean).join("");
  return `
    <div class="decision-provenance-block">
      <div class="decision-provenance-track" aria-label="Evidence provenance breakdown">${seg(f, "is-filing", "Filing")}${seg(p, "is-primary", "Primary")}${seg(r, "is-press", "Press")}${seg(a, "is-agg", "Aggregator")}</div>
      <div class="decision-provenance-legend">${chips || `<span class="decision-ai-no-chart">No tier breakdown available.</span>`}</div>
    </div>
  `;
}

function highlightSignalPhrases(rawText) {
  const escaped = escapeHtml(rawText);
  return escaped.replace(
    /(\$[0-9]+(?:\.[0-9]+)?[BMK]?|\b\d{4}-\d{2}-\d{2}\b|\b(?:Series\s+[A-Z]|M&amp;A|[A-Z][a-z]+\s+risk\s+flags?|[A-Z][a-z]+\s+shared|[A-Z][a-z]+\s+dated\s+milestones?|\d+\s+(?:shared|risk|dated|cross-hub))\b)/g,
    '<mark class="decision-key-token">$1</mark>'
  );
}

const FACTOR_ROLE_SUBTITLES = {
  access: "Syndicate & Warm Introduction Routes",
  lineage: "Founder, Alumni & Executive Bridges",
  timing: "Financing Velocity & Milestone Cadence",
  caution: "Competitive Overlap & Governance Watch"
};

const FACTOR_QUESTION_LABELS = {
  access: "Can we get a warm intro?",
  lineage: "Who is behind it?",
  timing: "Is now the moment?",
  caution: "What could go wrong?"
};

const VERDICT_TONE = {
  "Strong signal": "is-beneficial",
  "Positive signal": "is-beneficial",
  "Mixed signal": "is-mixed",
  "Weak signal": "is-neutral",
  "No evidence": "is-neutral",
  "Red flag": "is-caution",
  "Watch item": "is-mixed",
  "No flags found": "is-beneficial"
};

const VERDICT_SHORT_BADGE = {
  "Strong signal": "Strong",
  "Positive signal": "Positive",
  "Mixed signal": "Mixed",
  "Weak signal": "Weak",
  "No evidence": "None",
  "Red flag": "Red flag",
  "Watch item": "Watch",
  "No flags found": "Clear"
};

const STANCE_TONE = {
  "Pursue": "is-beneficial",
  "Pursue with caution": "is-mixed",
  "Monitor": "is-neutral",
  "Insufficient evidence": "is-neutral"
};

function currentDecisionAnalysisResult() {
  return state.decisionAnalysisStatus === "ready" && state.decisionAnalysisResult?.controlPlaneMode === "anthropic-connection-analyst"
    ? state.decisionAnalysisResult
    : null;
}

function getFactorVerdict(factor, analysis = null) {
  const claudeVerdict = cleanText(analysis?.verdict);
  if (claudeVerdict && VERDICT_TONE[claudeVerdict]) {
    return { label: claudeVerdict, cls: VERDICT_TONE[claudeVerdict], fromClaude: true };
  }
  const count = Number(factor?.count || 0);
  const shared = Number(factor?.sharedCount || 0);
  let label;
  if (factor?.group === "caution") {
    label = count === 0 ? "No flags found" : shared > 0 || count >= 3 ? "Red flag" : "Watch item";
  } else if (count === 0) {
    label = "No evidence";
  } else if (shared > 0 || count >= 4) {
    label = "Strong signal";
  } else if (count >= 2) {
    label = "Positive signal";
  } else {
    label = "Weak signal";
  }
  return { label, cls: VERDICT_TONE[label] || "is-neutral", fromClaude: false };
}

function getOverallStance(summary, res = currentDecisionAnalysisResult()) {
  const claudeStance = cleanText(res?.overallStance);
  if (claudeStance && STANCE_TONE[claudeStance]) {
    return { label: claudeStance, cls: STANCE_TONE[claudeStance] };
  }
  const cls = summary?.overall?.cls || "is-neutral";
  const label = cls === "is-mixed"
    ? "Pursue with caution"
    : cls === "is-beneficial"
    ? "Pursue"
    : cls === "is-caution"
    ? "Monitor"
    : "Insufficient evidence";
  return { label, cls: STANCE_TONE[label] };
}

function sourceQualityPhrase(pct) {
  const p = Number(pct || 0);
  if (p >= 60) return "Mostly primary sources";
  if (p >= 30) return "Mixed source quality";
  return "Mostly secondary sources";
}

function isPersonBridgeRecord(rec, bridgeMap = state.bridgeMap) {
  if (!rec) return false;
  if (rec.nodeEntityType) return /^person$/i.test(cleanText(rec.nodeEntityType));
  const nodes = asList(bridgeMap?.nodes);
  const byId = rec.nodeId ? nodes.find((n) => String(n.id) === String(rec.nodeId)) : null;
  if (byId?.entityType) return /^person$/i.test(cleanText(byId.entityType));
  const recFrom = cleanText(rec.canonicalFrom || String(rec.path || "").split(/\s*(?:→|↔)\s*/)[0]).toLowerCase();
  const byName = recFrom ? nodes.find((n) => cleanText(n.label || n.name).toLowerCase() === recFrom) : null;
  return /^person$/i.test(cleanText(byName?.entityType));
}

function deriveConnectionAnalystInsight(rec, factorGroup, findings = []) {
  const recPath = cleanText(rec?.path);
  const recFrom = cleanText(rec?.canonicalFrom || recPath.split(/\s*(?:→|↔)\s*/)[0]);
  const recTo = cleanText(rec?.canonicalTo || recPath.split(/\s*(?:→|↔)\s*/)[1]);
  const firstFromEntity = cleanText(recFrom.split(",")[0]);
  const isPerson = isPersonBridgeRecord(rec);
  for (const f of asList(findings)) {
    const conn = cleanText(f?.connection);
    const meaning = cleanText(f?.meaning);
    if (!conn || !meaning) continue;
    if (isPerson && factorGroup === "access" && /\b(?:institutional\s+investor|vc\s+firm)\b/i.test(meaning)) {
      continue;
    }
    const connLower = conn.toLowerCase();
    const connLeft = cleanText(conn.split(/\s*(?:→|↔)\s*/)[0]).toLowerCase();
    if (
      connLower === recPath.toLowerCase() ||
      (firstFromEntity && firstFromEntity.length > 2 && connLeft.includes(firstFromEntity.toLowerCase()) && !/openai|anthropic/i.test(firstFromEntity))
    ) {
      return meaning;
    }
  }
  const mode = getActiveAnalysisMode();
  const detail = cleanText(rec?.detail);
  const rel = cleanText(rec?.relation || rec?.type);
  const sharedHubs = asList(rec?.sharedHubs).filter(Boolean);
  const role = rec?.structuralRole || deriveStructuralRoleFrontend(rec);
  const isAcq = Boolean(rec?.isAcquisition || String(rec?.type || rec?.relation || "").toUpperCase() === "ACQUIRED");
  const focalNames = new Set([
    ...asList(state.bridgeMap?.focalEntities).map((f) => cleanText(f.name).toLowerCase()),
    ...asList(state.pinnedEntities).map((p) => cleanText(p.name).toLowerCase())
  ].filter(Boolean));
  const targetHub = (focalNames.has(recTo.toLowerCase()) && recTo)
    || (focalNames.has(recFrom.toLowerCase()) && recFrom)
    || recTo
    || "this hub";
  const counterparty = (recFrom && !focalNames.has(recFrom.toLowerCase()))
    ? recFrom
    : (recTo && !focalNames.has(recTo.toLowerCase()))
    ? recTo
    : "";
  if (isAcq) {
    return detail || `Corporate M&A / subsidiary acquisition (${recPath}) shaping asset ownership rather than competitive risk.`;
  }
  if (factorGroup === "access") {
    if (rec?.touchesPerspective && asList(rec?.perspectiveChain).length) {
      return `Warm route from your perspective: ${rec.perspectiveChain.join(" → ")}.`;
    }
    if (role === "commercial") {
      if (rec?.isSharedBridge && sharedHubs.length >= 2) {
        return `Shared commercial bottleneck serving ${sharedHubs.join(" & ")} — assess supplier/partner concentration.`;
      }
      return detail || `Commercial supply or partner link with ${counterparty || targetHub} (value-chain dependency, not investor warm intro).`;
    }
    if (isPerson) {
      if (rec?.isSharedBridge && sharedHubs.length >= 2) {
        return `Shared executive/individual tie across ${sharedHubs.join(" & ")} — verify advisory, angel, or board affiliation.`;
      }
      return detail || `Verified individual executive/insider link to ${targetHub} — confirm role vs. personal angel stake.`;
    }
    if (rec?.isSharedBridge && sharedHubs.length >= 2) {
      return mode === "ecosystem_compare"
        ? `Dual-backed across ${sharedHubs.join(" & ")} — shared institutional investor on both cap tables.`
        : `Backs both ${sharedHubs.join(" & ")} — warm intro route and side-by-side co-investor reference.`;
    }
    if (/lead/i.test(`${rel} ${detail}`)) {
      return `Lead investor in ${targetHub}${counterparty ? ` (${counterparty})` : ""} — primary syndicate anchor for ownership and terms.`;
    }
    if (/invest|back|round/i.test(`${rel} ${detail}`)) {
      return `Verified capital backer of ${targetHub}${counterparty ? ` (${counterparty})` : ""} (${mode === "perspective_triage" ? "cap-table co-investor reference" : "institutional ownership link"}).`;
    }
    return detail || `Strategic value-chain tie with ${counterparty || targetHub}.`;
  }
  if (factorGroup === "lineage") {
    if (rec?.isSharedBridge && sharedHubs.length >= 2) {
      return `Held leadership/founder roles across ${sharedHubs.join(" & ")} — direct operator spillover and backchannel.`;
    }
    return detail || `Verified governance or leadership tie (${rel}) confirming executive control and operator lineage.`;
  }
  if (factorGroup === "timing") {
    if (rec?.isAnomaly) {
      return detail || `Round sequence or timing discrepancy requiring cap-table verification.`;
    }
    if (rec?.isHistoricalMilestone || rec?.timingRecency === "historical_milestone") {
      return detail || `Historical milestone (${rec?.date || ">18m ago"}) providing capital history rather than a current catalyst.`;
    }
    return detail || `Active catalyst (${rec?.date || "within 18m"}) indicating recent financing or corporate momentum.`;
  }
  if (rec?.type === "PORTFOLIO_OVERLAP" || /portfolio.*overlap|portfolio rival/i.test(rel)) {
    return detail || `Overlaps with your perspective firm's portfolio — verify thesis conflict and information walls.`;
  }
  if (rec?.type === "DUAL_SIDED_INVESTOR_CONFLICT" || /shared cap-table/i.test(rel)) {
    return `Holds stakes in both ${recTo || "competitors"} — verify Chinese walls and information-rights boundaries.`;
  }
  if (rec?.type === "CROSS_HUB_TALENT_OVERLAP" || /founder overlap|executive/i.test(rel)) {
    return `Shared founder/exec lineage across ${recTo || "rivals"} — verify IP assignment and non-compete terms.`;
  }
  if (/rivalry|overlap|compet/i.test(`${recPath} ${rel} ${detail}`)) {
    return `Direct product & customer rivalry — check win-rates, moat differentiation, and conflict exposure.`;
  }
  return detail || `${rel} — verify governance and downside exposure before advancing.`;
}

function computeSourceProvenanceMix(sourceIds = [], sourceById = new Map()) {
  const counts = { filing: 0, primary: 0, press: 0, aggregator: 0, total: 0, verifiedSharePct: 0 };
  for (const id of asList(sourceIds)) {
    const src = sourceById.get(String(id));
    const rank = String(src?.sourceRank || src?.source_rank || src?.sourceTier || src?.source_tier || "AGGREGATOR").toUpperCase();
    if (rank.includes("FILING")) counts.filing += 1;
    else if (rank.includes("PRIMARY")) counts.primary += 1;
    else if (rank.includes("PRESS") || rank.includes("NEWS")) counts.press += 1;
    else counts.aggregator += 1;
    counts.total += 1;
  }
  if (counts.total > 0) {
    counts.verifiedSharePct = Math.round(((counts.filing + counts.primary) / counts.total) * 100);
  }
  return counts;
}

function renderDecisionDrawer(key, title, badgeText, bodyHtml, isOpen) {
  return `
    <section class="decision-drawer ${isOpen ? "is-open" : ""}" data-decision-drawer-section="${escapeHtml(key)}">
      <button
        type="button"
        class="decision-drawer-toggle"
        data-decision-drawer="${escapeHtml(key)}"
        aria-expanded="${Boolean(isOpen)}"
        aria-controls="decisionDrawerPanel-${escapeHtml(key)}"
      >
        <span class="decision-drawer-title">${escapeHtml(title)}</span>
        <span class="decision-drawer-right">
          ${badgeText ? `<span class="decision-ai-evidence-count">${escapeHtml(badgeText)}</span>` : ""}
          <span class="decision-drawer-chevron" aria-hidden="true">${isOpen ? "−" : "+"}</span>
        </span>
      </button>
      <div class="decision-drawer-panel" id="decisionDrawerPanel-${escapeHtml(key)}" ${isOpen ? "" : "hidden"}>
        ${bodyHtml}
      </div>
    </section>
  `;
}

function getConnectionRoleTag(rec, bridgeMap = state.bridgeMap) {
  if (!rec) return { label: "Verified Link", cls: "is-tag-muted" };
  const isPerson = isPersonBridgeRecord(rec, bridgeMap);
  if (rec.isAcquisition || String(rec.type || rec.relation || "").toUpperCase() === "ACQUIRED") {
    return { label: "M&A", cls: "is-tag-neutral" };
  }
  if (rec.isRecentCatalyst || rec.timingRecency === "active_catalyst") {
    return { label: "<=18m Catalyst", cls: "is-tag-coral" };
  }
  if (rec.isHistoricalMilestone || rec.timingRecency === "historical_milestone") {
    return { label: "Historical >18m", cls: "is-tag-muted" };
  }
  if (isPerson && rec.structuralRole !== "governance") {
    return { label: "Person Tie", cls: "is-tag-neutral" };
  }
  if (rec.structuralRole === "commercial") {
    return { label: "Value Chain", cls: "is-tag-cream" };
  }
  if (rec.structuralRole === "capital") {
    return { label: rec.isLead ? "Lead Capital" : "Capital", cls: "is-tag-cream" };
  }
  if (rec.structuralRole === "governance") {
    return { label: isPerson ? "Leadership" : "Governance", cls: "is-tag-neutral" };
  }
  return { label: cleanText(rec.relation).slice(0, 18) || "Verified Link", cls: "is-tag-muted" };
}

function mergeExpandedConnectionRecords(records = [], factorGroup = "access", bridgeMap = state.bridgeMap) {
  const rankValue = { FILING: 4, PRIMARY: 3, PRESS: 2, AGGREGATOR: 1 };
  const focalNames = new Set([
    ...asList(bridgeMap?.focalEntities).map((f) => cleanText(f.name).toLowerCase()),
    ...asList(state.pinnedEntities).map((p) => cleanText(p.name).toLowerCase())
  ].filter(Boolean));
  let working = [...records];

  if (factorGroup === "caution" && working.length > 1) {
    const rivalryRecs = working.filter((r) => /rivalry|competitive overlap/i.test(`${r.path} ${r.relation}`));
    if (rivalryRecs.length >= 2) {
      const hubs = [...new Set(rivalryRecs.map((r) => cleanText(r.canonicalFrom || r.path.split(/\s*→\s*/)[0])).filter(Boolean))];
      const target = cleanText(rivalryRecs[0].canonicalTo || rivalryRecs[0].path.split(/\s*→\s*/)[1]);
      const mergedRivalry = {
        ...rivalryRecs[0],
        path: `${hubs.join(" & ")} ↔ ${target}`,
        sharedHubs: hubs,
        sourceIds: [...new Set(rivalryRecs.flatMap((r) => asList(r.sourceIds)))]
      };
      const nonRivalry = working.filter((r) => !/rivalry|competitive overlap/i.test(`${r.path} ${r.relation}`));
      working = [mergedRivalry, ...nonRivalry];
    }
  }

  if (factorGroup === "timing") {
    const seen = new Set();
    return working.filter((rec) => {
      const k = `${cleanText(rec.path).toLowerCase()}::${cleanText(rec.date)}::${cleanText(rec.relation).toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  const grouped = new Map();
  const order = [];
  for (const rawRec of working) {
    let rec = rawRec;
    let recFrom = cleanText(rec.canonicalFrom || String(rec.path || "").split(/\s*(?:→|↔)\s*/)[0]);
    let recTo = cleanText(rec.canonicalTo || String(rec.path || "").split(/\s*(?:→|↔)\s*/)[1]);
    // Orient inbound capital links so backer appears cleanly before focal company (Investor -> Target)
    if (
      factorGroup === "access" &&
      (rec.structuralRole === "capital" || /invest|back|participat/i.test(`${rec.type} ${rec.relation}`)) &&
      recFrom &&
      recTo &&
      focalNames.has(recFrom.toLowerCase()) &&
      !focalNames.has(recTo.toLowerCase())
    ) {
      const flippedFrom = recTo;
      const flippedTo = recFrom;
      rec = { ...rec, canonicalFrom: flippedFrom, canonicalTo: flippedTo, path: `${flippedFrom} → ${flippedTo}` };
      recFrom = flippedFrom;
      recTo = flippedTo;
    }

    const isSynthetic = String(rec.id || "").startsWith("caution:") || String(rec.id || "").startsWith("persp-chain-");
    const canGroup = !isSynthetic && recFrom && !focalNames.has(recFrom.toLowerCase());
    const key = canGroup
      ? `entity::${recFrom.toLowerCase()}::${rec.structuralRole || factorGroup}`
      : `uniq::${cleanText(rec.path).toLowerCase()}::${rec.relation || ""}::${rec.date || ""}`;
    if (!grouped.has(key)) {
      const targets = [...new Set([...asList(rec.sharedHubs), recTo].filter((t) => t && cleanText(t).toLowerCase() !== recFrom.toLowerCase()))];
      grouped.set(key, {
        rec: { ...rec, canonicalFrom: recFrom, canonicalTo: recTo, sourceIds: [...new Set(asList(rec.sourceIds))] },
        targets
      });
      order.push(key);
    } else {
      const bucket = grouped.get(key);
      for (const h of [...asList(rec.sharedHubs), recTo]) {
        if (h && cleanText(h).toLowerCase() !== recFrom.toLowerCase() && !bucket.targets.includes(h)) {
          bucket.targets.push(h);
        }
      }
      bucket.rec.isSharedBridge = Boolean(bucket.rec.isSharedBridge || rec.isSharedBridge || bucket.targets.length >= 2);
      bucket.rec.isLead = Boolean(bucket.rec.isLead || rec.isLead);
      if ((rankValue[String(rec.sourceRank || "").toUpperCase()] || 0) > (rankValue[String(bucket.rec.sourceRank || "").toUpperCase()] || 0)) {
        bucket.rec.sourceRank = rec.sourceRank;
      }
      for (const sid of asList(rec.sourceIds)) {
        if (!bucket.rec.sourceIds.includes(sid)) bucket.rec.sourceIds.push(sid);
      }
      if (!bucket.rec.edgeId && rec.edgeId) bucket.rec.edgeId = rec.edgeId;
      if (!bucket.rec.date && rec.date) bucket.rec.date = rec.date;
    }
  }

  const seenPaths = new Set();
  const deduped = [];
  for (const key of order) {
    const { rec, targets } = grouped.get(key);
    const outRec = (targets.length >= 2 && rec.canonicalFrom && !String(rec.id || "").startsWith("caution:"))
      ? { ...rec, sharedHubs: targets, isSharedBridge: true, path: `${rec.canonicalFrom} → ${targets.join(" & ")}` }
      : rec;
    const normPath = cleanText(outRec.path).toLowerCase();
    if (normPath && seenPaths.has(normPath)) continue;
    if (normPath) seenPaths.add(normPath);
    deduped.push(outRec);
  }

  return deduped.sort((a, b) => {
    const sa = a.isSharedBridge ? 1 : 0;
    const sb = b.isSharedBridge ? 1 : 0;
    if (sb !== sa) return sb - sa;
    const pa = isPersonBridgeRecord(a, bridgeMap) ? 1 : 0;
    const pb = isPersonBridgeRecord(b, bridgeMap) ? 1 : 0;
    if (factorGroup === "access" && pa !== pb) return pa - pb;
    return (rankValue[String(b.sourceRank || "").toUpperCase()] || 0) - (rankValue[String(a.sourceRank || "").toUpperCase()] || 0);
  });
}

function buildExpandedModeSnapshotHtml(summary, factor, activeMode) {
  const exec = summary.executive || {};
  const byGroup = new Map(asList(summary.factors).map((f) => [f.group, f]));
  if (activeMode === "single_teardown") {
    const sbAcc = byGroup.get("access")?.structuralBreakdown || {};
    const sbLin = byGroup.get("lineage")?.structuralBreakdown || {};
    const sbTim = byGroup.get("timing")?.structuralBreakdown || {};
    const gaps = asList(exec.missingDisclosures);
    const gapHtml = gaps.length
      ? `<ul class="decision-snapshot-list">${gaps.slice(0, 3).map((g) => `<li>${escapeHtml(g)}</li>`).join("")}</ul>`
      : `<p class="decision-snapshot-empty">All core governance, capital, commercial, and timing dimensions have verified Cala coverage.</p>`;
    return `
      <section class="decision-snapshot-panel" aria-label="Company structural teardown breakdown">
        <div class="decision-panel-subhead">
          <strong>Cala Structural Breakdown</strong>
          <span>Single-Company Teardown</span>
        </div>
        <div class="decision-snapshot-tiles">
          <div class="decision-snapshot-tile"><span>Capital Backers</span><strong>${Number(sbAcc.capitalCount || 0)}</strong><small>Ownership links</small></div>
          <div class="decision-snapshot-tile"><span>Commercial Stack</span><strong>${Number(sbAcc.commercialCount || 0)}</strong><small>Supply &amp; partners</small></div>
          <div class="decision-snapshot-tile"><span>Leadership &amp; M&amp;A</span><strong>${Number(sbLin.governanceCount || 0) + Number(sbLin.acquisitionCount || 0)}</strong><small>${Number(sbLin.acquisitionCount || 0)} M&amp;A</small></div>
          <div class="decision-snapshot-tile"><span>Timing Catalysts</span><strong>${Number(sbTim.activeCatalystCount || 0)}</strong><small>${Number(sbTim.historicalMilestoneCount || 0)} older (&gt;18m)</small></div>
        </div>
        <div class="decision-snapshot-subblock">
          <span class="decision-ai-section-label">Cala Disclosure Gaps</span>
          ${gapHtml}
        </div>
      </section>
    `;
  }

  if (activeMode === "perspective_triage") {
    const pName = state.perspectiveEntity?.name || exec.perspectiveEntity?.name || "My Firm";
    const warmChains = asList(exec.warmIntroChains);
    const conflicts = asList(exec.portfolioConflicts);
    return `
      <section class="decision-snapshot-panel" aria-label="Origination triage breakdown">
        <div class="decision-panel-subhead">
          <strong>Origination Readiness · ${escapeHtml(pName)}</strong>
          <span>${warmChains.length} warm chain${warmChains.length === 1 ? "" : "s"} · ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}</span>
        </div>
        <div class="decision-snapshot-subblock">
          <span class="decision-ai-section-label">Warm Intro Chains</span>
          ${warmChains.length
            ? `<ul class="decision-snapshot-list">${warmChains.slice(0, 3).map((c) => `<li>${escapeHtml(String(c.chainText || c.bridgeLabel || "").replace(/\s*<->\s*/g, " ↔ ").replace(/\s*->\s*/g, " → "))}</li>`).join("")}</ul>`
            : `<p class="decision-snapshot-empty">No shared Cala path from ${escapeHtml(pName)} — plan direct cold outreach or external advisor intros.</p>`}
        </div>
        <div class="decision-snapshot-subblock">
          <span class="decision-ai-section-label">Portfolio &amp; Overlap Flags</span>
          ${conflicts.length
            ? `<ul class="decision-snapshot-list">${conflicts.slice(0, 3).map((c) => `<li>${escapeHtml(c.reason || `${c.portfolioName} vs ${c.targetName}`)}</li>`).join("")}</ul>`
            : `<p class="decision-snapshot-empty">No portfolio overlap or direct competitor conflict indexed in Cala for ${escapeHtml(pName)}.</p>`}
        </div>
      </section>
    `;
  }

  const hubCoverage = asList(factor.coverage?.hubCoverage);
  const bottlenecks = asList(exec.sharedCommercialBottlenecks);
  const highlights = asList(exec.sharedBridgeHighlights);
  const primaryId = state.primaryTargetId || exec.primaryTargetId || "";
  return `
    <section class="decision-snapshot-panel" aria-label="Cross-entity comparison breakdown">
      <div class="decision-panel-subhead">
        <strong>Cross-Entity Snapshot</strong>
        <span>${escapeHtml(factor.shortTabLabel || factor.label)}</span>
      </div>
      ${hubCoverage.length ? `
        <div class="decision-snapshot-subblock">
          <span class="decision-ai-section-label">Signal Count by Entity</span>
          <div class="decision-snapshot-chips">
            ${hubCoverage.map((h) => `<span class="decision-hub-chip ${primaryId && String(h.id) === String(primaryId) ? "is-primary" : ""}"><b>${escapeHtml(h.name)}</b> ${Number(h.count || 0)}</span>`).join("")}
          </div>
        </div>
      ` : ""}
      <div class="decision-snapshot-subblock">
        <span class="decision-ai-section-label">Shared Bottlenecks &amp; Cross-Hub Bridges</span>
        ${(bottlenecks.length || highlights.length)
          ? `<div class="decision-snapshot-bridge-list">
              ${bottlenecks.slice(0, 2).map((b) => `<button type="button" class="decision-snapshot-bridge-pill is-bottleneck" data-focus-node-id="${escapeHtml(b.nodeId || "")}" data-focus-edge-id="${escapeHtml(b.edgeId || "")}" data-focus-group="access"><strong>${escapeHtml(b.name)}</strong><span>Bottleneck · ${asList(b.sharedHubs).length || 2} hubs</span></button>`).join("")}
              ${highlights.slice(0, 3).map((h) => `<button type="button" class="decision-snapshot-bridge-pill" data-focus-node-id="${escapeHtml(h.nodeId || "")}" data-focus-edge-id="${escapeHtml(h.edgeId || "")}" data-focus-group="${escapeHtml(h.group || "access")}"><strong>${escapeHtml(h.name)}</strong><span>${escapeHtml(h.structuralRole === "commercial" ? "Commercial" : h.entityType === "Person" ? "Leader" : "Shared Backer")} · ${asList(h.sharedHubs).length || 2} hubs</span></button>`).join("")}
            </div>`
          : `<p class="decision-snapshot-empty">No cross-entity shared nodes indexed for this selection; explore direct links on the right.</p>`}
      </div>
    </section>
  `;
}

function renderDecisionFactorAnalysis(summary = buildFourFactorDecisionSummary(state.bridgeMap)) {
  const outEl = $("#decisionAiOutput");
  const promptEl = $("#decisionAiPrompt");
  const pop = $("#decisionSummaryPopover");
  if (!outEl || !summary) return;
  const factor = summary.factors.find((item) => item.group === state.decisionSelectedFactor);
  if (!factor || !state.decisionDetailView) {
    outEl.hidden = true;
    if (promptEl) promptEl.hidden = false;
    pop?.classList.remove("has-ai-results");
    return;
  }

  outEl.hidden = false;
  outEl.setAttribute("aria-live", "polite");
  if (promptEl) promptEl.hidden = true;
  pop?.classList.add("has-ai-results");

  const res = state.decisionAnalysisResult;
  const factorAnalyses = new Map(asList(res?.factorAnalyses).map((item) => [item.group, item]));
  const currentVerdict = getFactorVerdict(factor, factorAnalyses.get(factor.group));

  const switcherHtml = `
    <div class="decision-factor-switcher" role="tablist" aria-label="Switch factor">
      ${summary.factors.map((f) => {
        const fv = getFactorVerdict(f, factorAnalyses.get(f.group));
        return `
        <button
          type="button"
          class="decision-mini-pill ${f.group === factor.group ? "is-active" : ""}"
          role="tab"
          aria-selected="${f.group === factor.group}"
          title="${escapeHtml(f.displayLabel || f.label)}"
          data-switch-factor="${escapeHtml(f.group)}"
        >
          <span class="fam-dot" style="background:${getContributionColorHex(f.group)}"></span>
          <span>${escapeHtml(f.shortTabLabel || f.label)}</span>
          <b class="decision-mini-verdict ${escapeHtml(fv.cls)}">${escapeHtml(VERDICT_SHORT_BADGE[fv.label] || fv.label)}</b>
        </button>
      `;
      }).join("")}
    </div>
  `;

  const navHtml = `
    <div class="decision-ai-navigation">
      <button type="button" class="decision-ai-back" data-decision-back="true">&larr; Factors</button>
      ${switcherHtml}
      <button type="button" class="decision-ai-expand" data-decision-expand="true" aria-pressed="${state.decisionPanelExpanded}">${state.decisionPanelExpanded ? "Return to map" : "Expand"}</button>
    </div>
  `;

  if (state.decisionAnalysisStatus === "loading") {
    outEl.removeAttribute("aria-labelledby");
    outEl.setAttribute("aria-label", `${factor.label} analysis is loading`);
    outEl.innerHTML = `
      ${navHtml}
      <div class="decision-ai-card decision-ai-loading-card">
        <div class="decision-ai-head">
          <span>CLAUDE AI · ANALYZING ALL 4 FACTORS</span>
          <span class="decision-ai-step">${escapeHtml(currentVerdict.label)}</span>
        </div>
        <div class="decision-ai-loading-state" role="status" aria-live="polite">
          <span class="decision-ai-loading-indicator" aria-hidden="true"></span>
          <strong>Synthesizing ${escapeHtml(factor.label.toLowerCase())} & cross-hub signals</strong>
          <span>Grounding every takeaway in verified Cala citations...</span>
        </div>
      </div>
    `;
    return;
  }

  outEl.removeAttribute("aria-label");
  outEl.setAttribute("aria-labelledby", "decisionAiSelectedHeading");
  const factorSummaries = new Map(asList(res?.factorSummaries).map((item) => [item.group, item]));
  const factorInsight = factorSummaries.get(factor.group);
  const factorAnalysis = factorAnalyses.get(factor.group);
  const claudeAnalyzed = state.decisionAnalysisStatus === "ready" && res?.controlPlaneMode === "anthropic-connection-analyst";
  const candidateEffect = cleanText(factorAnalysis?.decisionEffect?.text || factorInsight?.text);
  const mapEffect = cleanText(factor.investmentImpact || factorInsight?.text || factor.line);
  const effectSource = factorAnalysis?.decisionEffectSource;
  const heuristicClaudeEffect = Boolean(candidateEffect && candidateEffect !== mapEffect && candidateEffect !== cleanText(factor.investmentImpact));
  const hasClaudeFactorEffect = claudeAnalyzed && effectSource !== "map-fallback" && effectSource !== "fallback" &&
    (effectSource === "anthropic" || (!effectSource && heuristicClaudeEffect));
  const decisionImpact = hasClaudeFactorEffect ? candidateEffect : (mapEffect || "No verified signal mapped in this factor.");

  const evidenceData = getDecisionFactorEvidence(state.bridgeMap, factor);
  const sourceById = collectDecisionSourceMap(state.bridgeMap, [...evidenceData.sources, ...asList(res?.analysisInput?.sources)]);
  const submittedRecords = evidenceData.records.slice(0, 8);
  const rankOrder = { FILING: 0, PRIMARY: 1, PRESS: 2, AGGREGATOR: 3 };
  const submittedSourceIds = [...new Set([...factor.sourceIds, ...submittedRecords.flatMap((r) => r.sourceIds)])]
    .sort((a, b) => {
      const sa = sourceById.get(String(a)) || {};
      const sb = sourceById.get(String(b)) || {};
      const ra = rankOrder[String(sa.sourceRank || sa.source_rank || "AGGREGATOR").toUpperCase()] ?? 4;
      const rb = rankOrder[String(sb.sourceRank || sb.source_rank || "AGGREGATOR").toUpperCase()] ?? 4;
      if (ra !== rb) return ra - rb;
      const ua = /^https?:\/\//i.test(sa.url || sa.document || "") ? 0 : 1;
      const ub = /^https?:\/\//i.test(sb.url || sb.document || "") ? 0 : 1;
      return ua - ub;
    });
  const decisionEffectSourceIds = asList(factorAnalysis?.decisionEffect?.sourceIds);

  const renderCitations = (sourceIds, max = 3) => asList(sourceIds)
    .slice(0, max)
    .map((id) => {
      const source = sourceById.get(String(id));
      const label = cleanText(source?.publisher || source?.title || `Cala source ${id}`);
      const fullTitle = cleanText(source?.title || label);
      const url = cleanText(source?.url || source?.document || "");
      const safeUrl = /^https?:\/\//i.test(url) ? url : "";
      return safeUrl
        ? `<a class="ai-cite-pill is-link" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(fullTitle)}">${escapeHtml(label)} &#8599;</a>`
        : `<span class="ai-cite-pill" title="${escapeHtml(fullTitle)}">${escapeHtml(label)}</span>`;
    })
    .join("");

  const reasoningList = claudeAnalyzed ? asList(factorAnalysis?.reasoning).slice(0, 3) : [];
  const sourceIdsForFactor = new Set(submittedSourceIds);
  const factorInsights = asList(res?.insights).filter((item) =>
    asList(item.sourceIds).some((id) => sourceIdsForFactor.has(String(id)))
  );
  const factorNextCheck = cleanText(factorAnalysis?.nextCheck || factor.actionableCheck || GROUP_DECISION_QUESTIONS[factor.group]);
  const fallbackLimitation = submittedRecords.length
    ? "Mapped relationships confirm network existence only; they do not establish product quality, revenue traction, or commercial terms."
    : "No mapped Cala records were returned for this factor; verify outside Cala before deciding.";
  const factorLimitation = cleanText(factorAnalysis?.limitation || fallbackLimitation);

  const reasoningHtml = reasoningList.length
    ? `<ul class="decision-ai-bullets">${reasoningList.map((item) => `<li>${escapeHtml(item.text)}</li>`).join("")}</ul>`
    : submittedRecords.length
    ? `<ul class="decision-ai-bullets">${submittedRecords.slice(0, 2).map((r) => `<li>${escapeHtml(r.path)} (${escapeHtml(r.relation)}${r.date ? `, ${escapeHtml(r.date)}` : ""})</li>`).join("")}</ul>`
    : `<p class="decision-ai-no-reasoning">No mapped relationships recorded for this factor.</p>`;

  const crossInsightsHtml = factorInsights.length
    ? `<div class="decision-ai-further"><strong>Cross-Factor Signal</strong><ul class="decision-ai-bullets">${factorInsights.map((it) => `<li>${escapeHtml(it.text)}</li>`).join("")}</ul></div>`
    : "";

  const reasoningDrawerBody = `
    <div class="decision-ai-detail-block">
      <div><span class="decision-ai-section-label">Evidence Reasoning</span>${reasoningHtml}</div>
      ${crossInsightsHtml}
      <div class="decision-ai-limitation"><strong>Scope & Limitation</strong><p>${escapeHtml(factorLimitation)}</p></div>
    </div>
  `;

  const sourceCardsHtml = submittedSourceIds.slice(0, 10).map((id) => sourceById.get(String(id)) || { id, title: `Cala record ${id}` }).map((source) => {
    const title = cleanText(source.title || source.publisher || source.id);
    const publisher = cleanText(source.publisher || source.source || "");
    const rank = cleanText(source.sourceRank || source.source_rank || "");
    const date = cleanText(source.date || source.asOfDate || "");
    const url = cleanText(source.url || source.document || "");
    const externalUrl = /^https?:\/\//i.test(url) ? url : "";
    return `
      <article class="decision-ai-source-card">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml([publisher, rank, date].filter(Boolean).join(" · ") || source.id)}</span>
        </div>
        ${externalUrl ? `<a href="${escapeHtml(externalUrl)}" target="_blank" rel="noopener noreferrer">Open &nearr;</a>` : ""}
      </article>
    `;
  }).join("");

  const formatArrowText = (str) => String(str || "")
    .replace(/\s*<->\s*/g, " \u2194 ")
    .replace(/\s*->\s*/g, " \u2192 ");
  const anomalies = asList(summary.executive?.dataAnomalies);
  const quarantinedCount = Number(summary.executive?.quarantinedCount || 0);
  const dataQualityHtml = (anomalies.length || quarantinedCount > 0)
    ? `
      <div class="decision-quality-box">
        <div class="decision-quality-head">
          <strong>Data Hygiene &amp; Quarantined Flags</strong>
          <span>${quarantinedCount} raw anomalies filtered</span>
        </div>
        ${anomalies.length ? `<ul class="decision-quality-list">${anomalies.slice(0, 2).map((a) => `<li><strong>${escapeHtml(formatArrowText(a.path || a.kind))}:</strong> ${escapeHtml(formatArrowText(a.detail))}</li>`).join("")}</ul>` : `<p class="decision-ai-no-reasoning">No high-severity timing conflicts flagged; raw bulk-crawl and generic edges were quarantined cleanly.</p>`}
      </div>
    `
    : "";

  const sourceProvenanceMix = computeSourceProvenanceMix(submittedSourceIds, sourceById);
  const provMixForDisplay = sourceProvenanceMix.total > 0 ? sourceProvenanceMix : factor.provenanceMix;
  const provBarHtml = renderProvenanceMixBar(provMixForDisplay);

  const sourcesDrawerBody = `
    <div class="decision-sources-wrap">
      ${dataQualityHtml}
      ${provBarHtml}
      <div class="decision-ai-sources-used">${sourceCardsHtml || `<span class="decision-ai-no-chart">No source cards linked.</span>`}</div>
    </div>
  `;

  const statusLabel = hasClaudeFactorEffect
    ? (res?.fromCache ? "CLAUDE · CACHED" : "CLAUDE AI")
    : state.decisionAnalysisStatus === "ready"
    ? "MAP BASELINE"
    : state.decisionAnalysisStatus === "error"
    ? "CLAUDE UNAVAILABLE"
    : "MAP READ";
  const canRetryClaude = Boolean(res?.anthropicConfigured && res?.fallbackReason &&
    !/no mapped citations|not configured/i.test(res.fallbackReason));
  const retryButton = `<button type="button" class="decision-ai-retry" data-decision-retry="true">Retry Claude</button>`;
  const analysisMessage = state.decisionAnalysisStatus === "error"
    ? `<div class="decision-ai-fallback" role="alert"><span>Claude unavailable: ${escapeHtml(state.decisionAnalysisError)}</span>${retryButton}</div>`
    : res?.fallbackReason
    ? `<div class="decision-ai-fallback" role="status"><span>${escapeHtml(res.fallbackReason)}</span>${canRetryClaude ? retryButton : ""}</div>`
    : "";

  const kpiStripHtml = `
    <div class="decision-ai-metrics" aria-label="Cala evidence metrics">
      <div><span>Paths</span><strong>${factor.count.toLocaleString()}</strong><small>${factor.sharedCount ? `${factor.sharedCount} shared` : "direct links"}</small></div>
      <div><span>Verified</span><strong>${provMixForDisplay?.verifiedSharePct ?? 0}%</strong><small>FILING / PRIMARY</small></div>
      <div><span>Sources</span><strong>${submittedSourceIds.length}</strong><small>${factor.coverage?.datedCount || 0} dated</small></div>
    </div>
  `;

  const roleSubtitle = factor.displayLabel || FACTOR_ROLE_SUBTITLES[factor.group] || `${factor.label} Signal Profile`;
  const factorQuestion = factor.sectionQuestion || FACTOR_QUESTION_LABELS[factor.group] || roleSubtitle;
  const factorHeadline = cleanText(factorAnalysis?.headline) || roleSubtitle;
  const factorColor = getContributionColorHex(factor.group);
  const findingsList = asList(factorAnalysis?.findings);

  const connectionRowsHtml = submittedRecords.length
    ? `<div class="decision-ai-evidence-list">${submittedRecords.map((rec) => {
        const canFocus = Boolean(rec.edgeId || rec.nodeId);
        const analystInsight = deriveConnectionAnalystInsight(rec, factor.group, findingsList);
        return `
          <article class="decision-ai-evidence-row">
            <div class="decision-ai-record-head">
              <strong>${escapeHtml(rec.path)}</strong>
              <span class="decision-row-badges">
                ${rec.isSharedBridge ? `<span class="decision-badge-shared">Shared</span>` : ""}
                <span class="source-tier" data-tier="${escapeHtml(rec.sourceRank || "AGGREGATOR")}">${escapeHtml(rec.sourceRank || "AGG")}</span>
              </span>
            </div>
            <p class="decision-connection-insight"><span class="decision-insight-prefix">Insight:</span> ${escapeHtml(analystInsight)}</p>
            <div class="decision-ai-record-meta">
              <span>${rec.date ? escapeHtml(rec.date) : "Verified in Cala"} · ${escapeHtml(rec.relation)}</span>
              ${canFocus ? `<button type="button" class="decision-focus-btn" data-focus-edge-id="${escapeHtml(rec.edgeId || "")}" data-focus-node-id="${escapeHtml(rec.nodeId || "")}" data-focus-group="${escapeHtml(factor.group)}">Focus map</button>` : ""}
            </div>
          </article>
        `;
      }).join("")}</div>`
    : `<div class="decision-ai-no-chart">No mapped relationship records for this factor.</div>`;

  const factorHeadHtml = state.decisionPanelExpanded
    ? `
      <div class="decision-ai-factor-head is-expanded-hero">
        <div class="decision-head-titles">
          <div class="decision-factor-top-meta">
            <span class="decision-factor-question-kicker">${escapeHtml(factorQuestion)}</span>
            <span class="decision-verdict-hero-pill ${escapeHtml(currentVerdict.cls)}">${escapeHtml(currentVerdict.label)}</span>
            <span class="decision-mode-tag ${hasClaudeFactorEffect ? "is-claude" : ""}">${statusLabel}</span>
          </div>
          <div class="decision-hero-title-row">
            <strong id="decisionAiSelectedHeading">${escapeHtml(factorHeadline)}</strong>
          </div>
          <div class="decision-head-meter is-wide">
            <span class="decision-hero-submeta">${factor.count} verified paths · ${factor.sharedCount ? `${factor.sharedCount} cross-hub shared` : "direct links"} · ${provMixForDisplay.verifiedSharePct ?? 0}% Filing/Primary (${submittedSourceIds.length} Cala sources)</span>
          </div>
        </div>
      </div>
    `
    : `
      <div class="decision-ai-factor-head">
        <div class="decision-head-left">
          <span class="fam-dot" style="background:${factorColor}"></span>
          <div class="decision-head-titles">
            <span class="decision-factor-question-kicker">${escapeHtml(factorQuestion)}</span>
            <strong id="decisionAiSelectedHeading">${escapeHtml(roleSubtitle)}</strong>
          </div>
        </div>
        <div class="decision-head-right">
          <span class="decision-effect-pill ${escapeHtml(currentVerdict.cls)}">${escapeHtml(currentVerdict.label)}</span>
          <span class="decision-mode-tag ${hasClaudeFactorEffect ? "is-claude" : ""}">${statusLabel}</span>
        </div>
      </div>
    `;

  const compactCalaStripHtml = `
    <div class="cala-provenance-strip">
      <span class="cala-provenance-copy"><span class="cala-trust-dot" aria-hidden="true"></span><span class="cala-provenance-text"><strong>Real Cala Data</strong> · ${provMixForDisplay.verifiedSharePct ?? 0}% Primary/Filing · ${submittedSourceIds.length} sources</span></span>
      <button type="button" class="decision-cite-count is-interactive" data-open-sources-drawer="true">Inspect &#8595;</button>
    </div>
  `;

  const citeCountControlHtml = decisionEffectSourceIds.length
    ? `<button type="button" class="decision-cite-count is-interactive" data-open-sources-drawer="true" title="View verified sources">${decisionEffectSourceIds.length} cited &#8595;</button>`
    : "";

  const takeawayBlockHtml = `
    <div class="decision-ai-impact-block ${hasClaudeFactorEffect ? "" : "is-fallback"}">
      <div class="decision-takeaway-top">
        <span class="decision-ai-section-label">${hasClaudeFactorEffect ? "Why This Matters To Your Decision" : "Map Takeaway"}</span>
        ${citeCountControlHtml}
      </div>
      <p>${highlightSignalPhrases(decisionImpact)}</p>
      ${decisionEffectSourceIds.length ? `<div class="decision-ai-citations">${renderCitations(decisionEffectSourceIds, state.decisionPanelExpanded ? 3 : 2)}</div>` : ""}
    </div>
    <div class="decision-ai-next-check">
      <span class="decision-ai-section-label">Action / Diligence Question</span>
      <p>${escapeHtml(factorNextCheck)}</p>
    </div>
  `;

  if (state.decisionPanelExpanded) {
    const exec = summary.executive || {};
    const activeMode = exec.analysisMode || getActiveAnalysisMode(state.bridgeMap);
    const overallStance = getOverallStance(summary, res);
    const icTakeaway = cleanText((claudeAnalyzed && res?.summary) || summary.investmentEffect);
    const expDrawers = state.decisionExpandedOpenDrawers || { icThesis: false, reasoning: false, sourcesList: false, hygiene: false };
    const ptsCount = reasoningList.length || Math.min(2, submittedRecords.length);

    const displayRecords = mergeExpandedConnectionRecords(submittedRecords, factor.group, state.bridgeMap);
    const compactConnectionRowsHtml = displayRecords.length
      ? `<div class="decision-ai-evidence-list is-compact-table">${displayRecords.slice(0, 6).map((rec) => {
          const canFocus = Boolean(rec.edgeId || rec.nodeId);
          const analystInsight = deriveConnectionAnalystInsight(rec, factor.group, findingsList);
          const roleTag = getConnectionRoleTag(rec, state.bridgeMap);
          return `
            <article class="decision-ai-evidence-row is-insight-card">
              <div class="decision-insight-card-top">
                <strong class="decision-compact-path">${escapeHtml(rec.path)}</strong>
                ${canFocus ? `<button type="button" class="decision-focus-btn" data-focus-edge-id="${escapeHtml(rec.edgeId || "")}" data-focus-node-id="${escapeHtml(rec.nodeId || "")}" data-focus-group="${escapeHtml(factor.group)}">Focus map</button>` : ""}
              </div>
              <div class="decision-insight-card-badges">
                <span class="decision-role-tag ${escapeHtml(roleTag.cls)}">${escapeHtml(roleTag.label)}</span>
                ${rec.isSharedBridge ? `<span class="decision-badge-shared">Shared</span>` : ""}
                ${rec.date ? `<span class="decision-date-tag">${escapeHtml(rec.date)}</span>` : ""}
                <span class="source-tier" data-tier="${escapeHtml(rec.sourceRank || "AGGREGATOR")}">${escapeHtml(rec.sourceRank || "AGG")}</span>
              </div>
              <p class="decision-connection-meaning">${escapeHtml(analystInsight)}</p>
            </article>
          `;
        }).join("")}</div>`
      : `<div class="decision-ai-no-chart">No mapped relationship records for this factor.</div>`;

    const modeBadgeLabel = activeMode === "single_teardown"
      ? "Single-Company Teardown"
      : activeMode === "perspective_triage"
        ? `Origination Triage · ${state.perspectiveEntity?.name || exec.perspectiveEntity?.name || "Firm"}`
        : "Ecosystem Comparison";

    let expandedModeControlsHtml = "";
    if (activeMode === "ecosystem_compare") {
      const focals = state.pinnedEntities.length ? state.pinnedEntities : asList(state.bridgeMap?.focalEntities);
      const activePrimary = state.primaryTargetId || "";
      expandedModeControlsHtml = `
        <div class="decision-exec-mode-controls">
          <span class="decision-focus-kicker">Evaluate Primary Target:</span>
          <div class="decision-focus-pills" role="group" aria-label="Evaluate mapped entity as primary target">
            <button type="button" class="decision-focus-chip ${!activePrimary ? "is-active" : ""}" data-primary-target-id="">All Peers</button>
            ${focals.slice(0, 4).map((f) => `<button type="button" class="decision-focus-chip ${activePrimary === f.id ? "is-active" : ""}" data-primary-target-id="${escapeHtml(f.id)}">${escapeHtml(f.name)}</button>`).join("")}
          </div>
        </div>
      `;
    } else if (activeMode === "single_teardown") {
      const gaps = asList(exec.missingDisclosures);
      expandedModeControlsHtml = `
        <div class="decision-exec-mode-controls">
          <span class="decision-mode-note">${gaps.length ? `<strong>${gaps.length} Cala disclosure gap${gaps.length === 1 ? "" : "s"}</strong> surfaced below.` : "Neutral structural company teardown."}</span>
          <div class="decision-cta-actions">
            <button type="button" class="decision-cta-pill" data-cta-add-peer="true">+ Add Peer</button>
            <button type="button" class="decision-cta-pill" data-cta-set-perspective="true">Set Perspective</button>
          </div>
        </div>
      `;
    } else {
      const pName = state.perspectiveEntity?.name || exec.perspectiveEntity?.name || "My Firm";
      expandedModeControlsHtml = `
        <div class="decision-exec-mode-controls">
          <span class="decision-mode-note"><strong>Perspective Seat:</strong> ${escapeHtml(pName)}</span>
          <div class="decision-cta-actions">
            <button type="button" class="decision-cta-pill" data-copy-triage-brief="true">Copy Brief</button>
            <button type="button" class="decision-cta-pill" data-reset-perspective="true">Reset Neutral</button>
          </div>
        </div>
      `;
    }

    const expandedSourcesDrawerHtml = renderDecisionDrawer(
      "exp-sources",
      "Inspect Source Links & Hygiene",
      `${submittedSourceIds.length} sources${quarantinedCount > 0 ? ` · ${quarantinedCount} filtered` : ""}`,
      `<div class="decision-sources-wrap">${dataQualityHtml}<div class="decision-ai-sources-used">${sourceCardsHtml || `<span class="decision-ai-no-chart">No source cards linked.</span>`}</div></div>`,
      Boolean(expDrawers.sourcesList)
    );

    const expandedReasoningDrawerHtml = renderDecisionDrawer(
      "exp-reasoning",
      "Additional Reasoning & Scope Limitation",
      `${ptsCount} ${ptsCount === 1 ? "point" : "points"}`,
      reasoningDrawerBody,
      Boolean(expDrawers.reasoning)
    );

    const snapshotHtml = buildExpandedModeSnapshotHtml(summary, factor, activeMode);
    const connCountMeta = displayRecords.length < factor.count
      ? `${displayRecords.length} key links (${factor.count} paths)`
      : `${displayRecords.length} verified link${displayRecords.length === 1 ? "" : "s"}`;

    outEl.innerHTML = `
      ${navHtml}
      <div class="decision-exec-banner is-streamlined">
        <div class="decision-exec-top">
          <span class="decision-exec-mode-badge">${escapeHtml(modeBadgeLabel)}</span>
          <span class="decision-verdict-badge ${escapeHtml(overallStance.cls)}">${escapeHtml(overallStance.label)}</span>
          <div class="decision-exec-kpi-pills">
            <span class="decision-cala-verified-badge"><span class="cala-trust-dot" aria-hidden="true"></span><b>Real Cala Data</b> · ${exec.verifiedSharePct ?? 0}% Filing/Primary</span>
            <span class="decision-exec-pill"><b>${factor.count}</b> ${escapeHtml(factor.shortTabLabel || factor.label)} paths</span>
            <span class="decision-exec-pill"><b>${submittedSourceIds.length}</b> cited Cala sources</span>
          </div>
          ${quarantinedCount > 0 ? `<span class="decision-exec-quarantine">${quarantinedCount} raw noise filtered</span>` : ""}
        </div>
        ${icTakeaway ? `<p class="decision-exec-ic">${escapeHtml(icTakeaway)}</p>` : ""}
        ${expandedModeControlsHtml}
      </div>
      <div class="decision-workspace-grid">
        <div class="decision-col-primary">
          <section class="decision-ai-factor-panel is-hero-panel" aria-label="${escapeHtml(factor.label)} analysis">
            ${factorHeadHtml}
            ${takeawayBlockHtml}
            ${expandedReasoningDrawerHtml}
            ${analysisMessage}
          </section>
          ${snapshotHtml}
        </div>
        <div class="decision-col-evidence">
          <section class="decision-evidence-panel">
            <div class="decision-panel-subhead"><strong>Key Connections &amp; What They Mean</strong><span>${escapeHtml(connCountMeta)}</span></div>
            ${compactConnectionRowsHtml}
          </section>
          <section class="decision-evidence-panel">
            <div class="decision-panel-subhead"><strong>Evidence Provenance &amp; Sources</strong><span>${submittedSourceIds.length} Cala sources · ${provMixForDisplay.verifiedSharePct ?? 0}% Filing/Primary</span></div>
            <div class="decision-cala-assurance"><span class="cala-trust-dot" aria-hidden="true"></span><span>Contributed strictly by <strong>real, verified Cala Knowledge Graph records &amp; filings</strong> — zero synthetic estimates.</span></div>
            ${provBarHtml}
            ${expandedSourcesDrawerHtml}
          </section>
        </div>
      </div>
    `;
    return;
  }

  const drawers = state.decisionOpenDrawers || { reasoning: false, connections: false, sources: false };
  const ptsCount = reasoningList.length || Math.min(2, submittedRecords.length);
  const pathCount = submittedRecords.length;
  outEl.innerHTML = `
    ${navHtml}
    <div class="decision-ai-card">
      <section class="decision-ai-factor-panel" aria-label="${escapeHtml(factor.label)} analysis">
        ${factorHeadHtml}
        ${kpiStripHtml}
        ${compactCalaStripHtml}
        ${takeawayBlockHtml}
        ${analysisMessage}
      </section>
      <div class="decision-drawers-stack">
        ${renderDecisionDrawer("reasoning", "Reasoning & Scope", `${ptsCount} ${ptsCount === 1 ? "point" : "points"}`, reasoningDrawerBody, drawers.reasoning)}
        ${renderDecisionDrawer("connections", "Supporting Connections", `${pathCount} ${pathCount === 1 ? "path" : "paths"}`, connectionRowsHtml, drawers.connections)}
        ${renderDecisionDrawer("sources", "Verified Sources & Quality", `${factor.provenanceMix?.verifiedSharePct ?? 0}% · ${submittedSourceIds.length}`, sourcesDrawerBody, drawers.sources)}
      </div>
    </div>
  `;
}

async function runFourFactorClaudeInsight(factorGroup = state.decisionSelectedFactor) {
  if (!state.bridgeMap) return;
  const summary = buildFourFactorDecisionSummary(state.bridgeMap);
  if (summary.factors.some((factor) => factor.group === factorGroup)) {
    state.decisionSelectedFactor = factorGroup;
  }
  state.decisionAnalysisStarted = true;
  state.decisionDetailView = true;
  const { title, cacheKey } = fourFactorClaudeCacheKey(summary, state.bridgeMap);
  if (state.decisionAnalysisKey !== cacheKey) {
    state.decisionAnalysisRequestId += 1;
    state.decisionAnalysisKey = cacheKey;
    state.decisionAnalysisPendingKey = null;
    state.decisionAnalysisResult = null;
    state.decisionAnalysisStatus = "idle";
    state.decisionAnalysisError = "";
  }
  const cached = state.aiInsightCache.get(cacheKey);
  if (cached?.controlPlaneMode === "anthropic-connection-analyst") {
    state.decisionAnalysisResult = cached;
    state.decisionAnalysisStatus = "ready";
    state.decisionAnalysisError = "";
    renderDecisionSummaryWidget();
    return;
  }
  if (cached) state.aiInsightCache.delete(cacheKey);
  if (state.decisionAnalysisPendingKey === cacheKey) {
    state.decisionAnalysisStatus = "loading";
    state.decisionAnalysisResult = null;
    state.decisionAnalysisError = "";
    renderDecisionSummaryWidget();
    return;
  }

  const requestId = ++state.decisionAnalysisRequestId;
  state.decisionAnalysisKey = cacheKey;
  state.decisionAnalysisPendingKey = cacheKey;
  state.decisionAnalysisStatus = "loading";
  state.decisionAnalysisResult = null;
  state.decisionAnalysisError = "";
  renderDecisionSummaryWidget();
  requestAnimationFrame(() => $("#decisionAiOutput")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));

  const sourceById = collectDecisionSourceMap(
    state.bridgeMap,
    summary.factors.flatMap((factor) => getDecisionFactorEvidence(state.bridgeMap, factor).sources)
  );
  const factorEvidence = summary.factors.map((factor) => {
    const data = getDecisionFactorEvidence(state.bridgeMap, factor);
    return { factor, records: data.records.slice(0, 6) };
  });

  // Round-robin prioritize sources across all 4 factors so no factor starves within the 32-source cap.
  const sourceIdsToSend = new Set();
  const pools = factorEvidence.map(({ factor, records }) => [...new Set([
    ...asList(factor.sourceIds).map(String),
    ...records.flatMap((record) => record.sourceIds.map(String))
  ])]);
  const maxPoolLen = Math.max(0, ...pools.map((p) => p.length));
  for (let i = 0; i < maxPoolLen && sourceIdsToSend.size < 32; i++) {
    for (const pool of pools) {
      const id = pool[i];
      if (id && !sourceIdsToSend.has(id) && sourceById.has(id)) {
        sourceIdsToSend.add(id);
        if (sourceIdsToSend.size >= 32) break;
      }
    }
  }

  const allSources = [...sourceIdsToSend].map((id) => ({
    id,
    title: sourceById.get(id)?.title || sourceById.get(id)?.publisher || `Cala source ${id}`,
    publisher: sourceById.get(id)?.publisher || sourceById.get(id)?.source || "Cala Knowledge Graph",
    sourceRank: sourceById.get(id)?.sourceRank || sourceById.get(id)?.source_rank || "AGGREGATOR",
    date: sourceById.get(id)?.date || sourceById.get(id)?.asOfDate || null
  }));
  const activeMode = getActiveAnalysisMode(state.bridgeMap);
  const perspectiveEntityName = state.perspectiveEntity?.name || state.bridgeMap?.perspectiveEntity?.name || "";
  const primaryTargetName = summary.executive?.primaryTargetName || "";

  const serializedFactors = factorEvidence.map(({ factor, records }) => ({
    group: factor.group,
    label: factor.displayLabel || factor.label,
    effect: factor.effect,
    impact: factor.investmentImpact,
    evidence: factor.line,
    metrics: {
      signalStrength: factor.signalStrength,
      sharedCount: factor.sharedCount,
      verifiedSharePct: factor.provenanceMix?.verifiedSharePct
    },
    sourceIds: [...new Set([...factor.sourceIds, ...records.flatMap((record) => record.sourceIds)])]
      .filter((id) => sourceIdsToSend.has(String(id)))
      .map(String),
    records: records.map((record, index) => ({
      id: `${factor.group}-${index + 1}`,
      type: record.type,
      path: record.path,
      relation: record.relation,
      detail: record.detail,
      date: record.date,
      sourceRank: record.sourceRank,
      isSharedBridge: record.isSharedBridge,
      structuralRole: record.structuralRole || deriveStructuralRoleFrontend(record),
      timingRecency: record.timingRecency || classifyTimingRecencyFrontend(record).timingRecency,
      isAcquisition: Boolean(record.isAcquisition),
      perspectiveChain: asList(record.perspectiveChain).length ? record.perspectiveChain : undefined,
      sourceIds: record.sourceIds.filter((id) => sourceIdsToSend.has(String(id))).map(String)
    }))
  }));
  const evidenceFacts = serializedFactors.flatMap((factor) => factor.records.map((record) => ({
    text: `${factor.label}: ${record.path} · ${record.relation}${record.date ? ` (${record.date})` : ""}. ${record.detail || ""}`.trim(),
    sourceIds: record.sourceIds
  })));
  try {
    const res = await fetchJson("/api/connection-insight", {
      method: "POST",
      body: JSON.stringify({
        mode: "entity",
        analysisMode: activeMode,
        perspectiveEntityName: perspectiveEntityName || undefined,
        primaryTargetName: primaryTargetName || undefined,
        title,
        hopType: activeMode === "single_teardown" ? "Company Teardown" : activeMode === "perspective_triage" ? "Origination Triage" : "Ecosystem Comparison",
        relation: "DECISION_SYNTHESIS",
        whyMatters: summary.investmentEffect,
        facts: evidenceFacts,
        decisionFactors: serializedFactors,
        anomalies: summary.executive?.dataAnomalies || [],
        sources: allSources
      })
    });
    res.analysisInput = { decisionFactors: serializedFactors, sources: allSources };
    if (res.controlPlaneMode === "anthropic-connection-analyst") {
      state.aiInsightCache.set(cacheKey, res);
    } else {
      state.aiInsightCache.delete(cacheKey);
    }
    if (state.decisionAnalysisRequestId === requestId && state.decisionAnalysisKey === cacheKey) {
      state.decisionAnalysisResult = res;
      state.decisionAnalysisStatus = "ready";
      renderDecisionSummaryWidget();
    }
  } catch (err) {
    if (state.decisionAnalysisRequestId === requestId && state.decisionAnalysisKey === cacheKey) {
      state.decisionAnalysisStatus = "error";
      state.decisionAnalysisError = err?.message || "Unknown analysis error";
      renderDecisionSummaryWidget();
    }
  } finally {
    if (state.decisionAnalysisRequestId === requestId && state.decisionAnalysisPendingKey === cacheKey) {
      state.decisionAnalysisPendingKey = null;
    }
  }
}

const GROUP_DECISION_QUESTIONS = {
  access: "Who backs or partners here, and where are the warm syndicate intro paths?",
  lineage: "Who founded or leads this company, and what operator network connects them?",
  timing: "What dated financings, filings, or catalysts establish timing conviction?",
  caution: "What M&A conflicts, direct competitors, or proof gaps need diligence?"
};

function cleanSentencePunctuation(text) {
  return cleanText(text).replace(/\.{2,}/g, ".");
}

function explainEdgeDecisionImplication(group, edge, context = {}) {
  const explicit = cleanSentencePunctuation(edge?.whyMatters);
  if (explicit) return explicit;

  const mode = getActiveAnalysisMode();
  const rel = String(edge?.relation || edge?.relationType || "").toUpperCase();
  const structuralRole = deriveStructuralRoleFrontend(edge);
  const isAcquisition = Boolean(edge?.isAcquisition || rel.includes("ACQUIRED"));
  const recency = classifyTimingRecencyFrontend(edge);
  const hubNames = asList(context.hubNames).filter(Boolean);
  const otherFocalNames = asList(context.otherFocalNames).filter(Boolean);
  const bridgeNodeName = cleanText(context.sharedBridgeNodeName);
  const fromLabel = cleanText(context.fromLabel);
  const focalLabel = cleanText(context.focalLabel) || fromLabel;
  const targetLabel = cleanText(context.targetLabel);
  const peerNames = asList(context.syndicatePeers || edge?.syndicatePeers)
    .map((p) => cleanText(p?.name))
    .filter(Boolean)
    .slice(0, 2);
  const dateStr = edge?.date || context.date || "";
  const rank = tierOf(edge || {});

  if (isAcquisition) {
    return `Corporate M&A / subsidiary acquisition linking ${fromLabel || "parent"} and ${targetLabel || "target"}${dateStr ? ` (${dateStr})` : ""}; treat as ownership allocation unless an explicit dispute or overlap exists.`;
  }

  if (structuralRole === "commercial") {
    if (edge?.touchesPerspective) {
      return `Commercial bridge connecting your firm perspective (${state.perspectiveEntity?.name || "firm"}) and ${targetLabel || "target"}; evaluate value-chain depth or partner intro potential.`;
    }
    if (bridgeNodeName && otherFocalNames.length) {
      return `Shared commercial bottleneck via ${bridgeNodeName} across ${otherFocalNames.join(" and ")}; assess supplier concentration, exclusivity, and margin dependency.`;
    }
    return `Commercial value-chain tie linking ${fromLabel || "counterparty"} and ${targetLabel || "partner"}; assess revenue concentration and operational leverage rather than investor warm outreach.`;
  }

  if (bridgeNodeName && otherFocalNames.length) {
    const peerList = otherFocalNames.join(" and ");
    if (group === "access") {
      return mode === "perspective_triage"
        ? `Warm bridge via ${bridgeNodeName} links ${focalLabel || "this hub"} with ${peerList}; verify direct intro path and reference strength.`
        : `Shared syndicate or ecosystem bridge via ${bridgeNodeName} connects ${focalLabel || "this hub"} to ${peerList}.`;
    }
    if (group === "lineage") {
      return `Operator/leadership bridge via ${bridgeNodeName} links ${focalLabel || "this hub"} with ${peerList}; verify founder execution track record and cross-company alumni ties.`;
    }
    if (group === "timing") {
      return `Shared dated catalyst around ${bridgeNodeName}${dateStr ? ` (${dateStr})` : ""} touches ${peerList}; track aligned financing timing.`;
    }
    return `Shared conflict or dependency around ${bridgeNodeName} touches ${peerList}; diligence overlap and competitive exposure carefully.`;
  }

  if (group === "access") {
    if (edge?.touchesPerspective && mode === "perspective_triage") {
      return `Verified connection from ${state.perspectiveEntity?.name || "your firm"} around ${targetLabel || "target"} creating a direct origination route.`;
    }
    if (hubNames.length >= 2) {
      return `Shared backer or partner across ${hubNames.join(" and ")} enabling side-by-side diligence.`;
    }
    if (rel === "INVESTED_IN" || rel === "CO_INVESTED_WITH" || edge?.isRoundExpanded) {
      const leadNote = edge?.isLead ? "Lead capital investor providing governance weight" : "Verified capital backer on the cap table";
      const coText = peerNames.length ? ` alongside ${peerNames.join(" and ")}` : "";
      return `${leadNote}${coText}${targetLabel ? ` in ${targetLabel}` : ""}.`;
    }
    return `Verified strategic or ownership tie${targetLabel ? ` with ${targetLabel}` : ""}.`;
  }
  if (group === "lineage") {
    if (hubNames.length >= 2) {
      return `Shared founder/executive lineage linking ${hubNames.join(" and ")}; high-signal operator reference.`;
    }
    if (/SUBSIDIARY|PARENT|CONTROL/i.test(rel)) {
      return `Verified corporate ownership or governance structure shaping cap-table control and exit approvals.`;
    }
    return `Verified founder or leadership tie validating execution pedigree${targetLabel ? ` at ${targetLabel}` : ""}.`;
  }
  if (group === "timing") {
    if (recency.isRecentCatalyst) {
      return `Active catalyst within 18 months${dateStr ? ` (${dateStr})` : ""} indicating current financing or operating momentum.`;
    }
    if (recency.isHistoricalMilestone) {
      return `Historical capital/operating milestone (${dateStr || ">18m ago"}) — background context rather than current deal timing.`;
    }
    return `Dated financing or corporate milestone${dateStr ? ` (${dateStr})` : ""} providing timeline context.`;
  }
  if (/COMPET/i.test(rel)) {
    return `Direct competitive overlap between ${fromLabel || "entity"} and ${targetLabel || "peer"}; check moat differentiation and win rates.`;
  }
  if (/LITIG|SUED|DISPUT|AFFECT/i.test(rel)) {
    return `Verified dispute, regulatory, or downside risk exposure to underwrite before committing capital.`;
  }
  if (rank === "AGGREGATOR") {
    return `Backed only by aggregator records; corroborate directly against SEC filings or primary releases.`;
  }
  return `Overlap, dependency, or downside caution flag requiring targeted partner diligence.`;
}

const TOOLTIP_TIER_WEIGHT = { FILING: 4, PRIMARY: 3, PRESS: 2, AGGREGATOR: 1 };

function summarizeFocalGroupInsight(edges = [], focalNode, nodeById) {
  if (!edges.length) return "";
  const sorted = [...edges].sort(
    (a, b) =>
      Number(Boolean(b.isSharedBridge)) - Number(Boolean(a.isSharedBridge)) ||
      (TOOLTIP_TIER_WEIGHT[tierOf(b)] || 0) - (TOOLTIP_TIER_WEIGHT[tierOf(a)] || 0) ||
      String(b.date || "").localeCompare(String(a.date || ""))
  );
  const top = sorted[0];
  const otherId = top.from === focalNode.id ? top.to : top.from;
  const otherNode = nodeById?.get(otherId);
  const otherName = otherNode ? nameOf(otherNode) : otherId;
  if (top.isSharedBridge) {
    const sharedHubs = asList(top.sharedByFocalEntityIds)
      .filter((id) => id !== focalNode.id)
      .map((id) => nameOf(nodeById?.get(id) || { label: id }))
      .filter(Boolean);
    if (sharedHubs.length) {
      return `Shared ${otherName} bridges to ${sharedHubs.join(", ")}`;
    }
  }
  return cleanText(top.detail) || `${otherName} (${top.label || top.relation || "verified link"})`;
}

function buildNodeTooltipHtml(node) {
  if (!node) return "";
  const layout = state.mapLayoutNodes;
  const nodeById = layout?.nodeById || new Map();
  const bridgeNodeById = new Map((state.bridgeMap?.nodes || []).map((n) => [n.id, n]));
  const lookupNode = (id) => nodeById.get(id) || bridgeNodeById.get(id);
  const incEdges = (layout?.connectedEdgesByNode?.get(node.id) || []).filter((e) => !e.isSecondaryOverviewLink);

  if (node.kind === "group_hub") {
    const groupKey = node.groupKey || "access";
    const cgMeta = CONTRIBUTION_VISUAL_META[groupKey] || CONTRIBUTION_VISUAL_META.access;
    const question = GROUP_DECISION_QUESTIONS[groupKey] || cgMeta.subtitle;
    const rawGroupEdges = (state.bridgeMap?.edges || []).filter(
      (e) => !e.isSecondaryOverviewLink && !e.id?.startsWith("tree-spoke-") && deriveContributionGroupFrontend(e) === groupKey
    );
    const layoutGroupEdges = (layout?.edges || []).filter(
      (e) => !e.isSecondaryOverviewLink && !e.id?.startsWith("tree-spoke-") && deriveContributionGroupFrontend(e) === groupKey
    );
    const groupEdges = rawGroupEdges.length >= layoutGroupEdges.length ? rawGroupEdges : layoutGroupEdges;
    const focalCats = groupKey === "timing"
      ? Object.values(state.bridgeMap?.timingEventsByEntity || {}).flat()
      : [];
    const totalSignals = groupKey === "timing"
      ? Math.max(groupEdges.length, focalCats.length)
      : Math.max(groupEdges.length, asList(node.topContributors).length);
    const factItems = [];
    for (const e of groupEdges) {
      if (factItems.length >= 3) break;
      const line = cleanText(e.detail) || `${nameOf(lookupNode(e.from) || { label: e.from })} ${String(e.label || "").toLowerCase()} ${nameOf(lookupNode(e.to) || { label: e.to })}`;
      if (line && !factItems.includes(line)) factItems.push(line);
    }
    if (groupKey === "timing") {
      for (const ev of focalCats) {
        if (factItems.length >= 3) break;
        const line = [ev.title, ev.date].filter(Boolean).join(" · ");
        if (line && !factItems.includes(line)) factItems.push(line);
      }
    }
    const driversText = factItems.length
      ? factItems.map((item) => escapeHtml(item)).join(" | ")
      : "No verified Cala signals mapped in this lens";
    return `
      <div class="tip-header">
        <strong>${escapeHtml(cgMeta.headerLabel)} · ${totalSignals} verified ${totalSignals === 1 ? "connection" : "connections"}</strong>
      </div>
      <div class="tip-spec-row"><span class="tip-k">Analyst Question:</span> ${escapeHtml(question)}</div>
      <div class="tip-spec-row"><span class="tip-k">Key Facts:</span> ${driversText}</div>
      <div class="tip-hint">${node.isExpandedHub ? "Click hub to return to overview" : "Click hub to isolate this lens"}</div>
    `;
  }

  if (node.kind === "anchor" || node.isFocalEntity) {
    const mode = getActiveAnalysisMode();
    const rawFocalEdges = (state.bridgeMap?.edges || []).filter(
      (e) => !e.id?.startsWith("tree-spoke-") && (e.from === node.id || e.to === node.id)
    );
    const focalEdges = rawFocalEdges.length ? rawFocalEdges : incEdges;
    const rank = strongestTier([node, ...focalEdges]);
    const entityType = typeBadge(node);
    const accessEdges = focalEdges.filter((e) => deriveContributionGroupFrontend(e) === "access");
    const lineageEdges = focalEdges.filter((e) => deriveContributionGroupFrontend(e) === "lineage");
    const timingEdges = focalEdges.filter((e) => deriveContributionGroupFrontend(e) === "timing");
    const cautionEdges = focalEdges.filter((e) => deriveContributionGroupFrontend(e) === "caution");
    const catalysts = asList(node.timingCatalysts || state.bridgeMap?.timingEventsByEntity?.[node.id]);

    const accessSummary = summarizeFocalGroupInsight(accessEdges, node, bridgeNodeById) || (
      mode === "perspective_triage" ? "No warm path from selected perspective in Cala" : "No capital or commercial ties indexed in Cala"
    );
    const lineageSummary = summarizeFocalGroupInsight(lineageEdges, node, bridgeNodeById);
    const timingSummary = catalysts[0]
      ? [catalysts[0].title, catalysts[0].date].filter(Boolean).join(" · ")
      : summarizeFocalGroupInsight(timingEdges, node, bridgeNodeById);
    const cautionSummary = summarizeFocalGroupInsight(cautionEdges, node, bridgeNodeById);

    const isPersp = Boolean(node.isPerspectiveEntity);
    const roleKind = isPersp
      ? "My Firm Perspective Seat"
      : /organization|fund|investor/i.test(typeOf(node))
        ? "Investor / Syndicate Entity"
        : mode === "single_teardown"
          ? "Teardown Target Entity"
          : "Mapped Peer Entity";
    const sharedCount = focalEdges.filter((e) => e.isSharedBridge).length;
    const roleText = `${roleKind} (${entityType})${sharedCount ? ` · ${sharedCount} shared bridge ${sharedCount === 1 ? "link" : "links"}` : ""} · Strongest tier: ${rank}`;

    const accessLbl = mode === "perspective_triage" ? "Access" : "Capital & Chain";
    const lineageLbl = mode === "perspective_triage" ? "Lineage" : "Governance & M&A";
    const thirdRow = lineageSummary
      ? `<div class="tip-spec-row"><span class="tip-k">${lineageLbl}:</span> ${escapeHtml(lineageSummary)}</div>`
      : timingSummary && cautionSummary
        ? `<div class="tip-spec-row"><span class="tip-k">Timing:</span> ${escapeHtml(timingSummary)}</div>`
        : "";
    const fourthLabel =
      lineageSummary && timingSummary && cautionSummary
        ? "Timing & Risk"
        : cautionSummary
          ? "Risks & Rivals"
          : "Catalysts";
    const fourthValue =
      lineageSummary && timingSummary && cautionSummary
        ? `${timingSummary} | ${cautionSummary}`
        : cautionSummary || timingSummary;

    return `
      <div class="tip-header">
        <strong>${escapeHtml(nameOf(node))} · ${escapeHtml(rank)}</strong>
      </div>
      <div class="tip-spec-row"><span class="tip-k">Context Role:</span> ${escapeHtml(roleText)}</div>
      <div class="tip-spec-row"><span class="tip-k">${accessLbl}:</span> ${escapeHtml(accessSummary)}</div>
      ${thirdRow}
      ${fourthValue ? `<div class="tip-spec-row"><span class="tip-k">${fourthLabel}:</span> ${escapeHtml(fourthValue)}</div>` : ""}
    `;
  }

  // Connected Entity / Person / Investor / Bridge Orb
  const bestEdge = incEdges[0] || null;
  const group = deriveContributionGroupFrontend(bestEdge || node);
  const rank = strongestTier([node, ...incEdges]);
  const hubNames = asList(node.sharedByFocalEntityIds)
    .map((id) => nameOf(nodeById.get(id) || { label: id }))
    .filter(Boolean);
  const singleTargetId = bestEdge ? (bestEdge.from === node.id ? bestEdge.to : bestEdge.from) : null;
  const singleTargetName = singleTargetId ? nameOf(nodeById.get(singleTargetId) || { label: singleTargetId }) : "";
  const seenPartners = new Set();
  const diverseEdges = [];
  for (const e of incEdges) {
    const otherId = e.from === node.id ? e.to : e.from;
    if (!seenPartners.has(otherId)) {
      seenPartners.add(otherId);
      diverseEdges.push(e);
    }
  }
  const relList = (diverseEdges.length >= 2 ? diverseEdges : incEdges).slice(0, 2);
  const relSummary = relList
    .map((e) => cleanText(e.detail))
    .filter(Boolean)
    .join(" · ") || `${nameOf(node)} (${typeBadge(node)}) verified in Cala`;
  const whyMatters = explainEdgeDecisionImplication(group, bestEdge || { topSourceRank: rank }, {
    hubNames,
    targetLabel: singleTargetName,
    date: node.date || bestEdge?.date
  });
  const datePart = node.date || bestEdge?.date;
  const isSharedBridge = Boolean(node.isSharedOverlap || node.isSharedBridge || node.isPerspectiveBridge || hubNames.length > 1);
  const impactLabel = isSharedBridge ? getSharedImpactBadge(node, incEdges).replace(/^↔\s*/, "") : "";
  const sharedBridgeNote = isSharedBridge
    ? `<div class="tip-shared-bridge"><strong>${escapeHtml(impactLabel)}</strong> Connects verified paths across ${escapeHtml(hubNames.length > 1 ? hubNames.join(" and ") : "mapped entities")}.</div>`
    : "";

  return `
    <div class="tip-header">
      <strong>${escapeHtml(formatReadableEntityLabel(nameOf(node), node.date))} · ${escapeHtml(typeBadge(node))}</strong>
    </div>
    ${sharedBridgeNote}
    <div class="tip-spec-row"><span class="tip-k">Relationship:</span> ${escapeHtml(relSummary)}</div>
    <div class="tip-spec-row"><span class="tip-k">Why it matters:</span> ${escapeHtml(whyMatters)}</div>
    <div class="tip-spec-row"><span class="tip-k">Source Tier:</span> ${escapeHtml(rank)}${datePart ? ` · ${escapeHtml(datePart)}` : ""}</div>
    <div class="tip-hint">Click orb for verified Cala dossier & sources</div>
  `;
}

function collectEdgeCitations(edgesList = [], options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 2;
  const sourceIndex = state.analysis?.sources || {};
  const byKey = new Map();
  let maxReportedCount = 0;

  for (const e of edgesList) {
    maxReportedCount = Math.max(maxReportedCount, Number(e?.sourceCount) || 0);
    const attached = asList(e?.evidenceSources);
    const resolved = attached.length
      ? attached
      : asList(e?.sourceIds)
          .map((id) => sourceIndex[id])
          .filter(Boolean);

    for (const src of resolved) {
      const title = cleanText(src?.title);
      const publisher = cleanText(src?.publisher || src?.source);
      const url = cleanText(src?.url || src?.document);
      const date = src?.date ? String(src.date).slice(0, 10) : "";
      const rank = String(src?.sourceRank || src?.source_rank || tierOf(e) || "AGGREGATOR").toUpperCase();
      const key = `${url.toLowerCase()}|${title.toLowerCase()}`;
      if (!title && !publisher && !url) continue;
      const existing = byKey.get(key);
      if (
        !existing ||
        (TOOLTIP_TIER_WEIGHT[rank] || 0) > (TOOLTIP_TIER_WEIGHT[existing.sourceRank] || 0) ||
        date > existing.date
      ) {
        byKey.set(key, {
          id: cleanText(src.id),
          title: title || publisher || "Cala relationship record",
          publisher: publisher || "Cala Knowledge Graph",
          url,
          date,
          sourceRank: rank
        });
      }
    }
  }

  const citations = [...byKey.values()].sort(
    (a, b) =>
      (TOOLTIP_TIER_WEIGHT[b.sourceRank] || 0) - (TOOLTIP_TIER_WEIGHT[a.sourceRank] || 0) ||
      String(b.date || "").localeCompare(String(a.date || ""))
  );
  const totalCount = citations.length;
  return {
    citations: limit > 0 ? citations.slice(0, limit) : citations,
    allCount: citations.length,
    totalCount,
    hasExternalRecords: citations.some((c) => !/^Cala Knowledge Graph$/i.test(c.publisher))
  };
}

function getSiblingEdgesForTooltip(edge, layout) {
  if (!edge || edge.isOverviewSpoke) return [edge].filter(Boolean);
  const rawEdges = asList(state.bridgeMap?.edges);
  const displayEdges = asList(layout?.displayEdges);

  let matches = [];
  if (String(edge.from || "").startsWith("group_hub:") && edge.realNodeId) {
    const anchorId = layout?.primaryAnchor?.id;
    matches = rawEdges.filter(
      (e) =>
        e.contributionGroup === edge.contributionGroup &&
        ((e.from === anchorId && e.to === edge.realNodeId) || (e.to === anchorId && e.from === edge.realNodeId))
    );
  } else {
    const a = String(edge.from || "");
    const b = String(edge.to || "");
    const pool = rawEdges.length ? rawEdges : displayEdges;
    matches = pool.filter(
      (e) => !e.isOverviewSpoke && ((e.from === a && e.to === b) || (e.from === b && e.to === a))
    );
  }

  if (!matches.length) return [edge];
  const unique = new Map();
  unique.set(edge.id, edge);
  for (const m of matches) {
    if (m?.id && !unique.has(m.id)) unique.set(m.id, m);
  }
  return [...unique.values()].sort((left, right) => {
    if (left.id === edge.id) return -1;
    if (right.id === edge.id) return 1;
    return (
      Number(Boolean(right.isLead)) - Number(Boolean(left.isLead)) ||
      (TOOLTIP_TIER_WEIGHT[tierOf(right)] || 0) - (TOOLTIP_TIER_WEIGHT[tierOf(left)] || 0) ||
      String(right.date || "").localeCompare(String(left.date || ""))
    );
  });
}

function buildGroupBranchEdgeTooltipHtml(edge, fromNode, toNode, cgMeta, group) {
  const rank = tierOf(edge);
  const question = GROUP_DECISION_QUESTIONS[group] || "Verified Cala signal category.";
  const contributors = asList(edge.hubTopContributors || toNode?.topContributors)
    .map((c) => cleanText(c?.label || c?.name))
    .filter(Boolean)
    .slice(0, 3);
  const entityCount = edge.hubEntityCount ?? toNode?.entityCount ?? 0;
  const edgeCount = edge.hubEdgeCount ?? toNode?.edgeCount ?? 0;

  return `
    <div class="tip-header">
      <div class="tip-title-cluster">
        <span class="tip-lens-badge" data-group="${escapeHtml(group)}">${escapeHtml(cgMeta.headerLabel)}</span>
        <strong>${escapeHtml(toNode?.label || cgMeta.headerLabel)} Branch</strong>
      </div>
      <span class="tip-tier-badge" data-tier="${escapeHtml(rank)}">${escapeHtml(rank)}</span>
    </div>
    <div class="tip-route">
      <span>${escapeHtml(nameOf(fromNode || { label: edge.from }))}</span>
      <span class="tip-arrow">&rarr;</span>
      <span>${escapeHtml(toNode?.label || cgMeta.headerLabel)}</span>
    </div>
    <div class="tip-spec-row"><span class="tip-k">Analyst Question:</span> ${escapeHtml(question)}</div>
    <div class="tip-spec-row"><span class="tip-k">Coverage:</span> ${entityCount} connected ${entityCount === 1 ? "entity" : "entities"} across ${edgeCount} verified ${edgeCount === 1 ? "path" : "paths"}${contributors.length ? ` (${escapeHtml(contributors.join(", "))})` : ""}.</div>
    <div class="tip-hint">Click branch orb or line to isolate this lens</div>
  `;
}

function buildEdgeContextMeta(edge) {
  const layout = state.mapLayoutNodes;
  const nodeById = layout?.nodeById || new Map();
  const group = deriveContributionGroupFrontend(edge);
  const cgMeta = CONTRIBUTION_VISUAL_META[group] || CONTRIBUTION_VISUAL_META.access;
  const isModeATreeEdge = String(edge.from || "").startsWith("group_hub:");
  const fromNode = isModeATreeEdge
    ? layout?.primaryAnchor || nodeById.get(edge.from) || { id: edge.from, label: edge.from }
    : nodeById.get(edge.from) || { id: edge.from, label: edge.from };
  const toNode = nodeById.get(edge.realNodeId || edge.to) || { id: edge.to, label: edge.to };
  const fromName = nameOf(fromNode);
  const toName = nameOf(toNode);
  const fromType = fromNode?.id ? typeBadge(fromNode) : "";
  const toType = toNode?.id ? typeBadge(toNode) : "";

  const siblings = getSiblingEdgesForTooltip(edge, layout);
  const rank = strongestTier(siblings);
  const arrowSymbol = edge.isSymmetric ? "\u2194" : "\u2192";
  const anyLead = siblings.some((s) => s.isLead);
  const sharedBridgeNode = edge.sharedBridgeNodeId ? nodeById.get(edge.sharedBridgeNodeId) : null;
  const sharedBridgeNodeName = sharedBridgeNode ? nameOf(sharedBridgeNode) : "";
  const allHubNames = asList(edge.sharedByFocalEntityIds)
    .map((id) => nameOf(nodeById.get(id) || { label: id }))
    .filter(Boolean);
  const focalAnchorIds = new Set([
    ...asList(state.bridgeMap?.focalEntities).map((f) => String(f.id)),
    ...asList(layout?.anchorIds ? [...layout.anchorIds] : []).map(String),
    ...(layout?.primaryAnchor?.id ? [String(layout.primaryAnchor.id)] : [])
  ]);
  const currentFocalId = isModeATreeEdge
    ? String(layout?.primaryAnchor?.id || edge.focalEntityId || "")
    : focalAnchorIds.has(String(edge.from))
      ? String(edge.from)
      : focalAnchorIds.has(String(edge.to))
        ? String(edge.to)
        : String(edge.focalEntityId || "");
  const currentFocalLabel = currentFocalId ? nameOf(nodeById.get(currentFocalId) || { label: "" }) : "";
  const otherFocalNames = asList(edge.sharedByFocalEntityIds)
    .filter((id) => String(id) !== currentFocalId)
    .map((id) => nameOf(nodeById.get(id) || { label: id }))
    .filter(Boolean);

  const factRows = [];
  const seenFactText = new Set();
  for (const s of siblings) {
    const fact = cleanSentencePunctuation(
      s.detail ||
        `${fromName} ${String(s.label || "connected to").toLowerCase()} ${toName}${s.roundLabel ? ` (${s.roundLabel})` : ""}`
    );
    const norm = fact.toLowerCase();
    if (!fact || seenFactText.has(norm)) continue;
    seenFactText.add(norm);
    factRows.push({
      label: s.label || "",
      fact,
      date: s.date || "",
      role: s.role || "",
      tier: tierOf(s)
    });
  }

  const hasActualRound = Boolean(edge.roundLabel || edge.roundType || edge.roundAmount);
  const roundSummary = hasActualRound
    ? (edge.roundLabel || [edge.roundType, edge.roundAmount, edge.roundDate || edge.date].filter(Boolean).join(" · "))
    : "";
  const roleDisplay =
    edge.role && !String(factRows[0]?.fact || "").toLowerCase().includes(String(edge.role).toLowerCase())
      ? edge.role
      : "";
  const peers = asList(edge.syndicatePeers);
  const rawRelations = [...new Set(siblings.map((s) => cleanText(s.relation)).filter(Boolean))];
  const hopTypeLabel = edge.isRoundExpanded
    ? "2-hop via FundingRound"
    : edge.isSharedBridge
      ? "Shared cross-hub bridge"
      : "Direct 1-hop Cala relation";
  const linkCitationCheck = collectEdgeCitations(siblings, { limit: 1 });
  const linkGaps = [];
  if (!cleanText(edge.date || edge.roundDate)) linkGaps.push("Event date");
  if ((rawRelations.includes("INVESTED_IN") || edge.isRoundExpanded) && !edge.roundAmount) {
    linkGaps.push("Round size / check amount");
  }
  if ((rawRelations.includes("INVESTED_IN") || edge.isRoundExpanded) && !anyLead && !cleanText(edge.role)) {
    linkGaps.push("Lead vs. participant role");
  }
  if (!linkCitationCheck.hasExternalRecords) linkGaps.push("External article URL");

  const targetForImplication = fromName === sharedBridgeNodeName ? fromName : toName;
  const whyMatters = explainEdgeDecisionImplication(group, edge, {
    hubNames: allHubNames,
    otherFocalNames,
    sharedBridgeNodeName,
    focalLabel: currentFocalLabel,
    fromLabel: fromName,
    targetLabel: targetForImplication,
    syndicatePeers: peers,
    date: edge.date
  });

  return {
    layout,
    nodeById,
    group,
    cgMeta,
    isModeATreeEdge,
    fromNode,
    toNode,
    fromName,
    toName,
    fromType,
    toType,
    siblings,
    rank,
    arrowSymbol,
    anyLead,
    sharedBridgeNode,
    sharedBridgeNodeName,
    allHubNames,
    otherFocalNames,
    factRows,
    hasActualRound,
    roundSummary,
    roleDisplay,
    peers,
    rawRelations,
    hopTypeLabel,
    linkGaps,
    whyMatters
  };
}

function formatCleanCitationTitle(title, publisher, url) {
  const pubLower = String(publisher || "").trim().toLowerCase();
  const rawTitle = cleanText(title);
  const titleLower = rawTitle.toLowerCase();
  const isGeneric =
    !titleLower ||
    pubLower === titleLower ||
    (titleLower.length >= 2 && pubLower.includes(titleLower)) ||
    /^home\s*\||^index\s*\|/i.test(rawTitle);
  if (!isGeneric) {
    return rawTitle.length > 68 ? `${rawTitle.slice(0, 65)}...` : rawTitle;
  }
  if (url && /^https?:\/\//i.test(url)) {
    try {
      const slug = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
      const words = slug.replace(/[-_]+/g, " ").replace(/\.[a-z0-9]{2,5}$/i, "").trim();
      if (words.length >= 6 && !/^[a-f0-9-]{16,}$/i.test(words)) {
        const pretty = words.charAt(0).toUpperCase() + words.slice(1);
        return pretty.length > 68 ? `${pretty.slice(0, 65)}...` : pretty;
      }
    } catch {
      // Ignore malformed URLs cleanly.
    }
  }
  return "";
}

function buildEdgeTooltipHtml(edge) {
  if (!edge) return "";
  const layout = state.mapLayoutNodes;
  const nodeById = layout?.nodeById || new Map();
  const group = deriveContributionGroupFrontend(edge);
  const cgMeta = CONTRIBUTION_VISUAL_META[group] || CONTRIBUTION_VISUAL_META.access;

  if (edge.isOverviewSpoke) {
    return buildGroupBranchEdgeTooltipHtml(
      edge,
      nodeById.get(edge.from),
      nodeById.get(edge.to),
      cgMeta,
      group
    );
  }

  const ctx = buildEdgeContextMeta(edge);
  const {
    isModeATreeEdge,
    fromName,
    toName,
    fromType,
    toType,
    siblings,
    rank,
    arrowSymbol,
    anyLead,
    sharedBridgeNodeName,
    allHubNames,
    otherFocalNames,
    factRows,
    roundSummary,
    roleDisplay,
    peers,
    rawRelations,
    linkGaps,
    whyMatters
  } = ctx;

  const mode = getActiveAnalysisMode();
  const sRole = deriveStructuralRoleFrontend(edge);
  const verdict = deriveEdgeVerdict(edge, nodeById.get(edge.to));
  const primaryLabel = edge.label || (isModeATreeEdge ? `${cgMeta.headerLabel} Connection` : "Verified Connection");
  const roleHeaderBadge =
    mode === "perspective_triage"
      ? cgMeta.headerLabel
      : edge.isAcquisition
        ? "M&A · GOVERNANCE"
        : (STRUCTURAL_ROLE_META[sRole]?.shortLabel || cgMeta.headerLabel).toUpperCase();
  const statusPills = [
    `<span class="tip-pill tip-verdict-pill is-${escapeHtml(verdict.key)}">${escapeHtml(verdict.label)}</span>`,
    `<span class="tip-pill is-hop">${escapeHtml(edge.isRoundExpanded ? "2-hop · FundingRound" : "1-hop · Direct")}</span>`,
    rawRelations[0] ? `<span class="tip-pill is-rel">${escapeHtml(rawRelations[0])}</span>` : "",
    anyLead ? `<span class="tip-pill is-lead">Lead Investor</span>` : "",
    edge.touchesPerspective ? `<span class="tip-pill is-bridge">Perspective Path</span>` : edge.isSharedBridge ? `<span class="tip-pill is-bridge">Shared Bridge</span>` : "",
    siblings.length > 1 ? `<span class="tip-pill is-multi">${siblings.length} linked roles</span>` : ""
  ]
    .filter(Boolean)
    .join("");

  let relationshipHtml = "";
  if (factRows.length <= 1) {
    const singleFact =
      factRows[0]?.fact || `${fromName} connected to ${toName}${edge.roundLabel ? ` (${edge.roundLabel})` : ""}.`;
    relationshipHtml = `<div class="tip-spec-row"><span class="tip-k">Verified Fact:</span> ${escapeHtml(singleFact)}</div>`;
  } else {
    const topFacts = factRows.slice(0, 3);
    const remainingFacts = factRows.length - topFacts.length;
    relationshipHtml = `
      <div class="tip-spec-row">
        <span class="tip-k">Verified Roles (${factRows.length}):</span>
        <ul class="tip-sublist">
          ${topFacts
            .map(
              (item) =>
                `<li>${item.label ? `<strong>${escapeHtml(item.label)}:</strong> ` : ""}${escapeHtml(item.fact)}</li>`
            )
            .join("")}
        </ul>
        ${remainingFacts > 0 ? `<div class="tip-more-note">+${remainingFacts} additional Cala role recorded</div>` : ""}
      </div>
    `;
  }

  const peerNames = peers.slice(0, 3).map((p) => `${p.name}${p.isLead ? " (Lead)" : ""}`);
  const extraPeers = Math.max(0, (edge.syndicateTotalCount || peers.length) - peerNames.length);
  const dateLabel = edge.date || edge.roundDate || "";
  const contextParts = [];
  if (roundSummary) contextParts.push(`Round: ${roundSummary}`);
  else if (dateLabel) contextParts.push(`Date: ${dateLabel}`);
  if (roleDisplay) contextParts.push(`Role: ${roleDisplay}`);

  const syndicateHtml = peerNames.length
    ? `<div class="tip-spec-row"><span class="tip-k">Co-investors:</span> ${escapeHtml(peerNames.join(", "))}${extraPeers > 0 ? ` <span class="tip-muted">+${extraPeers} more</span>` : ""}</div>`
    : "";

  const sharedBridgeHtml =
    edge.isSharedBridge && sharedBridgeNodeName && otherFocalNames.length
      ? `<div class="tip-spec-row"><span class="tip-k">Bridge Hub:</span> ${escapeHtml(sharedBridgeNodeName)} links ${escapeHtml(allHubNames.join(" \u2194 "))}</div>`
      : "";

  const contextHtml = contextParts.length
    ? `<div class="tip-spec-row tip-deal-row">${contextParts
        .map((part) => {
          const idx = part.indexOf(":");
          const k = idx > 0 ? part.slice(0, idx + 1) : "";
          const v = idx > 0 ? part.slice(idx + 1).trim() : part;
          return `<span class="tip-inline-kv"><span class="tip-k">${escapeHtml(k)}</span> ${escapeHtml(v)}</span>`;
        })
        .join('<span class="tip-sep">·</span>')}</div>`
    : "";

  const { citations, totalCount, hasExternalRecords } = collectEdgeCitations(siblings, { limit: 2 });
  const extraSources = Math.max(0, totalCount - citations.length);
  let sourcesHtml = "";
  if (citations.length && hasExternalRecords) {
    sourcesHtml = `
      <div class="tip-spec-row tip-sources-block">
        <span class="tip-k">Cala Sources (${totalCount}):</span>
        <ul class="tip-source-list">
          ${citations
            .map((src) => {
              const displayTitle = formatCleanCitationTitle(src.title, src.publisher, src.url);
              return `
                <li class="tip-source-item">
                  <span class="tip-tier-mini" data-tier="${escapeHtml(src.sourceRank)}">${escapeHtml(src.sourceRank)}</span>
                  <span class="tip-source-pub">${escapeHtml(src.publisher)}</span>
                  ${displayTitle ? `<span class="tip-source-title">${escapeHtml(displayTitle)}</span>` : ""}
                  ${src.date ? `<span class="tip-source-date">${escapeHtml(src.date)}</span>` : ""}
                </li>
              `;
            })
            .join("")}
        </ul>
        ${extraSources > 0 ? `<div class="tip-more-note">+${extraSources} additional verified ${extraSources === 1 ? "citation" : "citations"}</div>` : ""}
      </div>
    `;
  } else {
    sourcesHtml = `<div class="tip-spec-row"><span class="tip-k">Source Provenance:</span> ${escapeHtml(rank)} · Cala Knowledge Graph (entity-level record${dateLabel ? `, ${escapeHtml(dateLabel)}` : ""})</div>`;
  }

  const gapLineHtml = linkGaps.length
    ? `<div class="tip-spec-row tip-gap-line"><span class="tip-k">Unindexed in Cala:</span> ${escapeHtml(linkGaps.join(", "))}</div>`
    : "";

  const routeTypeText =
    fromType && toType && fromType !== "Group"
      ? `<span class="tip-route-types">${escapeHtml(fromType)} ${escapeHtml(arrowSymbol)} ${escapeHtml(toType)}</span>`
      : "";

  return `
    <div class="tip-header">
      <div class="tip-title-cluster">
        <span class="tip-lens-badge" data-group="${escapeHtml(group)}">${escapeHtml(roleHeaderBadge)}</span>
        <strong>${escapeHtml(primaryLabel)}</strong>
      </div>
      <span class="tip-tier-badge" data-tier="${escapeHtml(rank)}">${escapeHtml(rank)}</span>
    </div>
    ${statusPills ? `<div class="tip-pill-row">${statusPills}</div>` : ""}
    <div class="tip-verdict-line is-${escapeHtml(verdict.key)}">${escapeHtml(verdict.shortEffect)}</div>
    <div class="tip-route">
      <span class="tip-route-path">${escapeHtml(fromName)} <span class="tip-arrow">${escapeHtml(arrowSymbol)}</span> ${escapeHtml(toName)}</span>
      ${routeTypeText}
    </div>
    ${relationshipHtml}
    ${contextHtml}
    ${syndicateHtml}
    ${sharedBridgeHtml}
    <div class="tip-spec-row"><span class="tip-k">Why it matters:</span> ${escapeHtml(whyMatters)}</div>
    ${sourcesHtml}
    ${gapLineHtml}
    <div class="tip-hint">Click curve to inspect connection & verified Cala citations</div>
  `;
}

// ---------- Search Bar & Compare Autocomplete ----------

function closeSuggestPopup() {
  const popup = $("#searchSuggestPopup");
  if (popup) {
    popup.hidden = true;
    popup.innerHTML = "";
  }
  state.suggestItems = [];
}

function closeCompareSuggest() {
  const box = $("#compareEntitySuggest");
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
  state.compareSuggestItems = [];
}

function renderSearchSuggestions(items, queryText = "") {
  const popup = $("#searchSuggestPopup");
  if (!popup) return;
  state.suggestItems = items;
  if (!items.length) {
    if (queryText.length >= 2) {
      popup.innerHTML = `<div class="suggest-empty-state">No Cala entities matched "${escapeHtml(queryText)}".</div>`;
      popup.hidden = false;
    } else {
      popup.hidden = true;
      popup.innerHTML = "";
    }
    return;
  }

  const pinnedIds = new Set(state.pinnedEntities.map((p) => p.id));
  const hasExisting = state.pinnedEntities.length > 0;
  popup.innerHTML = items
    .map((item, idx) => {
      const alreadyOnMap = pinnedIds.has(item.id);
      const showOnlyBtn = hasExisting && !alreadyOnMap;
      const metaText = alreadyOnMap ? `On map · Click to focus · ${metaOf(item)}` : metaOf(item);
      return `
        <div class="suggest-item-wrap">
          <button type="button" class="suggest-item" data-suggest-action="add" data-suggest-index="${idx}" role="option">
            <span class="suggest-item-main">
              <span class="suggest-kind-tag is-filter">${escapeHtml(typeBadge(item))}</span>
              <span class="suggest-item-title">${escapeHtml(item.name)}</span>
            </span>
            <span class="suggest-item-meta">${escapeHtml(metaText)}</span>
          </button>
          ${showOnlyBtn ? `<button type="button" class="suggest-add-compare-btn" data-suggest-action="only" data-suggest-index="${idx}" title="Clear map and explore only this entity">Only</button>` : ""}
        </div>
      `;
    })
    .join("");
  popup.hidden = false;
}

function renderCompareSuggestions(items, queryText = "") {
  const box = $("#compareEntitySuggest");
  if (!box) return;
  state.compareSuggestItems = items;
  if (!items.length) {
    if (queryText.length >= 2) {
      box.innerHTML = `<div class="suggest-empty-state">No Cala match for "${escapeHtml(queryText)}".</div>`;
      box.hidden = false;
    } else {
      box.hidden = true;
      box.innerHTML = "";
    }
    return;
  }

  const pinnedIds = new Set(state.pinnedEntities.map((p) => p.id));
  const avail = items.filter((it) => !pinnedIds.has(it.id));
  if (!avail.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }

  box.innerHTML = avail
    .map(
      (item, idx) => `
      <button type="button" class="compare-suggest-btn" data-compare-index="${idx}">
        <span class="cs-kind">${escapeHtml(typeBadge(item))}</span>
        <span class="cs-title">${escapeHtml(item.name)}</span>
        <span class="cs-meta">${escapeHtml(metaOf(item))}</span>
      </button>
    `
    )
    .join("");
  box.hidden = false;
  state.compareSuggestItems = avail;
}

// ---------- Core Entity Map Analysis Orchestration ----------

async function runEntityMapAnalysis(entityRefs, options = {}) {
  const refs = entityRefs.filter((r) => r && (r.id || r.name)).slice(0, 20);
  if (!refs.length) return;

  state.analysisLoading = true;
  const submitBtn = $("#aiSearchSubmitBtn");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Searching Cala...";
  }
  updateLiveStatusPill(options.loadingMessage || `Mapping ${refs.map((r) => r.name).join(" + ")} in Cala...`);
  setStatus(`Building Cala map for ${refs.map((r) => r.name).join(", ")}...`);

  try {
    const activePersp = state.perspectiveEntity?.id || state.perspectiveEntity?.name ? state.perspectiveEntity : null;
    const validPrimary =
      state.primaryTargetId && refs.some((r) => String(r.id) === String(state.primaryTargetId))
        ? state.primaryTargetId
        : null;
    if (state.primaryTargetId && !validPrimary) state.primaryTargetId = null;

    const payload = {
      mode: "entity",
      entityRefs: refs,
      entities: refs,
      entityId: refs[0].id || undefined,
      compareEntityIds: refs.slice(1).map((r) => r.id).filter(Boolean),
      entityName: refs[0].name,
      perspectiveEntityId: activePersp?.id || undefined,
      perspectiveEntityName: activePersp?.name || undefined,
      perspectiveEntity: activePersp || undefined,
      primaryTargetId: validPrimary || undefined,
      hideMegaHubs: state.hideMegaHubs,
      discoverLive: options.discoverLive !== false
    };

    const result = await fetchJson("/api/analyze", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    const canonicalRefs = asList(result.focalEntities).map(toEntityRef).filter((r) => r.id && r.name);
    state.pinnedEntities = canonicalRefs.length ? canonicalRefs : refs;
    if (result.perspectiveEntity?.id && result.perspectiveEntity?.name) {
      state.perspectiveEntity = toEntityRef(result.perspectiveEntity);
      savePerspectiveToStorage();
    }
    state.focalEntities = canonicalRefs;
    state.comparedEntities = asList(result.comparedEntities);
    state.entityProfile = result.entityProfile || null;
    state.entityProfiles = result.bridgeMap?.entityProfiles || {};
    state.bridgeMap = result.bridgeMap || null;
    state.analysis = result;
    state.decisionSelectedFactor = options.selectedFactor || "access";
    state.decisionAnalysisRequestId += 1;
    const preserveExpanded = Boolean(options.preserveExpanded);
    state.decisionAnalysisStarted = preserveExpanded;
    state.decisionDetailView = preserveExpanded;
    setDecisionPanelExpanded(preserveExpanded);
    state.decisionAnalysisStatus = "idle";
    state.decisionAnalysisResult = null;
    state.decisionAnalysisError = "";
    state.decisionAnalysisKey = null;
    state.decisionAnalysisPendingKey = null;
    const priorDecisionOutput = $("#decisionAiOutput");
    if (priorDecisionOutput && !preserveExpanded) {
      priorDecisionOutput.hidden = true;
      priorDecisionOutput.innerHTML = "";
    }
    if (!preserveExpanded) {
      $("#decisionSummaryPopover")?.classList.remove("has-ai-results");
    }
    state.expandedGroupKey = null;
    state.selectedNodeId = null;
    state.selectedEdgeId = null;
    state.hoveredNodeId = null;
    state.hoveredEdgeId = null;

    if (result.calaBudget) {
      state.calaBudget = result.calaBudget;
      updateTelemetryPill(result.calaBudget);
    } else {
      refreshCalaBudget();
    }

    savePinnedEntitiesToStorage();
    setWorkspaceMode("map");
    syncConstellationControls();
    renderConstellationMap(undefined, { fit: options.fit !== false });
    setStatus(`Mapped ${state.pinnedEntities.map((p) => p.name).join(" · ")}`);
  } catch (err) {
    setStatus(err.message || "Unable to load Cala map.", true);
    showToast(err.message || "Unable to load Cala map.", true);
  } finally {
    state.analysisLoading = false;
    updateLiveStatusPill(null);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Cala Search";
    }
  }
}

async function resolveQueryTermsToEntities(rawQuery, maxTerms = 20) {
  const parts = String(rawQuery || "")
    .split(",")
    .map((s) => cleanText(s))
    .filter(Boolean)
    .slice(0, maxTerms);
  if (!parts.length) return [];

  updateLiveStatusPill(`Resolving ${parts.join(", ")} in Cala...`);
  const resolved = [];
  const seenIds = new Set();

  for (const term of parts) {
    const matches = await searchCalaEntities(term);
    if (!matches.length) continue;
    const needle = normalizedName(term);
    const exact = matches.find((m) => normalizedName(m.name) === needle);
    const pick = exact || matches[0];
    if (pick && !seenIds.has(pick.id)) {
      seenIds.add(pick.id);
      resolved.push(toEntityRef(pick));
    }
  }

  updateLiveStatusPill(null);
  return resolved;
}

function focusExistingMappedEntity(ref) {
  if (!ref || !ref.id) return;
  state.selectedNodeId = ref.id;
  state.selectedEdgeId = null;
  state.hoveredNodeId = null;
  state.hoveredEdgeId = null;
  applyPathLaserIsolation();
  focusNodeOnMap(ref.id);
  const pulseTargets = [
    ...document.querySelectorAll(`.map-node[data-node-id="${CSS.escape(ref.id)}"], .pinned-entity-chip[data-pin-id="${CSS.escape(ref.id)}"]`)
  ];
  for (const el of pulseTargets) {
    el.classList.remove("is-just-focused");
    void el.offsetWidth;
    el.classList.add("is-just-focused");
    setTimeout(() => el.classList.remove("is-just-focused"), 1400);
  }
  showToast(`${ref.name} is already on the map.`);
}

async function handleEntitySearchSubmit(rawQuery, options = {}) {
  closeSuggestPopup();
  const terms = cleanText(rawQuery);
  if (!terms) {
    if (state.pinnedEntities.length) {
      await runEntityMapAnalysis(state.pinnedEntities, { fit: true, discoverLive: true });
    }
    return;
  }

  const submitSeq = ++state.searchSubmitSeq;
  const refs = await resolveQueryTermsToEntities(terms);
  if (submitSeq !== state.searchSubmitSeq) return;
  if (!refs.length) {
    setStatus(`No Cala entities found for "${terms}".`, true);
    showToast(`No Cala entity found matching "${terms}".`, true);
    return;
  }

  const input = $("#aiSearchInput");
  if (input) input.value = "";

  if (options.replace || !state.pinnedEntities.length) {
    await runEntityMapAnalysis(refs, {
      fit: true,
      discoverLive: true,
      focusNewId: refs[refs.length - 1]?.id
    });
    return;
  }

  const existingIds = new Set(state.pinnedEntities.map((p) => p.id));
  const newRefs = refs.filter((r) => !existingIds.has(r.id));
  if (!newRefs.length) {
    focusExistingMappedEntity(refs[0]);
    return;
  }
  if (state.pinnedEntities.length >= 20) {
    showToast("Map displays up to 20 explored hubs cleanly. Remove one to add more.", true);
    return;
  }
  const merged = [...state.pinnedEntities, ...newRefs].slice(0, 20);
  await runEntityMapAnalysis(merged, {
    fit: true,
    discoverLive: true,
    focusNewId: newRefs[newRefs.length - 1].id
  });
}

async function focusOnlyEntityOnMap(entity) {
  const ref = toEntityRef(entity);
  if (!ref.id && !ref.name) return;
  closeSuggestPopup();
  closeCompareSuggest();
  const cInput = $("#compareEntityInput");
  if (cInput) cInput.value = "";
  const sInput = $("#aiSearchInput");
  if (sInput) sInput.value = "";
  await runEntityMapAnalysis([ref], { fit: true, discoverLive: true, focusNewId: ref.id });
}

async function addEntityToMap(entity) {
  const ref = toEntityRef(entity);
  if (!ref.id && !ref.name) return;
  closeSuggestPopup();
  closeCompareSuggest();
  const cInput = $("#compareEntityInput");
  if (cInput) cInput.value = "";
  const sInput = $("#aiSearchInput");
  if (sInput) sInput.value = "";

  if (ref.id && state.pinnedEntities.some((p) => p.id === ref.id)) {
    state.compareBoxOpen = false;
    renderExploredEntitiesBox();
    focusExistingMappedEntity(ref);
    return;
  }
  if (state.pinnedEntities.length >= 20) {
    showToast("Map displays up to 20 explored hubs cleanly. Remove one to add more.", true);
    return;
  }
  state.compareBoxOpen = false;
  renderExploredEntitiesBox();
  await runEntityMapAnalysis([...state.pinnedEntities, ref], {
    fit: true,
    discoverLive: true,
    focusNewId: ref.id
  });
}

async function removePinnedEntity(entityId) {
  const remaining = state.pinnedEntities.filter((p) => p.id !== entityId && p.key !== entityId);
  if (state.primaryTargetId && String(state.primaryTargetId) === String(entityId)) {
    state.primaryTargetId = null;
  }
  if (!remaining.length) {
    clearMapToEmpty();
    return;
  }
  await runEntityMapAnalysis(remaining, { fit: true, discoverLive: false });
}

function resetMapView({ stayOnMap = false } = {}) {
  state.pinnedEntities = [];
  state.primaryTargetId = null;
  state.bridgeMap = null;
  state.analysis = null;
  state.decisionAnalysisRequestId += 1;
  state.decisionAnalysisStarted = false;
  state.decisionDetailView = false;
  setDecisionPanelExpanded(false);
  state.decisionAnalysisStatus = "idle";
  state.decisionAnalysisResult = null;
  state.decisionAnalysisError = "";
  state.decisionAnalysisKey = null;
  state.decisionAnalysisPendingKey = null;
  state.focalEntities = [];
  state.comparedEntities = [];
  state.entityProfile = null;
  state.entityProfiles = {};
  state.mapLayoutNodes = null;
  state.expandedGroupKey = null;
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  state.hoveredNodeId = null;
  state.hoveredEdgeId = null;
  state.compareBoxOpen = false;
  state.decisionSummaryOpen = false;
  state.decisionDetailView = false;
  state.decisionAnalysisStarted = false;
  state.decisionOpenDrawers = { reasoning: false, connections: false, sources: false };
  closeSuggestPopup();
  closeCompareSuggest();
  const sInput = $("#aiSearchInput");
  if (sInput) sInput.value = "";
  savePinnedEntitiesToStorage();
  const svg = $("#constellationSvg");
  const layer = $("#constellationNodesLayer");
  if (svg) {
    svg.classList.remove("has-isolation");
    svg.innerHTML = "";
  }
  if (layer) layer.innerHTML = "";
  syncClearFocusButton();
  setWorkspaceMode(stayOnMap ? "map" : "hero");
  renderExploredEntitiesBox();
  syncConstellationControls();
  renderConstellationMap(null);
  renderDecisionSummaryWidget();
  setStatus(stayOnMap
    ? "Map is clear. Search above or use + Add to map another entity."
    : "Search any entity above or click a quick pick to map Cala paths.");
}

function clearMapToEmpty() {
  resetMapView({ stayOnMap: true });
}

function clearMapToHero() {
  resetMapView();
}

// ---------- Entity Dossier Modal (6 Evidence Tabs, Strict Cala Provenance) ----------

function profileFor(node = {}) {
  const extra = state.entityProfiles?.[node.id] || {};
  return { ...node, ...(node.profile || {}), ...(node.entity || {}), ...extra };
}

function dossierRef(node) {
  const t = typeOf(node).toLowerCase().replace(/\s+/g, "_") || "entity";
  return `${t}:${idOf(node)}`;
}

function dataForDossier(node, payload = null) {
  const root = payload?.dossier || payload?.record || payload || {};
  const identity = root.identity || payload?.identity || root.entity || payload?.entity || {};
  const profile = root.profile || payload?.profile || {};
  const mapRecord = profileFor(node);
  const identityName = cleanText(identity.name || identity.label || identity.entityName);
  const rootName = cleanText(root.name || root.label || root.entityName);
  const identityType = cleanText(identity.entityType || identity.entity_type || identity.type || identity.kind);
  const rootType = cleanText(root.entityType || root.entity_type || root.type || root.kind);
  return {
    ...mapRecord,
    ...root,
    ...profile,
    ...identity,
    identity,
    profile,
    connections: asList(root.verifiedConnections || root.connections || payload?.verifiedConnections || payload?.connections),
    id: idOf(identity) || idOf(root) || idOf(node),
    name: identityName || rootName || nameOf(node),
    entityType: identityType || rootType || typeOf(node)
  };
}

function dossierTier(data) {
  return strongestTier([data, ...asList(data.sources)]);
}

function initialsOf(name) {
  return cleanText(name)
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || "")
    .join("")
    .toUpperCase() || "E";
}

function isEntityOnMap(node) {
  const id = idOf(node);
  return state.pinnedEntities.some((p) => p.id === id);
}

async function openEntityDossier(node, options = {}) {
  const id = idOf(node);
  if (!id) return;
  const reqSeq = (state.dossierRequestSeq = (state.dossierRequestSeq || 0) + 1);
  const history = options.history || state.dossier?.history || [];
  const initial = dataForDossier(node);
  const cached = state.dossierCache.get(id);
  const currentFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  state.selectedNodeId = state.mapLayoutNodes?.nodeById?.has(id) ? id : null;
  state.selectedEdgeId = null;
  state.hoveredNodeId = null;
  state.hoveredEdgeId = null;
  hideMapTooltip();
  applyPathLaserIsolation();

  state.dossier = {
    node: { ...node, id },
    data: cached || initial,
    tab: options.tab || "overview",
    history,
    loading: !cached,
    returnFocus: options.returnFocus || state.dossier?.returnFocus || currentFocus
  };

  $("#entityDossierBackdrop").hidden = false;
  renderDossier({ resetScroll: true });
  $("#entityDossierModal")?.focus();

  if (cached) return;

  try {
    const params = new URLSearchParams({ ref: dossierRef({ ...node, id }) });
    for (const ref of state.pinnedEntities) {
      params.append("activeRef", dossierRef(ref));
    }
    if (state.pinnedEntities.length) {
      params.set("mapEntityIds", state.pinnedEntities.map((r) => r.id).join(","));
    }
    const payload = await fetchJson(`/api/entity-dossier?${params.toString()}`);
    const data = dataForDossier({ ...node, id }, payload);
    state.dossierCache.set(id, data);
    if (reqSeq === state.dossierRequestSeq && state.dossier?.node.id === id) {
      state.dossier.data = data;
      state.dossier.loading = false;
      renderDossier();
    }
  } catch {
    if (reqSeq === state.dossierRequestSeq && state.dossier?.node.id === id) {
      state.dossier.loading = false;
      renderDossier();
    }
  }
}

function openConnectionInspector(edge, options = {}) {
  if (!edge) return;
  const ctx = buildEdgeContextMeta(edge);
  const currentFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.selectedEdgeId = edge.id;
  state.selectedNodeId = null;
  state.hoveredNodeId = null;
  state.hoveredEdgeId = null;
  hideMapTooltip();
  applyPathLaserIsolation();
  state.dossier = {
    mode: "connection",
    edge,
    ctx,
    history: options.history || [],
    returnFocus: options.returnFocus || state.dossier?.returnFocus || currentFocus
  };
  $("#entityDossierBackdrop").hidden = false;
  renderDossier({ resetScroll: true });
  $("#entityDossierModal")?.focus();
}

function closeEntityDossier(options = {}) {
  const returnFocus = state.dossier?.returnFocus;
  const backdrop = $("#entityDossierBackdrop");
  if (backdrop) backdrop.hidden = true;
  state.dossier = null;
  if (!options.preserveSelection) {
    clearMapIsolation();
  }
  if (returnFocus && returnFocus.isConnected) returnFocus.focus();
}

function recordText(record) {
  if (typeof record === "string") return record;
  const base = cleanText(record.name || record.label || record.title || record.type || record.role || record.relation);
  const rest = [record.role, record.eventDate || record.date, record.description]
    .map(cleanText)
    .filter((v) => v && v !== base)
    .join(" | ");
  return [base, rest].filter(Boolean).join(" | ") || MISSING;
}

function peopleFor(data) {
  return [...asList(data.people), ...asList(data.leadership), ...asList(data.worksAt)];
}

function roundsFor(data) {
  return [...asList(data.rounds), ...asList(data.fundingRounds), ...asList(data.issuerRounds), ...asList(data.raisedRounds)];
}

function relationshipRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([direction, relations]) => {
    if (Array.isArray(relations)) return relations.map((r) => ({ ...r, direction }));
    if (!relations || typeof relations !== "object") return [];
    return Object.entries(relations).flatMap(([relation, records]) =>
      asList(records).map((r) => ({ ...r, relation, direction }))
    );
  });
}

function connectionRows(data) {
  return asList(data.connections || data.verifiedConnections);
}

function sourcesFor(data) {
  const unique = new Map();
  const records = [
    data,
    ...peopleFor(data),
    ...roundsFor(data),
    ...relationshipRows(data.relationships),
    ...connectionRows(data),
    ...asList(data.corporateEvents),
    ...asList(data.financialMetrics),
    ...asList(data.employeeCountSeries)
  ];
  for (const s of records.flatMap((r) => asList(r?.sources))) {
    const key = cleanText(s?.id || s?.url || s?.title || s?.name);
    if (key && !unique.has(key)) unique.set(key, s);
  }
  return [...unique.values()];
}

function gapListForDossier(profile, node, edges = []) {
  const gapText = (g) => (typeof g === "string" ? cleanText(g) : cleanText(g?.field || g?.label || g?.name || g?.status));
  const explicit = [...asList(profile?.missingFromCala), ...asList(profile?.gaps), ...edges.flatMap((e) => asList(e?.gaps))]
    .map(gapText)
    .filter(Boolean);
  const fallback = [];
  if (!cleanText(profile.category || profile.sector || node.sector)) fallback.push("Category / Sector");
  if (!cleanText(profile.headquarters || profile.hq || profile.hqCity || profile.address || node.hqCity)) fallback.push("Headquarters");
  if (!cleanText(profile.operationalStatus || profile.status)) fallback.push("Operational status");
  if (!peopleFor(profile).length) fallback.push("Leadership & people");
  if (!roundsFor(profile).length) fallback.push("Funding rounds");
  return [...new Set([...explicit, ...fallback])];
}

function factCardHtml(label, value, data) {
  const content = cleanText(value) || MISSING;
  return `
    <div class="fact">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(content)}</strong>
    </div>
  `;
}

function clickableChipHtml(label, record, attrName) {
  const id = idOf(record);
  const readable = formatReadableEntityLabel(label);
  return id
    ? `<button type="button" class="inline-chip" ${attrName}="${escapeHtml(id)}">${escapeHtml(readable)}</button>`
    : `<span class="inline-chip">${escapeHtml(readable)}</span>`;
}

function dossierAiCacheKey(dossier) {
  if (!dossier) return "";
  const am = getActiveAnalysisMode();
  const pId = state.perspectiveEntity?.id || "";
  if (dossier.mode === "connection") return `conn:${am}:${pId}:${dossier.edge?.id || ""}`;
  return `entity:${am}:${pId}:${dossier.node?.id || idOf(dossier.data) || ""}`;
}

function buildDossierAiInsightPacket(dossier) {
  if (!dossier) return null;
  const activeMode = getActiveAnalysisMode();
  const perspectiveEntityName = state.perspectiveEntity?.name || state.bridgeMap?.perspectiveEntity?.name || "";
  const primaryTargetObj = state.primaryTargetId
    ? state.pinnedEntities.find((p) => String(p.id) === String(state.primaryTargetId))
    : null;
  const primaryTargetName = primaryTargetObj?.name || "";

  if (dossier.mode === "connection") {
    const { edge, ctx } = dossier;
    const { citations } = collectEdgeCitations(ctx.siblings, { limit: 12 });
    return {
      mode: "connection",
      analysisMode: activeMode,
      perspectiveEntityName: perspectiveEntityName || undefined,
      primaryTargetName: primaryTargetName || undefined,
      title: `${ctx.fromName} ${ctx.arrowSymbol} ${ctx.toName}`,
      hopType: ctx.hopTypeLabel,
      relation: ctx.rawRelations.join(", "),
      roundSummary: ctx.roundSummary || "",
      date: cleanText(edge.date || edge.roundDate),
      whyMatters: ctx.whyMatters || "",
      facts: ctx.factRows.slice(0, 8).map((r) => ({
        text: r.fact,
        date: r.date || null,
        tier: r.tier,
        sourceIds: citations.map((c) => c.id).filter(Boolean).slice(0, 2)
      })),
      syndicatePeers: asList(ctx.peers).map((p) => p.name).filter(Boolean).slice(0, 8),
      gaps: ctx.linkGaps || [],
      sources: citations.filter((c) => c.id).map((c) => ({
        id: c.id,
        title: c.title,
        publisher: c.publisher,
        date: c.date || null,
        sourceRank: c.sourceRank
      }))
    };
  }

  const data = dossier.data || {};
  const node = dossier.node || {};
  const remoteConns = connectionRows(data);
  const mapEdges = mapEdgesForNode(node);
  const sources = sourcesFor(data).slice(0, 12).map((s, idx) => ({
    id: cleanText(s.id) || `src-entity-${idx}`,
    title: cleanText(s.title || s.name || s.publisher),
    publisher: cleanText(s.publisher || "Cala Knowledge Graph"),
    date: cleanText(s.date) || null,
    sourceRank: tierOf(s)
  }));
  const defaultSrcIds = sources.slice(0, 2).map((s) => s.id);
  const facts = [
    ...remoteConns.slice(0, 4).map((c) => ({
      text: `${cleanText(c.entityName || c.name)}: ${cleanText(c.relation || c.connectionType)}`,
      date: cleanText(c.eventDate) || null,
      tier: tierOf(c),
      sourceIds: cleanText(c.sourceId) ? [cleanText(c.sourceId)] : defaultSrcIds
    })),
    ...mapEdges.slice(0, 4).map((e) => ({
      text: cleanText(e.detail || e.label),
      date: cleanText(e.date) || null,
      tier: tierOf(e),
      sourceIds: asList(e.sourceIds).filter(Boolean).length ? asList(e.sourceIds).slice(0, 2) : defaultSrcIds
    }))
  ].filter((f) => f.text);

  return {
    mode: "entity",
    analysisMode: activeMode,
    perspectiveEntityName: perspectiveEntityName || undefined,
    primaryTargetName: primaryTargetName || undefined,
    title: formatReadableEntityLabel(nameOf(data), data.date),
    hopType: "Entity Dossier",
    relation: typeBadge(data),
    roundSummary: data.fundingStage || "",
    date: cleanText(data.foundingDate || data.founded),
    whyMatters: cleanText(data.description || data.summary).slice(0, 220),
    facts: facts.slice(0, 8),
    syndicatePeers: deduplicateEntityList(data.investors).map(nameOf).slice(0, 8),
    gaps: gapListForDossier(data, node, mapEdges).slice(0, 6),
    sources
  };
}

function formatCalaRelationDisplay(rawRelations = [], fromName = "", arrowSymbol = "\u2192", toName = "") {
  const list = asList(rawRelations).map((r) => cleanText(r)).filter(Boolean);
  if (!list.length) return "Verified entity link";
  const humanize = (raw) => {
    const words = String(raw || "").toLowerCase().replace(/_/g, " ").trim().replace(/\s+/g, " ");
    return words ? words.replace(/\b[a-z]/g, (ch) => ch.toUpperCase()) : "";
  };
  const label = list.map((raw) => {
    const h = humanize(raw);
    return h && h.toUpperCase() !== raw.toUpperCase() ? `${h} · ${raw}` : raw;
  }).join(", ");
  return fromName && toName ? `${label} (${fromName} ${arrowSymbol} ${toName})` : label;
}

function renderAiInsightSection(dossier) {
  const key = dossierAiCacheKey(dossier);
  if (!key) return "";
  const entry = state.aiInsightCache.get(key);

  if (entry?.loading) {
    return `
      <section class="dossier-section ai-insight-card">
        <div class="dossier-section-head-row">
          <h3>AI Diligence Brief</h3>
          <span class="tip-pill is-hop">Synthesizing verified Cala evidence...</span>
        </div>
        <div class="dossier-skeleton" aria-label="Analyzing verified Cala evidence"></div>
      </section>
    `;
  }

  if (entry?.data) {
    const res = entry.data;
    const isAi = res.controlPlaneMode === "anthropic-connection-analyst";
    const badgeLabel = isAi ? "Claude AI · Grounded in Cala" : "Deterministic Cala Brief";
    const packet = buildDossierAiInsightPacket(dossier);
    const sourceById = new Map((packet?.sources || []).map((s) => [s.id, s]));
    const rawSources = dossier.mode === "connection"
      ? collectEdgeCitations(dossier.ctx?.siblings, { limit: 40 }).citations
      : sourcesFor(dossier.data);
    const urlById = new Map();
    for (const s of rawSources) {
      const sid = cleanText(s?.id);
      const rawUrl = cleanText(s?.url || s?.document || s?.link);
      if (sid && /^https?:\/\//i.test(rawUrl)) urlById.set(sid, rawUrl);
    }
    const insightsHtml = (res.insights || []).length
      ? `<ul class="ai-insight-list">${res.insights
          .map((item) => {
            const cites = (item.sourceIds || [])
              .map((sid) => sourceById.get(sid))
              .filter(Boolean)
              .slice(0, 2)
              .map((src) => {
                const srcUrl = urlById.get(src.id) || "";
                const label = `${escapeHtml(src.publisher)}${src.date ? ` · ${escapeHtml(src.date)}` : ""}`;
                return srcUrl
                  ? `<a class="ai-cite-chip is-link" href="${escapeHtml(srcUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(src.title)}">${label} &#8599;</a>`
                  : `<span class="ai-cite-chip" title="${escapeHtml(src.title)}">${label}</span>`;
              })
              .join("");
            return `<li><span>${escapeHtml(item.text)}</span>${cites ? `<div class="ai-cite-row">${cites}</div>` : ""}</li>`;
          })
          .join("")}</ul>`
      : "";

    return `
      <section class="dossier-section ai-insight-card is-ready">
        <div class="dossier-section-head-row">
          <h3>AI Diligence Brief</h3>
          <span class="tip-pill ${isAi ? "is-hop" : ""}">${escapeHtml(badgeLabel)}</span>
        </div>
        ${res.summary ? `<p class="ai-insight-summary">${escapeHtml(res.summary)}</p>` : ""}
        ${insightsHtml}
        ${res.question ? `<div class="ai-insight-question"><strong>Next Diligence Check:</strong> ${escapeHtml(res.question)}</div>` : ""}
      </section>
    `;
  }

  return `
    <section class="dossier-section ai-insight-card">
      <div class="dossier-section-head-row">
        <div>
          <h3>AI Diligence Brief</h3>
          <div class="cell-muted" style="font-size:12px;margin-top:2px;">Synthesizes verified Cala paths &amp; citations on demand (zero ungrounded claims).</div>
        </div>
        <button type="button" class="conn-pivot-btn is-isolate" data-run-ai-insight="${escapeHtml(key)}">Analyze with Claude AI</button>
      </div>
    </section>
  `;
}

function renderConnectionInspectorBody(dossier) {
  const { edge, ctx } = dossier;
  const {
    fromNode,
    toNode,
    fromName,
    toName,
    fromType,
    toType,
    siblings,
    factRows,
    hasActualRound,
    roundSummary,
    roleDisplay,
    peers,
    sharedBridgeNode,
    sharedBridgeNodeName,
    allHubNames,
    otherFocalNames,
    rawRelations,
    hopTypeLabel,
    linkGaps,
    arrowSymbol
  } = ctx;

  const { citations, totalCount, hasExternalRecords } = collectEdgeCitations(siblings, { limit: 40 });

  const pivotActionsHtml = `
    <section class="dossier-section conn-pivot-bar">
      <div class="conn-pivot-buttons">
        ${fromNode?.id ? `<button type="button" class="conn-pivot-btn" data-inspect-entity-id="${escapeHtml(fromNode.id)}">Inspect ${escapeHtml(fromName)}${fromType ? ` (${escapeHtml(fromType)})` : ""} &rarr;</button>` : ""}
        ${toNode?.id && toNode.id !== fromNode?.id ? `<button type="button" class="conn-pivot-btn" data-inspect-entity-id="${escapeHtml(toNode.id)}">Inspect ${escapeHtml(toName)}${toType ? ` (${escapeHtml(toType)})` : ""} &rarr;</button>` : ""}
        <button type="button" class="conn-pivot-btn is-isolate" data-isolate-edge-id="${escapeHtml(edge.id)}">Isolate curve on map</button>
      </div>
    </section>
  `;

  const rolesHtml = factRows.length
    ? `<div class="timeline">${factRows
        .map(
          (row) => `
          <div class="timeline-item">
            ${row.date ? `<time>${escapeHtml(row.date)}</time>` : ""}
            <div style="flex:1 1 240px; min-width:0;">
              ${row.label ? `<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px;">${escapeHtml(row.label)}</div>` : ""}
              <strong>${escapeHtml(row.fact)}</strong>
            </div>
            <span class="source-tier" data-tier="${escapeHtml(row.tier)}">${escapeHtml(row.tier)}</span>
          </div>
        `
        )
        .join("")}</div>`
    : `<p class="dossier-empty">${escapeHtml(`${fromName} connected to ${toName}`)}</p>`;

  const dealParts = [
    { k: "Graph Path", v: hopTypeLabel },
    { k: "Cala Relation", v: formatCalaRelationDisplay(rawRelations, fromName, arrowSymbol, toName) }
  ];
  if (hasActualRound && roundSummary) dealParts.push({ k: "Round", v: roundSummary });
  else if (edge.date || edge.roundDate) dealParts.push({ k: "Observed Date", v: edge.date || edge.roundDate });
  if (roleDisplay) dealParts.push({ k: "Role", v: roleDisplay });
  if (edge.isSharedBridge && sharedBridgeNodeName && otherFocalNames.length) {
    dealParts.push({ k: "Shared Bridge", v: `${sharedBridgeNodeName} links ${allHubNames.join(" \u2194 ")}` });
  }
  if (linkGaps.length) {
    dealParts.push({ k: "Unindexed in Cala", v: linkGaps.join(", ") });
  }
  if (edge.isAnomaly && edge.anomalyReason) {
    dealParts.push({ k: "Data Flag", v: edge.anomalyReason });
  }

  const coInvestorsHtml = peers.length
    ? `
      <div style="margin-top:10px;">
        <div style="font-size:11.5px;font-weight:700;color:var(--muted);margin-bottom:6px;">VERIFIED ROUND CO-INVESTORS (${edge.syndicateTotalCount || peers.length})</div>
        <div class="inline-chip-row">
          ${peers
            .slice(0, 14)
            .map((p) => {
              const label = `${p.name}${p.isLead ? " (Lead)" : ""}`;
              return p.id
                ? `<button type="button" class="inline-chip" data-inspect-entity-id="${escapeHtml(p.id)}">${escapeHtml(label)}</button>`
                : `<span class="inline-chip">${escapeHtml(label)}</span>`;
            })
            .join("")}
        </div>
      </div>
    `
    : "";

  const dealSectionHtml = `
    <section class="dossier-section">
      <h3>Provenance, Deal Context &amp; Gaps</h3>
      <div class="fact-grid">${dealParts.map((d) => factCardHtml(d.k, d.v)).join("")}</div>
      ${sharedBridgeNode?.id && edge.isSharedBridge ? `<div class="inline-chip-row" style="margin-top:8px;"><button type="button" class="inline-chip" data-inspect-entity-id="${escapeHtml(sharedBridgeNode.id)}">Open Shared Hub: ${escapeHtml(sharedBridgeNodeName)}</button></div>` : ""}
      ${coInvestorsHtml}
    </section>
  `;

  const citationsHtml =
    citations.length && hasExternalRecords
      ? `<ul class="data-list">${citations
          .map((src) => {
            const safeUrl = /^https?:\/\//i.test(src.url || "") ? src.url : "";
            const prettyTitle = formatCleanCitationTitle(src.title, src.publisher, src.url);
            const titleText = prettyTitle || src.publisher || src.title;
            return `
              <li>
                <div>
                  ${safeUrl ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer">${escapeHtml(titleText)}</a>` : `<strong>${escapeHtml(titleText)}</strong>`}
                  <div style="color:var(--muted);font-size:12px;margin-top:2px;">${escapeHtml([src.publisher, src.date || "Undated", src.id ? `Record ${src.id.slice(0, 22)}` : ""].filter(Boolean).join(" · "))}</div>
                </div>
                <span class="source-tier" data-tier="${escapeHtml(src.sourceRank)}">${escapeHtml(src.sourceRank)}</span>
              </li>
            `;
          })
          .join("")}</ul>`
      : `<p class="dossier-empty">Verified in Cala Knowledge Graph at entity relationship level${edge.date ? ` (${escapeHtml(edge.date)})` : ""}; no external article URL is attached in Cala.</p>`;

  return `
    ${pivotActionsHtml}
    ${renderAiInsightSection(dossier)}
    <section class="dossier-section">
      <h3>Verified Cala Roles &amp; Facts (${siblings.length})</h3>
      ${rolesHtml}
    </section>
    ${dealSectionHtml}
    <section class="dossier-section">
      <h3>Verified Cala Sources (${totalCount || citations.length || 1})</h3>
      ${citationsHtml}
    </section>
  `;
}

function deduplicateEntityList(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of asList(items)) {
    const id = idOf(item);
    const label = cleanText(nameOf(item));
    const key = id ? `id:${id}` : `name:${normalizedName(label)}`;
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function formatTotalFundingDisplay(data) {
  const amt = data?.totalFunding;
  if (amt === null || amt === undefined || amt === "") return "";
  const num = Number(amt);
  const units = cleanText(data?.totalFundingUnits);
  if (Number.isFinite(num)) {
    const formatted =
      num >= 1e9 ? `${(num / 1e9).toFixed(1).replace(/\.0$/, "")}B` :
      num >= 1e6 ? `${(num / 1e6).toFixed(1).replace(/\.0$/, "")}M` :
      num.toLocaleString();
    return [formatted, units].filter(Boolean).join(" ");
  }
  return [cleanText(amt), units].filter(Boolean).join(" ");
}

function renderDossierTabContent(dossier) {
  const data = dossier.data;
  const node = dossier.node;
  const loading = dossier.loading
    ? `<div class="dossier-section"><div class="dossier-skeleton" aria-label="Loading verified Cala record"></div></div>`
    : "";

  const people = peopleFor(data);
  const rounds = roundsFor(data);
  const investors = deduplicateEntityList(data.investors);
  const remoteConns = connectionRows(data);
  const mapEdges = mapEdgesForNode(node);
  const sources = sourcesFor(data);

  if (dossier.tab === "overview") {
    const aliasList = [...new Set(asList(data.aliases).map(recordText).filter((v) => v && v !== MISSING))];
    const entityKind = typeBadge(data);
    const isPerson = entityKind === "Person";
    const affiliatedOrgs = [...new Set([...people, ...relationshipRows(data.relationships)].map((r) => formatReadableEntityLabel(nameOf(r))).filter(Boolean))]
      .slice(0, 3)
      .join(", ");
    const personRole = cleanText(data.role || data.title || data.jobTitle);
    const totalFundingLabel = formatTotalFundingDisplay(data);

    const schemaFields = isPerson
      ? [
          { label: "Category", value: populatedValue(data.category || data.sector || entityKind) },
          { label: "Role / Title", value: populatedValue(personRole) },
          { label: "Affiliations", value: populatedValue(affiliatedOrgs) },
          { label: "Location / Country", value: populatedValue(data.headquarters || data.hq || data.hqCity || data.country) },
          { label: "Website", value: populatedValue(data.website || data.domain || data.url) }
        ]
      : [
          { label: "Category", value: populatedValue(data.category || data.sector || entityKind) },
          { label: "Funding Stage", value: populatedValue(data.fundingStage) },
          { label: "Total Funding", value: populatedValue(totalFundingLabel) },
          { label: "Headquarters", value: populatedValue(data.headquarters || data.hq || data.hqCity || data.address) },
          { label: "Country", value: populatedValue(data.country) },
          { label: "Founded", value: populatedValue(data.founded || data.foundingDate) },
          { label: "Status", value: populatedValue(data.operationalStatus || data.status || data.ownershipStatus) },
          { label: "Website", value: populatedValue(data.website || data.domain || data.url) },
          { label: "Listing or Parent", value: populatedValue(data.listing || data.parentCompany || data.parent || data.acquiredBy) }
        ];

    const populated = schemaFields.filter((f) => f.value);
    const missing = schemaFields.filter((f) => !f.value);
    const displayCards = populated.length ? populated : [{ label: "Category", value: entityKind }];

    const connCount = Math.max(remoteConns.length, mapEdges.length);
    const kpiHtml = `
      <div class="dossier-kpi-strip">
        <button type="button" class="dossier-kpi-card" data-switch-dossier-tab="connections">
          <span class="kpi-num">${connCount}</span>
          <span class="kpi-lbl">Verified Links</span>
        </button>
        <button type="button" class="dossier-kpi-card" data-switch-dossier-tab="people">
          <span class="kpi-num">${people.length}</span>
          <span class="kpi-lbl">People</span>
        </button>
        <button type="button" class="dossier-kpi-card" data-switch-dossier-tab="funding">
          <span class="kpi-num">${rounds.length + investors.length}</span>
          <span class="kpi-lbl">${rounds.length ? "Rounds & Backers" : "Backers"}</span>
        </button>
        <button type="button" class="dossier-kpi-card" data-switch-dossier-tab="sources">
          <span class="kpi-num">${sources.length}</span>
          <span class="kpi-lbl">Cala Sources</span>
        </button>
      </div>
    `;

    const topConnPreview = (remoteConns.length ? remoteConns : mapEdges).slice(0, 3);
    const previewHtml = topConnPreview.length
      ? `
      <section class="dossier-section">
        <div class="dossier-section-head-row">
          <h3>Top Verified Connections</h3>
          <button type="button" class="dossier-link-btn" data-switch-dossier-tab="connections">View all (${connCount}) &rarr;</button>
        </div>
        <div class="group-entry-list">
          ${topConnPreview
            .map((item, idx) => {
              const isRemote = Boolean(item.entityId || item.connectionType);
              if (isRemote) {
                const pathSteps = asList(item.path).map((s) => formatReadableEntityLabel(nameOf(s))).filter(Boolean);
                const title = pathSteps.length ? pathSteps.join(" \u2192 ") : cleanText(item.entityName || item.name) || MISSING;
                const rel = cleanText(item.relation || item.relationship || item.connectionType);
                const tier = tierOf(item);
                return `
                  <button type="button" class="group-entry" data-focus-connection="${idx}">
                    <div class="group-entry-top">
                      <strong>${escapeHtml(title)}</strong>
                      <span class="source-tier" data-tier="${escapeHtml(tier)}">${escapeHtml(tier)}</span>
                    </div>
                    <span>${escapeHtml(rel)}${item.eventDate ? ` · ${escapeHtml(item.eventDate)}` : ""}</span>
                  </button>
                `;
              }
              const otherId = item.from === node.id ? item.to : item.from;
              const other = (state.bridgeMap?.nodes || []).find((n) => n.id === otherId);
              const title = `${formatReadableEntityLabel(nameOf(node))} \u2192 ${formatReadableEntityLabel(nameOf(other || { id: otherId }))}`;
              const tier = tierOf(item);
              return `
                <button type="button" class="group-entry" data-focus-edge="${escapeHtml(item.id)}" data-focus-node="${escapeHtml(otherId)}">
                  <div class="group-entry-top">
                    <strong>${escapeHtml(title)}</strong>
                    <span class="source-tier" data-tier="${escapeHtml(tier)}">${escapeHtml(tier)}</span>
                  </div>
                  <span>${escapeHtml(cleanText(item.detail || item.label || ""))}</span>
                </button>
              `;
            })
            .join("")}
        </div>
      </section>`
      : "";

    const aliasHtml = aliasList.length
      ? `<div class="dossier-alias-row"><span class="dossier-alias-lbl">Also known as:</span><div class="inline-chip-row">${aliasList.slice(0, 8).map((a) => `<span class="inline-chip">${escapeHtml(a)}</span>`).join("")}</div></div>`
      : "";

    return `
      ${loading}
      ${kpiHtml}
      ${renderAiInsightSection(dossier)}
      <section class="dossier-section">
        <div class="dossier-section-head-row">
          <h3>Identity</h3>
          <span class="source-tier" data-tier="${escapeHtml(dossierTier(data))}">${escapeHtml(dossierTier(data))}</span>
        </div>
        <div class="fact-grid">
          ${displayCards.map((f) => factCardHtml(f.label, f.value, data)).join("")}
        </div>
        ${aliasHtml}
        ${missing.length ? `<p class="dossier-missing-line"><span>Not indexed in Cala yet:</span> ${escapeHtml(missing.map((f) => f.label).join(" · "))}</p>` : ""}
      </section>
      <section class="dossier-section">
        <h3>Cala Summary</h3>
        <p class="dossier-empty">${escapeHtml(cleanText(data.description || data.summary) || MISSING)}</p>
      </section>
      ${previewHtml}
    `;
  }

  if (dossier.tab === "people") {
    if (!people.length) {
      return `${loading}<section class="dossier-section"><h3>People</h3><p class="dossier-empty">No people records verified in Cala for this entity.</p></section>`;
    }
    let hasMissingDates = false;
    let hasMissingPrior = false;
    return `
      ${loading}
      <section class="dossier-section">
        <h3>Leadership &amp; Verified People (${people.length})</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Relation</th>
                <th>Title</th>
                <th>Dates</th>
                <th>Prior Org</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              ${people
                .map((p) => {
                  const pid = idOf(p);
                  const pName = nameOf(p);
                  const tier = tierOf(p);
                  const nameCell = pid
                    ? `<button type="button" class="inline-chip" data-open-person="${escapeHtml(pid)}">${escapeHtml(pName)}</button>`
                    : escapeHtml(pName);
                  const relText = cleanText(p.relation || p.relationship);
                  const roleText = cleanText(p.role || p.title);
                  const span = [cleanText(p.validSince || p.since), cleanText(p.validUntil || p.until)].filter(Boolean).join(" to ");
                  const priorText = cleanText(p.priorCompany || p.prior_company);
                  if (!span) hasMissingDates = true;
                  if (!priorText) hasMissingPrior = true;
                  return `
                    <tr>
                      <td>${nameCell}</td>
                      <td>${relText ? escapeHtml(relText) : `<span class="cell-muted">-</span>`}</td>
                      <td>${roleText ? escapeHtml(roleText) : `<span class="cell-muted">-</span>`}</td>
                      <td>${span ? escapeHtml(span) : `<span class="cell-muted">-</span>`}</td>
                      <td>${priorText ? escapeHtml(priorText) : `<span class="cell-muted">-</span>`}</td>
                      <td><span class="source-tier" data-tier="${escapeHtml(tier)}">${escapeHtml(tier)}</span></td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table>
        </div>
        ${(hasMissingDates || hasMissingPrior) ? `<p class="dossier-missing-line"><span>Unindexed cells (-):</span> ${escapeHtml([hasMissingDates ? "Employment dates" : "", hasMissingPrior ? "Prior employer" : ""].filter(Boolean).join(" · "))} not found in Cala.</p>` : ""}
      </section>
    `;
  }

  if (dossier.tab === "funding") {
    const portfolio = deduplicateEntityList(data.portfolio);
    const fallback = [data.listing, data.parentCompany || data.parent, data.acquiredBy].filter(Boolean);

    const roundsHtml = rounds.length
      ? `<div class="timeline">${rounds
          .map((round) => {
            const names = [...asList(round.investors), ...asList(round.investorNames), round.leadInvestor]
              .filter(Boolean)
              .map((inv) =>
                typeof inv === "string"
                  ? `<span class="inline-chip">${escapeHtml(inv)}</span>`
                  : clickableChipHtml(nameOf(inv), inv, "data-open-investor")
              )
              .join(" ");
            const rawAmt = cleanText(round.amount ?? round.amountEurM ?? round.transactionValue);
            const rawUnit = cleanText(round.currency || round.transactionValueUnits || (round.amountEurM != null ? "EUR M" : ""));
            const amount = [rawAmt, rawUnit].filter(Boolean).join(" ");
            const dateStr = cleanText(round.date || round.eventDate);
            const tier = tierOf(round);
            return `
              <div class="timeline-item">
                <time>${escapeHtml(dateStr || "Undated")}</time>
                <strong>${escapeHtml(formatReadableEntityLabel(cleanText(round.type || round.roundType) || "Funding Round"))}</strong>
                <div>${amount ? escapeHtml(amount) : `<span class="cell-muted">Amount unindexed</span>`}</div>
                ${names ? `<div class="inline-chip-list">${names}</div>` : ""}
                <span class="source-tier" data-tier="${escapeHtml(tier)}">${escapeHtml(tier)}</span>
              </div>
            `;
          })
          .join("")}</div>`
      : `<p class="dossier-empty">No dedicated FundingRound nodes recorded in Cala${investors.length ? `; ${investors.length} investor links appear below.` : "."}</p>`;

    return `
      ${loading}
      <section class="dossier-section"><h3>Funding Rounds (${rounds.length})</h3>${roundsHtml}</section>
      <section class="dossier-section">
        <h3>Investors (${investors.length})</h3>
        ${investors.length
          ? `<ul class="data-list">${investors
              .map((inv) => {
                const tier = tierOf(inv);
                const roleMeta = [cleanText(inv.role), cleanText(inv.eventDate || inv.date)].filter(Boolean).join(" · ");
                return `<li><div>${clickableChipHtml(nameOf(inv), inv, "data-open-investor")}${roleMeta ? ` <span class="cell-muted" style="font-size:12px;margin-left:6px;">${escapeHtml(roleMeta)}</span>` : ""}</div><span class="source-tier" data-tier="${escapeHtml(tier)}">${escapeHtml(tier)}</span></li>`;
              })
              .join("")}</ul>`
          : `<p class="dossier-empty">${escapeHtml(MISSING)}</p>`}
      </section>
      <section class="dossier-section">
        <h3>Portfolio &amp; Corporate Holdings (${portfolio.length + fallback.length})</h3>
        ${portfolio.length || fallback.length
          ? `<ul class="data-list">${portfolio.map((item) => `<li>${clickableChipHtml(nameOf(item), item, "data-open-investor")}<span class="source-tier" data-tier="${escapeHtml(tierOf(item))}">${escapeHtml(tierOf(item))}</span></li>`).join("")}${fallback.map((item) => `<li><span>${escapeHtml(recordText(item))}</span></li>`).join("")}</ul>`
          : `<p class="dossier-empty">${escapeHtml(MISSING)}</p>`}
      </section>
    `;
  }

  if (dossier.tab === "connections") {
    const groupedRows = ORBIT_QUADRANTS.map((q) => {
      const edgesInGrp = mapEdges.filter((e) => getNodeContributionGroup(e) === q.group);
      const remoteInGrp = remoteConns.filter((c) => deriveContributionGroupFrontend(c) === q.group);
      const items = [
        ...edgesInGrp.map((e) => cleanText(e.detail || e.label || "")),
        ...remoteInGrp.map((c) => {
          const steps = asList(c.path).map((s) => formatReadableEntityLabel(nameOf(s))).filter(Boolean);
          return steps.length ? `${steps.join(" \u2192 ")} (${cleanText(c.relation || c.connectionType)})` : cleanText(c.relation || c.relationship);
        })
      ].filter(Boolean);
      const uniqueItems = [...new Set(items)];
      const tier = strongestTier([...edgesInGrp, ...remoteInGrp]);
      const extraCount = Math.max(0, uniqueItems.length - 4);
      const listHtml = uniqueItems.length
        ? `<ul class="dossier-group-bullets">${uniqueItems.slice(0, 4).map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>${extraCount ? `<div class="cell-muted" style="font-size:11.5px;margin-top:4px;">+${extraCount} more verified ${extraCount === 1 ? "signal" : "signals"}</div>` : ""}`
        : `<div class="cell-muted" style="font-size:12px;">No signals recorded in this category.</div>`;
      return `
        <div class="dossier-group-card">
          <div class="dossier-group-head">
            <span class="tip-lens-badge" data-group="${escapeHtml(q.group)}">${escapeHtml(q.label)}</span>
            ${uniqueItems.length ? `<span class="source-tier" data-tier="${escapeHtml(tier)}">${escapeHtml(tier)}</span>` : ""}
          </div>
          ${listHtml}
        </div>
      `;
    }).join("");

    const verifiedList = remoteConns.length
      ? `<div class="group-entry-list">${remoteConns
          .map((c, idx) => {
            const pathSteps = asList(c.path).map((step) => formatReadableEntityLabel(nameOf(step))).filter(Boolean);
            const title = pathSteps.length ? pathSteps.join(" \u2192 ") : cleanText(c.entityName || c.name || c.label) || MISSING;
            const rel = cleanText(c.relation || c.relationship || c.connectionType) || MISSING;
            const tier = tierOf(c);
            const badge = c.connectionType === "shared_bridge" ? "2-hop Shared Bridge" : "Direct 1-hop";
            return `
              <button type="button" class="group-entry" data-focus-connection="${idx}">
                <div class="group-entry-top">
                  <strong>${escapeHtml(title)}</strong>
                  <span class="source-tier" data-tier="${escapeHtml(tier)}">${escapeHtml(tier)}</span>
                </div>
                <span>${escapeHtml(badge)} · ${escapeHtml(rel)}${c.eventDate ? ` · ${escapeHtml(c.eventDate)}` : ""}</span>
              </button>
            `;
          })
          .join("")}</div>`
      : mapEdges.length
        ? `<div class="group-entry-list">${mapEdges
            .map((e) => {
              const otherId = e.from === node.id ? e.to : e.from;
              const other = (state.bridgeMap?.nodes || []).find((n) => n.id === otherId);
              const title = `${formatReadableEntityLabel(nameOf(node))} \u2192 ${formatReadableEntityLabel(nameOf(other || { id: otherId }))}`;
              const tier = tierOf(e);
              return `
                <button type="button" class="group-entry" data-focus-edge="${escapeHtml(e.id)}" data-focus-node="${escapeHtml(otherId)}">
                  <div class="group-entry-top">
                    <strong>${escapeHtml(title)}</strong>
                    <span class="source-tier" data-tier="${escapeHtml(tier)}">${escapeHtml(tier)}</span>
                  </div>
                  <span>${escapeHtml(cleanText(e.detail || MISSING))}</span>
                </button>
              `;
            })
            .join("")}</div>`
        : `<p class="dossier-empty">${escapeHtml(MISSING)}</p>`;

    return `
      ${loading}
      <section class="dossier-section">
        <h3>Contribution by Decision Group</h3>
        <div class="dossier-group-grid">${groupedRows}</div>
      </section>
      <section class="dossier-section">
        <h3>Verified Cala Paths (${remoteConns.length || mapEdges.length})</h3>
        ${verifiedList}
      </section>
    `;
  }

  if (dossier.tab === "timeline") {
    const observations = asList(data.employeeCountSeries);
    const allEvents = [
      ...asList(data.corporateEvents),
      ...asList(data.financialMetrics),
      ...relationshipRows(data.relationships)
    ];
    const datedEvents = [];
    const undatedEvents = [];
    for (const item of allEvents) {
      const dStr = cleanText(item.date || item.eventDate);
      if (dStr && /\d{4}/.test(dStr)) datedEvents.push({ item, date: dStr });
      else undatedEvents.push(item);
    }
    datedEvents.sort((a, b) => b.date.localeCompare(a.date));

    const obsHtml = observations.length
      ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Observed Value</th><th>Source</th></tr></thead><tbody>${observations
          .map((item) => {
            const tier = tierOf(item);
            return `<tr><td>${escapeHtml(cleanText(item.date) || "-")}</td><td>${escapeHtml(cleanText(item.value ?? item.count ?? item.employeeCount) || "-")}</td><td><span class="source-tier" data-tier="${escapeHtml(tier)}">${escapeHtml(tier)}</span></td></tr>`;
          })
          .join("")}</tbody></table></div>`
      : `<p class="dossier-empty">${escapeHtml(MISSING)}</p>`;

    const datedHtml = datedEvents.length
      ? `<div class="timeline">${datedEvents
          .map(({ item, date }) => {
            const tier = tierOf(item);
            return `<div class="timeline-item"><time>${escapeHtml(date)}</time><strong>${escapeHtml(formatReadableEntityLabel(recordText(item)))}</strong><span class="source-tier" data-tier="${escapeHtml(tier)}">${escapeHtml(tier)}</span></div>`;
          })
          .join("")}</div>`
      : `<p class="dossier-empty">No dated corporate events verified in Cala.</p>`;

    const undatedHtml = undatedEvents.length
      ? `<section class="dossier-section"><h3>Undated Cala Relationships (${undatedEvents.length})</h3><div class="timeline is-undated">${undatedEvents
          .slice(0, 20)
          .map((item) => {
            const tier = tierOf(item);
            return `<div class="timeline-item"><time class="cell-muted">Undated</time><strong>${escapeHtml(formatReadableEntityLabel(recordText(item)))}</strong><span class="source-tier" data-tier="${escapeHtml(tier)}">${escapeHtml(tier)}</span></div>`;
          })
          .join("")}</div>${undatedEvents.length > 20 ? `<p class="dossier-missing-line">Showing top 20 of ${undatedEvents.length} undated relationships.</p>` : ""}</section>`
      : "";

    return `
      ${loading}
      <section class="dossier-section"><h3>Dated Milestones &amp; Events (${datedEvents.length})</h3>${datedHtml}</section>
      <section class="dossier-section"><h3>Headcount &amp; Metrics</h3>${obsHtml}</section>
      ${undatedHtml}
    `;
  }

  // Sources & Gaps tab
  const gaps = gapListForDossier(data, node, mapEdges);
  const sourcesHtml = sources.length
    ? `<ul class="data-list">${sources
        .map((src) => {
          const prettyTitle = formatCleanCitationTitle(src.title || src.name, src.publisher, src.url || src.document || src.link);
          const label = prettyTitle || cleanText(src.publisher || src.title || src.name || src.id || src.url) || MISSING;
          const url = cleanText(src.url || src.document || src.link);
          const tier = tierOf(src);
          return `
            <li>
              <div>${url && /^https?:\/\//i.test(url) ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>` : escapeHtml(label)}<div style="color:var(--muted);font-size:12px;">${escapeHtml([cleanText(src.publisher), cleanText(src.date) || "Undated"].filter(Boolean).join(" · "))}</div></div>
              <span class="source-tier" data-tier="${escapeHtml(tier)}">${escapeHtml(tier)}</span>
            </li>
          `;
        })
        .join("")}</ul>`
    : `<p class="dossier-empty">${escapeHtml(MISSING)}</p>`;

  const gapsHtml = gaps.length
    ? `<ul class="data-list">${gaps.map((g) => `<li><strong>${escapeHtml(g)}</strong><span class="source-tier">${escapeHtml(MISSING)}</span></li>`).join("")}</ul>`
    : `<p class="dossier-empty">All core fields populated from Cala.</p>`;

  return `
    ${loading}
    <section class="dossier-section"><h3>Verified Cala Sources (${sources.length})</h3>${sourcesHtml}</section>
    <section class="dossier-section"><h3>Not Found in Cala (Gaps)</h3>${gapsHtml}</section>
  `;
}

function mapEdgesForNode(node) {
  return asList(state.bridgeMap?.edges).filter((e) => e.from === node.id || e.to === node.id);
}

const DOSSIER_TAB_LABELS = {
  overview: "Overview",
  people: "People",
  funding: "Funding & Investors",
  connections: "Connections",
  timeline: "Timeline",
  sources: "Sources & Gaps"
};

function renderDossier(options = {}) {
  const d = state.dossier;
  if (!d) return;

  const tabsEl = $(".dossier-tabs");
  const showMapBtn = $("#dossierShowMapBtn");
  const centerBtn = $("#dossierCenterBtn");
  const addBtn = $("#dossierAddBtn");
  const backBtn = $("#dossierBackBtn");
  const tierEl = $("#dossierTier");
  const body = $("#dossierBody");

  if (d.mode === "connection") {
    const { edge, ctx } = d;
    const { cgMeta, group, fromName, toName, fromType, toType, siblings, rank, arrowSymbol, whyMatters } = ctx;
    $("#dossierInitials").textContent = cgMeta.headerLabel.slice(0, 2);
    $("#dossierTitle").textContent = `${fromName} ${arrowSymbol} ${toName}`;
    $("#dossierTypeBadge").textContent = `${cgMeta.headerLabel} Connection`;
    $("#dossierTypeBadge").dataset.group = group;
    if (tierEl) {
      tierEl.textContent = rank;
      tierEl.dataset.tier = rank;
    }
    const metaParts = [
      fromType && toType ? `${fromType} ${arrowSymbol} ${toType}` : "",
      `${siblings.length} verified ${siblings.length === 1 ? "role" : "roles"}`,
      cleanText(edge.date || edge.roundDate)
    ].filter(Boolean);
    $("#dossierMeta").textContent = metaParts.join(" · ") || "Verified Cala Connection";
    $("#dossierDescription").textContent = whyMatters || cleanText(edge.detail) || MISSING;

    if (tabsEl) tabsEl.hidden = true;
    if (backBtn) backBtn.hidden = !d.history.length;
    if (showMapBtn) showMapBtn.hidden = true;
    if (centerBtn) centerBtn.hidden = true;
    if (addBtn) addBtn.hidden = true;
    if (body) {
      body.innerHTML = renderConnectionInspectorBody(d);
      if (options.resetScroll) body.scrollTop = 0;
    }
    return;
  }

  const { data, node } = d;
  const displayName = formatReadableEntityLabel(nameOf(data), data.date);
  const tier = dossierTier(data);

  $("#dossierInitials").textContent = initialsOf(displayName);
  $("#dossierTitle").textContent = displayName;
  $("#dossierTypeBadge").textContent = typeBadge(data);
  delete $("#dossierTypeBadge").dataset.group;
  if (tierEl) {
    tierEl.textContent = tier;
    tierEl.dataset.tier = tier;
  }
  const metaParts = [
    populatedValue(data.headquarters || data.hq || data.hqCity || data.address || data.country),
    populatedValue(data.founded || data.foundingDate),
    populatedValue(data.operationalStatus || data.status || data.role || data.title)
  ].filter(Boolean);
  $("#dossierMeta").textContent = metaParts.join(" · ") || typeBadge(data);
  $("#dossierDescription").textContent = cleanText(data.description || data.summary) || MISSING;

  if (tabsEl) tabsEl.hidden = false;
  if (showMapBtn) showMapBtn.hidden = false;
  if (centerBtn) centerBtn.hidden = false;
  if (backBtn) backBtn.hidden = !d.history.length;
  if (addBtn) addBtn.hidden = isEntityOnMap(node) || state.pinnedEntities.length >= 20;

  const peopleCount = peopleFor(data).length;
  const fundingCount = roundsFor(data).length + deduplicateEntityList(data.investors).length;
  const connCount = Math.max(connectionRows(data).length, mapEdgesForNode(node).length);
  const timelineCount =
    asList(data.employeeCountSeries).length +
    asList(data.corporateEvents).length +
    asList(data.financialMetrics).length +
    relationshipRows(data.relationships).length;
  const sourcesCount = sourcesFor(data).length;
  const tabCounts = {
    people: peopleCount,
    funding: fundingCount,
    connections: connCount,
    timeline: timelineCount,
    sources: sourcesCount
  };

  document.querySelectorAll("[data-dossier-tab]").forEach((tab) => {
    const key = tab.dataset.dossierTab;
    const active = key === d.tab;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    const base = DOSSIER_TAB_LABELS[key] || tab.textContent;
    const count = tabCounts[key];
    tab.innerHTML =
      typeof count === "number"
        ? `${escapeHtml(base)} <span class="dossier-tab-count${count === 0 ? " is-zero" : ""}">${count}</span>`
        : escapeHtml(base);
  });

  if (body) {
    body.innerHTML = renderDossierTabContent(d);
    if (options.resetScroll) body.scrollTop = 0;
  }
}

// ---------- Event Listeners ----------

function bindSearchAndCommandEvents() {
  const form = $("#aiSearchForm");
  const input = $("#aiSearchInput");
  const suggest = $("#searchSuggestPopup");

  input?.addEventListener("input", () => {
    const val = input.value;
    clearTimeout(state.suggestTimer);
    const cleaned = cleanText(val);
    if (cleaned.length < 2 || cleaned.includes(",")) {
      closeSuggestPopup();
      return;
    }
    const seq = ++state.suggestSeq;
    state.suggestTimer = setTimeout(async () => {
      try {
        const items = await searchCalaEntities(cleaned);
        if (seq === state.suggestSeq && cleanText(input.value) === cleaned) {
          renderSearchSuggestions(items, cleaned);
        }
      } catch {
        if (seq === state.suggestSeq) closeSuggestPopup();
      }
    }, 220);
  });

  input?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeSuggestPopup();
    }
  });

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await handleEntitySearchSubmit(input?.value || "");
  });

  suggest?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-suggest-action]");
    if (!btn) return;
    const item = state.suggestItems[Number(btn.dataset.suggestIndex)];
    if (!item) return;
    if (btn.dataset.suggestAction === "only") {
      await focusOnlyEntityOnMap(item);
    } else {
      await addEntityToMap(item);
    }
  });

  document.querySelectorAll("#heroCenterNav .hero-nav-pill[data-hero-pillar]").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#heroCenterNav .hero-nav-pill").forEach((b) => {
        b.classList.remove("is-active");
        b.querySelector(".hero-nav-dot")?.remove();
      });
      pill.classList.add("is-active");
      const dot = document.createElement("span");
      dot.className = "hero-nav-dot";
      dot.setAttribute("aria-hidden", "true");
      pill.prepend(dot);
      const idx = Number(pill.dataset.heroPillar || 0);
      document.querySelectorAll("#heroBottomStrip .hero-strip-item").forEach((el, itemIdx) => {
        el.classList.toggle("is-featured", itemIdx === idx);
      });
    });
  });

  $("#heroQuickDemoBtn")?.addEventListener("click", async () => {
    await handleEntitySearchSubmit("OpenAI, Nvidia, Anthropic", { replace: true });
  });

  $("#searchLiveCalaBtn")?.addEventListener("click", async () => {
    if (state.pinnedEntities.length) {
      await runEntityMapAnalysis(state.pinnedEntities, { fit: false, discoverLive: true, loadingMessage: "Refreshing live Cala graph..." });
    } else {
      await handleEntitySearchSubmit("OpenAI");
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#aiSearchForm")) closeSuggestPopup();
    if (!e.target.closest("#exploredEntitiesBox")) closeCompareSuggest();
    if (!e.target.closest("#mapMinimalHud") && state.legendPopoverOpen) {
      state.legendPopoverOpen = false;
      $("#mapLegendPopover").hidden = true;
      $("#mapLegendToggleBtn")?.setAttribute("aria-expanded", "false");
    }
  });

}

function bindFilterAndHudEvents() {
  const toggleFilters = () => {
    state.filtersPanelOpen = !state.filtersPanelOpen;
    const ribbon = $("#constellationFilterRibbon");
    if (ribbon) ribbon.hidden = !state.filtersPanelOpen;
    $("#toggleFiltersBtn")?.setAttribute("aria-expanded", String(state.filtersPanelOpen));
    if (state.filtersPanelOpen && state.perspectivePopoverOpen) {
      state.perspectivePopoverOpen = false;
      const pPop = $("#perspectivePopover");
      if (pPop) pPop.hidden = true;
      $("#perspectivePickerBtn")?.setAttribute("aria-expanded", "false");
    }
  };

  $("#toggleFiltersBtn")?.addEventListener("click", toggleFilters);
  $("#clearMapQuickBtn")?.addEventListener("click", clearMapToHero);

  $("#toggleSharedOnlyBtn")?.addEventListener("click", () => {
    state.sharedOnly = !state.sharedOnly;
    syncConstellationControls();
    renderConstellationMap(undefined, { fit: true });
  });

  $("#chipFilingOnlyBtn")?.addEventListener("click", () => {
    state.filingOnly = !state.filingOnly;
    syncConstellationControls();
    renderConstellationMap(undefined, { fit: true });
  });

  document.querySelectorAll("#bridgeFamilySwitcher [data-contribution-group]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const g = btn.dataset.contributionGroup || "all";
      state.contributionGroup = g;
      if (state.mapLayoutNodes?.mode === "polar") {
        state.expandedGroupKey = g === "all" ? null : g;
      }
      syncConstellationControls();
      renderConstellationMap(undefined, { fit: true });
    });
  });

  const resetAllFilters = () => {
    state.sharedOnly = false;
    state.filingOnly = false;
    state.contributionGroup = "all";
    state.expandedGroupKey = null;
    state.selectedNodeId = null;
    state.selectedEdgeId = null;
    state.hoveredNodeId = null;
    state.hoveredEdgeId = null;
    syncConstellationControls();
    renderConstellationMap(undefined, { fit: true });
  };
  $("#workspaceResetBtn")?.addEventListener("click", resetAllFilters);
  $("#emptyResetFiltersBtn")?.addEventListener("click", resetAllFilters);

  $("#mapDrilldownBackBtn")?.addEventListener("click", () => {
    state.expandedGroupKey = null;
    state.contributionGroup = "all";
    clearMapIsolation();
    syncConstellationControls();
    renderConstellationMap(undefined, { fit: true });
  });

  $("#mapClearFocusBtn")?.addEventListener("click", () => {
    clearMapIsolation();
    hideMapTooltip();
  });

  const closeDecisionPopover = () => {
    state.decisionSummaryOpen = false;
    const pop = $("#decisionSummaryPopover");
    if (pop) pop.hidden = true;
    setDecisionPanelExpanded(false);
    $("#decisionSummaryToggleBtn")?.setAttribute("aria-expanded", "false");
    syncDecisionOverlayBodyClasses();
  };

  // Top-left Explored Entities & Compare Drawer
  $("#toggleCompareBoxBtn")?.addEventListener("click", () => {
    state.compareBoxOpen = !state.compareBoxOpen;
    if (state.compareBoxOpen && window.innerWidth <= 900 && state.decisionSummaryOpen) {
      closeDecisionPopover();
    }
    renderExploredEntitiesBox();
    if (state.compareBoxOpen) {
      $("#compareEntityInput")?.focus();
    }
  });

  $("#pinnedEntitiesList")?.addEventListener("click", async (e) => {
    const rmBtn = e.target.closest("[data-unpin-key]");
    if (rmBtn) {
      await removePinnedEntity(rmBtn.dataset.unpinKey);
      return;
    }
    const chip = e.target.closest("[data-pin-id]");
    if (chip && state.pinnedEntities.length) {
      const target = state.pinnedEntities.find((p) => p.id === chip.dataset.pinId);
      if (target) await openEntityDossier(target);
    }
  });

  const cInput = $("#compareEntityInput");
  cInput?.addEventListener("input", () => {
    clearTimeout(state.compareSearchTimer);
    const cleaned = cleanText(cInput.value);
    if (cleaned.length < 2) {
      closeCompareSuggest();
      return;
    }
    const seq = ++state.compareSeq;
    state.compareSearchTimer = setTimeout(async () => {
      try {
        const items = await searchCalaEntities(cleaned);
        if (seq === state.compareSeq && cleanText(cInput.value) === cleaned) {
          renderCompareSuggestions(items, cleaned);
        }
      } catch {
        if (seq === state.compareSeq) closeCompareSuggest();
      }
    }, 220);
  });

  cInput?.addEventListener("keydown", async (e) => {
    if (e.key === "Enter" && cleanText(cInput.value)) {
      e.preventDefault();
      const first = state.compareSuggestItems[0];
      if (first) {
        await addEntityToMap(first);
      } else {
        const matches = await searchCalaEntities(cInput.value);
        if (matches[0]) await addEntityToMap(matches[0]);
      }
    } else if (e.key === "Escape") {
      closeCompareSuggest();
    }
  });

  $("#compareEntitySuggest")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-compare-index]");
    if (!btn) return;
    const item = state.compareSuggestItems[Number(btn.dataset.compareIndex)];
    if (item) await addEntityToMap(item);
  });

  $("#clearExploredEntitiesBtn")?.addEventListener("click", clearMapToHero);

  // Bottom-left Legend Popover
  $("#mapLegendToggleBtn")?.addEventListener("click", () => {
    state.legendPopoverOpen = !state.legendPopoverOpen;
    if (state.legendPopoverOpen && window.innerWidth <= 900 && state.decisionSummaryOpen) {
      closeDecisionPopover();
    }
    const pop = $("#mapLegendPopover");
    if (pop) pop.hidden = !state.legendPopoverOpen;
    $("#mapLegendToggleBtn")?.setAttribute("aria-expanded", String(state.legendPopoverOpen));
  });
  $("#mapLegendCloseBtn")?.addEventListener("click", () => {
    state.legendPopoverOpen = false;
    const pop = $("#mapLegendPopover");
    if (pop) pop.hidden = true;
    $("#mapLegendToggleBtn")?.setAttribute("aria-expanded", "false");
  });

  // Bottom-right 4-Factor Decision Summary Popover
  $("#decisionSummaryToggleBtn")?.addEventListener("click", () => {
    const nextOpen = !state.decisionSummaryOpen;
    if (!nextOpen) {
      closeDecisionPopover();
      return;
    }
    state.decisionSummaryOpen = true;
    if (state.compareBoxOpen) {
      state.compareBoxOpen = false;
      closeCompareSuggest();
      renderExploredEntitiesBox();
    }
    if (window.innerWidth <= 900 && state.legendPopoverOpen) {
      state.legendPopoverOpen = false;
      const legendPop = $("#mapLegendPopover");
      if (legendPop) legendPop.hidden = true;
      $("#mapLegendToggleBtn")?.setAttribute("aria-expanded", "false");
    }
    if ($("#mapStatus")?.textContent?.includes("Focused signal on constellation map")) {
      restoreDefaultMapStatus();
    }
    const pop = $("#decisionSummaryPopover");
    if (pop) pop.hidden = false;
    $("#decisionSummaryToggleBtn")?.setAttribute("aria-expanded", "true");
    resetDecisionPopoverScroll();
    renderDecisionSummaryWidget();
  });
  $("#decisionSummaryCloseBtn")?.addEventListener("click", closeDecisionPopover);
  $("#decisionAiOutput")?.addEventListener("click", (e) => {
    const focusBtn = e.target.closest("[data-focus-edge-id], [data-focus-node-id]");
    if (focusBtn) {
      focusDecisionSignalOnMap({
        edgeId: focusBtn.dataset.focusEdgeId || "",
        nodeId: focusBtn.dataset.focusNodeId || "",
        group: focusBtn.dataset.focusGroup || ""
      });
      return;
    }
    const openSourcesBtn = e.target.closest("[data-open-sources-drawer]");
    if (openSourcesBtn) {
      if (state.decisionPanelExpanded && state.decisionExpandedOpenDrawers) {
        state.decisionExpandedOpenDrawers.sourcesList = true;
        renderDecisionFactorAnalysis();
        requestAnimationFrame(() => {
          const sec = $('[data-decision-drawer-section="exp-sources"]');
          sec?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
      } else if (state.decisionOpenDrawers) {
        state.decisionOpenDrawers.sources = true;
        renderDecisionFactorAnalysis();
        requestAnimationFrame(() => {
          const sec = $('[data-decision-drawer-section="sources"]');
          sec?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
      }
      return;
    }
    const switchBtn = e.target.closest("[data-switch-factor]");
    if (switchBtn) {
      const grp = switchBtn.dataset.switchFactor;
      if (grp && grp !== state.decisionSelectedFactor) {
        resetDecisionPopoverScroll();
        runFourFactorClaudeInsight(grp);
      }
      return;
    }
    const drawerBtn = e.target.closest("[data-decision-drawer]");
    if (drawerBtn) {
      const key = drawerBtn.dataset.decisionDrawer;
      if (key === "exp-ic" && state.decisionExpandedOpenDrawers) {
        state.decisionExpandedOpenDrawers.icThesis = !state.decisionExpandedOpenDrawers.icThesis;
        renderDecisionFactorAnalysis();
        $(`[data-decision-drawer="exp-ic"]`)?.focus();
      } else if (key === "exp-reasoning" && state.decisionExpandedOpenDrawers) {
        state.decisionExpandedOpenDrawers.reasoning = !state.decisionExpandedOpenDrawers.reasoning;
        renderDecisionFactorAnalysis();
        $(`[data-decision-drawer="exp-reasoning"]`)?.focus();
      } else if (key === "exp-sources" && state.decisionExpandedOpenDrawers) {
        state.decisionExpandedOpenDrawers.sourcesList = !state.decisionExpandedOpenDrawers.sourcesList;
        renderDecisionFactorAnalysis();
        $(`[data-decision-drawer="exp-sources"]`)?.focus();
      } else if (key && state.decisionOpenDrawers) {
        state.decisionOpenDrawers[key] = !state.decisionOpenDrawers[key];
        renderDecisionFactorAnalysis();
        $(`[data-decision-drawer="${CSS.escape(key)}"]`)?.focus();
      }
      return;
    }
    if (e.target.closest("[data-decision-retry]")) {
      runFourFactorClaudeInsight(state.decisionSelectedFactor);
      return;
    }
    if (e.target.closest("[data-decision-back]")) {
      state.decisionDetailView = false;
      state.decisionAnalysisStarted = false;
      state.decisionOpenDrawers = { reasoning: false, connections: false, sources: false };
      resetDecisionPopoverScroll();
      setDecisionPanelExpanded(false);
      renderDecisionSummaryWidget();
      $("#decisionFactorTab-" + CSS.escape(state.decisionSelectedFactor))?.focus();
      return;
    }
    if (e.target.closest("[data-decision-expand]")) {
      setDecisionPanelExpanded(!state.decisionPanelExpanded);
      resetDecisionPopoverScroll();
      renderDecisionSummaryWidget();
      $("[data-decision-expand]")?.focus();
    }
  });
  $("#decisionBridgeStrip")?.addEventListener("click", (e) => {
    const focusBtn = e.target.closest("[data-focus-edge-id], [data-focus-node-id]");
    if (!focusBtn) return;
    focusDecisionSignalOnMap({
      edgeId: focusBtn.dataset.focusEdgeId || "",
      nodeId: focusBtn.dataset.focusNodeId || "",
      group: focusBtn.dataset.focusGroup || ""
    });
  });

  const closePerspectivePopover = () => {
    state.perspectivePopoverOpen = false;
    const pop = $("#perspectivePopover");
    if (pop) pop.hidden = true;
    $("#perspectivePickerBtn")?.setAttribute("aria-expanded", "false");
  };

  const renderPerspectiveResults = (items = [], query = "") => {
    const box = $("#perspectiveResults");
    if (!box) return;
    state.perspectiveResults = items;
    if (!query || query.length < 2) {
      box.innerHTML = "";
      return;
    }
    if (!items.length) {
      box.innerHTML = `<div class="perspective-empty">No Cala matches for "${escapeHtml(query)}"</div>`;
      return;
    }
    box.innerHTML = items
      .slice(0, 6)
      .map(
        (item, idx) => `
          <button type="button" class="perspective-result-item" role="option" data-perspective-index="${idx}">
            <span class="perspective-result-name">${escapeHtml(item.name || item.label)}</span>
            <span class="perspective-result-type">${escapeHtml(typeBadge(item))}</span>
          </button>
        `
      )
      .join("");
  };

  const setPerspectiveEntity = async (entityOrNull, { rerun = true } = {}) => {
    state.perspectiveEntity = entityOrNull ? toEntityRef(entityOrNull) : null;
    savePerspectiveToStorage();
    state.decisionAnalysisResult = null;
    state.decisionAnalysisKey = null;
    state.decisionAnalysisStatus = "idle";
    state.decisionAnalysisError = "";
    state.decisionDetailView = false;
    state.decisionAnalysisStarted = false;
    closePerspectivePopover();
    syncPerspectiveControl();
    if (rerun && state.pinnedEntities.length) {
      await runEntityMapAnalysis(state.pinnedEntities, { fit: true, discoverLive: Boolean(state.perspectiveEntity) });
      return;
    }
    if (!state.pinnedEntities.length && state.perspectiveEntity) {
      showToast(`Perspective set to ${state.perspectiveEntity.name} — search a target to run Origination Triage.`);
    }
  };

  $("#perspectivePickerBtn")?.addEventListener("click", () => {
    const nextOpen = !state.perspectivePopoverOpen;
    state.perspectivePopoverOpen = nextOpen;
    const pop = $("#perspectivePopover");
    if (pop) pop.hidden = !nextOpen;
    $("#perspectivePickerBtn")?.setAttribute("aria-expanded", String(nextOpen));
    if (nextOpen) {
      if (state.filtersPanelOpen) {
        state.filtersPanelOpen = false;
        const ribbon = $("#constellationFilterRibbon");
        if (ribbon) ribbon.hidden = true;
        $("#toggleFiltersBtn")?.setAttribute("aria-expanded", "false");
      }
      const inp = $("#perspectiveSearchInput");
      if (inp) {
        inp.value = "";
        renderPerspectiveResults([], "");
        inp.focus();
      }
    }
  });
  $("#perspectiveCloseBtn")?.addEventListener("click", closePerspectivePopover);
  $("#perspectiveClearBtn")?.addEventListener("click", async () => {
    await setPerspectiveEntity(null);
  });

  $("#perspectiveQuickRow")?.addEventListener("click", async (e) => {
    if (e.target.closest("[data-perspective-reset]")) {
      await setPerspectiveEntity(null);
      return;
    }
    const quickBtn = e.target.closest("[data-perspective-quick]");
    if (!quickBtn) return;
    const q = cleanText(quickBtn.dataset.perspectiveQuick);
    if (!q) return;
    updateLiveStatusPill(`Setting perspective to ${q}...`);
    try {
      const matches = await searchCalaEntities(q);
      if (matches[0]) {
        await setPerspectiveEntity(matches[0]);
      } else {
        await setPerspectiveEntity({ id: q, name: q, entityType: "Organization" });
      }
    } finally {
      updateLiveStatusPill(null);
    }
  });

  const pInput = $("#perspectiveSearchInput");
  pInput?.addEventListener("input", () => {
    clearTimeout(state.perspectiveSearchTimer);
    const cleaned = cleanText(pInput.value);
    if (cleaned.length < 2) {
      renderPerspectiveResults([], "");
      return;
    }
    const seq = ++state.perspectiveSeq;
    state.perspectiveSearchTimer = setTimeout(async () => {
      try {
        const items = await searchCalaEntities(cleaned);
        if (seq === state.perspectiveSeq && cleanText(pInput.value) === cleaned) {
          renderPerspectiveResults(items, cleaned);
        }
      } catch {
        if (seq === state.perspectiveSeq) renderPerspectiveResults([], "");
      }
    }, 220);
  });

  pInput?.addEventListener("keydown", async (e) => {
    if (e.key === "Enter" && cleanText(pInput.value)) {
      e.preventDefault();
      const first = state.perspectiveResults[0];
      if (first) {
        await setPerspectiveEntity(first);
      } else {
        const matches = await searchCalaEntities(pInput.value);
        if (matches[0]) await setPerspectiveEntity(matches[0]);
        else showToast(`No Cala entity found for "${cleanText(pInput.value)}".`, true);
      }
    } else if (e.key === "Escape") {
      closePerspectivePopover();
    }
  });

  $("#perspectiveResults")?.addEventListener("click", async (e) => {
    const row = e.target.closest("[data-perspective-index]");
    if (!row) return;
    const item = state.perspectiveResults[Number(row.dataset.perspectiveIndex)];
    if (item) await setPerspectiveEntity(item);
  });

  document.addEventListener("click", (e) => {
    if (!state.perspectivePopoverOpen) return;
    if (!e.target.closest("#perspectivePickerWrap")) {
      closePerspectivePopover();
    }
  });

  $("#decisionSummaryPopover")?.addEventListener("click", async (e) => {
    if (e.target.closest("[data-cta-add-peer]")) {
      if (state.decisionPanelExpanded) {
        setDecisionPanelExpanded(false);
        renderDecisionSummaryWidget();
      }
      if (window.innerWidth <= 900) closeDecisionPopover();
      state.compareBoxOpen = true;
      renderExploredEntitiesBox();
      requestAnimationFrame(() => $("#compareEntityInput")?.focus());
      return;
    }
    if (e.target.closest("[data-cta-set-perspective]")) {
      if (state.decisionPanelExpanded) {
        setDecisionPanelExpanded(false);
        renderDecisionSummaryWidget();
      }
      if (window.innerWidth <= 900) closeDecisionPopover();
      if (state.filtersPanelOpen) {
        state.filtersPanelOpen = false;
        const ribbon = $("#constellationFilterRibbon");
        if (ribbon) ribbon.hidden = true;
        $("#toggleFiltersBtn")?.setAttribute("aria-expanded", "false");
      }
      state.perspectivePopoverOpen = true;
      const pop = $("#perspectivePopover");
      if (pop) pop.hidden = false;
      $("#perspectivePickerBtn")?.setAttribute("aria-expanded", "true");
      requestAnimationFrame(() => $("#perspectiveSearchInput")?.focus());
      return;
    }
    if (e.target.closest("[data-reset-perspective]")) {
      const wasExpanded = state.decisionPanelExpanded;
      const prevGroup = state.decisionSelectedFactor;
      await setPerspectiveEntity(null);
      if (wasExpanded && state.bridgeMap) {
        state.decisionSelectedFactor = prevGroup;
        setDecisionPanelExpanded(true);
        await runFourFactorClaudeInsight(prevGroup);
      }
      return;
    }
    if (e.target.closest("[data-copy-triage-brief]")) {
      if (!state.bridgeMap) return;
      const s = buildFourFactorDecisionSummary(state.bridgeMap);
      const pName = state.perspectiveEntity?.name || s.executive?.perspectiveEntity?.name || "My Firm";
      const targets = state.pinnedEntities.map((p) => p.name).join(", ");
      const warm = asList(s.executive?.warmIntroChains).slice(0, 3).map((c) => `  - ${c.chainText}`);
      const conflicts = asList(s.executive?.portfolioConflicts).slice(0, 3).map((c) => `  - ${c.reason}`);
      const lines = [
        `VentureLink Origination Triage (${pName} -> ${targets})`,
        `Overall: ${s.overall.label} — ${s.investmentEffect}`,
        ...s.factors.map((f) => `- ${f.displayLabel || f.label} [${f.effect}]: ${f.line}`),
        ...(warm.length ? ["Warm Paths:", ...warm] : ["Warm Paths: None in Cala (cold outreach)"]),
        ...(conflicts.length ? ["Portfolio Conflicts:", ...conflicts] : [])
      ].join("\n");
      try {
        await navigator.clipboard?.writeText(lines);
        showToast("Copied origination triage brief to clipboard.");
      } catch {
        showToast("Unable to access clipboard.", true);
      }
      return;
    }
    const targetBtn = e.target.closest("[data-primary-target-id]");
    if (targetBtn) {
      const nextTarget = targetBtn.dataset.primaryTargetId || null;
      const wasExpanded = state.decisionPanelExpanded;
      const prevGroup = state.decisionSelectedFactor;
      state.primaryTargetId = state.primaryTargetId === nextTarget ? null : nextTarget;
      if (state.pinnedEntities.length) {
        await runEntityMapAnalysis(state.pinnedEntities, {
          fit: false,
          discoverLive: false,
          preserveExpanded: wasExpanded,
          selectedFactor: prevGroup
        });
        if (wasExpanded && state.bridgeMap) {
          await runFourFactorClaudeInsight(prevGroup);
        }
      }
    }
  });
  $("#decisionSummaryPopover")?.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (state.decisionPanelExpanded) {
      setDecisionPanelExpanded(false);
      renderDecisionSummaryWidget();
      $("[data-decision-expand]")?.focus();
    } else if (state.decisionDetailView) {
      state.decisionDetailView = false;
      state.decisionAnalysisStarted = false;
      resetDecisionPopoverScroll();
      renderDecisionSummaryWidget();
      $("#decisionFactorTab-" + CSS.escape(state.decisionSelectedFactor))?.focus();
    } else {
      closeDecisionPopover();
    }
  });
  const decisionFactorList = $("#decisionFactorList");
  decisionFactorList?.addEventListener("click", (e) => {
    const row = e.target.closest("[data-factor-group]");
    if (!row) return;
    if (state.compareBoxOpen) {
      state.compareBoxOpen = false;
      closeCompareSuggest();
      renderExploredEntitiesBox();
    }
    if (window.innerWidth <= 900 && state.legendPopoverOpen) {
      state.legendPopoverOpen = false;
      const legendPop = $("#mapLegendPopover");
      if (legendPop) legendPop.hidden = true;
      $("#mapLegendToggleBtn")?.setAttribute("aria-expanded", "false");
    }
    resetDecisionPopoverScroll();
    const grp = row.dataset.factorGroup;
    runFourFactorClaudeInsight(grp);
  });
  decisionFactorList?.addEventListener("keydown", (e) => {
    const tab = e.target.closest("[data-factor-group]");
    if (!tab || !["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    const tabs = [...decisionFactorList.querySelectorAll("[data-factor-group]")];
    const currentIndex = tabs.indexOf(tab);
    const nextIndex = e.key === "Home"
      ? 0
      : e.key === "End"
      ? tabs.length - 1
      : (currentIndex + (e.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault();
    tabs[nextIndex]?.focus();
    tabs[nextIndex]?.click();
  });

  // Top-right Zoom Controls
  $("#mapZoomInBtn")?.addEventListener("click", () => {
    state.mapZoom = clampZoom(state.mapZoom * 1.15);
    applyMapViewportTransform();
  });
  $("#mapZoomOutBtn")?.addEventListener("click", () => {
    state.mapZoom = clampZoom(state.mapZoom * 0.86);
    applyMapViewportTransform();
  });
  $("#mapFitViewBtn")?.addEventListener("click", fitConstellationToViewport);
  $("#mapCenterBtn")?.addEventListener("click", centerConstellationView);

  // Header Theme + Brand
  $("#themeToggleBtn")?.addEventListener("click", () => {
    applyTheme(getActiveTheme() === "light" ? "dark" : "light");
  });
  $("#brandHomeLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    clearMapToHero();
  });
}

function bindCanvasAndMapInteractions() {
  const canvas = $("#bridgeMapCanvas");
  const svgEl = $("#constellationSvg");
  const nodesLayer = $("#constellationNodesLayer");
  if (!canvas || !svgEl || !nodesLayer) return;

  nodesLayer.addEventListener("pointerdown", (e) => {
    const btn = e.target.closest(".map-node.is-physics-enabled[data-node-id]");
    const layout = state.mapLayoutNodes;
    const physics = state.mapPhysics;
    if (!btn || !layout || !physics || !layout.posMap.has(btn.dataset.nodeId)) return;
    const canvasRect = canvas.getBoundingClientRect();
    const worldX = (e.clientX - canvasRect.left - state.mapPanX) / state.mapZoom;
    const worldY = (e.clientY - canvasRect.top - state.mapPanY) / state.mapZoom;
    const pos = layout.posMap.get(btn.dataset.nodeId);
    const now = performance.now();
    state.mapNodeDrag = {
      id: btn.dataset.nodeId,
      pointerId: e.pointerId,
      button: btn,
      offsetX: worldX - pos.x,
      offsetY: worldY - pos.y,
      startClientX: e.clientX,
      startClientY: e.clientY,
      lastWorldX: worldX,
      lastWorldY: worldY,
      lastTime: now,
      moved: false
    };
    physics.draggedNodeId = btn.dataset.nodeId;
    physics.frameCount = 0;
    setMapNodeVelocity(physics, btn.dataset.nodeId, 0, 0, physics.maxSpeed);
    if (state.mapPhysicsRafId !== null) cancelAnimationFrame(state.mapPhysicsRafId);
    state.mapPhysicsRafId = null;
    for (const element of layout.nodeElements?.values?.() || []) {
      element.classList.remove("is-physics-running");
    }
    state.mapPhysicsLastFrame = 0;
    hideMapTooltip();
    try {
      btn.setPointerCapture(e.pointerId);
    } catch (_) {}
  });

  nodesLayer.addEventListener("pointermove", (e) => {
    const drag = state.mapNodeDrag;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const clientDistance = Math.hypot(e.clientX - drag.startClientX, e.clientY - drag.startClientY);
    if (!drag.moved && clientDistance < 4) return;
    drag.moved = true;
    drag.button.classList.add("is-physics-dragging");
    e.preventDefault();
    const canvasRect = canvas.getBoundingClientRect();
    const worldX = (e.clientX - canvasRect.left - state.mapPanX) / state.mapZoom;
    const worldY = (e.clientY - canvasRect.top - state.mapPanY) / state.mapZoom;
    const now = performance.now();
    const elapsedFrames = Math.max(1, (now - drag.lastTime) / (1000 / 60));
    const instantVx = (worldX - drag.lastWorldX) / elapsedFrames;
    const instantVy = (worldY - drag.lastWorldY) / elapsedFrames;
    const physics = state.mapPhysics;
    const nodeState = physics?.nodes.get(drag.id);
    if (nodeState) {
      setMapNodeVelocity(
        physics,
        drag.id,
        nodeState.vx * 0.35 + instantVx * 0.65,
        nodeState.vy * 0.35 + instantVy * 0.65,
        physics.maxSpeed
      );
    }
    const pos = state.mapLayoutNodes?.posMap.get(drag.id);
    if (pos) {
      pos.x = worldX - drag.offsetX;
      pos.y = worldY - drag.offsetY;
      resolveMapNodeCollisions(state.mapLayoutNodes, physics);
      renderMapPhysicsVisuals(state.mapLayoutNodes);
      recomputeMapLayoutBounds(state.mapLayoutNodes, 68);
    }
    drag.lastWorldX = worldX;
    drag.lastWorldY = worldY;
    drag.lastTime = now;
    scheduleMapPhysicsFrame();
  });

  const finishMapNodeDrag = (e) => {
    const drag = state.mapNodeDrag;
    if (!drag || (e && drag.pointerId !== e.pointerId)) return;
    state.mapNodeDrag = null;
    drag.button.classList.remove("is-physics-dragging");
    const physics = state.mapPhysics;
    const pos = state.mapLayoutNodes?.posMap.get(drag.id);
    if (physics) {
      physics.draggedNodeId = null;
      physics.frameCount = 0;
      if (pos) setMapNodeHome(state.mapLayoutNodes, physics, drag.id);
      state.mapPhysicsLastFrame = 0;
      scheduleMapPhysicsFrame();
    }
    if (drag.moved) {
      state.mapNodeClickSuppressUntil = performance.now() + 360;
      recomputeMapLayoutBounds(state.mapLayoutNodes, 68);
    }
  };

  nodesLayer.addEventListener("pointerup", finishMapNodeDrag);
  nodesLayer.addEventListener("pointercancel", finishMapNodeDrag);
  nodesLayer.addEventListener("lostpointercapture", finishMapNodeDrag);

  // Hover & Click on Nodes
  nodesLayer.addEventListener("pointerover", (e) => {
    const btn = e.target.closest("[data-node-id]");
    if (!btn) return;
    const node = state.mapLayoutNodes?.nodeById?.get(btn.dataset.nodeId);
    if (!node) return;
    state.hoveredNodeId = node.id;
    applyPathLaserIsolation();
    showMapTooltip(e.clientX, e.clientY, () => buildNodeTooltipHtml(node), `node:${node.id}`);
  });

  nodesLayer.addEventListener("pointermove", (e) => {
    if (state.mapNodeDrag?.pointerId === e.pointerId) return;
    const btn = e.target.closest("[data-node-id]");
    if (!btn) return;
    const node = state.mapLayoutNodes?.nodeById?.get(btn.dataset.nodeId);
    if (node) showMapTooltip(e.clientX, e.clientY, () => buildNodeTooltipHtml(node), `node:${node.id}`);
  });

  nodesLayer.addEventListener("pointerout", (e) => {
    const btn = e.target.closest("[data-node-id]");
    if (!btn) return;
    if (btn.contains(e.relatedTarget)) return;
    state.hoveredNodeId = null;
    applyPathLaserIsolation();
    hideMapTooltip();
  });

  nodesLayer.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-node-id]");
    if (!btn) return;
    if (e.detail !== 0 && performance.now() < state.mapNodeClickSuppressUntil) return;
    const node = state.mapLayoutNodes?.nodeById?.get(btn.dataset.nodeId);
    if (!node) return;
    hideMapTooltip();

    if (node.kind === "group_hub") {
      if (state.mapLayoutNodes?.mode === "explorer") {
        state.selectedNodeId = state.selectedNodeId === node.id ? null : node.id;
        state.selectedEdgeId = null;
        state.hoveredNodeId = null;
        state.hoveredEdgeId = null;
        applyPathLaserIsolation();
        return;
      }
      state.expandedGroupKey = state.expandedGroupKey === node.groupKey ? null : node.groupKey;
      state.selectedNodeId = null;
      state.selectedEdgeId = null;
      state.hoveredNodeId = null;
      state.hoveredEdgeId = null;
      syncConstellationControls();
      renderConstellationMap(undefined, { fit: true });
      return;
    }

    await openEntityDossier(node);
  });

  // Hover & Click on SVG Edges
  svgEl.addEventListener("pointerover", (e) => {
    const hit = e.target.closest("[data-edge-id]");
    if (!hit) return;
    const edge = (state.mapLayoutNodes?.displayEdges || []).find((it) => it.id === hit.dataset.edgeId);
    if (!edge) return;
    state.hoveredEdgeId = edge.id;
    applyPathLaserIsolation();
    showMapTooltip(e.clientX, e.clientY, () => buildEdgeTooltipHtml(edge), `edge:${edge.id}`);
  });

  svgEl.addEventListener("pointermove", (e) => {
    const hit = e.target.closest("[data-edge-id]");
    if (!hit) return;
    const edge = (state.mapLayoutNodes?.displayEdges || []).find((it) => it.id === hit.dataset.edgeId);
    if (edge) showMapTooltip(e.clientX, e.clientY, () => buildEdgeTooltipHtml(edge), `edge:${edge.id}`);
  });

  svgEl.addEventListener("pointerout", (e) => {
    const hit = e.target.closest("[data-edge-id]");
    if (!hit) return;
    if (state.hoveredEdgeId === hit.dataset.edgeId) {
      state.hoveredEdgeId = null;
      applyPathLaserIsolation();
    }
    hideMapTooltip();
  });

  let lastPointerDownEdge = null;
  svgEl.addEventListener("pointerdown", (e) => {
    const hit = e.target.closest("[data-edge-id]");
    lastPointerDownEdge = hit
      ? { id: hit.dataset.edgeId, x: e.clientX, y: e.clientY }
      : null;
  });

  svgEl.addEventListener("click", async (e) => {
    const hit = e.target.closest("[data-edge-id]");
    const edgeId =
      hit?.dataset.edgeId ||
      (lastPointerDownEdge && Math.hypot(e.clientX - lastPointerDownEdge.x, e.clientY - lastPointerDownEdge.y) <= 8
        ? lastPointerDownEdge.id
        : null);
    lastPointerDownEdge = null;
    if (!edgeId) return;
    const edge = (state.mapLayoutNodes?.displayEdges || []).find((it) => it.id === edgeId);
    if (!edge) return;
    hideMapTooltip();
    const targetNode =
      state.mapLayoutNodes?.nodeById?.get(edge.realNodeId || edge.to) ||
      state.mapLayoutNodes?.nodeById?.get(edge.from);
    if (edge.isOverviewSpoke || (targetNode && targetNode.kind === "group_hub")) {
      const groupKey = edge.contributionGroup || targetNode?.groupKey;
      if (groupKey) {
        state.expandedGroupKey = state.expandedGroupKey === groupKey ? null : groupKey;
        state.selectedNodeId = null;
        state.selectedEdgeId = null;
        state.hoveredNodeId = null;
        state.hoveredEdgeId = null;
        syncConstellationControls();
        renderConstellationMap(undefined, { fit: true });
      }
      return;
    }
    openConnectionInspector(edge);
  });

  // Trackpad Pan & Pinch-Zoom + Mouse Drag Pan
  const decisionPopover = $("#decisionSummaryPopover");
  let decisionMiddleScroll = null;
  decisionPopover?.addEventListener(
    "wheel",
    (e) => {
      // Route a mouse wheel directly to the analysis panel instead of letting
      // the map's canvas wheel handler consume it for viewport panning.
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) return;
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? decisionPopover.clientHeight
          : 1;
      const deltaY = e.deltaY || (e.shiftKey ? e.deltaX : 0);
      if (decisionPopover.scrollHeight <= decisionPopover.clientHeight + 1 || !deltaY) return;
      e.preventDefault();
      decisionPopover.scrollTop += deltaY * unit;
    },
    { passive: false }
  );
  decisionPopover?.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    if (e.button !== 1) return;
    if (e.target.closest?.("a")) return;
    // The canvas normally captures pointers to pan the map. Keep a middle-button
    // drag inside the decision panel so analysts can scroll its long evidence view.
    e.preventDefault();
    decisionMiddleScroll = { pointerId: e.pointerId, y: e.clientY };
    decisionPopover.classList.add("is-middle-scrolling");
    try {
      decisionPopover.setPointerCapture(e.pointerId);
    } catch (_) {}
  });
  decisionPopover?.addEventListener("pointermove", (e) => {
    if (!decisionMiddleScroll || decisionMiddleScroll.pointerId !== e.pointerId) return;
    e.preventDefault();
    decisionPopover.scrollTop += decisionMiddleScroll.y - e.clientY;
    decisionMiddleScroll.y = e.clientY;
  });
  const finishDecisionMiddleScroll = (e) => {
    if (!decisionMiddleScroll || (e?.pointerId != null && decisionMiddleScroll.pointerId !== e.pointerId)) return;
    const pointerId = decisionMiddleScroll.pointerId;
    decisionMiddleScroll = null;
    decisionPopover.classList.remove("is-middle-scrolling");
    try {
      if (decisionPopover.hasPointerCapture(pointerId)) decisionPopover.releasePointerCapture(pointerId);
    } catch (_) {}
  };
  decisionPopover?.addEventListener("pointerup", finishDecisionMiddleScroll);
  decisionPopover?.addEventListener("pointercancel", finishDecisionMiddleScroll);
  decisionPopover?.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    e.stopPropagation();
    if (e.target.closest?.("a")) return;
    e.preventDefault();
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      if (e.target.closest?.(".decision-summary-popover, .map-legend-popover")) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = canvas.getBoundingClientRect();
        const beforeX = (e.clientX - rect.left - state.mapPanX) / state.mapZoom;
        const beforeY = (e.clientY - rect.top - state.mapPanY) / state.mapZoom;
        const factor = e.deltaY < 0 ? 1.09 : 0.91;
        const nextZoom = clampZoom(state.mapZoom * factor);
        state.mapPanX = Math.round(e.clientX - rect.left - beforeX * nextZoom);
        state.mapPanY = Math.round(e.clientY - rect.top - beforeY * nextZoom);
        state.mapZoom = nextZoom;
      } else {
        state.mapPanX -= e.deltaX;
        state.mapPanY -= e.deltaY;
      }
      applyMapViewportTransform();
    },
    { passive: false }
  );

  canvas.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".map-node, [data-edge-id], .edge-hit-target, button, input, aside, .map-zoom-controls, .map-minimal-hud, .map-top-center-bar, .decision-summary-popover, .map-legend-popover, .map-bottom-left-overlay, .map-bottom-right-overlay")) {
      return;
    }
    state.pointerPan = { x: e.clientX, y: e.clientY, panX: state.mapPanX, panY: state.mapPanY };
    canvas.classList.add("is-panning");
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (_) {}
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!state.pointerPan) return;
    state.mapPanX = state.pointerPan.panX + (e.clientX - state.pointerPan.x);
    state.mapPanY = state.pointerPan.panY + (e.clientY - state.pointerPan.y);
    applyMapViewportTransform();
  });

  const finishPan = (e, allowClickClear) => {
    const pan = state.pointerPan;
    state.pointerPan = null;
    canvas.classList.remove("is-panning");
    if (
      allowClickClear &&
      pan &&
      e &&
      Math.hypot(e.clientX - pan.x, e.clientY - pan.y) <= 5
    ) {
      clearMapIsolation();
      hideMapTooltip();
    }
  };
  canvas.addEventListener("pointerup", (e) => finishPan(e, true));
  canvas.addEventListener("pointercancel", () => finishPan(null, false));

  window.addEventListener("resize", () => {
    if (state.workspaceMode === "map" && state.bridgeMap) {
      fitConstellationToViewport();
    }
  });
}

function bindDossierEvents() {
  const backdrop = $("#entityDossierBackdrop");
  backdrop?.addEventListener("click", (e) => {
    if (e.target === backdrop) closeEntityDossier();
  });

  $("#dossierCloseBtn")?.addEventListener("click", () => closeEntityDossier());
  $("#dossierBackBtn")?.addEventListener("click", () => {
    const prev = state.dossier?.history?.pop();
    if (!prev) return;
    if (prev.mode === "connection" && prev.edge) {
      openConnectionInspector(prev.edge, { history: state.dossier.history });
    } else {
      openEntityDossier(prev, { history: state.dossier.history });
    }
  });

  $("#dossierShowMapBtn")?.addEventListener("click", () => {
    const node = state.dossier?.node;
    if (!node) return;
    closeEntityDossier({ preserveSelection: true });
    state.selectedNodeId = node.id;
    state.selectedEdgeId = null;
    state.hoveredNodeId = null;
    state.hoveredEdgeId = null;
    applyPathLaserIsolation();
    focusNodeOnMap(node.id);
  });

  $("#dossierCenterBtn")?.addEventListener("click", async () => {
    const data = state.dossier?.data;
    const node = state.dossier?.node;
    if (!node) return;
    closeEntityDossier();
    await focusOnlyEntityOnMap({ ...node, ...data });
  });

  $("#dossierAddBtn")?.addEventListener("click", async () => {
    const data = state.dossier?.data;
    const node = state.dossier?.node;
    if (!node) return;
    closeEntityDossier();
    await addEntityToMap({ ...node, ...data });
  });

  const dossierTabs = [...document.querySelectorAll("[data-dossier-tab]")];
  dossierTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      if (!state.dossier) return;
      state.dossier.tab = tab.dataset.dossierTab;
      renderDossier({ resetScroll: true });
    });
    tab.addEventListener("keydown", (e) => {
      if (!state.dossier || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
      e.preventDefault();
      const delta = e.key === "ArrowRight" ? 1 : -1;
      const nextTab = dossierTabs[(index + delta + dossierTabs.length) % dossierTabs.length];
      if (!nextTab) return;
      state.dossier.tab = nextTab.dataset.dossierTab;
      renderDossier({ resetScroll: true });
      nextTab.focus();
    });
  });

  $("#dossierBody")?.addEventListener("click", async (e) => {
    const aiBtn = e.target.closest("[data-run-ai-insight]");
    if (aiBtn && state.dossier) {
      const key = aiBtn.dataset.runAiInsight;
      const packet = buildDossierAiInsightPacket(state.dossier);
      if (!packet) return;
      state.aiInsightCache.set(key, { loading: true });
      renderDossier();
      try {
        const res = await fetchJson("/api/connection-insight", {
          method: "POST",
          body: JSON.stringify(packet)
        });
        state.aiInsightCache.set(key, { loading: false, data: res });
      } catch {
        state.aiInsightCache.delete(key);
        showToast("Unable to run AI insight right now.", true);
      }
      if (state.dossier && dossierAiCacheKey(state.dossier) === key) {
        renderDossier();
      }
      return;
    }

    const switchTabBtn = e.target.closest("[data-switch-dossier-tab]");
    if (switchTabBtn && state.dossier) {
      state.dossier.tab = switchTabBtn.dataset.switchDossierTab;
      renderDossier({ resetScroll: true });
      return;
    }

    const inspectBtn = e.target.closest("[data-inspect-entity-id]");
    if (inspectBtn && state.dossier) {
      const targetId = inspectBtn.dataset.inspectEntityId;
      const existing = (state.bridgeMap?.nodes || []).find((n) => n.id === targetId);
      const historyEntry =
        state.dossier.mode === "connection"
          ? { mode: "connection", edge: state.dossier.edge }
          : state.dossier.node;
      const nextNode = existing || { id: targetId, name: inspectBtn.textContent };
      openEntityDossier(nextNode, { history: [...state.dossier.history, historyEntry] });
      return;
    }

    const isolateBtn = e.target.closest("[data-isolate-edge-id]");
    if (isolateBtn) {
      const edgeId = isolateBtn.dataset.isolateEdgeId;
      const edge = (state.mapLayoutNodes?.displayEdges || []).find((it) => it.id === edgeId);
      closeEntityDossier({ preserveSelection: true });
      state.selectedEdgeId = edgeId;
      state.selectedNodeId = null;
      state.hoveredNodeId = null;
      state.hoveredEdgeId = null;
      applyPathLaserIsolation();
      if (edge) focusNodeOnMap(edge.realNodeId || edge.to || edge.from);
      return;
    }

    const personBtn = e.target.closest("[data-open-person]");
    const invBtn = e.target.closest("[data-open-investor]");
    const openId = personBtn?.dataset.openPerson || invBtn?.dataset.openInvestor;
    if (openId && state.dossier) {
      const existing = (state.bridgeMap?.nodes || []).find((n) => n.id === openId);
      const nextNode = existing || {
        id: openId,
        name: e.target.textContent,
        entityType: personBtn ? "Person" : "Organization"
      };
      openEntityDossier(nextNode, { history: [...state.dossier.history, state.dossier.node] });
      return;
    }

    const focusEdge = e.target.closest("[data-focus-edge]");
    if (focusEdge) {
      closeEntityDossier({ preserveSelection: true });
      state.selectedEdgeId = focusEdge.dataset.focusEdge;
      state.selectedNodeId = focusEdge.dataset.focusNode || null;
      state.hoveredNodeId = null;
      state.hoveredEdgeId = null;
      applyPathLaserIsolation();
      if (state.selectedNodeId) focusNodeOnMap(state.selectedNodeId);
      return;
    }

    const focusConn = e.target.closest("[data-focus-connection]");
    if (focusConn && state.dossier) {
      const rows = connectionRows(state.dossier.data);
      const rec = rows[Number(focusConn.dataset.focusConnection)];
      const counterpartId = cleanText(rec?.entityId || idOf(rec?.bridge));
      closeEntityDossier({ preserveSelection: true });
      if (counterpartId) {
        state.selectedNodeId = counterpartId;
        state.selectedEdgeId = null;
        state.hoveredNodeId = null;
        state.hoveredEdgeId = null;
        applyPathLaserIsolation();
        focusNodeOnMap(counterpartId);
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    if (!backdrop || backdrop.hidden) {
      if (e.key === "Escape") {
        const suggest = $("#entitySuggestPopup");
        if (suggest && !suggest.hidden) {
          closeSuggestPopup();
          return;
        }
        const compareSuggest = $("#compareEntitySuggest");
        if (compareSuggest && !compareSuggest.hidden) {
          closeCompareSuggest();
          return;
        }
        if (state.perspectivePopoverOpen) {
          state.perspectivePopoverOpen = false;
          const pPop = $("#perspectivePopover");
          if (pPop) pPop.hidden = true;
          $("#perspectivePickerBtn")?.setAttribute("aria-expanded", "false");
          return;
        }
        if (state.legendPopoverOpen) {
          state.legendPopoverOpen = false;
          const pop = $("#mapLegendPopover");
          if (pop) pop.hidden = true;
          $("#mapLegendToggleBtn")?.setAttribute("aria-expanded", "false");
          return;
        }
        if (state.selectedNodeId || state.selectedEdgeId || state.hoveredNodeId || state.hoveredEdgeId) {
          e.preventDefault();
          clearMapIsolation();
          hideMapTooltip();
          return;
        }
        if (state.filtersPanelOpen) {
          state.filtersPanelOpen = false;
          const ribbon = $("#constellationFilterRibbon");
          if (ribbon) ribbon.hidden = true;
          $("#toggleFiltersBtn")?.setAttribute("aria-expanded", "false");
        }
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeEntityDossier();
      return;
    }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && state.dossier?.mode !== "connection") {
      if (!state.pinnedEntities.length) return;
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      const idx = Math.max(0, state.pinnedEntities.findIndex((p) => p.id === state.dossier?.node?.id));
      const next = state.pinnedEntities[(idx + dir + state.pinnedEntities.length) % state.pinnedEntities.length];
      if (next) openEntityDossier(next, { history: state.dossier.history });
    }
    if (e.key === "Tab") {
      const modal = $("#entityDossierModal");
      if (!modal) return;
      const focusable = [...modal.querySelectorAll("button:not([hidden]), a[href], [tabindex]:not([tabindex='-1'])")].filter((el) => !el.disabled);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}

// ---------- Bootstrap ----------

async function initApp() {
  applyTheme(getActiveTheme());
  bindSearchAndCommandEvents();
  bindFilterAndHudEvents();
  bindCanvasAndMapInteractions();
  bindDossierEvents();

  try {
    const [boot, budget] = await Promise.all([
      fetchJson("/api/bootstrap").catch(() => null),
      fetchJson("/api/cala-budget").catch(() => null)
    ]);
    state.bootstrap = boot;
    state.calaBudget = budget;
    updateTelemetryPill(budget);
  } catch (_) {}

  state.perspectiveEntity = loadPerspectiveFromStorage();
  syncPerspectiveControl();

  const saved = loadPinnedEntitiesFromStorage();
  if (saved.length) {
    await runEntityMapAnalysis(saved, { fit: true, discoverLive: true });
    return;
  }

  // Boot directly into a calm verified entity constellation if Cala/cache has OpenAI
  try {
    const matches = await searchCalaEntities("OpenAI");
    if (matches.length) {
      await runEntityMapAnalysis([toEntityRef(matches[0])], { fit: true, discoverLive: true });
      return;
    }
  } catch (_) {}

  setWorkspaceMode("hero");
  setStatus("Search any entity above or click a quick pick to map Cala paths.");
}

initApp();
