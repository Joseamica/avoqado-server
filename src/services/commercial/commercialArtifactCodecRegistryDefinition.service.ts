import type { CommercialArtifactCodecRegistration, CommercialPersistedArtifactKind } from '@/types/commercialCodec'

export const COMMERCIAL_ARTIFACT_CODEC_REGISTRY: readonly CommercialArtifactCodecRegistration[] = Object.freeze([
  Object.freeze({ kind: 'CATALOG', schemaVersion: 1, mode: 'READ_ONLY' }),
  Object.freeze({ kind: 'CATALOG', schemaVersion: 2, mode: 'READ_WRITE' }),
  Object.freeze({ kind: 'CAMPAIGN', schemaVersion: 1, mode: 'READ_ONLY' }),
  Object.freeze({ kind: 'CAMPAIGN', schemaVersion: 2, mode: 'READ_WRITE' }),
  Object.freeze({ kind: 'QUOTE', schemaVersion: 1, mode: 'READ_ONLY' }),
  Object.freeze({ kind: 'QUOTE', schemaVersion: 2, mode: 'READ_WRITE' }),
])

export function resolveCommercialArtifactCodec(
  kind: CommercialPersistedArtifactKind,
  schemaVersion: number,
): CommercialArtifactCodecRegistration | undefined {
  return COMMERCIAL_ARTIFACT_CODEC_REGISTRY.find(entry => entry.kind === kind && entry.schemaVersion === schemaVersion)
}
