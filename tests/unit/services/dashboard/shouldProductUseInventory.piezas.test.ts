/**
 * Tarjeta `hz:nube0000:na1d52b5` (17-nov-2026): contar piezas por producto es de todos los planes (decisión del founder del 29-sep,
 * «B»). La recomendación del asistente «Nuevo producto» habilita la opción QUANTITY siempre; RECIPE sigue siendo Premium
 * (INVENTORY_TRACKING). `hasInventoryFeature` y `recommendation` no cambian: los lee el DASHBOARD de antes.
 */
jest.mock('../../../../src/services/access/basePlan.service', () => ({
  ...jest.requireActual('../../../../src/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn(),
}))

import { prismaMock } from '../../../__helpers__/setup'
import { venueHasFeatureAccess } from '../../../../src/services/access/basePlan.service'
import { shouldProductUseInventory } from '../../../../src/services/dashboard/productInventoryIntegration.service'

const tienePremium = venueHasFeatureAccess as jest.Mock
const opcion = (r: Awaited<ReturnType<typeof shouldProductUseInventory>>, tipo: 'NONE' | 'QUANTITY' | 'RECIPE') =>
  r.options.find(o => o.type === tipo)

describe('shouldProductUseInventory — contar piezas en todos los planes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.venue.findUnique.mockResolvedValue({ id: 'venue-1' } as any)
  })

  // NEW FEATURE TESTS
  it('Gratis/Pro (sin INVENTORY_TRACKING): contar piezas habilitado, receta no', async () => {
    tienePremium.mockResolvedValue(false)

    const r = await shouldProductUseInventory('venue-1')

    expect(opcion(r, 'QUANTITY')?.enabled).toBe(true)
    expect(opcion(r, 'RECIPE')?.enabled).toBe(false)
    expect(opcion(r, 'NONE')?.enabled).toBe(true)
  })

  // REGRESSION TESTS
  it('Premium: las tres opciones habilitadas', async () => {
    tienePremium.mockResolvedValue(true)

    const r = await shouldProductUseInventory('venue-1')

    expect(r.options.map(o => [o.type, o.enabled])).toEqual([
      ['NONE', true],
      ['QUANTITY', true],
      ['RECIPE', true],
    ])
  })

  it('`hasInventoryFeature` y `recommendation` siguen diciendo el plan, como antes (los lee el DASHBOARD viejo)', async () => {
    tienePremium.mockResolvedValue(false)
    const sin = await shouldProductUseInventory('venue-1')
    expect(sin.hasInventoryFeature).toBe(false)
    expect(sin.recommendation).toBe('wizard.step2.recommendationDisabled')

    tienePremium.mockResolvedValue(true)
    const con = await shouldProductUseInventory('venue-1')
    expect(con.hasInventoryFeature).toBe(true)
    expect(con.recommendation).toBe('wizard.step2.recommendationEnabled')
  })

  it('el plan se resuelve con el mismo resolver que el candado (venueHasFeatureAccess de INVENTORY_TRACKING)', async () => {
    tienePremium.mockResolvedValue(false)

    await shouldProductUseInventory('venue-1')

    expect(tienePremium).toHaveBeenCalledWith('venue-1', 'INVENTORY_TRACKING')
  })

  it('quien pregunta es superadmin de verdad: contesta con Premium, como lo deja pasar el candado (Codex r3 #5)', async () => {
    tienePremium.mockResolvedValue(false)

    const r = await shouldProductUseInventory('venue-1', { quienPreguntaEsSuperadmin: true })

    expect(r.hasInventoryFeature).toBe(true)
    expect(opcion(r, 'RECIPE')?.enabled).toBe(true)
  })

  it('negocio que no existe ⇒ 404', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(null)

    await expect(shouldProductUseInventory('venue-x')).rejects.toMatchObject({ statusCode: 404 })
  })
})
