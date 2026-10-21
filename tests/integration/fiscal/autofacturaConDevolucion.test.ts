// T-I2 · A7-R10 (founder, 10-oct): la autofactura PÚBLICA no se ofrece en una venta con CUALQUIER devolución completada (total o
// parcial). Contra una base real: el GET y el POST de los controladores y, sobre todo, la CARRERA con el candado real de la orden (una
// devolución que entra entre el GET y el POST también bloquea). Sólo el PAC es de mentira.
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))
// Si la regla se rompe, el POST real timbraría: que tampoco suba archivos ni mande correos a ningún lado.
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
import { issueCfdiForOrder } from '@/services/fiscal/cfdi.service'
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

describe('T-I2 · A7-R10 — autofactura con devolución (base real)', () => {
  const fixture = `ti2-${randomUUID()}`
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
  // La factura del control se timbra por el motor con almacenamiento de mentira (el POST real subiría los archivos).
  const deps = { resolveProvider: jest.fn(() => provider as any), storeArtifact: jest.fn(async () => 'https://test/file') }
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
    provider.createInvoice.mockReset().mockResolvedValue({
      providerInvoiceId: randomUUID(),
      uuid: randomUUID(),
      serie: 'F',
      folio: '1',
      totalCents: 11600,
      stampedAt: new Date(),
      status: 'valid',
    })
    provider.findByExternalId.mockReset().mockResolvedValue(null)
    provider.downloadXml.mockResolvedValue(Buffer.from('<xml/>'))
    provider.downloadPdf.mockResolvedValue(Buffer.from('%PDF'))
  })
  afterAll(async () => {
    if (!venueId) return
    await prisma.activityLog.deleteMany({ where: { venueId } })
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
  /** Una devolución ligada a la venta (como la guardan la TPV y el dashboard: el `orderId` de la venta). */
  const devolucion = (orderId: string, monto: number, status: 'COMPLETED' | 'PENDING' | 'FAILED', db: any = prisma) =>
    db.payment.create({
      data: {
        venueId,
        orderId,
        type: 'REFUND',
        amount: -monto,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -monto,
        method: 'CREDIT_CARD',
        status,
      },
    })
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

  it.each([
    ['total', 116],
    ['parcial', 40],
  ])('🔴 (1/2) devolución %s ⇒ GET no disponible (FISCAL_BLOCK neutro) y POST 409 neutro, sin PAC y sin fila Cfdi', async (_n, monto) => {
    const { orderId, accessKey } = await venta()
    await devolucion(orderId, monto, 'COMPLETED')

    expect(await get(accessKey)).toEqual({ cfdi: null, autofacturaAvailable: false, autofacturaUnavailable: { kind: 'FISCAL_BLOCK' } })
    expect(await post(accessKey)).toEqual({ status: 409, body: { error: NEUTRO } })
    expect(resolveFiscalProvider).not.toHaveBeenCalled()
    expect(provider.createInvoice).not.toHaveBeenCalled()
    expect(provider.findByExternalId).not.toHaveBeenCalled()
    expect(await prisma.cfdi.count({ where: { orderId } })).toBe(0)
  })

  it('🔴 (4) una devolución PENDING o FAILED no bloquea: GET disponible y se timbra', async () => {
    const { orderId, accessKey } = await venta()
    await devolucion(orderId, 116, 'PENDING')
    await devolucion(orderId, 116, 'FAILED')

    expect(await get(accessKey)).toEqual({ cfdi: null, autofacturaAvailable: true })
    const res = await issueCfdiForOrder({ orderId, receptor, sandbox: true, expectedVenueId: venueId, flow: 'AUTOFACTURA_A' }, deps)
    expect(res.status).toBe('STAMPED')
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
  })

  it('control — (3) venta sin devolución ⇒ disponible y se timbra como hoy', async () => {
    const { orderId, accessKey } = await venta()
    expect(await get(accessKey)).toEqual({ cfdi: null, autofacturaAvailable: true })
    const res = await issueCfdiForOrder({ orderId, receptor, sandbox: true, expectedVenueId: venueId, flow: 'AUTOFACTURA_A' }, deps)
    expect(res.status).toBe('STAMPED')
  })

  it('F6 (cambio A PROPÓSITO): la factura del PERSONAL (STAFF_B) de una venta devuelta COMPLETA ya no se timbra — 409 con su código', async () => {
    const { orderId } = await venta()
    await devolucion(orderId, 116, 'COMPLETED')
    await expect(
      issueCfdiForOrder({ orderId, receptor, sandbox: true, expectedVenueId: venueId, flow: 'STAFF_B' }, deps),
    ).rejects.toMatchObject({ code: 'CFDI_VENTA_DEVUELTA' })
    expect(provider.createInvoice).not.toHaveBeenCalled()
  })

  it('🔴 (5) carrera: la devolución que hace commit MIENTRAS el POST espera el candado de la orden también bloquea', async () => {
    const { orderId, accessKey } = await venta()
    // El GET ofrece la autofactura: todavía no hay devolución.
    expect((await get(accessKey)).autofacturaAvailable).toBe(true)

    // 1. La devolución toma el `FOR UPDATE` de la orden (como `lockExistingOrderForPayment`), escribe su pago y se queda abierta.
    let soltar!: () => void
    const esperaSoltar = new Promise<void>(r => (soltar = r))
    let avisarTomado!: () => void
    const tomado = new Promise<void>(r => (avisarTomado = r))
    const tx = prisma.$transaction(
      async t => {
        await t.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`
        await devolucion(orderId, 40, 'COMPLETED', t)
        avisarTomado()
        await esperaSoltar
      },
      { timeout: 30_000, maxWait: 10_000 },
    )
    await tomado

    // 2. El POST arranca y se queda esperando el candado en su admisión (se comprueba en pg_locks, no con un sleep a ciegas).
    const enCurso = post(accessKey)
    let esperando = false
    for (let i = 0; i < 200 && !esperando; i++) {
      const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted AND a.datname = current_database()`
      esperando = n > 0
      if (!esperando) await new Promise(r => setTimeout(r, 25))
    }
    expect(esperando).toBe(true)

    // 3. La devolución hace commit; el POST obtiene el candado, la ve y decide.
    soltar()
    await tx
    expect(await enCurso).toEqual({ status: 409, body: { error: NEUTRO } })
    expect(provider.createInvoice).not.toHaveBeenCalled()
    expect(await prisma.cfdi.count({ where: { orderId } })).toBe(0)
    // Y el GET ya no la ofrece.
    expect((await get(accessKey)).autofacturaUnavailable).toEqual({ kind: 'FISCAL_BLOCK' })
  })
})
