/**
 * AdWinner Intel - Apify Service
 * 
 * Handles data ingestion from Facebook Ad Library and TikTok
 * via Apify actors.
 * 
 * COST EFFICIENCY STRATEGY:
 * - Facebook: curious_coder/facebook-ads-library-scraper (pay-per-result)
 *   - $0.75 per 1000 ads
 *   - 10 ads = ~$0.0075 per query -> strong margin at $0.10/query
 * - TikTok: apidojo/tiktok-scraper (pay-per-result)
 *   - $0.30 per 1000 results (16x cheaper than clockworks!)
 *   - Uses keyword search results as proxy for winning ads (no login required)
 * - Results are cached for 24h to avoid redundant scrapes
 * - For high-traffic domains, cache hit rate should be 80%+
 */

import { ApifyClient } from 'apify-client';
import {
  type AdEntity,
  type RawFacebookAd,
  type RawTikTokPost,
  type AdPlatform,
  type CreativeType,
  type ImpressionTier,
  type LongevityStatus,
  LONGEVITY_THRESHOLD_DAYS,
  IMPRESSION_TIERS,
} from '../types/index.js';

import { cacheCreativeInAppwrite } from './appwrite-service.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

// Token used for the downstream Facebook/TikTok scraper Actor calls. Prefer the
// dedicated SCRAPER_APIFY_TOKEN — this lets you bill scraping to a specific
// account (e.g. a separate plan), independent of the platform-injected
// APIFY_TOKEN. Falls back to APIFY_TOKEN (the auto-injected run token).
const APIFY_TOKEN = process.env.SCRAPER_APIFY_TOKEN || process.env.APIFY_TOKEN;
const ENABLE_LOCAL_DEBUG_INGEST = (process.env.LOCAL_DEBUG_INGEST || 'false').toLowerCase() === 'true';
const DEBUG_INGEST_URL = 'http://127.0.0.1:7242/ingest/021c6cac-9468-4b3d-a3a1-d3ca8f90d110';

if (!APIFY_TOKEN) {
  console.warn('[ApifyService] No SCRAPER_APIFY_TOKEN or APIFY_TOKEN set - scraping will fail');
}

const apifyClient = new ApifyClient({ token: APIFY_TOKEN });

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

/**
 * Apify actor IDs for ad/content scraping
 * 
 * Facebook: curious_coder/facebook-ads-library-scraper - pay-per-result, Meta Ad Library
 * TikTok: apidojo/tiktok-scraper - pay-per-result, $0.30/1K results
 */
const ACTORS = {
  FACEBOOK_AD_LIBRARY: 'curious_coder/facebook-ads-library-scraper',
  TIKTOK_SCRAPER: 'apidojo/tiktok-scraper',
} as const;

/**
 * Default limits to control costs and response times
 * Context Protocol requires < 30s response time
 */
const DEFAULTS = {
  MAX_ADS_PER_QUERY: 5,
  MAX_TIKTOK_POSTS: 10,
  // apidojo minimum is 10; 12 balances breadth with lower latency/cost
  TIKTOK_FETCH_POOL: 12,
  // Keep under Context grant's 30s execution constraint
  TIMEOUT_SECONDS: 20,
} as const;

// curious_coder actor pricing: $0.75 per 1000 ads
const FACEBOOK_AD_COST_PER_RESULT_USD = 0.00075;
// apidojo/tiktok-scraper: $0.30 per 1000 results = $0.0003/result
// 16x cheaper than clockworks ($5/1K). Min 10 posts per query = $0.003 floor.
const TIKTOK_POST_COST_PER_RESULT_USD = 0.0003;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Calculate the number of days since a given date
 */
function calculateActiveDays(startDateStr: string): number {
  const startDate = new Date(startDateStr);
  const now = new Date();
  const diffMs = now.getTime() - startDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
}

/**
 * Determine longevity status based on active days
 */
function getLongevityStatus(activeDays: number): LongevityStatus {
  return activeDays >= LONGEVITY_THRESHOLD_DAYS ? 'winner' : 'test';
}

/**
 * Map Facebook impression ranges to our tier system
 */
function getImpressionTier(lowerBound?: number, upperBound?: number): ImpressionTier {
  if (!lowerBound && !upperBound) return 'low';
  
  const midpoint = ((lowerBound || 0) + (upperBound || 0)) / 2;
  
  if (midpoint >= IMPRESSION_TIERS.viral.min) return 'viral';
  if (midpoint >= IMPRESSION_TIERS.high.min) return 'high';
  if (midpoint >= IMPRESSION_TIERS.medium.min) return 'medium';
  return 'low';
}

/**
 * Map TikTok play counts to impression tiers
 */
function getTikTokImpressionTier(playCount: number): ImpressionTier {
  if (playCount >= 1_000_000) return 'viral';
  if (playCount >= 100_000) return 'high';
  if (playCount >= 10_000) return 'medium';
  return 'low';
}

/**
 * Extract domain from a landing URL
 */
function extractDomain(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

function escapeRegexForDomainMatch(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function domainsMatchStrictly(candidateDomain: string | undefined, queryDomain: string): boolean {
  const normalizedQuery = normalizeDomain(queryDomain);
  const normalizedCandidate = normalizeDomain(candidateDomain || '');

  if (!normalizedQuery || !normalizedCandidate) return false;
  if (normalizedCandidate === normalizedQuery) return true;
  if (normalizedCandidate.endsWith(`.${normalizedQuery}`)) return true;

  // Support querying a subdomain while advertiser stores only the root domain.
  const candidateLabels = normalizedCandidate.split('.').filter(Boolean);
  if (candidateLabels.length >= 2 && normalizedQuery.endsWith(`.${normalizedCandidate}`)) return true;

  return false;
}

function urlMatchesDomain(url: string | undefined, queryDomain: string): boolean {
  if (!url) return false;
  const normalizedQuery = normalizeDomain(queryDomain);
  if (!normalizedQuery) return false;

  try {
    const parsed = new URL(url);
    return domainsMatchStrictly(parsed.hostname, normalizedQuery);
  } catch {
    // Fallback for malformed URLs from upstream: strict host-like token matching.
    const pattern = new RegExp(
      `(^|[^a-z0-9-])(?:[a-z0-9-]+\\.)*${escapeRegexForDomainMatch(normalizedQuery)}(?=[^a-z0-9-]|$)`,
      'i',
    );
    return pattern.test(url.toLowerCase());
  }
}

/**
 * Extract brand token from URL/domain/name input.
 *
 * Examples:
 * - "https://www.rappi.com.br" -> "rappi"
 * - "rappi.com" -> "rappi"
 * - "brand.co.uk" -> "brand"
 * - "Rappi" -> "rappi"
 */
export function extractBrandFromDomain(input: string): string {
  const cleaned = input.trim().toLowerCase();
  if (!cleaned) return '';

  const hasProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned);
  let host = cleaned;

  try {
    const parsed = new URL(hasProtocol ? cleaned : `https://${cleaned}`);
    host = parsed.hostname.toLowerCase();
  } catch {
    host = cleaned;
  }

  host = host
    .replace(/^www\d*\./, '')
    .split('/')[0]
    .split(':')[0];

  const labels = host.split('.').filter(Boolean);
  if (labels.length === 0) {
    return cleaned.replace(/[^a-z0-9]/g, '');
  }
  if (labels.length === 1) {
    return labels[0].replace(/[^a-z0-9]/g, '');
  }

  // Handle second-level ccTLDs like .co.uk, .com.br, .org.uk.
  const secondLevelTlds = new Set(['co', 'com', 'net', 'org', 'gov', 'edu']);
  let brandIndex = labels.length - 2;

  if (labels.length >= 3) {
    const tld = labels[labels.length - 1];
    const sld = labels[labels.length - 2];
    if (tld.length === 2 && secondLevelTlds.has(sld)) {
      brandIndex = labels.length - 3;
    }
  }

  const brand = labels[brandIndex] || labels[0];
  return brand.replace(/[^a-z0-9]/g, '');
}

function normalizeForFuzzyMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function fuzzyContainsBrand(text: string, brand: string): boolean {
  const normalizedText = normalizeForFuzzyMatch(text);
  const normalizedBrand = normalizeForFuzzyMatch(brand);
  if (!normalizedText || !normalizedBrand) return false;
  if (normalizedText.includes(normalizedBrand)) return true;
  return normalizedText.replace(/\s+/g, '').includes(normalizedBrand.replace(/\s+/g, ''));
}

/**
 * Check if a landing URL points to the target domain.
 * Handles subdomains (e.g., app.notion.so matches notion.so),
 * and common redirect domains (linktr.ee, bit.ly etc. are excluded).
 */
function landingUrlMatchesDomain(landingUrl: string | undefined, targetDomain: string): boolean {
  if (!landingUrl) return false;
  const extracted = extractDomain(landingUrl);
  if (!extracted) return false;

  const normalizedTarget = normalizeDomain(targetDomain);
  const normalizedLanding = extracted.toLowerCase();

  if (normalizedLanding === normalizedTarget) return true;
  if (normalizedLanding.endsWith(`.${normalizedTarget}`)) return true;

  const brand = extractBrandFromDomain(targetDomain);
  const landingBrand = extractBrandFromDomain(normalizedLanding);
  if (brand && landingBrand && landingBrand === brand) return true;

  return false;
}

/** Escape special regex characters in a string */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if a brand keyword appears in text as a product/brand reference (capitalized,
 * used as a proper noun) rather than as a common English word.
 *
 * Examples for brand "notion":
 *   "Notion is the best tool"        → true  (capitalized, product reference)
 *   "Check out @NotionHQ"            → true  (social handle reference)
 *   "notion.so/templates"            → true  (URL/domain reference)
 *   "#notion #productivity"          → true  (hashtag reference)
 *   "the notion that vulnerability"  → false (common English word, lowercase)
 */
function bodyTextReferencesBrand(bodyText: string, brandName: string, targetDomain: string): boolean {
  if (!bodyText || !brandName) return false;

  // 1. Domain/URL reference in body (e.g., "notion.so", "notion.com")
  const domainPattern = new RegExp(`${escapeRegex(brandName)}\\.[a-z]{2,}`, 'i');
  if (domainPattern.test(bodyText)) return true;

  // 2. Hashtag reference (e.g., #notion, #notiontemplate)
  const hashtagPattern = new RegExp(`#${escapeRegex(brandName)}`, 'i');
  if (hashtagPattern.test(bodyText)) return true;

  // 3. Social handle reference (e.g., @notion, @NotionHQ)
  const handlePattern = new RegExp(`@${escapeRegex(brandName)}`, 'i');
  if (handlePattern.test(bodyText)) return true;

  // 4. Capitalized brand name used as proper noun (product reference)
  const capitalizedBrand = brandName.charAt(0).toUpperCase() + brandName.slice(1);
  const properNounPattern = new RegExp(`\\b${escapeRegex(capitalizedBrand)}\\b`);
  const allCapsPattern = new RegExp(`\\b${escapeRegex(brandName.toUpperCase())}\\b`);
  if (properNounPattern.test(bodyText) || allCapsPattern.test(bodyText)) return true;

  // 5. CTA text referencing the domain (e.g., "Visit notion.so")
  const normalizedDomain = normalizeDomain(targetDomain);
  if (bodyText.toLowerCase().includes(normalizedDomain)) return true;

  return false;
}

/**
 * Determine the relevance tier of an ad for a given domain search.
 *
 * Tier 1 (HIGH):   Landing URL points to the target domain.
 * Tier 2 (MEDIUM): Advertiser name contains the brand OR body text references brand as product (UGC).
 * Tier 3 (LOW):    Only body text matches as common word → false positive, rejected.
 * Tier 0 (NONE):   No match at all.
 */
function getAdRelevanceTier(ad: AdEntity, brandName: string, targetDomain: string): 0 | 1 | 2 | 3 {
  if (landingUrlMatchesDomain(ad.creative?.landingUrl, targetDomain)) return 1;
  if (fuzzyContainsBrand(ad.advertiser.name || '', brandName)) return 2;

  const bodyText = ad.creative?.bodyText || '';
  if (bodyTextReferencesBrand(bodyText, brandName, targetDomain)) return 2;

  const bodyMatch = fuzzyContainsBrand(bodyText, brandName);
  const landingKeywordMatch = (ad.creative?.landingUrl || '').toLowerCase().includes(brandName);
  if (bodyMatch || landingKeywordMatch) return 3;

  return 0;
}

/**
 * Map Meta publisher platforms to our AdPlatform enum
 */
function mapMetaPlatform(publisherPlatforms?: string[]): AdPlatform {
  const platforms = (publisherPlatforms || []).map((platform) => platform.toUpperCase());
  if (platforms.includes('INSTAGRAM') && !platforms.includes('FACEBOOK')) {
    return 'instagram';
  }
  return 'facebook';
}

/**
 * Map Meta Ad Library impression index to actual impression ranges
 * Index mapping (based on Facebook Ad Library tiers):
 * -1: Unknown, 0: <1k, 1: 1k-5k, 2: 5k-10k, 3: 10k-50k, 4: 50k-100k, 5: 100k-500k, 6: 500k-1M, 7: >1M
 */
function mapImpressionIndex(index: number): { impressionsLower?: number; impressionsUpper?: number } {
  const ranges: Record<number, { lower: number; upper: number }> = {
    0: { lower: 0, upper: 1000 },
    1: { lower: 1000, upper: 5000 },
    2: { lower: 5000, upper: 10000 },
    3: { lower: 10000, upper: 50000 },
    4: { lower: 50000, upper: 100000 },
    5: { lower: 100000, upper: 500000 },
    6: { lower: 500000, upper: 1000000 },
    7: { lower: 1000000, upper: 10000000 },
  };
  
  if (index < 0 || !ranges[index]) {
    return { impressionsLower: undefined, impressionsUpper: undefined };
  }
  
  return { impressionsLower: ranges[index].lower, impressionsUpper: ranges[index].upper };
}

// =============================================================================
// FACEBOOK NORMALIZATION
// =============================================================================

/**
 * Normalize raw Facebook Ad Library response to AdEntity
 * 
 * @param raw - Raw response from Apify curious_coder/facebook-ads-library-scraper
 * @returns Normalized AdEntity
 */
/** Hard-code the creative URL into bodyText so the AI agent cannot lose it. */
function prependCreativeSource(bodyText: string | undefined, videoUrl: string | undefined, snapshotUrl: string | undefined): string {
  const url = videoUrl || snapshotUrl;
  if (!url) return bodyText || '';
  return '🔗 AD LINK (DO NOT HIDE): ' + url + ' \n\n ' + (bodyText || '');
}

export function normalizeFacebookAd(raw: RawFacebookAd): AdEntity {
  // Prioritize raw start_date from actor for longevity calculation.
  const startDate =
    (typeof raw.start_date === 'number' ? new Date(raw.start_date * 1000).toISOString() : raw.start_date)
    || raw.startDateFormatted
    || (typeof raw.startDate === 'number' ? new Date(raw.startDate * 1000).toISOString() : undefined)
    || raw.ad_delivery_start_time
    || new Date().toISOString();

  const endDate = raw.endDateFormatted
    || (typeof raw.endDate === 'number' ? new Date(raw.endDate * 1000).toISOString() : undefined)
    || raw.ad_delivery_stop_time
    || (typeof raw.end_date === 'number' ? new Date(raw.end_date * 1000).toISOString() : raw.end_date)
    || null;

  const activeDays = calculateActiveDays(startDate);

  // Extract impression data (index-based or range-based)
  const impressionsIndex = raw.impressionsWithIndex?.impressionsIndex
    ?? raw.impressions_with_index?.impressions_index
    ?? -1;
  const impressionsFromIndex = impressionsIndex >= 0 ? mapImpressionIndex(impressionsIndex) : {
    impressionsLower: undefined,
    impressionsUpper: undefined,
  };
  const impressionsLowerParsed = raw.impressions?.lower_bound ? Number(raw.impressions.lower_bound) : undefined;
  const impressionsUpperParsed = raw.impressions?.upper_bound ? Number(raw.impressions.upper_bound) : undefined;
  const impressionsLower = impressionsFromIndex.impressionsLower ?? impressionsLowerParsed;
  const impressionsUpper = impressionsFromIndex.impressionsUpper ?? impressionsUpperParsed;

  // Extract creative assets from snapshot
  const snapshot = raw.snapshot;
  const cardWithImage = snapshot?.cards?.find(
    (card) =>
      card.originalImageUrl ||
      card.resizedImageUrl ||
      card.original_image_url ||
      card.resized_image_url
  );
  const cardWithVideo = snapshot?.cards?.find(
    (card) =>
      card.videoHdUrl ||
      card.videoSdUrl ||
      card.video_hd_url ||
      card.video_sd_url
  );

  const imageUrl =
    snapshot?.images?.[0]?.originalImageUrl
    || snapshot?.images?.[0]?.resizedImageUrl
    || snapshot?.images?.[0]?.original_image_url
    || snapshot?.images?.[0]?.resized_image_url
    || cardWithImage?.originalImageUrl
    || cardWithImage?.resizedImageUrl
    || cardWithImage?.original_image_url
    || cardWithImage?.resized_image_url
    || raw.ad_snapshot_url
    || '';

  const videoUrl =
    snapshot?.videos?.[0]?.videoHdUrl
    || snapshot?.videos?.[0]?.videoSdUrl
    || snapshot?.videos?.[0]?.video_hd_url
    || snapshot?.videos?.[0]?.video_sd_url
    || cardWithVideo?.videoHdUrl
    || cardWithVideo?.videoSdUrl
    || cardWithVideo?.video_hd_url
    || cardWithVideo?.video_sd_url;

  const displayFormat = (snapshot?.displayFormat || snapshot?.display_format || '').toUpperCase();

  // Determine creative type
  let creativeType: CreativeType = 'image';
  if (videoUrl || displayFormat.includes('VIDEO')) {
    creativeType = 'video';
  } else if ((snapshot?.cards && snapshot.cards.length > 1) || displayFormat.includes('CAROUSEL') || displayFormat === 'DCO') {
    creativeType = 'carousel';
  }

  // Extract landing URL
  const landingUrl =
    snapshot?.linkUrl
    || snapshot?.link_url
    || cardWithImage?.linkUrl
    || cardWithImage?.link_url
    || raw.ad_creative_link_captions?.[0];

  const adArchiveId =
    raw.ad_archive_id
    || raw.adArchiveId
    || raw.adArchiveID
    || raw.adId
    || raw.ad_id
    || raw.id;

  const platform = mapMetaPlatform(raw.publisherPlatform || raw.publisher_platform);

  return {
    adId: `fb_${adArchiveId ? String(adArchiveId) : `unknown_${Date.now()}`}`,
    platform,

    advertiser: (() => {
      const rawName = snapshot?.pageName
        || snapshot?.page_name
        || raw.pageName
        || raw.page_name
        || raw.pageInfo?.page?.name
        || 'Unknown';
      return {
        name: rawName.replace(/\s*\(https?:\/\/[^)]+\)\s*/g, '').trim() || rawName,
        id:
          snapshot?.pageId
          || snapshot?.page_id
          || raw.pageId
          || raw.pageID
          || raw.page_id
          || raw.pageInfo?.page?.id
          || 'unknown',
        domain: extractDomain(landingUrl),
      };
    })(),

    creative: {
      REQUIRED_LINK_FOR_USER: adArchiveId
        ? `https://www.facebook.com/ads/library/?id=${adArchiveId}`
        : imageUrl,
      MANDATORY_VISUAL_PROOF_URL: videoUrl || imageUrl,
      type: creativeType,
      bodyText: prependCreativeSource(
        snapshot?.body?.text || raw.ad_creative_bodies?.join(' ') || undefined,
        videoUrl,
        imageUrl,
      ),
      ctaText: snapshot?.ctaText || snapshot?.cta_text || raw.ad_creative_link_titles?.[0] || undefined,
      landingUrl,
    },

    timing: {
      startDate,
      endDate,
      activeDays,
      longevityStatus: getLongevityStatus(activeDays),
    },

    performance: {
      impressionTier: getImpressionTier(impressionsLower, impressionsUpper),
      impressionsLower,
      impressionsUpper,
    },

    targeting: (raw.targetedOrReachedCountries || raw.targeted_or_reached_countries)?.length ? {
      countries: raw.targetedOrReachedCountries || raw.targeted_or_reached_countries,
    } : undefined,

    intelligence: undefined,

    meta: {
      fetchedAt: new Date().toISOString(),
      adLibraryUrl: adArchiveId ? `https://www.facebook.com/ads/library/?id=${adArchiveId}` : '',
      source: 'facebook',
    },
  };
}

// =============================================================================
// TIKTOK NORMALIZATION (apidojo/tiktok-scraper)
// =============================================================================

/**
 * Normalize raw TikTok post from apidojo/tiktok-scraper to AdEntity
 *
 * Handles both apidojo format (title, views, likes, channel.*) and
 * clockworks format (text, playCount, diggCount, authorMeta.*) for
 * backwards compatibility with cached data.
 *
 * @param raw - Raw response from Apify TikTok scraper
 * @returns Normalized AdEntity
 */
export function normalizeTikTokPost(raw: RawTikTokPost): AdEntity {
  const record = raw as Record<string, unknown>;

  const getValue = <T>(path: string): T | undefined => {
    if (Object.prototype.hasOwnProperty.call(record, path)) {
      return record[path] as T;
    }
    const segments = path.split('.');
    let current: unknown = record;
    for (const segment of segments) {
      if (!current || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current as T | undefined;
  };

  const toNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value.replace(/,/g, ''));
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  };

  const toBoolean = (value: unknown): boolean | undefined => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return undefined;
  };

  const id = getValue<string>('id') || getValue<string>('itemId') || `unknown_${Date.now()}`;
  // apidojo uses 'title', clockworks uses 'text'/'desc'
  const text = getValue<string>('title') || getValue<string>('text') || getValue<string>('desc') || '';

  // apidojo: uploadedAtFormatted / uploadedAt; clockworks: createTimeISO / createTime
  const createTimeISO = getValue<string>('uploadedAtFormatted') || getValue<string>('createTimeISO');
  const createTime = toNumber(getValue<number>('uploadedAt')) ?? toNumber(getValue<number>('createTime')) ?? toNumber(getValue<number>('timestamp'));
  const startDate = createTimeISO
    || (createTime ? new Date(createTime > 1_000_000_000_000 ? createTime : createTime * 1000).toISOString() : undefined)
    || new Date().toISOString();

  const activeDays = calculateActiveDays(startDate);

  // apidojo: channel.name/username; clockworks: authorMeta.name/nickName
  const authorName =
    getValue<string>('channel.username')
    || getValue<string>('channel.name')
    || getValue<string>('authorMeta.name')
    || getValue<string>('authorMeta.nickName')
    || getValue<string>('authorMeta.nickname')
    || getValue<string>('author.name')
    || getValue<string>('author.nickname')
    || getValue<string>('author.uniqueId')
    || 'Unknown';

  const authorId =
    getValue<string>('channel.id')
    || getValue<string>('authorMeta.id')
    || getValue<string>('authorMeta.authorId')
    || getValue<string>('author.id')
    || getValue<string>('author.uniqueId')
    || authorName
    || 'unknown';

  // apidojo: postPage; clockworks: webVideoUrl
  const webVideoUrl =
    getValue<string>('postPage')
    || getValue<string>('webVideoUrl')
    || getValue<string>('videoUrl')
    || getValue<string>('url');

  // apidojo: video.url; clockworks: videoMeta.downloadAddr etc
  const videoUrl =
    getValue<string>('video.url')
    || getValue<string>('downloadedVideoUrl')
    || getValue<string>('videoMeta.downloadAddr')
    || getValue<string>('videoMeta.playAddr')
    || getValue<string>('videoMeta.videoUrl')
    || getValue<string>('videoMeta.downloadUrl')
    || getValue<string>('videoUrl')
    || webVideoUrl;

  // apidojo: video.cover/video.thumbnail; clockworks: videoMeta.coverUrl
  const snapshotUrl =
    getValue<string>('video.cover')
    || getValue<string>('video.thumbnail')
    || getValue<string>('videoMeta.coverUrl')
    || getValue<string>('videoMeta.originalCoverUrl')
    || getValue<string>('videoMeta.cover')
    || getValue<string>('thumbnailUrl')
    || getValue<string>('channel.avatar')
    || getValue<string>('authorMeta.avatar')
    || '';

  // apidojo uses flat names: views/likes/comments/shares/bookmarks
  // clockworks uses: playCount/diggCount/commentCount/shareCount/collectCount
  const playCount = toNumber(getValue<number>('views')) ?? toNumber(getValue<number>('playCount')) ?? toNumber(getValue<number>('stats.playCount')) ?? 0;
  const diggCount = toNumber(getValue<number>('likes')) ?? toNumber(getValue<number>('diggCount')) ?? toNumber(getValue<number>('stats.diggCount')) ?? 0;
  const shareCount = toNumber(getValue<number>('shares')) ?? toNumber(getValue<number>('shareCount')) ?? toNumber(getValue<number>('stats.shareCount')) ?? 0;
  const commentCount = toNumber(getValue<number>('comments')) ?? toNumber(getValue<number>('commentCount')) ?? toNumber(getValue<number>('stats.commentCount')) ?? 0;
  const collectCount = toNumber(getValue<number>('bookmarks')) ?? toNumber(getValue<number>('collectCount')) ?? toNumber(getValue<number>('stats.collectCount')) ?? 0;

  // apidojo doesn't provide isAd/isSponsored — detect commercial intent via text patterns
  const bodyLower = (text || '').toLowerCase();
  const highIntent =
    /\bad\b|\bsponsored\b|\bpartnership\b|\bcollaboration\b|\bgifted\b/i.test(bodyLower)
    || /discount|code|link in bio|shop now|use my code|affiliate/i.test(bodyLower)
    || /#ad\b|#sponsored\b|#partner\b/i.test(bodyLower);

  const hashtagsFromList = (() => {
    const rawHashtags = getValue<unknown>('hashtags') || getValue<unknown>('challenges');
    if (!Array.isArray(rawHashtags)) return [];
    return rawHashtags
      .map((tag) => {
        if (typeof tag === 'string') return tag.replace(/^#/, '');
        if (tag && typeof tag === 'object') {
          const tagRecord = tag as Record<string, unknown>;
          return (tagRecord.name as string) || (tagRecord.title as string);
        }
        return undefined;
      })
      .filter((tag): tag is string => Boolean(tag));
  })();

  const hashtagsFromText = Array.from(text.matchAll(/#([\p{L}\p{N}_-]+)/gu)).map((match) => match[1]);
  const hashtags = Array.from(new Set([...hashtagsFromList, ...hashtagsFromText]));

  return {
    adId: `tt_${id}`,
    platform: 'tiktok' as AdPlatform,

    advertiser: {
      name: authorName,
      id: authorId,
      domain: undefined, // TikTok posts don't have landing pages
    },

    creative: {
      REQUIRED_LINK_FOR_USER: snapshotUrl,
      MANDATORY_VISUAL_PROOF_URL: videoUrl || undefined,
      type: 'video' as CreativeType, // TikTok is always video
      bodyText: prependCreativeSource(text || undefined, videoUrl, snapshotUrl),
      ctaText: undefined,
      landingUrl: webVideoUrl || undefined,
    },

    timing: {
      startDate,
      endDate: null, // Posts don't have end dates
      activeDays,
      longevityStatus: getLongevityStatus(activeDays),
    },

    performance: {
      likes: diggCount,
      views: playCount,
      shares: shareCount,
      comments: commentCount,
      bookmarks: collectCount,
      impressionTier: getTikTokImpressionTier(playCount),
      // Store additional metrics for analysis
      impressionsLower: playCount,
      impressionsUpper: playCount,
    },

    targeting: undefined, // TikTok search doesn't provide targeting info

    intelligence: {
      globalWinner: false,
      engagementRate: playCount > 0
        ? ((diggCount + shareCount + commentCount) / playCount) * 100
        : 0,
      hashtags,
      highIntent,
    },

    meta: {
      fetchedAt: new Date().toISOString(),
      adLibraryUrl: webVideoUrl || videoUrl || '',
      source: 'tiktok',
    },
  };
}

// =============================================================================
// APIFY ACTOR EXECUTION - FACEBOOK
// =============================================================================

export interface FetchFacebookAdsOptions {
  domain: string;
  country?: string;
  limit?: number;
  activeOnly?: boolean;
}

/**
 * Build Meta Ad Library keyword search URL (fallback).
 */
function buildFacebookAdLibraryKeywordUrl(brandName: string, country?: string): string {
  const resolvedCountry = (country || 'ALL').toUpperCase();
  const encodedBrandName = encodeURIComponent(brandName);
  return `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${resolvedCountry}&q=${encodedBrandName}&search_type=keyword_unordered&media_type=all`;
}

/**
 * Build Meta Ad Library page-specific URL using view_all_page_id.
 * Returns ONLY ads from the specified page — zero false positives.
 */
function buildFacebookAdLibraryPageUrl(pageId: string, country?: string): string {
  const resolvedCountry = (country || 'ALL').toUpperCase();
  return `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${resolvedCountry}&view_all_page_id=${pageId}&search_type=page&media_type=all`;
}

/**
 * Try to resolve a Facebook Page ID from a brand/domain search.
 *
 * Does a lightweight keyword probe (5 results) and looks for ads whose
 * landing URL or advertiser name matches the target domain (Tier 1/2).
 * If found, returns the page ID. Otherwise returns null.
 */
async function resolvePageIdFromDomain(
  domain: string,
  brandName: string,
  country: string,
  timeout: number
): Promise<string | null> {
  console.log(`[ApifyService] 🔍 Attempting to resolve Facebook Page ID for "${domain}"...`);

  const searchUrl = buildFacebookAdLibraryKeywordUrl(brandName, country);

  try {
    const run = await apifyClient.actor(ACTORS.FACEBOOK_AD_LIBRARY).call(
      {
        urls: [{ url: searchUrl }],
        count: 5,
        scrapeAdDetails: false,
        'scrapePageAds.activeStatus': 'active',
        'scrapePageAds.countryCode': country,
      },
      { timeout }
    );

    const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
    console.log(`[ApifyService] Page ID probe returned ${items.length} items for "${brandName}"`);

    if (items.length === 0) return null;

    for (const item of items) {
      try {
        const ad = normalizeFacebookAd(item as unknown as RawFacebookAd);
        if (!ad) continue;

        const tier = getAdRelevanceTier(ad, brandName, domain);
        if (tier >= 1 && tier <= 2) {
          const pageId = ad.advertiser.id;
          if (pageId && pageId !== 'unknown') {
            console.log(
              `[ApifyService] ✅ Resolved Page ID: ${pageId} (page: "${ad.advertiser.name}", tier=${tier})`
            );
            return pageId;
          }
        }
      } catch {
        continue;
      }
    }

    console.log(`[ApifyService] ⚠️ No confident page ID match found for "${domain}"`);
    return null;
  } catch (error) {
    console.warn(`[ApifyService] Page ID resolution failed for "${domain}":`, error);
    return null;
  }
}

/**
 * Normalize, dedupe and sort raw Apify items into AdEntity[].
 * Shared by both page-based and keyword-based fetch paths.
 */
function normalizeAndDedupeAds(items: unknown[], seenIds: Set<string>): AdEntity[] {
  if (items.length > 0) {
    const sample = items[0] as Record<string, unknown>;
    const hasSnapshot = Boolean(sample.snapshot || sample.ad_snapshot_url);
    const hasId = Boolean(sample.ad_archive_id || sample.adArchiveId || sample.id);
    if (!hasSnapshot && !hasId) {
      console.warn(
        `[ApifyService] ⚠️ EMPTY DATA WARNING: Apify returned ${items.length} Facebook items but first item has no snapshot or ad_archive_id. ` +
        `Sample keys: [${Object.keys(sample).slice(0, 10).join(', ')}]`
      );
    }
  }

  return items
    .map((item) => {
      try {
        return normalizeFacebookAd(item as unknown as RawFacebookAd);
      } catch (e) {
        console.warn(`[ApifyService] Failed to normalize Facebook ad:`, e);
        return null;
      }
    })
    .filter(
      (ad): ad is AdEntity =>
        ad !== null &&
        Boolean(ad.timing.startDate) &&
        ad.advertiser.id !== 'unknown'
    )
    .filter((ad) => {
      if (seenIds.has(ad.adId)) return false;
      seenIds.add(ad.adId);
      return true;
    })
    .sort((a, b) => b.timing.activeDays - a.timing.activeDays);
}

/**
 * Cache selected Facebook creatives in Appwrite (non-blocking).
 * Facebook Ad Library CDN URLs expire in minutes; this preserves them.
 */
function cacheCreativesInBackground(ads: AdEntity[]): void {
  if (ads.length === 0) return;
  Promise.allSettled(
    ads.map(async (ad) => {
      const sourceUrl = ad.creative.MANDATORY_VISUAL_PROOF_URL;
      if (!sourceUrl) return;
      const cached = await cacheCreativeInAppwrite(sourceUrl, ad.adId, 'facebook');
      if (cached) {
        ad.creative.MANDATORY_VISUAL_PROOF_URL = cached.url;
        ad.meta = { ...ad.meta, appwriteFileId: cached.fileId };
      }
    })
  ).then(results => {
    const cachedCount = results.filter(r => r.status === 'fulfilled').length;
    console.log(`[ApifyService] Cached ${cachedCount}/${ads.length} Facebook creatives in Appwrite`);
  }).catch(() => {});
}

/**
 * Fetch ads from Facebook Ad Library for a specific domain.
 *
 * STRATEGY (two-phase with fallback):
 *   Phase 1 — Page ID resolution: small keyword probe (5 results) to find the
 *             advertiser's Facebook Page ID via Tier 1/2 relevance match.
 *   Phase 2A — If page ID found: fetch ads using view_all_page_id (zero false positives).
 *   Phase 2B — If not found: keyword search + tiered relevance filter (fallback).
 *
 * COST: $0.75 per 1000 ads (pay-per-result)
 * - Phase 1 probe: ~$0.004  |  Phase 2: ~$0.008-$0.011  |  Total: ~$0.015
 */
export async function fetchFacebookAds(
  options: FetchFacebookAdsOptions
): Promise<AdEntity[]> {
  const { domain, country, limit = DEFAULTS.MAX_ADS_PER_QUERY } = options;
  const resolvedCountry = (country || 'ALL').toUpperCase();
  const resolvedLimit = Math.min(DEFAULTS.MAX_ADS_PER_QUERY, Math.max(1, limit));
  const actorCount = Math.max(10, resolvedLimit);
  const brandName = extractBrandFromDomain(domain) || domain.trim().toLowerCase();
  const seenIds = new Set<string>();

  console.log(`[ApifyService] Fetching Facebook ads for domain: ${domain}`);

  try {
    // ═══════════════════════════════════════════════════════════════════
    // PHASE 1: Resolve Page ID (small probe)
    // ═══════════════════════════════════════════════════════════════════
    const pageId = await resolvePageIdFromDomain(
      domain, brandName, resolvedCountry, DEFAULTS.TIMEOUT_SECONDS
    );

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 2A: Page ID found → fetch ads directly from advertiser's page
    // ═══════════════════════════════════════════════════════════════════
    if (pageId) {
      console.log(
        `[ApifyService] 🎯 Using Page ID ${pageId} for "${domain}" — zero false positives`
      );

      const pageUrl = buildFacebookAdLibraryPageUrl(pageId, resolvedCountry);
      const run = await apifyClient.actor(ACTORS.FACEBOOK_AD_LIBRARY).call(
        {
          urls: [{ url: pageUrl }],
          count: actorCount,
          scrapeAdDetails: false,
          'scrapePageAds.activeStatus': 'active',
          'scrapePageAds.countryCode': resolvedCountry,
        },
        { timeout: DEFAULTS.TIMEOUT_SECONDS }
      );

      const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
      console.log(
        `[ApifyService] Page-based fetch returned ${items.length} ads for page ${pageId} (cost: ~$${(items.length * FACEBOOK_AD_COST_PER_RESULT_USD).toFixed(4)})`
      );

      const normalizedAds = normalizeAndDedupeAds(items, seenIds);
      const selectedAds = normalizedAds.slice(0, resolvedLimit);

      sendLocalDebugIngest('apify-service.ts:fetchFacebookAds', 'FB ads via Page ID', {
        domain, brandName, pageId, totalRaw: items.length, selected: selectedAds.length,
        selectedNames: selectedAds.map((a) => a.advertiser.name),
      }, 'C');

      cacheCreativesInBackground(selectedAds);

      console.log(`[ApifyService] ✅ Returning ${selectedAds.length} ads via page ID for "${domain}"`);
      return selectedAds;
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 2B: No Page ID → keyword search + tiered relevance filter
    // ═══════════════════════════════════════════════════════════════════
    console.log(
      `[ApifyService] ⚡ Fallback: keyword search for "${brandName}" + tiered relevance filter`
    );

    const keywordUrl = buildFacebookAdLibraryKeywordUrl(brandName, resolvedCountry);
    const run = await apifyClient.actor(ACTORS.FACEBOOK_AD_LIBRARY).call(
      {
        urls: [{ url: keywordUrl }],
        count: actorCount,
        scrapeAdDetails: false,
        'scrapePageAds.activeStatus': 'active',
        'scrapePageAds.countryCode': resolvedCountry,
      },
      { timeout: DEFAULTS.TIMEOUT_SECONDS }
    );

    const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
    console.log(
      `[ApifyService] Keyword fallback returned ${items.length} ads for "${brandName}" (cost: ~$${(items.length * FACEBOOK_AD_COST_PER_RESULT_USD).toFixed(4)})`
    );

    const normalizedAds = normalizeAndDedupeAds(items, seenIds)
      .filter((ad) => {
        const tier = getAdRelevanceTier(ad, brandName, domain);
        console.log(
          `[Relevance] ad ${ad.adId}: Page "${ad.advertiser.name || ''}" | Landing "${ad.creative?.landingUrl || ''}" | Brand "${brandName}" | Domain "${domain}" => tier=${tier} ${tier <= 2 ? '✓ ACCEPTED' : '✗ REJECTED'}`
        );
        return tier >= 1 && tier <= 2;
      });

    const selectedAds = normalizedAds.slice(0, resolvedLimit);

    console.log(
      `[ApifyService] Relevance filter kept ${selectedAds.length}/${items.length} ads for brand "${brandName}"`
    );

    sendLocalDebugIngest('apify-service.ts:fetchFacebookAds', 'FB ads after tier filter', {
      domain, brandName, totalRaw: items.length, afterFilter: normalizedAds.length,
      selected: selectedAds.length,
      selectedNames: selectedAds.map((a) => a.advertiser.name),
      selectedDomains: selectedAds.map((a) => a.advertiser.domain),
    }, 'C');

    cacheCreativesInBackground(selectedAds);

    return selectedAds;
  } catch (error) {
    console.error(`[ApifyService] Error fetching Facebook ads:`, error);
    return [];
  }
}

/**
 * Score a TikTok post by commercial intent signals.
 * Higher score = more likely to be an actual ad or sponsored content.
 */
function commercialIntentScore(ad: AdEntity): number {
  let score = 0;

  // Text-based commercial signals (primary detection method)
  const body = (ad.creative.bodyText || '').toLowerCase();
  if (/\bad\b|\bsponsored\b|\bpartnership\b|\bcollaboration\b|\bgifted\b/.test(body)) score += 30;
  if (/#ad\b|#sponsored\b|#partner\b/.test(body)) score += 25;
  if (/discount|code|link in bio|shop now|use my code|affiliate/i.test(body)) score += 20;
  if (/@[\w.]+/.test(body)) score += 10; // Mentions brands with @

  // Engagement signals (high engagement = content resonates commercially)
  const engRate = ad.intelligence?.engagementRate || 0;
  if (engRate > 10) score += 15;
  else if (engRate > 5) score += 10;
  else if (engRate > 2) score += 5;

  // View count (reach matters for commercial content)
  const views = ad.performance?.views || ad.performance?.impressionsLower || 0;
  if (views > 500000) score += 15;
  else if (views > 100000) score += 10;
  else if (views > 50000) score += 5;

  // Longevity (longer = more likely commercial)
  if (ad.timing.activeDays >= 14) score += 10;
  else if (ad.timing.activeDays >= 7) score += 5;

  return score;
}

/**
 * Rank TikTok results by commercial intent, returning top N.
 * Ads and sponsored posts float to the top.
 */
export function rankByCommercialIntent(ads: AdEntity[], limit: number): AdEntity[] {
  return [...ads]
    .sort((a, b) => commercialIntentScore(b) - commercialIntentScore(a))
    .slice(0, limit);
}

/**
 * Filter ads by domain relevance using tiered validation.
 * Accepts Tier 1 (landing URL match) and Tier 2 (advertiser name / UGC brand reference).
 * Rejects Tier 3 (body text only — common word false positives).
 */
export function filterByDomainRelevance(ads: AdEntity[], targetDomain: string): AdEntity[] {
  const brandName = extractBrandFromDomain(targetDomain) || targetDomain.trim().toLowerCase();
  return ads.filter((ad) => {
    const tier = getAdRelevanceTier(ad, brandName, targetDomain);
    if (tier >= 1 && tier <= 2) return true;
    console.log(
      `[Relevance] Rejected ${ad.platform} ad ${ad.adId}: "${ad.advertiser.name}" tier=${tier} (body-only or no match for "${targetDomain}")`
    );
    return false;
  });
}

// =============================================================================
// APIFY ACTOR EXECUTION - TIKTOK
// =============================================================================

export interface FetchTikTokAdsOptions {
  keyword: string;
  region?: string;
  period?: '7' | '30' | '180';
}

/**
 * Fetch TikTok posts as proxy for "winning ads"
 *
 * Since TikTok Creative Center requires authentication, we use keyword
 * search results from apidojo/tiktok-scraper. High engagement posts
 * indicate content that resonates with audiences.
 *
 * COST: $0.30 per 1000 results (pay-per-result via apidojo/tiktok-scraper)
 * - Fetches 15 posts per query (~$0.0045) - all are persisted to DB
 * - Callers rank by commercial intent and return top N to the user
 * - 16x cheaper than previous clockworks scraper ($5/1K)
 *
 * @param options - Query parameters
 * @returns ALL normalized AdEntity objects (callers decide how many to show)
 */
export async function fetchTikTokAds(
  options: FetchTikTokAdsOptions
): Promise<AdEntity[]> {
  const { keyword, period, region } = options;
  const fetchCount = DEFAULTS.TIKTOK_FETCH_POOL;
  const location = region ? region.toUpperCase() : undefined;
  // Map period (days) to apidojo dateRange: '7' -> THIS_WEEK, '30' -> THIS_MONTH, '180' -> LAST_SIX_MONTHS
  const dateRange = period
    ? (period === '7' ? 'THIS_WEEK' : period === '30' ? 'THIS_MONTH' : 'LAST_SIX_MONTHS')
    : 'DEFAULT';

  console.log(`[ApifyService] Fetching TikTok posts for keyword: "${keyword}" (pool: ${fetchCount})`);

  try {
    // Run the apidojo/tiktok-scraper actor (pay-per-result, $0.30/1K)
    const run = await apifyClient.actor(ACTORS.TIKTOK_SCRAPER).call(
      {
        // apidojo/tiktok-scraper input schema
        keywords: [keyword],
        maxItems: fetchCount,
        dateRange,
        ...(location ? { location } : {}),
        sortType: 'MOST_LIKED', // Best for finding high-performing/winning content
        includeSearchKeywords: true, // Tags each result with the keyword that found it
      },
      {
        timeout: DEFAULTS.TIMEOUT_SECONDS,
        memory: 512,
      }
    );

    // Fetch results from the dataset
    const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
    
    console.log(`[ApifyService] Found ${items.length} TikTok posts for "${keyword}" (cost: ~$${(items.length * TIKTOK_POST_COST_PER_RESULT_USD).toFixed(4)})`);

    // ── Empty/placeholder data detection ──
    // If Apify returns items but they have zero engagement, the scraper likely
    // got blocked or returned stub data. Log a clear warning.
    if (items.length > 0) {
      const sample = items[0] as Record<string, unknown>;
      const hasRealData = Boolean(
        sample.title || sample.text || sample.desc
        || (sample.views && Number(sample.views) > 0)
        || (sample.likes && Number(sample.likes) > 0)
        || sample.channel || sample.authorMeta
      );
      if (!hasRealData) {
        console.warn(
          `[ApifyService] ⚠️ EMPTY DATA WARNING: Apify returned ${items.length} TikTok items for "${keyword}" but first item has no title/views/likes. ` +
          `The scraper may be rate-limited or blocked by TikTok. Sample keys: [${Object.keys(sample).slice(0, 10).join(', ')}]`
        );
        // Log first item for debugging
        console.warn(`[ApifyService] Sample item: ${JSON.stringify(sample).slice(0, 500)}`);
      }
    }

    // Normalize each post to our unified format
    const normalizedAds = items
      .map((item) => {
        try {
          return normalizeTikTokPost(item as unknown as RawTikTokPost);
        } catch (e) {
          console.warn(`[ApifyService] Failed to normalize TikTok post:`, e);
          return null;
        }
      })
      .filter((ad): ad is AdEntity => ad !== null);

    // ── Ghost data detection: all ads normalized but with zero engagement ──
    const ghostAds = normalizedAds.filter(
      (ad) => ad.advertiser.name === 'Unknown' && ad.performance?.views === 0 && ad.performance?.likes === 0
    );
    if (ghostAds.length > 0 && ghostAds.length === normalizedAds.length) {
      console.warn(
        `[ApifyService] ⚠️ GHOST DATA: All ${normalizedAds.length} normalized TikTok ads for "${keyword}" are placeholders ` +
        `(Unknown advertiser, 0 views, 0 likes). Apify scraper likely returned empty stubs.`
      );
    }

    // Return ALL results — callers handle ranking/slicing for response
    // and persist all to DB for scalable intelligence
    console.log(`[ApifyService] Normalized ${normalizedAds.length} TikTok posts for "${keyword}"`);

    return normalizedAds;
  } catch (error) {
    console.error(`[ApifyService] Error fetching TikTok posts:`, error);
    // Return empty array instead of crashing
    return [];
  }
}

// =============================================================================
// CROSS-PLATFORM INTELLIGENCE
// =============================================================================

/**
 * Normalize a brand name for fuzzy matching
 * - Lowercase, remove accents, remove spaces/punctuation
 * - Returns clean alphanumeric string
 */
function normalizeBrandForMatching(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove accents
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ''); // Keep only alphanumeric
}

/**
 * Check if two brand names are a fuzzy match
 * - Exact match after normalization
 * - One contains the other (min 4 chars)
 * - First 4 characters match
 */
function isFuzzyBrandMatch(name1: string, name2: string): boolean {
  const n1 = normalizeBrandForMatching(name1);
  const n2 = normalizeBrandForMatching(name2);
  
  if (!n1 || !n2 || n1.length < 3 || n2.length < 3) return false;
  
  // Exact match
  if (n1 === n2) return true;
  
  // One contains the other (minimum 4 chars to avoid false positives)
  if (n1.length >= 4 && n2.includes(n1)) return true;
  if (n2.length >= 4 && n1.includes(n2)) return true;
  
  // First 4 characters match
  if (n1.length >= 4 && n2.length >= 4 && n1.slice(0, 4) === n2.slice(0, 4)) return true;
  
  return false;
}

/**
 * Check if an advertiser has content on multiple platforms
 * This enables the "Global Winner" flag for high-confidence signals
 * 
 * Uses fuzzy matching to detect same brand across platforms:
 * - 'iFood' (FB) matches 'ifoodsuk' (TikTok)
 * - 'Glossier' (FB) matches 'glossierbeauty' (TikTok)
 * 
 * @param fbAds - Facebook ads for a domain
 * @param ttAds - TikTok posts (keyword matched)
 * @returns Updated ads with intelligence.globalWinner flag
 */
export function detectGlobalWinners(
  fbAds: AdEntity[],
  ttAds: AdEntity[]
): { facebookAds: AdEntity[]; tiktokAds: AdEntity[] } {
  // Extract advertiser names from both platforms
  const fbAdvertiserNames = fbAds
    .map((ad) => ad.advertiser.name)
    .filter((name): name is string => Boolean(name));
  const ttAdvertiserNames = ttAds
    .map((ad) => ad.advertiser.name)
    .filter((name): name is string => Boolean(name));

  // Find fuzzy matches between platforms
  const globalWinnerFbNames = new Set<string>();
  const globalWinnerTtNames = new Set<string>();

  for (const fbName of fbAdvertiserNames) {
    for (const ttName of ttAdvertiserNames) {
      if (isFuzzyBrandMatch(fbName, ttName)) {
        globalWinnerFbNames.add(fbName.toLowerCase());
        globalWinnerTtNames.add(ttName.toLowerCase());
        console.log(`[ApifyService] Global Winner match: "${fbName}" (FB) <-> "${ttName}" (TT)`);
      }
    }
  }

  const totalMatches = globalWinnerFbNames.size + globalWinnerTtNames.size;
  console.log(`[ApifyService] Detected ${totalMatches > 0 ? totalMatches / 2 : 0} Global Winner(s) across platforms`);

  // Update ads with Global Winner flag
  const updatedFbAds = fbAds.map((ad) => ({
    ...ad,
    intelligence: {
      ...ad.intelligence,
      globalWinner: ad.advertiser.name
        ? globalWinnerFbNames.has(ad.advertiser.name.toLowerCase())
        : false,
    },
  }));

  const updatedTtAds = ttAds.map((ad) => ({
    ...ad,
    intelligence: {
      ...ad.intelligence,
      globalWinner: ad.advertiser.name
        ? globalWinnerTtNames.has(ad.advertiser.name.toLowerCase())
        : false,
    },
  }));

  return { facebookAds: updatedFbAds, tiktokAds: updatedTtAds };
}

// =============================================================================
// PROFITABILITY SCORING
// =============================================================================

/**
 * Calculate profitability score for an ad (0-100)
 * 
 * Scoring weights:
 * - Longevity (40%): More days running = higher score
 * - Impressions/Engagement (35%): Higher reach = higher score
 * - Platform Diversity (25%): Running on multiple platforms = bonus
 */
export function calculateProfitabilityScore(ad: AdEntity): number {
  // Longevity score (max 40 points)
  // 14 days = 20 points, 30 days = 30 points, 60+ days = 40 points
  const longevityScore = Math.min(40, Math.floor(ad.timing.activeDays / 1.5));

  // Impression/Engagement score (max 35 points)
  let impressionScore = 0;
  if (ad.performance?.impressionTier) {
    const tierScores: Record<ImpressionTier, number> = {
      low: 10,
      medium: 20,
      high: 30,
      viral: 35,
    };
    impressionScore = tierScores[ad.performance.impressionTier];
  } else if (ad.performance?.likes) {
    // TikTok: estimate from likes
    impressionScore = Math.min(35, Math.floor(ad.performance.likes / 1000));
  }

  // Platform diversity score (max 25 points)
  const diversityScore = ad.intelligence?.globalWinner ? 25 : 0;

  const totalScore = longevityScore + impressionScore + diversityScore;
  
  return Math.min(100, totalScore);
}

/**
 * Enrich ads with profitability scores
 */
export function enrichWithProfitabilityScores(ads: AdEntity[]): AdEntity[] {
  return ads.map((ad) => ({
    ...ad,
    intelligence: {
      ...ad.intelligence,
      globalWinner: ad.intelligence?.globalWinner ?? false,
      profitabilityScore: calculateProfitabilityScore(ad),
    },
  }));
}
