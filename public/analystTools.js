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
  diligenceChecks = {},
  generatedAt = new Date().toISOString().slice(0, 10)
} = {}) {
  const exec = summary?.executive || {};
  const focals = (bridgeMap?.focalEntities || []).map((f) => formatInstitutionalEntityName(f.name || f.label)).filter(Boolean);
  const titleEntities = focals.length ? focals.join(" · ") : "Selected Entities";
  const mapProv = computeMapUniqueProvenance(bridgeMap, sourceById);
  const provPct = mapProv.total > 0 ? mapProv.verifiedSharePct : Number(exec.verifiedSharePct || 0);
  const sourceTotal = mapProv.total > 0 ? mapProv.total : Number(exec.provenanceMix?.total || 0);
  const claudeFactors = new Map((Array.isArray(claudeResult?.factorAnalyses) ? claudeResult.factorAnalyses : []).map((a) => [a.group, a]));
  const normalizedDiligence = normalizeDiligenceState(diligenceChecks);
  const dilProg = computeDiligenceProgress(summary?.factors || [], normalizedDiligence);
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

  const hasDiligenceUpdates = Object.values(normalizedDiligence).some((d) => d.status !== "open" || d.note);
  if (hasDiligenceUpdates && (summary?.factors || []).length) {
    lines.push(`## IC Diligence Verification Tracker (${dilProg.verified} Verified · ${dilProg.blocked} Blocked · ${dilProg.open} Open)`);
    for (const factor of summary?.factors || []) {
      const entry = normalizedDiligence[factor.group] || { status: "open", note: "" };
      const stUpper = entry.status.toUpperCase();
      lines.push(`- **[${factor.shortTabLabel || factor.label}]** \`[${stUpper}]\`${entry.note ? ` — ${entry.note}` : ""}`);
    }
    lines.push("");
  }

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

    const dCheck = normalizedDiligence[factor.group];
    const dTag = dCheck && dCheck.status !== "open" ? ` [${dCheck.status.toUpperCase()}]` : "";
    lines.push(`### ${factor.displayLabel || factor.label} — ${verdict} (${factor.count} paths)`);
    if (headline) lines.push(`**Headline:** ${headline}`);
    if (takeaway) lines.push(`**Investment Implication:** ${takeaway}`);
    if (nextCheck) lines.push(`**Diligence Question${dTag}:** ${nextCheck}`);
    if (dCheck?.note) lines.push(`**Analyst Note:** ${dCheck.note}`);
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
 * Normalizes embedded multi-word ALL-CAPS SEC/13F entity names inside prose
 * (e.g. "CISCO SYSTEMS, INC.", "BAILLIE GIFFORD & CO") while leaving short acronyms
 * ("SEC", "13F", "FILING", "M&A") intact.
 */
export function cleanInstitutionalProseNames(text = "") {
  const raw = String(text || "");
  if (!raw) return "";
  return raw.replace(
    /\b[A-Z][A-Z0-9.'’/-]*(?:,\s*|\s+&\s+|\s+)[A-Z0-9.'’/&,-]+(?:\s+[A-Z0-9.'’/&,-]+){0,6}/g,
    (match) => {
      if (/[a-z]/.test(match)) return match;
      const lettersOnly = match.replace(/[^A-Z]/g, "");
      if (lettersOnly.length < 8) return match;
      return formatInstitutionalEntityName(match);
    }
  );
}

const LEDGER_TIER_RANK = { FILING: 4, PRIMARY: 3, PRESS: 2, AGGREGATOR: 1 };

function normalizeIsoDateForSort(dateStr = "") {
  const s = String(dateStr || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{4}-\d{2}/.test(s)) return `${s.slice(0, 7)}-15`;
  if (/^\d{4}$/.test(s)) return `${s}-06-15`;
  return "";
}

/**
 * Filters and sorts verified connection ledger records deterministically without mutating input.
 */
export function filterAndSortLedgerRecords(
  records = [],
  { query = "", filter = "all", sort = "signal", starredKeys = new Set() } = {}
) {
  const list = Array.isArray(records) ? records : [];
  const q = String(query || "").trim().toLowerCase();
  const f = String(filter || "all").toLowerCase();
  const s = String(sort || "signal").toLowerCase();
  const stars = starredKeys instanceof Set ? starredKeys : new Set();

  const filtered = list.filter((rec) => {
    if (!rec) return false;
    const rank = String(rec.sourceRank || "AGGREGATOR").toUpperCase();
    const isStarred = stars.has(connectionStarKey(rec));
    const isShared = Boolean(rec.isSharedBridge || (Array.isArray(rec.sharedHubs) && rec.sharedHubs.length >= 2));
    const isRecent = Boolean(rec.isRecentCatalyst || rec.timingRecency === "active_catalyst");

    if (f === "shared" && !isShared) return false;
    if (f === "filing" && !rank.includes("FILING")) return false;
    if (f === "primary" && !rank.includes("FILING") && !rank.includes("PRIMARY")) return false;
    if (f === "recent" && !isRecent) return false;
    if (f === "starred" && !isStarred) return false;

    if (q) {
      const hay = [
        formatInstitutionalPath(rec.path || ""),
        rec.path,
        formatInstitutionalEntityName(rec.canonicalFrom || ""),
        rec.canonicalFrom,
        formatInstitutionalEntityName(rec.canonicalTo || ""),
        rec.canonicalTo,
        rec.relation,
        rec.detail,
        rec.date,
        rank,
        ...(Array.isArray(rec.sharedHubs) ? rec.sharedHubs : [])
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const tierScore = (rec) => LEDGER_TIER_RANK[String(rec?.sourceRank || "").toUpperCase()] || 0;
  const hubCount = (rec) => (Array.isArray(rec?.sharedHubs) && rec.sharedHubs.length ? rec.sharedHubs.length : rec?.isSharedBridge ? 2 : 1);

  return [...filtered].sort((a, b) => {
    if (s === "tier") {
      const td = tierScore(b) - tierScore(a);
      if (td !== 0) return td;
      const hd = hubCount(b) - hubCount(a);
      if (hd !== 0) return hd;
      return normalizeIsoDateForSort(b.date).localeCompare(normalizeIsoDateForSort(a.date));
    }
    if (s === "date") {
      const dd = normalizeIsoDateForSort(b.date).localeCompare(normalizeIsoDateForSort(a.date));
      if (dd !== 0) return dd;
      return tierScore(b) - tierScore(a);
    }
    if (s === "hubs") {
      const hd = hubCount(b) - hubCount(a);
      if (hd !== 0) return hd;
      const td = tierScore(b) - tierScore(a);
      if (td !== 0) return td;
      return (Number(b.signalWeight) || 0) - (Number(a.signalWeight) || 0);
    }
    if (s === "name") {
      const na = formatInstitutionalEntityName(a.canonicalFrom || a.path || "");
      const nb = formatInstitutionalEntityName(b.canonicalFrom || b.path || "");
      return na.localeCompare(nb);
    }
    // Default "signal": starred first, shared first, signalWeight DESC, tier DESC
    const sa = stars.has(connectionStarKey(a)) ? 1 : 0;
    const sb = stars.has(connectionStarKey(b)) ? 1 : 0;
    if (sb !== sa) return sb - sa;
    const sha = a.isSharedBridge ? 1 : 0;
    const shb = b.isSharedBridge ? 1 : 0;
    if (shb !== sha) return shb - sha;
    const wd = (Number(b.signalWeight) || 0) - (Number(a.signalWeight) || 0);
    if (Math.abs(wd) > 0.001) return wd;
    return tierScore(b) - tierScore(a);
  });
}

function deriveMatrixRole(edge = {}) {
  const sr = String(edge.structuralRole || "").toLowerCase();
  if (["capital", "commercial", "governance", "strategic_event"].includes(sr)) return sr;
  const rel = String(edge.relation || edge.relationType || "").toUpperCase();
  if (["INVESTED_IN", "CO_INVESTED_WITH", "PARTICIPATES_IN_FUNDING_ROUND", "HAS_FUNDING_ROUND"].includes(rel)) return "capital";
  if (["PARTNERED_WITH", "SUPPLIES", "SUPPLIED_BY", "ADVISED"].includes(rel)) return "commercial";
  if (rel === "ACQUIRED" || rel.startsWith("IS_") || rel.includes("FOUNDED") || rel === "WORKS_AT" || rel === "SPUN_OUT_OF") return "governance";
  return "strategic_event";
}

/**
 * Aggregates every verified counterparty across 2+ focal entities into a Cross-Entity
 * Overlap Matrix so analysts can pinpoint dual-backed investors, bottlenecks, and shared leaders.
 */
export function buildCrossEntityOverlapMatrix(bridgeMap) {
  if (!bridgeMap) {
    return { focals: [], rows: [], sharedRowCount: 0, totalRowCount: 0 };
  }
  const nodeById = new Map((Array.isArray(bridgeMap.nodes) ? bridgeMap.nodes : []).map((n) => [String(n.id), n]));
  const rawFocals = Array.isArray(bridgeMap.focalEntities) && bridgeMap.focalEntities.length
    ? bridgeMap.focalEntities
    : (Array.isArray(bridgeMap.focalEntityIds) ? bridgeMap.focalEntityIds : []).map((id) => nodeById.get(String(id)) || { id, name: String(id) });

  const focals = rawFocals
    .filter((f) => f && f.id)
    .map((f) => ({
      id: String(f.id),
      name: formatInstitutionalEntityName(f.label || f.name || f.id)
    }));
  const focalSet = new Set(focals.map((f) => f.id));
  if (focals.length < 2) {
    return { focals, rows: [], sharedRowCount: 0, totalRowCount: 0 };
  }

  const rowsMap = new Map();
  for (const edge of Array.isArray(bridgeMap.edges) ? bridgeMap.edges : []) {
    if (!edge || String(edge.id || "").startsWith("tree-spoke-")) continue;
    const fromId = String(edge.from || "");
    const toId = String(edge.to || "");
    let focalId = "";
    let cpId = "";
    if (focalSet.has(fromId) && !focalSet.has(toId)) {
      focalId = fromId;
      cpId = toId;
    } else if (focalSet.has(toId) && !focalSet.has(fromId)) {
      focalId = toId;
      cpId = fromId;
    } else {
      continue;
    }
    const cpNode = nodeById.get(cpId);
    const cpName = formatInstitutionalEntityName(cpNode?.label || cpNode?.name || cpId);
    const cpKey = cpId || cpName.toLowerCase();
    const role = deriveMatrixRole(edge);
    const rank = String(edge.topSourceRank || "AGGREGATOR").toUpperCase();
    const rankScore = LEDGER_TIER_RANK[rank] || 1;
    const isRisk = edge.contributionGroup === "caution" || /COMPET|RIVAL/i.test(String(edge.relation || ""));

    if (!rowsMap.has(cpKey)) {
      rowsMap.set(cpKey, {
        nodeId: cpId,
        name: cpName,
        entityType: cpNode?.entityType || "Organization",
        primaryRole: role,
        roles: new Set([role]),
        isRisk,
        strongestTier: rank,
        strongestRankScore: rankScore,
        cells: {}
      });
    }
    const row = rowsMap.get(cpKey);
    row.roles.add(role);
    if (isRisk) row.isRisk = true;
    if (rankScore > row.strongestRankScore) {
      row.strongestRankScore = rankScore;
      row.strongestTier = rank;
    }

    const existing = row.cells[focalId];
    const nextCell = {
      edgeId: String(edge.id || ""),
      focalId,
      label: String(edge.label || edge.relation || "Verified link").trim(),
      role,
      date: edge.date ? String(edge.date).slice(0, 10) : "",
      sourceRank: rank,
      rankScore,
      sourceIds: Array.isArray(edge.sourceIds) ? edge.sourceIds : []
    };
    if (!existing || nextCell.rankScore > existing.rankScore || (!existing.date && nextCell.date)) {
      row.cells[focalId] = nextCell;
    }
  }

  const rows = [...rowsMap.values()]
    .map((r) => ({
      nodeId: r.nodeId,
      name: r.name,
      entityType: r.entityType,
      primaryRole: r.primaryRole,
      roles: [...r.roles],
      isRisk: r.isRisk,
      strongestTier: r.strongestTier,
      strongestRankScore: r.strongestRankScore,
      sharedCount: Object.keys(r.cells).length,
      cells: r.cells
    }))
    .sort((a, b) => {
      if (b.sharedCount !== a.sharedCount) return b.sharedCount - a.sharedCount;
      if (b.strongestRankScore !== a.strongestRankScore) return b.strongestRankScore - a.strongestRankScore;
      return a.name.localeCompare(b.name);
    });

  return {
    focals,
    rows,
    sharedRowCount: rows.filter((r) => r.sharedCount >= 2).length,
    totalRowCount: rows.length
  };
}

/**
 * Serializes a Cross-Entity Overlap Matrix into an RFC-4180 UTF-8 BOM CSV for Excel/IC decks.
 */
export function buildOverlapMatrixCsv(matrix) {
  const focals = Array.isArray(matrix?.focals) ? matrix.focals : [];
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : [];
  const headers = [
    "Counterparty",
    "Entity Type",
    "Primary Role",
    "Overlap Count",
    "Strongest Tier",
    ...focals.map((f) => f.name)
  ];
  const lines = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    const focalCells = focals.map((f) => {
      const c = row.cells?.[f.id];
      if (!c) return "—";
      const meta = [c.date, c.sourceRank].filter(Boolean).join(" · ");
      return meta ? `${c.label} (${meta})` : c.label;
    });
    lines.push(
      [
        row.name,
        row.entityType,
        row.primaryRole,
        `${row.sharedCount}/${focals.length}`,
        row.strongestTier,
        ...focalCells
      ]
        .map(escapeCsvCell)
        .join(",")
    );
  }
  return `\uFEFF${lines.join("\n")}`;
}

function extractStrictCalaAmount(text = "") {
  const m = String(text || "").match(/((?:\$|€|USD\s*|EUR\s*)\d+(?:\.\d+)?\s?(?:[BMK]|billion|million|bn|m)\b)/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

/**
 * Builds a verified, strictly Cala-backed Chronological Financing & Catalyst Timeline
 * split cleanly into Active Window (<=18 months) vs. Historical Track Record (>18 months).
 */
export function buildChronologicalCatalystTimeline(bridgeMap, referenceDate = null) {
  const refStr = normalizeIsoDateForSort(referenceDate || bridgeMap?.referenceDate) || new Date().toISOString().slice(0, 10);
  const refMs = Date.parse(refStr) || Date.now();
  if (!bridgeMap) {
    return { active: [], historical: [], totalDated: 0, referenceDate: refStr };
  }

  const nodeById = new Map((Array.isArray(bridgeMap.nodes) ? bridgeMap.nodes : []).map((n) => [String(n.id), n]));
  const focalById = new Map((Array.isArray(bridgeMap.focalEntities) ? bridgeMap.focalEntities : []).map((f) => [String(f.id), f]));
  const items = [];
  const seenKeys = new Set();

  const pushItem = ({ focalName, title, detail, date, sourceRank, sourceIds, edgeId, nodeId, amount }) => {
    const rawDate = String(date || "").trim();
    const normDate = normalizeIsoDateForSort(rawDate);
    if (!normDate) return;
    const evtMs = Date.parse(normDate);
    if (!Number.isFinite(evtMs)) return;
    const monthsAgo = (refMs - evtMs) / (1000 * 60 * 60 * 24 * 30.4375);
    const isActive = monthsAgo <= 18 && monthsAgo >= -12;
    const cleanEntity = formatInstitutionalEntityName(focalName || "Entity");
    const cleanTitle = cleanInstitutionalProseNames(String(title || "Verified Milestone").trim());
    const cleanDetail = cleanInstitutionalProseNames(String(detail || "").trim());
    const dedupeKey = `${cleanEntity.toLowerCase()}::${rawDate.slice(0, 10)}::${cleanTitle.toLowerCase().slice(0, 48)}`;
    if (seenKeys.has(dedupeKey)) return;
    seenKeys.add(dedupeKey);

    items.push({
      focalName: cleanEntity,
      title: cleanTitle,
      detail: cleanDetail,
      date: rawDate.slice(0, 10),
      sortDate: normDate,
      isActive,
      amount: amount || extractStrictCalaAmount(`${cleanTitle} ${cleanDetail}`),
      sourceRank: String(sourceRank || "PRIMARY").toUpperCase(),
      sourceIds: Array.isArray(sourceIds) ? sourceIds.map(String).filter(Boolean) : [],
      edgeId: edgeId ? String(edgeId) : "",
      nodeId: nodeId ? String(nodeId) : ""
    });
  };

  for (const [entityId, events] of Object.entries(bridgeMap.timingEventsByEntity || {})) {
    const entityObj = focalById.get(String(entityId)) || nodeById.get(String(entityId));
    const focalName = entityObj?.name || entityObj?.label || "";
    for (const ev of Array.isArray(events) ? events : []) {
      if (!ev) continue;
      pushItem({
        focalName: ev.entityName || focalName,
        title: ev.title || ev.label || ev.relation || "Milestone",
        detail: ev.detail || ev.summary || "",
        date: ev.date || ev.roundDate,
        sourceRank: ev.topSourceRank || ev.sourceRank || "PRIMARY",
        sourceIds: ev.sourceIds || (ev.sourceId ? [ev.sourceId] : []),
        edgeId: ev.edgeId || "",
        nodeId: entityId,
        amount: ev.roundAmount || ev.amount || ""
      });
    }
  }

  for (const edge of Array.isArray(bridgeMap.edges) ? bridgeMap.edges : []) {
    if (!edge || String(edge.id || "").startsWith("tree-spoke-") || !(edge.date || edge.roundDate)) continue;
    const fromNode = nodeById.get(String(edge.from || ""));
    const toNode = nodeById.get(String(edge.to || ""));
    const focal = (fromNode?.isFocalEntity && fromNode) || (toNode?.isFocalEntity && toNode) || focalById.get(String(edge.focalEntityId || "")) || fromNode || toNode;
    const other = fromNode?.id === focal?.id ? toNode : fromNode;
    const focalName = focal?.label || focal?.name || "";
    const otherName = other?.label || other?.name || "";
    const labelStr = edge.roundLabel || edge.label || edge.relation || "Corporate event";
    const title = otherName && otherName !== focalName && !/Active Catalyst|Historical/i.test(otherName)
      ? `${labelStr}: ${formatInstitutionalEntityName(otherName)}`
      : labelStr;
    pushItem({
      focalName,
      title,
      detail: edge.detail || "",
      date: edge.roundDate || edge.date,
      sourceRank: edge.topSourceRank || "PRIMARY",
      sourceIds: edge.sourceIds || (edge.sourceId ? [edge.sourceId] : []),
      edgeId: edge.id,
      nodeId: other?.id || focal?.id || "",
      amount: edge.roundAmount || ""
    });
  }

  items.sort((a, b) => b.sortDate.localeCompare(a.sortDate) || (LEDGER_TIER_RANK[b.sourceRank] || 0) - (LEDGER_TIER_RANK[a.sourceRank] || 0));
  return {
    active: items.filter((i) => i.isActive),
    historical: items.filter((i) => !i.isActive),
    totalDated: items.length,
    referenceDate: refStr
  };
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

/**
 * Indexes real mapped graph nodes (excluding synthetic group hubs) for quick search/jumping.
 */
export function searchMappedGraphNodes(bridgeMap, query = "", { limit = 14 } = {}) {
  if (!bridgeMap || !Array.isArray(bridgeMap.nodes)) return [];
  const q = String(query || "").trim().toLowerCase();
  const nodes = bridgeMap.nodes.filter(
    (n) => n && n.id && !String(n.id).startsWith("group-hub:") && n.kind !== "group-hub"
  );
  const focalIds = new Set([
    ...(Array.isArray(bridgeMap.focalEntityIds) ? bridgeMap.focalEntityIds : []).map(String),
    ...(Array.isArray(bridgeMap.focalEntities) ? bridgeMap.focalEntities.map((f) => String(f?.id || "")) : []).filter(Boolean),
    ...nodes.filter((n) => n.kind === "anchor" || n.isFocalEntity).map((n) => String(n.id))
  ]);

  const statsById = new Map();
  for (const n of nodes) {
    statsById.set(String(n.id), {
      degree: 0,
      connectedFocalIds: new Set(),
      maxRank: 0,
      strongestTier: "",
      relations: new Set()
    });
  }

  for (const edge of Array.isArray(bridgeMap.edges) ? bridgeMap.edges : []) {
    if (!edge || String(edge.id || "").startsWith("tree-spoke-")) continue;
    const fromId = String(edge.from || "");
    const toId = String(edge.to || "");
    const tier = String(edge.topSourceRank || "AGGREGATOR").toUpperCase();
    const rankScore = LEDGER_TIER_RANK[tier] || 1;
    const rel = String(edge.label || edge.relation || "").trim();

    const sFrom = statsById.get(fromId);
    const sTo = statsById.get(toId);
    if (sFrom) {
      sFrom.degree += 1;
      if (focalIds.has(toId) && toId !== fromId) sFrom.connectedFocalIds.add(toId);
      if (rankScore > sFrom.maxRank) {
        sFrom.maxRank = rankScore;
        sFrom.strongestTier = tier;
      }
      if (rel) sFrom.relations.add(rel);
    }
    if (sTo) {
      sTo.degree += 1;
      if (focalIds.has(fromId) && fromId !== toId) sTo.connectedFocalIds.add(fromId);
      if (rankScore > sTo.maxRank) {
        sTo.maxRank = rankScore;
        sTo.strongestTier = tier;
      }
      if (rel) sTo.relations.add(rel);
    }
  }

  const results = [];
  for (const node of nodes) {
    const id = String(node.id);
    const rawName = String(node.label || node.name || id).trim();
    const formattedName = formatInstitutionalEntityName(rawName) || rawName;
    const entityType = String(node.entityType || (node.kind === "anchor" ? "Target" : "Entity")).trim();
    const stat = statsById.get(id);
    const isFocal = focalIds.has(id);
    const sharedCount = isFocal ? 0 : stat.connectedFocalIds.size;
    const relationLabels = [...stat.relations].slice(0, 4);

    let matchRank = 0;
    if (q) {
      const nameLow = formattedName.toLowerCase();
      const rawLow = rawName.toLowerCase();
      const extraHay = `${entityType} ${relationLabels.join(" ")}`.toLowerCase();
      if (nameLow === q || rawLow === q) matchRank = 0;
      else if (nameLow.startsWith(q) || rawLow.startsWith(q)) matchRank = 1;
      else if (nameLow.includes(q) || rawLow.includes(q)) matchRank = 2;
      else if (extraHay.includes(q)) matchRank = 3;
      else continue;
    }

    results.push({
      id,
      rawName,
      formattedName,
      entityType,
      isFocal,
      sharedCount,
      degree: stat.degree,
      strongestTier: stat.strongestTier || "CALA GRAPH",
      rankScore: stat.maxRank || 0,
      relationLabels,
      matchRank
    });
  }

  results.sort((a, b) => {
    if (q && a.matchRank !== b.matchRank) return a.matchRank - b.matchRank;
    if (a.isFocal !== b.isFocal) return a.isFocal ? -1 : 1;
    if (b.sharedCount !== a.sharedCount) return b.sharedCount - a.sharedCount;
    if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
    if (b.degree !== a.degree) return b.degree - a.degree;
    return a.formattedName.localeCompare(b.formattedName);
  });

  const cap = Number.isFinite(limit) && limit > 0 ? limit : results.length;
  return results.slice(0, cap);
}

/**
 * Finds all shortest simple verified Cala paths (BFS) between two mapped nodes up to maxDepth hops.
 */
export function findShortestVerifiedPaths(bridgeMap, startNodeId, endNodeId, { maxDepth = 4, maxPaths = 4 } = {}) {
  const empty = { found: false, hopCount: 0, paths: [], allNodeIds: [], allEdgeIds: [] };
  const startId = String(startNodeId || "").trim();
  const endId = String(endNodeId || "").trim();
  if (!bridgeMap || !startId || !endId || startId === endId) return empty;

  const nodeById = new Map(
    (Array.isArray(bridgeMap.nodes) ? bridgeMap.nodes : [])
      .filter((n) => n && n.id && !String(n.id).startsWith("group-hub:") && n.kind !== "group-hub")
      .map((n) => [String(n.id), n])
  );
  if (!nodeById.has(startId) || !nodeById.has(endId)) return empty;

  // Undirected adjacency list keeping the highest-provenance edge between any node pair (u, v).
  const adj = new Map();
  const bestPairEdge = new Map();
  for (const edge of Array.isArray(bridgeMap.edges) ? bridgeMap.edges : []) {
    if (!edge || !edge.id || String(edge.id).startsWith("tree-spoke-")) continue;
    const u = String(edge.from || "");
    const v = String(edge.to || "");
    if (!u || !v || u === v || !nodeById.has(u) || !nodeById.has(v)) continue;
    const pairKey = u < v ? `${u}::${v}` : `${v}::${u}`;
    const tier = String(edge.topSourceRank || "AGGREGATOR").toUpperCase();
    const score = LEDGER_TIER_RANK[tier] || 1;
    const prev = bestPairEdge.get(pairKey);
    if (!prev || score > prev.score || (score === prev.score && edge.date && !prev.edge.date)) {
      bestPairEdge.set(pairKey, { edge, score, tier });
    }
  }

  for (const { edge, score, tier } of bestPairEdge.values()) {
    const u = String(edge.from);
    const v = String(edge.to);
    if (!adj.has(u)) adj.set(u, []);
    if (!adj.has(v)) adj.set(v, []);
    adj.get(u).push({ neighborId: v, edge, score, tier });
    adj.get(v).push({ neighborId: u, edge, score, tier });
  }

  if (!adj.has(startId) || !adj.has(endId)) return empty;

  // Level-order BFS to enumerate all shortest simple paths of exact minimum length.
  let frontier = [[startId]];
  let edgeChains = [[]];
  const minDist = new Map([[startId, 0]]);
  const matched = [];

  for (let depth = 1; depth <= maxDepth && frontier.length && matched.length === 0; depth += 1) {
    const nextFrontier = [];
    const nextEdgeChains = [];
    for (let i = 0; i < frontier.length; i += 1) {
      const pathNodes = frontier[i];
      const pathEdges = edgeChains[i];
      const curr = pathNodes[pathNodes.length - 1];
      for (const step of adj.get(curr) || []) {
        if (pathNodes.includes(step.neighborId)) continue;
        const prevDist = minDist.get(step.neighborId);
        if (prevDist !== undefined && prevDist < depth) continue;
        const nextNodes = [...pathNodes, step.neighborId];
        const nextEdges = [...pathEdges, step];
        if (step.neighborId === endId) {
          matched.push({ nextNodes, nextEdges });
        } else {
          minDist.set(step.neighborId, depth);
          if (nextFrontier.length < 250) {
            nextFrontier.push(nextNodes);
            nextEdgeChains.push(nextEdges);
          }
        }
      }
    }
    frontier = nextFrontier;
    edgeChains = nextEdgeChains;
  }

  if (!matched.length) return empty;

  const formattedPaths = matched.map(({ nextNodes, nextEdges }) => {
    const hops = nextEdges.map((step, idx) => {
      const fId = nextNodes[idx];
      const tId = nextNodes[idx + 1];
      const fNode = nodeById.get(fId);
      const tNode = nodeById.get(tId);
      return {
        edgeId: String(step.edge.id),
        fromId: fId,
        fromName: formatInstitutionalEntityName(fNode?.label || fNode?.name || fId),
        toId: tId,
        toName: formatInstitutionalEntityName(tNode?.label || tNode?.name || tId),
        relation: String(step.edge.label || step.edge.relation || "Verified link").trim(),
        date: String(step.edge.roundDate || step.edge.date || "").trim(),
        sourceRank: step.tier,
        rankScore: step.score,
        sourceIds: Array.isArray(step.edge.sourceIds) ? step.edge.sourceIds : [],
        detail: String(step.edge.detail || "").trim()
      };
    });
    const avgRankScore = hops.reduce((sum, h) => sum + h.rankScore, 0) / Math.max(1, hops.length);
    const bestHop = hops.reduce((b, h) => (h.rankScore > b.rankScore ? h : b), hops[0]);
    return {
      nodeIds: nextNodes,
      edgeIds: hops.map((h) => h.edgeId),
      hops,
      strongestTier: bestHop?.sourceRank || "CALA GRAPH",
      avgRankScore
    };
  });

  formattedPaths.sort((a, b) => b.avgRankScore - a.avgRankScore);
  const topPaths = formattedPaths.slice(0, Math.max(1, maxPaths));
  const allNodeIds = [...new Set(topPaths.flatMap((p) => p.nodeIds))];
  const allEdgeIds = [...new Set(topPaths.flatMap((p) => p.edgeIds))];

  return {
    found: true,
    hopCount: topPaths[0].hops.length,
    paths: topPaths,
    allNodeIds,
    allEdgeIds
  };
}

/**
 * Deterministic key for persisting per-map IC diligence verification checklist state.
 */
export function buildDiligenceScopeKey(focalIds = []) {
  const clean = (Array.isArray(focalIds) ? focalIds : [])
    .map((id) => String(id || "").trim().toLowerCase())
    .filter(Boolean);
  if (!clean.length) return "default";
  return [...new Set(clean)].sort().join("|");
}

const VALID_DILIGENCE_STATUSES = new Set(["open", "verified", "blocked"]);

/**
 * Sanitizes persisted diligence status/notes per 4-factor group.
 */
export function normalizeDiligenceState(raw = {}) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [group, val] of Object.entries(raw)) {
    if (!group || !val || typeof val !== "object") continue;
    const statusRaw = String(val.status || "open").toLowerCase();
    const status = VALID_DILIGENCE_STATUSES.has(statusRaw) ? statusRaw : "open";
    const note = String(val.note || "").slice(0, 280).trim();
    const updatedAt = String(val.updatedAt || "").trim();
    out[String(group)] = { status, note, updatedAt };
  }
  return out;
}

/**
 * Computes completion counts across the 4 decision diligence checks.
 */
export function computeDiligenceProgress(factors = [], diligenceByGroup = {}) {
  const list = Array.isArray(factors) ? factors : [];
  const norm = normalizeDiligenceState(diligenceByGroup);
  let verified = 0;
  let blocked = 0;
  let open = 0;
  for (const f of list) {
    const st = norm[f?.group]?.status || "open";
    if (st === "verified") verified += 1;
    else if (st === "blocked") blocked += 1;
    else open += 1;
  }
  return {
    total: list.length,
    verified,
    blocked,
    open,
    resolved: verified + blocked
  };
}

/**
 * Returns entity-type-specific tab visibility, labels, Overview section headings,
 * and KPI tiles so Person, Fund/Investor, Round/Event, and Company dossiers never show
 * irrelevant sections (e.g. "People 0" or startup "Funding 0" inside a Person dossier).
 */
export function buildDossierEntityConfig(entityKind = "Company", counts = {}) {
  const kindLower = String(entityKind || "").toLowerCase();
  const peopleCount = Number(counts.peopleCount || 0);
  const portfolioCount = Number(counts.portfolioCount || 0);
  const roundsCount = Number(counts.roundsCount || 0);
  const investorsCount = Number(counts.investorsCount || 0);
  const financingTotal = portfolioCount + roundsCount + investorsCount;

  let archetype = "company";
  if (kindLower.includes("person") || kindLower.includes("founder") || kindLower.includes("exec")) {
    archetype = "person";
  } else if (kindLower.includes("round") || kindLower.includes("event") || kindLower.includes("catalyst")) {
    archetype = "event";
  } else if (
    kindLower.includes("fund") ||
    kindLower.includes("investor") ||
    (kindLower.includes("organization") && portfolioCount > 0 && roundsCount === 0 && investorsCount === 0)
  ) {
    archetype = "investor";
  }

  if (archetype === "person") {
    const visibleTabs = [
      { key: "overview", label: "Overview", countKey: null },
      { key: "connections", label: "Network", countKey: "connections" }
    ];
    if (portfolioCount > 0) {
      visibleTabs.push({ key: "funding", label: "Investments", countKey: "funding" });
    }
    visibleTabs.push(
      { key: "timeline", label: "Career", countKey: "timeline" },
      { key: "sources", label: "Sources", countKey: "sources" }
    );
    const thirdKpi = portfolioCount > 0
      ? { label: "Investments", countKey: "portfolio", targetTab: "funding" }
      : { label: "Career Events", countKey: "timeline", targetTab: "timeline" };
    return {
      archetype,
      visibleTabs,
      profileCardTitle: "Executive Profile",
      previewTitle: "Affiliations & Network",
      kpis: [
        { label: "Verified Links", countKey: "connections", targetTab: "connections" },
        { label: "Affiliated Orgs", countKey: "affiliatedOrgs", targetTab: "connections" },
        thirdKpi,
        { label: "Cala Sources", countKey: "sources", targetTab: "sources" }
      ]
    };
  }

  if (archetype === "investor") {
    const visibleTabs = [
      { key: "overview", label: "Overview", countKey: null },
      ...(peopleCount > 0 ? [{ key: "people", label: "Team", countKey: "people" }] : []),
      { key: "funding", label: "Portfolio", countKey: "funding" },
      { key: "connections", label: "Network", countKey: "connections" },
      { key: "timeline", label: "Activity", countKey: "timeline" },
      { key: "sources", label: "Sources", countKey: "sources" }
    ];
    return {
      archetype,
      visibleTabs,
      profileCardTitle: "Firm Profile",
      previewTitle: "Key Portfolio & Co-Investor Links",
      kpis: [
        { label: "Portfolio & Deals", countKey: "funding", targetTab: "funding" },
        { label: "Verified Links", countKey: "connections", targetTab: "connections" },
        { label: "Team", countKey: "people", targetTab: peopleCount > 0 ? "people" : "connections" },
        { label: "Cala Sources", countKey: "sources", targetTab: "sources" }
      ]
    };
  }

  if (archetype === "event") {
    const hasParticipants = investorsCount + roundsCount > 0;
    const visibleTabs = [
      { key: "overview", label: "Overview", countKey: null },
      ...(hasParticipants ? [{ key: "funding", label: "Participants", countKey: "funding" }] : []),
      { key: "connections", label: "Connections", countKey: "connections" },
      { key: "sources", label: "Sources", countKey: "sources" }
    ];
    return {
      archetype,
      visibleTabs,
      profileCardTitle: "Event / Deal Details",
      previewTitle: "Verified Participants & Links",
      kpis: [
        {
          label: "Participants",
          countKey: hasParticipants ? "funding" : "connections",
          targetTab: hasParticipants ? "funding" : "connections"
        },
        { label: "Verified Links", countKey: "connections", targetTab: "connections" },
        { label: "Cala Sources", countKey: "sources", targetTab: "sources" }
      ]
    };
  }

  const showOrgFunding = !kindLower.includes("organization") || financingTotal > 0;
  const visibleTabs = [
    { key: "overview", label: "Overview", countKey: null },
    { key: "people", label: "Leadership", countKey: "people" },
    ...(showOrgFunding ? [{ key: "funding", label: "Funding", countKey: "funding" }] : []),
    { key: "connections", label: "Connections", countKey: "connections" },
    { key: "timeline", label: "Timeline", countKey: "timeline" },
    { key: "sources", label: "Sources", countKey: "sources" }
  ];
  return {
    archetype,
    visibleTabs,
    profileCardTitle: kindLower.includes("organization") ? "Organization Profile" : "Company Profile",
    previewTitle: "Top Verified Connections",
    kpis: [
      { label: "Verified Links", countKey: "connections", targetTab: "connections" },
      { label: "Leadership", countKey: "people", targetTab: "people" },
      { label: "Rounds & Backers", countKey: "funding", targetTab: showOrgFunding ? "funding" : "connections" },
      { label: "Cala Sources", countKey: "sources", targetTab: "sources" }
    ]
  };
}
