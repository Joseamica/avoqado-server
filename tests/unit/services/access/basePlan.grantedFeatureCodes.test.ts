/**
 * Auditoría de Codex del 21-sep-2026, hallazgo #10 (P1 de acceso).
 *
 * Un empleado sin permiso de facturación (MANAGER, CASHIER…) veía «contrátala» sobre una función
 * que el negocio YA pagó suelta: sus compras sólo viajaban en `/features`, que exige
 * `billing:subscriptions:read`, así que el candado del dashboard caía al tier FREE. Había una ruta
 * abierta a todos los roles para eso, pero quedó ENTERRADA bajo la de facturación.
 *
 * La salida: los CÓDIGOS de las funciones sueltas vigentes viajan por `/plan-tier`, que ya leen
 * todos los roles. Sólo códigos — ni precios ni ids de Stripe.
 */
const mockFindMany = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venueFeature: { findMany: (...a: unknown[]) => mockFindMany(...a) } },
}))

import { getVenueGrantedFeatureCodes } from '@/services/access/basePlan.service'

beforeEach(() => jest.clearAllMocks())

describe('getVenueGrantedFeatureCodes', () => {
  it('devuelve los códigos de las funciones sueltas vigentes del negocio', async () => {
    mockFindMany.mockResolvedValue([{ feature: { code: 'INVENTORY_TRACKING' } }, { feature: { code: 'LOYALTY_PROGRAM' } }])

    await expect(getVenueGrantedFeatureCodes('v1')).resolves.toEqual(['INVENTORY_TRACKING', 'LOYALTY_PROGRAM'])
  })

  it('sólo cuenta las VIGENTES y nunca los planes', async () => {
    mockFindMany.mockResolvedValue([])
    await getVenueGrantedFeatureCodes('v1')

    const q = mockFindMany.mock.calls[0][0]
    expect(q.where).toMatchObject({ venueId: 'v1', active: true, suspendedAt: null })
    expect(q.where.feature.code.notIn).toEqual(expect.arrayContaining(['PLAN_PRO', 'PLAN_PREMIUM']))
    // 🔴 Sólo el código: ni precio ni suscripción de Stripe salen de aquí.
    expect(q.select).toEqual({ feature: { select: { code: true } } })
  })

  it('la consulta está acotada y con orden estable', async () => {
    mockFindMany.mockResolvedValue([])
    await getVenueGrantedFeatureCodes('v1')

    const q = mockFindMany.mock.calls[0][0]
    expect(q.take).toBeGreaterThan(0)
    expect(q.orderBy).toEqual({ id: 'asc' })
  })
})
