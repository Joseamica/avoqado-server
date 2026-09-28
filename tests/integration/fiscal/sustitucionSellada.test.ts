import * as sellosIva from '@/services/fiscal/sellosIva'
import { replaceCfdi } from '@/services/fiscal/cfdiReplacement.service'
import { ProviderHttpError } from '@/services/fiscal/providers/facturapi.provider'
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { issueCfdiForOrder } from '@/services/fiscal/cfdi.service'
import { huellaDeEntrada, leerEntrada, paramsDesdeEntrada } from '@/services/fiscal/entradaDocumental'
import { encenderIvaPorProducto } from '../../__helpers__/iva-por-producto'

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
// La base fiscal de esta Mac o la desechable de CI (ci-cd.yml adopta ese nombre en vez de relajar la guarda): nunca otra.
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !['/av_db_25_iva_test', '/avoqado_h1a_test_20260808'].includes(database.pathname)
) {
  throw new Error('Esta suite exige la base local av_db_25_iva_test o la desechable de CI avoqado_h1a_test_20260808.')
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

describe('sustitución sellada', () => {
  const fixture = `sustitucion-iva-${randomUUID()}`
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
    cancelInvoice: jest.fn(),
  }
  const deps = {
    resolveProvider: jest.fn(() => provider as any),
    storeArtifact: jest.fn(async () => 'https://test/file'),
  }
  const issue = (orderId: string, extra = {}) =>
    issueCfdiForOrder({ orderId, receptor, sandbox: true, expectedVenueId: venueId, ...extra }, deps)

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
  beforeEach(async () => {
    jest.clearAllMocks()
    stamped.uuid = randomUUID()
    stamped.providerInvoiceId = randomUUID()
    provider.createInvoice.mockReset().mockResolvedValue(stamped)
    provider.findByExternalId.mockReset().mockResolvedValue(null)
    provider.getInvoice.mockReset().mockResolvedValue(stamped)
    provider.cancelInvoice.mockReset().mockResolvedValue({ status: 'pending' })
    provider.downloadXml.mockResolvedValue(Buffer.from('<Comprobante/>'))
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
  const replacement = (originalId: string, overrides = {}) =>
    replaceCfdi({ cfdiId: originalId, sandbox: true, expectedVenueId: venueId }, { ...deps, ...overrides } as any)
  const replacementRow = (id: string) => prisma.cfdi.findFirstOrThrow({ where: { replacesCfdiId: id } })
  async function original() {
    const o = await order()
    const issued = await issue(o.id)
    provider.createInvoice.mockClear()
    provider.downloadXml.mockClear()
    stamped.uuid = randomUUID()
    stamped.providerInvoiceId = randomUUID()
    provider.createInvoice.mockResolvedValue({ ...stamped })
    return { o, cfdi: issued.cfdi }
  }
  it('reserva su entrada y relación04; mantiene dos sellos hasta la cancelación confirmada', async () => {
    const { o, cfdi } = await original()
    const oldEntry = cfdi.entrada
    const result = await replacement(cfdi.id)
    const sub = await replacementRow(cfdi.id)
    const entry = leerEntrada(sub.entrada)!
    expect(result).toMatchObject({ status: 'REPLACED', cancelPendiente: true, cancelStatus: 'REQUESTED' })
    expect(sub).toMatchObject({ protocoloIva: 1, attempts: 1, replacesCfdiId: cfdi.id, entradaHuella: huellaDeEntrada(entry) })
    expect(entry.replacesCfdiId).toBe(cfdi.id)
    expect(entry.params.relation).toEqual({ tipoRelacion: '04', relatedUuids: [cfdi.uuid] })
    expect(provider.createInvoice).toHaveBeenCalledWith({
      ...paramsDesdeEntrada(entry, `${sub.idempotencyKey}#1`),
      idempotencyKey: `${sub.idempotencyKey}#1`,
    })
    expect(await sellosIva.renglonesSellados(prisma, o.id)).toEqual([expect.objectContaining({ cfdis: 2, tratamiento: 'IVA_16' })])
    expect((await prisma.cfdi.findUniqueOrThrow({ where: { id: cfdi.id } })).entrada).toEqual(oldEntry)
    await prisma.cfdi.update({ where: { id: cfdi.id }, data: { cancelStatus: 'REJECTED' } })
    provider.cancelInvoice.mockResolvedValue({ status: 'accepted', cancelledAt: new Date() })
    expect((await replacement(cfdi.id)).cancelPendiente).toBe(false)
    expect(await sellosIva.renglonesSellados(prisma, o.id)).toEqual([expect.objectContaining({ cfdis: 1, tratamiento: 'IVA_16' })])
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(await prisma.orderItemSelloIva.findFirst({ where: { cfdiId: sub.id } })).toMatchObject({ intento: 1 })
  })
  it('el payload permanece congelado si la orden cambia tras el commit de reserva', async () => {
    const { o, cfdi } = await original()
    await replacement(cfdi.id, {
      runInTransaction: async (work: any) => {
        const result: any = await prisma.$transaction(work)
        if (result?.fresh) await prisma.orderItem.update({ where: { id: o.items[0].id }, data: { productName: 'Cambio posterior' } })
        return result
      },
    })
    const sub = await replacementRow(cfdi.id)
    const entry = leerEntrada(sub.entrada)!
    expect(provider.createInvoice).toHaveBeenCalledWith({
      ...paramsDesdeEntrada(entry, `${sub.idempotencyKey}#1`),
      idempotencyKey: `${sub.idempotencyKey}#1`,
    })
    expect(entry.params.items[0].description).not.toBe('Cambio posterior')
  })
  it('timeout se recupera por identidad sin recapturar ni reclamar; funciona con original cancelada', async () => {
    const { o, cfdi } = await original()
    provider.createInvoice.mockRejectedValueOnce(new Error('timeout'))
    expect((await replacement(cfdi.id)).status).toBe('STAMP_FAILED')
    const first = await replacementRow(cfdi.id)
    await prisma.orderItem.update({ where: { id: o.items[0].id }, data: { productName: 'Otra descripción' } })
    await prisma.cfdi.update({ where: { id: cfdi.id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    provider.findByExternalId.mockResolvedValue({ ...stamped })
    const loadOrderForCfdi = jest.fn(() => {
      throw new Error('no leer orden viva')
    })
    expect((await replacement(cfdi.id, { loadOrderForCfdi })).status).toBe('REPLACED')
    expect(provider.findByExternalId).toHaveBeenCalledWith(`${first.idempotencyKey}#1`)
    expect(loadOrderForCfdi).not.toHaveBeenCalled()
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(await replacementRow(cfdi.id)).toMatchObject({ attempts: 1, entrada: first.entrada, entradaHuella: first.entradaHuella })
  })
  it('incierto no caduca, no se reenvía con búsqueda negativa y escala una vez', async () => {
    const { cfdi } = await original()
    provider.createInvoice.mockRejectedValueOnce(new Error('timeout'))
    await replacement(cfdi.id)
    const sub = await replacementRow(cfdi.id)
    await prisma.cfdi.update({ where: { id: sub.id }, data: { enviadoAt: new Date(Date.now() - 61 * 60_000) } })
    await expect(replacement(cfdi.id)).rejects.toThrow(/procesando/)
    await expect(replacement(cfdi.id)).rejects.toThrow(/procesando/)
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(await replacementRow(cfdi.id)).toMatchObject({ attempts: 1, entrada: sub.entrada, falloDefinitivo: false })
    expect(await prisma.activityLog.count({ where: { entityId: sub.id, action: 'CFDI_INTENTO_INCIERTO_ESCALADO' } })).toBe(1)
  })
  it('pending guarda id sin finalizar/cancelar; consulta por id recupera sin subir versión', async () => {
    const { cfdi } = await original()
    provider.createInvoice.mockResolvedValueOnce({ ...stamped, status: 'pending', uuid: null })
    await expect(replacement(cfdi.id)).rejects.toThrow(/procesando/)
    const sub = await replacementRow(cfdi.id)
    expect(sub).toMatchObject({ status: 'STAMPING', uuid: null, facturapiId: stamped.providerInvoiceId, attempts: 1 })
    expect(provider.cancelInvoice).not.toHaveBeenCalled()
    provider.getInvoice.mockResolvedValue({ ...stamped })
    await replacement(cfdi.id)
    expect(provider.getInvoice).toHaveBeenCalledWith(sub.facturapiId)
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect((await replacementRow(cfdi.id)).attempts).toBe(1)
  })
  it('un rechazo confirmado recaptura la sustituta sin liberar el sello de la original', async () => {
    const { o, cfdi } = await original()
    provider.createInvoice.mockRejectedValueOnce(new ProviderHttpError(400, 'invalid_request', 'invalid'))
    await replacement(cfdi.id)
    const first = await replacementRow(cfdi.id)
    expect(first.falloDefinitivo).toBe(true)
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: first.id } })).toBe(0)
    expect(await sellosIva.renglonesSellados(prisma, o.id)).toEqual([expect.objectContaining({ cfdis: 1, tratamiento: 'IVA_16' })])
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
    await replacement(cfdi.id)
    const sub = await replacementRow(cfdi.id)
    expect(sub.attempts).toBe(2)
    expect(leerEntrada(sub.entrada)!.renglones[0].tratamiento).toBe('IVA_16')
    expect(await sellosIva.renglonesSellados(prisma, o.id)).toEqual([expect.objectContaining({ cfdis: 2 })])
    expect(await prisma.orderItemSelloIva.findFirst({ where: { cfdiId: sub.id } })).toMatchObject({ intento: 2 })
  })
  it.each(['STAMPED', 'STAMPING', 'STAMP_FAILED'] as const)('otra individual VIVA %s impide reservar', async status => {
    const { o, cfdi } = await original()
    await prisma.cfdi.create({
      data: {
        venueId,
        orderId: o.id,
        fiscalEmisorId,
        type: 'INGRESO',
        flow: 'STAFF_B',
        status,
        idempotencyKey: `${cfdi.idempotencyKey}-n2`,
        falloDefinitivo: false,
        receptorRfc: receptor.rfc,
        receptorNombre: receptor.razonSocial,
        receptorRegimen: receptor.regimenFiscal,
        receptorCp: receptor.codigoPostal,
        usoCfdi: receptor.usoCfdi,
        formaPago: '01',
        metodoPago: 'PUE',
        subtotalCents: 10000,
        taxCents: 1600,
        totalCents: 11600,
      },
    })
    await expect(replacement(cfdi.id)).rejects.toThrow(/proceso/)
    expect(provider.createInvoice).not.toHaveBeenCalled()
    expect(await prisma.cfdi.count({ where: { replacesCfdiId: cfdi.id } })).toBe(0)
  })
  it('dos solicitudes reales reservan y envían sólo una vez', async () => {
    const { cfdi } = await original()
    const results = await Promise.allSettled([replacement(cfdi.id), replacement(cfdi.id)])
    expect(results.some(r => r.status === 'fulfilled')).toBe(true)
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(await prisma.cfdi.count({ where: { replacesCfdiId: cfdi.id } })).toBe(1)
  })
  it('una respuesta de otra versión no finaliza ni cancela la original', async () => {
    const { cfdi } = await original()
    provider.createInvoice.mockImplementationOnce(async () => {
      const sub = await replacementRow(cfdi.id)
      await prisma.cfdi.update({ where: { id: sub.id }, data: { attempts: { increment: 1 } } })
      return { ...stamped }
    })
    await expect(replacement(cfdi.id)).rejects.toThrow(/procesando/)
    const sub = await replacementRow(cfdi.id)
    expect(sub).toMatchObject({ status: 'STAMPING', uuid: null, attempts: 2 })
    expect(provider.cancelInvoice).not.toHaveBeenCalled()
    expect(await prisma.activityLog.count({ where: { entityId: sub.id, action: 'CFDI_TIMBRE_DUPLICADO' } })).toBe(1)
  })
  it.each(['otra individual', 'original cancelada'])('reevalúa %s después de esperar el bloqueo real de la orden', async scenario => {
    const { o, cfdi } = await original()
    let request!: Promise<any>
    let pid = 0
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${o.id} FOR UPDATE`
      request = replacement(cfdi.id, {
        runInTransaction: (work: any) =>
          prisma.$transaction(async inner => {
            const [connection] = await inner.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
            pid = connection.pid
            return work(inner)
          }),
      }).then(
        value => value,
        error => error,
      )
      let waited = false
      const until = Date.now() + 2000
      while (Date.now() < until) {
        const [lock] = await tx.$queryRaw<
          Array<{ waiting: boolean }>
        >`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ${pid} AND NOT granted) AS waiting`
        if (lock.waiting) {
          waited = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waited).toBe(true)
      if (scenario === 'original cancelada') {
        await tx.cfdi.update({ where: { id: cfdi.id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
      } else {
        await tx.cfdi.create({
          data: {
            venueId,
            orderId: o.id,
            fiscalEmisorId,
            flow: 'STAFF_B',
            status: 'STAMP_FAILED',
            falloDefinitivo: false,
            idempotencyKey: `${cfdi.idempotencyKey}-n2`,
            receptorRfc: receptor.rfc,
            receptorNombre: receptor.razonSocial,
            receptorRegimen: receptor.regimenFiscal,
            receptorCp: receptor.codigoPostal,
            usoCfdi: receptor.usoCfdi,
            formaPago: '01',
            metodoPago: 'PUE',
            subtotalCents: 10000,
            taxCents: 1600,
            totalCents: 11600,
          },
        })
      }
    })
    expect(await request).toBeInstanceOf(Error)
    expect(provider.createInvoice).not.toHaveBeenCalled()
    expect(await prisma.cfdi.count({ where: { replacesCfdiId: cfdi.id } })).toBe(0)
  })
  it('una entrada nunca enviada se recaptura tras corregir validación; sin sellos prematuros', async () => {
    const { o, cfdi } = await original()
    await prisma.orderItem.update({ where: { id: o.items[0].id }, data: { unitPrice: 120, total: 120 } })
    const invalid = await replacement(cfdi.id)
    expect(invalid).toMatchObject({ status: 'VALIDATION_FAILED', sustituta: null })
    expect(invalid.reasons!.join(' ')).toContain('no coincide con lo cobrado')
    const first = await replacementRow(cfdi.id)
    expect(first).toMatchObject({ attempts: 0, enviadoAt: null, status: 'VALIDATION_FAILED', protocoloIva: 1 })
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: first.id } })).toBe(0)
    await prisma.orderItem.update({ where: { id: o.items[0].id }, data: { unitPrice: 116, total: 116 } })
    await replacement(cfdi.id)
    expect(await replacementRow(cfdi.id)).toMatchObject({ attempts: 1, status: 'STAMPED' })
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
  })
  it.each(['pending', 'failure'] as const)('respuesta %s de versión anterior no pisa la siguiente', async response => {
    const { cfdi } = await original()
    provider.createInvoice.mockImplementationOnce(async () => {
      const sub = await replacementRow(cfdi.id)
      await prisma.cfdi.update({ where: { id: sub.id }, data: { attempts: { increment: 1 } } })
      if (response === 'failure') throw new ProviderHttpError(400, 'invalid_request', 'invalid')
      return { ...stamped, status: 'pending', uuid: null }
    })
    await expect(replacement(cfdi.id)).rejects.toThrow(/procesando/)
    const sub = await replacementRow(cfdi.id)
    expect(sub).toMatchObject({ status: 'STAMPING', attempts: 2, facturapiId: null, uuid: null, falloDefinitivo: false })
    expect(provider.cancelInvoice).not.toHaveBeenCalled()
    expect(await prisma.activityLog.count({ where: { entityId: sub.id, action: 'CFDI_TIMBRE_DUPLICADO' } })).toBe(1)
  })
  async function historicalReplacement(cfdi: any) {
    return prisma.cfdi.create({
      data: {
        venueId,
        orderId: cfdi.orderId,
        fiscalEmisorId,
        flow: 'STAFF_B',
        status: 'STAMP_FAILED',
        attempts: 2,
        idempotencyKey: `${cfdi.idempotencyKey}-r1`,
        replacesCfdiId: cfdi.id,
        receptorRfc: receptor.rfc,
        receptorNombre: receptor.razonSocial,
        receptorRegimen: receptor.regimenFiscal,
        receptorCp: receptor.codigoPostal,
        usoCfdi: receptor.usoCfdi,
        formaPago: '01',
        metodoPago: 'PUE',
        subtotalCents: 9000,
        taxCents: 1500,
        totalCents: 10500,
      },
    })
  }
  it.each(['pending', 'valid'] as const)('legacy consulta %s sinUUID no finaliza ni cancela', async status => {
    const { cfdi } = await original()
    const sub = await historicalReplacement(cfdi)
    let atLookup: any
    provider.findByExternalId.mockImplementation(async () => {
      atLookup = await replacementRow(cfdi.id)
      return { ...stamped, status, uuid: null }
    })
    await expect(replacement(cfdi.id)).rejects.toThrow(/proceso|procesando/)
    expect(await replacementRow(cfdi.id)).toMatchObject({ status: 'STAMPING', attempts: 3, uuid: null, entrada: null, protocoloIva: null })
    expect(await replacementRow(cfdi.id)).toEqual(atLookup)
    expect(provider.findByExternalId).toHaveBeenCalledWith(sub.idempotencyKey)
    expect(provider.createInvoice).not.toHaveBeenCalled()
    expect(provider.downloadXml).not.toHaveBeenCalled()
    expect(provider.cancelInvoice).not.toHaveBeenCalled()
  })
  it('legacy recuperada conserva dinero histórico y finaliza identidad antes de archivos', async () => {
    const { cfdi } = await original()
    await historicalReplacement(cfdi)
    provider.findByExternalId.mockResolvedValue({ ...stamped })
    provider.downloadXml.mockImplementationOnce(async () => {
      expect(await replacementRow(cfdi.id)).toMatchObject({ status: 'STAMPED', uuid: stamped.uuid, totalCents: 10500 })
      return Buffer.from('<Comprobante/>')
    })
    const res = await replacement(cfdi.id)
    expect(res.status).toBe('REPLACED')
    const sub = await replacementRow(cfdi.id)
    expect(sub).toMatchObject({
      totalCents: 10500,
      subtotalCents: 9000,
      taxCents: 1500,
      entrada: null,
      entradaHuella: null,
      protocoloIva: null,
      attempts: 3,
      taxBreakdown: [],
    })
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: sub.id } })).toBe(0)
    expect(provider.createInvoice).not.toHaveBeenCalled()
  })
  it.each(['pending', 'failure', 'valid'] as const)(
    'legacy envío %s tardío no revive cancelación ni pisa versión posterior',
    async response => {
      for (const state of ['CANCELLED', 'NEW_VERSION']) {
        const { cfdi } = await original()
        const old = await historicalReplacement(cfdi)
        provider.cancelInvoice.mockClear()
        provider.findByExternalId.mockResolvedValue(null)
        provider.createInvoice.mockImplementationOnce(async () => {
          await prisma.cfdi.update({
            where: { id: old.id },
            data: state === 'CANCELLED' ? { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } : { attempts: 4 },
          })
          if (response === 'failure') throw new Error('timeout')
          return { ...stamped, status: response, uuid: response === 'pending' ? null : stamped.uuid }
        })
        await expect(replacement(cfdi.id)).rejects.toThrow(/proceso|procesando/)
        expect(await replacementRow(cfdi.id)).toMatchObject(
          state === 'CANCELLED'
            ? { status: 'CANCELLED', cancelStatus: 'ACCEPTED', uuid: null }
            : { status: 'STAMPING', attempts: 4, uuid: null },
        )
        expect(provider.cancelInvoice).not.toHaveBeenCalled()
      }
    },
  )
})
