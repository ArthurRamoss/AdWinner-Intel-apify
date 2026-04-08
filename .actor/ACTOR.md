# AdWinner Intel — Competitive Ad Intelligence

Spy on competitor ads across **Meta Ad Library** (Facebook & Instagram) and **TikTok** in a single query. AdWinner Intel finds proven winning ads using longevity-based profitability scoring and analyzes creatives with **Google Gemini AI** to extract hooks, pain points, and emotional triggers.

## What makes it unique

- **Longevity = Profitability**: Ads running 14+ days are almost certainly profitable — nobody keeps spending on losers. AdWinner ranks ads by how long they've been active, not vanity metrics.
- **Cross-platform intelligence**: Search Meta AND TikTok simultaneously. Ads running on both platforms get a "Global Winner" flag — the strongest signal of profitability.
- **AI creative analysis**: Google Gemini vision analyzes the actual ad creative (video/image) to extract the hook type, pain point addressed, emotional triggers, CTA strength, and a 0-10 marketing score.
- **Pay-per-query pricing**: No $150/month AdSpy subscription. Pay only for what you use.

## Who is this for?

- **E-commerce brands** — See what competitors' winning ads look like before you spend on creative production
- **Marketing agencies** — Research competitor strategies for client pitches and creative briefs
- **Dropshippers** — Find products with proven ad creatives running 30+ days (strong profitability signal)
- **Media buyers** — Discover winning hooks, angles, and formats before testing your own
- **Content creators** — Understand what ad styles and hooks are trending in your niche

## Available actions

### 1. `analyze_domain_winners` (main action)
Find proven winning ads for any domain. Returns ads sorted by longevity with profitability scores, AI creative analysis, and cross-platform hook comparison.

### 2. `extract_marketing_hooks`
AI-analyze a single ad creative URL. Extracts: hook type (first 3 seconds), pain point, emotional triggers, CTA strength, marketing score 0-10, and replication tips.

### 3. `get_trend_report`
Discover what's trending RIGHT NOW in a niche on TikTok. Returns dominant formats, rising angles/hashtags, common hooks, and actionable insights.

### 4. `ad_profitability_score`
Calculate a 0-100 profitability score for a specific ad based on longevity (40%), impressions (35%), and platform diversity (25%).

### 5. `get_raw_fb_ads`
Fetch raw ad data from Meta Ad Library including creatives, impression ranges, and demographic distribution.

### 6. `get_raw_tiktok_ads`
Fetch raw TikTok content data with engagement metrics, hashtags, and creator metadata.

## How input works

1. Select an **Action** from the dropdown
2. Fill in the parameters relevant to that action (irrelevant fields are ignored)
3. Run the Actor — results are pushed to the default dataset

### Example: Find winning ads for Glossier

```json
{
    "action": "analyze_domain_winners",
    "domain": "glossier.com",
    "platform": "all",
    "minLongevityDays": 14,
    "includeAnalysis": true,
    "maxResults": 5
}
```

### Example: Analyze a specific creative

```json
{
    "action": "extract_marketing_hooks",
    "creativeUrl": "https://example.com/ad-video.mp4"
}
```

### Example: TikTok trends in skincare

```json
{
    "action": "get_trend_report",
    "keyword": "skincare",
    "region": "US",
    "timeRange": "7d"
}
```

## Standby mode (HTTP API)

This Actor supports standby mode for low-latency HTTP access. Send a POST request to the standby URL:

```bash
curl -X POST https://<standby-url>/ \
  -H "Content-Type: application/json" \
  -d '{"action": "analyze_domain_winners", "domain": "huel.com"}'
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `APIFY_TOKEN` | Yes | Apify API token (for ad library scrapers) |
| `GEMINI_API_KEY` | Yes | Google Gemini API key (for AI creative analysis) |
| `GEMINI_MODEL` | No | Gemini model name (default: `gemini-2.0-flash`) |
| `REDIS_URL` | No | Redis URL for caching (reduces API calls) |
| `APPWRITE_ENDPOINT` | No | Appwrite endpoint for persistent storage |
| `APPWRITE_PROJECT_ID` | No | Appwrite project ID |
| `APPWRITE_API_KEY` | No | Appwrite API key |

## Pricing

This Actor uses **pay-per-event** pricing. You are charged per successful analysis completed. See the pricing tab for details.

## Output

Results are pushed to the default dataset and include:
- Ad creative URLs (images, videos)
- Advertiser information and targeting
- Longevity data (days running, start date)
- Profitability scores (0-100)
- AI analysis (hooks, pain points, emotional triggers, marketing score)
- Cross-platform comparison when searching both Meta and TikTok
