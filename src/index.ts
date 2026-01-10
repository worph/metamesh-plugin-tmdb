/**
 * MetaMesh Plugin: TMDB
 *
 * ============================================================================
 * PLUGIN MOUNT ARCHITECTURE - DO NOT MODIFY WITHOUT AUTHORIZATION
 * ============================================================================
 *
 * Each plugin container has exactly 3 mounts:
 *
 *   1. /files          (READ-ONLY)  - Shared media files, read access only
 *   2. /cache          (READ-WRITE) - Plugin-specific cache folder
 *   3. /files/plugin/<name> (READ-WRITE for this plugin, READ-ONLY for others)
 *                                   - Plugin output folder for generated files
 *
 * SECURITY: Plugins must NEVER write to /files directly.
 * - Use /cache for temporary/cache data
 * - Use /files/plugin/<name> for output files (e.g., posters, generated assets)
 *
 * This architecture ensures:
 * - Plugins cannot corrupt user's media files
 * - Plugins can share generated assets with other plugins (read-only)
 * - Each plugin has isolated cache storage
 *
 * ============================================================================
 */

import Fastify from 'fastify';
import type { HealthResponse, ProcessRequest, ProcessResponse, CallbackPayload, ConfigureRequest, ConfigureResponse } from './types.js';
import { manifest, process as processFile, configure } from './plugin.js';

const app = Fastify({ logger: true });
let ready = false;

app.get('/health', async (): Promise<HealthResponse> => ({ status: 'healthy', ready, version: manifest.version }));
app.get('/manifest', async () => manifest);
app.post<{ Body: ConfigureRequest }>('/configure', async (request): Promise<ConfigureResponse> => {
    try {
        configure(request.body.config || {});
        console.log(`[${manifest.id}] Configuration updated`);
        return { status: 'ok' };
    } catch (error) {
        return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
});
app.post('/recompute', async () => {
    configure({ forceRecompute: true });
    console.log(`[${manifest.id}] Recompute mode enabled`);
    return { status: 'ok', message: 'Recompute mode enabled' };
});
app.post<{ Body: ProcessRequest }>('/process', async (request, reply) => {
    const { taskId, cid, filePath, callbackUrl, metaCoreUrl } = request.body;
    if (!taskId || !cid || !filePath || !callbackUrl || !metaCoreUrl) {
        return reply.send({ status: 'rejected', error: 'Missing required fields' } as ProcessResponse);
    }
    processFile(request.body, async (payload: CallbackPayload) => {
        try { await fetch(callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
        catch (error) { console.error(`[${manifest.id}] Callback error:`, error); }
    }).catch(console.error);
    return reply.send({ status: 'accepted' } as ProcessResponse);
});

const port = parseInt(process.env.PORT || '8080', 10);
app.listen({ port, host: '0.0.0.0' }).then(() => { ready = true; console.log(`[${manifest.id}] Listening on port ${port}`); });
process.on('SIGTERM', async () => { ready = false; await app.close(); process.exit(0); });
