/**
 * TMDB Plugin
 *
 * Fetches metadata from The Movie Database (TMDB) API.
 * Supports both v3 API keys and v4 Bearer tokens.
 * Downloads poster and backdrop images to /output/
 *
 * ============================================================================
 * PLUGIN MOUNT ARCHITECTURE - DO NOT MODIFY WITHOUT AUTHORIZATION
 * ============================================================================
 *
 * Each plugin container has exactly 3 mounts:
 *
 *   1. /files              (READ-ONLY)  - Shared media files, read access only
 *   2. /cache              (READ-WRITE) - Plugin-specific cache folder
 *   3. /output  (READ-WRITE) - Plugin output folder for posters/images
 *
 * SECURITY: Plugins must NEVER write to /files directly.
 * - Use /cache for temporary/cache data (e.g., TMDB API responses)
 * - Use /output for output files (e.g., posters, backdrops)
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
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import type { PluginManifest, ProcessRequest, CallbackPayload } from './types.js';
import { MetaCoreClient } from './meta-core-client.js';
import { readJson, writeJson } from './cache.js';

const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/original';

/**
 * ============================================================================
 * MOUNT PATHS - Enforced by plugin architecture
 * ============================================================================
 * FILES_PATH (/files) - READ-ONLY access to media files
 * PLUGIN_OUTPUT_PATH (/output) - READ-WRITE for plugin-generated files
 * CACHE_PATH (/cache) - READ-WRITE for plugin cache (handled by cache.ts)
 * ============================================================================
 */
// Use globalThis.process to avoid conflict with the exported process function
const FILES_PATH = (globalThis as any).process?.env?.FILES_PATH || '/files';
const PLUGIN_OUTPUT_PATH = '/output';

export const manifest: PluginManifest = {
    id: 'tmdb',
    name: 'TMDB Metadata',
    version: '1.0.0',
    description: 'Fetches metadata from The Movie Database (TMDB) API',
    author: 'MetaMesh',
    dependencies: ['file-info', 'filename-parser', 'jellyfin-nfo'],
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
 * Download an image from URL to local path
 *
 * IMPORTANT: Images are saved to PLUGIN_OUTPUT_PATH (/output)
 * NOT to /files directly. See mount architecture comments at top of file.
 */
async function downloadImage(imageUrl: string, localPath: string): Promise<boolean> {
    try {
        const response = await axios({
            method: 'get',
            url: imageUrl,
            responseType: 'stream',
            timeout: 30000,
        });

        // Ensure directory exists
        const dir = path.dirname(localPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        // Pipe the response to a file
        const writer = createWriteStream(localPath);
        await pipeline(response.data, writer);

        console.log(`[tmdb] Downloaded image to ${localPath}`);
        return true;
    } catch (error) {
        console.error(`[tmdb] Failed to download image from ${imageUrl}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

/**
 * Download and hash an image, returning its CID and path
 *
 * IMPORTANT: Images are saved to PLUGIN_OUTPUT_PATH (/output)
 * This is the plugin's dedicated output folder with READ-WRITE access.
 * Other plugins can read these files but cannot write to this location.
 *
 * @returns {Promise<{cid: string, path: string} | null>}
 */
async function downloadAndHashImage(
    imagePath: string,
    imageType: string,
    title: string,
    year: string | undefined,
    tmdbId: string,
    metaCore: MetaCoreClient
): Promise<{ cid: string; path: string } | null> {
    if (!imagePath) {
        return null;
    }

    const imageUrl = `${IMAGE_BASE_URL}${imagePath}`;
    const ext = path.extname(imagePath) || '.jpg';

    // Build filename: <title> (<year>)[tmdb<tmdbId>]_<type>.jpg
    // Note: Don't include file CID to avoid duplicate posters for same movie
    const safeName = sanitizeFilename(title);
    const yearStr = year ? ` (${year})` : '';
    const filename = `${safeName}${yearStr}[tmdb${tmdbId}]_${imageType}${ext}`;

    // IMPORTANT: Write to PLUGIN_OUTPUT_PATH, not FILES_PATH
    // This respects the mount architecture: /files is READ-ONLY
    const localPath = path.join(PLUGIN_OUTPUT_PATH, filename);

    // Relative path for storage (relative to /files for meta-core compatibility)
    // Path format: plugin/tmdb/<filename>
    const relativePath = `plugin/tmdb/${filename}`;

    // Check if file already exists (skip download)
    if (existsSync(localPath)) {
        console.log(`[tmdb] Image already exists: ${localPath}`);
    } else {
        // Ensure plugin output directory exists
        if (!existsSync(PLUGIN_OUTPUT_PATH)) {
            mkdirSync(PLUGIN_OUTPUT_PATH, { recursive: true });
            console.log(`[tmdb] Created plugin output directory: ${PLUGIN_OUTPUT_PATH}`);
        }

        // Download the image
        const downloaded = await downloadImage(imageUrl, localPath);
        if (!downloaded) {
            return null;
        }
    }

    // Compute CID using meta-core API
    try {
        const cid = await metaCore.computeFileCID(relativePath);
        if (cid) {
            console.log(`[tmdb] Image ${imageType} CID: ${cid}`);
            return { cid, path: relativePath };
        } else {
            console.warn(`[tmdb] Failed to compute CID for ${localPath}`);
        }
    } catch (e) {
        console.error(`[tmdb] Failed to compute CID for ${localPath}: ${e instanceof Error ? e.message : String(e)}`);
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
    if (data.poster_path && tmdbId) {
        const posterResult = await downloadAndHashImage(
            data.poster_path,
            'poster',
            displayTitle,
            year,
            tmdbId,
            metaCore as any
        );
        if (posterResult) {
            await metaCore.setProperty(cid, 'poster', posterResult.cid);
            await metaCore.setProperty(cid, 'posterPath', posterResult.path);
            console.log(`[tmdb] Set poster CID: ${posterResult.cid}`);
        }
    }

    if (data.backdrop_path && tmdbId) {
        const backdropResult = await downloadAndHashImage(
            data.backdrop_path,
            'backdrop',
            displayTitle,
            year,
            tmdbId,
            metaCore as any
        );
        if (backdropResult) {
            await metaCore.setProperty(cid, 'backdrop', backdropResult.cid);
            await metaCore.setProperty(cid, 'backdropPath', backdropResult.path);
            console.log(`[tmdb] Set backdrop CID: ${backdropResult.cid}`);
        }
    }
}
