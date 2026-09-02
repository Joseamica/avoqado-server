import { ValidationError } from '@/errors/AppError'

const COMMERCIAL_DRAFT_ETAG = /^W\/"commercial-draft:([^":]+):([1-9]\d*)"$/

function invalidCommercialDraftEtag(): never {
  throw new ValidationError('COMMERCIAL_DRAFT_ETAG_INVALID: If-Match no corresponde al borrador solicitado.')
}

export function formatCommercialDraftEtag(draftId: string, revision: number): string {
  if (!draftId || draftId.includes(':') || draftId.includes('"') || !Number.isSafeInteger(revision) || revision < 1) {
    return invalidCommercialDraftEtag()
  }
  return `W/"commercial-draft:${draftId}:${revision}"`
}

export function parseCommercialDraftEtag(value: string, expectedDraftId: string): number {
  const match = COMMERCIAL_DRAFT_ETAG.exec(value)
  if (!match || match[1] !== expectedDraftId) return invalidCommercialDraftEtag()

  const revision = Number(match[2])
  if (!Number.isSafeInteger(revision) || revision < 1) return invalidCommercialDraftEtag()
  return revision
}
