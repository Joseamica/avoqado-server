/**
 * Integration (REAL DB + REAL app por supertest) — Tarea 8 del KDS de Uber: «¿quién trae
 * este pedido?». Setup calcado de `kdsContacto.test.ts` (Tarea 4): un venue con su
 * DeliveryChannelLink de Uber, una orden ingerida de verdad y una comanda de KDS real.
 */
import { DeliveryChannelLink, DeliveryProvider, OrderSource, StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import type { NormalizedDeliveryOrder } from '@/services/delivery-channels/core/types'

// El GET del repartidor cae en el MISMO GET que `fetchOrder`, así que basta con controlar
// esa única llamada por prueba — nunca se pega a la red real de Uber.
jest.mock('@/services/delivery-channels/providers/uber-eats/uber.client', () => ({
  ...jest.requireActual('@/services/delivery-channels/providers/uber-eats/uber.client'),
  fetchUberOrder: jest.fn(),
}))
import { fetchUberOrder } from '@/services/delivery-channels/providers/uber-eats/uber.client'
const mockFetchUberOrder = fetchUberOrder as jest.Mock

// Para la prueba "un proveedor sin fetchCourier": se envuelve el registro REAL con un jest.fn
// por export, con un default que delega al de siempre — así el resto de las pruebas de este
// archivo usan el adaptador de Uber tal cual es, y sólo UNA prueba lo sustituye.
jest.mock('@/services/delivery-channels/core/adapterRegistry', () => ({
  hasAdapter: jest.fn(),
  adapterFor: jest.fn(),
}))
import { adapterFor, hasAdapter } from '@/services/delivery-channels/core/adapterRegistry'
const mockAdapterFor = adapterFor as jest.Mock
const mockHasAdapter = hasAdapter as jest.Mock
const adapterRegistryReal = jest.requireActual('@/services/delivery-channels/core/adapterRegistry')

describe('el KDS contesta "¿quién trae este pedido?" (Tarea 8)', () => {
  let venueId: string, venueIdOtro: string, orgId: string, staffId: string
  let link: DeliveryChannelLink
  let token: string, tokenOtro: string

  const pedido = (externalId: string, overrides: Partial<NormalizedDeliveryOrder> = {}): NormalizedDeliveryOrder => ({
    externalId,
    displayId: 'AB12C',
    source: OrderSource.UBER_EATS,
    items: [{ externalId: 'item-1', name: 'Cochinita', quantity: 1, unitPrice: '100.00', total: '100.00' }],
    payment: {
      currency: 'MXN',
      saleAmount: '100.00',
      merchantFees: '0.00',
      tipAmount: '0.00',
      externallyPaidSale: '100.00',
      externallyPaidTip: '0.00',
      cashDueSale: '0.00',
      cashDueTip: '0.00',
    },
    customer: { name: 'Avoqado S.', phone: '+52 33 1930 9789', phonePin: '481 32 632' },
    raw: { fuente: 'test' },
    placedAt: new Date(),
    ...overrides,
  })

  beforeEach(() => {
    mockFetchUberOrder.mockReset()
    mockAdapterFor.mockReset().mockImplementation(adapterRegistryReal.adapterFor)
    mockHasAdapter.mockReset().mockImplementation(adapterRegistryReal.hasAdapter)
  })

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org kds-courier ${Date.now()}`, email: `kds-courier${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const v = await prisma.venue.create({
      data: { organizationId: orgId, name: `V kds-courier ${Date.now()}`, slug: `v-kds-courier-${Date.now()}` },
    })
    venueId = v.id
    const v2 = await prisma.venue.create({
      data: { organizationId: orgId, name: `V kds-courier-otro ${Date.now()}`, slug: `v-kds-courier-otro-${Date.now()}` },
    })
    venueIdOtro = v2.id
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.UBER_EATS, externalLocationId: `store-${Date.now()}`, webhookSecret: 'x' },
    })

    const staff = await prisma.staff.create({
      data: { email: `kds-courier-staff-${Date.now()}@t.mx`, firstName: 'KDS', lastName: 'Courier' },
    })
    staffId = staff.id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.OWNER, active: true } })
    await prisma.staffVenue.create({ data: { staffId, venueId: venueIdOtro, role: StaffRole.OWNER, active: true } })
    token = jwt.sign({ sub: staffId, orgId, venueId, role: StaffRole.OWNER }, process.env.ACCESS_TOKEN_SECRET as string, {
      expiresIn: '15m',
    })
    tokenOtro = jwt.sign({ sub: staffId, orgId, venueId: venueIdOtro, role: StaffRole.OWNER }, process.env.ACCESS_TOKEN_SECRET as string, {
      expiresIn: '15m',
    })
  })

  afterAll(async () => {
    try {
      const orders = await prisma.order.findMany({ where: { venueId: { in: [venueId, venueIdOtro] } }, select: { id: true } })
      const ids = orders.map(o => o.id)
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.order.deleteMany({ where: { venueId: { in: [venueId, venueIdOtro] } } })
      await prisma.kdsOrder.deleteMany({ where: { venueId: { in: [venueId, venueIdOtro] } } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
      await prisma.venueTenderTypeRevision.deleteMany({ where: { venueId: { in: [venueId, venueIdOtro] } } })
      await prisma.venueTenderType.deleteMany({ where: { venueId: { in: [venueId, venueIdOtro] } } })
      await prisma.product.deleteMany({ where: { venueId: { in: [venueId, venueIdOtro] } } })
      await prisma.menuCategory.deleteMany({ where: { venueId: { in: [venueId, venueIdOtro] } } })
      await prisma.staffVenue.deleteMany({ where: { staffId } })
      await prisma.venue.deleteMany({ where: { id: { in: [venueId, venueIdOtro] } } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
      await prisma.staff.deleteMany({ where: { id: staffId } })
    } catch {
      /* fixtures */
    }
  })

  it('sin repartidor asignado responde assigned:false', async () => {
    mockFetchUberOrder.mockResolvedValueOnce({ status: 200, json: { order: { deliveries: [] } }, text: '{}' })

    const { order } = await ingestDeliveryOrder(pedido(`sin-repartidor-${Date.now()}`), link)
    const kds = await prisma.kdsOrder.findFirstOrThrow({ where: { orderId: order.id } })

    const res = await request(app)
      .get(`/api/v1/mobile/venues/${venueId}/kds/orders/${kds.id}/courier`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ supported: true, assigned: false })
    expect(mockFetchUberOrder).toHaveBeenCalledTimes(1)
  })

  it('con repartidor asignado devuelve su nombre y vehículo', async () => {
    mockFetchUberOrder.mockResolvedValueOnce({
      status: 200,
      json: { order: { deliveries: [{ first_name: 'Juan', phone: '+52 1', vehicle: { make: 'Nissan', model: 'March' } }] } },
      text: '{}',
    })

    const { order } = await ingestDeliveryOrder(pedido(`con-repartidor-${Date.now()}`), link)
    const kds = await prisma.kdsOrder.findFirstOrThrow({ where: { orderId: order.id } })

    const res = await request(app)
      .get(`/api/v1/mobile/venues/${venueId}/kds/orders/${kds.id}/courier`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      supported: true,
      assigned: true,
      courier: {
        name: 'Juan',
        phone: '+52 1',
        phoneCode: undefined,
        vehicle: { make: 'Nissan', model: 'March', licensePlate: undefined },
        pictureUrl: undefined,
      },
    })
  })

  it('una comanda de OTRO venue responde 404', async () => {
    const { order } = await ingestDeliveryOrder(pedido(`otro-venue-${Date.now()}`), link)
    const kds = await prisma.kdsOrder.findFirstOrThrow({ where: { orderId: order.id } })

    // El staff SÍ pertenece a `venueIdOtro` (pasa el middleware de membresía), pero la
    // comanda es de `venueId` — el servicio la busca acotada por el venue de la URL.
    const res = await request(app)
      .get(`/api/v1/mobile/venues/${venueIdOtro}/kds/orders/${kds.id}/courier`)
      .set('Authorization', `Bearer ${tokenOtro}`)

    expect(res.status).toBe(404)
    expect(mockFetchUberOrder).not.toHaveBeenCalled()
  })

  it('un proveedor sin fetchCourier responde supported:false', async () => {
    const real = adapterRegistryReal.adapterFor(DeliveryProvider.UBER_EATS)
    const { fetchCourier, ...sinFetchCourier } = real
    mockAdapterFor.mockImplementation((p: DeliveryProvider) =>
      p === DeliveryProvider.UBER_EATS ? sinFetchCourier : adapterRegistryReal.adapterFor(p),
    )

    const { order } = await ingestDeliveryOrder(pedido(`sin-fetchcourier-${Date.now()}`), link)
    const kds = await prisma.kdsOrder.findFirstOrThrow({ where: { orderId: order.id } })

    const res = await request(app)
      .get(`/api/v1/mobile/venues/${venueId}/kds/orders/${kds.id}/courier`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ supported: false, assigned: false })
    expect(mockFetchUberOrder).not.toHaveBeenCalled()
  })

  it('si Uber no contesta responde 502 PROVIDER_UNAVAILABLE', async () => {
    mockFetchUberOrder.mockRejectedValueOnce(new Error('ECONNRESET'))

    const { order } = await ingestDeliveryOrder(pedido(`uber-caido-${Date.now()}`), link)
    const kds = await prisma.kdsOrder.findFirstOrThrow({ where: { orderId: order.id } })

    const res = await request(app)
      .get(`/api/v1/mobile/venues/${venueId}/kds/orders/${kds.id}/courier`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(502)
    expect(res.body.code).toBe('PROVIDER_UNAVAILABLE')
  })
})
