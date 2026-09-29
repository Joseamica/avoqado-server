/**
 * Etapa 3 del KDS (spec 2026-09-27 §1): los datos nuevos. El folio es único por negocio (y NULL no choca:
 * comandas viejas y de Uber), y borrar una estación deja sus comandas «Sin estación» en vez de borrarlas.
 */
import prisma from '@/utils/prismaClient'

const suffix = `kds3datos-${Date.now()}`
let orgId: string
let venueA: string
let venueB: string

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `KDS3 ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  const venue = async (n: string) =>
    (await prisma.venue.create({ data: { organizationId: orgId, name: `${n}-${suffix}`, slug: `${n}-${suffix}` } })).id
  venueA = await venue('a')
  venueB = await venue('b')
})

afterAll(async () => {
  if (!orgId) return
  const venues = [venueA, venueB].filter(Boolean)
  await prisma.kdsOrder.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.printStation.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.order.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.venue.deleteMany({ where: { id: { in: venues } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

const comanda = (venueId: string, sourceKey: string | null) => ({ venueId, sourceKey, orderNumber: 'A1', orderType: 'DINE_IN' })

describe('KdsOrder — folio, estación y marcas (etapa 3)', () => {
  it('el mismo folio dos veces en el mismo negocio choca (P2002)', async () => {
    await prisma.kdsOrder.create({ data: comanda(venueA, 'sale:ext-1:none') })
    await expect(prisma.kdsOrder.create({ data: comanda(venueA, 'sale:ext-1:none') })).rejects.toMatchObject({ code: 'P2002' })
  })

  it('el mismo folio en OTRO negocio no choca, y sin folio tampoco', async () => {
    await expect(prisma.kdsOrder.create({ data: comanda(venueB, 'sale:ext-1:none') })).resolves.toBeTruthy()
    await prisma.kdsOrder.create({ data: comanda(venueA, null) })
    await expect(prisma.kdsOrder.create({ data: comanda(venueA, null) })).resolves.toBeTruthy()
  })

  it('borrar la estación deja la comanda «Sin estación», no la borra', async () => {
    const estacion = await prisma.printStation.create({
      data: { venueId: venueA, name: 'Barra', hasKitchenDisplay: true, kitchenDisplaySince: new Date() },
    })
    const k = await prisma.kdsOrder.create({ data: { ...comanda(venueA, 'round:r1:x'), printStationId: estacion.id } })
    await prisma.printStation.delete({ where: { id: estacion.id } })
    expect((await prisma.kdsOrder.findUniqueOrThrow({ where: { id: k.id } })).printStationId).toBeNull()
  })

  it('existen «salió en papel» en la comanda y «falta armarla» en la orden', async () => {
    const k = await prisma.kdsOrder.create({ data: { ...comanda(venueA, 'sale:ext-2:none'), fallbackPrintedAt: new Date() } })
    expect(k.fallbackPrintedAt).toBeInstanceOf(Date)
    const o = await prisma.order.create({
      data: { venueId: venueA, orderNumber: `O-${suffix}`, subtotal: 0, taxAmount: 0, total: 0, kitchenPendingAt: new Date() },
    })
    expect(o.kitchenPendingAt).toBeInstanceOf(Date)
  })
})
