/**
 * AdWinner Intel - Ad Entity Types
 * 
 * Unified data structures for ads from Facebook Ad Library and TikTok keyword search results.
 * These types normalize the different API responses into a single, consistent format.
 */

// =============================================================================
// ENUMS & CONSTANTS
// =============================================================================

/**
 * Supported advertising platforms
 */
export type AdPlatform = 'facebook' | 'tiktok' | 'instagram';

/**
 * Longevity status based on the "14-day rule"
 * - 'winner': Ad running >= 14 days (proven profitable)
 * - 'test': Ad running < 14 days (still in testing phase)
 */
export type LongevityStatus = 'winner' | 'test';

/**
 * Creative format types
 */
export type CreativeType = 'video' | 'image' | 'carousel';

/**
 * Impression volume tiers (Facebook uses ranges, not exact numbers)
 */
export type ImpressionTier = 'low' | 'medium' | 'high' | 'viral';

// =============================================================================
// CORE AD ENTITY
// =============================================================================

/**
 * Unified Ad Entity
 * 
 * Normalizes data from:
 * - Facebook Ad Library (via Apify: curious_coder/facebook-ads-library-scraper)
 * - TikTok keyword search results (via Apify: apidojo/tiktok-scraper)
 */
export interface AdEntity {
  /** Unique identifier (platform-prefixed: fb_xxx or tt_xxx) */
  adId: string;

  /** Source platform */
  platform: AdPlatform;

  /** Advertiser information */
  advertiser: {
    /** Page/Brand name */
    name: string;
    /** Page ID (Facebook) or Brand ID (TikTok) */
    id: string;
    /** Advertiser domain (e.g., 'glossier.com') - used for cross-platform matching */
    domain?: string;
  };

  /** Creative asset URLs */
  creative: {
    /** URL to ad snapshot/thumbnail (image) */
    REQUIRED_LINK_FOR_USER: string;
    /** URL to video asset (if video ad) */
    MANDATORY_VISUAL_PROOF_URL?: string;
    /** Creative format type */
    type: CreativeType;
    /** Ad copy / body text */
    bodyText?: string;
    /** CTA button text */
    ctaText?: string;
    /** Landing page URL */
    landingUrl?: string;
  };

  /** Temporal data */
  timing: {
    /** When the ad started running (ISO 8601) */
    startDate: string;
    /** When the ad stopped (null if still active) */
    endDate?: string | null;
    /** Calculated: days the ad has been running */
    activeDays: number;
    /** Derived from activeDays >= LONGEVITY_THRESHOLD (14 days) */
    longevityStatus: LongevityStatus;
  };

  /** Performance indicators (when available) */
  performance?: {
    /** Facebook: impression range bucket */
    impressionTier?: ImpressionTier;
    /** Facebook: lower bound of impression range */
    impressionsLower?: number;
    /** Facebook: upper bound of impression range */
    impressionsUpper?: number;
    /** TikTok: CTR if available */
    ctr?: number;
    /** TikTok: likes count */
    likes?: number;
    /** TikTok: views/play count */
    views?: number;
    /** TikTok: shares count */
    shares?: number;
    /** TikTok: comments count */
    comments?: number;
    /** TikTok: bookmark/favorites count */
    bookmarks?: number;
  };

  /** Targeting information (when available) */
  targeting?: {
    /** Country codes where ad is shown */
    countries?: string[];
    /** Age range */
    ageRange?: { min: number; max: number };
    /** Gender distribution */
    genderSplit?: { male: number; female: number; unknown: number };
  };

  /** Cross-platform intelligence */
  intelligence?: {
    /** True if same advertiser has ads on multiple platforms */
    globalWinner: boolean;
    /** Profitability score (0-100) */
    profitabilityScore?: number;
    /** Other platform IDs where this advertiser runs ads */
    crossPlatformAdIds?: string[];
    /** Engagement rate percentage (TikTok) */
    engagementRate?: number;
    /** Hashtags/challenges associated with the content */
    hashtags?: string[];
    /** True if commercial intent detected via text patterns, brand-keyword match, or provider flags */
    highIntent?: boolean;
  };

  /** Metadata */
  meta: {
    /** When this record was fetched/created */
    fetchedAt: string;
    /** Direct link to ad in platform's ad library */
    adLibraryUrl: string;
    /** Data source platform identifier */
    source: 'facebook' | 'tiktok';
    /** Appwrite Storage file ID for cached creative (used for cleanup after analysis) */
    appwriteFileId?: string;
  };
}

// =============================================================================
// PLATFORM-SPECIFIC RAW TYPES (for Apify response mapping)
// =============================================================================

/**
 * Raw Facebook Ad Library response (from Apify: curious_coder/facebook-ads-library-scraper)
 * This is what we receive before normalization.
 * 
 * @see https://apify.com/curious_coder/facebook-ads-library-scraper
 */
export interface RawFacebookAd {
  // Core identifiers
  adArchiveId?: string;
  adArchiveID?: string;
  adId?: string | null;
  ad_id?: string | null;
  ad_archive_id?: string;
  id?: string;

  // Page/Advertiser info
  pageId?: string;
  pageID?: string;
  page_id?: string;
  pageName?: string;
  page_name?: string;
  pageInfo?: {
    page?: {
      name?: string;
      id?: string;
    };
  };

  // Status & dates (Unix timestamps)
  isActive?: boolean;
  startDate?: number; // Unix timestamp
  endDate?: number;  // Unix timestamp
  startDateFormatted?: string; // ISO date
  endDateFormatted?: string;   // ISO date
  start_date?: number | string;
  end_date?: number | string;

  // Publisher platforms
  publisherPlatform?: string[];
  publisher_platform?: string[];

  // Snapshot contains all creative details
  snapshot?: {
    body?: { text?: string };
    title?: string;
    caption?: string;
    ctaText?: string;
    cta_text?: string;
    ctaType?: string;
    linkUrl?: string;
    link_url?: string;
    linkDescription?: string;
    displayFormat?: string;
    display_format?: string;
    images?: Array<{
      originalImageUrl?: string;
      resizedImageUrl?: string;
      original_image_url?: string;
      resized_image_url?: string;
    }>;
    videos?: Array<{
      videoHdUrl?: string;
      videoSdUrl?: string;
      videoPreviewImageUrl?: string;
      video_hd_url?: string;
      video_sd_url?: string;
      video_preview_image_url?: string;
    }>;
    cards?: Array<{
      body?: string;
      title?: string;
      linkUrl?: string;
      link_url?: string;
      originalImageUrl?: string;
      resizedImageUrl?: string;
      original_image_url?: string;
      resized_image_url?: string;
      videoHdUrl?: string;
      videoSdUrl?: string;
      videoPreviewImageUrl?: string;
      video_hd_url?: string;
      video_sd_url?: string;
      video_preview_image_url?: string;
    }>;
    pageName?: string;
    pageId?: string;
    page_name?: string;
    page_id?: string;
    pageProfilePictureUrl?: string;
    pageProfileUri?: string;
    pageLikeCount?: number;
    pageCategories?: string[];
  };

  // Performance (when available)
  impressionsWithIndex?: {
    impressionsText?: string | null;
    impressionsIndex?: number;
  };
  impressions_with_index?: {
    impressions_text?: string | null;
    impressions_index?: number;
  };
  impressions?: {
    lower_bound: string;
    upper_bound: string;
  };

  // Categories and targeting
  categories?: string[];
  targetedOrReachedCountries?: string[];
  targeted_or_reached_countries?: string[];

  // Metadata
  contains_digital_created_media?: boolean;
  contains_sensitive_content?: boolean;
  gated_type?: string;

  // Legacy fields for backwards compatibility
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_captions?: string[];
  ad_creative_link_titles?: string[];
  ad_snapshot_url?: string;
  demographic_distribution?: Array<{
    age: string;
    gender: string;
    percentage: string;
  }>;
}

/**
 * Raw TikTok post structure — supports both apidojo/tiktok-scraper (primary)
 * and clockworks/free-tiktok-scraper (legacy/cached data)
 *
 * apidojo: $0.30/1K results, uses title/views/likes/channel/postPage
 * clockworks: $5.00/1K results (deprecated), uses text/playCount/diggCount/authorMeta
 *
 * @see https://apify.com/apidojo/tiktok-scraper
 */
export interface RawTikTokPost {
  id?: string;
  // apidojo format
  title?: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  bookmarks?: number;
  channel?: {
    name?: string;
    username?: string;
    bio?: string;
    id?: string;
    url?: string;
    avatar?: string;
    verified?: boolean;
    followers?: number;
    following?: number;
    videos?: number;
  };
  video?: {
    url?: string;
    cover?: string;
    thumbnail?: string;
    width?: number;
    height?: number;
    duration?: number;
    ratio?: string;
  };
  song?: {
    id?: number;
    title?: string;
    artist?: string;
    album?: string;
    duration?: number;
    cover?: string;
  };
  postPage?: string;
  uploadedAt?: number;
  uploadedAtFormatted?: string;
  // clockworks format (backwards compat for cached data)
  text?: string;
  desc?: string;
  createTime?: number;
  createTimeISO?: string;
  authorMeta?: {
    name?: string;
    nickName?: string;
    nickname?: string;
    id?: string;
    authorId?: string;
    profileUrl?: string;
    avatar?: string;
  };
  author?: {
    uniqueId?: string;
    nickname?: string;
    id?: string;
    name?: string;
  };
  diggCount?: number;
  shareCount?: number;
  commentCount?: number;
  playCount?: number;
  collectCount?: number;
  stats?: {
    diggCount?: number;
    shareCount?: number;
    commentCount?: number;
    playCount?: number;
    collectCount?: number;
  };
  videoMeta?: {
    duration?: number;
    coverUrl?: string;
    originalCoverUrl?: string;
    cover?: string;
    playAddr?: string;
    downloadAddr?: string;
    videoUrl?: string;
    downloadUrl?: string;
  };
  webVideoUrl?: string;
  videoUrl?: string;
  downloadedVideoUrl?: string;
  hashtags?: Array<{ name?: string; id?: string } | string>;
  challenges?: Array<{ title?: string }>;
  [key: string]: unknown;
}

// =============================================================================
// UTILITY TYPES
// =============================================================================

/**
 * Parameters for fetching ads by domain
 */
export interface DomainQueryParams {
  domain: string;
  country?: string;
  platform?: AdPlatform | 'all';
  minLongevityDays?: number;
  limit?: number;
}

/**
 * Result of a domain analysis query
 */
export interface DomainAnalysisResult {
  domain: string;
  queryParams: DomainQueryParams;
  totalAdsFound: number;
  winnersCount: number;
  ads: AdEntity[];
  queriedAt: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * The magic number: ads running >= this many days are considered "winners"
 */
export const LONGEVITY_THRESHOLD_DAYS = 14;

/**
 * Impression tier mappings (Facebook uses string ranges)
 */
export const IMPRESSION_TIERS: Record<ImpressionTier, { min: number; max: number }> = {
  low: { min: 0, max: 10_000 },
  medium: { min: 10_001, max: 100_000 },
  high: { min: 100_001, max: 1_000_000 },
  viral: { min: 1_000_001, max: Infinity },
};
