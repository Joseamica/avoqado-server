// tests/integration/dashboard/ligaConDescuento.integration.test.ts
/**
 * Descuento en ligas de pago, T6 (spec 2026-10-24 «Al pagar»): la venta de una liga con descuento lo guarda COMO descuento —
 * `Order.discountAmount` y una fila `OrderDiscount` con su reparto de cuenta—, construida SÓLO con la sesión de pago
 * (`metadata.descuento`, T5). El cobro, la lealtad y la comisión van sobre el neto sin propina; la factura (directa y la foto
 * de la global) lleva la base y el descuento; el recibo por correo, subtotal y descuento. Postgres REAL.
 *
 * Correr: TEST_DATABASE_URL=<base desechable> npx jest --selectProjects integration --runInBand \
 *   --runTestsByPath tests/integration/dashboard/ligaConDescuento.integration.test.ts --ci
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import emailService from '@/services/email.service'
import {
  completeCharge,
  finalizeMercadoPagoCheckout,
  finalizePaymentLinkCheckout,
  getSessionStatus,
  sendPaymentLinkReceiptEmail,
} from '@/services/dashboard/paymentLink.service'
import { ticketTotalsDelSnapshot } from '@/services/shared/ticketTotals'
import { loadOrderForCfdiFromDb } from '@/services/fiscal/cfdi.service'
import { ORDER_SELECT, ticketParaGlobal } from '@/services/fiscal/cfdiGlobal.service'
import logger from '@/config/logger'
import { importesDeLasFilas } from '@/services/shared/repartoDescuento'
import { RENGLON_PARA_REPARTO_SELECT } from '@/services/shared/repartoDescuentoTx'
import { borrarMundoComisiones, categoria, crearMundoComisiones, MundoComisiones, procesarEfectos } from '../commission/_mundoComisiones'

// Blumon E-commerce: el banco aprueba (la autorización real no es lo que se prueba aquí).
let autorizacion = 0
jest.mock('@/services/payments/provider-registry', () => ({
  ...jest.requireActual('@/services/payments/provider-registry'),
  getProvider: () => ({
    authorizeCardPayment: async () => ({ transactionId: `blu_${process.pid}_${++autorizacion}_${Date.now()}`, authorizationCode: 'A1' }),
  }),
}))

const PROVEEDOR = 'LIGA_DESC_PRUEBA'
type Camino = 'stripe' | 'blumon' | 'mercadopago'
const CAMINOS: Camino[] = ['stripe', 'blumon', 'mercadopago']

let m: MundoComisiones
let w: { canal: string; productos: { id: string; nombre: string; precio: number }[]; cliente: string; emailCliente: string; regla: string }
let n = 0

// La guarda de la base (nunca av-db-25 ni remota) la pone `integration-setup.ts` para todas las suites.
beforeEach(async () => {
  m = await crearMundoComisiones('liga-desc')
  const cat = await categoria(m)
  const producto = async (nombre: string, precio: number) => {
    const p = await prisma.product.create({
      data: {
        venueId: m.venueId,
        categoryId: cat,
        name: nombre,
        sku: `${m.key}-${nombre}`,
        price: new Prisma.Decimal(precio),
        satProductKey: '90101500',
        satUnitKey: 'H87',
      },
    })
    return { id: p.id, nombre, precio }
  }
  const proveedor = await prisma.paymentProvider.upsert({
    where: { code: PROVEEDOR },
    create: { code: PROVEEDOR, name: 'Liga con descuento (prueba)', type: 'PAYMENT_PROCESSOR' },
    update: {},
  })
  const canal = await prisma.ecommerceMerchant.create({
    data: {
      venueId: m.venueId,
      businessName: 'Liga con descuento',
      contactEmail: `${m.key}-canal@example.test`,
      publicKey: `pk_test_${m.key}`,
      secretKeyHash: `hash-${m.key}`,
      providerId: proveedor.id,
      providerCredentials: {},
    },
  })
  const emisor = await prisma.fiscalEmisor.create({
    data: { venueId: m.venueId, rfc: 'EKU9003173C9', legalName: 'ESCUELA KEMPER URGATE', regimenFiscal: '601', lugarExpedicion: '06000' },
  })
  await prisma.merchantFiscalConfig.create({
    data: { ecommerceMerchantId: canal.id, fiscalEmisorId: emisor.id, facturacionEnabled: true, autofacturaEnabled: true },
  })
  const emailCliente = `${m.key}-cliente@example.test`
  const cliente = await prisma.customer.create({ data: { venueId: m.venueId, email: emailCliente, firstName: 'Clienta', active: true } })
  const regla = await prisma.discount.create({
    data: { venueId: m.venueId, name: 'Promo 15', type: 'PERCENTAGE', value: new Prisma.Decimal(15), scope: 'ORDER', active: true },
  })
  w = {
    canal: canal.id,
    productos: [await producto('Playera', 600), await producto('Gorra', 400)],
    cliente: cliente.id,
    emailCliente,
    regla: regla.id,
  }
})
afterEach(async () => {
  if (m?.venueId) {
    await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisor: { venueId: m.venueId } } })
    await prisma.fiscalEmisor.deleteMany({ where: { venueId: m.venueId } })
  }
  await borrarMundoComisiones(m)
})
afterAll(() => prisma.paymentProvider.deleteMany({ where: { code: PROVEEDOR } }))

const foto = () => ({ v: 1, origen: 'CATALOGO', discountId: w.regla, type: 'PERCENTAGE', value: 15, name: 'Promo 15' })

/**
 * Una liga atribuida a Ana y pagada por `camino`, con la sesión como la deja la T5: `amount` = neto + propina y, sólo con
 * descuento, `metadata.descuento = { foto, descuento, base }`. Devuelve la orden que crea el finalizador.
 */
async function ligaPagada(
  camino: Camino,
  o: {
    productos: boolean
    descuento: boolean
    propina?: number
    /** El monto y la foto del descuento (default: Promo 15 → 150). */
    monto?: number
    foto?: Record<string, unknown>
    /** `metadata.descuento` tal cual (mal formado o que no cuadra); `amount` sigue saliendo de `descuento`/`monto`. */
    guardado?: unknown
  },
) {
  const propina = o.propina ?? 50
  const base = 1000
  const descuento = o.descuento ? (o.monto ?? 150) : 0
  const items = o.productos
    ? w.productos.map(p => ({ productId: p.id, productName: p.nombre, quantity: 1, unitPrice: p.precio, modifiers: [] }))
    : []
  const liga = await prisma.paymentLink.create({
    data: {
      shortCode: `${Math.random().toString(36).slice(2, 10)}${++n}`,
      venueId: m.venueId,
      ecommerceMerchantId: w.canal,
      createdById: m.owner,
      title: 'Liga con descuento',
      amountType: 'FIXED',
      amount: o.productos ? null : new Prisma.Decimal(base),
      purpose: o.productos ? 'ITEM' : 'PAYMENT',
      attributions: { create: [{ staffId: m.ana }] },
    },
  })
  const sessionId = camino === 'stripe' ? `pi_${m.key}_${n}` : `cs_${camino}_${m.key}_${n}`
  const metadata: Record<string, unknown> = {
    ...(propina > 0 ? { tipAmount: propina } : {}),
    ...(o.guardado !== undefined
      ? { descuento: o.guardado }
      : o.descuento
        ? { descuento: { foto: o.foto ?? foto(), descuento, base } }
        : {}),
    ...(o.productos ? { purpose: 'ITEM', items } : {}),
    ...(camino === 'blumon' ? { cardToken: 'tok_prueba', cvv: '123', maskedPan: '************4242', cardBrand: 'VISA' } : {}),
  }
  await prisma.checkoutSession.create({
    data: {
      sessionId,
      ecommerceMerchantId: w.canal,
      paymentLinkId: liga.id,
      amount: new Prisma.Decimal(base - descuento + propina),
      currency: 'MXN',
      customerEmail: w.emailCliente,
      expiresAt: new Date(Date.now() + 86_400_000),
      status: camino === 'blumon' ? 'PROCESSING' : 'PENDING',
      metadata: metadata as Prisma.InputJsonValue,
    },
  })
  if (camino === 'stripe') await finalizePaymentLinkCheckout({ stripeSessionId: sessionId, paymentIntentId: sessionId })
  else if (camino === 'blumon') await completeCharge(liga.shortCode, sessionId)
  else await finalizeMercadoPagoCheckout({ sessionId, mpPaymentId: `mp_${m.key}_${n}`, paymentTypeId: 'credit_card' })
  const orden = await prisma.order.findFirstOrThrow({
    where: { venueId: m.venueId, source: 'PAYMENT_LINK' },
    include: { orderDiscounts: true, items: { orderBy: { unitPrice: 'desc' } }, payments: true },
  })
  return { orden, liga, sessionId }
}

const txt = (d: Prisma.Decimal | null | undefined) => (d == null ? null : new Prisma.Decimal(d).toFixed(2))

describe('T6 · la venta de una liga con descuento guarda su descuento', () => {
  it.each(CAMINOS)(
    '🔴 %s: liga con productos 600 + 400 −15 % + propina 50 → orden 1000/150/900, fila con reparto, cobro 850',
    async camino => {
      const { orden } = await ligaPagada(camino, { productos: true, descuento: true })
      expect([txt(orden.subtotal), txt(orden.discountAmount), txt(orden.total), txt(orden.tipAmount), txt(orden.paidAmount)]).toEqual([
        '1000.00',
        '150.00',
        '900.00',
        '50.00',
        '900.00',
      ])
      expect(orden.orderDiscounts).toHaveLength(1)
      const fila = orden.orderDiscounts[0]
      expect({
        discountId: fila.discountId,
        type: fila.type,
        value: Number(fila.value),
        name: fila.name,
        amount: txt(fila.amount),
        isManual: fila.isManual,
        appliedById: fila.appliedById,
      }).toEqual({
        discountId: w.regla,
        type: 'PERCENTAGE',
        value: 15,
        name: 'Promo 15',
        amount: '150.00',
        isManual: false,
        appliedById: null,
      })
      const reparto = fila.reparto as { alcance: string; espejo: boolean; renglones: Record<string, number> }
      expect([reparto.alcance, reparto.espejo]).toEqual(['CUENTA', false])
      // El reparto suma el descuento entre los renglones (90 a la playera de 600, 60 a la gorra de 400).
      expect(orden.items.map(it => reparto.renglones[it.id])).toEqual([9000, 6000])
      expect(orden.payments.map(p => [txt(p.amount), txt(p.tipAmount)])).toEqual([['850.00', '50.00']])
      // El uso del descuento del catálogo, en la misma transacción.
      expect((await prisma.discount.findUniqueOrThrow({ where: { id: w.regla } })).currentUses).toBe(1)
      // Lealtad y métricas del cliente: el neto sin propina.
      expect(txt((await prisma.customer.findUniqueOrThrow({ where: { id: w.cliente } })).totalSpent)).toBe('850.00')
      // Comisión (10 %, «lo cobrado»): sobre 850, no sobre 1000.
      await procesarEfectos(m)
      const comision = await prisma.commissionCalculation.findFirstOrThrow({
        where: { venueId: m.venueId, paymentId: orden.payments[0].id },
      })
      expect([txt(comision.baseAmount), txt(comision.netCommission)]).toEqual(['850.00', '85.00'])
    },
  )

  it.each(CAMINOS)('%s: liga sin descuento → la orden y el cobro de hoy (sin fila, sin uso)', async camino => {
    const { orden } = await ligaPagada(camino, { productos: true, descuento: false })
    expect([txt(orden.subtotal), txt(orden.discountAmount), txt(orden.total), txt(orden.tipAmount), txt(orden.paidAmount)]).toEqual([
      '1000.00',
      '0.00',
      '1050.00',
      '50.00',
      '1050.00',
    ])
    expect(orden.orderDiscounts).toEqual([])
    expect(orden.payments.map(p => [txt(p.amount), txt(p.tipAmount)])).toEqual([['1000.00', '50.00']])
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: w.regla } })).currentUses).toBe(0)
    expect(txt((await prisma.customer.findUniqueOrThrow({ where: { id: w.cliente } })).totalSpent)).toBe('1000.00')
  })

  it.each(CAMINOS)(
    '🔴 %s: el descuento del catálogo se borró entre la sesión y el pago → se registra con los importes de la sesión, sin discountId',
    async camino => {
      await prisma.discount.delete({ where: { id: w.regla } })
      const { orden } = await ligaPagada(camino, { productos: true, descuento: true })
      expect([txt(orden.subtotal), txt(orden.discountAmount), txt(orden.total)]).toEqual(['1000.00', '150.00', '900.00'])
      expect(orden.orderDiscounts.map(f => [f.discountId, txt(f.amount), f.name])).toEqual([[null, '150.00', 'Promo 15']])
      expect(orden.payments.map(p => txt(p.amount))).toEqual(['850.00'])
    },
  )

  it('🔴 liga FIJA con descuento: factura directa y foto de la global dan el mismo concepto «Venta» 1000 − 150 = 850, sin propina', async () => {
    const { orden } = await ligaPagada('stripe', { productos: false, descuento: true })
    expect([txt(orden.subtotal), txt(orden.discountAmount), txt(orden.total)]).toEqual(['1000.00', '150.00', '900.00'])
    const directa = await loadOrderForCfdiFromDb(orden.id)
    expect(directa?.unsupportedReasons).toBeUndefined()
    expect(
      (directa!.order.items as any[]).map(it => [it.productName, txt(it.unitPrice), txt(new Prisma.Decimal(it.discountAmount))]),
    ).toEqual([['Venta', '1000.00', '150.00']])
    expect([directa!.paidCents, directa!.totalCents]).toEqual([85000, 85000])
    // La captura de la global congela los mismos conceptos (la extracción factura con éstos: base y descuento).
    const ticket = ticketParaGlobal(await prisma.order.findUniqueOrThrow({ where: { id: orden.id }, select: ORDER_SELECT }))
    expect(ticket.ok).toBe(true)
    if (!ticket.ok) return
    expect(ticket.orden.paidCents).toBe(85000)
    expect(ticket.orden.conceptosReales?.map(r => [r.descripcion, r.precio, r.descuentoCents])).toEqual([['Venta', '1000.000000', 15000]])
  })

  it('liga FIJA sin descuento: el concepto de respaldo de hoy (lo pagado, sin descuento)', async () => {
    const { orden } = await ligaPagada('stripe', { productos: false, descuento: false })
    const directa = await loadOrderForCfdiFromDb(orden.id)
    expect((directa!.order.items as any[]).map(it => [it.productName, txt(it.unitPrice), Number(it.discountAmount)])).toEqual([
      ['Venta', '1000.00', 0],
    ])
    const ticket = ticketParaGlobal(await prisma.order.findUniqueOrThrow({ where: { id: orden.id }, select: ORDER_SELECT }))
    expect(ticket.ok && ticket.orden.conceptosReales?.map(r => [r.precio, r.descuentoCents])).toEqual([['1000.000000', 0]])
  })

  it('liga CON PRODUCTOS con descuento: la factura lleva cada renglón con su reparto y suma 850', async () => {
    const { orden } = await ligaPagada('stripe', { productos: true, descuento: true })
    const directa = await loadOrderForCfdiFromDb(orden.id)
    expect(directa?.unsupportedReasons).toBeUndefined()
    expect(
      (directa!.order.items as any[]).map(it => [it.productName, txt(it.unitPrice), txt(new Prisma.Decimal(it.discountAmount))]),
    ).toEqual([
      ['Playera', '600.00', '90.00'],
      ['Gorra', '400.00', '60.00'],
    ])
    expect([directa!.paidCents, directa!.totalCents]).toEqual([85000, 85000])
  })

  it('🔴 recibo por correo: subtotal 1000, descuento 150, propina 50, total 900', async () => {
    const enviar = jest.spyOn(emailService, 'sendReceiptEmail').mockResolvedValue(true as never)
    try {
      const { orden, liga, sessionId } = await ligaPagada('stripe', { productos: true, descuento: true })
      await prisma.payment.update({ where: { id: orden.payments[0].id }, data: { receiptUrl: 'https://example.test/recibo' } })
      await sendPaymentLinkReceiptEmail(liga.shortCode, sessionId, w.emailCliente)
      const datos = enviar.mock.calls[0][1] as { subtotal?: number; discountAmount?: number; tipAmount?: number; totalAmount: number }
      expect([datos.subtotal, datos.discountAmount, datos.tipAmount, datos.totalAmount]).toEqual([1000, 150, 50, 900])
    } finally {
      enviar.mockRestore()
    }
  })

  it('🔴 D7 Mercado Pago: el estado da el recibo de Avoqado, el mismo en cada consulta, con lo cobrado (1000 − 150 + 50)', async () => {
    const antes = process.env.FRONTEND_URL
    process.env.FRONTEND_URL = 'https://dashboard.test'
    const avisos = jest.spyOn(logger, 'warn')
    try {
      const { orden, liga, sessionId } = await ligaPagada('mercadopago', { productos: false, descuento: true })
      // En Mercado Pago la sesión la marca COMPLETED el cobro (`executeMercadoPagoPaymentForPaymentLink`) o su aviso, no el finalizador.
      await prisma.checkoutSession.update({ where: { sessionId }, data: { status: 'COMPLETED', completedAt: new Date() } })
      // Dos pestañas a la vez la primera vez (Codex r1 #2): el candado del pago les da el mismo recibo.
      const [primera, segunda] = await Promise.all([getSessionStatus(liga.shortCode, sessionId), getSessionStatus(liga.shortCode, sessionId)])
      const tercera = await getSessionStatus(liga.shortCode, sessionId)

      // Si el generador falla, el estado lo traga (no tumba la página): aquí se exige que no haya fallado, con su motivo.
      expect(avisos.mock.calls.filter(c => String(c[0]).includes('recibo de Avoqado'))).toEqual([])
      expect([primera.status, primera.payment === null]).toEqual(['COMPLETED', false])
      const recibos = await prisma.digitalReceipt.findMany({ where: { paymentId: orden.payments[0].id } })
      expect(recibos).toHaveLength(1)
      expect(primera.payment?.receiptUrl).toBe(`https://dashboard.test/receipts/public/${recibos[0].accessKey}`)
      expect([segunda.payment?.receiptUrl, tercera.payment?.receiptUrl]).toEqual([primera.payment?.receiptUrl, primera.payment?.receiptUrl])
      const t = ticketTotalsDelSnapshot(recibos[0].dataSnapshot)
      expect([t?.subtotal, t?.discount, t?.tip, t?.total]).toEqual([1000, 150, 50, 900])
      // Codex r1 #1: la venta quedó ligada a Ana por su correo, sin verificar; el recibo público no lleva sus datos.
      expect(orden.customerId).toBeTruthy()
      expect((recibos[0].dataSnapshot as { customer?: unknown }).customer).toBeUndefined()
      expect(JSON.stringify(recibos[0].dataSnapshot)).not.toContain(w.emailCliente)
    } finally {
      avisos.mockRestore()
      process.env.FRONTEND_URL = antes
    }
  })

  it('🔴 D7 Blumon: la sesión apunta a su pago y el estado da el recibo de Avoqado', async () => {
    const antes = process.env.FRONTEND_URL
    process.env.FRONTEND_URL = 'https://dashboard.test'
    try {
      const { orden, liga, sessionId } = await ligaPagada('blumon', { productos: false, descuento: true })
      const sesion = await prisma.checkoutSession.findUniqueOrThrow({ where: { sessionId }, select: { paymentId: true } })
      expect(sesion.paymentId).toBe(orden.payments[0].id)

      const r = await getSessionStatus(liga.shortCode, sessionId)
      const recibo = await prisma.digitalReceipt.findFirstOrThrow({ where: { paymentId: orden.payments[0].id } })
      expect(r.payment?.receiptUrl).toBe(`https://dashboard.test/receipts/public/${recibo.accessKey}`)
    } finally {
      process.env.FRONTEND_URL = antes
    }
  })

  it('🔴 fix r1: un % topado por el catálogo (20 % con tope 100 sobre 1000) guarda el tope y un recálculo da 100, no 200', async () => {
    const { orden } = await ligaPagada('stripe', {
      productos: true,
      descuento: true,
      monto: 100,
      foto: { ...foto(), value: 20, name: 'Promo 20 tope 100' },
    })
    const [fila] = orden.orderDiscounts
    expect([fila.type, Number(fila.value), txt(fila.amount), (fila.reparto as { tope?: number }).tope]).toEqual([
      'PERCENTAGE',
      20,
      '100.00',
      100,
    ])
    const renglones = await prisma.orderItem.findMany({ where: { orderId: orden.id }, select: RENGLON_PARA_REPARTO_SELECT })
    const { montosRederivados } = importesDeLasFilas(renglones, await prisma.orderDiscount.findMany({ where: { orderId: orden.id } }))
    expect(montosRederivados.get(fila.id)).toBe(100)
  })

  it('un % sin tope (15 % = 150) no guarda tope', async () => {
    const { orden } = await ligaPagada('stripe', { productos: true, descuento: true })
    expect((orden.orderDiscounts[0].reparto as { tope?: number }).tope).toBeUndefined()
  })

  it.each([
    ...CAMINOS.map(c => [c, 'no cuadra con lo cobrado', { descuento: 150, base: 1000 }] as const),
    ...CAMINOS.map(c => [c, 'trae importes que no son números', { descuento: 'abc', base: null }] as const),
  ])(
    '🔴 fix r1: %s con un descuento guardado que %s → la venta de hoy (lo que cobró el banco), sin lanzar y con error en el log',
    async (camino, _caso, valores) => {
      const error = jest.spyOn(logger, 'error')
      try {
        const { orden, sessionId } = await ligaPagada(camino, {
          productos: false,
          descuento: false,
          guardado: { foto: foto(), ...valores },
        })
        expect([txt(orden.subtotal), txt(orden.discountAmount), txt(orden.total), txt(orden.paidAmount)]).toEqual([
          '1000.00',
          '0.00',
          '1050.00',
          '1050.00',
        ])
        expect(orden.orderDiscounts).toEqual([])
        expect(orden.payments.map(p => [txt(p.amount), txt(p.tipAmount)])).toEqual([['1000.00', '50.00']])
        expect((await prisma.discount.findUniqueOrThrow({ where: { id: w.regla } })).currentUses).toBe(0)
        expect(error).toHaveBeenCalledWith(expect.stringContaining('no cuadra con lo cobrado'), expect.objectContaining({ sessionId }))
      } finally {
        error.mockRestore()
      }
    },
  )
})
