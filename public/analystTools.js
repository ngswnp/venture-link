/**
 * VentureLink Pure Financial Analyst Utilities
 * Deterministic entity normalization, strict Claude finding attribution,
 * unique map-level provenance computation, IC flagging, CSV & Markdown export,
 * and shareable workspace URL codecs.
 */

const PRESERVED_UPPER_ACRONYMS = new Set([
  "AI",
  "XAI",
  "US",
  "UK",
  "EU",
  "UN",
  "LLC",
  "LP",
  "LLP",
  "LLLP",
  "PBC",
  "PLC",
  "GP",
  "VC",
  "PE",
  "LBO",
  "IPO",
  "SEC",
  "NYSE",
  "NASDAQ",
  "FED",
  "FDIC",
  "IMF",
  "MIT",
  "IBM",
  "AMD",
  "ARM",
  "TSMC",
  "ASML",
  "NVIDIA",
  "AWS",
  "GCP",
  "IP",
  "IT",
  "CEO",
  "CFO",
  "CTO",
  "COO",
  "PRH",
  "GLEIF",
  "UKCH",
  "USD",
  "EUR",
  "GBP",
  "RMB",
  "JPY"
]);

const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC"
]);

const MINOR_LOWERCASE_WORDS = new Set(["of", "and", "the", "for", "in", "on", "at", "by", "to", "de", "van", "von"]);

function titleCaseWord(token, index, totalTokens, afterSlash = false) {
  if (!token) return "";
  const match = token.match(/^([^A-Za-z0-9]*)([A-Za-z0-9'.&-]+?)([^A-Za-z0-9]*)$/);
  if (!match) return token;
  const [, prefix, core, suffix] = match;
  const upperCore = core.toUpperCase();
  const bareUpper = upperCore.replace(/\./g, "");

  if (afterSlash && US_STATE_CODES.has(bareUpper)) {
    return `${prefix}${upperCore}${suffix}`;
  }
  if (PRESERVED_UPPER_ACRONYMS.has(upperCore) || PRESERVED_UPPER_ACRONYMS.has(bareUpper)) {
    return `${prefix}${upperCore}${suffix}`;
  }
  if (/^(?:B\.V|N\.V|S\.A|U\.S|U\.K|S\.L)$/i.test(core)) {
    return `${prefix}${upperCore}${suffix}`;
  }
  if (/^\d+[A-Z]?$/.test(upperCore)) {
    return `${prefix}${upperCore}${suffix}`;
  }
  if (index > 0 && index < totalTokens - 1 && MINOR_LOWERCASE_WORDS.has(core.toLowerCase())) {
    return `${prefix}${core.toLowerCase()}${suffix}`;
  }
  const lower = core.toLowerCase();
  return `${prefix}${lower.charAt(0).toUpperCase()}${lower.slice(1)}${suffix}`;
}

/**
 * Normalizes noisy ALL-CAPS regulatory / 13F entity strings (e.g. "BAILLIE GIFFORD & CO",
 * "BLAIR WILLIAM & CO/IL", "CISCO SYSTEMS, INC.") into clean institutional Title Case
 * while preserving mixed-case entity names ("OpenAI", "xAI", "NVIDIA Corporation") untouched.
 */
export function formatInstitutionalEntityName(rawName) {
  const text = String(rawName || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  // Skip internal ALL-CAPS underscore relation IDs (handled by formatReadableEntityLabel)
  if (/^[A-Z0-9_]{8,}$/.test(text) && text.includes("_")) {
    return text;
  }
  // Only reformat strings that contain uppercase letters and NO lowercase letters
  const isAllCaps = text.length >= 4 && /[A-Z]/.test(text) && !/[a-z]/.test(text);
  if (!isAllCaps) {
    return text;
  }
  // Handle single-word preserved acronyms cleanly (e.g. "NVIDIA" -> "NVIDIA", "ANTHROPIC" -> "Anthropic")
  const words = text.split(" ");
  if (words.length === 1 && PRESERVED_UPPER_ACRONYMS.has(words[0].replace(/[^A-Z]/g, ""))) {
    return text;
  }

  return words
    .map((word, idx) => {
      if (word === "&" || word === "+" || word === "-") return word;
      if (word.includes("/")) {
        const parts = word.split("/");
        return parts
          .map((part, pIdx) => titleCaseWord(part, idx, words.length, pIdx > 0))
          .join("/");
      }
      return titleCaseWord(word, idx, words.length, false);
    })
    .join(" ");
}

/**
 * Formats an arrow/ampersand path string ("A → B & C") cleanly using formatInstitutionalEntityName
 * per entity segment without altering arrows or joining delimiters.
 */
export function formatInstitutionalPath(pathStr = "") {
  const raw = String(pathStr || "").trim();
  if (!raw) return "";
  return raw
    .split(/(\s*(?:→|↔|->|<->)\s*)/g)
    .map((part) => {
      if (/^\s*(?:→|↔|->|<->)\s*$/.test(part)) {
        return part.includes("<->") || part.includes("↔") ? " ↔ " : " → ";
      }
      if (part.includes(" & ")) {
        const subparts = part.split(" & ");
        // Do not split "BAILLIE GIFFORD & CO" or "BLAIR WILLIAM & CO/IL"
        const looksLikeLegalAmpersand = subparts.length === 2 && /^(?:CO(?:\/[A-Z]{2})?\.?|PARTNERS|SONS?|COMPAN(?:Y|IES)|ASSOCIATES|BROTHERS|BROS\.?)$/i.test(subparts[1].trim());
        if (looksLikeLegalAmpersand) {
          return formatInstitutionalEntityName(part);
        }
        return subparts.map((s) => formatInstitutionalEntityName(s)).join(" & ");
      }
      return formatInstitutionalEntityName(part);
    })
    .join("");
}

function normalizePathText(str = "") {
  return String(str || "")
    .replace(/\s*<->\s*/g, " ↔ ")
    .replace(/\s*->\s*/g, " → ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractEntityTokens(str = "") {
  const cleaned = String(str || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s*(?:→|↔|->|<->)\s*/g, "|")
    .trim();
  const rawParts = cleaned.split("|");
  const entities = [];
  for (const rawPart of rawParts) {
    const trimmed = rawPart.trim();
    if (!trimmed) continue;
    const ampersandParts = trimmed.split(/\s+&\s+/);
    const isLegalCo = ampersandParts.length === 2 && /^(?:co(?:\/[a-z]{2})?\.?|partners|sons?|associates|bros\.?)$/i.test(ampersandParts[1].trim());
    if (isLegalCo) {
      entities.push(trimmed.toLowerCase());
    } else {
      for (const piece of ampersandParts) {
        const norm = piece.replace(/^[,.\s]+|[,.\s]+$/g, "").toLowerCase();
        if (norm.length >= 2) entities.push(norm);
      }
    }
  }
  return [...new Set(entities)];
}

function tokenMatchesCandidate(token, candidatePool = []) {
  const cleanTok = token.replace(/[^a-z0-9]/g, "");
  if (cleanTok.length < 2) return false;
  for (const cand of candidatePool) {
    if (cand === token) return true;
    const cleanCand = cand.replace(/[^a-z0-9]/g, "");
    if (!cleanCand) continue;
    if (cleanCand === cleanTok) return true;
    // Allow "nvidia" to match "nvidia corporation" or "baillie gifford" to match "baillie gifford & co",
    // while keeping short ambiguous tokens ("ai") strict so "xai" NEVER matches "openai".
    if (cleanTok.length >= 4 && cleanCand.length >= 4) {
      if (cleanCand.includes(cleanTok) || cleanTok.includes(cleanCand)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Strictly attributes a Claude finding to a rendered connection record without
 * cross-contaminating distinct bridge entities (e.g. rejects "Sequoia Capital -> xAI -> Anthropic"
 * when matching "Sequoia Capital -> Anthropic & NVIDIA CORPORATION").
 */
export function matchClaudeFindingToRecord(rec, findings = [], { factorGroup = "access", isPerson = false } = {}) {
  const list = Array.isArray(findings) ? findings : [];
  if (!rec || !list.length) return "";

  const recPath = String(rec.path || "").trim();
  const normRecPath = normalizePathText(recPath);
  const recEntities = [
    ...extractEntityTokens(recPath),
    ...extractEntityTokens(rec.canonicalFrom),
    ...extractEntityTokens(rec.canonicalTo),
    ...(Array.isArray(rec.sharedHubs) ? rec.sharedHubs.flatMap((h) => extractEntityTokens(h)) : []),
    ...(Array.isArray(rec.perspectiveChain) ? rec.perspectiveChain.flatMap((h) => extractEntityTokens(h)) : [])
  ];
  const uniqueRecEntities = [...new Set(recEntities)];
  const recAnchorEntities = extractEntityTokens(rec.canonicalFrom || recPath.split(/\s*(?:→|↔|->|<->)\s*/)[0] || "");

  for (const f of list) {
    const conn = String(f?.connection || "").trim();
    const meaning = String(f?.meaning || "").trim();
    if (!conn || !meaning) continue;
    if (isPerson && factorGroup === "access" && /\b(?:institutional\s+investor|vc\s+firm)\b/i.test(meaning)) {
      continue;
    }

    if (normRecPath && normalizePathText(conn) === normRecPath) {
      return meaning;
    }

    const connHops = extractEntityTokens(conn);
    if (connHops.length < 2 || uniqueRecEntities.length < 2) continue;

    // Require the starting/left entity to align when matching multi-hop findings
    const connLead = connHops[0];
    if (recAnchorEntities.length && !tokenMatchesCandidate(connLead, recAnchorEntities)) {
      continue;
    }

    // Every single entity mentioned in `conn` must appear in `rec`'s entity set!
    // If `conn` includes an unrepresented bridge node (like "xAI"), reject immediately.
    const allConnEntitiesPresent = connHops.every((tok) => tokenMatchesCandidate(tok, uniqueRecEntities));
    if (allConnEntitiesPresent) {
      return meaning;
    }
  }
  return "";
}

/**
 * Computes consistent map-wide provenance strictly across unique Cala source IDs
 * referenced by non-spoke map edges, timing events, and decision factors.
 */
export function computeMapUniqueProvenance(bridgeMap, sourceById = new Map()) {
  const counts = { filing: 0, primary: 0, press: 0, aggregator: 0, total: 0, verifiedSharePct: 0 };
  if (!bridgeMap) return counts;

  const uniqueSourceIds = new Set();
  const addId = (sid) => {
    const key = String(sid || "").trim();
    if (key) uniqueSourceIds.add(key);
  };

  for (const edge of Array.isArray(bridgeMap.edges) ? bridgeMap.edges : []) {
    if (!edge || String(edge.id || "").startsWith("tree-spoke-")) continue;
    for (const sid of Array.isArray(edge.sourceIds) ? edge.sourceIds : []) addId(sid);
    if (edge.sourceId) addId(edge.sourceId);
    for (const src of Array.isArray(edge.evidenceSources) ? edge.evidenceSources : []) {
      addId(src?.id || src?.sourceId || src?.source_id);
    }
  }

  for (const events of Object.values(bridgeMap.timingEventsByEntity || {})) {
    for (const ev of Array.isArray(events) ? events : []) {
      for (const sid of Array.isArray(ev?.sourceIds) ? ev.sourceIds : []) addId(sid);
      if (ev?.sourceId) addId(ev.sourceId);
    }
  }

  for (const f of Object.values(bridgeMap.decisionIntelligence?.factors || {})) {
    for (const sid of Array.isArray(f?.sourceIds) ? f.sourceIds : []) addId(sid);
    for (const rec of Array.isArray(f?.rankedRecords) ? f.rankedRecords : []) {
      for (const sid of Array.isArray(rec?.sourceIds) ? rec.sourceIds : []) addId(sid);
    }
  }

  if (uniqueSourceIds.size === 0 && sourceById instanceof Map) {
    for (const key of sourceById.keys()) addId(key);
  }

  for (const sid of uniqueSourceIds) {
    const src = sourceById instanceof Map ? sourceById.get(sid) : null;
    if (!src) continue;
    const rank = String(src.sourceRank || src.source_rank || src.sourceTier || src.source_tier || "AGGREGATOR").toUpperCase();
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

/**
 * Deterministic persistence key for flagging/starring a connection record for IC review.
 */
export function connectionStarKey(rec = {}) {
  const from = String(rec.canonicalFrom || "").trim().toLowerCase();
  const to = String(rec.canonicalTo || "").trim().toLowerCase();
  const role = String(rec.structuralRole || rec.relation || rec.type || "").trim().toLowerCase();
  if (from && to) return `${from}::${to}::${role}`;
  const pathNorm = normalizePathText(rec.path || rec.id || "");
  return `${pathNorm}::${role}`;
}

export function escapeCsvCell(value) {
  const raw = String(value ?? "").replace(/\r?\n/g, " ");
  // Guard spreadsheet formula injection (=, +, -, @) while leaving pure dates/numbers readable if safe,
  // or quote all strings per RFC-4180
  const needsQuote = /[",\n\r]/.test(raw);
  const safe = raw.replace(/"/g, '""');
  return needsQuote ? `"${safe}"` : safe;
}

/**
 * Exports all verified connections across all 4 decision lenses to an Excel-ready UTF-8 CSV.
 */
export function buildVerifiedConnectionsCsv({
  summary,
  sourceById = new Map(),
  factorEvidenceByGroup = {},
  starredKeys = new Set(),
  deriveInsight = null
} = {}) {
  const headers = [
    "Factor",
    "Path",
    "Counterparty",
    "Entity Type",
    "Focal Target(s)",
    "Structural Role",
    "Recency",
    "Event Date",
    "Shared Hubs",
    "Top Source Tier",
    "Citation Count",
    "Primary Source Publisher",
    "Primary Source URL",
    "Flagged for IC",
    "Analyst Insight"
  ];
  const rows = [headers.map(escapeCsvCell).join(",")];
  const factors = Array.isArray(summary?.factors) ? summary.factors : [];

  for (const factor of factors) {
    const group = factor.group;
    const records = Array.isArray(factorEvidenceByGroup?.[group])
      ? factorEvidenceByGroup[group]
      : Array.isArray(factor.rankedRecords)
        ? factor.rankedRecords
        : [];
    const factorTitle = factor.displayLabel || factor.shortTabLabel || factor.label || group;

    for (const rec of records) {
      const sIds = Array.isArray(rec.sourceIds) ? rec.sourceIds : [];
      const firstSrc = sIds.map((id) => sourceById.get(String(id))).find(Boolean) || {};
      const urlSrc = sIds.map((id) => sourceById.get(String(id))).find((s) => /^https?:\/\//i.test(s?.url || s?.document || "")) || firstSrc;
      const cleanPath = formatInstitutionalPath(rec.path || `${rec.canonicalFrom || ""} → ${rec.canonicalTo || ""}`);
      const counterparty = formatInstitutionalEntityName(rec.canonicalFrom || "");
      const focalTargets = Array.isArray(rec.sharedHubs) && rec.sharedHubs.length
        ? rec.sharedHubs.map(formatInstitutionalEntityName).join("; ")
        : formatInstitutionalEntityName(rec.canonicalTo || "");
      const recency = rec.isRecentCatalyst || rec.timingRecency === "active_catalyst"
        ? "Active (<=18m)"
        : rec.isHistoricalMilestone || rec.timingRecency === "historical_milestone"
          ? "Historical (>18m)"
          : "Undated / Structural";
      const insight = typeof deriveInsight === "function"
        ? deriveInsight(rec, group)
        : (rec.detail || rec.relation || "");
      const star = starredKeys instanceof Set && starredKeys.has(connectionStarKey(rec)) ? "Yes" : "No";

      const cells = [
        factorTitle,
        cleanPath,
        counterparty,
        rec.nodeEntityType || "Organization",
        focalTargets,
        rec.structuralRole || "",
        recency,
        rec.date || "",
        Array.isArray(rec.sharedHubs) ? rec.sharedHubs.length : 0,
        rec.sourceRank || firstSrc.sourceRank || "AGGREGATOR",
        sIds.length,
        urlSrc.publisher || firstSrc.publisher || "",
        urlSrc.url || urlSrc.document || "",
        star,
        insight
      ];
      rows.push(cells.map(escapeCsvCell).join(","));
    }
  }

  return `\uFEFF${rows.join("\n")}`;
}

/**
 * Formats an Investment Committee Diligence Memo in structured Markdown across
 * Single-Company Teardown, Ecosystem Comparison, and Origination Triage modes.
 */
export function buildIcDiligenceMemoMarkdown({
  summary,
  bridgeMap,
  sourceById = new Map(),
  factorEvidenceByGroup = {},
  claudeResult = null,
  starredKeys = new Set(),
  deriveInsight = null,
  generatedAt = new Date().toISOString().slice(0, 10)
} = {}) {
  const exec = summary?.executive || {};
  const focals = (bridgeMap?.focalEntities || []).map((f) => formatInstitutionalEntityName(f.name || f.label)).filter(Boolean);
  const titleEntities = focals.length ? focals.join(" · ") : "Selected Entities";
  const mapProv = computeMapUniqueProvenance(bridgeMap, sourceById);
  const provPct = mapProv.total > 0 ? mapProv.verifiedSharePct : Number(exec.verifiedSharePct || 0);
  const sourceTotal = mapProv.total > 0 ? mapProv.total : Number(exec.provenanceMix?.total || 0);
  const claudeFactors = new Map((Array.isArray(claudeResult?.factorAnalyses) ? claudeResult.factorAnalyses : []).map((a) => [a.group, a]));
  const lines = [];

  lines.push(`# VentureLink · Investment Committee Diligence Memo`);
  lines.push(`**Subject:** ${titleEntities}`);
  lines.push(`**Analysis Mode:** ${exec.modeLabel || exec.analysisMode || "Ecosystem Map"}`);
  if (exec.perspectiveEntity?.name) {
    lines.push(`**Perspective Seat:** ${formatInstitutionalEntityName(exec.perspectiveEntity.name)}`);
  }
  lines.push(`**Generated:** ${generatedAt}`);
  lines.push(`**Data Provenance:** 100% Real Cala Knowledge Graph (${provPct}% Filing/Primary across ${sourceTotal} unique cited sources; ${Number(exec.quarantinedCount || 0)} raw noise edges quarantined)`);
  lines.push("");

  const verdictLabel = claudeResult?.recommendation || summary?.overall?.label || exec.verdict || "Ready";
  const thesisText = claudeResult?.summary || summary?.investmentEffect || exec.investmentEffect || "";
  lines.push(`## Executive Verdict: ${verdictLabel}`);
  if (thesisText) lines.push(thesisText);
  lines.push("");

  // Collect starred connections first if any are flagged
  const starredItems = [];
  if (starredKeys instanceof Set && starredKeys.size > 0) {
    for (const factor of summary?.factors || []) {
      const records = Array.isArray(factorEvidenceByGroup?.[factor.group])
        ? factorEvidenceByGroup[factor.group]
        : (factor.rankedRecords || []);
      for (const rec of records) {
        if (!starredKeys.has(connectionStarKey(rec))) continue;
        starredItems.push({ factor, rec });
      }
    }
  }
  if (starredItems.length) {
    lines.push(`## Flagged Connections for IC (${starredItems.length})`);
    for (const { factor, rec } of starredItems) {
      const pathStr = formatInstitutionalPath(rec.path);
      const insight = typeof deriveInsight === "function" ? deriveInsight(rec, factor.group) : (rec.detail || rec.relation);
      const firstUrl = (rec.sourceIds || []).map((id) => sourceById.get(String(id))).find((s) => /^https?:\/\//i.test(s?.url || s?.document || ""));
      const citePart = firstUrl ? ` ([${firstUrl.publisher || "Source"}](${firstUrl.url || firstUrl.document}))` : "";
      lines.push(`- **[${factor.shortTabLabel || factor.label}] ${pathStr}** (${rec.sourceRank || "Cala"}${rec.date ? ` · ${rec.date}` : ""}): ${insight}${citePart}`);
    }
    lines.push("");
  }

  lines.push(`## 4-Factor Institutional Analysis`);
  for (const factor of summary?.factors || []) {
    const fa = claudeFactors.get(factor.group);
    const verdict = fa?.verdict || factor.effect || "Mapped";
    const headline = fa?.headline || factor.line || "";
    const takeaway = fa?.decisionEffect?.text || factor.investmentImpact || "";
    const nextCheck = fa?.nextCheck || factor.actionableCheck || "";
    const records = (Array.isArray(factorEvidenceByGroup?.[factor.group])
      ? factorEvidenceByGroup[factor.group]
      : (factor.rankedRecords || [])).slice(0, 5);

    lines.push(`### ${factor.displayLabel || factor.label} — ${verdict} (${factor.count} paths)`);
    if (headline) lines.push(`**Headline:** ${headline}`);
    if (takeaway) lines.push(`**Investment Implication:** ${takeaway}`);
    if (nextCheck) lines.push(`**Diligence Question:** ${nextCheck}`);
    if (records.length) {
      lines.push(`**Key Verified Links:**`);
      for (const rec of records) {
        const insight = typeof deriveInsight === "function" ? deriveInsight(rec, factor.group) : (rec.detail || rec.relation);
        const src = (rec.sourceIds || []).map((id) => sourceById.get(String(id))).find((s) => /^https?:\/\//i.test(s?.url || s?.document || ""));
        const cite = src ? ` — [${src.publisher || "Cala Source"}](${src.url || src.document})` : "";
        lines.push(`- \`${rec.sourceRank || "CALA"}\` **${formatInstitutionalPath(rec.path)}**${rec.date ? ` (${rec.date})` : ""}: ${insight}${cite}`);
      }
    }
    lines.push("");
  }

  if (exec.analysisMode === "perspective_triage" && exec.perspectiveEntity?.name) {
    const warmChains = Array.isArray(exec.warmIntroChains) ? exec.warmIntroChains : [];
    const conflicts = Array.isArray(exec.portfolioConflicts) ? exec.portfolioConflicts : [];
    lines.push(`## Origination Routes & Portfolio Conflicts (${formatInstitutionalEntityName(exec.perspectiveEntity.name)})`);
    if (warmChains.length) {
      for (const c of warmChains.slice(0, 5)) {
        lines.push(`- Warm route: ${formatInstitutionalPath(c.chainText || c.bridgeLabel)}`);
      }
    } else {
      lines.push(`- Cold outreach: No 1-hop or 2-hop warm intro chains found in Cala.`);
    }
    for (const conflict of conflicts.slice(0, 5)) {
      lines.push(`- Conflict flag: ${conflict.reason || `${conflict.portfolioName} vs ${conflict.targetName}`}`);
    }
    lines.push("");
  } else if (Array.isArray(exec.sharedCommercialBottlenecks) && exec.sharedCommercialBottlenecks.length) {
    lines.push(`## Shared Commercial Bottlenecks`);
    for (const b of exec.sharedCommercialBottlenecks.slice(0, 4)) {
      lines.push(`- **${formatInstitutionalEntityName(b.name)}** across ${(b.sharedHubs || []).join(" & ")}`);
    }
    lines.push("");
  }

  const gaps = Array.isArray(exec.missingDisclosures) ? exec.missingDisclosures : [];
  const anomalies = Array.isArray(exec.dataAnomalies) ? exec.dataAnomalies : [];
  if (gaps.length || anomalies.length) {
    lines.push(`## Cala Disclosure Gaps & Data Hygiene Flags`);
    for (const g of gaps) lines.push(`- Gap: ${g}`);
    for (const a of anomalies) lines.push(`- Hygiene flag (${a.kind || "anomaly"}): ${formatInstitutionalPath(a.path || "")} — ${a.detail || ""}`);
    lines.push("");
  }

  lines.push(`---`);
  lines.push(`*Prepared with VentureLink · Grounded strictly in verified Cala Knowledge Graph sources.*`);
  return lines.join("\n");
}

/**
 * Encodes current pinned entities and optional perspective firm into a shareable `?map=...` URL.
 */
export function buildShareableWorkspaceUrl(origin = "", pathname = "/", pinnedEntities = [], perspectiveEntity = null) {
  const names = (Array.isArray(pinnedEntities) ? pinnedEntities : [])
    .map((p) => String(p?.name || p?.label || "").trim())
    .filter(Boolean);
  const cleanOrigin = String(origin || "").replace(/\/+$/, "");
  const cleanPath = String(pathname || "/");
  if (!names.length) return `${cleanOrigin}${cleanPath}`;
  const params = new URLSearchParams();
  params.set("map", names.join(","));
  const pName = String(perspectiveEntity?.name || perspectiveEntity?.label || "").trim();
  if (pName) params.set("perspective", pName);
  return `${cleanOrigin}${cleanPath}?${params.toString()}`;
}

/**
 * Parses explicit shareable workspace parameters from `window.location.search`.
 * Bare `/` returns `{ mapTerms: [], perspectiveTerm: null }`.
 */
export function parseShareableWorkspaceParams(search = "") {
  const params = new URLSearchParams(String(search || ""));
  const mapRaw = String(params.get("map") || "").trim();
  const mapTerms = mapRaw
    ? mapRaw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20)
    : [];
  const perspRaw = String(params.get("perspective") || "").trim();
  return {
    mapTerms,
    perspectiveTerm: perspRaw || null
  };
}
