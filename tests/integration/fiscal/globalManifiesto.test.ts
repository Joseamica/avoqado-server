jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))
jest.mock('@/services/storage.service', () => ({
  buildStoragePath: (s: string) => s,
  uploadFileToStorage: jest.fn(async () => 'https://test/file'),
}))
import { Prisma } from '@prisma/client'
import { huellaDeEntrada } from '@/services/fiscal/entradaDocumental'
import { liberarSellosDe } from '@/services/fiscal/sellosIva'
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { issueGlobalForEmisor } from '@/services/fiscal/cfdiGlobal.service'
import { issueCfdiForOrder, cancelCfdi } from '@/services/fiscal/cfdi.service'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import { ProviderHttpError } from '@/services/fiscal/providers/facturapi.provider'
import { encenderIvaPorProducto } from '../../__helpers__/iva-por-producto'

const { isDisposableH1Url } = require('../../../scripts/h1-test-database.cjs')
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
// Sólo las bases fiscales locales existentes o una desechable H1 validada por el lanzador.
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !(
    ['/av_db_25_iva_test', '/av_db_25_iva_test_b3c', '/avoqado_h1a_test_20260808'].includes(database.pathname) ||
    isDisposableH1Url(database)
  )
)
  throw new Error('Dedicated test DB required')
const NOW = new Date('2026-06-03T17:00:00Z')
const receptor = { rfc: 'EKU9003173C9', razonSocial: 'ESCUELA KEMPER URGATE', regimenFiscal: '601', codigoPostal: '64000', usoCfdi: 'G03' }
const valid = () => ({
  providerInvoiceId: randomUUID(),
  uuid: randomUUID(),
  serie: 'F',
  folio: '1',
  totalCents: 11600,
  stampedAt: new Date(),
  status: 'valid' as const,
})

describe('global con manifiesto y entrada congelada', () => {
  const fixture = `global-iva-${randomUUID()}`
  let venueId: string
  let productId: string
  let fiscalEmisorId: string
  const provider = {
    name: 'facturapi',
    createInvoice: jest.fn(),
    createGlobalInvoice: jest.fn(),
    cancelInvoice: jest.fn(),
    findByExternalId: jest.fn(),
    getInvoice: jest.fn(),
    downloadXml: jest.fn(),
    downloadPdf: jest.fn(),
  }
  const issue = (orderId: string) => issueCfdiForOrder({ orderId, receptor, sandbox: true, expectedVenueId: venueId })
  const global = () => issueGlobalForEmisor({ emisorId: fiscalEmisorId, now: NOW, sandbox: true })
  const row = () => prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: `cfdi-global-${fiscalEmisorId}-2026-05-04` } })
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
  })

  async function cleanOrders() {
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.orderItemSelloIva.deleteMany({ where: { cfdi: { venueId } } })
    await prisma.cfdiGlobalOrden.deleteMany({ where: { cfdi: { venueId } } })
    await prisma.cfdi.deleteMany({ where: { venueId } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
  }
  beforeEach(async () => {
    await cleanOrders()
    jest.resetAllMocks()
    jest.mocked(resolveFiscalProvider).mockReturnValue(provider as any)
    provider.createInvoice.mockImplementation(async () => valid())
    provider.createGlobalInvoice.mockImplementation(async () => valid())
    provider.cancelInvoice.mockResolvedValue({ status: 'canceled', cancelledAt: new Date() })
    provider.findByExternalId.mockResolvedValue(null)
    provider.downloadXml.mockResolvedValue(Buffer.from('<Comprobante/>'))
    provider.downloadPdf.mockResolvedValue(Buffer.from('%PDF'))
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_16' } })
  })
  afterEach(() => jest.restoreAllMocks())
  afterAll(async () => {
    if (!venueId) return
    await cleanOrders()
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisorId } })
    await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
    await prisma.merchantAccount.deleteMany({ where: { id: fixture } })
    await prisma.paymentProvider.deleteMany({ where: { id: fixture } })
    await prisma.venue.delete({ where: { id: venueId } })
    await prisma.organization.delete({ where: { id: fixture } })
  })
  async function order(amount = 116) {
    return prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        subtotal: amount,
        taxAmount: 0,
        total: amount,
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        items: { create: { productId, productName: 'Producto', quantity: 1, unitPrice: amount, taxAmount: 0, total: amount } },
        payments: {
          create: {
            venueId,
            merchantAccountId: fixture,
            amount,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: amount,
            method: 'CREDIT_CARD',
            status: 'COMPLETED',
            // C1 (Codex C1-5): el periodo de la venta es el de su último cobro, no `Order.updatedAt`.
            createdAt: new Date('2026-05-15T12:00:00Z'),
          },
        },
      },
      include: { items: true },
    })
  }
  it('todo16 conserva payload y dinero; reserva protocolo1, manifiesto y sellos antes del PAC', async () => {
    const a = await order()
    const b = await order(58)
    provider.createGlobalInvoice.mockImplementation(async params => {
      const c = await row()
      expect(c).toMatchObject({ protocoloIva: 1, attempts: 1, subtotalCents: 15000, taxCents: 2400, totalCents: 17400 })
      expect(c.enviadoAt).not.toBeNull()
      expect(await prisma.cfdiGlobalOrden.count({ where: { cfdiId: c.id } })).toBe(2)
      expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: c.id } })).toBe(2)
      expect(params).toEqual({
        receptor: { legal_name: 'PÚBLICO EN GENERAL', tax_id: 'XAXX010101000', tax_system: '616', address: { zip: '01000' } },
        // H3 (Tarea 3): cada concepto lleva su folio como NoIdentificacion (`sku` = `orderNumber`).
        items: (
          [
            [11600, a.orderNumber],
            [5800, b.orderNumber],
          ] as const
        ).map(([unitPriceCents, sku]) => ({
          satProductKey: '01010101',
          satUnitKey: 'ACT',
          description: 'Venta',
          quantity: 1,
          unitPriceCents,
          discountCents: 0,
          objetoImp: '02',
          taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
          taxIncluded: true,
          sku,
        })),
        payment_form: '04',
        use: 'S01',
        global: { periodicity: 'month', months: '05', year: 2026 },
        externalId: `${c.idempotencyKey}#1`,
        idempotencyKey: `${c.idempotencyKey}#1`,
      })
      return valid()
    })
    expect((await global()).status).toBe('STAMPED')
    await expect(issue(a.id)).rejects.toThrow('ya está incluida en la factura global')
    await cancelCfdi({ cfdiId: (await row()).id, motivo: '02', sandbox: true, expectedVenueId: venueId })
    expect(await prisma.cfdiGlobalOrden.count({ where: { cfdiId: (await row()).id } })).toBe(2)
    expect((await issue(b.id)).status).toBe('STAMPED')
  })
  it('🔴 C1: el ticket mezclado ya entra (antes se excluía en silencio)', async () => {
    // Para la v1, «MIXTA» era todo lo que no fuera todo al 16 % (aquí el producto pasó al 0 % antes de sellarse): se excluía y sólo se
    // contaba. Con C1 entra con su IVA real (§4.3) y ya no cuenta como excluida.
    const o = await order()
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
    expect(await global()).toMatchObject({ status: 'STAMPED', candidateCount: 1, excluidasPorIvaMixto: 0, excluidas: {} })
    expect(provider.createGlobalInvoice.mock.calls[0][0].items).toEqual([
      expect.objectContaining({
        sku: o.orderNumber,
        unitPriceCents: 11600,
        taxIncluded: true,
        taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0, withholding: false }],
      }),
    ])
    expect(await row()).toMatchObject({ subtotalCents: 11600, taxCents: 0, totalCents: 11600 })
  })
  it('individual incierta y manifiesto global incierto excluyen la venta', async () => {
    const o = await order()
    provider.createInvoice.mockRejectedValue(new Error('timeout'))
    await issue(o.id)
    expect((await global()).status).toBe('NOTHING_TO_INVOICE')
    const c = await prisma.cfdi.findFirstOrThrow({ where: { venueId } })
    await prisma.cfdi.update({ where: { id: c.id }, data: { orderId: null, isGlobal: true } })
    await prisma.cfdiGlobalOrden.create({ data: { cfdiId: c.id, orderId: o.id, huella: 'historical' } })
    expect((await global()).status).toBe('NOTHING_TO_INVOICE')
  })
  it('respuesta perdida recupera identidad sin recapturar ni segundo envío', async () => {
    await order()
    const stamped = valid()
    provider.createGlobalInvoice.mockRejectedValueOnce(new Error('timeout'))
    expect((await global()).status).toBe('STAMP_FAILED')
    const before = await row()
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
    provider.findByExternalId.mockResolvedValue(stamped)
    expect((await global()).status).toBe('STAMPED')
    expect(provider.createGlobalInvoice).toHaveBeenCalledTimes(1)
    expect(provider.findByExternalId).toHaveBeenCalledWith(`${before.idempotencyKey}#1`)
    expect((await row()).entrada).toEqual(before.entrada)
  })
  it('incierto negativo nunca reenvía, ni siquiera tras60min; escala una vez', async () => {
    await order()
    provider.createGlobalInvoice.mockRejectedValue(new Error('timeout'))
    await global()
    await prisma.cfdi.update({ where: { id: (await row()).id }, data: { enviadoAt: new Date(Date.now() - 61 * 60000) } })
    await expect(global()).rejects.toThrow(/procesando/)
    await expect(global()).rejects.toThrow(/procesando/)
    expect(provider.createGlobalInvoice).toHaveBeenCalledTimes(1)
    expect(await prisma.activityLog.count({ where: { venueId, action: 'CFDI_INTENTO_INCIERTO_ESCALADO' } })).toBe(1)
  })
  it('pending guarda sólo identidad y recupera por provider id; XML falla después de STAMPED', async () => {
    await order()
    provider.createGlobalInvoice.mockResolvedValue({ ...valid(), providerInvoiceId: 'pending-global', status: 'pending', uuid: null })
    await expect(global()).rejects.toThrow(/procesando/)
    expect(await row()).toMatchObject({ status: 'STAMPING', facturapiId: 'pending-global', attempts: 1 })
    provider.getInvoice.mockResolvedValue({ ...valid(), providerInvoiceId: 'pending-global' })
    provider.downloadXml.mockImplementation(async () => {
      expect((await row()).status).toBe('STAMPED')
      throw new Error('storage')
    })
    expect((await global()).status).toBe('STAMPED')
    expect(provider.getInvoice).toHaveBeenCalledWith('pending-global')
  })
  it('🔴 decisión A del founder (7-oct; antes C1-38): un rechazo confirmado se recaptura con identidad NUEVA después de consultar al PAC; la individual de su venta sí se emite', async () => {
    // Como producción: el siguiente intento pregunta al PAC por el intento rechazado (`#1`); si no lo tiene, recaptura con los tickets de
    // ese momento (la venta que ya se facturó aparte queda fuera) y manda `#2`. Nunca se reenvía la MISMA identidad.
    const first = await order()
    provider.createGlobalInvoice.mockRejectedValueOnce(new ProviderHttpError(400, 'invalid_request', 'bad'))
    await global()
    const before = await row()
    expect(before).toMatchObject({ falloDefinitivo: true, attempts: 1, enviadoAt: expect.any(Date) })
    expect((await issue(first.id)).status).toBe('STAMPED')
    const second = await order(58)
    provider.findByExternalId.mockClear()
    expect((await global()).status).toBe('STAMPED')
    expect(provider.findByExternalId).toHaveBeenCalledWith(`${before.idempotencyKey}#1`)
    expect(provider.createGlobalInvoice.mock.calls.map(c => c[0].externalId)).toEqual([
      `${before.idempotencyKey}#1`,
      `${before.idempotencyKey}#2`,
    ])
    expect(await row()).toMatchObject({ status: 'STAMPED', attempts: 2, falloDefinitivo: false })
    expect(await prisma.cfdiGlobalOrden.findMany({ where: { cfdiId: before.id }, take: 10, select: { orderId: true } })).toEqual([
      { orderId: second.id },
    ])
  })
  it('rechazo global libera todos los miembros y una nueva individual captura IVA actual', async () => {
    const a = await order()
    const b = await order()
    provider.createGlobalInvoice.mockRejectedValueOnce(new ProviderHttpError(400, 'invalid_request', 'bad'))
    await global()
    const rejected = await row()
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
    const individual = await issue(a.id)
    expect(individual.cfdi).toMatchObject({ subtotalCents: 11600, taxCents: 0, totalCents: 11600 })
    expect(provider.createInvoice.mock.calls[0][0].items[0].taxes[0].rate).toBe(0)
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: rejected.id } })).toBe(0)
    expect(await prisma.orderItem.findUnique({ where: { id: b.items[0].id } })).toMatchObject({ ivaTratamiento: null })
    expect(await row()).toEqual(rejected)
    expect(await prisma.cfdiGlobalOrden.count({ where: { cfdiId: rejected.id } })).toBe(2)
  })
  it('rechazo individual no impone IVA16 a una global posterior: la global la captura con su IVA actual (C1: al 0 %, ya no se excluye)', async () => {
    const o = await order()
    provider.createInvoice.mockRejectedValueOnce(new ProviderHttpError(400, 'invalid_request', 'bad'))
    await issue(o.id)
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
    expect(await global()).toMatchObject({ status: 'STAMPED', candidateCount: 1, excluidasPorIvaMixto: 0 })
    expect(provider.createGlobalInvoice.mock.calls[0][0].items.map((i: any) => i.taxes[0].rate)).toEqual([0])
  })
  it('relee elegibilidad bajo lock: una individual entre selección y reserva gana', async () => {
    const o = await order()
    const read = prisma.order.findMany.bind(prisma.order)
    let paused = false
    jest.spyOn(prisma.order, 'findMany').mockImplementation((async (args: Prisma.OrderFindManyArgs) => {
      const result = await read(args as any)
      if (!paused && result.some(r => r.id === o.id)) {
        paused = true
        await issue(o.id)
      }
      return result
    }) as any)
    expect((await global()).status).toBe('NOTHING_TO_INVOICE')
    expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
  })
  it('validación fallida nunca enviada puede corregirse sin tratarla como entrada corrupta', async () => {
    await order()
    await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { lugarExpedicion: 'BADCP' } })
    try {
      expect((await global()).status).toBe('VALIDATION_FAILED')
      expect(await row()).toMatchObject({ attempts: 0, enviadoAt: null, protocoloIva: 1 })
    } finally {
      await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { lugarExpedicion: '01000' } })
    }
    expect((await global()).status).toBe('STAMPED')
    expect((await row()).attempts).toBe(1)
  })
  it('hash correcto no autoriza params cuyo importe diverge de la foto: ENVIADA e incierta, sólo se consulta al PAC por su identidad y nunca se reenvía', async () => {
    // Ronda 1 de la T7 (M4): con `enviadoAt` la fila se consulta al PAC ANTES de leerla (lo que el PAC timbró manda). Sin respuesta: «procesando»,
    // y la entrada alterada nunca se manda (antes se rechazaba al leerla, sin consultar).
    await order()
    provider.createGlobalInvoice.mockRejectedValueOnce(new Error('timeout'))
    await global()
    const c = await row()
    const entrada = c.entrada as any
    entrada.params.items[0].unitPriceCents += 11600
    await prisma.cfdi.update({ where: { id: c.id }, data: { entrada, entradaHuella: huellaDeEntrada(entrada) } })
    await expect(global()).rejects.toThrow(/procesando/)
    expect(provider.findByExternalId).toHaveBeenCalledWith(`${c.idempotencyKey}#1`)
    expect(provider.createGlobalInvoice).toHaveBeenCalledTimes(1)
  })
  it('🔴 ronda 1 de la T7 (M4): una reserva NUNCA enviada con params alterados no se manda: se recaptura y sale lo que dice la venta', async () => {
    await order()
    await expect(
      issueGlobalForEmisor(
        { emisorId: fiscalEmisorId, now: NOW, sandbox: true },
        {
          resolveProvider: () => {
            throw new Error('sin proveedor')
          },
        },
      ),
    ).rejects.toThrow('sin proveedor')
    const c = await row()
    expect(c).toMatchObject({ status: 'STAMPING', enviadoAt: null })
    const entrada = c.entrada as any
    entrada.params.items[0].unitPriceCents += 11600
    await prisma.cfdi.update({ where: { id: c.id }, data: { entrada, entradaHuella: huellaDeEntrada(entrada) } })
    await expect(global()).resolves.toMatchObject({ status: 'STAMPED' })
    expect(provider.createGlobalInvoice.mock.calls.map(([p]) => p.items.map((i: any) => i.unitPriceCents))).toEqual([[11600]])
    expect(await row()).toMatchObject({ attempts: 2, totalCents: 11600 })
  })
  it('respeta el opt-in de efectivo en la selección real', async () => {
    const o = await order()
    await prisma.payment.updateMany({ where: { orderId: o.id }, data: { method: 'CASH' } })
    await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { invoiceCashSales: false } })
    try {
      expect((await global()).status).toBe('NOTHING_TO_INVOICE')
      expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
    } finally {
      await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { invoiceCashSales: true } })
    }
    expect((await global()).status).toBe('STAMPED')
  })
  it('enumera más de una página y reserva todos los tickets sin truncar', async () => {
    for (let i = 0; i < 102; i++) await order()
    const spy = jest.spyOn(prisma.order, 'findMany')
    const result = await global()
    expect(result).toMatchObject({ status: 'STAMPED', candidateCount: 102 })
    expect(provider.createGlobalInvoice.mock.calls[0][0].items).toHaveLength(102)
    expect(await prisma.cfdiGlobalOrden.count({ where: { cfdiId: result.cfdi.id } })).toBe(102)
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2)
    for (const [args] of spy.mock.calls) expect(args?.take).toBeLessThanOrEqual(100)
  })
  it('dos solicitudes concurrentes producen un solo envío', async () => {
    await order()
    const results = await Promise.allSettled([global(), global()])
    expect(results.some(r => r.status === 'fulfilled' && r.value.status === 'STAMPED')).toBe(true)
    expect(provider.createGlobalInvoice).toHaveBeenCalledTimes(1)
  })
  it('usa params congelados aunque el catálogo cambie después del commit', async () => {
    await order()
    const result = await issueGlobalForEmisor(
      { emisorId: fiscalEmisorId, now: NOW, sandbox: true },
      {
        loadVenueSlug: async () => {
          await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
          return fixture
        },
      },
    )
    expect(result.status).toBe('STAMPED')
    expect(provider.createGlobalInvoice.mock.calls[0][0].items[0].taxes[0].rate).toBe(0.16)
  })
  it.each(['valid', 'pending', 'failure'])('respuesta %s de otra versión no pisa ni finaliza', async outcome => {
    await order()
    provider.createGlobalInvoice.mockImplementation(async () => {
      await prisma.cfdi.update({ where: { id: (await row()).id }, data: { attempts: 2 } })
      if (outcome === 'failure') throw new ProviderHttpError(400, 'invalid_request', 'late')
      return outcome === 'valid' ? valid() : { ...valid(), status: 'pending', uuid: null }
    })
    await expect(global()).rejects.toThrow(/procesando/)
    expect(await row()).toMatchObject({ attempts: 2, status: 'STAMPING', uuid: null, falloDefinitivo: false, facturapiId: null })
    expect(await prisma.activityLog.count({ where: { venueId, action: 'CFDI_TIMBRE_DUPLICADO' } })).toBe(1)
  })
  it('rechazo del primer envío tras RESET marca definitivo sin subir versión', async () => {
    await order()
    provider.createGlobalInvoice.mockImplementation(async () => {
      await prisma.cfdi.update({ where: { id: (await row()).id }, data: { status: 'STAMP_FAILED' } })
      throw new ProviderHttpError(400, 'invalid_request', 'rejected')
    })
    expect((await global()).status).toBe('STAMP_FAILED')
    expect(await row()).toMatchObject({ attempts: 1, falloDefinitivo: true })
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: (await row()).id } })).toBe(0)
  })
  // D21 (founder, 1-oct, opción A): una global HEREDADA (sin protocoloIva) en un estado reintentable ya no puede existir. Las nueve
  // pruebas que la fabricaban a partir de un intento incierto (consulta pending en STAMPING, sin órdenes elegibles, recuperar
  // identidad, reintento con identidad histórica, respuesta valid/pending/failure de otra versión, pending/valid sin UUID) se
  // reemplazan por la del rechazo: volverla heredada falla y la transacción no deja nada a medias (manifiesto y sellos incluidos).
  it('una global incierta ya no puede volverse heredada: la base lo rechaza sin soltar manifiesto ni sellos', async () => {
    await order()
    provider.createGlobalInvoice.mockRejectedValueOnce(new Error('timeout'))
    await global()
    const c = await row()
    expect(c).toMatchObject({ status: 'STAMP_FAILED', falloDefinitivo: false, protocoloIva: 1 })
    expect(await prisma.cfdiGlobalOrden.count({ where: { cfdiId: c.id } })).toBe(1)
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: c.id } })).toBe(1)
    await expect(
      prisma.$transaction(async tx => {
        await liberarSellosDe(tx, c.id)
        await tx.cfdiGlobalOrden.deleteMany({ where: { cfdiId: c.id } })
        await tx.cfdi.update({
          where: { id: c.id },
          data: { protocoloIva: null, entrada: Prisma.DbNull, entradaHuella: null, enviadoAt: null },
        })
      }),
    ).rejects.toThrow(/Cfdi_heredada_solo_terminada/)
    expect(await row()).toEqual(c)
    expect(await prisma.cfdiGlobalOrden.count({ where: { cfdiId: c.id } })).toBe(1)
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: c.id } })).toBe(1)
  })
  it('un fallo después de manifiesto y sellos revierte toda la reserva global', async () => {
    const o = await order()
    await expect(
      issueGlobalForEmisor(
        { emisorId: fiscalEmisorId, now: NOW, sandbox: true },
        {
          runInTransaction: work =>
            prisma.$transaction(async tx => {
              await work(tx)
              const c = await tx.cfdi.findUniqueOrThrow({ where: { idempotencyKey: `cfdi-global-${fiscalEmisorId}-2026-05-04` } })
              expect(await tx.cfdiGlobalOrden.count({ where: { cfdiId: c.id } })).toBe(1)
              expect(await tx.orderItemSelloIva.count({ where: { cfdiId: c.id } })).toBe(1)
              throw new Error('fallo inyectado después de sellar')
            }),
        },
      ),
    ).rejects.toThrow('fallo inyectado después de sellar')
    expect(await prisma.cfdi.count({ where: { venueId } })).toBe(0)
    expect(await prisma.cfdiGlobalOrden.count({ where: { orderId: o.id } })).toBe(0)
    expect(await prisma.orderItemSelloIva.count({ where: { orderItem: { orderId: o.id } } })).toBe(0)
    expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
  })
})
