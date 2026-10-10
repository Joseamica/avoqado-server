jest.mock('@/services/access/access.service', () => ({ hasPermission: jest.fn(() => true) }))
jest.mock('@/services/access/basePlan.service', () => ({ venuesWithFeatureAccess: jest.fn(async (ids: string[]) => new Set(ids)) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/mcp/guard', () => ({ createGuard: () => ({ venueFilter: jest.fn(), requirePermission: jest.fn() }) }))
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))
jest.mock('@/services/storage.service', () => ({
  ...jest.requireActual('@/services/storage.service'),
  uploadFileToStorage: jest.fn(async () => 'https://test/file'),
}))
import express from 'express'
import { registerCfdiTools } from '@/mcp/tools/cfdi'
import { auditMcpWrite } from '@/mcp/audit'
import { ProviderHttpError } from '@/services/fiscal/providers/facturapi.provider'
import * as admission from '@/services/fiscal/admisionIva'
import request from 'supertest'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import {
  AVISO_FACTURACION_APAGADA,
  emitRefundCreditNote,
  getRefundCreditNoteStatus,
  MOTIVO_FALTA_LA_HUELLA,
  MOTIVO_REPARTO_CAMBIO,
  MOTIVO_NOTA_CAMBIO,
  MOTIVO_XML_ILEGIBLE,
} from '@/services/fiscal/cfdiCreditNote.service'
import { MOTIVO_ESPERA_XML } from '@/services/fiscal/saldoFiscal'
import * as finalizador from '@/services/fiscal/finalizadorCfdi'
import { xmlConceptosDe, xmlDeLaFila } from '../../__helpers__/xml-del-pac'
import { emitRefundCreditNoteController, getRefundCreditNoteController } from '@/controllers/dashboard/cfdi.dashboard.controller'
import { validateRequest } from '@/middlewares/validation'
import { emitRefundCreditNoteSchema } from '@/schemas/dashboard/cfdi.schema'
import { Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { issueCfdiForOrder } from '@/services/fiscal/cfdi.service'
import { huellaDeEntrada } from '@/services/fiscal/entradaDocumental'
import { encenderIvaPorProducto } from '../../__helpers__/iva-por-producto'
import { logAction } from '@/services/dashboard/activity-log.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'

const { isDisposableH1Url } = require('../../../scripts/h1-test-database.cjs')
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
// Sólo las bases fiscales locales existentes o una desechable H1 validada por el lanzador.
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !(
    ['/av_db_25_iva_test', '/av_db_25_iva_test_b3c', '/avoqado_h1a_test_20260808'].includes(database.pathname) ||
    isDisposableH1Url(database)
  )
) {
  throw new Error('Esta suite exige la base local av_db_25_iva_test o una base H1 desechable validada.')
}

const receptor = { rfc: 'EKU9003173C9', razonSocial: 'ESCUELA KEMPER URGATE', regimenFiscal: '601', codigoPostal: '64000', usoCfdi: 'G03' }
const stamped = {
  providerInvoiceId: 'pac-test',
  uuid: 'UUID-TEST',
  serie: 'F',
  folio: '1',
  totalCents: 11600,
  stampedAt: new Date(),
  status: 'valid',
}

describe('egreso con entrada congelada', () => {
  const fixture = `emision-iva-${randomUUID()}`
  let venueId: string
  let productId: string
  let cafeId: string // C2 T7: un segundo producto, al 0 %, para la venta mezclada
  let fiscalEmisorId: string
  const provider = {
    name: 'facturapi',
    createInvoice: jest.fn(),
    createCreditNote: jest.fn(),
    findByExternalId: jest.fn(),
    getInvoice: jest.fn(),
    downloadXml: jest.fn(),
    downloadPdf: jest.fn(),
  }
  const deps = {
    resolveProvider: jest.fn(() => provider as any),
    storeArtifact: jest.fn(async () => 'https://test/file'),
  }
  const issue = (orderId: string, extra = {}) =>
    issueCfdiForOrder({ orderId, receptor, sandbox: true, expectedVenueId: venueId, ...extra }, deps)
  const row = (orderId: string) => prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: `cfdi-order-${orderId}` } })

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
    venueId = (await prisma.venue.create({ data: { id: fixture, organizationId: fixture, name: fixture, slug: fixture } })).id
    await encenderIvaPorProducto(venueId)
    const category = await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })
    productId = (await prisma.product.create({ data: { venueId, categoryId: category.id, name: fixture, sku: fixture, price: 116 } })).id
    cafeId = (
      await prisma.product.create({
        data: { venueId, categoryId: category.id, name: `${fixture}-cafe`, sku: `${fixture}-cafe`, price: 200, ivaTratamiento: 'IVA_0' },
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
      data: { merchantAccountId: fixture, fiscalEmisorId, facturacionEnabled: true, autofacturaEnabled: true },
    })
  })
  afterEach(() => jest.restoreAllMocks())
  beforeEach(async () => {
    finalizador.olvidarReparaciones() // C2 T7 ronda 1 (I2): la memoria de reparaciones es del proceso
    jest.clearAllMocks()
    jest.mocked(resolveFiscalProvider).mockReturnValue(provider as any)
    provider.createCreditNote
      .mockReset()
      .mockImplementation(async () => ({ ...stamped, uuid: randomUUID(), providerInvoiceId: randomUUID() }))
    stamped.uuid = randomUUID()
    stamped.providerInvoiceId = randomUUID()
    // C2 T7: cada factura con su identidad del PAC, y el XML de cada una armado de lo que se le mandó (la regla de la 6b): la nota exige
    // el XML de su original (D5).
    provider.createInvoice.mockReset().mockImplementation(async () => ({ ...stamped, uuid: randomUUID(), providerInvoiceId: randomUUID() }))
    provider.findByExternalId.mockReset().mockResolvedValue(null)
    provider.getInvoice.mockReset().mockResolvedValue(stamped)
    provider.downloadXml.mockReset().mockImplementation(async (id: string) => xmlDeLaFila(prisma, id))
    provider.downloadPdf.mockResolvedValue(Buffer.from('%PDF'))
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_16' } })
  })
  afterAll(async () => {
    if (!venueId) return
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.orderItemSelloIva.deleteMany({ where: { cfdi: { venueId } } })
    await prisma.cfdi.deleteMany({ where: { venueId } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisorId } })
    await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
    await prisma.merchantAccount.deleteMany({ where: { id: fixture } })
    await prisma.paymentProvider.deleteMany({ where: { id: fixture } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: fixture } })
  })
  async function order() {
    return prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        subtotal: 116,
        taxAmount: 0,
        total: 116,
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        items: { create: { productId, productName: 'Producto', quantity: 1, unitPrice: 116, taxAmount: 0, total: 116 } },
        payments: { create: { venueId, amount: 116, feePercentage: 0, feeAmount: 0, netAmount: 116, method: 'CASH', status: 'COMPLETED' } },
      },
      include: { items: true },
    })
  }
  const emit = (id: string, extra = {}) => emitRefundCreditNote({ venueId, refundPaymentId: id, sandbox: true, ...extra })
  const note = (id: string) => prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: `cfdi-refund-${id}` } })
  async function refund(orderId: string, amount = 116) {
    return prisma.payment.create({
      data: {
        venueId,
        orderId,
        type: 'REFUND',
        amount: -amount,
        tipAmount: -10,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -amount,
        method: 'CASH',
        status: 'COMPLETED',
      },
    })
  }
  async function sale(treatment: 'IVA_16' | 'IVA_0' = 'IVA_16') {
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: treatment } })
    const o = await order()
    await issue(o.id)
    return { o, original: await row(o.id), refund: await refund(o.id) }
  }
  /** C2 T7: la venta mezclada del plan —café $200 al 0 % + pan $58 al 16 %— con su factura timbrada (y su XML). */
  async function ventaMixta() {
    const o = await prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        subtotal: 258,
        taxAmount: 0,
        total: 258,
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        items: {
          create: [
            { productId: cafeId, productName: 'Café', quantity: 1, unitPrice: 200, taxAmount: 0, total: 200 },
            { productId, productName: 'Pan', quantity: 1, unitPrice: 58, taxAmount: 0, total: 58 },
          ],
        },
        payments: { create: { venueId, amount: 258, feePercentage: 0, feeAmount: 0, netAmount: 258, method: 'CASH', status: 'COMPLETED' } },
      },
      include: { items: true },
    })
    await issue(o.id)
    return {
      o,
      original: await row(o.id),
      cafe: o.items.find(i => i.productId === cafeId)!,
      pan: o.items.find(i => i.productId === productId)!,
    }
  }
  /** Un reembolso POR ARTÍCULOS, como lo escribe `issueRefund` (`processorData.refundedItems`), sin propina. */
  async function refundArticulos(orderId: string, items: Array<{ id: string; cents: number; nombre: string }>) {
    const total = items.reduce((s, x) => s + x.cents, 0) / 100
    return prisma.payment.create({
      data: {
        venueId,
        orderId,
        type: 'REFUND',
        amount: -total,
        tipAmount: 0,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -total,
        method: 'CASH',
        status: 'COMPLETED',
        processorData: {
          refundedItems: items.map(x => ({
            orderItemId: x.id,
            quantity: 1,
            amountCents: x.cents,
            amount: x.cents / 100,
            productName: x.nombre,
          })),
        },
      },
    })
  }
  /** El XML de una fila después de reescribir sus conceptos (lo que el PAC habría timbrado con ellos). */
  const conXml = (items: any[]) => {
    const x = xmlConceptosDe(items)
    return { xmlConceptos: x.xmlConceptos as unknown as Prisma.InputJsonValue, taxBreakdown: x.taxBreakdown as Prisma.InputJsonValue }
  }
  // C2 (§4.4), dorada que cambia A PROPÓSITO: antes «rechaza original mixta por la ruta real del dashboard con 409 y texto exacto».
  it('🔴 C2: la original mixta ya no se rechaza: por la ruta real del dashboard timbra su nota por tasa (201)', async () => {
    const v = await ventaMixta()
    const r = await refund(v.o.id, 258)
    const app = express()
    app.post(
      '/venues/:venueId/refunds/:refundId/credit-note',
      (req, _res, next) => {
        ;(req as any).authContext = { venueId }
        next()
      },
      emitRefundCreditNoteController,
    )
    const res = await request(app).post(`/venues/${venueId}/refunds/${r.id}/credit-note`)
    expect(res.status).toBe(201)
    expect(provider.createCreditNote.mock.calls[0][0].items.map((i: any) => [i.satProductKey, i.unitPriceCents, i.taxes[0]?.rate])).toEqual(
      [
        ['84111506', 5800, 0.16],
        ['84111506', 20000, 0],
      ],
    )
  })
  it('🔴 C2 T7: mezclada, por artículos sólo el café ⇒ UN concepto 84111506/ACT al 0 % por $200, PUE y G02, entrada v2; luego $58 por importe al 16 %; luego $1 no cabe', async () => {
    const v = await ventaMixta()
    const r1 = await refundArticulos(v.o.id, [{ id: v.cafe.id, cents: 20000, nombre: 'Café' }])
    const logAction = jest.fn()
    const emitConBitacora = (id: string) => emitRefundCreditNote({ venueId, refundPaymentId: id, sandbox: true }, { logAction })
    expect((await emitConBitacora(r1.id)).status).toBe('STAMPED')
    const enviado = provider.createCreditNote.mock.calls[0][0]
    expect(enviado.items).toEqual([
      {
        satProductKey: '84111506',
        satUnitKey: 'ACT',
        description: `Devolución sobre factura ${v.original.serie}${v.original.folio}`,
        quantity: 1,
        unitPriceCents: 20000,
        discountCents: 0,
        objetoImp: '02',
        taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0, withholding: false }],
        taxIncluded: true,
      },
    ])
    expect(enviado).toMatchObject({ metodoPago: 'PUE', receptor: { usoCfdi: 'G02' }, relationship: '01', relatedUuids: [v.original.uuid] })
    const n1 = await note(r1.id)
    expect(n1).toMatchObject({ metodoPago: 'PUE', usoCfdi: 'G02', subtotalCents: 20000, taxCents: 0, totalCents: 20000 })
    expect(n1.entrada).toMatchObject({
      version: 2,
      causa: 'DEVOLUCION',
      originalCfdiId: v.original.id, // la guarda C2-6 de la cancelación la encuentra por esta llave
      modalidad: 'POR_ARTICULOS',
      porTratamiento: { IVA_0: { baseCents: 20000, ivaCents: 0, totalCents: 20000 } },
      porRenglon: [{ orderItemId: v.cafe.id, totalCents: 20000, porTratamiento: { IVA_0: 20000 } }],
      redondeo: [],
    })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CFDI_CREDIT_NOTE_ISSUED',
        data: expect.objectContaining({ modalidad: 'POR_ARTICULOS', redondeo: [], originalEsGlobal: false, relatedCfdiId: v.original.id }),
      }),
    )
    // Lo único que queda es el pan: $58 por importe sale al 16 %.
    const r2 = await refund(v.o.id, 58)
    expect((await emit(r2.id)).status).toBe('STAMPED')
    expect(provider.createCreditNote.mock.calls[1][0].items).toEqual([
      expect.objectContaining({
        satProductKey: '84111506',
        unitPriceCents: 5800,
        taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
      }),
    ])
    expect((await note(r2.id)).entrada).toMatchObject({
      modalidad: 'POR_IMPORTE',
      porTratamiento: { IVA_16: { baseCents: 5000, ivaCents: 800, totalCents: 5800 } },
    })
    // Y ya no queda nada: $1 más no cabe.
    const r3 = await refund(v.o.id, 1)
    expect((await getRefundCreditNoteStatus(venueId, r3.id))?.eligibility.reason).toBe('EXCEEDS_REMAINING')
    await expect(emit(r3.id)).rejects.toThrow(/queda/)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(2)
  })
  it('🔴 (B) de punta a punta: la 6b dejó a B 1 ¢ debajo de lo cobrado; devolverlo COMPLETO timbra, con el centavo declarado y la entrada v2 legible', async () => {
    // A $19 − $2.50 y B $35 (al 16 %): el PAC daría otro total, la 6b baja el descuento de A a $2.49 ⇒ A queda en 16.51 y B en 34.99.
    const o = await prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        subtotal: 54,
        discountAmount: 2.5,
        taxAmount: 0,
        total: 51.5,
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        items: {
          create: [
            { productId, productName: 'A', quantity: 1, unitPrice: 19, discountAmount: 2.5, taxAmount: 0, total: 19 },
            { productId, productName: 'B', quantity: 1, unitPrice: 35, taxAmount: 0, total: 35 },
          ],
        },
        payments: {
          create: { venueId, amount: 51.5, feePercentage: 0, feeAmount: 0, netAmount: 51.5, method: 'CASH', status: 'COMPLETED' },
        },
      },
      include: { items: true },
    })
    await issue(o.id)
    const original = await row(o.id)
    const b = o.items.find(i => i.productName === 'B')!
    expect((original.entrada as any).montosPorRenglon).toContainEqual({
      orderItemId: b.id,
      totalCents: 3499,
      porTratamiento: { IVA_16: 3499 },
    })
    const r = await refundArticulos(o.id, [{ id: b.id, cents: 3500, nombre: 'B' }])
    expect((await emit(r.id)).status).toBe('STAMPED')
    expect(provider.createCreditNote.mock.calls[0][0].items).toEqual([expect.objectContaining({ unitPriceCents: 3500 })])
    expect((await note(r.id)).entrada).toMatchObject({
      version: 2,
      porRenglon: [{ orderItemId: b.id, totalCents: 3500, porTratamiento: { IVA_16: 3500 } }],
      redondeo: [{ tratamiento: 'IVA_16', componente: 'ARTICULO', cents: 1, ambito: 'FACTURA', orderItemId: b.id }],
    })
  })
  it('🔴 C2-P3: una original PPD ⇒ la nota sale PUE', async () => {
    const s = await sale()
    await prisma.cfdi.update({ where: { id: s.original.id }, data: { metodoPago: 'PPD' } })
    expect((await emit(s.refund.id)).status).toBe('STAMPED')
    expect(provider.createCreditNote.mock.calls[0][0].metodoPago).toBe('PUE')
    expect(await note(s.refund.id)).toMatchObject({ metodoPago: 'PUE', usoCfdi: 'G02' })
  })
  it('🔴 G8: reembolso sin forma SAT y la original PPD «por definir» (99) sin pagos ⇒ la nota sale con 15 (condonación) y PUE', async () => {
    const s = await sale()
    await prisma.cfdi.update({ where: { id: s.original.id }, data: { metodoPago: 'PPD', formaPago: '99' } })
    await prisma.payment.update({ where: { id: s.refund.id }, data: { method: 'OTHER' } })
    expect((await emit(s.refund.id)).status).toBe('STAMPED')
    expect(provider.createCreditNote.mock.calls[0][0]).toMatchObject({ formaPago: '15', metodoPago: 'PUE' })
  })
  it('🔴 C2-13 de punta a punta: sin el XML de la original la vista dice ESPERA_XML y pide sus archivos; el POST los repara al momento y timbra', async () => {
    const s = await sale()
    await prisma.cfdi.update({ where: { id: s.original.id }, data: { xmlConceptos: Prisma.DbNull } })
    provider.downloadXml.mockClear()
    provider.downloadXml.mockRejectedValueOnce(new Error('el PAC no rinde el XML'))
    expect((await getRefundCreditNoteStatus(venueId, s.refund.id))?.eligibility).toMatchObject({ eligible: false, reason: 'ESPERA_XML' })
    expect(provider.downloadXml.mock.calls).toEqual([[s.original.facturapiId]]) // los pidió, una vez, con SU identidad
    expect((await emit(s.refund.id)).status).toBe('STAMPED')
    expect((await prisma.cfdi.findUniqueOrThrow({ where: { id: s.original.id } })).xmlConceptos).not.toBeNull()
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })
  it('🔴 C2-13: si el PAC no rinde el XML, el POST responde VALIDATION_FAILED con MOTIVO_ESPERA_XML y no reserva', async () => {
    const s = await sale()
    await prisma.cfdi.update({ where: { id: s.original.id }, data: { xmlConceptos: Prisma.DbNull } })
    provider.downloadXml.mockRejectedValue(new Error('el PAC no rinde el XML'))
    expect(await emit(s.refund.id)).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_ESPERA_XML] })
    expect(await prisma.cfdi.count({ where: { idempotencyKey: `cfdi-refund-${s.refund.id}` } })).toBe(0)
    expect(provider.createCreditNote).not.toHaveBeenCalled()
  })
  it('🔴 N1: un XML que se bajó y no se lee DETIENE la nota con su motivo (nunca espera para siempre), en el POST y en la vista', async () => {
    const s = await sale()
    await prisma.cfdi.update({ where: { id: s.original.id }, data: { xmlConceptos: Prisma.DbNull } })
    provider.downloadXml.mockResolvedValue(Buffer.from('<Comprobante/>'))
    expect(await emit(s.refund.id)).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_XML_ILEGIBLE] })
    expect((await getRefundCreditNoteStatus(venueId, s.refund.id))?.eligibility).toEqual({
      eligible: false,
      reason: 'XML_IRRECUPERABLE',
      message: MOTIVO_XML_ILEGIBLE,
    })
    expect(await prisma.cfdi.count({ where: { idempotencyKey: `cfdi-refund-${s.refund.id}` } })).toBe(0)
    expect(provider.createCreditNote).not.toHaveBeenCalled()
  })
  it('🔴 I2 (ronda 1): dos vistas y el POST a la vez sobre una original sin XML ⇒ UNA sola bajada; la vista la espera ≤ 2 s', async () => {
    const s = await sale()
    await prisma.cfdi.update({ where: { id: s.original.id }, data: { xmlConceptos: Prisma.DbNull } })
    provider.downloadXml.mockClear()
    const compartida = jest.spyOn(finalizador, 'repararArchivosCompartido')
    let soltar!: () => void
    const puerta = new Promise<void>(r => (soltar = r))
    provider.downloadXml.mockImplementation(async (id: string) => {
      await puerta
      return xmlDeLaFila(prisma, id)
    })
    const pedidos = Promise.all([
      getRefundCreditNoteStatus(venueId, s.refund.id),
      getRefundCreditNoteStatus(venueId, s.refund.id),
      emit(s.refund.id),
    ])
    setTimeout(soltar, 300)
    const [v1, v2, nota] = await pedidos
    expect(nota.status).toBe('STAMPED')
    expect([v1!.eligibility.reason, v2!.eligibility.reason].every(r => r === null || r === 'ESPERA_XML')).toBe(true)
    // UNA bajada del XML de la ORIGINAL (la otra llamada es la de los archivos de la nota recién timbrada).
    expect(provider.downloadXml.mock.calls.filter(([id]) => id === s.original.facturapiId)).toHaveLength(1)
    for (const [, opts] of compartida.mock.calls.filter(([, o]) => !o.insistir)) expect(opts.esperaMs).toBeLessThanOrEqual(2_000)
  })
  it('🔴 I2 (ronda 1): el veredicto «ilegible» queda PERSISTIDO en la original; la vista siguiente lo dice SIN volver a bajar el XML', async () => {
    const s = await sale()
    await prisma.cfdi.update({ where: { id: s.original.id }, data: { xmlConceptos: Prisma.DbNull } })
    provider.downloadXml.mockResolvedValue(Buffer.from('<Comprobante/>'))
    expect(await emit(s.refund.id)).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_XML_ILEGIBLE] })
    expect((await prisma.cfdi.findUniqueOrThrow({ where: { id: s.original.id } })).xmlConceptos).toMatchObject({
      version: 1,
      ilegible: true,
    })
    finalizador.olvidarReparaciones() // otro proceso, sin memoria: sólo lo persistido
    provider.downloadXml.mockClear()
    expect((await getRefundCreditNoteStatus(venueId, s.refund.id))?.eligibility).toEqual({
      eligible: false,
      reason: 'XML_IRRECUPERABLE',
      message: MOTIVO_XML_ILEGIBLE,
    })
    expect(provider.downloadXml).not.toHaveBeenCalled()
  })
  it('🔴 M4 (ronda 1): con la nota ya timbrada, la vista no repara el XML de la original ni calcula la elegibilidad', async () => {
    const s = await sale()
    expect((await emit(s.refund.id)).status).toBe('STAMPED')
    await prisma.cfdi.update({ where: { id: s.original.id }, data: { xmlConceptos: Prisma.DbNull } })
    provider.downloadXml.mockClear()
    const st = await getRefundCreditNoteStatus(venueId, s.refund.id)
    expect(st?.creditNote).toMatchObject({ status: 'STAMPED' })
    expect(st?.eligibility).toEqual({ eligible: false, reason: null, message: 'Este reembolso ya tiene su nota de crédito timbrada.' })
    expect(provider.downloadXml).not.toHaveBeenCalled()
  })
  it('🔴 G6: con la facturación del comercio apagada la nota manual NO se bloquea, y la vista previa lo dice (con su desglose)', async () => {
    const s = await sale()
    await prisma.merchantFiscalConfig.updateMany({ where: { fiscalEmisorId }, data: { facturacionEnabled: false } })
    try {
      const st = await getRefundCreditNoteStatus(venueId, s.refund.id)
      expect(st?.eligibility.eligible).toBe(true)
      expect(st?.preview).toMatchObject({
        avisoFacturacionApagada: AVISO_FACTURACION_APAGADA,
        usoCfdi: 'G02',
        desglose: [{ tratamiento: 'IVA_16', cents: 11600, baseCents: 10000, ivaCents: 1600 }],
        redondeo: [],
      })
      expect((await emit(s.refund.id)).status).toBe('STAMPED')
    } finally {
      await prisma.merchantFiscalConfig.updateMany({ where: { fiscalEmisorId }, data: { facturacionEnabled: true } })
    }
    expect((await getRefundCreditNoteStatus(venueId, (await refund(s.o.id, 1)).id))?.preview).not.toHaveProperty('avisoFacturacionApagada')
  })
  it('congela entrada EGRESO y versión sin sellos nuevos; catálogo posterior no cambia IVA16', async () => {
    const s = await sale()
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
    expect((await emit(s.refund.id)).status).toBe('STAMPED')
    const n = await note(s.refund.id)
    expect(n).toMatchObject({ protocoloIva: 1, attempts: 1, subtotalCents: 10000, taxCents: 1600, totalCents: 11600 })
    expect(n.enviadoAt).not.toBeNull()
    expect(n.entrada).toMatchObject({
      tipo: 'EGRESO',
      originalCfdiId: s.original.id,
      originalUuid: s.original.uuid,
      refundPaymentId: s.refund.id,
    })
    expect(n.entradaHuella).toBe(huellaDeEntrada(n.entrada))
    expect(provider.createCreditNote.mock.calls[0][0]).toMatchObject({
      externalId: `cfdi-refund-${s.refund.id}#1`,
      idempotencyKey: `cfdi-refund-${s.refund.id}#1`,
      items: [{ taxes: [{ rate: 0.16 }] }],
    })
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: n.id } })).toBe(0)
  })
  it.each(['missing', 'hash', 'shape'])('original protocolo1 corrupta %s es negocio inelegible y jamás llega al PAC', async corruption => {
    const s = await sale()
    const entrada = structuredClone(s.original.entrada) as any
    if (corruption === 'shape') entrada.renglones[0].tratamiento = 'INVENTADO'
    await prisma.cfdi.update({
      where: { id: s.original.id },
      data:
        corruption === 'missing'
          ? { entrada: Prisma.DbNull }
          : { entrada, entradaHuella: corruption === 'hash' ? 'bad' : huellaDeEntrada(entrada) },
    })
    expect((await getRefundCreditNoteStatus(venueId, s.refund.id))?.eligibility.reason).toBe('ORIGINAL_ENTRADA_INVALIDA')
    await expect(emit(s.refund.id)).rejects.toThrow(/entrada|soporte/i)
    expect(provider.createCreditNote).not.toHaveBeenCalled()
  })
  it('respuesta perdida recupera identidad pese a original cancelada y reembolso cambiado', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    const before = await note(s.refund.id)
    await prisma.cfdi.update({ where: { id: s.original.id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    await prisma.payment.update({ where: { id: s.refund.id }, data: { status: 'PENDING', amount: -1 } })
    expect(await getRefundCreditNoteStatus(venueId, s.refund.id)).toMatchObject({ recoveryOnly: true, eligibility: { eligible: false } })
    provider.findByExternalId.mockResolvedValue({ ...stamped, uuid: randomUUID() })
    expect((await emit(s.refund.id, { lookupOnly: true })).status).toBe('STAMPED')
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    expect(provider.findByExternalId).toHaveBeenCalledWith(`${before.idempotencyKey}#1`)
    expect(await note(s.refund.id)).toMatchObject({ attempts: 1, entrada: before.entrada, totalCents: 11600 })
  })
  it('dos reembolsos distintos compiten por el mismo saldo; incierto consume capacidad', async () => {
    const s = await sale()
    const other = await refund(s.o.id)
    provider.createCreditNote.mockRejectedValue(new Error('timeout'))
    const results = await Promise.allSettled([emit(s.refund.id), emit(other.id)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })
  it('lookupOnly nunca recaptura un intento que pasó a rechazo definitivo', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    await prisma.cfdi.update({ where: { id: (await note(s.refund.id)).id }, data: { falloDefinitivo: true } })
    await expect(emit(s.refund.id, { lookupOnly: true })).rejects.toThrow(/proces/i)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    expect((await note(s.refund.id)).attempts).toBe(1)
  })
  // C2 (C2-P5), dorada que cambia A PROPÓSITO: la histórica sin IVA ya no sale por `taxCents === 0` (`originalSinIvaHistorico`, v1) sino por
  // SU XML: el concepto `ObjetoImp 01` da una nota v2 no objeto.
  it('legacy original sin IVA: su XML dice «no objeto» ⇒ la nota v2 sale no objeto, con su procedencia congelada', async () => {
    const s = await sale()
    const sinIva = conXml([
      {
        satProductKey: '01010101',
        satUnitKey: 'H87',
        description: 'Producto',
        quantity: 1,
        unitPriceCents: 11600,
        discountCents: 0,
        taxIncluded: true,
        objetoImp: '01',
        taxes: [],
      },
    ])
    await prisma.cfdi.update({
      where: { id: s.original.id },
      data: { protocoloIva: null, entrada: Prisma.DbNull, entradaHuella: null, subtotalCents: 11600, taxCents: 0, ...sinIva },
    })
    await emit(s.refund.id)
    expect(await note(s.refund.id)).toMatchObject({
      protocoloIva: 1,
      taxCents: 0,
      subtotalCents: 11600,
      entrada: {
        version: 2,
        originalCfdiId: s.original.id,
        porTratamiento: { NO_OBJETO: { baseCents: 11600, ivaCents: 0, totalCents: 11600 } },
      },
    })
    expect(provider.createCreditNote.mock.calls[0][0].items[0]).toMatchObject({ satProductKey: '84111506', objetoImp: '01', taxes: [] })
  })
  it('idempotencia STAMPED no revela una nota de otro tenant', async () => {
    const s = await sale()
    await emit(s.refund.id)
    await expect(emitRefundCreditNote({ venueId: 'otro', refundPaymentId: s.refund.id, sandbox: true })).rejects.toThrow(/no encontrado/i)
  })
  function mcp() {
    const handlers = new Map<string, (...args: any[]) => Promise<any>>()
    registerCfdiTools(
      { tool: (...args: any[]) => handlers.set(args[0], args.at(-1)) } as any,
      { staffId: 'test-staff', activeOrg: fixture, allowedVenueIds: [venueId], perVenueAccess: new Map() } as any,
    )
    return async (refundPaymentId: string, confirm?: boolean, extra = {}) =>
      JSON.parse((await handlers.get('emit_refund_credit_note')!({ venueId, refundPaymentId, confirm, ...extra }, {})).content[0].text)
  }
  // C2 (§4.4), dorada que cambia A PROPÓSITO: antes «MCP real bloquea original mixta con confirm=%s sin PAC/audit» (`ORIGINAL_IVA_MIXTO`).
  it('🔴 C2: el MCP real ya no bloquea la original mixta: la vista previa no toca el PAC y con confirm emite por tasa', async () => {
    const v = await ventaMixta()
    const r = await refund(v.o.id, 258)
    const call = mcp()
    // T9 ronda 1, cambio A PROPÓSITO: el paso 2 son los confirmationArgs de la vista previa tal cual (sin lookupOnly; con su huella).
    const vista = await call(r.id)
    expect(vista).toMatchObject({ requiresConfirmation: true, expectedSourceFingerprint: expect.any(String) })
    expect(vista.confirmationArgs.lookupOnly).toBeUndefined()
    expect(provider.createCreditNote).not.toHaveBeenCalled()
    expect(auditMcpWrite).not.toHaveBeenCalled()
    expect((await call(r.id, true, vista.confirmationArgs)).ok).toBe(true)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    expect(auditMcpWrite).toHaveBeenCalledTimes(1)
  })
  it('MCP real recupera nota enviada con la original cancelada; preview no consulta el PAC', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    await prisma.cfdi.update({ where: { id: s.original.id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    await prisma.payment.update({ where: { id: s.refund.id }, data: { amount: -1, status: 'PENDING' } })
    const call = mcp()
    const lookups = provider.findByExternalId.mock.calls.length
    const preview = await call(s.refund.id)
    expect(preview).toMatchObject({ requiresConfirmation: true, preview: { importeAcreditadoMxn: 116 } })
    expect(provider.findByExternalId).toHaveBeenCalledTimes(lookups)
    provider.findByExternalId.mockResolvedValue({ ...stamped, uuid: randomUUID() })
    expect((await call(s.refund.id, true, preview.confirmationArgs)).ok).toBe(true) // T9 ronda 1: con los args de la vista
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })
  it('POST pending guarda id; recuperación usa id y nunca segundo POST', async () => {
    const s = await sale()
    provider.createCreditNote.mockResolvedValueOnce({ ...stamped, providerInvoiceId: 'pending-note', status: 'pending', uuid: null })
    await expect(emit(s.refund.id)).rejects.toThrow(/proces/i)
    expect(await note(s.refund.id)).toMatchObject({ facturapiId: 'pending-note', status: 'STAMPING', attempts: 1 })
    provider.getInvoice.mockResolvedValueOnce({ ...stamped, uuid: randomUUID() })
    expect((await emit(s.refund.id)).status).toBe('STAMPED')
    expect(provider.getInvoice).toHaveBeenCalledWith('pending-note')
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })
  it('lookup pending es lectura: no guarda id ni cambia versión/snapshot', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    const before = await note(s.refund.id)
    provider.findByExternalId.mockResolvedValue({ ...stamped, providerInvoiceId: 'pending-found', status: 'pending', uuid: null })
    await expect(emit(s.refund.id)).rejects.toThrow(/proces/i)
    expect(await note(s.refund.id)).toEqual(before)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })
  it('incertidumbre nunca caduca; ausencia no recaptura ni cambia attempts', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    const first = await note(s.refund.id)
    await prisma.cfdi.update({ where: { id: first.id }, data: { enviadoAt: new Date(Date.now() - 61 * 60000) } })
    await expect(emit(s.refund.id)).rejects.toThrow(/proces/i)
    await expect(emit(s.refund.id)).rejects.toThrow(/proces/i)
    expect(await note(s.refund.id)).toMatchObject({ attempts: 1, entradaHuella: first.entradaHuella, falloDefinitivo: false })
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    expect(await prisma.activityLog.count({ where: { venueId, entityId: first.id, action: 'CFDI_INTENTO_INCIERTO_ESCALADO' } })).toBe(1)
  })
  it('rechazo confirmado recaptura la misma fila con versión nueva y reserva saldo propio', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new ProviderHttpError(400, 'invalid_request', 'rechazo'))
    expect((await emit(s.refund.id)).status).toBe('STAMP_FAILED')
    const first = await note(s.refund.id)
    expect(first.falloDefinitivo).toBe(true)
    expect((await emit(s.refund.id)).status).toBe('STAMPED')
    expect(await note(s.refund.id)).toMatchObject({ id: first.id, attempts: 2, falloDefinitivo: false })
    expect(provider.createCreditNote.mock.calls[1][0].externalId).toBe(`${first.idempotencyKey}#2`)
  })
  it('admisión org y recheck del reembolso ocurren dentro de la reserva', async () => {
    const s = await sale()
    const spy = jest.spyOn(admission, 'tomarAdmisionCompartida')
    await expect(
      emitRefundCreditNote(
        { venueId, refundPaymentId: s.refund.id, sandbox: true },
        {
          runInTransaction: work =>
            prisma.$transaction(async tx => {
              await tx.payment.update({ where: { id: s.refund.id }, data: { status: 'PENDING' } })
              return work(tx)
            }),
        },
      ),
    ).rejects.toThrow(/no está completado/)
    expect(spy).toHaveBeenCalledWith(expect.anything(), fixture)
    expect(provider.createCreditNote).not.toHaveBeenCalled()
    expect(await prisma.cfdi.count({ where: { idempotencyKey: `cfdi-refund-${s.refund.id}` } })).toBe(0)
  })
  it('fallo de archivos ocurre después de identidad duradera, sin otro timbre al reintentar', async () => {
    const s = await sale()
    provider.downloadXml.mockRejectedValueOnce(new Error('storage offline'))
    expect((await emit(s.refund.id)).status).toBe('STAMPED')
    expect((await note(s.refund.id)).uuid).toBeTruthy()
    expect((await emit(s.refund.id)).status).toBe('STAMPED')
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })
  it.each(['STAMPED', 'CANCELLED', 'VERSION'])('respuesta atrasada no pisa %s', async state => {
    const s = await sale()
    provider.createCreditNote.mockImplementationOnce(async () => {
      const n = await note(s.refund.id)
      await prisma.cfdi.update({
        where: { id: n.id },
        data:
          state === 'VERSION'
            ? { attempts: 2 }
            : state === 'CANCELLED'
              ? { status: 'CANCELLED', cancelStatus: 'ACCEPTED' }
              : { status: 'STAMPED', uuid: 'winner', facturapiId: 'winner' },
      })
      return { ...stamped, uuid: randomUUID() }
    })
    await expect(emit(s.refund.id)).rejects.toThrow(/proces/i)
    const n = await note(s.refund.id)
    if (state === 'VERSION') expect(n.attempts).toBe(2)
    else expect(n.status).toBe(state)
    if (state === 'STAMPED') expect(n.uuid).toBe('winner')
  })
  // D21 (founder, 1-oct, opción A): una nota HEREDADA (sin protocoloIva) en un estado reintentable ya no puede existir. Las ocho
  // pruebas que la fabricaban a partir de un intento incierto (recuperar por identidad, consulta pending/valid sin UUID, reintento
  // STAMP_FAILED, resultado success/failure/pending contra una cancelación, éxito obsoleto sobre un ganador nuevo) se reemplazan
  // por la del rechazo: volverla heredada falla y no queda nada a medias. Las notas nuevas contra una original histórica
  // TIMBRADA siguen probándose abajo («legacy original sin IVA…», «original histórica positiva…»).
  it('una nota incierta ya no puede volverse heredada: la base lo rechaza y la nota queda como estaba', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    const n = await note(s.refund.id)
    expect(n).toMatchObject({ status: 'STAMP_FAILED', falloDefinitivo: false, protocoloIva: 1 })
    await expect(
      prisma.cfdi.update({
        where: { id: n.id },
        data: { protocoloIva: null, entrada: Prisma.DbNull, entradaHuella: null, enviadoAt: null },
      }),
    ).rejects.toThrow(/Cfdi_heredada_solo_terminada/)
    expect(await note(s.refund.id)).toEqual(n)
  })
  it('saldo ignora egreso válido de otra original pero conserva atribución legacy/corrupta', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    await prisma.cfdi.update({ where: { id: s.original.id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    const data = { ...s.original, id: undefined, createdAt: undefined, updatedAt: undefined }
    const newer = await prisma.cfdi.create({
      data: {
        ...data,
        idempotencyKey: randomUUID(),
        uuid: randomUUID(),
        entrada: data.entrada as Prisma.InputJsonValue,
        globalPeriod: Prisma.DbNull,
        // C2 T7: la factura más nueva trae su XML (la nota lo exige, D5); la fila leída trae `JsonValue | null`.
        taxBreakdown: data.taxBreakdown as Prisma.InputJsonValue,
        xmlConceptos: data.xmlConceptos as Prisma.InputJsonValue,
      },
    })
    const r = await refund(s.o.id)
    expect((await getRefundCreditNoteStatus(venueId, r.id))?.eligibility.eligible).toBe(true)
    const n = await note(s.refund.id)
    await prisma.cfdi.update({ where: { id: n.id }, data: { entradaHuella: 'bad' } })
    expect((await getRefundCreditNoteStatus(venueId, r.id))?.eligibility.reason).toBe('EXCEEDS_REMAINING')
    // D21: la nota incierta ya no puede volverse heredada a medias; la atribución heredada se prueba con una heredada TIMBRADA,
    // la única que sigue pudiendo existir (cuenta contra la orden, sin vínculo a una original).
    const heredada = { protocoloIva: null, entrada: Prisma.DbNull, entradaHuella: null }
    await expect(prisma.cfdi.update({ where: { id: n.id }, data: heredada })).rejects.toThrow(/Cfdi_heredada_solo_terminada/)
    await prisma.cfdi.update({
      where: { id: n.id },
      data: { ...heredada, status: 'STAMPED', uuid: randomUUID(), facturapiId: randomUUID() },
    })
    expect((await getRefundCreditNoteStatus(venueId, r.id))?.eligibility.reason).toBe('EXCEEDS_REMAINING')
    expect(newer.id).not.toBe(s.original.id)
  })
  it.each(['money', 'original-item', 'original-tax'])('rechaza snapshot de forma válida pero semántica corrupta: %s', async corrupt => {
    const s = await sale()
    if (corrupt.startsWith('original')) {
      const e = structuredClone(s.original.entrada) as any
      if (corrupt === 'original-item') e.params.items[0].unitPriceCents = null
      else e.params.items[0].taxes[0].rate = 0
      await prisma.cfdi.update({ where: { id: s.original.id }, data: { entrada: e, entradaHuella: huellaDeEntrada(e) } })
      expect((await getRefundCreditNoteStatus(venueId, s.refund.id))?.eligibility.reason).toBe('ORIGINAL_ENTRADA_INVALIDA')
    } else {
      await expect(
        emitRefundCreditNote(
          { venueId, refundPaymentId: s.refund.id, sandbox: true },
          {
            reserveCfdi: async (data, tx = prisma) => {
              const altered = structuredClone(data) as any
              altered.entrada.montos.subtotalCents++
              altered.entrada.montos.taxCents--
              altered.subtotalCents++
              altered.taxCents--
              altered.entradaHuella = huellaDeEntrada(altered.entrada)
              return tx.cfdi.create({ data: altered })
            },
          },
        ),
      ).rejects.toThrow(/soporte/)
    }
    expect(provider.createCreditNote).not.toHaveBeenCalled()
  })
  it.each(['price', 'quantity', 'discount', 'taxIncluded-flipped', 'taxIncluded-missing', 'taxIncluded-string'])(
    'rechaza conceptos originales que contradicen la cabecera: %s',
    async corruption => {
      const s = await sale()
      const e = structuredClone(s.original.entrada) as any
      const item = e.params.items[0]
      if (corruption === 'price') item.unitPriceCents = 1
      if (corruption === 'quantity') item.quantity = 2
      if (corruption === 'discount') item.discountCents = 100
      if (corruption === 'taxIncluded-flipped') item.taxIncluded = false
      if (corruption === 'taxIncluded-missing') delete item.taxIncluded
      if (corruption === 'taxIncluded-string') item.taxIncluded = 'true'
      await prisma.cfdi.update({ where: { id: s.original.id }, data: { entrada: e, entradaHuella: huellaDeEntrada(e) } })
      expect((await getRefundCreditNoteStatus(venueId, s.refund.id))?.eligibility.reason).toBe('ORIGINAL_ENTRADA_INVALIDA')
      await expect(emit(s.refund.id)).rejects.toThrow(/soporte/)
      expect(provider.createCreditNote).not.toHaveBeenCalled()
    },
  )
  it.each([
    { taxIncluded: true, unitPriceCents: 5801, quantity: 2, discountCents: 2, subtotalCents: 10000, taxCents: 1600, totalCents: 11600 },
    { taxIncluded: false, unitPriceCents: 5001, quantity: 2, discountCents: 2, subtotalCents: 10000, taxCents: 1600, totalCents: 11600 },
    { taxIncluded: true, unitPriceCents: 10005, quantity: 0.3, discountCents: 1, subtotalCents: 2587, taxCents: 414, totalCents: 3001 },
    { taxIncluded: false, unitPriceCents: 10005, quantity: 0.3, discountCents: 1, subtotalCents: 3001, taxCents: 480, totalCents: 3481 },
  ])('admite conceptos originales válidos con descuento y redondeo: %j', async example => {
    const s = await sale()
    const e = structuredClone(s.original.entrada) as any
    const { subtotalCents, taxCents, totalCents, ...item } = example
    Object.assign(e.params.items[0], item)
    e.montos = { subtotalCents, taxCents, totalCents }
    // C2 T6: la captura congeló lo facturado de cada artículo del documento ORIGINAL; éste es otro documento, sin esa evidencia.
    delete e.montosPorRenglon
    e.paidCents = totalCents
    await prisma.cfdi.update({
      where: { id: s.original.id },
      // C2 T7 (D5): otro documento, otro XML: el PAC habría timbrado ESTOS conceptos.
      data: { entrada: e, entradaHuella: huellaDeEntrada(e), subtotalCents, taxCents, totalCents, ...conXml(e.params.items) },
    })
    await prisma.payment.update({ where: { id: s.refund.id }, data: { amount: -totalCents / 100 } })
    expect((await getRefundCreditNoteStatus(venueId, s.refund.id))?.eligibility.eligible).toBe(true)
    await emit(s.refund.id)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    expect((await note(s.refund.id)).totalCents).toBe(totalCents)
  })
  it('🔴 C2 T6 ronda 1 (M1): un montosPorRenglon malformado en la original no la anula: la nota por importe sale igual', async () => {
    const s = await sale()
    const e = structuredClone(s.original.entrada) as any
    expect(e.montosPorRenglon).toEqual([expect.objectContaining({ totalCents: 11600 })])
    // Suma de más (11601 en una factura de 11600): ya no es evidencia por artículo, pero la factura sigue siendo la misma.
    e.montosPorRenglon = [{ orderItemId: e.renglones[0].orderItemId, totalCents: 11601, porTratamiento: { IVA_16: 11601 } }]
    await prisma.cfdi.update({ where: { id: s.original.id }, data: { entrada: e, entradaHuella: huellaDeEntrada(e) } })
    expect((await getRefundCreditNoteStatus(venueId, s.refund.id))?.eligibility.eligible).toBe(true)
    expect((await emit(s.refund.id)).status).toBe('STAMPED')
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    expect((await note(s.refund.id)).totalCents).toBe(11600)
  })
  it('CSD inválido guarda intento nunca enviado, corregirlo permite primera versión1', async () => {
    const s = await sale()
    await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { csdStatus: 'EXPIRED' } })
    try {
      expect((await emit(s.refund.id)).status).toBe('VALIDATION_FAILED')
      expect(await note(s.refund.id)).toMatchObject({ attempts: 0, enviadoAt: null, protocoloIva: 1 })
      expect(provider.createCreditNote).not.toHaveBeenCalled()
    } finally {
      await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { csdStatus: 'ACTIVE' } })
    }
    expect((await emit(s.refund.id)).status).toBe('STAMPED')
    expect((await note(s.refund.id)).attempts).toBe(1)
  })
  it('regresión: parcial, propina excluida, receptor original y forma99 fallback', async () => {
    const s = await sale()
    await prisma.payment.update({ where: { id: s.refund.id }, data: { amount: -33.33, tipAmount: -10, method: 'OTHER' } })
    await emit(s.refund.id)
    const n = await note(s.refund.id)
    expect(n.subtotalCents + n.taxCents).toBe(3333)
    expect(n.formaPago).toBe(s.original.formaPago)
    expect(provider.createCreditNote.mock.calls[0][0]).toEqual({
      receptor: {
        rfc: receptor.rfc,
        razonSocial: receptor.razonSocial,
        regimenFiscal: receptor.regimenFiscal,
        codigoPostal: receptor.codigoPostal,
        usoCfdi: 'G02',
      },
      items: [
        {
          satProductKey: '84111506', // C2-P3 (Apéndice 5), dorada que cambia A PROPÓSITO: antes 01010101
          satUnitKey: 'ACT',
          description: `Devolución sobre factura ${s.original.serie}${s.original.folio}`,
          quantity: 1,
          unitPriceCents: 3333,
          discountCents: 0,
          objetoImp: '02',
          taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
          taxIncluded: true,
        },
      ],
      formaPago: s.original.formaPago,
      metodoPago: 'PUE',
      relationship: '01',
      relatedUuids: [s.original.uuid],
      externalId: `cfdi-refund-${s.refund.id}#1`,
      idempotencyKey: `cfdi-refund-${s.refund.id}#1`,
      protocoloIva: 1,
    })
  })
  it('carrera de la misma llave devuelve el ganador STAMPED sin otro envío', async () => {
    const s = await sale()
    const result = await emitRefundCreditNote(
      { venueId, refundPaymentId: s.refund.id, sandbox: true },
      {
        runInTransaction: async work => {
          await emit(s.refund.id)
          return prisma.$transaction(work)
        },
      },
    )
    expect(result.status).toBe('STAMPED')
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })
  it('original histórica positiva sigue al16 sin tasas de catálogo', async () => {
    const s = await sale()
    await prisma.cfdi.update({ where: { id: s.original.id }, data: { protocoloIva: null, entrada: Prisma.DbNull, entradaHuella: null } })
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
    await emit(s.refund.id)
    expect(await note(s.refund.id)).toMatchObject({ subtotalCents: 10000, taxCents: 1600, protocoloIva: 1 })
    expect((await note(s.refund.id)).entrada).not.toHaveProperty('originalSinIvaHistorico')
  })
  it('proveedor sin soporte no reserva ni marca enviado', async () => {
    const s = await sale()
    await expect(
      emitRefundCreditNote({ venueId, refundPaymentId: s.refund.id, sandbox: true }, { resolveProvider: () => ({ name: 'other' }) as any }),
    ).rejects.toThrow(/no soporta/)
    expect(await prisma.cfdi.count({ where: { idempotencyKey: `cfdi-refund-${s.refund.id}` } })).toBe(0)
  })
  // T9 ronda 1, cambio A PROPÓSITO: «consultar» queda atado a la huella de la vista previa (no a un lookupOnly que el catálogo no firma).
  it('MCP: si el intento pasa a rechazado entre los pasos, confirmar «consultar» no recaptura (pide otra vista); con lookupOnly en el paso 1, sólo consulta', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    const call = mcp()
    const preview = await call(s.refund.id)
    expect(preview.confirmationArgs).toMatchObject({ confirm: true, venueId, refundPaymentId: s.refund.id })
    expect(preview.message).toMatch(/consultará/)
    const conLookup = await call(s.refund.id, undefined, { lookupOnly: true })
    expect(conLookup.confirmationArgs).toMatchObject({ lookupOnly: true })
    await prisma.cfdi.update({ where: { id: (await note(s.refund.id)).id }, data: { falloDefinitivo: true } })
    const confirmed = await call(s.refund.id, true, preview.confirmationArgs)
    expect(confirmed).toMatchObject({ ok: false, error: expect.stringMatching(/vista previa/) })
    const soloConsulta = await call(s.refund.id, true, conLookup.confirmationArgs)
    expect(soloConsulta.ok).toBe(false)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    expect((await note(s.refund.id)).attempts).toBe(1)
  })
  // T9 ronda 1, cambio A PROPÓSITO: la confirmación vieja (o sin huella) no hace nada; la vista previa fresca SÍ recaptura (antes, por el
  // catálogo, ese reintento no terminaba nunca).
  it('MCP: una confirmación vieja o sin huella no recaptura; con la vista previa fresca, el reintento sí', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    const call = mcp()
    const vieja = await call(s.refund.id)
    await prisma.cfdi.update({ where: { id: (await note(s.refund.id)).id }, data: { falloDefinitivo: true } })
    expect(await call(s.refund.id, true)).toMatchObject({ ok: false, error: expect.stringMatching(/vista previa/) })
    expect(await call(s.refund.id, true, vieja.confirmationArgs)).toMatchObject({ ok: false, error: expect.stringMatching(/vista previa/) })
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    const fresca = await call(s.refund.id)
    expect(fresca).toMatchObject({ requiresConfirmation: true })
    expect((await call(s.refund.id, true, fresca.confirmationArgs)).ok).toBe(true)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(2)
  })

  // ─── C2 · Tarea 9: «acreditar por importe» (P10; Codex C2-16) ───────────────
  /** La venta mezclada con su factura SIN `montosPorRenglon` (como una factura de antes de la T6): por artículos no hay evidencia. */
  async function ventaMixtaSinEvidencia() {
    const v = await ventaMixta()
    const e = structuredClone(v.original.entrada) as any
    expect(e.montosPorRenglon).toHaveLength(2)
    delete e.montosPorRenglon
    await prisma.cfdi.update({ where: { id: v.original.id }, data: { entrada: e, entradaHuella: huellaDeEntrada(e) } })
    return v
  }
  /** La ruta real del dashboard (GET y POST de la nota), con la validación del body como en `dashboard.routes.ts`. */
  function dashboard(userId: string) {
    const app = express()
    app.use(express.json())
    const auth = (req: any, _res: any, next: any) => {
      req.authContext = { venueId, userId }
      next()
    }
    app.get('/venues/:venueId/refunds/:refundId/credit-note', auth, getRefundCreditNoteController)
    app.post(
      '/venues/:venueId/refunds/:refundId/credit-note',
      auth,
      validateRequest(emitRefundCreditNoteSchema),
      emitRefundCreditNoteController,
      // validateRequest pasa sus errores con next(err): el manejador de errores de la app los vuelve 400.
    )
    app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ error: err.message }))
    return {
      ver: (id: string) => request(app).get(`/venues/${venueId}/refunds/${id}/credit-note`),
      emitir: (id: string, body?: Record<string, unknown>) =>
        body
          ? request(app).post(`/venues/${venueId}/refunds/${id}/credit-note`).send(body)
          : request(app).post(`/venues/${venueId}/refunds/${id}/credit-note`),
    }
  }
  /** Un ajuste de la plataforma de entregas (su reparto congelado, todo al 0 %): cambia la PROPORCIÓN de lo que queda por acreditar. */
  async function ajusteDeEntregasAl0(orderId: string, cents: number) {
    return prisma.payment.create({
      data: {
        venueId,
        orderId,
        type: 'REFUND',
        amount: -cents / 100,
        tipAmount: 0,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -cents / 100,
        method: 'CASH',
        status: 'COMPLETED',
        processorData: {
          provenance: 'PROVIDER_ADJUSTMENT',
          fiscalByRateCents: { v: 2, porTratamiento: { IVA_0: { baseCents: cents, ivaCents: 0 } } },
        },
      },
    })
  }
  const notaDe = (id: string) => prisma.cfdi.findUnique({ where: { idempotencyKey: `cfdi-refund-${id}` } })
  /** La bitácora de la nota (en integración `logAction` es un doble: se lee lo que recibió). */
  const bitacoraDe = (cfdiId: string) =>
    jest
      .mocked(logAction)
      .mock.calls.map(c => c[0] as any)
      .find(x => x.action === 'CFDI_CREDIT_NOTE_ISSUED' && x.entityId === cfdiId)
  it('🔴 C2 T9 de punta a punta: sin montosPorRenglon, por artículos se detiene y se ofrece «por importe»; sin huella 400, con la vieja 409 sin reservar, con la vigente STAMPED con quién la eligió', async () => {
    const v = await ventaMixtaSinEvidencia()
    const r1 = await refundArticulos(v.o.id, [{ id: v.pan.id, cents: 5800, nombre: 'Pan' }])
    const d = dashboard(`staff-${fixture}`)
    // La vista previa: por artículos no hay evidencia; se ofrece la alternativa con su reparto y su huella.
    const g1 = await d.ver(r1.id)
    expect(g1.status).toBe(200)
    expect(g1.body.eligibility).toMatchObject({ eligible: false, reason: 'SIN_MONTO_POR_ARTICULO' })
    const alt1 = g1.body.preview.alternativa
    expect(alt1).toMatchObject({ modalidad: 'POR_IMPORTE', huella: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(alt1.desglose.map((x: any) => x.tratamiento).sort()).toEqual(['IVA_0', 'IVA_16'])
    expect(alt1.desglose.reduce((s: number, x: any) => s + x.cents, 0)).toBe(5800)
    // Sin elegir: se detiene (nunca cambia en silencio de modalidad).
    const sinElegir = await d.emitir(r1.id)
    expect(sinElegir.status).toBe(409)
    expect(sinElegir.body.error).toMatch(/no registró cuánto se facturó/)
    // Eligiendo sin huella: 400, sin reservar.
    const sinHuella = await d.emitir(r1.id, { modalidad: 'POR_IMPORTE' })
    expect(sinHuella.status).toBe(400)
    expect(sinHuella.body.error).toBe(MOTIVO_FALTA_LA_HUELLA)
    // Una modalidad inventada no pasa la validación del body.
    expect((await d.emitir(r1.id, { modalidad: 'REGALO', huella: alt1.huella })).status).toBe(400)
    expect(await notaDe(r1.id)).toBeNull()
    // Entre la vista previa y el POST se timbra OTRA nota (un ajuste de entregas todo al 0 %): cambia lo que queda y su proporción.
    const r2 = await ajusteDeEntregasAl0(v.o.id, 10000)
    expect((await d.emitir(r2.id)).status).toBe(201)
    const vieja = await d.emitir(r1.id, { modalidad: 'POR_IMPORTE', huella: alt1.huella })
    expect(vieja.status).toBe(409)
    expect(vieja.body.error).toBe(MOTIVO_REPARTO_CAMBIO)
    expect(await notaDe(r1.id)).toBeNull() // no reservó
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    // La vista previa de nuevo: otro reparto, otra huella; con ésa sale.
    const alt2 = (await d.ver(r1.id)).body.preview.alternativa
    expect(alt2.huella).not.toBe(alt1.huella)
    expect(alt2.desglose).not.toEqual(alt1.desglose)
    const ok = await d.emitir(r1.id, { modalidad: 'POR_IMPORTE', huella: alt2.huella })
    expect(ok.status).toBe(201)
    const n1 = (await notaDe(r1.id))!
    expect(n1).toMatchObject({ status: 'STAMPED', totalCents: 5800 })
    expect(n1.entrada).toMatchObject({
      version: 2,
      modalidad: 'POR_IMPORTE_ELEGIDO',
      elegidoPor: `staff-${fixture}`,
      devueltoCents: 5800,
      porTratamiento: Object.fromEntries(
        alt2.desglose.map((x: any) => [x.tratamiento, { baseCents: x.baseCents, ivaCents: x.ivaCents, totalCents: x.cents }]),
      ),
    })
    expect((n1.entrada as any).porRenglon).toBeUndefined()
    expect(provider.createCreditNote.mock.calls[1][0].items.map((i: any) => [i.unitPriceCents, i.taxes[0]?.rate]).sort()).toEqual(
      alt2.desglose.map((x: any) => [x.cents, x.tratamiento === 'IVA_16' ? 0.16 : 0]).sort(),
    )
    // La bitácora lo dice: la modalidad elegida y quién la eligió.
    expect(bitacoraDe(n1.id)?.data).toMatchObject({ modalidad: 'POR_IMPORTE_ELEGIDO', elegidoPor: `staff-${fixture}` })
  })
  // C2 · T10 ronda 1 (M9): la emisión NORMAL también ata la vista previa. El panel manda `{ huella }` (sin modalidad); bajo los candados, si
  // lo que se timbraría ya no es lo que se vio (otra nota de la misma factura en medio), 409 sin reservar. Sin body, como siempre.
  it('🔴 T10 ronda 1 (M9): por importe normal ⇒ la vista previa da `preview.huella`; con la vieja 409 «La factura cambió…» sin reservar; con la vigente 201', async () => {
    const v = await ventaMixta()
    const r1 = await refund(v.o.id, 58) // sin artículos: por importe, en proporción a lo que QUEDA de cada tasa
    const d = dashboard(`staff-${fixture}`)
    const g1 = await d.ver(r1.id)
    expect(g1.body.eligibility.eligible).toBe(true)
    const h1 = g1.body.preview.huella
    expect(h1).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/))
    // Entre la vista previa y el POST se timbra OTRA nota (un ajuste de entregas todo al 0 %): cambia la proporción de lo que queda.
    const r2 = await ajusteDeEntregasAl0(v.o.id, 10000)
    expect((await d.emitir(r2.id)).status).toBe(201)
    const vieja = await d.emitir(r1.id, { huella: h1 })
    expect(vieja.status).toBe(409)
    expect(vieja.body.error).toBe(MOTIVO_NOTA_CAMBIO)
    expect(await notaDe(r1.id)).toBeNull() // no reservó
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    const g2 = await d.ver(r1.id)
    expect(g2.body.preview.huella).not.toBe(h1)
    const ok = await d.emitir(r1.id, { huella: g2.body.preview.huella })
    expect(ok.status).toBe(201)
    expect((await notaDe(r1.id))!.entrada).toMatchObject({ devueltoCents: 5800 })
  })
  it('control — T10 ronda 1 (M9): sin huella (cliente viejo) la emisión normal sale como siempre', async () => {
    const v = await ventaMixta()
    const r1 = await refund(v.o.id, 58)
    const d = dashboard(`staff-${fixture}`)
    expect((await d.emitir(r1.id)).status).toBe(201)
  })
  it('🔴 C2 T9: con evidencia por artículo, elegir «por importe» se rechaza (409) y no reserva; por artículos sale como siempre', async () => {
    const v = await ventaMixta()
    const r = await refundArticulos(v.o.id, [{ id: v.pan.id, cents: 5800, nombre: 'Pan' }])
    const d = dashboard(`staff-${fixture}`)
    const g = await d.ver(r.id)
    expect(g.body.eligibility.eligible).toBe(true)
    expect(g.body.preview.alternativa).toBeUndefined()
    const elegido = await d.emitir(r.id, { modalidad: 'POR_IMPORTE', huella: 'f'.repeat(64) })
    expect(elegido.status).toBe(409)
    expect(elegido.body.error).toMatch(/sólo se puede elegir cuando no hay forma de comprobar/)
    expect(await notaDe(r.id)).toBeNull()
    expect((await d.emitir(r.id)).status).toBe(201)
    expect((await notaDe(r.id))!.entrada).toMatchObject({ modalidad: 'POR_ARTICULOS' })
  })
  it('🔴 C2 T9 por el MCP real: la vista previa «por importe» da el reparto y la huella; con confirm emite la ELEGIDA con quién la eligió', async () => {
    const v = await ventaMixtaSinEvidencia()
    const r = await refundArticulos(v.o.id, [{ id: v.pan.id, cents: 5800, nombre: 'Pan' }])
    const call = mcp()
    const sin = await call(r.id)
    expect(sin).toMatchObject({ ok: false, reason: 'SIN_MONTO_POR_ARTICULO', alternativa: { modalidad: 'POR_IMPORTE', importeMxn: 58 } })
    const vista = await call(r.id, undefined, { modalidad: 'POR_IMPORTE' })
    expect(vista).toMatchObject({ requiresConfirmation: true, expectedSourceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(provider.createCreditNote).not.toHaveBeenCalled()
    expect((await call(r.id, true, vista.confirmationArgs)).ok).toBe(true)
    expect((await notaDe(r.id))!.entrada).toMatchObject({ modalidad: 'POR_IMPORTE_ELEGIDO', elegidoPor: 'test-staff' })
  })

  // ─── C2 · Tarea 9, ronda 1 (I-1): la cortesía D9 por su RENGLÓN, también en una factura SIN montos ───
  it('🔴 C2 T9 ronda 1 (I-1): factura SIN montos y una galleta de cortesía devuelta por artículos ⇒ «por importe» con el aviso que la nombra', async () => {
    const o = await prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        subtotal: 258,
        taxAmount: 0,
        total: 258,
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        items: {
          create: [
            { productId: cafeId, productName: 'Café', quantity: 1, unitPrice: 200, taxAmount: 0, total: 200 },
            { productId, productName: 'Pan', quantity: 1, unitPrice: 58, taxAmount: 0, total: 58 },
            // La cortesía de la terminal: el descuento es el total (D9 la deja fuera de la factura).
            {
              productId,
              productName: 'Galleta',
              quantity: 1,
              unitPrice: 10,
              taxAmount: 0,
              total: 10,
              discountAmount: 10,
              isCortesia: true,
            },
          ],
        },
        payments: { create: { venueId, amount: 258, feePercentage: 0, feeAmount: 0, netAmount: 258, method: 'CASH', status: 'COMPLETED' } },
      },
      include: { items: true },
    })
    await issue(o.id)
    const original = await row(o.id)
    expect(original.totalCents).toBe(25800) // la galleta no entró
    const e = structuredClone(original.entrada) as any
    delete e.montosPorRenglon // una factura de antes de C2
    await prisma.cfdi.update({ where: { id: original.id }, data: { entrada: e, entradaHuella: huellaDeEntrada(e) } })
    const pan = o.items.find(i => i.productName === 'Pan')!
    const galleta = o.items.find(i => i.productName === 'Galleta')!
    // El escritor de devoluciones regresa el BRUTO de la galleta (el defecto preexistente); el nombre NO viaja en el reembolso.
    const r = await refundArticulos(o.id, [
      { id: pan.id, cents: 5800, nombre: 'Pan' },
      { id: galleta.id, cents: 1000, nombre: '' },
    ])
    const st = await getRefundCreditNoteStatus(venueId, r.id)
    expect(st?.eligibility.reason).toBe('SIN_MONTO_POR_ARTICULO')
    expect(st?.preview?.alternativa?.aviso).toEqual(expect.stringContaining('«Galleta» no aparece en la factura'))
    expect(st?.preview?.alternativa?.aviso).toContain('($10.00)')
    expect(st?.preview?.alternativa?.aviso).not.toContain('Pan')
  })

  // C2 A-1 (decisión A del founder, 9-oct): la devolución por artículos regresa lo COBRADO. Sobre Postgres real: café $200 al 0 % + pan
  // $58 al 16 % con un descuento de CUENTA de $25.80 repartido 10 % / 10 % (D7). Devolver el pan por el escritor real regresa $52.20, no
  // $58, y su nota por artículos SÍ sale. Con el bruto, el escritor devolvía $58 y la nota se detenía con ARTICULO_EXCEDE_LO_FACTURADO
  // ($58 > $52.20 facturados del pan).
  it('🔴 C2 A-1: devolver por artículos un renglón con descuento de cuenta regresa lo cobrado ($52.20) y su nota por artículos SÍ sale', async () => {
    const o = await prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        subtotal: 258,
        discountAmount: 25.8,
        taxAmount: 0,
        total: 232.2,
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        items: {
          create: [
            { productId: cafeId, productName: 'Café', quantity: 1, unitPrice: 200, taxAmount: 0, total: 200 },
            { productId, productName: 'Pan', quantity: 1, unitPrice: 58, taxAmount: 0, total: 58 },
          ],
        },
        payments: {
          create: { venueId, amount: 232.2, feePercentage: 0, feeAmount: 0, netAmount: 232.2, method: 'CASH', status: 'COMPLETED' },
        },
      },
      include: { items: true, payments: true },
    })
    const cafe = o.items.find(i => i.productId === cafeId)!
    const pan = o.items.find(i => i.productId === productId)!
    await prisma.orderDiscount.create({
      data: {
        orderId: o.id,
        type: 'PERCENTAGE',
        name: '10 % en la cuenta',
        value: 10,
        amount: 25.8,
        reparto: { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { [cafe.id]: 2000, [pan.id]: 580 } },
      },
    })
    await issue(o.id)
    const original = await row(o.id)
    expect(original.status).toBe('STAMPED')

    const r = await issueRefund({ venueId, paymentId: o.payments[0].id, items: [{ orderItemId: pan.id }], reason: 'RETURNED_GOODS' })

    expect(r).toMatchObject({ amount: 52.2, remainingRefundable: 180, status: 'COMPLETED' })
    const fila = await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })
    expect(fila.amount.toString()).toBe('-52.2')
    expect(fila.tipAmount.toString()).toBe('0')
    expect((fila.processorData as any).refundedItems).toEqual([
      expect.objectContaining({ orderItemId: pan.id, quantity: 1, amountCents: 5220, amount: 52.2 }),
    ])

    const res = await emit(r.refundId)
    expect(res.status).toBe('STAMPED')
    expect(provider.createCreditNote.mock.calls[0][0].items).toEqual([
      expect.objectContaining({ unitPriceCents: 5220, taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }] }),
    ])
    expect((await note(r.refundId)).entrada).toMatchObject({
      modalidad: 'POR_ARTICULOS',
      porRenglon: [{ orderItemId: pan.id, totalCents: 5220, porTratamiento: { IVA_16: 5220 } }],
    })
  })

  // C2 A-1 ronda 1 (I1): en una cuenta DIVIDIDA lo ya devuelto de un artículo se cuenta sobre TODA la orden. Sobre Postgres real (la
  // lectura de las devoluciones de la orden es SQL crudo): A $100 + B $100 pagada en dos cobros de $100. A por el cobro 1 ⇒ $100; A otra
  // vez por el cobro 2 ⇒ 400 y nada escrito; B por el cobro 2 ⇒ $100.
  it('🔴 C2 A-1 ronda 1: cuenta dividida en dos cobros ⇒ un artículo se devuelve UNA vez en toda la orden', async () => {
    const pago = {
      venueId,
      amount: 100,
      feePercentage: 0,
      feeAmount: 0,
      netAmount: 100,
      method: 'CASH' as const,
      status: 'COMPLETED' as const,
    }
    const o = await prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        subtotal: 200,
        taxAmount: 0,
        total: 200,
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        items: {
          create: [
            { productId, productName: 'A', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 },
            { productId, productName: 'B', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 },
          ],
        },
        payments: { create: [pago, pago] },
      },
      include: { items: true, payments: { orderBy: { id: 'asc' } } },
    })
    const [p1, p2] = o.payments
    const a = o.items.find(i => i.productName === 'A')!
    const b = o.items.find(i => i.productName === 'B')!
    const devolver = (paymentId: string, orderItemId: string) =>
      issueRefund({ venueId, paymentId, items: [{ orderItemId }], reason: 'RETURNED_GOODS' })

    expect((await devolver(p1.id, a.id)).amount).toBe(100)
    await expect(devolver(p2.id, a.id)).rejects.toThrow(
      'Este artículo («A») ya se devolvió en otro cobro de la misma cuenta; quedan 0 de 1 por devolver.',
    )
    expect((await devolver(p2.id, b.id)).amount).toBe(100)
    const devoluciones = await prisma.payment.findMany({ where: { orderId: o.id, type: 'REFUND' }, select: { amount: true } })
    expect(devoluciones.map(d => d.amount.toString()).sort()).toEqual(['-100', '-100'])
  })
})
