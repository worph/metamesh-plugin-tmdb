/**
 * The `posters/{lang3}/{cid}` key-set for a TMDB-enriched video record
 * (METADATA_KEYS.md §6): the primary poster plus the best-voted alternatives.
 *
 * CROSS-BINARY CONTRACT: same ranking, cap, CDN size and language rule as the
 * tmdb card feeder's `poster_member_keys`
 * (`meta-feeder-tmdb/feeder-plugin/card-feeder/src/card.rs`).
 */

import { encodeUrlCid } from './cid.js';

/** Most members a record's `posters/*` key-set may carry, the primary included. */
export const MAX_POSTER_MEMBERS = 10;

/**
 * CDN root + size the alternatives are referenced at. `w500`, as the card
 * feeder's `poster_url`, so both writers mint the same locator for one image.
 */
export const ALT_POSTER_BASE_URL = 'https://image.tmdb.org/t/p/w500';

/** One entry of a TMDB details payload's `images.posters` (`append_to_response=images`). */
export interface TmdbImage {
    file_path?: string;
    iso_639_1?: string | null;
    vote_average?: number;
    vote_count?: number;
}

/**
 * ISO 639-1 → ISO 639-3 (`lang3`), the 639-2/T form where B and T differ
 * (`fra`, `deu`, `zho` — never `fre`/`ger`/`chi`). Mirrors the card feeder's
 * `iso639_1_to_3` table.
 */
const ISO639_1_TO_3: Record<string, string> = {
    en: 'eng', ja: 'jpn', fr: 'fra', de: 'deu', es: 'spa', it: 'ita', ru: 'rus',
    ko: 'kor', zh: 'zho', pt: 'por', nl: 'nld', sv: 'swe', no: 'nor', da: 'dan',
    fi: 'fin', pl: 'pol', tr: 'tur', ar: 'ara', hi: 'hin', th: 'tha', vi: 'vie',
    id: 'ind', cs: 'ces', el: 'ell', he: 'heb', hu: 'hun', ro: 'ron', uk: 'ukr',
    fa: 'fas', ms: 'msa', tl: 'tgl', ca: 'cat', nb: 'nob',
};

/**
 * The language segment for a poster: that of the text printed on it. `zxx`
 * (no linguistic content) when TMDB gives none — a textless poster — and
 * `und` for a code outside the table.
 */
export function posterLang3(code: string | null | undefined): string {
    const trimmed = (code ?? '').trim().toLowerCase();
    if (!trimmed) return 'zxx';
    return ISO639_1_TO_3[trimmed] ?? 'und';
}

function compareCandidates(a: TmdbImage, b: TmdbImage): number {
    const byAverage = (b.vote_average ?? 0) - (a.vote_average ?? 0);
    if (byAverage !== 0) return byAverage;
    const byCount = (b.vote_count ?? 0) - (a.vote_count ?? 0);
    if (byCount !== 0) return byCount;
    const pa = a.file_path ?? '';
    const pb = b.file_path ?? '';
    return pa < pb ? -1 : pa > pb ? 1 : 0;
}

/**
 * The `posters/{lang3}/{cid}` members to merge onto a record whose `poster` is
 * `primaryPosterCid`. The primary is always a member, filed under the language
 * of its own `images.posters` entry (`und` if TMDB did not list it); the
 * alternatives follow as `url` locators, ranked by `vote_average`, then
 * `vote_count`, then `file_path` (so equal payloads give equal keys), capped at
 * {@link MAX_POSTER_MEMBERS} in total.
 *
 * Returns `{}` when the payload has no image list — a cached entry from before
 * the `images` append. Without one the primary's language is unknown, and a set
 * is better absent than mislabelled.
 */
export function posterMembers(data: any, primaryPosterCid: string): Record<string, 'true'> {
    const candidates: TmdbImage[] = Array.isArray(data?.images?.posters) ? data.images.posters : [];
    if (candidates.length === 0 || !primaryPosterCid) {
        return {};
    }
    const primaryPath: string | undefined = data?.poster_path;
    const members: Record<string, 'true'> = {};

    const primary = candidates.find((img) => !!img.file_path && img.file_path === primaryPath);
    const primaryLang = primary ? posterLang3(primary.iso_639_1) : 'und';
    members[`posters/${primaryLang}/${primaryPosterCid}`] = 'true';
    let count = 1;

    const ranked = candidates
        .filter((img) => typeof img.file_path === 'string' && img.file_path.trim() !== '' && img.file_path !== primaryPath)
        .sort(compareCandidates);
    for (const img of ranked) {
        if (count >= MAX_POSTER_MEMBERS) break;
        const cid = encodeUrlCid(`${ALT_POSTER_BASE_URL}/${img.file_path!.replace(/^\/+/, '')}`);
        if (!cid) continue;
        const key = `posters/${posterLang3(img.iso_639_1)}/${cid}`;
        if (!(key in members)) {
            members[key] = 'true';
            count++;
        }
    }
    return members;
}
