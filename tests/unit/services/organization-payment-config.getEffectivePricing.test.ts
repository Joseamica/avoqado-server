/**
 * Codex R4-3: la vigencia de una tarifa se evalúa A LA FECHA pedida (la del cobro cuando se calcula un costo), no siempre
 * «hoy». Sin esto, «el slot SECONDARY» de un cobro de ayer apuntaba a la tarifa vigente hoy.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { getEffectivePricing } from '@/services/organization-payment-config.service'

beforeEach(() => {
  ;(prismaMock as any).venuePricingStructure.findMany.mockReset().mockResolvedValue([{ id: 's1' }])
  ;(prismaMock as any).organizationPricingStructure.findMany.mockReset().mockResolvedValue([])
  ;(prismaMock as any).venue.findUnique.mockReset().mockResolvedValue({ organizationId: 'org' })
})

it('la ventana de vigencia (effectiveFrom ≤ fecha ≤ effectiveTo) se evalúa con la fecha recibida', async () => {
  const at = new Date('2026-07-01T12:00:00Z')
  const r = await getEffectivePricing('v1', 'SECONDARY', at)
  expect(r).toEqual({ pricing: [{ id: 's1' }], source: 'venue' })
  const where = (prismaMock as any).venuePricingStructure.findMany.mock.calls[0][0].where
  expect(where).toMatchObject({ venueId: 'v1', accountType: 'SECONDARY', active: true, effectiveFrom: { lte: at } })
  expect(where.OR).toEqual([{ effectiveTo: null }, { effectiveTo: { gte: at } }])
})

it('sin fecha, sigue siendo «ahora» (compatibilidad con los llamadores que consultan la configuración vigente)', async () => {
  const antes = Date.now()
  await getEffectivePricing('v1')
  const where = (prismaMock as any).venuePricingStructure.findMany.mock.calls[0][0].where
  expect(where.effectiveFrom.lte.getTime()).toBeGreaterThanOrEqual(antes)
  expect(where.accountType).toBeUndefined()
})

it('el respaldo de la organización usa la MISMA fecha', async () => {
  ;(prismaMock as any).venuePricingStructure.findMany.mockResolvedValue([])
  ;(prismaMock as any).organizationPricingStructure.findMany.mockResolvedValue([{ id: 'o1' }])
  const at = new Date('2026-07-01T12:00:00Z')
  const r = await getEffectivePricing('v1', 'PRIMARY', at)
  expect(r).toEqual({ pricing: [{ id: 'o1' }], source: 'organization' })
  expect((prismaMock as any).organizationPricingStructure.findMany.mock.calls[0][0].where).toMatchObject({
    organizationId: 'org',
    effectiveFrom: { lte: at },
  })
})
