// tests/integration/fiscal/confirmarContratoDePrecio.mavericks.test.ts
//
// IVA por producto, B3b — el caso Mavericks DE PUNTA A PUNTA contra Postgres (Codex, código r1, P2 #5).
//
// Testarudo no pudo refacturar a Mavericks su «GRN TURISMO 2 KG» (café en grano, IVA 0 %): $6,040 de lista con
// $2,958 de descuento, cobrados $3,082. Es una venta VIEJA (contrato de precio DESCONOCIDO), así que «Facturar» se
// bloquea hasta que alguien confirme que el precio ya incluía IVA. Las otras pruebas cubren las piezas por
// separado (la unitaria arranca con el contrato ya confirmado; la integración de confirmarContratoDePrecio.test.ts
// usa una cabecera sin renglones y nunca factura). Ésta recorre el camino real, con los controladores y servicios
// de verdad y la base de verdad:
//
//   facturar ⇒ 422 con la fila de CFDI fallida y la vista previa (`priceContract`)
//   ⇒ confirmar con su versión y huella (200, ActivityLog en la misma transacción)
//   ⇒ facturar otra vez ⇒ STAMPED: UN concepto al 0 %, descuento de 295800 centavos y total de 308200.
//
// Sólo el PAC va simulado (`resolveFiscalProvider`). Sus archivos (XML/PDF) se dejan fallar a propósito: son
// best-effort después del timbre y así la prueba nunca toca el almacenamiento.
import { randomUUID } from 'crypto'
import type { Request, Response } from 'express'
import prisma from '@/utils/prismaClient'
import { encenderIvaPorProducto } from '../../__helpers__/iva-por-producto'

const provider = {
  name: 'facturapi',
  createInvoice: jest.fn(),
  findByExternalId: jest.fn(),
  getInvoice: jest.fn(),
  downloadXml: jest.fn(),
  downloadPdf: jest.fn(),
}
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({
  ...jest.requireActual('@/services/fiscal/fiscalProvider.factory'),
  resolveFiscalProvider: jest.fn(() => provider),
}))

import { issueCfdiForOrderController, confirmOrderPriceContractController } from '@/controllers/dashboard/cfdi.dashboard.controller'
import { MOTIVO_CONTRATO_DESCONOCIDO } from '@/services/fiscal/cfdi.service'

const TASA_0 = [{ type: 'IVA', factor: 'Tasa', rate: 0, withholding: false }]
const RECEPTOR = { rfc: 'EKU9003173C9', razonSocial: 'ESCUELA KEMPER URGATE', regimenFiscal: '601', codigoPostal: '64000', usoCfdi: 'G03' }

describe('caso Mavericks de punta a punta (integración): 422 → confirmar → facturar', () => {
  beforeAll(() => {
    const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '')
    expect(['localhost', '127.0.0.1']).toContain(url.hostname)
    expect(url.pathname).toMatch(/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_|av_db_25_iva_test)/)
  })

  const fixture = `mavericks-${randomUUID().slice(0, 8)}`
  let venueId: string
  let staffId: string
  let productId: string
  let fiscalEmisorId: string

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
    venueId = (await prisma.venue.create({ data: { id: fixture, organizationId: fixture, name: fixture, slug: fixture } })).id
    // Un negocio con IVA por producto encendido (sin la bandera, el trigger de Product rechaza una tasa ≠ 16 %).
    await encenderIvaPorProducto(venueId)
    staffId = (await prisma.staff.create({ data: { email: `${fixture}@staff.test`, firstName: 'Dueña', lastName: 'Testarudo' } })).id
    const category = await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })
    productId = (
      await prisma.product.create({ data: { venueId, categoryId: category.id, name: 'GRN TURISMO 2 KG', sku: fixture, price: 6040 } })
    ).id
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
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

  beforeEach(() => {
    provider.createInvoice.mockReset().mockResolvedValue({
      providerInvoiceId: `pac-${randomUUID()}`,
      uuid: randomUUID(),
      serie: 'F',
      folio: '1',
      totalCents: 308200,
      stampedAt: new Date(),
      status: 'valid',
    })
    provider.findByExternalId.mockReset().mockResolvedValue(null)
    provider.getInvoice.mockReset()
    provider.downloadXml.mockReset().mockRejectedValue(new Error('sin archivos en la prueba'))
    provider.downloadPdf.mockReset().mockRejectedValue(new Error('sin archivos en la prueba'))
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
    await prisma.staff.deleteMany({ where: { id: staffId } })
    await prisma.organization.deleteMany({ where: { id: fixture } })
    await prisma.$disconnect()
  })

  /** Lo que un controlador recibe tras `authenticateToken` + `validateRequest` (ya probados en sus propias pruebas). */
  function peticion(orderId: string, body: Record<string, unknown>): Request {
    return { params: { venueId, orderId }, body, headers: {}, authContext: { userId: staffId, venueId, role: 'OWNER' } } as any
  }

  function respuesta() {
    const res: any = {}
    res.status = jest.fn(() => res)
    res.json = jest.fn(() => res)
    return res as Response & { status: jest.Mock; json: jest.Mock }
  }

  it('la venta vieja se bloquea con la vista previa, se confirma y se factura: UN concepto al 0 %, $2,958 de descuento, $3,082', async () => {
    // La venta vieja de Testarudo: contrato DESCONOCIDO (el default), sin IVA separado, pagada en efectivo.
    const orden = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `${fixture}-mav`,
        subtotal: 6040,
        taxAmount: 0,
        discountAmount: 2958,
        total: 3082,
        source: 'TPV',
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        paidAmount: 3082,
        items: {
          create: { productId, productName: 'GRN TURISMO 2 KG', quantity: 1, unitPrice: 6040, taxAmount: 0, total: 6040 },
        },
        payments: {
          create: { venueId, amount: 3082, feePercentage: 0, feeAmount: 0, netAmount: 3082, method: 'CASH', status: 'COMPLETED' },
        },
      },
    })
    expect(orden.contratoDePrecio).toBe('DESCONOCIDO')

    // 1. Facturar ⇒ 422: el motivo pide confirmar el contrato, queda la fila de CFDI fallida y llega la vista previa.
    const r1 = respuesta()
    await issueCfdiForOrderController(peticion(orden.id, RECEPTOR), r1)
    expect(r1.status).toHaveBeenCalledWith(422)
    const cuerpo422 = r1.json.mock.calls[0][0]
    expect(cuerpo422).toMatchObject({ error: 'No se pudo facturar', reasons: [MOTIVO_CONTRATO_DESCONOCIDO] })
    expect(cuerpo422.cfdiId).toEqual(expect.any(String))
    const fallida = await prisma.cfdi.findUniqueOrThrow({ where: { id: cuerpo422.cfdiId } })
    expect(fallida).toMatchObject({ orderId: orden.id, venueId, status: 'VALIDATION_FAILED' })
    expect(cuerpo422.priceContract).toMatchObject({
      orderId: orden.id,
      confirmable: true,
      contratoActual: 'DESCONOCIDO',
      totalMxn: 3082,
      version: orden.version,
    })
    expect(cuerpo422.priceContract.huella).toMatch(/^[0-9a-f]{64}$/)
    expect(provider.createInvoice).not.toHaveBeenCalled()

    // 2. Confirmar con la versión y la huella que trajo el 422 ⇒ 200, contrato IVA_INCLUIDO y su ActivityLog.
    const r2 = respuesta()
    await confirmOrderPriceContractController(
      peticion(orden.id, { version: cuerpo422.priceContract.version, huella: cuerpo422.priceContract.huella }),
      r2,
    )
    expect(r2.status).toHaveBeenCalledWith(200)
    expect(r2.json).toHaveBeenCalledWith({ ok: true })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orden.id } })).toMatchObject({
      contratoDePrecio: 'IVA_INCLUIDO',
      version: orden.version + 1,
    })
    const bitacora = await prisma.activityLog.findMany({ where: { action: 'ORDER_PRICE_CONTRACT_CONFIRMED', entityId: orden.id } })
    expect(bitacora).toHaveLength(1)
    expect(bitacora[0]).toMatchObject({ staffId, venueId, entity: 'Order' })
    expect(bitacora[0].data).toMatchObject({
      antes: 'DESCONOCIDO',
      despues: 'IVA_INCLUIDO',
      motivo: 'Confirmado desde el dashboard al facturar',
      version: orden.version,
      orderNumber: orden.orderNumber,
      total: 3082,
      paidAmount: 3082,
    })

    // 3. Facturar otra vez (sólo el PAC simulado) ⇒ STAMPED con UN concepto al 0 %, IVA incluido.
    const r3 = respuesta()
    await issueCfdiForOrderController(peticion(orden.id, RECEPTOR), r3)
    expect(r3.status).toHaveBeenCalledWith(201)
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    const alPac = provider.createInvoice.mock.calls[0][0]
    expect(alPac.items).toHaveLength(1)
    expect(alPac.items[0]).toMatchObject({
      description: 'GRN TURISMO 2 KG',
      objetoImp: '02',
      taxes: TASA_0,
      taxIncluded: true,
      unitPriceCents: 604000,
      discountCents: 295800,
    })
    const timbrada = await prisma.cfdi.findUniqueOrThrow({ where: { id: r3.json.mock.calls[0][0].cfdi.id } })
    expect(timbrada).toMatchObject({ orderId: orden.id, status: 'STAMPED', subtotalCents: 308200, taxCents: 0, totalCents: 308200 })
  })
})
