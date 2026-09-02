export type CommercialQuotePreviewSecretIssueCode = 'MISSING' | 'TOO_SHORT' | 'REUSED'

export interface CommercialQuotePreviewSecretIssue {
  code: CommercialQuotePreviewSecretIssueCode
  field: 'COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET'
  message: string
}

export interface CommercialQuotePreviewSecretsInput {
  quotePreviewSigningSecret: unknown
  publicationPreviewSigningSecret: unknown
}

const FIELD = 'COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET' as const

function issue(code: CommercialQuotePreviewSecretIssueCode, message: string): CommercialQuotePreviewSecretIssue[] {
  return [{ code, field: FIELD, message }]
}

export function getCommercialQuotePreviewSecretIssues(input: CommercialQuotePreviewSecretsInput): CommercialQuotePreviewSecretIssue[] {
  if (typeof input.quotePreviewSigningSecret !== 'string' || input.quotePreviewSigningSecret.length === 0) {
    return issue('MISSING', 'COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET is required')
  }
  if (Buffer.byteLength(input.quotePreviewSigningSecret, 'utf8') < 32) {
    return issue('TOO_SHORT', 'COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET must contain at least 32 UTF-8 bytes')
  }
  if (
    typeof input.publicationPreviewSigningSecret === 'string' &&
    Buffer.from(input.quotePreviewSigningSecret, 'utf8').equals(Buffer.from(input.publicationPreviewSigningSecret, 'utf8'))
  ) {
    return issue('REUSED', 'COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET must differ from COMMERCIAL_PREVIEW_SIGNING_SECRET')
  }
  return []
}

export function assertCommercialQuotePreviewSecrets(input: CommercialQuotePreviewSecretsInput): void {
  if (getCommercialQuotePreviewSecretIssues(input).length !== 0) {
    throw new Error('COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET_INVALID')
  }
}
