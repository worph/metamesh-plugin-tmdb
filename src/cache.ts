/**
 * File-based cache utility for plugin data
 * Matches the old ctx.cache API: readJson, writeJson
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const CACHE_DIR = process.env.CACHE_DIR || '/cache';

/**
 * Ensure cache directory exists
 */
async function ensureCacheDir(): Promise<void> {
    if (!existsSync(CACHE_DIR)) {
        await mkdir(CACHE_DIR, { recursive: true });
    }
}

/**
 * Read JSON from cache
 * @param filename - Cache filename (e.g., "abc123_tmdb.json")
 * @returns Parsed JSON object or null if not found
 */
export async function readJson<T = unknown>(filename: string): Promise<T | null> {
    try {
        const filePath = path.join(CACHE_DIR, filename);
        if (!existsSync(filePath)) {
            return null;
        }
        const content = await readFile(filePath, 'utf-8');
        return JSON.parse(content) as T;
    } catch (error) {
        console.debug(`[cache] Failed to read ${filename}:`, error);
        return null;
    }
}

/**
 * Write JSON to cache
 * @param filename - Cache filename (e.g., "abc123_tmdb.json")
 * @param data - Data to cache
 */
export async function writeJson(filename: string, data: unknown): Promise<void> {
    try {
        await ensureCacheDir();
        const filePath = path.join(CACHE_DIR, filename);
        await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
        console.debug(`[cache] Wrote ${filename}`);
    } catch (error) {
        console.warn(`[cache] Failed to write ${filename}:`, error);
    }
}
