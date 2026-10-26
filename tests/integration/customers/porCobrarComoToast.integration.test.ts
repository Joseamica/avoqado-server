/**
 * 🔴 «Por cobrar» como Toast (founder 26-oct, hz:898a8a42:D1): sólo es deuda del cliente lo que el cajero mandó a «Pagar
 * después». Amaena: un cobro con tarjeta que el banco rechazó (o con la terminal ocupada) dejaba la cuenta abierta con su
 * cliente y salía como deuda en «Cuentas por cobrar», en el saldo del cliente y en su «Liquidar todo», que la habría
 * marcado como pagada en efectivo sin que nadie pagara.
 *
 * Un mismo cliente con tres cuentas abiertas: «Pagar después» (payLater = true), un cobro con tarjeta que falló
 * (payLater = false) y una vieja sin marca (null, la regla de antes). Contra Postgres real.
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import { getCustomers, settleCustomerBalance } from '@/services/dashboard/customer.dashboard.service'
import { getPayLaterAgingReport } from '@/services/dashboard/reports.dashboard.service'
import { getOrders } from '@/services/tpv/order.tpv.service'
import { mergeOrders, splitOrderItems } from '@/services/mobile/order.mobile.service'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({ socketManager: { broadcastToVenue: jest.fn() } }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  ...jest.requireActual('@/services/shared/cashDrawerPosting'),
  postCashSaleToDrawer: jest.fn().mockResolvedValue(undefined),
  postCashRefundToDrawer: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))

describe('«Por cobrar» sólo lo que el cajero mandó a «Pagar después» (integración)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let clienteId: string
  const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  const cuentas: Record<'fiado' | 'tarjetaFallida' | 'vieja', string> = { fiado: '', tarjetaFallida: '', vieja: '' }

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({ data: { name: 'ITEST PorCobrar', email: `itest-porcobrar-${sello}@test.com`, phone: '5550000000' } })
    ).id
    venueId = (
      await prisma.venue.create({
        data: { name: `itest-porcobrar-${sello}`, slug: `itest-porcobrar-${sello}`, organizationId: orgId, timezone: 'America/Mexico_City' },
      })
    ).id
    clienteId = (await prisma.customer.create({ data: { venueId, firstName: 'Eva', lastName: 'Fiado' } })).id
    let k = 0
    const cuenta = async (payLater: boolean | null, saldo: number) => {
      const o = await prisma.order.create({
        data: {
          venueId: venueId!,
          orderNumber: `ITEST-PORCOBRAR-${sello}-${++k}`,
          subtotal: saldo,
          taxAmount: 0,
          total: saldo,
          remainingBalance: saldo,
          paymentStatus: 'PENDING',
          status: 'CONFIRMED',
          customerId: clienteId,
          payLater,
        },
      })
      await prisma.orderCustomer.create({ data: { orderId: o.id, customerId: clienteId, isPrimary: true } })
      return o.id
    }
    cuentas.fiado = await cuenta(true, 100)
    cuentas.tarjetaFallida = await cuenta(false, 577.5)
    cuentas.vieja = await cuenta(null, 50)
  })

  afterAll(async () => {
    // 🔴 Sin fixture no se limpia NADA.
    if (!venueId || !orgId) return
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } }) // OrderCustomer cae en cascada
    await prisma.customer.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  it('el reporte «Cuentas por cobrar» lista el fiado y la vieja, no la tarjeta que falló', async () => {
    const reporte = await getPayLaterAgingReport(venueId!)
    const ids = reporte.orders.aging_0_30.map(o => o.id).sort()
    expect(ids).toEqual([cuentas.fiado, cuentas.vieja].sort())
    expect(reporte.summary.total_balance).toBe(150)
  })

  it('el saldo pendiente del cliente no suma la tarjeta que falló (Prisma y SQL)', async () => {
    const conFiltro = await getCustomers(venueId!, 1, 20, undefined, undefined, undefined, undefined, 'createdAt', 'desc', true)
    const eva = conFiltro.data.find(c => c.id === clienteId)
    expect(eva).toMatchObject({ pendingOrderCount: 2, pendingBalance: 150 })
    // Con búsqueda pasa por el prefiltro en SQL crudo (`sqlDeFiltrosDeClientes`).
    const buscando = await getCustomers(venueId!, 1, 20, 'Eva', undefined, undefined, undefined, 'createdAt', 'desc', true)
    expect(buscando.data.map(c => c.id)).toEqual([clienteId])
  })

  it('la TPV: «pagar después» trae el fiado y la vieja; la lista normal trae la tarjeta que falló', async () => {
    const fiados = await getOrders(venueId!, orgId, { onlyPayLater: true })
    expect(fiados.map(o => o.id).sort()).toEqual([cuentas.fiado, cuentas.vieja].sort())
    const normales = await getOrders(venueId!, orgId)
    expect(normales.map(o => o.id)).toEqual([cuentas.tarjetaFallida])
  })

  it('🔴 «Liquidar todo» paga el fiado y la vieja, y deja abierta la tarjeta que falló', async () => {
    const r = await settleCustomerBalance(venueId!, clienteId, 'Pagó su fiado', null)
    expect(r).toMatchObject({ settledOrderCount: 2, settledAmount: 150 })
    const estados = await prisma.order.findMany({ where: { venueId }, select: { id: true, paymentStatus: true } })
    const de = (id: string) => estados.find(o => o.id === id)?.paymentStatus
    expect(de(cuentas.fiado)).toBe('PAID')
    expect(de(cuentas.vieja)).toBe('PAID')
    expect(de(cuentas.tarjetaFallida)).toBe('PENDING')
  })
})

/**
 * Dividir o juntar una cuenta conserva la MARCA de fiado: la parte separada la hereda y, al juntar, el fiado gana
 * (`combinarPayLater`). Que la cuenta nueva pierda al CLIENTE ya pasaba antes de este cambio y es aparte (hz:01185fe7:D2):
 * copiarlo aquí ligaba una venta a dos clientes y abría un interbloqueo con las métricas del cobro (Codex r3).
 */
describe('dividir y juntar conservan la marca «Pagar después» (integración)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  let k = 0

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({ data: { name: 'ITEST Fiado Dividido', email: `itest-fiado-div-${sello}@test.com`, phone: '5550000000' } })
    ).id
    venueId = (
      await prisma.venue.create({
        data: { name: `itest-fiado-div-${sello}`, slug: `itest-fiado-div-${sello}`, organizationId: orgId, timezone: 'America/Mexico_City' },
      })
    ).id
  })

  afterAll(async () => {
    // 🔴 Sin fixture no se limpia NADA.
    if (!venueId || !orgId) return
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  /** Una cuenta con `n` renglones de $50 y su marca. */
  async function cuenta(n: number, payLater: boolean | null) {
    const o = await prisma.order.create({
      data: {
        venueId: venueId!,
        orderNumber: `ITEST-FIADO-DIV-${sello}-${++k}`,
        subtotal: 50 * n,
        taxAmount: 0,
        total: 50 * n,
        remainingBalance: 50 * n,
        paymentStatus: 'PENDING',
        status: 'CONFIRMED',
        payLater,
      },
    })
    for (let i = 0; i < n; i++) {
      await prisma.orderItem.create({
        data: { orderId: o.id, productName: `Artículo ${i + 1}`, quantity: 1, unitPrice: 50, taxAmount: 0, total: 50 },
      })
    }
    const items = await prisma.orderItem.findMany({ where: { orderId: o.id }, select: { id: true }, orderBy: { id: 'asc' } })
    return { id: o.id, itemIds: items.map(i => i.id) }
  }
  const marca = async (id: string) => (await prisma.order.findUniqueOrThrow({ where: { id }, select: { payLater: true } })).payLater

  it.each([true, false, null])('separar un artículo: la cuenta nueva hereda la marca (%p)', async payLater => {
    const origen = await cuenta(2, payLater)
    const { created } = await splitOrderItems(venueId!, origen.id, [origen.itemIds[0]])
    expect(await marca(created.id)).toBe(payLater)
  })

  it('🔴 juntar un fiado en una cuenta de cobro del momento: lo que queda es fiado', async () => {
    const fiado = await cuenta(1, true)
    const mostrador = await cuenta(1, false)
    await mergeOrders(venueId!, mostrador.id, fiado.id)
    expect(await marca(mostrador.id)).toBe(true)
  })

  it('juntar dos cobros del momento: sigue siendo cobro del momento', async () => {
    const a = await cuenta(1, false)
    const b = await cuenta(1, false)
    await mergeOrders(venueId!, a.id, b.id)
    expect(await marca(a.id)).toBe(false)
  })
})
