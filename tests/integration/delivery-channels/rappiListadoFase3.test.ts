/**
 * Integration (REAL DB) — Rappi fase 3: el listado de canales le dice al panel, por tienda de Rappi, cuántos pedidos siguen
 * en curso (para poner «Desconectar» en gris) y qué conexión está viendo (para que un clic viejo no apague una nueva).
 */
import { DeliveryChannelStatus, DeliveryProvider, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as tasa from '@/services/delivery-channels/core/injectionRate.service'
import { listChannelLinks } from '@/services/delivery-channels/core/deliveryChannelLink.service'

describe('Rappi fase 3: pedidos en curso y conexión en el listado de canales', () => {
  const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let n = 0
  let orgId: string, venueId: string, venueGrande: string

  const vinculo = (provider: DeliveryProvider, venue = venueId, intentId: string | null = `intent-${sufijo}-${n}`) =>
    prisma.deliveryChannelLink.create({
      data: {
        venueId: venue,
        provider,
        externalLocationId: `t-lista-${sufijo}-${n++}`,
        webhookSecret: 'x',
        status: DeliveryChannelStatus.ACTIVE,
        config: intentId ? { rappiProvisioning: { intentId } } : {},
      },
    })

  beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: 'Rappi listado', email: `${sufijo}@example.test`, phone: '5500000000' } })).id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Rappi lista', slug: `rappi-lista-${sufijo}` } })).id
    venueGrande = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Rappi 201', slug: `rappi-201-${sufijo}` } })).id
  })

  afterAll(async () => {
    if (!venueId || !venueGrande || !orgId) return
    for (const v of [venueId, venueGrande]) {
      await prisma.order.deleteMany({ where: { venueId: v } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId: v } })
    }
    await prisma.venue.deleteMany({ where: { id: { in: [venueId, venueGrande] } } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  it('trae pedidosEnCurso y conexionId para RAPPI y no para otros proveedores', async () => {
    const rappi = await vinculo(DeliveryProvider.RAPPI)
    const manual = await vinculo(DeliveryProvider.RAPPI, venueId, null)
    const uber = await vinculo(DeliveryProvider.UBER_EATS)
    await prisma.order.create({
      data: {
        venueId,
        orderNumber: 'Rappi lista',
        source: 'RAPPI',
        originSystem: 'DELIVERY_PLATFORM',
        status: 'CONFIRMED',
        subtotal: new Prisma.Decimal(100),
        total: new Prisma.Decimal(100),
        taxAmount: new Prisma.Decimal(0),
        remainingBalance: new Prisma.Decimal(100),
        contratoDePrecio: 'IVA_INCLUIDO',
        deliveryChannelLinkId: rappi.id,
      },
    })
    const lista = (await listChannelLinks(venueId)) as unknown as Array<Record<string, unknown>>
    const de = (id: string) => lista.find(l => l.id === id)!
    expect(de(rappi.id)).toMatchObject({ pedidosEnCurso: 1, conexionId: `intent-${sufijo}-0:${rappi.externalLocationId}` })
    expect(de(manual.id)).toMatchObject({ pedidosEnCurso: 0, conexionId: `manual:${manual.externalLocationId}` })
    expect(de(uber.id)).not.toHaveProperty('pedidosEnCurso')
    expect(de(uber.id)).not.toHaveProperty('conexionId')
    // Lo que ya salía sigue saliendo.
    expect(de(rappi.id)).toHaveProperty('injectionRate')
    expect(de(rappi.id)).toHaveProperty('menuSyncStatus')
  })

  it('con 3 vínculos RAPPI calcula la tasa de inyección una vez por proveedor y cuenta en UNA consulta', async () => {
    await vinculo(DeliveryProvider.RAPPI)
    await vinculo(DeliveryProvider.RAPPI)
    const espiaTasa = jest.spyOn(tasa, 'calcularTasaInyeccion')
    const espiaSql = jest.spyOn(prisma, '$queryRaw')
    await listChannelLinks(venueId)
    const llamadasRappi = espiaTasa.mock.calls.filter(([p]) => p.provider === DeliveryProvider.RAPPI)
    expect(llamadasRappi).toHaveLength(1)
    expect(espiaSql).toHaveBeenCalledTimes(1)
    espiaTasa.mockRestore()
    espiaSql.mockRestore()
  })

  it('devuelve los 201 vínculos de un venue con 201 (sin recorte)', async () => {
    await prisma.deliveryChannelLink.createMany({
      data: Array.from({ length: 201 }, (_, i) => ({
        venueId: venueGrande,
        provider: DeliveryProvider.RAPPI,
        externalLocationId: `t-201-${sufijo}-${i}`,
        webhookSecret: 'x',
        status: DeliveryChannelStatus.ACTIVE,
      })),
    })
    const lista = await listChannelLinks(venueGrande)
    expect(lista).toHaveLength(201)
  })
})
