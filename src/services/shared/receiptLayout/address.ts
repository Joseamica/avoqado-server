import type { ReceiptVenueInfo } from './types'

/** Minúsculas y sin marcas diacríticas: el mismo dato viene escrito distinto en cada campo. Espejo de Android e iOS. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
}

/**
 * «Nápoles 47, Cuauhtémoc, Ciudad de México, CP 06600» — una línea.
 *
 * 🔴 NO repite lo que `address` ya dice. Medido en papel el 1-sep: una dirección real ya venía
 * completa y pegarle ciudad, estado y CP gastaba tres renglones diciendo lo mismo. Puerto de
 * `ReceiptInfo.addressLine` de Android; las tres apps lo implementan igual.
 */
export function addressLine(venue: Pick<ReceiptVenueInfo, 'address' | 'city' | 'state' | 'zipCode'>): string | null {
  const parts: string[] = []
  const add = (value?: string | null) => {
    const v = value?.trim()
    if (!v) return
    if (!parts.some(p => normalize(p).includes(normalize(v)))) parts.push(v)
  }
  add(venue.address)
  add(venue.city)
  add(venue.state)
  const cp = venue.zipCode?.trim()
  if (cp && !parts.some(p => p.includes(cp))) parts.push(`CP ${cp}`)
  return parts.length ? parts.join(', ') : null
}
