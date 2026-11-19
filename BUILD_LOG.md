# VentureLink Auto-Build Loop Log

## Baseline Audit (2026-11-19)

Tested live on `OpenAI + Anthropic` (`POST /api/analyze` + `POST /api/connection-insight`):

1. **Graph Data Hygiene Bugs (`src/engine.mjs`)**:
   - **Inverted Strategic Investor Arrows**: Non-round-expanded `INVESTED_IN` edges such as `OpenAI -> NVIDIA` and `OpenAI -> Amazon` were not recognized as inverted because `isLikelyInvestorEntity()` only checked narrow fund/VC keywords, missing major strategic/institutional investors (`NVIDIA`, `Amazon`, `Microsoft`, `Alphabet`, `MGX`, `Fidelity`, `Baillie Gifford`, etc.).
   - **Cross-Focal `IS_MEMBER_OF` Lineage Noise**: Raw Cala edges like `OpenAI IS_MEMBER_OF Anthropic` leaked directly into `LINEAGE`, distorting both the constellation map and Claude's lineage synthesis.
   - **Empty `CAUTION` on Multi-Hub Comparison**: On `OpenAI + Anthropic`, `caution` had `0` edges (`significanceScore: 0`) because `buildEntityBridgeMap` only checked `entity.category`/`sector`/`industry`, ignoring Cala's `OPERATES_IN_INDUSTRY` relationships as well as dual-sided investor conflicts, cross-hub talent migration, and round-sequence anomalies.
   - **Round-Sequence & Roundup Press Anomalies**: `timingEventsByEntity` promoted press-roundup headlines (`Series B · $580M (2026-05-11)` dated after `Series G · $5.0B (2026-04-21)` via a multi-company Crunchbase roundup URL) without ranking down anomalies or surfacing them to `Caution`.

2. **Claude Grounding & Latency Bottlenecks (`src/llmControlPlane.mjs`)**:
   - **Cold Latency**: `35,633 ms` on `OpenAI + Anthropic`, with no persistent disk cache across server restarts.
   - **Naive Sentence Splitter Truncation**: `filterUnsupportedFactorClaims` split on `/[^.!?]+[.!?]?/g`, cutting mid-phrase at `(Astral.` / `Ltd.` / `$5.0B`.
   - **Lost `nextCheck` & `reasoning`**: Overly aggressive acronym/claim rejection dropped `nextCheck` to `""` on all 4 factors and emptied `Access` reasoning (`[]`).

3. **Decision UX Friction (`public/app.js`, `public/styles.css`)**:
   - Client-side `getDecisionFactorEvidence` reversed arrow directions (`isFocal(edge.to)`), lacked per-factor quantitative signal strength & provenance bars, sent unranked/unbalanced records, and relied on raw `<details>` disclosures without 1-click connection focus on the map.

---

## Step 1: Graph Data Hygiene & Provenance Reconciliation (`src/engine.mjs`)
- **Implemented**:
  - Added `isStrategicCorporateInvestor`, `investorHierarchyScore`, `isLocationOrCountryEntity`, `isMembershipConsortiumEntity`, and `isRootHomepageUrl` helpers.
  - Added bulk-crawl spam detection (`isBulkCrawlNoise`: `>= 12` origins with `>= 70%` root homepage URLs) and tightened `inferCalaOriginRank` so bare homepage URLs (`https://www.sec.gov/`, `https://search.gleif.org/`) do not masquerade as `FILING` unless backed by explicit filing titles.
  - Quarantined noisy cross-focal `IS_MEMBER_OF` edges (`OpenAI -> Anthropic`), unverified `PRESS`/`AGGREGATOR` cross-focal `INVESTED_IN` co-mentions, `Location`/`Country` entities (`United States`) in `IS_MEMBER_OF`, and root-homepage bulk-crawl noise (`Target Corp -> OpenAI`, `OpenAI -> OpenAI Group PBC`) into `bridgeMap.quarantinedAnomalies`.
  - Fixed bidirectional `INVESTED_IN` conflict resolution (`rawInvestedPairs`) and oriented strategic/institutional investor edges (`NVIDIA -> OpenAI`, `Amazon -> OpenAI`, `Amazon -> Anthropic`, `CISCO SYSTEMS, INC. -> Anthropic`, `Sequoia -> Anthropic`).
  - Collapsed redundant person-to-company `WORKS_AT`/`IS_MEMBER_OF` duplicates when explicit founder/executive roles exist (capping noisy multi-C-suite press duplicates to top 3 provenance-ranked distinct roles per `(person, focalCompany)` while preserving all cross-hub bridges).
  - Added round-sequence and press-roundup anomaly detection on `timingEventsByEntity` (flagging out-of-sequence `Anthropic Series B` after `Series G` and `OpenAI Seed` after `Series B`) and fixed `OPERATES_IN_INDUSTRY` overlap extraction (`Software & Services Rivalry`).
- **Checks Passed**: `node --test test/entity-map.test.mjs test/engine.test.mjs` (`34/34` pass); `npm test` (`63/63` pass).

## Step 2: Backend Decision Engineering Engine (`src/decisionEngine.mjs`)
- **Implemented**:
  - Created `src/decisionEngine.mjs` exporting `buildDecisionIntelligence({ focalEntities, nodes, edges, timingEventsByEntity, sourcesById, anomalies })`.
  - Computes per-factor `signalStrength` (0–100) weighted by provenance (`FILING=1.0`, `PRIMARY=0.82`, `PRESS=0.45`, `AGGREGATOR=0.35`), shared-bridge multiplier (`1.5x`), lead/executive boost (`1.25x`), and timing recency decay.
  - Produces hub-balanced, distinct-actor-prioritized `rankedRecords` (top 8 per factor), `provenanceMix`, `coverage`, crisp `headline`, `investmentImpact`, and record-anchored `actionableCheck`.
  - Synthesizes grounded Caution flags: industry overlap (`OPERATES_IN_INDUSTRY`), dual-sided institutional investor exposure (`DUAL_SIDED_INVESTOR_CONFLICT`), cross-hub executive overlap (`CROSS_HUB_TALENT_OVERLAP`), and round-sequence anomalies (`ROUND_SEQUENCE_ANOMALY`).
  - Produces executive synthesis (`verdict`, `evidenceScore`, `reliabilityGrade`, `sharedBridgeHighlights`, `warmIntroRoutes`, `dataAnomalies`, `topDiligenceActions`) wired into `buildEntityBridgeMap` (`src/engine.mjs`).
- **Checks Passed**: Added `test/decisionEngine.test.mjs` and wired into `package.json`; `npm test` passed (`65/65`). On `OpenAI + Anthropic`, `decisionIntelligence` yields `evidenceScore: 86` (`Grade A`, `72%` verified), `Verdict: Actionable · Verify Risks`, `Access` `98` (`13` shared paths), `Lineage` `98` (`5` cross-hub leaders), `Timing` `56`, `Caution` `87` (`6` grounded flags).

## Step 3: Claude Control-Plane Grounding, Wire Aliasing & Persistent Cache (`src/llmControlPlane.mjs`, `src/engine.mjs`, `src/decisionEngine.mjs`)
- **Implemented**:
  - Added schema-versioned persistent disk insight cache (`.cache/claude-insight-cache.json`, prefix `v6:`, skipping disk when `options.cache` or `options.disableDiskCache` is set and never caching deterministic fallbacks or HTTP errors).
  - Added `splitSentencesPreservingAbbreviations` (`$5.0B`, `Astral.sh`, `Inc.`/`Ltd.`/`Corp.`), `extractAllowedNumbers` supporting compact currency/percent tokens (`$30B`, `$40M`, `$580M`, `€5.5M`, `72%`), `ip`/`ma`/`mna` acronym equivalents, `record.sourceRank` grounding visibility (`FILING`/`PRIMARY`/`PRESS`/`AGGREGATOR`), `[...groupIds]` evidence pooling for `limitation`/`nextCheck`, and allowed negated caveats on `limitation`.
  - Added wire-level short source ID aliasing (`s1..s32`) before calling Anthropic API and restored full Cala citation IDs on parse; calibrated 4-factor prompt to generate `executiveTakeaway` alongside factor analyses and prevent wire alias leaks in prose.
  - Added round-robin source collection per ranked record in `src/decisionEngine.mjs`, cleaned duplicate date formatting in `timing.actionableCheck`, and mapped `MNA_COMPLETED` to `M&A Completed` in `src/engine.mjs`.
- **Checks & Calibration Metrics**:
  - `npm test`: `68/68` pass across 8 suites (including 3 new `llmControlPlane.test.mjs` tests).
  - **Before -> After (`OpenAI + Anthropic`)**: Cold latency `35,633 ms -> 14,356 ms` (~2.48x faster), warm cache hit `3 ms` (`fromCache: true`), grounded factor `decisionEffectSource === 'anthropic'` improved to `4/4` (`access`, `lineage`, `timing`, `caution`) with `dropped: 0` and grounded `executiveTakeaway` (`M&A Completed (2026-03-19)`, `$30B`, `$13B`, `$40M`).
  - **Cross-Scenario Verification (`NVIDIA + OpenAI`)**: Cold `15,655 ms`, `4/4` `decisionEffectSource === 'anthropic'`, `4/4` non-empty record-grounded `nextCheck` checks, `dropped: 0`.

## Step 4: Progressive-Disclosure Low-Text Decision UI/UX (`public/index.html`, `public/app.js`, `public/styles.css`)
- **Implemented**:
  - Updated `#decisionSummaryPopover` (`public/index.html`) with `#decisionGradeBadge` (`Score N/100 · Grade X · Y% Verified`) and clickable `#decisionBridgeStrip` bridge highlights.
  - Wired `buildFourFactorDecisionSummary` and `getDecisionFactorEvidence` in `public/app.js` directly to `bridgeMap.decisionIntelligence` (`signalStrength`, provenance mix, canonical `From → To` direction, hub-balanced `rankedRecords`, and quarantined anomaly count).
  - Updated Compact Popover with 4 low-text factor scorecards (`0–100` progress bar, `N shared` micro-tag, truncated 1-line headline) and top 2 map-clickable bridge highlight chips (`data-focus-edge-id`, `data-focus-node-id`).
  - Redesigned Factor Detail View and Expanded 2-Column Executive Workspace with sticky 4-factor pill switcher (`0 ms` cached switching), 3 KPI tiles (`Paths`, `Verified`, `Sources`), Claude Takeaway, Next Diligence Check, stacked Provenance Mix bar, Data Hygiene & Quarantined Flags box, accessible `<button aria-expanded>` drawers (`Reasoning & Scope`, `Supporting Connections`, `Verified Sources & Quality` — zero `<details>` tags), `focusDecisionSignalOnMap` 1-click curve/node isolation, and Connection Inspector `Data Flag` surfacing.
  - Added full Dark, High-Contrast `body.theme-light`, and Mobile (`<= 700px`) styling in `public/styles.css` with zero green hex/rgba values.
- **Checks Passed**: `node --check` on `server.mjs`, `src/*.mjs`, `public/app.js` (`0` errors); `grep -c "<details"` returned `0` in both `public/index.html` and `public/app.js`; zero green CSS values; `npm test` passed (`68/68`).

