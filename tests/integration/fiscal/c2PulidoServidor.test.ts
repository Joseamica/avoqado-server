// C2-pulido (guía de Facturación, 10-oct), contra una base real:
//  · G7: el filtro de la lista separa el timbre EN DUDA de «Con error» DENTRO del `where` (semántica de NULL de Postgres, página y total).
//  · G1/m-2: con la factura de la venta EN DUDA, el GET público ya no ofrece el formulario (`TIMBRE_EN_DUDA`), ni con una devolución.
//  · G2 → C3 (Ruling G2, dorada que cambia A PROPÓSITO): el ticket en una global VIVA SE OFRECE (el POST decide, sacándolo de la global); no
//    se ofrece si su extracción se canceló o quedó sin su global.
// Sólo el PAC es de mentira.
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
import prisma from '@/utils/prismaClient'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import { listCfdisForVenue } from '@/services/fiscal/cfdi.service'
import { autofacturaController, getAutofacturaStatusController } from '@/controllers/public/cfdi.public.controller'
import { encenderIvaPorProducto } from '../../__helpers__/iva-por-producto'

const { isDisposableH1Url } = require('../../../scripts/h1-test-database.cjs')
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
// Sólo una base local desechable (`avoqado_<tarea>_test_<fecha>` o una H1 validada); nunca otra.
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !(isDisposableH1Url(database) || /^\/avoqado_[a-z0-9]+_test_[0-9]+$/.test(database.pathname))
) {
  throw new Error('Esta suite exige una base local desechable (avoqado_<tarea>_test_<fecha>).')
}

const NEUTRO = 'Esta cuenta no se puede facturar en línea. Pide tu factura directamente al negocio.'
const receptor = { rfc: 'EKU9003173C9', razonSocial: 'ESCUELA KEMPER URGATE', regimenFiscal: '601', codigoPostal: '64000', usoCfdi: 'G03' }

describe('C2-pulido · servidor (base real)', () => {
  const fixture = `c2p-${randomUUID()}`
  let venueId: string
  let productId: string
  let fiscalEmisorId: string
  const provider = {
    name: 'facturapi',
    createInvoice: jest.fn(),
    findByExternalId: jest.fn(),
    getInvoice: jest.fn(),
    downloadXml: jest.fn(),
    downloadPdf: jest.fn(),
  }
  const respuesta = () => {
    const r: any = { status: jest.fn(() => r), json: jest.fn(() => r) }
    return r
  }

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
    venueId = (await prisma.venue.create({ data: { id: fixture, organizationId: fixture, name: fixture, slug: fixture } })).id
    await encenderIvaPorProducto(venueId)
    const category = await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })
    productId = (await prisma.product.create({ data: { venueId, categoryId: category.id, name: fixture, sku: fixture, price: 116 } })).id
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
    jest.clearAllMocks()
    ;(resolveFiscalProvider as jest.Mock).mockReturnValue(provider)
    provider.findByExternalId.mockReset().mockResolvedValue(null)
  })
  afterAll(async () => {
    if (!venueId) return
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.cfdiGlobalOrden.deleteMany({ where: { cfdi: { venueId } } })
    await prisma.orderItemSelloIva.deleteMany({ where: { cfdi: { venueId } } })
    await prisma.cfdi.deleteMany({ where: { venueId } })
    await prisma.digitalReceipt.deleteMany({ where: { payment: { venueId } } })
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

  /** Una venta de $116 cobrada con la terminal del comercio, con su recibo (la llave del QR). */
  async function venta() {
    const o = await prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        subtotal: 116,
        taxAmount: 0,
        total: 116,
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        items: { create: { productId, productName: 'Producto', quantity: 1, unitPrice: 116, taxAmount: 0, total: 116 } },
        payments: {
          create: {
            venueId,
            amount: 116,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: 116,
            method: 'CREDIT_CARD',
            status: 'COMPLETED',
            merchantAccountId: fixture,
          },
        },
      },
      include: { payments: true },
    })
    const recibo = await prisma.digitalReceipt.create({ data: { paymentId: o.payments[0].id, dataSnapshot: {} } })
    return { orderId: o.id, accessKey: recibo.accessKey }
  }
  /** Una fila `Cfdi` del negocio (protocolo 1, como nace toda reserva desde D21). */
  const factura = (extra: Record<string, unknown>) =>
    prisma.cfdi.create({
      data: {
        venueId,
        fiscalEmisorId,
        flow: 'AUTOFACTURA_A',
        receptorRfc: receptor.rfc,
        receptorNombre: receptor.razonSocial,
        receptorRegimen: receptor.regimenFiscal,
        receptorCp: receptor.codigoPostal,
        usoCfdi: receptor.usoCfdi,
        formaPago: '04',
        metodoPago: 'PUE',
        subtotalCents: 10000,
        taxCents: 1600,
        totalCents: 11600,
        protocoloIva: 1,
        ...extra,
      } as any,
    })
  const enviada = new Date()
  async function get(accessKey: string) {
    const r = respuesta()
    await getAutofacturaStatusController({ params: { accessKey } } as any, r)
    return r.json.mock.calls[0][0]
  }
  async function post(accessKey: string) {
    const r = respuesta()
    await autofacturaController({ params: { accessKey }, body: receptor } as any, r)
    return { status: r.status.mock.calls[0]?.[0], body: r.json.mock.calls[0]?.[0] }
  }

  describe('G7 — la lista: «Con error» sin los timbres en duda', () => {
    const ids: Record<string, string> = {}
    beforeAll(async () => {
      const filas: Array<[string, Record<string, unknown>]> = [
        ['rechazada', { status: 'STAMP_FAILED', enviadoAt: enviada, falloDefinitivo: true }],
        ['sin-enviar', { status: 'STAMP_FAILED', enviadoAt: null, falloDefinitivo: false }],
        ['en-duda', { status: 'STAMP_FAILED', enviadoAt: enviada, falloDefinitivo: false }],
        ['validacion', { status: 'VALIDATION_FAILED' }],
        ['timbrando', { status: 'STAMPING' }],
        ['timbrada', { status: 'STAMPED', stampedAt: enviada, uuid: randomUUID() }],
      ]
      for (const [nombre, extra] of filas) ids[(await factura({ flow: 'STAFF_B', ...extra })).id] = nombre
    })
    const lista = async (status: any, extra: Record<string, unknown> = {}) => {
      const r = await listCfdisForVenue({ venueId, status, page: 1, pageSize: 20, ...extra })
      return {
        nombres: (r.cfdis as any[])
          .map(c => ids[c.id])
          .filter(Boolean)
          .sort(),
        total: r.total,
      }
    }

    it('🔴 «Con error» (VALIDATION_FAILED, STAMP_FAILED) ⇒ rechazada, sin-enviar y validación; la en duda NO; el total cuadra', async () => {
      expect(await lista(['VALIDATION_FAILED', 'STAMP_FAILED'])).toEqual({ nombres: ['rechazada', 'sin-enviar', 'validacion'], total: 3 })
    })
    it('🔴 «En proceso» con `STAMP_IN_DOUBT` ⇒ la que timbra y la en duda', async () => {
      expect(await lista(['DRAFT', 'VALIDATING', 'STAMPING', 'STAMP_IN_DOUBT'])).toEqual({ nombres: ['en-duda', 'timbrando'], total: 2 })
    })
    it('🔴 con el rango de fechas del día y página 2 de 2 ⇒ el total sigue siendo 3 y la página trae 1', async () => {
      const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date())
      const r = await listCfdisForVenue({
        venueId,
        status: ['VALIDATION_FAILED', 'STAMP_FAILED'],
        from: hoy,
        to: hoy,
        page: 2,
        pageSize: 2,
        venueTimezone: 'America/Mexico_City',
      })
      expect(r.total).toBe(3)
      expect(r.cfdis).toHaveLength(1)
      expect(ids[(r.cfdis as any[])[0].id]).toBeDefined()
    })
    it('control — los dos valores juntos ⇒ todas las STAMP_FAILED, como antes', async () => {
      expect(await lista(['STAMP_FAILED', 'STAMP_IN_DOUBT'])).toEqual({ nombres: ['en-duda', 'rechazada', 'sin-enviar'], total: 3 })
    })
  })

  describe('G1 / m-2 — el GET público con la factura de la venta EN DUDA', () => {
    it('🔴 G1: en duda ⇒ no disponible con `TIMBRE_EN_DUDA` (no se vuelve a ofrecer el formulario); las columnas internas no viajan', async () => {
      const { orderId, accessKey } = await venta()
      await factura({
        orderId,
        idempotencyKey: `cfdi-order-${orderId}`,
        status: 'STAMP_FAILED',
        enviadoAt: enviada,
        falloDefinitivo: false,
      })
      const estado = await get(accessKey)
      expect(estado).toMatchObject({ autofacturaAvailable: false, autofacturaUnavailable: { kind: 'TIMBRE_EN_DUDA' } })
      expect(estado.cfdi).toEqual(expect.objectContaining({ status: 'STAMP_FAILED' }))
      for (const interna of ['enviadoAt', 'falloDefinitivo', 'protocoloIva', 'cancelStatus', 'replacesCfdiId'])
        expect(estado.cfdi).not.toHaveProperty(interna)
    })

    it('🔴 m-2: en duda y una devolución que entró después ⇒ el GET sigue «se está procesando» (no FISCAL_BLOCK)', async () => {
      const { orderId, accessKey } = await venta()
      await factura({
        orderId,
        idempotencyKey: `cfdi-order-${orderId}`,
        status: 'STAMP_FAILED',
        enviadoAt: enviada,
        falloDefinitivo: false,
      })
      await prisma.payment.create({
        data: {
          venueId,
          orderId,
          type: 'REFUND',
          amount: -40,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: -40,
          method: 'CREDIT_CARD',
          status: 'COMPLETED',
        },
      })
      expect(await get(accessKey)).toMatchObject({ autofacturaAvailable: false, autofacturaUnavailable: { kind: 'TIMBRE_EN_DUDA' } })
    })

    it('control — un rechazo definitivo no es «en duda»: el GET la ofrece (el cliente corrige sus datos)', async () => {
      const { orderId, accessKey } = await venta()
      await factura({ orderId, idempotencyKey: `cfdi-order-${orderId}`, status: 'STAMP_FAILED', enviadoAt: enviada, falloDefinitivo: true })
      expect(await get(accessKey)).toMatchObject({ autofacturaAvailable: true })
    })
  })

  describe('G2 — el ticket ya incluido en una global viva', () => {
    async function enGlobal(orderId: string, extra: Record<string, unknown> = {}) {
      const g = await factura({
        flow: 'GLOBAL_C',
        isGlobal: true,
        status: 'STAMPED',
        uuid: randomUUID(),
        serie: 'G',
        folio: String(Date.now() % 100000),
        stampedAt: new Date(),
        receptorRfc: 'XAXX010101000',
        ...extra,
      })
      await prisma.cfdiGlobalOrden.create({ data: { cfdiId: g.id, orderId, huella: 'h' } })
      return g
    }

    /** Una nota de extracción de la venta contra la global `g` (sólo la fila: lo que miran el GET y el antecedente). */
    const extraccion = (orderId: string, g: { id: string }, extra: Record<string, unknown> = {}) =>
      factura({
        orderId,
        type: 'EGRESO',
        flow: 'STAFF_B',
        idempotencyKey: `cfdi-extraccion-${g.id}-${orderId}`,
        status: 'STAMPED',
        uuid: randomUUID(),
        serie: 'E',
        folio: '9',
        stampedAt: new Date(),
        receptorRfc: 'XAXX010101000',
        ...extra,
      })

    it('🔴 C3 (G2): global viva ⇒ el GET SÍ la ofrece (el POST decide); el POST no puede sacarla sin el XML de la global ⇒ 409 neutro, sin PAC ni fila nueva', async () => {
      const { orderId, accessKey } = await venta()
      await enGlobal(orderId)
      expect(await get(accessKey)).toEqual({ cfdi: null, autofacturaAvailable: true })
      expect(await post(accessKey)).toEqual({ status: 409, body: { error: NEUTRO } })
      expect(provider.createInvoice).not.toHaveBeenCalled()
      expect(await prisma.cfdi.count({ where: { orderId } })).toBe(0)
    })

    it('🔴 C3-19 (G2): su extracción se CANCELÓ ⇒ el GET ya no la ofrece (FISCAL_BLOCK neutro, el motivo al log)', async () => {
      const { orderId, accessKey } = await venta()
      const g = await enGlobal(orderId)
      await extraccion(orderId, g, { status: 'CANCELLED', cancelStatus: 'ACCEPTED', cancelledAt: new Date() })
      expect(await get(accessKey)).toEqual({ cfdi: null, autofacturaAvailable: false, autofacturaUnavailable: { kind: 'FISCAL_BLOCK' } })
    })

    it('🔴 C3-13 (G2): su extracción es de una global que ya no está vigente ⇒ el GET no la ofrece', async () => {
      const { orderId, accessKey } = await venta()
      const g = await enGlobal(orderId, { status: 'CANCELLED', cancelStatus: 'ACCEPTED', cancelledAt: new Date() })
      await extraccion(orderId, g)
      expect(await get(accessKey)).toEqual({ cfdi: null, autofacturaAvailable: false, autofacturaUnavailable: { kind: 'FISCAL_BLOCK' } })
    })

    it('control — global viva con su extracción timbrada (la factura del cliente falta o se reintenta) ⇒ se ofrece', async () => {
      const { orderId, accessKey } = await venta()
      const g = await enGlobal(orderId)
      await extraccion(orderId, g)
      expect(await get(accessKey)).toEqual({ cfdi: null, autofacturaAvailable: true })
    })

    it('control — la global CANCELADA (confirmada) ya no la tiene: el GET vuelve a ofrecer la autofactura', async () => {
      const { orderId, accessKey } = await venta()
      await enGlobal(orderId, { status: 'CANCELLED', cancelStatus: 'ACCEPTED', cancelledAt: new Date() })
      expect(await get(accessKey)).toEqual({ cfdi: null, autofacturaAvailable: true })
    })
  })
})
