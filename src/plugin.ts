/**
 * TMDB Plugin
 * Fetches metadata from The Movie Database API
 * Downloads poster and backdrop images to /files/poster/
 */

import axios from 'axios';
import * as fs from 'fs/promises';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import type { PluginManifest, ProcessRequest, CallbackPayload } from './types.js';
import { MetaCoreClient } from './meta-core-client.js';

const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/original';
// Use globalThis.process to avoid conflict with the exported process function
const FILES_PATH = (globalThis as any).process?.env?.FILES_PATH || '/files';

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
    },
};

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

    const posterDir = path.join(FILES_PATH, 'poster');
    const localPath = path.join(posterDir, filename);

    // Relative path for storage (relative to filesPath)
    const relativePath = `poster/${filename}`;

    // Check if file already exists (skip download)
    if (existsSync(localPath)) {
        console.log(`[tmdb] Image already exists: ${localPath}`);
    } else {
        // Ensure poster directory exists
        if (!existsSync(posterDir)) {
            mkdirSync(posterDir, { recursive: true });
            console.log(`[tmdb] Created poster directory: ${posterDir}`);
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

        // Skip if already has TMDB data
        if (existingMeta?.tmdbid) {
            await sendCallback({
                taskId: request.taskId,
                status: 'skipped',
                duration: Date.now() - startTime,
                reason: 'Already has TMDB data',
            });
            return;
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
            const metadata: Record<string, string> = {};

            const tmdbId = tmdbData.id ? String(tmdbData.id) : '';
            if (tmdbId) metadata.tmdbid = tmdbId;
            if (tmdbData.imdb_id) metadata.imdbid = tmdbData.imdb_id;

            const originalTitle = tmdbData.original_title || tmdbData.original_name;
            const localizedTitle = tmdbData.title || tmdbData.name;
            if (localizedTitle) metadata.title = localizedTitle;
            if (originalTitle) metadata.originalTitle = originalTitle;

            const releaseDate = tmdbData.release_date || tmdbData.first_air_date;
            let year: string | undefined;
            if (releaseDate) {
                metadata.releasedate = releaseDate;
                year = releaseDate.split('-')[0];
                if (year) {
                    metadata.movieYear = year;
                }
            }

            if (tmdbData.overview) metadata['plot/eng'] = tmdbData.overview;
            if (tmdbData.vote_average) metadata.rating = String(tmdbData.vote_average);

            // Download and hash poster/backdrop images
            const displayTitle = localizedTitle || originalTitle || 'Unknown';

            if (tmdbData.poster_path && tmdbId) {
                const posterResult = await downloadAndHashImage(
                    tmdbData.poster_path,
                    'poster',
                    displayTitle,
                    year,
                    tmdbId,
                    metaCore
                );
                if (posterResult) {
                    metadata.poster = posterResult.cid;
                    metadata.posterPath = posterResult.path;
                    console.log(`[tmdb] Set poster CID: ${posterResult.cid}`);
                }
            }

            if (tmdbData.backdrop_path && tmdbId) {
                const backdropResult = await downloadAndHashImage(
                    tmdbData.backdrop_path,
                    'backdrop',
                    displayTitle,
                    year,
                    tmdbId,
                    metaCore
                );
                if (backdropResult) {
                    metadata.backdrop = backdropResult.cid;
                    metadata.backdropPath = backdropResult.path;
                    console.log(`[tmdb] Set backdrop CID: ${backdropResult.cid}`);
                }
            }

            await metaCore.mergeMetadata(cid, metadata);

            // Add genres
            for (const genre of tmdbData.genres || []) {
                await metaCore.addToSet(cid, 'genres', genre.name);
            }

            // Add studios
            for (const company of tmdbData.production_companies || []) {
                await metaCore.addToSet(cid, 'studio', company.name);
            }

            await metaCore.addToSet(cid, 'tags', 'tmdb-verified');
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
