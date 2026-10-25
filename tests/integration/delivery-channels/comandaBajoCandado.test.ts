/**
 * Integration (Postgres REAL) — la comanda de un pedido de reparto nace bajo el candado de la orden (Tarea 11, Rappi fase 2).
 *
 * Las pruebas unitarias corren sobre un `prisma` simulado que NO sabe bloquear: ahí `FOR UPDATE` es texto. Esto prueba lo
 * que sólo la base puede decir:
 *  (a) la cancelación entra ENTRE la transacción que guarda la venta y la que crea la comanda ⇒ la comanda no nace;
 *  (b) la cancelación TIENE el candado de fila de la orden cuando la ingesta va a crear la comanda ⇒ la ingesta ESPERA ese
 *      candado, relee CANCELLED y no la crea (sin el candado leería «viva» y la comanda nacería viva sobre una cancelada);
 *  (c) dos cancelaciones a la vez ⇒ una cancela y la otra relee CANCELLED bajo el candado: UNA sola `DELIVERY_ORDER_CANCELLED`.
 *
 * Núcleo compartido con Uber: lo de Uber sigue en `uberEventProcessor.test.ts` y `uberOrderIngestion.test.ts`.
 * Sólo crea filas propias (sufijo único) y las borra en `afterAll`, falle o no.
 */
import { DeliveryChannelLink, DeliveryProvider, OrderSource } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { cancelDeliveryOrder } from '@/services/delivery-channels/core/cancelDeliveryOrder.service'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import type { NormalizedDeliveryOrder } from '@/services/delivery-channels/core/types'
import * as estaciones from '@/services/kds/kitchenDisplayStations'

// La bitácora se cuenta aquí (cuántas DELIVERY_ORDER_CANCELLED): es justo lo que la relectura bajo el candado arregla.
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

jest.setTimeout(30_000)

const mockLog = logAction as jest.Mock

/**
 * 🔴 La base es compartida por ~20 sesiones: fuera de una base de PRUEBAS no se toca nada. Mismo criterio que
 * `rappiCandadoDeFila.test.ts`: `av-db-25-test` o una desechable `avoqado_*_test_*`. Rechaza `av-db-25` y cualquier otra.
 */
const esBaseDePrueba = (nombre: string) => nombre === 'av-db-25-test' || /^(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/.test(nombre)
{
  const url = new URL(process.env.DATABASE_URL ?? '')
  const nombre = decodeURIComponent(url.pathname.slice(1))
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !esBaseDePrueba(nombre)) {
    throw new Error(`Base inesperada para esta prueba: ${url.hostname}/${nombre}`)
  }
}

describe('la comanda nace bajo el candado de la orden — contra Postgres', () => {
  const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let orgId: string
  let venueId: string
  let link: DeliveryChannelLink
  let n = 0

  const pedido = (): NormalizedDeliveryOrder => ({
    externalId: `it-comanda-${sufijo}-${++n}`,
    displayId: `C${n}`,
    source: OrderSource.RAPPI,
    items: [{ externalId: `taco-${sufijo}`, name: 'Taco', quantity: 2, unitPrice: '45.00', total: '90.00', modifiers: [] }],
    payment: {
      currency: 'MXN',
      saleAmount: '90.00',
      merchantFees: '0.00',
      tipAmount: '0.00',
      externallyPaidSale: '90.00',
      externallyPaidTip: '0.00',
      cashDueSale: '0.00',
      cashDueTip: '0.00',
    },
    raw: { fuente: 'comandaBajoCandado' },
    placedAt: new Date(),
  })

  const comandas = (orderId: string) => prisma.kdsOrder.count({ where: { orderId } })
  const estado = async (orderId: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })).status

  /** Espera a que `n` sesiones estén BLOQUEADAS detrás de `pid` (en fila: la segunda espera a la primera, se sigue la cadena). */
  async function esperarBloqueadas(pid: number, cuantas: number) {
    const hasta = Date.now() + 4_000 // < los 5 s de `maxWait` del candado del pedido
    while (Date.now() < hasta) {
      const [{ c }] = await prisma.$queryRaw<Array<{ c: number }>>`
        WITH RECURSIVE detras(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))
          UNION
          SELECT a.pid FROM pg_stat_activity a JOIN detras d ON d.pid = ANY(pg_blocking_pids(a.pid))
        ) SELECT count(*)::int AS c FROM detras`
      if (c >= cuantas) return
      await new Promise(r => setTimeout(r, 25))
    }
    throw new Error(`no se bloquearon ${cuantas} sesiones detrás de ${pid}`)
  }

  /**
   * Una PUERTA: una transacción aparte que toma el candado de fila de la orden (`SELECT … FOR UPDATE`, el de
   * `lockExistingOrderForPayment`) y lo sostiene hasta `abrir()`. Con `cancelar`, antes de soltarlo la deja CANCELLED, como
   * lo hace `cancelDeliveryOrder` dentro de su transacción.
   */
  type Puerta = { pid: number; abrir: () => void; fin: Promise<void> }
  async function puerta(orderId: string, { cancelar }: { cancelar: boolean }): Promise<Puerta> {
    let abrir!: () => void
    const abierta = new Promise<void>(r => (abrir = r))
    let listo!: (pid: number) => void
    const tomada = new Promise<number>(r => (listo = r))
    const fin = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`
        listo(pid)
        await abierta
        if (cancelar) await tx.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' } })
      },
      { timeout: 20_000, maxWait: 5_000 },
    )
    return { pid: await tomada, abrir, fin }
  }

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({
        data: { name: `Org comanda-it ${sufijo}`, email: `comanda-it-${sufijo}@t.mx`, phone: '5555555555' },
      })
    ).id
    venueId = (
      await prisma.venue.create({ data: { organizationId: orgId, name: `V comanda-it ${sufijo}`, slug: `v-comanda-it-${sufijo}` } })
    ).id
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.RAPPI, externalLocationId: `rappi-comanda-it-${sufijo}`, webhookSecret: 'x' },
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
    mockLog.mockClear()
  })

  afterAll(async () => {
    // 🔴 jest-circus corre `afterAll` aunque `beforeAll` haya lanzado: sin ids propios no se borra nada (un filtro
    // `undefined` borraría la tabla entera).
    if (!orgId || !venueId) return
    try {
      const ids = (await prisma.order.findMany({ where: { venueId }, select: { id: true } })).map(o => o.id)
      const pagos = (await prisma.payment.findMany({ where: { venueId }, select: { id: true } })).map(p => p.id)
      await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: pagos } } })
      await prisma.payment.deleteMany({ where: { venueId } })
      await prisma.kdsOrder.deleteMany({ where: { venueId } })
      await prisma.inventoryPosting.deleteMany({ where: { venueId } })
      await prisma.orderItemModifier.deleteMany({ where: { orderItem: { orderId: { in: ids } } } })
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.order.deleteMany({ where: { venueId } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
      await prisma.venueTenderTypeRevision.deleteMany({ where: { venueId } })
      await prisma.venueTenderType.deleteMany({ where: { venueId } })
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch (e) {
      console.error(`comanda-it ${sufijo}: la limpieza de fixtures falló (quedaron filas propias)`, e)
    }
  })

  it('sin carrera: la venta viva nace con su comanda (como siempre)', async () => {
    const r = await ingestDeliveryOrder(pedido(), link)

    expect(r).toMatchObject({ created: true, kitchenTicketCreated: true, hayComanda: true, cancelada: false })
    expect(await comandas(r.order.id)).toBe(1)
    expect(await estado(r.order.id)).toBe('CONFIRMED')
  })

  it('🔴 (a) la cancelación entra entre la venta y la comanda: la comanda NO nace', async () => {
    const p = pedido()
    let cancelacion: string | null = null
    // La estación se elige ENTRE las dos transacciones (la de la venta y la del candado): ahí entra la cancelación real.
    jest.spyOn(estaciones, 'estacionDePantallaParaReparto').mockImplementation(async () => {
      cancelacion = (await cancelDeliveryOrder(p.externalId, DeliveryProvider.RAPPI, 'cancelado por Rappi: canceled_with_charge')).outcome
      return null
    })

    const r = await ingestDeliveryOrder(p, link)

    expect(cancelacion).toBe('CANCELLED')
    // Lo que importa primero: en la base, la orden cancelada y CERO comandas (antes nacía una viva).
    expect(await estado(r.order.id)).toBe('CANCELLED')
    expect(await comandas(r.order.id)).toBe(0)
    expect(r).toMatchObject({ created: true, kitchenTicketCreated: false, hayComanda: false, cancelada: true })
    expect(r.order.status).toBe('CANCELLED')
  })

  /** Entre la venta y la comanda, otro proceso toma la fila de la orden (la puerta) y la sostiene. */
  const puertaEntreVentaYComanda = (p: NormalizedDeliveryOrder, cancelar: boolean) =>
    new Promise<{ orderId: string } & Puerta>(resolve => {
      jest.spyOn(estaciones, 'estacionDePantallaParaReparto').mockImplementation(async () => {
        const { id } = await prisma.order.findFirstOrThrow({
          where: { venueId, externalId: `RAPPI:${p.externalId}` },
          select: { id: true },
        })
        resolve({ orderId: id, ...(await puerta(id, { cancelar })) })
        return null
      })
    })

  it('🔴 (b) la cancelación tiene el candado de fila: la ingesta lo ESPERA, relee CANCELLED y no crea la comanda', async () => {
    const p = pedido()
    const tomada = puertaEntreVentaYComanda(p, true)

    const ingesta = ingestDeliveryOrder(p, link)
    const g = await tomada
    // La ingesta queda bloqueada detrás de la cancelación (su `lockExistingOrderForPayment`) antes de releer nada.
    await esperarBloqueadas(g.pid, 1)
    // Mientras espera, la venta sigue CONFIRMED para cualquier otra lectura: sin el candado, la comanda habría nacido viva.
    expect(await estado(g.orderId)).toBe('CONFIRMED')
    g.abrir()
    await g.fin

    const r = await ingesta
    expect(await estado(r.order.id)).toBe('CANCELLED')
    expect(await comandas(r.order.id)).toBe(0)
    expect(r).toMatchObject({ kitchenTicketCreated: false, hayComanda: false, cancelada: true })
  })

  it('(b′) si quien tiene el candado NO cancela, la ingesta espera y la comanda nace al soltarlo', async () => {
    const p = pedido()
    const tomada = puertaEntreVentaYComanda(p, false)

    const ingesta = ingestDeliveryOrder(p, link)
    const g = await tomada
    await esperarBloqueadas(g.pid, 1)
    expect(await comandas(g.orderId)).toBe(0)
    g.abrir()
    await g.fin

    const r = await ingesta
    expect(r).toMatchObject({ kitchenTicketCreated: true, hayComanda: true, cancelada: false })
    expect(await comandas(r.order.id)).toBe(1)
  })

  it('🔴 (c) dos cancelaciones a la vez: una cancela, la otra relee CANCELLED bajo el candado — UNA sola DELIVERY_ORDER_CANCELLED', async () => {
    const p = pedido()
    const r = await ingestDeliveryOrder(p, link)
    expect(await comandas(r.order.id)).toBe(1)
    mockLog.mockClear()

    // Las dos leen «viva» antes del candado (la puerta no cambia nada) y las dos se forman detrás de ella.
    const g = await puerta(r.order.id, { cancelar: false })
    const una = cancelDeliveryOrder(p.externalId, DeliveryProvider.RAPPI, 'cancelado por Rappi: aviso')
    const otra = cancelDeliveryOrder(p.externalId, DeliveryProvider.RAPPI, 'cancelado por Rappi: reintento')
    await esperarBloqueadas(g.pid, 2)
    g.abrir()
    await g.fin
    const resultados = (await Promise.all([una, otra])).map(x => x.outcome).sort()

    expect(resultados).toEqual(['ALREADY_CANCELLED', 'CANCELLED'])
    expect(mockLog.mock.calls.filter(([a]) => a.action === 'DELIVERY_ORDER_CANCELLED')).toHaveLength(1)
    expect(await estado(r.order.id)).toBe('CANCELLED')
    expect(await comandas(r.order.id)).toBe(0)
  })
})
