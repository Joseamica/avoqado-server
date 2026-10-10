import * as exclusionGlobal from '@/services/fiscal/exclusionGlobal'
import * as sellosIva from '@/services/fiscal/sellosIva'
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { issueCfdiForOrder } from '@/services/fiscal/cfdi.service'
import { huellaDeEntrada, leerEntrada, leerMontosPorRenglon, paramsDesdeEntrada } from '@/services/fiscal/entradaDocumental'
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

describe('emisión individual sellada', () => {
  const fixture = `emision-iva-${randomUUID()}`
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
    provider.downloadXml.mockResolvedValue(Buffer.from('<xml/>'))
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
  it('reserva, captura y sella en una transacción; envía sólo la entrada congelada', async () => {
    const o = await order()
    const result = await issue(o.id)
    expect(result.status).toBe('STAMPED')
    const cfdi = await row(o.id)
    const entrada = leerEntrada(cfdi.entrada)!
    expect(entrada).not.toBeNull()
    expect(cfdi).toMatchObject({ protocoloIva: 1, attempts: 1, entradaHuella: huellaDeEntrada(entrada), falloDefinitivo: false })
    expect(cfdi.enviadoAt).not.toBeNull()
    expect(provider.createInvoice).toHaveBeenCalledWith({
      ...paramsDesdeEntrada(entrada, `${cfdi.idempotencyKey}#1`),
      idempotencyKey: `${cfdi.idempotencyKey}#1`,
    })
    expect(await prisma.orderItemSelloIva.findMany({ where: { cfdiId: cfdi.id } })).toEqual([
      expect.objectContaining({ orderItemId: o.items[0].id, intento: 1 }),
    ])
    expect(await prisma.orderItem.findUnique({ where: { id: o.items[0].id } })).toMatchObject({ ivaTratamiento: 'IVA_16' })
  })
  it('C2 T6: la factura timbrada guarda lo facturado de cada artículo (montosPorRenglon) y se lee de la base', async () => {
    const o = await order()
    expect((await issue(o.id)).status).toBe('STAMPED')
    const cfdi = await row(o.id)
    const entrada = leerEntrada(cfdi.entrada)!
    expect(leerMontosPorRenglon(entrada)).toEqual([{ orderItemId: o.items[0].id, totalCents: 11600, porTratamiento: { IVA_16: 11600 } }])
    expect(cfdi.entradaHuella).toBe(huellaDeEntrada(entrada))
  })
  it('un cambio al producto durante el PAC no cambia la foto ni el sello', async () => {
    const o = await order()
    provider.createInvoice.mockImplementationOnce(async () => {
      await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
      return stamped
    })
    await issue(o.id)
    expect(provider.createInvoice.mock.calls[0][0].items[0].taxes[0].rate).toBe(0.16)
    expect(leerEntrada((await row(o.id)).entrada)!.renglones[0].tratamiento).toBe('IVA_16')
    expect(await prisma.orderItem.findUnique({ where: { id: o.items[0].id } })).toMatchObject({ ivaTratamiento: 'IVA_16' })
  })
  it('rechazo confirmado permite liberar y recapturar IVA_0 con una nueva versión', async () => {
    const o = await order()
    provider.createInvoice.mockRejectedValueOnce(rejection())
    expect((await issue(o.id)).status).toBe('STAMP_FAILED')
    const first = await row(o.id)
    expect(first).toMatchObject({ falloDefinitivo: true, attempts: 1 })
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: first.id } })).toBe(0)
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
    expect((await issue(o.id)).status).toBe('STAMPED')
    const second = await row(o.id)
    expect(second).toMatchObject({ attempts: 2, falloDefinitivo: false, taxCents: 0, totalCents: 11600 })
    expect(provider.createInvoice.mock.calls[1][0]).toMatchObject({
      externalId: `${second.idempotencyKey}#2`,
      idempotencyKey: `${second.idempotencyKey}#2`,
      items: [{ taxes: [{ rate: 0 }] }],
    })
    expect(await prisma.orderItemSelloIva.findFirst({ where: { cfdiId: second.id } })).toMatchObject({ intento: 2 })
  })
  // D21 (founder, 1-oct, opción A): una reserva heredada (sin protocoloIva) en un estado reintentable ya no puede existir. Las dos
  // pruebas que la fabricaban a partir de un intento incierto («legacy validación atrasada no pisa al ganador STAMPED/CANCELLED
  // tras vencer el TTL») se reemplazan por la del rechazo: volverla heredada falla y la transacción no deja nada a medias.
  it('un intento incierto ya no puede volverse heredada: la base lo rechaza y no libera sus sellos', async () => {
    const o = await order()
    provider.createInvoice.mockRejectedValueOnce(new Error('timeout'))
    await issue(o.id)
    const initial = await row(o.id)
    expect(initial).toMatchObject({ status: 'STAMP_FAILED', falloDefinitivo: false, protocoloIva: 1 })
    await expect(
      prisma.$transaction(async tx => {
        await sellosIva.liberarSellosDe(tx, initial.id)
        await tx.cfdi.update({
          where: { id: initial.id },
          data: { protocoloIva: null, entrada: Prisma.DbNull, entradaHuella: null, enviadoAt: null },
        })
      }),
    ).rejects.toThrow(/Cfdi_heredada_solo_terminada/)
    expect(await row(o.id)).toEqual(initial)
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: initial.id } })).toBe(1)
    expect(await prisma.orderItem.findUnique({ where: { id: o.items[0].id } })).toMatchObject({ ivaTratamiento: 'IVA_16' })
  })
  it('rechazo y liberación revierten juntos si falla la liberación', async () => {
    const o = await order()
    provider.createInvoice.mockRejectedValueOnce(rejection())
    const release = sellosIva.liberarSellosDe
    const spy = jest.spyOn(sellosIva, 'liberarSellosDe').mockImplementationOnce(async (tx, id) => {
      await release(tx, id)
      throw new Error('fallo después de liberar')
    })
    try {
      await expect(issue(o.id)).rejects.toThrow('fallo después de liberar')
      const current = await row(o.id)
      expect(current).toMatchObject({ status: 'STAMPING', falloDefinitivo: false, attempts: 1 })
      expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: current.id } })).toBe(1)
      expect(await prisma.orderItem.findUnique({ where: { id: o.items[0].id } })).toMatchObject({ ivaTratamiento: 'IVA_16' })
    } finally {
      spy.mockRestore()
    }
  })
  it('consulta recupera un timbre con su foto original sin volver a enviar', async () => {
    const o = await order()
    provider.createInvoice.mockRejectedValueOnce(new Error('timeout'))
    await issue(o.id)
    const first = await row(o.id)
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
    provider.findByExternalId.mockResolvedValue(stamped)
    expect((await issue(o.id)).status).toBe('STAMPED')
    expect(provider.findByExternalId).toHaveBeenCalledWith(`${first.idempotencyKey}#1`)
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(await row(o.id)).toMatchObject({ attempts: 1, entrada: first.entrada, entradaHuella: first.entradaHuella })
  })
  it('validación fallida guarda entrada sin sellos y recaptura al corregirse', async () => {
    const o = await order()
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
    await prisma.order.update({ where: { id: o.id }, data: { contratoDePrecio: 'DESCONOCIDO' } })
    const result = await issue(o.id)
    expect(result.status).toBe('VALIDATION_FAILED')
    const first = await row(o.id)
    expect(leerEntrada(first.entrada)).not.toBeNull()
    expect(first).toMatchObject({ attempts: 0, enviadoAt: null, protocoloIva: 1 })
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: first.id } })).toBe(0)
    expect(provider.createInvoice).not.toHaveBeenCalled()
    await prisma.order.update({ where: { id: o.id }, data: { contratoDePrecio: 'IVA_INCLUIDO' } })
    expect((await issue(o.id)).status).toBe('STAMPED')
    expect(await row(o.id)).toMatchObject({ attempts: 1 })
  })
  it('producto bloqueado conserva su motivo y una entrada no timbrable sin excepción', async () => {
    const o = await order()
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'BLOQUEADO_04' } })
    const result = await issue(o.id)
    expect(result.status).toBe('VALIDATION_FAILED')
    expect(result.reasons!.join(' ')).toMatch(/04|bloqueado|tratamiento/i)
    expect(leerEntrada((await row(o.id)).entrada)!.renglones[0].tratamiento).toBe('BLOQUEADO_04')
    expect(await prisma.orderItemSelloIva.count({ where: { orderItemId: o.items[0].id } })).toBe(0)
    expect(provider.createInvoice).not.toHaveBeenCalled()
  })
  it('dos emisiones concurrentes producen una sola llamada al PAC', async () => {
    const o = await order()
    const results = await Promise.allSettled([issue(o.id), issue(o.id)])
    expect(results.some(r => r.status === 'fulfilled' && r.value.status === 'STAMPED')).toBe(true)
    for (const r of results) if (r.status === 'rejected') expect(r.reason.statusCode).toBe(409)
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(await prisma.cfdi.count({ where: { orderId: o.id } })).toBe(1)
  })
  it('otro venue obtiene 404 sin fila ni sellos', async () => {
    const o = await order()
    await expect(issue(o.id, { expectedVenueId: 'otro' })).rejects.toThrow(/not found/)
    expect(await prisma.cfdi.count({ where: { orderId: o.id } })).toBe(0)
    expect(provider.createInvoice).not.toHaveBeenCalled()
  })
  it.each([
    ['timeout', () => new Error('timeout')],
    ['500 con code de rechazo', () => rejection(500)],
    ['422 desconocido', () => rejection(422, 'unknown')],
  ])('%s queda incierto incluso después de horas y escala una sola vez', async (_name, error) => {
    const o = await order()
    provider.createInvoice.mockRejectedValueOnce(error())
    await issue(o.id)
    const first = await row(o.id)
    expect(first.falloDefinitivo).toBe(false)
    await prisma.cfdi.update({ where: { id: first.id }, data: { enviadoAt: new Date(Date.now() - 61 * 60_000) } })
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
    for (let i = 0; i < 2; i++) await expect(issue(o.id)).rejects.toMatchObject({ statusCode: 409 })
    expect(await row(o.id)).toMatchObject({
      attempts: 1,
      entrada: first.entrada,
      entradaHuella: first.entradaHuella,
      status: 'STAMP_FAILED',
      falloDefinitivo: false,
    })
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: first.id } })).toBe(1)
    expect(await prisma.activityLog.count({ where: { venueId, entityId: first.id, action: 'CFDI_INTENTO_INCIERTO_ESCALADO' } })).toBe(1)
  })
  it.each(['STAMP_FAILED', 'STAMPED'] as const)('rechazo atrasado tras %s sólo aplica al RESET', async status => {
    const o = await order()
    provider.createInvoice.mockImplementationOnce(async () => {
      const cfdi = await row(o.id)
      await prisma.cfdi.update({ where: { id: cfdi.id }, data: { status, ...(status === 'STAMPED' ? { uuid: 'OTHER' } : {}) } })
      throw rejection()
    })
    await issue(o.id)
    expect(await row(o.id)).toMatchObject({ status, falloDefinitivo: status === 'STAMP_FAILED' })
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: (await row(o.id)).id } })).toBe(status === 'STAMP_FAILED' ? 0 : 1)
  })
  it('consultar mientras A procesa no reclama ni impide que A finalice', async () => {
    const o = await order()
    const entered = deferred()
    const release = deferred()
    provider.createInvoice.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return stamped
    })
    const a = issue(o.id)
    await Promise.race([entered.promise, a])
    try {
      await expect(issue(o.id)).rejects.toMatchObject({ statusCode: 409 })
      expect((await row(o.id)).attempts).toBe(1)
    } finally {
      release.resolve()
    }
    expect((await a).status).toBe('STAMPED')
    expect(await prisma.activityLog.count({ where: { venueId, action: 'CFDI_TIMBRE_DUPLICADO', entityId: (await row(o.id)).id } })).toBe(0)
  })
  it('pending guarda id sin UUID; consulta posterior por id completa la misma versión', async () => {
    const o = await order()
    provider.createInvoice.mockResolvedValueOnce({ ...stamped, status: 'pending', uuid: null })
    await expect(issue(o.id)).rejects.toMatchObject({ statusCode: 409 })
    const pending = await row(o.id)
    expect(pending).toMatchObject({ status: 'STAMPING', facturapiId: stamped.providerInvoiceId, uuid: null, attempts: 1 })
    expect((await issue(o.id)).status).toBe('STAMPED')
    expect(provider.getInvoice).toHaveBeenCalledWith(stamped.providerInvoiceId)
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
  })
  it('sustitución incierta bloquea una nueva llave después de cancelar la original', async () => {
    const o = await order()
    await issue(o.id)
    const original = await row(o.id)
    await prisma.cfdi.update({ where: { id: original.id }, data: { status: 'CANCELLED', cancelStatus: 'CANCELLED' } })
    await prisma.cfdi.create({
      data: {
        venueId,
        fiscalEmisorId,
        orderId: o.id,
        flow: 'STAFF_B',
        status: 'STAMP_FAILED',
        protocoloIva: 1,
        replacesCfdiId: original.id,
        idempotencyKey: `${original.idempotencyKey}-r1`,
        enviadoAt: new Date(),
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
    await expect(issue(o.id)).rejects.toMatchObject({ statusCode: 409 })
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(await prisma.cfdi.count({ where: { orderId: o.id } })).toBe(2)
  })
  it('exclusión global devuelve motivo y no crea reserva ni sellos', async () => {
    const o = await order()
    const spy = jest.spyOn(exclusionGlobal, 'excluirSiEstaEnGlobal').mockResolvedValue('La venta está incluida en una factura global.')
    try {
      await expect(issue(o.id)).rejects.toMatchObject({ statusCode: 409, message: 'La venta está incluida en una factura global.' })
      expect(await prisma.cfdi.count({ where: { orderId: o.id } })).toBe(0)
      expect(await prisma.orderItemSelloIva.count({ where: { orderItemId: o.items[0].id } })).toBe(0)
      expect(provider.createInvoice).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
  it('la transacción B repite exclusión si una global entra después de A', async () => {
    const o = await order()
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
    await prisma.order.update({ where: { id: o.id }, data: { contratoDePrecio: 'DESCONOCIDO' } })
    await issue(o.id)
    const before = await row(o.id)
    await prisma.order.update({ where: { id: o.id }, data: { contratoDePrecio: 'IVA_INCLUIDO' } })
    const spy = jest
      .spyOn(exclusionGlobal, 'excluirSiEstaEnGlobal')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('La venta está incluida en una factura global.')
    try {
      await expect(issue(o.id)).rejects.toMatchObject({ statusCode: 409, message: 'La venta está incluida en una factura global.' })
      expect(spy).toHaveBeenCalledTimes(2)
      expect(await row(o.id)).toEqual(before)
      expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: before.id } })).toBe(0)
      expect(provider.createInvoice).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
  it('el CAS de recaptura pierde si A fija enviadoAt después de la lectura de B', async () => {
    const o = await order()
    const aReserved = deferred()
    const releaseA = deferred()
    const bLookup = deferred()
    const releaseB = deferred()
    const aSending = deferred()
    const finishA = deferred()
    let transactions = 0
    const a = issueCfdiForOrder(
      { orderId: o.id, receptor, sandbox: true, expectedVenueId: venueId },
      {
        ...deps,
        runInTransaction: async work => {
          const result = await prisma.$transaction(work)
          if (++transactions === 1) {
            aReserved.resolve()
            await releaseA.promise
          }
          return result
        },
      },
    )
    await Promise.race([aReserved.promise, a])
    provider.findByExternalId.mockImplementationOnce(async () => {
      bLookup.resolve()
      await releaseB.promise
      return null
    })
    provider.createInvoice.mockImplementationOnce(async () => {
      aSending.resolve()
      await finishA.promise
      return stamped
    })
    const b = issue(o.id)
    const bResult = expect(b).rejects.toMatchObject({ statusCode: 409 })
    try {
      await Promise.race([bLookup.promise, b])
      releaseA.resolve()
      await Promise.race([aSending.promise, a])
      releaseB.resolve()
      await bResult
      expect((await row(o.id)).attempts).toBe(1)
    } finally {
      releaseA.resolve()
      releaseB.resolve()
      finishA.resolve()
    }
    expect((await a).status).toBe('STAMPED')
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
  })
  // D21: la «factura viva legacy sin llave» en STAMP_FAILED ya no puede existir (una heredada sólo existe terminada), así que la
  // prueba que la usaba para excluir otra emisión se reemplaza por el rechazo. La única heredada sin llave que sigue viva es la
  // TIMBRADA, y ésa sigue excluyendo: la emisión la devuelve como ya facturada, sin tocar al PAC.
  it('una heredada sin llave a medias ya no puede existir; timbrada, sigue excluyendo otra emisión', async () => {
    const o = await order()
    const heredada = (status: 'STAMP_FAILED' | 'STAMPED') =>
      prisma.cfdi.create({
        data: {
          venueId,
          fiscalEmisorId,
          orderId: o.id,
          flow: 'STAFF_B',
          status,
          protocoloIva: null,
          idempotencyKey: null,
          ...(status === 'STAMPED' ? { uuid: randomUUID(), facturapiId: randomUUID() } : {}),
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
    await expect(heredada('STAMP_FAILED')).rejects.toThrow(/Cfdi_heredada_solo_terminada/)
    expect(await prisma.cfdi.count({ where: { orderId: o.id } })).toBe(0)
    const timbrada = await heredada('STAMPED')
    expect(await issue(o.id)).toMatchObject({ status: 'STAMPED', alreadyIssued: true, cfdi: { id: timbrada.id } })
    expect(provider.createInvoice).not.toHaveBeenCalled()
    expect(await prisma.cfdi.count({ where: { orderId: o.id } })).toBe(1)
  })
  it('un fallo DESPUÉS de sellar revierte reserva y sellos juntos', async () => {
    const o = await order()
    const original = sellosIva.sellarRenglones
    const spy = jest.spyOn(sellosIva, 'sellarRenglones').mockImplementationOnce(async (tx, input) => {
      await original(tx, input)
      throw new Error('fallo después del sello')
    })
    try {
      await expect(issue(o.id)).rejects.toThrow('fallo después del sello')
      expect(await prisma.cfdi.count({ where: { orderId: o.id } })).toBe(0)
      expect(await prisma.orderItemSelloIva.count({ where: { orderItemId: o.items[0].id } })).toBe(0)
      expect(await prisma.orderItem.findUnique({ where: { id: o.items[0].id } })).toMatchObject({ ivaTratamiento: null })
      expect(provider.createInvoice).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
  it.each(['valid', 'pending', 'reject'])('una respuesta %s de otra versión no pisa el intento y deja evidencia', async mode => {
    const o = await order()
    provider.createInvoice.mockImplementationOnce(async () => {
      const current = await row(o.id)
      await prisma.cfdi.update({ where: { id: current.id }, data: { attempts: 2, lastError: 'otra versión' } })
      if (mode === 'reject') throw rejection()
      return mode === 'pending' ? { ...stamped, status: 'pending', uuid: null } : stamped
    })
    await expect(issue(o.id)).rejects.toMatchObject({ statusCode: 409 })
    const current = await row(o.id)
    expect(current).toMatchObject({
      attempts: 2,
      status: 'STAMPING',
      uuid: null,
      facturapiId: null,
      lastError: 'otra versión',
      falloDefinitivo: false,
    })
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: current.id } })).toBe(1)
    expect(await prisma.activityLog.findFirst({ where: { venueId, entityId: current.id, action: 'CFDI_TIMBRE_DUPLICADO' } })).toMatchObject(
      {
        data: expect.objectContaining({ attempts: 1, currentAttempts: 2, uuid: mode === 'valid' ? stamped.uuid : null, currentUuid: null }),
      },
    )
  })
  it('una respuesta válida tardía nunca resucita una cancelación confirmada', async () => {
    const o = await order()
    provider.createInvoice.mockImplementationOnce(async () => {
      const current = await row(o.id)
      await prisma.cfdi.update({ where: { id: current.id }, data: { status: 'CANCELLED', cancelStatus: 'CANCELLED' } })
      return stamped
    })
    await expect(issue(o.id)).rejects.toMatchObject({ statusCode: 409 })
    expect(await row(o.id)).toMatchObject({ status: 'CANCELLED', cancelStatus: 'CANCELLED', uuid: null })
  })
  it('a los 61 minutos también escala si la consulta al PAC falla', async () => {
    const o = await order()
    provider.createInvoice.mockRejectedValueOnce(new Error('timeout'))
    await issue(o.id)
    const cfdi = await row(o.id)
    await prisma.cfdi.update({ where: { id: cfdi.id }, data: { enviadoAt: new Date(Date.now() - 61 * 60_000) } })
    provider.findByExternalId.mockRejectedValue(new Error('offline'))
    await expect(issue(o.id)).rejects.toMatchObject({ statusCode: 409 })
    expect(await prisma.activityLog.count({ where: { venueId, entityId: cfdi.id, action: 'CFDI_INTENTO_INCIERTO_ESCALADO' } })).toBe(1)
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
  })
})

function rejection(status = 400, code = 'invalid_request') {
  const { ProviderHttpError } = require('@/services/fiscal/providers/facturapi.provider')
  return new ProviderHttpError(status, code, 'Rechazo de prueba')
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}
