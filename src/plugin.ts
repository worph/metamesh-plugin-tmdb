/**
 * TMDB Plugin
 *
 * Fetches metadata from The Movie Database (TMDB) API.
 * Supports both v3 API keys and v4 Bearer tokens.
 * Downloads poster and backdrop images via WebDAV to /files/plugin/tmdb/
 *
 * ============================================================================
 * PLUGIN FILE ACCESS ARCHITECTURE
 * ============================================================================
 *
 * File access via WebDAV, on the meta-core named by each /process request
 * (its /urls -> webdavUrlInternal; WEBDAV_URL overrides):
 *   - Read media files:  GET  /webdav/watch/...  or /webdav/test/...
 *   - Write output:      PUT  /webdav/plugin/tmdb/...
 *   - Cache:             Local /cache mount (for JSON cache files)
 *
 * Benefits:
 *   - No output mount needed on plugin containers
 *   - Consistent read/write architecture via HTTP
 *   - Works in any orchestration environment
 *   - Posters land in the same core the CIDs are written to, always
 *
 * ============================================================================
 *
 * Matches old TMDBProcessor output:
 * - tmdbid, imdbid
 * - originalTitle, movieYear, releasedate
 * - plot/eng, rating
 * - genres (add), studio (add), tags (add)
 * - poster, backdrop (CID hashes of downloaded images)
 */

import axios from 'axios';
import { createHash } from 'crypto';
import * as path from 'path';
import type { PluginManifest, ProcessRequest, CallbackPayload } from './types.js';
import { MetaCoreClient } from './meta-core-client.js';
import { readJson, writeJson } from './cache.js';
import { getWebDAVClient, WebDAVClient } from './webdav-client.js';

const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/original';

/**
 * ============================================================================
 * PLUGIN OUTPUT PATH - Written via WebDAV
 * ============================================================================
 * Output files (posters, backdrops) are written via WebDAV PUT requests, to the
 * WebDAV of the meta-core that issued the /process call.
 * Path: /files/plugin/tmdb/<filename>
 * CACHE_PATH (/cache) - Local mount for plugin cache (handled by cache.ts)
 * ============================================================================
 */
const PLUGIN_OUTPUT_WEBDAV_PATH = '/files/plugin/tmdb';

/**
 * Compute midhash256 CID via WebDAV
 */
async function computeMidHash256WebDAV(client: WebDAVClient, filePath: string): Promise<string> {
    const SAMPLE_SIZE = 1024 * 1024; // 1MB

    // Get file size via HTTP HEAD
    const stats = await client.stat(filePath);
    const fileSize = stats.size;

    // Read sample data via HTTP Range request
    let sampleData: Buffer;
    if (fileSize <= SAMPLE_SIZE) {
        // Small file: read entire content
        sampleData = await client.readBytes(filePath, 0, fileSize - 1);
    } else {
        // Large file: read middle 1MB
        const middleOffset = Math.floor((fileSize - SAMPLE_SIZE) / 2);
        sampleData = await client.readBytes(filePath, middleOffset, middleOffset + SAMPLE_SIZE - 1);
    }

    return computeMidHash256FromData(fileSize, sampleData);
}

/**
 * Compute midhash256 CID from file size and sample data
 */
function computeMidHash256FromData(fileSize: number, sampleData: Buffer): string {
    // varint encoding of 0x1000 (4096) for both codec and hash function code
    const MIDHASH_VARINT = Buffer.from([0x80, 0x20]);

    // Create size buffer (64-bit big-endian)
    const sizeBuffer = Buffer.allocUnsafe(8);
    sizeBuffer.writeBigUInt64BE(BigInt(fileSize), 0);

    // Compute SHA-256 hash of [size + sample]
    const hashInput = Buffer.concat([sizeBuffer, sampleData]);
    const hashBuffer = createHash('sha256').update(hashInput).digest();

    // Build CIDv1: version (0x01) + codec (varint) + multihash
    // Codec 0x1000 = varint [0x80, 0x20]
    // Multihash: function-code (varint 0x1000) + length (0x20) + hash
    const cidBytes = Buffer.concat([
        Buffer.from([0x01]),           // CIDv1
        MIDHASH_VARINT,                // codec 0x1000 as varint
        MIDHASH_VARINT,                // hash function code 0x1000 as varint
        Buffer.from([0x20]),           // 32 bytes digest length
        hashBuffer
    ]);

    // Encode as base32lower with 'b' prefix (multibase)
    const base32Chars = 'abcdefghijklmnopqrstuvwxyz234567';
    let cid = 'b';
    let bits = 0;
    let value = 0;
    for (const byte of cidBytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            cid += base32Chars[(value >> bits) & 0x1f];
        }
    }
    if (bits > 0) {
        cid += base32Chars[(value << (5 - bits)) & 0x1f];
    }

    return cid;
}

export const manifest: PluginManifest = {
    id: 'tmdb',
    name: 'TMDB Metadata',
    version: '1.0.0',
    description: 'Fetches metadata from The Movie Database (TMDB) API',
    author: 'MetaMesh',
    dependencies: ['file-info', 'filename-parser'],
    priority: 30,
    color: '#01B4E4',
    defaultQueue: 'background',
    timeout: 60000,
    schema: {
        tmdbid: { label: 'TMDB ID', type: 'string', readonly: true },
        imdbid: { label: 'IMDB ID', type: 'string' },
        originalTitle: { label: 'Original Title', type: 'string' },
        movieYear: { label: 'Release Year', type: 'number' },
        releasedate: { label: 'Release Date', type: 'string' },
        rating: { label: 'Vote Average', type: 'string', readonly: true },
        'plot/eng': { label: 'Plot (English)', type: 'string', readonly: true },
    },
    config: {
        apiKey: {
            type: 'string',
            label: 'TMDB API Key or Bearer Token',
            required: true,
            secret: true,
        },
        language: {
            type: 'select',
            label: 'Metadata Language',
            default: 'en-US',
        },
        forceRecompute: {
            type: 'boolean',
            label: 'Force Recompute',
            default: false,
        },
    },
};

// Track forceRecompute config
let forceRecompute = false;

const BASE_URL = 'https://api.themoviedb.org/3';

let apiKey: string | null = null;
let isV4Token = false;
let metadataLanguage = 'en-US';

export function configure(config: Record<string, unknown>): void {
    console.log(`[tmdb] Received config keys: ${Object.keys(config).join(', ')}`);
    apiKey = config.apiKey as string || null;
    if (apiKey) {
        isV4Token = apiKey.startsWith('eyJ');
        console.log(`[tmdb] API key configured (type: ${isV4Token ? 'v4 token' : 'v3 key'}, length: ${apiKey.length})`);
    } else {
        console.log(`[tmdb] WARNING: No API key in config`);
    }
    const lang = config.language as string || 'en';
    metadataLanguage = lang.includes('-') ? lang : `${lang}-${lang.toUpperCase()}`;
    if (metadataLanguage === 'en-en') metadataLanguage = 'en-US';
    console.log(`[tmdb] Language set to: ${metadataLanguage}`);
    forceRecompute = config.forceRecompute === true;
    if (forceRecompute) {
        console.log(`[tmdb] Force recompute enabled`);
    }
}

function getAxiosConfig(params: Record<string, string> = {}) {
    if (isV4Token) {
        return {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            params,
        };
    }
    return { params: { api_key: apiKey, ...params } };
}

async function findByImdbId(imdbId: string): Promise<any> {
    try {
        const config = getAxiosConfig({ language: metadataLanguage, external_source: 'imdb_id' });
        const response = await axios.get(`${BASE_URL}/find/${imdbId}`, config);
        const result = response.data.movie_results?.[0] || response.data.tv_results?.[0];
        if (result) {
            const mediaType = response.data.movie_results?.[0] ? 'movie' : 'tv';
            return getByTmdbId(result.id.toString(), mediaType);
        }
    } catch {
        return null;
    }
    return null;
}

async function getByTmdbId(tmdbId: string, mediaType: string): Promise<any> {
    try {
        const config = getAxiosConfig({ language: metadataLanguage });
        const response = await axios.get(`${BASE_URL}/${mediaType}/${tmdbId}`, config);
        return response.data;
    } catch {
        return null;
    }
}

async function searchByTitle(title: string, year?: string, videoType?: string): Promise<any> {
    try {
        const mediaType = videoType === 'tvshow' || videoType === 'tv' ? 'tv' : 'movie';
        const endpoint = `search/${mediaType}`;
        const params: Record<string, string> = { language: metadataLanguage, query: title };
        if (year) params.year = year;
        const config = getAxiosConfig(params);
        const response = await axios.get(`${BASE_URL}/${endpoint}`, config);
        const results = response.data.results || [];
        if (results.length > 0) {
            return getByTmdbId(results[0].id.toString(), mediaType);
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * Sanitize filename by removing invalid characters
 */
function sanitizeFilename(name: string): string {
    return name
        .replace(/[<>:"/\\|?*]/g, '') // Remove invalid chars
        .replace(/\s+/g, ' ')          // Normalize whitespace
        .trim();
}

/**
 * Download an image from URL and upload to WebDAV
 *
 * Images are written via WebDAV PUT to /files/plugin/tmdb/
 * This allows output without mounting a volume to the plugin container.
 */
async function downloadImageToWebDAV(
    client: WebDAVClient,
    imageUrl: string,
    webdavPath: string
): Promise<boolean> {
    try {
        // Download image as buffer
        const response = await axios({
            method: 'get',
            url: imageUrl,
            responseType: 'arraybuffer',
            timeout: 30000,
        });

        // Upload to WebDAV
        await client.writeFile(webdavPath, Buffer.from(response.data));

        console.log(`[tmdb] Uploaded image to WebDAV: ${webdavPath}`);
        return true;
    } catch (error) {
        console.error(`[tmdb] Failed to download/upload image from ${imageUrl}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

/**
 * Download and hash an image, returning its CID.
 *
 * Images are written via WebDAV PUT to /files/plugin/tmdb/. The watcher
 * indexes that directory as a first-class file root, so each downloaded
 * image becomes a normal metadata entry with a midhash256 alias. The
 * editor's CID preview then resolves through standard CID resolution —
 * no need to store any path in the parent file's metadata.
 */
async function downloadAndHashImage(
    webdavClient: WebDAVClient | null,
    imagePath: string,
    imageType: string,
    title: string,
    year: string | undefined,
    tmdbId: string
): Promise<string | null> {
    if (!imagePath) {
        return null;
    }

    if (!webdavClient) {
        console.error(`[tmdb] WebDAV client not available, cannot write output files`);
        return null;
    }

    const imageUrl = `${IMAGE_BASE_URL}${imagePath}`;
    const ext = path.extname(imagePath) || '.jpg';

    // Build filename: <title> (<year>)[tmdb<tmdbId>]_<type>.jpg
    // Note: Don't include file CID to avoid duplicate posters for same movie
    const safeName = sanitizeFilename(title);
    const yearStr = year ? ` (${year})` : '';
    const filename = `${safeName}${yearStr}[tmdb${tmdbId}]_${imageType}${ext}`;

    // WebDAV path for output file
    const webdavPath = `${PLUGIN_OUTPUT_WEBDAV_PATH}/${filename}`;

    // Check if file already exists via WebDAV HEAD
    const exists = await webdavClient.exists(webdavPath);
    if (exists) {
        console.log(`[tmdb] Image already exists: ${webdavPath}`);
    } else {
        // Download the image and upload via WebDAV
        const uploaded = await downloadImageToWebDAV(webdavClient, imageUrl, webdavPath);
        if (!uploaded) {
            return null;
        }
    }

    // Compute midhash256 CID via WebDAV (reads file back to compute hash)
    try {
        const cid = await computeMidHash256WebDAV(webdavClient, webdavPath);
        console.log(`[tmdb] Image ${imageType} CID: ${cid}`);
        return cid;
    } catch (e) {
        console.error(`[tmdb] Failed to compute CID for ${webdavPath}: ${e instanceof Error ? e.message : String(e)}`);
    }

    return null;
}

export async function process(
    request: ProcessRequest,
    sendCallback: (payload: CallbackPayload) => Promise<void>
): Promise<void> {
    const startTime = Date.now();
    const metaCore = new MetaCoreClient(request.metaCoreUrl);
    // WebDAV of the very core we're enriching, so poster blobs and the poster
    // CIDs we write can never point at different cores. Cached per core URL.
    const webdavClient = await getWebDAVClient(request.metaCoreUrl);

    try {
        const { cid, existingMeta } = request;

        if (!apiKey) {
            await sendCallback({
                taskId: request.taskId,
                status: 'skipped',
                duration: Date.now() - startTime,
                reason: 'No API key configured',
            });
            return;
        }

        if (existingMeta?.fileType !== 'video') {
            await sendCallback({
                taskId: request.taskId,
                status: 'skipped',
                duration: Date.now() - startTime,
                reason: 'Not a video file',
            });
            return;
        }

        // Skip only if FULLY enriched already (tmdbid AND poster), unless forced.
        // A record carrying a tmdbid but no poster — e.g. a gateway anchor or
        // jellyfin-nfo that set only the id — still runs, so the full cycle
        // (poster download + plot/genres) completes via getByTmdbId below.
        if (existingMeta?.tmdbid && existingMeta?.poster && !forceRecompute) {
            await sendCallback({
                taskId: request.taskId,
                status: 'skipped',
                duration: Date.now() - startTime,
                reason: 'Already has TMDB data',
            });
            return;
        }

        if (forceRecompute) {
            console.log(`[tmdb] Force recompute enabled for ${request.filePath ?? existingMeta?.fileName ?? cid}`);
        }

        const label = request.filePath ?? existingMeta?.fileName ?? cid;

        // Exact-file cache, keyed by the file's byte-hash. Only records carrying
        // real file bytes have `cid_midhash256`; gateway/usenet records don't —
        // which is exactly why the per-tmdbid cache below exists. Stores a full
        // entry now, but tolerates the legacy raw-payload format from older builds.
        const midhash = existingMeta?.['cid_midhash256'];
        if (midhash && !forceRecompute) {
            const cached = await readJson<any>(`${midhash}_tmdb.json`);
            if (cached) {
                console.log(`[tmdb] Using byte-hash cached TMDB data for ${label}`);
                const isEntry = cached.data !== undefined;
                await applyTmdbData(
                    metaCore,
                    webdavClient,
                    cid,
                    isEntry ? cached.data : cached,
                    // Legacy raw payloads carry no image CIDs → let applyTmdbData recompute.
                    isEntry ? { posterCid: cached.posterCid, backdropCid: cached.backdropCid } : undefined
                );
                await sendCallback({
                    taskId: request.taskId,
                    status: 'completed',
                    duration: Date.now() - startTime,
                });
                return;
            }
        }

        // Resolve the show/movie entry, deduped per tmdbid. A record that already
        // carries a tmdbid anchor (every gateway torrent/usenet hit does) takes
        // the cached + single-flighted fast path, so N releases of one show share
        // ONE TMDB fetch + poster seed instead of N.
        let entry: TmdbCacheEntry | null = null;
        const knownTmdbId = existingMeta?.tmdbid;
        if (knownTmdbId) {
            const mediaType =
                existingMeta?.videoType === 'tvshow' || existingMeta?.videoType === 'tv'
                    ? 'tv'
                    : 'movie';
            entry = await resolveEntryById(webdavClient, knownTmdbId, mediaType);
        }

        // Fallback: no usable id → resolve by IMDB id or fuzzy title, then cache
        // the result by its resolved tmdbid so later releases of the same show
        // take the fast path above.
        if (!entry) {
            let tmdbData: any = null;

            const imdbId = existingMeta?.imdbid;
            if (imdbId) {
                tmdbData = await findByImdbId(imdbId);
            }

            if (!tmdbData) {
                let title = existingMeta?.originalTitle || existingMeta?.fileName;
                const year = existingMeta?.movieYear;
                const videoType = existingMeta?.videoType;

                // Strip trailing year from title if present ("Sintel 2010" -> "Sintel").
                if (title && year) {
                    const yearRegex = new RegExp(`\\s*[\\(\\[]?${year}[\\)\\]]?\\s*$`);
                    title = title.replace(yearRegex, '').trim();
                }

                if (title) {
                    tmdbData = await searchByTitle(title, year, videoType);
                }
            }

            if (tmdbData) {
                const images = await computeImageCids(webdavClient, tmdbData);
                entry = { data: tmdbData, ...images };
                if (tmdbData.id) {
                    await writeJson(tmdbCacheKey(String(tmdbData.id), mediaTypeOf(tmdbData)), entry);
                }
            }
        }

        if (entry) {
            await applyTmdbData(metaCore, webdavClient, cid, entry.data, {
                posterCid: entry.posterCid,
                backdropCid: entry.backdropCid,
            });
            // Keep the exact-file cache warm too, so a future re-enrichment of
            // this same file skips straight to the byte-hash hit.
            if (midhash) {
                await writeJson(`${midhash}_tmdb.json`, entry);
            }
            console.log(`[tmdb] Enriched ${label} (tmdbid=${entry.data.id})`);
        } else {
            console.log(`[tmdb] No TMDB match found for ${label}`);
        }

        await sendCallback({
            taskId: request.taskId,
            status: 'completed',
            duration: Date.now() - startTime,
        });
    } catch (error) {
        await sendCallback({
            taskId: request.taskId,
            status: 'failed',
            duration: Date.now() - startTime,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/** Resolved TMDB payload plus the seeded poster/backdrop CIDs, cached per
 *  tmdbid. Every torrent/usenet release of an episode carries the same
 *  `tmdbid`, and TMDB only gives us show/movie-level fields (poster, plot,
 *  genres — no per-episode data), so N releases can share ONE fetch + seed. */
interface TmdbCacheEntry {
    data: any;
    posterCid: string | null;
    backdropCid: string | null;
}

// In-process single-flight: collapses concurrent resolves of the same key onto
// one promise, so a burst of same-tmdbid records that all miss the cold cache
// triggers a single TMDB fetch (no thundering herd) — the rest await it.
const tmdbEntryInflight = new Map<string, Promise<TmdbCacheEntry | null>>();

// Persistent cache filename for a resolved show/movie. Includes mediaType +
// language so a tv/movie id clash or a language switch can't return stale text.
function tmdbCacheKey(tmdbId: string, mediaType: string): string {
    return `tmdbid_${mediaType}_${tmdbId}_${metadataLanguage}_tmdb.json`;
}

// Media type from a raw TMDB payload's own shape (tv payloads carry
// name/first_air_date). Mirrors the check in applyTmdbData.
function mediaTypeOf(data: any): string {
    return data?.first_air_date !== undefined ||
        data?.name !== undefined ||
        data?.original_name !== undefined
        ? 'tv'
        : 'movie';
}

// Download + hash the poster/backdrop for a resolved payload. Record-independent
// (the image filename is keyed by tmdbId, so the blob dedups across records), so
// the CIDs can be computed once per show and reused for every release.
async function computeImageCids(
    webdavClient: WebDAVClient | null,
    data: any
): Promise<{ posterCid: string | null; backdropCid: string | null }> {
    const tmdbId = data?.id ? String(data.id) : '';
    const displayTitle =
        data?.title || data?.name || data?.original_title || data?.original_name || 'Unknown';
    const releaseDate = data?.release_date || data?.first_air_date;
    const year = releaseDate ? releaseDate.split('-')[0] : undefined;
    const posterCid =
        data?.poster_path && tmdbId
            ? await downloadAndHashImage(webdavClient, data.poster_path, 'poster', displayTitle, year, tmdbId)
            : null;
    const backdropCid =
        data?.backdrop_path && tmdbId
            ? await downloadAndHashImage(webdavClient, data.backdrop_path, 'backdrop', displayTitle, year, tmdbId)
            : null;
    return { posterCid, backdropCid };
}

// Resolve the full entry (payload + image CIDs) for a KNOWN tmdbid, served from
// the persistent per-tmdbid cache when possible and single-flighted otherwise.
// This is the hot path for gateway records (torrent + usenet), which always
// carry a `tmdbid` anchor — so N releases of one show share one TMDB fetch.
async function resolveEntryById(
    webdavClient: WebDAVClient | null,
    tmdbId: string,
    mediaType: string
): Promise<TmdbCacheEntry | null> {
    const key = tmdbCacheKey(tmdbId, mediaType);
    if (!forceRecompute) {
        const cached = await readJson<TmdbCacheEntry>(key);
        if (cached?.data) {
            return cached;
        }
    }
    const inflight = tmdbEntryInflight.get(key);
    if (inflight) {
        return inflight;
    }
    const pending = (async (): Promise<TmdbCacheEntry | null> => {
        console.log(`[tmdb] Resolving TMDB ${mediaType}/${tmdbId} (cache miss)`);
        const data = await getByTmdbId(tmdbId, mediaType);
        if (!data) {
            return null;
        }
        const images = await computeImageCids(webdavClient, data);
        const entry: TmdbCacheEntry = { data, ...images };
        await writeJson(key, entry);
        return entry;
    })();
    tmdbEntryInflight.set(key, pending);
    try {
        return await pending;
    } finally {
        tmdbEntryInflight.delete(key);
    }
}

/**
 * Apply TMDB data to KV store using same keys as old TMDBProcessor
 */
async function applyTmdbData(
    metaCore: MetaCoreClient,
    webdavClient: WebDAVClient | null,
    cid: string,
    data: any,
    images?: { posterCid: string | null; backdropCid: string | null }
): Promise<{ posterCid: string | null; backdropCid: string | null }> {
    const metadata: Record<string, string> = {};

    // Basic IDs
    const tmdbId = data.id ? String(data.id) : '';
    if (tmdbId) metadata.tmdbid = tmdbId;
    if (data.imdb_id) metadata.imdbid = data.imdb_id;

    // Authoritative media type, stamped from TMDB's own payload shape. TV
    // payloads carry `name`/`first_air_date`/`original_name`; movie payloads
    // carry `title`/`release_date`/`original_title`. This overrides whatever the
    // filename-parser guessed (`videoType`/`contentKind`), which it derives from
    // a parsed season/episode — frequently absent for anime fansubs (absolute
    // numbering, batch packs), the root cause of series being mislabeled films
    // downstream in meta-watch. `videoType` (movie|tvshow) and `contentKind`
    // (movie|episode) mirror the filename-parser's keys so consumers read one
    // field regardless of the enrichment source.
    const isTv =
        data.first_air_date !== undefined ||
        data.name !== undefined ||
        data.original_name !== undefined;
    metadata.videoType = isTv ? 'tvshow' : 'movie';
    metadata.contentKind = isTv ? 'episode' : 'movie';
    // `domain` is written in the same breath as `contentKind`
    // (METADATA_KEYS.md §1) — it is the key meta-watch filters its wall on,
    // and TMDB is precisely the identity graph that decides film vs tv here.
    metadata.domain = isTv ? 'tv' : 'film';

    // Title - store both original and localized
    const originalTitle = data.original_title || data.original_name;
    const localizedTitle = data.title || data.name;
    const displayTitle = localizedTitle || originalTitle || 'Unknown';

    // Store localized title as the main title (for display in Stremio)
    if (localizedTitle && localizedTitle !== originalTitle) {
        metadata.title = localizedTitle;
    }

    // Store original title separately
    if (originalTitle) {
        metadata.originalTitle = originalTitle;
    }

    // Dates
    const releaseDate = data.release_date || data.first_air_date;
    let year: string | undefined;
    if (releaseDate) {
        metadata.releasedate = releaseDate;
        year = releaseDate.split('-')[0];
        if (year) {
            metadata.movieYear = year;
        }
    }

    // Plot (in configured language)
    if (data.overview) {
        // Extract language code from metadataLanguage (e.g., 'en-US' -> 'eng')
        const langCode = metadataLanguage.split('-')[0];
        const langKey = langCode === 'en' ? 'eng' : langCode;
        metadata[`plot/${langKey}`] = data.overview;
        // Also set as primary plot for compatibility
        metadata['plot/eng'] = data.overview;
    }

    // Rating
    if (data.vote_average) {
        metadata.rating = String(data.vote_average);
    }

    await metaCore.mergeMetadata(cid, metadata);

    // Genres (add)
    if (data.genres && Array.isArray(data.genres)) {
        for (const genre of data.genres) {
            await metaCore.addToSet(cid, 'genres', genre.name);
        }
    }

    // Production companies as studios (add)
    if (data.production_companies && Array.isArray(data.production_companies)) {
        for (const company of data.production_companies) {
            await metaCore.addToSet(cid, 'studio', company.name);
        }
    }

    // Add tmdb-verified tag (same as old processor)
    await metaCore.addToSet(cid, 'tags', 'tmdb-verified');

    // Poster/backdrop CIDs. Reuse the precomputed values when the caller already
    // seeded them (a per-tmdbid cache hit — so we don't re-download + re-hash the
    // same image for every release of a show); otherwise download + hash now.
    // The image filename is keyed by tmdbId, so the blob is deduped either way —
    // this just also skips the WebDAV round-trips. The watcher picks the images
    // up as first-class file entries, so storing the CID is all that's needed.
    let posterCid = images ? images.posterCid : null;
    if (!images && data.poster_path && tmdbId) {
        posterCid = await downloadAndHashImage(webdavClient, data.poster_path, 'poster', displayTitle, year, tmdbId);
    }
    if (posterCid) {
        await metaCore.setProperty(cid, 'poster', posterCid);
        console.log(`[tmdb] Set poster CID: ${posterCid}`);
    }

    let backdropCid = images ? images.backdropCid : null;
    if (!images && data.backdrop_path && tmdbId) {
        backdropCid = await downloadAndHashImage(webdavClient, data.backdrop_path, 'backdrop', displayTitle, year, tmdbId);
    }
    if (backdropCid) {
        await metaCore.setProperty(cid, 'backdrop', backdropCid);
        console.log(`[tmdb] Set backdrop CID: ${backdropCid}`);
    }

    return { posterCid, backdropCid };
}
