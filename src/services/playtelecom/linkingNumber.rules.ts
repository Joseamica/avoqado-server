import type { SaleVerificationNumberSource } from '@prisma/client'

export type CaptureDestination = 'PHOTO_VINCULACION' | 'PHOTO_PORTABILIDAD' | 'LINKING' | 'PORTED'
/** Por destino, la última captura aplicada de cada aparato (captureDeviceId -> captureSeq). */
export type AppliedCaptureSeqs = Partial<Record<CaptureDestination, Record<string, number>>>
export type NumberAlertCode = 'LINKING_DUPLICATE' | 'PORTED_DUPLICATE' | 'NOT_10_DIGITS' | 'LINKING_MISSING' | 'PORTED_MISSING'

/** Quita sólo espacios, guiones, puntos y paréntesis; cualquier otro carácter (una letra, "+") se queda y el número no valida. */
export const normalizeLinkingNumber = (raw: string): string => raw.replace(/[\s\-.()]/g, '')

export const isValidTerminalNumber = (digits: string): boolean => /^\d{9,10}$/.test(digits)

export const isValidBackofficeNumber = (digits: string, allowNine: boolean): boolean =>
  /^\d{10}$/.test(digits) || (allowNine && /^\d{9}$/.test(digits))

export const isNewerCapture = (a: AppliedCaptureSeqs, d: CaptureDestination, deviceId: string, seq: number): boolean => {
  const byDevice = a[d]
  // Own-property: un captureDeviceId como "constructor" no debe leer lo heredado.
  return !byDevice || !Object.hasOwn(byDevice, deviceId) || seq > byDevice[deviceId]
}

export const withAppliedCapture = (a: AppliedCaptureSeqs, d: CaptureDestination, deviceId: string, seq: number): AppliedCaptureSeqs => ({
  ...a,
  [d]: { ...a[d], [deviceId]: seq },
})

/** La terminal no pisa lo que escribió el back-office, una venta externa o una importación. */
export const canTerminalWriteNumber = (source: SaleVerificationNumberSource | null): boolean => source === null || source === 'TPV'

export function computeNumberAlerts(s: {
  linkingNumber: string | null
  linkingNumberSource: SaleVerificationNumberSource | null
  portedNumber: string | null
  portedNumberSource: SaleVerificationNumberSource | null
  isPortabilidad: boolean
  photos: string[]
  isExternalSale: boolean
  linkingDuplicate: boolean
  portedDuplicate: boolean
}): NumberAlertCode[] {
  const out: NumberAlertCode[] = []
  if (s.linkingDuplicate) out.push('LINKING_DUPLICATE')
  if (s.portedDuplicate) out.push('PORTED_DUPLICATE')
  // 9 dígitos sólo es normal si el back-office lo confirmó a propósito.
  const not10 = (n: string | null, src: SaleVerificationNumberSource | null) => n !== null && n.length === 9 && src !== 'BACKOFFICE'
  if (not10(s.linkingNumber, s.linkingNumberSource) || not10(s.portedNumber, s.portedNumberSource)) out.push('NOT_10_DIGITS')
  const has = (i: number) => !!s.photos[i]
  // Sin número pero con su foto (o venta externa): falta. Sin foto todavía, la terminal aún lo manda.
  if (s.linkingNumber === null && (has(0) || s.isExternalSale)) out.push('LINKING_MISSING')
  if (s.isPortabilidad && s.portedNumber === null && (has(1) || s.isExternalSale)) out.push('PORTED_MISSING')
  return out
}
