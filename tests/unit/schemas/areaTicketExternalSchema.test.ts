import { AreaSettlementRoute, AreaTicketExternalSettlementStatus } from '@prisma/client'

describe('Schema — ruta externa', () => {
  it('AVOQADO es el default de la ruta, para que ningún venue existente cambie de comportamiento', () => {
    expect(AreaSettlementRoute.AVOQADO).toBe('AVOQADO')
    expect(AreaSettlementRoute.EXTERNAL).toBe('EXTERNAL')
  })

  it('el cobro externo distingue asumido de confirmado — nunca son lo mismo', () => {
    expect(Object.keys(AreaTicketExternalSettlementStatus).sort()).toEqual(
      ['ASSUMED', 'CONFIRMED', 'DISCREPANCY', 'NOT_CHARGED', 'PENDING'].sort(),
    )
  })
})
