import * as sellosIva from '@/services/fiscal/sellosIva'
import { replaceCfdi } from '@/services/fiscal/cfdiReplacement.service'
import { ProviderHttpError } from '@/services/fiscal/providers/facturapi.provider'
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { anotarIntencionDeCancelar, issueCfdiForOrder, TEXTO_SUSTITUCION_ATORADA } from '@/services/fiscal/cfdi.service'
import {
  MOTIVO_ORIGINAL_EN_SUSTITUCION,
  MOTIVO_ORIGINAL_EN_SUSTITUCION_ATORADA,
  emitRefundCreditNote,
  getRefundCreditNoteStatus,
  loadRefundForCreditNoteFromDb,
} from '@/services/fiscal/cfdiCreditNote.service'
import { huellaDeEntrada, leerEntrada, leerMontosPorRenglon, paramsDesdeEntrada } from '@/services/fiscal/entradaDocumental'
import { encenderIvaPorProducto } from '../../__helpers__/iva-por-producto'
import { xmlDeLaFila } from '../../__helpers__/xml-del-pac'

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
// La base fiscal de esta Mac o la desechable de CI (ci-cd.yml adopta ese nombre en vez de relajar la guarda): nunca otra.
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !['/av_db_25_iva_test', '/av_db_25_iva_test_b3c', '/avoqado_h1a_test_20260808'].includes(database.pathname)
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
    // C2 T7 (D5): la nota exige el XML de su original; el doble devuelve el que el PAC timbraría con lo que se le mandó.
    provider.downloadXml.mockImplementation(async (id: string) => xmlDeLaFila(prisma, id))
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
  it('control — C2 T6 ronda 1 (M5): la sustituta congela SU propio montosPorRenglon, el del documento nuevo; la original conserva el suyo', async () => {
    const { o, cfdi } = await original()
    const deLaOriginal = [{ orderItemId: o.items[0].id, totalCents: 11600, porTratamiento: { IVA_16: 11600 } }]
    expect(leerMontosPorRenglon(leerEntrada(cfdi.entrada)!)).toEqual(deLaOriginal)
    // La venta se corrige antes de sustituir: un artículo más de $50, cobrado.
    const otro = await prisma.orderItem.create({
      data: { orderId: o.id, productId, productName: 'Producto', quantity: 1, unitPrice: 50, taxAmount: 0, total: 50 },
    })
    await prisma.order.update({ where: { id: o.id }, data: { subtotal: 166, total: 166 } })
    await prisma.payment.create({
      data: { venueId, orderId: o.id, amount: 50, feePercentage: 0, feeAmount: 0, netAmount: 50, method: 'CASH', status: 'COMPLETED' },
    })
    expect(await replacement(cfdi.id)).toMatchObject({ status: 'REPLACED' })
    const sub = await replacementRow(cfdi.id)
    const entry = leerEntrada(sub.entrada)!
    const esperado = [
      { orderItemId: o.items[0].id, totalCents: 11600, porTratamiento: { IVA_16: 11600 } },
      { orderItemId: otro.id, totalCents: 5000, porTratamiento: { IVA_16: 5000 } },
    ].sort((x, y) => (x.orderItemId < y.orderItemId ? -1 : 1))
    expect(leerMontosPorRenglon(entry)).toEqual(esperado)
    expect(entry.montos.totalCents).toBe(16600)
    expect(sub.entradaHuella).toBe(huellaDeEntrada(entry))
    const orig = await prisma.cfdi.findUniqueOrThrow({ where: { id: cfdi.id } })
    expect(leerMontosPorRenglon(leerEntrada(orig.entrada)!)).toEqual(deLaOriginal)
    expect(orig.entradaHuella).not.toBe(sub.entradaHuella)
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
        // D21: dato de la ruta nueva (una heredada sin protocoloIva sólo puede existir terminada); la prueba es sobre la otra VIVA.
        protocoloIva: 1,
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
  // Las dos ramas del filtro de admisión (cfdi.service.ts, `idempotencyKey: null` OR `not: llave`): una heredada TIMBRADA con llave
  // distinta y otra sin llave (SQL: `NULL <> 'x'` no es verdadero, así que sin la rama explícita no bloquearía).
  it.each([
    ['con otra llave', (base: string | null) => `${base}-n2-heredada`],
    ['sin llave (idempotencyKey null)', () => null],
  ])('otra individual heredada (protocoloIva null) TIMBRADA %s impide reservar', async (_caso, llave) => {
    const { o, cfdi } = await original()
    await prisma.cfdi.create({
      data: {
        venueId,
        orderId: o.id,
        fiscalEmisorId,
        type: 'INGRESO',
        flow: 'STAFF_B',
        // D21: una heredada TIMBRADA sigue existiendo en producción y debe seguir bloqueando
        status: 'STAMPED',
        protocoloIva: null,
        idempotencyKey: llave(cfdi.idempotencyKey),
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
            // D21: dato de la ruta nueva (una heredada sin protocoloIva sólo puede existir terminada).
            protocoloIva: 1,
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
  // D21 (founder, 1-oct, opción A): una sustituta HEREDADA (sin protocoloIva) en un estado reintentable ya no puede existir; la
  // restricción Cfdi_heredada_solo_terminada lo impide. Por eso las pruebas que reintentaban o recuperaban una (consulta
  // pending/valid sin UUID, recuperación con el dinero histórico, envío tardío contra una cancelación o una versión nueva) se
  // reemplazan por esta: crearla falla y no queda nada a medias. Toda sustituta nueva nace con protocoloIva = 1 (prueba 1).
  it.each(['STAMP_FAILED', 'STAMPING'] as const)('una sustituta heredada %s ya no puede existir: la base la rechaza', async status => {
    const { cfdi } = await original()
    const antes = await prisma.cfdi.findUniqueOrThrow({ where: { id: cfdi.id } })
    await expect(
      prisma.cfdi.create({
        data: {
          venueId,
          orderId: cfdi.orderId,
          fiscalEmisorId,
          flow: 'STAFF_B',
          status,
          protocoloIva: null,
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
      }),
    ).rejects.toThrow(/Cfdi_heredada_solo_terminada/)
    expect(await prisma.cfdi.count({ where: { replacesCfdiId: cfdi.id } })).toBe(0)
    expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: cfdi.id } })).toEqual(antes)
  })

  // ── C2 · Tarea 3 (+ G4 del controlador): la sustitución no EMPIEZA sobre una original con cancelación en trámite, ni sobre una con
  // notas de crédito vivas. Las dos guardas viven en el `capture` de la emisión (reserva fresca y recaptura), bajo el candado de la orden.
  const EN_TRAMITE = /cancelación en trámite/
  /** Una nota de crédito (EGRESO) que apunta a la original por su entrada, como las del protocolo; `over` la vuelve timbrada, muerta o heredada. */
  async function notaDe(orderId: string, originalId: string, over: Record<string, unknown> = {}) {
    return prisma.cfdi.create({
      data: {
        venueId,
        fiscalEmisorId,
        orderId,
        type: 'EGRESO',
        status: 'STAMPING',
        flow: 'STAFF_B',
        receptorRfc: receptor.rfc,
        receptorNombre: receptor.razonSocial,
        receptorRegimen: receptor.regimenFiscal,
        receptorCp: receptor.codigoPostal,
        usoCfdi: 'G02',
        formaPago: '01',
        metodoPago: 'PUE',
        subtotalCents: 862,
        taxCents: 138,
        totalCents: 1000,
        protocoloIva: 1,
        attempts: 1,
        idempotencyKey: `cfdi-refund-${randomUUID()}`,
        entrada: { v: 1, tipo: 'EGRESO', originalCfdiId: originalId },
        ...over,
      } as any,
    })
  }
  const sinSustituta = async (originalId: string) => {
    expect(provider.createInvoice).not.toHaveBeenCalled()
    expect(provider.cancelInvoice).not.toHaveBeenCalled()
    expect(await prisma.cfdi.count({ where: { replacesCfdiId: originalId } })).toBe(0)
  }

  it('🔴 T3: original con cancelación en trámite (enviada y acusada) ⇒ rechaza; ni sustituta reservada ni PAC', async () => {
    const { cfdi } = await original()
    const hace = new Date(Date.now() - 5 * 60_000)
    await prisma.cfdi.update({
      where: { id: cfdi.id },
      data: {
        cancelStatus: 'REQUESTED',
        cancelMotivo: '02',
        cancelRequestedAt: hace,
        cancelIntento: 1,
        cancelEnviadaAt: hace,
        cancelAcusadaAt: hace,
      },
    })
    const antes = await prisma.cfdi.findUniqueOrThrow({ where: { id: cfdi.id } })
    await expect(replacement(cfdi.id)).rejects.toThrow(EN_TRAMITE)
    await sinSustituta(cfdi.id)
    expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: cfdi.id } })).toEqual(antes)
  })

  it('🔴 T3: basta la intención recién ANOTADA (aún sin enviar al PAC)', async () => {
    const { cfdi } = await original()
    expect(await anotarIntencionDeCancelar(cfdi.id, cfdi.attempts, { motivo: '02' })).toMatchObject({ estado: 'ANOTADA', intento: 1 })
    // T10 (M2 de la T3), cambio A PROPÓSITO: sólo ANOTADA, el SAT todavía no la tiene ⇒ «se está enviando al SAT», no «en trámite».
    await expect(replacement(cfdi.id)).rejects.toThrow(/se está enviando al SAT; espera a que se resuelva antes de sustituirla/)
    await sinSustituta(cfdi.id)
  })

  it('🔴 T3 en la RECAPTURA: una sustituta fallida no se vuelve a capturar ni a enviar sobre una original en trámite', async () => {
    const { cfdi } = await original()
    provider.createInvoice.mockRejectedValueOnce(new ProviderHttpError(400, 'invalid_request', 'invalid'))
    await replacement(cfdi.id)
    const fallida = await replacementRow(cfdi.id)
    expect(fallida).toMatchObject({ status: 'STAMP_FAILED', falloDefinitivo: true, attempts: 1 })
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    await prisma.cfdi.update({
      where: { id: cfdi.id },
      data: { cancelStatus: 'REQUESTED', cancelMotivo: '02', cancelRequestedAt: new Date() },
    })
    await expect(replacement(cfdi.id)).rejects.toThrow(EN_TRAMITE)
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(provider.cancelInvoice).not.toHaveBeenCalled()
    // La transacción de la recaptura se revirtió entera: la sustituta sigue como estaba (ni reclamada, ni con otra versión).
    expect(await replacementRow(cfdi.id)).toEqual(fallida)
  })

  it('🔴 G4: original con una nota de crédito TIMBRADA viva ⇒ rechaza con el texto de la cancelación (C2-6); ni sustituta ni PAC', async () => {
    const { o, cfdi } = await original()
    await notaDe(o.id, cfdi.id, { status: 'STAMPED', serie: 'NC', folio: '7', uuid: randomUUID() })
    await expect(replacement(cfdi.id)).rejects.toThrow(
      'Esta factura tiene la nota de crédito NC-7 vigente; el SAT exige cancelar primero lo relacionado.',
    )
    await sinSustituta(cfdi.id)
  })

  it('🔴 G4: una nota RESERVADA (en proceso, sin folio) y una nota HEREDADA de la misma venta también bloquean', async () => {
    const { o, cfdi } = await original()
    const reservada = await notaDe(o.id, cfdi.id)
    await expect(replacement(cfdi.id)).rejects.toThrow(
      'Esta factura tiene una nota de crédito en proceso; el SAT exige cancelar primero lo relacionado.',
    )
    await prisma.cfdi.delete({ where: { id: reservada.id } })
    await notaDe(o.id, 'otra', { status: 'STAMPED', protocoloIva: null, entrada: undefined, serie: 'NC', folio: '8', uuid: randomUUID() })
    await expect(replacement(cfdi.id)).rejects.toThrow(/NC-8/)
    await sinSustituta(cfdi.id)
  })

  it('control — G4: una nota muerta (validación fallida) o de OTRA original no estorba: la sustitución sale', async () => {
    const { o, cfdi } = await original()
    await notaDe(o.id, cfdi.id, { status: 'VALIDATION_FAILED' })
    await notaDe(o.id, 'otra-original', { status: 'STAMPED', serie: 'NC', folio: '9', uuid: randomUUID() })
    expect(await replacement(cfdi.id)).toMatchObject({ status: 'REPLACED' })
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
  })

  // ── C2 · Tarea 3, ronda 1 (I1, el espejo de G4; M1): mientras la SUSTITUCIÓN de A está en vuelo (B reservada y en el PAC, o en duda),
  // ni una nota de crédito sobre A ni una cancelación manual de A empiezan; las dos lo dicen. Cuando B termina, la nota sale contra la
  // corregida; si B falla en definitiva, la nota vuelve a salir contra A (y entonces G4 detiene una nueva sustitución).
  describe('ronda 1 de la T3 · sustitución en curso', () => {
    const createCreditNote = jest.fn()
    beforeEach(() =>
      createCreditNote.mockReset().mockImplementation(async () => {
        throw new Error('la nota NO debía llegar al PAC')
      }),
    )
    const notaTimbrable = () =>
      createCreditNote.mockImplementation(async () => ({
        ...stamped,
        stampedAt: new Date(),
        uuid: randomUUID(),
        providerInvoiceId: randomUUID(),
      }))
    async function reembolso(orderId: string, amount = 10) {
      return prisma.payment.create({
        data: {
          venueId,
          orderId,
          type: 'REFUND',
          amount: -amount,
          tipAmount: 0,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: -amount,
          method: 'CASH',
          status: 'COMPLETED',
        },
      })
    }
    const nota = (refundPaymentId: string, over: Record<string, unknown> = {}) =>
      emitRefundCreditNote({ venueId, refundPaymentId, sandbox: true }, {
        resolveProvider: (() => ({ ...provider, createCreditNote })) as any,
        storeArtifact: deps.storeArtifact,
        ...over,
      } as any)
    const egresos = (orderId: string) => prisma.cfdi.count({ where: { orderId, type: 'EGRESO' } })
    const elegibilidad = async (refundPaymentId: string) => (await getRefundCreditNoteStatus(venueId, refundPaymentId))!.eligibility
    const ESPERA = { eligible: false, reason: 'ORIGINAL_EN_SUSTITUCION', message: MOTIVO_ORIGINAL_EN_SUSTITUCION }

    /** Barrera determinista: arranca la sustitución de A y la deja PAUSADA dentro del PAC (B reservada y enviada, sin respuesta). */
    async function sustitucionEnPausa(originalId: string) {
      let soltar!: () => void
      const pausa = new Promise<void>(r => (soltar = r))
      let entrar!: () => void
      const enElPac = new Promise<void>(r => (entrar = r))
      provider.createInvoice.mockImplementationOnce(async () => {
        entrar()
        await pausa
        // stampedAt propio: la nota posterior elige la corregida por `stampedAt`, no por un empate con la original.
        return { ...stamped, stampedAt: new Date() }
      })
      const promesa = replacement(originalId)
      await enElPac
      const sustituta = await replacementRow(originalId)
      expect(sustituta).toMatchObject({ status: 'STAMPING', replacesCfdiId: originalId })
      expect(sustituta.enviadoAt).not.toBeNull()
      return { soltar, promesa, sustituta }
    }

    it('🔴 I1: con la sustitución EN VUELO, la nota sobre A se rechaza con su texto (botón y emisión) y no deja EGRESO; al soltarla, la sustitución cancela A sin conflicto y la nota sale contra la corregida', async () => {
      const { o, cfdi } = await original()
      const r = await reembolso(o.id)
      const { soltar, promesa, sustituta } = await sustitucionEnPausa(cfdi.id)
      let res: any
      try {
        expect(await elegibilidad(r.id)).toEqual(ESPERA)
        await expect(nota(r.id)).rejects.toThrow(MOTIVO_ORIGINAL_EN_SUSTITUCION)
        expect(createCreditNote).not.toHaveBeenCalled()
        expect(await egresos(o.id)).toBe(0)
      } finally {
        soltar()
        res = await promesa.catch((e: unknown) => e)
      }
      expect(res).toMatchObject({ status: 'REPLACED', cancelStatus: 'REQUESTED' })
      expect(res.cancelConflicto).toBeUndefined()
      expect(provider.cancelInvoice).toHaveBeenCalledTimes(1)
      // B timbrada: la nota vuelve a ser posible, contra la CORREGIDA (la original ya está en trámite de cancelación).
      notaTimbrable()
      expect((await nota(r.id)).status).toBe('STAMPED')
      expect((await prisma.cfdi.findFirstOrThrow({ where: { orderId: o.id, type: 'EGRESO' } })).entrada).toMatchObject({
        originalCfdiId: sustituta.id,
      })
    })

    it('🔴 I1 bajo candado: la revisión inicial no ve sustituta; B se reserva ANTES de que la nota tome el candado de la orden ⇒ la revisión bajo candado la detiene; ni fila ni PAC', async () => {
      const { o, cfdi } = await original()
      const r = await reembolso(o.id)
      const lecturas: boolean[] = []
      let pausada: Awaited<ReturnType<typeof sustitucionEnPausa>> | undefined
      const cargar: typeof loadRefundForCreditNoteFromDb = async (...args) => {
        const l = await loadRefundForCreditNoteFromDb(...args)
        lecturas.push(!!l?.original?.sustitutaEnCurso)
        if (lecturas.length === 1) pausada = await sustitucionEnPausa(cfdi.id)
        return l
      }
      try {
        await expect(nota(r.id, { loadRefundForCreditNote: cargar })).rejects.toThrow(MOTIVO_ORIGINAL_EN_SUSTITUCION)
        expect(lecturas).toEqual([false, true])
        expect(createCreditNote).not.toHaveBeenCalled()
        expect(await egresos(o.id)).toBe(0)
      } finally {
        pausada?.soltar()
        await pausada?.promesa.catch(() => undefined)
      }
      expect(await pausada!.promesa).toMatchObject({ status: 'REPLACED' })
    })

    it('🔴 I1: B en DUDA (el PAC no contestó: STAMP_FAILED sin fallo definitivo) sigue deteniendo la nota sobre A', async () => {
      const { o, cfdi } = await original()
      const r = await reembolso(o.id)
      provider.createInvoice.mockRejectedValueOnce(new Error('timeout'))
      expect((await replacement(cfdi.id)).status).toBe('STAMP_FAILED')
      expect(await replacementRow(cfdi.id)).toMatchObject({ status: 'STAMP_FAILED', falloDefinitivo: false })
      expect(await elegibilidad(r.id)).toEqual(ESPERA)
      await expect(nota(r.id)).rejects.toThrow(MOTIVO_ORIGINAL_EN_SUSTITUCION)
      expect(await egresos(o.id)).toBe(0)
    })

    // C2 · T10 (N1 de la re-revisión de la T3): B se ENVIÓ y lleva más de una hora sin resolverse ⇒ nadie la termina sola (CFDI_VIVO). La nota
    // y la cancelación manual siguen bloqueadas, pero el texto manda a soporte en vez de prometer «espera a que termine».
    it('🔴 T10 (N1): B en duda desde hace más de una hora ⇒ la nota y la cancelación manual dicen «escríbenos a soporte»; sin anotar nada', async () => {
      const { o, cfdi } = await original()
      const r = await reembolso(o.id)
      provider.createInvoice.mockRejectedValueOnce(new Error('timeout'))
      expect((await replacement(cfdi.id)).status).toBe('STAMP_FAILED')
      const b = await replacementRow(cfdi.id)
      expect(b).toMatchObject({ status: 'STAMP_FAILED', falloDefinitivo: false, enviadoAt: expect.any(Date) })
      // Recién enviada: «espera a que termine».
      expect(await elegibilidad(r.id)).toEqual(ESPERA)
      await prisma.cfdi.update({ where: { id: b.id }, data: { enviadoAt: new Date(Date.now() - 2 * 60 * 60_000) } })
      expect(await elegibilidad(r.id)).toEqual({
        eligible: false,
        reason: 'ORIGINAL_EN_SUSTITUCION',
        message: MOTIVO_ORIGINAL_EN_SUSTITUCION_ATORADA,
      })
      await expect(nota(r.id)).rejects.toThrow(MOTIVO_ORIGINAL_EN_SUSTITUCION_ATORADA)
      expect(await anotarIntencionDeCancelar(cfdi.id, cfdi.attempts, { motivo: '02' })).toEqual({ conflicto: TEXTO_SUSTITUCION_ATORADA })
      expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: cfdi.id } })).toMatchObject({ cancelStatus: null, cancelIntento: 0 })
      expect(await egresos(o.id)).toBe(0)
    })

    it('control — I1: B fallida EN DEFINITIVA (el PAC la rechazó) ya no detiene: la nota sale contra A; y entonces G4 detiene un nuevo intento de sustituir', async () => {
      const { o, cfdi } = await original()
      const r = await reembolso(o.id)
      provider.createInvoice.mockRejectedValueOnce(new ProviderHttpError(400, 'invalid_request', 'invalid'))
      await replacement(cfdi.id)
      expect(await replacementRow(cfdi.id)).toMatchObject({ status: 'STAMP_FAILED', falloDefinitivo: true })
      expect(await elegibilidad(r.id)).toEqual({ eligible: true, reason: null, message: null })
      notaTimbrable()
      expect((await nota(r.id)).status).toBe('STAMPED')
      expect((await prisma.cfdi.findFirstOrThrow({ where: { orderId: o.id, type: 'EGRESO' } })).entrada).toMatchObject({
        originalCfdiId: cfdi.id,
      })
      await expect(replacement(cfdi.id)).rejects.toThrow(/el SAT exige cancelar primero lo relacionado/)
      expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    })

    it('🔴 M1: con la sustitución EN VUELO, cancelar A a mano se rechaza («se está sustituyendo») sin anotar nada; al soltarla, la sustitución cancela A sin conflicto', async () => {
      const { cfdi } = await original()
      const { soltar, promesa } = await sustitucionEnPausa(cfdi.id)
      let res: any
      try {
        expect(await anotarIntencionDeCancelar(cfdi.id, cfdi.attempts, { motivo: '02' })).toEqual({
          conflicto: 'Esta factura se está sustituyendo; espera a que termine antes de cancelarla.',
        })
        expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: cfdi.id } })).toMatchObject({ cancelStatus: null, cancelIntento: 0 })
        expect(provider.cancelInvoice).not.toHaveBeenCalled()
      } finally {
        soltar()
        res = await promesa.catch((e: unknown) => e)
      }
      expect(res).toMatchObject({ status: 'REPLACED', cancelStatus: 'REQUESTED' })
      expect(res.cancelConflicto).toBeUndefined()
    })
  })
})
