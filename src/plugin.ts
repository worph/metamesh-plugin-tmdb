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
 * File access via WebDAV (WEBDAV_URL environment variable):
 *   - Read media files:  GET  /webdav/watch/...  or /webdav/test/...
 *   - Write output:      PUT  /webdav/plugin/tmdb/...
 *   - Cache:             Local /cache mount (for JSON cache files)
 *
 * Benefits:
 *   - No output mount needed on plugin containers
 *   - Consistent read/write architecture via HTTP
 *   - Works in any orchestration environment
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
import { statSync, openSync, readSync, closeSync } from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';
import type { PluginManifest, ProcessRequest, CallbackPayload } from './types.js';
import { MetaCoreClient } from './meta-core-client.js';
import { readJson, writeJson } from './cache.js';
import { createWebDAVClient, WebDAVClient } from './webdav-client.js';

// Initialize WebDAV client - required for plugin operation
const webdavClient = createWebDAVClient();
if (webdavClient) {
    console.log('[tmdb] WebDAV client initialized for file access');
} else {
    console.warn('[tmdb] WARNING: WEBDAV_URL not set - plugin will not be able to write output files');
}

const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/original';

/**
 * ============================================================================
 * PLUGIN OUTPUT PATH - Written via WebDAV
 * ============================================================================
 * Output files (posters, backdrops) are written via WebDAV PUT requests.
 * Path: /files/plugin/tmdb/<filename> (accessible at WEBDAV_URL/plugin/tmdb/)
 * CACHE_PATH (/cache) - Local mount for plugin cache (handled by cache.ts)
 * ============================================================================
 */
const PLUGIN_OUTPUT_WEBDAV_PATH = '/files/plugin/tmdb';

/**
 * Compute midhash256 CID for a file (matches meta-hash algorithm)
 *
 * Algorithm:
 * - For files <= 1MB: Hashes entire file content + 8-byte size prefix
 * - For files > 1MB: Hashes middle 1MB + 8-byte size prefix
 * - Returns CIDv1 with custom codec 0x1000
 */
function computeMidHash256Sync(filePath: string): string {
    const SAMPLE_SIZE = 1024 * 1024; // 1MB
    // varint encoding of 0x1000 (4096) for both codec and hash function code
    const MIDHASH_VARINT = Buffer.from([0x80, 0x20]);

    // Get file size
    const stats = statSync(filePath);
    const fileSize = stats.size;

    // Create size buffer (64-bit big-endian)
    const sizeBuffer = Buffer.allocUnsafe(8);
    sizeBuffer.writeBigUInt64BE(BigInt(fileSize), 0);

    // Extract sample data
    let sampleData: Buffer;
    if (fileSize <= SAMPLE_SIZE) {
        // Small file: read entire content
        const fd = openSync(filePath, 'r');
        sampleData = Buffer.allocUnsafe(fileSize);
        readSync(fd, sampleData, 0, fileSize, 0);
        closeSync(fd);
    } else {
        // Large file: read middle 1MB
        const middleOffset = Math.floor((fileSize - SAMPLE_SIZE) / 2);
        const fd = openSync(filePath, 'r');
        sampleData = Buffer.allocUnsafe(SAMPLE_SIZE);
        readSync(fd, sampleData, 0, SAMPLE_SIZE, middleOffset);
        closeSync(fd);
    }

    return computeMidHash256FromData(fileSize, sampleData);
}

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

/**
 * Compute midhash256 CID for a file (auto-selects WebDAV or filesystem)
 */
async function computeMidHash256(filePath: string): Promise<string> {
    if (webdavClient) {
        return computeMidHash256WebDAV(webdavClient, filePath);
    }
    return computeMidHash256Sync(filePath);
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
 * Download and hash an image, returning its CID
 *
 * Images are written via WebDAV PUT to /files/plugin/tmdb/
 * The files will be picked up by meta-sort's file watcher and processed like any other file.
 *
 * @returns {Promise<string | null>} The midhash256 CID of the downloaded image
 */
async function downloadAndHashImage(
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

        // Skip if already has TMDB data (unless forceRecompute)
        if (existingMeta?.tmdbid && !forceRecompute) {
            await sendCallback({
                taskId: request.taskId,
                status: 'skipped',
                duration: Date.now() - startTime,
                reason: 'Already has TMDB data',
            });
            return;
        }

        if (forceRecompute) {
            console.log(`[tmdb] Force recompute enabled for ${request.filePath}`);
        }

        // Get midhash for caching
        const midhash = existingMeta?.['cid_midhash256'];

        // Check cache (skip if forceRecompute)
        if (midhash && !forceRecompute) {
            const cachedData = await readJson<any>(`${midhash}_tmdb.json`);
            if (cachedData) {
                console.log(`[tmdb] Using cached TMDB data for ${request.filePath}`);
                await applyTmdbData(metaCore, cid, cachedData);
                await sendCallback({
                    taskId: request.taskId,
                    status: 'completed',
                    duration: Date.now() - startTime,
                });
                return;
            }
        }

        let tmdbData = null;

        // Try by IMDB ID first
        const imdbId = existingMeta?.imdbid;
        if (imdbId) {
            tmdbData = await findByImdbId(imdbId);
        }

        // Try by title search
        if (!tmdbData) {
            let title = existingMeta?.originalTitle || existingMeta?.fileName;
            const year = existingMeta?.movieYear;
            const videoType = existingMeta?.videoType;

            // Strip trailing year from title if present (e.g., "Sintel 2010" -> "Sintel")
            if (title && year) {
                const yearRegex = new RegExp(`\\s*[\\(\\[]?${year}[\\)\\]]?\\s*$`);
                title = title.replace(yearRegex, '').trim();
            }

            if (title) {
                tmdbData = await searchByTitle(title, year, videoType);
            }
        }

        if (tmdbData) {
            await applyTmdbData(metaCore, cid, tmdbData);

            // Cache TMDB data for future use
            if (midhash) {
                await writeJson(`${midhash}_tmdb.json`, tmdbData);
            }

            console.log(`[tmdb] Fetched TMDB data for ${request.filePath}`);
        } else {
            console.log(`[tmdb] No TMDB match found for ${request.filePath}`);
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

/**
 * Apply TMDB data to KV store using same keys as old TMDBProcessor
 */
async function applyTmdbData(
    metaCore: MetaCoreClient,
    cid: string,
    data: any
): Promise<void> {
    const metadata: Record<string, string> = {};

    // Basic IDs
    const tmdbId = data.id ? String(data.id) : '';
    if (tmdbId) metadata.tmdbid = tmdbId;
    if (data.imdb_id) metadata.imdbid = data.imdb_id;

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

    // Download poster and backdrop images to plugin output folder
    // The files will be picked up by meta-sort's file watcher and processed like any other file
    if (data.poster_path && tmdbId) {
        const posterCid = await downloadAndHashImage(
            data.poster_path,
            'poster',
            displayTitle,
            year,
            tmdbId
        );
        if (posterCid) {
            await metaCore.setProperty(cid, 'poster', posterCid);
            console.log(`[tmdb] Set poster CID: ${posterCid}`);
        }
    }

    if (data.backdrop_path && tmdbId) {
        const backdropCid = await downloadAndHashImage(
            data.backdrop_path,
            'backdrop',
            displayTitle,
            year,
            tmdbId
        );
        if (backdropCid) {
            await metaCore.setProperty(cid, 'backdrop', backdropCid);
            console.log(`[tmdb] Set backdrop CID: ${backdropCid}`);
        }
    }
}
