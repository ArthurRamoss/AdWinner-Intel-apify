/**
 * AdWinner Intel - Services Index
 * 
 * Barrel export for all services.
 */

// Apify Service (Data Ingestion)
export {
  fetchFacebookAds,
  fetchTikTokAds,
  normalizeFacebookAd,
  normalizeTikTokPost,
  detectGlobalWinners,
  enrichWithProfitabilityScores,
  calculateProfitabilityScore,
  rankByCommercialIntent,
  type FetchFacebookAdsOptions,
  type FetchTikTokAdsOptions,
} from './apify-service.js';

// Gemini Service (AI Analysis)
export {
  analyzeAdCreative,
  analyzeAdsInBatch,
  calculateBatchCost,
} from './gemini-service.js';

// Cache Service (Redis)
export {
  getCachedAds,
  setCachedAds,
  getCachedTrends,
  setCachedTrends,
  getCachedAnalysis,
  setCachedAnalysis,
  invalidateDomainCache,
  checkRateLimit,
  getCacheStats,
  isRedisAvailable,
  closeRedis,
} from './cache-service.js';

// Cost Tracker
export { RequestCostTracker, type CostSummary } from './cost-tracker.js';

// Appwrite DB (Persistent Data Broker)
export {
  ensureDatabase,
  persistAds,
  getPersistedAds,
  searchPersistedAds,
  logQueryCost,
  getCostAnalytics,
} from './appwrite-db.js';
