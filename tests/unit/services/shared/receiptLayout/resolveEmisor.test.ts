import { resolveEmisor } from '@/services/shared/receiptLayout/resolveEmisor'
import type { ReceiptVenueInfo } from '@/services/shared/receiptLayout/types'

const A = { id: 'emA', legalName: 'CAFÉ A SA DE CV', rfc: 'CAA010101AAA', lugarExpedicion: '06600', merchantAccountIds: ['maA'] }
const B = { id: 'emB', legalName: 'CAFÉ B SA DE CV', rfc: 'CBB020202BBB', lugarExpedicion: '06700', merchantAccountIds: ['maB'] }
const venue = (over: Partial<ReceiptVenueInfo>): ReceiptVenueInfo => ({
  name: 'Testarudo',
  hasLogo: false,
  fiscalEmisors: [A, B],
  principalEmisorId: 'emA',
  legacy: { legalName: null, rfc: null },
  ...over,
})

describe('resolveEmisor — merchant → principal → legacy', () => {
  it('🔴 una venta con tarjeta imprime el emisor de la cuenta que cobró, no el principal', () => {
    expect(resolveEmisor(venue({}), 'maB')).toEqual({
      legalName: B.legalName,
      rfc: B.rfc,
      lugarExpedicion: '06700',
      source: 'merchant',
    })
  })
  it('efectivo (sin cuenta) → el principal', () => {
    expect(resolveEmisor(venue({}), null)).toMatchObject({ rfc: A.rfc, source: 'principal' })
  })
  it('una cuenta que ningún emisor conoce → el principal (no se adivina)', () => {
    expect(resolveEmisor(venue({}), 'maX')).toMatchObject({ rfc: A.rfc, source: 'principal' })
  })
  it('sin principalEmisorId, el principal es el primero de la lista (el servidor la manda por fecha de alta)', () => {
    expect(resolveEmisor(venue({ principalEmisorId: null, fiscalEmisors: [B, A] }), null)).toMatchObject({
      rfc: B.rfc,
      source: 'principal',
    })
  })
  it('sin emisores → las columnas legacy de Venue, SIN lugar de expedición', () => {
    const v = venue({ fiscalEmisors: [], principalEmisorId: null, legacy: { legalName: 'VIEJO SA', rfc: 'VIE900101AAA' } })
    expect(resolveEmisor(v, 'maA')).toEqual({ legalName: 'VIEJO SA', rfc: 'VIE900101AAA', lugarExpedicion: null, source: 'legacy' })
  })
  it('sin emisores ni legacy → null: el bloque fiscal no imprime nada', () => {
    expect(resolveEmisor(venue({ fiscalEmisors: [], principalEmisorId: null }), null)).toBeNull()
  })
})
