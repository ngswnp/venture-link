# VentureLink — Revealed Thesis & Cala Entity Bridge Map

VentureLink maps verified knowledge-graph relationships from Cala alongside European deal sourcing, revealed thesis analysis, and citation-gated Claude 4-factor decision insights.

## Features

- **Interactive Constellation Map**: Explore verified entities (companies, venture funds, people, events) and documented multi-entity bridge paths across 4 contribution lenses (`Access`, `Lineage`, `Timing`, `Caution`) with interactive physics, zoom/pan, and shared-path filtering.
- **6-Tab Entity Dossier**: Inspect `Overview`, `People`, `Funding & Investors`, `Connections`, `Timeline`, and `Sources & Gaps` for any indexed or live Cala entity.
- **Revealed Thesis Engine**: Deterministic suitability scoring, warm-intro pathfinding, untapped discovery mode, and point-in-time backtesting from verified deal history.
- **Citation-Gated Claude Control Plane**: Natural-language query compilation, grounded brief narration, and 4-factor connection analysis (`access`, `lineage`, `timing`, `caution`) strictly anchored to Cala source IDs.
- **Registry Enrichment & Disk Caching**: Supports UK Companies House and Finnish PRH lookups alongside budget-guarded Cala API caching in `.cache/`.

## Getting Started

1. Copy `.env.example` to `.env` and set your `CALA_API_KEY` and `ANTHROPIC_API_KEY`.
2. Start the server (Node.js >= 20 required, zero external npm dependencies):

```bash
npm start
```

3. Open `http://127.0.0.1:4173` in your browser.

## Testing

```bash
npm test
```

## Docker

```bash
docker build -t venture-link .
docker run -p 4173:4173 --env-file .env venture-link
```
