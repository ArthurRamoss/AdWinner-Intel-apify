/**
 * AdWinner Intel - Cache Service
 * 
 * Redis-based caching layer for ad data and analysis results.
 * 
 * CACHING STRATEGY:
 * - Domain ads: 24h TTL (ads don't change that frequently)
 * - Trend reports: 6h TTL (trends change faster)
 * - Analysis results: 7d TTL (AI analysis is deterministic)
 * 
 * COST IMPACT:
 * - Cache hit = $0.00001 (Redis read)
 * - Cache miss = $0.005-0.015 (Apify + Gemini)
 * - Target: 80%+ cache hit rate for popular domains
 * - This reduces average query cost from $0.01 to ~$0.003
 */

import { Redis } from 'ioredis';
import type { AdEntity, GeminiAnalysis } from '../types/index.js';

// Type alias for Redis instance
type RedisClient = Redis;

// =============================================================================
// CONFIGURATION
// =============================================================================

const REDIS_URL = process.env.REDIS_URL;

/**
 * TTL values in seconds
 */
const TTL = {
  DOMAIN_ADS: 86400,      // 24 hours
  DOMAIN_ADS_EMPTY: 3600, // 1 hour for negative-cache entries
  TREND_REPORT: 21600,    // 6 hours
  ANALYSIS: 604800,       // 7 days
  RATE_LIMIT: 60,         // 1 minute (for rate limiting)
} as const;

/**
 * Cache key prefixes for organization
 */
const KEYS = {
  DOMAIN_ADS: 'adwinner:domain:',
  TIKTOK_TRENDS: 'adwinner:trends:',
  ANALYSIS: 'adwinner:analysis:',
  RATE_LIMIT: 'adwinner:ratelimit:',
} as const;

// =============================================================================
// REDIS CLIENT
// =============================================================================

let redis: RedisClient | null = null;
let redisDisabled = false;

function disableRedis(reason: string): void {
  if (redisDisabled) return;
  redisDisabled = true;
  console.warn(`[CacheService] Redis disabled: ${reason}`);
  if (redis) {
    redis.disconnect();
    redis = null;
  }
}

function handleRedisFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes('ECONNREFUSED') ||
    message.includes('Connection is closed') ||
    message.includes('connect ECONNREFUSED')
  ) {
    disableRedis(message || 'connection failure');
  }
}

/**
 * Get or create Redis connection
 * Lazy initialization to handle startup timing
 */
function getRedis(): RedisClient | null {
  if (redisDisabled) {
    return null;
  }
  if (!REDIS_URL) {
    return null;
  }
  if (!redis) {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 3) {
          disableRedis('connection failed after 3 retries');
          return null; // Stop retrying
        }
        return Math.min(times * 100, 1000); // Exponential backoff
      },
      lazyConnect: true,
    });

    redis.on('connect', () => {
      console.log('[CacheService] Redis connected');
    });

    redis.on('error', (err: Error) => {
      console.error('[CacheService] Redis error:', err.message);
      handleRedisFailure(err);
    });
  }
  return redis;
}

/**
 * Check if Redis is available
 */
export async function isRedisAvailable(): Promise<boolean> {
  try {
    const client = getRedis();
    if (!client) return false;
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Graceful shutdown
 */
export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
    console.log('[CacheService] Redis connection closed');
  }
}

// =============================================================================
// DOMAIN ADS CACHE
// =============================================================================

/**
 * Build cache key for domain ads
 */
function buildDomainKey(domain: string, country: string, platform: string): string {
  const normalized = domain.toLowerCase().replace(/^www\./, '');
  return `${KEYS.DOMAIN_ADS}${normalized}:${country}:${platform}`;
}

/**
 * Get cached ads for a domain
 * 
 * @param domain - Advertiser domain
 * @param country - Country code
 * @param platform - Platform filter
 * @returns Cached ads or null if not found
 */
export async function getCachedAds(
  domain: string,
  country: string = 'US',
  platform: string = 'all'
): Promise<AdEntity[] | null> {
  try {
    const client = getRedis();
    if (!client) return null;
    const key = buildDomainKey(domain, country, platform);
    const cached = await client.get(key);
    
    if (cached) {
      console.log(`[CacheService] Cache HIT for ${domain}`);
      return JSON.parse(cached) as AdEntity[];
    }
    
    console.log(`[CacheService] Cache MISS for ${domain}`);
    return null;
  } catch (error) {
    handleRedisFailure(error);
    console.error('[CacheService] Error reading cache:', error);
    return null; // Fail open - continue without cache
  }
}

/**
 * Store ads in cache
 * 
 * @param domain - Advertiser domain
 * @param ads - Array of AdEntity to cache
 * @param country - Country code
 * @param platform - Platform filter
 */
export async function setCachedAds(
  domain: string,
  ads: AdEntity[],
  country: string = 'US',
  platform: string = 'all'
): Promise<void> {
  try {
    const client = getRedis();
    if (!client) return;
    const key = buildDomainKey(domain, country, platform);
    const ttlSeconds = ads.length === 0 ? TTL.DOMAIN_ADS_EMPTY : TTL.DOMAIN_ADS;
    await client.setex(key, ttlSeconds, JSON.stringify(ads));
    console.log(`[CacheService] Cached ${ads.length} ads for ${domain} (TTL: ${ttlSeconds}s)`);
  } catch (error) {
    handleRedisFailure(error);
    console.error('[CacheService] Error writing cache:', error);
    // Fail silently - caching is not critical
  }
}

/**
 * Invalidate cache for a domain (if needed)
 */
export async function invalidateDomainCache(
  domain: string,
  country?: string
): Promise<void> {
  try {
    const client = getRedis();
    if (!client) return;
    const pattern = country
      ? `${KEYS.DOMAIN_ADS}${domain.toLowerCase()}:${country}:*`
      : `${KEYS.DOMAIN_ADS}${domain.toLowerCase()}:*`;
    
    const keys = await client.keys(pattern);
    if (keys.length > 0) {
      await client.del(...keys);
      console.log(`[CacheService] Invalidated ${keys.length} cache entries for ${domain}`);
    }
  } catch (error) {
    handleRedisFailure(error);
    console.error('[CacheService] Error invalidating cache:', error);
  }
}

// =============================================================================
// TREND REPORT CACHE
// =============================================================================

/**
 * Build cache key for trend reports
 */
function buildTrendKey(keyword: string, region: string, timeRange: string): string {
  const normalized = keyword.toLowerCase().replace(/\s+/g, '-');
  return `${KEYS.TIKTOK_TRENDS}${normalized}:${region}:${timeRange}`;
}

/**
 * Get cached trend report
 */
export async function getCachedTrends(
  keyword: string,
  region: string = 'US',
  timeRange: string = '7d'
): Promise<AdEntity[] | null> {
  try {
    const client = getRedis();
    if (!client) return null;
    const key = buildTrendKey(keyword, region, timeRange);
    const cached = await client.get(key);
    
    if (cached) {
      console.log(`[CacheService] Trend cache HIT for "${keyword}"`);
      return JSON.parse(cached) as AdEntity[];
    }
    
    return null;
  } catch (error) {
    handleRedisFailure(error);
    console.error('[CacheService] Error reading trend cache:', error);
    return null;
  }
}

/**
 * Store trend report in cache
 */
export async function setCachedTrends(
  keyword: string,
  ads: AdEntity[],
  region: string = 'US',
  timeRange: string = '7d'
): Promise<void> {
  try {
    const client = getRedis();
    if (!client) return;
    const key = buildTrendKey(keyword, region, timeRange);
    await client.setex(key, TTL.TREND_REPORT, JSON.stringify(ads));
    console.log(`[CacheService] Cached trend report for "${keyword}" (TTL: ${TTL.TREND_REPORT}s)`);
  } catch (error) {
    handleRedisFailure(error);
    console.error('[CacheService] Error writing trend cache:', error);
  }
}

// =============================================================================
// ANALYSIS CACHE
// =============================================================================

/**
 * Build cache key for analysis results
 * Uses ad ID as primary key since analysis is deterministic
 */
function buildAnalysisKey(adId: string): string {
  return `${KEYS.ANALYSIS}${adId}`;
}

/**
 * Get cached analysis for an ad
 */
export async function getCachedAnalysis(adId: string): Promise<GeminiAnalysis | null> {
  try {
    const client = getRedis();
    if (!client) return null;
    const key = buildAnalysisKey(adId);
    const cached = await client.get(key);
    
    if (cached) {
      console.log(`[CacheService] Analysis cache HIT for ${adId}`);
      return JSON.parse(cached) as GeminiAnalysis;
    }
    
    return null;
  } catch (error) {
    handleRedisFailure(error);
    console.error('[CacheService] Error reading analysis cache:', error);
    return null;
  }
}

/**
 * Store analysis result in cache
 */
export async function setCachedAnalysis(
  adId: string,
  analysis: GeminiAnalysis
): Promise<void> {
  try {
    const client = getRedis();
    if (!client) return;
    const key = buildAnalysisKey(adId);
    await client.setex(key, TTL.ANALYSIS, JSON.stringify(analysis));
    console.log(`[CacheService] Cached analysis for ${adId} (TTL: ${TTL.ANALYSIS}s)`);
  } catch (error) {
    handleRedisFailure(error);
    console.error('[CacheService] Error writing analysis cache:', error);
  }
}

// =============================================================================
// RATE LIMITING
// =============================================================================

/**
 * Check if a request should be rate limited
 * Uses sliding window algorithm
 * 
 * @param identifier - Unique identifier (e.g., IP, user ID)
 * @param maxRequests - Maximum requests per window
 * @param windowSeconds - Window size in seconds
 * @returns Object with allowed status and remaining requests
 */
export async function checkRateLimit(
  identifier: string,
  maxRequests: number = 100,
  windowSeconds: number = 60
): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
  try {
    const client = getRedis();
    if (!client) {
      return { allowed: true, remaining: maxRequests, resetIn: 0 };
    }
    const key = `${KEYS.RATE_LIMIT}${identifier}`;
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    // Use Redis transaction for atomic operations
    const multi = client.multi();
    
    // Remove old entries outside the window
    multi.zremrangebyscore(key, '-inf', windowStart);
    
    // Add current request
    multi.zadd(key, now, `${now}-${Math.random()}`);
    
    // Count requests in window
    multi.zcard(key);
    
    // Set expiry
    multi.expire(key, windowSeconds);
    
    const results = await multi.exec();
    const count = results?.[2]?.[1] as number || 0;
    
    const allowed = count <= maxRequests;
    const remaining = Math.max(0, maxRequests - count);
    
    return {
      allowed,
      remaining,
      resetIn: windowSeconds,
    };
  } catch (error) {
    handleRedisFailure(error);
    console.error('[CacheService] Rate limit check failed:', error);
    // Fail open - allow request if Redis is down
    return { allowed: true, remaining: maxRequests, resetIn: 0 };
  }
}

// =============================================================================
// CACHE STATISTICS
// =============================================================================

/**
 * Get cache statistics for monitoring
 */
export async function getCacheStats(): Promise<{
  connected: boolean;
  domainCacheKeys: number;
  trendCacheKeys: number;
  analysisCacheKeys: number;
  memoryUsage: string;
}> {
  try {
    const client = getRedis();
    if (!client) {
      return {
        connected: false,
        domainCacheKeys: 0,
        trendCacheKeys: 0,
        analysisCacheKeys: 0,
        memoryUsage: 'N/A',
      };
    }
    
    const [domainKeys, trendKeys, analysisKeys, info] = await Promise.all([
      client.keys(`${KEYS.DOMAIN_ADS}*`),
      client.keys(`${KEYS.TIKTOK_TRENDS}*`),
      client.keys(`${KEYS.ANALYSIS}*`),
      client.info('memory'),
    ]);

    // Parse memory usage from INFO response
    const memoryMatch = info.match(/used_memory_human:(\S+)/);
    const memoryUsage = memoryMatch?.[1] || 'unknown';

    return {
      connected: true,
      domainCacheKeys: domainKeys.length,
      trendCacheKeys: trendKeys.length,
      analysisCacheKeys: analysisKeys.length,
      memoryUsage,
    };
  } catch (error) {
    return {
      connected: false,
      domainCacheKeys: 0,
      trendCacheKeys: 0,
      analysisCacheKeys: 0,
      memoryUsage: 'N/A',
    };
  }
}
