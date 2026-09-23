/**
 * El candado por pedido: primitiva de concurrencia que usan accept/ready/deny (Task 7)
 * y quitar un artículo (Task 14). Contra Postgres real: el advisory lock y la carrera
 * entre dos transacciones no se prueban con Prisma mockeado.
 */
import prisma from '@/utils/prismaClient'
import { tomarReserva, soltarReserva, withDeliveryOrderLock, RESERVA_TTL_MS } from '@/services/delivery-channels/core/deliveryOrderLock'

describe('candado por pedido y reserva simetrica con token', () => {
  let venueId: string, orgId: string

  const sembrarOrdenDeReparto = async () => {
    const order = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `R-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        externalId: `UBER_EATS:lock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        status: 'PENDING',
        total: '100',
        subtotal: '100',
        taxAmount: '0',
        tipAmount: '0',
      },
    })
    return { order }
  }

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org lock ${Date.now()}`, email: `lock${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const v = await prisma.venue.create({ data: { organizationId: orgId, name: `V lock ${Date.now()}`, slug: `vl-${Date.now()}` } })
    venueId = v.id
  })

  afterAll(async () => {
    try {
      await prisma.order.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch {
      /* fixtures */
    }
  })

  it('una segunda operacion no puede tomar la reserva viva', async () => {
    const { order } = await sembrarOrdenDeReparto()
    const a = await tomarReserva(order.id, 'REMOVE_ITEM')
    expect(a.ok).toBe(true)
    const b = await tomarReserva(order.id, 'READY')
    expect(b).toMatchObject({ ok: false, ocupadaPor: 'REMOVE_ITEM' })
  })

  it('una reserva huerfana (> 2 min) se puede tomar', async () => {
    const { order } = await sembrarOrdenDeReparto()
    await tomarReserva(order.id, 'READY')
    await prisma.order.update({
      where: { id: order.id },
      data: { deliveryOpInFlightAt: new Date(Date.now() - RESERVA_TTL_MS - 1000) },
    })
    const b = await tomarReserva(order.id, 'REMOVE_ITEM')
    expect(b.ok).toBe(true)
  })

  it('soltar con un token viejo NO libera la reserva de otra operacion', async () => {
    const { order } = await sembrarOrdenDeReparto()
    const a = await tomarReserva(order.id, 'READY')
    await prisma.order.update({
      where: { id: order.id },
      data: { deliveryOpInFlightAt: new Date(Date.now() - RESERVA_TTL_MS - 1000) },
    })
    const b = await tomarReserva(order.id, 'REMOVE_ITEM')
    await soltarReserva(order.id, (a as { ok: true; token: string }).token) // el finally TARDÍO de A
    const fila = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(fila.deliveryOpInFlight).toBe('REMOVE_ITEM')
    expect(fila.deliveryOpToken).toBe((b as { ok: true; token: string }).token)
  })

  it('withDeliveryOrderLock serializa: la segunda transaccion espera a que la primera termine', async () => {
    const { order } = await sembrarOrdenDeReparto()
    const tiempos: { quien: string; evento: string; en: number }[] = []
    const registra = (quien: string, evento: string) => tiempos.push({ quien, evento, en: Date.now() })

    const a = withDeliveryOrderLock(order.id, async () => {
      registra('A', 'start')
      await new Promise(resolve => setTimeout(resolve, 300))
      registra('A', 'end')
    })
    // Deja que A tome el candado (abre su transacción y corre el advisory lock)
    // antes de lanzar B, para que B se quede esperando el mismo lock.
    await new Promise(resolve => setTimeout(resolve, 50))
    const b = withDeliveryOrderLock(order.id, async () => {
      registra('B', 'start')
    })

    await Promise.all([a, b])

    const finDeA = tiempos.find(t => t.quien === 'A' && t.evento === 'end')?.en
    const iniciodeB = tiempos.find(t => t.quien === 'B' && t.evento === 'start')?.en
    expect(finDeA).toBeDefined()
    expect(iniciodeB).toBeDefined()
    expect(iniciodeB!).toBeGreaterThanOrEqual(finDeA!)
  })
})
