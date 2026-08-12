import { AreaTicketExternalSettlementStatus, Prisma } from '@prisma/client'

/**
 * Lee el `@default` que Prisma generó de verdad para un campo, directo del DMMF del
 * datamodel — no necesita una base de datos viva. Un `toBe('AVOQADO')` contra el enum
 * exportado (`AreaSettlementRoute.AVOQADO === 'AVOQADO'`) es tautológico: eso solo
 * prueba que el codegen de Prisma nombra los enums como se esperaba, sin importar qué
 * campo del modelo trae el default. Esto prueba lo que de verdad importa: que ESTOS
 * campos concretos siguen naciendo en AVOQADO.
 */
function fieldDefault(modelName: string, fieldName: string): unknown {
  const model = Prisma.dmmf.datamodel.models.find(m => m.name === modelName)
  const field = model?.fields.find(f => f.name === fieldName)
  return field?.default
}

describe('Schema — ruta externa', () => {
  it('AVOQADO es el @default real de settlementRoute en AreaTicket y FulfillmentArea, para que ningún venue existente cambie de comportamiento', () => {
    expect(fieldDefault('AreaTicket', 'settlementRoute')).toBe('AVOQADO')
    expect(fieldDefault('FulfillmentArea', 'settlementRoute')).toBe('AVOQADO')
  })

  it('el cobro externo distingue asumido de confirmado — nunca son lo mismo', () => {
    expect(Object.keys(AreaTicketExternalSettlementStatus).sort()).toEqual(
      ['ASSUMED', 'CONFIRMED', 'DISCREPANCY', 'NOT_CHARGED', 'PENDING'].sort(),
    )
  })
})
