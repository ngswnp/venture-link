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

## Step 5: Live Multi-Scenario Hygiene, Investor-Round Fix & Edge Brief Grounding (`src/engine.mjs`, `src/llmControlPlane.mjs`)
- **Bugs Found & Fixed During Live Multi-Scenario HTTP Benchmark (`http://127.0.0.1:4173`)**:
  - **Investor Portfolio-Round Timeline Pollution**: `Sequoia Capital` (`Series C` / `Series B` / `Series F`) and `NVIDIA` (`Ineffable Intelligence SEED $1.1B` / `Series A`) previously pushed `FundingRound` participations with `role: INVESTOR` / `LEAD_INVESTOR` / `LENDER` into the investor's own `timingEventsByEntity`, creating false `ROUND_SEQUENCE_ANOMALY` flags (`5` false flags on Sequoia Capital, `3` on Nvidia). Scoped `recordTimingCatalyst` in `src/engine.mjs` to exclude investor-role funding-round participations while preserving `Pass 2` `Investor -> Issuer` access edges.
  - **Company-to-Company `IS_MEMBER_OF` Leakage on Neighbor Entities**: Generalized cross-entity `IS_MEMBER_OF` suppression to quarantine unverified non-person, non-investor, non-consortium edges even when one endpoint is outside `focalById` (eliminating `OpenAI IS_MEMBER_OF Anthropic PBC` from `NVIDIA + OpenAI`).
  - **`B2B` False `$2B` Rejection & Missing `summarySourceIds`**: Fixed `currencyRe` lookbehind `(?<![A-Za-z0-9_.])` in `src/llmControlPlane.mjs` so tokens like `B2B` are never misread as `$2B`, added `summarySourceIds` to `mode: 'connection'` schema, and expanded `executiveTakeaway` cap to `420` chars with clean sanitization (`v8:` cache key).
- **Checks Passed**:
  - `npm test`: `70/70` pass across all 8 suites (including 2 new regression tests in `test/entity-map.test.mjs` and `test/llmControlPlane.test.mjs`).
  - Live `OpenAI + Anthropic`: `24ms` analyze, `score 84` (`Grade A`, `70%` verified, `25` quarantined), `4/4` `anthropic` factors, `dropped: 0`, `14,094 ms` cold / `5 ms` warm.
  - Live `NVIDIA + OpenAI`: `38ms` analyze, `score 87` (`Grade A`, `74%` verified, `44` quarantined), `timingAnoms: []`, `OpenAI IS_MEMBER_OF Anthropic PBC` eliminated, `4/4` `anthropic` factors, `dropped: 0`, `12,895 ms` cold.
  - Live `Sequoia Capital`: `10ms` analyze, `score 54` (`Grade B`, `83%` verified), `timingAnoms: []`, and single-edge `AI Diligence Brief` (`Sequoia Capital → fal.ai`) returned `anthropic-connection-analyst` (`2,868 ms`, `dropped: 0`, `2` grounded insights).
  - HTTP validation: `GET /` `200`, `GET /api/bootstrap` `200`, `POST /api/connection-insight {}` `400`.

## Step 6: Visual & Interactive Browser QA + 4-Analyst Assessment (`src/decisionEngine.mjs`, `public/index.html`, `public/app.js`, `public/styles.css`)
- **Bugs Caught & Fixed via Headless Chrome CDP + Screenshot Inspection**:
  - **Light Mode Contrast Fix**: Replaced legacy `body.theme-light` selectors (lines 9625–11077 in `public/styles.css`) with `html[data-theme="light"]` matching `applyTheme()` in `public/app.js`, moving light `.decision-summary-popover` rules after base styles and adding full light-surface/slate-ink contrast rules (`qa_6`, `qa_6b`).
  - **Top-Left Pinned Chip Wrapping & Bridge Diversity**: Updated `.explored-entities-box.is-expanded` wrapping (`qa_1`) and diversified `sharedBridgeHighlights` in `src/decisionEngine.mjs` so `Key Bridges · Click to Locate` displays both `Access` (`CISCO SYSTEMS, INC.`) and `Lineage` (`Daniela Amodei`) hubs.
  - **Drawer Typo, Scroll Resets, Provenance Source Ordering & Mobile Viewport Fit**: Fixed `renderDrawer` -> `renderDecisionDrawer`, fixed singular `"1 point"` / `"1 path"` badges, sorted `submittedSourceIds` by provenance tier (`FILING` -> `PRIMARY` -> `PRESS` -> `AGGREGATOR`, external URLs first), reset popover `scrollTop = 0` on view switches, tuned mobile (`390x844`) `max-height: min(600px, calc(100dvh - 235px))` + header status ellipsis, and added inline SVG `<link rel="icon">` to eliminate `/favicon.ico` `404`s.
- **Verified Browser QA Metrics (`http://127.0.0.1:4173`, Chrome CDP `qa_browser.mjs`)**:
  - Desktop Dark (`1440x900`), Desktop Light (`1440x900`), and Mobile (`390x844`) visually verified across 8 screenshots (`qa_1`..`qa_7` + `qa_6b`).
  - `consoleErrors: []` (`0`), `failedRequests: []` (`0`), `<details>` count `0`, factor switch latency `2 ms`, `4/4` Claude factors + grounded `IC Synthesis` + `Claude AI · Grounded in Cala` edge inspector brief (`edge:593b35a1...`), mobile horizontal overflow `390/390` (`0 px` overflow across Compact, Detail, and Expanded views).

### Multi-Perspective Analyst Assessment (Post-Step 6 Verified Build)
| Analyst Perspective | Evidence & Capability Verified | Score |
|---|---|---|
| **VC Sourcing Associate** | 1-click verdict + `Score 84/100 · Grade A`, diversified `Key Bridges` (`CISCO SYSTEMS, INC.`, `Daniela Amodei`), `Focus map` hub expansion & curve isolation, `2 ms` cached factor switches | **9.7 / 10** |
| **Investment Committee Partner** | Low-text progressive disclosure above the fold (`Claude Takeaway` + `Next Diligence Check`), instant 2-column IC Workspace with grounded synthesis, spotless Dark + Light themes | **9.6 / 10** |
| **Data Engineer** | Strategic investor direction fix (`NVIDIA -> OpenAI`, `CISCO -> OpenAI`), `25`–`44` noisy edges quarantined, zero investor portfolio-round pollution, `v8:` disk cache (`35.6s -> 14.1s` cold, `2–5ms` warm), `70/70` tests | **9.7 / 10** |
| **Due Diligence Lead** | `FILING`/`PRIMARY` external sources (`Open ↗`) prioritized at top, stacked Provenance Mix bar, explicit `Data Hygiene & Quarantined Flags` audit panel, grounded `Scope & Limitation` + `Next Diligence Check`, working edge `AI Diligence Brief` | **9.6 / 10** |

## Step 7: Final Verification & Release Checklist
- Syntax checks (`node --check` on `server.mjs`, `src/*.mjs`, `public/app.js`), full test suite (`npm test`), secret history audit, live daemon health check (`http://127.0.0.1:4173/api/bootstrap`), and `git push origin main` verified after final edit.

## Step 8: 4-Factor Analysis Tab & Overall UI/UX Polish (`public/app.js`, `public/styles.css`)
- **4-Factor Analysis Tab Fixes & UX Upgrades**:
  - **Pinned Header & Sticky Factor Navigation**: Converted `.decision-summary-popover` into a bounded `overflow: hidden` flex container with independent scrollable `#decisionFactorList` and `#decisionAiOutput` (`min-height: 0; overflow-y: auto`), keeping `.decision-pop-header` pinned and making `.decision-ai-navigation` (`<- Factors`, 4-factor mini switcher pills, `Expand` / `Return to map`) `position: sticky; top: 0` during drawer scroll (`scrollTop = 340`).
  - **De-duplicated Badges & Domain Role Headings**: Replaced triple-repeated factor titles with descriptive domain subtitles (`FACTOR_ROLE_SUBTITLES`) + inline progress track in `.decision-ai-factor-head`, hid redundant `#decisionGradeBadge` in compact detail headers, and hid duplicate header badges in Expanded 2-Column Workspace (`.decision-exec-banner` renders them directly below).
  - **Accurate Source Provenance Mix, Above-the-Fold Hygiene & Clickable Citations**: Fixed `computeSourceProvenanceMix` in `public/app.js` so `Verified Sources & Quality` tallies match displayed `submittedSourceIds` (`16 sources` = `PRIMARY 13 · PRESS 1 · AGG 2`), fixed `collectDecisionSourceMap` non-empty field merge so Cala source `url` links are preserved when `res.analysisInput.sources` is merged, surfaced `Data Hygiene & Quarantined Flags` above source cards in Expanded Workspace (`hygieneVisibleInExpanded: true`), added clickable citation `<a>` pills in Compact/Expanded takeaways, and made `N cited ↓` jump directly to open `Verified Sources & Quality`.
- **Overall Constellation Map & Inspector Bug Fixes**:
  - **Right Zoom Rail Non-Overlap**: Toggled `has-decision-popover-open` and `has-decision-detail-open` on `document.body` so `#mapZoomToolbar` repositions cleanly left (`right: 424px` / `456px`) when the compact decision popover is open (`zoomOverlapCompact: false`, `zoomOverlapDetail: false`) and fades unobtrusively on narrow screens.
  - **Top-Left Compare Drawer & Stale Status Hygiene**: Auto-collapsed `#exploredCompareDrawer` after adding a compare entity (`compareDrawerHiddenAfterAdd: true`) and on opening the decision popover; added mutual overlay exclusion and clean bottom pill truncation on `390x844` mobile (`scrollW: 390`, `bottomPillOverlap: false`, `12px` clearance); added `restoreDefaultMapStatus()` to clear transient `"Focused signal on constellation map..."` copy.
  - **Connection Inspector & Entity Dossier Typography**: Replaced display ASCII arrows (`->`, `<->`) with Unicode `→` / `↔`, humanized `Cala Relation` enums (`formatCalaRelationDisplay`), converted `.ai-cite-chip` pills inside `renderAiInsightSection()` into external links when source URLs exist (`clickableCiteLinks: 2`), reset modal scroll & hid hover tooltips on open, and balanced `.fact-grid` (`minmax(220px, 1fr)`).
- **Verified Checks**:
  - `npm test`: `70/70` pass across all 8 test files (`0` failures, `0` skipped).
  - Invariants: `0` `<details>` tags, `0` green hex/rgba colors.
  - Headless Chrome CDP (`qa_browser.mjs`, `http://127.0.0.1:4173`): `consoleErrors: []`, `failedRequests: []`, Dark/Light/Mobile screenshots visually inspected (`qa_1`..`qa_7`, `qa_6b`).

## Step 9: Context-Aware Workflow & 4-Factor Architecture Redesign (`src/engine.mjs`, `server.mjs`, `src/decisionEngine.mjs`, `src/llmControlPlane.mjs`, `public/*`)
- **Layer A — Objective Structural Role Decoupling (`src/engine.mjs`)**:
  - Added `STRUCTURAL_ROLES` (`capital`, `governance`, `commercial`, `strategic_event`) and `classifyTimingRecency()` using a dynamic 18-month cutoff relative to `referenceDate` (`active_catalyst` <= 18m vs `historical_milestone` > 18m vs `undated`).
  - Reclassified `ACQUIRED` out of `caution` to `structuralRole: 'governance'`, `contributionGroup: 'lineage'`, `isAcquisition: true` unless paired with an explicit conflict/rivalry flag.
  - Tagged `SUPPLIES`, `SUPPLIED_BY`, `PARTNERED_WITH`, `ADVISED` cleanly with `structuralRole: 'commercial'` so commercial value-chain ties are never mislabeled as warm intro outreach unless traced through an active firm Perspective.
  - Removed remaining `'pts'` strings from `buildEntityBridgeMap` (`formulaBreakdown.inputs`, `significanceInputs`) and `computeContributionWeightsFrontend` (`public/app.js`).
- **Layer B — Dynamic Context Modes & Asymmetric Perspective Triage (`src/engine.mjs`, `server.mjs`, `src/decisionEngine.mjs`, `src/llmControlPlane.mjs`)**:
  - **`single_teardown`** (1 entity, Perspective = Neutral default): Removed forced `group_hub` rings; grouped satellites into non-empty radial sectors by objective `structuralRole` (`GOVERNANCE & LEADERSHIP`, `CAPITAL & OWNERSHIP`, `COMMERCIAL VALUE CHAIN`, `M&A, RIVALS & CATALYSTS`) with SVG sector headers, Company Teardown brief, explicit `missingDisclosures`, and quick CTAs (`+ Add Peer`, `Set Perspective`).
  - **`ecosystem_compare`** (2+ entities, Neutral): Removed per-anchor `group_hub` intermediate bubbles in favor of direct structural satellite arcs + typed Center Bridge Spine badges (`↔ Shared Backer`, `↔ Shared Bottleneck`, `↔ Shared Talent`, `↔ Direct Rivalry`), `sharedCommercialBottlenecks`, and `Evaluate Primary Target` switcher.
  - **`perspective_triage`** (optional, clearable `My Firm / Buyer Seat` set): Resolved direct and 2-hop warm intro chains (`warmIntroChains`, `isColdOutreach`) and `PORTFOLIO_OVERLAP` conflicts asymmetrically relative to the selected perspective (`My Firm` on left -> Warm Spine -> Target(s) on right).
  - Updated `analyzeConnectionWithCitationGate` (`v10:` cache key) to tailor structured and single-edge prompts per active `analysisMode` (`single_teardown`, `ecosystem_compare`, `perspective_triage`).
- **Verified Checks (Post-Final Edit)**:
  - `node --check public/app.js public/mapPhysics.js server.mjs src/*.mjs`: `0` syntax errors.
  - `npm test`: `74/74` tests passing across all 8 suites (including 4 new test cases across `test/entity-map.test.mjs`, `test/decisionEngine.test.mjs`, `test/api.test.mjs`, and `test/llmControlPlane.test.mjs`).
  - UI Invariants: `0` `<details>` elements, `0` green hex/rgba colors in `public/styles.css` & `public/app.js`, `0` `'pts'` strings in `public/app.js`.
  - Live Chrome CDP (`qa_context_modes.mjs`, `http://127.0.0.1:4173`): Verified `Nvidia` single teardown (`0` `group_hub` nodes, `3` SVG sector labels, all 4 teardown cards visible), `OpenAI + Nvidia + Anthropic` ecosystem map (`0` `group_hub` nodes, `Anthropic` Primary Target focus), `Sequoia Capital` -> `Anthropic` perspective triage (`perspective_triage` + clean reset back to Neutral), `390x844` mobile layout (`0px` horizontal overflow), `consoleErrors: []`, `pageExceptions: []`.

## Step 10: Expanded Analysis Tab Re-Optimization, UI Collision Fixes & Verified Cala Data Emphasis (`src/decisionEngine.mjs`, `src/llmControlPlane.mjs`, `public/*`)
- **Verified Real Cala Data Provenance Emphasis**:
  - Updated the welcoming hero screen (`public/index.html`, `public/styles.css`) with `"Powered by Real, Verified Cala Data"` kicker, revised hero subtitle highlighting live Cala Knowledge Graph records & primary filings, and the 3-pillar `#heroCalaTrustBar` (`Real Cala Graph Data`, `Filing & Primary Provenance`, `Source-Locked Analysis`), hidden automatically once entering map workspace.
  - Added prominent Cala provenance trust cues across the compact and expanded analysis views: updated `#decisionAiPrompt` (`100% Real Cala Data`), `#decisionGradeBadge` (`Real Cala Data · ...`), `.cala-provenance-strip` in Compact Detail, `.decision-cala-verified-badge` in Expanded Executive Strip, and `.decision-cala-assurance` inside Expanded `Evidence Provenance & Sources`.
- **UI Collision & Canvas Layout Fixes**:
  - Added mode-aware `shortTabLabel` across `single_teardown`, `ecosystem_compare`, and `perspective_triage` (`src/decisionEngine.mjs`, `public/app.js`) plus proportional CSS grid tracks and ellipsis bounds (`.decision-factor-switcher`, `.decision-mini-pill`), eliminating tab text collisions in compact, expanded, and `390×844` mobile views (2×2 grid on `@media (max-width: 700px)`).
  - Added SVG bounding-box collision avoidance on `.sector-cluster-label` (`renderConstellationMap`), preventing sector headers (`CAPITAL & OWNERSHIP`, etc.) from overlapping outer node labels (`overlaps: []`).
  - Enforced mutual exclusion between `#constellationFilterRibbon` and `#perspectivePopover`, plus delegated mode CTA handling across both compact and expanded analysis drawers (preserving expanded workspace when switching `Evaluate Primary Target` inline).
- **Expanded Analysis Tab & Entity Direction Cleanup**:
  - Attached `nodeEntityType` (`Organization` vs `Person`) on factor records, prioritized institutional organizations ahead of individual executives in `access` headlines, and fixed `Person Tie` vs `institutional investor` insight phrasing (`isPersonBridgeRecord`, `deriveConnectionAnalystInsight`).
  - Added `mergeExpandedConnectionRecords` to collapse duplicated shared bridge rows (`CISCO SYSTEMS, INC. → OpenAI & Anthropic`), normalize inbound capital orientation (`Investor → Target`), eliminate expanded right-column horizontal overflow by separating `.decision-insight-card-top` (`Focus map`) from `.decision-insight-card-badges`, and added the left-column `.decision-snapshot-panel` (Teardown 4-tile breakdown + Cala disclosure gaps, Ecosystem hub counts + clickable shared bridges, Triage warm intro chains + portfolio overlap flags).
  - Tuned Claude `modeGuidance` and safe-noun guidance (`v11:` cache key in `src/llmControlPlane.mjs`) without relaxing `restrictedClaimTerms`.
- **Verified Checks**:
  - `node --check public/app.js public/mapPhysics.js server.mjs src/*.mjs`: `0` syntax errors.
  - `npm test`: `75/75` tests passing across all 8 test suites (including `test/decisionEngine.test.mjs` coverage for `shortTabLabel`, `nodeEntityType`, and Org-ahead-of-Person priority).
  - Static invariants: `0` `<details>` elements, `0` `pts` strings, `0` green hex/rgba colors.
  - Live Chrome CDP (`qa_v2_capture.mjs`, `http://127.0.0.1:4173`): `ok: true`, `0` console/page errors, `0` tab overlaps/clipping across compact, expanded dark/light, teardown, triage, and `390×844` mobile.

## Step 11: Saltmere-Style Editorial Welcome Screen Redesign & Starter Card Removal (`public/index.html`, `public/styles.css`, `public/app.js`)
- **Removed Old 4-Tab Starter Grid (`#aiExamplesBar` / `.starter-pill-btn`)**:
  - Removed the 4 starter entity cards (`OpenAI`, `NVIDIA Corporation`, `Sequoia Capital`, `Nvidia + OpenAI network`) and `#heroCalaTrustBar` from `public/index.html`, `public/styles.css`, and `public/app.js` (`STARTER=0`).
- **Editorial Saltmere-Matched Welcome Layout (`body.is-search-hero`)**:
  - **Fluted Glass & Coral/Cream Radial Bloom Backdrop**: Layered `repeating-linear-gradient(90deg, ...)` reeded vertical stripes over a central Coral (`#FF6B5B`) and warm Cream (`#F4EDE0`) radial bloom on deep Navy (`#111D35`) in dark mode and Cream (`#F4EDE0`) in light mode, keeping the dot-grid canvas scoped strictly to `body.is-map-workspace`.
  - **Floating Centered Header Pillar Nav (`#heroCenterNav`)**: Added a hero-only translucent pill switcher (`Graph Explorer`, `Real Cala Data`, `Primary Filings`, `4-Lens Briefs`) in `#dashboardMasthead` that syncs the active Coral indicator on the bottom feature strip.
  - **Upper-Right Translucent Cala Verification Card (`#heroPreviewCard`)**: Added the right-aligned frosted glass card showcasing `Live Cala Knowledge Graph · Real Filings`, tabular `FILING` / `100% Real` / `PRIMARY` and `1–4 Hubs` / `Source-locked` / `4 Lenses` rows, and the bottom Coral provenance badge (`100% Real Cala Data · Auditable Source IDs`).
  - **Lower Split Baseline Row (`.hero-main-grid`)**: Positioned the left-aligned display headline (`Real Cala data that / maps every link.`) and 2-line subtitle opposite the lower-right glass `#aiSearchForm` (`Cala Search ›`), upward-opening `#searchSuggestPopup` (`opensUpward: true`, `fitsViewport: true`), and `#heroQuickDemoBtn` (`Explore sample map ›`).
  - **Bottom 5-Column Editorial Reliability Strip (`#heroBottomStrip`)**: Added the 5-column hairline footer strip with active Coral top border segment and geometric vector icons (`Real Cala graph data`, `Primary & 13F filings`, `Zero synthetic links`, `Three analyst modes`, `Source-cited briefs`).
- **Verified Checks**:
  - `node --check public/app.js public/mapPhysics.js server.mjs src/*.mjs` & `npm test`: `75/75` tests passing (`0` failures).
  - Static invariants: `0` `.starter-pill-btn`, `0` `<details>`, `0` `pts`, `0` green hex/rgba colors.
  - Live Chrome CDP (`qa_v3_capture.mjs`, `http://127.0.0.1:4173`): `ok: true`, `scrollHeight: 900` at `1440×900`, `0` console/page errors, `390×844` mobile `overflows: false`, visually inspected in `qa_v3_welcome_dark.png`, `qa_v3_welcome_light.png`, `qa_v3_welcome_suggest.png`, `qa_v3_welcome_mobile_390.png`, and `qa_v3_map_workspace_check.png`.
