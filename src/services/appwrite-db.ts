/**
 * AdWinner Intel - Appwrite Data Broker Service
 *
 * Persistent storage layer using Appwrite TablesDB (v22 API).
 * Acts as a "data broker" — every ad we fetch from Apify gets stored permanently.
 * On subsequent queries, we check Appwrite first before paying for Apify.
 *
 * This is L2 cache (persistent, cross-deploy) vs Redis L1 (fast, ephemeral).
 *
 * Architecture:
 *   Query → Redis (L1, 6-24h TTL) → Appwrite DB (L2, persistent) → Apify (L3, $$)
 *
 * Tables:
 *   - ads:       Every ad entity we've ever fetched
 *   - queries:   Query log with cost tracking
 *
 * NOTE: All TablesDB calls use the object parameter style (non-deprecated).
 */

import { Client, TablesDB, Query, ID, IndexType } from 'node-appwrite';
import type { AdEntity } from '../types/index.js';
import type { CostSummary } from './cost-tracker.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT;
const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
const APPWRITE_DATABASE_ID = process.env.APPWRITE_DATABASE_ID || 'adwinner';

const TABLES = {
  ADS: 'ads',
  QUERIES: 'queries',
} as const;

// How fresh does Appwrite data need to be to skip Apify?
const APPWRITE_FRESHNESS_HOURS = Number(process.env.APPWRITE_FRESHNESS_HOURS || '48');
const APPWRITE_FRESHNESS_MS = APPWRITE_FRESHNESS_HOURS * 60 * 60 * 1000;

const CONTEXT_PROTOCOL_CUT = 0.10;

// =============================================================================
// CLIENT
// =============================================================================

let db: TablesDB | null = null;
let dbAvailable = false;
let dbChecked = false;

function isDbConfigured(): boolean {
  return Boolean(APPWRITE_ENDPOINT && APPWRITE_PROJECT_ID && APPWRITE_API_KEY);
}

function getDb(): TablesDB | null {
  if (!isDbConfigured()) return null;
  if (db) return db;

  const client = new Client()
    .setEndpoint(APPWRITE_ENDPOINT!)
    .setProject(APPWRITE_PROJECT_ID!)
    .setKey(APPWRITE_API_KEY!);

  db = new TablesDB(client);
  return db;
}

// =============================================================================
// BOOTSTRAP — Create database + tables if missing
// =============================================================================

export async function ensureDatabase(): Promise<boolean> {
  if (dbChecked) return dbAvailable;
  dbChecked = true;

  const tdb = getDb();
  if (!tdb) {
    console.log('[AppwriteDB] Not configured — skipping persistent storage');
    return false;
  }

  try {
    // Check if database exists
    try {
      await tdb.get({ databaseId: APPWRITE_DATABASE_ID });
    } catch {
      console.log(`[AppwriteDB] Creating database "${APPWRITE_DATABASE_ID}"...`);
      await tdb.create({ databaseId: APPWRITE_DATABASE_ID, name: APPWRITE_DATABASE_ID });
    }

    // Ensure "ads" table
    await ensureAdsTable(tdb);

    // Ensure "queries" table
    await ensureQueriesTable(tdb);

    dbAvailable = true;
    console.log('[AppwriteDB] Persistent storage ready');
    return true;
  } catch (error) {
    console.warn('[AppwriteDB] Failed to initialize:', (error as Error).message);
    dbAvailable = false;
    return false;
  }
}

async function ensureAdsTable(tdb: TablesDB): Promise<void> {
  try {
    await tdb.getTable({ databaseId: APPWRITE_DATABASE_ID, tableId: TABLES.ADS });
    return; // already exists
  } catch { /* needs creation */ }

  console.log('[AppwriteDB] Creating "ads" table...');
  await tdb.createTable({
    databaseId: APPWRITE_DATABASE_ID,
    tableId: TABLES.ADS,
    name: 'ads',
  });

  // Columns
  const cols: Array<{ key: string; type: 'string' | 'longtext' | 'integer'; size?: number }> = [
    { key: 'adId', type: 'string', size: 128 },
    { key: 'platform', type: 'string', size: 16 },
    { key: 'domain', type: 'string', size: 128 },
    { key: 'advertiserName', type: 'string', size: 256 },
    { key: 'activeDays', type: 'integer' },
    { key: 'fetchedAt', type: 'string', size: 64 },
    { key: 'data', type: 'longtext' },
  ];

  for (const col of cols) {
    try {
      if (col.type === 'string') {
        await tdb.createStringColumn({
          databaseId: APPWRITE_DATABASE_ID, tableId: TABLES.ADS,
          key: col.key, size: col.size!, required: false,
        });
      } else if (col.type === 'longtext') {
        await tdb.createLongtextColumn({
          databaseId: APPWRITE_DATABASE_ID, tableId: TABLES.ADS,
          key: col.key, required: false,
        });
      } else if (col.type === 'integer') {
        await tdb.createIntegerColumn({
          databaseId: APPWRITE_DATABASE_ID, tableId: TABLES.ADS,
          key: col.key, required: false,
        });
      }
    } catch { /* column may exist */ }
  }

  // Indexes
  try {
    await tdb.createIndex({
      databaseId: APPWRITE_DATABASE_ID, tableId: TABLES.ADS,
      key: 'idx_domain', type: IndexType.Key, columns: ['domain'],
    });
  } catch { /* */ }
  try {
    await tdb.createIndex({
      databaseId: APPWRITE_DATABASE_ID, tableId: TABLES.ADS,
      key: 'idx_adId', type: IndexType.Unique, columns: ['adId'],
    });
  } catch { /* */ }
}

async function ensureQueriesTable(tdb: TablesDB): Promise<void> {
  try {
    await tdb.getTable({ databaseId: APPWRITE_DATABASE_ID, tableId: TABLES.QUERIES });
    return;
  } catch { /* needs creation */ }

  console.log('[AppwriteDB] Creating "queries" table...');
  await tdb.createTable({
    databaseId: APPWRITE_DATABASE_ID,
    tableId: TABLES.QUERIES,
    name: 'queries',
  });

  const stringCols: Array<{ key: string; size: number }> = [
    { key: 'toolName', size: 64 },
    { key: 'query', size: 256 },
    { key: 'timestamp', size: 64 },
    { key: 'warning', size: 256 },
  ];
  const floatCols = ['totalCost', 'margin'];
  const intCols = ['marginPercent', 'resultCount'];

  for (const col of stringCols) {
    try {
      await tdb.createStringColumn({
        databaseId: APPWRITE_DATABASE_ID, tableId: TABLES.QUERIES,
        key: col.key, size: col.size, required: false,
      });
    } catch { /* */ }
  }
  for (const key of floatCols) {
    try {
      await tdb.createFloatColumn({
        databaseId: APPWRITE_DATABASE_ID, tableId: TABLES.QUERIES,
        key, required: false,
      });
    } catch { /* */ }
  }
  for (const key of intCols) {
    try {
      await tdb.createIntegerColumn({
        databaseId: APPWRITE_DATABASE_ID, tableId: TABLES.QUERIES,
        key, required: false,
      });
    } catch { /* */ }
  }
  try {
    await tdb.createBooleanColumn({
      databaseId: APPWRITE_DATABASE_ID, tableId: TABLES.QUERIES,
      key: 'fromCache', required: false,
    });
  } catch { /* */ }
}

// =============================================================================
// ADS STORAGE
// =============================================================================

/**
 * Sanitize adId into a valid Appwrite rowId (a-z, A-Z, 0-9, .-_ , max 36).
 * We use a deterministic ID so upsertRow works without querying first.
 */
function toRowId(adId: string): string {
  return adId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 36);
}

/**
 * Store ads in Appwrite (persistent).
 * Uses bulk upsertRows — one network call instead of N.
 */
export async function persistAds(ads: AdEntity[], domain?: string): Promise<void> {
  if (!dbAvailable || ads.length === 0) return;
  const tdb = getDb();
  if (!tdb) return;

  const now = new Date().toISOString();

  // Build rows for bulk upsert
  const rows = ads.map(ad => ({
    $id: toRowId(ad.adId),
    adId: ad.adId,
    platform: ad.platform,
    domain: (domain || ad.advertiser.domain || '').toLowerCase(),
    advertiserName: ad.advertiser.name?.slice(0, 255) || '',
    activeDays: ad.timing.activeDays,
    fetchedAt: now,
    data: JSON.stringify(ad),
  }));

  try {
    await tdb.upsertRows({
      databaseId: APPWRITE_DATABASE_ID,
      tableId: TABLES.ADS,
      rows,
    });
    console.log(`[AppwriteDB] Upserted ${rows.length} ads for domain="${domain || 'unknown'}"`);
  } catch (error) {
    // Fallback: try one by one if bulk fails
    let stored = 0;
    for (const row of rows) {
      try {
        const { $id, ...data } = row;
        await tdb.upsertRow({
          databaseId: APPWRITE_DATABASE_ID,
          tableId: TABLES.ADS,
          rowId: $id,
          data,
        });
        stored++;
      } catch {
        // best-effort
      }
    }
    if (stored > 0) {
      console.log(`[AppwriteDB] Persisted ${stored}/${ads.length} ads (fallback) for "${domain || 'unknown'}"`);
    } else {
      console.warn('[AppwriteDB] persistAds failed:', (error as Error).message);
    }
  }
}

/**
 * Fetch ads from Appwrite for a domain.
 * Returns fresh enough data or null.
 * L2 cache check — runs before Apify calls.
 */
export async function getPersistedAds(
  domain: string,
  platform?: string,
): Promise<AdEntity[] | null> {
  if (!dbAvailable) return null;
  const tdb = getDb();
  if (!tdb) return null;

  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '');
  const cutoff = new Date(Date.now() - APPWRITE_FRESHNESS_MS).toISOString();

  try {
    const queries = [
      Query.equal('domain', normalizedDomain),
      Query.greaterThan('fetchedAt', cutoff),
      Query.limit(15),
      Query.orderDesc('activeDays'),
    ];

    if (platform && platform !== 'all') {
      queries.push(Query.equal('platform', platform));
    }

    const result = await tdb.listRows({
      databaseId: APPWRITE_DATABASE_ID,
      tableId: TABLES.ADS,
      queries,
    });

    if (result.rows.length === 0) {
      console.log(`[AppwriteDB] No fresh data for "${normalizedDomain}" (cutoff: ${APPWRITE_FRESHNESS_HOURS}h)`);
      return null;
    }

    const ads: AdEntity[] = [];
    for (const row of result.rows) {
      try {
        ads.push(JSON.parse(row.data as string) as AdEntity);
      } catch { /* skip malformed */ }
    }

    console.log(`[AppwriteDB] Found ${ads.length} persisted ads for "${normalizedDomain}"`);
    return ads.length > 0 ? ads : null;
  } catch (error) {
    console.warn('[AppwriteDB] Query failed:', (error as Error).message);
    return null;
  }
}

/**
 * Search persisted ads by keyword (full-text on advertiserName).
 */
export async function searchPersistedAds(
  keyword: string,
  platform?: string,
): Promise<AdEntity[] | null> {
  if (!dbAvailable) return null;
  const tdb = getDb();
  if (!tdb) return null;

  const cutoff = new Date(Date.now() - APPWRITE_FRESHNESS_MS).toISOString();

  try {
    const queries = [
      Query.greaterThan('fetchedAt', cutoff),
      Query.limit(15),
      Query.orderDesc('activeDays'),
      Query.search('advertiserName', keyword.toLowerCase()),
    ];
    if (platform && platform !== 'all') {
      queries.push(Query.equal('platform', platform));
    }

    const result = await tdb.listRows({
      databaseId: APPWRITE_DATABASE_ID,
      tableId: TABLES.ADS,
      queries,
    });

    if (result.rows.length === 0) return null;

    const ads: AdEntity[] = [];
    for (const row of result.rows) {
      try {
        ads.push(JSON.parse(row.data as string) as AdEntity);
      } catch { /* skip */ }
    }

    console.log(`[AppwriteDB] Found ${ads.length} persisted ads matching "${keyword}"`);
    return ads.length > 0 ? ads : null;
  } catch (error) {
    console.warn('[AppwriteDB] Search failed:', (error as Error).message);
    return null;
  }
}

// =============================================================================
// QUERY LOG (COST TRACKING)
// =============================================================================

/**
 * Log a query with its cost summary to Appwrite.
 */
export async function logQueryCost(
  toolName: string,
  queryString: string,
  cost: CostSummary,
  resultCount: number,
): Promise<void> {
  if (!dbAvailable) return;
  const tdb = getDb();
  if (!tdb) return;

  try {
    await tdb.createRow({
      databaseId: APPWRITE_DATABASE_ID,
      tableId: TABLES.QUERIES,
      rowId: ID.unique(),
      data: {
        toolName,
        query: queryString.slice(0, 255),
        totalCost: cost.totalCost,
        margin: cost.margin,
        marginPercent: cost.marginPercent,
        resultCount,
        fromCache: cost.fromCache,
        timestamp: new Date().toISOString(),
        warning: (cost.warning || '').slice(0, 255),
      },
    });
  } catch (error) {
    console.warn('[AppwriteDB] Failed to log query cost:', (error as Error).message);
  }
}

/**
 * Get cost analytics for the last N hours.
 */
export async function getCostAnalytics(hours = 24): Promise<{
  totalQueries: number;
  totalCost: number;
  totalRevenue: number;
  netProfit: number;
  avgMarginPercent: number;
  warnings: number;
  cacheHitRate: number;
} | null> {
  if (!dbAvailable) return null;
  const tdb = getDb();
  if (!tdb) return null;

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  try {
    const result = await tdb.listRows({
      databaseId: APPWRITE_DATABASE_ID,
      tableId: TABLES.QUERIES,
      queries: [
        Query.greaterThan('timestamp', cutoff),
        Query.limit(500),
        Query.orderDesc('timestamp'),
      ],
    });

    const rows = result.rows;
    if (rows.length === 0) return null;

    const totalQueries = rows.length;
    const totalCost = rows.reduce((s, r) => s + ((r.totalCost as number) || 0), 0);
    const totalRevenue = totalQueries * 0.10;
    const netProfit = totalRevenue - totalCost - (totalRevenue * CONTEXT_PROTOCOL_CUT);
    const avgMarginPercent = rows.reduce((s, r) => s + ((r.marginPercent as number) || 0), 0) / totalQueries;
    const warnings = rows.filter(r => r.warning && (r.warning as string).length > 0).length;
    const cacheHits = rows.filter(r => r.fromCache === true).length;

    return {
      totalQueries,
      totalCost: Math.round(totalCost * 10000) / 10000,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      netProfit: Math.round(netProfit * 10000) / 10000,
      avgMarginPercent: Math.round(avgMarginPercent),
      warnings,
      cacheHitRate: Math.round((cacheHits / totalQueries) * 100),
    };
  } catch (error) {
    console.warn('[AppwriteDB] Analytics query failed:', (error as Error).message);
    return null;
  }
}
