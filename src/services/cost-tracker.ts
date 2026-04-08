/**
 * AdWinner Intel - Cost Tracker
 *
 * Tracks Apify and Gemini costs per request to ensure $0.10/query margin stays positive.
 * Logs costs to console and returns cost metadata in each response.
 *
 * Revenue model:
 *   User pays: $0.10/query
 *   Context Protocol takes: 10% ($0.01)
 *   Net revenue: $0.09/query
 *   Target max cost: $0.04/query (55%+ margin)
 *
 * Cost breakdown:
 *   Facebook Ads Library:  $0.00075/result  (curious_coder actor)
 *   TikTok Scraper:         $0.0003/result   (apidojo actor, $0.30/1K)
 *   Gemini 2.0 Flash:      ~$0.0001/analysis
 *   Redis cache read:      ~$0.00001
 */

// =============================================================================
// COST CONSTANTS
// =============================================================================

const COST_PER_FB_RESULT = 0.00075;
const COST_PER_TIKTOK_RESULT = 0.0003;
const COST_PER_GEMINI_ANALYSIS = 0.0002; // conservative estimate
const REVENUE_PER_QUERY = 0.10;
const CONTEXT_PROTOCOL_CUT = 0.10; // 10%
const NET_REVENUE = REVENUE_PER_QUERY * (1 - CONTEXT_PROTOCOL_CUT); // $0.09

// Red line: if a single query costs more than this, we're losing money
const COST_WARNING_THRESHOLD = 0.06;  // 66% of net revenue
const COST_DANGER_THRESHOLD = NET_REVENUE; // $0.09 — above this = net loss

// =============================================================================
// REQUEST COST TRACKER
// =============================================================================

export interface CostEntry {
  service: 'facebook' | 'tiktok' | 'gemini' | 'cache';
  operation: string;
  resultCount: number;
  estimatedCost: number;
  fromCache: boolean;
  timestamp: number;
}

export interface CostSummary {
  totalCost: number;
  breakdown: {
    facebook: number;
    tiktok: number;
    gemini: number;
  };
  margin: number;        // net revenue minus cost
  marginPercent: number;  // margin / net_revenue * 100
  warning: string | null; // null if healthy
  entryCount: number;
  fromCache: boolean;     // true if ALL data came from cache
}

/**
 * Per-request cost tracker.
 * Create one at the start of each tool handler, pass it through,
 * then call .summary() to get the cost metadata for the response.
 */
export class RequestCostTracker {
  private entries: CostEntry[] = [];
  private toolName: string;
  private startTime: number;

  constructor(toolName: string) {
    this.toolName = toolName;
    this.startTime = Date.now();
  }

  /** Record a Facebook fetch */
  trackFacebook(resultCount: number, fromCache = false): void {
    this.entries.push({
      service: 'facebook',
      operation: 'fetch_ads',
      resultCount,
      estimatedCost: fromCache ? 0 : resultCount * COST_PER_FB_RESULT,
      fromCache,
      timestamp: Date.now(),
    });
  }

  /** Record a TikTok fetch */
  trackTikTok(resultCount: number, fromCache = false): void {
    this.entries.push({
      service: 'tiktok',
      operation: 'fetch_posts',
      resultCount,
      estimatedCost: fromCache ? 0 : resultCount * COST_PER_TIKTOK_RESULT,
      fromCache,
      timestamp: Date.now(),
    });
  }

  /** Record a Gemini analysis */
  trackGemini(count = 1): void {
    this.entries.push({
      service: 'gemini',
      operation: 'analyze_creative',
      resultCount: count,
      estimatedCost: count * COST_PER_GEMINI_ANALYSIS,
      fromCache: false,
      timestamp: Date.now(),
    });
  }

  /** Record a cache hit (cost = $0) */
  trackCacheHit(service: 'facebook' | 'tiktok' | 'gemini', resultCount: number): void {
    this.entries.push({
      service,
      operation: 'cache_hit',
      resultCount,
      estimatedCost: 0,
      fromCache: true,
      timestamp: Date.now(),
    });
  }

  /** Get cost summary for this request */
  summary(): CostSummary {
    const fb = this.entries.filter(e => e.service === 'facebook').reduce((s, e) => s + e.estimatedCost, 0);
    const tt = this.entries.filter(e => e.service === 'tiktok').reduce((s, e) => s + e.estimatedCost, 0);
    const gem = this.entries.filter(e => e.service === 'gemini').reduce((s, e) => s + e.estimatedCost, 0);
    const totalCost = fb + tt + gem;
    const margin = NET_REVENUE - totalCost;
    const marginPercent = NET_REVENUE > 0 ? (margin / NET_REVENUE) * 100 : 0;
    const allFromCache = this.entries.length > 0 && this.entries.every(e => e.fromCache);

    let warning: string | null = null;
    if (totalCost >= COST_DANGER_THRESHOLD) {
      warning = `🔴 NET LOSS: Query cost $${totalCost.toFixed(4)} exceeds net revenue $${NET_REVENUE.toFixed(2)}`;
    } else if (totalCost >= COST_WARNING_THRESHOLD) {
      warning = `🟡 LOW MARGIN: Query cost $${totalCost.toFixed(4)}, margin only $${margin.toFixed(4)} (${marginPercent.toFixed(0)}%)`;
    }

    // Always log costs
    const durationMs = Date.now() - this.startTime;
    const cacheLabel = allFromCache ? ' [CACHED]' : '';
    console.log(
      `[CostTracker] ${this.toolName}${cacheLabel}: $${totalCost.toFixed(4)} cost | $${margin.toFixed(4)} margin (${marginPercent.toFixed(0)}%) | ${durationMs}ms` +
      (warning ? ` | ${warning}` : '')
    );

    if (this.entries.length > 0) {
      for (const entry of this.entries) {
        const label = entry.fromCache ? '(cache)' : `(${entry.resultCount} results)`;
        console.log(`  └─ ${entry.service}/${entry.operation}: $${entry.estimatedCost.toFixed(4)} ${label}`);
      }
    }

    return {
      totalCost: Math.round(totalCost * 10000) / 10000,
      breakdown: {
        facebook: Math.round(fb * 10000) / 10000,
        tiktok: Math.round(tt * 10000) / 10000,
        gemini: Math.round(gem * 10000) / 10000,
      },
      margin: Math.round(margin * 10000) / 10000,
      marginPercent: Math.round(marginPercent),
      warning,
      entryCount: this.entries.length,
      fromCache: allFromCache,
    };
  }
}
