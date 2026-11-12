/** `maxStampsPerDay`: 0 = sin límite en el panel y el servicio; negativo se rechaza en español; 51 sigue aceptado (MCP certificado). */
import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('../../../../src/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn().mockResolvedValue(true) }))

import { updateLoyaltyConfig } from '../../../../src/services/dashboard/loyalty.dashboard.service'
import { UpdateLoyaltyConfigSchema } from '../../../../src/schemas/dashboard/loyalty.schema'
import { BadRequestError } from '../../../../src/errors/AppError'

const cfg = (o: Record<string, unknown> = {}) =>
  ({ id: 'c', venueId: 'v1', active: true, pointsPerDollar: new Decimal(1), redemptionRate: new Decimal(0.01), ...o }) as any

describe('maxStampsPerDay', () => {
  beforeEach(() => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue(cfg())
    prismaMock.loyaltyConfig.update.mockImplementation((async ({ data }: any) => cfg(data)) as never)
  })

  it('el servicio acepta 0 (sin límite)', async () => {
    await updateLoyaltyConfig('v1', { maxStampsPerDay: 0 })
    expect(prismaMock.loyaltyConfig.update).toHaveBeenCalledWith(expect.objectContaining({ data: { maxStampsPerDay: 0 } }))
  })

  it('el servicio rechaza -1 con mensaje en español', async () => {
    await expect(updateLoyaltyConfig('v1', { maxStampsPerDay: -1 })).rejects.toThrow(BadRequestError)
    await expect(updateLoyaltyConfig('v1', { maxStampsPerDay: -1 })).rejects.toThrow('no puede ser negativo')
  })

  it('el servicio sigue aceptando 51 (regresión: configure_loyalty certificada llega aquí)', async () => {
    await updateLoyaltyConfig('v1', { maxStampsPerDay: 51 })
    expect(prismaMock.loyaltyConfig.update).toHaveBeenCalledWith(expect.objectContaining({ data: { maxStampsPerDay: 51 } }))
  })

  it('el zod del panel acepta 0 y rechaza -1 en español', () => {
    const body = (n: number) => UpdateLoyaltyConfigSchema.safeParse({ body: { maxStampsPerDay: n } })
    expect(body(0).success).toBe(true)
    const r = body(-1)
    expect(r.success).toBe(false)
    expect(JSON.stringify((r as any).error.issues)).toContain('no puede ser negativo')
  })
})
