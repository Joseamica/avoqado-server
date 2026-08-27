import { updateLoyaltyConfig } from '../../../../src/services/dashboard/loyalty.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'
import { BadRequestError } from '../../../../src/errors/AppError'

jest.mock('../../../../src/services/wallet/stampLedger.service', () => ({
  grantStamp: jest.fn(),
}))
jest.mock('../../../../src/services/mobile/loyalty.mobile.service', () => ({
  redeemPointsToOrder: jest.fn(),
}))

/**
 * El PROGRAMA DE SELLOS, configurable por fin desde una interfaz.
 *
 * Hasta el 2026-08-26 el motor de sellos estaba completo (un cobro sella, una
 * cartilla llena se canjea, un reembolso revierte) pero `stampsEnabled` sólo se
 * podía escribir con un UPDATE en Postgres: ni el dashboard ni el MCP lo exponían.
 *
 * Estas pruebas van primero porque esto DEFINE CUÁNTO SE REGALA. Un `stampsRequired`
 * de 1 regala en cada compra; un `PERCENTAGE` de 150 descuenta más que la cuenta.
 * Nada de eso puede depender de que la pantalla mande valores sensatos.
 */
const VENUE = 'venue-1'

const configBase = {
  id: 'cfg-1',
  venueId: VENUE,
  active: true,
  pointsPerDollar: { toNumber: () => 1 },
  redemptionRate: { toNumber: () => 0.05 },
  stampsEnabled: false,
  stampsRequired: 10,
  maxStampsPerDay: 1,
  stampRewardType: 'FREE_PRODUCT',
  stampRewardValue: null,
  stampRewardProductId: null,
  stampRewardLabel: 'Un producto gratis',
}

describe('updateLoyaltyConfig — programa de sellos', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue(configBase as never)
    // Prisma devuelve Decimal en estos dos campos; el servicio les llama .toNumber().
    // Emularlo importa: con números planos el mock rompe por una razón que no es del código.
    prismaMock.loyaltyConfig.update.mockImplementation((({ data }: never) => {
      const d = data as Record<string, unknown>
      return Promise.resolve({
        ...configBase,
        ...d,
        pointsPerDollar: { toNumber: () => Number(d.pointsPerDollar ?? 1) },
        redemptionRate: { toNumber: () => Number(d.redemptionRate ?? 0.05) },
      })
    }) as never)
    prismaMock.product.findFirst.mockResolvedValue(null as never)
  })

  describe('lo que impide regalar de más', () => {
    it('rechaza prender con PERCENTAGE sin decir el porcentaje', async () => {
      await expect(
        updateLoyaltyConfig(VENUE, { stampsEnabled: true, stampRewardType: 'PERCENTAGE' }),
      ).rejects.toThrow(BadRequestError)
    })

    it('rechaza un porcentaje mayor a 100 — descontaría más que la cuenta', async () => {
      await expect(
        updateLoyaltyConfig(VENUE, {
          stampsEnabled: true,
          stampRewardType: 'PERCENTAGE',
          stampRewardValue: 150,
        }),
      ).rejects.toThrow(BadRequestError)
    })

    it('rechaza un monto fijo de cero — un premio que no da nada', async () => {
      await expect(
        updateLoyaltyConfig(VENUE, {
          stampsEnabled: true,
          stampRewardType: 'FIXED_AMOUNT',
          stampRewardValue: 0,
        }),
      ).rejects.toThrow(BadRequestError)
    })

    it('rechaza una cartilla de 1 sello — sería regalar en cada compra', async () => {
      await expect(updateLoyaltyConfig(VENUE, { stampsRequired: 1 })).rejects.toThrow(BadRequestError)
    })

    it('rechaza una cartilla imposible de llenar (más de 50)', async () => {
      await expect(updateLoyaltyConfig(VENUE, { stampsRequired: 60 })).rejects.toThrow(BadRequestError)
    })

    it('rechaza un tope de sellos por día menor a 1 — nadie podría sellar', async () => {
      await expect(updateLoyaltyConfig(VENUE, { maxStampsPerDay: 0 })).rejects.toThrow(BadRequestError)
    })
  })

  describe('aislamiento entre negocios', () => {
    it('rechaza regalar un producto que es de OTRO negocio', async () => {
      prismaMock.product.findFirst.mockResolvedValue(null as never) // no existe EN ESTE venue
      await expect(
        updateLoyaltyConfig(VENUE, {
          stampsEnabled: true,
          stampRewardType: 'FREE_PRODUCT',
          stampRewardProductId: 'producto-de-otro-venue',
        }),
      ).rejects.toThrow(BadRequestError)
      expect(prismaMock.product.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ venueId: VENUE }) }),
      )
    })
  })

  describe('lo que sí se puede', () => {
    it('prende los sellos con producto gratis y guarda los campos', async () => {
      const r = await updateLoyaltyConfig(VENUE, {
        stampsEnabled: true,
        stampsRequired: 7,
        stampRewardType: 'FREE_PRODUCT',
        stampRewardLabel: 'Un café gratis',
      })
      expect(prismaMock.loyaltyConfig.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: VENUE },
          data: expect.objectContaining({
            stampsEnabled: true,
            stampsRequired: 7,
            stampRewardLabel: 'Un café gratis',
          }),
        }),
      )
      expect(r.stampsEnabled).toBe(true)
    })

    it('APAGAR nunca se bloquea, aunque la configuración esté a medias', async () => {
      prismaMock.loyaltyConfig.findUnique.mockResolvedValue({
        ...configBase,
        stampsEnabled: true,
        stampRewardType: 'PERCENTAGE',
        stampRewardValue: null, // quedó incompleta
      } as never)
      await expect(updateLoyaltyConfig(VENUE, { stampsEnabled: false })).resolves.toBeDefined()
    })

    it('no toca los sellos cuando sólo se cambian los puntos', async () => {
      await updateLoyaltyConfig(VENUE, { pointsPerDollar: 2 })
      const data = (prismaMock.loyaltyConfig.update as jest.Mock).mock.calls[0][0].data
      expect(data).not.toHaveProperty('stampsEnabled')
      expect(data).not.toHaveProperty('stampRewardType')
    })
  })
})
