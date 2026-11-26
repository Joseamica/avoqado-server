/**
 * hz:be99f328:D42 (founder, «A», 25-nov): el «Sumaste…» del folio de la tienda en línea. El sello se enseña con la tarjeta de sellos
 * prendida aunque los PUNTOS estén apagados; los puntos, sólo con su programa prendido. Antes, con `active: false` no decía nada.
 */
import { lealtadDeLaCuenta } from '@/services/online-ordering/beneficiosDeLaCuenta'
import { prismaMock } from '@tests/__helpers__/setup'

const P = { venueId: 'v1', orderId: 'o1', customerId: 'c1' }
const SELLO = { customerId: 'c1', stampsEarned: 3, stampsRequired: 6, revertido: false }

describe('lealtadDeLaCuenta (D42)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$queryRaw.mockResolvedValue([SELLO] as never)
    prismaMock.loyaltyTransaction.findFirst.mockResolvedValue({ points: 40 } as never)
  })

  it('puntos apagados + sellos prendidos ⇒ dice el sello, no los puntos', async () => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ active: false, stampsEnabled: true } as never)
    await expect(lealtadDeLaCuenta(P)).resolves.toEqual({ sello: { ganados: 3, meta: 6 } })
    expect(prismaMock.loyaltyTransaction.findFirst).not.toHaveBeenCalled()
  })

  it('regresión: los dos prendidos ⇒ sello y puntos', async () => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ active: true, stampsEnabled: true } as never)
    await expect(lealtadDeLaCuenta(P)).resolves.toEqual({ sello: { ganados: 3, meta: 6 }, puntos: 40 })
  })

  it('regresión: sólo puntos ⇒ sólo puntos, sin leer el sello', async () => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ active: true, stampsEnabled: false } as never)
    await expect(lealtadDeLaCuenta(P)).resolves.toEqual({ puntos: 40 })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  it('los dos apagados (o sin configuración) ⇒ null, sin leer nada más', async () => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ active: false, stampsEnabled: false } as never)
    await expect(lealtadDeLaCuenta(P)).resolves.toBeNull()
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue(null)
    await expect(lealtadDeLaCuenta(P)).resolves.toBeNull()
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(prismaMock.loyaltyTransaction.findFirst).not.toHaveBeenCalled()
  })
})
