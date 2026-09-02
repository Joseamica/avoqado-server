import { formatCommercialDraftEtag, parseCommercialDraftEtag } from '@/services/commercial/commercialDraftEtag'

describe('commercial draft ETag', () => {
  it('round-trips the draft identity and revision using the frozen wire contract', () => {
    const etag = formatCommercialDraftEtag('draft_1', 7)

    expect(etag).toBe('W/"commercial-draft:draft_1:7"')
    expect(parseCommercialDraftEtag(etag, 'draft_1')).toBe(7)
  })

  it.each([
    ['"7"', 'draft_1'],
    ['W/"commercial-draft:draft_other:7"', 'draft_1'],
    ['W/"commercial-draft:draft_1:0"', 'draft_1'],
    ['W/"commercial-draft:draft_1:7:extra"', 'draft_1'],
  ])('rejects a stale or malformed validator %s', (etag, draftId) => {
    expect(() => parseCommercialDraftEtag(etag, draftId)).toThrow('COMMERCIAL_DRAFT_ETAG_INVALID')
  })
})
