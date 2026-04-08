/**
 * AdWinner Intel - Gemini AI Analysis Types
 * 
 * Structured output definitions for Google Gemini 2.5 Flash video analysis.
 * 
 * EFFICIENCY STRATEGY:
 * - Analyze only 0-10 seconds of video (the "Hook")
 * - Cost: ~$0.10/1M input tokens = ~$0.0001 per 1k tokens per query
 * - Expected tokens per query: ~1k (video frames + prompt + response)
 */

// =============================================================================
// HOOK ANALYSIS TYPES
// =============================================================================

/**
 * How the hook captures attention
 */
export type HookType = 
  | 'visual'           // Pattern interrupt, bold visuals, unexpected imagery
  | 'audio'            // Music, sound effect, voice tone
  | 'text-overlay'     // On-screen text/caption that hooks
  | 'question'         // Poses a question to the viewer
  | 'statement'        // Bold claim or statement
  | 'social-proof'     // Testimonial, review, or authority
  | 'pain-point'       // Addresses a problem immediately
  | 'curiosity-gap'    // Creates intrigue / incomplete information
  | 'before-after'     // Transformation shown immediately
  | 'ugc-native';      // Appears organic / user-generated

/**
 * Emotional triggers used in the creative
 */
export type EmotionalTrigger =
  | 'fear'             // Fear of missing out, fear of problem
  | 'desire'           // Aspiration, wanting the outcome
  | 'curiosity'        // Need to know more
  | 'urgency'          // Time pressure
  | 'social-validation'// Others are doing it
  | 'exclusivity'      // Not everyone can have this
  | 'relief'           // Solution to pain
  | 'excitement'       // High energy, enthusiasm
  | 'trust'            // Authority, credibility
  | 'humor';           // Comedy, relatability

/**
 * CTA strength and type
 */
export type CtaStyle = 
  | 'soft'             // "Learn more", low commitment
  | 'medium'           // "Shop now", clear but not pushy
  | 'hard'             // "Buy now - 50% off ends tonight", urgency + scarcity
  | 'implied';         // No explicit CTA, action is implied

// =============================================================================
// GEMINI ANALYSIS RESPONSE
// =============================================================================

/**
 * Structured analysis output from Gemini 2.5 Flash
 * 
 * This is the exact JSON schema we request from Gemini.
 * The model returns this structure for every video analyzed.
 */
export interface GeminiAnalysis {
  /** Analysis metadata */
  meta: {
    /** Model used (should be gemini-2.5-flash) */
    model: string;
    /** Seconds of video analyzed (0-10) */
    analyzedDuration: number;
    /** Tokens consumed (for cost tracking) */
    tokensUsed: number;
    /** Processing time in ms */
    latencyMs: number;
  };

  /** 
   * THE HOOK (First 0-3 seconds)
   * This is the most valuable insight - what stops the scroll
   */
  hook: {
    /** Primary hook mechanism */
    type: HookType;
    /** 
     * Human-readable description of what happens in first 3 seconds
     * @example "A woman screams 'STOP!' directly at camera with hands up"
     */
    description: string;
    /** 
     * Why this hook works psychologically
     * @example "Pattern interrupt - unexpected behavior breaks scroll momentum"
     */
    psychologyExplanation: string;
    /** Hook effectiveness rating (1-10) */
    effectiveness: number;
  };

  /**
   * PAIN POINT / PROBLEM
   * What customer problem does this ad address?
   */
  painPoint: {
    /** The core problem being addressed */
    problem: string;
    /** 
     * How the ad frames the problem
     * @example "Makes viewer feel their current solution is inadequate"
     */
    framing: string;
    /** Whether pain point is explicitly stated or implied */
    explicit: boolean;
  };

  /**
   * VALUE PROPOSITION
   * What solution/benefit is being offered?
   */
  valueProposition: {
    /** Core promise or benefit */
    mainBenefit: string;
    /** Supporting benefits mentioned */
    secondaryBenefits: string[];
    /** How believable is the claim (1-10) */
    credibilityScore: number;
  };

  /**
   * EMOTIONAL TRIGGERS
   * What psychological levers are being pulled?
   */
  emotionalTriggers: {
    /** Primary emotion being targeted */
    primary: EmotionalTrigger;
    /** Secondary emotions */
    secondary: EmotionalTrigger[];
    /** 
     * Explanation of emotional strategy
     * @example "Creates FOMO by showing others already enjoying the product"
     */
    strategy: string;
  };

  /**
   * CALL TO ACTION
   */
  cta: {
    /** Exact CTA text if visible */
    text: string | null;
    /** CTA aggressiveness level */
    style: CtaStyle;
    /** Is there urgency/scarcity? */
    hasUrgency: boolean;
    /** Urgency mechanism if present */
    urgencyType?: 'time-limited' | 'quantity-limited' | 'price-increase' | 'social-proof';
  };

  /**
   * CREATIVE EXECUTION
   * Technical and stylistic observations
   */
  creativeExecution: {
    /** Video style */
    format: 'ugc' | 'professional' | 'mixed' | 'animated' | 'slideshow';
    /** Is there a person's face visible? (faces increase engagement) */
    hasFace: boolean;
    /** Is there talking/voiceover in first 10s? */
    hasVoice: boolean;
    /** Text overlay density */
    textOverlayDensity: 'none' | 'minimal' | 'moderate' | 'heavy';
    /** Primary color palette (for brand matching) */
    dominantColors: string[];
    /** Estimated production quality (1-10) */
    productionQuality: number;
  };

  /**
   * MARKETING SCORE
   * Overall assessment of ad quality
   */
  marketingScore: {
    /** Overall score (0-10) */
    overall: number;
    /** Breakdown by category */
    breakdown: {
      hookStrength: number;      // 0-10
      messagingClarity: number;  // 0-10
      emotionalResonance: number; // 0-10
      ctaEffectiveness: number;  // 0-10
      productionValue: number;   // 0-10
    };
  };

  /**
   * SWIPE FILE SUMMARY
   * One-paragraph takeaway for the marketer's notes
   */
  swipeFileSummary: string;

  /**
   * REPLICATION FRAMEWORK
   * How to recreate this ad's success
   */
  replicationTips: string[];
}

// =============================================================================
// GEMINI REQUEST TYPES
// =============================================================================

/**
 * Input for Gemini video analysis
 */
export interface GeminiAnalysisRequest {
  /** URL to the video asset */
  videoUrl: string;
  /** Optional: advertiser context for better analysis */
  context?: {
    advertiserName?: string;
    industry?: string;
    productType?: string;
    targetAudience?: string;
  };
  /** Analysis depth */
  analysisDepth?: 'quick' | 'detailed';
}

/**
 * Gemini analysis with error handling wrapper
 */
export interface GeminiAnalysisResult {
  success: boolean;
  analysis?: GeminiAnalysis;
  error?: {
    code: 'VIDEO_UNAVAILABLE' | 'PROCESSING_ERROR' | 'RATE_LIMITED' | 'INVALID_FORMAT';
    message: string;
  };
  /** Cost tracking */
  cost: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
}

// =============================================================================
// GEMINI PROMPT TEMPLATE
// =============================================================================

/**
 * The system prompt for Gemini video analysis
 * This is included here for reference - actual usage in implementation.
 */
export const GEMINI_ANALYSIS_PROMPT = `
You are an expert direct-response marketing analyst. Analyze this video advertisement.

CRITICAL: Only analyze the first 10 seconds of the video. Focus on:
1. THE HOOK (0-3 seconds): What stops the scroll?
2. PAIN POINT: What problem is being addressed?
3. EMOTIONAL TRIGGERS: What psychological levers are used?
4. CTA: What action is requested?

Return your analysis as structured JSON matching the GeminiAnalysis schema.

Be specific and actionable. A marketer should be able to replicate this ad's success from your analysis.
` as const;

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum video duration to analyze (seconds) */
export const MAX_ANALYSIS_DURATION_SECONDS = 10;

/** Gemini 2.5 Flash pricing (as of 2025) */
export const GEMINI_PRICING = {
  inputTokensPer1M: 0.10,   // $0.10 per 1M input tokens
  outputTokensPer1M: 0.40,  // $0.40 per 1M output tokens
  estimatedTokensPerQuery: 1000,
} as const;
