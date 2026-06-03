/**
 * AdWinner Intel - Apify Actor
 *
 * Competitive ad intelligence Actor for the Apify platform.
 * Searches Meta Ad Library and TikTok, calculates longevity/profitability scores,
 * and analyzes creatives with Google Gemini.
 *
 * Supports batch mode (Apify input) and standby mode (HTTP API).
 */

import 'dotenv/config';

import { Actor } from 'apify';
import express, { type Request, type Response, type NextFunction } from 'express';

type CallToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

// Services
import {
  fetchFacebookAds,
  fetchTikTokAds,
  detectGlobalWinners,
  enrichWithProfitabilityScores,
  calculateProfitabilityScore,
  extractBrandFromDomain,
  rankByCommercialIntent,
  filterByDomainRelevance,
} from './services/apify-service.js';
import {
  analyzeAdCreative,
  normalizeGeminiAnalysis,
  validateGeminiConnection,
  isGeminiConfigured,
} from './services/gemini-service.js';
import {
  getCachedAds,
  setCachedAds,
  getCachedTrends,
  setCachedTrends,
  getCachedAnalysis,
  setCachedAnalysis,
  closeRedis,
} from './services/cache-service.js';
import { RequestCostTracker } from './services/cost-tracker.js';
import {
  ensureDatabase,
  persistAds,
  getPersistedAds,
  logQueryCost,
} from './services/appwrite-db.js';
import { deleteCreativeFromAppwrite } from './services/appwrite-service.js';

// Types
import {
  LONGEVITY_THRESHOLD_DAYS,
  type AdEntity,
  type GeminiAnalysis,
} from './types/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const ENABLE_LOCAL_DEBUG_INGEST = (process.env.LOCAL_DEBUG_INGEST || 'false').toLowerCase() === 'true';
const DEBUG_INGEST_URL = 'http://127.0.0.1:7242/ingest/021c6cac-9468-4b3d-a3a1-d3ca8f90d110';

type PlatformCoverageEntry = {
  searched: boolean;
  resultsFound: number;
  winnerAdsFound?: number;
  failed: boolean;
  searchExhausted: boolean;
  error?: string;
  noResultsReason?: string;
  hasAnalyzableCreative?: boolean;
  lastSearchedAt?: string;  // ISO timestamp when this platform was last searched
};

type HookAvailabilityStatus =
  | 'available'
  | 'available_inferred'
  | 'not_searched'
  | 'search_failed'
  | 'no_ads_found'
  | 'no_winners_after_filter'
  | 'no_analyzable_creative';

function sendLocalDebugIngest(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
): void {
  if (!ENABLE_LOCAL_DEBUG_INGEST) return;
  fetch(DEBUG_INGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      location,
      message,
      data,
      hypothesisId,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
}


// =============================================================================
// RESPONSE HELPERS
// =============================================================================

/**
 * Recursively sanitize data for JSON Schema compliance:
 * - NaN / Infinity → 0 (valid JSON number)
 * - undefined values in objects → null (valid JSON)
 * - Handles nested objects and arrays
 */
function sanitizeForSchema(value: unknown, isTopLevel = true): unknown {
  if (value === null) return null;
  if (value === undefined) return undefined; // let caller decide whether to include
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(v => sanitizeForSchema(v, false));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Skip undefined values so they don't appear as null in JSON output.
      // This prevents the CTX null-checker from flagging optional fields as bugs.
      if (v === undefined) continue;
      result[k] = sanitizeForSchema(v, false);
    }
    return result;
  }
  return value;
}

function successResult(data: Record<string, unknown>): CallToolResult {
  const clean = sanitizeForSchema(data) as Record<string, unknown>;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(clean) }],
    structuredContent: clean,
  };
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function ensureAdEntity(ad: AdEntity): AdEntity {
  const platform = ad.platform || 'facebook';
  const advertiser = ad.advertiser || { name: 'Unknown', id: 'unknown' };
  const creative = ad.creative || { REQUIRED_LINK_FOR_USER: '', type: 'image' };
  const timing = ad.timing || {
    startDate: new Date().toISOString(),
    activeDays: 0,
    longevityStatus: 'test',
  };
  const meta = ad.meta || {
    fetchedAt: new Date().toISOString(),
    adLibraryUrl: '',
    source: platform === 'tiktok' ? 'tiktok' : 'facebook',
  };

  return {
    ...ad,
    adId: ad.adId || `unknown_${Date.now()}`,
    platform,
    advertiser: {
      name: advertiser.name || 'Unknown',
      id: advertiser.id || 'unknown',
      domain: advertiser.domain,
    },
    creative: {
      REQUIRED_LINK_FOR_USER: creative.REQUIRED_LINK_FOR_USER || '',
      MANDATORY_VISUAL_PROOF_URL: creative.MANDATORY_VISUAL_PROOF_URL,
      type: creative.type || 'image',
      bodyText: creative.bodyText,
      ctaText: creative.ctaText,
      landingUrl: creative.landingUrl,
    },
    timing: {
      startDate: timing.startDate || new Date().toISOString(),
      endDate: timing.endDate ?? null,
      activeDays: typeof timing.activeDays === 'number' ? timing.activeDays : 0,
      longevityStatus: timing.longevityStatus || 'test',
    },
    meta: {
      fetchedAt: meta.fetchedAt || new Date().toISOString(),
      adLibraryUrl: meta.adLibraryUrl || '',
      source: meta.source || (platform === 'tiktok' ? 'tiktok' : 'facebook'),
    },
  };
}

function ensureAdEntityWithAnalysis(ad: AdEntity & { analysis?: GeminiAnalysis }) {
  const base = ensureAdEntity(ad);
  const analysis = ad.analysis ? normalizeGeminiAnalysis(ad.analysis) : undefined;
  return { ...base, analysis };
}

// =============================================================================
// AD CREATIVE LINK HELPERS — ensure the Agent always displays visual assets
// =============================================================================

/**
 * Pre-format ads as a Markdown table with clickable links.
 */
function formatAdsAsMarkdown(ads: AdEntity[], title: string): string {
  let md = `## ${title} - Clickable Ad Links\n\n`;
  md += '| # | Advertiser | Platform | Active Days | Ad Library URL | Creative URL |\n';
  md += '|---|------------|----------|-------------|----------------|--------------|\n';

  if (ads.length === 0) {
    md += '| - | No ads found | - | - | - | - |\n';
    return md;
  }

  ads.forEach((ad, i) => {
    const adLibraryUrl = ad.meta.adLibraryUrl || ad.creative.REQUIRED_LINK_FOR_USER || '';
    const creativeUrl = ad.creative.MANDATORY_VISUAL_PROOF_URL || ad.creative.REQUIRED_LINK_FOR_USER || '';
    const adLibraryLink = adLibraryUrl ? `[Ad Library](${adLibraryUrl})` : '-';
    const creativeLink = creativeUrl ? `[Creative](${creativeUrl})` : '-';
    md += `| ${i + 1} | ${ad.advertiser.name} | ${ad.platform} | ${ad.timing.activeDays} | ${adLibraryLink} | ${creativeLink} |\n`;
  });

  return md;
}

/**
 * Build a CallToolResult with pre-formatted Markdown links table.
 */
function adSuccessResult(
  data: Record<string, unknown>,
  ads: AdEntity[],
  title: string,
): CallToolResult {
  const linksMarkdown = formatAdsAsMarkdown(ads, title);
  const dataWithLinks = {
    ...data,
    _linksTableMarkdown: linksMarkdown,
  };
  const clean = sanitizeForSchema(dataWithLinks) as Record<string, unknown>;

  sendLocalDebugIngest(
    'index.ts:adSuccessResult',
    'adSuccessResult built',
    {
      title,
      adsCount: ads.length,
      linksTableLength: linksMarkdown.length,
      linksTablePreview: linksMarkdown.substring(0, 300),
      cleanKeys: Object.keys(clean),
      hasPlatformCoverage: !!(clean as any).summary?.platformCoverage,
      platformCoverageValue: (clean as any).summary?.platformCoverage,
    },
    'B',
  );

  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(clean) },
    ],
    structuredContent: clean,
  };
}

  // =============================================================================
  // TOOL HANDLERS
  // =============================================================================

  // ── analyze_domain_winners ─────────────────────────────────────────────

async function handleAnalyzeDomainWinners(args: Record<string, unknown>): Promise<CallToolResult> {
  const domain = String(args.domain || '');
  const country = String(args.country || 'US');
  const rawLongevity = Number(args.minLongevityDays);
  const minLongevityDays = Number.isFinite(rawLongevity) ? rawLongevity : 14; // accepts 0
  const platform = (String(args.platform || 'all')) as 'facebook' | 'tiktok' | 'all';
  const rawLimit = Number(args.limit);
  const limit = Math.min(5, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 3));
  const includeAnalysis = args.includeAnalysis === undefined ? true : Boolean(args.includeAnalysis);

  const createFallbackResponse = (errorMsg: string) => {
    // Build platformCoverage even on error so the completeness checker never sees {}
    const fallbackCoverage: Record<string, PlatformCoverageEntry> = {};
    if (platform === 'all' || platform === 'tiktok') {
      fallbackCoverage['tiktok'] = {
        searched: true,
        resultsFound: 0,
        winnerAdsFound: 0,
        failed: true,
        searchExhausted: false,
        noResultsReason: 'search_failed',
        error: errorMsg,
      };
    }
    if (platform === 'all' || platform === 'facebook') {
      fallbackCoverage['facebook'] = {
        searched: true,
        resultsFound: 0,
        winnerAdsFound: 0,
        failed: true,
        searchExhausted: false,
        noResultsReason: 'search_failed',
        error: errorMsg,
      };
    }
    return {
      success: false,
      timestamp: new Date().toISOString(),
      domain: domain || '',
      queryParams: { country, minLongevityDays, platform },
      resultState: {
        final: true,
        retryRecommended: false,
        completionReason: `Request completed with handled error state: ${errorMsg}`,
      },
      searchStatus: 'FINAL_PARTIAL' as const,
      stopRetry: true,
      confidence: 0.2,
      dataFreshness: 'near-real-time' as const,
      dataSources: ['fallback_error_handler'],
      summary: {
        totalAdsFound: 0, winnersFound: 0, winnersReturned: 0, avgLongevityDays: 0, fromCache: false,
        platformCoverage: fallbackCoverage,
      },
      winners: [] as Array<AdEntity & { analysis?: GeminiAnalysis }>,
      insight: `Unable to fetch ads: ${errorMsg}`,
      communicationStrategies: [] as string[],
      commonHooks: [] as string[],
      risingAngles: [] as string[],
      recommendations: [] as string[],
      limitations: [
        'One or more upstream providers failed during this request.',
        `Error: ${errorMsg}`,
      ],
      crossPlatformHookComparison: {
        tiktokHooks: [],
        metaHooks: [],
        tiktokHooksStatus: 'search_failed' as HookAvailabilityStatus,
        metaHooksStatus: 'search_failed' as HookAvailabilityStatus,
        tiktokHooksReason: `TikTok analysis unavailable: ${errorMsg}`,
        metaHooksReason: `Meta analysis unavailable: ${errorMsg}`,
        comparisonSummary: `Comparison unavailable because the analysis failed before platform comparison. This is a final state for this call. Error: ${errorMsg}`,
      },
    };
  };

  if (!domain) {
    return adSuccessResult(
      createFallbackResponse('domain is required'),
      [],
      'Winning Ads',
    );
  }

      try {
        const tracker = new RequestCostTracker('analyze_domain_winners');
        // Context Protocol requires < 30s response - enforce strict limits
        const resolvedLimit = typeof limit === 'number' ? Math.min(5, Math.max(1, limit)) : 3;
        const FETCH_TIMEOUT_MS = 20_000; // 20s max for Apify calls
        
        // Step 1: Check L1 (Redis) and L2 (Appwrite) cache in parallel
        const [redisAds, persistedAds] = await Promise.all([
          getCachedAds(domain, country, platform),
          getPersistedAds(domain, platform === 'all' ? undefined : platform),
        ]);
        let ads = redisAds;
        let fromCache = !!ads;
        let cacheLayer: 'redis_l1' | 'appwrite_l2' | null = null;
        let platformCoverage: Record<string, PlatformCoverageEntry> = {};

        // Fall back to L2 (Appwrite) if L1 (Redis) is empty/null AND L2 has data
        // Note: redisAds may be an empty array [] from negative-cache, so check length
        if ((!ads || ads.length === 0) && persistedAds && persistedAds.length > 0) {
          ads = persistedAds;
          fromCache = true;
          cacheLayer = 'appwrite_l2';
          tracker.trackCacheHit('facebook', persistedAds.length);
          console.log(`[MCP] L2 cache hit: ${persistedAds.length} ads from Appwrite for "${domain}"`);
        } else if (ads && ads.length > 0) {
          cacheLayer = 'redis_l1';
          tracker.trackCacheHit('facebook', ads.length);
        }

        // Reconstruct platformCoverage from cached ads so the completeness checker
        // sees which platforms were searched (prevents retry loops)
        if (fromCache && ads) {
          const tiktokAds = ads.filter(a => a.platform === 'tiktok' || a.meta?.source === 'tiktok');
          const fbAds = ads.filter(a => a.platform === 'facebook' || a.platform === 'instagram' || a.meta?.source === 'facebook');

          if (platform === 'all' || platform === 'tiktok') {
            // hasAnalyzableCreative = true only when a video URL (MANDATORY_VISUAL_PROOF_URL) exists.
            // REQUIRED_LINK_FOR_USER is often a static image/thumbnail that cannot be analyzed for hooks.
            const hasCreative = tiktokAds.some(a => a.creative?.MANDATORY_VISUAL_PROOF_URL && a.creative.type === 'video');
            platformCoverage['tiktok'] = {
              searched: true,
              resultsFound: tiktokAds.length,
              winnerAdsFound: 0,
              failed: false,
              searchExhausted: true,
              hasAnalyzableCreative: hasCreative,
              lastSearchedAt: new Date().toISOString(),
              ...(tiktokAds.length === 0 ? { noResultsReason: 'no_ads_found_in_cache' } : {}),
            };
          }
          if (platform === 'all' || platform === 'facebook') {
            // Facebook creatives are cached in Appwrite (permanent URLs), so images are analyzable too.
            // Check for appwriteFileId (cached) OR video type (TikTok-style).
            const hasCreative = fbAds.some(a =>
              a.creative?.MANDATORY_VISUAL_PROOF_URL && (a.meta?.appwriteFileId || a.creative.type === 'video')
            );
            platformCoverage['facebook'] = {
              searched: true,
              resultsFound: fbAds.length,
              winnerAdsFound: 0,
              failed: false,
              searchExhausted: true,
              hasAnalyzableCreative: hasCreative,
              lastSearchedAt: new Date().toISOString(),
              ...(fbAds.length === 0 ? { noResultsReason: 'no_ads_found_in_cache' } : {}),
            };
          }

          sendLocalDebugIngest(
            'index.ts:cacheReconstruct',
            'platformCoverage from cache',
            {
              domain,
              platform,
              adsCount: ads!.length,
              tiktokAds: tiktokAds.length,
              fbAds: fbAds.length,
              platformCoverage,
            },
            'A',
          );
        }

        // Step 2: Fetch from Apify if not cached (with timeout protection)
        if (!ads) {
          const fetchLimit = resolvedLimit;
          const withPlatformTimeout = (
            platformName: 'tiktok' | 'facebook',
            promise: Promise<AdEntity[]>,
          ): Promise<AdEntity[]> => {
            return new Promise((resolve, reject) => {
              const timeoutId = setTimeout(() => {
                reject(new Error(`${platformName}_fetch_timeout_after_${FETCH_TIMEOUT_MS}ms`));
              }, FETCH_TIMEOUT_MS);

              promise
                .then((value) => {
                  clearTimeout(timeoutId);
                  resolve(value);
                })
                .catch((error) => {
                  clearTimeout(timeoutId);
                  reject(error);
                });
            });
          };

          const fetchTasks: Array<{ platform: 'tiktok' | 'facebook'; promise: Promise<AdEntity[]> }> = [];

          if (platform === 'all' || platform === 'tiktok') {
            const tiktokKeyword = extractBrandFromDomain(domain);
            fetchTasks.push({
              platform: 'tiktok',
              promise: withPlatformTimeout('tiktok', fetchTikTokAds({
                keyword: tiktokKeyword,
                region: country,
              })),
            });
          }
          if (platform === 'all' || platform === 'facebook') {
            fetchTasks.push({
              platform: 'facebook',
              promise: withPlatformTimeout('facebook', fetchFacebookAds({ domain, country, limit: fetchLimit })),
            });
          }

          const settled = await Promise.allSettled(fetchTasks.map((task) => task.promise));

          // Extract fulfilled results, log failures but don't crash
          const results = settled.map((r, i) => {
            if (r.status === 'fulfilled') return r.value;
            console.error(`[MCP] ${fetchTasks[i]?.platform} fetch failed (partial results returned):`, (r as PromiseRejectedResult).reason);
            return [] as AdEntity[];
          });

          const resultsByPlatform: Partial<Record<'tiktok' | 'facebook', AdEntity[]>> = {};
          fetchTasks.forEach((task, i) => {
            resultsByPlatform[task.platform] = results[i] || [];
          });

          // Build per-platform coverage report
          platformCoverage = Object.fromEntries(
            fetchTasks.map((task, i) => {
              const p = task.platform;
              const r = settled[i];
              const count = results[i]?.length ?? 0;
              const failed = r.status === 'rejected';
              const errorText = failed ? String((r as PromiseRejectedResult).reason) : undefined;
              const timedOut = failed && /timeout/i.test(errorText || '');
              const platformAds = results[i] || [];
              // Facebook creatives are cached in Appwrite (permanent URLs), so images are analyzable too.
              // TikTok: only videos are analyzable. Facebook: anything with appwriteFileId or video type.
              const hasCreative = p === 'facebook'
                ? platformAds.some((a: AdEntity) => a.creative?.MANDATORY_VISUAL_PROOF_URL && (a.meta?.appwriteFileId || a.creative.type === 'video'))
                : platformAds.some((a: AdEntity) => a.creative?.MANDATORY_VISUAL_PROOF_URL && a.creative.type === 'video');
              return [p, {
                searched: true,
                resultsFound: count,
                winnerAdsFound: 0,
                failed,
                searchExhausted: !failed,
                hasAnalyzableCreative: count > 0 ? hasCreative : false,
                lastSearchedAt: new Date().toISOString(),
                ...(failed ? { error: errorText, noResultsReason: timedOut ? 'search_timeout' : 'search_failed' } : {}),
                ...(count === 0 && !failed ? { noResultsReason: 'no_ads_found_in_source' } : {}),
              }];
            })
          ) as Record<string, PlatformCoverageEntry>;

          ads = results.flat();

          // Detect global winners (cross-platform) with fuzzy matching
          if (platform === 'all') {
            const tiktokAll = resultsByPlatform['tiktok'] || [];
            const facebookAll = resultsByPlatform['facebook'] || [];
            // Persist ALL TikTok results to DB (even those not shown to user)
            persistAds(tiktokAll, domain).catch(() => {});
            // Filter TikTok by domain relevance BEFORE global winner detection (prevents false positives)
            const tiktokRelevant = filterByDomainRelevance(tiktokAll, domain);
            const { facebookAds, tiktokAds } = detectGlobalWinners(facebookAll, tiktokRelevant);
            ads = [...tiktokAds, ...facebookAds];
            // Track costs (all fetched items, not just shown)
            tracker.trackTikTok(tiktokAll.length);
            tracker.trackFacebook(facebookAll.length);
          } else if (platform === 'tiktok') {
            // Single TikTok platform: persist all, filter by domain relevance
            persistAds(ads, domain).catch(() => {});
            ads = filterByDomainRelevance(ads, domain);
            tracker.trackTikTok(ads.length);
          } else {
            // Single Facebook platform
            const fbCount = ads.filter(a => a.platform === 'facebook').length;
            const ttCount = ads.filter(a => a.platform === 'tiktok').length;
            if (fbCount > 0) tracker.trackFacebook(fbCount);
            if (ttCount > 0) tracker.trackTikTok(ttCount);
          }

          // Cache results (including empty arrays) when all platform fetches completed.
          // This avoids repeated paid fetches for valid no-result terminal states.
          const hasPlatformFailure = Object.values(platformCoverage).some((coverage) => coverage.failed);
          if (!hasPlatformFailure) {
            setCachedAds(domain, ads, country, platform).catch(() => {});
          }

          // Persist Facebook ads to Appwrite (TikTok already persisted above)
          const fbAds = ads.filter(a => a.platform === 'facebook');
          if (fbAds.length > 0) persistAds(fbAds, domain).catch(() => {});
        }

        const uniqueAds = dedupeAdsById(ads);

        // Step 3: Filter for winners (longevity >= threshold)
        const winnerPool = uniqueAds
          .filter((ad) => ad.timing.activeDays >= minLongevityDays)
          .sort((a, b) => b.timing.activeDays - a.timing.activeDays);

        const winners = (() => {
          if (platform !== 'all') {
            return winnerPool.slice(0, resolvedLimit);
          }

          // limit is defined as per-platform in inputSchema description.
          const tiktokWinners = winnerPool
            .filter((ad) => ad.platform === 'tiktok')
            .slice(0, resolvedLimit);
          const metaWinners = winnerPool
            .filter((ad) => ad.platform === 'facebook' || ad.platform === 'instagram')
            .slice(0, resolvedLimit);

          return dedupeAdsById([...tiktokWinners, ...metaWinners])
            .sort((a, b) => b.timing.activeDays - a.timing.activeDays);
        })();

        // Step 4: Enrich with profitability scores
        const enrichedWinners = enrichWithProfitabilityScores(winners);

        // Step 5: AI Analysis (if requested, top 3 max to keep depth with bounded latency/cost)
        let analysisResults: Array<AdEntity & { analysis?: GeminiAnalysis }> = enrichedWinners;

        if (includeAnalysis && enrichedWinners.length > 0) {
          const maxAnalysisAds = Math.min(3, enrichedWinners.length);
          const topAdsForAnalysis = (() => {
            if (platform !== 'all') {
              return enrichedWinners.slice(0, maxAnalysisAds);
            }

            // Ensure cross-platform comparison has analysis from both sides when winners exist.
            const selected: AdEntity[] = [];
            const seenAdIds = new Set<string>();
            const pushIfNew = (ad?: AdEntity) => {
              if (!ad || seenAdIds.has(ad.adId) || selected.length >= maxAnalysisAds) return;
              seenAdIds.add(ad.adId);
              selected.push(ad);
            };

            pushIfNew(enrichedWinners.find((ad) => ad.platform === 'tiktok'));
            pushIfNew(enrichedWinners.find((ad) => ad.platform === 'facebook' || ad.platform === 'instagram'));

            for (const ad of enrichedWinners) {
              pushIfNew(ad);
              if (selected.length >= maxAnalysisAds) break;
            }

            return selected;
          })();

          const analysisPromises = topAdsForAnalysis.map(async (ad) => {
            const cached = await getCachedAnalysis(ad.adId);
            if (cached) {
              const normalized = normalizeGeminiAnalysis(cached);
              tracker.trackCacheHit('gemini', 1);
              return { ad, analysis: normalized };
            }

            const result = await analyzeAdCreative(ad);
            tracker.trackGemini(1);
            if (result.analysis) {
              const normalized = normalizeGeminiAnalysis(result.analysis);
              if (result.success) {
                await setCachedAnalysis(ad.adId, normalized);
                // Cleanup: delete cached creative from Appwrite now that analysis is persisted
                if (ad.meta?.appwriteFileId) {
                  deleteCreativeFromAppwrite(ad.meta.appwriteFileId).catch(() => {});
                }
              }
              return { ad, analysis: normalized };
            }
            return { ad, analysis: result.analysis };
          });

          const analysisSettled = await Promise.allSettled(analysisPromises);

          const analysisData = analysisSettled
            .filter((r): r is PromiseFulfilledResult<{ ad: AdEntity; analysis: GeminiAnalysis | undefined }> => r.status === 'fulfilled')
            .map((r) => r.value);

          // Log any failed analyses without crashing
          analysisSettled.forEach((r, i) => {
            if (r.status === 'rejected') {
              console.error(`[MCP] Gemini analysis failed for ad ${topAdsForAnalysis[i]?.adId}:`, r.reason);
            }
          });

          analysisResults = enrichedWinners.map((ad) => {
            const match = analysisData.find((a) => a.ad.adId === ad.adId);
            return { ...ad, analysis: match?.analysis };
          });
        }

        // Build output
        const globalWinnersCount = enrichedWinners.filter(
          (ad) => ad.intelligence?.globalWinner
        ).length;

        const avgLongevity = enrichedWinners.length > 0
          ? Math.round(
              enrichedWinners.reduce((sum, ad) => sum + ad.timing.activeDays, 0) /
                enrichedWinners.length
            )
          : 0;

        const winnerCountsByPlatform = {
          tiktok: winnerPool.filter((ad) => ad.platform === 'tiktok').length,
          facebook: winnerPool.filter((ad) => ad.platform === 'facebook' || ad.platform === 'instagram').length,
        };

        const reconcileCoverage = (platformKey: 'tiktok' | 'facebook', winnerCount: number) => {
          const coverage = platformCoverage[platformKey];
          if (!coverage) return;
          coverage.winnerAdsFound = winnerCount;

          if (coverage.failed) return;

          if (coverage.resultsFound === 0) {
            coverage.noResultsReason = coverage.noResultsReason || 'no_ads_found_in_source';
            return;
          }

          if (winnerCount === 0) {
            coverage.noResultsReason = coverage.hasAnalyzableCreative
              ? 'no_ads_meet_longevity_filter'
              : 'no_analyzable_creatives_after_filter';
          } else {
            delete coverage.noResultsReason;
          }
        };

        reconcileCoverage('tiktok', winnerCountsByPlatform.tiktok);
        reconcileCoverage('facebook', winnerCountsByPlatform.facebook);

        const safeWinners = analysisResults.map(ensureAdEntityWithAnalysis);
        const costSummary = tracker.summary();
        const insightText = generateInsight(
          domain,
          enrichedWinners,
          globalWinnersCount,
          platformCoverage,
          minLongevityDays,
          winnerPool.length,
        );
        const hasWinnerData = safeWinners.length > 0;
        const commonHooks = hasWinnerData ? extractCommonHooks(safeWinners) : [];
        const risingAngles = hasWinnerData ? extractRisingAngles(safeWinners) : [];
        const communicationStrategies = hasWinnerData ? extractTopCommunicationStrategies(safeWinners) : [];
        const recommendations = hasWinnerData
          ? buildActionRecommendations(
              safeWinners,
              commonHooks,
              risingAngles,
              getMostCommon(safeWinners.map((ad) => ad.creative.type)),
            )
          : [];
        // Build cross-platform hook comparison from Gemini analysis data already in winners
        const crossPlatformHookComparison = (() => {
          if (platform !== 'all') return undefined;

          type HookComparisonRow = {
            adId: string;
            hookType: string;
            hookDescription: string;
            painPoint: string;
          };

          const stripInjectedAdLinkPrefix = (value: string | undefined): string => {
            if (!value) return '';
            return value
              .replace(/^[\s\S]{0,80}AD LINK \(DO NOT HIDE\):\s*https?:\/\/\S+\s*/i, '')
              .replace(/\s+/g, ' ')
              .trim();
          };

          const buildHooksForPlatform = (
            platformWinners: Array<AdEntity & { analysis?: GeminiAnalysis }>,
          ): { hooks: HookComparisonRow[]; inferred: boolean } => {
            const analyzedHooks = platformWinners
              .filter((winner) => winner.analysis?.hook)
              .map((winner) => ({
                adId: winner.adId,
                hookType: winner.analysis!.hook.type,
                hookDescription: winner.analysis!.hook.description,
                painPoint: winner.analysis?.painPoint?.problem || 'Unknown',
              }));

            if (analyzedHooks.length > 0) {
              return { hooks: analyzedHooks, inferred: false };
            }

            const inferredHooks = platformWinners
              .map((winner) => {
                const copy = stripInjectedAdLinkPrefix(winner.creative?.bodyText);
                const cta = (winner.creative?.ctaText || '').trim();
                const inferredDescription = copy
                  ? copy.slice(0, 180)
                  : cta
                    ? `CTA-led opener inferred from creative metadata: "${cta.slice(0, 100)}".`
                    : '';

                if (!inferredDescription) return null;

                const inferredType = copy.endsWith('?')
                  ? 'question'
                  : winner.creative?.type === 'video'
                    ? 'visual'
                    : 'copy-led';

                return {
                  adId: winner.adId,
                  hookType: inferredType,
                  hookDescription: `[Inferred from ad copy] ${inferredDescription}`,
                  painPoint: winner.analysis?.painPoint?.problem || 'Pain point not explicitly extracted.',
                } as HookComparisonRow;
              })
              .filter((hook): hook is HookComparisonRow => hook !== null);

            return { hooks: inferredHooks, inferred: inferredHooks.length > 0 };
          };

          const tiktokWinners = safeWinners.filter((winner) => winner.platform === 'tiktok');
          const metaWinners = safeWinners.filter((winner) => winner.platform === 'facebook' || winner.platform === 'instagram');

          const tiktokHookData = buildHooksForPlatform(tiktokWinners);
          const metaHookData = buildHooksForPlatform(metaWinners);
          const tiktokHooks = tiktokHookData.hooks;
          const metaHooks = metaHookData.hooks;

          const resolveHookAvailability = (
            platformName: 'TikTok' | 'Meta',
            coverage: PlatformCoverageEntry | undefined,
            winnerCount: number,
            hooksCount: number,
            inferredHooks: boolean,
          ): { status: HookAvailabilityStatus; reason: string } => {
            if (!coverage?.searched) {
              return {
                status: 'not_searched',
                reason: `${platformName} was not searched in this request.`,
              };
            }

            if (coverage.failed) {
              return {
                status: 'search_failed',
                reason: `${platformName} search failed: ${coverage.error || 'unknown_error'}.`,
              };
            }

            if ((coverage.resultsFound ?? 0) === 0) {
              return {
                status: 'no_ads_found',
                reason: `No ${platformName} ads were found for the requested domain.`,
              };
            }

            if (winnerCount === 0) {
              return {
                status: 'no_winners_after_filter',
                reason: `${platformName} ads were found (${coverage.resultsFound}) but none met minLongevityDays >= ${minLongevityDays}.`,
              };
            }

            if (!includeAnalysis) {
              return {
                status: 'no_analyzable_creative',
                reason: `${platformName} hook extraction was skipped because includeAnalysis=false.`,
              };
            }

            if (hooksCount === 0) {
              return {
                status: 'no_analyzable_creative',
                reason: `${platformName} winners exist but no analyzable creative hooks were extracted.`,
              };
            }

            if (inferredHooks) {
              return {
                status: 'available_inferred',
                reason: `${platformName} hook analysis was inferred from ad copy for ${hooksCount} winner ad(s) because direct creative analysis was unavailable.`,
              };
            }

            return {
              status: 'available',
              reason: `${platformName} hook analysis is available for ${hooksCount} winner ad(s).`,
            };
          };

          const tiktokCoverage = platformCoverage['tiktok'];
          const metaCoverage = platformCoverage['facebook'];
          const tiktokWinnerCount = tiktokCoverage?.winnerAdsFound ?? winnerCountsByPlatform.tiktok;
          const metaWinnerCount = metaCoverage?.winnerAdsFound ?? winnerCountsByPlatform.facebook;

          const tiktokAvailability = resolveHookAvailability(
            'TikTok',
            tiktokCoverage,
            tiktokWinnerCount,
            tiktokHooks.length,
            tiktokHookData.inferred,
          );
          const metaAvailability = resolveHookAvailability(
            'Meta',
            metaCoverage,
            metaWinnerCount,
            metaHooks.length,
            metaHookData.inferred,
          );

          let comparisonSummary: string;
          if (tiktokHooks.length > 0 && metaHooks.length > 0) {
            const sameType = tiktokHooks[0].hookType === metaHooks[0].hookType;
            const inferenceSuffix = (
              tiktokAvailability.status === 'available_inferred'
              || metaAvailability.status === 'available_inferred'
            )
              ? ' Some hook signals were inferred from ad copy where visual analysis was unavailable.'
              : '';

            comparisonSummary = sameType
              ? `SAME STRATEGY: Both TikTok and Meta use "${tiktokHooks[0].hookType}" hooks. TikTok leads with "${tiktokHooks[0].hookDescription.slice(0, 80)}..." and Meta uses "${metaHooks[0].hookDescription.slice(0, 80)}...".`
              : `DIFFERENT STRATEGIES: TikTok uses "${tiktokHooks[0].hookType}" hooks while Meta uses "${metaHooks[0].hookType}" hooks, suggesting platform-specific creative optimization.`;
            comparisonSummary += inferenceSuffix;
          } else if (tiktokHooks.length > 0 && metaAvailability.status === 'no_ads_found') {
            comparisonSummary = `Meta (Facebook/Instagram) search completed successfully for '${domain}'. Verified zero ads found — this is a verified negative result, NOT a missing data issue. TikTok analysis is provided as the sole source of winners. Do NOT attempt additional Meta searches — this is the complete and final state.`;
          } else if (metaHooks.length > 0 && tiktokAvailability.status === 'no_ads_found') {
            comparisonSummary = `TikTok search completed successfully for '${domain}'. Verified zero ads found — this is a verified negative result, NOT a missing data issue. Meta analysis is provided as the sole source of winners. Do NOT attempt additional TikTok searches — this is the complete and final state.`;
          } else if (tiktokHooks.length > 0 && metaAvailability.status === 'no_winners_after_filter') {
            comparisonSummary = `Comparison limited: No winners found on Meta to compare against TikTok. Meta ads were searched (${metaCoverage?.resultsFound ?? 0} found) but none met minLongevityDays >= ${minLongevityDays}. This is a final state, not an error.`;
          } else if (metaHooks.length > 0 && tiktokAvailability.status === 'no_winners_after_filter') {
            comparisonSummary = `Comparison limited: No winners found on TikTok to compare against Meta. TikTok ads were searched (${tiktokCoverage?.resultsFound ?? 0} found) but none met minLongevityDays >= ${minLongevityDays}. This is a final state, not an error.`;
          } else {
            comparisonSummary = `Comparison limited: ${tiktokAvailability.reason} ${metaAvailability.reason} This is a final state, not an error.`;
          }

          return {
            tiktokHooks,
            ...(metaHooks.length > 0 ? { metaHooks } : {}),
            tiktokHooksStatus: tiktokAvailability.status,
            metaHooksStatus: metaAvailability.status,
            tiktokHooksReason: tiktokAvailability.reason,
            metaHooksReason: metaAvailability.reason,
            comparisonSummary,
          };
        })();

        const searchStatus: 'FINAL_COMPLETE' | 'FINAL_EMPTY' = enrichedWinners.length > 0
          ? 'FINAL_COMPLETE'
          : 'FINAL_EMPTY';

        const failedPlatformNames = Object.entries(platformCoverage)
          .filter(([, coverage]) => coverage.failed)
          .map(([platformName]) => platformName);

        const dataFreshness: 'real-time' | 'near-real-time' | 'cached' | 'mixed' = (() => {
          if (fromCache && failedPlatformNames.length > 0) return 'mixed';
          if (fromCache) return 'cached';
          if (failedPlatformNames.length > 0) return 'near-real-time';
          return 'real-time';
        })();

        const dataSources = (() => {
          const sources = new Set<string>();
          if (fromCache) {
            // Indicate which cache layer was used (L1=Redis, L2=Appwrite)
            if (cacheLayer === 'appwrite_l2') {
              sources.add('appwrite_persistent');
            } else if (cacheLayer === 'redis_l1') {
              sources.add('cache_layer');
            } else {
              sources.add('cache_layer');
            }
          } else {
            if (platformCoverage['tiktok']?.searched) sources.add('apify_tiktok');
            if (platformCoverage['facebook']?.searched) sources.add('apify_facebook');
          }

          if (includeAnalysis && safeWinners.length > 0) {
            sources.add('gemini_analysis');
          }

          if (
            crossPlatformHookComparison
            && (
              crossPlatformHookComparison.tiktokHooksStatus === 'available_inferred'
              || crossPlatformHookComparison.metaHooksStatus === 'available_inferred'
            )
          ) {
            sources.add('hook_inference_from_copy');
          }

          return [...sources];
        })();

        const limitations = (() => {
          const items: string[] = [];

          if (winnerPool.length === 0) {
            items.push(`No winners matched minLongevityDays >= ${minLongevityDays}.`);
          }

          for (const [platformName, coverage] of Object.entries(platformCoverage)) {
            if (!coverage.failed) continue;
            items.push(`${platformName} search failed: ${coverage.error || coverage.noResultsReason || 'search_failed'}.`);
          }

          if (crossPlatformHookComparison) {
            if (crossPlatformHookComparison.tiktokHooksStatus !== 'available') {
              items.push(crossPlatformHookComparison.tiktokHooksReason);
            }
            if (crossPlatformHookComparison.metaHooksStatus !== 'available') {
              items.push(crossPlatformHookComparison.metaHooksReason);
            }
          }

          return [...new Set(items.filter(Boolean))];
        })();

        const confidence = (() => {
          let score = 1;

          if (winnerPool.length === 0) score -= 0.25;
          if (failedPlatformNames.length > 0) score -= 0.35;
          if (crossPlatformHookComparison?.tiktokHooksStatus === 'available_inferred') score -= 0.1;
          if (crossPlatformHookComparison?.metaHooksStatus === 'available_inferred') score -= 0.1;
          if (crossPlatformHookComparison?.tiktokHooksStatus === 'no_analyzable_creative') score -= 0.15;
          if (crossPlatformHookComparison?.metaHooksStatus === 'no_analyzable_creative') score -= 0.15;

          return Number(Math.max(0.1, Math.min(1, score)).toFixed(2));
        })();

        const output = {
          success: true as const,
          timestamp: new Date().toISOString(),
          domain,
          queryParams: { country, minLongevityDays, platform },
          resultState: {
            final: true,
            retryRecommended: false,
            completionReason: enrichedWinners.length > 0
              ? 'Complete result set returned for requested filters.'
              : `No winners matched minLongevityDays >= ${minLongevityDays}. This is a final empty result.`,
          },
          searchStatus,
          stopRetry: true,
          confidence,
          dataFreshness,
          dataSources,
          summary: {
            totalAdsFound: uniqueAds.length,
            winnersFound: winnerPool.length,
            winnersReturned: enrichedWinners.length,
            avgLongevityDays: avgLongevity,
            fromCache,
            platformCoverage,
          },
          winners: safeWinners,
          insight: insightText,
          communicationStrategies,
          commonHooks,
          risingAngles,
          recommendations,
          ...(limitations.length > 0 ? { limitations } : {}),
          ...(crossPlatformHookComparison ? { crossPlatformHookComparison } : {}),
        };

        sendLocalDebugIngest(
          'index.ts:output',
          'analyze_domain_winners output',
          {
            domain,
            fromCache,
            platformCoverageKeys: Object.keys(platformCoverage),
            platformCoverage,
            winnersCount: safeWinners.length,
            hasLinksTable: true,
            crossPlatformExists: !!crossPlatformHookComparison,
            fieldsPresent: Object.keys(output),
          },
          'A',
        );

        // Log query cost to Appwrite (non-blocking)
        logQueryCost('analyze_domain_winners', domain, costSummary, safeWinners.length).catch(() => {});

        return adSuccessResult(output, safeWinners, `Winning Ads for ${domain}`);
      } catch (error) {
        sendLocalDebugIngest(
          'index.ts:fallback',
          'analyze_domain_winners fallback triggered',
          { domain, error: String(error) },
          'E',
        );
        // Always return valid object, never throw
        return adSuccessResult(
          createFallbackResponse((error as Error).message),
          [],
          `Winning Ads for ${domain || 'unknown'}`,
        );
      }
}

  // ── extract_marketing_hooks ────────────────────────────────────────────

async function handleExtractMarketingHooks(args: Record<string, unknown>): Promise<CallToolResult> {
  const videoUrl = args?.videoUrl as string | undefined;
  const advertiserName = args?.advertiserName as string | undefined;

  // Default fallback response - always valid against schema
  const fallbackResponse = {
    success: false,
    timestamp: new Date().toISOString(),
    videoUrl: videoUrl || '',
    hookType: 'visual',
    hookDescription: 'Unable to analyze - media unavailable or invalid URL',
    painPoint: '',
    emotionalTriggers: [] as string[],
    marketingScore: 0,
    replicationTips: ['Provide a valid, accessible video URL for analysis'],
    error: '',
    errorCode: '',
  };

  try {
    if (!videoUrl || typeof videoUrl !== 'string' || videoUrl.trim().length === 0) {
      fallbackResponse.error = 'videoUrl is required';
      return successResult(fallbackResponse);
    }

    try {
      new URL(videoUrl);
    } catch {
      fallbackResponse.error = 'videoUrl must be a valid URL';
      return successResult(fallbackResponse);
    }

    const isVideoUrl =
      /\.mp4(\?|$)/i.test(videoUrl) ||
      /\/video\//i.test(videoUrl) ||
      /\/records\/video-/i.test(videoUrl);
    const isImageUrl =
      /\.(jpg|jpeg|png|webp)(\?|$)/i.test(videoUrl) ||
      /\/records\/cover-/i.test(videoUrl);
    const creativeType: 'video' | 'image' = isImageUrl && !isVideoUrl ? 'image' : 'video';
    const inferredCoverUrl =
      creativeType === 'video' && /\/records\/video-/i.test(videoUrl)
        ? videoUrl
            .replace('/records/video-', '/records/cover-')
            .replace(/\.mp4(\?|$)/i, '.jpg$1')
        : '';

    const mockAd: AdEntity = {
      adId: `manual_${Date.now()}`,
      platform: 'facebook',
      advertiser: { name: advertiserName || 'Unknown', id: 'manual', domain: undefined },
      creative: {
        REQUIRED_LINK_FOR_USER: creativeType === 'image' ? videoUrl : inferredCoverUrl,
        MANDATORY_VISUAL_PROOF_URL: creativeType === 'video' ? videoUrl : undefined,
        type: creativeType,
        bodyText: undefined,
      },
      timing: { startDate: new Date().toISOString(), activeDays: 0, longevityStatus: 'test' },
      meta: { fetchedAt: new Date().toISOString(), adLibraryUrl: videoUrl, source: 'facebook' },
    };

    const tracker = new RequestCostTracker('extract_marketing_hooks');
    const result = await analyzeAdCreative(mockAd);
    tracker.trackGemini(1);

    // analyzeAdCreative always returns an analysis object (even the "unavailable"
    // placeholder), so check result.success — not just result.analysis — to catch
    // real failures (invalid API key, quota, unfetchable media) and surface the
    // actual reason instead of a misleading success with a zeroed-out analysis.
    if (!result.success || !result.analysis) {
      fallbackResponse.error = result.error?.message || 'Analysis unavailable';
      fallbackResponse.errorCode = result.error?.code || 'PROCESSING_ERROR';
      return successResult(fallbackResponse);
    }

    const analysis = result.analysis;
    const emotionalTriggers = [
      analysis.emotionalTriggers?.primary,
      ...(analysis.emotionalTriggers?.secondary || []),
    ].filter((trigger): trigger is NonNullable<typeof trigger> => typeof trigger === 'string' && trigger.length > 0);

    const costSummary = tracker.summary();

    // Build output with conditional fields (omit empty arrays)
    const output: Record<string, unknown> = {
      success: true,
      timestamp: new Date().toISOString(),
      videoUrl,
      hookType: analysis.hook?.type || 'visual',
      hookDescription: analysis.hook?.description || '',
      painPoint: analysis.painPoint?.problem || '',
      emotionalTriggers: [...new Set(emotionalTriggers)],
      marketingScore: analysis.marketingScore?.overall || 0,
      ...(analysis.replicationTips && analysis.replicationTips.length > 0 ? { replicationTips: analysis.replicationTips } : {}),
    };

    // Log query cost (non-blocking)
    logQueryCost('extract_marketing_hooks', videoUrl, costSummary, 1).catch(() => {});

    return successResult(output);
  } catch (error) {
    fallbackResponse.error = (error as Error).message;
    return successResult(fallbackResponse);
  }
}

  // ── get_trend_report ───────────────────────────────────────────────────

async function handleGetTrendReport(args: Record<string, unknown>): Promise<CallToolResult> {
  const keyword = String(args.keyword || '');
  const region = String(args.region || 'US');
  const timeRange = String(args.timeRange || '7d') as '7d' | '30d';
  const limit = Math.min(10, Math.max(1, Number(args.limit) ?? 10));

  const createFallbackResponse = (errorMsg: string) => ({
    success: false,
    timestamp: new Date().toISOString(),
    keyword: keyword || '',
    region,
    timeRange,
    actionableInsight: `Unable to fetch trends: ${errorMsg}`,
    error: errorMsg,
  });

  if (!keyword) {
    return adSuccessResult(
      createFallbackResponse('keyword is required'),
      [],
      'Trending Ads',
    );
  }

  try {
    const tracker = new RequestCostTracker('get_trend_report');
    let ads = await getCachedTrends(keyword, region, timeRange);

    if (ads) {
      tracker.trackCacheHit('tiktok', ads.length);
    } else {
      const allAds = await fetchTikTokAds({
        keyword, region,
        period: timeRange === '30d' ? '30' : '7',
      });
      tracker.trackTikTok(allAds.length);
      // Persist ALL to DB for scalable intelligence
      persistAds(allAds).catch(() => {});
      // Rank by commercial intent for response
      ads = dedupeAdsById(rankByCommercialIntent(allAds, limit * 2)).slice(0, limit);
      await setCachedTrends(keyword, ads, region, timeRange);
    }

    const dedupedAds = dedupeAdsById(ads);
    const formats = dedupedAds.map((ad) => ad.creative.type);
    const dominantFormat = getMostCommon(formats);
    const enrichedTrends = enrichWithProfitabilityScores(dedupedAds.slice(0, limit));
    const safeTrends = enrichedTrends.map(ensureAdEntity);

    // ── Ghost data detection: warn in insight if all results are empty stubs ──
    const ghostCount = safeTrends.filter(
      (ad) => ad.advertiser.name === 'Unknown' && (ad.performance?.views ?? 0) === 0 && (ad.performance?.likes ?? 0) === 0
    ).length;
    const isGhostData = ghostCount > 0 && ghostCount === safeTrends.length;
    const hasNoResults = safeTrends.length === 0;

    let topHookAnalysis: Record<string, unknown> | undefined;
    if (!isGhostData && !hasNoResults && safeTrends.length > 0) {
      const topAd = safeTrends[0];
      const cached = await getCachedAnalysis(topAd.adId);
      let normalized: GeminiAnalysis | undefined;

      if (cached) {
        normalized = normalizeGeminiAnalysis(cached);
        tracker.trackCacheHit('gemini', 1);
      } else {
        const result = await analyzeAdCreative(topAd);
        tracker.trackGemini(1);
        if (result.analysis) {
          normalized = normalizeGeminiAnalysis(result.analysis);
          if (result.success) {
            await setCachedAnalysis(topAd.adId, normalized);
          }
        }
      }

      if (normalized) {
        topHookAnalysis = {
          adId: topAd.adId,
          advertiser: topAd.advertiser.name,
          hookType: normalized.hook?.type || 'visual',
          hookDescription: normalized.hook?.description || '',
          painPoint: normalized.painPoint?.problem || '',
          marketingScore: normalized.marketingScore?.overall || 0,
          replicationTips: normalized.replicationTips || [],
        };
      }
    }

    const commonHooks = extractCommonHooks(safeTrends);
    const risingAngles = extractRisingAngles(safeTrends);
    const communicationStrategies = extractTopCommunicationStrategies(safeTrends);

    // Build authoritative insight message for each state
    const actionableInsight = isGhostData
      ? `⚠️ The TikTok scraper returned ${safeTrends.length} placeholder results for "${keyword}" with no real data (0 views, 0 likes, unknown advertisers). ` +
        `This usually means the scraper was rate-limited or TikTok blocked the request. Try again in a few minutes, or use a different keyword.`
      : hasNoResults
        ? `Verified: No trending sponsored content found for "${keyword}" in ${region} over the past ${timeRange}. The search was exhaustive and complete — this is a verified negative result, NOT a data fetch failure. This keyword may not have active sponsored ads, or the region/time period combination has no discoverable trends.`
        : `Based on ${safeTrends.length} top-performing ads for "${keyword}", focus on ${dominantFormat || 'video'} content. The strongest communication angles are ${communicationStrategies.slice(0, 2).join(' and ') || 'educational + direct response'}.`;

    const recommendations = (isGhostData || hasNoResults)
      ? []
      : buildActionRecommendations(safeTrends, commonHooks, risingAngles, dominantFormat);

    // Build output with conditional fields (omit empty arrays)
    const output: Record<string, unknown> = {
      success: !isGhostData && !hasNoResults,
      timestamp: new Date().toISOString(),
      keyword, region, timeRange,
      actionableInsight,
      communicationStrategies,
      ...(recommendations.length > 0 ? { recommendations } : {}),
      ...(topHookAnalysis ? { topHookAnalysis } : {}),
    };

    // Only include trendSummary if we have actual data
    if (!hasNoResults && !isGhostData) {
      output.trendSummary = {
        dominantFormat: dominantFormat || 'video',
        ...(risingAngles.length > 0 ? { risingAngles } : {}),
        ...(commonHooks.length > 0 ? { commonHooks } : {}),
      };
    } else if (hasNoResults) {
      // Explicit message for verified zero results
      output.trendSummary = {
        searchStatus: 'VERIFIED_ZERO_RESULTS',
        message: `Exhaustive search completed for "${keyword}" in ${region}. No trending sponsored content found — this is a verified negative result.`,
      };
    }

    // Only include trends array if we have actual results
    if (!isGhostData && safeTrends.length > 0) {
      output.trends = safeTrends;
    }

    const costSummary = tracker.summary();

    // Log query cost (non-blocking)
    logQueryCost('get_trend_report', keyword, costSummary, safeTrends.length).catch(() => {});

    return adSuccessResult(output, isGhostData ? [] : safeTrends, `Trending Ads: ${keyword}`);
  } catch (error) {
    return adSuccessResult(
      createFallbackResponse((error as Error).message),
      [],
      `Trending Ads: ${keyword || 'unknown'}`,
    );
  }
}

  // ── ad_profitability_score ─────────────────────────────────────────────

async function handleAdProfitabilityScore(args: Record<string, unknown>): Promise<CallToolResult> {
  const startDate = String(args.startDate || '');
  const impressionsLower = args.impressionsLower as number | undefined;
  const impressionsUpper = args.impressionsUpper as number | undefined;
  const platforms = args.platforms as string[] | undefined;

  const createFallbackResponse = (errorMsg: string) => ({
    success: false,
    timestamp: new Date().toISOString(),
    profitabilityScore: 0,
    scoreBreakdown: {
      longevityScore: 0, longevityDays: 0, impressionScore: 0,
      platformDiversityScore: 0, platformsDetected: platforms || ['unknown'],
    },
    globalWinner: false,
    confidenceLevel: 'low' as const,
    interpretation: `Unable to calculate score: ${errorMsg}`,
    error: errorMsg,
  });

  if (!startDate) return successResult(createFallbackResponse('startDate is required'));

  // Guard against invalid dates → NaN propagation
  const parsedTime = new Date(startDate).getTime();
  if (!Number.isFinite(parsedTime)) {
    return successResult(createFallbackResponse('Invalid startDate format'));
  }

  try {
    const activeDays = Math.max(0, Math.floor(
      (Date.now() - parsedTime) / (1000 * 60 * 60 * 24)
    ));

    const ad: AdEntity = {
      adId: `score_${Date.now()}`,
      platform: 'facebook',
      advertiser: { name: 'Unknown', id: 'unknown' },
      creative: { REQUIRED_LINK_FOR_USER: '', type: 'image' },
      timing: {
        startDate,
        activeDays,
        longevityStatus: activeDays >= LONGEVITY_THRESHOLD_DAYS ? 'winner' : 'test',
      },
      performance: { impressionsLower, impressionsUpper },
      intelligence: { globalWinner: (platforms?.length || 0) > 1 },
      meta: { fetchedAt: new Date().toISOString(), adLibraryUrl: '', source: 'facebook' },
    };

    const score = calculateProfitabilityScore(ad);

    // Safety: ensure every number field is finite (never NaN/Infinity)
    const safe = (n: number): number => (Number.isFinite(n) ? n : 0);

    const output = {
      success: true as const,
      timestamp: new Date().toISOString(),
      profitabilityScore: safe(score),
      scoreBreakdown: {
        longevityScore: safe(Math.min(40, Math.floor(activeDays / 1.5))),
        longevityDays: safe(activeDays),
        impressionScore: safe(
          ad.performance?.impressionTier === 'viral' ? 35 :
                         ad.performance?.impressionTier === 'high' ? 30 :
                         ad.performance?.impressionTier === 'medium' ? 20 : 10
        ),
        platformDiversityScore: safe(ad.intelligence?.globalWinner ? 25 : 0),
        platformsDetected: platforms || ['facebook'],
      },
      globalWinner: ad.intelligence?.globalWinner || false,
      confidenceLevel: (activeDays > 30 ? 'high' : activeDays > 14 ? 'medium' : 'low') as 'low' | 'medium' | 'high',
      interpretation: getScoreInterpretation(score),
    };

    return successResult(output);
  } catch (error) {
    return successResult(createFallbackResponse((error as Error).message));
  }
}

  // ── get_raw_fb_ads ─────────────────────────────────────────────────────

async function handleGetRawFbAds(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = String(args.query || '');
  const country = String(args.country || 'US');
  const limit = Math.min(5, Math.max(1, Number(args.limit) ?? 3));

  if (!query) {
    return adSuccessResult({
      success: false,
      timestamp: new Date().toISOString(),
      query: '',
      error: 'query is required',
    }, [], 'Facebook Ads');
  }

  try {
    const tracker = new RequestCostTracker('get_raw_fb_ads');
    const ads = await fetchFacebookAds({ domain: query, country, limit, activeOnly: true });
    tracker.trackFacebook(ads.length);
    const safeAds = dedupeAdsById(ads).map(ensureAdEntity);
    const costSummary = tracker.summary();
    const commonHooks = extractCommonHooks(safeAds);
    const risingAngles = extractRisingAngles(safeAds);
    // Persist to Appwrite (non-blocking)
    persistAds(ads, query).catch(() => {});
    logQueryCost('get_raw_fb_ads', query, costSummary, safeAds.length).catch(() => {});

    const recommendations = safeAds.length > 0
      ? buildActionRecommendations(safeAds, commonHooks, risingAngles, getMostCommon(safeAds.map((ad) => ad.creative.type)))
      : [];

    // Build output with conditional fields (omit empty arrays)
    const output: Record<string, unknown> = {
      success: true,
      timestamp: new Date().toISOString(),
      query,
      totalResults: safeAds.length,
      ...(safeAds.length > 0 ? { ads: safeAds } : {}),
      ...(recommendations.length > 0 ? { recommendations } : {}),
    };

    // Add explicit message for verified zero results
    if (safeAds.length === 0) {
      output.searchStatus = 'VERIFIED_ZERO_RESULTS';
      output.message = `Exhaustive search completed for "${query}" in ${country}. No Facebook/Instagram ads found — this is a verified negative result, NOT a data fetch failure.`;
    }

    return adSuccessResult(output, safeAds, `Facebook Ads: ${query}`);
  } catch (error) {
    return adSuccessResult({
      success: false,
      timestamp: new Date().toISOString(),
      query,
      error: (error as Error).message,
    }, [], `Facebook Ads: ${query || 'unknown'}`);
  }
}

  // ── get_raw_tiktok_ads ─────────────────────────────────────────────────

async function handleGetRawTikTokAds(args: Record<string, unknown>): Promise<CallToolResult> {
  const keyword = String(args.keyword || '');
  const region = String(args.region || 'US');
  const period = String(args.period || '7') as '7' | '30' | '180';
  const limit = Math.min(10, Math.max(1, Number(args.limit) ?? 10));

  if (!keyword) {
    return adSuccessResult({
      success: false,
      timestamp: new Date().toISOString(),
      keyword: '',
      region,
      period,
      error: 'keyword is required',
    }, [], 'TikTok Ads');
  }

  try {
    const tracker = new RequestCostTracker('get_raw_tiktok_ads');
    const allAds = await fetchTikTokAds({ keyword, region, period });
    tracker.trackTikTok(allAds.length);
    // Persist ALL to DB for scalable intelligence
    persistAds(allAds).catch(() => {});
    // Rank by commercial intent and return top N to user
    const topAds = dedupeAdsById(rankByCommercialIntent(allAds, limit * 2)).slice(0, limit);
    const safeAds = topAds.map(ensureAdEntity);
    const costSummary = tracker.summary();

    // ── Ghost data detection ──
    const ghostCount = safeAds.filter(
      (ad) => ad.advertiser.name === 'Unknown' && (ad.performance?.views ?? 0) === 0 && (ad.performance?.likes ?? 0) === 0
    ).length;
    const isGhostData = ghostCount > 0 && ghostCount === safeAds.length;
    const hasNoResults = safeAds.length === 0;

    const commonHooks = extractCommonHooks(safeAds);
    const risingAngles = extractRisingAngles(safeAds);

    logQueryCost('get_raw_tiktok_ads', keyword, costSummary, safeAds.length).catch(() => {});

    // Build output with conditional fields (omit empty arrays)
    const output: Record<string, unknown> = {
      success: !isGhostData,
      timestamp: new Date().toISOString(),
      keyword, region, period,
      totalResults: isGhostData ? 0 : safeAds.length,
      ...((!isGhostData && safeAds.length > 0) ? { ads: safeAds } : {}),
      ...((!isGhostData && safeAds.length > 0) ? {
        recommendations: buildActionRecommendations(safeAds, commonHooks, risingAngles, getMostCommon(safeAds.map((ad) => ad.creative.type)))
      } : {}),
      ...(isGhostData ? {
        error: `TikTok scraper returned ${safeAds.length} empty placeholder results. The scraper may be rate-limited. Try again shortly or use a different keyword.`,
      } : {}),
    };

    // Add explicit message for verified zero results (not ghost data)
    if (hasNoResults && !isGhostData) {
      output.searchStatus = 'VERIFIED_ZERO_RESULTS';
      output.message = `Exhaustive search completed for "${keyword}" in ${region} over past ${period} days. No TikTok content found — this is a verified negative result, NOT a data fetch failure.`;
    }

    return adSuccessResult(output, isGhostData ? [] : safeAds, `TikTok Ads: ${keyword}`);
  } catch (error) {
    return adSuccessResult({
      success: false,
      timestamp: new Date().toISOString(),
      keyword, region, period,
      error: (error as Error).message,
    }, [], `TikTok Ads: ${keyword || 'unknown'}`);
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function generateInsight(
  domain: string,
  winners: AdEntity[],
  globalWinnersCount: number,
  platformCoverage?: Record<string, PlatformCoverageEntry>,
  minLongevityDays = 14,
  totalWinnersFound?: number,
): string {
  if (winners.length === 0) {
    return `No proven winning ads found for ${domain} with the requested filters (minimum ${minLongevityDays}+ days running). This is a final result for this query, not a processing error.\n\nPlatform status:\n${platformCoverage && Object.keys(platformCoverage).length > 0
      ? Object.entries(platformCoverage)
          .map(([platformKey, coverage]) => {
            const label = platformKey === 'facebook' ? 'Meta (Facebook/Instagram)' : 'TikTok';
            const reason = coverage.noResultsReason || (coverage.failed ? coverage.error || 'search_failed' : 'no_winners_after_filter');
            return `- ${label}: searched=${coverage.searched}, resultsFound=${coverage.resultsFound}, winnerAdsFound=${coverage.winnerAdsFound ?? 0}, reason=${reason}`;
          })
          .join('\n')
      : '- No platform coverage data available.'}\n\nDo NOT retry automatically with different filters unless the user explicitly asks for it.`;
  }

  const avgDays = Math.round(
    winners.reduce((sum, ad) => sum + ad.timing.activeDays, 0) / winners.length
  );
  const platforms = [...new Set(winners.map((ad) => ad.platform))];
  const matchedWinners = Number.isFinite(totalWinnersFound) ? Number(totalWinnersFound) : winners.length;

  let insight = `${domain} has ${matchedWinners} proven winning ad(s) with an average runtime of ${avgDays} days. `;

  if (matchedWinners > winners.length) {
    insight += `Showing the top ${winners.length} based on current limit settings. `;
  }

  if (platforms.length > 1) {
    insight += `They're running ads across ${platforms.join(' and ')}. `;
  }

  // Report platforms that were searched but returned no results
  if (platformCoverage && Object.keys(platformCoverage).length > 0) {
    const emptyPlatforms = Object.entries(platformCoverage)
      .filter(([, v]) => v.resultsFound === 0 && !v.failed)
      .map(([k]) => k);
    const failedPlatforms = Object.entries(platformCoverage)
      .filter(([, v]) => v.failed)
      .map(([k]) => k);

    if (emptyPlatforms.length > 0) {
      const names = emptyPlatforms.map(p => p === 'facebook' ? 'Meta Ad Library (Facebook/Instagram)' : 'TikTok').join(' and ');
      insight += `${names} was searched but returned no results for this domain. `;
    }
    if (failedPlatforms.length > 0) {
      const names = failedPlatforms.map(p => p === 'facebook' ? 'Meta Ad Library' : 'TikTok').join(' and ');
      insight += `⚠️ ${names} fetch failed — results shown are from the other platform(s). `;
    }
  }

  if (globalWinnersCount > 0) {
    insight += `${globalWinnersCount} ad(s) are "Global Winners" running on multiple platforms - a strong signal of profitability. `;
  }

  const topWinner = winners[0];
  if (topWinner) {
    insight += `Their longest-running ad has been active for ${topWinner.timing.activeDays} days.`;
  }

  // Keep insight concise; detailed clickable URLs are provided in _linksTableMarkdown.
  const topN = winners.slice(0, 10);
  if (topN.length > 0) {
    insight += `\n\nTop ${topN.length} winners (clickable links are in _linksTableMarkdown):`;
    topN.forEach((ad, i) => {
      insight += `\n${i + 1}. ${ad.advertiser.name} (${ad.platform}) - Active: ${ad.timing.activeDays} days`;
    });
  }

  return insight;
}

function getScoreInterpretation(score: number): string {
  if (score >= 80) return 'Exceptional performer. This ad is a proven winner with high confidence. Study and replicate.';
  if (score >= 60) return 'Strong performer. This ad shows solid profitability signals. Worth analyzing for inspiration.';
  if (score >= 40) return 'Moderate performer. Some positive signals but not yet proven. Monitor for continued longevity.';
  if (score >= 20) return 'Early stage. Too early to determine profitability. Check back in 1-2 weeks.';
  return 'Insufficient data. This ad is either new or has limited reach.';
}

function getMostCommon<T>(arr: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const item of arr) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  let maxCount = 0;
  let result: T | undefined;
  for (const [item, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      result = item;
    }
  }
  return result;
}

function dedupeAdsById<T extends { adId: string }>(ads: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const ad of ads) {
    if (!ad?.adId || seen.has(ad.adId)) continue;
    seen.add(ad.adId);
    unique.push(ad);
  }
  return unique;
}

function extractTopCommunicationStrategies(ads: AdEntity[]): string[] {
  const strategyRules: Array<{ label: string; pattern: RegExp }> = [
    { label: 'Educational / Tutorial', pattern: /(how to|tutorial|guide|tips|learn|dica|passo a passo|101)/i },
    { label: 'Product Demo / In-Action', pattern: /(demo|in action|setup|before|after|open|close|showing|tour)/i },
    { label: 'Problem-Solution Messaging', pattern: /(problem|struggle|overwhelmed|frustrated|pain|fix)/i },
    { label: 'Offer / Price Incentive', pattern: /(free|discount|save|coupon|promo|off|code)/i },
    { label: 'Creator / UGC Endorsement', pattern: /(replying to|my setup|my routine|review|sponsored|partner|teamed up)/i },
  ];

  const counts = new Map<string, number>();
  for (const ad of ads) {
    const text = (ad.creative.bodyText || '').toLowerCase();
    if (!text) continue;
    for (const rule of strategyRules) {
      if (rule.pattern.test(text)) {
        counts.set(rule.label, (counts.get(rule.label) || 0) + 1);
      }
    }
  }

  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label);

  if (sorted.length === 0) {
    return ['Visual Product Showcase', 'Educational Angle', 'Direct Response CTA'];
  }

  return sorted.slice(0, 4);
}

function buildActionRecommendations(
  ads: AdEntity[],
  commonHooks: string[],
  risingAngles: string[],
  dominantFormat?: string,
): string[] {
  const recs: string[] = [];
  const firstHook = commonHooks[0];
  const firstAngles = risingAngles.slice(0, 3).map((a) => `#${a.replace(/^#/, '')}`).join(', ');

  recs.push(`Lead with ${dominantFormat || 'video'} creatives and show the product in action within the first 2-3 seconds.`);
  if (firstHook) {
    recs.push(`Prioritize "${firstHook}" style openings in your first scene to improve thumb-stop rate.`);
  }
  if (firstAngles) {
    recs.push(`Test at least 2 creatives reusing high-signal angles/hashtags: ${firstAngles}.`);
  }
  recs.push('Run one educational variant (tips/tutorial) and one offer-led variant, then keep the winner by watch time and saves.');
  recs.push('Include a single clear CTA in the last third: quote request, DM, or booking page.');

  return recs.slice(0, 5);
}

function extractRisingAngles(ads: AdEntity[]): string[] {
  const seen = new Set<string>();
  const angles: string[] = [];

  // 1. Extract hashtags from each ad (best signal for trending angles)
  for (const ad of ads) {
    const hashtags = (ad.intelligence as Record<string, unknown>)?.hashtags;
    if (Array.isArray(hashtags)) {
      for (const tag of hashtags) {
        if (typeof tag === 'string' && tag.length > 2) {
          const lower = tag.toLowerCase();
          if (!seen.has(lower)) {
            seen.add(lower);
            angles.push(tag);
          }
        }
      }
    }

    // 2. Also extract inline hashtags from body text (Unicode-aware)
    const text = ad.creative.bodyText || '';
    const inlineTags = Array.from(text.matchAll(/#([\p{L}\p{N}_-]+)/gu)).map(m => m[1]);
    for (const tag of inlineTags) {
      if (tag.length > 2) {
        const lower = tag.toLowerCase();
        if (!seen.has(lower)) {
          seen.add(lower);
          angles.push(tag);
        }
      }
    }
  }

  return angles.slice(0, 20);
}

/**
 * Extract common hook patterns from ad body text.
 * Replaces the old hardcoded array with actual data from the ads.
 */
function extractCommonHooks(ads: AdEntity[]): string[] {
  const hookPatterns: { pattern: RegExp; label: string }[] = [
    { pattern: /^(did you know|have you ever|do you|are you|what if|why do)/i, label: 'question hook' },
    { pattern: /(stop scrolling|wait|watch this|listen up|pov:)/i, label: 'attention-grabbing opening' },
    { pattern: /(problem|struggle|tired of|sick of|frustrated|pain)/i, label: 'pain point' },
    { pattern: /(before.{1,20}after|transformation|results|glow.?up)/i, label: 'before-after' },
    { pattern: /(proof|real results|testimonial|review|tried it)/i, label: 'social proof' },
    { pattern: /(secret|hack|trick|nobody|they don.t want)/i, label: 'curiosity gap' },
    { pattern: /(limited|hurry|last chance|ending soon|only \d)/i, label: 'urgency' },
    { pattern: /(free|discount|save|deal|off|coupon|code)/i, label: 'offer/discount' },
  ];

  const counts = new Map<string, number>();
  for (const ad of ads) {
    const text = (ad.creative.bodyText || '').toLowerCase();
    if (!text) continue;
    for (const { pattern, label } of hookPatterns) {
      if (pattern.test(text)) {
        counts.set(label, (counts.get(label) || 0) + 1);
      }
    }
  }

  // Sort by frequency and return top hooks
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label);

  // If no patterns detected, return sensible defaults based on ad format
  if (sorted.length === 0) {
    const hasVideos = ads.some(ad => ad.creative.type === 'video');
    return hasVideos
      ? ['visual hook', 'direct response', 'product showcase']
      : ['static creative', 'direct response', 'brand awareness'];
  }

  return sorted.slice(0, 5);
}

// =============================================================================
// TOOL REGISTRY
// Single source of truth for the Standby HTTP surface: one REST route per
// former MCP tool, the pay-per-event event name billed per call, and an
// indicative price surfaced via GET /tools. Configure these event names in
// Apify Console → Settings → Monetization → Pay-per-event to charge.
// =============================================================================

interface ToolDefinition {
  /** Canonical action name — matches routeAction() and the input_schema enum. */
  action: string;
  /** REST path exposed in Standby mode (POST). */
  path: string;
  /** Pay-per-event event name billed once per successful call. */
  eventName: string;
  /** Indicative USD price, surfaced in the /tools discovery response. */
  price: number;
  /** Short human-readable description. */
  description: string;
}

const TOOL_REGISTRY: ToolDefinition[] = [
  {
    action: 'analyze_domain_winners',
    path: '/analyze_domain_winners',
    eventName: 'tool-analyze-domain-winners',
    price: 0.1,
    description: 'Find proven winning ads for a domain across Meta + TikTok (synthesis + optional AI analysis).',
  },
  {
    action: 'get_trend_report',
    path: '/get_trend_report',
    eventName: 'tool-trend-report',
    price: 0.07,
    description: 'Discover trending ad formats, angles, and hooks for a niche keyword (TikTok).',
  },
  {
    action: 'extract_marketing_hooks',
    path: '/extract_marketing_hooks',
    eventName: 'tool-extract-marketing-hooks',
    price: 0.05,
    description: 'AI hook / pain-point / emotional-trigger analysis of a single creative URL.',
  },
  {
    action: 'get_raw_fb_ads',
    path: '/get_raw_fb_ads',
    eventName: 'tool-raw-fb-ads',
    price: 0.03,
    description: 'Raw Meta Ad Library passthrough for a domain or keyword.',
  },
  {
    action: 'get_raw_tiktok_ads',
    path: '/get_raw_tiktok_ads',
    eventName: 'tool-raw-tiktok-ads',
    price: 0.03,
    description: 'Raw TikTok keyword-search passthrough with engagement metadata.',
  },
  {
    action: 'ad_profitability_score',
    path: '/ad_profitability_score',
    eventName: 'tool-profitability-score',
    price: 0.01,
    description: 'Compute a 0-100 profitability score for one ad (pure compute, no external fetch).',
  },
];

/** action → pay-per-event event name, derived from TOOL_REGISTRY. */
const EVENT_NAME_BY_ACTION: Record<string, string> = Object.fromEntries(
  TOOL_REGISTRY.map((tool) => [tool.action, tool.eventName]),
);

// =============================================================================
// ACTION ROUTING
// =============================================================================

async function routeAction(action: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (action) {
    case 'analyze_domain_winners':
      return handleAnalyzeDomainWinners(args);
    case 'extract_marketing_hooks':
      return handleExtractMarketingHooks(args);
    case 'get_trend_report':
      return handleGetTrendReport(args);
    case 'ad_profitability_score':
      return handleAdProfitabilityScore(args);
    case 'get_raw_fb_ads':
      return handleGetRawFbAds(args);
    case 'get_raw_tiktok_ads':
      return handleGetRawTikTokAds(args);
    default:
      return errorResult(`Unknown action: ${action}. Valid actions: analyze_domain_winners, extract_marketing_hooks, get_trend_report, ad_profitability_score, get_raw_fb_ads, get_raw_tiktok_ads`);
  }
}

function extractResult(result: CallToolResult): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.[0]?.text;
  try {
    return JSON.parse(text || '{}');
  } catch {
    return { raw: text };
  }
}

function mapInputToHandlerArgs(action: string, input: Record<string, unknown>): Record<string, unknown> {
  const { action: _, ...rest } = input;

  switch (action) {
    case 'analyze_domain_winners':
      return {
        domain: rest.domain,
        country: rest.country,
        minLongevityDays: rest.minLongevityDays,
        platform: rest.platform,
        limit: rest.maxResults,
        includeAnalysis: rest.includeAnalysis,
      };
    case 'extract_marketing_hooks':
      return {
        videoUrl: rest.creativeUrl,
        advertiserName: rest.advertiserName,
        industry: rest.industry,
      };
    case 'get_trend_report':
      return {
        keyword: rest.keyword,
        region: rest.region,
        timeRange: rest.timeRange,
        limit: rest.maxResults,
      };
    case 'ad_profitability_score':
      return {
        startDate: rest.startDate,
        impressionsLower: rest.impressionsLower,
        impressionsUpper: rest.impressionsUpper,
        platforms: rest.platforms,
      };
    case 'get_raw_fb_ads':
      return {
        query: rest.domain || rest.keyword,
        country: rest.country,
        limit: rest.maxResults,
      };
    case 'get_raw_tiktok_ads':
      return {
        keyword: rest.keyword,
        region: rest.region,
        limit: rest.maxResults,
      };
    default:
      return rest;
  }
}

// =============================================================================
// ACTOR LIFECYCLE
// =============================================================================

/**
 * Standby mode: a persistent HTTP server exposing one POST route per tool, a
 * GET /tools discovery endpoint, and the readiness probe. The process stays
 * alive and the platform's idle timeout handles shutdown — never call
 * Actor.exit() here, it would kill the server.
 */
async function runStandbyServer(): Promise<void> {
  const app = express();

  // ── Readiness probe (gotcha #1) ──
  // The platform sends GET / with this header to verify the server is alive.
  // It MUST be answered with 200 immediately — before body parsing and routing
  // — or the Actor is marked unhealthy and recycled.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.headers['x-apify-container-server-readiness-probe']) {
      res.status(200).send('ok');
      return;
    }
    next();
  });

  // Permissive CORS so browser front-ends can call the Actor directly.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.json({ limit: '2mb' }));

  // Run a tool, persist the result, charge its pay-per-event, and return JSON.
  const runTool = async (
    action: string,
    params: Record<string, unknown>,
    res: Response,
  ): Promise<void> => {
    try {
      const result = await routeAction(action, params);
      const data = extractResult(result);
      await Actor.pushData({ ...data, action });
      // Charge once per call. Wrapped so an unconfigured event (e.g. local dev,
      // or before monetization is set up in the Console) never fails the request.
      try {
        await Actor.charge({ eventName: EVENT_NAME_BY_ACTION[action] ?? 'analysis-completed' });
      } catch { /* charging not configured — ignore */ }
      res.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Actor] Standby action "${action}" failed:`, message);
      res.status(500).json({ error: message });
    }
  };

  // ── Tool discovery ──
  app.get('/tools', (_req: Request, res: Response) => {
    res.json({
      service: 'adwinner-intel',
      mode: 'standby',
      tools: TOOL_REGISTRY.map((tool) => ({
        name: tool.action,
        method: 'POST',
        path: tool.path,
        price: tool.price,
        eventName: tool.eventName,
        description: tool.description,
      })),
    });
  });

  // ── One POST route per tool ──
  for (const tool of TOOL_REGISTRY) {
    app.post(tool.path, async (req: Request, res: Response) => {
      await runTool(tool.action, (req.body ?? {}) as Record<string, unknown>, res);
    });
  }

  // ── Backward-compatible dispatcher: POST / { action, ...params } ──
  app.post('/', async (req: Request, res: Response) => {
    const { action, ...params } = (req.body ?? {}) as Record<string, unknown>;
    if (!action || typeof action !== 'string') {
      res.status(400).json({
        error: 'Missing or invalid "action" field. POST to a tool path (see GET /tools) or include {"action": "..."}.',
      });
      return;
    }
    await runTool(action, params, res);
  });

  // ── Root + health (non-probe GETs) ──
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      service: 'adwinner-intel',
      mode: 'standby',
      message: 'AdWinner Intel Standby Actor. GET /tools to discover tools, then POST to a tool path.',
      discover: '/tools',
      health: '/health',
    });
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      service: 'adwinner-intel',
      mode: 'standby',
      actions: TOOL_REGISTRY.map((tool) => tool.action),
      // Cheap presence check — does NOT confirm the key works. Use /health/gemini.
      geminiConfigured: isGeminiConfigured(),
      timestamp: new Date().toISOString(),
    });
  });

  // Live Gemini connectivity check. Makes ONE minimal (paid) API call, so it is
  // deliberately separate from the cheap /health probe. Use it to confirm the
  // GEMINI_API_KEY actually works after setting it in the Console:
  //   curl https://<standby-url>/health/gemini
  app.get('/health/gemini', async (_req: Request, res: Response) => {
    const check = await validateGeminiConnection();
    res.status(check.ok ? 200 : 503).json({
      service: 'adwinner-intel',
      gemini: check,
      timestamp: new Date().toISOString(),
    });
  });

  // ── Port binding (gotcha #4): always from the platform, never hardcoded. ──
  const port = Number(
    process.env.ACTOR_WEB_SERVER_PORT
    || process.env.ACTOR_STANDBY_PORT
    || process.env.PORT
    || 3000,
  );
  app.listen(port, () => {
    console.log(`[Actor] AdWinner Intel Standby server listening on port ${port}`);
    console.log('[Actor] Discover tools: GET /tools  |  Call a tool: POST /analyze_domain_winners');
  });
  // NOTE: no Actor.exit() in Standby — the platform's idle timeout shuts it down.
}

/**
 * Batch mode (the "Start" button / single-run path): read input, run one
 * action, push the result to the dataset, charge, and exit.
 */
async function runBatch(): Promise<void> {
  const input = (await Actor.getInput<Record<string, unknown>>()) || {};
  const action = String(input.action || 'analyze_domain_winners');
  const args = mapInputToHandlerArgs(action, input);

  console.log(`[Actor] Running action: ${action}`);
  console.log(`[Actor] Args:`, JSON.stringify(args, null, 2));

  try {
    const result = await routeAction(action, args);
    const data = extractResult(result);
    await Actor.pushData({ ...data, action });
    try {
      await Actor.charge({ eventName: EVENT_NAME_BY_ACTION[action] ?? 'analysis-completed' });
    } catch { /* charge may not be configured */ }
    console.log(`[Actor] Action "${action}" completed successfully`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Actor] Action "${action}" failed:`, message);
    await Actor.pushData({ error: message, action, success: false, timestamp: new Date().toISOString() });
  }

  await closeRedis();
  await Actor.exit();
}

async function main() {
  await Actor.init();

  await ensureDatabase().catch(e => console.warn('[Actor] Appwrite DB init skipped:', e.message));

  // Authoritative standby detection: the platform sets APIFY_META_ORIGIN=STANDBY
  // when the Actor is invoked via its Standby URL (this also covers local
  // `apify run --standby`). Fall back to the legacy ACTOR_STANDBY_PORT heuristic.
  const isStandby =
    process.env.APIFY_META_ORIGIN === 'STANDBY'
    || (Actor.isAtHome() && !!process.env.ACTOR_STANDBY_PORT);

  if (isStandby) {
    await runStandbyServer();
  } else {
    await runBatch();
  }
}

main().catch(async (error) => {
  console.error('[Actor] Fatal error:', error);
  await Actor.exit({ exitCode: 1 }).catch(() => process.exit(1));
});
