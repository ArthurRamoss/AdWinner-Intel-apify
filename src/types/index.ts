/**
 * AdWinner Intel - Types Index
 * 
 * Barrel export for all type definitions.
 */

// =============================================================================
// AD ENTITY TYPES
// =============================================================================
export type {
  AdPlatform,
  LongevityStatus,
  CreativeType,
  ImpressionTier,
  AdEntity,
  RawFacebookAd,
  RawTikTokPost,
  DomainQueryParams,
  DomainAnalysisResult,
} from './ad-entity.js';

export {
  LONGEVITY_THRESHOLD_DAYS,
  IMPRESSION_TIERS,
} from './ad-entity.js';

// =============================================================================
// GEMINI ANALYSIS TYPES
// =============================================================================
export type {
  HookType,
  EmotionalTrigger,
  CtaStyle,
  GeminiAnalysis,
  GeminiAnalysisRequest,
  GeminiAnalysisResult,
} from './gemini-analysis.js';

export {
  GEMINI_ANALYSIS_PROMPT,
  MAX_ANALYSIS_DURATION_SECONDS,
  GEMINI_PRICING,
} from './gemini-analysis.js';

// =============================================================================
// TOOL SCHEMAS
// =============================================================================
export type {
  AnalyzeDomainWinnersInput,
  GetTrendReportInput,
  ExtractMarketingHooksInput,
  AdProfitabilityScoreInput,
  GetRawFbAdsInput,
  GetRawTikTokAdsInput,
  AnalyzeDomainWinnersOutput,
  GetTrendReportOutput,
  ExtractMarketingHooksOutput,
  AdProfitabilityScoreOutput,
  GetRawFbAdsOutput,
  GetRawTikTokAdsOutput,
} from './tool-schemas.js';

export {
  AnalyzeDomainWinnersInputSchema,
  GetTrendReportInputSchema,
  ExtractMarketingHooksInputSchema,
  AdProfitabilityScoreInputSchema,
  GetRawFbAdsInputSchema,
  GetRawTikTokAdsInputSchema,
  AnalyzeDomainWinnersOutputSchema,
  GetTrendReportOutputSchema,
  ExtractMarketingHooksOutputSchema,
  AdProfitabilityScoreOutputSchema,
  GetRawFbAdsOutputSchema,
  GetRawTikTokAdsOutputSchema,
  AdEntitySchema,
  GeminiAnalysisSchema,
} from './tool-schemas.js';
