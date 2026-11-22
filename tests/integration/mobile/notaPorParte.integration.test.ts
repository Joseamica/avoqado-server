/**
 * D40 (Flautas Coyoacán, como Fudo) contra Postgres REAL: la nota de cada parte del «Paquete Completo» («sin cebolla» sólo al
 * Consomé, «salsa combinada» a las 2 Flautas Cochinita) se guarda con su parte en Mostrador y en una ronda de Mesas, sale en la
 * comanda de la pantalla de cocina debajo de su parte y vuelve en la cuenta. Una app vieja (sin `modifierNotes`) queda igual.
 *
 * Correr (base desechable, nunca av-db-25):
 *   TEST_DATABASE_URL="$DESECHABLE" DATABASE_URL="$DESECHABLE" npx jest --selectProjects=integration --runInBand \
 *     --runTestsByPath tests/integration/mobile/notaPorParte.integration.test.ts --ci
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createOrderWithItems, getOrder } from '@/services/mobile/order.mobile.service'
import { addItemsToOrder } from '@/services/tpv/order.tpv.service'
import { authorKitchenTickets } from '@/services/kds/kitchenTicketAuthoring.service'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const haceUnaHora = new Date(Date.now() - 60 * 60 * 1000)
let organizationId: string
let venueId: string
let staffId: string
let paquete: string
let consome: string
let cochinita: string
let agua: string

beforeAll(async () => {
  organizationId = (
    await prisma.organization.create({ data: { name: `Nota parte ${s}`, email: `nota-parte-${s}@example.com`, phone: '5555555555' } })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId, name: `Nota parte ${s}`, slug: `nota-parte-${s}`, seatCapExempt: true } }))
    .id
  staffId = (await prisma.staff.create({ data: { email: `nota-parte-${s}@staff.test`, firstName: 'Caja', lastName: 'Flautas' } })).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })
  await prisma.printStation.create({
    data: { venueId, name: 'Cocina', isDefault: true, hasKitchenDisplay: true, kitchenDisplaySince: haceUnaHora },
  })
  const categoryId = (await prisma.menuCategory.create({ data: { venueId, name: `Paquetes ${s}`, slug: `paquetes-${s}` } })).id
  paquete = (
    await prisma.product.create({
      data: { venueId, categoryId, sku: `PAQ-${s}`, name: 'Paquete Completo', price: new Prisma.Decimal(150) },
    })
  ).id
  const grupo = await prisma.modifierGroup.create({ data: { venueId, name: `Partes ${s}` } })
  const extra = async (name: string) =>
    (await prisma.modifier.create({ data: { groupId: grupo.id, name, price: new Prisma.Decimal(0) } })).id
  consome = await extra('Consomé')
  cochinita = await extra('Flautas Cochinita')
  agua = await extra('Agua')
})

afterAll(async () => {
  if (!venueId) return // sin fixture, un deleteMany sin filtro borraría la tabla entera
  await prisma.kdsOrder.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId } } } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.modifierGroup.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.printStation.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
})

const partesDe = (orderId: string) =>
  prisma.orderItemModifier.findMany({
    where: { orderItem: { orderId } },
    select: { modifierId: true, notes: true, orderItemId: true },
    orderBy: { name: 'asc' },
    take: 50,
  })
const etiquetasEnCocina = async (orderId: string) =>
  (await prisma.kdsOrder.findMany({ where: { venueId, orderId }, include: { items: true }, take: 10 }))
    .flatMap(c => c.items)
    .map(i => JSON.parse(i.modifiers ?? '[]'))

describe('D40 · nota por parte', () => {
  it('P1 Mostrador: cada parte guarda SU nota, la basura se ignora y la cocina la ve pegada a su parte', async () => {
    const venta = await createOrderWithItems(venueId, {
      staffId,
      externalId: `venta-${randomUUID()}`,
      source: 'AVOQADO_ANDROID',
      items: [
        {
          productId: paquete,
          quantity: 1,
          modifierIds: [consome, cochinita, cochinita, agua],
          modifierNotes: { [consome]: ' sin cebolla ', [cochinita]: 'salsa combinada', ajeno: 'no cuenta', [agua]: 5 },
        },
      ],
    } as any)

    const partes = await partesDe(venta.id)
    expect(partes.map(p => [p.modifierId, p.notes])).toEqual([
      [agua, null],
      [consome, 'sin cebolla'],
      [cochinita, 'salsa combinada'],
      [cochinita, 'salsa combinada'],
    ])

    const detalle: any = await getOrder(venueId, venta.id)
    const extras = detalle.items[0].modifiers
    expect(extras.find((m: any) => m.name === 'Consomé').notes).toBe('sin cebolla')
    expect('notes' in extras.find((m: any) => m.name === 'Agua')).toBe(false) // sin nota, la respuesta queda como antes

    await prisma.order.update({ where: { id: venta.id }, data: { kitchenPendingAt: new Date() } })
    await authorKitchenTickets({ venueId, orderId: venta.id, trigger: 'PAID' })
    expect(await etiquetasEnCocina(venta.id)).toEqual([
      ['Consomé\nNota: sin cebolla', 'Flautas Cochinita\nNota: salsa combinada', 'Flautas Cochinita\nNota: salsa combinada', 'Agua'],
    ])
  })

  it('P1 una app vieja (sin modifierNotes) deja todo como siempre', async () => {
    const venta = await createOrderWithItems(venueId, {
      staffId,
      externalId: `venta-${randomUUID()}`,
      source: 'AVOQADO_ANDROID',
      items: [{ productId: paquete, quantity: 1, modifierIds: [consome, agua] }],
    } as any)
    expect((await partesDe(venta.id)).map(p => p.notes)).toEqual([null, null])
  })

  it('P1 Mesas: la ronda guarda la nota de cada parte; iguales salvo por la nota no se juntan', async () => {
    const cuenta = await prisma.order.create({
      data: { venueId, orderNumber: `M-${s}`, externalId: `mesa-${s}`, subtotal: 0, taxAmount: 0, total: 0 },
      select: { id: true, version: true },
    })
    // Ronda en línea o reproducida de la cola (`ADD_ITEMS`): llega con su llave por renglón.
    await addItemsToOrder(
      venueId,
      cuenta.id,
      [
        {
          productId: paquete,
          quantity: 1,
          modifierIds: [consome, agua],
          modifierNotes: { [consome]: 'sin cebolla' },
          externalId: `sync:${s}:0`,
        } as any,
      ],
      cuenta.version,
      true,
    )
    const { version } = await prisma.order.findUniqueOrThrow({ where: { id: cuenta.id }, select: { version: true } })
    // Carrito completo sin llave (camino que junta renglones iguales): el mismo paquete SIN la nota es otro renglón.
    await addItemsToOrder(venueId, cuenta.id, [{ productId: paquete, quantity: 1, modifierIds: [consome, agua] }], version)

    const partes = await partesDe(cuenta.id)
    expect(new Set(partes.map(p => p.orderItemId)).size).toBe(2)
    expect(
      partes
        .filter(p => p.modifierId === consome)
        .map(p => p.notes)
        .sort(),
    ).toEqual(['sin cebolla', null].sort())
  })
})
