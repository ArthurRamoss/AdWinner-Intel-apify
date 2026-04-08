# 🏆 AdWinner Ad Intelligence (Tier S)

> **Unbundle AdSpy ($150/mo) into $0.10/query** — Find proven profitable ads by analyzing longevity patterns across Facebook Ad Library and TikTok.

[![Context Protocol](https://img.shields.io/badge/Context%20Protocol-Tier%20S-gold)](https://ctxprotocol.com)
[![MCP](https://img.shields.io/badge/MCP-1.0-blue)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## 🎯 Core Thesis: Longevity = Profitability

**Ads running for 14+ days are almost certainly profitable.** No rational advertiser keeps spending on losing ads. This simple insight lets us identify "winner" creatives without access to actual ROAS data.

```
Ad running 1-7 days   → Testing phase (ignore)
Ad running 14+ days   → Profitable (study this)
Ad running 30+ days   → Highly profitable (copy this)
Ad running 60+ days   → Evergreen winner (replicate structure)
```

---

## 🔍 Winning Signal Detection

### Multi-Platform Intelligence

| Signal | Source | Confidence |
|--------|--------|------------|
| **Longevity > 14 days** | Facebook Ad Library | High |
| **High engagement rate** | TikTok metrics | Medium |
| **Cross-platform presence** | FB + TikTok match | Very High |
| **Impression tier: Viral** | Platform data | High |

### Global Winner Detection

When we detect the **same brand running ads on multiple platforms**, we flag it as a "Global Winner" — the highest confidence signal that a creative strategy is working.

```
iFood (Facebook) + ifoodsuk (TikTok) → Global Winner ✓
Glossier (Facebook) + glossierbeauty (TikTok) → Global Winner ✓
```

Our fuzzy matching algorithm detects brand variations across platforms.

---

## 🤖 AI Hook Analysis (Gemini 2.0 Flash)

For winning ads, we extract marketing psychology using Google Gemini:

| Analysis | Description |
|----------|-------------|
| **Hook Type** | Visual, audio, question, curiosity-gap, pain-point |
| **Pain Point** | Core problem being addressed |
| **Emotional Triggers** | Fear, desire, urgency, social-validation |
| **CTA Style** | Soft, medium, hard, implied |
| **Marketing Score** | 0-10 composite rating |
| **Replication Tips** | How to recreate this ad's success |

---

## 💰 Unit Economics

### Cost Structure

| Operation | Our Cost | Notes |
|-----------|----------|-------|
| Facebook Ads (5 results) | ~$0.004 | Apify: $0.75/1000 |
| TikTok Posts (5 results) | ~$0.025 | Apify: $5/1000 |
| Gemini Analysis (1 ad) | ~$0.001 | 1K tokens |
| **Total per query** | **~$0.03** | With caching: ~$0.01 |

### Revenue Model

| Metric | Value |
|--------|-------|
| **Query Price** | $0.10 USDC |
| **Cost per Query** | $0.01-0.03 |
| **Gross Margin** | **70-90%** |
| **Context Protocol Fee** | 10% |
| **Net to Developer** | 90% × $0.10 = $0.09 |

### vs AdSpy Subscription

```
AdSpy: $150/month = $1,800/year
Break-even: 1,500 queries/year
Most users: <100 queries/month

→ 15x cost savings for typical user
```

---

## 🛠️ MCP Tools

### 1. `analyze_domain_winners`
Find proven profitable ads for a competitor domain.

```json
{
  "domain": "glossier.com",
  "country": "US",
  "platform": "all",
  "limit": 3,
  "includeAnalysis": false
}
```

### 2. `extract_marketing_hooks`
AI-powered hook extraction from any video/image URL.

```json
{
  "videoUrl": "https://example.com/ad-video.mp4",
  "advertiserName": "Glossier"
}
```

### 3. `get_trend_report`
Discover trending ad formats in a keyword/niche.

```json
{
  "keyword": "skincare",
  "region": "US",
  "timeRange": "7d",
  "limit": 3
}
```

### 4. `ad_profitability_score`
Calculate 0-100 profitability score for any ad.

```json
{
  "startDate": "2025-01-01",
  "impressionsLower": 100000,
  "platforms": ["facebook", "tiktok"]
}
```

### 5. `get_raw_fb_ads`
Direct passthrough to Facebook Ad Library.

### 6. `get_raw_tiktok_ads`
Direct passthrough to TikTok keyword search.

---

## 🚀 Quick Start

### Environment Variables

```env
# Required
APIFY_TOKEN=apify_api_xxxxx
GEMINI_API_KEY=AIzaSyxxxxx

# Appwrite (persistent L2 cache + cost tracking)
APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1
APPWRITE_PROJECT_ID=your_project_id
APPWRITE_API_KEY=your_api_key
APPWRITE_DATABASE_ID=adwinner          # optional, defaults to 'adwinner'
APPWRITE_FRESHNESS_HOURS=48            # optional, L2 cache freshness window

# Optional
REDIS_URL=redis://localhost:6379       # L1 cache (fail-open if absent)
MCP_TRANSPORT=http                     # 'http' or 'stdio'
PORT=3000
TIKTOK_DOWNLOAD_VIDEOS=false           # default false (saves cost)
TIKTOK_DOWNLOAD_COVERS=false           # default false (saves cost)
```

### Run Locally

```bash
# Install dependencies
pnpm install

# Development mode
pnpm run dev

# Production build
pnpm run build
pnpm start
```

### Docker

```bash
# Build
docker build -t adwinner-intel .

# Run
docker run -p 3000:3000 \
  -e APIFY_TOKEN=xxx \
  -e GEMINI_API_KEY=xxx \
  adwinner-intel
```

### Deploy to Railway

```bash
railway up
```

---

## 📊 Example Response

```json
{
  "timestamp": "2026-02-06T18:34:39.795Z",
  "domain": "glossier.com",
  "summary": {
    "totalAdsFound": 12,
    "winnersFound": 5,
    "globalWinnersFound": 2,
    "avgLongevityDays": 45
  },
  "winners": [
    {
      "adId": "fb_123456789",
      "platform": "facebook",
      "advertiser": { "name": "Glossier", "domain": "glossier.com" },
      "timing": { "activeDays": 89, "longevityStatus": "winner" },
      "intelligence": { "globalWinner": true, "profitabilityScore": 85 }
    }
  ],
  "insight": "glossier.com has 5 proven winning ads with average runtime of 45 days..."
}
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     MCP Client (Agent)                      │
└─────────────────────────┬───────────────────────────────────┘
                          │ MCP Protocol (HTTP/stdio)
┌─────────────────────────▼───────────────────────────────────┐
│                   AdWinner Intel Server                      │
│  ┌─────────────┐  ┌──────────────────┐  ┌───────────────┐   │
│  │ 6 MCP Tools │  │  3-Layer Cache   │  │ Cost Tracker  │   │
│  │ (Zod valid) │  │  L1 → L2 → L3   │  │ (per-request) │   │
│  └──────┬──────┘  └────────┬─────────┘  └───────┬───────┘   │
└─────────┼──────────────────┼────────────────────┼───────────┘
          │                  │                    │
   ┌──────▼──────┐   ┌──────▼──────┐   ┌─────────▼─────────┐
   │ Data Sources│   │ Cache Stack │   │ AI Analysis       │
   │             │   │             │   │                   │
   │ • Meta Ads  │   │ L1: Redis   │   │ Google Gemini     │
   │ • TikTok    │   │   (6-24h)   │   │ 2.0 Flash         │
   │             │   │ L2: Appwrite│   │ (video analysis)  │
   │             │   │   (48h+)    │   │                   │
   │             │   │ L3: Apify   │   │                   │
   │             │   │   (source)  │   │                   │
   └─────────────┘   └─────────────┘   └───────────────────┘
```

### Cache Flow

```
Query → Redis L1 (6-24h TTL, fail-open)
  ↓ miss
      → Appwrite L2 (persistent, 48h freshness)
          ↓ miss
              → Apify L3 ($$, pay-per-result)
                  ↓ results
              → Persist to Appwrite (non-blocking)
              → Cache in Redis (non-blocking)
```

---

## 🔒 Data Broker Standard Compliance

| Requirement | Status |
|-------------|--------|
| `outputSchema` defined | ✅ All 6 tools |
| Deterministic outputs | ✅ 3-layer cache (Redis → Appwrite → Source) |
| Error handling | ✅ Graceful MCP errors + fail-open cache |
| Response time < 30s | ✅ Timeout protection (20s Apify, 10s Gemini) |
| Cost protection | ✅ Per-request tracking, margin alerts |
| Persistent storage | ✅ Appwrite TablesDB (ads + query costs) |
| Creative URLs visible | ✅ `_adCreativeLinks` flat array + display instructions |
| No infrastructure leaks | ✅ Tool descriptions hide internal plumbing |

---

## 📋 Context Marketplace Submission

```json
{
  "name": "AdWinner Ad Intelligence",
  "description": "Find proven profitable ads by analyzing longevity patterns. Ads running 14+ days are almost certainly profitable. Unbundles AdSpy ($150/mo) into $0.10/query.\n\nFeatures:\n- Scrapes Meta Ad Library for any domain\n- Cross-references TikTok keyword search results\n- Filters for winners (ads running ≥14 days)\n- Calculates profitability score (0-100)\n- Gemini AI analysis of creatives\n- Flags Global Winners across platforms\n\nTry asking:\n- \"What winning ads is glossier.com running?\"\n- \"Find profitable TikTok ads in the skincare niche\"\n- \"Analyze the marketing hooks in this ad video\"",
  "category": "Market Data",
  "price": "0.10",
  "endpoint": "https://your-railway-url.up.railway.app/mcp"
}
```

---

## 📜 License

MIT © 2026

---

**Built for [Context Protocol](https://ctxprotocol.com) Marketplace** 🚀