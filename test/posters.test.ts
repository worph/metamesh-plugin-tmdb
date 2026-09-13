import { describe, expect, it } from 'vitest';
import { encodeUrlCid } from '../src/cid.js';
import { ALT_POSTER_BASE_URL, MAX_POSTER_MEMBERS, posterLang3, posterMembers, type TmdbImage } from '../src/posters.js';

const alt = (path: string) => encodeUrlCid(`${ALT_POSTER_BASE_URL}${path}`)!;
const img = (file_path: string, iso_639_1: string | null, vote_average = 0, vote_count = 0): TmdbImage => ({
    file_path,
    iso_639_1,
    vote_average,
    vote_count,
});

describe('encodeUrlCid', () => {
    // Same vectors as meta-feeder-tmdb's vendored `hash.rs::url_cid_matches_pinned_vectors`.
    it('matches the pinned Rust vectors', () => {
        expect(encodeUrlCid('https://image.tmdb.org/t/p/w500/dqZENchTd7lp5zit1Q7Bkjzcxpi.jpg')).toBe(
            'bagdcaab7nb2hi4dthixs62lnmftwkltunvsgeltpojts65bpoaxxonjqgaxwi4k2ivhgg2cumq3wy4bvpjuximkrg5bgw2t2mn4ha2jonjygo',
        );
    });

    it('uses a two-byte length varint past 127 bytes', () => {
        const long = `https://image.tmdb.org/t/p/w500/${'a'.repeat(100)}.jpg`;
        expect(long.length).toBe(136);
        expect(encodeUrlCid(long)).toBe(
            'bagdcaaeiafuhi5dqom5c6l3jnvqwozjoorwwiyron5zgol3uf5yc65zvgayc6ylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcylbmfqwcltkobtq',
        );
    });

    it('rejects anything but an absolute http(s) URL', () => {
        expect(encodeUrlCid('/relative.jpg')).toBeNull();
        expect(encodeUrlCid('ftp://example.com/x.jpg')).toBeNull();
        expect(encodeUrlCid('')).toBeNull();
    });
});

describe('posterLang3', () => {
    it('maps to ISO 639-3, never 639-2/B', () => {
        expect(posterLang3('fr')).toBe('fra');
        expect(posterLang3('de')).toBe('deu');
        expect(posterLang3('EN')).toBe('eng');
    });

    it('files a textless poster under zxx and an unknown code under und', () => {
        expect(posterLang3(null)).toBe('zxx');
        expect(posterLang3(undefined)).toBe('zxx');
        expect(posterLang3('xx')).toBe('und');
    });
});

describe('posterMembers', () => {
    const PRIMARY_CID = 'bagacbabaecontentcid';

    it('lists the primary under its own language, once, beside the alternatives', () => {
        const data = {
            poster_path: '/primary.jpg',
            images: {
                posters: [img('/alt-fr.jpg', 'fr', 5.5, 10), img('/primary.jpg', 'ja', 5, 3), img('/textless.jpg', null, 6, 1)],
            },
        };
        expect(posterMembers(data, PRIMARY_CID)).toEqual({
            [`posters/jpn/${PRIMARY_CID}`]: 'true',
            [`posters/zxx/${alt('/textless.jpg')}`]: 'true',
            [`posters/fra/${alt('/alt-fr.jpg')}`]: 'true',
        });
    });

    it('ranks by vote_average then vote_count, and caps at ten including the primary', () => {
        const posters = Array.from({ length: 15 }, (_, i) => img(`/p${String(i).padStart(2, '0')}.jpg`, 'en', i, 1));
        const keys = Object.keys(posterMembers({ poster_path: '/primary.jpg', images: { posters } }, PRIMARY_CID));
        expect(keys).toHaveLength(MAX_POSTER_MEMBERS);
        expect(keys[0]).toBe(`posters/und/${PRIMARY_CID}`);
        expect(keys[1]).toBe(`posters/eng/${alt('/p14.jpg')}`);
        expect(keys).not.toContain(`posters/eng/${alt('/p05.jpg')}`);

        const tie = Object.keys(
            posterMembers(
                { poster_path: '/primary.jpg', images: { posters: [img('/few.jpg', null, 5, 1), img('/many.jpg', null, 5, 9)] } },
                PRIMARY_CID,
            ),
        );
        expect(tie[1]).toBe(`posters/zxx/${alt('/many.jpg')}`);
    });

    it('writes no set when the payload has no image list', () => {
        expect(posterMembers({ poster_path: '/primary.jpg' }, PRIMARY_CID)).toEqual({});
        expect(posterMembers({ poster_path: '/primary.jpg', images: { posters: [] } }, PRIMARY_CID)).toEqual({});
    });
});
