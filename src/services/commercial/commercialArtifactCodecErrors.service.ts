import type { CommercialPersistedArtifactKind } from '@/types/commercialCodec'

export type CommercialArtifactCodecErrorCode =
  | 'COMMERCIAL_ARTIFACT_ENVELOPE_INVALID'
  | 'COMMERCIAL_ARTIFACT_KIND_UNSUPPORTED'
  | 'COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED'
  | `COMMERCIAL_${CommercialPersistedArtifactKind}_SCHEMA_UNSUPPORTED`
  | `COMMERCIAL_${CommercialPersistedArtifactKind}_CONTRACT_UNSUPPORTED`
  | `COMMERCIAL_${CommercialPersistedArtifactKind}_SHAPE_INVALID`
  | `COMMERCIAL_${CommercialPersistedArtifactKind}_CHECKSUM_INVALID`
  | `COMMERCIAL_${CommercialPersistedArtifactKind}_IDENTITY_MISMATCH`
  | `COMMERCIAL_${CommercialPersistedArtifactKind}_SCOPE_MISMATCH`
  | 'COMMERCIAL_V1_EMISSION_DISABLED'
  | 'COMMERCIAL_QUOTE_V1_ACCEPTANCE_DISABLED'
  | 'COMMERCIAL_QUOTE_SUBJECT_NOT_ACCEPTABLE'

const MESSAGE_BY_CODE: Readonly<Record<CommercialArtifactCodecErrorCode, string>> = Object.freeze({
  COMMERCIAL_ARTIFACT_ENVELOPE_INVALID: 'Commercial artifact envelope is invalid.',
  COMMERCIAL_ARTIFACT_KIND_UNSUPPORTED: 'Commercial artifact kind is unsupported.',
  COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED: 'Verified commercial artifact is required.',
  COMMERCIAL_CATALOG_SCHEMA_UNSUPPORTED: 'Commercial catalog schema is unsupported.',
  COMMERCIAL_CAMPAIGN_SCHEMA_UNSUPPORTED: 'Commercial campaign schema is unsupported.',
  COMMERCIAL_QUOTE_SCHEMA_UNSUPPORTED: 'Commercial quote schema is unsupported.',
  COMMERCIAL_CATALOG_CONTRACT_UNSUPPORTED: 'Commercial catalog contract is unsupported.',
  COMMERCIAL_CAMPAIGN_CONTRACT_UNSUPPORTED: 'Commercial campaign contract is unsupported.',
  COMMERCIAL_QUOTE_CONTRACT_UNSUPPORTED: 'Commercial quote contract is unsupported.',
  COMMERCIAL_CATALOG_SHAPE_INVALID: 'Commercial catalog shape is invalid.',
  COMMERCIAL_CAMPAIGN_SHAPE_INVALID: 'Commercial campaign shape is invalid.',
  COMMERCIAL_QUOTE_SHAPE_INVALID: 'Commercial quote shape is invalid.',
  COMMERCIAL_CATALOG_CHECKSUM_INVALID: 'Commercial catalog checksum is invalid.',
  COMMERCIAL_CAMPAIGN_CHECKSUM_INVALID: 'Commercial campaign checksum is invalid.',
  COMMERCIAL_QUOTE_CHECKSUM_INVALID: 'Commercial quote checksum is invalid.',
  COMMERCIAL_CATALOG_IDENTITY_MISMATCH: 'Commercial catalog identity does not match its row.',
  COMMERCIAL_CAMPAIGN_IDENTITY_MISMATCH: 'Commercial campaign identity does not match its row.',
  COMMERCIAL_QUOTE_IDENTITY_MISMATCH: 'Commercial quote identity does not match its row.',
  COMMERCIAL_CATALOG_SCOPE_MISMATCH: 'Commercial catalog scope does not match its row.',
  COMMERCIAL_CAMPAIGN_SCOPE_MISMATCH: 'Commercial campaign scope does not match its row.',
  COMMERCIAL_QUOTE_SCOPE_MISMATCH: 'Commercial quote scope does not match its row.',
  COMMERCIAL_V1_EMISSION_DISABLED: 'Commercial v1 emission is disabled.',
  COMMERCIAL_QUOTE_V1_ACCEPTANCE_DISABLED: 'Commercial quote v1 acceptance is disabled.',
  COMMERCIAL_QUOTE_SUBJECT_NOT_ACCEPTABLE: 'Commercial quote subject is not acceptable.',
})

export class CommercialArtifactCodecError extends Error {
  readonly code: CommercialArtifactCodecErrorCode

  constructor(code: CommercialArtifactCodecErrorCode) {
    super(MESSAGE_BY_CODE[code])
    this.name = 'CommercialArtifactCodecError'
    this.code = code
  }
}

export function failCommercialArtifactCodec(code: CommercialArtifactCodecErrorCode): never {
  throw new CommercialArtifactCodecError(code)
}

export function artifactCode(
  kind: CommercialPersistedArtifactKind,
  suffix: 'SCHEMA_UNSUPPORTED' | 'CONTRACT_UNSUPPORTED' | 'SHAPE_INVALID' | 'CHECKSUM_INVALID' | 'IDENTITY_MISMATCH' | 'SCOPE_MISMATCH',
): CommercialArtifactCodecErrorCode {
  return `COMMERCIAL_${kind}_${suffix}`
}
