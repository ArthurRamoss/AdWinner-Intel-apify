/**
 * AdWinner Intel - Gemini AI Service
 * 
 * Handles video/image analysis using Google Gemini 2.5 Flash.
 * 
 * VIDEO EFFICIENCY STRATEGY:
 * - Analyze ONLY first 10 seconds of video (the "Hook Zone")
 * - Cost: ~$0.10 per 1M input tokens = ~$0.0001 per 1k tokens
 * - Expected tokens per query: ~1000 (frames + prompt + response)
 * - Target cost per analysis: < $0.01
 * 
 * WHY GEMINI 2.5 FLASH:
 * - Native video understanding with inline MP4 payload
 * - Multimodal input (video URL or image URL directly)
 * - Structured JSON output mode for reliable parsing
 * - 10x cheaper than GPT-4o for equivalent quality
 */

import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, type GenerativeModel } from '@google/generative-ai';
import {
  type AdEntity,
  type GeminiAnalysis,
  type GeminiAnalysisResult,
  type HookType,
  type EmotionalTrigger,
  type CtaStyle,
  GEMINI_ANALYSIS_PROMPT,
  MAX_ANALYSIS_DURATION_SECONDS,
  GEMINI_PRICING,
} from '../types/index.js';
import {
  isAppwriteConfigured,
  uploadBufferToAppwrite,
} from './appwrite-service.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/**
 * Whether a Gemini API key is present. This is a cheap, synchronous check — it
 * confirms the key is set, NOT that it is valid. Use validateGeminiConnection()
 * for a live check against the API.
 */
export function isGeminiConfigured(): boolean {
  return typeof GEMINI_API_KEY === 'string' && GEMINI_API_KEY.trim().length > 0;
}

if (!isGeminiConfigured()) {
  console.warn('[GeminiService] GEMINI_API_KEY not set — AI creative analysis will return "unavailable".');
} else {
  // Log presence + length only. NEVER log the key value itself.
  console.log(
    `[GeminiService] GEMINI_API_KEY present (length ${GEMINI_API_KEY!.trim().length}). Model: ${process.env.GEMINI_MODEL || 'gemini-2.5-flash'}`,
  );
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || '');

/**
 * Gemini model configuration
 * Default uses a stable Gemini API model. Override via GEMINI_MODEL env.
 */
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
// Analyze the actual VIDEO by default (not just the static thumbnail). The hook
// lives in the motion + audio of the first seconds, which a thumbnail misses.
// Override with TIKTOK_ANALYSIS_MODE=thumbnail for the cheaper/faster path.
const TIKTOK_ANALYSIS_MODE = (process.env.TIKTOK_ANALYSIS_MODE || 'video').toLowerCase();
const TIKTOK_ANALYSIS_SECONDS = Number(process.env.TIKTOK_ANALYSIS_SECONDS || '15');
const TIKTOK_MAX_VIDEO_MB = Number(process.env.TIKTOK_MAX_VIDEO_MB || '25');
const TIKTOK_VIDEO_RANGE_BYTES = Number(process.env.TIKTOK_VIDEO_RANGE_BYTES || '0');
const GEMINI_MEDIA_FETCH_TIMEOUT_MS = Number(process.env.GEMINI_MEDIA_FETCH_TIMEOUT_MS || '9000');
const GEMINI_GENERATION_TIMEOUT_MS = Number(process.env.GEMINI_GENERATION_TIMEOUT_MS || '18000');
const CACHE_TIKTOK_VIDEO_COPY = (process.env.CACHE_TIKTOK_VIDEO_COPY || 'false').toLowerCase() === 'true';
const TIKTOK_MAX_VIDEO_BYTES = Number.isFinite(TIKTOK_MAX_VIDEO_MB) && TIKTOK_MAX_VIDEO_MB > 0
  ? Math.floor(TIKTOK_MAX_VIDEO_MB * 1024 * 1024)
  : 25 * 1024 * 1024;

// Browser-like headers for media fetches. TikTok (and some Meta) CDNs return 403
// to "headless" requests with no User-Agent/Referer — sending these makes the
// server-side download succeed so we can analyze the real video, not a thumbnail.
const MEDIA_FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'video/webm,video/mp4,image/avif,image/webp,image/*,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.tiktok.com/',
};

/**
 * Safety settings - relaxed for ad analysis
 * Ads may contain marketing claims that could trigger false positives
 */
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

/**
 * Generation config for structured JSON output
 */
const GENERATION_CONFIG = {
  temperature: 0.4, // Lower temperature for consistent, factual analysis
  topP: 0.8,
  topK: 40,
  maxOutputTokens: 2048,
  responseMimeType: 'application/json',
};

// =============================================================================
// NORMALIZATION (ENUM SAFETY)
// =============================================================================

const HOOK_TYPES: HookType[] = [
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
];

const EMOTIONAL_TRIGGERS: EmotionalTrigger[] = [
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
];

const CTA_STYLES: CtaStyle[] = ['soft', 'medium', 'hard', 'implied'];

const CREATIVE_FORMATS: Array<GeminiAnalysis['creativeExecution']['format']> = [
  'ugc',
  'professional',
  'mixed',
  'animated',
  'slideshow',
];

const TEXT_OVERLAY_DENSITY: Array<GeminiAnalysis['creativeExecution']['textOverlayDensity']> = [
  'none',
  'minimal',
  'moderate',
  'heavy',
];

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string');
  }
  if (typeof value === 'string') {
    return [value];
  }
  return [];
}

function normalizeNumber(value: unknown, fallback: number = 0): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const cleaned = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1'].includes(cleaned)) return true;
    if (['false', 'no', 'n', '0'].includes(cleaned)) return false;
  }
  return fallback;
}

function normalizeHookType(value: unknown): HookType {
  if (typeof value !== 'string') return 'visual';
  const cleaned = value.trim().toLowerCase();
  if (HOOK_TYPES.includes(cleaned as HookType)) return cleaned as HookType;

  if (cleaned.includes('visual') || cleaned.includes('demo') || cleaned.includes('demonstration')) return 'visual';
  if (cleaned.includes('audio') || cleaned.includes('sound') || cleaned.includes('voice')) return 'audio';
  if (cleaned.includes('text') || cleaned.includes('overlay') || cleaned.includes('caption')) return 'text-overlay';
  if (cleaned.includes('question')) return 'question';
  if (cleaned.includes('statement') || cleaned.includes('claim')) return 'statement';
  if (cleaned.includes('social') || cleaned.includes('proof') || cleaned.includes('testimonial') || cleaned.includes('review') || cleaned.includes('authority')) return 'social-proof';
  if (cleaned.includes('pain') || cleaned.includes('problem')) return 'pain-point';
  if (cleaned.includes('curiosity') || cleaned.includes('tease') || cleaned.includes('mystery')) return 'curiosity-gap';
  if (cleaned.includes('before') || cleaned.includes('after') || cleaned.includes('transformation')) return 'before-after';
  if (cleaned.includes('ugc') || cleaned.includes('user') || cleaned.includes('native') || cleaned.includes('selfie')) return 'ugc-native';

  return 'visual';
}

function normalizeEmotionalTrigger(value: unknown): EmotionalTrigger {
  if (typeof value !== 'string') return 'curiosity';
  const cleaned = value.trim().toLowerCase();
  if (EMOTIONAL_TRIGGERS.includes(cleaned as EmotionalTrigger)) return cleaned as EmotionalTrigger;

  if (cleaned.includes('fear') || cleaned.includes('fomo') || cleaned.includes('worry') || cleaned.includes('risk')) return 'fear';
  if (cleaned.includes('desire') || cleaned.includes('aspir') || cleaned.includes('want') || cleaned.includes('dream') || cleaned.includes('beauty')) return 'desire';
  if (cleaned.includes('curios') || cleaned.includes('intrigue') || cleaned.includes('mystery')) return 'curiosity';
  if (cleaned.includes('urgent') || cleaned.includes('limited') || cleaned.includes('scarcity') || cleaned.includes('now')) return 'urgency';
  if (cleaned.includes('social') || cleaned.includes('proof') || cleaned.includes('validation') || cleaned.includes('relat')) return 'social-validation';
  if (cleaned.includes('exclusive') || cleaned.includes('vip')) return 'exclusivity';
  if (cleaned.includes('relief') || cleaned.includes('solution') || cleaned.includes('fix')) return 'relief';
  if (cleaned.includes('excit') || cleaned.includes('energy') || cleaned.includes('fun')) return 'excitement';
  if (cleaned.includes('trust') || cleaned.includes('credib') || cleaned.includes('authority')) return 'trust';
  if (cleaned.includes('humor') || cleaned.includes('funny') || cleaned.includes('joke')) return 'humor';

  return 'curiosity';
}

function normalizeCtaStyle(value: unknown): CtaStyle {
  if (typeof value !== 'string') return 'implied';
  const cleaned = value.trim().toLowerCase();
  if (CTA_STYLES.includes(cleaned as CtaStyle)) return cleaned as CtaStyle;

  if (cleaned.includes('learn') || cleaned.includes('discover') || cleaned.includes('see more')) return 'soft';
  if (cleaned.includes('shop') || cleaned.includes('buy') || cleaned.includes('order') || cleaned.includes('subscribe')) return 'medium';
  if (cleaned.includes('limited') || cleaned.includes('now') || cleaned.includes('urgent') || cleaned.includes('sale')) return 'hard';
  if (cleaned.includes('button')) return 'medium';
  if (cleaned.includes('implied') || cleaned.includes('none')) return 'implied';

  return 'medium';
}

function normalizeCreativeFormat(value: unknown): GeminiAnalysis['creativeExecution']['format'] {
  if (typeof value !== 'string') return 'mixed';
  const cleaned = value.trim().toLowerCase();
  if (CREATIVE_FORMATS.includes(cleaned as GeminiAnalysis['creativeExecution']['format'])) {
    return cleaned as GeminiAnalysis['creativeExecution']['format'];
  }
  if (cleaned.includes('ugc') || cleaned.includes('user')) return 'ugc';
  if (cleaned.includes('professional') || cleaned.includes('studio')) return 'professional';
  if (cleaned.includes('animated') || cleaned.includes('motion')) return 'animated';
  if (cleaned.includes('slide')) return 'slideshow';
  if (cleaned.includes('video')) return 'professional';

  return 'mixed';
}

function normalizeTextOverlayDensity(value: unknown): GeminiAnalysis['creativeExecution']['textOverlayDensity'] {
  if (typeof value !== 'string') return 'minimal';
  const cleaned = value.trim().toLowerCase();
  if (TEXT_OVERLAY_DENSITY.includes(cleaned as GeminiAnalysis['creativeExecution']['textOverlayDensity'])) {
    return cleaned as GeminiAnalysis['creativeExecution']['textOverlayDensity'];
  }
  if (cleaned.includes('none') || cleaned.includes('zero')) return 'none';
  if (cleaned.includes('low') || cleaned.includes('light') || cleaned.includes('minimal')) return 'minimal';
  if (cleaned.includes('medium') || cleaned.includes('moderate')) return 'moderate';
  if (cleaned.includes('high') || cleaned.includes('heavy') || cleaned.includes('dense')) return 'heavy';

  return 'minimal';
}

function normalizeUrgencyType(value: unknown): GeminiAnalysis['cta']['urgencyType'] {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim().toLowerCase();
  if (cleaned.includes('time')) return 'time-limited';
  if (cleaned.includes('quantity') || cleaned.includes('stock') || cleaned.includes('limited')) return 'quantity-limited';
  if (cleaned.includes('price') || cleaned.includes('discount') || cleaned.includes('increase')) return 'price-increase';
  if (cleaned.includes('social')) return 'social-proof';
  if (['time-limited', 'quantity-limited', 'price-increase', 'social-proof'].includes(cleaned)) {
    return cleaned as GeminiAnalysis['cta']['urgencyType'];
  }
  return undefined;
}

export function normalizeGeminiAnalysis(raw: Partial<GeminiAnalysis>): GeminiAnalysis {
  const base = createUnavailableAnalysis('Incomplete AI output');
  const hook = (raw.hook || {}) as Partial<GeminiAnalysis['hook']>;
  const painPoint = (raw.painPoint || {}) as Partial<GeminiAnalysis['painPoint']>;
  const valueProp = (raw.valueProposition || {}) as Partial<GeminiAnalysis['valueProposition']>;
  const emotional = (raw.emotionalTriggers || {}) as Partial<GeminiAnalysis['emotionalTriggers']>;
  const cta = (raw.cta || {}) as Partial<GeminiAnalysis['cta']>;
  const creative = (raw.creativeExecution || {}) as Partial<GeminiAnalysis['creativeExecution']>;
  const marketing = (raw.marketingScore || {}) as Partial<GeminiAnalysis['marketingScore']>;
  const breakdown = (marketing.breakdown || {}) as Partial<GeminiAnalysis['marketingScore']['breakdown']>;

  return {
    meta: {
      ...base.meta,
      ...(raw.meta || {}),
      model: raw.meta?.model || MODEL_NAME,
      analyzedDuration: normalizeNumber(raw.meta?.analyzedDuration, base.meta.analyzedDuration),
      tokensUsed: normalizeNumber(raw.meta?.tokensUsed, base.meta.tokensUsed),
      latencyMs: normalizeNumber(raw.meta?.latencyMs, base.meta.latencyMs),
    },
    hook: {
      type: normalizeHookType(hook.type),
      description: typeof hook.description === 'string' ? hook.description : base.hook.description,
      psychologyExplanation: typeof hook.psychologyExplanation === 'string' ? hook.psychologyExplanation : base.hook.psychologyExplanation,
      effectiveness: normalizeNumber(hook.effectiveness, base.hook.effectiveness),
    },
    painPoint: {
      problem: typeof painPoint.problem === 'string' ? painPoint.problem : base.painPoint.problem,
      framing: typeof painPoint.framing === 'string' ? painPoint.framing : base.painPoint.framing,
      explicit: normalizeBoolean(painPoint.explicit, base.painPoint.explicit),
    },
    valueProposition: {
      mainBenefit: typeof valueProp.mainBenefit === 'string' ? valueProp.mainBenefit : base.valueProposition.mainBenefit,
      secondaryBenefits: normalizeStringArray(valueProp.secondaryBenefits),
      credibilityScore: normalizeNumber(valueProp.credibilityScore, base.valueProposition.credibilityScore),
    },
    emotionalTriggers: {
      primary: normalizeEmotionalTrigger(emotional.primary),
      secondary: normalizeStringArray(emotional.secondary).map(normalizeEmotionalTrigger),
      strategy: typeof emotional.strategy === 'string' ? emotional.strategy : base.emotionalTriggers.strategy,
    },
    cta: {
      text: typeof cta.text === 'string' ? cta.text : cta.text === null ? null : base.cta.text,
      style: normalizeCtaStyle(cta.style),
      hasUrgency: normalizeBoolean(cta.hasUrgency, base.cta.hasUrgency),
      urgencyType: normalizeUrgencyType(cta.urgencyType),
    },
    creativeExecution: {
      format: normalizeCreativeFormat(creative.format),
      hasFace: normalizeBoolean(creative.hasFace, base.creativeExecution.hasFace),
      hasVoice: normalizeBoolean(creative.hasVoice, base.creativeExecution.hasVoice),
      textOverlayDensity: normalizeTextOverlayDensity(creative.textOverlayDensity),
      dominantColors: normalizeStringArray(creative.dominantColors),
      productionQuality: normalizeNumber(creative.productionQuality, base.creativeExecution.productionQuality),
    },
    marketingScore: {
      overall: normalizeNumber(marketing.overall, base.marketingScore.overall),
      breakdown: {
        hookStrength: normalizeNumber(breakdown.hookStrength, base.marketingScore.breakdown.hookStrength),
        messagingClarity: normalizeNumber(breakdown.messagingClarity, base.marketingScore.breakdown.messagingClarity),
        emotionalResonance: normalizeNumber(breakdown.emotionalResonance, base.marketingScore.breakdown.emotionalResonance),
        ctaEffectiveness: normalizeNumber(breakdown.ctaEffectiveness, base.marketingScore.breakdown.ctaEffectiveness),
        productionValue: normalizeNumber(breakdown.productionValue, base.marketingScore.breakdown.productionValue),
      },
    },
    swipeFileSummary: typeof raw.swipeFileSummary === 'string' ? raw.swipeFileSummary : base.swipeFileSummary,
    replicationTips: normalizeStringArray(raw.replicationTips),
  };
}

// =============================================================================
// PROMPT ENGINEERING
// =============================================================================

/**
 * Build the analysis prompt with context
 */
function buildAnalysisPrompt(ad: AdEntity, analysisSeconds: number): string {
  const contextLines: string[] = [];
  const stripInjectedAdLinkPrefix = (value: string): string =>
    value
      .replace(/^[\s\S]{0,80}AD LINK \(DO NOT HIDE\):\s*https?:\/\/\S+\s*/i, '')
      .trim();
  
  if (ad.advertiser.name) {
    contextLines.push(`Advertiser: ${ad.advertiser.name}`);
  }
  if (ad.advertiser.domain) {
    contextLines.push(`Domain: ${ad.advertiser.domain}`);
  }
  if (ad.creative.bodyText) {
    const cleanBody = stripInjectedAdLinkPrefix(ad.creative.bodyText);
    contextLines.push(`Ad Copy: "${cleanBody.slice(0, 200)}..."`);
  }
  if (ad.timing.activeDays > 0) {
    contextLines.push(`Running for: ${ad.timing.activeDays} days (${ad.timing.longevityStatus})`);
  }

  const contextSection = contextLines.length > 0 
    ? `\n\nCONTEXT:\n${contextLines.join('\n')}`
    : '';

  return `${GEMINI_ANALYSIS_PROMPT}${contextSection}

IMPORTANT:
- For video, focus on the first ${analysisSeconds} seconds (the part that decides performance).
- THE FIRST 3 SECONDS ARE THE HOOK and matter most: ~70% of viewers decide to keep
  watching or scroll away within those 3s, and the vast majority of high-performing
  ads land their hook there. Describe the hook (visual + audio + on-screen text) in
  detail, then explain how it transitions into the pain point, value prop, and CTA
  across the rest of the window.
- "hook.effectiveness" should reflect how strongly those first 3 seconds stop the scroll.
- Return valid JSON matching the GeminiAnalysis schema
- Be specific and actionable in your analysis

Return the analysis as a JSON object with this exact structure:
{
  "meta": { "model": "gemini-2.5-flash", "analyzedDuration": number, "tokensUsed": 0, "latencyMs": 0 },
  "hook": { "type": string, "description": string, "psychologyExplanation": string, "effectiveness": number },
  "painPoint": { "problem": string, "framing": string, "explicit": boolean },
  "valueProposition": { "mainBenefit": string, "secondaryBenefits": string[], "credibilityScore": number },
  "emotionalTriggers": { "primary": string, "secondary": string[], "strategy": string },
  "cta": { "text": string|null, "style": string, "hasUrgency": boolean, "urgencyType": string|null },
  "creativeExecution": { "format": string, "hasFace": boolean, "hasVoice": boolean, "textOverlayDensity": string, "dominantColors": string[], "productionQuality": number },
  "marketingScore": { "overall": number, "breakdown": { "hookStrength": number, "messagingClarity": number, "emotionalResonance": number, "ctaEffectiveness": number, "productionValue": number } },
  "swipeFileSummary": string,
  "replicationTips": string[]
}`;
}

/**
 * Create the default "unavailable" analysis for error cases
 */
function createUnavailableAnalysis(reason: string): GeminiAnalysis {
  return {
    meta: {
      model: MODEL_NAME,
      analyzedDuration: 0,
      tokensUsed: 0,
      latencyMs: 0,
    },
    hook: {
      type: 'visual' as HookType,
      description: `Analysis unavailable: ${reason}`,
      psychologyExplanation: 'N/A',
      effectiveness: 0,
    },
    painPoint: {
      problem: 'Unable to analyze',
      framing: 'N/A',
      explicit: false,
    },
    valueProposition: {
      mainBenefit: 'Unable to analyze',
      secondaryBenefits: [],
      credibilityScore: 0,
    },
    emotionalTriggers: {
      primary: 'curiosity' as EmotionalTrigger,
      secondary: [],
      strategy: 'N/A',
    },
    cta: {
      text: null,
      style: 'implied' as CtaStyle,
      hasUrgency: false,
    },
    creativeExecution: {
      format: 'ugc',
      hasFace: false,
      hasVoice: false,
      textOverlayDensity: 'none',
      dominantColors: [],
      productionQuality: 0,
    },
    marketingScore: {
      overall: 0,
      breakdown: {
        hookStrength: 0,
        messagingClarity: 0,
        emotionalResonance: 0,
        ctaEffectiveness: 0,
        productionValue: 0,
      },
    },
    swipeFileSummary: `Analysis could not be completed: ${reason}`,
    replicationTips: [],
  };
}

// =============================================================================
// MEDIA RESOLUTION (TikTok + Appwrite)
// =============================================================================

function getAnalysisSeconds(ad: AdEntity): number {
  if (ad.platform === 'tiktok') {
    return Number.isFinite(TIKTOK_ANALYSIS_SECONDS) && TIKTOK_ANALYSIS_SECONDS > 0
      ? TIKTOK_ANALYSIS_SECONDS
      : MAX_ANALYSIS_DURATION_SECONDS;
  }
  return MAX_ANALYSIS_DURATION_SECONDS;
}

function shouldUseVideoForAnalysis(ad: AdEntity): boolean {
  if (ad.creative.type !== 'video' || !ad.creative.MANDATORY_VISUAL_PROOF_URL) {
    return false;
  }
  if (ad.platform !== 'tiktok') {
    return true;
  }
  return TIKTOK_ANALYSIS_MODE === 'video';
}

function getVideoRangeCandidates(): number[] {
  if (Number.isFinite(TIKTOK_VIDEO_RANGE_BYTES) && TIKTOK_VIDEO_RANGE_BYTES > 0) {
    return [Math.floor(TIKTOK_VIDEO_RANGE_BYTES), 0];
  }
  return [0];
}

async function fetchBinaryWithLimit(
  url: string,
  maxBytes: number,
  rangeBytes: number
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const headers: Record<string, string> = { ...MEDIA_FETCH_HEADERS };
  if (rangeBytes > 0) {
    headers.Range = `bytes=0-${rangeBytes - 1}`;
  }

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(GEMINI_MEDIA_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch media: ${response.status}`);
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`Media exceeds max size (${contentLength} bytes > ${maxBytes})`);
  }

  const contentType = response.headers.get('content-type');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(`Media exceeds max size (${buffer.length} bytes > ${maxBytes})`);
  }

  return { buffer, contentType };
}

function normalizeMimeType(contentType: string | null, fallback: string): string {
  if (!contentType) {
    return fallback;
  }
  const [mime] = contentType.split(';').map((part) => part.trim());
  return mime || fallback;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutLabel: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${timeoutLabel}_after_${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function cacheTikTokVideoInAppwrite(videoBuffer: Buffer, contentType: string, adId: string): Promise<string | null> {
  if (!isAppwriteConfigured()) {
    return null;
  }

  try {
    const filename = `${adId || 'tiktok'}-${Date.now()}.mp4`;
    const uploaded = await uploadBufferToAppwrite({
      buffer: videoBuffer,
      filename,
      contentType,
    });
    return uploaded?.url || null;
  } catch (error) {
    console.warn('[GeminiService] Failed to upload TikTok video copy to Appwrite:', error);
    return null;
  }
}

// =============================================================================
// TEXT-ONLY FALLBACK (when media URLs return 403/expired)
// =============================================================================

/**
 * Analyze an ad using ONLY text context (bodyText, CTA, advertiser, timing).
 * Used when both video and image URLs fail (e.g., expired CDN links, 403).
 * Still provides useful hook/CTA/pain-point analysis from the ad copy.
 */
async function attemptTextOnlyAnalysis(
  model: GenerativeModel,
  ad: AdEntity,
  _originalPrompt: string,
  startTime: number,
): Promise<GeminiAnalysisResult> {
  const bodyText = ad.creative.bodyText || '';
  const ctaText = ad.creative.ctaText || '';
  const landingUrl = ad.creative.landingUrl || '';

  // Need at least some text to analyze
  if (!bodyText && !ctaText) {
    return {
      success: false,
      analysis: createUnavailableAnalysis('No media or ad copy available for analysis'),
      error: { code: 'VIDEO_UNAVAILABLE', message: 'No media or ad copy available' },
      cost: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    };
  }

  // Strip injected creative URL prefix from bodyText for cleaner text analysis.
  const cleanBody = bodyText
    .replace(/^[\s\S]{0,80}AD LINK \(DO NOT HIDE\):\s*https?:\/\/\S+\s*/i, '')
    .trim();

  const textPrompt = `You are analyzing a Facebook/TikTok ad based on its TEXT ONLY (the image/video was unavailable).
Analyze the ad copy, CTA, and context to provide marketing insights.

AD COPY:
"${cleanBody.slice(0, 500)}"

CTA BUTTON: "${ctaText}"
LANDING URL: ${landingUrl}
ADVERTISER: ${ad.advertiser.name}
DOMAIN: ${ad.advertiser.domain || 'unknown'}
RUNNING FOR: ${ad.timing.activeDays} days (${ad.timing.longevityStatus})
FORMAT: ${ad.creative.type || 'unknown'}

NOTE: Since you cannot see the visual creative, focus your analysis on:
- The text hook (first line of copy)
- Pain points addressed in the copy
- CTA strategy
- Emotional triggers in the language
- Why this ad might be running for ${ad.timing.activeDays} days (longevity = profitability signal)

For visual-specific fields (hasFace, dominantColors, etc.), set reasonable defaults.

Return valid JSON matching the GeminiAnalysis schema:
{
  "meta": { "model": "gemini-2.5-flash", "analyzedDuration": 0, "tokensUsed": 0, "latencyMs": 0 },
  "hook": { "type": string, "description": string, "psychologyExplanation": string, "effectiveness": number },
  "painPoint": { "problem": string, "framing": string, "explicit": boolean },
  "valueProposition": { "mainBenefit": string, "secondaryBenefits": string[], "credibilityScore": number },
  "emotionalTriggers": { "primary": string, "secondary": string[], "strategy": string },
  "cta": { "text": string|null, "style": string, "hasUrgency": boolean, "urgencyType": string|null },
  "creativeExecution": { "format": string, "hasFace": false, "hasVoice": false, "textOverlayDensity": "unknown", "dominantColors": [], "productionQuality": 5 },
  "marketingScore": { "overall": number, "breakdown": { "hookStrength": number, "messagingClarity": number, "emotionalResonance": number, "ctaEffectiveness": number, "productionValue": 5 } },
  "swipeFileSummary": string,
  "replicationTips": string[]
}`;

  try {
    console.log(`[GeminiService] Text-only fallback analysis for ${ad.adId} (${cleanBody.length} chars of copy)`);
    const result = await withTimeout(
      model.generateContent([textPrompt]),
      GEMINI_GENERATION_TIMEOUT_MS,
      'gemini_text_generation_timeout',
    );
    const response = result.response;
    const text = response.text();

    let analysis: GeminiAnalysis;
    try {
      analysis = JSON.parse(text);
    } catch {
      console.error('[GeminiService] Text-only fallback: failed to parse JSON:', text.slice(0, 300));
      return {
        success: false,
        analysis: createUnavailableAnalysis('Text-only analysis returned invalid JSON'),
        error: { code: 'PROCESSING_ERROR', message: 'Text-only analysis returned invalid JSON' },
        cost: estimateCost(textPrompt.length, text.length, false),
      };
    }

    analysis = normalizeGeminiAnalysis(analysis);
    const latencyMs = Date.now() - startTime;
    const tokenEstimate = estimateTokens(textPrompt, text, false);

    analysis.meta = {
      ...analysis.meta,
      model: MODEL_NAME,
      analyzedDuration: 0,
      tokensUsed: tokenEstimate.total,
      latencyMs,
    };

    // Flag that this was text-only in swipeFileSummary
    analysis.swipeFileSummary = `[Text-only analysis — visual unavailable] ${analysis.swipeFileSummary}`;

    console.log(`[GeminiService] Text-only analysis complete in ${latencyMs}ms, score: ${analysis.marketingScore.overall}/10`);
    return {
      success: true,
      analysis,
      cost: { inputTokens: tokenEstimate.input, outputTokens: tokenEstimate.output, estimatedCostUsd: tokenEstimate.cost },
    };
  } catch (error) {
    console.error('[GeminiService] Text-only fallback also failed:', error);
    return {
      success: false,
      analysis: createUnavailableAnalysis((error as Error).message),
      error: { code: 'PROCESSING_ERROR', message: (error as Error).message },
      cost: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    };
  }
}

// =============================================================================
// CONNECTIVITY VALIDATION
// =============================================================================

/**
 * Live connectivity check for the Gemini API. Makes ONE minimal text-only call
 * to confirm the configured GEMINI_API_KEY actually works — this catches invalid
 * or expired keys, billing/permission problems, and "model not found" errors
 * that a presence check (isGeminiConfigured) cannot.
 *
 * It does cost a few tokens, so it is meant for health checks / startup
 * diagnostics, NOT for the per-request hot path.
 */
export async function validateGeminiConnection(): Promise<{
  ok: boolean;
  configured: boolean;
  model: string;
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  if (!isGeminiConfigured()) {
    return { ok: false, configured: false, model: MODEL_NAME, latencyMs: 0, error: 'GEMINI_API_KEY not set' };
  }
  try {
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });
    const result = await withTimeout(
      model.generateContent('Reply with the single word: ok'),
      GEMINI_GENERATION_TIMEOUT_MS,
      'gemini_validation_timeout',
    );
    const text = (result.response.text() || '').trim();
    return { ok: text.length > 0, configured: true, model: MODEL_NAME, latencyMs: Date.now() - start };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      model: MODEL_NAME,
      latencyMs: Date.now() - start,
      error: (error as Error).message,
    };
  }
}

// =============================================================================
// MAIN ANALYSIS FUNCTION
// =============================================================================

/**
 * Analyze an ad creative using Gemini 2.5 Flash
 * 
 * COST BREAKDOWN:
 * - Video (first 10s): ~500-800 tokens input (sampled frames)
 * - Prompt: ~300 tokens
 * - Response: ~500-800 tokens output
 * - Total cost: ~$0.0001 input + ~$0.0004 output = ~$0.0005 per analysis
 * 
 * @param ad - The AdEntity to analyze
 * @returns GeminiAnalysisResult with analysis or error
 */
export async function analyzeAdCreative(ad: AdEntity): Promise<GeminiAnalysisResult> {
  const startTime = Date.now();
  
  // Determine which media to analyze
  const analysisSeconds = getAnalysisSeconds(ad);
  const preferVideo = shouldUseVideoForAnalysis(ad);
  const snapshotUrl = ad.creative.REQUIRED_LINK_FOR_USER;

  if (!preferVideo && !snapshotUrl) {
    return {
      success: false,
      error: {
        code: 'VIDEO_UNAVAILABLE',
        message: 'No media URL available for analysis',
      },
      cost: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    };
  }

  try {
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      safetySettings: SAFETY_SETTINGS,
      generationConfig: GENERATION_CONFIG,
    });

    // Build the prompt with context
    const prompt = buildAnalysisPrompt(ad, analysisSeconds);

    // Prepare media input based on type
    let result;
    let isVideoAnalysis = false;

    if (preferVideo && ad.creative.MANDATORY_VISUAL_PROOF_URL) {
      const rangeCandidates = getVideoRangeCandidates();
      let lastVideoError: unknown = null;

      for (const rangeBytes of rangeCandidates) {
        try {
          const { buffer, contentType } = await fetchBinaryWithLimit(
            ad.creative.MANDATORY_VISUAL_PROOF_URL,
            TIKTOK_MAX_VIDEO_BYTES,
            rangeBytes
          );
          const mimeType = normalizeMimeType(contentType, 'video/mp4');
          const base64Data = buffer.toString('base64');

          if (ad.platform === 'tiktok') {
            // Optional best-effort traceability copy. Disabled by default to avoid adding latency.
            if (CACHE_TIKTOK_VIDEO_COPY) {
              cacheTikTokVideoInAppwrite(buffer, mimeType, ad.adId)
                .then((hostedUrl) => {
                  if (hostedUrl) {
                    console.log(`[GeminiService] TikTok video cached in Appwrite: ${hostedUrl.slice(0, 80)}...`);
                  }
                })
                .catch((error) => {
                  console.warn('[GeminiService] TikTok Appwrite cache async failure:', error);
                });
            }
          }

          const mode = rangeBytes > 0 ? `range ${rangeBytes}B` : 'full';
          console.log(`[GeminiService] Analyzing video payload (${mode}, ${mimeType}, ${buffer.length} bytes)`);

          isVideoAnalysis = true;
          result = await withTimeout(
            model.generateContent([
              prompt,
              {
                inlineData: {
                  mimeType,
                  data: base64Data,
                },
              },
            ]),
            GEMINI_GENERATION_TIMEOUT_MS,
            'gemini_video_generation_timeout',
          );
          break;
        } catch (videoError) {
          lastVideoError = videoError;
          const mode = rangeBytes > 0 ? `range ${rangeBytes}B` : 'full';
          console.warn(`[GeminiService] Video analysis attempt failed (${mode}):`, videoError);
        }
      }

      if (!result && lastVideoError) {
        console.warn('[GeminiService] Video analysis path failed, falling back to image.');
      }
    }

    if (!result) {
      if (!snapshotUrl) {
        // No snapshot URL — try text-only analysis as last resort
        return await attemptTextOnlyAnalysis(model, ad, prompt, startTime);
      }

      // Step 1 — fetch the media. A failure here (403, expired CDN, unsupported
      // type) IS recoverable: fall back to text-only analysis.
      let fallbackMedia: { data: string; mimeType: string };
      try {
        fallbackMedia = await fetchInlineMedia(snapshotUrl);
        const fallbackMime = fallbackMedia.mimeType.toLowerCase();
        if (!fallbackMime.startsWith('image/') && !fallbackMime.startsWith('video/')) {
          throw new Error(`Unsupported fallback media type: ${fallbackMedia.mimeType}`);
        }
      } catch (mediaError) {
        // Media URL itself failed (403, expired CDN, unsupported type).
        console.warn(`[GeminiService] Media fetch failed: ${(mediaError as Error).message}. Trying text-only analysis.`);
        return await attemptTextOnlyAnalysis(model, ad, prompt, startTime);
      }

      // Step 2 — call Gemini. A failure HERE (invalid API key, quota, model not
      // found) is NOT a media problem and must NOT be masked as one. Let it
      // propagate to the outer catch so the real error surfaces in the result
      // instead of a misleading "no media available" message.
      isVideoAnalysis = fallbackMedia.mimeType.toLowerCase().startsWith('video/');
      const fallbackKind = isVideoAnalysis ? 'video' : 'image';
      console.log(`[GeminiService] Analyzing fallback ${fallbackKind}: ${snapshotUrl.slice(0, 80)}...`);
      result = await withTimeout(
        model.generateContent([
          prompt,
          {
            inlineData: {
              mimeType: fallbackMedia.mimeType,
              data: fallbackMedia.data,
            },
          },
        ]),
        GEMINI_GENERATION_TIMEOUT_MS,
        'gemini_fallback_generation_timeout',
      );
    }

    const response = result.response;
    const text = response.text();
    
    // Parse the JSON response
    let analysis: GeminiAnalysis;
    try {
      analysis = JSON.parse(text);
    } catch (parseError) {
      console.error('[GeminiService] Failed to parse JSON response:', text.slice(0, 500));
      const reason = 'Failed to parse AI response as JSON';
      return {
        success: false,
        analysis: createUnavailableAnalysis(reason),
        error: {
          code: 'PROCESSING_ERROR',
          message: reason,
        },
        cost: estimateCost(prompt.length, text.length, isVideoAnalysis),
      };
    }

    analysis = normalizeGeminiAnalysis(analysis);

    // Update metadata with actual values
    const latencyMs = Date.now() - startTime;
    const tokenEstimate = estimateTokens(prompt, text, isVideoAnalysis);
    
    analysis.meta = {
      ...analysis.meta,
      model: MODEL_NAME,
      analyzedDuration: isVideoAnalysis ? analysisSeconds : 0,
      tokensUsed: tokenEstimate.total,
      latencyMs,
    };

    console.log(`[GeminiService] Analysis complete in ${latencyMs}ms, score: ${analysis.marketingScore.overall}/10`);

    return {
      success: true,
      analysis,
      cost: {
        inputTokens: tokenEstimate.input,
        outputTokens: tokenEstimate.output,
        estimatedCostUsd: tokenEstimate.cost,
      },
    };

  } catch (error) {
    const latencyMs = Date.now() - startTime;
    console.error(`[GeminiService] Analysis failed after ${latencyMs}ms:`, error);

    // Determine error type for graceful handling
    const errorMessage = (error as Error).message || 'Unknown error';
    type ErrorCode = 'VIDEO_UNAVAILABLE' | 'PROCESSING_ERROR' | 'RATE_LIMITED' | 'INVALID_FORMAT';
    let errorCode: ErrorCode = 'PROCESSING_ERROR';
    
    if (errorMessage.includes('rate limit') || errorMessage.includes('quota')) {
      errorCode = 'RATE_LIMITED';
    } else if (errorMessage.includes('format') || errorMessage.includes('unsupported')) {
      errorCode = 'INVALID_FORMAT';
    } else if (errorMessage.includes('not found') || errorMessage.includes('404')) {
      errorCode = 'VIDEO_UNAVAILABLE';
    }

    return {
      success: false,
      analysis: createUnavailableAnalysis(errorMessage),
      error: {
        code: errorCode,
        message: errorMessage,
      },
      cost: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    };
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Fetch media URL and return base64 payload + detected mime type.
 */
async function fetchInlineMedia(url: string): Promise<{ data: string; mimeType: string }> {
  try {
    const response = await fetch(url, {
      headers: MEDIA_FETCH_HEADERS,
      signal: AbortSignal.timeout(GEMINI_MEDIA_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch media: ${response.status}`);
    }

    const contentType = response.headers.get('content-type');
    const mimeType = normalizeMimeType(contentType, 'image/jpeg');
    const buffer = await response.arrayBuffer();

    return {
      data: Buffer.from(buffer).toString('base64'),
      mimeType,
    };
  } catch (error) {
    console.error('[GeminiService] Failed to fetch media:', error);
    throw error;
  }
}

/**
 * Estimate token usage and cost
 * Rough estimates based on character count (4 chars ≈ 1 token)
 */
function estimateTokens(
  prompt: string,
  response: string,
  isVideo: boolean = true
): { input: number; output: number; total: number; cost: number } {
  const inputTokens = Math.ceil(prompt.length / 4);
  const outputTokens = Math.ceil(response.length / 4);
  
  // Add ~500 tokens for video frame processing if applicable
  const totalInput = inputTokens + (isVideo ? 500 : 0);
  
  const inputCost = (totalInput / 1_000_000) * GEMINI_PRICING.inputTokensPer1M;
  const outputCost = (outputTokens / 1_000_000) * GEMINI_PRICING.outputTokensPer1M;
  
  return {
    input: totalInput,
    output: outputTokens,
    total: totalInput + outputTokens,
    cost: inputCost + outputCost,
  };
}

/**
 * Estimate cost from character lengths
 */
function estimateCost(
  promptLength: number,
  responseLength: number,
  isVideo: boolean = true
): GeminiAnalysisResult['cost'] {
  const tokens = estimateTokens('x'.repeat(promptLength), 'x'.repeat(responseLength), isVideo);
  return {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    estimatedCostUsd: tokens.cost,
  };
}

// =============================================================================
// BATCH ANALYSIS
// =============================================================================

/**
 * Analyze multiple ads in parallel (with concurrency limit)
 * 
 * COST EFFICIENCY:
 * - Max 3 concurrent requests to avoid rate limits
 * - Failed analyses don't block successful ones
 * - Returns partial results if some fail
 * 
 * @param ads - Array of AdEntity to analyze
 * @param maxConcurrent - Maximum parallel requests (default: 3)
 * @returns Array of results (analysis or error for each)
 */
export async function analyzeAdsInBatch(
  ads: AdEntity[],
  maxConcurrent: number = 3
): Promise<GeminiAnalysisResult[]> {
  const results: GeminiAnalysisResult[] = [];
  
  // Process in batches
  for (let i = 0; i < ads.length; i += maxConcurrent) {
    const batch = ads.slice(i, i + maxConcurrent);
    const batchSettled = await Promise.allSettled(
      batch.map((ad) => analyzeAdCreative(ad))
    );
    // Keep fulfilled results, create error results for failures
    for (let j = 0; j < batchSettled.length; j++) {
      const r = batchSettled[j];
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        console.error(`[Gemini] Batch analysis failed for ad ${batch[j]?.adId}:`, r.reason);
        results.push({
          success: false,
          error: { message: String(r.reason), code: 'PROCESSING_ERROR' as const },
          cost: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        });
      }
    }
    
    // Small delay between batches to respect rate limits
    if (i + maxConcurrent < ads.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  
  return results;
}

/**
 * Get total cost from batch results
 */
export function calculateBatchCost(results: GeminiAnalysisResult[]): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  successCount: number;
  failureCount: number;
} {
  return results.reduce(
    (acc, result) => ({
      totalInputTokens: acc.totalInputTokens + result.cost.inputTokens,
      totalOutputTokens: acc.totalOutputTokens + result.cost.outputTokens,
      totalCostUsd: acc.totalCostUsd + result.cost.estimatedCostUsd,
      successCount: acc.successCount + (result.success ? 1 : 0),
      failureCount: acc.failureCount + (result.success ? 0 : 1),
    }),
    { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, successCount: 0, failureCount: 0 }
  );
}
