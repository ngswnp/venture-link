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

