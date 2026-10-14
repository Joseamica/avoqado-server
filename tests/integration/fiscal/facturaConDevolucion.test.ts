/**
 * IVA por producto · F6 (hallazgo #6, decisión del founder del 12-oct) contra una base desechable: facturar desde Pedidos (STAFF_B) una venta
 * que ya tuvo devoluciones. Decisión 1: TOTAL ⇒ no se factura. Decisión 2: sólo artículos completos ⇒ la factura sale con lo que el cliente
 * se quedó. Decisión 3: por importe, parte de un artículo o la mezcla ⇒ por el total + la nota de cada devolución, emitida sola, en orden
 * fiscal. El PAC es SIEMPRE un doble (Facturapi nunca real); su `downloadXml` arma el XML de lo que se le mandó (`xmlDeLaFila`), así la nota
 * tiene el XML de su factura al momento, como en producción.
 */
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))
jest.mock('@/services/storage.service', () => ({
  ...jest.requireActual('@/services/storage.service'),
  uploadFileToStorage: jest.fn(async () => 'https://test/file'),
}))
jest.mock('@/services/fiscal/cfdiEmail.service', () => ({
  ...jest.requireActual('@/services/fiscal/cfdiEmail.service'),
  sendNewCfdiByEmail: jest.fn(async () => undefined),
}))
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import {
  CODIGO_VENTA_DEVUELTA,
  folioDe,
  issueCfdiForOrder,
  listCfdisForVenue,
  MOTIVO_VENTA_DEVUELTA_COMPLETA,
  textoDeDocumentoRelacionado,
  type IssueCfdiDeps,
} from '@/services/fiscal/cfdi.service'
import { replaceCfdi } from '@/services/fiscal/cfdiReplacement.service'
import {
  asignacionDeReales,
  emitRefundCreditNote,
  getRefundCreditNoteStatus,
  MOTIVO_DESCONTADA_EN_LA_FACTURA,
  MOTIVO_NOTA_DEL_REEMBOLSO_CANCELADA,
  MOTIVO_VENTA_DEVUELTA_SIN_FACTURA,
  motivoEsperaNotaDeArticulos,
  olvidarGlobalesEvaluadas,
} from '@/services/fiscal/cfdiCreditNote.service'
import * as notas from '@/services/fiscal/cfdiCreditNote.service'
import { emitirExtraccion, motivoDevolucionSinNotaEnLaGlobal } from '@/services/fiscal/cfdiExtraccion.service'
import { issueGlobalForEmisor, ORDER_SELECT, ticketParaGlobal } from '@/services/fiscal/cfdiGlobal.service'
import * as cfdiService from '@/services/fiscal/cfdi.service'
import * as reconcileService from '@/services/fiscal/cfdiReconcile.service'
import { CfdiReconcileJob } from '@/jobs/cfdiReconcile.job'
import logger from '@/config/logger'
import {
  contarFacturasConNotasPendientes,
  emitirNotasDeDevolucion,
  facturasConNotasPendientes,
  MOTIVO_NOTA_PENDIENTE,
  motivoDevolucionIlegible,
  motivoNotaCancelada,
  motivoNotaDeOtraFactura,
  sqlDeNotasPendientes,
  sqlDelConteoDeNotasPendientes,
} from '@/services/fiscal/facturaConDevolucion'
import { ProviderHttpError } from '@/services/fiscal/providers/facturapi.provider'
import { MOTIVO_REMANENTE_NO_TRAZABLE } from '@/services/fiscal/nominativaPorExtraccion'
import * as finalizadorCfdi from '@/services/fiscal/finalizadorCfdi'
import { xmlDeLaFila } from '../../__helpers__/xml-del-pac'
import { encenderIvaPorProducto } from '../../__helpers__/iva-por-producto'

const { isDisposableH1Url } = require('../../../scripts/h1-test-database.cjs')
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
// Sólo una base local desechable (`avoqado_<tarea>_test_<fecha>` o una H1 validada); nunca `av-db-25`.
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !(isDisposableH1Url(database) || /^\/avoqado_[a-z0-9]+_test_[0-9]+$/.test(database.pathname))
)
  throw new Error('Esta suite exige una base local desechable (avoqado_<tarea>_test_<fecha>).')

const NOW = new Date('2026-06-03T17:00:00Z')
const MAYO = new Date('2026-05-15T12:00:00Z')
const CLAVE_CAFE = { satProductKey: '50201706', satUnitKey: 'H87' }
const receptor = { rfc: 'EKU9003173C9', razonSocial: 'ESCUELA KEMPER URGATE', regimenFiscal: '601', codigoPostal: '64000', usoCfdi: 'G03' }
const valid = () => ({
  providerInvoiceId: randomUUID(),
  uuid: randomUUID(),
  serie: 'F',
  folio: String(Math.floor(Math.random() * 1e6)),
  totalCents: 0,
  stampedAt: new Date(),
  status: 'valid' as const,
})

describe('F6 · facturar desde Pedidos una venta que tuvo devolución', () => {
  const fixture = `f6-${randomUUID()}`
  let venueId: string
  let p16: string
  let p0: string
  let fiscalEmisorId: string
  let s1: string
  const provider = {
    name: 'facturapi',
    createInvoice: jest.fn(),
    createGlobalInvoice: jest.fn(),
    createCreditNote: jest.fn(),
    cancelInvoice: jest.fn(),
    findByExternalId: jest.fn(),
    getInvoice: jest.fn(),
    downloadXml: jest.fn(),
    downloadPdf: jest.fn(),
  }

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
    venueId = (await prisma.venue.create({ data: { id: fixture, organizationId: fixture, name: fixture, slug: fixture } })).id
    await encenderIvaPorProducto(venueId)
    const category = await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })
    p16 = (
      await prisma.product.create({ data: { venueId, categoryId: category.id, name: `${fixture}-16`, sku: `${fixture}-16`, price: 116 } })
    ).id
    p0 = (
      await prisma.product.create({
        data: {
          venueId,
          categoryId: category.id,
          name: `${fixture}-0`,
          sku: `${fixture}-0`,
          price: 200,
          ivaTratamiento: 'IVA_0',
          satProductKey: CLAVE_CAFE.satProductKey,
          satUnitKey: CLAVE_CAFE.satUnitKey,
        },
      })
    ).id
    fiscalEmisorId = (
      await prisma.fiscalEmisor.create({
        data: {
          venueId,
          rfc: 'AAA010101AAA',
          legalName: fixture,
          regimenFiscal: '601',
          lugarExpedicion: '01000',
          csdStatus: 'ACTIVE',
          globalPeriodicity: 'MENSUAL',
          invoiceCashSales: true,
        },
      })
    ).id
    await prisma.paymentProvider.create({
      data: { id: fixture, code: fixture, name: fixture, type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
    await prisma.merchantAccount.create({
      data: { id: fixture, providerId: fixture, externalMerchantId: fixture, credentialsEncrypted: {} },
    })
    await prisma.merchantFiscalConfig.create({
      data: { merchantAccountId: fixture, fiscalEmisorId, facturacionEnabled: true, autofacturaEnabled: true, includeInGlobal: true },
    })
    s1 = (await prisma.staff.create({ data: { email: `${fixture}-s1@staff.test`, firstName: 'Factura', lastName: 'Devuelta' } })).id
  })

  async function limpiarVentas() {
    if (!venueId) return
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.orderItemSelloIva.deleteMany({ where: { cfdi: { venueId } } })
    await prisma.cfdiGlobalOrden.deleteMany({ where: { cfdi: { venueId } } })
    await prisma.cfdi.deleteMany({ where: { venueId } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
  }
  beforeEach(async () => {
    await limpiarVentas()
    olvidarGlobalesEvaluadas()
    finalizadorCfdi.olvidarReparaciones()
    jest.clearAllMocks()
    for (const f of Object.values(provider)) if (typeof f === 'function') (f as jest.Mock).mockReset()
    jest.mocked(resolveFiscalProvider).mockReturnValue(provider as any)
    provider.createInvoice.mockImplementation(async () => valid())
    provider.createGlobalInvoice.mockImplementation(async () => valid())
    provider.createCreditNote.mockImplementation(async () => valid())
    provider.findByExternalId.mockResolvedValue(null)
    provider.getInvoice.mockResolvedValue(null)
    provider.downloadXml.mockImplementation(async (id: string) => xmlDeLaFila(prisma, id))
    provider.downloadPdf.mockResolvedValue(Buffer.from('%PDF'))
  })
  afterEach(() => jest.restoreAllMocks())
  afterAll(async () => {
    if (!venueId) return
    await limpiarVentas()
    await prisma.staff.deleteMany({ where: { id: { in: [s1].filter(Boolean) } } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisorId } })
    await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
    await prisma.merchantAccount.deleteMany({ where: { id: fixture } })
    await prisma.paymentProvider.deleteMany({ where: { id: fixture } })
    await prisma.venue.delete({ where: { id: venueId } })
    await prisma.organization.delete({ where: { id: fixture } })
  })

  /** Una venta de mayo cobrada con tarjeta (IVA incluido): un renglón por producto, al precio indicado. */
  async function venta(renglones: Array<{ productId: string; precio: number }>) {
    const total = renglones.reduce((s, r) => s + r.precio, 0)
    return prisma.order.create({
      data: {
        venueId,
        orderNumber: `F6-${randomUUID().slice(0, 8)}`,
        subtotal: total,
        taxAmount: 0,
        total,
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        items: {
          create: renglones.map(r => ({
            productId: r.productId,
            productName: 'Producto',
            quantity: 1,
            unitPrice: r.precio,
            taxAmount: 0,
            total: r.precio,
          })),
        },
        payments: {
          create: {
            venueId,
            merchantAccountId: fixture,
            amount: total,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: total,
            method: 'CREDIT_CARD',
            status: 'COMPLETED',
            createdAt: MAYO,
          },
        },
      },
      include: { items: true },
    })
  }
  type Venta = Awaited<ReturnType<typeof venta>>
  const articulo = (t: Venta, productId: string, precio: number) =>
    t.items.find(i => i.productId === productId && Number(i.total) === precio)!
  /** Un reembolso por ARTÍCULOS como lo guarda el dashboard (`processorData.refundedItems` con cantidad e importe). */
  async function refundItems(t: Venta, cuales: Array<{ productId: string; precio: number; amountCents?: number }>, db: any = prisma) {
    const filas = cuales.map(c => {
      const it = articulo(t, c.productId, c.precio)
      return { orderItemId: it.id, quantity: 1, amountCents: c.amountCents ?? Math.round(Number(it.total) * 100) }
    })
    const cents = filas.reduce((s, f) => s + f.amountCents, 0)
    return db.payment.create({
      data: {
        venueId,
        orderId: t.id,
        type: 'REFUND',
        amount: -cents / 100,
        tipAmount: 0,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -cents / 100,
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        processorData: { refundedItems: filas },
      },
    })
  }
  /** Un reembolso por IMPORTE (sin artículos). */
  const refundAmount = (
    t: { id: string },
    pesos: number,
    o: { propina?: number; status?: 'COMPLETED' | 'PENDING' | 'FAILED' } = {},
    db: any = prisma,
  ) =>
    db.payment.create({
      data: {
        venueId,
        orderId: t.id,
        type: 'REFUND',
        amount: -pesos,
        tipAmount: -(o.propina ?? 0),
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -(pesos + (o.propina ?? 0)),
        method: 'CREDIT_CARD',
        status: o.status ?? 'COMPLETED',
      },
    })
  /** «Facturar» desde Pedidos, como el controlador del dashboard. */
  const facturar = (orderId: string, over: Partial<IssueCfdiDeps> = {}) =>
    issueCfdiForOrder(
      { orderId, receptor, sandbox: true, expectedVenueId: venueId, flow: 'STAFF_B', staffId: s1 },
      { resolveProvider: () => provider as any, ...over },
    )
  const facturaDe = (orderId: string) =>
    prisma.cfdi.findFirstOrThrow({ where: { orderId, type: 'INGRESO', isGlobal: false }, orderBy: { createdAt: 'desc' } })
  /** Café $200 (0 %) + pan $58 (16 %): la venta de las Tareas 4 a 9. */
  const ventaMezclada = () =>
    venta([
      { productId: p0, precio: 200 },
      { productId: p16, precio: 58 },
    ])
  const notaDe = (refundId: string) => prisma.cfdi.findUnique({ where: { idempotencyKey: `cfdi-refund-${refundId}` } })
  /** «Facturar» con las notas automáticas fallando (como si el proceso muriera). Una fábrica, no un objeto: `afterEach(jest.restoreAllMocks)`
   * le quitaría la implementación a un `jest.fn` compartido. */
  const sinNotas = () => ({ emitRefundCreditNote: jest.fn().mockRejectedValue(new Error('el proceso murió')) })

  // ─── Tarea 3: la decisión bajo el candado y la factura que sale ────────────────────────────────────────────────────────────────────

  it.each([
    ['por importe', async (t: Venta) => refundAmount(t, 258)],
    [
      'todos los artículos',
      async (t: Venta) =>
        refundItems(t, [
          { productId: p0, precio: 200 },
          { productId: p16, precio: 58 },
        ]),
    ],
  ])('🔴 decisión 1 (%s): la venta devuelta completa NO se factura — 409 con su código, ni PAC ni fila Cfdi', async (_c, devolver) => {
    const t = await venta([
      { productId: p0, precio: 200 },
      { productId: p16, precio: 58 },
    ])
    await devolver(t)
    await expect(facturar(t.id)).rejects.toMatchObject({ message: MOTIVO_VENTA_DEVUELTA_COMPLETA, code: CODIGO_VENTA_DEVUELTA })
    expect(provider.createInvoice).not.toHaveBeenCalled()
    expect(await prisma.cfdi.count({ where: { orderId: t.id } })).toBe(0)
  })

  // D1 del /full-testing: el panel del reembolso de una venta devuelta COMPLETA sin factura decía «primero se factura la venta», y F6 ya no la factura.
  it('🔴 D1: el reembolso de una venta devuelta COMPLETA y sin factura dice que ya no se factura por separado (la suma de los reembolsos, vista desde cualquiera)', async () => {
    const t = await venta([
      { productId: p0, precio: 200 },
      { productId: p16, precio: 58 },
    ])
    const r1 = await refundAmount(t, 200, { propina: 100 }) // la propina nunca cuenta como venta devuelta
    // devuelta EN PARTE: la venta sí se puede facturar, y el texto de siempre es verdad
    expect((await getRefundCreditNoteStatus(venueId, r1.id))!.eligibility).toMatchObject({ eligible: false, reason: 'NO_ORIGINAL_CFDI' })
    const r2 = await refundItems(t, [{ productId: p16, precio: 58 }])
    for (const r of [r1, r2])
      expect((await getRefundCreditNoteStatus(venueId, r.id))!.eligibility).toEqual({
        eligible: false,
        reason: 'VENTA_DEVUELTA_COMPLETA',
        message: MOTIVO_VENTA_DEVUELTA_SIN_FACTURA,
      })
    await expect(facturar(t.id)).rejects.toMatchObject({ code: CODIGO_VENTA_DEVUELTA }) // y de verdad no se factura
  })
  it('control D1 — con factura vigente, devolverla COMPLETA sigue llevando su nota (la regla sólo habla de la venta SIN factura)', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    expect((await facturar(t.id)).status).toBe('STAMPED')
    const r = await refundAmount(t, 116)
    expect((await getRefundCreditNoteStatus(venueId, r.id))!.eligibility).toMatchObject({ eligible: true })
  })

  it('🔴 M1 (revisión final): una reserva que nunca se envió (el proceso murió) + devolución TOTAL + volver a facturar ⇒ la fila queda VALIDATION_FAILED (no viva) con el motivo, sin timbrar', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const murio = () => {
      throw new Error('el proceso murió')
    }
    await expect(facturar(t.id, { resolveProvider: murio as any })).rejects.toThrow('el proceso murió') // entre la reserva y el envío
    const reserva = await facturaDe(t.id)
    expect(reserva).toMatchObject({ status: 'STAMPING', enviadoAt: null })
    await refundAmount(t, 116)
    expect(await facturar(t.id)).toMatchObject({
      status: 'VALIDATION_FAILED',
      reasons: expect.arrayContaining([MOTIVO_VENTA_DEVUELTA_COMPLETA]),
    })
    // VALIDATION_FAILED no es viva (`CFDI_VIVO`): ni «en proceso» para siempre en la lista ni bloquea otra emisión.
    expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: reserva.id } })).toMatchObject({
      status: 'VALIDATION_FAILED',
      enviadoAt: null,
    })
    expect(provider.createInvoice).not.toHaveBeenCalled()
  })

  it('🔴 decisión 2 (venta mezclada): el pan devuelto completo ⇒ la factura sale SÓLO con el café, por lo que se cobró de él, con su clave real', async () => {
    const t = await venta([
      { productId: p0, precio: 200 },
      { productId: p16, precio: 58 },
    ])
    const r1 = await refundItems(t, [{ productId: p16, precio: 58 }])
    const r = await facturar(t.id)
    expect(r.status).toBe('STAMPED')
    const enviado = provider.createInvoice.mock.calls[0][0]
    expect(enviado.items.map((i: any) => [i.unitPriceCents, i.quantity, i.satProductKey, i.satUnitKey])).toEqual([
      [20000, 1, '50201706', 'H87'],
    ])
    const f = await facturaDe(t.id)
    expect(f.totalCents).toBe(20000)
    const e = f.entrada as any
    expect(e.devoluciones).toEqual({ modo: 'DESCONTADAS', pagos: [r1.id] })
    expect(e.devoluciones).not.toHaveProperty('redondeoCents') // Ruling M7: sin redondeo, el campo no aparece
    expect(e.paidCents).toBe(20000)
    expect(e.renglones).toEqual([{ orderItemId: articulo(t, p0, 200).id, tratamiento: 'IVA_0' }])
    const sellos = await prisma.orderItemSelloIva.findMany({ where: { cfdiId: f.id }, select: { orderItemId: true } })
    expect(sellos).toEqual([{ orderItemId: articulo(t, p0, 200).id }]) // el pan devuelto no se sella
  })

  it('🔴 decisión 2 (todo al 16 %, el caso de todos los días): una de dos piezas devuelta completa ⇒ la factura por la otra', async () => {
    const t = await venta([
      { productId: p16, precio: 116 },
      { productId: p16, precio: 58 },
    ])
    await refundItems(t, [{ productId: p16, precio: 116 }])
    expect((await facturar(t.id)).status).toBe('STAMPED')
    expect(provider.createInvoice.mock.calls[0][0].items.map((i: any) => i.unitPriceCents)).toEqual([5800])
    expect((await facturaDe(t.id)).totalCents).toBe(5800)
  })

  it('🔴 Ruling M7 (controlador): la torta devuelta por lo que se le asignó y queda el pan ⇒ factura por lo comercial del pan, con el 1 ¢ REGISTRADO', async () => {
    // El ticket M7 de C3: pan $65 − $2.50 + 2 tortas de $58 (un renglón de cantidad 2), al 16 %, cobrado $178.50.
    const t = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `F6-${randomUUID().slice(0, 8)}`,
        subtotal: 181,
        taxAmount: 0,
        discountAmount: 2.5,
        total: 178.5,
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        items: {
          create: [
            { productId: p16, productName: 'Pan', quantity: 1, unitPrice: 65, discountAmount: 2.5, taxAmount: 0, total: 65 },
            { productId: p16, productName: 'Torta', quantity: 2, unitPrice: 58, taxAmount: 0, total: 116 },
          ],
        },
        payments: {
          create: {
            venueId,
            merchantAccountId: fixture,
            amount: 178.5,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: 178.5,
            method: 'CREDIT_CARD',
            status: 'COMPLETED',
            createdAt: MAYO,
          },
        },
      },
      include: { items: true },
    })
    // Lo devuelto de la torta sale de la asignación de C2 sobre los conceptos reales del ticket (nunca a mano): 1 ¢ abajo de su precio.
    const tk = ticketParaGlobal(await prisma.order.findUniqueOrThrow({ where: { id: t.id }, select: ORDER_SELECT }))
    if (!tk.ok || !tk.orden.conceptosReales) throw new Error('el ticket M7 tiene sus conceptos reales')
    const asignado = asignacionDeReales(tk.orden.conceptosReales, tk.orden.porTratamiento, tk.orden.filasD16)!.montos.get(
      articulo(t, p16, 116).id,
    )!.totalCents
    const devuelto = Math.min(11600, asignado)
    expect(devuelto).toBe(11599) // el caso existe: cobrado − devuelto = 6251, el pan vale 6250
    const r = await refundItems(t, [{ productId: p16, precio: 116, amountCents: devuelto }])
    expect((await facturar(t.id)).status).toBe('STAMPED')
    const f = await facturaDe(t.id)
    expect(f.totalCents).toBe(6250)
    expect((f.entrada as any).devoluciones).toEqual({ modo: 'DESCONTADAS', pagos: [r.id], redondeoCents: 1 })
  })

  it('🔴 decisión 3 (por importe) y parte de un artículo: la factura por el TOTAL, con la marca de su nota', async () => {
    const t = await venta([
      { productId: p0, precio: 200 },
      { productId: p16, precio: 58 },
    ])
    const parte = await refundItems(t, [{ productId: p16, precio: 58, amountCents: 2900 }])
    const importe = await refundAmount(t, 50)
    expect((await facturar(t.id)).status).toBe('STAMPED')
    const f = await facturaDe(t.id)
    expect(f.totalCents).toBe(25800)
    expect((f.entrada as any).devoluciones).toEqual({ modo: 'CON_NOTA', pagos: [parte.id, importe.id] })
  })

  it('🔴 R1 · la mezcla con el IMPORTE ANTES que el artículo: la marca congela el ORDEN FISCAL (artículo primero), no el de llegada ni el id', async () => {
    const t = await venta([
      { productId: p0, precio: 200 },
      { productId: p16, precio: 58 },
    ])
    const importe = await refundAmount(t, 50)
    const pan = await refundItems(t, [{ productId: p16, precio: 58 }])
    expect((await facturar(t.id)).status).toBe('STAMPED')
    expect(((await facturaDe(t.id)).entrada as any).devoluciones).toEqual({ modo: 'CON_NOTA', pagos: [pan.id, importe.id] })
  })

  it('🔴 Review Focus 2 (R2): una devolución con artículos que no suman lo devuelto ⇒ se DETIENE antes de timbrar, con su motivo', async () => {
    const t = await venta([
      { productId: p0, precio: 200 },
      { productId: p16, precio: 58 },
    ])
    await prisma.payment.create({
      data: {
        venueId,
        orderId: t.id,
        type: 'REFUND',
        amount: -58,
        tipAmount: 0,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -58,
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        processorData: { refundedItems: [{ orderItemId: articulo(t, p16, 58).id, quantity: 1, amountCents: 4000 }] },
      },
    })
    expect(await facturar(t.id)).toMatchObject({
      status: 'VALIDATION_FAILED',
      reasons: expect.arrayContaining([motivoDevolucionIlegible(5800)]),
    })
    expect(provider.createInvoice).not.toHaveBeenCalled()
  })

  it.each([
    ['sólo propina', async (t: Venta) => refundAmount(t, 0, { propina: 10 })],
    ['PENDING', async (t: Venta) => refundAmount(t, 116, { status: 'PENDING' })],
    ['FAILED', async (t: Venta) => refundAmount(t, 116, { status: 'FAILED' })],
  ])('una devolución %s no cambia nada — la factura de hoy, sin marca', async (_c, devolver) => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await devolver(t)
    expect((await facturar(t.id)).status).toBe('STAMPED')
    const f = await facturaDe(t.id)
    expect(f.totalCents).toBe(11600)
    expect((f.entrada as any).devoluciones).toBeUndefined()
  })

  it('🔴 carrera: la devolución TOTAL que hace commit MIENTRAS «Facturar» espera el candado de la orden también se ve — 409, sin PAC ni fila', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    // 1. La devolución toma el `FOR UPDATE` de la orden (como `lockExistingOrderForPayment`), escribe su pago y se queda abierta.
    let soltar!: () => void
    const esperaSoltar = new Promise<void>(r => (soltar = r))
    let avisarTomado!: (pid: number) => void
    const tomado = new Promise<number>(r => (avisarTomado = r))
    const tx = prisma.$transaction(
      async db => {
        const [{ pid }] = await db.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        await db.$queryRaw`SELECT id FROM "Order" WHERE id = ${t.id} FOR UPDATE`
        await refundAmount(t, 116, {}, db)
        avisarTomado(pid)
        await esperaSoltar
      },
      { timeout: 30_000, maxWait: 10_000 },
    )
    try {
      const pidDevolucion = await tomado
      // 2. «Facturar» arranca y espera el candado: se comprueba que ALGUIEN quedó bloqueado POR la transacción de la devolución
      //    (`pg_blocking_pids`), no cualquier espera de la base (otras pruebas o sesiones).
      const enCurso = facturar(t.id).then(
        v => ({ ok: true as const, v }),
        e => ({ ok: false as const, e }),
      )
      let esperando = false
      for (let i = 0; i < 200 && !esperando; i++) {
        const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity a WHERE ${pidDevolucion}::int = ANY(pg_blocking_pids(a.pid))`
        esperando = n > 0
        if (!esperando) await new Promise(r => setTimeout(r, 25))
      }
      expect(esperando).toBe(true)
      // 3. La devolución hace commit; «Facturar» obtiene el candado, la ve y decide.
      soltar()
      await tx
      expect(await enCurso).toMatchObject({ ok: false, e: { message: MOTIVO_VENTA_DEVUELTA_COMPLETA, code: CODIGO_VENTA_DEVUELTA } })
      expect(provider.createInvoice).not.toHaveBeenCalled()
      expect(await prisma.cfdi.count({ where: { orderId: t.id } })).toBe(0)
    } finally {
      soltar() // nunca deja la transacción de la devolución abierta, aunque una aserción falle
      await tx.catch(() => undefined)
    }
  })

  // ─── Tarea 4: la guarda de la global ───────────────────────────────────────────────────────────────────────────────────────────────

  const laGlobal = async () => {
    const g = await issueGlobalForEmisor({ emisorId: fiscalEmisorId, now: NOW, sandbox: true })
    expect(g.status).toBe('STAMPED')
    return g.cfdi
  }

  it('🔴 R4: un ticket en la global con una devolución SIN su nota no se extrae — dice la salida; con la nota timbrada, C3 factura lo que quedó', async () => {
    const t = await ventaMezclada()
    const g = await laGlobal()
    const pan = await refundItems(t, [{ productId: p16, precio: 58 }])
    expect(await facturar(t.id)).toMatchObject({
      status: 'VALIDATION_FAILED',
      cfdi: null,
      reasons: [motivoDevolucionSinNotaEnLaGlobal({ n: 1, cents: 5800 })],
    })
    expect(await prisma.cfdi.count({ where: { orderId: t.id, type: 'EGRESO' } })).toBe(0)
    const nota = await emitRefundCreditNote({ venueId, refundPaymentId: pan.id, sandbox: true }) // la salida que ya existe (C2)
    expect((nota.cfdi.entrada as any).originalCfdiId).toBe(g.id)
    // N8: la MISMA nota relacionada con otra factura no cuenta (quitar el filtro por `originalCfdiId` tumba esta aserción).
    const entrada = nota.cfdi.entrada as object
    await prisma.cfdi.update({ where: { id: nota.cfdi.id }, data: { entrada: { ...entrada, originalCfdiId: 'otra-factura' } } })
    expect(await facturar(t.id)).toMatchObject({
      status: 'VALIDATION_FAILED',
      reasons: [motivoDevolucionSinNotaEnLaGlobal({ n: 1, cents: 5800 })],
    })
    await prisma.cfdi.update({ where: { id: nota.cfdi.id }, data: { entrada } })
    expect((await facturar(t.id)).status).toBe('STAMPED') // extracción por $200 y factura del cliente con el café (decisión 2, por C3)
    expect((await facturaDe(t.id)).totalCents).toBe(20000)
  })

  // Codex código r1 (P3-4): con una devolución POR IMPORTE, emitir la nota no basta: C3 sigue sin poder comprobar qué productos quedaron
  // (C3-P6 ⇒ contador). El texto ya no promete «vuelve a facturar».
  it('🔴 P3-4: un ticket en la global con una devolución POR IMPORTE sin su nota ⇒ el texto dice «con tu contador», y con la nota timbrada C3 la sigue deteniendo', async () => {
    const t = await ventaMezclada()
    await laGlobal()
    const d = await refundAmount(t, 50)
    const r = await facturar(t.id)
    expect(r).toMatchObject({
      status: 'VALIDATION_FAILED',
      cfdi: null,
      reasons: [motivoDevolucionSinNotaEnLaGlobal({ n: 1, cents: 5000, porImporte: true })],
    })
    expect(r.reasons![0]).toMatch(/por importe \(sin artículos\).*con tu contador\.$/)
    expect((await emitRefundCreditNote({ venueId, refundPaymentId: d.id, sandbox: true })).status).toBe('STAMPED')
    expect(await facturar(t.id)).toMatchObject({
      status: 'VALIDATION_FAILED',
      reasons: expect.arrayContaining([MOTIVO_REMANENTE_NO_TRAZABLE]),
    })
    expect(provider.createInvoice).not.toHaveBeenCalled()
  })

  // Ruling CX-6: un AJUSTE DE ENTREGA (reparto por tasa, sin artículos) tampoco deja comprobar qué productos quedaron: el mismo texto.
  it('🔴 CX-6: un ticket en la global con un AJUSTE DE ENTREGA sin su nota ⇒ el texto del contador, sin «vuelve a facturar»', async () => {
    const t = await ventaMezclada()
    await laGlobal()
    await prisma.payment.create({
      data: {
        venueId,
        orderId: t.id,
        type: 'REFUND',
        amount: -50,
        tipAmount: 0,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -50,
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        processorData: {
          provenance: 'PROVIDER_ADJUSTMENT',
          fiscalByRateCents: { v: 2, porTratamiento: { IVA_16: { baseCents: 4310, ivaCents: 690 } } },
        },
      },
    })
    const r = await facturar(t.id)
    expect(r).toMatchObject({ status: 'VALIDATION_FAILED', cfdi: null })
    expect(r.reasons).toEqual([motivoDevolucionSinNotaEnLaGlobal({ n: 1, cents: 5000, porImporte: true })])
    expect(r.reasons![0]).toMatch(/con tu contador\.$/)
    expect(r.reasons![0]).not.toMatch(/vuelve a facturar/)
    expect(await prisma.cfdi.count({ where: { orderId: t.id } })).toBe(0)
  })

  it('🔴 R4 · R2 (ruling T4-1): un ticket en la global con una devolución ILEGIBLE ⇒ el motivo de R2 (su nota nunca saldría), 0 extracciones', async () => {
    const t = await ventaMezclada()
    await laGlobal()
    await prisma.payment.create({
      data: {
        venueId,
        orderId: t.id,
        type: 'REFUND',
        amount: -58,
        tipAmount: 0,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -58,
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        processorData: { refundedItems: [{ orderItemId: articulo(t, p16, 58).id, quantity: 1, amountCents: 4000 }] },
      },
    })
    expect(await facturar(t.id)).toMatchObject({ status: 'VALIDATION_FAILED', cfdi: null, reasons: [motivoDevolucionIlegible(5800)] })
    expect(provider.createCreditNote).not.toHaveBeenCalled()
    expect(await prisma.cfdi.count({ where: { orderId: t.id, idempotencyKey: { startsWith: 'cfdi-extraccion-' } } })).toBe(0)
  })

  it('🔴 R4 bajo el candado: la devolución que llega ENTRE la comprobación previa y la reserva también detiene la extracción — sin fila', async () => {
    const t = await ventaMezclada()
    await laGlobal()
    const r = await facturar(t.id, {
      despuesDeLaComprobacionPrevia: async () => void (await refundItems(t, [{ productId: p16, precio: 58 }])),
    })
    expect(r).toMatchObject({
      status: 'VALIDATION_FAILED',
      cfdi: null,
      reasons: [motivoDevolucionSinNotaEnLaGlobal({ n: 1, cents: 5800 })],
    })
    expect(provider.createCreditNote).not.toHaveBeenCalled()
    expect(await prisma.cfdi.count({ where: { orderId: t.id } })).toBe(0)
  })

  it('🔴 N1: una nota reservada o en duda NO basta — tampoco si después se rechaza; sólo la timbrada contra la global deja extraer', async () => {
    const t = await ventaMezclada()
    await laGlobal()
    const pan = await refundItems(t, [{ productId: p16, precio: 58 }])
    provider.createCreditNote.mockRejectedValueOnce(new TypeError('fetch failed')) // error de red ⇒ nota en duda (viva, sin timbre)
    await emitRefundCreditNote({ venueId, refundPaymentId: pan.id, sandbox: true }).catch(() => undefined)
    const sinNota = { status: 'VALIDATION_FAILED', reasons: [motivoDevolucionSinNotaEnLaGlobal({ n: 1, cents: 5800 })] }
    expect(await facturar(t.id)).toMatchObject(sinNota)
    await prisma.cfdi.update({ where: { idempotencyKey: `cfdi-refund-${pan.id}` }, data: { falloDefinitivo: true } }) // el PAC la rechazó
    expect(await facturar(t.id)).toMatchObject(sinNota)
    expect(await prisma.cfdi.count({ where: { orderId: t.id, idempotencyKey: { startsWith: 'cfdi-extraccion-' } } })).toBe(0)
    expect((await emitRefundCreditNote({ venueId, refundPaymentId: pan.id, sandbox: true })).status).toBe('STAMPED') // recapturada y timbrada
    expect((await facturar(t.id)).status).toBe('STAMPED')
    expect((await facturaDe(t.id)).totalCents).toBe(20000)
  })

  it('🔴 N2: el proceso murió entre RESERVAR la extracción y enviarla, y luego hubo una devolución ⇒ se RETOMA la extracción (no se traba), y la devolución va después contra la factura del cliente', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const g = await laGlobal()
    await expect(
      emitirExtraccion(
        { venueId, orderId: t.id, sandbox: true, staffId: null, comprobarNominativa: async () => [] },
        { antesDeEnviar: async () => Promise.reject(new Error('el proceso murió')) },
      ),
    ).rejects.toThrow('el proceso murió')
    const devolucion = await refundAmount(t, 50)
    // C2 no admite la nota contra la global de un ticket con su extracción viva (C3 T5) …
    await expect(emitRefundCreditNote({ venueId, refundPaymentId: devolucion.id, sandbox: true })).rejects.toThrow()
    // … y F6 no la exige al retomar: la extracción reservada sale con las protecciones de C3 y la factura del cliente también.
    expect((await facturar(t.id)).status).toBe('STAMPED')
    expect(await prisma.cfdi.count({ where: { orderId: t.id, idempotencyKey: { startsWith: `cfdi-extraccion-${g.id}` } } })).toBe(1)
    const cliente = await facturaDe(t.id)
    const nota = await emitRefundCreditNote({ venueId, refundPaymentId: devolucion.id, sandbox: true })
    expect(nota.status).toBe('STAMPED')
    expect((nota.cfdi.entrada as any).originalCfdiId).toBe(cliente.id) // se acredita contra la nominativa
  })

  // ─── Tarea 5: las guardas de la nota ───────────────────────────────────────────────────────────────────────────────────────────────

  it('🔴 Review Focus 4: el reembolso que la factura ya descontó no lleva nota — ni por artículos, ni «por importe» (panel y MCP usan este servicio)', async () => {
    const t = await ventaMezclada()
    const r1 = await refundItems(t, [{ productId: p16, precio: 58 }])
    expect((await facturar(t.id)).status).toBe('STAMPED')
    const st = await getRefundCreditNoteStatus(venueId, r1.id)
    expect(st!.eligibility).toEqual({ eligible: false, reason: 'DESCONTADA_EN_LA_FACTURA', message: MOTIVO_DESCONTADA_EN_LA_FACTURA })
    expect((st!.preview as any)?.alternativa).toBeFalsy()
    await expect(emitRefundCreditNote({ venueId, refundPaymentId: r1.id, sandbox: true })).rejects.toThrow(MOTIVO_DESCONTADA_EN_LA_FACTURA)
    await expect(
      emitRefundCreditNote({ venueId, refundPaymentId: r1.id, sandbox: true, modalidad: 'POR_IMPORTE', huellaDelReparto: 'h' }),
    ).rejects.toThrow(MOTIVO_DESCONTADA_EN_LA_FACTURA)
    expect(provider.createCreditNote).not.toHaveBeenCalled()
    const despues = await refundItems(t, [{ productId: p0, precio: 200 }]) // control: una POSTERIOR del café va contra la factura neta
    expect((await emitRefundCreditNote({ venueId, refundPaymentId: despues.id, sandbox: true })).status).toBe('STAMPED')
  })

  it('🔴 H1: «acreditar por importe» (P10) antes de una nota fija pendiente — ni la vista previa la ofrece ni la reserva la deja pasar (bajo el candado)', async () => {
    const t = await ventaMezclada()
    const importe = await refundAmount(t, 50)
    const pan = await refundItems(t, [{ productId: p16, precio: 58 }])
    expect((await facturar(t.id, sinNotas())).status).toBe('STAMPED') // las notas automáticas fallan ⇒ las dos quedan pendientes
    // Una devolución POSTERIOR de un artículo que la factura no registra: por artículos le falta evidencia ⇒ sólo P10 (proporcional).
    const p10 = await refundAmount(t, 30)
    await prisma.payment.update({
      where: { id: p10.id },
      data: { processorData: { refundedItems: [{ orderItemId: 'fuera-de-la-factura', quantity: 1, amountCents: 3000 }] } },
    })
    const espera = motivoEsperaNotaDeArticulos(5800)
    const vista = (await getRefundCreditNoteStatus(venueId, p10.id))!
    expect((vista.preview as any)?.alternativa).toBeFalsy()
    expect(vista.eligibility.message).toContain(espera)
    // La reserva relee BAJO el candado de la orden: aunque la lectura de afuera no viera la dependencia, adentro se detiene.
    const real = notas.loadRefundForCreditNoteFromDb
    const sinDependenciasAfuera: typeof real = async (v, r, tx, ex) => {
      const l = await real(v, r, tx, ex)
      return l && !tx ? { ...l, notasFijasPendientes: undefined } : l
    }
    await expect(
      emitRefundCreditNote(
        { venueId, refundPaymentId: p10.id, sandbox: true, modalidad: 'POR_IMPORTE', huellaDelReparto: 'h' },
        { loadRefundForCreditNote: sinDependenciasAfuera },
      ),
    ).rejects.toThrow(espera)
    expect(provider.createCreditNote).not.toHaveBeenCalled()
    // Con la del pan timbrada, P10 ya se ofrece (y la de importe de la marca también sale).
    expect((await emitRefundCreditNote({ venueId, refundPaymentId: pan.id, sandbox: true })).status).toBe('STAMPED')
    expect((await getRefundCreditNoteStatus(venueId, p10.id))!.preview?.alternativa).toBeTruthy()
    expect((await emitRefundCreditNote({ venueId, refundPaymentId: importe.id, sandbox: true })).status).toBe('STAMPED')
  })

  // ─── Tarea 6: las notas salen solas al timbrar ─────────────────────────────────────────────────────────────────────────────────────

  /** Sondea cada 20 ms hasta 5 s (como C3). */
  async function esperarHasta(fn: () => Promise<boolean>) {
    for (let i = 0; i < 250; i++) {
      if (await fn()) return
      await new Promise(r => setTimeout(r, 20))
    }
    throw new Error('esperarHasta: no se cumplió en 5 s')
  }

  it('🔴 decisión 3: por importe ⇒ la factura por el total y la nota de esa devolución, emitida sola contra ella', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const r1 = await refundAmount(t, 50)
    const r = await facturar(t.id)
    expect(r.status).toBe('STAMPED')
    expect(r.notasDeDevolucion).toEqual([{ refundPaymentId: r1.id, status: 'STAMPED', folio: expect.any(String) }])
    const n = await notaDe(r1.id)
    expect(n).toMatchObject({ status: 'STAMPED', type: 'EGRESO', totalCents: 5000 })
    expect((n!.entrada as any).originalCfdiId).toBe(r.cfdi.id)
  })

  it.each([
    ['🔴 Review Focus 1: el IMPORTE ocurrió ANTES que el artículo', 'importe-primero'],
    ['control: el artículo ocurrió primero', 'articulo-primero'],
  ])('R1 · la mezcla (%s) ⇒ las dos notas salen, la del artículo primero', async (_c, orden) => {
    const t = await ventaMezclada()
    let importe: { id: string }
    let pan: { id: string }
    if (orden === 'importe-primero') {
      importe = await refundAmount(t, 50)
      pan = await refundItems(t, [{ productId: p16, precio: 58 }])
    } else {
      pan = await refundItems(t, [{ productId: p16, precio: 58 }])
      importe = await refundAmount(t, 50)
    }
    const r = await facturar(t.id)
    expect(r.notasDeDevolucion?.map(x => [x.refundPaymentId, x.status])).toEqual([
      [pan.id, 'STAMPED'],
      [importe.id, 'STAMPED'],
    ])
    expect([(await notaDe(pan.id))!.totalCents, ((await notaDe(pan.id))!.entrada as any).modalidad]).toEqual([5800, 'POR_ARTICULOS'])
    expect([(await notaDe(importe.id))!.totalCents, ((await notaDe(importe.id))!.entrada as any).modalidad]).toEqual([5000, 'POR_IMPORTE'])
  })

  it('🔴 R1 · se rechaza la nota del artículo ⇒ la de importe NO sale (espera), y lo dicen las dos', async () => {
    const t = await ventaMezclada()
    const importe = await refundAmount(t, 50)
    const pan = await refundItems(t, [{ productId: p16, precio: 58 }])
    provider.createCreditNote.mockRejectedValueOnce(
      new ProviderHttpError(422, 'invoice_stamping_validation_error', 'el SAT rechazó la nota'),
    )
    const r = await facturar(t.id)
    expect(r.status).toBe('STAMPED')
    expect(r.notasDeDevolucion).toEqual([
      { refundPaymentId: pan.id, status: 'PENDIENTE', motivo: expect.any(String) },
      { refundPaymentId: importe.id, status: 'PENDIENTE', motivo: motivoEsperaNotaDeArticulos(5800) },
    ])
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })

  it('🔴 R1/N3 · emisión MANUAL: la de importe de la marca y una devolución POSTERIOR por importe esperan a la del artículo', async () => {
    const t = await ventaMezclada()
    const importe = await refundAmount(t, 50)
    await refundItems(t, [{ productId: p16, precio: 58 }])
    expect((await facturar(t.id, sinNotas())).status).toBe('STAMPED')
    const posterior = await refundAmount(t, 30) // no está en la marca: es manual, y tampoco se adelanta (N3)
    for (const id of [importe.id, posterior.id])
      await expect(emitRefundCreditNote({ venueId, refundPaymentId: id, sandbox: true })).rejects.toThrow(motivoEsperaNotaDeArticulos(5800))
    expect(provider.createCreditNote).not.toHaveBeenCalled()
  })

  it('🔴 N8 · carrera real: con la nota del artículo EN VUELO (reservada y enviada), la de importe ya puede salir y se reparte sobre lo que QUEDA', async () => {
    const t = await ventaMezclada()
    const importe = await refundAmount(t, 50)
    const pan = await refundItems(t, [{ productId: p16, precio: 58 }])
    expect((await facturar(t.id, sinNotas())).status).toBe('STAMPED')
    let soltar!: () => void
    const pausa = new Promise<void>(r => (soltar = r))
    provider.createCreditNote.mockImplementationOnce(async () => {
      await pausa // el PAC de la nota del pan no contesta todavía: su fila ya está reservada y enviada (viva)
      return valid()
    })
    const delPan = emitRefundCreditNote({ venueId, refundPaymentId: pan.id, sandbox: true })
    try {
      await esperarHasta(async () => !!(await notaDe(pan.id))?.enviadoAt)
      const r = await emitRefundCreditNote({ venueId, refundPaymentId: importe.id, sandbox: true })
      expect(r.status).toBe('STAMPED')
      expect(Object.keys((r.cfdi.entrada as any).porTratamiento)).toEqual(['IVA_0']) // el tramo al 16 % ya lo tomó el pan
    } finally {
      soltar()
    }
    expect((await delPan).status).toBe('STAMPED')
  })

  it('🔴 Review Focus 3 (R3): se cancelan la nota y la factura y se vuelve a facturar ⇒ se DETIENE con el folio de la nota cancelada, sin otro ingreso', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const r1 = await refundAmount(t, 50)
    const r = await facturar(t.id)
    const nota = (await notaDe(r1.id))!
    expect(nota.status).toBe('STAMPED')
    // Como lo deja la cancelación confirmada: primero la nota, después la factura (la guarda de documentos relacionados lo exige).
    await prisma.cfdi.update({ where: { id: nota.id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    await prisma.cfdi.update({ where: { id: r.cfdi.id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    expect(await facturar(t.id)).toMatchObject({
      status: 'VALIDATION_FAILED',
      reasons: expect.arrayContaining([motivoNotaCancelada(folioDe(nota))]),
    })
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
  })

  it('🔴 duda (b): IVA aparte con devolución por artículos ⇒ factura por el total (IVA aparte) y la nota del artículo con su base, su IVA y su relación', async () => {
    const t = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `F6-${randomUUID().slice(0, 8)}`,
        subtotal: 150,
        taxAmount: 24,
        total: 174,
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_APARTE',
        items: {
          create: [
            // Con IVA aparte el renglón guarda precio × cantidad SIN el IVA (`total`) y el IVA en `taxAmount` (como la terminal; el cargador
            // exige `total` = precio × cantidad + extras).
            { productId: p16, productName: 'Producto', quantity: 1, unitPrice: 100, taxAmount: 16, total: 100 },
            { productId: p16, productName: 'Producto', quantity: 1, unitPrice: 50, taxAmount: 8, total: 50 },
          ],
        },
        payments: {
          create: {
            venueId,
            merchantAccountId: fixture,
            amount: 174,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: 174,
            method: 'CREDIT_CARD',
            status: 'COMPLETED',
            createdAt: MAYO,
          },
        },
      },
      include: { items: true },
    })
    const devolucion = await refundItems(t, [{ productId: p16, precio: 100, amountCents: 11600 }]) // lo que el cliente pagó por él: $116
    const r = await facturar(t.id)
    expect(r.status).toBe('STAMPED')
    expect((await facturaDe(t.id)).totalCents).toBe(17400)
    expect(r.notasDeDevolucion).toEqual([{ refundPaymentId: devolucion.id, status: 'STAMPED', folio: expect.any(String) }])
    const e = (await notaDe(devolucion.id))!.entrada as any
    expect(e.originalCfdiId).toBe(r.cfdi.id)
    expect(e.modalidad).toBe('POR_ARTICULOS')
    expect(e.porTratamiento.IVA_16).toEqual({ baseCents: 10000, ivaCents: 1600, totalCents: 11600 })
  })

  it('🔴 la nota falla DESPUÉS de timbrar ⇒ la factura se queda, la nota sale PENDIENTE, y volver a «Facturar» no timbra otra factura ni otra nota', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const r1 = await refundAmount(t, 50)
    provider.createCreditNote.mockRejectedValueOnce(
      new ProviderHttpError(422, 'invoice_stamping_validation_error', 'el SAT rechazó la nota'),
    )
    const r = await facturar(t.id)
    expect(r.status).toBe('STAMPED')
    expect(r.notasDeDevolucion).toEqual([{ refundPaymentId: r1.id, status: 'PENDIENTE', motivo: expect.any(String) }])
    const otra = await facturar(t.id)
    expect(otra).toMatchObject({ status: 'STAMPED', alreadyIssued: true })
    expect(otra.notasDeDevolucion).toBeUndefined() // reintentarla es del job (Tarea 7), no del botón
    // La carrera de dos clics: la segunda petición leyó ANTES de que la primera timbrara (ni factura de la venta ni fila con su llave) y la
    // encuentra timbrada ya dentro de la reserva ⇒ tampoco emite notas (`!r.alreadyIssued`; la «otra» de arriba sale antes, por la venta).
    const carrera = await facturar(t.id, { findOrderInvoices: async () => [], findExistingCfdi: async () => null })
    expect(carrera).toMatchObject({ status: 'STAMPED', alreadyIssued: true })
    expect(carrera.notasDeDevolucion).toBeUndefined()
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })

  it('una devolución que entra ENTRE la reserva y el timbre no recibe nota automática: es de una venta ya facturada (nota manual, como hoy)', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    let tarde: { id: string } | undefined
    provider.createInvoice.mockImplementationOnce(async () => {
      tarde = await refundAmount(t, 30)
      return valid()
    })
    const r = await facturar(t.id)
    expect(r.status).toBe('STAMPED')
    expect(r.notasDeDevolucion).toBeUndefined()
    expect(((await facturaDe(t.id)).entrada as any).devoluciones).toBeUndefined()
    expect(provider.createCreditNote).not.toHaveBeenCalled()
    expect((await getRefundCreditNoteStatus(venueId, tarde!.id))!.eligibility.eligible).toBe(true)
  })

  // Ruling T4-b (llevado a la T6): la guarda de la global con la nota de esa devolución YA cancelada dice el texto de R3, no «emítela».
  it('🔴 Tarea 6 · R3 en la global: la nota de la devolución contra la global se CANCELÓ ⇒ el texto de R3 (su llave no admite otra), sin extraer', async () => {
    const t = await ventaMezclada()
    await laGlobal()
    const pan = await refundItems(t, [{ productId: p16, precio: 58 }])
    const nota = await emitRefundCreditNote({ venueId, refundPaymentId: pan.id, sandbox: true })
    expect(nota.status).toBe('STAMPED')
    await prisma.cfdi.update({ where: { id: nota.cfdi.id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    expect(await facturar(t.id)).toMatchObject({
      status: 'VALIDATION_FAILED',
      cfdi: null,
      reasons: [motivoNotaCancelada(folioDe(nota.cfdi))],
    })
    expect(await prisma.cfdi.count({ where: { orderId: t.id, idempotencyKey: { startsWith: 'cfdi-extraccion-' } } })).toBe(0)
  })

  // T4 minor (llevado a la T6): la cláusula de cancelación de N1 (`cancelStatus` nulo o REJECTED) con la nota YA timbrada contra la global.
  it('🔴 Tarea 6 · N1 con la nota timbrada contra la global: su cancelación EN TRÁMITE la sigue deteniendo; RECHAZADA deja extraer', async () => {
    const t = await ventaMezclada()
    await laGlobal()
    const pan = await refundItems(t, [{ productId: p16, precio: 58 }])
    const nota = await emitRefundCreditNote({ venueId, refundPaymentId: pan.id, sandbox: true })
    expect(nota.status).toBe('STAMPED')
    await prisma.cfdi.update({ where: { id: nota.cfdi.id }, data: { cancelStatus: 'REQUESTED' } })
    expect(await facturar(t.id)).toMatchObject({
      status: 'VALIDATION_FAILED',
      cfdi: null,
      reasons: [motivoDevolucionSinNotaEnLaGlobal({ n: 1, cents: 5800 })],
    })
    expect(await prisma.cfdi.count({ where: { orderId: t.id, idempotencyKey: { startsWith: 'cfdi-extraccion-' } } })).toBe(0)
    await prisma.cfdi.update({ where: { id: nota.cfdi.id }, data: { cancelStatus: 'REJECTED' } })
    expect((await facturar(t.id)).status).toBe('STAMPED')
    expect((await facturaDe(t.id)).totalCents).toBe(20000)
  })

  // ─── Tarea 7: el job barre las notas que faltan ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Una pasada REAL del job sin salir a la red: cancelaciones, atorados y archivos apagados con espías ENTRE módulos (como C3). El logger está
   * simulado en la integración, así que «ningún `tick failed`» se comprueba aquí (una consulta de la pasada que truena cae ahí, no en la prueba).
   */
  async function pasadaDelJob(job = new CfdiReconcileJob()) {
    const espias = [
      jest.spyOn(cfdiService, 'tocaRevisarCancelaciones').mockReturnValue(false),
      jest.spyOn(reconcileService, 'reconcileStuckCfdi').mockResolvedValue({ outcome: 'SKIPPED' } as never),
      jest.spyOn(finalizadorCfdi, 'repararArchivosCompartido').mockResolvedValue('OK' as never),
    ]
    try {
      await job.runNow()
    } finally {
      espias.forEach(e => e.mockRestore())
    }
    expect(logger.error).not.toHaveBeenCalledWith('[cfdiReconcile] tick failed (top-level)', expect.anything())
  }
  const haceOnceMinutos = () => new Date(Date.now() - 11 * 60_000)
  const envejecer = (cfdiId: string) => prisma.cfdi.update({ where: { id: cfdiId }, data: { stampedAt: haceOnceMinutos() } })
  /** Ruling CX-1: el rechazo definitivo de estas notas fue hace 61 min (`updatedAt` es UTC sin zona; por SQL, Prisma lo pisaría). */
  const rechazadasHaceMasDeUnaHora = (...refundIds: string[]) =>
    prisma.$executeRaw`UPDATE "Cfdi" SET "updatedAt" = (now() AT TIME ZONE 'UTC') - interval '61 minutes'
      WHERE "idempotencyKey" = ANY(${refundIds.map(id => `cfdi-refund-${id}`)})`

  it('🔴 el proceso murió entre el timbre y la nota y NADIE vuelve a facturar ⇒ la pasada la emite contra la factura, una vez', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const r1 = await refundAmount(t, 50)
    const r = await facturar(t.id, sinNotas())
    // Ruling T6-d: el error interno («el proceso murió», un `Error` suelto) no llega a la pantalla: el texto de siempre (el crudo, al log).
    expect(r.notasDeDevolucion).toEqual([{ refundPaymentId: r1.id, status: 'PENDIENTE', motivo: MOTIVO_NOTA_PENDIENTE }])
    await envejecer(r.cfdi.id)
    await pasadaDelJob()
    const n = await notaDe(r1.id)
    expect(n).toMatchObject({ status: 'STAMPED', totalCents: 5000 })
    expect((n!.entrada as any).originalCfdiId).toBe(r.cfdi.id)
    await pasadaDelJob()
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })

  // Revisión T6 (⚠️ ⇒ T7): el barrido no depende de QUIÉN confirmó el timbre de la factura. Una factura cuyo envío quedó en duda y que después
  // confirmó la conciliación de siempre nunca pasó por el gancho de `issueCfdiForOrder`: sus notas las emite la pasada.
  it('🔴 la factura quedó EN DUDA y la confirmó la conciliación (nunca pasó por el gancho de «Facturar») ⇒ la pasada emite su nota', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const r1 = await refundAmount(t, 50)
    provider.createInvoice.mockRejectedValueOnce(new TypeError('fetch failed')) // error de red ⇒ la factura queda enviada e incierta
    const r = await facturar(t.id).catch((e: unknown) => e)
    expect((r as { notasDeDevolucion?: unknown }).notasDeDevolucion).toBeUndefined()
    const enDuda = await facturaDe(t.id)
    expect(enDuda).toMatchObject({ status: 'STAMP_FAILED', falloDefinitivo: false, enviadoAt: expect.any(Date) })
    expect((enDuda.entrada as any).devoluciones).toEqual({ modo: 'CON_NOTA', pagos: [r1.id] })
    provider.findByExternalId.mockResolvedValueOnce(valid()) // el PAC sí la timbró
    expect((await reconcileService.reconcileStuckCfdi({ cfdi: enDuda as any, now: new Date(), sandbox: true })).outcome).toBe('COMPLETED')
    expect((await facturaDe(t.id)).status).toBe('STAMPED')
    expect(provider.createCreditNote).not.toHaveBeenCalled() // nadie emitió la nota al confirmarla
    await envejecer(enDuda.id)
    await pasadaDelJob()
    const n = await notaDe(r1.id)
    expect(n).toMatchObject({ status: 'STAMPED', totalCents: 5000 })
    expect((n!.entrada as any).originalCfdiId).toBe(enDuda.id)
  })

  it('🔴 H2: una nota ENVIADA y en duda no la reintenta la pasada de F6 (es de la conciliación de siempre), no le cierra el paso a otra independiente y sigue a la vista', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const enDuda = await refundAmount(t, 50)
    const otra = await refundAmount(t, 30)
    const r = await facturar(t.id, sinNotas())
    provider.createCreditNote.mockRejectedValueOnce(new TypeError('fetch failed')) // error de red ⇒ enviada e incierta (C3-5)
    await emitRefundCreditNote({ venueId, refundPaymentId: enDuda.id, sandbox: true }).catch(() => undefined)
    expect(await notaDe(enDuda.id)).toMatchObject({ falloDefinitivo: false, enviadoAt: expect.any(Date) })
    provider.createCreditNote.mockClear()
    provider.findByExternalId.mockImplementation(() => new Promise(() => undefined)) // si F6 la consultara, se comería todo el presupuesto
    await envejecer(r.cfdi.id)
    await pasadaDelJob()
    await pasadaDelJob()
    expect((await notaDe(otra.id))!.status).toBe('STAMPED')
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1) // sólo la otra; la de duda nunca se vuelve a mandar
    expect(provider.findByExternalId).not.toHaveBeenCalled() // su identidad la consulta `reconcileStuckCfdi` (aquí apagado), no F6
    expect((await facturasConNotasPendientes({ cfdiIds: [r.cfdi.id], limite: 5 }))[0].pendientes).toEqual([enDuda.id]) // sigue a la vista
  })

  it('🔴 R4-2: una nota RECHAZADA en definitiva (sin identidad del PAC) se recaptura sin consultar al PAC, y otra independiente sale igual', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const rechazada = await refundAmount(t, 50)
    const otra = await refundAmount(t, 30)
    const r = await facturar(t.id, sinNotas())
    provider.createCreditNote.mockRejectedValueOnce(
      new ProviderHttpError(422, 'invoice_stamping_validation_error', 'el SAT rechazó la nota'),
    )
    await emitRefundCreditNote({ venueId, refundPaymentId: rechazada.id, sandbox: true }).catch(() => undefined)
    expect(await notaDe(rechazada.id)).toMatchObject({ status: 'STAMP_FAILED', falloDefinitivo: true, facturapiId: null })
    provider.createCreditNote.mockClear()
    provider.findByExternalId.mockImplementation(() => new Promise(() => undefined)) // una consulta suspendida se comería todo el presupuesto
    await envejecer(r.cfdi.id)
    await rechazadasHaceMasDeUnaHora(rechazada.id) // Ruling CX-1: antes de la hora se pospone (lo prueba «CX-1»)
    await pasadaDelJob()
    await pasadaDelJob()
    expect((await notaDe(otra.id))!.status).toBe('STAMPED')
    expect((await notaDe(rechazada.id))!.status).toBe('STAMPED') // recapturada por la vía protegida: otro intento, que el PAC ya acepta
    expect(provider.findByExternalId).not.toHaveBeenCalled()
  })

  // Codex código r1 (P2-1, Ruling CX-1): cada pasada empezaba por las mismas notas con rechazo definitivo; si sus reintentos se comían el
  // presupuesto, una nota independiente posterior de la MISMA factura nunca se intentaba. Cada rechazo «tarda» 20 s de reloj (presupuesto: 30 s).
  it('🔴 CX-1: dos rechazos DEFINITIVOS y lentos no le cierran el paso a una 3.ª nota independiente — se posponen 1 h (siguen a la vista) y después se reintentan', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const a = await refundAmount(t, 10)
    const b = await refundAmount(t, 20)
    const c = await refundAmount(t, 30)
    const r = await facturar(t.id, sinNotas())
    const ahoraReal = Date.now
    let adelanto = 0
    jest.spyOn(Date, 'now').mockImplementation(() => ahoraReal() + adelanto)
    provider.createCreditNote.mockImplementation(async (p: { externalId: string }) => {
      if (p.externalId.startsWith(`cfdi-refund-${c.id}#`)) return valid()
      adelanto += 20_000
      throw new ProviderHttpError(422, 'invoice_stamping_validation_error', 'el SAT rechazó la nota')
    })
    const intentos = () =>
      [a, b, c].map(
        x => provider.createCreditNote.mock.calls.filter(([p]) => String(p.externalId).startsWith(`cfdi-refund-${x.id}#`)).length,
      )
    await envejecer(r.cfdi.id)
    const job = new CfdiReconcileJob()
    await pasadaDelJob(job) // a y b se rechazan y se comen el presupuesto: c no alcanza
    expect(intentos()).toEqual([1, 1, 0])
    await pasadaDelJob(job)
    await pasadaDelJob(job)
    expect(intentos()).toEqual([1, 1, 1]) // a y b, pospuestas; c sí se intenta
    expect((await notaDe(c.id))!.status).toBe('STAMPED')
    expect((await facturasConNotasPendientes({ cfdiIds: [r.cfdi.id], limite: 5 }))[0].pendientes).toEqual([a.id, b.id]) // siguen a la vista
    await rechazadasHaceMasDeUnaHora(a.id, b.id)
    await pasadaDelJob(job)
    expect(intentos()).toEqual([2, 2, 1]) // pasada la hora, se reintentan solas (decisión A)
  })

  it('🔴 R1 en el job: la nota del artículo se rechazó al facturar ⇒ la pasada emite el artículo y DESPUÉS el importe', async () => {
    const t = await ventaMezclada()
    const importe = await refundAmount(t, 50)
    const pan = await refundItems(t, [{ productId: p16, precio: 58 }])
    provider.createCreditNote.mockRejectedValueOnce(
      new ProviderHttpError(422, 'invoice_stamping_validation_error', 'el SAT rechazó la nota'),
    )
    const r = await facturar(t.id)
    await envejecer(r.cfdi.id)
    await pasadaDelJob() // Ruling CX-1: el artículo, rechazado hace segundos, se pospone; el importe lo sigue esperando (nunca sale antes)
    expect((await notaDe(importe.id))?.status).not.toBe('STAMPED')
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    await rechazadasHaceMasDeUnaHora(pan.id)
    await pasadaDelJob()
    expect((await notaDe(pan.id))!.status).toBe('STAMPED')
    expect((await notaDe(importe.id))!.status).toBe('STAMPED')
    const [, segunda, tercera] = provider.createCreditNote.mock.calls.map(c => c[0].externalId as string)
    expect([segunda.startsWith(`cfdi-refund-${pan.id}`), tercera.startsWith(`cfdi-refund-${importe.id}`)]).toEqual([true, true])
  })

  it('el job no le gana al pedido del usuario (timbrada hace < 10 min)', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await refundAmount(t, 50)
    await facturar(t.id, sinNotas())
    await pasadaDelJob()
    expect(provider.createCreditNote).not.toHaveBeenCalled()
  })

  it('🔴 N8 · páginas con la MISMA instancia del job: la 1.ª página sigue pendiente (rechazada) y aun así la 2.ª se alcanza', async () => {
    const reembolsoDe = new Map<string, string>()
    for (let i = 0; i < 21; i++) {
      const t = await venta([{ productId: p16, precio: 116 }])
      const d = await refundAmount(t, 10)
      reembolsoDe.set((await facturar(t.id, sinNotas())).cfdi.id, d.id)
    }
    const ids = [...reembolsoDe.keys()]
    await prisma.cfdi.updateMany({ where: { id: { in: ids } }, data: { stampedAt: haceOnceMinutos() } })
    const [{ id: ultima }] = await prisma.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM "Cfdi" WHERE id = ANY(${ids}) ORDER BY id DESC LIMIT 1`
    provider.createCreditNote.mockRejectedValue(new ProviderHttpError(422, 'invoice_stamping_validation_error', 'rechazada'))
    const job = new CfdiReconcileJob()
    await pasadaDelJob(job) // las 20 de la 1.ª página se intentan y se rechazan: siguen pendientes
    expect(provider.createCreditNote).toHaveBeenCalledTimes(20)
    // Ruling CX-1: sin esto la 1.ª página quedaría pospuesta una hora y la pasada siguiente no probaría el cursor.
    await rechazadasHaceMasDeUnaHora(...ids.map(id => reembolsoDe.get(id)!))
    provider.createCreditNote.mockImplementation(async () => valid())
    await pasadaDelJob(job) // el cursor sigue DESPUÉS de la 1.ª página: sólo la última
    expect(provider.createCreditNote).toHaveBeenCalledTimes(21)
    expect((await notaDe(reembolsoDe.get(ultima)!))!.status).toBe('STAMPED')
    const resto = ids.filter(id => id !== ultima).map(id => reembolsoDe.get(id)!)
    expect(await prisma.cfdi.count({ where: { idempotencyKey: { in: resto.map(id => `cfdi-refund-${id}`) }, status: 'STAMPED' } })).toBe(0)
  })

  it('🔴 N8 · una nota timbrada contra OTRA factura no cumple la de ésta: sigue pendiente en la consulta y la emisión no la cuenta', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const r1 = await refundAmount(t, 50)
    const r = await facturar(t.id)
    const nota = (await notaDe(r1.id))!
    await prisma.cfdi.update({ where: { id: nota.id }, data: { entrada: { ...(nota.entrada as object), originalCfdiId: 'otra-factura' } } })
    expect((await facturasConNotasPendientes({ cfdiIds: [r.cfdi.id], limite: 5 })).map(f => f.pendientes)).toEqual([[r1.id]])
    expect(
      (await emitirNotasDeDevolucion({ id: r.cfdi.id, venueId }, [r1.id], { sandbox: true, staffId: null, presupuestoMs: 10_000 }))[0],
    ).toEqual({ refundPaymentId: r1.id, status: 'PENDIENTE', motivo: motivoNotaDeOtraFactura(folioDe(nota)) })
  })

  it('🔴 N5 · exclusiones: ni una factura cancelada, ni la nota cancelada de una factura que tiene otra pendiente (la pasada sólo recibe la intentable)', async () => {
    const a = await venta([{ productId: p16, precio: 116 }])
    await refundAmount(a, 50)
    const ra = await facturar(a.id, sinNotas())
    await prisma.cfdi.update({
      where: { id: ra.cfdi.id },
      data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED', stampedAt: haceOnceMinutos() },
    })
    const b = await venta([{ productId: p16, precio: 116 }])
    const b1 = await refundAmount(b, 20)
    const b2 = await refundAmount(b, 30)
    const rb = await facturar(b.id, sinNotas())
    await emitRefundCreditNote({ venueId, refundPaymentId: b1.id, sandbox: true })
    await prisma.cfdi.update({ where: { idempotencyKey: `cfdi-refund-${b1.id}` }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    expect(await facturasConNotasPendientes({ venueIds: [venueId], paraEmitir: true, limite: 20 })).toEqual([
      { cfdiId: rb.cfdi.id, venueId, orderId: b.id, pendientes: [b2.id] },
    ])
    expect((await facturasConNotasPendientes({ cfdiIds: [rb.cfdi.id], limite: 20 }))[0].pendientes).toEqual([b1.id, b2.id]) // la lista sí la muestra
  })

  it('🔴 H5 · el conteo REAL (sin dobles), la página de 1 con cursor y cada local con lo suyo', async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const t = await venta([{ productId: p16, precio: 116 }])
      await refundAmount(t, 10)
      ids.push((await facturar(t.id, sinNotas())).cfdi.id)
    }
    const otro = `${fixture}-b`
    await prisma.venue.create({ data: { id: otro, organizationId: fixture, name: otro, slug: otro } })
    try {
      // Una factura pendiente del OTRO local: la misma fila, con su local, sin venta (para no chocar con ninguna regla por orden).
      await prisma.$executeRaw`INSERT INTO "Cfdi" SELECT (jsonb_populate_record(NULL::"Cfdi", to_jsonb(c) || jsonb_build_object(
        'id', ${otro} || '-c', 'venueId', ${otro}, 'orderId', NULL, 'idempotencyKey', ${otro} || '-k', 'uuid', md5(${otro}), 'facturapiId', NULL
      ))).* FROM "Cfdi" c WHERE c.id = ${ids[0]}`
      expect(await contarFacturasConNotasPendientes({ venueIds: [venueId] })).toBe(3)
      expect(await contarFacturasConNotasPendientes({ venueIds: [otro] })).toBe(1)
      expect(await contarFacturasConNotasPendientes({ venueIds: [venueId, otro] })).toBe(4)
      const ambos = await facturasConNotasPendientes({ venueIds: [venueId, otro], limite: 10 })
      expect(ambos.map(f => f.venueId).sort()).toEqual([venueId, venueId, venueId, otro].sort()) // H6: cada una con su local
      const vistas: string[] = []
      let despuesDe: string | null = null
      for (let i = 0; i < 5; i++) {
        const pagina = await facturasConNotasPendientes({ venueIds: [venueId], despuesDe, limite: 1 })
        if (!pagina.length) break
        vistas.push(pagina[0].cfdiId)
        despuesDe = pagina[0].cfdiId
      }
      const enOrden = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Cfdi" WHERE id = ANY(${ids}) ORDER BY id`
      expect(vistas).toEqual(enOrden.map(x => x.id))
    } finally {
      await prisma.cfdi.deleteMany({ where: { venueId: otro } })
      await prisma.venue.delete({ where: { id: otro } })
    }
  })

  // ─── Tarea 8: la sustitución no vuelve a decidir ───────────────────────────────────────────────────────────────────────────────────

  it('🔴 Review Focus 5: «Corregir importe» de una factura que salió sin lo devuelto CONSERVA lo neto (nunca vuelve a la venta completa) y el reembolso sigue sin nota', async () => {
    const t = await ventaMezclada()
    const r1 = await refundItems(t, [{ productId: p16, precio: 58 }])
    const r = await facturar(t.id)
    expect(r.status).toBe('STAMPED')
    provider.cancelInvoice.mockResolvedValue({ status: 'canceled', cancelledAt: new Date() })
    const s = await replaceCfdi({ cfdiId: r.cfdi.id, sandbox: true, expectedVenueId: venueId })
    expect(s.status).toBe('REPLACED')
    expect(s.sustituta).toMatchObject({ totalCents: 20000, replacesCfdiId: r.cfdi.id })
    const [payload] = provider.createInvoice.mock.calls.at(-1)!
    expect(payload.items).toEqual((r.cfdi.entrada as any).params.items)
    expect(payload.relation).toEqual({ tipoRelacion: '04', relatedUuids: [r.cfdi.uuid] })
    expect((s.sustituta.entrada as any).devoluciones).toEqual({ modo: 'DESCONTADAS', pagos: [r1.id] })
    expect((await getRefundCreditNoteStatus(venueId, r1.id))!.eligibility.reason).toBe('DESCONTADA_EN_LA_FACTURA')
  })

  it('🔴 la sustituta de una factura por el total con su nota PENDIENTE hereda la marca: el job la emite contra la sustituta (nunca se pierde)', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const r1 = await refundAmount(t, 50)
    const r = await facturar(t.id, sinNotas())
    provider.cancelInvoice.mockResolvedValue({ status: 'canceled', cancelledAt: new Date() })
    const s = await replaceCfdi({ cfdiId: r.cfdi.id, sandbox: true, expectedVenueId: venueId })
    expect(s.status).toBe('REPLACED')
    expect(s.sustituta.totalCents).toBe(11600)
    expect((s.sustituta.entrada as any).devoluciones).toEqual({ modo: 'CON_NOTA', pagos: [r1.id] })
    await envejecer(s.sustituta.id)
    await pasadaDelJob()
    const n = await notaDe(r1.id)
    expect(n?.status).toBe('STAMPED')
    expect((n!.entrada as any).originalCfdiId).toBe(s.sustituta.id)
  })

  it('🔴 R3 en la sustitución: la nota de la devolución se canceló ⇒ «Corregir importe» se detiene con su folio, sin timbrar la sustituta', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const r1 = await refundAmount(t, 50)
    const r = await facturar(t.id)
    const nota = (await notaDe(r1.id))!
    await prisma.cfdi.update({ where: { id: nota.id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    const s = await replaceCfdi({ cfdiId: r.cfdi.id, sandbox: true, expectedVenueId: venueId })
    expect(s).toMatchObject({ status: 'VALIDATION_FAILED', reasons: expect.arrayContaining([motivoNotaCancelada(folioDe(nota))]) })
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
  })

  // Encargo del revisor de la T6: la sustituta hereda SÓLO los pagos de la marca SIN nota timbrada contra la original (una timbrada ya acreditó
  // ahí: heredada, la pasada la devolvería para siempre como `motivoNotaDeOtraFactura`). No hace falta filtrar al heredar: con una nota viva
  // contra la original la sustitución no empieza (G4: el SAT exige cancelar primero lo relacionado) y, cancelada esa nota, la detiene R3.
  it('🔴 la sustituta nunca hereda un pago con su nota TIMBRADA contra la original: G4 detiene «Corregir importe» y, cancelada la nota, R3', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const timbrada = await refundAmount(t, 20)
    await refundAmount(t, 30) // la otra de la marca, pendiente
    const r = await facturar(t.id, sinNotas())
    expect((await emitRefundCreditNote({ venueId, refundPaymentId: timbrada.id, sandbox: true })).status).toBe('STAMPED')
    const nota = (await notaDe(timbrada.id))!
    expect((nota.entrada as any).originalCfdiId).toBe(r.cfdi.id)
    provider.cancelInvoice.mockResolvedValue({ status: 'canceled', cancelledAt: new Date() })
    await expect(replaceCfdi({ cfdiId: r.cfdi.id, sandbox: true, expectedVenueId: venueId })).rejects.toMatchObject({
      message: textoDeDocumentoRelacionado(nota),
    })
    expect(await prisma.cfdi.count({ where: { replacesCfdiId: r.cfdi.id } })).toBe(0)
    await prisma.cfdi.update({ where: { id: nota.id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    expect(await replaceCfdi({ cfdiId: r.cfdi.id, sandbox: true, expectedVenueId: venueId })).toMatchObject({
      status: 'VALIDATION_FAILED',
      reasons: expect.arrayContaining([motivoNotaCancelada(folioDe(nota))]),
    })
    expect(provider.createInvoice).toHaveBeenCalledTimes(1) // sólo la original
  })

  it('🔴 la nota RECHAZADA contra la original no está timbrada: la sustituta la hereda y la pasada la recaptura contra la sustituta', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const r1 = await refundAmount(t, 50)
    const r = await facturar(t.id, sinNotas())
    provider.createCreditNote.mockRejectedValueOnce(
      new ProviderHttpError(422, 'invoice_stamping_validation_error', 'el SAT rechazó la nota'),
    )
    await emitRefundCreditNote({ venueId, refundPaymentId: r1.id, sandbox: true }).catch(() => undefined)
    expect(await notaDe(r1.id)).toMatchObject({ status: 'STAMP_FAILED', falloDefinitivo: true })
    provider.cancelInvoice.mockResolvedValue({ status: 'canceled', cancelledAt: new Date() })
    const s = await replaceCfdi({ cfdiId: r.cfdi.id, sandbox: true, expectedVenueId: venueId })
    expect(s.status).toBe('REPLACED')
    expect((s.sustituta.entrada as any).devoluciones).toEqual({ modo: 'CON_NOTA', pagos: [r1.id] })
    await envejecer(s.sustituta.id)
    await rechazadasHaceMasDeUnaHora(r1.id) // Ruling CX-1: antes de la hora se pospone
    await pasadaDelJob()
    const n = await notaDe(r1.id)
    expect(n?.status).toBe('STAMPED')
    expect((n!.entrada as any).originalCfdiId).toBe(s.sustituta.id)
  })

  // ─── Tarea 9: lo pendiente se ve ───────────────────────────────────────────────────────────────────────────────────────────────────

  const filaDe = async (cfdiId: string) =>
    (await listCfdisForVenue({ venueId, page: 1, pageSize: 20 })).cfdis.find((c: any) => c.id === cfdiId) as any

  it('🔴 R7/N10: la fila dice qué notas faltan, cada una con su fecha e importe (y deja de decirlo cuando salen); el panel dice que sale sola', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const r1 = await refundAmount(t, 50)
    const r = await facturar(t.id, sinNotas())
    const pago = await prisma.payment.findUniqueOrThrow({ where: { id: r1.id } })
    expect((await filaDe(r.cfdi.id)).notasDeDevolucionPendientes).toEqual([
      { refundPaymentId: r1.id, importeCents: 5000, fecha: pago.createdAt.toISOString() },
    ])
    expect((await getRefundCreditNoteStatus(venueId, r1.id))!.automatica).toEqual({ estado: 'RECUPERANDO' }) // elegible: la pasada la emite
    expect((await emitRefundCreditNote({ venueId, refundPaymentId: r1.id, sandbox: true })).status).toBe('STAMPED')
    expect(await filaDe(r.cfdi.id)).not.toHaveProperty('notasDeDevolucionPendientes')
    expect((await getRefundCreditNoteStatus(venueId, r1.id))!.automatica).toBeUndefined() // ya timbrada
  })

  it('🔴 N6: la nota automática de ESTE reembolso se canceló ⇒ no se ofrece «Emitir nota» (su llave no admite otra) y requiere a una persona', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const r1 = await refundAmount(t, 50)
    const r = await facturar(t.id)
    await prisma.cfdi.update({ where: { idempotencyKey: `cfdi-refund-${r1.id}` }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    const st = (await getRefundCreditNoteStatus(venueId, r1.id))!
    expect(st.eligibility).toEqual({ eligible: false, reason: 'NOTA_CANCELADA', message: MOTIVO_NOTA_DEL_REEMBOLSO_CANCELADA })
    expect(st.automatica).toEqual({ estado: 'REQUIERE_INTERVENCION' })
    expect((await filaDe(r.cfdi.id)).notasDeDevolucionPendientes.map((n: any) => n.refundPaymentId)).toEqual([r1.id])
  })

  it('🔴 I-2 (revisión final): devolución de artículos DESPUÉS de facturar, se cancelan su nota manual y la factura, y se vuelve a facturar (neta) ⇒ el reembolso dice DESCONTADA_EN_LA_FACTURA, no «pide a soporte»', async () => {
    const t = await ventaMezclada()
    const f0 = await facturar(t.id)
    expect(f0.status).toBe('STAMPED')
    const r1 = await refundItems(t, [{ productId: p16, precio: 58 }])
    expect((await emitRefundCreditNote({ venueId, refundPaymentId: r1.id, sandbox: true })).status).toBe('STAMPED')
    // Como lo deja la cancelación confirmada: primero la nota, después la factura.
    await prisma.cfdi.update({ where: { idempotencyKey: `cfdi-refund-${r1.id}` }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    await prisma.cfdi.update({ where: { id: f0.cfdi.id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    expect((await facturar(t.id)).status).toBe('STAMPED')
    expect(((await facturaDe(t.id)).entrada as any).devoluciones).toEqual({ modo: 'DESCONTADAS', pagos: [r1.id] }) // F6 decidió bien
    const st = (await getRefundCreditNoteStatus(venueId, r1.id))!
    expect(st.eligibility).toEqual({ eligible: false, reason: 'DESCONTADA_EN_LA_FACTURA', message: MOTIVO_DESCONTADA_EN_LA_FACTURA })
    expect(st).not.toHaveProperty('automatica')
  })

  it('🔴 I-2 · T9-a en una venta SIN F6: la nota de un reembolso posterior a la factura se canceló ⇒ NOTA_CANCELADA, sin `automatica`', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const f0 = await facturar(t.id)
    expect(f0.cfdi.entrada as any).not.toHaveProperty('devoluciones') // la factura no es de F6
    const r1 = await refundAmount(t, 50)
    expect((await emitRefundCreditNote({ venueId, refundPaymentId: r1.id, sandbox: true })).status).toBe('STAMPED')
    await prisma.cfdi.update({ where: { idempotencyKey: `cfdi-refund-${r1.id}` }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    const st = (await getRefundCreditNoteStatus(venueId, r1.id))!
    expect(st.eligibility).toEqual({ eligible: false, reason: 'NOTA_CANCELADA', message: MOTIVO_NOTA_DEL_REEMBOLSO_CANCELADA })
    expect(st).not.toHaveProperty('automatica')
  })

  it('🔴 H4: la de importe que espera a otra nota no promete nada — texto neutral con la devolución a revisar, y «requiere tu intervención»', async () => {
    const t = await ventaMezclada()
    const importe = await refundAmount(t, 50)
    await refundItems(t, [{ productId: p16, precio: 58 }])
    expect((await facturar(t.id, sinNotas())).status).toBe('STAMPED')
    const st = (await getRefundCreditNoteStatus(venueId, importe.id))!
    expect(st.eligibility).toMatchObject({
      eligible: false,
      reason: 'ESPERA_NOTA_DE_ARTICULOS',
      message: motivoEsperaNotaDeArticulos(5800),
    })
    expect(st.automatica).toEqual({ estado: 'REQUIERE_INTERVENCION' })
  })

  it('🔴 H4 · P10 pendiente: una devolución de artículos que la factura no registra (necesita que alguien confirme «por importe») no detiene a la de importe ni se presenta como automática', async () => {
    const t = await ventaMezclada()
    const sinEvidencia = await refundAmount(t, 30)
    await prisma.payment.update({
      where: { id: sinEvidencia.id },
      data: { processorData: { refundedItems: [{ orderItemId: 'fuera-de-la-factura', quantity: 1, amountCents: 3000 }] } },
    })
    const importe = await refundAmount(t, 50)
    const r = await facturar(t.id)
    expect(r.notasDeDevolucion?.map(n => [n.refundPaymentId, n.status])).toEqual([
      [sinEvidencia.id, 'PENDIENTE'],
      [importe.id, 'STAMPED'], // no espera a una dependencia que no es de reparto fijo comprobado (H1)
    ])
    const st = (await getRefundCreditNoteStatus(venueId, sinEvidencia.id))!
    expect(st.eligibility.reason).toBe('ARTICULO_SIN_EVIDENCIA')
    expect((st.preview as any)?.alternativa).toBeTruthy() // la persona decide (P10)
    expect(st.automatica).toEqual({ estado: 'REQUIERE_INTERVENCION' })
  })

  it('🔴 Ruling T9-b: la nota que el PAC rechazó EN DEFINITIVA no «se está recuperando» — requiere a una persona (con el motivo del PAC); la que quedó EN DUDA no lo pide', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const rechazada = await refundAmount(t, 50)
    const enDuda = await refundAmount(t, 30)
    provider.createCreditNote
      .mockRejectedValueOnce(new ProviderHttpError(422, 'invoice_stamping_validation_error', 'el SAT rechazó la nota'))
      .mockRejectedValueOnce(new TypeError('fetch failed')) // error de red ⇒ enviada e incierta
    const r = await facturar(t.id)
    expect(r.notasDeDevolucion?.map(n => [n.refundPaymentId, n.status])).toEqual([
      [rechazada.id, 'PENDIENTE'],
      [enDuda.id, 'PENDIENTE'],
    ])
    expect(await notaDe(rechazada.id)).toMatchObject({ status: 'STAMP_FAILED', falloDefinitivo: true })
    const st = (await getRefundCreditNoteStatus(venueId, rechazada.id))!
    expect(st.automatica).toEqual({ estado: 'REQUIERE_INTERVENCION' })
    expect(st.creditNote.lastError).toBeTruthy() // el motivo del PAC, ya expuesto en la nota
    expect(await notaDe(enDuda.id)).toMatchObject({ falloDefinitivo: false, enviadoAt: expect.any(Date) })
    const duda = (await getRefundCreditNoteStatus(venueId, enDuda.id))!
    expect(duda.recoveryOnly).toBe(true) // la conciliación la confirma por su identidad: «se está procesando», nunca «requiere intervención»
    expect(duda.automatica?.estado).not.toBe('REQUIERE_INTERVENCION')
  })

  it('N3: una devolución POSTERIOR (fuera de la marca) espera igual, pero no se presenta como automática: es manual', async () => {
    const t = await ventaMezclada()
    await refundItems(t, [{ productId: p16, precio: 58 }])
    await refundAmount(t, 50)
    expect((await facturar(t.id, sinNotas())).status).toBe('STAMPED')
    const posterior = await refundAmount(t, 30)
    const st = (await getRefundCreditNoteStatus(venueId, posterior.id))!
    expect(st.eligibility.reason).toBe('ESPERA_NOTA_DE_ARTICULOS')
    expect(st.automatica).toBeUndefined()
  })

  it('control — una factura neta (DESCONTADAS) no trae el campo', async () => {
    const t = await ventaMezclada()
    await refundItems(t, [{ productId: p16, precio: 58 }])
    const r = await facturar(t.id)
    expect(await filaDe(r.cfdi.id)).not.toHaveProperty('notasDeDevolucionPendientes')
  })

  // N9: la medición, apagada por defecto (corre con F6_EXPLAIN=1). Usa el fixture de esta suite; cada escenario en una transacción que se deshace.
  // Ruling B2 del pre-flight: 10× más chica que el plan (≈20k + 20k + 10k filas, no 200k + 200k + 100k) para no saturar el Postgres compartido
  // de la Mac; el umbral se escala igual (10 ms en vez de 100 ms). Producción tiene 54 `Cfdi`: 10k ya es ~200×.
  ;(process.env.F6_EXPLAIN ? it : it.skip)(
    'N9 · medición del barrido: historial F6 resuelto, cero pendientes, pendientes al final y 1 % entre facturas sin F6',
    async () => {
      const t = await venta([{ productId: p16, precio: 116 }])
      const d = await refundAmount(t, 50)
      const r = await facturar(t.id) // su nota timbrada: la fuente de las notas clonadas
      const notaId = (await notaDe(d.id))!.id
      const clonarFacturas = (db: Prisma.TransactionClient, prefijo: string, n: number, marca: 'RESUELTA' | 'PENDIENTE' | 'SIN_F6') =>
        db.$executeRaw`
          INSERT INTO "Cfdi" SELECT (jsonb_populate_record(NULL::"Cfdi", to_jsonb(c) || jsonb_build_object(
            'id', ${prefijo} || g, 'idempotencyKey', ${prefijo} || '-' || g, 'uuid', md5(${prefijo} || g::text), 'facturapiId', NULL,
            'stampedAt', now() - interval '1 day',
            'entrada', CASE WHEN ${marca} = 'SIN_F6' THEN c.entrada - 'devoluciones'
              ELSE c.entrada || jsonb_build_object('devoluciones', jsonb_build_object('modo', 'CON_NOTA', 'pagos', jsonb_build_array(${prefijo} || 'p' || g))) END
          ))).* FROM "Cfdi" c, generate_series(1, ${n}) g WHERE c.id = ${r.cfdi.id}`
      const clonarNotas = (db: Prisma.TransactionClient, prefijo: string, n: number) =>
        db.$executeRaw`
          INSERT INTO "Cfdi" SELECT (jsonb_populate_record(NULL::"Cfdi", to_jsonb(k) || jsonb_build_object(
            'id', ${prefijo} || 'n' || g, 'idempotencyKey', 'cfdi-refund-' || ${prefijo} || 'p' || g, 'uuid', md5(${prefijo} || 'n' || g::text),
            'facturapiId', NULL, 'entrada', k.entrada || jsonb_build_object('originalCfdiId', ${prefijo} || g)
          ))).* FROM "Cfdi" k, generate_series(1, ${n}) g WHERE k.id = ${notaId}`
      const escenarios: Array<[string, (db: Prisma.TransactionClient) => Promise<unknown>]> = [
        [
          'historial resuelto, cero pendientes',
          async db => {
            await clonarFacturas(db, 'f6a', 10_000, 'RESUELTA')
            await clonarNotas(db, 'f6a', 10_000)
          },
        ],
        [
          'historial resuelto + 20 pendientes al final',
          async db => {
            await clonarFacturas(db, 'f6a', 10_000, 'RESUELTA')
            await clonarNotas(db, 'f6a', 10_000)
            await clonarFacturas(db, 'f6z', 20, 'PENDIENTE')
          },
        ],
        [
          '1 % pendientes entre facturas sin F6',
          async db => {
            await clonarFacturas(db, 'f6s', 9_900, 'SIN_F6')
            await clonarFacturas(db, 'f6p', 100, 'PENDIENTE')
          },
        ],
      ]
      for (const [nombre, preparar] of escenarios) {
        const plan = await prisma
          .$transaction(
            async db => {
              await preparar(db)
              await db.$executeRaw`ANALYZE "Cfdi"`
              const explicar = async (sql: Prisma.Sql) =>
                (await db.$queryRaw<Array<{ 'QUERY PLAN': string }>>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS) ${sql}`))
                  .map(f => f['QUERY PLAN'])
                  .join('\n')
              const pagina = await explicar(sqlDeNotasPendientes({ timbradaAntesDe: haceOnceMinutos(), paraEmitir: true, limite: 20 }))
              const conteo = await explicar(sqlDelConteoDeNotasPendientes({ venueIds: [venueId] })) // H5: el total del MCP, sin límite ni antigüedad
              throw Object.assign(new Error('deshacer'), { plan: `${pagina}\n── conteo del MCP\n${conteo}` })
            },
            { timeout: 900_000 },
          )
          .catch((e: { plan?: string }) => e.plan)
        console.log(`── ${nombre}\n${plan}`) // copiar al ledger
        expect(plan?.match(/Execution Time/g)).toHaveLength(2)
      }
    },
    15 * 60_000,
  )
})
