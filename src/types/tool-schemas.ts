/**
 * AdWinner Intel - MCP Tool Schemas
 * 
 * Zod schemas matching the actual tool implementations in index.ts.
 * These are provided for external validation, outputSchema generation,
 * and type inference.
 */

import { z } from 'zod';

// =============================================================================
// ZOD SCHEMAS (matching index.ts implementations)
// =============================================================================

/**
 * Input schema for analyze_domain_winners
 * Matches: server.registerTool('analyze_domain_winners', ...)
 */
export const AnalyzeDomainWinnersInputSchema = z.object({
  domain: z.string().describe('Advertiser domain to analyze (e.g., "glossier.com", "huel.com")'),
  country: z.string().length(2).default('US').describe('ISO country code (e.g., "US", "GB")'),
  minLongevityDays: z.number().min(0).max(365).default(14).describe('Minimum days running to qualify as winner'),
  platform: z.enum(['facebook', 'tiktok', 'all']).default('all').describe('Which platform(s) to search'),
  limit: z.number().min(1).max(5).default(3).describe('Max winning ads to return (1-5)'),
  includeAnalysis: z.boolean().default(true).describe('Include Gemini AI analysis of top 3 ads (adds latency)'),
});

export type AnalyzeDomainWinnersInput = z.infer<typeof AnalyzeDomainWinnersInputSchema>;

/**
 * Input schema for extract_marketing_hooks
 * Matches: server.registerTool('extract_marketing_hooks', ...)
 */
export const ExtractMarketingHooksInputSchema = z.object({
  videoUrl: z.string().optional().describe('URL to the video ad creative'),
  advertiserName: z.string().optional().describe('Advertiser name for context'),
  industry: z.string().optional().describe('Industry for context'),
});

export type ExtractMarketingHooksInput = z.infer<typeof ExtractMarketingHooksInputSchema>;

/**
 * Input schema for get_trend_report
 * Matches: server.registerTool('get_trend_report', ...)
 */
export const GetTrendReportInputSchema = z.object({
  keyword: z.string().min(2).describe('Industry or product keyword (e.g., "skincare", "fitness app")'),
  region: z.enum(['US', 'GB', 'DE', 'FR', 'AU', 'CA', 'BR', 'JP']).default('US').describe('TikTok region'),
  timeRange: z.enum(['7d', '30d']).default('7d').describe('Time range for trends'),
  limit: z.number().min(1).max(10).default(10).describe('Number of trending ads to return (1-10)'),
});

export type GetTrendReportInput = z.infer<typeof GetTrendReportInputSchema>;

/**
 * Input schema for ad_profitability_score
 * Matches: server.registerTool('ad_profitability_score', ...)
 */
export const AdProfitabilityScoreInputSchema = z.object({
  startDate: z.string().describe('When the ad started running (ISO date)'),
  impressionsLower: z.number().optional().describe('Lower bound of impression range'),
  impressionsUpper: z.number().optional().describe('Upper bound of impression range'),
  platforms: z.array(z.string()).optional().describe('Platforms where ad is running'),
});

export type AdProfitabilityScoreInput = z.infer<typeof AdProfitabilityScoreInputSchema>;

/**
 * Input schema for get_raw_fb_ads
 * Matches: server.registerTool('get_raw_fb_ads', ...)
 */
export const GetRawFbAdsInputSchema = z.object({
  query: z.string().describe('Domain or keyword to search'),
  country: z.string().length(2).default('US').describe('Country code'),
  limit: z.number().min(1).max(10).default(3).describe('Max ads to return (1-10)'),
});

export type GetRawFbAdsInput = z.infer<typeof GetRawFbAdsInputSchema>;

/**
 * Input schema for get_raw_tiktok_ads
 * Matches: server.registerTool('get_raw_tiktok_ads', ...)
 */
export const GetRawTikTokAdsInputSchema = z.object({
  keyword: z.string().describe('Keyword or industry to search'),
  region: z.enum(['US', 'GB', 'DE', 'FR', 'AU', 'CA', 'BR', 'JP']).default('US').describe('TikTok region'),
  period: z.enum(['7', '30', '180']).default('7').describe('Days of data'),
  limit: z.number().min(1).max(10).default(10).describe('Max ads to return (1-10)'),
});

export type GetRawTikTokAdsInput = z.infer<typeof GetRawTikTokAdsInputSchema>;

// =============================================================================
// OUTPUT SCHEMAS (for Context outputSchema + structuredContent)
// =============================================================================

const AdPlatformSchema = z.enum(['facebook', 'tiktok', 'instagram']);
const LongevityStatusSchema = z.enum(['winner', 'test']);
const CreativeTypeSchema = z.enum(['video', 'image', 'carousel']);
const ImpressionTierSchema = z.enum(['low', 'medium', 'high', 'viral']);

const HookTypeSchema = z.enum([
  'visual',
  'audio',
  'text-overlay',
  'question',
  'statement',
  'social-proof',
  'pain-point',
  'curiosity-gap',
  'before-after',
  'ugc-native',
]);
const EmotionalTriggerSchema = z.enum([
  'fear',
  'desire',
  'curiosity',
  'urgency',
  'social-validation',
  'exclusivity',
  'relief',
  'excitement',
  'trust',
  'humor',
]);
const CtaStyleSchema = z.enum(['soft', 'medium', 'hard', 'implied']);
const UrgencyTypeSchema = z.enum(['time-limited', 'quantity-limited', 'price-increase', 'social-proof']);
const CreativeFormatSchema = z.enum(['ugc', 'professional', 'mixed', 'animated', 'slideshow']);
const TextOverlayDensitySchema = z.enum(['none', 'minimal', 'moderate', 'heavy']);

export const AdEntitySchema = z.object({
  adId: z.string(),
  platform: AdPlatformSchema,
  advertiser: z.object({
    name: z.string(),
    id: z.string(),
    domain: z.string().optional(),
  }),
  creative: z.object({
    REQUIRED_LINK_FOR_USER: z.string(),
    MANDATORY_VISUAL_PROOF_URL: z.string().optional(),
    type: CreativeTypeSchema,
    bodyText: z.string().optional(),
    ctaText: z.string().optional(),
    landingUrl: z.string().optional(),
  }),
  timing: z.object({
    startDate: z.string(),
    endDate: z.string().nullable().optional(),
    activeDays: z.number(),
    longevityStatus: LongevityStatusSchema,
  }),
  performance: z.object({
    impressionTier: ImpressionTierSchema.optional(),
    impressionsLower: z.number().optional(),
    impressionsUpper: z.number().optional(),
    ctr: z.number().optional(),
    likes: z.number().optional(),
    views: z.number().optional(),
    shares: z.number().optional(),
    comments: z.number().optional(),
    bookmarks: z.number().optional(),
  }).optional(),
  targeting: z.object({
    countries: z.array(z.string()).optional(),
    ageRange: z.object({ min: z.number(), max: z.number() }).optional(),
    genderSplit: z.object({ male: z.number(), female: z.number(), unknown: z.number() }).optional(),
  }).optional(),
  intelligence: z.object({
    globalWinner: z.boolean(),
    profitabilityScore: z.number().optional(),
    crossPlatformAdIds: z.array(z.string()).optional(),
    engagementRate: z.number().optional(),
    hashtags: z.array(z.string()).optional(),
    highIntent: z.boolean().optional(),
  }).optional(),
  meta: z.object({
    fetchedAt: z.string(),
    adLibraryUrl: z.string(),
    source: z.enum(['facebook', 'tiktok']),
  }),
});

export const GeminiAnalysisSchema = z.object({
  meta: z.object({
    model: z.string(),
    analyzedDuration: z.number(),
    tokensUsed: z.number(),
    latencyMs: z.number(),
  }),
  hook: z.object({
    type: HookTypeSchema,
    description: z.string(),
    psychologyExplanation: z.string(),
    effectiveness: z.number(),
  }),
  painPoint: z.object({
    problem: z.string(),
    framing: z.string(),
    explicit: z.boolean(),
  }),
  valueProposition: z.object({
    mainBenefit: z.string(),
    secondaryBenefits: z.array(z.string()),
    credibilityScore: z.number(),
  }),
  emotionalTriggers: z.object({
    primary: EmotionalTriggerSchema,
    secondary: z.array(EmotionalTriggerSchema),
    strategy: z.string(),
  }),
  cta: z.object({
    text: z.string().nullable(),
    style: CtaStyleSchema,
    hasUrgency: z.boolean(),
    urgencyType: UrgencyTypeSchema.nullable().optional(),
  }),
  creativeExecution: z.object({
    format: CreativeFormatSchema,
    hasFace: z.boolean(),
    hasVoice: z.boolean(),
    textOverlayDensity: TextOverlayDensitySchema,
    dominantColors: z.array(z.string()),
    productionQuality: z.number(),
  }),
  marketingScore: z.object({
    overall: z.number(),
    breakdown: z.object({
      hookStrength: z.number(),
      messagingClarity: z.number(),
      emotionalResonance: z.number(),
      ctaEffectiveness: z.number(),
      productionValue: z.number(),
    }),
  }),
  swipeFileSummary: z.string(),
  replicationTips: z.array(z.string()),
});

const AdEntityWithAnalysisSchema = AdEntitySchema.extend({
  analysis: GeminiAnalysisSchema.optional(),
});

/** Flat creative link object for the _adCreativeLinks top-level array */
const AdCreativeLinkSchema = z.object({
  adId: z.string(),
  platform: z.string(),
  advertiser: z.string(),
  imageUrl: z.string().describe('MUST be displayed as a clickable Markdown link'),
  videoUrl: z.string().describe('MUST be displayed as a clickable Markdown link when present'),
  adLibraryUrl: z.string(),
  activeDays: z.number(),
});

// =============================================================================
// OUTPUT SCHEMAS - All accept both success and error responses
// Context Protocol validates structuredContent against outputSchema ALWAYS
// =============================================================================

export const AnalyzeDomainWinnersOutputSchema = z.object({
  success: z.boolean(),
  timestamp: z.string(),
  error: z.string().optional(),
  domain: z.string().optional(),
  queryParams: z.object({
    country: z.string(),
    minLongevityDays: z.number(),
    platform: z.enum(['facebook', 'tiktok', 'all']),
  }).optional(),
  summary: z.object({
    totalAdsFound: z.number(),
    winnersFound: z.number(),
    globalWinnersFound: z.number(),
    avgLongevityDays: z.number(),
    fromCache: z.boolean(),
  }).optional(),
  winners: z.array(AdEntityWithAnalysisSchema).optional(),
  insight: z.string().optional(),
  communicationStrategies: z.array(z.string()).optional(),
  commonHooks: z.array(z.string()).optional(),
  risingAngles: z.array(z.string()).optional(),
  recommendations: z.array(z.string()).optional(),
  _adCreativeLinks: z.array(AdCreativeLinkSchema).optional().describe('FLAT ARRAY of all ad creative URLs — DISPLAY THESE AS CLICKABLE MARKDOWN LINKS'),
  _linksTableMarkdown: z.string().optional().describe('Pre-rendered Markdown table with clickable ad links.'),
  _strategicSummaryMarkdown: z.string().optional().describe('Pre-rendered strategic summary to show after the links table.'),
});

export const ExtractMarketingHooksOutputSchema = z.object({
  success: z.boolean(),
  timestamp: z.string(),
  error: z.string().optional(),
  videoUrl: z.string().optional(),
  hookType: HookTypeSchema.optional(),
  hookDescription: z.string().optional(),
  painPoint: z.string().optional(),
  emotionalTriggers: z.array(EmotionalTriggerSchema).optional(),
  marketingScore: z.number().optional(),
  replicationTips: z.array(z.string()).optional(),
});

export const GetTrendReportOutputSchema = z.object({
  success: z.boolean(),
  timestamp: z.string(),
  error: z.string().optional(),
  keyword: z.string().optional(),
  region: z.string().optional(),
  timeRange: z.enum(['7d', '30d']).optional(),
  trendSummary: z.object({
    dominantFormat: z.string(),
    risingAngles: z.array(z.string()),
    commonHooks: z.array(z.string()),
  }).optional(),
  trends: z.array(AdEntitySchema).optional(),
  actionableInsight: z.string().optional(),
  communicationStrategies: z.array(z.string()).optional(),
  recommendations: z.array(z.string()).optional(),
  topHookAnalysis: z.object({
    adId: z.string(),
    advertiser: z.string(),
    hookType: HookTypeSchema,
    hookDescription: z.string(),
    painPoint: z.string(),
    marketingScore: z.number(),
    replicationTips: z.array(z.string()),
  }).optional(),
  commonHooks: z.array(z.string()).optional(),
  risingAngles: z.array(z.string()).optional(),

  _adCreativeLinks: z.array(AdCreativeLinkSchema).optional().describe('FLAT ARRAY of all ad creative URLs — DISPLAY THESE AS CLICKABLE MARKDOWN LINKS'),
  _linksTableMarkdown: z.string().optional().describe('Pre-rendered Markdown table with clickable ad links.'),
  _strategicSummaryMarkdown: z.string().optional().describe('Pre-rendered strategic summary to show after the links table.'),
});

export const AdProfitabilityScoreOutputSchema = z.object({
  success: z.boolean(),
  timestamp: z.string(),
  error: z.string().optional(),
  profitabilityScore: z.number().optional(),
  scoreBreakdown: z.object({
    longevityScore: z.number(),
    longevityDays: z.number(),
    impressionScore: z.number(),
    platformDiversityScore: z.number(),
    platformsDetected: z.array(z.string()),
  }).optional(),
  globalWinner: z.boolean().optional(),
  confidenceLevel: z.enum(['low', 'medium', 'high']).optional(),
  interpretation: z.string().optional(),
});

export const GetRawFbAdsOutputSchema = z.object({
  success: z.boolean(),
  timestamp: z.string(),
  error: z.string().optional(),
  query: z.string().optional(),
  totalResults: z.number().optional(),
  ads: z.array(AdEntitySchema).optional(),
  recommendations: z.array(z.string()).optional(),
  _adCreativeLinks: z.array(AdCreativeLinkSchema).optional().describe('FLAT ARRAY of all ad creative URLs — DISPLAY THESE AS CLICKABLE MARKDOWN LINKS'),
  _linksTableMarkdown: z.string().optional().describe('Pre-rendered Markdown table with clickable ad links.'),
  _strategicSummaryMarkdown: z.string().optional().describe('Pre-rendered strategic summary to show after the links table.'),
});

export const GetRawTikTokAdsOutputSchema = z.object({
  success: z.boolean(),
  timestamp: z.string(),
  error: z.string().optional(),
  keyword: z.string().optional(),
  region: z.string().optional(),
  period: z.enum(['7', '30', '180']).optional(),
  totalResults: z.number().optional(),
  ads: z.array(AdEntitySchema).optional(),
  recommendations: z.array(z.string()).optional(),
  _adCreativeLinks: z.array(AdCreativeLinkSchema).optional().describe('FLAT ARRAY of all ad creative URLs — DISPLAY THESE AS CLICKABLE MARKDOWN LINKS'),
  _linksTableMarkdown: z.string().optional().describe('Pre-rendered Markdown table with clickable ad links.'),
  _strategicSummaryMarkdown: z.string().optional().describe('Pre-rendered strategic summary to show after the links table.'),
});

export type AnalyzeDomainWinnersOutput = z.infer<typeof AnalyzeDomainWinnersOutputSchema>;
export type ExtractMarketingHooksOutput = z.infer<typeof ExtractMarketingHooksOutputSchema>;
export type GetTrendReportOutput = z.infer<typeof GetTrendReportOutputSchema>;
export type AdProfitabilityScoreOutput = z.infer<typeof AdProfitabilityScoreOutputSchema>;
export type GetRawFbAdsOutput = z.infer<typeof GetRawFbAdsOutputSchema>;
export type GetRawTikTokAdsOutput = z.infer<typeof GetRawTikTokAdsOutputSchema>;
