/**
 * Google review link helpers. A venue owner may paste EITHER a full Google
 * review URL (e.g. https://g.page/r/XXXX/review) OR a bare Place ID (ChIJ...).
 * We store the raw value and normalize to a clickable "write a review" URL on read.
 */

/** Hosts we accept for a pasted full URL. Anything else is rejected. */
export const GOOGLE_REVIEW_DOMAINS = [
  'g.page',
  'goo.gl',
  'maps.app.goo.gl',
  'google.com',
  'www.google.com',
  'search.google.com',
  'maps.google.com',
]

const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,256}$/

/**
 * Returns a SPANISH error message if the value is not a valid Google review
 * link or Place ID, or `null` if it is valid. An empty/whitespace value is
 * treated as valid (it means the owner is clearing the field).
 */
export function validateGoogleReviewLink(raw: string): string | null {
  const v = (raw ?? '').trim()
  if (!v) return null // clearing the field

  if (/^https?:\/\//i.test(v)) {
    let url: URL
    try {
      url = new URL(v)
    } catch {
      return 'El link de Google no es una URL válida.'
    }
    const host = url.hostname.toLowerCase()
    if (!GOOGLE_REVIEW_DOMAINS.includes(host)) {
      return 'El link debe ser de Google (por ejemplo g.page, maps.app.goo.gl o google.com).'
    }
    return null
  }

  if (!PLACE_ID_RE.test(v)) {
    return 'Pega el link completo de Google o solo el Place ID (sin espacios ni símbolos).'
  }
  return null
}

/**
 * Turn the stored raw value into a clickable "write a review" URL:
 *  - a full URL passes through unchanged,
 *  - a bare Place ID becomes a search.google.com writereview URL,
 *  - null/empty returns null.
 */
export function normalizeGoogleReviewUrl(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  if (/^https?:\/\//i.test(v)) return v
  return `https://search.google.com/local/writereview?placeid=${v}`
}
