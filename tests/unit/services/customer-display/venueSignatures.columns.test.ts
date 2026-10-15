// tests/unit/services/customer-display/venueSignatures.columns.test.ts
import { Prisma } from '@prisma/client'
import {
  RECEIPT_ASSOCIATION_COLUMNS,
  RECEIPT_EMISOR_COLUMNS,
  RECEIPT_VENUE_SELECT,
} from '@/services/dashboard/receiptLayout/devicePayload.service'
import { venueSignaturesSql } from '@/services/customer-display/venueSignatures'

describe('la firma del venue cubre TODO lo que consume el recibo', () => {
  const sql = venueSignaturesSql('venue-1').sql

  it('cada columna del emisor que lee el recibo entra al hash de emisores', () => {
    for (const c of RECEIPT_EMISOR_COLUMNS) expect(sql).toContain(`e."${c}"`)
    expect(sql).toContain('e."createdAt"') // el orden decide el principal: también entra
  })

  it('cada columna de la asociación que lee el recibo entra al hash de asociaciones', () => {
    for (const c of RECEIPT_ASSOCIATION_COLUMNS) expect(sql).toContain(`m."${c}"`)
    expect(sql).toContain('m."fiscalEmisorId"') // una reasignación cambia la firma
  })

  it('lo demás del recibo son columnas del Venue: las cubre Venue.updatedAt', () => {
    const modelo = Prisma.dmmf.datamodel.models.find(m => m.name === 'Venue')!
    const escalares = new Set(modelo.fields.filter(f => f.kind === 'scalar').map(f => f.name))
    const { fiscalEmisors: _emisores, ...delVenue } = RECEIPT_VENUE_SELECT
    for (const columna of Object.keys(delVenue)) expect(escalares.has(columna)).toBe(true)
  })

  it('el venue va como parámetro, nunca pegado al texto', () => {
    expect(sql).not.toContain('venue-1')
    expect(venueSignaturesSql('venue-1').values).toContain('venue-1')
  })
})
