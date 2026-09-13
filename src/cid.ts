/**
 * CID encoding helpers (METADATA_KEYS.md §2).
 */

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lowercase, no padding, with the `b` multibase prefix. */
export function base32LowerMultibase(bytes: Uint8Array): string {
    let out = 'b';
    let bits = 0;
    let value = 0;
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            out += BASE32_ALPHABET[(value >> bits) & 0x1f];
        }
    }
    if (bits > 0) {
        out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
    }
    return out;
}

/** Unsigned LEB128 varint, as multiformats encodes codecs and lengths. */
function varint(value: number): number[] {
    const out: number[] = [];
    let n = value;
    while (n >= 0x80) {
        out.push((n & 0x7f) | 0x80);
        n = Math.floor(n / 0x80);
    }
    out.push(n);
    return out;
}

/** Custom multicodec of the `url` locator (METADATA_KEYS.md §2.1). */
export const URL_LOCATOR_CODEC = 0x1006;

/**
 * Encode an absolute http(s) URL as a `0x1006` identity-multihash CIDv1:
 * `[0x01][varint codec][0x00][varint len][utf-8 url]`, base32lower. The digest
 * is the URL itself, so minting one costs no I/O. `null` for anything that is
 * not an absolute http(s) URL.
 *
 * CROSS-BINARY CONTRACT: byte-identical to meta-feeder-sdk's `compute_url_cid`
 * (`hash.rs`); both test suites pin the same vectors.
 */
export function encodeUrlCid(url: string): string | null {
    const trimmed = url.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        return null;
    }
    const digest = Buffer.from(trimmed, 'utf8');
    const header = Buffer.from([0x01, ...varint(URL_LOCATOR_CODEC), 0x00, ...varint(digest.length)]);
    return base32LowerMultibase(Buffer.concat([header, digest]));
}
