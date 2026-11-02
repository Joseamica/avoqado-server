/**
 * Tablero hz:ec5af077:D2 (24-oct-2026, founder «A»): la oficina de PlayTelecom corrige el importe de una venta de SIM desde la
 * verificación (panel y MCP, `editOrgSaleVerification`). Antes cambiaba sólo el cobro: la E-SIM que la TPV registra en $0 y la
 * oficina sube a $100 dejaba la cuenta en total $0 / pagado $0 con un cobro de $100 (6 ventas así en producción, medido el
 * 24-oct; 1 al revés, $100 → $0). Ahora la cuenta sigue al cobro —precio del artículo, subtotal, total, pagado y saldo— cuando
 * la venta es simple (1 artículo, cantidad 1, sin modificadores, sin IVA aparte, descuento, cargo, envío ni propina, y ningún
 * otro cobro vivo). Si no es simple, el importe no se corrige ahí: 409 `SALE_AMOUNT_NOT_SIMPLE` y NADA se escribe.
 */
import { Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { editOrgSaleVerification } from '@/services/dashboard/sale-verification.org.dashboard.service'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import * as moduloDelProtocolo from '@/services/shared/cobroDelProtocolo'
import { crearFixture, exigirBaseDesechable, type Fixture, exigir } from './webhookCheckpoint.fixture'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToUser: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

let f: Fixture
beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('ventapt')
})
afterEach(async () => {
  jest.restoreAllMocks()
  await prisma.saleVerification.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
})
afterAll(() => f.destruir())

const d = (n: number) => new Prisma.Decimal(n)

/** La venta de SIM tal como la deja la TPV en producción: 1 artículo, cobro en efectivo anterior al protocolo, cuenta PAID. */
async function ventaDeSim(
  importe: number,
  extra: { orden?: Partial<Prisma.OrderUncheckedCreateInput>; articulos?: number; tipo?: 'REGULAR' | 'REFUND' } = {},
) {
  const orden = await prisma.order.create({
    data: {
      venueId: f.venueId,
      orderNumber: `ventapt-${randomUUID().slice(0, 8)}`,
      type: 'TAKEOUT',
      source: 'TPV',
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      subtotal: d(importe),
      taxAmount: d(0),
      total: d(importe),
      paidAmount: d(importe),
      remainingBalance: d(0),
      createdById: f.staffId,
      ...extra.orden,
    },
  })
  for (let i = 0; i < (extra.articulos ?? 1); i++) {
    await prisma.orderItem.create({
      data: { orderId: orden.id, productName: 'E-SIM de promotor', quantity: 1, unitPrice: d(importe), taxAmount: d(0), total: d(importe) },
    })
  }
  const pago = await prisma.payment.create({
    data: {
      venueId: f.venueId,
      orderId: orden.id,
      amount: d(importe),
      tipAmount: d(0),
      method: 'CASH',
      status: 'COMPLETED',
      type: extra.tipo ?? 'REGULAR',
      feePercentage: d(0),
      feeAmount: d(0),
      netAmount: d(importe),
      processedById: f.staffId,
    },
  })
  const sv = await prisma.saleVerification.create({
    data: { venueId: f.venueId, paymentId: pago.id, staffId: f.staffId, photos: [], status: 'PENDING', isPortabilidad: false },
  })
  return { orden, pago, sv }
}

const editar = (sv: { id: string }, cambios: Record<string, unknown>) =>
  editOrgSaleVerification(f.fixture, { saleVerificationId: sv.id, editedById: f.staffId, reason: 'corrección de prueba D2', ...cambios })

const cuenta = async (orderId: string) => {
  const o = await exigir(prisma.order.findUnique({ where: { id: orderId }, include: { items: true } }))
  return {
    subtotal: Number(o.subtotal),
    total: Number(o.total),
    paidAmount: Number(o.paidAmount),
    remainingBalance: Number(o.remainingBalance),
    paymentStatus: o.paymentStatus,
    version: o.version,
    articulos: o.items.map(i => ({ unitPrice: Number(i.unitPrice), total: Number(i.total) })),
  }
}
const importeDelCobro = async (id: string) => Number((await exigir(prisma.payment.findUnique({ where: { id } }))).amount)

describe('D2 · corregir el importe de una venta de SIM mueve también la cuenta', () => {
  it('E-SIM de $0 corregida a $100 ⇒ artículo, subtotal, total y pagado en $100, saldo $0 y PAID', async () => {
    const { orden, pago, sv } = await ventaDeSim(0)
    await editar(sv, { amount: 100 })
    expect(await importeDelCobro(pago.id)).toBe(100)
    expect(await cuenta(orden.id)).toMatchObject({
      subtotal: 100,
      total: 100,
      paidAmount: 100,
      remainingBalance: 0,
      paymentStatus: 'PAID',
      articulos: [{ unitPrice: 100, total: 100 }],
    })
  })

  it('al revés: venta de $100 bajada a $0 ⇒ la cuenta queda en $0 y PAID', async () => {
    const { orden, sv } = await ventaDeSim(100)
    await editar(sv, { amount: 0 })
    expect(await cuenta(orden.id)).toMatchObject({ subtotal: 0, total: 0, paidAmount: 0, remainingBalance: 0, paymentStatus: 'PAID' })
  })

  it('una cuenta que YA quedó desfasada (total $0, cobro $100, como las 6 de producción) se acomoda al volver a corregirla', async () => {
    const { orden, pago, sv } = await ventaDeSim(0)
    await prisma.payment.update({ where: { id: pago.id }, data: { amount: d(100) } })
    await editar(sv, { amount: 150 })
    expect(await cuenta(orden.id)).toMatchObject({ total: 150, paidAmount: 150, remainingBalance: 0, articulos: [{ unitPrice: 150 }] })
  })

  it('la cuenta sube de versión (los aparatos que la tengan en memoria la vuelven a leer)', async () => {
    const { orden, sv } = await ventaDeSim(0)
    const antes = (await cuenta(orden.id)).version
    await editar(sv, { amount: 100 })
    expect((await cuenta(orden.id)).version).toBe(antes + 1)
  })

  it('la bitácora dice que la cuenta se movió con el cobro', async () => {
    const { orden, sv } = await ventaDeSim(0)
    await editar(sv, { amount: 100 })
    const bitacora = await exigir(prisma.activityLog.findFirst({ where: { entityId: sv.id, action: 'SALE_VERIFICATION_EDIT' } }))
    expect(bitacora.data).toMatchObject({ cuenta: { orderId: orden.id, antes: { total: 0 }, despues: { total: 100 } } })
  })

  it.each([
    ['dos artículos', { articulos: 2 }],
    ['un descuento', { orden: { discountAmount: d(10) } }],
    ['una propina', { orden: { tipAmount: d(5) } }],
    ['IVA aparte', { orden: { taxAmount: d(16) } }],
    ['un cargo por servicio', { orden: { serviceChargeAmount: d(10) } }],
    ['un costo de envío', { orden: { deliveryFeeAmount: d(20) } }],
    ['un cobro que es REEMBOLSO', { tipo: 'REFUND' }],
  ])('venta con %s ⇒ 409 SALE_AMOUNT_NOT_SIMPLE y no cambia nada (ni el cobro, ni la cuenta, ni la verificación)', async (_n, extra) => {
    const { orden, pago, sv } = await ventaDeSim(100, extra as Parameters<typeof ventaDeSim>[1])
    const antes = await cuenta(orden.id)
    await expect(editar(sv, { amount: 120, status: 'COMPLETED' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'SALE_AMOUNT_NOT_SIMPLE',
    })
    expect(await importeDelCobro(pago.id)).toBe(100)
    expect(await cuenta(orden.id)).toEqual(antes)
    expect((await exigir(prisma.saleVerification.findUnique({ where: { id: sv.id } }))).status).toBe('PENDING')
    expect(await prisma.activityLog.count({ where: { entityId: sv.id } })).toBe(0)
  })

  it('venta con OTRO cobro vivo en la misma cuenta ⇒ 409 y nada cambia', async () => {
    const { orden, pago, sv } = await ventaDeSim(100)
    await prisma.payment.create({
      data: {
        venueId: f.venueId,
        orderId: orden.id,
        amount: d(20),
        method: 'CASH',
        status: 'COMPLETED',
        feePercentage: d(0),
        feeAmount: d(0),
        netAmount: d(20),
      },
    })
    await expect(editar(sv, { amount: 120 })).rejects.toMatchObject({ statusCode: 409, code: 'SALE_AMOUNT_NOT_SIMPLE' })
    expect(await importeDelCobro(pago.id)).toBe(100)
  })

  it('CONTROL · un cobro FALLIDO en la misma cuenta no estorba', async () => {
    const { orden, sv } = await ventaDeSim(0)
    await prisma.payment.create({
      data: {
        venueId: f.venueId,
        orderId: orden.id,
        amount: d(100),
        method: 'CASH',
        status: 'FAILED',
        feePercentage: d(0),
        feeAmount: d(0),
        netAmount: d(100),
      },
    })
    await editar(sv, { amount: 100 })
    expect(await cuenta(orden.id)).toMatchObject({ total: 100, paidAmount: 100 })
  })

  it('CONTROL · cambiar sólo la forma de pago o el estado no toca la cuenta (ni su versión)', async () => {
    const { orden, sv } = await ventaDeSim(100, { articulos: 2 })
    const antes = await cuenta(orden.id)
    await editar(sv, { paymentForm: 'OTHER', status: 'COMPLETED' })
    expect(await cuenta(orden.id)).toEqual(antes)
  })

  it('CONTROL · el mismo importe (no-op) no toca la cuenta aunque no sea simple', async () => {
    const { orden, sv } = await ventaDeSim(100, { articulos: 2 })
    const antes = await cuenta(orden.id)
    await editar(sv, { amount: 100 })
    expect(await cuenta(orden.id)).toEqual(antes)
  })

  describe('carreras (Codex r1): la cuenta se toma ANTES que el cobro, como todo dinero ligado a una orden', () => {
    const cuentaSinEsperar = (id: string): Promise<'LIBRE' | 'TOMADA'> =>
      prisma.$transaction(async tx => {
        await tx.$executeRaw`SAVEPOINT sonda`
        try {
          await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${id} FOR UPDATE NOWAIT`
          await tx.$executeRaw`RELEASE SAVEPOINT sonda`
          return 'LIBRE' as const
        } catch (error) {
          if (!/55P03|could not obtain lock/i.test(error instanceof Error ? error.message : String(error))) throw error
          await tx.$executeRaw`ROLLBACK TO SAVEPOINT sonda`
          return 'TOMADA' as const
        }
      })
    const sigueCorriendo = async (p: Promise<unknown>, ms: number) =>
      Promise.race([
        p.then(
          () => false,
          () => false,
        ),
        new Promise<boolean>(r => setTimeout(() => r(true), ms)),
      ])
    /** Detiene al editor ya clasificado (con la cuenta y el cobro tomados) hasta `soltar()`. */
    const editorEnPausa = () => {
      let soltar!: () => void
      let pausado!: () => void
      const liberada = new Promise<void>(r => (soltar = r))
      const enPausa = new Promise<void>(r => (pausado = r))
      const real = moduloDelProtocolo.cobrosDelProtocolo
      jest.spyOn(moduloDelProtocolo, 'cobrosDelProtocolo').mockImplementationOnce(async (db, ids) => {
        const r = await real(db, ids)
        pausado()
        await liberada
        return r
      })
      return { soltar, enPausa }
    }
    const cobroTardioDeLaTpv = (orderId: string, centavos: number) =>
      recordOrderPayment(
        f.venueId,
        orderId,
        { ...f.registroDeLaTerminal({ attemptId: randomUUID(), sinMerchant: true, amount: centavos }), method: 'CASH' } as never,
        f.staffId,
      )

    it('EDITOR PRIMERO · con la corrección en curso la cuenta está TOMADA; el cobro tardío de la TPV ($20) espera y, al entrar, cuenta los $150 corregidos: pagado $170, nunca $150', async () => {
      const { orden, sv } = await ventaDeSim(100)
      const b = editorEnPausa()
      const edicion = editar(sv, { amount: 150 })
      await b.enPausa
      let tpv: Promise<unknown> | null = null
      try {
        expect(await cuentaSinEsperar(orden.id)).toBe('TOMADA')
        tpv = cobroTardioDeLaTpv(orden.id, 2000)
        expect(await sigueCorriendo(tpv, 1500)).toBe(true)
      } finally {
        b.soltar()
      }
      await edicion
      await tpv
      const cobros = await prisma.payment.findMany({ where: { orderId: orden.id, status: 'COMPLETED' }, select: { amount: true } })
      expect(cobros.map(c => Number(c.amount)).sort((a, z) => a - z)).toEqual([20, 150])
      expect((await cuenta(orden.id)).paidAmount).toBe(170)
    })

    it('OTRO PRIMERO · si otro escritor tiene la cuenta y le agrega un cobro, la corrección espera, relee y responde 409 sin escribir nada', async () => {
      const { orden, pago, sv } = await ventaDeSim(100)
      let soltar!: () => void
      const liberada = new Promise<void>(r => (soltar = r))
      let tomada!: () => void
      const yaTomada = new Promise<void>(r => (tomada = r))
      const otro = prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orden.id} FOR UPDATE`
          tomada()
          await liberada
          await tx.payment.create({
            data: {
              venueId: f.venueId,
              orderId: orden.id,
              amount: d(20),
              method: 'CASH',
              status: 'COMPLETED',
              feePercentage: d(0),
              feeAmount: d(0),
              netAmount: d(20),
            },
          })
        },
        { timeout: 15_000 },
      )
      await yaTomada
      const edicion = editar(sv, { amount: 150 })
      try {
        expect(await sigueCorriendo(edicion, 1500)).toBe(true)
      } finally {
        soltar()
      }
      await otro
      await expect(edicion).rejects.toMatchObject({ statusCode: 409, code: 'SALE_AMOUNT_NOT_SIMPLE' })
      expect(await importeDelCobro(pago.id)).toBe(100)
    })

    it('el neto del cobro acompaña al importe corregido', async () => {
      const { pago, sv } = await ventaDeSim(0)
      await editar(sv, { amount: 100 })
      expect(Number((await exigir(prisma.payment.findUnique({ where: { id: pago.id } }))).netAmount)).toBe(100)
    })
  })
})
