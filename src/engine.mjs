import {
  COMPANIES,
  FUNDS,
  PEER_INVESTORS,
  REFERENCE_DATE,
  SOURCES
} from './data.mjs';
import { buildDecisionIntelligence } from './decisionEngine.mjs';

const SECTOR_ADJACENCY = {
  'AI & ML': ['DeepTech', 'B2B SaaS'],
  'DeepTech': ['AI & ML', 'Climate Tech'],
  'HealthTech': ['AI & ML', 'DeepTech'],
  'Fintech': ['B2B SaaS', 'AI & ML'],
  'Climate Tech': ['DeepTech', 'AI & ML'],
  'B2B SaaS': ['AI & ML', 'Fintech']
};

const NEXT_STAGE = {
  'Pre-Seed': 'Seed',
  'Seed': 'Series A',
  'Series A': 'Series B',
  'Series B': 'Series B'
};

/**
 * Calibrated from investorTotalDealsMap across the indexed European venture snapshot:
 * - 7 multi-stage mega-hub funds hold 9-18 deals (lifeline-ventures 18, seedcamp 13,
 *   cherry-ventures 12, maki-vc 11, inventure 11, northzone 10, creandum 9).
 * - 12 specialist, micro, and angel-syndicate investors hold 1-7 deals (angel-syndicate 7,
 *   forerunner 4, eqt-ventures 3, true-ventures/icebreaker-vc/hummingbird/general-catalyst/nordic-micro-lab 2, etc.).
 * Threshold 8 isolates noisy high-degree hubs while keeping boutique and micro-fund bridges visible.
 */
// Investor deal-degree distribution across COMPANES (reference index):
// Anchor: lifeline-ventures (18). Multi-stage European Seed VCs: seedcamp (13), cherry-ventures (12),
// maki-vc (11), inventure (11), northzone (10), creandum (9). Specialist / micro / syndicates (1-7).
// Threshold 14 keeps real European Seed VCs visible as Feeder / Co-Investor bridges while flagging
// hyper-volume platforms (>= 14 deals) and broad unselective angel aggregators (BROAD_HUB_INVESTOR_IDS).
export const MEGA_HUB_DEAL_THRESHOLD = 14;
export const BROAD_HUB_INVESTOR_IDS = new Set(['angel-syndicate']);

export const SLUSH_2026_EVENT_ID = 'bc844d56-6ab4-452b-96bf-2661e86e592b';

const SOURCE_RANK_PRIORITY = {
  FILING: 4,
  PRIMARY: 3,
  PRESS: 2,
  AGGREGATOR: 1
};

export function monthsBetween(startIso, endIso = REFERENCE_DATE) {
  if (!startIso || !endIso) return 0;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  const days = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round((days / 30.4375) * 10) / 10);
}

export function subtractMonths(isoDate, months) {
  const d = new Date(isoDate);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

export function median(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2 === 1) return Math.round(nums[mid] * 10) / 10;
  return Math.round(((nums[mid - 1] + nums[mid]) / 2) * 10) / 10;
}

export function quantile(values, q) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const clamped = Math.max(0, Math.min(1, Number(q) || 0));
  const pos = clamped * (nums.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return Math.round(nums[lo] * 10) / 10;
  const val = nums[lo] + (nums[hi] - nums[lo]) * (pos - lo);
  return Math.round(val * 10) / 10;
}

export function interpolateHeadcountAtDate(company, isoDate, cutoffDate = null) {
  const rawSeries = Array.isArray(company?.employeeCountSeries) ? company.employeeCountSeries : [];
  const series = rawSeries
    .filter((obs) => obs?.date && (!cutoffDate || obs.date <= cutoffDate))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  if (!series.length) {
    const declaredHeadcount = Number(company?.employeeCount);
    return {
      // Preserve an honest Cala coverage gap instead of inventing a likely
      // employee count for a sparse live entity.
      headcount: Number.isFinite(declaredHeadcount) && declaredHeadcount > 0 ? declaredHeadcount : null,
      preRoundVelocityPct: 0,
      observationDate: null,
      sourceId: company?.rounds?.[0]?.sourceIds?.[0] || null
    };
  }

  const targetDate = isoDate || cutoffDate || REFERENCE_DATE;
  const exact = series.find((obs) => obs.date === targetDate);
  const onOrBefore = series.filter((obs) => obs.date <= targetDate);
  const after = series.filter((obs) => obs.date > targetDate);

  let headcount;
  let usedObs;

  if (exact) {
    headcount = exact.value;
    usedObs = exact;
  } else if (onOrBefore.length > 0 && after.length > 0) {
    const prev = onOrBefore[onOrBefore.length - 1];
    const next = after[0];
    const spanMs = Math.max(1, new Date(next.date).getTime() - new Date(prev.date).getTime());
    const elapsedMs = Math.max(0, new Date(targetDate).getTime() - new Date(prev.date).getTime());
    const ratio = Math.min(1, elapsedMs / spanMs);
    headcount = Math.round(prev.value + (next.value - prev.value) * ratio);
    usedObs = prev;
  } else if (onOrBefore.length > 0) {
    usedObs = onOrBefore[onOrBefore.length - 1];
    headcount = usedObs.value;
  } else {
    usedObs = series[0];
    headcount = usedObs.value;
  }

  const earlierObs = series.filter((obs) => obs.date < (exact ? exact.date : targetDate));
  const baseline = earlierObs.length > 1 ? earlierObs[earlierObs.length - 1] : earlierObs[0];
  let preRoundVelocityPct = 0;
  if (baseline && baseline.value > 0 && headcount >= baseline.value) {
    preRoundVelocityPct = Math.round(((headcount - baseline.value) / baseline.value) * 100);
  }

  return {
    headcount,
    preRoundVelocityPct,
    observationDate: usedObs.date,
    sourceId: usedObs.sourceId || null
  };
}

function normalizeDistribution(weightMap) {
  const entries = Object.entries(weightMap).filter(([, val]) => val.weight > 0);
  const totalWeight = entries.reduce((sum, [, val]) => sum + val.weight, 0);
  if (totalWeight <= 0) return [];
  return entries
    .map(([label, val]) => ({
      label,
      count: val.count,
      weightedScore: Math.round(val.weight * 10) / 10,
      sharePct: Math.round((val.weight / totalWeight) * 100)
    }))
    .sort((a, b) => b.sharePct - a.sharePct || b.count - a.count || a.label.localeCompare(b.label));
}

export function deriveSourceProvenance(source) {
  if (!source) return { sourceRank: 'PRESS', datePrecision: 'month' };
  const explicitRank = source.sourceRank || source.source_rank;
  const hay = `${source.publisher || ''} ${source.title || ''} ${source.name || ''}`.toLowerCase();
  let sourceRank = explicitRank || 'PRESS';
  if (!explicitRank) {
    if (/(prh|trade register|bolagsverket|bronnoy|brønnøysund|virk|companies house|gleif|registry|patent|echa|tax|grant|esa|business finland|vinnova|eic|filing|sec|ytj|regulatory)/.test(hay)) {
      sourceRank = 'FILING';
    } else if (/(press release|official|portfolio|announcement|disclosure|company|investor|blog|direct)/.test(hay)) {
      sourceRank = 'PRIMARY';
    } else if (/(dealroom|pitchbook|crunchbase|tracxn|cb insights|archive)/.test(hay)) {
      sourceRank = 'AGGREGATOR';
    }
  }
  const explicitPrec = source.datePrecision || source.date_precision;
  let datePrecision = explicitPrec || 'month';
  if (!explicitPrec && typeof source.date === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(source.date)) datePrecision = 'day';
    else if (/^\d{4}-\d{2}$/.test(source.date)) datePrecision = 'month';
    else if (/^\d{4}$/.test(source.date)) datePrecision = 'year';
  }
  return { sourceRank, datePrecision };
}

export function resolveSources(sourceIds = []) {
  return sourceIds
    .map((id) => SOURCES[id])
    .filter(Boolean)
    .map((s) => ({ ...s, ...deriveSourceProvenance(s) }));
}

/**
 * Enforces Q31: every generated reason sentence must carry at least one valid Cala source ID.
 * Sentences without valid source IDs are dropped.
 */
export function enforceFactCitations(reasons = []) {
  return reasons
    .map((r) => {
      const validIds = (r.sourceIds || []).filter((id) => Boolean(SOURCES[id]));
      if (!validIds.length) return null;
      return {
        text: r.text,
        sourceIds: validIds,
        sources: resolveSources(validIds)
      };
    })
    .filter(Boolean);
}

export function searchEntities(rawQuery = '') {
  const query = String(rawQuery || '').trim().toLowerCase();
  if (!query) {
    return {
      query: '',
      ambiguousFunds: false,
      funds: FUNDS.slice(0, 3).map((f) => ({ id: f.id, name: f.name, hqCity: f.hqCity, country: f.country, calaEntityId: f.calaEntityId })),
      companies: COMPANIES.slice(0, 5).map((c) => ({ id: c.id, name: c.name, sector: c.sector, country: c.country }))
    };
  }

  const fundMatches = FUNDS.filter(
    (f) => f.name.toLowerCase().includes(query) || f.hqCity.toLowerCase().includes(query) || f.country.toLowerCase().includes(query)
  );
  const companyMatches = COMPANIES.filter(
    (c) =>
      String(c.name || '').toLowerCase().includes(query) ||
      String(c.sector || '').toLowerCase().includes(query) ||
      String(c.country || '').toLowerCase().includes(query)
  );

  return {
    query: rawQuery.trim(),
    ambiguousFunds: fundMatches.length > 1,
    funds: fundMatches.slice(0, 3).map((f) => ({
      id: f.id,
      name: f.name,
      hqCity: f.hqCity,
      country: f.country,
      calaEntityId: f.calaEntityId
    })),
    companies: companyMatches.slice(0, 6).map((c) => ({
      id: c.id,
      name: c.name,
      sector: c.sector,
      country: c.country,
      calaEntityId: c.calaEntityId
    }))
  };
}

function addToBucket(map, key, weight) {
  if (!map[key]) map[key] = { count: 0, weight: 0 };
  map[key].count += 1;
  map[key].weight += weight;
}

function analyzeStatedVsRevealed(statedText, sectorMix, geographyMix, stageMix, timeTravelProfile = null, upstreamFeeders = []) {
  const text = String(statedText || '').toLowerCase();
  const topSector = sectorMix[0];
  const topTwoSectorShare = (sectorMix[0]?.sharePct || 0) + (sectorMix[1]?.sharePct || 0);
  const topCountry = geographyMix[0];
  const topStage = stageMix[0];
  const findings = [];

  if (text.includes('agnostic') || text.includes('broad') || text.includes('consumer')) {
    if (topTwoSectorShare >= 65) {
      findings.push(
        `Website claims broad or agnostic investing, yet ${topTwoSectorShare}% of weighted deal history concentrates in ${sectorMix.slice(0, 2).map((s) => s.label).join(' and ')}.`
      );
    }
  }
  if (topSector && !text.includes(topSector.label.toLowerCase().split(' ')[0])) {
    findings.push(
      `Primary revealed sector (${topSector.label} at ${topSector.sharePct}% weighted share) receives little explicit emphasis in stated copy.`
    );
  }
  if (topCountry && topCountry.sharePct >= 50) {
    findings.push(
      `Geographic behaviour is tightly concentrated: ${topCountry.sharePct}% of weighted rounds are headquartered in ${topCountry.label}.`
    );
  }
  if (topStage) {
    findings.push(
      `Actual entry discipline centres on ${topStage.label} (${topStage.sharePct}% weighted share), confirming stage alignment.`
    );
  }
  if (timeTravelProfile?.medianEntryHeadcount != null) {
    const earliestClaimed = /(day[- ]?zero|day[- ]?one|pre[- ]?product|first check|two founders)/i.test(text);
    const p25 = timeTravelProfile.entryHeadcountP25;
    const p75 = timeTravelProfile.entryHeadcountP75;
    const iqrText = p25 != null && p75 != null ? `P25–P75 ${p25}–${p75}` : timeTravelProfile.entryHeadcountBand;
    if (earliestClaimed && timeTravelProfile.medianEntryHeadcount >= 12) {
      findings.push(
        `Stated copy emphasizes day-one/pre-product entry, yet time-travel reconstruction shows checks land at a median of ${timeTravelProfile.medianEntryHeadcount} employees (${iqrText}), ~${timeTravelProfile.medianEntryAgeMonths} months post-founding.`
      );
    } else {
      findings.push(
        `Time-travel entry DNA: writes checks at a median of ${timeTravelProfile.medianEntryHeadcount} employees (${iqrText}), ~${timeTravelProfile.medianEntryAgeMonths} months post-incorporation (${timeTravelProfile.filingVerifiedSharePct}% FILING/PRIMARY verified).`
      );
    }
  }
  if (upstreamFeeders.length > 0) {
    const topFeeders = upstreamFeeders.slice(0, 2);
    findings.push(
      `Upstream feeder reliance: ${topFeeders.map((f) => `${f.name} (${f.fedDealsCount}x prior round, lift ${f.lift ?? f.fedDealsCount})`).join(' and ')} backed Round N-1 ahead of follow-on entry.`
    );
  }
  if (!findings.length) {
    findings.push('Public stated thesis aligns broadly with observed Cala sector and stage records.');
  }
  return findings;
}

export function computeRevealedThesis(input, options = {}) {
  const cutoffDate = options.cutoffDate || null;
  const evalDate = cutoffDate || REFERENCE_DATE;
  const recencyCutoff = subtractMonths(evalDate, 36);

  const mode = input?.mode === 'companies' ? 'companies' : 'fund';
  let entity = null;
  const deals = [];
  const portfolioCompanyIds = new Set();
  const portfolioCompetitorGroups = new Map();

  if (mode === 'fund') {
    const fundId = input?.fundId;
    entity = FUNDS.find((f) => f.id === fundId || f.name.toLowerCase() === String(fundId || '').toLowerCase());
    if (!entity) {
      const err = new Error(`Fund "${fundId}" was not found in indexed Cala entities.`);
      err.statusCode = 404;
      throw err;
    }

    for (const company of COMPANIES) {
      if (company.isRegistryDiscovered || company.entityCategory === 'established_corp') continue;
      if (cutoffDate && company.isLiveCalaDiscovered) continue;
      for (const round of company.rounds) {
        if (cutoffDate && round.date >= cutoffDate) continue;
        if (round.investorIds.includes(entity.id)) {
          deals.push({ company, round });
          portfolioCompanyIds.add(company.id);
          if (company.competitorGroup) {
            portfolioCompetitorGroups.set(company.competitorGroup, company.name);
          }
        }
      }
    }
  } else {
    const companyIds = Array.isArray(input?.companyIds) ? input.companyIds : [];
    if (!companyIds.length) {
      const err = new Error('Please provide 3 to 5 company IDs to construct a proxy thesis.');
      err.statusCode = 400;
      throw err;
    }
    const matchedCompanies = COMPANIES.filter((c) => companyIds.includes(c.id));
    if (!matchedCompanies.length) {
      const err = new Error('None of the selected companies were found in Cala.');
      err.statusCode = 404;
      throw err;
    }
    entity = {
      id: 'custom-proxy',
      name: `Proxy Profile (${matchedCompanies.map((c) => c.name).slice(0, 3).join(', ')}${matchedCompanies.length > 3 ? '...' : ''})`,
      hqCity: matchedCompanies[0].hqCity,
      country: matchedCompanies[0].country,
      region: matchedCompanies[0].region,
      statedThesis: options.statedThesisOverride || 'Custom thesis inferred from user-selected admired companies.',
      sourceIds: matchedCompanies.flatMap((c) => c.rounds[0]?.sourceIds || [])
    };
    for (const company of matchedCompanies) {
      portfolioCompanyIds.add(company.id);
      if (company.competitorGroup) {
        portfolioCompetitorGroups.set(company.competitorGroup, company.name);
      }
      for (const round of company.rounds) {
        if (cutoffDate && (!round.date || round.date >= cutoffDate)) continue;
        deals.push({ company, round });
      }
    }
  }

  deals.sort((a, b) => (b.round.date || '').localeCompare(a.round.date || ''));

  const stageBuckets = {};
  const sectorBuckets = {};
  const olderSectorBuckets = {};
  const recentSectorBuckets = {};
  const countryBuckets = {};
  const regionBuckets = {};
  const coInvestorMap = {};
  const companyRoundCounts = {};
  const roundAmounts = [];
  const dealDates = [];
  let leadCount = 0;
  let recentCount = 0;
  let olderCount = 0;

  const entryHeadcounts = [];
  const entryAgeMonthsList = [];
  const preRoundVelocities = [];
  const dealSnapshots = [];
  let filingVerifiedDeals = 0;

  const entryByCompany = new Map();
  for (const { company, round } of [...deals].sort((a, b) => (a.round.date || '').localeCompare(b.round.date || ''))) {
    if (!entryByCompany.has(company.id)) {
      entryByCompany.set(company.id, { company, round });
    }
  }

  for (const { company, round } of [...entryByCompany.values()].sort((a, b) => (b.round.date || '').localeCompare(a.round.date || ''))) {
    const entryObs = interpolateHeadcountAtDate(company, round.date, cutoffDate);
    const foundingIso = company.foundingDate || `${company.foundedYear}-02-15`;
    const entryAgeMonths = monthsBetween(foundingIso, round.date);
    const resolvedSrcs = resolveSources(round.sourceIds || []);
    const hasFilingOrPrimary = resolvedSrcs.some((s) => s.sourceRank === 'FILING' || s.sourceRank === 'PRIMARY');
    if (hasFilingOrPrimary) filingVerifiedDeals += 1;

    entryHeadcounts.push(entryObs.headcount);
    entryAgeMonthsList.push(entryAgeMonths);
    preRoundVelocities.push(entryObs.preRoundVelocityPct);
    dealSnapshots.push({
      companyId: company.id,
      companyName: company.name,
      roundType: round.type,
      roundDate: round.date,
      entryHeadcount: entryObs.headcount,
      entryAgeMonths,
      preRoundVelocityPct: entryObs.preRoundVelocityPct
    });
  }

  const totalEntryDeals = entryByCompany.size || deals.length;

  for (const { company, round } of deals) {
    const isRecent = round.date >= recencyCutoff;
    const weight = isRecent ? 2.0 : 1.0;

    if (isRecent) {
      recentCount += 1;
      addToBucket(recentSectorBuckets, company.sector, 1);
    } else {
      olderCount += 1;
      addToBucket(olderSectorBuckets, company.sector, 1);
    }

    addToBucket(stageBuckets, round.type, weight);
    addToBucket(sectorBuckets, company.sector, weight);
    addToBucket(countryBuckets, company.country, weight);
    addToBucket(regionBuckets, company.region, weight);

    if (typeof round.amountEurM === 'number') roundAmounts.push(round.amountEurM);
    dealDates.push(round.date);
    companyRoundCounts[company.id] = (companyRoundCounts[company.id] || 0) + 1;

    if (mode === 'fund' && round.leadInvestorId === entity.id) {
      leadCount += 1;
    } else if (mode === 'companies' && round.leadInvestorId) {
      leadCount += 1;
    }

    for (const invId of round.investorIds) {
      if (mode === 'fund' && invId === entity.id) continue;
      if (invId === 'angel-syndicate') continue;
      if (!coInvestorMap[invId]) {
        coInvestorMap[invId] = {
          id: invId,
          name: PEER_INVESTORS[invId] || invId,
          sharedRounds: 0,
          companies: new Set(),
          sourceIds: new Set()
        };
      }
      coInvestorMap[invId].sharedRounds += 1;
      coInvestorMap[invId].companies.add(company.name);
      for (const sId of round.sourceIds || []) coInvestorMap[invId].sourceIds.add(sId);
    }
  }

  // Investor total deal counts (respected strictly <= cutoffDate) for normalized feeder lift
  const investorTotalDealsMap = {};
  for (const c of COMPANIES) {
    if (cutoffDate && c.isLiveCalaDiscovered) continue;
    for (const r of c.rounds || []) {
      if (cutoffDate && r.date >= cutoffDate) continue;
      for (const invId of r.investorIds || []) {
        investorTotalDealsMap[invId] = (investorTotalDealsMap[invId] || 0) + 1;
      }
    }
  }

  // Upstream "Feeder" Syndicate Graph & portfolio round cadence gaps
  const upstreamFeederMap = {};
  const roundGapsMonths = [];
  for (const compId of portfolioCompanyIds) {
    const company = COMPANIES.find((c) => c.id === compId);
    if (!company) continue;
    const compRounds = company.rounds
      .filter((r) => r.date && (!cutoffDate || r.date < cutoffDate))
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    if (compRounds.length < 2) continue;

    for (let i = 1; i < compRounds.length; i += 1) {
      const gap = monthsBetween(compRounds[i - 1].date, compRounds[i].date);
      if (gap > 0 && gap <= 60) roundGapsMonths.push(Math.round(gap));
    }

    let entryIdx = compRounds.length - 1;
    if (mode === 'fund') {
      const idx = compRounds.findIndex((r) => r.investorIds.includes(entity.id));
      if (idx <= 0) continue;
      entryIdx = idx;
    }

    for (let i = 0; i < entryIdx; i += 1) {
      const prevRound = compRounds[i];
      for (const invId of prevRound.investorIds) {
        if ((mode === 'fund' && invId === entity.id) || invId === 'angel-syndicate') continue;
        if (!upstreamFeederMap[invId]) {
          upstreamFeederMap[invId] = {
            id: invId,
            name: PEER_INVESTORS[invId] || invId,
            fedDealsCount: 0,
            companies: new Set(),
            sourceIds: new Set(),
            relationshipType: 'feeder_to_lead'
          };
        }
        upstreamFeederMap[invId].fedDealsCount += 1;
        upstreamFeederMap[invId].companies.add(company.name);
        for (const sId of prevRound.sourceIds || []) upstreamFeederMap[invId].sourceIds.add(sId);
      }
    }
  }

  const upstreamFeeders = Object.values(upstreamFeederMap)
    .map((f) => {
      const totalDeals = Math.max(f.fedDealsCount, investorTotalDealsMap[f.id] || f.fedDealsCount);
      const lift = Math.round((f.fedDealsCount / Math.sqrt(Math.max(1, totalDeals))) * 100) / 100;
      const isMegaHub = totalDeals >= MEGA_HUB_DEAL_THRESHOLD || BROAD_HUB_INVESTOR_IDS.has(f.id);
      return {
        id: f.id,
        investorId: f.id,
        name: f.name,
        investorName: f.name,
        fedDealsCount: f.fedDealsCount,
        totalDeals,
        lift,
        isMegaHub,
        companies: [...f.companies],
        relationshipType: f.relationshipType,
        sourceIds: [...f.sourceIds]
      };
    })
    .sort((a, b) => b.lift - a.lift || b.fedDealsCount - a.fedDealsCount || a.name.localeCompare(b.name));

  const sortedHc = [...entryHeadcounts].sort((a, b) => a - b);
  const lowHc = sortedHc.length ? sortedHc[Math.floor(sortedHc.length * 0.2)] : null;
  const highHc = sortedHc.length ? sortedHc[Math.min(sortedHc.length - 1, Math.floor(sortedHc.length * 0.8))] : null;
  const entryHeadcountBand =
    lowHc === null
      ? 'Not enough rounds'
      : lowHc === highHc
        ? `${lowHc} employees at entry`
        : `${lowHc}-${highHc} employees at entry`;

  if (roundGapsMonths.length < 2) {
    for (const c of COMPANIES) {
      const cRounds = (c.rounds || [])
        .filter((r) => r.date && (!cutoffDate || r.date < cutoffDate))
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      for (let i = 1; i < cRounds.length; i += 1) {
        const gap = monthsBetween(cRounds[i - 1].date, cRounds[i].date);
        if (gap > 0 && gap <= 60) roundGapsMonths.push(Math.round(gap));
      }
    }
  }
  const medianRoundGapMonths = median(roundGapsMonths) ?? 18;

  const timeTravelProfile = {
    medianEntryHeadcount: median(entryHeadcounts),
    entryHeadcountP25: quantile(entryHeadcounts, 0.25),
    entryHeadcountP75: quantile(entryHeadcounts, 0.75),
    entryHeadcountBand,
    medianEntryAgeMonths: median(entryAgeMonthsList),
    medianRoundGapMonths,
    medianPreRoundVelocityPct: median(preRoundVelocities) ?? 0,
    filingVerifiedSharePct: totalEntryDeals > 0 ? Math.round((filingVerifiedDeals / totalEntryDeals) * 100) : 0,
    dealSnapshots: dealSnapshots.slice(0, 8)
  };

  const stageMix = normalizeDistribution(stageBuckets);
  const sectorMix = normalizeDistribution(sectorBuckets);
  const geographyMix = normalizeDistribution(countryBuckets);
  const regionMix = normalizeDistribution(regionBuckets);
  const olderSectors = normalizeDistribution(olderSectorBuckets);
  const recentSectors = normalizeDistribution(recentSectorBuckets);

  let driftSummary = 'Insufficient historical span to compute multi-year thesis drift.';
  if (recentCount > 0 && olderCount > 0) {
    const topRecent = recentSectors[0];
    const oldMatch = olderSectors.find((s) => s.label === topRecent?.label);
    const oldShare = oldMatch ? oldMatch.sharePct : 0;
    const topOld = olderSectors[0];
    if (topRecent && topRecent.sharePct - oldShare >= 15) {
      driftSummary = `Shifting toward ${topRecent.label}: rose from ${oldShare}% in older rounds to ${topRecent.sharePct}% in the last 3 years (2x recency weight).`;
    } else if (topOld && topRecent && topOld.label !== topRecent.label) {
      driftSummary = `Transitioning focus from ${topOld.label} (${topOld.sharePct}% older) toward ${topRecent.label} (${topRecent.sharePct}% in last 3 years).`;
    } else if (topRecent) {
      driftSummary = `Consistent conviction in ${topRecent.label} (${topRecent.sharePct}% of recent deals vs. ${oldShare}% historically).`;
    }
  } else if (recentCount > 0 && sectorMix[0]) {
    driftSummary = `Recent 3-year activity clusters in ${sectorMix[0].label} (${sectorMix[0].sharePct}% weighted share).`;
  }

  const topCoInvestors = Object.values(coInvestorMap)
    .map((ci) => {
      const totalDeals = Math.max(ci.sharedRounds, investorTotalDealsMap[ci.id] || ci.sharedRounds);
      const lift = Math.round((ci.sharedRounds / Math.sqrt(Math.max(1, totalDeals))) * 100) / 100;
      const isMegaHub = totalDeals >= MEGA_HUB_DEAL_THRESHOLD || BROAD_HUB_INVESTOR_IDS.has(ci.id);
      return {
        id: ci.id,
        investorId: ci.id,
        name: ci.name,
        investorName: ci.name,
        sharedRounds: ci.sharedRounds,
        totalDeals,
        lift,
        isMegaHub,
        companies: [...ci.companies],
        sourceIds: [...ci.sourceIds]
      };
    })
    .sort((a, b) => b.sharedRounds - a.sharedRounds || b.lift - a.lift || a.name.localeCompare(b.name));

  let pacePerYear = 0;
  if (dealDates.length >= 2) {
    const oldest = new Date(dealDates[dealDates.length - 1]);
    const newest = new Date(dealDates[0]);
    const years = Math.max(1, (newest.getTime() - oldest.getTime()) / (1000 * 60 * 60 * 24 * 365.25));
    pacePerYear = Math.round((deals.length / years) * 10) / 10;
  } else {
    pacePerYear = deals.length;
  }

  const uniqueCompaniesCount = portfolioCompanyIds.size;
  const followOnCompanies = Object.values(companyRoundCounts).filter((c) => c >= 2).length;
  const followOnRatePct = uniqueCompaniesCount > 0 ? Math.round((followOnCompanies / uniqueCompaniesCount) * 100) : 0;
  const leadRatePct = deals.length > 0 ? Math.round((leadCount / deals.length) * 100) : 0;

  const statedText = options.statedThesisOverride || entity.statedThesis;
  const statedVsRevealed = analyzeStatedVsRevealed(
    statedText,
    sectorMix,
    geographyMix,
    stageMix,
    timeTravelProfile,
    upstreamFeeders
  );

  const portfolioList = [...portfolioCompanyIds]
    .map((id) => COMPANIES.find((c) => c.id === id))
    .filter(Boolean)
    .map((c) => ({
      id: c.id,
      name: c.name,
      sector: c.sector,
      subSectors: c.subSectors || [],
      competitorGroup: c.competitorGroup || null,
      country: c.country,
      region: c.region || null,
      hqCity: c.hqCity || null,
      // A missing round is unknown, not an implicit Seed round.
      latestRoundType: c.rounds[c.rounds.length - 1]?.type || null,
      latestRoundDate: c.rounds[c.rounds.length - 1]?.date || null,
      roundInvestorIds: [...new Set((c.rounds || []).flatMap((r) => [...(r.investorIds || []), r.leadInvestorId].filter(Boolean)))],
      sourceIds: c.rounds.flatMap((r) => r.sourceIds || [])
    }));

  const weakProfile = mode === 'fund' ? deals.length < 5 : uniqueCompaniesCount < 3;

  return {
    mode,
    evalDate,
    fundId: entity.id,
    fundName: entity.name,
    calaEntityId: entity.calaEntityId || null,
    hqCity: entity.hqCity,
    country: entity.country,
    dealsAnalyzedCount: deals.length,
    portfolioCount: uniqueCompaniesCount,
    weakProfile,
    weakProfileNote: weakProfile
      ? `Only ${deals.length} known deals found in Cala (under the 5-deal reliability floor). Add 3 to 5 admired companies to strengthen the profile.`
      : null,
    stageMix,
    sectorMix,
    geographyMix,
    regionMix,
    medianRoundSizeEurM: median(roundAmounts),
    roundSizeLabel: 'Median size of rounds joined (individual cheque size not public in Cala)',
    leadRatePct,
    followOnRatePct,
    pacePerYear,
    lastDealDate: dealDates[0] || null,
    driftSummary,
    statedThesis: statedText,
    statedVsRevealed,
    timeTravelProfile,
    upstreamFeeders,
    topCoInvestors,
    investorTotalDealsMap,
    portfolioCompanyIds: [...portfolioCompanyIds],
    portfolioCompetitorGroups: Object.fromEntries(portfolioCompetitorGroups),
    portfolioCompanies: portfolioList
  };
}

function getWeights(rankingMode) {
  let weights;
  if (rankingMode === 'untapped') {
    weights = { sector: 32, stage: 26, syndicate: 0, momentum: 24, geography: 18 };
  } else if (rankingMode === 'warmest') {
    weights = { sector: 22, stage: 18, syndicate: 35, momentum: 15, geography: 10 };
  } else {
    weights = { sector: 26, stage: 22, syndicate: 20, momentum: 18, geography: 14 };
  }
  Object.defineProperty(weights, 'coInvestor', {
    get() {
      return this.syndicate;
    },
    enumerable: false
  });
  return weights;
}

function buildCoInvestorPath(thesis, company, visibleRounds) {
  const coInvestorLookup = new Map((thesis.topCoInvestors || []).map((ci) => [ci.id, ci]));
  const feederLookup = new Map((thesis.upstreamFeeders || []).map((f) => [f.id, f]));
  let bestPath = null;

  for (const round of visibleRounds) {
    for (const invId of round.investorIds) {
      const ci = coInvestorLookup.get(invId);
      const feeder = feederLookup.get(invId);
      if (!ci && !feeder) continue;
      const isLead = round.leadInvestorId === invId;
      const sharedCount = ci?.sharedRounds || 0;
      const feederCount = feeder?.fedDealsCount || 0;
      const feederLift = feeder?.lift || 0;
      const rankScore = sharedCount * 2 + (feeder ? feederCount + feederLift * 3 : 0) + (isLead ? 1 : 0);
      if (!bestPath || rankScore > bestPath.rankScore) {
        const invName = ci?.name || feeder?.name || PEER_INVESTORS[invId] || invId;
        const sampleCompanies = (ci?.companies || feeder?.companies || []).slice(0, 2);
        const sourceIds = [
          ...new Set([
            ...(ci?.sourceIds || []).slice(0, 1),
            ...(feeder?.sourceIds || []).slice(0, 1),
            ...(round.sourceIds || []).slice(0, 1)
          ])
        ];
        const roundDateLabel = round.date ? String(round.date).slice(0, 7) : 'undated';
        const summary = feeder
          ? `Upstream feeder ${invName} (${feederCount}x Round N-1 feeder${sampleCompanies.length ? `: ${sampleCompanies.join(', ')}` : ''}) ${isLead ? 'led' : 'backed'} ${company.name} ${round.type} (${roundDateLabel}).`
          : `Co-invested with ${invName} ${sharedCount}x (${sampleCompanies.join(', ')}); ${invName} ${isLead ? 'led' : 'joined'} ${company.name} ${round.type} (${roundDateLabel}).`;
        bestPath = {
          rankScore,
          coInvestorId: invId,
          coInvestorName: invName,
          sharedCount,
          feederDealsCount: feederCount,
          feederLift,
          isUpstreamFeeder: Boolean(feeder),
          pathwayType: feeder ? 'feeder_to_lead' : 'same_round_syndicate',
          sharedPortfolioSample: sampleCompanies,
          startupRole: isLead ? 'led' : 'joined',
          roundType: round.type,
          roundDate: round.date,
          sourceIds,
          summary
        };
      }
    }
  }
  return bestPath;
}

const BRIDGE_FAMILY_META = {
  feeder: { id: 'cluster-feeder', label: 'Feeder Bridges', subtitle: 'Funds that feed your benchmark' },
  co_investor: { id: 'cluster-co-investor', label: 'Co-Investor Bridges', subtitle: 'Shared syndicate partners' },
  alumni_spinout: { id: 'cluster-alumni-spinout', label: 'Alumni & Operator Spinouts', subtitle: 'Operator & founder lineage' },
  portfolio_twin: { id: 'cluster-portfolio-twin', label: 'Portfolio Twins & Analogues', subtitle: 'Structural portfolio comps' },
  event: { id: 'cluster-event', label: 'Event & Ecosystem Ties', subtitle: 'Shared event & Slush ties' }
};

const CONTRIBUTION_GROUP_META = {
  access: {
    id: 'contrib-access',
    group: 'access',
    label: 'ACCESS',
    subtitle: 'Warm intro routes, non-mega feeders & syndicate trust'
  },
  lineage: {
    id: 'contrib-lineage',
    group: 'lineage',
    label: 'LINEAGE',
    subtitle: 'Operator DNA, founder spinouts & portfolio twins'
  },
  timing: {
    id: 'contrib-timing',
    group: 'timing',
    label: 'TIMING',
    subtitle: 'Event ties, hiring surges, domain shifts & pre-press filings'
  },
  caution: {
    id: 'contrib-caution',
    group: 'caution',
    label: 'CAUTION',
    subtitle: 'Portfolio conflicts, revealed mega-hubs & press-only flags'
  }
};

export function deriveContributionGroup(bridge = {}) {
  const explicit = bridge?.contributionGroup ? String(bridge.contributionGroup).trim().toLowerCase() : null;
  if (explicit && CONTRIBUTION_GROUP_META[explicit]) {
    return explicit;
  }
  const bType = String(bridge?.bridgeType || '').toLowerCase();
  const labelLower = String(bridge?.label || bridge?.bridgeEntityName || '').toLowerCase();
  if (
    bridge?.isMegaHub ||
    bridge?.catalystKind === 'conflict_risk' ||
    bridge?.catalystKind === 'press_only_warning' ||
    bridge?.catalystKind === 'no_warm_intro' ||
    bType.includes('caution') ||
    labelLower.includes('conflict') ||
    labelLower.includes('overlap') ||
    labelLower.includes('press-only') ||
    labelLower.includes('no warm')
  ) {
    return 'caution';
  }
  const fam = bridge?.bridgeFamily;
  if (
    fam === 'alumni_spinout' ||
    fam === 'portfolio_twin' ||
    bType.includes('employer') ||
    bType.includes('university') ||
    bType.includes('academic') ||
    bType.includes('spinout') ||
    bType.includes('alumni')
  ) {
    return 'lineage';
  }
  if (
    fam === 'event' ||
    bridge?.catalystKind === 'pre_press_filing' ||
    bridge?.catalystKind === 'domain_shift' ||
    bridge?.catalystKind === 'hiring_velocity' ||
    bridge?.catalystKind === 'raise_window' ||
    bType.includes('catalyst') ||
    labelLower.includes('pre-press') ||
    labelLower.includes('hiring') ||
    labelLower.includes('domain') ||
    labelLower.includes('raise') ||
    labelLower.includes('slush')
  ) {
    return 'timing';
  }
  if (fam === 'feeder' || fam === 'co_investor') return 'access';
  return 'access';
}

export function computeContributionClusterWeights(bridgeNodes = [], startupIdsByGroup = null) {
  const byGroup = {
    access: new Map(),
    lineage: new Map(),
    timing: new Map(),
    caution: new Map()
  };

  (bridgeNodes || []).forEach((rawNode, idx) => {
    if (!rawNode || (rawNode.kind && rawNode.kind !== 'bridge')) return;
    const grp = deriveContributionGroup(rawNode);
    if (!byGroup[grp]) return;
    const dedupKey = rawNode.id || `${grp}:${rawNode.bridgeEntityId || rawNode.bridgeEntityName || rawNode.label || idx}`;
    const existing = byGroup[grp].get(dedupKey);
    const rankScore = SOURCE_RANK_PRIORITY[String(rawNode.topSourceRank || '').toUpperCase()] || 1;
    const curRarity = Number(rawNode.rarityScore ?? ((Number(rawNode.lift) || 0.5) * 10));
    if (!existing) {
      byGroup[grp].set(dedupKey, { ...rawNode, _rankScore: rankScore, _effRarity: curRarity });
    } else {
      existing._rankScore = Math.max(existing._rankScore, rankScore);
      existing._effRarity = Math.max(existing._effRarity, curRarity);
      if (rankScore >= existing._rankScore) existing.topSourceRank = rawNode.topSourceRank || existing.topSourceRank;
      existing.isMegaHub = Boolean(existing.isMegaHub && rawNode.isMegaHub);
    }
  });

  const significanceFormula = 'topSignalRarity + mean(top3Bridges) + min(4.5, FILING_count * 1.5)';
  const statsByGroup = {};
  for (const grp of Object.keys(CONTRIBUTION_GROUP_META)) {
    const members = [...byGroup[grp].values()];
    const startupCount = startupIdsByGroup?.[grp]?.size ?? 0;
    if (!members.length) {
      statsByGroup[grp] = {
        group: grp,
        memberCount: 0,
        startupCount,
        topRarity: 0,
        top3MeanRarity: 0,
        filingVerifiedCount: 0,
        filingCount: 0,
        filingBonus: 0,
        significanceScore: 0,
        visualWeight: 0.6,
        significanceFormula,
        significanceInputs: `Top: 0.0 + Top3 avg: 0.0 + 0 FILING (+0.0) = 0.0 pts | ${startupCount} startups connected`,
        topContributors: []
      };
      continue;
    }

    const sortedMembers = [...members].sort(
      (a, b) =>
        (a.isMegaHub ? 1 : 0) - (b.isMegaHub ? 1 : 0) ||
        (Number(b._effRarity) || 0) - (Number(a._effRarity) || 0) ||
        (b._rankScore || 0) - (a._rankScore || 0) ||
        String(a.label || '').localeCompare(String(b.label || ''))
    );

    const rarities = members
      .map((m) => (m.isMegaHub ? 1.0 : Math.max(0, Number(m._effRarity) || 0)))
      .sort((a, b) => b - a);
    const topRarity = rarities[0] || 0;
    const top3Slice = rarities.slice(0, 3);
    const top3MeanRarity = top3Slice.length
      ? top3Slice.reduce((sum, val) => sum + val, 0) / top3Slice.length
      : 0;
    const filingVerifiedCount = members.filter(
      (m) => !m.isMegaHub && String(m.topSourceRank || '').toUpperCase() === 'FILING'
    ).length;
    const filingBonus = Math.min(4.5, filingVerifiedCount * 1.5);
    const significanceScore = Math.round((topRarity + top3MeanRarity + filingBonus) * 100) / 100;
    const topR = Math.round(topRarity * 100) / 100;
    const top3M = Math.round(top3MeanRarity * 100) / 100;
    const filingB = Math.round(filingBonus * 100) / 100;
    const topContributors = sortedMembers.slice(0, 3).map((m) => ({
      id: m.id,
      label: m.label,
      lift: m.lift != null ? Math.round(Number(m.lift) * 100) / 100 : null,
      rarityScore: Math.round((Number(m._effRarity) || 0) * 100) / 100,
      topSourceRank: m.topSourceRank || 'AGGREGATOR',
      bridgeFamily: m.bridgeFamily || null,
      totalDeals: m.totalDeals ?? null
    }));

    statsByGroup[grp] = {
      group: grp,
      memberCount: members.length,
      startupCount,
      topRarity: topR,
      top3MeanRarity: top3M,
      filingVerifiedCount,
      filingCount: filingVerifiedCount,
      filingBonus: filingB,
      significanceScore,
      visualWeight: 0.6,
      significanceFormula,
      significanceInputs: `Top: ${topR.toFixed(1)} + Top3 avg: ${top3M.toFixed(1)} + ${filingVerifiedCount} FILING (+${filingB.toFixed(1)}) = ${significanceScore.toFixed(1)} pts | ${startupCount} ${startupCount === 1 ? 'startup' : 'startups'} connected`,
      topContributors
    };
  }

  const activeScores = Object.values(statsByGroup)
    .filter((s) => s.significanceScore > 0)
    .map((s) => s.significanceScore);

  if (!activeScores.length) {
    for (const s of Object.values(statsByGroup)) {
      s.visualWeight = 1.0;
    }
    return statsByGroup;
  }

  const maxSig = Math.max(...activeScores);
  const minSig = Math.min(...activeScores);
  for (const s of Object.values(statsByGroup)) {
    if (s.significanceScore <= 0) {
      s.visualWeight = 0.6;
    } else if (maxSig <= minSig) {
      s.visualWeight = 1.25;
    } else {
      const ratio = (s.significanceScore - minSig) / (maxSig - minSig);
      const scaled = 0.75 + ratio * (1.65 - 0.75);
      s.visualWeight = Math.round(Math.min(1.65, Math.max(0.6, scaled)) * 100) / 100;
    }
  }
  return statsByGroup;
}

function slugifyBridgeId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'entity';
}

function resolveValidSourceIds(candidateIds = [], visibleRounds = [], company = null) {
  const fallbackIds = [
    ...(visibleRounds || []).flatMap((r) => r.sourceIds || []),
    company?.registryInfo?.sourceId,
    ...(company?.corporateEvents || []).map((ev) => ev.sourceId),
    ...(company?.employeeCountSeries || []).map((pt) => pt.sourceId),
    ...(company?.financialMetrics || []).map((m) => m.sourceId),
    ...(company?.peopleCoverage?.roles || []).map((r) => r.sourceId)
  ];
  const valid = [...new Set([...(candidateIds || []), ...fallbackIds].filter((id) => id && SOURCES[id]))];
  if (valid.length > 0) return valid;
  const anyRoundSrc = (company?.rounds || []).flatMap((r) => r.sourceIds || []).find((id) => id && SOURCES[id]);
  return anyRoundSrc ? [anyRoundSrc] : [];
}

function deriveTopRankFromSources(sourceIds = [], explicitRank = null) {
  const upperExplicit = explicitRank ? String(explicitRank).toUpperCase() : null;
  let bestRank = upperExplicit && SOURCE_RANK_PRIORITY[upperExplicit] ? upperExplicit : 'AGGREGATOR';
  let bestPrio = upperExplicit && SOURCE_RANK_PRIORITY[bestRank] ? SOURCE_RANK_PRIORITY[bestRank] : 0;
  for (const src of resolveSources(sourceIds)) {
    const rank = String(src.sourceRank || 'PRESS').toUpperCase();
    const prio = SOURCE_RANK_PRIORITY[rank] || 1;
    if (prio > bestPrio) {
      bestPrio = prio;
      bestRank = rank;
    }
  }
  return bestRank;
}

function computeBridgeRarityScore(lift, topSourceRank, isMegaHub, extraBonus = 0) {
  const rankBonus = (SOURCE_RANK_PRIORITY[topSourceRank] || 1) * 1.25;
  const megaPenalty = isMegaHub ? 50 : 0;
  return Math.round(((Number(lift) || 0) * 10 + rankBonus + extraBonus - megaPenalty) * 100) / 100;
}

function buildBridgeFormulaBreakdown({
  kind,
  anchorLabel = 'Benchmark Fund',
  entityName = '',
  sharedCount = 1,
  totalDeals = null,
  lift = 1,
  topSourceRank = 'PRIMARY',
  isMegaHub = false,
  isLead = false,
  extraBonus = 0,
  sampleCompany = null,
  intermediaryName = null,
  isSameRound = false,
  relatedStartupName = null,
  personName = null,
  priorCompany = null,
  priorRole = null,
  priorValidUntil = null,
  currentRole = null,
  targetName = '',
  twinName = null,
  simScore = null,
  twinReasons = null,
  eventDate = null,
  operatorDesc = null
}) {
  const rankBonus = Math.round(((SOURCE_RANK_PRIORITY[topSourceRank] || 1) * 1.25) * 100) / 100;
  const megaPart = isMegaHub ? '; mega-hub suppression (-50)' : '';
  const leadPart = kind === 'feeder' || kind === 'co_investor' ? `; ${isLead ? 'Lead round' : 'Syndicate'} (+${extraBonus.toFixed(1)})` : '';
  const dealRoot = totalDeals ? Math.sqrt(Math.max(1, totalDeals)).toFixed(2) : null;

  if (kind === 'feeder') {
    return {
      formula: 'fedDeals / sqrt(totalDealsByBridge) = lift; rarity = lift * 10 + sourceRankBonus + roleBonus',
      inputs: `${sharedCount} N-1 fed deals (${sampleCompany || anchorLabel}) / sqrt(${totalDeals} total deals = ${dealRoot}) = ${lift}x lift; ${topSourceRank} rank (+${rankBonus})${leadPart}${megaPart}`,
      plainMeaning: 'Surfaces focused boutique feeders over mega-funds that invest in everything.'
    };
  }
  if (kind === 'mega_hub') {
    return {
      formula: '1 / sqrt(totalDealsByBridge) = lift; rarity = lift * 10 + sourceRankBonus - 50 (suppressed mega-hub)',
      inputs: `${totalDeals} indexed deals by ${entityName} -> 1 / sqrt(${totalDeals} = ${dealRoot}) = ${lift}x lift; ${topSourceRank} rank (+${rankBonus}); mega-hub (-50)`,
      plainMeaning: `Broad mega-fund/syndicate (>= ${MEGA_HUB_DEAL_THRESHOLD} deals); hidden by default so rare paths stay legible.`
    };
  }
  if (kind === 'co_investor') {
    return {
      formula: 'sharedDeals / sqrt(totalDealsByBridge) = lift; rarity = lift * 10 + sourceRankBonus + roleBonus',
      inputs: `${sharedCount} shared with ${anchorLabel}${sampleCompany ? ` (${sampleCompany})` : ''} / sqrt(${totalDeals} total deals = ${dealRoot}) = ${lift}x lift; ${topSourceRank} rank (+${rankBonus})${leadPart}${megaPart}`,
      plainMeaning: `Ranks non-obvious co-investors who repeatedly share deals with ${anchorLabel} without spraying the market.`
    };
  }
  if (kind === '2hop_syndicate') {
    return {
      formula: '1.25 / sqrt(0.5 * totalDealsB) = lift; chainScore = syndicateOverlap + rarityBonus + directLift',
      inputs: `${intermediaryName} + ${entityName} (${totalDeals} total deals) on ${sampleCompany} (${isSameRound ? 'same round' : 'consecutive rounds'}) -> ${lift}x lift; ${topSourceRank} rank (+${rankBonus})${megaPart}`,
      plainMeaning: `Traces a 2-hop co-investment chain via ${sampleCompany} when ${anchorLabel} has no direct deal with ${entityName}.`
    };
  }
  if (kind === 'bidirectional_alumni') {
    return {
      formula: 'Bidirectional lineage lift (1.95x) + sourceRankBonus (+6.4 cross-company weight)',
      inputs: `${personName}: ${priorRole || 'leadership'} at ${priorCompany} -> ${currentRole || 'leadership'} at ${relatedStartupName}; ${lift}x lift; ${topSourceRank} rank (+${rankBonus})`,
      plainMeaning: 'Verified executive move between two indexed startups enabling direct operator backchanneling.'
    };
  }
  if (kind === 'alumni_spinout') {
    return {
      formula: `Alumni lineage lift (${lift}x) + sourceRankBonus`,
      inputs: `${personName} (${priorRole} at ${priorCompany}${priorValidUntil ? ` until ${priorValidUntil}` : ''} -> ${currentRole} at ${targetName}); ${lift}x lift; ${topSourceRank} rank (+${rankBonus})`,
      plainMeaning: `Founder or operator built verifiable tenure inside ${priorCompany} before launching/joining ${targetName}.`
    };
  }
  if (kind === 'portfolio_twin') {
    return {
      formula: '1.55 + min(1.4, (simScore - 5) * 0.22) = lift (sector +4, geo +1.5..2.5, subSector +2..4)',
      inputs: `Similarity ${(simScore ?? 0).toFixed(1)} vs. ${twinName} (${(twinReasons || []).join(', ') || 'structural fit'}) -> ${lift}x lift; ${topSourceRank} rank (+${rankBonus})`,
      plainMeaning: `Structural portfolio analogue in ${anchorLabel} matched by sector, sub-sector, and geography.`
    };
  }
  if (kind === 'person_bridge') {
    return {
      formula: `Direct human/founder tie (${lift}x lift) + sourceRankBonus`,
      inputs: `${personName} (${currentRole || 'Leader / Backer'} at ${targetName}) -> ${lift}x lift; ${topSourceRank} rank (+${rankBonus})`,
      plainMeaning: `Direct Cala leadership, board, control-person, or angel link via ${personName} to ${targetName}.`
    };
  }
  if (kind === 'live_investor') {
    return {
      formula: `Live Cala investor tie (${lift}x lift) + sourceRankBonus`,
      inputs: `${entityName} indexed on ${targetName} in Cala graph -> ${lift}x lift; ${topSourceRank} rank (+${rankBonus})`,
      plainMeaning: `Cala Organization investment relationship connecting ${entityName} to ${targetName}.`
    };
  }
  return {
    formula: `Event participation lift (${lift}x base) + sourceRankBonus`,
    inputs: `${targetName} verified at ${entityName}${eventDate ? ` (${String(eventDate).slice(0, 7)})` : ''}; ${lift}x lift; ${topSourceRank} rank (+${rankBonus})`,
    plainMeaning: 'Shared conference or ecosystem presence creating an immediate in-person meeting opportunity.'
  };
}

function computeSignalTier({ bridges = [], dataConfidence = null, urgencyTriggers = [], suitabilityScore = 0 } = {}) {
  const nonMegaCount = (bridges || []).filter((b) => !b.isMegaHub).length;
  const rank = dataConfidence?.topSourceRank || 'AGGREGATOR';
  const highTrust = rank === 'FILING' || rank === 'PRIMARY';
  if (nonMegaCount > 0 && highTrust && ((urgencyTriggers || []).length > 0 || suitabilityScore >= 60)) {
    return 'High-Signal Match';
  }
  if (nonMegaCount > 0 || (highTrust && suitabilityScore >= 45)) {
    return 'Contextual Match';
  }
  return 'Sparse / Baseline';
}

function buildMatchOrderFormula(scoreBreakdown = null, totalScore = 0, rankingMode = 'balanced', dataConfidence = null, nonMegaCount = 0) {
  if (!scoreBreakdown) return 'Match order derived from verified Cala sector, bridge, and activity records.';
  const buckets = [
    ['Sector', scoreBreakdown.sector?.earned ?? 0, scoreBreakdown.sector?.max ?? 25],
    ['Stage', scoreBreakdown.stage?.earned ?? 0, scoreBreakdown.stage?.max ?? 25],
    ['Syndicate', scoreBreakdown.syndicate?.earned ?? 0, scoreBreakdown.syndicate?.max ?? 20],
    ['Momentum', scoreBreakdown.momentum?.earned ?? 0, scoreBreakdown.momentum?.max ?? 15],
    ['Geo', scoreBreakdown.geography?.earned ?? 0, scoreBreakdown.geography?.max ?? 10],
    ['Timing/Filing', scoreBreakdown.arbitrageBonus?.earned ?? 0, scoreBreakdown.arbitrageBonus?.max ?? 5]
  ];
  const criteriaMet = buckets.filter(([, earned]) => earned > 0).length;
  const parts = buckets.map(([label, earned, max]) => `${label} ${earned}/${max}`);
  const rank = dataConfidence?.topSourceRank || 'AGGREGATOR';
  return `Criteria ${criteriaMet}/${buckets.length} | Rank Score: ${totalScore}/99 = ${parts.join(' + ')} (${rankingMode}; ${nonMegaCount} non-mega bridges; ${rank} top proof)`;
}

function buildGlobalRoundIndex(evalDate = null) {
  const investorTotalDeals = {};
  const investorDeals = new Map();
  const companyRounds = [];
  const reverseAlumniByScaleupName = new Map();
  const peersByPriorScaleup = new Map();

  for (const c of COMPANIES) {
    if (evalDate && c.isLiveCalaDiscovered) continue;
    const compRounds = (c.rounds || [])
      .filter((r) => !evalDate || (r.date && r.date < evalDate))
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    companyRounds.push({ company: c, rounds: compRounds });

    for (const r of compRounds) {
      const roundInvs = new Set([...(r.investorIds || []), r.leadInvestorId].filter(Boolean));
      for (const invId of roundInvs) {
        investorTotalDeals[invId] = (investorTotalDeals[invId] || 0) + 1;
        if (!investorDeals.has(invId)) investorDeals.set(invId, []);
        investorDeals.get(invId).push({ company: c, round: r });
      }
    }

    for (const role of c.peopleCoverage?.roles || []) {
      if (!role?.priorCompany) continue;
      const key = normalizeLookupName(role.priorCompany);
      if (!key) continue;
      if (!reverseAlumniByScaleupName.has(key)) reverseAlumniByScaleupName.set(key, []);
      reverseAlumniByScaleupName.get(key).push({ targetCompany: c, role });
      if (!peersByPriorScaleup.has(key)) peersByPriorScaleup.set(key, []);
      peersByPriorScaleup.get(key).push({ company: c, label: role.priorCompany, sourceId: role.sourceId });
    }
  }

  return {
    investorTotalDeals,
    investorDeals,
    companyRounds,
    reverseAlumniByScaleupName,
    peersByPriorScaleup
  };
}

function extractTwoHopSyndicateBridges(thesis, company, visibleRounds, globalIndex) {
  const results = [];
  if (!thesis || !visibleRounds?.length) return results;

  const directInvestors = new Map();
  for (const f of thesis.upstreamFeeders || []) {
    const id = f.id || f.investorId;
    if (id) directInvestors.set(id, { ...f, id, kind: 'feeder' });
  }
  for (const ci of thesis.topCoInvestors || []) {
    const id = ci.id || ci.investorId;
    if (id && !directInvestors.has(id)) {
      directInvestors.set(id, { ...ci, id, kind: 'co_investor' });
    }
  }

  const companyRoundByInv = new Map();
  for (const r of visibleRounds) {
    const invs = new Set([...(r.investorIds || []), r.leadInvestorId].filter(Boolean));
    for (const invId of invs) {
      if (invId === thesis.fundId || BROAD_HUB_INVESTOR_IDS.has(invId) || directInvestors.has(invId)) continue;
      if (!companyRoundByInv.has(invId)) companyRoundByInv.set(invId, r);
    }
  }

  for (const [invB, targetRound] of companyRoundByInv.entries()) {
    const invBName = PEER_INVESTORS[invB] || invB;
    const invBDeals = globalIndex.investorDeals.get(invB) || [];
    let bestChain = null;

    for (const { company: midComp, round: midRound } of invBDeals) {
      if (!midComp || midComp.id === company.id) continue;
      const midEntry = globalIndex.companyRounds.find((entry) => entry.company.id === midComp.id);
      const midAllInvs = new Set(
        (midEntry?.rounds || []).flatMap((r) => [...(r.investorIds || []), r.leadInvestorId].filter(Boolean))
      );
      const sameRoundInvs = new Set([...(midRound.investorIds || []), midRound.leadInvestorId].filter(Boolean));

      for (const invA of midAllInvs) {
        const directMeta = directInvestors.get(invA);
        if (!directMeta) continue;
        const isSameRound = sameRoundInvs.has(invA);
        const directIsMega = Boolean(directMeta.isMegaHub);
        const totalDealsB = Math.max(1, globalIndex.investorTotalDeals[invB] || 1);
        const isMegaB = totalDealsB >= MEGA_HUB_DEAL_THRESHOLD || BROAD_HUB_INVESTOR_IDS.has(invB);
        const chainScore =
          (isSameRound ? 3 : 1.5) +
          (directIsMega ? -4 : 2.5) +
          (isMegaB ? -4 : 2.5) +
          (directMeta.lift || 0.5);
        if (!bestChain || chainScore > bestChain.chainScore) {
          bestChain = {
            invA,
            directMeta,
            midComp,
            midRound,
            isSameRound,
            totalDealsB,
            isMegaB,
            chainScore
          };
        }
      }
    }

    if (!bestChain) continue;
    const invAName = bestChain.directMeta.name || PEER_INVESTORS[bestChain.invA] || bestChain.invA;
    const sourceIds = resolveValidSourceIds(
      [...(targetRound.sourceIds || []), ...(bestChain.midRound.sourceIds || [])],
      visibleRounds,
      company
    );
    const topSourceRank = deriveTopRankFromSources(sourceIds);
    const fam = bestChain.directMeta.kind === 'feeder' ? 'feeder' : 'co_investor';
    const lift = Math.round((1.25 / Math.sqrt(Math.max(1, bestChain.totalDealsB * 0.5))) * 100) / 100;
    const anchorExample = (bestChain.directMeta.companies || [])[0];
    const invAStep = anchorExample ? `${invAName} (${anchorExample})` : invAName;

    results.push({
      id: `bridge-2hop-${bestChain.invA}-${invB}-${company.id}`,
      bridgeFamily: fam,
      hopKind: '2hop_syndicate',
      bridgeEntityId: invB,
      bridgeEntityName: `${invBName} (via ${invAName})`,
      intermediaryInvestor: invAName,
      intermediaryCompany: bestChain.midComp.name,
      isMegaHub: bestChain.isMegaB,
      totalDeals: bestChain.totalDealsB,
      lift,
      rarityScore: computeBridgeRarityScore(lift, topSourceRank, bestChain.isMegaB, 5.5),
      hops: [thesis.fundName, invAStep, `${invBName} (on ${bestChain.midComp.name})`, company.name],
      date: targetRound.date || bestChain.midRound.date || null,
      topSourceRank,
      sourceIds,
      formulaBreakdown: buildBridgeFormulaBreakdown({
        kind: '2hop_syndicate',
        anchorLabel: thesis?.fundName || 'Anchor Fund',
        entityName: invBName,
        intermediaryName: invAName,
        sampleCompany: bestChain.midComp.name,
        totalDeals: bestChain.totalDealsB,
        lift,
        topSourceRank,
        isMegaHub: bestChain.isMegaB,
        isSameRound: bestChain.isSameRound
      }),
      whyMatters: `${invAName} and ${invBName} ${bestChain.isSameRound ? 'co-invested' : 'syndicated'} on ${bestChain.midComp.name}, creating a warm 2-hop syndicate bridge into ${company.name}.`,
      summary: `2-hop syndicate via ${invAName} (${bestChain.midComp.name}): ${invBName} backs ${company.name}'s ${targetRound.type} round.`
    });
  }

  return results;
}

function extractBidirectionalAlumniBridges(thesis, company, visibleRounds, globalIndex, signals) {
  const results = [];
  const companyNorm = normalizeLookupName(company.name);

  // 1. Reverse alumni lineage: target company (e.g. Pleo) spun out a founder now leading another European startup (e.g. VeloPay)
  const reverseMatches = globalIndex.reverseAlumniByScaleupName.get(companyNorm) || [];
  for (const { targetCompany, role } of reverseMatches) {
    if (!targetCompany || targetCompany.id === company.id) continue;
    const sourceIds = resolveValidSourceIds(
      [role.sourceId, ...(targetCompany.rounds || []).flatMap((r) => r.sourceIds || [])],
      visibleRounds,
      company
    );
    const topSourceRank = deriveTopRankFromSources(sourceIds, role.sourceRank || 'FILING');
    const lift = 1.95;
    results.push({
      id: `bridge-alumni-bi-${company.id}-${targetCompany.id}`,
      bridgeFamily: 'alumni_spinout',
      hopKind: 'bidirectional_alumni',
      bridgeEntityId: `alumni-bi-${slugifyBridgeId(company.name + '-' + targetCompany.name)}`,
      bridgeEntityName: `${company.name} -> ${targetCompany.name} Spinout`,
      relatedStartupId: targetCompany.id,
      relatedStartupName: targetCompany.name,
      isMegaHub: false,
      totalDeals: null,
      verifiedAnchorConnection: (thesis?.portfolioCompanyIds || []).includes(targetCompany.id),
      lift,
      rarityScore: computeBridgeRarityScore(lift, topSourceRank, false, 6.4),
      hops: [thesis.fundName, `${role.name} (${company.name} alumni)`, targetCompany.name],
      date: role.validSince || role.priorValidUntil || null,
      topSourceRank,
      sourceIds,
      formulaBreakdown: buildBridgeFormulaBreakdown({
        kind: 'bidirectional_alumni',
        anchorLabel: thesis?.fundName || 'Anchor Fund',
        entityName: `${company.name} -> ${targetCompany.name} Spinout`,
        personName: role.name,
        priorRole: role.priorRole,
        priorCompany: company.name,
        currentRole: role.role,
        relatedStartupName: targetCompany.name,
        lift,
        topSourceRank
      }),
      whyMatters: `Bidirectional alumni tie: ${role.name} transitioned from ${role.priorRole || 'leadership'} at ${company.name} to lead ${targetCompany.name}, enabling operator backchanneling across both startups.`,
      summary: `Bidirectional lineage: ${role.name} left ${company.name} to become ${role.role} at ${targetCompany.name} (${targetCompany.sector}).`
    });
  }

  return results;
}

function extractPortfolioTwinBridges(thesis, company, visibleRounds, signals) {
  const portfolioList = thesis?.portfolioCompanies || [];
  if (!portfolioList.length) return [];

  const companySubs = new Set((company.subSectors || []).map((s) => String(s).toLowerCase()));
  let bestTwin = null;

  for (const p of portfolioList) {
    if (!p || p.id === company.id) continue;
    const fullTwin = COMPANIES.find((c) => c.id === p.id) || p;
    let simScore = 0;
    const reasons = [];

    if (fullTwin.sector && fullTwin.sector === company.sector) {
      simScore += 4.0;
      reasons.push(`same ${company.sector} thesis`);
    }
    if (fullTwin.country && fullTwin.country === company.country) {
      simScore += 2.5;
      reasons.push(`${company.country} ecosystem`);
    } else if (fullTwin.region && fullTwin.region === company.region) {
      simScore += 1.5;
      reasons.push(`${company.region} overlap`);
    }

    const twinSubs = (fullTwin.subSectors || []).filter((s) => companySubs.has(String(s).toLowerCase()));
    if (twinSubs.length > 0) {
      simScore += Math.min(4, twinSubs.length * 2.0);
      reasons.push(`shared focus (${twinSubs.slice(0, 2).join(', ')})`);
    }

    if (simScore < 5.5) continue;
    if (!bestTwin || simScore > bestTwin.simScore) {
      bestTwin = { fullTwin, simScore, reasons };
    }
  }

  if (!bestTwin) return [];
  const { fullTwin, simScore, reasons } = bestTwin;
  const twinLatestStage = fullTwin.rounds?.[fullTwin.rounds.length - 1]?.type || fullTwin.latestRoundType || 'Not found in Cala';
  const companyStage = visibleRounds?.[visibleRounds.length - 1]?.type || company.stage || 'Not found in Cala';
  const growthPct = signals?.headcountGrowthPct;
  const hasUnannounced = Boolean(signals?.visibleCorpEvents?.some((e) => e.unannouncedFiling));

  let whyLookDelta = `Earlier ${companyStage} entry window vs. ${fullTwin.name} (${twinLatestStage})`;
  if (hasUnannounced) {
    whyLookDelta = `Pre-press statutory filing on ${company.name} ahead of comparable ${fullTwin.name} (${twinLatestStage}) comps`;
  } else if (growthPct !== null && growthPct !== undefined && growthPct >= 35) {
    whyLookDelta = `+${growthPct}% post-round hiring velocity at ${companyStage} vs. ${fullTwin.name} benchmark`;
  } else if (fullTwin.country !== company.country) {
    whyLookDelta = `${company.country} geographic analogue mirroring ${fullTwin.name} (${fullTwin.country})`;
  }

  const sourceIds = resolveValidSourceIds(
    [...(fullTwin.rounds || []).flatMap((r) => r.sourceIds || []).slice(0, 1)],
    visibleRounds,
    company
  );
  const topSourceRank = deriveTopRankFromSources(sourceIds, 'PRIMARY');
  const lift = Math.round((1.55 + Math.min(1.4, (simScore - 5) * 0.22)) * 100) / 100;

  return [{
    id: `bridge-twin-${fullTwin.id}-${company.id}`,
    bridgeFamily: 'portfolio_twin',
    hopKind: 'portfolio_twin',
    bridgeEntityId: `twin-${fullTwin.id}`,
    bridgeEntityName: `Twin: ${fullTwin.name}`,
    twinCompanyId: fullTwin.id,
    twinCompanyName: fullTwin.name,
    whyLookDelta,
    isMegaHub: false,
    totalDeals: null,
    lift,
    rarityScore: computeBridgeRarityScore(lift, topSourceRank, false, 4.8),
    hops: [thesis.fundName, `Portfolio: ${fullTwin.name}`, company.name],
    date: visibleRounds?.[visibleRounds.length - 1]?.date || null,
    topSourceRank,
    sourceIds,
    formulaBreakdown: buildBridgeFormulaBreakdown({
      kind: 'portfolio_twin',
      anchorLabel: thesis?.fundName || 'Anchor Fund',
      entityName: `Twin: ${fullTwin.name}`,
      twinName: fullTwin.name,
      simScore,
      twinReasons: reasons,
      lift,
      topSourceRank
    }),
    whyMatters: `Matches ${thesis.fundName} portfolio company ${fullTwin.name} via ${reasons.join(' + ')}. ${whyLookDelta}.`,
    summary: `Nearest twin to portfolio company ${fullTwin.name} (${reasons.join(' · ')}). ${whyLookDelta}.`
  }];
}

function buildPeerEdgesForShortlist(displayed = [], globalIndex = null) {
  const index = globalIndex || buildGlobalRoundIndex(null);
  const rawById = new Map();
  for (const item of displayed) {
    rawById.set(item.id, COMPANIES.find((c) => c.id === item.id) || item);
  }

  const candidates = [];
  for (let i = 0; i < displayed.length; i += 1) {
    for (let j = i + 1; j < displayed.length; j += 1) {
      const a = displayed[i];
      const b = displayed[j];
      const rawA = rawById.get(a.id);
      const rawB = rawById.get(b.id);
      if (!rawA || !rawB) continue;

      const rolesA = rawA.peopleCoverage?.roles || [];
      const rolesB = rawB.peopleCoverage?.roles || [];
      const priorsA = new Set(rolesA.map((r) => normalizeLookupName(r.priorCompany)).filter(Boolean));
      const priorsB = new Set(rolesB.map((r) => normalizeLookupName(r.priorCompany)).filter(Boolean));

      const sharedPrior = [...priorsA].find((p) => priorsB.has(p));
      const biAtoB = priorsB.has(normalizeLookupName(rawA.name));
      const biBtoA = priorsA.has(normalizeLookupName(rawB.name));

      const invsA = new Set((rawA.rounds || []).flatMap((r) => [...(r.investorIds || []), r.leadInvestorId].filter(Boolean)));
      const invsB = new Set((rawB.rounds || []).flatMap((r) => [...(r.investorIds || []), r.leadInvestorId].filter(Boolean)));
      const liveInvsA = new Set((rawA.liveInvestorNames || []).map(normalizeLookupName).filter(Boolean));
      const liveInvsB = new Set((rawB.liveInvestorNames || []).map(normalizeLookupName).filter(Boolean));
      const sharedLiveInvestor = [...liveInvsA].find((name) => liveInvsB.has(name));
      const peopleA = new Set(rolesA.map((r) => normalizeLookupName(r.name)).filter(Boolean));
      const peopleB = new Set(rolesB.map((r) => normalizeLookupName(r.name)).filter(Boolean));
      const sharedPerson = [...peopleA].find((name) => peopleB.has(name));
      const sharedNonMegaInvs = [...invsA]
        .filter((invId) => {
          if (!invsB.has(invId) || BROAD_HUB_INVESTOR_IDS.has(invId)) return false;
          const total = index.investorTotalDeals[invId] || 1;
          return total < MEGA_HUB_DEAL_THRESHOLD;
        })
        .sort((x, y) => (index.investorTotalDeals[x] || 99) - (index.investorTotalDeals[y] || 99));

      const sameSector = rawA.sector && rawA.sector === rawB.sector;
      const bothSlush = Boolean(rawA.attendingSlush2026 && rawB.attendingSlush2026);
      const bothFiling = String(a.dataConfidence?.topSourceRank || '').toUpperCase() === 'FILING'
        && String(b.dataConfidence?.topSourceRank || '').toUpperCase() === 'FILING';

      let chosen = null;
      if (biAtoB || biBtoA) {
        const srcCo = biAtoB ? rawA : rawB;
        const dstCo = biAtoB ? rawB : rawA;
        const role = (dstCo.peopleCoverage?.roles || []).find((r) => normalizeLookupName(r.priorCompany) === normalizeLookupName(srcCo.name));
        chosen = {
          kind: 'shared_alumni',
          strength: 3,
          label: `${srcCo.name} Alumni -> ${dstCo.name}`,
          reason: `${role?.name || 'Operator'} spun out of ${srcCo.name} to lead ${dstCo.name}.`,
          sourceIds: resolveValidSourceIds([role?.sourceId], [...(rawA.rounds || []), ...(rawB.rounds || [])], rawA)
        };
      } else if (sharedPrior) {
        const displayPrior = rolesA.find((r) => normalizeLookupName(r.priorCompany) === sharedPrior)?.priorCompany || sharedPrior;
        chosen = {
          kind: 'shared_alumni',
          strength: 2.8,
          label: `Both Ex-${displayPrior}`,
          reason: `Leadership teams at both ${rawA.name} and ${rawB.name} originated at ${displayPrior}.`,
          sourceIds: resolveValidSourceIds([], [...(rawA.rounds || []), ...(rawB.rounds || [])], rawA)
        };
      } else if (sharedNonMegaInvs.length > 0) {
        const bestInv = sharedNonMegaInvs[0];
        const invName = PEER_INVESTORS[bestInv] || bestInv;
        const total = index.investorTotalDeals[bestInv] || 1;
        chosen = {
          kind: 'shared_investor',
          strength: 2.4 + Math.max(0, 14 - total) * 0.1,
          label: `Shared: ${invName} (${total}d)`,
          reason: `${invName} (${total} indexed deals) backs both ${rawA.name} and ${rawB.name}.`,
          sourceIds: resolveValidSourceIds([], [...(rawA.rounds || []), ...(rawB.rounds || [])], rawA)
        };
      } else if (sharedLiveInvestor) {
        const displayName = (rawA.liveInvestorNames || []).find((name) => normalizeLookupName(name) === sharedLiveInvestor) || sharedLiveInvestor;
        chosen = {
          kind: 'shared_investor',
          strength: 2.1,
          label: `Shared Cala investor: ${displayName}`,
          reason: `${displayName} is listed in Cala as an investor in both ${rawA.name} and ${rawB.name}.`,
          sourceIds: resolveValidSourceIds([], [...(rawA.rounds || []), ...(rawB.rounds || [])], rawA)
        };
      } else if (sharedPerson) {
        const personRole = rolesA.find((role) => normalizeLookupName(role.name) === sharedPerson);
        const displayName = personRole?.name || sharedPerson;
        chosen = {
          kind: 'shared_person',
          strength: 2.0,
          label: `Shared Cala person: ${displayName}`,
          reason: `${displayName} has a verified Cala role connected to both ${rawA.name} and ${rawB.name}.`,
          sourceIds: resolveValidSourceIds([personRole?.sourceId], [...(rawA.rounds || []), ...(rawB.rounds || [])], rawA)
        };
      } else if (sameSector && (bothSlush || bothFiling)) {
        const catLabel = bothSlush && bothFiling ? 'Slush + Filing Peers' : bothSlush ? 'Slush Peers' : 'Filing Peers';
        chosen = {
          kind: 'peer_catalyst',
          strength: bothSlush && bothFiling ? 2.0 : 1.5,
          label: `${rawA.sector} · ${catLabel}`,
          reason: `Direct ${rawA.sector} peers (${rawA.country}/${rawB.country}) sharing ${bothSlush ? 'Slush 2026 cohort' : 'FILING provenance'}.`,
          sourceIds: resolveValidSourceIds([], [...(rawA.rounds || []), ...(rawB.rounds || [])], rawA)
        };
      }

      if (chosen) {
        candidates.push({
          id: `peer:${a.id}:${b.id}`,
          from: a.id,
          to: b.id,
          ...chosen
        });
      }
    }
  }

  // Keep top peer edges sorted by strength while capping per-node degree <= 2 so Hop 2 stays crisp
  candidates.sort((x, y) => y.strength - x.strength || x.id.localeCompare(y.id));
  const degreeMap = new Map();
  const selected = [];
  for (const edge of candidates) {
    const da = degreeMap.get(edge.from) || 0;
    const db = degreeMap.get(edge.to) || 0;
    if (da >= 2 || db >= 2) continue;
    degreeMap.set(edge.from, da + 1);
    degreeMap.set(edge.to, db + 1);
    selected.push(edge);
    if (selected.length >= 16) break;
  }
  return selected;
}

export function extractHiddenBridges(thesis, company, visibleRounds = [], signals = null, options = {}) {
  const {
    hideMegaHubs = true,
    bridgeFamily = null,
    contributionGroup = null,
    filingOnly = false,
    maxPaths = 5
  } = options || {};

  const normalizedFamily = bridgeFamily && bridgeFamily !== 'all' ? String(bridgeFamily).trim().toLowerCase() : null;
  const rawContrib = contributionGroup && contributionGroup !== 'all' ? String(contributionGroup).trim().toLowerCase() : null;
  const normalizedContrib = rawContrib && CONTRIBUTION_GROUP_META[rawContrib] ? rawContrib : null;
  const rounds = [...(visibleRounds || [])];
  const anchorId = thesis?.fundId || 'query-anchor';
  const anchorLabel = thesis?.fundName || 'Search Strategy Anchor';
  const targetStartupId = company?.id || 'startup';
  const targetStartupName = company?.name || 'Target Startup';

  const feederLookup = new Map((thesis?.upstreamFeeders || []).map((f) => [f.id, f]));
  const coInvestorLookup = new Map((thesis?.topCoInvestors || []).map((ci) => [ci.id, ci]));
  const totalDealsMap = thesis?.investorTotalDealsMap || {};
  const portfolioCompanyNames = new Set(
    (thesis?.portfolioCompanies || []).map((p) => String(p.name || '').toLowerCase()).filter(Boolean)
  );

  const bridgeMap = new Map();
  const registerBridge = (candidate) => {
    const hops = candidate?.verifiedAnchorConnection === false
      ? (candidate.hops || []).filter((hop) => hop?.id !== anchorId && hop?.kind !== 'anchor')
      : candidate.hops;
    const tagged = {
      ...candidate,
      hops,
      contributionGroup: deriveContributionGroup(candidate)
    };
    const dedupKey = `${tagged.bridgeFamily}::${String(tagged.bridgeEntityId || tagged.bridgeEntityName).toLowerCase()}`;
    const existing = bridgeMap.get(dedupKey);
    if (!existing) {
      bridgeMap.set(dedupKey, tagged);
      return;
    }
    const mergedSourceIds = [...new Set([...(existing.sourceIds || []), ...(tagged.sourceIds || [])])];
    const mergedRank = deriveTopRankFromSources(
      mergedSourceIds,
      (SOURCE_RANK_PRIORITY[tagged.topSourceRank] || 0) >= (SOURCE_RANK_PRIORITY[existing.topSourceRank] || 0)
        ? tagged.topSourceRank
        : existing.topSourceRank
    );
    const winner = tagged.rarityScore > existing.rarityScore ? tagged : existing;
    bridgeMap.set(dedupKey, {
      ...winner,
      contributionGroup: deriveContributionGroup(winner),
      sourceIds: mergedSourceIds,
      topSourceRank: mergedRank
    });
  };

  // 1 & 2. Feeder & Co-Investor investor bridges from visible rounds
  for (const round of rounds) {
    for (const invId of round.investorIds || []) {
      const feeder = feederLookup.get(invId);
      const coInv = coInvestorLookup.get(invId);
      const isLead = round.leadInvestorId === invId;
      const invDisplayName = feeder?.name || coInv?.name || PEER_INVESTORS[invId] || invId;

      if (feeder) {
        const totalDeals = feeder.totalDeals ?? Math.max(feeder.fedDealsCount || 1, totalDealsMap[invId] || 1);
        const lift =
          feeder.lift ??
          Math.round(((feeder.fedDealsCount || 1) / Math.sqrt(Math.max(1, totalDeals))) * 100) / 100;
        const isMegaHub = Boolean(feeder.isMegaHub ?? (totalDeals >= MEGA_HUB_DEAL_THRESHOLD || BROAD_HUB_INVESTOR_IDS.has(feeder.id || feeder.investorId)));
        const sourceIds = resolveValidSourceIds(
          [...(feeder.sourceIds || []).slice(0, 2), ...(round.sourceIds || [])],
          rounds,
          company
        );
        const topSourceRank = deriveTopRankFromSources(sourceIds);
        const sampleCo = (feeder.companies || [])[0] || null;
        const hops = [
          { id: anchorId, label: anchorLabel, role: 'Query Anchor', kind: 'anchor', date: null },
          {
            id: `inv-${invId}`,
            label: invDisplayName,
            role: `Upstream Feeder (${feeder.fedDealsCount}x N-1, ${totalDeals} deals)`,
            kind: 'bridge',
            date: round.date || null
          },
          ...(sampleCo
            ? [
                {
                  id: `co-${slugifyBridgeId(sampleCo)}`,
                  label: sampleCo,
                  role: 'Shared Portfolio Step',
                  kind: 'intermediate',
                  date: null
                }
              ]
            : []),
          {
            id: targetStartupId,
            label: targetStartupName,
            role: `${isLead ? 'Led' : 'Joined'} ${round.type}`,
            kind: 'startup',
            date: round.date || null
          }
        ];

        registerBridge({
          id: `bridge-feeder-${slugifyBridgeId(invId)}-${targetStartupId}`,
          bridgeFamily: 'feeder',
          bridgeEntityId: `inv-${invId}`,
          bridgeEntityName: invDisplayName,
          hops,
          totalDeals,
          lift,
          isMegaHub,
          topSourceRank,
          sourceIds,
          date: round.date || null,
          rarityScore: computeBridgeRarityScore(lift, topSourceRank, isMegaHub, isMegaHub ? 0 : (isLead ? 3.8 : 3.2)),
          formulaBreakdown: buildBridgeFormulaBreakdown({
            kind: 'feeder',
            anchorLabel,
            entityName: invDisplayName,
            sharedCount: feeder.fedDealsCount || 1,
            totalDeals,
            lift,
            topSourceRank,
            isMegaHub,
            isLead,
            extraBonus: isMegaHub ? 0 : (isLead ? 3.8 : 3.2),
            sampleCompany: sampleCo
          }),
          summary: `Upstream feeder ${invDisplayName} (${feeder.fedDealsCount} N-1 fed deals across ${totalDeals} indexed deals, lift ${lift}x${sampleCo ? ` via ${sampleCo}` : ''}) ${isLead ? 'led' : 'joined'} ${targetStartupName} ${round.type} (${(round.date || '').slice(0, 7) || 'undated'}).`
        });
      }

      if (coInv) {
        const totalDeals = coInv.totalDeals ?? Math.max(coInv.sharedRounds || 1, totalDealsMap[invId] || 1);
        const lift =
          coInv.lift ??
          Math.round(((coInv.sharedRounds || 1) / Math.sqrt(Math.max(1, totalDeals))) * 100) / 100;
        const isMegaHub = Boolean(coInv.isMegaHub ?? (totalDeals >= MEGA_HUB_DEAL_THRESHOLD || BROAD_HUB_INVESTOR_IDS.has(coInv.id || coInv.investorId)));
        const sourceIds = resolveValidSourceIds(
          [...(coInv.sourceIds || []).slice(0, 2), ...(round.sourceIds || [])],
          rounds,
          company
        );
        const topSourceRank = deriveTopRankFromSources(sourceIds);
        const sampleCo = (coInv.companies || [])[0] || null;
        const hops = [
          { id: anchorId, label: anchorLabel, role: 'Query Anchor', kind: 'anchor', date: null },
          {
            id: `inv-${invId}`,
            label: invDisplayName,
            role: `Co-Investor (${coInv.sharedRounds}x shared, ${totalDeals} deals)`,
            kind: 'bridge',
            date: round.date || null
          },
          ...(sampleCo
            ? [
                {
                  id: `co-${slugifyBridgeId(sampleCo)}`,
                  label: sampleCo,
                  role: 'Co-Invested Company',
                  kind: 'intermediate',
                  date: null
                }
              ]
            : []),
          {
            id: targetStartupId,
            label: targetStartupName,
            role: `${isLead ? 'Led' : 'Backed'} ${round.type}`,
            kind: 'startup',
            date: round.date || null
          }
        ];

        registerBridge({
          id: `bridge-co_investor-${slugifyBridgeId(invId)}-${targetStartupId}`,
          bridgeFamily: 'co_investor',
          bridgeEntityId: `inv-${invId}`,
          bridgeEntityName: invDisplayName,
          hops,
          totalDeals,
          lift,
          isMegaHub,
          topSourceRank,
          sourceIds,
          date: round.date || null,
          rarityScore: computeBridgeRarityScore(lift, topSourceRank, isMegaHub, isMegaHub ? 0 : (isLead ? 3.6 : 3.0)),
          formulaBreakdown: buildBridgeFormulaBreakdown({
            kind: 'co_investor',
            anchorLabel,
            entityName: invDisplayName,
            sharedCount: coInv.sharedRounds || 1,
            totalDeals,
            lift,
            topSourceRank,
            isMegaHub,
            isLead,
            extraBonus: isMegaHub ? 0 : (isLead ? 3.6 : 3.0),
            sampleCompany: sampleCo
          }),
          summary: `${invDisplayName} co-invested ${coInv.sharedRounds}x across ${totalDeals} indexed deals (lift ${lift}x${sampleCo ? `, e.g. ${sampleCo}` : ''}) and ${isLead ? 'led' : 'joined'} ${targetStartupName} ${round.type} (${(round.date || '').slice(0, 7) || 'undated'}).`
        });
      }
    }
  }

  // 2b. Live Cala investor entities not seeded in PEER_INVESTORS (e.g. external VC Organization search)
  for (const liveInvName of (company?.liveInvestorNames || []).slice(0, 4)) {
    const cleanInv = String(liveInvName || '').trim();
    if (!cleanInv) continue;
    const slugInv = slugifyBridgeId(cleanInv);
    if (bridgeMap.has(`co_investor::inv-${slugInv}`) || bridgeMap.has(`feeder::inv-${slugInv}`)) continue;
    const latestR = rounds[rounds.length - 1] || null;
    const sourceIds = resolveValidSourceIds(latestR?.sourceIds || [], rounds, company);
    const topSourceRank = deriveTopRankFromSources(sourceIds, 'PRIMARY');
    const lift = 1.25;
    const invIdKey = `inv-${slugInv}`;
    registerBridge({
      id: `bridge-co_investor-live-${slugInv}-${targetStartupId}`,
      bridgeFamily: 'co_investor',
      bridgeEntityId: invIdKey,
      bridgeEntityName: cleanInv,
      hops: [
        { id: anchorId, label: anchorLabel, role: 'Query Anchor', kind: 'anchor', date: null },
        { id: invIdKey, label: cleanInv, role: 'Cala Verified Backer', kind: 'bridge', date: latestR?.date || null },
        { id: targetStartupId, label: targetStartupName, role: latestR ? `Backed ${latestR.type}` : 'Invested', kind: 'startup', date: latestR?.date || null }
      ],
      totalDeals: 1,
      lift,
      isMegaHub: false,
      topSourceRank,
      sourceIds,
      date: latestR?.date || null,
      rarityScore: computeBridgeRarityScore(lift, topSourceRank, false, 4.4),
      formulaBreakdown: buildBridgeFormulaBreakdown({
        kind: 'live_investor',
        anchorLabel,
        entityName: cleanInv,
        targetName: targetStartupName,
        lift,
        topSourceRank
      }),
      summary: `${cleanInv} is linked to ${targetStartupName} via Cala INVESTED_IN relationship.`
    });
  }

  // 3. Alumni / operator spinout bridges
  const roles = company?.peopleCoverage?.roles || [];
  const priorRolesByPerson = new Map();
  for (const role of roles) {
    const rel = String(role.relation || '').toUpperCase();
    const isPriorRel = ['WORKS_AT', 'IS_VICEPRESIDENT_OF', 'IS_BOARD_MEMBER_OF'].includes(rel);
    const isPartnerStub = /Partner Rep$/i.test(role.name || '');
    if (isPriorRel && !isPartnerStub && role.name) {
      priorRolesByPerson.set(role.name, role);
    }
  }

  const candidateAlumniList = [];
  for (const role of roles) {
    if (role.priorCompany) {
      candidateAlumniList.push({
        personName: role.name,
        currentRole: role.role || role.relation,
        validSince: role.validSince || role.startDate || null,
        priorCompany: role.priorCompany,
        priorRole: role.priorRole || 'Operator',
        priorValidUntil: role.priorValidUntil || role.validUntil || role.endDate || null,
        sourceId: role.sourceId || null,
        sourceRank: role.sourceRank || null
      });
    } else if (
      ['FOUNDED', 'IS_CEO_OF', 'IS_CTO_OF'].includes(String(role.relation || '').toUpperCase()) &&
      priorRolesByPerson.has(role.name)
    ) {
      const prev = priorRolesByPerson.get(role.name);
      // A role title such as "Vice President" is not an employer.  Only use
      // a named organization supplied by Cala when constructing alumni paths.
      const prevOrg = prev.company || prev.organization || prev.entityName || null;
      if (prevOrg) {
        candidateAlumniList.push({
          personName: role.name,
          currentRole: role.role || role.relation,
          validSince: role.validSince || role.startDate || null,
          priorCompany: prevOrg,
          priorRole: prev.role || prev.relation,
          priorValidUntil: prev.validUntil || prev.endDate || prev.priorValidUntil || null,
          sourceId: prev.sourceId || role.sourceId || null,
          sourceRank: prev.sourceRank || role.sourceRank || null
        });
      }
    }
  }

  if (signals?.alumniSpinout && !candidateAlumniList.some((a) => a.priorCompany === signals.alumniSpinout.priorCompany)) {
    candidateAlumniList.push({
      personName: signals.alumniSpinout.name,
      currentRole: signals.alumniSpinout.role,
      validSince: signals.alumniSpinout.validSince,
      priorCompany: signals.alumniSpinout.priorCompany,
      priorRole: signals.alumniSpinout.priorRole,
      priorValidUntil: signals.alumniSpinout.priorValidUntil,
      sourceId: signals.alumniSpinout.sourceId,
      sourceRank: 'FILING'
    });
  }

  for (const alum of candidateAlumniList) {
    const inPortfolio = portfolioCompanyNames.has(String(alum.priorCompany || '').toLowerCase());
    const lift = inPortfolio ? 1.45 : 1.15;
    const bridgeEntityId = `alumni-${slugifyBridgeId(alum.priorCompany)}`;
    const bridgeEntityName = `${alum.priorCompany} Alumni`;
    const sourceIds = resolveValidSourceIds([alum.sourceId], rounds, company);
    const topSourceRank = deriveTopRankFromSources(sourceIds, alum.sourceRank || 'PRIMARY');
    const hops = [
      { id: anchorId, label: anchorLabel, role: 'Query Anchor', kind: 'anchor', date: null },
      {
        id: bridgeEntityId,
        label: bridgeEntityName,
        role: inPortfolio ? 'Portfolio Spinout Source' : 'Scaleup Lineage',
        kind: 'bridge',
        date: alum.priorValidUntil || null
      },
      {
        id: `person-${slugifyBridgeId(alum.personName)}`,
        label: alum.personName,
        role: `${alum.priorRole}${alum.priorValidUntil ? ` -> ${alum.currentRole}` : ''}`,
        kind: 'intermediate',
        date: alum.validSince || null
      },
      {
        id: targetStartupId,
        label: targetStartupName,
        role: alum.currentRole || 'Founder / Exec',
        kind: 'startup',
        date: alum.validSince || null
      }
    ];

    registerBridge({
      id: `bridge-alumni_spinout-${slugifyBridgeId(alum.priorCompany)}-${targetStartupId}`,
      bridgeFamily: 'alumni_spinout',
      bridgeEntityId,
      bridgeEntityName,
      hops,
      totalDeals: null,
      verifiedAnchorConnection: inPortfolio,
      lift,
      isMegaHub: false,
      topSourceRank,
      sourceIds,
      date: alum.validSince || alum.priorValidUntil || null,
      rarityScore: computeBridgeRarityScore(lift, topSourceRank, false, inPortfolio ? 5.8 : 4.6),
      formulaBreakdown: buildBridgeFormulaBreakdown({
        kind: 'alumni_spinout',
        anchorLabel,
        entityName: bridgeEntityName,
        personName: alum.personName,
        priorRole: alum.priorRole,
        priorCompany: alum.priorCompany,
        priorValidUntil: alum.priorValidUntil,
        currentRole: alum.currentRole,
        targetName: targetStartupName,
        lift,
        topSourceRank
      }),
      summary: `${alum.personName} moved from ${alum.priorRole} at ${alum.priorCompany}${alum.priorValidUntil ? ` (until ${alum.priorValidUntil})` : ''} to ${alum.currentRole} at ${targetStartupName}${alum.validSince ? ` (since ${alum.validSince})` : ''}.`
    });
  }

  // 3b. Direct Person / Founder / Angel / Control-Person bridges (multi-company operators or live/matched People)
  const alumniCoveredPeople = new Set(candidateAlumniList.map((a) => normalizeLookupName(a.personName)));
  const countCompaniesForPerson = (personName) => {
    const norm = normalizeLookupName(personName);
    if (!norm || norm.length < 3) return 0;
    let count = 0;
    for (const c of COMPANIES) {
      if ((c.peopleCoverage?.roles || []).some((r) => !/Partner Rep$/i.test(r.name || '') && normalizeLookupName(r.name) === norm)) {
        count += 1;
        if (count >= 2) return count;
      }
    }
    return count;
  };

  let emittedDirectPeople = 0;
  for (const role of roles) {
    if (!role?.name || /Partner Rep$/i.test(role.name)) continue;
    const normPerson = normalizeLookupName(role.name);
    if (!normPerson || alumniCoveredPeople.has(normPerson)) continue;
    const rel = String(role.relation || '').toUpperCase();
    const isAngel = rel === 'INVESTED_IN';
    const sharedCompanyCount = role.isMatchedPersonBridge ? 2 : countCompaniesForPerson(role.name);
    if (!role.isMatchedPersonBridge && sharedCompanyCount < 2) continue;

    alumniCoveredPeople.add(normPerson);
    emittedDirectPeople += 1;
    const sourceIds = resolveValidSourceIds([role.sourceId], rounds, company);
    const topSourceRank = deriveTopRankFromSources(sourceIds, role.sourceRank || 'PRIMARY');
    const lift = isAngel ? 1.4 : sharedCompanyCount >= 2 ? 1.35 : 1.05;
    const personEntityId = `person-${slugifyBridgeId(role.name)}`;
    const family = isAngel ? 'co_investor' : 'alumni_spinout';
    const roleDesc = role.role || rel.replace(/^IS_|_OF$/g, '').toLowerCase();
    const bonus = role.isMatchedPersonBridge ? 5.6 : sharedCompanyCount >= 2 ? 4.8 : 3.4;

    registerBridge({
      id: `bridge-${family}-${personEntityId}-${targetStartupId}`,
      bridgeFamily: family,
      bridgeEntityId: personEntityId,
      bridgeEntityName: role.name,
      hops: [
        { id: anchorId, label: anchorLabel, role: 'Query Anchor', kind: 'anchor', date: null },
        {
          id: personEntityId,
          label: role.name,
          role: isAngel ? 'Angel / Individual Backer' : roleDesc,
          kind: 'bridge',
          date: role.validSince || role.startDate || null
        },
        {
          id: targetStartupId,
          label: targetStartupName,
          role: roleDesc,
          kind: 'startup',
          date: role.validSince || role.startDate || null
        }
      ],
      totalDeals: sharedCompanyCount >= 2 ? sharedCompanyCount : 1,
      // This person can be meaningful evidence about the target, but a fund
      // anchor has no verified relationship to them merely because they are a
      // target-side role. Keep it off the anchor trunk.
      verifiedAnchorConnection: false,
      lift,
      isMegaHub: false,
      topSourceRank,
      sourceIds,
      date: role.validSince || role.startDate || null,
      rarityScore: computeBridgeRarityScore(lift, topSourceRank, false, bonus),
      formulaBreakdown: buildBridgeFormulaBreakdown({
        kind: 'person_bridge',
        anchorLabel,
        entityName: role.name,
        personName: role.name,
        currentRole: roleDesc,
        targetName: targetStartupName,
        lift,
        topSourceRank
      }),
      summary: `${role.name} (${roleDesc}) connects ${sharedCompanyCount >= 2 ? `${sharedCompanyCount}+ indexed entities including ` : ''}${targetStartupName}${role.validSince ? ` since ${String(role.validSince).slice(0, 7)}` : ''}.`
    });
  }

  // 4. Event / ecosystem bridges (Slush 2026 & PARTICIPATES_IN_EVENT / conferences)
  const corpEvents = [...(signals?.visibleCorpEvents || company?.corporateEvents || [])];
  const eventCandidates = corpEvents.filter(
    (ev) =>
      ev &&
      (ev.id === SLUSH_2026_EVENT_ID ||
        ev.eventType === 'PARTICIPATES_IN_EVENT' ||
        /slush|summit|conference|demo day|accelerator/i.test(`${ev.name || ''} ${ev.summary || ''}`))
  );
  const hasSlushEvent =
    Boolean(company?.attendingSlush2026) ||
    eventCandidates.some((ev) => ev.id === SLUSH_2026_EVENT_ID || /slush/i.test(`${ev.name || ''} ${ev.summary || ''}`));

  if (hasSlushEvent && !eventCandidates.some((ev) => ev.id === SLUSH_2026_EVENT_ID)) {
    const anySlushLike = eventCandidates.find((ev) => /slush/i.test(`${ev.name || ''} ${ev.summary || ''}`));
    eventCandidates.push({
      id: SLUSH_2026_EVENT_ID,
      name: 'Slush 2026 (Helsinki)',
      eventDate: anySlushLike?.eventDate || null,
      summary: `${targetStartupName} indexed in Slush 2026 participant graph.`,
      sourceId: anySlushLike?.sourceId || corpEvents[0]?.sourceId || null,
      sourceRank: anySlushLike?.sourceRank || 'PRIMARY'
    });
  }

  for (const ev of eventCandidates) {
    const isSlush = ev.id === SLUSH_2026_EVENT_ID || /slush/i.test(`${ev.name || ''} ${ev.summary || ''}`);
    const bridgeEntityId = isSlush ? SLUSH_2026_EVENT_ID : ev.id || `event-${slugifyBridgeId(ev.name)}`;
    const bridgeEntityName = isSlush ? 'Slush 2026 (Helsinki)' : ev.name || 'Ecosystem Event';
    const sourceIds = resolveValidSourceIds([ev.sourceId], rounds, company);
    const topSourceRank = deriveTopRankFromSources(sourceIds, ev.sourceRank || 'PRIMARY');
    const lift = 0.9;
    const hops = [
      { id: anchorId, label: anchorLabel, role: 'Query Anchor', kind: 'anchor', date: null },
      {
        id: bridgeEntityId,
        label: bridgeEntityName,
        role: 'Event Participant Bridge',
        kind: 'bridge',
        date: ev.eventDate || null
      },
      { id: targetStartupId, label: targetStartupName, role: 'Participating Startup', kind: 'startup', date: ev.eventDate || null }
    ];

    registerBridge({
      id: `bridge-event-${slugifyBridgeId(bridgeEntityId)}-${targetStartupId}`,
      bridgeFamily: 'event',
      bridgeEntityId,
      bridgeEntityName,
      hops,
      totalDeals: null,
      verifiedAnchorConnection: false,
      lift,
      isMegaHub: false,
      topSourceRank,
      sourceIds,
      date: ev.eventDate || null,
      rarityScore: computeBridgeRarityScore(lift, topSourceRank, false, isSlush ? -4.5 : -5.0),
      formulaBreakdown: buildBridgeFormulaBreakdown({
        kind: 'event',
        anchorLabel,
        entityName: bridgeEntityName,
        targetName: targetStartupName,
        eventDate: ev.eventDate || null,
        lift,
        topSourceRank
      }),
      summary: `${targetStartupName} connects via ${bridgeEntityName}${ev.eventDate ? ` (${ev.eventDate.slice(0, 7)})` : ''}: ${ev.summary || 'verified ecosystem participant record.'}`
    });
  }

  const gIndex = options.globalIndex || buildGlobalRoundIndex(thesis?.evalDate || null);
  for (const round of visibleRounds || []) {
    for (const invId of round.investorIds || []) {
      if (!BROAD_HUB_INVESTOR_IDS.has(invId)) continue;
      const totalDeals = Math.max(1, gIndex.investorTotalDeals[invId] || 7);
      const lift = Math.round((1 / Math.sqrt(totalDeals)) * 100) / 100;
      const sourceIds = resolveValidSourceIds(round.sourceIds || [], visibleRounds, company);
      const topSourceRank = deriveTopRankFromSources(sourceIds);
      const invName = PEER_INVESTORS[invId] || invId;
      registerBridge({
        id: `bridge-hub-${invId}-${company.id}`,
        bridgeFamily: 'co_investor',
        bridgeEntityId: invId,
        bridgeEntityName: invName,
        isMegaHub: true,
        totalDeals,
        lift,
        rarityScore: computeBridgeRarityScore(lift, topSourceRank, true, 0),
        formulaBreakdown: buildBridgeFormulaBreakdown({
          kind: 'mega_hub',
          anchorLabel,
          entityName: invName,
          totalDeals,
          lift,
          topSourceRank,
          isMegaHub: true
        }),
        hops: [thesis?.fundName || 'Anchor Fund', invName, company.name],
        date: round.date || null,
        topSourceRank,
        sourceIds,
        summary: `Broad angel syndicate ${invName} (${totalDeals} indexed deals) backed ${company.name} ${round.type}.`
      });
    }
  }
  for (const p of extractTwoHopSyndicateBridges(thesis, company, visibleRounds, gIndex)) {
    registerBridge(p);
  }
  for (const p of extractBidirectionalAlumniBridges(thesis, company, visibleRounds, gIndex, signals)) {
    registerBridge(p);
  }
  for (const p of extractPortfolioTwinBridges(thesis, company, visibleRounds, signals)) {
    registerBridge(p);
  }

  const allCandidates = [...bridgeMap.values()];
  const familyScoped = normalizedFamily
    ? allCandidates.filter((b) => b.bridgeFamily === normalizedFamily)
    : allCandidates;
  const contribScoped = normalizedContrib
    ? familyScoped.filter((b) => deriveContributionGroup(b) === normalizedContrib)
    : familyScoped;
  const provenanceScoped = filingOnly
    ? contribScoped.filter((b) => b.topSourceRank === 'FILING')
    : contribScoped;

  const megaHubCount = provenanceScoped.filter((b) => b.isMegaHub).length;
  const nonMegaHubs = provenanceScoped.filter((b) => !b.isMegaHub);
  const suppressedMegaHubCount = hideMegaHubs ? megaHubCount : 0;
  const eligible = hideMegaHubs ? nonMegaHubs : provenanceScoped;

  eligible.sort(
    (a, b) =>
      b.rarityScore - a.rarityScore ||
      b.lift - a.lift ||
      a.bridgeEntityName.localeCompare(b.bridgeEntityName)
  );

  const cap = Math.max(1, Math.min(20, Number(maxPaths) || 5));
  const bridges = eligible.slice(0, cap);

  return {
    bridges,
    totalBeforeSuppression: provenanceScoped.length,
    suppressedMegaHubCount,
    hiddenMegaHubCount: suppressedMegaHubCount,
    megaHubFallbackUsed: false,
    familiesPresent: [...new Set(bridges.map((b) => b.bridgeFamily))],
    contributionGroupsPresent: [...new Set(bridges.map((b) => b.contributionGroup))],
    hideMegaHubsApplied: Boolean(hideMegaHubs)
  };
}

function buildMissingFromCala(company, visibleRounds = [], signals = null) {
  const series = signals?.visibleSeries || company?.employeeCountSeries || [];
  const finMetrics = signals?.visibleFinMetrics || company?.financialMetrics || [];
  const roles = company?.peopleCoverage?.roles || [];
  const rounds = visibleRounds || [];

  const gaps = [
    {
      field: 'Private revenue, ARR, and burn rate',
      status: 'Not found in Cala',
      reason: finMetrics.length
        ? Number.isFinite(finMetrics[0]?.cashEurM)
          ? 'UK Companies House provides balance sheet cash/creditors only; ARR splits remain private.'
          : 'Indexed Cala metrics show statutory balance/filing series only; private ARR & burn remain undisclosed.'
        : 'Cala financial metrics cover UK/public statutory filings only.'
    },
    {
      field: 'Individual fund cheque sizes',
      status: 'Not found in Cala',
      reason: 'Round totals are public; investor-level splits are estimated as not disclosed.'
    },
    {
      field: 'Personal founder-partner connections',
      status: 'Not found in Cala',
      reason: 'Personal relationships reside in LinkedIn or private CRMs (not scraped).'
    },
    {
      field: 'Customer cohort retention and net revenue churn',
      status: 'Not found in Cala',
      reason: 'Private unit economics and cohort retention metrics are not disclosed in statutory filings.'
    }
  ];

  if (series.length < 2) {
    gaps.push({
      field: 'Historical employee growth curve',
      status: 'Not found in Cala',
      reason: 'Fewer than 2 dated employee_count observations are currently indexed in Cala for this company.'
    });
  }

  if (!rounds.length) {
    gaps.push({
      field: 'VC funding rounds & valuation',
      status: 'Not found in Cala',
      reason: company?.isRegistryDiscovered
        ? 'Discovered via official government corporate registry; no VC funding rounds are indexed in Cala.'
        : 'No equity venture rounds are currently indexed in Cala for this entity.'
    });
  } else if (rounds.every((r) => r.valuationEurM === null || r.valuationEurM === undefined)) {
    gaps.push({
      field: 'Post-money round valuations',
      status: 'Not found in Cala',
      reason: 'Equity round filings disclose capital raised, while headline valuations were not publicly reported.'
    });
  }

  if (!company?.peopleCoverage?.available || !roles.length) {
    gaps.push({
      field: 'Verified leadership & prior-role coverage',
      status: 'Not found in Cala',
      reason: company?.peopleCoverage?.note || 'Leadership role lineage has not been indexed in Cala for this entity.'
    });
  }

  return gaps;
}

export function buildEvidenceFolders(
  company,
  visibleRounds = [],
  signals = null,
  hiddenBridgesResult = null,
  dataConfidence = null,
  _matchContext = null
) {
  const safeSignals = signals || {};
  const rounds = visibleRounds || [];
  const bridgePaths = hiddenBridgesResult?.bridges || [];
  const suppressedMegaHubCount = hiddenBridgesResult?.suppressedMegaHubCount ?? 0;

  // Folder 2: Observed Activity & Timing
  const activityItems = [];
  const series = safeSignals.visibleSeries || [];
  let velocityFormula = 'Not calculated: <2 dated Cala observations';
  if (series.length > 0) {
    const firstPt = series[0];
    const latestPt = series[series.length - 1];
    const growth = safeSignals.headcountGrowthPct ?? 0;
    const obsSourceIds = resolveValidSourceIds([latestPt.sourceId], rounds, company);
    const obsRank = deriveTopRankFromSources(obsSourceIds, latestPt.sourceRank || 'PRIMARY');
    const startVal = safeSignals.headcountAtLastRound ?? firstPt.value;
    const endVal = safeSignals.currentObservedEmp ?? latestPt.value;
    if (series.length >= 2 && startVal > 0) {
      const calcPct = Math.round(((endVal - startVal) / startVal) * 100);
      const signPct = calcPct >= 0 ? `+${calcPct}%` : `${calcPct}%`;
      velocityFormula = `(${endVal} current - ${startVal} at baseline) / ${startVal} = ${signPct} (from ${String(firstPt.date || '').slice(0, 7) || 'prior'} to ${String(latestPt.date || '').slice(0, 7) || 'latest'}, ${obsRank})`;
    }
    activityItems.push({
      kind: growth >= 30 ? 'headcount_momentum' : 'headcount_observation',
      label: growth >= 30 ? `+${growth}% team growth` : `Observed team: ${endVal} employees`,
      detail: `${startVal} -> ${endVal} employees across ${series.length} dated Cala observation(s).`,
      date: latestPt.date || null,
      sourceRank: obsRank,
      sourceIds: obsSourceIds
    });
  }

  const corpEvents = safeSignals.visibleCorpEvents || [];
  for (const ev of corpEvents) {
    const evSourceIds = resolveValidSourceIds([ev.sourceId], rounds, company);
    activityItems.push({
      kind: ev.unannouncedFiling
        ? 'unannounced_filing'
        : ev.id === SLUSH_2026_EVENT_ID || ev.eventType === 'PARTICIPATES_IN_EVENT'
          ? 'ecosystem_event'
          : 'corporate_event',
      label: ev.name || 'Corporate Event',
      detail: ev.summary || ev.name || 'Corporate event indexed in Cala.',
      date: ev.eventDate || null,
      sourceRank: deriveTopRankFromSources(evSourceIds, ev.sourceRank || 'FILING'),
      sourceIds: evSourceIds
    });
  }

  if (
    company?.attendingSlush2026 &&
    !corpEvents.some((ev) => ev.id === SLUSH_2026_EVENT_ID || /slush/i.test(ev.name || ''))
  ) {
    const slushSourceIds = resolveValidSourceIds([], rounds, company);
    activityItems.push({
      kind: 'ecosystem_event',
      label: 'Slush 2026 Participant',
      detail: `${company.name} listed in Cala Slush 2026 participant graph.`,
      date: null,
      sourceRank: deriveTopRankFromSources(slushSourceIds, 'PRIMARY'),
      sourceIds: slushSourceIds
    });
  }

  const activeAiDomain = (safeSignals.visibleDomains || []).find((d) => d.status === 'ACTIVE' && d.domain?.endsWith('.ai'));
  if (activeAiDomain && (safeSignals.visibleDomains || []).some((d) => d.status === 'INACTIVE')) {
    const domSourceIds = resolveValidSourceIds([], rounds, company);
    activityItems.push({
      kind: 'domain_shift',
      label: `Domain upgrade -> ${activeAiDomain.domain}`,
      detail: `HAS_DOMAIN_NAME activated ${activeAiDomain.domain} on ${activeAiDomain.validSince}.`,
      date: activeAiDomain.validSince || null,
      sourceRank: deriveTopRankFromSources(domSourceIds, 'PRIMARY'),
      sourceIds: domSourceIds
    });
  }

  activityItems.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (SOURCE_RANK_PRIORITY[b.sourceRank] || 0) - (SOURCE_RANK_PRIORITY[a.sourceRank] || 0));

  // Folder 3: Filings, Proof & Missing Gaps
  const verifiedFacts = [];
  for (const r of rounds) {
    const rSources = resolveValidSourceIds(r.sourceIds || [], rounds, company);
    const invList = [...new Set([
      ...(r.investorIds || []).map((id) => company?.liveInvestorsMap?.[id] || PEER_INVESTORS[id] || id),
      ...(r.investorNames || [])
    ])].filter(Boolean);
    const leadLabel = r.leadInvestorId
      ? company?.liveInvestorsMap?.[r.leadInvestorId] || PEER_INVESTORS[r.leadInvestorId] || r.leadInvestorId
      : invList[0] || null;
    verifiedFacts.push({
      kind: 'funding_round',
      label: `${r.type}${r.amountEurM !== null && r.amountEurM !== undefined ? ` (EUR ${r.amountEurM}M)` : ''}`,
      detail: `${leadLabel ? `Lead: ${leadLabel}` : 'Round investor undisclosed in Cala'}${invList.length ? `; Syndicate: ${invList.join(', ')}` : ''}.`,
      date: r.date || null,
      sourceRank: deriveTopRankFromSources(rSources),
      sourceIds: rSources
    });
  }

  for (const m of safeSignals.visibleFinMetrics || []) {
    const mSources = resolveValidSourceIds([m.sourceId], rounds, company);
    const isStatutoryCash = Number.isFinite(m.cashEurM);
    verifiedFacts.push({
      kind: 'statutory_financials',
      label: isStatutoryCash
        ? `Companies House #${company?.companiesHouseNumber || 'Filing'} (${m.year || m.periodEnd?.slice(0, 4) || 'Latest'})`
        : `${m.label || m.metric || 'Cala Financial Metric'} (${m.year || m.periodEnd?.slice(0, 4) || 'Latest'})`,
      detail: isStatutoryCash
        ? `Cash EUR ${m.cashEurM}M, net assets EUR ${m.netAssetsEurM}M (~${m.runwayMonthsEst}m est. runway).`
        : `${m.label || m.metric}: ${m.value}${m.unit ? ` ${m.unit}` : ''}${m.periodEnd ? ` as of ${m.periodEnd}` : ''}.`,
      date: m.filingDate || m.periodEnd || null,
      sourceRank: deriveTopRankFromSources(mSources, m.sourceRank || 'FILING'),
      sourceIds: mSources
    });
  }

  if (company?.registryInfo?.registrationNumber) {
    const regSources = resolveValidSourceIds([company.registryInfo.sourceId], rounds, company);
    verifiedFacts.push({
      kind: 'official_registry',
      label: `${company.registryInfo.registryName} #${company.registryInfo.registrationNumber}`,
      detail: `Status: ${company.registryInfo.status}${company.registryInfo.industryDescription ? ` (${company.registryInfo.industryDescription})` : ''}.`,
      date: company.foundingDate || null,
      sourceRank: deriveTopRankFromSources(regSources, 'FILING'),
      sourceIds: regSources
    });
  }

  for (const ev of corpEvents) {
    if (ev.unannouncedFiling || ev.deduplicatedAgainstRound === false) {
      const fSources = resolveValidSourceIds([ev.sourceId], rounds, company);
      verifiedFacts.push({
        kind: 'statutory_event',
        label: ev.name || 'Statutory Filing',
        detail: ev.summary || ev.name || 'Statutory corporate event.',
        date: ev.eventDate || null,
        sourceRank: deriveTopRankFromSources(fSources, ev.sourceRank || 'FILING'),
        sourceIds: fSources
      });
    }
  }

  if (safeSignals.alumniSpinout) {
    const aSources = resolveValidSourceIds([safeSignals.alumniSpinout.sourceId], rounds, company);
    verifiedFacts.push({
      kind: 'people_lineage',
      label: `${safeSignals.alumniSpinout.name} (${safeSignals.alumniSpinout.role})`,
      detail: `Prior: ${safeSignals.alumniSpinout.priorRole} at ${safeSignals.alumniSpinout.priorCompany}${safeSignals.alumniSpinout.priorValidUntil ? ` until ${safeSignals.alumniSpinout.priorValidUntil}` : ''}.`,
      date: safeSignals.alumniSpinout.validSince || null,
      sourceRank: deriveTopRankFromSources(aSources, 'FILING'),
      sourceIds: aSources
    });
  }

  verifiedFacts.sort(
    (a, b) =>
      (SOURCE_RANK_PRIORITY[b.sourceRank] || 0) - (SOURCE_RANK_PRIORITY[a.sourceRank] || 0) ||
      (b.date || '').localeCompare(a.date || '') ||
      a.label.localeCompare(b.label)
  );

  return {
    triageNote: 'Evidence-match order for analyst review only, not an investment recommendation.',
    hiddenBridges: {
      label: 'Hidden Bridges & Warm Paths',
      totalFound: bridgePaths.length + suppressedMegaHubCount,
      suppressedMegaHubCount,
      hiddenMegaHubCount: suppressedMegaHubCount,
      familiesPresent: [...new Set(bridgePaths.map((p) => p.bridgeFamily))],
      paths: bridgePaths
    },
    observedActivity: {
      label: 'Observed Activity & Timing',
      whyNowTrigger: safeSignals.whyNowTrigger || null,
      headcountAtLastRound: safeSignals.headcountAtLastRound ?? null,
      currentObservedEmp: safeSignals.currentObservedEmp ?? company?.employeeCount ?? null,
      headcountGrowthPct: safeSignals.headcountGrowthPct ?? null,
      velocityFormula,
      items: activityItems
    },
    proofAndGaps: {
      label: 'Filings, Proof & Missing Gaps',
      dataConfidenceGrade: dataConfidence?.grade || 'Early / Sparse',
      topSourceRank: dataConfidence?.topSourceRank || 'AGGREGATOR',
      verifiedFacts: verifiedFacts.slice(0, 12),
      missingFromCala: buildMissingFromCala(company, rounds, safeSignals)
    }
  };
}

const STAGE_RANK_ORDER = {
  'registered (unfunded)': 1,
  'pre-seed': 1,
  angel: 1,
  seed: 2,
  'series a': 3,
  'series b': 4,
  growth: 4,
  'series c': 5,
  'series d': 6,
  'public / mature': 7
};

function getStageRankNum(stageName) {
  const s = String(stageName || '').trim().toLowerCase();
  return STAGE_RANK_ORDER[s] || 2;
}

function buildPortfolioConflictAndTwinCheck(company, thesis, companyStage, visibleRounds = []) {
  const portfolioList = thesis?.portfolioCompanies || [];
  if (!portfolioList.length) {
    return {
      conflictRisk: {
        level: 'None',
        companyId: null,
        companyName: null,
        stage: null,
        overlapDetails: [],
        reason: 'No portfolio benchmark loaded for deterministic conflict comparison.',
        sourceIds: []
      },
      synergisticTwin: null
    };
  }

  const companyRank = getStageRankNum(companyStage);
  const companySubs = new Set((company?.subSectors || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  const companyInvIds = new Set(
    (visibleRounds || []).flatMap((r) => [...(r.investorIds || []), r.leadInvestorId].filter((id) => id && id !== 'angel-syndicate'))
  );

  let bestConflict = null;

  for (const p of portfolioList) {
    if (!p || p.id === company?.id) continue;
    const pFull = COMPANIES.find((c) => c.id === p.id) || p;
    const pStage = p.latestRoundType || pFull.rounds?.[pFull.rounds.length - 1]?.type || 'Not found in Cala';
    const stageGap = Math.abs(getStageRankNum(pStage) - companyRank);
    const sameCompetitorGroup = Boolean(
      company?.competitorGroup &&
      pFull.competitorGroup &&
      company.competitorGroup === pFull.competitorGroup
    );
    const exactSector = Boolean(company?.sector && pFull.sector && company.sector === pFull.sector);
    const pSubs = pFull.subSectors || p.subSectors || [];
    const overlappingSubs = pSubs.filter((s) => companySubs.has(String(s).trim().toLowerCase()));
    const sameCountry = Boolean(company?.country && pFull.country && company.country === pFull.country);
    const pSources = resolveValidSourceIds([...(p.sourceIds || []), ...(pFull.rounds || []).flatMap((r) => r.sourceIds || [])], visibleRounds, company);

    let level = 'None';
    let rankScore = 0;
    let reason = '';

    if (sameCompetitorGroup || (exactSector && overlappingSubs.length > 0 && sameCountry && stageGap <= 1)) {
      level = 'High';
      rankScore = sameCompetitorGroup ? 100 : 90 + overlappingSubs.length;
      const overlapLabel = overlappingSubs.length ? overlappingSubs.slice(0, 2).join(', ') : pFull.competitorGroup || company.sector;
      const geoLabel = sameCountry ? company.country : `${company.country || 'European'} buyer profile`;
      reason = `Direct ${company.sector} + ${geoLabel} overlap (${overlapLabel}) with portfolio company ${pFull.name} (${pStage}) - verify non-compete before intro`;
    } else if (exactSector && stageGap <= 1 && (overlappingSubs.length > 0 || sameCountry)) {
      level = 'Watch';
      rankScore = 60 + overlappingSubs.length * 5 + (sameCountry ? 4 : 0);
      reason = overlappingSubs.length > 0
        ? `Overlapping ${overlappingSubs.slice(0, 2).join(', ')} focus within +/-1 stage of portfolio company ${pFull.name} (${pStage}) - verify buyer positioning before partner review`
        : `Exact ${company.sector} + ${company.country} overlap within +/-1 stage of portfolio company ${pFull.name} (${pStage}) - verify positioning boundaries`;
    }

    if (level !== 'None' && (!bestConflict || rankScore > bestConflict.rankScore)) {
      bestConflict = {
        rankScore,
        level,
        companyId: pFull.id,
        companyName: pFull.name,
        stage: pStage,
        overlapDetails: overlappingSubs.length ? overlappingSubs : [company.sector].filter(Boolean),
        reason,
        sourceIds: pSources.slice(0, 2)
      };
    }
  }

  const conflictRisk = bestConflict
    ? {
        level: bestConflict.level,
        companyId: bestConflict.companyId,
        companyName: bestConflict.companyName,
        stage: bestConflict.stage,
        overlapDetails: bestConflict.overlapDetails,
        reason: bestConflict.reason,
        sourceIds: bestConflict.sourceIds
      }
    : {
        level: 'None',
        companyId: null,
        companyName: null,
        stage: null,
        overlapDetails: [],
        reason: 'No direct portfolio conflict detected across sector, sub-sector, country, and +/-1 stage records.',
        sourceIds: []
      };

  // Synergistic / Pattern Twin (non-conflicting portfolio company sharing GTM archetype, stage, or feeder investor)
  let bestTwin = null;
  for (const p of portfolioList) {
    if (!p || p.id === company?.id || p.id === conflictRisk.companyId) continue;
    const pFull = COMPANIES.find((c) => c.id === p.id) || p;
    const pRounds = pFull.rounds || [];
    const pStage = p.latestRoundType || pRounds[pRounds.length - 1]?.type || 'Not found in Cala';
    const stageGap = Math.abs(getStageRankNum(pStage) - companyRank);
    const pInvs = new Set([
      ...(p.roundInvestorIds || []),
      ...pRounds.flatMap((r) => [...(r.investorIds || []), r.leadInvestorId].filter(Boolean))
    ]);
    const sharedInvestorNames = [...companyInvIds]
      .filter((id) => pInvs.has(id) && id !== thesis?.fundId)
      .map((id) => PEER_INVESTORS[id] || id);
    const overlappingSubs = (pFull.subSectors || p.subSectors || []).filter((s) =>
      companySubs.has(String(s).trim().toLowerCase())
    );
    const exactSector = Boolean(company?.sector && pFull.sector === company.sector);
    const sameCountry = Boolean(company?.country && pFull.country === company.country);
    const sameRegion = Boolean(company?.region && pFull.region === company.region);

    let simScore = 0;
    const matchReasons = [];
    if (sharedInvestorNames.length > 0) {
      simScore += 4.5 * sharedInvestorNames.length;
      matchReasons.push(`shared syndicate (${sharedInvestorNames.slice(0, 2).join(', ')})`);
    }
    if (exactSector) {
      simScore += 3.0;
      matchReasons.push(`${pFull.sector} buyer archetype`);
    }
    if (stageGap <= 1) {
      simScore += 2.2;
      matchReasons.push(`${pStage} stage peer`);
    }
    if (overlappingSubs.length > 0) {
      simScore += Math.min(3.5, overlappingSubs.length * 1.8);
      matchReasons.push(`shared focus (${overlappingSubs.slice(0, 2).join(', ')})`);
    }
    if (sameCountry) {
      simScore += 1.5;
      matchReasons.push(`${pFull.country} ecosystem`);
    } else if (sameRegion) {
      simScore += 0.6;
    }

    if (simScore > (bestTwin?.simScore ?? 0)) {
      const stagesTrail = pRounds.map((r) => r.type).filter(Boolean);
      const latestR = pRounds[pRounds.length - 1] || null;
      const latestLeadName = latestR?.leadInvestorId ? PEER_INVESTORS[latestR.leadInvestorId] || latestR.leadInvestorId : null;
      const highestVal = Math.max(0, ...pRounds.map((r) => Number(r.valuationEurM) || 0));
      const progression = stagesTrail.length >= 2
        ? `${stagesTrail[0]} -> ${stagesTrail[stagesTrail.length - 1]}`
        : pStage;
      const markupCue = highestVal > 0
        ? `scaled to EUR ${highestVal}M valuation`
        : latestR?.amountEurM
          ? `raised EUR ${latestR.amountEurM}M ${latestR.type}${latestLeadName ? ` led by ${latestLeadName}` : ''}`
          : `${pStage} benchmark`;
      const pSources = resolveValidSourceIds([...(p.sourceIds || []), ...pRounds.flatMap((r) => r.sourceIds || [])], visibleRounds, company);

      bestTwin = {
        simScore,
        companyId: pFull.id,
        companyName: pFull.name,
        sector: pFull.sector,
        stage: pStage,
        country: pFull.country,
        sharedFeeders: sharedInvestorNames,
        patternSummary: `Mirrors ${pFull.name} (${progression}, ${markupCue}) via ${matchReasons.slice(0, 3).join(' + ') || pFull.sector}.`,
        sourceIds: pSources.slice(0, 2)
      };
    }
  }

  const synergisticTwin = bestTwin
    ? {
        companyId: bestTwin.companyId,
        companyName: bestTwin.companyName,
        sector: bestTwin.sector,
        stage: bestTwin.stage,
        country: bestTwin.country,
        sharedFeeders: bestTwin.sharedFeeders,
        patternSummary: bestTwin.patternSummary,
        sourceIds: bestTwin.sourceIds
      }
    : null;

  return { conflictRisk, synergisticTwin };
}

function buildKillScreenRiskFlags(company, visibleRounds, signals, hiddenBridgesResult, evidenceFolders, dataConfidence, evalDate) {
  const flags = [];
  const rounds = visibleRounds || [];
  const latestRound = rounds[rounds.length - 1] || null;
  const series = signals?.visibleSeries || company?.employeeCountSeries || [];
  const verifiedFacts = evidenceFolders?.proofAndGaps?.verifiedFacts || [];
  const missingFromCala = evidenceFolders?.proofAndGaps?.missingFromCala || [];
  const topRank = String(dataConfidence?.topSourceRank || evidenceFolders?.proofAndGaps?.topSourceRank || 'AGGREGATOR').toUpperCase();

  const hasFilingOrPrimaryFact =
    topRank === 'FILING' ||
    topRank === 'PRIMARY' ||
    verifiedFacts.some((f) => f.sourceRank === 'FILING' || f.sourceRank === 'PRIMARY') ||
    (signals?.arbitrageSignals || []).some((s) => s.sourceRank === 'FILING' || s.sourceRank === 'PRIMARY');

  if (!hasFilingOrPrimaryFact) {
    flags.push({
      id: 'press_only_provenance',
      severity: 'warning',
      label: 'Press / Aggregator Only Provenance',
      detail: `Relies solely on ${topRank} mentions (0 FILING/PRIMARY records) - verify statutory filings before partner escalation`,
      rule: 'filingsAndPrimaryCount === 0',
      sourceIds: resolveValidSourceIds([], rounds, company)
    });
  }

  const monthsSince = latestRound ? monthsBetween(latestRound.date, evalDate || REFERENCE_DATE) : null;
  const growthPct = signals?.headcountGrowthPct ?? 0;
  if ((monthsSince !== null && monthsSince >= 18 && growthPct < 5) || series.length < 2) {
    const detail = monthsSince !== null && monthsSince >= 18 && growthPct < 5
      ? `Latest round was ${Math.round(monthsSince)}m ago with +${growthPct}% headcount growth (<5%) - verify commercial traction vs. plateau`
      : `Only ${series.length} dated employee_count observation(s) in Cala (<2 required for velocity curve) - verify team trajectory`;
    flags.push({
      id: 'flat_or_missing_velocity',
      severity: 'warning',
      label: series.length < 2 ? 'Missing Headcount Velocity Curve' : 'Flat Post-Round Velocity',
      detail,
      rule: '(monthsSince >= 18 && headcountGrowthPct < 5) || seriesCount < 2',
      sourceIds: resolveValidSourceIds(series.map((p) => p.sourceId), rounds, company)
    });
  }

  const paths = hiddenBridgesResult?.bridges || [];
  const nonMegaInvOrAlumni = paths.filter(
    (b) => !b.isMegaHub && (b.bridgeFamily === 'feeder' || b.bridgeFamily === 'co_investor' || b.bridgeFamily === 'alumni_spinout')
  );
  if (nonMegaInvOrAlumni.length === 0) {
    const suppressedCnt = hiddenBridgesResult?.suppressedMegaHubCount ?? 0;
    flags.push({
      id: 'mega_hub_only_bridge',
      severity: 'warning',
      label: 'No Non-Mega-Hub Investor / Alumni Bridge',
      detail: `0 boutique VC/Feeder or Alumni paths indexed${suppressedCnt > 0 ? ` (${suppressedCnt} mega-hub overlap(s) suppressed)` : ''} - use backchannel/direct operator intro`,
      rule: 'nonMegaInvestorOrAlumniBridges === 0',
      sourceIds: resolveValidSourceIds([], rounds, company)
    });
  }

  if (missingFromCala.length >= 4) {
    flags.push({
      id: 'missing_data_high',
      severity: missingFromCala.length >= 5 ? 'warning' : 'info',
      label: `High Gap Surface (${missingFromCala.length} fields missing)`,
      detail: `${missingFromCala.length} diligence fields remain Not found in Cala (incl. ARR/burn${missingFromCala.some((g) => /headcount|employee/i.test(g.field)) ? ' + headcount history' : ''}${missingFromCala.some((g) => /valuation|vc funding/i.test(g.field)) ? ' + valuation/rounds' : ''})`,
      rule: 'missingFromCala.length >= 4',
      sourceIds: resolveValidSourceIds([], rounds, company)
    });
  }

  return flags;
}

function buildUrgencyTriggers(company, thesis, visibleRounds, signals, evalDate) {
  const triggers = [];
  const rounds = visibleRounds || [];
  const latestRound = rounds[rounds.length - 1] || null;
  const corpEvents = signals?.visibleCorpEvents || [];

  const filingEv = corpEvents.find((ev) => ev.unannouncedFiling);
  if (filingEv) {
    triggers.push({
      kind: 'unannounced_filing',
      label: filingEv.name || 'Unannounced statutory filing',
      detail: filingEv.summary || 'Recent statutory filing precedes press announcement.',
      date: filingEv.eventDate || null,
      sourceRank: 'FILING',
      sourceIds: resolveValidSourceIds([filingEv.sourceId], rounds, company)
    });
  }

  const visibleDomains = signals?.visibleDomains || [];
  const activeAiDomain = visibleDomains.find((d) => d.status === 'ACTIVE' && d.domain?.endsWith('.ai'));
  if (activeAiDomain && visibleDomains.some((d) => d.status === 'INACTIVE')) {
    triggers.push({
      kind: 'domain_shift',
      label: `Domain upgrade (${activeAiDomain.domain})`,
      detail: `Active domain transitioned to ${activeAiDomain.domain} on ${activeAiDomain.validSince}.`,
      date: activeAiDomain.validSince || null,
      sourceRank: 'PRIMARY',
      sourceIds: resolveValidSourceIds([], rounds, company)
    });
  }

  const growthPct = signals?.headcountGrowthPct ?? 0;
  const series = signals?.visibleSeries || [];
  if (growthPct >= 30 && series.length >= 2) {
    const latestPt = series[series.length - 1];
    triggers.push({
      kind: 'headcount_growth',
      label: `+${growthPct}% post-round hiring velocity`,
      detail: `Observed team scaled ${signals?.headcountAtLastRound ?? latestPt?.value} -> ${signals?.currentObservedEmp ?? latestPt?.value} employees.`,
      date: latestPt?.date || null,
      sourceRank: latestPt?.sourceRank || 'PRIMARY',
      sourceIds: resolveValidSourceIds([latestPt?.sourceId], rounds, company)
    });
  }

  const monthsSince = latestRound && latestRound.date ? monthsBetween(latestRound.date, evalDate || REFERENCE_DATE) : null;
  const medianGap = thesis?.timeTravelProfile?.medianRoundGapMonths ?? 18;
  const windowLow = Math.max(1, medianGap - 3);
  const windowHigh = medianGap + 4;
  let timingFormula = 'Not calculated: no dated prior round';
  if (monthsSince !== null && latestRound) {
    const roundRank = deriveTopRankFromSources(latestRound.sourceIds || []);
    const windowStatus = monthsSince >= windowLow && monthsSince <= windowHigh
      ? 'inside follow-on window'
      : monthsSince < windowLow
        ? 'earlier than window'
        : 'past typical window';
    timingFormula = `${Math.round(monthsSince)} mo since ${latestRound.type} (${latestRound.date ? String(latestRound.date).slice(0, 7) : 'undated'}) vs. benchmark median ${medianGap} mo (window ${windowLow}-${windowHigh} mo, ${windowStatus}, ${roundRank})`;
  }
  if (monthsSince !== null && monthsSince >= windowLow && monthsSince <= windowHigh) {
    triggers.push({
      kind: 'round_cadence_window',
      label: `Follow-on cadence window (${Math.round(monthsSince)}m post-${latestRound.type})`,
      detail: `${Math.round(monthsSince)}m since ${latestRound.type} (${latestRound.date ? String(latestRound.date).slice(0, 7) : 'undated'}) sits inside benchmark ${medianGap}m follow-on window [${windowLow}-${windowHigh}m].`,
      date: latestRound.date,
      sourceRank: deriveTopRankFromSources(latestRound.sourceIds || []),
      sourceIds: resolveValidSourceIds(latestRound.sourceIds || [], rounds, company)
    });
  }

  return {
    triggers,
    timingFormula,
    statusText: triggers.length > 0
      ? `${triggers.length} timing signal(s) active this week`
      : 'No immediate timing inflection detected in Cala'
  };
}

function buildWarmIntroForwardability(bridges = [], thesis = null) {
  const coInvestorLookup = new Map();
  for (const ci of thesis?.topCoInvestors || []) {
    const id = String(ci.id || ci.investorId || '').replace(/^inv-/, '');
    if (id) coInvestorLookup.set(id, ci);
  }
  const feederLookup = new Map();
  for (const f of thesis?.upstreamFeeders || []) {
    const id = String(f.id || f.investorId || '').replace(/^inv-/, '');
    if (id) feederLookup.set(id, f);
  }
  const fundName = thesis?.fundName || 'your benchmark fund';

  const enriched = bridges.map((p) => {
    let forwardability = 'Backchannel First';
    let reciprocityScore = 60;
    let reciprocityNote = 'Operator Backchannel First - off-record founder check before burning a partner intro';

    if (p.bridgeFamily === 'co_investor' || p.bridgeFamily === 'feeder') {
      const normalizedBridgeId = String(p.bridgeEntityId || '').replace(/^inv-/, '');
      const ci = coInvestorLookup.get(normalizedBridgeId);
      const feeder = feederLookup.get(normalizedBridgeId);
      const sharedCount = Math.max(ci?.sharedRounds || 0, feeder?.fedDealsCount || 0);
      if (p.isMegaHub) {
        forwardability = 'Low';
        reciprocityScore = 34;
        reciprocityNote = `Mega-hub syndicate (${p.totalDeals ?? 'high'} deals) - lower signal-to-noise; pair with founder context first`;
      } else if (p.hopKind === '2hop_syndicate') {
        forwardability = 'Medium';
        reciprocityScore = 64;
        reciprocityNote = `2-hop syndicate via ${p.intermediaryInvestor || 'direct peer'} (${p.intermediaryCompany || 'shared deal'}) - warm up intermediate GP first`;
      } else if (sharedCount >= 2) {
        forwardability = 'High';
        reciprocityScore = Math.min(96, 72 + sharedCount * 7);
        reciprocityNote = `${p.bridgeEntityName} co-invested with ${fundName} ${sharedCount}x (${p.lift ?? 1}x lift) - high forward likelihood`;
      } else if (sharedCount >= 1) {
        forwardability = 'High';
        reciprocityScore = 72;
        reciprocityNote = `${p.bridgeEntityName} shares 1 verified deal with ${fundName} (${p.lift ?? 1}x lift) - reliable partner intro path`;
      } else {
        forwardability = 'Medium';
        reciprocityScore = 54;
        reciprocityNote = `Indirect VC tie via ${p.bridgeEntityName} - confirm partner-level relationship before requesting forward`;
      }
    } else if (p.bridgeFamily === 'alumni_spinout') {
      forwardability = 'Backchannel First';
      reciprocityScore = p.topSourceRank === 'FILING' ? 78 : 66;
      reciprocityNote = `Operator Backchannel First - off-record check via ${p.bridgeEntityName} before burning a partner intro`;
    } else if (p.bridgeFamily === 'portfolio_twin') {
      forwardability = 'Backchannel First';
      reciprocityScore = 58;
      reciprocityNote = `Operator Backchannel First - compare ${p.twinCompanyName || 'portfolio twin'} buyer proof before partner outreach`;
    } else {
      forwardability = 'Low';
      reciprocityScore = 26;
      reciprocityNote = 'Event overlap only - build operator or syndicate context before cold outreach';
    }

    p.reciprocityScore = reciprocityScore;
    p.forwardability = forwardability;
    p.reciprocityNote = reciprocityNote;

    return {
      bridgeId: p.id,
      bridgeEntityName: p.bridgeEntityName,
      bridgeFamily: p.bridgeFamily,
      forwardability,
      reciprocityScore,
      reciprocityNote,
      hops: p.hops || [],
      topSourceRank: p.topSourceRank || 'AGGREGATOR',
      sourceIds: p.sourceIds || []
    };
  });

  return enriched.sort((a, b) => b.reciprocityScore - a.reciprocityScore || a.bridgeEntityName.localeCompare(b.bridgeEntityName));
}

function buildCallQuestionsFromGaps(company, visibleRounds, signals, conflictRisk, riskFlags, missingFromCala = []) {
  const questions = [];
  const rounds = visibleRounds || [];
  const latestRound = rounds[rounds.length - 1] || null;
  const latestFin = (signals?.visibleFinMetrics || [])[Math.max(0, (signals?.visibleFinMetrics || []).length - 1)] || null;
  const growthPct = signals?.headcountGrowthPct ?? null;

  const pushUnique = (item) => {
    if (!item?.question) return;
    if (questions.some((q) => q.category === item.category)) return;
    questions.push(item);
  };

  if (conflictRisk?.level === 'High' || conflictRisk?.level === 'Watch') {
    pushUnique({
      id: 'q-conflict',
      category: 'Portfolio Overlap',
      basedOnGap: `Portfolio ${conflictRisk.level}: ${conflictRisk.companyName}`,
      verifiedAnchor: `${company.sector} · ${company.country}`,
      question: `Portfolio check flagged ${conflictRisk.level} overlap with ${conflictRisk.companyName} (${conflictRisk.stage}) - clarify target ICP differentiation and channel conflict before partner intro.`
    });
  }

  if ((riskFlags || []).some((f) => f.id === 'press_only_provenance')) {
    pushUnique({
      id: 'q-filings',
      category: 'Statutory Verification',
      basedOnGap: '0 FILING/PRIMARY sources in Cala',
      verifiedAnchor: `${company.name} press/aggregator mentions`,
      question: 'Cala shows only PRESS/AGGREGATOR mentions for current entities - request official cap table extract and statutory registry filing confirmation prior to partner meeting.'
    });
  }

  for (const gap of missingFromCala) {
    const field = String(gap.field || '');
    if (/revenue|arr|burn/i.test(field)) {
      let verifiedAnchor = 'No statutory P&L indexed in Cala';
      let question = `Cala does not disclose revenue or burn for ${company.name} - verify current ARR, gross margin, net burn, and months of runway.`;
      if (latestFin && Number.isFinite(latestFin.cashEurM)) {
        verifiedAnchor = `Companies House #${company.companiesHouseNumber || 'filing'} (EUR ${latestFin.cashEurM}M cash)`;
        question = `UK filing confirms balance-sheet context (EUR ${latestFin.cashEurM}M cash, ~${latestFin.runwayMonthsEst}m runway) but omits revenue/ARR and burn - verify gross margin, NRR, and net burn.`;
      } else if (latestFin) {
        verifiedAnchor = `${latestFin.label || latestFin.metric} (${latestFin.value}${latestFin.unit ? ` ${latestFin.unit}` : ''})`;
        question = `Cala indexes ${latestFin.label || latestFin.metric} (${latestFin.value}${latestFin.unit ? ` ${latestFin.unit}` : ''}, ${latestFin.periodEnd || 'latest'}) - confirm current ARR, gross margin, and monthly burn.`;
      } else if (company?.registryInfo?.registrationNumber) {
        verifiedAnchor = `${company.registryInfo.registryName} #${company.registryInfo.registrationNumber}`;
        question = `${company.registryInfo.registryName} filing (#${company.registryInfo.registrationNumber}) confirms legal standing but omits revenue/ARR and burn - verify ARR, gross margin, and monthly burn.`;
      }
      pushUnique({
        id: 'q-unit-economics',
        category: 'ARR & Burn',
        basedOnGap: gap.field,
        verifiedAnchor,
        question
      });
    } else if (/valuation|vc funding/i.test(field)) {
      const roundTag = latestRound ? `${latestRound.type} (${latestRound.date ? String(latestRound.date).slice(0, 7) : 'undated'})` : null;
      const anchor = roundTag
        ? roundTag
        : company?.registryInfo?.registrationNumber
          ? `${company.registryInfo.registryName} (unfunded in Cala)`
          : 'No VC round valuation in Cala';
      const question = roundTag
        ? `${roundTag} lacks public valuation in Cala - confirm prior post-money valuation, total dilution, and upcoming round target.`
        : `No equity VC rounds are indexed in Cala - verify bootstrapped vs. angel capital raised, ownership table, and upcoming round timeline.`;
      pushUnique({
        id: 'q-valuation-rounds',
        category: 'Cap Table & Valuation',
        basedOnGap: gap.field,
        verifiedAnchor: anchor,
        question
      });
    } else if (/retention|churn/i.test(field)) {
      pushUnique({
        id: 'q-retention',
        category: 'Retention & Concentration',
        basedOnGap: gap.field,
        verifiedAnchor: `${company.sector} · ${company.country}`,
        question: `Cohort retention is not found in Cala filings - verify gross logo churn, net dollar retention (NDR), and top-3 customer revenue concentration.`
      });
    } else if (/employee growth/i.test(field)) {
      pushUnique({
        id: 'q-headcount',
        category: 'Hiring & Velocity',
        basedOnGap: gap.field,
        verifiedAnchor: `${company.employeeCount ?? 'Unknown'} current employees`,
        question: 'Fewer than 2 dated employee snapshots exist in Cala - walk through 12-month hiring pace, engineering vs. GTM split, and leadership attrition.'
      });
    } else if (/leadership|prior-role/i.test(field)) {
      pushUnique({
        id: 'q-leadership',
        category: 'Team Lineage',
        basedOnGap: gap.field,
        verifiedAnchor: 'People roles missing in Cala',
        question: 'Founder prior-company lineage is not indexed in Cala - confirm prior operating roles, co-founder equity split, and upcoming technical hires.'
      });
    } else if (/cheque/i.test(field)) {
      pushUnique({
        id: 'q-round-splits',
        category: 'Syndicate Ownership',
        basedOnGap: gap.field,
        verifiedAnchor: latestRound ? `${latestRound.type} round syndicate` : 'Syndicate splits undisclosed',
        question: `Individual investor cheque sizes are not disclosed in Cala - confirm lead investor ownership %, insider follow-on capacity, and allocation openness${growthPct >= 30 ? ` ahead of +${growthPct}% hiring ramp` : ''}.`
      });
    }
  }

  return questions.slice(0, 5);
}

export function buildAnalystDiligencePacket(
  company,
  thesis = null,
  signals = null,
  hiddenBridgesResult = null,
  evidenceFolders = null
) {
  const evalDate = thesis?.evalDate || REFERENCE_DATE;
  const visibleRounds = [...(company?.rounds || [])]
    .filter((r) => !thesis?.cutoffDate || r.date < thesis.cutoffDate)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const safeSignals = signals || extractCandidateSignals(company, visibleRounds, evalDate);
  const dataConfidence = evidenceFolders?.proofAndGaps
    ? {
        grade: evidenceFolders.proofAndGaps.dataConfidenceGrade,
        topSourceRank: evidenceFolders.proofAndGaps.topSourceRank
      }
    : computeDataConfidence(company, visibleRounds, safeSignals);
  const safeBridges = hiddenBridgesResult || extractHiddenBridges(thesis, company, visibleRounds, safeSignals, {
    hideMegaHubs: true,
    maxPaths: 5
  });
  const safeFolders = evidenceFolders || buildEvidenceFolders(company, visibleRounds, safeSignals, safeBridges, dataConfidence);
  const companyStage = visibleRounds[visibleRounds.length - 1]?.type
    || company?.stage
    || (company?.entityCategory === 'established_corp' ? 'Public / Mature' : 'Registered (Unfunded)');

  const { conflictRisk, synergisticTwin } = buildPortfolioConflictAndTwinCheck(company, thesis, companyStage, visibleRounds);
  const riskFlags = buildKillScreenRiskFlags(company, visibleRounds, safeSignals, safeBridges, safeFolders, dataConfidence, evalDate);
  const urgency = buildUrgencyTriggers(company, thesis, visibleRounds, safeSignals, evalDate);
  const warmIntroPaths = buildWarmIntroForwardability(safeFolders.hiddenBridges?.paths || safeBridges.bridges || [], thesis);
  const callQuestions = buildCallQuestionsFromGaps(
    company,
    visibleRounds,
    safeSignals,
    conflictRisk,
    riskFlags,
    safeFolders.proofAndGaps?.missingFromCala || []
  );

  return {
    triageNote: 'Deterministic analyst diligence packet for partner review only - never an Invest/Pass recommendation.',
    conflictRisk,
    synergisticTwin,
    riskFlags,
    urgencyTriggers: urgency.triggers,
    timingFormula: urgency.timingFormula,
    urgencyStatus: urgency.statusText,
    warmIntroPaths,
    callQuestions
  };
}

function extractDecisionCatalystsForStartup(
  thesis,
  rawCompany,
  item,
  visibleRounds = [],
  signals = null,
  directBridges = [],
  options = {}
) {
  const catalysts = [];
  if (options.bridgeFamily && options.bridgeFamily !== 'all') return catalysts;

  const contribFilter = options.contributionGroup || 'all';
  const filingOnly = Boolean(options.filingOnly);
  const evalDate = thesis?.evalDate || REFERENCE_DATE;

  const urgencyTriggers = item?.diligencePacket?.urgencyTriggers
    || buildUrgencyTriggers(rawCompany, thesis, visibleRounds, signals, evalDate).triggers
    || [];
  const riskFlags = item?.diligencePacket?.riskFlags || [];
  const conflictRisk = item?.diligencePacket?.conflictRisk || null;
  const nonTimingCount = directBridges.filter((b) => deriveContributionGroup(b) !== 'timing' && !b.isMegaHub).length;

  // TIMING CATALYSTS (Pre-Press Filing, Domain -> .ai, Hiring surge, Raise cadence window)
  if (contribFilter === 'all' || contribFilter === 'timing') {
    const filingTrig = urgencyTriggers.find((t) => t.kind === 'unannounced_filing');
    if (filingTrig) {
      const sourceIds = resolveValidSourceIds(filingTrig.sourceIds || [], visibleRounds, rawCompany);
      catalysts.push({
        id: 'cat:timing:pre-press-filing',
        catalystKind: 'pre_press_filing',
        contributionGroup: 'timing',
        bridgeFamily: 'event',
        label: 'Pre-Press Filing',
        topSourceRank: 'FILING',
        sourceIds,
        rarityScore: 34.5,
        lift: 1.85,
        totalDeals: null,
        whyMatters: filingTrig.detail || `${rawCompany.name} logged an unannounced statutory filing (${filingTrig.label}).`,
        formulaBreakdown: {
          formula: 'statutoryFilingEvent (unannouncedFiling === true) before press notice = timing lead',
          inputs: `${filingTrig.label} (${filingTrig.date ? String(filingTrig.date).slice(0, 7) : 'recent'}); FILING provenance`,
          plainMeaning: 'Statutory share/facility allotment precedes public round press announcements by weeks or months.'
        }
      });
    }

    const domainTrig = urgencyTriggers.find((t) => t.kind === 'domain_shift');
    if (domainTrig) {
      const sourceIds = resolveValidSourceIds(domainTrig.sourceIds || [], visibleRounds, rawCompany);
      const topRank = deriveTopRankFromSources(sourceIds, 'PRIMARY');
      if (!filingOnly || topRank === 'FILING') {
        catalysts.push({
          id: 'cat:timing:domain-ai',
          catalystKind: 'domain_shift',
          contributionGroup: 'timing',
          bridgeFamily: 'event',
          label: 'Domain -> .ai',
          topSourceRank: topRank,
          sourceIds,
          rarityScore: 22.0,
          lift: 1.4,
          totalDeals: null,
          whyMatters: domainTrig.detail || `${rawCompany.name} transitioned its active web domain to .ai.`,
          formulaBreakdown: {
            formula: 'activeDomain (.ai) + deprecated legacy domain = active AI repositioning trigger',
            inputs: `${domainTrig.label} (${domainTrig.date ? String(domainTrig.date).slice(0, 7) : 'active'}); ${topRank} rank`,
            plainMeaning: 'Observed product/domain upgrade typically precedes outbound commercial or round activity.'
          }
        });
      }
    }

    const growthPct = item?.headcountGrowthPct ?? signals?.headcountGrowthPct ?? 0;
    const growthTrig = urgencyTriggers.find((t) => t.kind === 'headcount_growth');
    const includeHiring = growthTrig && (
      contribFilter === 'timing'
        ? growthPct >= 30
        : (growthPct >= 70 || (growthPct >= 30 && !filingTrig && !domainTrig && nonTimingCount < 2))
    );
    if (includeHiring) {
      const sourceIds = resolveValidSourceIds(growthTrig.sourceIds || [], visibleRounds, rawCompany);
      const topRank = deriveTopRankFromSources(sourceIds, growthTrig.sourceRank || 'PRIMARY');
      if (!filingOnly || topRank === 'FILING') {
        const isHighSurge = growthPct >= 70;
        catalysts.push({
          id: isHighSurge ? 'cat:timing:hiring-70' : 'cat:timing:hiring-30',
          catalystKind: 'headcount_growth',
          contributionGroup: 'timing',
          bridgeFamily: 'event',
          label: isHighSurge ? 'Hiring +70%+' : 'Hiring +30%+',
          topSourceRank: topRank,
          sourceIds,
          rarityScore: isHighSurge ? 33.5 : 21.5,
          lift: Math.round((1 + Math.min(1.5, growthPct / 100)) * 100) / 100,
          totalDeals: null,
          whyMatters: `${rawCompany.name}: ${growthTrig.label} (${growthTrig.detail}).`,
          formulaBreakdown: {
            formula: '(currentEmp - empAtRound) / empAtRound * 100 >= 30% -> Hiring Momentum Catalyst',
            inputs: item?.evidenceFolders?.observedActivity?.velocityFormula || `+${growthPct}% post-round hiring velocity`,
            plainMeaning: 'Verifies rapid post-round team scaling from timestamped employee_count observations.'
          }
        });
      }
    }

    const cadenceTrig = urgencyTriggers.find((t) => t.kind === 'round_cadence_window');
    if (cadenceTrig && (contribFilter === 'timing' || (!filingTrig && !domainTrig && !includeHiring && nonTimingCount < 2))) {
      const sourceIds = resolveValidSourceIds(cadenceTrig.sourceIds || [], visibleRounds, rawCompany);
      const topRank = deriveTopRankFromSources(sourceIds, cadenceTrig.sourceRank || 'PRIMARY');
      if (!filingOnly || topRank === 'FILING') {
        catalysts.push({
          id: 'cat:timing:raise-window',
          catalystKind: 'round_cadence_window',
          contributionGroup: 'timing',
          bridgeFamily: 'event',
          label: 'Raise Window',
          topSourceRank: topRank,
          sourceIds,
          rarityScore: 16.0,
          lift: 1.2,
          totalDeals: null,
          whyMatters: cadenceTrig.detail || 'Sits inside benchmark follow-on cadence window.',
          formulaBreakdown: {
            formula: 'monthsSinceLastRound in [benchmarkMedianGap - 3, benchmarkMedianGap + 4]',
            inputs: item?.diligencePacket?.timingFormula || cadenceTrig.label,
            plainMeaning: 'Signals company has entered the historical interval when peer founders initiate next financing.'
          }
        });
      }
    }
  }

  // CAUTION CATALYSTS (Portfolio Conflicts, Press-Only Proof, No Warm Intro)
  if (contribFilter === 'all' || contribFilter === 'caution') {
    const isHighConflict = conflictRisk && conflictRisk.level === 'High';
    const isWatchConflict = conflictRisk && conflictRisk.level === 'Watch' && contribFilter === 'caution';
    if (isHighConflict || isWatchConflict) {
      const sourceIds = resolveValidSourceIds([], visibleRounds, rawCompany);
      const topRank = deriveTopRankFromSources(sourceIds, item?.dataConfidence?.topSourceRank || 'PRIMARY');
      if (!filingOnly || topRank === 'FILING') {
        catalysts.push({
          id: isHighConflict ? 'cat:caution:portfolio-conflict' : 'cat:caution:watch-overlap',
          catalystKind: 'conflict_risk',
          contributionGroup: 'caution',
          bridgeFamily: 'portfolio_twin',
          label: isHighConflict ? 'Portfolio Conflict' : 'Sector Overlap',
          topSourceRank: topRank,
          sourceIds,
          rarityScore: isHighConflict ? 35.0 : 19.5,
          lift: null,
          totalDeals: null,
          whyMatters: conflictRisk.reason || `${conflictRisk.level} overlap with portfolio company ${conflictRisk.companyName}.`,
          formulaBreakdown: {
            formula: 'exactSector && (sharedSubSector || sameCountry) && stageDistance <= 1 -> Conflict Check',
            inputs: `${conflictRisk.level} vs. ${conflictRisk.companyName || 'portfolio company'} (${rawCompany.sector}, ${rawCompany.country})`,
            plainMeaning: 'Flags existing portfolio overlap so partner team clears non-compete/thesis conflict before outreach.'
          }
        });
      }
    }

    const pressFlag = riskFlags.find((f) => f.id === 'press_only_provenance');
    if (pressFlag && !filingOnly) {
      const sourceIds = resolveValidSourceIds(pressFlag.sourceIds || [], visibleRounds, rawCompany);
      catalysts.push({
        id: 'cat:caution:press-only',
        catalystKind: 'press_only_warning',
        contributionGroup: 'caution',
        bridgeFamily: 'event',
        label: 'Press-Only Proof',
        topSourceRank: 'PRESS',
        sourceIds,
        rarityScore: 18.0,
        lift: null,
        totalDeals: null,
        whyMatters: pressFlag.detail,
        formulaBreakdown: {
          formula: 'filingsCount === 0 && primaryCount === 0 -> Press / Aggregator Only Caution',
          inputs: `Top rank ${item?.dataConfidence?.topSourceRank || 'PRESS'}; 0 FILING/PRIMARY records`,
          plainMeaning: 'Warns analyst that claims rely only on press/aggregator coverage and lack statutory filing verification.'
        }
      });
    }

    const noWarmFlag = riskFlags.find((f) => f.id === 'mega_hub_only_bridge');
    if (noWarmFlag) {
      const sourceIds = resolveValidSourceIds(noWarmFlag.sourceIds || [], visibleRounds, rawCompany);
      const topRank = deriveTopRankFromSources(sourceIds, item?.dataConfidence?.topSourceRank || 'PRIMARY');
      if (!filingOnly || topRank === 'FILING') {
        catalysts.push({
          id: 'cat:caution:no-warm-intro',
          catalystKind: 'no_warm_intro',
          contributionGroup: 'caution',
          bridgeFamily: 'co_investor',
          label: 'No Warm Intro',
          topSourceRank: topRank,
          sourceIds,
          rarityScore: 31.0,
          lift: null,
          totalDeals: null,
          whyMatters: noWarmFlag.detail,
          formulaBreakdown: {
            formula: 'nonMegaInvestorOrAlumniBridges === 0 -> Backchannel Required',
            inputs: '0 boutique VC/alumni bridges indexed (mega-hubs filtered); verify direct intro',
            plainMeaning: 'Highlights targets lacking a boutique feeder or alumni backchannel despite thesis fit.'
          }
        });
      }
    }
  }

  return catalysts;
}

export function buildBridgeMapPayload(thesis, shortlist = [], options = {}) {
  const maxStartups = Math.max(1, Math.min(12, Number(options.maxStartups) || 12));
  const maxPaths = Math.max(1, Math.min(6, Number(options.maxPaths) || 4));
  const hideMegaHubs = options.hideMegaHubs !== undefined ? Boolean(options.hideMegaHubs) : true;
  const rawFamily = String(options.bridgeFamily || 'all').trim().toLowerCase();
  const bridgeFamily = BRIDGE_FAMILY_META[rawFamily] ? rawFamily : 'all';
  const rawContrib = String(options.contributionGroup || 'all').trim().toLowerCase();
  const contributionGroup = CONTRIBUTION_GROUP_META[rawContrib] ? rawContrib : 'all';
  const filingOnly = Boolean(options.filingOnly);

  const anchor = {
    id: thesis?.fundId || 'query-anchor',
    label: thesis?.fundName || 'Search Strategy Anchor',
    kind: 'anchor',
    contributionGroup: 'all'
  };

  const nodeMap = new Map();
  nodeMap.set(anchor.id, { ...anchor });

  const edges = [];
  const seenEdgeIds = new Set();
  const renderedBridgeNodeIds = new Set();
  const clusterStats = {
    feeder: { bridgeNodeIds: new Set(), edgeCount: 0 },
    co_investor: { bridgeNodeIds: new Set(), edgeCount: 0 },
    alumni_spinout: { bridgeNodeIds: new Set(), edgeCount: 0 },
    portfolio_twin: { bridgeNodeIds: new Set(), edgeCount: 0 },
    event: { bridgeNodeIds: new Set(), edgeCount: 0 }
  };
  const contribStats = {
    access: { bridgeNodeIds: new Set(), startupIds: new Set(), edgeCount: 0 },
    lineage: { bridgeNodeIds: new Set(), startupIds: new Set(), edgeCount: 0 },
    timing: { bridgeNodeIds: new Set(), startupIds: new Set(), edgeCount: 0 },
    caution: { bridgeNodeIds: new Set(), startupIds: new Set(), edgeCount: 0 }
  };

  let suppressedMegaHubCount = 0;
  const displayed = (shortlist || []).slice(0, maxStartups);
  const globalIndex = buildGlobalRoundIndex(thesis?.evalDate || null);

  for (let itemIdx = 0; itemIdx < displayed.length; itemIdx++) {
    const item = displayed[itemIdx];
    const rawCompany = COMPANIES.find((c) => c.id === item.id) || {
      ...item,
      rounds: item.rounds || item.roundHistory || []
    };
    const visibleRounds = [...(rawCompany.rounds || [])];
    const signals = extractCandidateSignals(rawCompany, visibleRounds, thesis?.evalDate || REFERENCE_DATE, null, item.coInvestorPath || null);
    const bridgeResult = extractHiddenBridges(thesis, rawCompany, visibleRounds, signals, {
      hideMegaHubs,
      bridgeFamily: bridgeFamily === 'all' ? null : bridgeFamily,
      contributionGroup: contributionGroup === 'all' ? null : contributionGroup,
      filingOnly,
      maxPaths,
      globalIndex
    });

    suppressedMegaHubCount += bridgeResult.suppressedMegaHubCount || 0;

    const topBridge = bridgeResult.bridges?.[0] || null;
    const twoHopBridge = bridgeResult.bridges?.find((b) => b.hopKind === '2hop_syndicate');
    const biAlumniBridge = bridgeResult.bridges?.find((b) => b.hopKind === 'bidirectional_alumni');
    const unannouncedEv = (signals?.visibleCorpEvents || []).find((ev) => ev.unannouncedFiling);
    const twinBridge = bridgeResult.bridges?.find((b) => b.bridgeFamily === 'portfolio_twin');
    const growthPctVal = item.headcountGrowthPct ?? signals?.headcountGrowthPct ?? 0;
    let primaryInsight = '';
    if (twoHopBridge?.intermediaryInvestor) {
      primaryInsight = `2-Hop via ${twoHopBridge.intermediaryInvestor}`;
    } else if (biAlumniBridge?.relatedStartupName) {
      primaryInsight = `Alumni -> ${biAlumniBridge.relatedStartupName}`;
    } else if (signals?.alumniSpinout?.priorCompany) {
      const priorShort = signals.alumniSpinout.priorCompany.split(' ')[0];
      primaryInsight = `Ex-${priorShort}${unannouncedEv ? ' · Filing' : ''}`;
    } else if (unannouncedEv) {
      primaryInsight = 'Pre-Press Filing';
    } else if (growthPctVal >= 50) {
      primaryInsight = `+${growthPctVal}% team`;
    } else if (twinBridge?.twinCompanyName) {
      primaryInsight = `Twin: ${twinBridge.twinCompanyName}`;
    } else if (topBridge) {
      primaryInsight = topBridge.bridgeEntityName;
    }

    if (!nodeMap.has(item.id)) {
      nodeMap.set(item.id, {
        id: item.id,
        label: item.name,
        kind: 'startup',
        startupId: item.id,
        triageRank: itemIdx + 1,
        contributionGroup: topBridge ? deriveContributionGroup(topBridge) : (item?.diligencePacket?.conflictRisk?.level === 'High' ? 'caution' : ((item?.diligencePacket?.urgencyTriggers || []).length ? 'timing' : 'access')),
        signalTier: item.signalTier || computeSignalTier({
          bridges: bridgeResult.bridges,
          dataConfidence: item.dataConfidence,
          urgencyTriggers: item.diligencePacket?.urgencyTriggers,
          suitabilityScore: item.suitabilityScore
        }),
        suitabilityScore: item.suitabilityScore ?? null,
        matchOrderFormula: item.matchOrderFormula || null,
        sector: item.sector,
        country: item.country,
        stage: item.stage,
        topSourceRank: item.dataConfidence?.topSourceRank || 'AGGREGATOR',
        headcountGrowthPct: item.headcountGrowthPct ?? null,
        missingGapCount: (item.evidenceFolders?.proofAndGaps?.missingFromCala || []).length,
        primaryInsight,
        bestBridgeSummary: topBridge?.summary || null,
        bestBridgeFormula: topBridge?.formulaBreakdown || null,
        bestBridgeHops: topBridge?.hops || null,
        velocityFormula: item.evidenceFolders?.observedActivity?.velocityFormula || null,
        timingFormula: item.diligencePacket?.timingFormula || null,
        conflictRisk: item.diligencePacket?.conflictRisk || null,
        riskFlagsCount: (item.diligencePacket?.riskFlags || []).length,
        topRiskFlag: item.diligencePacket?.riskFlags?.[0] || null,
        isSlush: Boolean(rawCompany.attendingSlush2026 || item.attendingSlush2026),
        hasUnannouncedFiling: Boolean(unannouncedEv)
      });
    }

    const catalysts = extractDecisionCatalystsForStartup(
      thesis,
      rawCompany,
      item,
      visibleRounds,
      signals,
      bridgeResult.bridges || [],
      { bridgeFamily, contributionGroup, filingOnly }
    );

    const combinedEntries = [
      ...(bridgeResult.bridges || []).map((bridge) => ({
        bridgeNodeId: `bridge:${bridge.bridgeFamily}:${bridge.bridgeEntityId || slugifyBridgeId(bridge.bridgeEntityName)}`,
        label: bridge.bridgeEntityName,
        bridgeFamily: bridge.bridgeFamily,
        contributionGroup: deriveContributionGroup(bridge),
        catalystKind: bridge.isMegaHub ? 'mega_hub' : null,
        bridgeId: bridge.id,
        hopKind: bridge.hopKind || null,
        hopVia: bridge.intermediaryInvestor || bridge.twinCompanyName || null,
        whyMatters: bridge.whyMatters || bridge.whyLookDelta || null,
        topSourceRank: bridge.topSourceRank,
        sourceIds: bridge.sourceIds || [],
        date: bridge.date || null,
        isMegaHub: Boolean(bridge.isMegaHub),
        verifiedAnchorConnection: bridge.verifiedAnchorConnection !== false,
        totalDeals: bridge.totalDeals ?? null,
        lift: bridge.lift,
        rarityScore: bridge.rarityScore,
        formulaBreakdown: bridge.formulaBreakdown || null,
        edgeLabel: bridge.hopKind === '2hop_syndicate' && bridge.intermediaryInvestor
          ? `2-Hop via ${bridge.intermediaryInvestor}`
          : bridge.totalDeals
            ? `${bridge.lift}x lift (${bridge.totalDeals}d)`
            : (BRIDGE_FAMILY_META[bridge.bridgeFamily]?.label || bridge.bridgeFamily),
        targetEdgeLabel: bridge.summary,
        countTowardsFamilyCluster: true
      })),
      ...catalysts.map((cat) => ({
        bridgeNodeId: cat.id,
        label: cat.label,
        bridgeFamily: cat.bridgeFamily,
        contributionGroup: cat.contributionGroup,
        catalystKind: cat.catalystKind,
        bridgeId: `${cat.id}-${item.id}`,
        hopKind: 'decision_catalyst',
        hopVia: null,
        whyMatters: cat.whyMatters,
        topSourceRank: cat.topSourceRank,
        sourceIds: cat.sourceIds || [],
        date: null,
        isMegaHub: false,
        verifiedAnchorConnection: false,
        totalDeals: null,
        lift: cat.lift,
        rarityScore: cat.rarityScore,
        formulaBreakdown: cat.formulaBreakdown,
        edgeLabel: cat.label,
        targetEdgeLabel: cat.whyMatters,
        countTowardsFamilyCluster: false
      }))
    ];

    for (const entry of combinedEntries) {
      const fam = entry.bridgeFamily;
      const grp = entry.contributionGroup;
      const famMeta = BRIDGE_FAMILY_META[fam] || { id: `cluster-${fam}`, label: fam };
      const bridgeNodeId = entry.bridgeNodeId;

      if (!nodeMap.has(bridgeNodeId)) {
        nodeMap.set(bridgeNodeId, {
          id: bridgeNodeId,
          label: entry.label,
          kind: 'bridge',
          bridgeFamily: fam,
          contributionGroup: grp,
          catalystKind: entry.catalystKind || null,
          isCatalyst: Boolean(entry.catalystKind),
          hopKind: entry.hopKind || null,
          hopVia: entry.hopVia || null,
          whyMatters: entry.whyMatters || null,
          clusterId: CONTRIBUTION_GROUP_META[grp]?.id || famMeta.id,
          clusterSubtitle: CONTRIBUTION_GROUP_META[grp]?.subtitle || famMeta.subtitle || null,
          topSourceRank: entry.topSourceRank,
          sourceIds: entry.sourceIds || [],
          date: entry.date || null,
          isMegaHub: Boolean(entry.isMegaHub),
          totalDeals: entry.totalDeals ?? null,
          lift: entry.lift,
          rarityScore: entry.rarityScore ?? null,
          formulaBreakdown: entry.formulaBreakdown || null
        });
      } else {
        const existingNode = nodeMap.get(bridgeNodeId);
        if ((entry.rarityScore ?? -999) > (existingNode.rarityScore ?? -999)) {
          existingNode.rarityScore = entry.rarityScore ?? existingNode.rarityScore;
          existingNode.lift = entry.lift ?? existingNode.lift;
        }
        if ((SOURCE_RANK_PRIORITY[entry.topSourceRank] || 0) > (SOURCE_RANK_PRIORITY[existingNode.topSourceRank] || 0)) {
          existingNode.topSourceRank = entry.topSourceRank;
        }
      }
      renderedBridgeNodeIds.add(bridgeNodeId);
      if (entry.countTowardsFamilyCluster && clusterStats[fam]) clusterStats[fam].bridgeNodeIds.add(bridgeNodeId);
      if (contribStats[grp]) contribStats[grp].bridgeNodeIds.add(bridgeNodeId);

      // An entity's own fact is useful evidence, but it is not a connection to
      // the focal entity unless Cala verifies that first hop.
      const edgeCitation = resolveMapEdgeEvidenceSources(entry.sourceIds);
      const trunkEdgeId = `edge:${anchor.id}:${bridgeNodeId}`;
      if (entry.verifiedAnchorConnection && !seenEdgeIds.has(trunkEdgeId)) {
        seenEdgeIds.add(trunkEdgeId);
        edges.push({
          id: trunkEdgeId,
          from: anchor.id,
          to: bridgeNodeId,
          bridgeId: entry.bridgeId,
          bridgeFamily: fam,
          contributionGroup: grp,
          catalystKind: entry.catalystKind || null,
          isCatalyst: Boolean(entry.catalystKind),
          hopKind: entry.hopKind || null,
          whyMatters: entry.whyMatters || null,
          formulaBreakdown: entry.formulaBreakdown || null,
          rarityScore: entry.rarityScore,
          topSourceRank: entry.topSourceRank,
          sourceIds: entry.sourceIds,
          evidenceSources: edgeCitation.evidenceSources,
          sourceCount: edgeCitation.sourceCount,
          date: entry.date || null,
          label: entry.edgeLabel
        });
        if (entry.countTowardsFamilyCluster && clusterStats[fam]) clusterStats[fam].edgeCount += 1;
        if (contribStats[grp]) contribStats[grp].edgeCount += 1;
      }

      // Bridge -> Startup target edge
      const targetEdgeId = `edge:${bridgeNodeId}:${item.id}`;
      if (!seenEdgeIds.has(targetEdgeId)) {
        seenEdgeIds.add(targetEdgeId);
        edges.push({
          id: targetEdgeId,
          from: bridgeNodeId,
          to: item.id,
          bridgeId: entry.bridgeId,
          bridgeFamily: fam,
          contributionGroup: grp,
          catalystKind: entry.catalystKind || null,
          isCatalyst: Boolean(entry.catalystKind),
          hopKind: entry.hopKind || null,
          whyMatters: entry.whyMatters || null,
          formulaBreakdown: entry.formulaBreakdown || null,
          rarityScore: entry.rarityScore,
          topSourceRank: entry.topSourceRank,
          sourceIds: entry.sourceIds,
          evidenceSources: edgeCitation.evidenceSources,
          sourceCount: edgeCitation.sourceCount,
          date: entry.date || null,
          label: entry.targetEdgeLabel
        });
        if (entry.countTowardsFamilyCluster && clusterStats[fam]) clusterStats[fam].edgeCount += 1;
        if (contribStats[grp]) {
          contribStats[grp].edgeCount += 1;
          contribStats[grp].startupIds.add(item.id);
        }
      }
    }

    // Recompute startup primary contributionGroup and bestBridgeFormula from its highest-rarity incident edge
    const startupNode = nodeMap.get(item.id);
    if (startupNode) {
      const incident = edges
        .filter((e) => e.to === item.id)
        .sort((a, b) => (b.rarityScore || 0) - (a.rarityScore || 0));
      if (incident[0]?.contributionGroup) {
        startupNode.contributionGroup = incident[0].contributionGroup;
        if (contribStats[startupNode.contributionGroup]) {
          contribStats[startupNode.contributionGroup].startupIds.add(item.id);
        }
      }
      if (!startupNode.bestBridgeFormula && incident[0]?.formulaBreakdown) {
        startupNode.bestBridgeFormula = incident[0].formulaBreakdown;
      }
    }
  }

  const peerEdges = buildPeerEdgesForShortlist(displayed, globalIndex).filter(
    (pe) => nodeMap.has(pe.from) && nodeMap.has(pe.to)
  );

  const clusters = Object.entries(BRIDGE_FAMILY_META).map(([fam, meta]) => ({
    id: meta.id,
    bridgeFamily: fam,
    label: meta.label,
    subtitle: meta.subtitle || '',
    nodeCount: clusterStats[fam]?.bridgeNodeIds.size || 0,
    edgeCount: clusterStats[fam]?.edgeCount || 0
  }));

  const distinctBridgeNodes = [...nodeMap.values()].filter((n) => n.kind === 'bridge');
  const startupIdsByGroup = {
    access: contribStats.access.startupIds,
    lineage: contribStats.lineage.startupIds,
    timing: contribStats.timing.startupIds,
    caution: contribStats.caution.startupIds
  };
  const contribWeights = computeContributionClusterWeights(distinctBridgeNodes, startupIdsByGroup);

  const contributionClusters = Object.values(CONTRIBUTION_GROUP_META).map((meta) => {
    const w = contribWeights[meta.group] || {
      significanceScore: 0,
      visualWeight: 0.6,
      topRarity: 0,
      top3MeanRarity: 0,
      filingVerifiedCount: 0,
      filingCount: 0,
      filingBonus: 0,
      startupCount: 0,
      significanceFormula: 'topSignalRarity + mean(top3Bridges) + min(4.5, FILING_count * 1.5)',
      significanceInputs: 'Top: 0.0 + Top3 avg: 0.0 + 0 FILING (+0.0) = 0.0 pts',
      topContributors: []
    };
    const sCount = w.startupCount ?? contribStats[meta.group]?.startupIds?.size ?? 0;
    const fCount = w.filingCount ?? w.filingVerifiedCount ?? 0;
    return {
      id: meta.id,
      group: meta.group,
      contributionGroup: meta.group,
      label: meta.label,
      subtitle: meta.subtitle,
      nodeCount: contribStats[meta.group]?.bridgeNodeIds.size || 0,
      edgeCount: contribStats[meta.group]?.edgeCount || 0,
      startupCount: sCount,
      filingCount: fCount,
      significanceScore: w.significanceScore,
      visualWeight: w.visualWeight,
      topRarity: w.topRarity,
      top3MeanRarity: w.top3MeanRarity,
      filingVerifiedCount: w.filingVerifiedCount,
      filingBonus: w.filingBonus,
      significanceFormula: w.significanceFormula,
      significanceInputs: w.significanceInputs,
      topContributors: w.topContributors || []
    };
  });

  return {
    anchor,
    clusters,
    contributionClusters,
    nodes: [...nodeMap.values()],
    edges,
    peerEdges,
    stats: {
      renderedStartups: displayed.length,
      renderedBridges: renderedBridgeNodeIds.size,
      renderedPeerEdges: peerEdges.length,
      suppressedMegaHubCount,
      hideMegaHubsApplied: hideMegaHubs
    }
  };
}

const ENTITY_MAP_RELATION_META = {
  PARTNERED_WITH: { label: 'Partnered with', group: 'access', family: 'co_investor' },
  SUPPLIES: { label: 'Supplies', group: 'access', family: 'co_investor' },
  SUPPLIED_BY: { label: 'Supplied by', group: 'access', family: 'co_investor' },
  INVESTED_IN: { label: 'Invested in', group: 'access', family: 'co_investor' },
  CO_INVESTED_WITH: { label: 'Co-invested with', group: 'access', family: 'co_investor' },
  ADVISED: { label: 'Advised', group: 'access', family: 'co_investor' },
  FOUNDED: { label: 'Founded', group: 'lineage', family: 'alumni_spinout' },
  CO_FOUNDED: { label: 'Co-founded', group: 'lineage', family: 'alumni_spinout' },
  IS_CEO_OF: { label: 'Leads as CEO of', group: 'lineage', family: 'alumni_spinout' },
  IS_CTO_OF: { label: 'Leads as CTO of', group: 'lineage', family: 'alumni_spinout' },
  IS_CFO_OF: { label: 'Serves as CFO of', group: 'lineage', family: 'alumni_spinout' },
  IS_COO_OF: { label: 'Serves as COO of', group: 'lineage', family: 'alumni_spinout' },
  IS_CSO_OF: { label: 'Serves as CSO of', group: 'lineage', family: 'alumni_spinout' },
  IS_CRO_OF: { label: 'Serves as CRO of', group: 'lineage', family: 'alumni_spinout' },
  IS_CMO_OF: { label: 'Serves as CMO of', group: 'lineage', family: 'alumni_spinout' },
  IS_CCO_OF: { label: 'Serves as CCO of', group: 'lineage', family: 'alumni_spinout' },
  IS_VICEPRESIDENT_OF: { label: 'Served as VP at', group: 'lineage', family: 'alumni_spinout' },
  IS_PRESIDENT_OF: { label: 'Served as President of', group: 'lineage', family: 'alumni_spinout' },
  IS_CHAIR_OF: { label: 'Chairs', group: 'lineage', family: 'alumni_spinout' },
  IS_BOARD_MEMBER_OF: { label: 'Serves on the board of', group: 'lineage', family: 'alumni_spinout' },
  WORKS_AT: { label: 'Works at', group: 'lineage', family: 'alumni_spinout' },
  IS_MEMBER_OF: { label: 'Is a member of', group: 'lineage', family: 'alumni_spinout' },
  IS_SUBSIDIARY_OF: { label: 'Is a subsidiary of', group: 'lineage', family: 'portfolio_twin' },
  IS_DIRECT_PARENT_OF: { label: 'Direct parent of', group: 'lineage', family: 'portfolio_twin' },
  IS_ULTIMATE_PARENT_OF: { label: 'Ultimate parent of', group: 'lineage', family: 'portfolio_twin' },
  IS_CONTROL_PERSON_OF: { label: 'Control person of', group: 'lineage', family: 'portfolio_twin' },
  SPUN_OUT_OF: { label: 'Spun out of', group: 'lineage', family: 'alumni_spinout' },
  ACQUIRED: { label: 'Acquired', group: 'caution', family: 'portfolio_twin' },
  COMPETES_WITH: { label: 'Competes with', group: 'caution', family: 'portfolio_twin' },
  PARTICIPATES_IN_FUNDING_ROUND: { label: 'Participated in funding round', group: 'timing', family: 'event' },
  HAS_FUNDING_ROUND: { label: 'Has funding round', group: 'timing', family: 'event' },
  PARTICIPATES_IN_CORPORATE_EVENT: { label: 'Participated in corporate event', group: 'timing', family: 'event' },
  PARTICIPATES_IN_EVENT: { label: 'Participated in event', group: 'timing', family: 'event' }
};

const ENTITY_MAP_STATIC_RELATIONS = new Set([
  'HAS_HEADQUARTERS_IN',
  'HAS_PRESENCE_IN',
  'IS_REGISTERED_IN',
  'OPERATES_IN_INDUSTRY',
  'HAS_NATIONALITY',
  'STUDIED_AT',
  'SPOKE_AT',
  'FEATURED_IN',
  'RECEIVED_AWARD',
  'PUBLISHED_BY',
  'DESIGNED_BY',
  'CREATED_BY',
  'MANUFACTURED_BY',
  'OPERATED_BY',
  'TRADED_ON',
  'LISTED_ON',
  'IS_BENEFICIARY_OWNER_OF'
]);

const ENTITY_MAP_SYMMETRIC_RELATIONS = new Set(['PARTNERED_WITH', 'COMPETES_WITH', 'CO_INVESTED_WITH']);
const ROUND_AND_EVENT_RELATIONS = new Set([
  'PARTICIPATES_IN_FUNDING_ROUND',
  'HAS_FUNDING_ROUND',
  'PARTICIPATES_IN_CORPORATE_EVENT',
  'PARTICIPATES_IN_EVENT',
  'IS_TRANCHE_OF'
]);

const GENERIC_CONTAINER_NAMES = new Set([
  'results',
  'other material',
  'other material event',
  'results or trading update',
  'form 10 k',
  'form 10 q',
  'form 8 k',
  'form s 1',
  'form d',
  'current report',
  'annual report',
  'quarterly report',
  'shareholder vote',
  'management or board change',
  'financing raised',
  'financing raised or facility entered',
  'corporate event',
  'earnings release'
]);

const PRIORITY_MAP_RELATIONS = new Set([
  'INVESTED_IN',
  'CO_INVESTED_WITH',
  'PARTNERED_WITH',
  'SUPPLIES',
  'SUPPLIED_BY',
  'FOUNDED',
  'CO_FOUNDED',
  'IS_CEO_OF',
  'IS_CTO_OF',
  'IS_VICEPRESIDENT_OF',
  'IS_BOARD_MEMBER_OF',
  'ACQUIRED',
  'COMPETES_WITH'
]);

function canonicalMapEntityName(name = '') {
  let key = normalizeLookupName(name);
  const suffixRe = /\s+(?:pbc|inc|incorporated|corp|corporation|ltd|limited|llc|llp|lp|plc|gmbh|ag|oyj|oy|ab|sa|sas|bv|nv|co)$/;
  while (suffixRe.test(key)) {
    const stripped = key.replace(suffixRe, '').trim();
    if (stripped.length < 2) break;
    key = stripped;
  }
  return key;
}

function isHonorificPersonStub(entity = {}) {
  const type = entityMapType(entity).toLowerCase();
  if (type !== 'person') return false;
  return /^(?:mr|ms|mrs|mx|dr|prof)\.?\s+[a-z][a-z'-]*$/i.test(String(entity.name || '').trim());
}

function isFundingRoundEntity(entity = {}) {
  const type = entityMapType(entity).toLowerCase();
  return type === 'fundinground' || type === 'privatecompanyfundinground' || type === 'fundingroundtranche';
}

function isLikelyInvestorEntity(entity = {}) {
  const type = entityMapType(entity).toLowerCase();
  if (type === 'fund') return true;
  const raw = String(entity.name || '');
  return /\b(?:venture(?:s| partners)?|capital|partners|investments?|asset management|management|fund(?:s)?|holdings?|equity|endowment|sequoia|catalyst|lightspeed|greenoaks|blackstone|blackrock|fidelity|baillie gifford|dst global|thrive|softbank|gic|mgx|menlo|bessemer|coatue|benchmark|accel|greylock|founders fund|khosla|index ventures|insight partners|tiger global|a16z|andreessen|t\.?\s*rowe price|g42|temasek|dragoneer|altimeter|iconiq|spark|y combinator|falcon edge|appaloosa|d\.?\s*e\.?\s*shaw|sands capital|3 comma|flat capital|alpha wave|a capital)\b/i.test(raw);
}

function isStrategicCorporateInvestor(entity = {}) {
  const canon = canonicalMapEntityName(entity?.name || '');
  if (!canon) return false;
  return /^(?:nvidia|amazon|amazon com|microsoft|alphabet|google|softbank|oracle|cisco|cisco systems|salesforce|intel|qualcomm|amd|apple|meta|samsung|sap|servicenow)$/.test(canon);
}

function investorHierarchyScore(entity = {}) {
  if (isLikelyInvestorEntity(entity)) return 3;
  if (isStrategicCorporateInvestor(entity)) return 2;
  return 0;
}

const LOCATION_ENTITY_NAMES = new Set([
  'united states', 'usa', 'us', 'united kingdom', 'uk', 'great britain', 'canada', 'germany',
  'france', 'finland', 'sweden', 'norway', 'denmark', 'estonia', 'switzerland', 'netherlands',
  'japan', 'china', 'india', 'singapore', 'israel', 'australia', 'europe', 'north america', 'asia'
]);

function isLocationOrCountryEntity(entity = {}) {
  const type = entityMapType(entity).toLowerCase();
  if (['location', 'country', 'city', 'region', 'state', 'geography', 'place'].includes(type)) return true;
  const canon = canonicalMapEntityName(entity?.name || '');
  return LOCATION_ENTITY_NAMES.has(canon);
}

function isMembershipConsortiumEntity(entity = {}) {
  const raw = String(entity?.name || '');
  return /\b(?:foundation|association|consortium|alliance|initiative|collective|institute|accelerator|incubator|forum|conference|code of practice|y combinator|linux)\b/i.test(raw);
}

function isGenericEventContainerNode(entity = {}, relationType = '') {
  if (isFundingRoundEntity(entity)) return true;
  const type = entityMapType(entity).toLowerCase();
  if (type === 'corporateevent' || type === 'event') return true;
  const rawName = String(entity.name || '').trim();
  const norm = normalizeLookupName(rawName);
  if (GENERIC_CONTAINER_NAMES.has(norm)) return true;
  if (/^(?:RESULTS_OR_TRADING_UPDATE|OTHER_MATERIAL_EVENT|SHAREHOLDER_VOTE|MANAGEMENT_OR_BOARD_CHANGE|FINANCING_RAISED_OR_FACILITY_ENTERED|MATERIAL_AGREEMENT_ANNOUNCED|CORPORATE_EVENT|EARNINGS_RELEASE)(?:_|$)/i.test(rawName)) {
    return true;
  }
  if (/^(?:form\s+(?:10-[kq]|8-k|6-k|20-f|s-1|d)|current report|annual report|quarterly report|prospectus|registration statement)\b/i.test(rawName)) {
    return true;
  }
  if (ROUND_AND_EVENT_RELATIONS.has(relationType) &&
      /^(?:pre[- ]?seed|seed|angel|series [a-z0-9+]+|growth|late[- ]?stage|venture|bridge|convertible|debt|ipo|spac|secondary|grant|undisclosed|unknown)(?:\s+round)?$/i.test(rawName)) {
    return true;
  }
  return false;
}

function resolveEntityMapRelationMeta(relationType = '') {
  const key = String(relationType || '').trim();
  if (!key || ENTITY_MAP_STATIC_RELATIONS.has(key)) return null;
  if (ENTITY_MAP_RELATION_META[key]) return ENTITY_MAP_RELATION_META[key];

  let words = key.split('_').filter(Boolean).map((w) => w.toLowerCase());
  if (words[0] === 'is' && words.length >= 3 && words[words.length - 1] === 'of') {
    words = words.slice(1);
  }
  const phrase = words.join(' ');
  const label = phrase ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : 'Related to';

  let group = 'access';
  let family = 'co_investor';
  if (/COMPET|LAWSUIT|LITIG|SUED|REGULAT|SANCTION|AFFECT|RISK|CONFLICT|DEBT|BANKRUPT|INVESTIGAT|TERMINAT|ACQUIR|MERG/i.test(key)) {
    group = 'caution';
    family = 'portfolio_twin';
  } else if (/ROUND|EVENT|FILING|IPO|LIST|ANNOUNCE|LAUNCH|DIVIDEND|TRANCHE|EXPIRE/i.test(key)) {
    group = 'timing';
    family = 'event';
  } else if (/FOUND|CEO|CTO|CFO|COO|CMO|CRO|CSO|EXEC|BOARD|CHAIR|WORK|ALUM|EMPLOY|PARENT|SUBSIDIAR|OWN|CONTROL|MEMBER|SPIN|AFFILIAT/i.test(key)) {
    group = 'lineage';
    family = 'alumni_spinout';
  }
  return { label, group, family };
}

function formatCompactRoundValue(amount, units = 'USD') {
  const num = Number(amount);
  if (!Number.isFinite(num) || num <= 0) return '';
  const sym = /eur/i.test(String(units || '')) ? 'EUR ' : '$';
  if (num >= 1e9) return `${sym}${(num / 1e9).toFixed(num >= 10e9 ? 0 : 1)}B`;
  if (num >= 1e6) return `${sym}${(num / 1e6).toFixed(num >= 10e6 ? 0 : 1)}M`;
  if (num >= 1e3) return `${sym}${(num / 1e3).toFixed(0)}K`;
  return `${sym}${num}`;
}

const TIMING_TOKEN_LABELS = {
  mna: 'M&A',
  ipo: 'IPO',
  sec: 'SEC',
  spv: 'SPV',
  pe: 'PE',
  vc: 'VC',
  ai: 'AI',
  or: '/'
};

function formatTimingContainerLabel(rawName = '') {
  const str = String(rawName || '').trim();
  if (!str) return 'Corporate milestone';
  if (/^[A-Z0-9_]{6,}$/.test(str) && str.includes('_')) {
    return str
      .toLowerCase()
      .split('_')
      .filter(Boolean)
      .map((w) => TIMING_TOKEN_LABELS[w] || (w.charAt(0).toUpperCase() + w.slice(1)))
      .slice(0, 4)
      .join(' ');
  }
  return str;
}

function entityMapType(entity = {}) {
  return String(entity.entity_type || entity.entityType || entity.type || 'Entity');
}

function entityMapNodeKind(entity = {}, isAnchor = false) {
  if (isAnchor) return 'anchor';
  const type = entityMapType(entity).toLowerCase();
  if (type === 'person') return 'person';
  if (type === 'organization' || type === 'fund') return 'organization';
  if (type.includes('event') || type.includes('round')) return 'event';
  return 'entity';
}

function ensureSinglePeriod(text = '') {
  const cleaned = String(text || '').trim().replace(/\s+/g, ' ').replace(/\.+$/, '');
  return cleaned ? `${cleaned}.` : '';
}

function formatReadableEdgeRole(rawRole = '') {
  const roleStr = String(rawRole || '').trim();
  if (!roleStr) return '';
  if (/[a-z]/.test(roleStr)) return roleStr;
  return roleStr
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => (/^(ceo|cto|cfo|coo|cso|cro|cmo|cco|vp)$/.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

function extractCalaOriginPublisher(origin = {}) {
  const explicit = String(origin?.source || origin?.publisher || '').trim();
  if (explicit && !/^cala/i.test(explicit)) return explicit;
  const urlStr = String(origin?.url || origin?.document || '').trim();
  if (urlStr) {
    try {
      const host = new URL(urlStr).hostname.replace(/^www\./i, '');
      if (host === 'sec.gov' || host.endsWith('.sec.gov')) return 'SEC EDGAR';
      if (host) return host;
    } catch {
      // Ignore malformed origin URLs and fall back to explicit/Cala label.
    }
  }
  return explicit || 'Cala Knowledge Graph';
}

function resolveMapEdgeEvidenceSources(sourceIds = [], limit = 4) {
  const seen = new Set();
  const evidenceSources = [];
  for (const id of sourceIds || []) {
    const src = SOURCES[id];
    if (!src) continue;
    const dedupKey = `${String(src.url || '').trim().toLowerCase()}|${String(src.title || '').trim().toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    evidenceSources.push({
      id: src.id,
      title: src.title,
      publisher: src.publisher,
      url: src.url,
      date: src.date || null,
      sourceRank: src.sourceRank || 'AGGREGATOR'
    });
  }
  evidenceSources.sort(
    (a, b) =>
      (SOURCE_RANK_PRIORITY[b.sourceRank] || 0) - (SOURCE_RANK_PRIORITY[a.sourceRank] || 0) ||
      String(b.date || '').localeCompare(String(a.date || ''))
  );
  return {
    evidenceSources: evidenceSources.slice(0, limit),
    sourceCount: evidenceSources.length
  };
}

function isRootHomepageUrl(urlStr = '') {
  const raw = String(urlStr || '').trim();
  if (!raw || !/^https?:\/\//i.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return !parsed.pathname || parsed.pathname === '/';
  } catch {
    return false;
  }
}

function registerEntityMapSource(anchor, relation, fallbackRank = null) {
  const rawOrigins = [
    ...(relation?.properties?.sources || []),
    ...(relation?.sources || [])
  ].filter(Boolean);

  const entityId = String(anchor?.id || 'anchor');
  const relationId = String(relation?.id || relation?.name || 'relation');
  const dedupedOrigins = new Map();
  let rawRootOrigins = 0;
  for (const origin of rawOrigins) {
    const rank = inferCalaOriginRank(origin, origin?.source_rank || fallbackRank);
    const originDate = origin?.published_time ? String(origin.published_time).slice(0, 10) : (origin?.date ? String(origin.date).slice(0, 10) : null);
    const originUrl = String(origin?.url || origin?.document || '').trim();
    const originTitle = String(origin?.name || `${anchor?.name || 'Cala entity'} relationship record`).trim();
    const urlNorm = originUrl ? originUrl.replace(/\/+$/, '').toLowerCase() : '';
    const key = urlNorm || originTitle.toLowerCase();
    const isGenericRoot = isRootHomepageUrl(originUrl);
    if (isGenericRoot) rawRootOrigins += 1;
    const existing = dedupedOrigins.get(key);
    if (
      !existing ||
      (existing.isGenericRoot && !isGenericRoot) ||
      ((existing.isGenericRoot === isGenericRoot) && (SOURCE_RANK_PRIORITY[rank] || 0) > (SOURCE_RANK_PRIORITY[existing.sourceRank] || 0)) ||
      ((existing.isGenericRoot === isGenericRoot) && String(originDate || '') > String(existing.date || ''))
    ) {
      dedupedOrigins.set(key, {
        origin,
        sourceRank: rank,
        isGenericRoot,
        date: originDate,
        url: originUrl || `https://cala.ai/entities/${encodeURIComponent(entityId)}`,
        title: originTitle,
        publisher: extractCalaOriginPublisher(origin)
      });
    }
  }

  const sortedOrigins = [...dedupedOrigins.values()].sort(
    (a, b) =>
      Number(Boolean(a.isGenericRoot)) - Number(Boolean(b.isGenericRoot)) ||
      (SOURCE_RANK_PRIORITY[b.sourceRank] || 0) - (SOURCE_RANK_PRIORITY[a.sourceRank] || 0) ||
      String(b.date || '').localeCompare(String(a.date || ''))
  );

  const candidates = sortedOrigins.length
    ? sortedOrigins.slice(0, 6)
    : [{
      origin: null,
      sourceRank: inferCalaOriginRank(null, fallbackRank),
      date: null,
      url: `https://cala.ai/entities/${encodeURIComponent(entityId)}`,
      title: `${anchor?.name || 'Cala entity'} relationship record`,
      publisher: 'Cala Knowledge Graph'
    }];

  const registeredIds = [];
  const seenRegisteredIds = new Set();
  const evidenceSources = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const item = candidates[i];
    const baseSlug = slugifyBridgeId(`${entityId}-${relationId}-${item.origin?.document || item.origin?.url || item.title}`).slice(0, 58);
    const sourceId = `src-cala-map-${baseSlug}-${i}`;
    if (seenRegisteredIds.has(sourceId)) continue;
    seenRegisteredIds.add(sourceId);
    if (!SOURCES[sourceId]) {
      SOURCES[sourceId] = {
        id: sourceId,
        title: item.title,
        publisher: item.publisher,
        url: item.url,
        date: item.date,
        sourceRank: item.sourceRank,
        datePrecision: item.date ? 'day' : 'unknown',
        snippet: `${anchor?.name || 'Entity'}: verified Cala relationship ${relation?.name || relation?.id || ''}.`
      };
    }
    registeredIds.push(sourceId);
    if (evidenceSources.length < 4) {
      evidenceSources.push({
        id: sourceId,
        title: SOURCES[sourceId].title,
        publisher: SOURCES[sourceId].publisher,
        url: SOURCES[sourceId].url,
        date: SOURCES[sourceId].date,
        sourceRank: SOURCES[sourceId].sourceRank
      });
    }
  }

  const isBulkCrawlNoise = rawOrigins.length >= 12 && (rawRootOrigins / rawOrigins.length) >= 0.7;

  return {
    sourceId: registeredIds[0],
    sourceIds: registeredIds,
    sourceRank: candidates[0].sourceRank,
    evidenceSources,
    sourceCount: sortedOrigins.length,
    isBulkCrawlNoise
  };
}

function addEntityMapNode(nodeMap, entity, { isAnchor = false, topSourceRank = null, sourceIds = [] } = {}) {
  const id = String(entity?.id || '');
  if (!id) return null;
  const existing = nodeMap.get(id);
  if (existing) {
    const existingPriority = SOURCE_RANK_PRIORITY[String(existing.topSourceRank || '').toUpperCase()] || 0;
    const newPriority = SOURCE_RANK_PRIORITY[String(topSourceRank || '').toUpperCase()] || 0;
    if (newPriority > existingPriority) existing.topSourceRank = topSourceRank;
    existing.sourceIds = [...new Set([...(existing.sourceIds || []), ...sourceIds])];
    return existing;
  }
  const node = {
    id,
    label: String(entity?.name || 'Unnamed Cala entity'),
    kind: entityMapNodeKind(entity, isAnchor),
    entityType: entityMapType(entity),
    entityCategory: entity?.entityCategory || null,
    contributionGroup: isAnchor ? 'all' : null,
    topSourceRank,
    sourceIds: [...new Set(sourceIds)],
    description: entity?.description || entity?.properties?.description?.value || null
  };
  nodeMap.set(id, node);
  return node;
}

/**
 * Builds an entity-first graph using only edges supplied by Cala on the anchor
 * entity. `relatedEntities` can enrich relationship targets, but never creates
 * an edge on its own. This keeps an isolated fact from looking like a bridge.
 */
export function buildEntityBridgeMap(anchorEntity, relatedEntities = [], options = {}) {
  const requestedCenters = Array.isArray(anchorEntity)
    ? anchorEntity
    : [anchorEntity, ...(options.multiCenter ? relatedEntities : [])];
  const focalEntities = [...new Map(
    requestedCenters
      .filter((entity) => entity?.id && entity?.name)
      .map((entity) => [String(entity.id), entity])
  ).values()].slice(0, 20);

  if (!focalEntities.length) {
    const err = new Error('Entity mode requires at least one Cala entity with an id and name.');
    err.statusCode = 400;
    throw err;
  }

  const anchorEntityResolved = focalEntities[0];
  const focalById = new Map(focalEntities.map((entity) => [String(entity.id), entity]));
  const focalEntityIds = focalEntities.map((entity) => String(entity.id));
  const focalByName = new Map(focalEntities.map((entity) => [normalizeLookupName(entity.name), entity]));
  const focalByCanonicalName = new Map();
  for (const entity of focalEntities) {
    const canon = canonicalMapEntityName(entity.name);
    if (canon && !focalByCanonicalName.has(canon)) focalByCanonicalName.set(canon, entity);
  }
  const relatedById = new Map(
    (relatedEntities || [])
      .filter((entity) => entity?.id)
      .map((entity) => [String(entity.id), entity])
  );
  const nonFocalByCanonicalKey = new Map();
  const getCanonicalBucketKey = (entity = {}) => {
    const canon = canonicalMapEntityName(entity.name || '');
    if (!canon) return null;
    const typeBucket = entityMapType(entity).toLowerCase() === 'person' ? 'person' : 'org';
    return `${typeBucket}:${canon}`;
  };
  for (const entity of relatedById.values()) {
    if (isFundingRoundEntity(entity) || isGenericEventContainerNode(entity)) continue;
    const k = getCanonicalBucketKey(entity);
    if (!k) continue;
    const prev = nonFocalByCanonicalKey.get(k);
    if (!prev || (entity.relationships && !prev.relationships)) {
      nonFocalByCanonicalKey.set(k, entity);
    }
  }
  const nodeMap = new Map();
  const anchor = {
    id: String(anchorEntityResolved.id),
    label: String(anchorEntityResolved.name),
    kind: 'anchor',
    entityType: entityMapType(anchorEntityResolved),
    contributionGroup: 'all'
  };

  const timingEventsByEntity = Object.fromEntries(focalEntityIds.map((id) => [id, []]));
  const seenTimingByEntity = new Map(focalEntityIds.map((id) => [id, new Set()]));

  const resolveFocalEntity = (candidate) => {
    if (!candidate) return null;
    if (candidate.id && focalById.has(String(candidate.id))) return focalById.get(String(candidate.id));
    const exact = candidate.name ? focalByName.get(normalizeLookupName(candidate.name)) : null;
    if (exact) return exact;
    const canon = candidate.name ? focalByCanonicalName.get(canonicalMapEntityName(candidate.name)) : null;
    return canon || null;
  };

  const resolveTargetEntity = (rawTarget) => {
    const focalMatch = resolveFocalEntity(rawTarget);
    if (focalMatch) return focalMatch;
    if (isFundingRoundEntity(rawTarget) || isGenericEventContainerNode(rawTarget)) {
      if (rawTarget?.id && relatedById.has(String(rawTarget.id))) return relatedById.get(String(rawTarget.id));
      return rawTarget;
    }
    const byId = rawTarget?.id ? relatedById.get(String(rawTarget.id)) : null;
    const canonicalKey = getCanonicalBucketKey(rawTarget);
    if (canonicalKey) {
      const existing = nonFocalByCanonicalKey.get(canonicalKey);
      if (existing) return existing;
      const chosen = byId || rawTarget;
      nonFocalByCanonicalKey.set(canonicalKey, chosen);
      return chosen;
    }
    return byId || rawTarget;
  };

  const recordTimingCatalyst = (focalId, item) => {
    const fId = String(focalId || '');
    if (!fId || !timingEventsByEntity[fId]) return;
    const seen = seenTimingByEntity.get(fId);
    const dedupKey = `${item.id || ''}:${normalizeLookupName(item.title || '')}:${item.date || ''}`;
    if (seen?.has(dedupKey)) return;
    seen?.add(dedupKey);
    timingEventsByEntity[fId].push(item);
  };

  for (const entity of focalEntities) {
    const entitySource = Object.values(entity.properties || {})
      .flatMap((property) => property?.sources || [])
      .find(Boolean) || null;
    const { sourceId, sourceRank } = registerEntityMapSource(entity, {
      id: 'entity-record',
      name: `${entity.name || 'Cala entity'} record`,
      properties: { sources: entitySource ? [entitySource] : [] }
    });
    const node = addEntityMapNode(nodeMap, entity, { isAnchor: true, topSourceRank: sourceRank, sourceIds: [sourceId] });
    if (node) node.isFocalEntity = true;
  }

  // In single-center mode, comparison entities stay visible as disconnected
  // nodes until the live Cala graph proves a relationship.  Multi-center mode
  // treats every supplied entity as a focal node above.
  if (!options.multiCenter) {
    for (const entity of relatedById.values()) {
      if (resolveFocalEntity(entity)) continue;
      if (isGenericEventContainerNode(entity)) continue;
      const entitySource = Object.values(entity.properties || {})
        .flatMap((property) => property?.sources || [])
        .find(Boolean) || null;
      const { sourceId, sourceRank } = registerEntityMapSource(entity, {
        id: 'entity-record',
        name: `${entity.name || 'Cala entity'} record`,
        properties: { sources: entitySource ? [entitySource] : [] }
      });
      const node = addEntityMapNode(nodeMap, entity, { topSourceRank: sourceRank, sourceIds: [sourceId] });
      if (node) node.isPinnedComparison = true;
    }
  }

  const edges = [];
  const seenEdges = new Set();
  const quarantinedAnomalies = [];
  const sharedTargetCenters = new Map();
  const roundFocalRoleHints = new Map();
  const groupStats = Object.fromEntries(
    Object.keys(CONTRIBUTION_GROUP_META).map((group) => [group, { nodeIds: new Set(), edgeCount: 0, entries: [] }])
  );

  const registerSharedEndpoint = (nodeEntity, focalId) => {
    const nodeId = String(nodeEntity?.id || '');
    if (!nodeId || focalById.has(nodeId)) return;
    const typeBucket = entityMapType(nodeEntity).toLowerCase() === 'person' ? 'person' : 'org';
    const sharedKey = `${typeBucket}:${canonicalMapEntityName(nodeEntity.name) || normalizeLookupName(nodeEntity.name) || nodeId}`;
    if (!sharedTargetCenters.has(sharedKey)) {
      sharedTargetCenters.set(sharedKey, { nodeIds: new Set(), focalIds: new Set() });
    }
    const bucket = sharedTargetCenters.get(sharedKey);
    bucket.nodeIds.add(nodeId);
    bucket.focalIds.add(String(focalId));
  };

  const emitVerifiedEdge = ({
    sourceEntity,
    targetEntity,
    relationType,
    relationMeta,
    direction = 'outgoing',
    focalId,
    rawRecord,
    date = null,
    role = null,
    detail = null,
    roundLabel = null,
    roundType = null,
    roundAmount = null,
    roundDate = null,
    syndicatePeers = null,
    syndicateTotalCount = 0,
    isLead = false,
    isRoundExpanded = false
  }) => {
    const fromEntity = direction === 'outgoing' ? sourceEntity : targetEntity;
    const toEntity = direction === 'outgoing' ? targetEntity : sourceEntity;
    const from = String(fromEntity?.id || '');
    const to = String(toEntity?.id || '');
    if (!from || !to || from === to) return null;

    if (relationType === 'IS_MEMBER_OF' && (isLocationOrCountryEntity(fromEntity) || isLocationOrCountryEntity(toEntity))) {
      return null;
    }

    const isSymmetric = ENTITY_MAP_SYMMETRIC_RELATIONS.has(relationType);
    const edgeId = isSymmetric
      ? `edge:${[from, to].sort().join(':')}:${relationType}`
      : `edge:${from}:${relationType}:${to}`;
    if (seenEdges.has(edgeId)) return null;

    const anchorForSource = focalById.get(String(focalId)) || sourceEntity;
    const { sourceIds, sourceRank, evidenceSources, sourceCount, isBulkCrawlNoise } = registerEntityMapSource(
      anchorForSource,
      rawRecord || targetEntity
    );

    if (
      relationType === 'IS_MEMBER_OF' &&
      !isMembershipConsortiumEntity(fromEntity) &&
      !isMembershipConsortiumEntity(toEntity) &&
      (
        (focalById.has(from) && focalById.has(to)) ||
        (
          entityMapType(fromEntity).toLowerCase() !== 'person' &&
          entityMapType(toEntity).toLowerCase() !== 'person' &&
          !isLikelyInvestorEntity(fromEntity) &&
          !isLikelyInvestorEntity(toEntity)
        )
      )
    ) {
      quarantinedAnomalies.push({
        kind: 'quarantined_noise_edge',
        relation: relationType,
        path: `${fromEntity.name} -> ${toEntity.name}`,
        detail: `Suppressed unverified cross-entity IS_MEMBER_OF link between ${fromEntity.name} and ${toEntity.name}.`,
        sourceRank,
        sourceIds
      });
      return null;
    }

    if (focalById.has(from) && focalById.has(to)) {
      if (
        relationType === 'INVESTED_IN' &&
        !isRoundExpanded &&
        investorHierarchyScore(fromEntity) === 0 &&
        investorHierarchyScore(toEntity) === 0 &&
        ['PRESS', 'AGGREGATOR'].includes(String(sourceRank || '').toUpperCase())
      ) {
        quarantinedAnomalies.push({
          kind: 'quarantined_comention',
          relation: relationType,
          path: `${fromEntity.name} -> ${toEntity.name}`,
          detail: `Quarantined unverified ${sourceRank} co-mention financing edge between ${fromEntity.name} and ${toEntity.name}.`,
          sourceRank,
          sourceIds
        });
        return null;
      }
    }

    seenEdges.add(edgeId);
    addEntityMapNode(nodeMap, fromEntity, { topSourceRank: sourceRank, sourceIds });
    addEntityMapNode(nodeMap, toEntity, { topSourceRank: sourceRank, sourceIds });

    const resolvedDate =
      date ||
      rawRecord?.properties?.event_date ||
      rawRecord?.properties?.valid_since ||
      rawRecord?.properties?.sources?.[0]?.date ||
      null;
    const rawRoleValue = role || rawRecord?.properties?.role || null;
    const readableRole = formatReadableEdgeRole(rawRoleValue);
    const normalizedLabel = String(relationMeta.label || '').toLowerCase();
    const roleDuplicatesVerb =
      readableRole &&
      (normalizedLabel.includes(readableRole.toLowerCase()) ||
        readableRole.toLowerCase() === 'founder' && normalizedLabel === 'founded' ||
        readableRole.toLowerCase() === 'investor' && normalizedLabel.includes('invest'));
    const lowercaseVerbPhrase = relationMeta.label
      .toLowerCase()
      .replace(/\b(ceo|cto|cfo|coo|cso|cro|cmo|cco|vp)\b/gi, (m) => m.toUpperCase());
    const computedDetail = ensureSinglePeriod(
      detail ||
        `${fromEntity.name} ${lowercaseVerbPhrase} ${toEntity.name}${readableRole && !roleDuplicatesVerb ? ` as ${readableRole}` : ''}`
    );

    const edge = {
      id: edgeId,
      from,
      to,
      focalEntityId: String(focalId),
      relation: relationType,
      isSymmetric,
      label: roundLabel ? `${relationMeta.label} (${roundLabel})` : relationMeta.label,
      roundLabel: roundLabel || null,
      roundType: roundType || null,
      roundAmount: roundAmount || null,
      roundDate: roundDate ? String(roundDate).slice(0, 10) : null,
      syndicatePeers: Array.isArray(syndicatePeers) && syndicatePeers.length ? syndicatePeers : null,
      syndicateTotalCount: syndicateTotalCount || 0,
      isLead: Boolean(isLead),
      isRoundExpanded: Boolean(isRoundExpanded),
      isBulkCrawlNoise: Boolean(isBulkCrawlNoise),
      contributionGroup: relationMeta.group,
      bridgeFamily: relationMeta.family,
      topSourceRank: sourceRank,
      sourceIds,
      evidenceSources,
      sourceCount,
      date: resolvedDate ? String(resolvedDate).slice(0, 10) : null,
      role: readableRole || null,
      detail: computedDetail,
      verified: true
    };
    edges.push(edge);

    if (focalById.has(from) && !focalById.has(to)) {
      registerSharedEndpoint(toEntity, from);
      const toNode = nodeMap.get(to);
      if (toNode && !toNode.isFocalEntity) toNode.contributionGroup ||= relationMeta.group;
    } else if (focalById.has(to) && !focalById.has(from)) {
      registerSharedEndpoint(fromEntity, to);
      const fromNode = nodeMap.get(from);
      if (fromNode && !fromNode.isFocalEntity) fromNode.contributionGroup ||= relationMeta.group;
    } else if (focalById.has(from) && focalById.has(to)) {
      const fNode = nodeMap.get(from);
      const tNode = nodeMap.get(to);
      if (fNode && !fNode.isFocalEntity) fNode.contributionGroup ||= relationMeta.group;
      if (tNode && !tNode.isFocalEntity) tNode.contributionGroup ||= relationMeta.group;
    }

    const stat = groupStats[relationMeta.group];
    if (stat) {
      const nonFocalEndpoint = !focalById.has(to) ? toEntity : !focalById.has(from) ? fromEntity : toEntity;
      stat.nodeIds.add(String(nonFocalEndpoint.id));
      stat.edgeCount += 1;
      stat.entries.push({ id: String(nonFocalEndpoint.id), label: nonFocalEndpoint.name, topSourceRank: sourceRank, sourceIds, detail: computedDetail });
    }
    return edge;
  };

  const scanEntityRelationshipsForFocal = (entityRecord, assignedFocal) => {
    const focalId = String(assignedFocal.id);
    const relationships = entityRecord.relationships || {};
    for (const direction of ['outgoing', 'incoming']) {
      for (const [relationType, rawTargets] of Object.entries(relationships[direction] || {})) {
        const relationMeta = resolveEntityMapRelationMeta(relationType);
        if (!relationMeta) continue;
        for (const rawTarget of rawTargets || []) {
          if (!rawTarget?.id || !rawTarget?.name) continue;
          const target = resolveTargetEntity(rawTarget);
          if (isHonorificPersonStub(target)) continue;

          if (isFundingRoundEntity(target) || isGenericEventContainerNode(target, relationType)) {
            const roundRole = String(rawTarget.properties?.role || '').toUpperCase();
            if (isFundingRoundEntity(target) && roundRole) {
              if (!roundFocalRoleHints.has(String(target.id))) roundFocalRoleHints.set(String(target.id), []);
              roundFocalRoleHints.get(String(target.id)).push({
                entity: assignedFocal,
                role: roundRole,
                isLead: Boolean(rawTarget.properties?.is_lead),
                rawRecord: rawTarget
              });
            }
            // Portfolio rounds where the focal entity is merely an investor must NOT pollute the investor's own financing timeline.
            if (isFundingRoundEntity(target) && ['INVESTOR', 'LEAD_INVESTOR', 'LENDER'].includes(roundRole)) {
              continue;
            }
            const origin = rawTarget.properties?.sources?.[0] || rawTarget.sources?.[0] || null;
            const date =
              rawTarget.properties?.event_date ||
              target.properties?.event_date?.value ||
              target.properties?.announcement_date?.value ||
              target.properties?.close_date?.value ||
              origin?.date ||
              null;
            const amount = formatCompactRoundValue(
              target.properties?.transaction_value?.value,
              target.properties?.transaction_value_units?.value
            );
            const roundTypeVal =
              target.properties?.round_label?.value ||
              target.properties?.round_type?.value ||
              formatTimingContainerLabel(target.name);
            const title = [roundTypeVal, amount].filter(Boolean).join(' · ');
            const registeredSource = registerEntityMapSource(assignedFocal, rawTarget);
            const hasOriginSource = Boolean(origin);
            recordTimingCatalyst(focalId, {
              id: String(target.id),
              kind: isFundingRoundEntity(target) ? 'funding_round' : 'corporate_event',
              title,
              date: date ? String(date).slice(0, 10) : null,
              amount: amount || null,
              role: roundRole || null,
              sourceRank: registeredSource.sourceRank,
              sourceId: hasOriginSource ? registeredSource.sourceId : null,
              sourceIds: hasOriginSource ? registeredSource.sourceIds : [],
              evidenceSources: hasOriginSource ? registeredSource.evidenceSources : [],
              sourceCount: hasOriginSource ? registeredSource.sourceCount : 0,
              url: origin?.document || origin?.url || null
            });
            continue;
          }

          emitVerifiedEdge({
            sourceEntity: assignedFocal,
            targetEntity: target,
            relationType,
            relationMeta,
            direction,
            focalId,
            rawRecord: rawTarget
          });
        }
      }
    }
  };

  // Pass 1: Scan all focal entities AND any hydrated related entities that canonically match a focal hub.
  for (const focal of focalEntities) {
    scanEntityRelationshipsForFocal(focal, focal);
  }
  for (const neighbor of relatedById.values()) {
    const matchedFocal = resolveFocalEntity(neighbor);
    if (matchedFocal && String(neighbor.id) !== String(matchedFocal.id) && neighbor.relationships) {
      scanEntityRelationshipsForFocal(neighbor, matchedFocal);
    }
  }

  // Pass 2: Expand hydrated FundingRound / PrivateCompanyFundingRound entities into Investor -> Issuer edges.
  for (const roundEntity of relatedById.values()) {
    if (!isFundingRoundEntity(roundEntity)) continue;
    const roundId = String(roundEntity.id);
    const roundType =
      roundEntity.properties?.round_label?.value ||
      roundEntity.properties?.round_type?.value ||
      (/^(?:FINANCING_RAISED|CAPITAL)/i.test(String(roundEntity.name || '')) ? 'Financing' : roundEntity.name) ||
      'Funding Round';
    const roundAmount = formatCompactRoundValue(
      roundEntity.properties?.transaction_value?.value,
      roundEntity.properties?.transaction_value_units?.value
    );
    const roundDateRaw =
      roundEntity.properties?.event_date?.value ||
      roundEntity.properties?.announcement_date?.value ||
      roundEntity.properties?.close_date?.value ||
      null;

    const participants = [
      ...(roundEntity.relationships?.incoming?.PARTICIPATES_IN_FUNDING_ROUND || []),
      ...(roundEntity.relationships?.incoming?.PARTICIPATES_IN_CORPORATE_EVENT || []),
      ...(roundEntity.relationships?.outgoing?.PARTICIPATES_IN_FUNDING_ROUND || []),
      ...(roundEntity.relationships?.outgoing?.PARTICIPATES_IN_CORPORATE_EVENT || [])
    ];

    const participantById = new Map();
    for (const p of participants) {
      if (!p?.id || !p?.name) continue;
      const resolved = resolveTargetEntity(p);
      if (isHonorificPersonStub(resolved)) continue;
      const key = String(resolved.id);
      if (!participantById.has(key)) {
        participantById.set(key, {
          entity: resolved,
          role: String(p.properties?.role || '').toUpperCase(),
          isLead: Boolean(p.properties?.is_lead),
          rawRecord: p
        });
      }
    }
    for (const hint of roundFocalRoleHints.get(roundId) || []) {
      const key = String(hint.entity.id);
      if (!participantById.has(key)) {
        participantById.set(key, hint);
      } else if (!participantById.get(key).role && hint.role) {
        participantById.get(key).role = hint.role;
      }
    }

    const issuers = [];
    const investors = [];
    for (const entry of participantById.values()) {
      if (entry.role === 'ISSUER' || entry.role === 'BORROWER' || entry.role === 'TARGET') {
        issuers.push(entry);
      } else if (entry.role === 'INVESTOR' || entry.role === 'LEAD_INVESTOR' || entry.role === 'LENDER') {
        investors.push(entry);
      }
    }
    if (!issuers.length || !investors.length) continue;

    const sampleSourceDate =
      roundDateRaw ||
      participants.find((p) => p?.properties?.event_date)?.properties?.event_date ||
      participants.find((p) => p?.properties?.sources?.[0]?.date)?.properties?.sources?.[0]?.date ||
      null;
    const shortDate = sampleSourceDate ? String(sampleSourceDate).slice(0, 7) : null;
    const roundSummary = [roundType, roundAmount, shortDate].filter(Boolean).join(' · ');

    for (const issuer of issuers) {
      const issuerIsFocal = focalById.has(String(issuer.entity.id));
      for (const investor of investors) {
        const investorIsFocal = focalById.has(String(investor.entity.id));
        if (!issuerIsFocal && !investorIsFocal) continue;
        const primaryFocalId = investorIsFocal ? String(investor.entity.id) : String(issuer.entity.id);
        const mergedSources = [
          ...(investor.rawRecord?.properties?.sources || []),
          ...(issuer.rawRecord?.properties?.sources || []),
          ...(roundEntity.properties?.event_date?.sources || []),
          ...(roundEntity.properties?.transaction_value?.sources || [])
        ].filter(Boolean);
        const syndicatePeers = investors
          .filter((peer) => String(peer.entity.id) !== String(investor.entity.id))
          .sort(
            (a, b) =>
              Number(Boolean(b.isLead)) - Number(Boolean(a.isLead)) ||
              Number(focalById.has(String(b.entity.id))) - Number(focalById.has(String(a.entity.id))) ||
              String(a.entity.name || '').localeCompare(String(b.entity.name || ''))
          )
          .slice(0, 5)
          .map((peer) => ({
            id: String(peer.entity.id),
            name: String(peer.entity.name || peer.entity.id),
            isLead: Boolean(peer.isLead)
          }));
        const rawRecord = {
          id: `${roundId}-${investor.entity.id}-${issuer.entity.id}`,
          name: `${investor.entity.name} -> ${issuer.entity.name} (${roundSummary || roundType})`,
          properties: {
            sources: mergedSources,
            event_date: sampleSourceDate ? String(sampleSourceDate).slice(0, 10) : null,
            role: investor.isLead ? 'LEAD_INVESTOR' : 'INVESTOR'
          }
        };
        const leadText = investor.isLead ? 'led' : 'invested in';
        const cleanIssuerOwner = String(issuer.entity.name || '').replace(/\.+$/, '');
        const detail = ensureSinglePeriod(
          `${investor.entity.name} ${leadText} ${cleanIssuerOwner}'s ${roundType}${roundAmount ? ` (${roundAmount})` : ''}${sampleSourceDate ? ` on ${String(sampleSourceDate).slice(0, 10)}` : ''}`
        );
        emitVerifiedEdge({
          sourceEntity: investor.entity,
          targetEntity: issuer.entity,
          relationType: 'INVESTED_IN',
          relationMeta: {
            label: investor.isLead ? 'Led round' : 'Invested in',
            group: 'access',
            family: 'co_investor'
          },
          direction: 'outgoing',
          focalId: primaryFocalId,
          rawRecord,
          date: sampleSourceDate,
          role: investor.isLead ? 'LEAD_INVESTOR' : 'INVESTOR',
          detail,
          roundLabel: roundSummary || roundType,
          roundType,
          roundAmount: roundAmount || null,
          roundDate: sampleSourceDate ? String(sampleSourceDate).slice(0, 10) : null,
          syndicatePeers,
          syndicateTotalCount: Math.max(0, investors.length - 1),
          isLead: investor.isLead,
          isRoundExpanded: true
        });
      }
    }

    // If a focal investor co-invested alongside a distinct lead co-investor in a non-focal issuer round,
    // also add a compact lead co-investor edge so syndicates across maps can link up cleanly.
    for (const focalInv of investors.filter((inv) => focalById.has(String(inv.entity.id)))) {
      const leadPeers = investors.filter(
        (peer) => String(peer.entity.id) !== String(focalInv.entity.id) && (peer.isLead || focalById.has(String(peer.entity.id)))
      );
      for (const peer of leadPeers.slice(0, 2)) {
        const mergedSources = [
          ...(focalInv.rawRecord?.properties?.sources || []),
          ...(peer.rawRecord?.properties?.sources || [])
        ].filter(Boolean);
        const issuerNames = issuers.map((i) => i.entity.name).slice(0, 2).join(', ');
        const otherInvestors = investors
          .filter((inv) => String(inv.entity.id) !== String(focalInv.entity.id) && String(inv.entity.id) !== String(peer.entity.id))
          .slice(0, 4)
          .map((inv) => ({
            id: String(inv.entity.id),
            name: String(inv.entity.name || inv.entity.id),
            isLead: Boolean(inv.isLead)
          }));
        const detail = ensureSinglePeriod(
          `${focalInv.entity.name} and ${peer.entity.name} co-invested in ${issuerNames} (${roundSummary || roundType})`
        );
        emitVerifiedEdge({
          sourceEntity: focalInv.entity,
          targetEntity: peer.entity,
          relationType: 'CO_INVESTED_WITH',
          relationMeta: {
            label: 'Co-invested with',
            group: 'access',
            family: 'co_investor'
          },
          direction: 'outgoing',
          focalId: String(focalInv.entity.id),
          rawRecord: {
            id: `${roundId}-coinv-${focalInv.entity.id}-${peer.entity.id}`,
            name: detail,
            properties: { sources: mergedSources, event_date: sampleSourceDate }
          },
          date: sampleSourceDate,
          detail,
          roundLabel: roundSummary || roundType,
          roundType,
          roundAmount: roundAmount || null,
          roundDate: sampleSourceDate ? String(sampleSourceDate).slice(0, 10) : null,
          syndicatePeers: otherInvestors,
          syndicateTotalCount: Math.max(0, investors.length - 2),
          isRoundExpanded: true
        });
      }
    }
  }

  // Pass 3: Scan hydrated 1-hop Person/Company/Organization neighbors for cross-focal edges
  // (for example, Daniela Amodei having both Anthropic and OpenAI edges even when one hub's list truncated her).
  for (const neighbor of relatedById.values()) {
    if (resolveFocalEntity(neighbor)) continue;
    if (isFundingRoundEntity(neighbor) || isGenericEventContainerNode(neighbor)) continue;
    if (isHonorificPersonStub(neighbor) || !neighbor.relationships) continue;
    const canonicalNeighbor = resolveTargetEntity(neighbor);
    for (const direction of ['outgoing', 'incoming']) {
      for (const [relationType, rawTargets] of Object.entries(neighbor.relationships[direction] || {})) {
        const relationMeta = resolveEntityMapRelationMeta(relationType);
        if (!relationMeta) continue;
        for (const rawTarget of rawTargets || []) {
          if (!rawTarget?.id || !rawTarget?.name) continue;
          const matchedFocal = resolveFocalEntity(rawTarget);
          if (!matchedFocal) continue;
          if (isGenericEventContainerNode(matchedFocal, relationType)) continue;
          const flippedDir = direction === 'outgoing' ? 'incoming' : 'outgoing';
          emitVerifiedEdge({
            sourceEntity: matchedFocal,
            targetEntity: canonicalNeighbor,
            relationType,
            relationMeta,
            direction: flippedDir,
            focalId: String(matchedFocal.id),
            rawRecord: rawTarget
          });
        }
      }
    }
  }

  // Reconcile noisy or backwards raw INVESTED_IN edges against round-verified edges,
  // suppress root-homepage-only co-mentions, orient strategic/institutional investors,
  // and collapse redundant person-to-company role bloat.
  const entityObjById = new Map();
  for (const e of [...focalEntities, ...relatedEntities]) {
    if (e?.id && !entityObjById.has(String(e.id))) entityObjById.set(String(e.id), e);
  }
  const netInvestorSignal = (id, nodeObj) => {
    const raw = entityObjById.get(String(id));
    const hier = investorHierarchyScore({ name: nodeObj?.label || raw?.name, entity_type: nodeObj?.entityType || raw?.entity_type });
    if (hier > 0) return hier * 100;
    const outCount = (raw?.relationships?.outgoing?.INVESTED_IN || []).length;
    const inCount = (raw?.relationships?.incoming?.INVESTED_IN || []).length;
    return outCount - inCount;
  };
  const edgeUrlInvestorHint = (edge, fromName, toName) => {
    const hay = (edge.evidenceSources || []).map((s) => `${s.title || ''} ${s.url || ''}`).join(' ').toLowerCase();
    const fSlug = canonicalMapEntityName(fromName).replace(/\s+/g, '');
    const tSlug = canonicalMapEntityName(toName).replace(/\s+/g, '');
    let bonus = 0;
    if (fSlug && (hay.includes(`investments-by-${fSlug}`) || hay.includes(`${fSlug}s-startup-empire`) || hay.includes(`${fSlug}-startup-empire`) || hay.includes(`${fSlug}-mafia`))) {
      bonus += 40;
    }
    if (tSlug && (hay.includes(`investments-by-${tSlug}`) || hay.includes(`${tSlug}s-startup-empire`) || hay.includes(`${tSlug}-startup-empire`) || hay.includes(`${tSlug}-mafia`))) {
      bonus -= 40;
    }
    if (fSlug && hay.includes(`startup-${fSlug}`)) bonus -= 35;
    if (tSlug && hay.includes(`startup-${tSlug}`)) bonus += 35;
    return bonus;
  };

  const roundVerifiedUndirectedPairs = new Set();
  for (const edge of edges) {
    if (edge.isRoundExpanded && edge.relation === 'INVESTED_IN') {
      roundVerifiedUndirectedPairs.add([edge.from, edge.to].sort().join(':'));
    }
  }
  const rawInvestedPairs = new Map();
  for (const edge of edges) {
    if (!edge.isRoundExpanded && edge.relation === 'INVESTED_IN') {
      const k = [edge.from, edge.to].sort().join(':');
      if (!rawInvestedPairs.has(k)) rawInvestedPairs.set(k, []);
      rawInvestedPairs.get(k).push(edge);
    }
  }
  const dropEdgeIds = new Set();
  for (const [pairKey, pairEdges] of rawInvestedPairs.entries()) {
    if (roundVerifiedUndirectedPairs.has(pairKey)) {
      for (const e of pairEdges) dropEdgeIds.add(e.id);
      continue;
    }
    if (pairEdges.length >= 2) {
      const sortedPair = [...pairEdges].sort((a, b) => {
        const aFromNode = nodeMap.get(a.from) || entityObjById.get(a.from) || { name: '' };
        const aToNode = nodeMap.get(a.to) || entityObjById.get(a.to) || { name: '' };
        const bFromNode = nodeMap.get(b.from) || entityObjById.get(b.from) || { name: '' };
        const bToNode = nodeMap.get(b.to) || entityObjById.get(b.to) || { name: '' };
        const aScore =
          (a.isBulkCrawlNoise ? -120 : 0) +
          netInvestorSignal(a.from, aFromNode) -
          netInvestorSignal(a.to, aToNode) +
          edgeUrlInvestorHint(a, aFromNode.label || aFromNode.name, aToNode.label || aToNode.name);
        const bScore =
          (b.isBulkCrawlNoise ? -120 : 0) +
          netInvestorSignal(b.from, bFromNode) -
          netInvestorSignal(b.to, bToNode) +
          edgeUrlInvestorHint(b, bFromNode.label || bFromNode.name, bToNode.label || bToNode.name);
        return bScore - aScore || (SOURCE_RANK_PRIORITY[b.topSourceRank] || 0) - (SOURCE_RANK_PRIORITY[a.topSourceRank] || 0);
      });
      for (const extra of sortedPair.slice(1)) {
        dropEdgeIds.add(extra.id);
        quarantinedAnomalies.push({
          kind: 'bidirectional_investor_conflict',
          relation: 'INVESTED_IN',
          path: `${nodeMap.get(extra.from)?.label || extra.from} -> ${nodeMap.get(extra.to)?.label || extra.to}`,
          detail: `Removed conflicting reverse INVESTED_IN duplicate in favor of canonical direction.`,
          sourceRank: extra.topSourceRank,
          sourceIds: extra.sourceIds || []
        });
      }
    }
  }
  for (const edge of edges) {
    if (dropEdgeIds.has(edge.id) || edge.isRoundExpanded || edge.relation !== 'INVESTED_IN') continue;
    const fromNode = nodeMap.get(edge.from) || { label: edge.from };
    const toNode = nodeMap.get(edge.to) || { label: edge.to };
    const fromRank = investorHierarchyScore({ name: fromNode.label, entity_type: fromNode.entityType });
    const toRank = investorHierarchyScore({ name: toNode.label, entity_type: toNode.entityType });
    const evList = edge.evidenceSources || [];
    const allRootCrawlUrls = evList.length > 0 && evList.every((s) => isRootHomepageUrl(s.url));
    const hasInvestHeadline = evList.some((s) =>
      /\b(?:invest|round|funding|series|seed|backed|backers?|lead|portfolio|capital|stake|venture)\b/i.test(String(s.title || ''))
    );
    if ((fromRank === 0 && edge.isBulkCrawlNoise) || (fromRank === 0 && allRootCrawlUrls && !hasInvestHeadline)) {
      dropEdgeIds.add(edge.id);
      quarantinedAnomalies.push({
        kind: 'low_confidence_comention',
        relation: 'INVESTED_IN',
        path: `${fromNode.label} -> ${toNode.label}`,
        detail: `Quarantined unverified bulk-crawl link (${fromNode.label} -> ${toNode.label}) lacking specific round or article proof.`,
        sourceRank: edge.topSourceRank,
        sourceIds: edge.sourceIds || []
      });
    }
  }
  if (dropEdgeIds.size) {
    for (let i = edges.length - 1; i >= 0; i--) {
      if (dropEdgeIds.has(edges[i].id)) edges.splice(i, 1);
    }
  }
  for (const edge of edges) {
    if (edge.isRoundExpanded || edge.relation !== 'INVESTED_IN') continue;
    const fromNode = nodeMap.get(edge.from) || { label: edge.from };
    const toNode = nodeMap.get(edge.to) || { label: edge.to };
    const fromScore = investorHierarchyScore({ name: fromNode.label, entity_type: fromNode.entityType });
    const toScore = investorHierarchyScore({ name: toNode.label, entity_type: toNode.entityType });
    if (toScore > fromScore) {
      [edge.from, edge.to] = [edge.to, edge.from];
      edge.id = `edge:${edge.from}:INVESTED_IN:${edge.to}`;
      edge.label = toScore === 2 ? 'Strategic investor' : 'Invested in';
      edge.detail = ensureSinglePeriod(`${toNode.label} invested in ${fromNode.label} (verified in Cala)`);
    } else if (toScore === 0 && fromScore === 0 && focalById.has(edge.from) && focalById.has(edge.to)) {
      edge.label = 'Financing link';
      edge.detail = ensureSinglePeriod(`Cala financing record connects ${fromNode.label} and ${toNode.label}`);
    }
  }

  // Collapse redundant person-to-company roles (e.g. drop generic WORKS_AT/IS_MEMBER_OF
  // when an explicit executive/founder role exists on the same pair, and cap noisy
  // multi-C-suite press duplicates to top 3 highest-provenance distinct roles).
  const EXEC_ROLE_PRIORITY = {
    FOUNDED: 10,
    CO_FOUNDED: 10,
    IS_BOARD_MEMBER_OF: 9,
    IS_CEO_OF: 8,
    IS_PRESIDENT_OF: 8,
    IS_COO_OF: 7,
    IS_CTO_OF: 7,
    IS_VICEPRESIDENT_OF: 6,
    IS_CFO_OF: 5,
    IS_CSO_OF: 4,
    IS_CRO_OF: 4,
    IS_CMO_OF: 3,
    IS_CCO_OF: 3,
    WORKS_AT: 1,
    IS_MEMBER_OF: 1
  };
  const lineageByPair = new Map();
  for (const edge of edges) {
    if (edge.contributionGroup !== 'lineage') continue;
    const fromNode = nodeMap.get(edge.from);
    const toNode = nodeMap.get(edge.to);
    const actorId = focalById.has(edge.from) ? edge.to : edge.from;
    const actorNode = nodeMap.get(actorId);
    if (!actorNode || String(actorNode.entityType || '').toLowerCase() !== 'person') continue;
    const focalTargetId = actorId === edge.from ? edge.to : edge.from;
    if (!focalById.has(focalTargetId) || !toNode || !fromNode) continue;
    const pairKey = `${actorId}:${focalTargetId}`;
    if (!lineageByPair.has(pairKey)) lineageByPair.set(pairKey, []);
    lineageByPair.get(pairKey).push(edge);
  }
  const redundantLineageIds = new Set();
  for (const pairEdges of lineageByPair.values()) {
    if (pairEdges.length <= 1) continue;
    const hasExplicitExec = pairEdges.some((e) => (EXEC_ROLE_PRIORITY[e.relation] || 2) >= 3);
    const ordered = [...pairEdges].sort(
      (a, b) =>
        (SOURCE_RANK_PRIORITY[b.topSourceRank] || 0) - (SOURCE_RANK_PRIORITY[a.topSourceRank] || 0) ||
        (EXEC_ROLE_PRIORITY[b.relation] || 2) - (EXEC_ROLE_PRIORITY[a.relation] || 2) ||
        String(b.date || '').localeCompare(String(a.date || ''))
    );
    let kept = 0;
    for (const edge of ordered) {
      const prio = EXEC_ROLE_PRIORITY[edge.relation] || 2;
      if (hasExplicitExec && prio <= 1) {
        redundantLineageIds.add(edge.id);
        continue;
      }
      if (kept >= 3) {
        redundantLineageIds.add(edge.id);
        continue;
      }
      kept += 1;
    }
  }
  if (redundantLineageIds.size) {
    for (let i = edges.length - 1; i >= 0; i--) {
      if (redundantLineageIds.has(edges[i].id)) edges.splice(i, 1);
    }
  }

  sharedTargetCenters.clear();
  for (const edge of edges) {
    const fIsFocal = focalById.has(edge.from);
    const tIsFocal = focalById.has(edge.to);
    if (fIsFocal && !tIsFocal) {
      const targetNode = nodeMap.get(edge.to);
      if (targetNode) registerSharedEndpoint({ id: targetNode.id, name: targetNode.label, entity_type: targetNode.entityType }, edge.from);
    } else if (tIsFocal && !fIsFocal) {
      const sourceNode = nodeMap.get(edge.from);
      if (sourceNode) registerSharedEndpoint({ id: sourceNode.id, name: sourceNode.label, entity_type: sourceNode.entityType }, edge.to);
    }
  }

  const parseRoundStageOrdinal = (title = '') => {
    const m = String(title || '').toLowerCase().match(/\b(?:(pre[- ]?seed)|(seed)|(angel)|series\s+([a-k]))\b/);
    if (!m) return null;
    if (m[1]) return 1;
    if (m[2] || m[3]) return 2;
    if (m[4]) return 3 + (m[4].charCodeAt(0) - 97);
    return null;
  };
  const isRoundupPressEvent = (evt = {}, focalName = '') => {
    const urlStr = String(evt.url || '').toLowerCase();
    if (!urlStr) return false;
    const isRoundupSlug = /(?:biggest-vc|largest-funding|top-\d+|weekly-funding|roundup)/.test(urlStr);
    if (!isRoundupSlug) return false;
    const canon = canonicalMapEntityName(focalName).replace(/\s+/g, '');
    return Boolean(canon && !urlStr.replace(/[^a-z0-9]/g, '').includes(canon));
  };

  for (const [focalId, list] of Object.entries(timingEventsByEntity)) {
    const focalName = focalById.get(focalId)?.name || '';
    const chronoRounds = list
      .map((ev) => ({ ev, ord: parseRoundStageOrdinal(ev.title) }))
      .filter((item) => item.ord !== null && item.ev.date)
      .sort((a, b) => String(a.ev.date).localeCompare(String(b.ev.date)));
    let maxOrdSeen = 0;
    let maxOrdTitle = '';
    let maxOrdDate = '';
    for (const item of chronoRounds) {
      if (item.ord < maxOrdSeen) {
        item.ev.isAnomaly = true;
        item.ev.anomalyReason = `Out-of-sequence round: ${item.ev.title} (${item.ev.date}) appears after ${maxOrdTitle} (${maxOrdDate}).`;
      } else if (item.ord > maxOrdSeen) {
        maxOrdSeen = item.ord;
        maxOrdTitle = item.ev.title;
        maxOrdDate = item.ev.date;
      }
    }
    for (const ev of list) {
      if (!ev.isAnomaly && isRoundupPressEvent(ev, focalName)) {
        ev.isAnomaly = true;
        ev.anomalyReason = `Multi-company press roundup URL does not match ${focalName || 'entity'} directly (${ev.title}).`;
      }
      if (ev.isAnomaly) {
        quarantinedAnomalies.push({
          kind: 'timing_anomaly',
          relation: 'TIMING_EVENT',
          path: `${focalName} · ${ev.title}`,
          detail: ev.anomalyReason,
          date: ev.date || null,
          sourceRank: ev.sourceRank || 'PRESS',
          sourceIds: ev.sourceIds || []
        });
      }
    }

    timingEventsByEntity[focalId] = list
      .sort(
        (a, b) =>
          Number(Boolean(a.isAnomaly)) - Number(Boolean(b.isAnomaly)) ||
          (SOURCE_RANK_PRIORITY[b.sourceRank] || 0) - (SOURCE_RANK_PRIORITY[a.sourceRank] || 0) ||
          String(b.date || '').localeCompare(String(a.date || ''))
      )
      .slice(0, 12);
    const fNode = nodeMap.get(focalId);
    if (fNode) fNode.timingCatalysts = timingEventsByEntity[focalId];

    // Surface top 2 verified dated milestones as visible TIMING map nodes/edges
    const seenTimingTitles = new Set();
    let promotedTiming = 0;
    for (const evt of timingEventsByEntity[focalId]) {
      if (promotedTiming >= 2) break;
      const evtLabel = String(evt.label || evt.title || evt.name || '').trim();
      const eventSourceIds = [...new Set([...(Array.isArray(evt.sourceIds) ? evt.sourceIds : []), evt.sourceId].filter(Boolean))];
      if (!evtLabel || !evt.date || eventSourceIds.length === 0) continue;
      const normKey = evtLabel.toLowerCase().slice(0, 36);
      if (seenTimingTitles.has(normKey)) continue;
      seenTimingTitles.add(normKey);

      const evtNodeId = `event:${slugifyBridgeId(`${focalId}-${evtLabel}-${evt.date}`).slice(0, 48)}`;
      const shortName = evtLabel.length > 38 ? `${evtLabel.slice(0, 35)}...` : evtLabel;
      if (!nodeMap.has(evtNodeId)) {
        nodeMap.set(evtNodeId, {
          id: evtNodeId,
          name: shortName,
          label: shortName,
          fullTitle: evtLabel,
          kind: 'event',
          entityType: 'Timing Catalyst',
          contributionGroup: 'timing',
          isTimingCatalyst: true,
          isAnomaly: Boolean(evt.isAnomaly),
          date: evt.date,
          topSourceRank: evt.sourceRank || 'PRESS',
          focalEntityIds: [focalId],
          sourceId: evt.sourceId || eventSourceIds[0],
          sourceIds: eventSourceIds,
          evidenceSources: evt.evidenceSources || [],
          sourceCount: evt.sourceCount || eventSourceIds.length
        });
      }
      const evtEdgeId = `edge:${focalId}:TIMING:${evtNodeId}`;
      if (!edges.some((e) => e.id === evtEdgeId)) {
        edges.push({
          id: evtEdgeId,
          from: focalId,
          to: evtNodeId,
          relation: evt.relation || 'DATED_MILESTONE',
          label: `${shortName} (${evt.date})`,
          date: evt.date,
          contributionGroup: 'timing',
          isTimingCatalyst: true,
          isAnomaly: Boolean(evt.isAnomaly),
          anomalyReason: evt.anomalyReason || null,
          topSourceRank: evt.sourceRank || 'PRESS',
          sourceId: evt.sourceId || eventSourceIds[0],
          sourceIds: eventSourceIds,
          evidenceSources: evt.evidenceSources || [],
          sourceCount: evt.sourceCount || eventSourceIds.length,
          focalEntityId: focalId,
          whyMatters: evt.anomalyReason || `Verified dated milestone (${evt.date}) indicating active operational or financing timing.`
        });
      }
      promotedTiming += 1;
    }
  }

  // Surface verified competitive/sector overlap as a CAUTION bridge across 2+ focal entities
  const formatIndustryName = (raw = '') => {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^[A-Z0-9_]+$/.test(s)) {
      return s
        .toLowerCase()
        .split('_')
        .map((w) => (w === 'and' ? '&' : w === 'ai' ? 'AI' : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(' ');
    }
    return s;
  };
  if (focalEntityIds.length >= 2) {
    const byCategory = new Map();
    const recordIndustryTag = (rawVal, focalId) => {
      const cleaned = formatIndustryName(rawVal);
      if (!cleaned || /^(entity|company|organization|person|unknown)$/i.test(cleaned)) return;
      const key = cleaned.toLowerCase();
      if (!byCategory.has(key)) byCategory.set(key, { label: cleaned, focalIds: new Set() });
      byCategory.get(key).focalIds.add(focalId);
    };
    for (const focalId of focalEntityIds) {
      const fEnt = focalById.get(focalId) || {};
      const fNode = nodeMap.get(focalId);
      recordIndustryTag(fEnt.category || fEnt.sector || fEnt.industry || fNode?.sector, focalId);
      for (const ind of fEnt.relationships?.outgoing?.OPERATES_IN_INDUSTRY || []) {
        recordIndustryTag(ind?.name, focalId);
      }
    }
    const INDUSTRY_PRIORITY = (key) => {
      if (/ai|artificial|software|foundation model/i.test(key)) return 3;
      if (/internet|cloud|fintech|biotech|health|robotics/i.test(key)) return 2;
      if (/semiconductor|hardware/i.test(key)) return 1.5;
      return 1;
    };
    const sharedCategories = [...byCategory.entries()]
      .filter(([, entry]) => entry.focalIds.size >= 2)
      .sort((a, b) => INDUSTRY_PRIORITY(b[0]) - INDUSTRY_PRIORITY(a[0]) || b[1].focalIds.size - a[1].focalIds.size || a[0].localeCompare(b[0]))
      .slice(0, 1);

    for (const [catKey, entry] of sharedCategories) {
      const focalList = [...entry.focalIds];
      const alreadyHasCautionBridge = edges.some(
        (e) => e.contributionGroup === 'caution' && focalList.includes(e.focalEntityId)
      );
      if (alreadyHasCautionBridge) continue;
      const cautionNodeId = `caution:overlap:${slugifyBridgeId(catKey).slice(0, 40)}`;
      const fallbackSrcIds = focalList
        .flatMap((fid) => (nodeMap.get(fid)?.sourceIds || focalById.get(fid)?.sourceIds || []))
        .filter(Boolean)
        .slice(0, 3);
      if (!nodeMap.has(cautionNodeId)) {
        nodeMap.set(cautionNodeId, {
          id: cautionNodeId,
          name: `${entry.label} Rivalry`,
          label: `${entry.label} Rivalry`,
          kind: 'caution',
          entityType: 'Competitive Overlap',
          contributionGroup: 'caution',
          isCautionFlag: true,
          isSharedBridge: true,
          sharedByFocalEntityIds: focalList,
          topSourceRank: 'PRIMARY',
          focalEntityIds: focalList,
          sourceIds: fallbackSrcIds
        });
      }
      for (const fid of focalList) {
        const cEdgeId = `edge:${fid}:SECTOR_OVERLAP:${cautionNodeId}`;
        if (!edges.some((e) => e.id === cEdgeId)) {
          edges.push({
            id: cEdgeId,
            from: fid,
            to: cautionNodeId,
            relation: 'SECTOR_COMPETITION',
            label: `Direct ${entry.label} overlap`,
            contributionGroup: 'caution',
            isCautionFlag: true,
            isSharedBridge: true,
            sharedBridgeNodeId: cautionNodeId,
            sharedByFocalEntityIds: focalList,
            topSourceRank: 'PRIMARY',
            sourceIds: fallbackSrcIds,
            focalEntityId: fid,
            whyMatters: `Multiple mapped entities operate in ${entry.label}; check competitive conflict and customer overlap.`
          });
        }
      }
    }
  }

  const sharedBridgeNodeIds = [];
  for (const { nodeIds, focalIds } of sharedTargetCenters.values()) {
    if (focalIds.size < 2) continue;
    for (const nodeId of nodeIds) {
      const node = nodeMap.get(nodeId);
      if (!node) continue;
      node.isSharedBridge = true;
      node.sharedByFocalEntityIds = [...focalIds];
      // The node and each of its incident verified Cala edges carry the same
      // shared-bridge marker, allowing the UI to highlight a real common path
      // without inventing an edge between focal entities.
      for (const edge of edges) {
        if (edge.from !== nodeId && edge.to !== nodeId) continue;
        edge.isSharedBridge = true;
        edge.sharedBridgeNodeId = nodeId;
        edge.sharedByFocalEntityIds = [...focalIds];
      }
      sharedBridgeNodeIds.push(nodeId);
    }
  }

  // A deep Cala record can contain hundreds of true relationships. The map is
  // a projection of that record, not the record itself: retain every shared
  // bridge and direct focal-to-focal fact, then show a compact, provenance-led
  // set of each focal entity's remaining top connections. Nothing is inferred
  // or deleted from the dossier's raw relationship data.
  const directFocalEdge = (edge) => focalById.has(edge.from) && focalById.has(edge.to);
  const edgeSignalWeight = (edge) => {
    let score = (SOURCE_RANK_PRIORITY[edge.topSourceRank] || 0) * 10;
    if (edge.isRoundExpanded) score += 16;
    if (edge.isLead) score += 8;
    if (PRIORITY_MAP_RELATIONS.has(edge.relation)) score += 6;
    if (edge.relation === 'WORKS_AT' || edge.relation === 'IS_MEMBER_OF') score -= 6;
    if (edge.date) score += 3;
    return score;
  };
  const compareMapEdge = (left, right) =>
    edgeSignalWeight(right) - edgeSignalWeight(left) ||
    String(right.date || '').localeCompare(String(left.date || '')) ||
    String(left.label || '').localeCompare(String(right.label || '')) ||
    String(left.id).localeCompare(String(right.id));
  const selectedEdgeIds = new Set(
    edges
      .filter((edge) => edge.isSharedBridge || directFocalEdge(edge))
      .map((edge) => edge.id)
  );
  const maxNonsharedPerGroup = focalEntityIds.length === 1 ? 3 : 2;
  const maxNonsharedPerFocal = focalEntityIds.length === 1 ? 12 : focalEntityIds.length <= 3 ? 9 : 6;
  for (const focalId of focalEntityIds) {
    const candidates = edges
      .filter((edge) => edge.focalEntityId === focalId && !edge.isSharedBridge && !directFocalEdge(edge))
      .sort(compareMapEdge);
    const selectedForFocal = new Set();
    for (const group of Object.keys(CONTRIBUTION_GROUP_META)) {
      for (const edge of candidates.filter((candidate) => candidate.contributionGroup === group).slice(0, maxNonsharedPerGroup)) {
        selectedEdgeIds.add(edge.id);
        selectedForFocal.add(edge.id);
      }
    }
    for (const edge of candidates) {
      if (selectedForFocal.size >= maxNonsharedPerFocal) break;
      if (selectedForFocal.has(edge.id)) continue;
      selectedEdgeIds.add(edge.id);
      selectedForFocal.add(edge.id);
    }
  }
  const ENTITY_PROVENANCE_WEIGHT = { FILING: 18, PRIMARY: 12, PRESS: 8, AGGREGATOR: 6 };
  const formatEntityDisplayLabel = (raw = '', date = null) => {
    const str = String(raw || '').trim();
    if (!str) return 'Unnamed Cala entity';
    if (/^[A-Z0-9_]{8,}$/.test(str) && str.includes('_')) {
      const words = str
        .toLowerCase()
        .split('_')
        .filter(Boolean)
        .map((w) => (w === 'or' ? '/' : w.charAt(0).toUpperCase() + w.slice(1)));
      const compact = words.slice(0, 3).join(' ');
      const yr = date && String(date).length >= 4 ? ` (${String(date).slice(0, 4)})` : '';
      return `${compact}${yr}`;
    }
    return str;
  };

  const displayEdges = edges.filter((edge) => selectedEdgeIds.has(edge.id)).map((edge) => {
    const rank = String(edge.topSourceRank || 'AGGREGATOR').toUpperCase();
    const basePts = ENTITY_PROVENANCE_WEIGHT[rank] || 6;
    const sharedPts = edge.isSharedBridge ? 6 : 0;
    const datePts = edge.date ? 2 : 0;
    const rarityScore = Math.round((basePts + sharedPts + datePts) * 10) / 10;
    const formulaBreakdown = {
      formula: 'sourceRankWeight + sharedBridgeBonus + datedRecordBonus',
      inputs: `${rank} (+${basePts})${sharedPts ? ` + shared path (+${sharedPts})` : ''}${datePts ? ` + dated ${edge.date} (+${datePts})` : ''} = ${rarityScore} pts`,
      plainMeaning: edge.detail
    };
    return {
      ...edge,
      rarityScore,
      formulaBreakdown
    };
  });

  const visibleNodeIds = new Set(focalEntityIds);
  for (const edge of displayEdges) {
    visibleNodeIds.add(edge.from);
    visibleNodeIds.add(edge.to);
  }
  for (const nodeId of [...nodeMap.keys()]) {
    if (!visibleNodeIds.has(nodeId)) nodeMap.delete(nodeId);
  }
  for (const [nodeId, node] of nodeMap.entries()) {
    const incEdges = displayEdges
      .filter((e) => e.from === nodeId || e.to === nodeId)
      .sort((a, b) => (b.rarityScore || 0) - (a.rarityScore || 0));
    const bestEdge = incEdges[0] || null;
    if (!node.isFocalEntity && bestEdge) {
      node.rarityScore = bestEdge.rarityScore;
      node.formulaBreakdown = bestEdge.formulaBreakdown;
      if (bestEdge.date && !node.date) node.date = bestEdge.date;
    }
    const cleanLbl = formatEntityDisplayLabel(node.label, node.date || bestEdge?.date);
    if (cleanLbl !== node.label) {
      node.rawLabel = node.label;
      node.label = cleanLbl;
    }
  }

  const displayedSharedBridgeNodeIds = sharedBridgeNodeIds.filter((nodeId) => visibleNodeIds.has(nodeId));
  const displayedGroupStats = Object.fromEntries(
    Object.keys(CONTRIBUTION_GROUP_META).map((group) => [group, { nodeIds: new Set(), edgeCount: 0, entries: [], filingNodeIds: new Set() }])
  );
  for (const edge of displayEdges) {
    const stat = displayedGroupStats[edge.contributionGroup];
    if (!stat) continue;
    stat.edgeCount += 1;
    const bridgeIds = [edge.from, edge.to].filter((nodeId) => !focalById.has(nodeId));
    for (const nodeId of bridgeIds) {
      const node = nodeMap.get(nodeId);
      if (!node) continue;
      stat.nodeIds.add(nodeId);
      if (String(edge.topSourceRank || '').toUpperCase() === 'FILING') {
        stat.filingNodeIds.add(nodeId);
      }
      stat.entries.push({
        id: nodeId,
        label: node.label,
        rarityScore: edge.rarityScore || 6,
        topSourceRank: edge.topSourceRank,
        sourceIds: edge.sourceIds || [],
        detail: edge.detail
      });
    }
  }

  const groupSignificanceRaw = {};
  for (const meta of Object.values(CONTRIBUTION_GROUP_META)) {
    const stat = displayedGroupStats[meta.group];
    const dedupEntries = new Map();
    for (const e of stat.entries) {
      const prev = dedupEntries.get(e.id);
      if (!prev || (e.rarityScore || 0) > (prev.rarityScore || 0)) dedupEntries.set(e.id, e);
    }
    const sortedEntries = [...dedupEntries.values()].sort(
      (a, b) =>
        (b.rarityScore || 0) - (a.rarityScore || 0) ||
        (SOURCE_RANK_PRIORITY[b.topSourceRank] || 0) - (SOURCE_RANK_PRIORITY[a.topSourceRank] || 0) ||
        a.label.localeCompare(b.label)
    );
    const topRarity = sortedEntries[0]?.rarityScore || 0;
    const top3Slice = sortedEntries.slice(0, 3).map((e) => e.rarityScore || 0);
    const top3MeanRarity = top3Slice.length ? top3Slice.reduce((s, v) => s + v, 0) / top3Slice.length : 0;
    const filingCount = stat.filingNodeIds.size;
    const filingBonus = Math.min(4.5, filingCount * 1.5);
    const significanceScore = sortedEntries.length
      ? Math.round((topRarity + top3MeanRarity + filingBonus) * 100) / 100
      : 0;
    groupSignificanceRaw[meta.group] = {
      sortedEntries,
      topRarity: Math.round(topRarity * 10) / 10,
      top3MeanRarity: Math.round(top3MeanRarity * 10) / 10,
      filingCount,
      filingBonus: Math.round(filingBonus * 10) / 10,
      significanceScore
    };
  }
  const activeSigScores = Object.values(groupSignificanceRaw).map((g) => g.significanceScore).filter((v) => v > 0);
  const maxGroupSig = activeSigScores.length ? Math.max(...activeSigScores) : 0;
  const minGroupSig = activeSigScores.length ? Math.min(...activeSigScores) : 0;

  const contributionClusters = Object.values(CONTRIBUTION_GROUP_META).map((meta) => {
    const stat = displayedGroupStats[meta.group];
    const g = groupSignificanceRaw[meta.group];
    let visualWeight = 0.6;
    if (g.significanceScore > 0) {
      visualWeight = maxGroupSig > minGroupSig
        ? Math.round((0.88 + ((g.significanceScore - minGroupSig) / (maxGroupSig - minGroupSig)) * 0.77) * 100) / 100
        : 1.15;
    }
    const entityWord = stat.nodeIds.size === 1 ? 'entity' : 'entities';
    return {
      id: meta.id,
      group: meta.group,
      contributionGroup: meta.group,
      label: meta.label,
      subtitle: meta.subtitle,
      nodeCount: stat.nodeIds.size,
      edgeCount: stat.edgeCount,
      startupCount: stat.nodeIds.size,
      topRarity: g.topRarity,
      top3MeanRarity: g.top3MeanRarity,
      filingCount: g.filingCount,
      filingBonus: g.filingBonus,
      significanceScore: g.significanceScore,
      visualWeight,
      significanceFormula: 'topSignalRarity + mean(top3Paths) + min(4.5, FILING_count * 1.5)',
      significanceInputs: `Top: ${g.topRarity.toFixed(1)} + Top3 avg: ${g.top3MeanRarity.toFixed(1)} + ${g.filingCount} FILING (+${g.filingBonus.toFixed(1)}) = ${g.significanceScore.toFixed(1)} pts | ${stat.nodeIds.size} ${entityWord}`,
      topContributors: g.sortedEntries.slice(0, 3)
    };
  });

  const clusters = Object.entries(BRIDGE_FAMILY_META).map(([family, meta]) => {
    const familyEdges = displayEdges.filter((edge) => edge.bridgeFamily === family);
    return {
      id: meta.id,
      bridgeFamily: family,
      label: meta.label,
      subtitle: meta.subtitle || '',
      nodeCount: new Set(familyEdges.flatMap((edge) => [edge.from, edge.to]).filter((id) => !focalEntityIds.includes(id))).size,
      edgeCount: familyEdges.length
    };
  });

  const nodesList = [...nodeMap.values()];
  const decisionIntelligence = buildDecisionIntelligence({
    focalEntities,
    nodes: nodesList,
    edges: displayEdges,
    timingEventsByEntity,
    sourcesById: SOURCES,
    anomalies: quarantinedAnomalies
  });

  return {
    anchor,
    focalEntityIds,
    sharedBridgeNodeIds: displayedSharedBridgeNodeIds,
    clusters,
    contributionClusters,
    timingEventsByEntity,
    quarantinedAnomalies,
    decisionIntelligence,
    nodes: nodesList,
    edges: displayEdges,
    peerEdges: [],
    stats: {
      renderedStartups: Math.max(0, nodeMap.size - focalEntities.length),
      renderedEntities: Math.max(0, nodeMap.size - focalEntities.length),
      renderedFocalEntities: focalEntities.length,
      renderedSharedBridges: displayedSharedBridgeNodeIds.length,
      renderedBridges: displayEdges.length,
      renderedPeerEdges: 0,
      suppressedMegaHubCount: 0,
      hideMegaHubsApplied: Boolean(options.hideMegaHubs)
    }
  };
}

export function computeDataConfidence(company, visibleRounds = [], signals = null) {
  const roundSources = resolveSources((visibleRounds || []).flatMap((r) => r.sourceIds || []));
  const sigRanks = (signals?.arbitrageSignals || []).map((s) => s.sourceRank).filter(Boolean);
  const series = signals?.visibleSeries || company?.employeeCountSeries || [];
  const finMetrics = signals?.visibleFinMetrics || company?.financialMetrics || [];
  const corpEvents = signals?.visibleCorpEvents || company?.corporateEvents || [];
  const roles = company?.peopleCoverage?.roles || [];

  const allRanks = [
    ...roundSources.map((s) => s.sourceRank),
    ...sigRanks,
    ...series.map((p) => p.sourceRank),
    ...finMetrics.map((m) => m.sourceRank),
    ...corpEvents.map((ev) => ev.sourceRank),
    ...roles.map((r) => r.sourceRank)
  ].filter(Boolean);

  let topSourceRank = 'AGGREGATOR';
  let bestPrio = 0;
  for (const r of allRanks) {
    const p = SOURCE_RANK_PRIORITY[String(r).toUpperCase()] || 1;
    if (p > bestPrio) {
      bestPrio = p;
      topSourceRank = String(r).toUpperCase();
    }
  }
  if (!allRanks.length && company?.isLiveCalaDiscovered) {
    topSourceRank = 'PRIMARY';
    bestPrio = 3;
  }

  const rankPts = topSourceRank === 'FILING' ? 45 : topSourceRank === 'PRIMARY' ? 32 : topSourceRank === 'PRESS' ? 18 : 8;
  const hasTimeSeries = series.length >= 2;
  const seriesPts = series.length >= 3 ? 30 : series.length === 2 ? 22 : series.length === 1 ? 10 : 0;
  const hasPeopleCoverage = Boolean(company?.peopleCoverage?.available && roles.length >= 1);
  const peoplePts = hasPeopleCoverage ? (roles.length >= 2 ? 25 : 15) : 0;

  const provenanceScore = Math.min(100, rankPts + seriesPts + peoplePts);
  let grade = 'Early / Sparse';
  if ((topSourceRank === 'FILING' || topSourceRank === 'PRIMARY') && provenanceScore >= 75) {
    grade = 'High';
  } else if (provenanceScore >= 45) {
    grade = 'Medium';
  }

  return {
    grade,
    score: provenanceScore,
    topSourceRank,
    hasTimeSeries,
    hasPeopleCoverage,
    seriesPointsCount: series.length,
    peopleRolesCount: roles.length
  };
}

function extractCandidateSignals(company, visibleRounds, evalDate, cutoffDate = null, coInvestorPath = null) {
  const sortedRounds = [...(visibleRounds || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const latestRound = sortedRounds[sortedRounds.length - 1] || null;
  const visibleSeries = (company.employeeCountSeries || [])
    .filter((pt) => !cutoffDate || pt.date <= cutoffDate)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const visibleCorpEvents = (company.corporateEvents || [])
    .filter((ev) => !cutoffDate || !ev.eventDate || ev.eventDate < cutoffDate)
    .sort((a, b) => (a.eventDate || '').localeCompare(b.eventDate || ''));
  const visibleFinMetrics = (company.financialMetrics || [])
    .filter((m) => !cutoffDate || ((m.filingDate || m.periodEnd || '') < cutoffDate))
    .sort((a, b) => (a.periodEnd || '').localeCompare(b.periodEnd || ''));
  const visibleDomains = (company.domainHistory || [])
    .filter((d) => !cutoffDate || !d.validSince || d.validSince < cutoffDate);

  const entryObs = latestRound && latestRound.date
    ? interpolateHeadcountAtDate(company, latestRound.date, cutoffDate)
    : interpolateHeadcountAtDate(company, evalDate, cutoffDate);
  const latestObs = interpolateHeadcountAtDate(company, evalDate, cutoffDate);

  const headcountAtLastRound = entryObs.headcount;
  const currentObservedEmp = latestObs.headcount;
  const headcountGrowthPct =
    Number.isFinite(headcountAtLastRound) && Number.isFinite(currentObservedEmp) && headcountAtLastRound > 0
      ? Math.max(0, Math.round(((currentObservedEmp - headcountAtLastRound) / headcountAtLastRound) * 100))
      : null;

  const alumniRole = (company.peopleCoverage?.roles || []).find((r) => Boolean(r.priorCompany)) || null;
  const alumniSpinout = alumniRole
    ? {
        name: alumniRole.name,
        role: alumniRole.role,
        relation: alumniRole.relation,
        validSince: alumniRole.validSince,
        priorCompany: alumniRole.priorCompany,
        priorRole: alumniRole.priorRole,
        priorValidUntil: alumniRole.priorValidUntil,
        sourceId: alumniRole.sourceId || latestRound?.sourceIds?.[0] || null
      }
    : null;

  const arbitrageSignals = [];
  const filingEvent = visibleCorpEvents.find((ev) => ev.unannouncedFiling);
  if (filingEvent) {
    arbitrageSignals.push({
      type: 'filing_arbitrage',
      label: filingEvent.name,
      detail: filingEvent.summary,
      date: filingEvent.eventDate,
      sourceRank: 'FILING',
      sourceIds: [filingEvent.sourceId, ...(latestRound?.sourceIds || [])].filter((id) => id && SOURCES[id])
    });
  }

  if (headcountGrowthPct !== null && headcountGrowthPct >= 30) {
    arbitrageSignals.push({
      type: 'headcount_velocity',
      label: `+${headcountGrowthPct}% team growth`,
      detail: `Team expanded ${headcountAtLastRound} to ${currentObservedEmp} employees since ${latestRound?.type || 'last round'}.`,
      date: latestObs.observationDate,
      sourceRank: visibleSeries[visibleSeries.length - 1]?.sourceRank || 'PRIMARY',
      sourceIds: [latestObs.sourceId, ...(latestRound?.sourceIds || [])].filter((id) => id && SOURCES[id])
    });
  }

  const latestFin = visibleFinMetrics[visibleFinMetrics.length - 1] || null;
  if (latestFin && Number.isFinite(latestFin.cashEurM)) {
    arbitrageSignals.push({
      type: 'companies_house_metric',
      label: `Companies House #${company.companiesHouseNumber}`,
      detail: `Cash EUR ${latestFin.cashEurM}M, net assets EUR ${latestFin.netAssetsEurM}M (~${latestFin.runwayMonthsEst}m runway est.).`,
      date: latestFin.filingDate || latestFin.periodEnd,
      sourceRank: 'FILING',
      sourceIds: [latestFin.sourceId].filter((id) => id && SOURCES[id])
    });
  } else if (latestFin) {
    arbitrageSignals.push({
      type: 'cala_financial_metric',
      label: `${latestFin.label || latestFin.metric}`,
      detail: `${latestFin.label || latestFin.metric}: ${latestFin.value}${latestFin.unit ? ` ${latestFin.unit}` : ''}${latestFin.periodEnd ? ` (${latestFin.periodEnd})` : ''}.`,
      date: latestFin.filingDate || latestFin.periodEnd || null,
      sourceRank: latestFin.sourceRank || 'PRIMARY',
      sourceIds: [latestFin.sourceId].filter((id) => id && SOURCES[id])
    });
  }

  const activeAiDomain = visibleDomains.find((d) => d.status === 'ACTIVE' && d.domain.endsWith('.ai'));
  if (activeAiDomain && visibleDomains.some((d) => d.status === 'INACTIVE')) {
    arbitrageSignals.push({
      type: 'domain_shift',
      label: `Domain upgrade -> ${activeAiDomain.domain}`,
      detail: `HAS_DOMAIN_NAME activated ${activeAiDomain.domain} on ${activeAiDomain.validSince}.`,
      date: activeAiDomain.validSince,
      sourceRank: 'PRIMARY',
      sourceIds: [...(latestRound?.sourceIds || [])].filter((id) => id && SOURCES[id])
    });
  }

  if (alumniSpinout) {
    arbitrageSignals.push({
      type: 'alumni_lineage',
      label: `Ex-${alumniSpinout.priorCompany} founder`,
      detail: `${alumniSpinout.name} (${alumniSpinout.priorRole}, until ${alumniSpinout.priorValidUntil}) -> ${alumniSpinout.role}.`,
      date: alumniSpinout.validSince,
      sourceRank: 'FILING',
      sourceIds: [alumniSpinout.sourceId, ...(latestRound?.sourceIds || [])].filter((id) => id && SOURCES[id])
    });
  }

  const monthsSince = latestRound ? monthsBetween(latestRound.date, evalDate) : 0;
  const raisingSoon = monthsSince >= 12 && monthsSince <= 24;

  let whyNowTrigger = '';
  if (filingEvent) {
    whyNowTrigger = `New ${company.country === 'United Kingdom' ? 'Companies House SH01' : 'registry'} filing (${filingEvent.eventDate ? String(filingEvent.eventDate).slice(0, 7) : 'recent'})`;
  } else if (headcountGrowthPct !== null && headcountGrowthPct >= 35) {
    whyNowTrigger = `+${headcountGrowthPct}% hiring velocity since ${latestRound?.type || 'round'}`;
  } else if (latestFin && Number.isFinite(latestFin.runwayMonthsEst) && latestFin.runwayMonthsEst <= 15) {
    whyNowTrigger = `Companies House: EUR ${latestFin.cashEurM}M cash (~${latestFin.runwayMonthsEst}m runway)`;
  } else if (coInvestorPath?.isUpstreamFeeder) {
    whyNowTrigger = `Feeder backed: ${coInvestorPath.coInvestorName}`;
  } else if (alumniSpinout) {
    whyNowTrigger = `Ex-${alumniSpinout.priorCompany} spinout (${alumniSpinout.name.split(' ')[0]})`;
  } else if (raisingSoon && latestRound) {
    whyNowTrigger = `${NEXT_STAGE[latestRound.type] || 'Next'} window (${Math.round(monthsSince)}m post-${latestRound.type})`;
  } else if (latestRound) {
    const headcountText = Number.isFinite(headcountAtLastRound) && Number.isFinite(currentObservedEmp)
      ? ` · ${headcountAtLastRound}->${currentObservedEmp} team`
      : '';
    whyNowTrigger = `${latestRound.type} (${latestRound.date ? String(latestRound.date).slice(0, 7) : 'Cala Graph'})${headcountText}`;
  } else if (latestFin) {
    whyNowTrigger = `${latestFin.label || latestFin.metric}: ${latestFin.value}${latestFin.unit ? ` ${latestFin.unit}` : ''}`;
  } else if (company.registryInfo?.registrationNumber) {
    whyNowTrigger = `${company.registryInfo.registryName} #${company.registryInfo.registrationNumber}${company.foundingDate ? ` (${company.foundingDate.slice(0, 7)})` : ''}`;
  } else if (company.entityCategory === 'established_corp') {
    whyNowTrigger = 'Established / corporate entity (no VC rounds indexed)';
  }

  return {
    visibleSeries,
    visibleCorpEvents,
    visibleFinMetrics,
    visibleDomains,
    headcountAtLastRound,
    currentObservedEmp,
    headcountGrowthPct,
    alumniSpinout,
    arbitrageSignals,
    whyNowTrigger
  };
}

function buildRelationshipGraph(thesis, company, visibleRounds, coInvestorPath) {
  const nodes = [
    { id: thesis.fundId, label: thesis.fundName, type: 'target_fund' },
    { id: company.id, label: company.name, type: 'target_startup' }
  ];
  const links = [];
  const seenNodes = new Set([thesis.fundId, company.id]);

  // Add top co-investors linked to this startup or fund (capped well below 100 nodes)
  const relevantCoInvestors = thesis.topCoInvestors.slice(0, 6);
  for (const ci of relevantCoInvestors) {
    if (!seenNodes.has(ci.id)) {
      nodes.push({ id: ci.id, label: ci.name, type: 'co_investor' });
      seenNodes.add(ci.id);
    }
    links.push({
      source: thesis.fundId,
      target: ci.id,
      label: `${ci.sharedRounds} shared deals`
    });
  }

  // Add links from rounds of the target startup
  for (const round of visibleRounds) {
    for (const invId of round.investorIds) {
      if (invId === thesis.fundId) continue;
      if (!seenNodes.has(invId) && nodes.length < 95) {
        nodes.push({
          id: invId,
          label: PEER_INVESTORS[invId] || invId,
          type: invId === 'angel-syndicate' ? 'angel' : 'peer_investor'
        });
        seenNodes.add(invId);
      }
      if (seenNodes.has(invId)) {
        links.push({
          source: invId,
          target: company.id,
          label: `${round.leadInvestorId === invId ? 'led' : 'joined'} ${round.type}`
        });
      }
    }
  }

  // Add up to 3 shared portfolio bridge nodes if highlighted path exists
  if (coInvestorPath) {
    for (const sampleName of coInvestorPath.sharedPortfolioSample) {
      const port = thesis.portfolioCompanies.find((p) => p.name === sampleName);
      if (port && !seenNodes.has(port.id) && nodes.length < 98) {
        nodes.push({ id: port.id, label: port.name, type: 'portfolio' });
        seenNodes.add(port.id);
        links.push({ source: thesis.fundId, target: port.id, label: 'backed' });
        links.push({ source: coInvestorPath.coInvestorId, target: port.id, label: 'co-invested' });
      }
    }
  }

  return {
    cappedAt: 100,
    nodeCount: nodes.length,
    nodes: nodes.slice(0, 100),
    links
  };
}

export function scoreAndRankCandidates(thesis, options = {}) {
  const rankingMode = options.rankingMode || 'balanced';
  const cutoffDate = options.cutoffDate || null;
  const evalDate = cutoffDate || thesis.evalDate || REFERENCE_DATE;
  const limit = options.limit ?? 200;
  const entityScope = options.entityScope === 'all' ? 'all' : 'startups';
  const includeCompanySet = new Set(
    (options.includeCompanyNames || []).map((n) => normalizeLookupName(n)).filter(Boolean)
  );
  const includeEntityIdSet = new Set((options.includeEntityIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  const seenSet = new Set((options.seenCompanyNames || []).map((n) => n.trim().toLowerCase()).filter(Boolean));
  const excludedIds = new Set(thesis.portfolioCompanyIds || []);
  const weights = getWeights(rankingMode);

  const sectorShareMap = Object.fromEntries(thesis.sectorMix.map((s) => [s.label, s.sharePct / 100]));
  const stageShareMap = Object.fromEntries(thesis.stageMix.map((s) => [s.label, s.sharePct / 100]));
  const countryShareMap = Object.fromEntries(thesis.geographyMix.map((g) => [g.label, g.sharePct / 100]));
  const regionShareMap = Object.fromEntries(thesis.regionMix.map((r) => [r.label, r.sharePct / 100]));
  const topSectorSet = new Set(thesis.sectorMix.slice(0, 2).map((s) => s.label));

  const scored = [];

  for (const company of COMPANIES) {
    if (cutoffDate && (company.isLiveCalaDiscovered || company.isRegistryDiscovered || company.entityCategory === 'established_corp')) continue;
    if (excludedIds.has(company.id)) continue;
    if (seenSet.has(company.name.toLowerCase())) continue;

    const explicitlyIncluded =
      includeCompanySet.has(normalizeLookupName(company.name)) ||
      includeEntityIdSet.has(String(company.id)) ||
      includeEntityIdSet.has(String(company.calaEntityId || ''));
    const retainLiveEntity = Boolean(company.isLiveCalaDiscovered || explicitlyIncluded);
    if (entityScope !== 'all' && company.entityCategory === 'established_corp' && !retainLiveEntity) continue;

    const visibleRounds = cutoffDate
      ? company.rounds.filter((r) => r.date < cutoffDate)
      : [...company.rounds];
    const allowUnfunded =
      !cutoffDate && (company.isRegistryDiscovered || company.isLiveCalaDiscovered || company.entityCategory === 'established_corp' || entityScope === 'all' || explicitlyIncluded);
    if (!visibleRounds.length && !allowUnfunded) continue;

    visibleRounds.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const latestRound = visibleRounds[visibleRounds.length - 1] || null;
    const monthsSince = latestRound && latestRound.date ? monthsBetween(latestRound.date, evalDate) : null;

    // 1. Sector fit
    const exactSectorShare = sectorShareMap[company.sector] || 0;
    const adjacentMatch = (SECTOR_ADJACENCY[company.sector] || []).some((adj) => topSectorSet.has(adj));
    const sectorRatio = Math.min(1, exactSectorShare * 2.1 + (exactSectorShare === 0 && adjacentMatch ? 0.45 : 0));
    const sectorPts = Math.round(weights.sector * sectorRatio * 10) / 10;

    // 2. Syndicate & Upstream Feeder link + Signals + Provenance + Multi-Bridge Folders
    const coInvestorPath = buildCoInvestorPath(thesis, company, visibleRounds);
    const hasAngelOnly =
      Boolean(latestRound && latestRound.investorIds.length === 1 && latestRound.investorIds[0] === 'angel-syndicate');
    const signals = extractCandidateSignals(company, visibleRounds, evalDate, cutoffDate, coInvestorPath);
    const dataConfidence = computeDataConfidence(company, visibleRounds, signals);
    const hiddenBridgesResult = extractHiddenBridges(thesis, company, visibleRounds, signals, {
      hideMegaHubs: options.hideMegaHubs ?? true,
      bridgeFamily: options.bridgeFamily ?? null,
      filingOnly: options.filingOnly ?? false,
      maxPaths: options.maxBridgePaths ?? 5
    });
    const evidenceFolders = buildEvidenceFolders(company, visibleRounds, signals, hiddenBridgesResult, dataConfidence);
    const diligencePacket = buildAnalystDiligencePacket(company, thesis, signals, hiddenBridgesResult, evidenceFolders);

    // 3. Stage & Time-Travel Entry Kernel (70% next-stage/ticket fit + 30% entry kernel)
    const likelyNextStage = latestRound
      ? NEXT_STAGE[latestRound.type] || 'Not found in Cala'
      : company.entityCategory === 'established_corp'
        ? 'Public / Mature'
        : 'Not found in Cala';
    let stageTicketRatio = company.entityCategory === 'established_corp' ? 0.12 : 0.55;
    if (latestRound) {
      const currentStageShare = stageShareMap[latestRound.type] || 0;
      const nextStageShare = stageShareMap[likelyNextStage] || 0;
      const nextStageRatio = Math.min(1, Math.max(nextStageShare * 1.8, currentStageShare * 1.4));

      let bestSizeFit = 0.5;
      if (thesis.medianRoundSizeEurM && latestRound.amountEurM) {
        const expectedNextSize = latestRound.amountEurM * 2.2;
        const ratioCurrent =
          Math.min(latestRound.amountEurM, thesis.medianRoundSizeEurM) /
          Math.max(latestRound.amountEurM, thesis.medianRoundSizeEurM);
        const ratioNext =
          Math.min(expectedNextSize, thesis.medianRoundSizeEurM) /
          Math.max(expectedNextSize, thesis.medianRoundSizeEurM);
        bestSizeFit = Math.max(ratioCurrent, ratioNext);
      }
      stageTicketRatio = Math.min(1, 0.65 * nextStageRatio + 0.35 * bestSizeFit);
    }

    let hcKernel = 0.5;
    const tp = thesis.timeTravelProfile || {};
    if (tp.medianEntryHeadcount && (signals.visibleSeries.length > 0 || company.employeeCount)) {
      const emp = signals.currentObservedEmp;
      if (
        tp.entryHeadcountP25 != null &&
        tp.entryHeadcountP75 != null &&
        emp >= tp.entryHeadcountP25 &&
        emp <= tp.entryHeadcountP75
      ) {
        hcKernel = 1.0;
      } else {
        hcKernel = Math.max(
          0.2,
          Math.min(1, Math.min(emp, tp.medianEntryHeadcount) / Math.max(1, Math.max(emp, tp.medianEntryHeadcount)))
        );
      }
    }
    let ageKernel = 0.5;
    const foundingStr = company.foundingDate || (company.foundedYear ? `${company.foundedYear}-02-15` : null);
    if (tp.medianEntryAgeMonths && foundingStr) {
      const companyAgeMonths = Math.max(1, monthsBetween(foundingStr, evalDate));
      const sigma = Math.max(12, tp.medianEntryAgeMonths * 0.6);
      ageKernel = Math.max(0.2, Math.exp(-0.5 * Math.pow((companyAgeMonths - tp.medianEntryAgeMonths) / sigma, 2)));
    }
    const stageRatio = Math.min(1, 0.7 * stageTicketRatio + 0.3 * (0.6 * hcKernel + 0.4 * ageKernel));
    const stagePts = Math.round(weights.stage * stageRatio * 10) / 10;

    // 4. Syndicate score (same-round co-investors + upstream feeder lift + lead bonus)
    let syndicatePts = 0;
    if (weights.syndicate > 0 && coInvestorPath) {
      const baseStrength = 0.5 + Math.min(0.25, (coInvestorPath.sharedCount || 0) * 0.12);
      const feederLiftBonus = coInvestorPath.isUpstreamFeeder
        ? Math.min(0.25, 0.1 + (coInvestorPath.feederLift || 0) * 0.12)
        : 0;
      const leadBonus = coInvestorPath.startupRole === 'led' ? 0.15 : 0;
      const strength = Math.min(1, baseStrength + feederLiftBonus + leadBonus);
      syndicatePts = Math.round(weights.syndicate * strength * 10) / 10;
    }

    // 5. Team Momentum & Lineage (60% post-round headcount velocity + 40% temporal alumni lineage; neutral 0.50 baseline when missing)
    let velocityRatio = 0.5;
    if (signals.visibleSeries.length >= 2 && signals.headcountAtLastRound > 0) {
      velocityRatio = Math.max(0.25, Math.min(1, 0.35 + signals.headcountGrowthPct / 100));
    }
    let alumniRatio = 0.5;
    const peopleRoles = company.peopleCoverage?.roles || [];
    if (signals.alumniSpinout) {
      alumniRatio = 1.0;
    } else if (company.peopleCoverage?.available && peopleRoles.length > 0) {
      alumniRatio = 0.65;
    }
    const momentumRatio = Math.min(1, 0.6 * velocityRatio + 0.4 * alumniRatio);
    const momentumPts = Math.round(weights.momentum * momentumRatio * 10) / 10;

    // 6. Geography score
    const countryShare = countryShareMap[company.country] || 0;
    const regionShare = regionShareMap[company.region] || 0;
    const geoRatio = Math.min(1, countryShare * 2.2 + (countryShare === 0 ? regionShare * 0.75 : 0));
    const geoPts = Math.round(weights.geography * geoRatio * 10) / 10;

    // 7. Continuous Timing Window (peaking 14-22m) & Filing/Runway Arbitrage Bonus (0..+5 pts)
    const raisingSoon = monthsSince !== null && monthsSince >= 12 && monthsSince <= 24;
    const untappedBoost = rankingMode === 'untapped' && hasAngelOnly ? 4 : 0;
    const timingWindowPts =
      monthsSince !== null
        ? 2.5 * Math.exp(-0.5 * Math.pow((monthsSince - 18) / 4.5, 2))
        : company.entityCategory === 'established_corp'
          ? 0
          : 0.8;
    const hasFilingArbitrage = signals.visibleCorpEvents.some(
      (ev) =>
        ev.unannouncedFiling ||
        (ev.eventType === 'FINANCING_RAISED_OR_FACILITY_ENTERED' &&
          (ev.sourceRank === 'FILING' || SOURCES[ev.sourceId]?.sourceRank === 'FILING'))
    );
    const latestFin = signals.visibleFinMetrics[signals.visibleFinMetrics.length - 1] || null;
    const finArbitragePts = latestFin ? (Number.isFinite(latestFin.runwayMonthsEst) && latestFin.runwayMonthsEst <= 16 ? 1.0 : 0.5) : 0;
    const arbitrageBonus = Math.min(
      5,
      Math.round((timingWindowPts + (hasFilingArbitrage ? 1.5 : 0) + finArbitragePts) * 10) / 10
    );

    const totalScore = Math.min(
      99,
      Math.round(sectorPts + stagePts + syndicatePts + momentumPts + geoPts + untappedBoost + arbitrageBonus)
    );
    const scoreBreakdown = {
      sector: { earned: sectorPts, max: weights.sector },
      stage: { earned: stagePts, max: weights.stage },
      syndicate: { earned: syndicatePts, max: weights.syndicate },
      momentum: { earned: momentumPts, max: weights.momentum },
      geography: { earned: geoPts, max: weights.geography },
      arbitrageBonus: { earned: arbitrageBonus, max: 5 }
    };
    Object.defineProperty(scoreBreakdown, 'coInvestor', {
      get() {
        return this.syndicate;
      },
      enumerable: false
    });

    const directCompetitorOf = thesis.portfolioCompetitorGroups[company.competitorGroup] || null;

    // Similar past deals in portfolio
    const similarPortfolio = thesis.portfolioCompanies
      .filter((p) => p.sector === company.sector || p.country === company.country)
      .sort((a, b) => {
        const aExact = (a.sector === company.sector ? 2 : 0) + (a.country === company.country ? 1 : 0);
        const bExact = (b.sector === company.sector ? 2 : 0) + (b.country === company.country ? 1 : 0);
        return bExact - aExact;
      })
      .slice(0, 2);

    // Build source-grounded reasons (every sentence must carry a Cala or registry source ID)
    const candidateReasons = [];
    const primarySourceIds = latestRound
      ? latestRound.sourceIds || []
      : [
          company.registryInfo?.sourceId,
          ...(company.corporateEvents || []).map((ev) => ev.sourceId)
        ].filter((id) => id && SOURCES[id]);
    const portfolioSourceIds = similarPortfolio.flatMap((p) => p.sourceIds || []).slice(0, 1);

    const sameSectorPortfolioCount = thesis.portfolioCompanies.filter((p) => p.sector === company.sector).length;
    const sameCountryPortfolioCount = thesis.portfolioCompanies.filter((p) => p.country === company.country).length;

    if (company.entityCategory === 'established_corp') {
      const regText = company.registryInfo
        ? `${company.registryInfo.registryName} #${company.registryInfo.registrationNumber}${company.registryInfo.industryDescription ? ` (${company.registryInfo.industryDescription})` : ''}`
        : 'Cala knowledge graph';
      candidateReasons.push({
        text: `Established / corporate entity verified via ${regText}; no early-stage VC rounds indexed.`,
        sourceIds: primarySourceIds
      });
    } else if (sameSectorPortfolioCount > 0 || sameCountryPortfolioCount > 0) {
      const parts = [];
      if (sameSectorPortfolioCount > 0) parts.push(`${company.sector} (${sameSectorPortfolioCount} portfolio deals)`);
      if (sameCountryPortfolioCount > 0) parts.push(`${company.country} (${sameCountryPortfolioCount} portfolio deals)`);
      candidateReasons.push({
        text: `Matches ${parts.join(' and ')} pattern from recent deals such as ${similarPortfolio.map((p) => p.name).join(' and ') || 'existing portfolio'}.`,
        sourceIds: [...new Set([...primarySourceIds, ...portfolioSourceIds])]
      });
    } else {
      candidateReasons.push({
        text: `${company.sector} operating in ${company.country}, adjacent to ${thesis.sectorMix[0]?.label || 'core'} focus.`,
        sourceIds: primarySourceIds
      });
    }

    if (coInvestorPath) {
      candidateReasons.push({
        text: coInvestorPath.summary,
        sourceIds: coInvestorPath.sourceIds
      });
    } else if (hasAngelOnly && latestRound) {
      const amtStr = latestRound.amountEurM !== null && latestRound.amountEurM !== undefined ? ` (€${latestRound.amountEurM}M)` : '';
      candidateReasons.push({
        text: `Untapped institutional profile: ${latestRound.type} backed by angel syndicate${amtStr} with no competing VC lead yet.`,
        sourceIds: primarySourceIds
      });
    }

    if (raisingSoon && latestRound) {
      const amtPrefix = latestRound.amountEurM !== null && latestRound.amountEurM !== undefined ? `€${latestRound.amountEurM}M ` : '';
      const dateStr = latestRound.date ? String(latestRound.date).slice(0, 7) : 'undated';
      candidateReasons.push({
        text: `Likely raising ${likelyNextStage} soon: ${monthsSince} months since ${amtPrefix}${latestRound.type} (${dateStr}).`,
        sourceIds: primarySourceIds
      });
    } else if (latestRound) {
      const amtPrefix = latestRound.amountEurM !== null && latestRound.amountEurM !== undefined ? `€${latestRound.amountEurM}M ` : '';
      const datePart = latestRound.date ? ` on ${String(latestRound.date).slice(0, 7)} (${monthsSince} months ago)` : '';
      candidateReasons.push({
        text: `Latest round was ${amtPrefix}${latestRound.type}${datePart}.`,
        sourceIds: primarySourceIds
      });
    } else if (company.registryInfo) {
      candidateReasons.push({
        text: `Official filing in ${company.registryInfo.registryName} (#${company.registryInfo.registrationNumber}, status: ${company.registryInfo.status}); VC rounds not indexed in Cala.`,
        sourceIds: primarySourceIds
      });
    }

    if (signals.arbitrageSignals.length > 0) {
      const topSig = signals.arbitrageSignals[0];
      candidateReasons.push({
        text: `${topSig.label}: ${topSig.detail}`,
        sourceIds: topSig.sourceIds.length ? topSig.sourceIds : primarySourceIds
      });
    }

    const reasons = enforceFactCitations(candidateReasons);
    const graph = buildRelationshipGraph(thesis, company, visibleRounds, coInvestorPath);

    // Surface only connections present in the Cala graph.  The previous
    // implementation filled this list with regional LinkedIn assumptions.
    const startupInvestorIds = new Set(visibleRounds.flatMap((r) => r.investorIds).filter((id) => id !== 'angel-syndicate'));
    const startupInvestorNames = new Set((company.liveInvestorNames || []).map(normalizeLookupName).filter(Boolean));
    const startupPeople = new Set((company.peopleCoverage?.roles || []).map((r) => normalizeLookupName(r.name)).filter(Boolean));

    const peerStartups = [];
    for (const other of COMPANIES) {
      if (other.id === company.id) continue;
      const otherInvIds = new Set(other.rounds.flatMap((r) => r.investorIds).filter((id) => id !== 'angel-syndicate'));
      const sharedInvestors = [...startupInvestorIds].filter((id) => otherInvIds.has(id));
      const otherInvestorNames = new Set((other.liveInvestorNames || []).map(normalizeLookupName).filter(Boolean));
      const sharedLiveInvestor = [...startupInvestorNames].find((name) => otherInvestorNames.has(name));
      const otherPeople = new Set((other.peopleCoverage?.roles || []).map((r) => normalizeLookupName(r.name)).filter(Boolean));
      const sharedPerson = [...startupPeople].find((name) => otherPeople.has(name));
      const isCandidate = !excludedIds.has(other.id);
      if (sharedInvestors.length > 0 && isCandidate) {
        const invName = PEER_INVESTORS[sharedInvestors[0]] || sharedInvestors[0];
        peerStartups.push({
          id: other.id,
          name: other.name,
          sector: other.sector,
          country: other.country,
          connectionType: 'cala_shared_investor',
          bridgeLabel: `Shared investor: ${invName}`
        });
      } else if (sharedLiveInvestor && isCandidate) {
        peerStartups.push({
          id: other.id,
          name: other.name,
          sector: other.sector,
          country: other.country,
          connectionType: 'cala_shared_investor',
          bridgeLabel: `Shared investor: ${sharedLiveInvestor}`
        });
      } else if (sharedPerson && isCandidate) {
        peerStartups.push({
          id: other.id,
          name: other.name,
          sector: other.sector,
          country: other.country,
          connectionType: 'cala_shared_person',
          bridgeLabel: `Shared Cala person: ${sharedPerson}`
        });
      }
      if (peerStartups.length >= 4) break;
    }

    const nonMegaCount = (hiddenBridgesResult.bridges || []).filter((b) => !b.isMegaHub).length;
    const signalTier = computeSignalTier({
      bridges: hiddenBridgesResult.bridges,
      dataConfidence,
      urgencyTriggers: diligencePacket.urgencyTriggers,
      suitabilityScore: totalScore
    });
    const matchOrderFormula = buildMatchOrderFormula(scoreBreakdown, totalScore, rankingMode, dataConfidence, nonMegaCount);

    scored.push({
      id: company.id,
      calaEntityId: company.calaEntityId,
      isLiveCalaDiscovered: Boolean(company.isLiveCalaDiscovered),
      isRegistryDiscovered: Boolean(company.isRegistryDiscovered),
      entityCategory: company.entityCategory || 'startup',
      registryInfo: company.registryInfo || null,
      website: company.website || null,
      attendingSlush2026: Boolean(company.attendingSlush2026),
      name: company.name,
      oneLiner: company.oneLiner,
      description: company.description,
      sector: company.sector,
      subSectors: company.subSectors,
      country: company.country,
      region: company.region,
      hqCity: company.hqCity,
      foundingDate: company.foundingDate || (company.foundedYear ? `${company.foundedYear}-02-15` : null),
      employeeCount: signals.currentObservedEmp,
      headcountAtLastRound: signals.headcountAtLastRound,
      headcountGrowthPct: signals.headcountGrowthPct,
      employeeCountSeries: signals.visibleSeries,
      whyNowTrigger: signals.whyNowTrigger,
      arbitrageSignals: signals.arbitrageSignals,
      alumniSpinout: signals.alumniSpinout,
      companiesHouseNumber: company.companiesHouseNumber || null,
      financialMetrics: signals.visibleFinMetrics,
      corporateEvents: signals.visibleCorpEvents,
      domainHistory: signals.visibleDomains,
      peopleCoverage: company.peopleCoverage,
      liveInvestorNames: company.liveInvestorNames || [],
      dataConfidence,
      stage: latestRound
        ? latestRound.type
        : company.entityCategory === 'established_corp'
          ? 'Public / Mature'
          : 'Registered (Unfunded)',
      likelyNextStage,
      lastRoundDate: latestRound ? latestRound.date : null,
      lastRoundAmountEurM: latestRound ? latestRound.amountEurM : null,
      monthsSinceLastRound: monthsSince,
      raisingSoon,
      untappedSignal: hasAngelOnly,
      directCompetitorOf,
      suitabilityScore: totalScore,
      signalTier,
      matchOrderFormula,
      triageNote: evidenceFolders.triageNote,
      scoreBreakdown,
      reasons,
      coInvestorPath,
      evidenceFolders,
      diligencePacket,
      peerStartups,
      similarPortfolio: similarPortfolio.map((p) => ({
        id: p.id,
        name: p.name,
        sector: p.sector,
        country: p.country,
        sources: resolveSources((p.sourceIds || []).slice(0, 1))
      })),
      roundHistory: visibleRounds.map((r) => ({
        id: r.id,
        calaRoundId: r.calaRoundId,
        type: r.type,
        date: r.date,
        amountEurM: r.amountEurM,
        valuationEurM: r.valuationEurM,
        leadInvestorName: company.liveInvestorsMap?.[r.leadInvestorId] || PEER_INVESTORS[r.leadInvestorId] || r.leadInvestorId || null,
        investorNames: [...new Set([
          ...(r.investorIds || []).map((id) => company.liveInvestorsMap?.[id] || PEER_INVESTORS[id] || id),
          ...(r.investorNames || [])
        ])].filter(Boolean),
        sources: resolveSources(r.sourceIds)
      })),
      graph
    });
  }

  scored.sort(
    (a, b) =>
      b.suitabilityScore - a.suitabilityScore ||
      (b.raisingSoon ? 1 : 0) - (a.raisingSoon ? 1 : 0) ||
      a.name.localeCompare(b.name)
  );

  return {
    rankingMode,
    weights,
    totalCandidatesEvaluated: scored.length,
    shortlist: scored.slice(0, limit),
    allRanked: scored
  };
}

/**
 * Q27: Point-in-Time Backtest.
 * Hides deals whose first investment by this fund happened in the last 12 months,
 * strips all post-cutoff rounds across every startup (zero future data leakage),
 * rebuilds the thesis purely from pre-cutoff deals, and checks how many hidden deals
 * land in the Top 15 and Top 50.
 */
export function runPointInTimeBacktest(fundId) {
  const cutoffDate = subtractMonths(REFERENCE_DATE, 12);
  const fund = FUNDS.find((f) => f.id === fundId);
  if (!fund) {
    return null;
  }

  const hiddenDeals = [];
  for (const company of COMPANIES) {
    if (company.isLiveCalaDiscovered) continue;
    const fundRounds = company.rounds.filter((r) => r.investorIds.includes(fund.id)).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    if (!fundRounds.length) continue;
    const firstFundDealDate = fundRounds[0].date;
    const hadPreCutoffRound = company.rounds.some((r) => r.date < cutoffDate);
    if (firstFundDealDate >= cutoffDate && hadPreCutoffRound) {
      hiddenDeals.push({
        companyId: company.id,
        name: company.name,
        actualRoundType: fundRounds[0].type,
        actualDate: firstFundDealDate,
        sourceIds: fundRounds[0].sourceIds || []
      });
    }
  }

  const preCutoffThesis = computeRevealedThesis({ mode: 'fund', fundId }, { cutoffDate });
  const backtestRun = scoreAndRankCandidates(preCutoffThesis, {
    rankingMode: 'balanced',
    cutoffDate,
    limit: 50
  });

  const rankMap = new Map(backtestRun.allRanked.map((item, idx) => [item.id, { rank: idx + 1, item }]));

  const evaluatedHidden = hiddenDeals.map((hd) => {
    const found = rankMap.get(hd.companyId);
    return {
      ...hd,
      sources: resolveSources(hd.sourceIds),
      predictedRank: found ? found.rank : null,
      predictedScore: found ? found.item.suitabilityScore : null,
      inTop15: Boolean(found && found.rank <= 15),
      inTop50: Boolean(found && found.rank <= 50),
      coInvestorHint: found?.item?.coInvestorPath?.summary || 'No shared pre-cutoff co-investor link'
    };
  });

  const hitsTop15 = evaluatedHidden.filter((d) => d.inTop15).length;
  const hitsTop50 = evaluatedHidden.filter((d) => d.inTop50).length;
  const totalActual = evaluatedHidden.length;
  const recallAt15 = totalActual > 0 ? Math.round((hitsTop15 / totalActual) * 1000) / 1000 : 0;
  const recallAt50 = totalActual > 0 ? Math.round((hitsTop50 / totalActual) * 1000) / 1000 : 0;
  const mrrSum = evaluatedHidden.reduce((sum, d) => sum + (d.predictedRank ? 1 / d.predictedRank : 0), 0);
  const mrr = totalActual > 0 ? Math.round((mrrSum / totalActual) * 1000) / 1000 : 0;

  return {
    fundId: fund.id,
    fundName: fund.name,
    cutoffDate,
    preCutoffDealsCount: preCutoffThesis.dealsAnalyzedCount,
    candidatePoolAtCutoff: backtestRun.totalCandidatesEvaluated,
    hiddenDealsCount: totalActual,
    totalActualDeals: totalActual,
    hitsInTop15: hitsTop15,
    hitsInTop50: hitsTop50,
    recallAt15,
    recallAt50,
    mrr,
    summaryText:
      totalActual > 0
        ? `Using only deals before ${cutoffDate} (${preCutoffThesis.dealsAnalyzedCount} deals, zero post-cutoff leakage), ${hitsTop15} of ${totalActual} actual investments made in the last 12 months ranked in the Top 15 (${hitsTop50}/${totalActual} in Top 50, MRR ${mrr}).`
        : `No post-cutoff (${cutoffDate}) new portfolio deals available in Cala snapshot for this fund.`,
    hiddenDeals: evaluatedHidden
  };
}

export function buildStartupBrief(startupId, fundId = null) {
  const company = COMPANIES.find((c) => c.id === startupId);
  if (!company) {
    const err = new Error(`Startup "${startupId}" was not found in Cala.`);
    err.statusCode = 404;
    throw err;
  }

  let thesis = null;
  let matchContext = null;
  if (fundId && fundId !== 'custom-proxy') {
    thesis = computeRevealedThesis({ mode: 'fund', fundId });
    const ranked = scoreAndRankCandidates(thesis, {
      limit: 200,
      entityScope: 'all',
      includeCompanyNames: [company.name]
    });
    matchContext = ranked.allRanked.find((r) => r.id === startupId) || null;
  }

  const roundsWithSources = company.rounds.map((r) => ({
    id: r.id,
    calaRoundId: r.calaRoundId,
    type: r.type,
    date: r.date,
    amountEurM: r.amountEurM,
    valuationEurM: r.valuationEurM !== null ? r.valuationEurM : 'Not found in Cala',
    leadInvestorName: company.liveInvestorsMap?.[r.leadInvestorId] || PEER_INVESTORS[r.leadInvestorId] || r.leadInvestorId || null,
    investorNames: [...new Set([
      ...(r.investorIds || []).map((id) => company.liveInvestorsMap?.[id] || PEER_INVESTORS[id] || id),
      ...(r.investorNames || [])
    ])].filter(Boolean),
    sources: resolveSources(r.sourceIds)
  }));

  const signals = extractCandidateSignals(
    company,
    company.rounds,
    REFERENCE_DATE,
    null,
    matchContext?.coInvestorPath || null
  );
  const dataConfidence = computeDataConfidence(company, company.rounds, signals);
  const hiddenBridgesResult = extractHiddenBridges(thesis, company, company.rounds, signals, {
    hideMegaHubs: true,
    maxPaths: 5
  });
  const evidenceFolders = buildEvidenceFolders(company, company.rounds, signals, hiddenBridgesResult, dataConfidence, matchContext);
  const diligencePacket = buildAnalystDiligencePacket(company, thesis, signals, hiddenBridgesResult, evidenceFolders);

  const allSourcesMap = new Map();
  const extraSourceIds = [
    ...(signals.arbitrageSignals || []).flatMap((sig) => sig.sourceIds || []),
    ...(company.corporateEvents || []).map((ev) => ev.sourceId),
    ...(company.financialMetrics || []).map((m) => m.sourceId),
    ...(company.employeeCountSeries || []).map((p) => p.sourceId),
    ...(company.peopleCoverage?.roles || []).map((r) => r.sourceId)
  ].filter(Boolean);
  for (const s of resolveSources(extraSourceIds)) {
    allSourcesMap.set(s.id, s);
  }
  for (const r of roundsWithSources) {
    for (const s of r.sources) {
      if (!allSourcesMap.has(s.id)) allSourcesMap.set(s.id, s);
    }
  }

  const notFoundInCala = buildMissingFromCala(company, roundsWithSources, signals);

  const memoLines = [
    `# Investment Brief: ${company.name}`,
    `Cala Entity ID: ${company.calaEntityId || 'Not indexed in Cala (Official Registry Record)'}`,
    ...(company.registryInfo
      ? [`Official Registry: ${company.registryInfo.registryName} #${company.registryInfo.registrationNumber} (${company.registryInfo.status})`]
      : []),
    `HQ: ${company.hqCity || 'Not found in Cala'}, ${company.country || 'Not found in Cala'} | Sector: ${company.sector || 'Not found in Cala'} | Employees: ${company.employeeCount ?? 'Not found in Cala'} | Founded: ${company.foundingDate || company.foundedYear || 'Not found in Cala'}`,
    `Data Confidence: ${dataConfidence.grade} (${dataConfidence.topSourceRank})`,
    ``,
    `## Overview`,
    `${company.description}`,
    ``,
    matchContext ? `## Fit vs. ${matchContext.suitabilityScore}/100 Suitability Score` : `## Fit Context`,
    ...(matchContext ? matchContext.reasons.map((r) => `- ${r.text} [${r.sources.map((s) => s.title).join('; ')}]`) : ['- Standalone Cala/Registry company profile']),
    ``,
    `## Time-Series & Filing Arbitrage Signals`,
    `- Why Now: ${signals.whyNowTrigger || 'No recent round trigger indexed'}`,
    `- Headcount Velocity: ${Number.isFinite(signals.headcountAtLastRound) && Number.isFinite(signals.currentObservedEmp) ? `${signals.headcountAtLastRound} -> ${signals.currentObservedEmp} employees (${signals.headcountGrowthPct ?? 'Not found in Cala'}% since latest round)` : 'Not found in Cala'}`,
    ...signals.arbitrageSignals.map((sig) => `- [${sig.sourceRank}] ${sig.label}: ${sig.detail} (${sig.date})`),
    ``,
    `## Funding History (Cala Sourced)`,
    ...(roundsWithSources.length
      ? roundsWithSources.map(
          (r) =>
            `- ${r.date || 'Undated'} | ${r.type} | ${r.amountEurM !== null && r.amountEurM !== undefined ? `EUR ${r.amountEurM}M` : 'Amount not in Cala'} | Lead: ${r.leadInvestorName || 'Not found'} | Investors: ${r.investorNames.join(', ')} | Sources: ${r.sources.map((s) => s.url).join(', ')}`
        )
      : ['- No VC funding rounds indexed in Cala.']),
    ``,
    `## Explicit Coverage Gaps (Not Found in Cala)`,
    ...notFoundInCala.map((g) => `- ${g.field}: ${g.status} (${g.reason})`),
    ``,
    `## Partner Screening & Call #1 Questions (Deterministic)`,
    `- Conflict Check (${diligencePacket.conflictRisk.level}): ${diligencePacket.conflictRisk.reason}`,
    ...(diligencePacket.synergisticTwin
      ? [`- Pattern Twin: ${diligencePacket.synergisticTwin.patternSummary}`]
      : []),
    `- Timing Inflection: ${diligencePacket.urgencyStatus}`,
    ...diligencePacket.riskFlags.map((f) => `- [${f.severity.toUpperCase()}] ${f.label}: ${f.detail} (Rule: ${f.rule})`),
    ...diligencePacket.callQuestions.map((q, i) => `- Call Q${i + 1} [${q.category}]: ${q.question}`)
  ];

  const nonMegaBriefCount = (hiddenBridgesResult.bridges || []).filter((b) => !b.isMegaHub).length;
  const signalTier = computeSignalTier({
    bridges: hiddenBridgesResult.bridges,
    dataConfidence,
    urgencyTriggers: diligencePacket.urgencyTriggers,
    suitabilityScore: matchContext?.suitabilityScore ?? 55
  });
  const matchOrderFormula = matchContext?.scoreBreakdown
    ? buildMatchOrderFormula(
        matchContext.scoreBreakdown,
        matchContext.suitabilityScore,
        'balanced',
        dataConfidence,
        nonMegaBriefCount
      )
    : `Standalone profile audit (${dataConfidence.topSourceRank} top proof; ${nonMegaBriefCount} non-mega bridges).`;

  return {
    id: company.id,
    calaEntityId: company.calaEntityId,
    isLiveCalaDiscovered: Boolean(company.isLiveCalaDiscovered),
    isRegistryDiscovered: Boolean(company.isRegistryDiscovered),
    entityCategory: company.entityCategory || 'startup',
    registryInfo: company.registryInfo || null,
    website: company.website || null,
    name: company.name,
    oneLiner: company.oneLiner,
    description: company.description,
    sector: company.sector,
    subSectors: company.subSectors,
    hqCity: company.hqCity,
    country: company.country,
    region: company.region,
    foundedYear: company.foundedYear,
    foundingDate: company.foundingDate || null,
    employeeCount: company.employeeCount,
    headcountAtLastRound: signals.headcountAtLastRound,
    headcountGrowthPct: signals.headcountGrowthPct,
    employeeCountSeries: signals.visibleSeries,
    whyNowTrigger: signals.whyNowTrigger,
    arbitrageSignals: signals.arbitrageSignals,
    dataConfidence,
    alumniSpinout: signals.alumniSpinout,
    companiesHouseNumber: company.companiesHouseNumber || null,
    financialMetrics: signals.visibleFinMetrics,
    corporateEvents: signals.visibleCorpEvents,
    domainHistory: signals.visibleDomains,
    peopleCoverage: {
      available: company.peopleCoverage.available,
      note: company.peopleCoverage.note,
      roles: company.peopleCoverage.roles.map((role) => ({
        ...role,
        source: resolveSources([role.sourceId])[0] || null
      }))
    },
    rounds: roundsWithSources,
    matchContext,
    signalTier,
    matchOrderFormula,
    triageNote: evidenceFolders.triageNote,
    evidenceFolders,
    diligencePacket,
    sources: [...allSourcesMap.values()],
    notFoundInCala,
    memoMarkdown: memoLines.join('\n')
  };
}

function matchesStageGroup(stageValue, stageFilter) {
  if (!stageFilter || stageFilter === 'all') return true;
  const s = String(stageValue || '').toLowerCase();
  if (stageFilter === 'pre_seed_seed') {
    return s.includes('pre-seed') || s.includes('seed');
  }
  if (stageFilter === 'seed_series_a') {
    return s.includes('seed') || s.includes('series a');
  }
  if (stageFilter === 'series_a_plus') {
    return s.includes('series a') || s.includes('series b') || s.includes('growth');
  }
  return s.includes(stageFilter.toLowerCase());
}

export function buildAgentPipeline(thesis, shortlist = [], options = {}) {
  const feederCount = (thesis.upstreamFeeders || []).length;
  const topFeeders = (thesis.upstreamFeeders || []).slice(0, 2).map((f) => f.name).join(', ') || 'none indexed';
  const tt = thesis.timeTravelProfile || {};
  const arbitrageHits = shortlist.filter((s) => (s.arbitrageSignals || []).length > 0).length;
  const activeFilterNote = options.filterLabel ? ` Filtered on ${options.filterLabel}.` : '';

  return [
    {
      step: 1,
      agent: 'Time-Travel DNA Profiler',
      status: 'completed',
      detail: `Reconstructed ${thesis.dealsAnalyzedCount} entry rounds (median ${tt.medianEntryHeadcount ?? '--'} employees, ~${tt.medianEntryAgeMonths ?? '--'}m post-founding).`
    },
    {
      step: 2,
      agent: 'Upstream Syndicate Mapper',
      status: 'completed',
      detail: `Mapped ${(thesis.topCoInvestors || []).length} co-investors and ${feederCount} Round N-1 upstream feeders (${topFeeders}).`
    },
    {
      step: 3,
      agent: 'Filing & Velocity Arbitrage Scout',
      status: 'completed',
      detail: `Flagged ${arbitrageHits} candidates with +30% employee_count growth, statutory PRH/Companies House filings, or alumni spinout lineage.${activeFilterNote}`
    },
    {
      step: 4,
      agent: 'Provenance Gate',
      status: 'completed',
      detail: `${tt.filingVerifiedSharePct ?? 0}% deal history backed by FILING/PRIMARY sources; 100% shortlist reasons citation-enforced.`
    }
  ];
}

const CALA_SLUSH_2026_ID = SLUSH_2026_EVENT_ID;
const EXCLUDED_FUND_NAME_RE = /\b(ventures|venture capital|capital partners|investment fund|fund [ivx]+|scsp|ky\b|holding)\b/i;

function inferCalaSector(industryRels = [], description = '', name = '', sectorHint = null) {
  const indNames = (industryRels || []).map((r) => r?.name || '').join(' ');
  const hay = `${indNames} ${description} ${name}`.toLowerCase();
  if (/(quantum|photonics|space|satellite|fusion|chip|semiconductor|hardware|defense|drone|laser|optics|robotics|material|battery cell|cryo)/.test(hay)) {
    return { sector: 'DeepTech', subSectors: ['DeepTech', 'Hardware & frontier tech'] };
  }
  if (/(climate|energy|grid|solar|carbon|recycle|recycling|plastic|hydrogen|clean|emission|decarbon|thermal)/.test(hay)) {
    return { sector: 'Climate Tech', subSectors: ['Climate Tech', 'Energy & sustainability'] };
  }
  if (/(health|medtech|clinical|biotech|diagnostic|pharma|patient|hospital|therapy|wellness|bio\b|medical)/.test(hay)) {
    return { sector: 'HealthTech', subSectors: ['HealthTech', 'Digital biology & care'] };
  }
  if (/(fintech|payment|bank|treasury|accounting|billing|cfo|invoice|credit|insurance|ledger|financial|konsernilaskenta|kirjanpito)/.test(hay)) {
    return { sector: 'Fintech', subSectors: ['Fintech', 'Financial infrastructure'] };
  }
  if (/(ai\b|ml\b|machine learning|llm|agent|neural|vision|nlp|generative|autonomous|tekoäly|ai-pohj)/.test(hay)) {
    return { sector: 'AI & ML', subSectors: ['AI & ML', 'Applied intelligence'] };
  }
  if (/(saas|software|workflow|crm|erp|compliance|security|procurement|b2b|platform|cloud|ohjelmisto)/.test(hay)) {
    return { sector: 'B2B SaaS', subSectors: ['B2B SaaS', 'Enterprise software'] };
  }
  return {
    sector: sectorHint || null,
    subSectors: sectorHint ? [sectorHint] : []
  };
}

function inferCalaGeography(outRels = {}, props = {}, name = '', description = '', defaultSlush = false) {
  const hqRel = (outRels.HAS_HEADQUARTERS_IN || []).map((x) => x?.name || '').join(' ');
  const regRel = (outRels.IS_REGISTERED_IN || []).map((x) => x?.name || '').join(' ');
  const addr = `${props.headquarters_address?.value || ''} ${props.registered_address?.value || ''}`;
  const hay = `${hqRel} ${regRel} ${addr} ${name} ${description}`.toLowerCase();
  const nameAndStruct = `${name} ${hqRel} ${regRel}`;

  if (/\b(?:finland|helsinki|espoo|oulu|tampere|turku|oy|oyj)\b/.test(hay)) {
    const city = /\bespoo\b/.test(hay) ? 'Espoo' : /\boulu\b/.test(hay) ? 'Oulu' : /\btampere\b/.test(hay) ? 'Tampere' : /\bturku\b/.test(hay) ? 'Turku' : 'Helsinki';
    return { country: 'Finland', region: 'Nordics', hqCity: city };
  }
  if (/\b(?:sweden|stockholm|gothenburg|malmö|malmo)\b/.test(hay) || /\bAB\b/.test(nameAndStruct)) {
    const city = /\bgothenburg\b/.test(hay) ? 'Gothenburg' : /\bmalm/.test(hay) ? 'Malmo' : 'Stockholm';
    return { country: 'Sweden', region: 'Nordics', hqCity: city };
  }
  if (/\b(?:denmark|copenhagen|aarhus)\b/.test(hay) || /\b(?:ApS|A\/S)\b/i.test(nameAndStruct)) {
    return { country: 'Denmark', region: 'Nordics', hqCity: /\baarhus\b/.test(hay) ? 'Aarhus' : 'Copenhagen' };
  }
  if (/\b(?:estonia|tallinn|tartu)\b/.test(hay) || /(?:^|\s)OÜ(?=$|\s|[.,])/i.test(nameAndStruct)) {
    return { country: 'Estonia', region: 'Nordics', hqCity: /\btartu\b/.test(hay) ? 'Tartu' : 'Tallinn' };
  }
  if (/\b(?:norway|oslo|bergen|trondheim)\b/.test(hay) || /\bAS\b/.test(nameAndStruct)) {
    return { country: 'Norway', region: 'Nordics', hqCity: /\bbergen\b/.test(hay) ? 'Bergen' : 'Oslo' };
  }
  if (/\b(?:germany|berlin|munich|münchen|hamburg|frankfurt|gmbh)\b/.test(hay)) {
    const city = /\b(?:munich|münchen)\b/.test(hay) ? 'Munich' : /\bhamburg\b/.test(hay) ? 'Hamburg' : 'Berlin';
    return { country: 'Germany', region: 'DACH', hqCity: city };
  }
  if (/\b(?:switzerland|zurich|zürich|basel|geneva|lausanne)\b/.test(hay) || /\bAG\b/.test(nameAndStruct)) {
    return { country: 'Switzerland', region: 'DACH', hqCity: /\bgeneva\b/.test(hay) ? 'Geneva' : 'Zurich' };
  }
  if (/\b(?:netherlands|amsterdam|rotterdam|eindhoven|delft)\b/.test(hay) || /\bb\.?v\.?(?=$|\s|,)/i.test(nameAndStruct)) {
    return { country: 'Netherlands', region: 'Western Europe', hqCity: /\beindhoven\b/.test(hay) ? 'Eindhoven' : 'Amsterdam' };
  }
  if (/\b(?:france|french|paris|toulouse|lyon|grenoble)\b/.test(hay) || /\b(?:S\.A\.S\.?|SAS|SARL)\b/.test(nameAndStruct)) {
    return { country: 'France', region: 'Western Europe', hqCity: /\btoulouse\b/.test(hay) ? 'Toulouse' : 'Paris' };
  }
  if (/\b(?:japan|japanese|tokyo|osaka|hamamatsu)\b/.test(hay) || /(?:^|\s)k\.?k\.?(?=$|\s|,)/i.test(nameAndStruct)) {
    return { country: 'Japan', region: 'Asia-Pacific', hqCity: /\bhamamatsu\b/.test(hay) ? 'Hamamatsu' : 'Tokyo' };
  }
  if (
    /\b(?:united states|usa|u\.s\.a?\.?|american|massachusetts|california|texas|florida|virginia|delaware|san francisco|new york|austin|boston|palo alto|seattle|los angeles|chicago)\b/.test(hay) ||
    /\b(?:Inc\.?|LLC|Corp(?:oration)?\.?)(?=$|\s|,)/i.test(nameAndStruct)
  ) {
    const city = /\bnew york\b/.test(hay) ? 'New York' : /\bboston\b/.test(hay) ? 'Boston' : /\boxford,?\s+massachusetts\b/.test(hay) ? 'Oxford, MA' : 'San Francisco';
    return { country: 'United States', region: 'North America', hqCity: city };
  }
  if (/\b(?:uk|united kingdom|england|scotland|edinburgh|london|cambridge|oxford|manchester|bristol|limited|ltd|plc)\b/.test(hay)) {
    const city = /\bedinburgh\b/.test(hay) ? 'Edinburgh' : /\bcambridge\b/.test(hay) ? 'Cambridge' : /\boxford\b/.test(hay) ? 'Oxford' : 'London';
    return { country: 'United Kingdom', region: 'UK', hqCity: city };
  }
  if (defaultSlush) {
    return { country: null, region: null, hqCity: 'Slush 2026' };
  }
  return { country: null, region: null, hqCity: null };
}

function formatCalaMetricLabel(rawMetric) {
  return String(rawMetric || 'Financial Metric')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferCalaOriginRank(origin, defaultRank = 'PRIMARY') {
  if (!origin) return defaultRank;
  const urlStr = String(origin?.url || origin?.document || '').trim();
  const titleStr = String(origin?.source || origin?.name || '').trim();
  const hay = `${titleStr} ${urlStr}`;
  const genericRoot = isRootHomepageUrl(urlStr);
  const explicitFilingTitle = /\b(?:form\s*(?:10-[kq]|8-k|6-k|20-f|s-1|d)|10-k|statutory filing)\b/i.test(titleStr);
  if ((!genericRoot || explicitFilingTitle) && /(?:sec\.gov|edgar|fintel\.io|companies[ _-]?house|prh\.fi|ytj|gleif|bolagsverket|handelsregister|form[ _-]*(?:10-[kq]|8-k|6-k|20-f|s-1|d)|statutory filing)/i.test(hay)) {
    return 'FILING';
  }
  if (origin?.source_rank) return String(origin.source_rank).toUpperCase();
  if (/(?:tracxn|pitchbook|dealroom|cbinsights|cb insights|gurufocus|seedtable|failory|crunchbase\.com\/organization|cala ai|clay\.com|vcsheet|basepoint|vc-mapping|sec\.gov|gleif)/i.test(hay)) {
    return 'AGGREGATOR';
  }
  if (/(?:techcrunch|bloomberg|reuters|cnbc|wsj|nytimes|ft\.com|forbes|news\.crunchbase|sifted|yahoo|fortune|businessinsider|theinformation|siliconangle|economictimes|venturebeat|axios|semafor|ground news|thefintechtimes|firstwordpharma|datacenterdynamics|investor database|observer|peoplematters|bbc\.com|theverge|cnet\.com|entrackr|yourstory|techrepublic|dqindia|tahawultech|techfundingnews|theneurondaily|inforcapital|hindubusinessline)/i.test(hay)) {
    return 'PRESS';
  }
  if (defaultRank) return defaultRank;
  if (origin?.document || origin?.url || origin?.name) {
    return 'PRIMARY';
  }
  return 'PRIMARY';
}

function registerNumericalOriginSource(origin, metricLabel, cleanName, fallbackSrcId, defaultRank = 'PRIMARY') {
  if (!origin || (!origin.url && !origin.name)) {
    return { sourceId: fallbackSrcId, sourceRank: defaultRank };
  }
  const rank = inferCalaOriginRank(origin, defaultRank);
  const rawKey = `${cleanName}-${origin.name || origin.source || ''}-${origin.url || ''}-${String(origin.published_time || '').slice(0, 10)}`;
  const hash = rawKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48);
  const obsSrcId = `src-cala-obs-${hash}`;
  if (!SOURCES[obsSrcId]) {
    SOURCES[obsSrcId] = {
      id: obsSrcId,
      title: origin.name || `${cleanName} - ${metricLabel}`,
      publisher: origin.source || origin.name || 'Cala AI Filing Source',
      url: origin.url || null,
      date: origin.published_time ? String(origin.published_time).slice(0, 10) : null,
      sourceRank: rank,
      datePrecision: origin.published_time ? 'day' : 'unknown',
      snippet: `${cleanName}: ${metricLabel} reported by ${origin.name || origin.source || 'Cala'}.`
    };
  }
  return { sourceId: obsSrcId, sourceRank: rank };
}

function parseCalaNumericalObservations(numericalObservations = [], cleanName = '', fallbackSrcId = null) {
  const headcountByDate = new Map();
  const finPoints = [];

  for (const obs of Array.isArray(numericalObservations) ? numericalObservations : []) {
    if (!obs) continue;
    const rawName = String(obs.name || obs.metric || '').trim();
    const isEmployeeMetric =
      obs.metric === 'employee_count' ||
      rawName === 'employee_count' ||
      /average_?number_?employees|number_?of_?employees|headcount|employee_?count|staff_?count/i.test(rawName);
    const label = formatCalaMetricLabel(rawName || 'Metric');
    const unit = obs.properties?.unit || obs.unit || null;

    // Case A: real Cala nested shape { type, id, name, properties: { unit }, data: [{ time, value, origin }] }
    if (Array.isArray(obs.data)) {
      for (const pt of obs.data) {
        const val = Number(pt?.value);
        const dateStr = pt?.time || pt?.date ? String(pt.time || pt.date).slice(0, 10) : null;
        if (!Number.isFinite(val) || !dateStr) continue;
        const { sourceId, sourceRank } = registerNumericalOriginSource(
          pt.origin,
          label,
          cleanName,
          fallbackSrcId,
          obs.source_rank || obs.sourceRank || null
        );
        if (isEmployeeMetric) {
          if (val <= 0) continue;
          const prev = headcountByDate.get(dateStr);
          if (!prev || (SOURCE_RANK_PRIORITY[sourceRank] || 0) >= (SOURCE_RANK_PRIORITY[prev.sourceRank] || 0)) {
            headcountByDate.set(dateStr, {
              date: dateStr,
              value: Math.max(1, Math.round(val)),
              metric: 'employee_count',
              sourceRank,
              datePrecision: 'day',
              sourceId
            });
          }
        } else {
          finPoints.push({
            metric: rawName || 'FinancialMetric',
            label,
            value: Math.round(val * 100) / 100,
            unit,
            periodEnd: dateStr,
            filingDate: pt.origin?.published_time ? String(pt.origin.published_time).slice(0, 10) : dateStr,
            year: dateStr.slice(0, 4),
            sourceRank,
            sourceId
          });
        }
      }
      continue;
    }

    // Case B: legacy/flat shape { metric: 'employee_count', date, value }
    const val = Number(obs?.value);
    const dateStr = obs?.date || obs?.time ? String(obs.date || obs.time).slice(0, 10) : null;
    if (!Number.isFinite(val) || !dateStr) continue;
    const rank = obs.source_rank || obs.sourceRank || null;
    const src = obs.sourceId || fallbackSrcId || null;
    if (isEmployeeMetric) {
      if (val <= 0) continue;
      headcountByDate.set(dateStr, {
        date: dateStr,
        value: Math.max(1, Math.round(val)),
        metric: 'employee_count',
        sourceRank: rank,
        datePrecision: obs.date_precision || obs.datePrecision || 'day',
        sourceId: src
      });
    } else if (rawName) {
      finPoints.push({
        metric: rawName,
        label,
        value: Math.round(val * 100) / 100,
        unit,
        periodEnd: dateStr,
        filingDate: dateStr,
        year: dateStr.slice(0, 4),
        sourceRank: rank,
        sourceId: src
      });
    }
  }

  const employeeCountSeries = [...headcountByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const finDedup = new Map();
  for (const fp of finPoints) {
    finDedup.set(`${fp.metric}::${fp.periodEnd}`, fp);
  }
  const financialMetrics = [...finDedup.values()]
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
    .slice(-12);

  return { employeeCountSeries, financialMetrics };
}

function parseCalaFoundedAndHeadcount(props = {}, description = '', numericalObservations = [], cleanName = '', fallbackSrcId = null) {
  let foundingDate = String(props.founding_date?.value || '').trim();
  let foundedYear = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(foundingDate)) {
    foundedYear = Number(foundingDate.slice(0, 4));
  } else if (/^\d{4}$/.test(foundingDate)) {
    foundedYear = Number(foundingDate);
    // Cala gives only a year, so retain that precision instead of inventing a day.
    foundingDate = null;
  } else {
    const ym = String(description || '').match(/\b(201[6-9]|202[0-6])\b/);
    if (ym) foundedYear = Number(ym[1]);
    foundingDate = null;
  }

  const { employeeCountSeries, financialMetrics } = parseCalaNumericalObservations(
    numericalObservations,
    cleanName,
    fallbackSrcId
  );

  let employeeCount = employeeCountSeries.length ? employeeCountSeries[employeeCountSeries.length - 1].value : null;
  const empRange = props.employee_count_range?.value;
  if (!employeeCountSeries.length) {
    if (Array.isArray(empRange) && empRange.length > 0) {
      const nums = empRange.map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (nums.length >= 2) employeeCount = Math.round((nums[0] + nums[1]) / 2);
      else if (nums.length === 1) employeeCount = nums[0];
    } else if (typeof empRange === 'number' && empRange > 0) {
      employeeCount = empRange;
    }
    if (Number.isFinite(employeeCount) && employeeCount > 0) {
      employeeCount = Math.round(employeeCount);
    } else {
      employeeCount = null;
    }
  }

  return { foundedYear, foundingDate, employeeCount, employeeCountSeries, financialMetrics };
}

function mapCalaRoundType(rawStage) {
  const s = String(rawStage || '').toUpperCase();
  if (!s) return null;
  if (s.includes('PRE_SEED') || s.includes('PRE-SEED')) return 'Pre-Seed';
  if (s.includes('SERIES_B') || s.includes('SERIES B')) return 'Series B';
  if (s.includes('SERIES_A') || s.includes('SERIES A')) return 'Series A';
  if (s.includes('SEED')) return 'Seed';
  return String(rawStage).trim() || null;
}

function extractCalaDomain(props = {}, outRels = {}, cleanName = '') {
  const domainRel = (outRels.HAS_DOMAIN_NAME || []).find((d) => d?.properties?.status === 'ACTIVE') || (outRels.HAS_DOMAIN_NAME || [])[0];
  const rawUrl = props.website?.value || domainRel?.name || '';
  if (rawUrl) {
    return String(rawUrl).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
  }
  return null;
}

function resolveRegionDefaultInvestor(region) {
  if (region === 'DACH') return 'cherry-ventures';
  if (region === 'UK') return 'seedcamp';
  return 'inventure';
}

function matchCalaInvestors(inRels = {}, context = {}) {
  const peerEntries = Object.entries(PEER_INVESTORS);
  const matchedIds = [];
  const liveInvestorsMap = {};
  const liveInvestorNames = [];

  const registerInvestorName = (invName) => {
    const cleanInv = String(invName || '').trim();
    if (!cleanInv) return;
    const low = cleanInv.toLowerCase();
    const hit = peerEntries.find(([id, name]) => low.includes(name.toLowerCase()) || id.replace(/-/g, ' ') === low);
    if (hit) {
      if (!matchedIds.includes(hit[0])) matchedIds.push(hit[0]);
      if (!liveInvestorNames.includes(hit[1])) liveInvestorNames.push(hit[1]);
      return;
    }
    const slug = `cala-inv-${slugifyBridgeId(cleanInv)}`;
    liveInvestorsMap[slug] = cleanInv;
    if (!matchedIds.includes(slug)) matchedIds.push(slug);
    if (!liveInvestorNames.includes(cleanInv)) liveInvestorNames.push(cleanInv);
  };

  const incoming = inRels.incoming || inRels;
  const outgoing = inRels.outgoing || {};
  for (const inv of [...(incoming.INVESTED_IN || []), ...(outgoing.INVESTED_IN || [])]) {
    if (inv?.entity_type === 'Person') continue;
    registerInvestorName(inv?.name);
  }
  if (context.investorId) {
    if (!matchedIds.includes(context.investorId)) matchedIds.push(context.investorId);
    if (PEER_INVESTORS[context.investorId] && !liveInvestorNames.includes(PEER_INVESTORS[context.investorId])) {
      liveInvestorNames.push(PEER_INVESTORS[context.investorId]);
    }
  }
  if (context.investorName) {
    registerInvestorName(context.investorName);
  }
  for (const extraInv of context.extraInvestorNames || []) {
    registerInvestorName(extraInv);
  }
  return { matchedIds, liveInvestorsMap, liveInvestorNames };
}

const LIVE_CALA_RELATION_TYPES = new Set([
  'PARTNERED_WITH',
  'SUPPLIES',
  'COMPETES_WITH',
  'ACQUIRED',
  'IS_SUBSIDIARY_OF',
  'INVESTED_IN',
  'FOUNDED',
  'IS_CEO_OF',
  'IS_CTO_OF',
  'IS_BOARD_MEMBER_OF',
  'WORKS_AT',
  'PARTICIPATES_IN_FUNDING_ROUND',
  'HAS_FUNDING_ROUND',
  'PARTICIPATES_IN_CORPORATE_EVENT',
  'PARTICIPATES_IN_EVENT'
]);

function collectLiveCalaRelations(entity, fallbackSourceId = null) {
  const relationships = entity?.relationships || {};
  const collected = [];
  for (const direction of ['outgoing', 'incoming']) {
    const relationMap = relationships[direction] || {};
    for (const [relation, targets] of Object.entries(relationMap)) {
      if (!LIVE_CALA_RELATION_TYPES.has(relation)) continue;
      for (const target of targets || []) {
        if (!target?.id || !target?.name) continue;
        const origin = target.properties?.sources?.[0] || null;
        collected.push({
          id: `${direction}:${relation}:${target.id}`,
          direction,
          relation,
          entityId: target.id,
          name: target.name,
          entityType: target.entity_type || target.entityType || 'Entity',
          role: target.properties?.role || null,
          date: target.properties?.event_date || target.properties?.valid_since || null,
          sourceId: origin?.id || origin?.source_id || origin?.sourceId || fallbackSourceId,
          sourceRank: inferCalaOriginRank(origin, origin?.source_rank || null)
        });
      }
    }
  }
  return collected;
}

/**
 * Normalizes live or cached Cala API entities (`Company` / `Event` attendees / `INVESTED_IN`)
 * into COMPANIES + SOURCES so `scoreAndRankCandidates` and `buildStartupBrief` can evaluate them.
 */
export function ingestLiveCalaEntities(rawEntities = [], context = {}) {
  const existingFundNames = new Set([
    ...FUNDS.map((f) => f.name.toLowerCase()),
    ...Object.values(PEER_INVESTORS).map((n) => n.toLowerCase())
  ]);
  const existingFundIds = new Set(FUNDS.map((f) => f.calaEntityId).filter(Boolean));
  const ingested = [];
  const enriched = [];

  for (const item of rawEntities || []) {
    const entityId = String(item?.id || '').trim();
    const cleanName = String(item?.name || '').trim();
    if (!entityId || !cleanName) continue;

    const eType = item.entity_type || item.entityType || 'Company';
    // Organizations are first-class map entities.  We still keep people as
    // graph nodes rather than coercing them into a company record.
    if (eType !== 'Company' && eType !== 'Organization') continue;
    if (existingFundIds.has(entityId) || existingFundNames.has(cleanName.toLowerCase())) continue;
    if (EXCLUDED_FUND_NAME_RE.test(cleanName)) continue;

    const props = item.properties || {};
    const outRels = item.relationships?.outgoing || {};
    const inRels = item.relationships?.incoming || {};

    const rawDescription = String(
      item.description ||
        props.description?.value ||
        context.descriptionFallback ||
        ''
    ).trim();
    const oneLiner = rawDescription
      ? (rawDescription.length > 110 ? `${rawDescription.slice(0, 107)}...` : rawDescription)
      : 'Not found in Cala';
    const isSlush =
      Boolean(context.slush2026) ||
      (outRels.PARTICIPATES_IN_EVENT || []).some((ev) => ev?.id === CALA_SLUSH_2026_ID || /slush/i.test(ev?.name || ''));

    const { sector, subSectors } = inferCalaSector(outRels.OPERATES_IN_INDUSTRY, rawDescription, cleanName, context.sectorHint);
    const { country, region, hqCity } = inferCalaGeography(outRels, props, cleanName, rawDescription, isSlush);

    const idSlug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'entity';
    const srcSlug = entityId.replace(/[^a-z0-9]/gi, '').slice(0, 12);
    const srcId = `src-cala-live-${srcSlug}`;

    const rawSrc =
      props.name?.sources?.[0] ||
      props.legal_name?.sources?.[0] ||
      outRels.PARTICIPATES_IN_FUNDING_ROUND?.[0]?.properties?.sources?.[0] ||
      item.properties?.sources?.[0] ||
      null;

    if (!SOURCES[srcId]) {
      SOURCES[srcId] = {
        id: srcId,
        title: `${cleanName} - Cala AI Graph Verification`,
        publisher: rawSrc?.name || 'Cala AI Knowledge Graph',
        url: rawSrc?.document || `https://cala.ai/entities/${entityId}`,
        date: rawSrc?.date || null,
        sourceRank: inferCalaOriginRank(rawSrc, rawSrc?.source_rank || null),
        datePrecision: rawSrc?.date_precision || 'unknown',
        snippet: rawDescription
      };
    }

    const { foundedYear, foundingDate, employeeCount, employeeCountSeries, financialMetrics } = parseCalaFoundedAndHeadcount(
      props,
      rawDescription,
      item.numerical_observations,
      cleanName,
      srcId
    );

    const existing = COMPANIES.find((c) => c.calaEntityId === entityId || c.name.toLowerCase() === cleanName.toLowerCase());
    const issuerRoundsRaw = (outRels.PARTICIPATES_IN_FUNDING_ROUND || []).filter(
      (r) => !r?.properties?.role || r.properties.role === 'ISSUER'
    );
    const isLegacyOrPublicCorp =
      !isSlush &&
      !existing &&
      !issuerRoundsRaw.length &&
      !props.funding_stage?.value &&
      (Boolean(outRels.TRADED_ON?.length) ||
        Boolean(outRels.LISTED_ON?.length) ||
        Boolean(outRels.IS_SUBSIDIARY_OF?.length) ||
        Boolean(outRels.ACQUIRED?.length) ||
        Boolean(inRels.ACQUIRED?.length) ||
        Boolean(props.cik?.value) ||
        (Number.isFinite(foundedYear) && foundedYear < 2015) ||
        /\b(?:aerospace corporation|collins aerospace|exail aerospace|group ltd)\b|(?:^|\s)k\.?k\.?(?=$|\s|,)|\b(?:plc|inc\.?|corp(?:oration)?\.?)(?=$|\s|,)/i.test(cleanName) ||
        /\b(?:publicly[- ]traded|nasdaq|nyse|stock exchange|subsidiary of|division of|merger of|largest suppliers|fortune 500|founded in 19\d\d|founded in 200\d|founded in 201[0-4])\b/i.test(
          rawDescription
        ));
    const entityCategory = isLegacyOrPublicCorp || (eType === 'Organization' && !issuerRoundsRaw.length) ? 'established_corp' : 'startup';

    const extraPersonInvMap = context.personInvestorNamesByCompanyId;
    const extraInvestorNames =
      extraPersonInvMap instanceof Map
        ? extraPersonInvMap.get(entityId) || []
        : Array.isArray(extraPersonInvMap?.[entityId])
          ? extraPersonInvMap[entityId]
          : [];
    const { matchedIds: mappedInvestors, liveInvestorsMap, liveInvestorNames } = matchCalaInvestors({ incoming: inRels, outgoing: outRels }, {
      investorId: context.investorId,
      investorName: context.investorName,
      extraInvestorNames
    });

    const defaultStage = props.funding_stage?.value ? mapCalaRoundType(props.funding_stage.value) : null;
    const rawTotalVal = Number(props.total_funding?.value);
    const defaultAmount = Number.isFinite(rawTotalVal) && rawTotalVal > 0
      ? Math.round((rawTotalVal > 1000 ? rawTotalVal / 1_000_000 : rawTotalVal) * 10) / 10
      : null;

    const rounds = issuerRoundsRaw.length > 0
      ? issuerRoundsRaw.slice(0, 4).map((r, idx) => {
          const valRaw = Number(r?.properties?.transaction_value);
          const amt = Number.isFinite(valRaw) && valRaw > 0
            ? Math.round((valRaw > 1000 ? valRaw / 1_000_000 : valRaw) * 10) / 10
            : defaultAmount;
          const rType = mapCalaRoundType(r.name || defaultStage) || 'Undisclosed funding round';
          const evDate = r?.properties?.event_date ? String(r.properties.event_date).slice(0, 10) : null;
          return {
            id: `rnd-live-${srcSlug}-${idx + 1}`,
            calaRoundId: r.id || `cala_rnd_${srcSlug}_${idx + 1}`,
            type: rType,
            date: evDate,
            amountEurM: amt,
            valuationEurM: null,
            leadInvestorId: mappedInvestors[0] || null,
            investorIds: mappedInvestors,
            investorNames: liveInvestorNames,
            sourceIds: [srcId]
          };
        })
      : [];

    const mapPersonRel = (list, relation, fallbackRole) =>
      (list || []).map((p) => {
        const origin = p?.properties?.sources?.[0] || null;
        return {
          relation,
          name: p?.name,
          role: p?.properties?.role || fallbackRole,
          validSince: p?.properties?.valid_since ? String(p.properties.valid_since).slice(0, 10) : null,
          validUntil: p?.properties?.valid_until ? String(p.properties.valid_until).slice(0, 10) : null,
          // A prior company is surfaced only when Cala placed it on the
          // relationship; there is intentionally no display-name fallback.
          priorCompany: p?.properties?.prior_company || null,
          priorRole: p?.properties?.prior_role || null,
          priorValidUntil: p?.properties?.prior_valid_until || null,
          sourceId: origin?.id || origin?.source_id || origin?.sourceId || null,
          sourceRank: inferCalaOriginRank(origin, origin?.source_rank || null)
        };
      });

    const contextRolesMap = context.personRolesByCompanyId;
    const contextRoles =
      contextRolesMap instanceof Map
        ? contextRolesMap.get(entityId) || []
        : Array.isArray(contextRolesMap?.[entityId])
          ? contextRolesMap[entityId]
          : [];

    const rawLeaderRels = [
      ...mapPersonRel(inRels.FOUNDED, 'FOUNDED', 'Founder'),
      ...mapPersonRel(inRels.IS_CEO_OF, 'IS_CEO_OF', 'Chief Executive Officer'),
      ...mapPersonRel(inRels.IS_CTO_OF, 'IS_CTO_OF', 'Chief Technology Officer'),
      ...mapPersonRel(inRels.IS_CFO_OF, 'IS_CFO_OF', 'Chief Financial Officer'),
      ...mapPersonRel(inRels.IS_COO_OF, 'IS_COO_OF', 'Chief Operating Officer'),
      ...mapPersonRel(inRels.IS_VICEPRESIDENT_OF, 'IS_VICEPRESIDENT_OF', 'Vice President'),
      ...mapPersonRel(inRels.IS_BOARD_MEMBER_OF, 'IS_BOARD_MEMBER_OF', 'Board Member'),
      ...mapPersonRel(inRels.IS_CONTROL_PERSON_OF, 'IS_CONTROL_PERSON_OF', 'Control Person'),
      ...mapPersonRel(inRels.IS_BENEFICIARY_OWNER_OF, 'IS_BENEFICIARY_OWNER_OF', 'Beneficial Owner'),
      ...mapPersonRel(inRels.WORKS_AT, 'WORKS_AT', 'Executive / Operator'),
      ...mapPersonRel(inRels.IS_MEMBER_OF, 'IS_MEMBER_OF', 'Member / Advisor'),
      ...mapPersonRel((inRels.INVESTED_IN || []).filter((p) => p?.entity_type === 'Person'), 'INVESTED_IN', 'Angel Investor'),
      ...contextRoles
    ].filter((r) => Boolean(r?.name));

    const dedupRoles = [];
    const seenRoleKeys = new Set();
    for (const r of rawLeaderRels) {
      const k = `${String(r.relation || '').toUpperCase()}::${normalizeLookupName(r.name)}`;
      if (seenRoleKeys.has(k)) continue;
      seenRoleKeys.add(k);
      dedupRoles.push({
        relation: r.relation,
        name: r.name,
        role: r.role,
        startDate: r.validSince || null,
        endDate: r.validUntil || null,
        validSince: r.validSince || null,
        validUntil: r.validUntil || null,
        priorCompany: r.priorCompany || null,
        priorRole: r.priorRole || null,
        priorValidUntil: r.priorValidUntil || null,
        isMatchedPersonBridge: Boolean(r.isMatchedPersonBridge),
        sourceRank: r.sourceRank || null,
        sourceId: r.sourceId || srcId
      });
    }
    const roles = dedupRoles;

    const liveEvents = [
      ...(outRels.PARTICIPATES_IN_EVENT || []).slice(0, 5).map((ev, idx) => ({
        id: `ev-cala-evt-${srcSlug}-${idx + 1}`,
        name: ev?.name || 'Ecosystem Event',
        summary: `${cleanName} participated in ${ev?.name || 'Cala-indexed event'}${ev?.properties?.role ? ` (${ev.properties.role})` : ''}.`,
        eventType: 'PARTICIPATES_IN_EVENT',
        eventDate: ev?.properties?.event_date ? String(ev.properties.event_date).slice(0, 10) : null,
        sourceRank: inferCalaOriginRank(ev?.properties?.sources?.[0], ev?.properties?.sources?.[0]?.source_rank || null),
        sourceId: srcId,
        unannouncedFiling: false
      })),
      ...(outRels.PARTICIPATES_IN_CORPORATE_EVENT || []).slice(0, 5).map((ev, idx) => ({
        id: `ev-cala-corp-${srcSlug}-${idx + 1}`,
        name: ev?.name || 'Corporate Event',
        summary: `${cleanName}: ${ev?.name || 'Corporate event'}${ev?.properties?.role ? ` (${ev.properties.role})` : ''}.`,
        eventType: 'PARTICIPATES_IN_CORPORATE_EVENT',
        eventDate: ev?.properties?.event_date ? String(ev.properties.event_date).slice(0, 10) : null,
        sourceRank: inferCalaOriginRank(ev?.properties?.sources?.[0], ev?.properties?.sources?.[0]?.source_rank || null),
        sourceId: srcId,
        unannouncedFiling: false
      }))
    ];

    const domainHost = extractCalaDomain(props, outRels, cleanName);
    const domainHistory = domainHost
      ? [{ domain: domainHost, status: 'ACTIVE', validSince: foundingDate, validUntil: null, sourceRank: null }]
      : [];
    const verifiedRelations = collectLiveCalaRelations(item, srcId);

    if (existing) {
      let touched = false;
      if (isSlush && !existing.attendingSlush2026) {
        existing.attendingSlush2026 = true;
        touched = true;
      }
      if (String(existing.calaEntityId || '').startsWith('ent_')) {
        existing.calaEntityId = entityId;
        touched = true;
      }
      if (roles.length > 0) {
        const mergedRoles = [...(existing.peopleCoverage?.roles || [])];
        for (const role of roles) {
          const idx = mergedRoles.findIndex(
            (er) => String(er.relation || '').toUpperCase() === String(role.relation || '').toUpperCase() &&
              normalizeLookupName(er.name) === normalizeLookupName(role.name)
          );
          if (idx === -1) {
            mergedRoles.push(role);
            touched = true;
          } else {
            if (role.isMatchedPersonBridge && !mergedRoles[idx].isMatchedPersonBridge) {
              mergedRoles[idx].isMatchedPersonBridge = true;
              touched = true;
            }
            if (role.priorCompany && !mergedRoles[idx].priorCompany) {
              mergedRoles[idx].priorCompany = role.priorCompany;
              mergedRoles[idx].priorRole = role.priorRole;
              mergedRoles[idx].priorValidUntil = role.priorValidUntil;
              touched = true;
            }
          }
        }
        existing.peopleCoverage = {
          available: mergedRoles.length > 0,
          note: existing.peopleCoverage?.note || 'Retrieved live from Cala AI knowledge graph.',
          roles: mergedRoles
        };
      }
      if (liveInvestorNames.length > 0) {
        existing.liveInvestorNames = [...new Set([...(existing.liveInvestorNames || []), ...liveInvestorNames])];
        existing.liveInvestorsMap = { ...(existing.liveInvestorsMap || {}), ...liveInvestorsMap };
        touched = true;
      }
      if (verifiedRelations.length > 0) {
        const existingRelations = existing.verifiedRelations || [];
        const relationKeys = new Set(existingRelations.map((rel) => rel.id));
        for (const relation of verifiedRelations) {
          if (!relationKeys.has(relation.id)) existingRelations.push(relation);
        }
        existing.verifiedRelations = existingRelations;
        touched = true;
      }
      if (employeeCountSeries.length > (existing.employeeCountSeries?.length || 0)) {
        existing.employeeCountSeries = employeeCountSeries;
        existing.employeeCount = employeeCountSeries[employeeCountSeries.length - 1].value;
        touched = true;
      }
      if (financialMetrics.length > 0 && (existing.isLiveCalaDiscovered || !(existing.financialMetrics?.length))) {
        existing.financialMetrics = financialMetrics;
        touched = true;
      }
      if (existing.isLiveCalaDiscovered && (item.description || Object.keys(props).length > 0)) {
        existing.description = rawDescription;
        existing.oneLiner = oneLiner;
        existing.sector = sector;
        existing.subSectors = subSectors;
        existing.country = country;
        existing.region = region;
        existing.hqCity = hqCity;
        existing.foundedYear = foundedYear;
        existing.foundingDate = foundingDate;
        if (!existing.employeeCountSeries?.length) existing.employeeCount = employeeCount;
        existing.domainHistory = domainHistory;
        existing.corporateEvents = liveEvents;
        if (issuerRoundsRaw.length > 0) existing.rounds = rounds;
        touched = true;
      }
      if (touched || contextRoles.length > 0 || extraInvestorNames.length > 0) {
        enriched.push(existing);
      }
      continue;
    }

    const record = {
      id: `cala-live-${idSlug}-${entityId.slice(0, 6)}`,
      calaEntityId: entityId,
      isLiveCalaDiscovered: true,
      entityCategory,
      attendingSlush2026: isSlush,
      name: cleanName,
      oneLiner,
      description: rawDescription,
      sector,
      subSectors,
      competitorGroup: `cala-live-${idSlug}`,
      country,
      region,
      hqCity,
      foundedYear,
      foundingDate,
      employeeCount,
      employeeCountSeries,
      financialMetrics,
      liveInvestorNames,
      liveInvestorsMap,
      verifiedRelations,
      corporateEvents: liveEvents,
      domainHistory,
      peopleCoverage: {
        available: roles.length > 0,
        note: roles.length > 0
          ? 'Discovered live from Cala AI knowledge graph.'
          : 'Leadership lineage not yet indexed in Cala for this entity.',
        roles
      },
      rounds
    };
    COMPANIES.push(record);
    ingested.push(record);
  }

  return { ingestedCount: ingested.length, enrichedCount: enriched.length, companies: [...ingested, ...enriched] };
}

/**
 * Ingests normalized entities from official government corporate registries (PRH/YTJ, GLEIF LEI, UK Companies House)
 * into COMPANIES + SOURCES without creating synthetic VC funding rounds or distorting backtests.
 */
export function ingestRegistryEntities(normalizedRecords = []) {
  const ingested = [];
  const enriched = [];

  for (const item of normalizedRecords || []) {
    if (!item || !item.id || !item.name || !item.source?.id) continue;

    if (!SOURCES[item.source.id]) {
      SOURCES[item.source.id] = { ...item.source };
    }

    const cleanLower = item.name.trim().toLowerCase();
    const regNo = item.registryInfo?.registrationNumber ? String(item.registryInfo.registrationNumber).trim() : null;
    const chNo = item.companiesHouseNumber ? String(item.companiesHouseNumber).trim() : null;

    const existing = COMPANIES.find(
      (c) =>
        (chNo && c.companiesHouseNumber === chNo) ||
        (regNo && c.registryInfo?.registrationNumber === regNo) ||
        c.name.trim().toLowerCase() === cleanLower
    );

    const regEvent = {
      id: `ev-reg-${item.id}`,
      name: `${item.registryInfo?.registryName || 'Official Registry'} Filing`,
      summary: `Active official entity #${regNo || 'N/A'}${item.registryInfo?.industryCode ? ` (${item.registryInfo.industryCode})` : ''}.`,
      eventType: 'OFFICIAL_REGISTRY_RECORD',
      eventDate: item.foundingDate || item.source.date,
      sourceRank: 'FILING',
      sourceId: item.source.id,
      unannouncedFiling: false
    };

    if (existing) {
      let updated = false;
      if (!existing.registryInfo && item.registryInfo) {
        existing.registryInfo = { ...item.registryInfo, sourceId: item.source.id };
        updated = true;
      }
      if (chNo && !existing.companiesHouseNumber) {
        existing.companiesHouseNumber = chNo;
        updated = true;
      }
      if (!existing.website && item.website) {
        existing.website = item.website;
        updated = true;
      }
      existing.corporateEvents = existing.corporateEvents || [];
      if (!existing.corporateEvents.some((ev) => ev.id === regEvent.id)) {
        existing.corporateEvents.push(regEvent);
        updated = true;
      }
      if (updated) enriched.push(existing);
      continue;
    }

    const domainHost = item.website
      ? String(item.website).replace(/^https?:\/\//i, '').split('/')[0]
      : null;

    const record = {
      id: item.id,
      calaEntityId: null,
      isLiveCalaDiscovered: false,
      isRegistryDiscovered: true,
      entityCategory: item.entityCategory === 'established_corp' ? 'established_corp' : 'startup',
      attendingSlush2026: false,
      name: item.name,
      oneLiner: item.oneLiner,
      description: item.description,
      sector: item.sector,
      subSectors: item.subSectors || [item.sector],
      competitorGroup: item.id,
      country: item.country,
      region: item.region,
      hqCity: item.hqCity,
      foundedYear: item.foundedYear || null,
      foundingDate: item.foundingDate || null,
      employeeCount: null,
      employeeCountSeries: [],
      companiesHouseNumber: chNo,
      website: item.website || null,
      registryInfo: {
        ...(item.registryInfo || {}),
        sourceId: item.source.id
      },
      financialMetrics: [],
      corporateEvents: [regEvent],
      domainHistory: domainHost
        ? [{ domain: domainHost, status: 'ACTIVE', validSince: item.foundingDate || item.source.date, validUntil: null, sourceRank: 'PRIMARY' }]
        : [],
      peopleCoverage: {
        available: false,
        note: 'Official corporate registry record. Founder/executive lineage and VC rounds are not yet indexed in Cala.',
        roles: []
      },
      rounds: []
    };
    COMPANIES.push(record);
    ingested.push(record);
  }

  return { ingestedCount: ingested.length, enrichedCount: enriched.length, companies: [...ingested, ...enriched] };
}

function normalizeLookupName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[.,()-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCandidateHaystack(item) {
  return [
    item.name,
    normalizeLookupName(item.name),
    item.hqCity,
    item.country,
    item.region,
    item.sector,
    item.stage,
    item.entityCategory,
    item.website,
    item.registryInfo?.registryName,
    item.registryInfo?.registrationNumber,
    item.registryInfo?.industryDescription,
    item.oneLiner,
    item.description,
    item.whyNowTrigger,
    item.alumniSpinout?.priorCompany,
    ...(item.subSectors || []),
    ...(item.liveInvestorNames || []),
    ...(item.corporateEvents || []).map((e) => e.name),
    ...(item.peopleCoverage?.roles || []).flatMap((r) => [
      r.name,
      normalizeLookupName(r.name),
      r.role,
      r.relation,
      r.priorCompany,
      r.priorRole
    ]),
    ...(item.roundHistory || []).flatMap((r) => r.investorNames || [])
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function refineShortlist(thesis, allRanked, refinement = {}) {
  const rawQuery = String(refinement.queryText || '').trim();
  const query = rawQuery.toLowerCase();
  const requestedSectors = Array.isArray(refinement.sectors) ? refinement.sectors.filter(Boolean) : [];
  const requestedCountries = Array.isArray(refinement.countries) ? refinement.countries.map((c) => c.toLowerCase()).filter(Boolean) : [];
  const expandedKeywords = Array.isArray(refinement.expandedKeywords)
    ? [...new Set(refinement.expandedKeywords.map((k) => String(k || '').toLowerCase().trim()).filter((k) => k.length >= 2))]
    : [];
  const maxEmployees = Number.isFinite(Number(refinement.maxEmployees)) && refinement.maxEmployees !== null
    ? Number(refinement.maxEmployees)
    : null;
  const minHeadcountGrowthPct =
    refinement.minHeadcountGrowthPct !== null &&
    refinement.minHeadcountGrowthPct !== undefined &&
    Number.isFinite(Number(refinement.minHeadcountGrowthPct))
      ? Math.max(0, Number(refinement.minHeadcountGrowthPct))
      : null;
  const linkedCompanySet = new Set(
    (Array.isArray(refinement.linkedCompanyNames) ? refinement.linkedCompanyNames : [])
      .map((n) => normalizeLookupName(n))
      .filter(Boolean)
  );
  const slush2026Only = Boolean(refinement.slush2026Only || refinement.slushOnly);
  const preferWarm = Boolean(refinement.preferWarm);
  const hideMegaHubs = refinement.hideMegaHubs !== undefined ? Boolean(refinement.hideMegaHubs) : true;
  const rawBridgeFamily = String(refinement.bridgeFamily || 'all').trim().toLowerCase();
  const bridgeFamily = BRIDGE_FAMILY_META[rawBridgeFamily] ? rawBridgeFamily : 'all';
  const rawContribGroup = String(refinement.contributionGroup || 'all').trim().toLowerCase();
  const contributionGroup = CONTRIBUTION_GROUP_META[rawContribGroup] ? rawContribGroup : 'all';

  let regionFilter = refinement.region || 'all';
  let stageFilter = refinement.stageFilter || 'all';
  let excludeSector = refinement.excludeSector || 'none';
  let raisingSoonOnly = Boolean(refinement.raisingSoonOnly);
  let untappedOnly = Boolean(refinement.untappedOnly);
  let highVelocityOnly = Boolean(refinement.highVelocityOnly);
  let feederOnly = Boolean(refinement.feederOnly);
  let filingOnly = Boolean(refinement.filingOnly);
  let alumniOnly = Boolean(refinement.alumniOnly || refinement.requireAlumniFounder);
  let sectorFilter = null;
  let investorFilter = null;
  let companyMatchName = null;
  let freeTextQuery = null;
  let searchIntent = refinement.intent && ['general', 'company', 'investor', 'industry', 'why_not'].includes(refinement.intent)
    ? refinement.intent
    : 'general';
  let explanation = null;
  const aiTrace = [];

  if (contributionGroup !== 'all') {
    aiTrace.push(`Filter: Decision lens "${CONTRIBUTION_GROUP_META[contributionGroup].label}" (${hideMegaHubs ? 'mega-hubs hidden' : 'including mega-hubs'})`);
  }
  if (bridgeFamily !== 'all') {
    aiTrace.push(`Filter: Bridge family "${bridgeFamily}" (${hideMegaHubs ? 'mega-hubs hidden' : 'including mega-hubs'})`);
  } else if (!hideMegaHubs) {
    aiTrace.push('Bridge Mode: Mega-hub bridges revealed (hideMegaHubs: false)');
  }

  if (minHeadcountGrowthPct !== null && minHeadcountGrowthPct > 0) {
    aiTrace.push(`Filter: Headcount growth >= +${minHeadcountGrowthPct}%`);
  }
  if (refinement.requireAlumniFounder && !alumniOnly) {
    alumniOnly = true;
  }
  if (alumniOnly) {
    aiTrace.push('Filter: Temporal FOUNDED / valid_until scaleup alumni spinout');
  }
  if (expandedKeywords.length > 0) {
    aiTrace.push(`Expanded keywords: ${expandedKeywords.join(', ')}`);
  }

  if (refinement.investorQuery) {
    const invQ = String(refinement.investorQuery).toLowerCase();
    const matchedEntry = Object.entries(PEER_INVESTORS).find(
      ([id, name]) => invQ.includes(name.toLowerCase()) || name.toLowerCase().includes(invQ) || (id !== 'angel-syndicate' && invQ.includes(id.replace('-', ' ')))
    );
    if (matchedEntry) {
      searchIntent = 'investor';
      investorFilter = matchedEntry[1];
    } else if (invQ.length >= 2) {
      searchIntent = 'investor';
      investorFilter = String(refinement.investorQuery).trim();
    }
  }
  if (refinement.companyQuery) {
    const compQNorm = normalizeLookupName(refinement.companyQuery);
    const matchedComp = COMPANIES.find((c) => {
      const cNorm = normalizeLookupName(c.name);
      return cNorm.includes(compQNorm) || compQNorm.includes(cNorm);
    });
    searchIntent = 'company';
    companyMatchName = matchedComp ? matchedComp.name : refinement.companyQuery;
    if (matchedComp && !requestedSectors.length) sectorFilter = matchedComp.sector;
  }

  const explicitWhyName = refinement.whyNotCompany ? String(refinement.whyNotCompany).trim() : null;

  if (query || explicitWhyName) {
    let matchedStructured = Boolean(
      requestedSectors.length ||
      requestedCountries.length ||
      minHeadcountGrowthPct !== null ||
      alumniOnly ||
      slush2026Only ||
      raisingSoonOnly ||
      untappedOnly ||
      bridgeFamily !== 'all' ||
      contributionGroup !== 'all' ||
      expandedKeywords.length
    );
    if (query.includes('nordic')) {
      regionFilter = 'Nordics';
      matchedStructured = true;
    } else if (query.includes('dach') || query.includes('german')) {
      regionFilter = 'DACH';
      matchedStructured = true;
    } else if (query.includes('uk') || query.includes('london') || query.includes('britain')) {
      regionFilter = 'UK';
      matchedStructured = true;
    }

    if (query.includes('exclude fintech') || query.includes('no fintech')) {
      excludeSector = 'Fintech';
      matchedStructured = true;
    } else if (query.includes('exclude health') || query.includes('no health')) {
      excludeSector = 'HealthTech';
      matchedStructured = true;
    } else if (query.includes('exclude climate') || query.includes('no climate')) {
      excludeSector = 'Climate Tech';
      matchedStructured = true;
    } else if (query.includes('exclude saas') || query.includes('no saas')) {
      excludeSector = 'B2B SaaS';
      matchedStructured = true;
    }

    if (query.includes('raising')) {
      raisingSoonOnly = true;
      matchedStructured = true;
    }
    if (query.includes('untapped') || query.includes('angel')) {
      untappedOnly = true;
      matchedStructured = true;
    }
    if (/(fast headcount|headcount growth|headcount velocity|high growth|team velocity|hiring velocity)/i.test(query)) {
      highVelocityOnly = true;
      matchedStructured = true;
      aiTrace.push('Filter: Post-round headcount growth >= 30% (employee_count time-series)');
    }
    if (/(feeder syndicate|upstream feeder|prior[- ]round feeder|feeder)/i.test(query)) {
      feederOnly = true;
      matchedStructured = true;
      aiTrace.push('Filter: Backed by Round N-1 upstream feeder syndicate');
    }
    if (/(filing signal|filing arbitrage|companies house|share allotment|unannounced filing|facility)/i.test(query)) {
      filingOnly = true;
      matchedStructured = true;
      aiTrace.push('Filter: Statutory FILING provenance (PRH / UK Companies House / HRB)');
    }
    if (/(alumni founder|spinout|operator lineage|ex-iceye|ex-aiven|ex-iqm|ex-oura|ex-silo)/i.test(query)) {
      alumniOnly = true;
      matchedStructured = true;
      if (!aiTrace.some((t) => t.includes('alumni spinout'))) {
        aiTrace.push('Filter: Temporal FOUNDED / valid_until scaleup alumni spinout');
      }
    }

    const whyMatch = query.match(/why not\s+([a-z0-9\s.-]+)/i);
    if (whyMatch || explicitWhyName) {
      searchIntent = 'why_not';
      const targetName = (explicitWhyName || whyMatch[1]).replace(/\?+$/, '').trim();
      const company = COMPANIES.find((c) => c.name.toLowerCase().includes(targetName.toLowerCase()));
      if (!company) {
        explanation = `Company "${targetName}" was not found in the indexed European Cala universe.`;
      } else if (thesis.portfolioCompanyIds.includes(company.id)) {
        explanation = `${company.name} is excluded from the shortlist because it is already in ${thesis.fundName} existing portfolio (Q24 exclusion rule).`;
      } else {
        const idx = allRanked.findIndex((item) => item.id === company.id);
        if (idx === -1) {
          explanation = `${company.name} had no indexed funding rounds matching the evaluation window.`;
        } else {
          const item = allRanked[idx];
          const synEarned = item.scoreBreakdown.syndicate?.earned ?? item.scoreBreakdown.coInvestor?.earned ?? 0;
          const synMax = item.scoreBreakdown.syndicate?.max ?? item.scoreBreakdown.coInvestor?.max ?? 20;
          explanation = `${company.name} ranks #${idx + 1} overall with ${item.suitabilityScore}/100 (Sector ${item.scoreBreakdown.sector.earned}/${item.scoreBreakdown.sector.max}, Stage ${item.scoreBreakdown.stage.earned}/${item.scoreBreakdown.stage.max}, Syndicate ${synEarned}/${synMax}, Geo ${item.scoreBreakdown.geography.earned}/${item.scoreBreakdown.geography.max}).`;
        }
      }
      aiTrace.push(`Intent: Portfolio exclusion audit for "${targetName}"`);
      aiTrace.push(`Checked ${thesis.fundName} Cala portfolio (${thesis.portfolioCount} companies)`);
    } else {
      // Check Investor archetype
      const matchedInvestorEntry = Object.entries(PEER_INVESTORS).find(
        ([id, name]) => query.includes(name.toLowerCase()) || (id !== 'angel-syndicate' && query.includes(id.replace('-', ' ')))
      );
      if (query.startsWith('investor:') || query.includes('co-invest') || matchedInvestorEntry) {
        searchIntent = 'investor';
        if (matchedInvestorEntry) {
          investorFilter = matchedInvestorEntry[1];
          aiTrace.push(`Intent: Investor & co-investor network filter (${investorFilter})`);
        } else {
          aiTrace.push(`Intent: Investor search "${rawQuery}"`);
        }
        aiTrace.push(`Matched rounds backed by ${investorFilter || 'peer co-investors'} in Cala`);
      }

      // Check Industry / Theme archetype (skip single-slot overwrite when caller passed multi-sectors)
      if (!investorFilter && requestedSectors.length === 0) {
        if (query.includes('deeptech') || query.includes('quantum') || query.includes('space') || query.includes('robotics')) {
          searchIntent = 'industry';
          sectorFilter = 'DeepTech';
        } else if (query.includes('ai') || query.includes('ml') || query.includes('agent')) {
          searchIntent = 'industry';
          sectorFilter = 'AI & ML';
        } else if (query.includes('fintech') && !query.includes('exclude fintech') && !query.includes('no fintech')) {
          searchIntent = 'industry';
          sectorFilter = 'Fintech';
        } else if (query.includes('health') && !query.includes('exclude health') && !query.includes('no health')) {
          searchIntent = 'industry';
          sectorFilter = 'HealthTech';
        } else if (query.includes('climate') && !query.includes('exclude climate') && !query.includes('no climate')) {
          searchIntent = 'industry';
          sectorFilter = 'Climate Tech';
        } else if (query.includes('saas') && !query.includes('exclude saas') && !query.includes('no saas')) {
          searchIntent = 'industry';
          sectorFilter = 'B2B SaaS';
        }
        if (sectorFilter) {
          aiTrace.push(`Intent: Industry & thesis filter (${sectorFilter})`);
        }
      } else if (requestedSectors.length > 0) {
        searchIntent = 'industry';
        aiTrace.push(`Intent: Multi-sector filter (${requestedSectors.join(', ')})`);
      }

      // Check Company archetype (explicit "Company:" or matching company name, ignoring "ex-<Company>" alumni mentions)
      const cleanedCompanyQuery = query.replace(/^company:\s*/i, '').replace(/^similar to\s+/i, '').trim();
      const cleanedCompanyNorm = normalizeLookupName(cleanedCompanyQuery);
      const matchedComp = COMPANIES.find((c) => {
        if (cleanedCompanyNorm.length < 2) return false;
        const escaped = c.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(?:ex-|former\\s+)${escaped}`, 'i').test(query)) return false;
        const cNorm = normalizeLookupName(c.name);
        return cNorm.includes(cleanedCompanyNorm) || (cNorm.length >= 3 && cleanedCompanyNorm.includes(cNorm));
      });
      if (query.startsWith('company:') || query.startsWith('similar to') || (matchedComp && !alumniOnly)) {
        searchIntent = 'company';
        companyMatchName = matchedComp ? matchedComp.name : cleanedCompanyQuery;
        if (matchedComp) {
          sectorFilter = matchedComp.sector;
          aiTrace.push(`Intent: Company & entity lookup (${matchedComp.name}${matchedComp.entityCategory === 'established_corp' ? ', corporate registry' : ` in ${matchedComp.sector}`})`);
        } else {
          aiTrace.push(`Intent: Company keyword search ("${cleanedCompanyQuery}")`);
        }
      }

      if (!matchedStructured && !investorFilter && !sectorFilter && !companyMatchName && requestedSectors.length === 0 && requestedCountries.length === 0 && maxEmployees === null && !slush2026Only) {
        freeTextQuery = query;
        aiTrace.push(`Intent: Keyword match across Cala profiles ("${rawQuery}")`);
      } else if (!aiTrace.length) {
        aiTrace.push(`Intent: Thesis filter across ${thesis.fundName} candidate pool`);
      }
      aiTrace.push(`Ranked by Suitability Score using verified Cala citations`);
    }
  }

  const effectiveEntityScope = refinement.entityScope === 'all' ? 'all' : 'startups';
  const targetCompanyNorm = companyMatchName ? normalizeLookupName(companyMatchName) : '';
  const extraCompanyNorm = refinement.companyQuery ? normalizeLookupName(refinement.companyQuery) : '';
  const personOrEntityMatchesQuery = (it, normTerm) => {
    const t = normTerm || targetCompanyNorm;
    if (!t) return false;
    const itemNorm = normalizeLookupName(it.name);
    if (itemNorm.includes(t) || (extraCompanyNorm && itemNorm.includes(extraCompanyNorm))) return true;
    if (linkedCompanySet.has(itemNorm)) return true;
    if ((it.peopleCoverage?.roles || []).some((r) => normalizeLookupName(r.name).includes(t))) return true;
    if ((it.liveInvestorNames || []).some((n) => normalizeLookupName(n).includes(t))) return true;
    if ((it.roundHistory || []).some((r) => (r.investorNames || []).some((n) => normalizeLookupName(n).includes(t)))) return true;
    return false;
  };
  const hasEstablishedCompanyMatch = Boolean(
    targetCompanyNorm &&
      allRanked.some(
        (it) =>
          personOrEntityMatchesQuery(it, targetCompanyNorm) &&
          (it.entityCategory === 'established_corp' || it.isRegistryDiscovered)
      )
  );

  const bridgeResultCache = new Map();
  const getReconciledBridges = (item) => {
    if (bridgeResultCache.has(item.id)) return bridgeResultCache.get(item.id);
    const rawCompany = COMPANIES.find((c) => c.id === item.id) || {
      ...item,
      rounds: item.rounds || item.roundHistory || []
    };
    const visibleRounds = [...(rawCompany.rounds || [])];
    const signals = extractCandidateSignals(
      rawCompany,
      visibleRounds,
      thesis?.evalDate || REFERENCE_DATE,
      null,
      item.coInvestorPath || null
    );
    const res = extractHiddenBridges(thesis, rawCompany, visibleRounds, signals, {
      hideMegaHubs,
      bridgeFamily: bridgeFamily === 'all' ? null : bridgeFamily,
      filingOnly,
      maxPaths: 5
    });
    bridgeResultCache.set(item.id, res);
    return res;
  };

  const companyMatchesContributionGroup = (item, grp) => {
    if (!grp || grp === 'all') return true;
    const br = getReconciledBridges(item);
    if (grp === 'access' || grp === 'lineage') {
      return (br.bridges || []).some((b) => deriveContributionGroup(b) === grp);
    }
    if (grp === 'timing') {
      return (
        (br.bridges || []).some((b) => deriveContributionGroup(b) === 'timing') ||
        (item.diligencePacket?.urgencyTriggers || []).length > 0 ||
        Boolean(item.attendingSlush2026)
      );
    }
    if (grp === 'caution') {
      const cLevel = item.diligencePacket?.conflictRisk?.level;
      return (
        (br.bridges || []).some((b) => deriveContributionGroup(b) === 'caution') ||
        (cLevel && cLevel !== 'None') ||
        (item.diligencePacket?.riskFlags || []).some(
          (rf) => rf.id === 'press_only_provenance' || rf.id === 'mega_hub_only_bridge'
        )
      );
    }
    return true;
  };

  let filtered = allRanked.filter((item) => {
    const isExplicitEntityMatch = targetCompanyNorm && personOrEntityMatchesQuery(item, targetCompanyNorm);
    if (
      effectiveEntityScope !== 'all' &&
      item.entityCategory === 'established_corp' &&
      !hasEstablishedCompanyMatch &&
      !isExplicitEntityMatch &&
      !item.isLiveCalaDiscovered
    ) return false;
    if (regionFilter !== 'all' && item.region !== regionFilter) return false;
    if (!matchesStageGroup(item.stage, stageFilter)) return false;
    if (excludeSector !== 'none' && item.sector === excludeSector) return false;
    if (raisingSoonOnly && !item.raisingSoon) return false;
    if (untappedOnly && !item.untappedSignal) return false;
    if (highVelocityOnly && (item.headcountGrowthPct || 0) < 30) return false;
    if (minHeadcountGrowthPct !== null && (item.headcountGrowthPct || 0) < minHeadcountGrowthPct) return false;
    if (feederOnly && !item.coInvestorPath?.isUpstreamFeeder) return false;
    if (filingOnly && !(item.arbitrageSignals || []).some((s) => s.sourceRank === 'FILING')) return false;
    if (alumniOnly && !item.alumniSpinout) return false;
    if (maxEmployees !== null && Number(item.employeeCount || 0) > maxEmployees) return false;
    if (slush2026Only && !item.attendingSlush2026) return false;
    if (bridgeFamily !== 'all' && getReconciledBridges(item).bridges.length === 0) return false;
    if (contributionGroup !== 'all' && !companyMatchesContributionGroup(item, contributionGroup)) return false;
    if (requestedSectors.length > 0 && !requestedSectors.includes(item.sector)) return false;
    if (requestedCountries.length > 0) {
      const locHay = `${item.country || ''} ${item.hqCity || ''}`.toLowerCase();
      if (!requestedCountries.some((c) => locHay.includes(c))) return false;
    }
    if (expandedKeywords.length > 0 && searchIntent !== 'company') {
      const hay = buildCandidateHaystack(item);
      if (!expandedKeywords.some((kw) => hay.includes(kw))) return false;
    }
    if (investorFilter) {
      const invNorm = normalizeLookupName(investorFilter);
      const hasInv =
        normalizeLookupName(item.coInvestorPath?.coInvestorName).includes(invNorm) ||
        (item.liveInvestorNames || []).some((n) => normalizeLookupName(n).includes(invNorm)) ||
        (item.roundHistory || []).some((r) => (r.investorNames || []).some((n) => normalizeLookupName(n).includes(invNorm))) ||
        linkedCompanySet.has(normalizeLookupName(item.name));
      if (!hasInv) return false;
    }
    if (searchIntent === 'company' && companyMatchName) {
      const exactMatch = personOrEntityMatchesQuery(item, targetCompanyNorm);
      const sameSectorMatch =
        !hasEstablishedCompanyMatch && effectiveEntityScope !== 'all' && sectorFilter && item.sector === sectorFilter;
      if (!exactMatch && !sameSectorMatch) return false;
    } else if (sectorFilter && requestedSectors.length === 0) {
      const textMatch =
        item.sector === sectorFilter ||
        item.subSectors.some((s) => query.includes(s.toLowerCase())) ||
        item.description.toLowerCase().includes(sectorFilter.toLowerCase().split(' ')[0]);
      if (!textMatch) return false;
    } else if (freeTextQuery) {
      const hay = buildCandidateHaystack(item);
      const freeNorm = normalizeLookupName(freeTextQuery);
      if (!hay.includes(freeTextQuery) && (!freeNorm || !hay.includes(freeNorm))) return false;
    }
    return true;
  });

  // Soft-match recovery so combined constraints or novel terms never overlook startups
  const hasStrictUiFilter = Boolean(
    bridgeFamily !== 'all' ||
    contributionGroup !== 'all' ||
    filingOnly ||
    slush2026Only ||
    feederOnly ||
    alumniOnly ||
    raisingSoonOnly ||
    untappedOnly ||
    highVelocityOnly ||
    maxEmployees !== null ||
    (minHeadcountGrowthPct !== null && minHeadcountGrowthPct > 0) ||
    (regionFilter && regionFilter !== 'all') ||
    (stageFilter && stageFilter !== 'all') ||
    (excludeSector && excludeSector !== 'none') ||
    requestedSectors.length > 0 ||
    requestedCountries.length > 0 ||
    sectorFilter ||
    investorFilter
  );

  const relaxSuggestions = [];
  if (filtered.length === 0) {
    if (contributionGroup !== 'all') {
      relaxSuggestions.push({ filter: 'contributionGroup', value: 'all', label: 'Switch to All Lenses' });
    }
    if (bridgeFamily !== 'all') {
      relaxSuggestions.push({ filter: 'bridgeFamily', value: 'all', label: 'Switch to All Bridges' });
    }
    if (hideMegaHubs !== false) {
      relaxSuggestions.push({ filter: 'hideMegaHubs', value: false, label: 'Reveal suppressed bridges' });
    }
    if (slush2026Only) {
      relaxSuggestions.push({ filter: 'slush2026Only', value: false, label: 'Clear Slush 2026 filter' });
    }
    if (filingOnly) {
      relaxSuggestions.push({ filter: 'filingOnly', value: false, label: 'Include PRIMARY & PRESS sources' });
    }
    if (untappedOnly) {
      relaxSuggestions.push({ filter: 'untappedOnly', value: false, label: 'Include VC-backed startups' });
    }
    if (feederOnly) {
      relaxSuggestions.push({ filter: 'feederOnly', value: false, label: 'Clear Feeder-only filter' });
    }
    if (alumniOnly) {
      relaxSuggestions.push({ filter: 'alumniOnly', value: false, label: 'Clear Alumni Spinout filter' });
    }
    if (raisingSoonOnly) {
      relaxSuggestions.push({ filter: 'raisingSoonOnly', value: false, label: 'Clear Raising window filter' });
    }
    if (highVelocityOnly) {
      relaxSuggestions.push({ filter: 'highVelocityOnly', value: false, label: 'Clear high-velocity filter' });
    }
    if (regionFilter && regionFilter !== 'all') {
      relaxSuggestions.push({ filter: 'region', value: 'all', label: 'Expand to All Europe' });
    }
    if (stageFilter && stageFilter !== 'all') {
      relaxSuggestions.push({ filter: 'stageFilter', value: 'all', label: 'Include all stages' });
    }
    if (maxEmployees !== null) {
      relaxSuggestions.push({ filter: 'maxEmployees', value: null, label: 'Remove team size cap' });
    }
    if (minHeadcountGrowthPct !== null && minHeadcountGrowthPct > 0) {
      relaxSuggestions.push({ filter: 'minHeadcountGrowthPct', value: null, label: 'Remove hiring growth minimum' });
    }
    if (excludeSector && excludeSector !== 'none') {
      relaxSuggestions.push({ filter: 'excludeSector', value: 'none', label: `Include ${excludeSector}` });
    }
    if (rawQuery) {
      relaxSuggestions.push({ filter: 'reset', value: true, label: 'Reset search & filters' });
    }
  }

  const exactMatchesBeforeFallback = filtered.length;
  let usedSoftFallback = false;
  if (filtered.length === 0 && !hasStrictUiFilter && (rawQuery || expandedKeywords.length > 0) && searchIntent !== 'why_not') {
    usedSoftFallback = true;
    const queryTokens = [
      ...expandedKeywords,
      ...query
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !['the', 'and', 'for', 'with', 'find', 'show', 'under', 'startups', 'startup', 'raising', 'soon'].includes(t))
    ];

    const scoredFallback = allRanked
      .filter((item) => excludeSector === 'none' || item.sector !== excludeSector)
      .map((item) => {
        const hay = buildCandidateHaystack(item);
        let hits = 0;
        for (const tok of queryTokens) {
          if (hay.includes(tok)) hits += 1;
        }
        if (requestedSectors.includes(item.sector)) hits += 2;
        if (regionFilter !== 'all' && item.region === regionFilter) hits += 1;
        if (requestedCountries.some((c) => `${item.country} ${item.hqCity}`.toLowerCase().includes(c))) hits += 2;
        if (slush2026Only && item.attendingSlush2026) hits += 1;
        if (alumniOnly && item.alumniSpinout) hits += 2;
        return { item, softScore: hits * 15 + (item.suitabilityScore || 0) * 0.25 };
      })
      .sort((a, b) => b.softScore - a.softScore);

    filtered = scoredFallback.slice(0, 15).map((entry) => entry.item);
    explanation = `0 exact matches for all combined constraints in "${rawQuery}"; showing top ${filtered.length} closest thesis-assessed startups.`;
    aiTrace.push(`Soft-match recovery: ranked ${filtered.length} closest candidates from ${allRanked.length} evaluated startups`);
  }

  if (searchIntent === 'company' && companyMatchName) {
    filtered.sort((a, b) => {
      const rankItem = (it) => {
        const norm = normalizeLookupName(it.name);
        if (norm.includes(targetCompanyNorm) || (extraCompanyNorm && norm.includes(extraCompanyNorm))) return 2;
        if (personOrEntityMatchesQuery(it, targetCompanyNorm)) return 1;
        return 0;
      };
      return rankItem(b) - rankItem(a) || (b.suitabilityScore || 0) - (a.suitabilityScore || 0);
    });
  } else if (expandedKeywords.length > 0) {
    filtered.sort((a, b) => {
      const hayA = buildCandidateHaystack(a);
      const hayB = buildCandidateHaystack(b);
      const hitsA = expandedKeywords.filter((k) => hayA.includes(k)).length;
      const hitsB = expandedKeywords.filter((k) => hayB.includes(k)).length;
      return hitsB - hitsA || (b.suitabilityScore || 0) - (a.suitabilityScore || 0);
    });
  } else if (preferWarm) {
    filtered.sort((a, b) => {
      const aw = (a.evidenceFolders?.hiddenBridges?.paths || []).length > 0 ? 1 : 0;
      const bw = (b.evidenceFolders?.hiddenBridges?.paths || []).length > 0 ? 1 : 0;
      return bw - aw || (b.suitabilityScore || 0) - (a.suitabilityScore || 0);
    });
  } else if (highVelocityOnly || minHeadcountGrowthPct !== null) {
    filtered.sort((a, b) => (b.headcountGrowthPct || 0) - (a.headcountGrowthPct || 0) || b.suitabilityScore - a.suitabilityScore);
  }

  if (!explanation && query) {
    explanation = `Matched ${filtered.length} startups from ${thesis.fundName} pool (${allRanked.length} assessed) using verified Cala records.`;
  }

  const agentPipeline = buildAgentPipeline(thesis, filtered, {
    filterLabel: rawQuery || null
  });
  for (const stage of agentPipeline) {
    aiTrace.push(`${stage.step}. ${stage.agent}: ${stage.detail}`);
  }

  const shortlistSlice = filtered.slice(0, refinement.limit ?? 200).map((item) => {
    const br = getReconciledBridges(item);
    const warmPaths = buildWarmIntroForwardability(br.bridges || [], thesis);
    const baseFolders = item.evidenceFolders || {};
    const updatedFolders = {
      ...baseFolders,
      hiddenBridges: {
        label: baseFolders.hiddenBridges?.label || 'Hidden Bridges & Warm Paths',
        totalFound: br.bridges.length + br.suppressedMegaHubCount,
        suppressedMegaHubCount: br.suppressedMegaHubCount,
        hiddenMegaHubCount: br.suppressedMegaHubCount,
        familiesPresent: br.familiesPresent,
        paths: br.bridges
      }
    };
    const rawComp = COMPANIES.find((c) => c.id === item.id) || item;
    const updatedDiligence = item.diligencePacket
      ? {
          ...item.diligencePacket,
          warmIntroPaths: warmPaths,
          riskFlags: buildKillScreenRiskFlags(
            rawComp,
            rawComp.rounds || [],
            {
              visibleSeries: item.employeeCountSeries || rawComp.employeeCountSeries || [],
              headcountGrowthPct: item.headcountGrowthPct ?? 0,
              arbitrageSignals: item.arbitrageSignals || []
            },
            br,
            updatedFolders,
            item.dataConfidence,
            thesis?.evalDate || REFERENCE_DATE
          )
        }
      : buildAnalystDiligencePacket(rawComp, thesis, null, br, updatedFolders);

    return {
      ...item,
      signalTier: computeSignalTier({
        bridges: br.bridges,
        dataConfidence: item.dataConfidence,
        urgencyTriggers: updatedDiligence.urgencyTriggers,
        suitabilityScore: item.suitabilityScore
      }),
      evidenceFolders: updatedFolders,
      diligencePacket: updatedDiligence
    };
  });

  const bridgeMap = buildBridgeMapPayload(thesis, shortlistSlice, {
    hideMegaHubs,
    bridgeFamily,
    contributionGroup,
    filingOnly
  });

  return {
    searchIntent,
    aiTrace,
    agentPipeline,
    appliedFilters: {
      entityScope: effectiveEntityScope,
      region: regionFilter,
      stageFilter,
      excludeSector,
      raisingSoonOnly,
      untappedOnly,
      highVelocityOnly,
      minHeadcountGrowthPct,
      feederOnly,
      filingOnly,
      alumniOnly,
      requireAlumniFounder: alumniOnly,
      hideMegaHubs,
      bridgeFamily,
      contributionGroup,
      sectors: requestedSectors,
      countries: requestedCountries,
      maxEmployees,
      slush2026Only,
      slushOnly: slush2026Only,
      expandedKeywords,
      sectorFilter,
      investorFilter,
      queryText: rawQuery
    },
    explanation,
    usedSoftFallback,
    exactMatchesBeforeFallback,
    relaxSuggestions,
    totalMatches: filtered.length,
    shortlist: shortlistSlice,
    bridgeMap
  };
}

export function runFullAnalysis(input, options = {}) {
  if (input?.mode === 'entity') {
    const requestedEntities = Array.isArray(input.entities) && input.entities.length
      ? input.entities
      : [input.entity || input.anchorEntity, ...(input.relatedEntities || options.relatedEntities || [])].filter(Boolean);
    const relatedEntities = input.relatedEntities || options.relatedEntities || [];
    const bridgeMap = buildEntityBridgeMap(requestedEntities, relatedEntities, { ...options, multiCenter: true });
    const anchor = bridgeMap.anchor;
    const entityNodes = bridgeMap.nodes.filter((node) => node.id !== anchor.id);
    const entitySourceRanks = bridgeMap.edges
      .map((edge) => edge.topSourceRank)
      .filter(Boolean)
      .sort((a, b) => (SOURCE_RANK_PRIORITY[b] || 0) - (SOURCE_RANK_PRIORITY[a] || 0));
    const thesis = {
      mode: 'entity',
      fundId: anchor.id,
      fundName: anchor.label,
      calaEntityId: anchor.id,
      entityType: anchor.entityType,
      portfolioCompanies: [],
      portfolioCompanyIds: [],
      portfolioCompetitorGroups: {},
      topCoInvestors: [],
      upstreamFeeders: [],
      investorTotalDealsMap: {},
      evalDate: REFERENCE_DATE,
      dealsAnalyzedCount: bridgeMap.edges.length,
      portfolioCount: entityNodes.length,
      weakProfile: bridgeMap.edges.length === 0,
      weakProfileNote: bridgeMap.edges.length === 0 ? 'No verified Cala relationships are indexed for this entity.' : null
    };
    const shortlist = entityNodes.map((node) => ({
      id: node.id,
      calaEntityId: node.id,
      name: node.label,
      entityType: node.entityType,
      entityCategory: node.entityCategory,
      topSourceRank: node.topSourceRank,
      contributionGroup: node.contributionGroup,
      description: node.description,
      verified: true
    }));
    const entitySourcesMap = {};
    for (const edge of bridgeMap.edges) {
      for (const sId of edge.sourceIds || []) {
        if (SOURCES[sId] && !entitySourcesMap[sId]) entitySourcesMap[sId] = SOURCES[sId];
      }
    }
    return {
      mode: 'entity',
      thesis,
      timeTravelProfile: null,
      upstreamFeeders: [],
      dataConfidence: { grade: 'Entity graph', topSourceRank: entitySourceRanks[0] || null },
      rankingMode: 'entity',
      weights: {},
      totalCandidatesEvaluated: shortlist.length,
      shortlist,
      allRanked: shortlist,
      backtest: null,
      agentPipeline: [],
      bridgeMap,
      sources: entitySourcesMap,
      calaTelemetry: {
        entitiesIndexed: bridgeMap.nodes.length,
        roundsInspected: bridgeMap.edges.filter((edge) => /FUNDING_ROUND/.test(edge.relation || '')).length,
        verifiedCitationsInShortlist: new Set(bridgeMap.edges.flatMap((edge) => edge.sourceIds || [])).size,
        registriesIntegrated: [],
        pipelineMode: 'Live Cala entity graph'
      }
    };
  }

  const hideMegaHubs = options.hideMegaHubs !== undefined ? Boolean(options.hideMegaHubs) : true;
  const rawBridgeFamily = String(options.bridgeFamily || 'all').trim().toLowerCase();
  const bridgeFamily = BRIDGE_FAMILY_META[rawBridgeFamily] ? rawBridgeFamily : 'all';
  const rawContribGroup = String(options.contributionGroup || 'all').trim().toLowerCase();
  const contributionGroup = CONTRIBUTION_GROUP_META[rawContribGroup] ? rawContribGroup : 'all';

  const thesis = computeRevealedThesis(input, options);
  const ranking = scoreAndRankCandidates(thesis, {
    rankingMode: options.rankingMode || 'balanced',
    seenCompanyNames: options.seenCompanyNames || [],
    entityScope: options.entityScope || input?.entityScope || 'startups',
    includeCompanyNames: options.includeCompanyNames || input?.includeCompanyNames || [],
    hideMegaHubs,
    bridgeFamily,
    contributionGroup,
    limit: options.limit ?? 200
  });
  const backtest = thesis.mode === 'fund' ? runPointInTimeBacktest(thesis.fundId) : null;
  const agentPipeline = buildAgentPipeline(thesis, ranking.shortlist);
  const bridgeMap = buildBridgeMapPayload(thesis, ranking.shortlist, {
    hideMegaHubs,
    bridgeFamily,
    contributionGroup
  });

  const uniqueSourceIds = new Set();
  const confidenceCounts = { high: 0, medium: 0, sparse: 0 };
  for (const item of ranking.shortlist) {
    for (const r of item.reasons) {
      for (const sId of r.sourceIds) uniqueSourceIds.add(sId);
    }
    const g = item.dataConfidence?.grade;
    if (g === 'High') confidenceCounts.high += 1;
    else if (g === 'Medium') confidenceCounts.medium += 1;
    else confidenceCounts.sparse += 1;
  }

  const dataConfidence = {
    filingVerifiedSharePct: thesis.timeTravelProfile?.filingVerifiedSharePct ?? 0,
    shortlistBreakdown: confidenceCounts,
    grade:
      (thesis.timeTravelProfile?.filingVerifiedSharePct ?? 0) >= 60 && !thesis.weakProfile
        ? 'High'
        : thesis.dealsAnalyzedCount >= 4
          ? 'Medium'
          : 'Early / Sparse'
  };

  return {
    thesis,
    timeTravelProfile: thesis.timeTravelProfile,
    upstreamFeeders: thesis.upstreamFeeders,
    dataConfidence,
    rankingMode: ranking.rankingMode,
    weights: ranking.weights,
    totalCandidatesEvaluated: ranking.totalCandidatesEvaluated,
    shortlist: ranking.shortlist,
    allRanked: ranking.allRanked,
    backtest,
    agentPipeline,
    bridgeMap,
    calaTelemetry: {
      entitiesIndexed: FUNDS.length + COMPANIES.length,
      roundsInspected: COMPANIES.reduce((sum, c) => sum + c.rounds.length, 0),
      verifiedCitationsInShortlist: uniqueSourceIds.size,
      registriesIntegrated: ['PRH/YTJ v3', 'GLEIF LEI', ...(process.env.COMPANIES_HOUSE_API_KEY ? ['UK Companies House'] : [])],
      pipelineMode: process.env.CALA_API_KEY ? 'Live Cala API + Official Registries' : 'Pre-indexed Cala Snapshot + Official Registries'
    }
  };
}
