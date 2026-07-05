import { validateGoogleReviewLink, normalizeGoogleReviewUrl } from '../../../src/utils/googleReviewLink'

describe('validateGoogleReviewLink', () => {
  it('accepts a full g.page review URL', () => {
    expect(validateGoogleReviewLink('https://g.page/r/AbC123_/review')).toBeNull()
  })
  it('accepts a search.google.com writereview URL', () => {
    expect(validateGoogleReviewLink('https://search.google.com/local/writereview?placeid=ChIJ12345abc')).toBeNull()
  })
  it('accepts a bare Place ID', () => {
    expect(validateGoogleReviewLink('ChIJ12345abcDEF-_')).toBeNull()
  })
  it('treats empty string as valid (clearing)', () => {
    expect(validateGoogleReviewLink('   ')).toBeNull()
  })
  it('rejects a non-Google URL with a Spanish message', () => {
    const err = validateGoogleReviewLink('https://facebook.com/mypage')
    expect(err).toMatch(/Google/)
  })
  it('rejects a malformed URL', () => {
    expect(validateGoogleReviewLink('http://')).not.toBeNull()
  })
  it('rejects a Place ID with spaces/symbols', () => {
    expect(validateGoogleReviewLink('ChIJ 12/34.5')).not.toBeNull()
  })
  it('rejects a too-short Place ID', () => {
    expect(validateGoogleReviewLink('abc')).not.toBeNull()
  })
})

describe('normalizeGoogleReviewUrl', () => {
  it('passes through a full URL unchanged', () => {
    expect(normalizeGoogleReviewUrl('https://g.page/r/AbC/review')).toBe('https://g.page/r/AbC/review')
  })
  it('builds a writereview URL from a bare Place ID', () => {
    expect(normalizeGoogleReviewUrl('ChIJ12345abc')).toBe('https://search.google.com/local/writereview?placeid=ChIJ12345abc')
  })
  it('returns null for null/empty', () => {
    expect(normalizeGoogleReviewUrl(null)).toBeNull()
    expect(normalizeGoogleReviewUrl('  ')).toBeNull()
  })
})
