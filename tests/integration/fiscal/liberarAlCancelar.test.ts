jest.unmock('@/services/dashboard/activity-log.service')
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))
import * as admisionIva from '@/services/fiscal/admisionIva'
import * as sellosIva from '@/services/fiscal/sellosIva'
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { issueCfdiForOrder, cancelCfdi, refreshPendingCancellation, sincronizarCancelacionExterna } from '@/services/fiscal/cfdi.service'
import { leerEntrada } from '@/services/fiscal/entradaDocumental'
import { encenderIvaPorProducto } from '../../__helpers__/iva-por-producto'

import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import { replaceCfdi } from '@/services/fiscal/cfdiReplacement.service'
import { finalizarTimbre } from '@/services/fiscal/finalizadorCfdi'
import { cancelCfdiController } from '@/controllers/dashboard/cfdi.dashboard.controller'

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

describe('liberar sellos al confirmar cancelación', () => {
  const fixture = `emision-iva-${randomUUID()}`
  let venueId: string
  let productId: string
  let fiscalEmisorId: string
  const provider = {
    name: 'facturapi',
    createInvoice: jest.fn(),
    cancelInvoice: jest.fn(),
    getCancellationStatus: jest.fn(),
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
    jest.mocked(resolveFiscalProvider).mockReturnValue(provider as any)
    provider.cancelInvoice.mockReset().mockResolvedValue({ status: 'canceled', cancelledAt: new Date() })
    provider.getCancellationStatus.mockReset().mockResolvedValue({ status: 'canceled', cancelledAt: new Date() })
    stamped.uuid = randomUUID()
    stamped.providerInvoiceId = randomUUID()
    provider.createInvoice.mockReset().mockResolvedValue(stamped)
    provider.findByExternalId.mockReset().mockResolvedValue(null)
    provider.getInvoice.mockReset().mockResolvedValue(stamped)
    provider.downloadXml.mockResolvedValue(Buffer.from('<Comprobante/>'))
    provider.downloadPdf.mockResolvedValue(Buffer.from('%PDF'))
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_16' } })
  })
  afterEach(() => jest.restoreAllMocks())
  afterAll(async () => {
    if (!venueId) return
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.orderItemSelloIva.deleteMany({ where: { cfdi: { venueId } } })
    await prisma.cfdiGlobalOrden.deleteMany({ where: { cfdi: { venueId } } })
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
  const paths = ['directa', 'pendiente', 'externa'] as const
  type Path = (typeof paths)[number]
  async function fixtureFor(path: Path) {
    const o = await order()
    await issue(o.id)
    const c = await row(o.id)
    if (path === 'pendiente') await prisma.cfdi.update({ where: { id: c.id }, data: { cancelStatus: 'REQUESTED' } })
    return { o, c: await prisma.cfdi.findUniqueOrThrow({ where: { id: c.id }, include: { fiscalEmisor: true } }) }
  }
  async function cancel(path: Path, c: any) {
    if (path === 'directa') return cancelCfdi({ cfdiId: c.id, motivo: '02', sandbox: true, expectedVenueId: venueId })
    if (path === 'pendiente') return refreshPendingCancellation(c, { sandbox: true })
    return sincronizarCancelacionExterna(c, { sandbox: true })
  }
  const seals = (cfdiId: string) => prisma.orderItemSelloIva.count({ where: { cfdiId } })
  const currentItem = (id: string) => prisma.orderItem.findUniqueOrThrow({ where: { id } })

  it.each(paths)('%s: confirma y libera sólo esa factura, preservando el sello de su sustituta', async path => {
    const { o, c } = await fixtureFor(path)
    const data = c
    const substitute = await prisma.cfdi.create({
      data: {
        venueId,
        fiscalEmisorId,
        orderId: o.id,
        flow: 'STAFF_B',
        status: 'STAMPED',
        receptorRfc: data.receptorRfc,
        receptorNombre: data.receptorNombre,
        receptorRegimen: data.receptorRegimen,
        receptorCp: data.receptorCp,
        usoCfdi: data.usoCfdi,
        formaPago: '01',
        metodoPago: 'PUE',
        subtotalCents: 10000,
        taxCents: 1600,
        totalCents: 11600,
        replacesCfdiId: c.id,
        uuid: randomUUID(),
      },
    })
    await prisma.$transaction(tx =>
      sellosIva.sellarRenglones(tx, {
        cfdiId: substitute.id,
        intento: 1,
        renglones: [{ orderItemId: o.items[0].id, tratamiento: 'IVA_16' }],
      }),
    )
    if (path === 'directa') {
      expect((await replaceCfdi({ cfdiId: c.id, sandbox: true, expectedVenueId: venueId })).cancelPendiente).toBe(false)
    } else await cancel(path, c)
    expect(await seals(c.id)).toBe(0)
    expect(await seals(substitute.id)).toBe(1)
    expect((await currentItem(o.items[0].id)).ivaTratamiento).toBe('IVA_16')
    expect((await row(o.id)).status).toBe('CANCELLED')
  })
  it.each(paths.flatMap(path => ['pending', 'rejected'].map(status => [path, status] as const)))(
    '%s: %s conserva sellos',
    async (path, status) => {
      const { o, c } = await fixtureFor(path)
      provider.cancelInvoice.mockResolvedValue({ status, cancelledAt: null })
      provider.getCancellationStatus.mockResolvedValue({ status, cancelledAt: null })
      await cancel(path, c)
      expect(await seals(c.id)).toBe(1)
      expect((await currentItem(o.items[0].id)).ivaTratamiento).toBe('IVA_16')
      expect((await row(o.id)).status).toBe('STAMPED')
    },
  )
  it.each(paths)('%s: dos confirmaciones concurrentes liberan y auditan sólo al ganador', async path => {
    const { o, c } = await fixtureFor(path)
    const release = jest.spyOn(sellosIva, 'liberarSellosDe')
    // Both requests finish their read before either provider response arrives.
    let arrived = 0
    let proceed!: () => void
    const both = new Promise<void>(resolve => {
      proceed = resolve
    })
    const response = async () => {
      if (++arrived === 2) proceed()
      await both
      return { status: 'canceled', cancelledAt: new Date() }
    }
    provider.cancelInvoice.mockImplementation(response)
    provider.getCancellationStatus.mockImplementation(response)
    const run = async () => {
      if (path !== 'directa') return cancel(path, c)
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
      await cancelCfdiController({ params: { cfdiId: c.id, venueId }, body: { motivo: '02' }, authContext: { venueId } } as any, res)
      expect(res.status).toHaveBeenCalledWith(200)
    }
    await Promise.all([run(), run()])
    expect(release).toHaveBeenCalledTimes(1)
    expect(await prisma.activityLog.count({ where: { entityId: c.id, action: { in: ['CFDI_CANCELLED', 'CFDI_CANCEL_CONFIRMED'] } } })).toBe(
      1,
    )
    expect(await seals(c.id)).toBe(0)
    expect((await currentItem(o.items[0].id)).ivaTratamiento).toBeNull()
    release.mockRestore()
  })
  it.each(paths)('%s: una respuesta de otra versión no cancela ni libera', async path => {
    const { o, c } = await fixtureFor(path)
    const response = async () => {
      await prisma.cfdi.update({ where: { id: c.id }, data: { attempts: { increment: 1 } } })
      return { status: 'canceled', cancelledAt: new Date() }
    }
    provider.cancelInvoice.mockImplementation(response)
    provider.getCancellationStatus.mockImplementation(response)
    await cancel(path, c)
    expect((await row(o.id)).status).toBe('STAMPED')
    expect(await seals(c.id)).toBe(1)
    expect(await prisma.activityLog.count({ where: { entityId: c.id, action: 'CFDI_CANCEL_CONFIRMED' } })).toBe(0)
  })
  it.each(paths)('%s: fallo al liberar revierte también CANCELLED', async path => {
    const { o, c } = await fixtureFor(path)
    const release = jest.spyOn(sellosIva, 'liberarSellosDe').mockRejectedValueOnce(new Error('release failed'))
    await expect(cancel(path, c)).rejects.toThrow('release failed')
    release.mockRestore()
    expect((await row(o.id)).status).toBe('STAMPED')
    expect(await seals(c.id)).toBe(1)
  })
  it.each(paths)('%s: accepted también libera los sellos', async path => {
    const { o, c } = await fixtureFor(path)
    provider.cancelInvoice.mockResolvedValue({ status: 'accepted', cancelledAt: null })
    provider.getCancellationStatus.mockResolvedValue({ status: 'accepted', cancelledAt: null })
    await cancel(path, c)
    expect(await seals(c.id)).toBe(0)
    expect((await currentItem(o.items[0].id)).ivaTratamiento).toBeNull()
    expect(await row(o.id)).toMatchObject({ status: 'CANCELLED', cancelStatus: 'ACCEPTED' })
  })
  it('global sin orderId bloquea todas las órdenes del manifiesto en orden antes de liberar', async () => {
    const { o, c } = await fixtureFor('directa')
    const second = await order()
    await prisma.cfdi.update({ where: { id: c.id }, data: { isGlobal: true, orderId: null } })
    await prisma.cfdiGlobalOrden.createMany({ data: [second.id, o.id].map(orderId => ({ cfdiId: c.id, orderId, huella: 'test' })) })
    await prisma.$transaction(tx =>
      sellosIva.sellarRenglones(tx, { cfdiId: c.id, intento: 1, renglones: [{ orderItemId: second.items[0].id, tratamiento: 'IVA_16' }] }),
    )
    const lock = jest.spyOn(admisionIva, 'bloquearOrdenParaFacturar')
    let unlock!: () => void
    let locked!: () => void
    const held = new Promise<void>(resolve => {
      locked = resolve
    })
    const gate = new Promise<void>(resolve => {
      unlock = resolve
    })
    const holder = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${o.id} FOR UPDATE`
        locked()
        await gate
      },
      { timeout: 15000 },
    )
    await held
    const cancelling = cancel('directa', c)
    try {
      let waiting = false
      for (let tries = 0; tries < 200 && !waiting; tries++) {
        const waiters = await prisma.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE OF o%'`
        waiting = waiters[0].n > 0
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
      expect(await seals(c.id)).toBe(2)
      expect((await row(o.id)).status).toBe('STAMPED')
    } finally {
      unlock()
      await holder
      await cancelling
    }
    expect(lock.mock.calls.map(call => call[1])).toEqual([o.id, second.id].sort())
    expect(await seals(c.id)).toBe(0)
    expect((await currentItem(o.items[0].id)).ivaTratamiento).toBeNull()
    expect((await currentItem(second.items[0].id)).ivaTratamiento).toBeNull()
  })
  it('pending directo atrasado no degrada una confirmación externa ni libera dos veces', async () => {
    const { o, c } = await fixtureFor('directa')
    let entered!: () => void
    let respond!: (result: any) => void
    const ready = new Promise<void>(resolve => {
      entered = resolve
    })
    provider.cancelInvoice.mockImplementation(() => {
      entered()
      return new Promise(resolve => {
        respond = resolve
      })
    })
    const direct = cancel('directa', c)
    await ready
    const release = jest.spyOn(sellosIva, 'liberarSellosDe')
    await cancel('externa', c)
    respond({ status: 'pending', cancelledAt: null })
    expect(await direct).toMatchObject({ applied: false, cancelStatus: 'CANCELLED' })
    expect(release).toHaveBeenCalledTimes(1)
    expect((await row(o.id)).status).toBe('CANCELLED')
    expect(await seals(c.id)).toBe(0)
  })
  it('respuesta pendiente vieja no escribe desde STAMP_FAILED aunque coincida attempts', async () => {
    const { o, c } = await fixtureFor('pendiente')
    await prisma.cfdi.update({ where: { id: c.id }, data: { status: 'STAMP_FAILED' } })
    await cancel('pendiente', c)
    expect((await row(o.id)).status).toBe('STAMP_FAILED')
    expect(await seals(c.id)).toBe(1)
  })
  it('tras cancelar, -n2 captura el IVA corregido y una finalización vieja no revive la original', async () => {
    const { o, c } = await fixtureFor('directa')
    await cancel('directa', c)
    expect(
      await finalizarTimbre({
        cfdiId: c.id,
        idempotencyKey: c.idempotencyKey,
        version: c.attempts,
        identidad: { status: 'valid', facturapiId: c.facturapiId!, uuid: c.uuid, serie: c.serie, folio: c.folio, stampedAt: c.stampedAt },
      }),
    ).toBe('DUPLICADO')
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
    stamped.uuid = randomUUID()
    stamped.providerInvoiceId = randomUUID()
    expect((await issue(o.id)).status).toBe('STAMPED')
    const next = await prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: `cfdi-order-${o.id}-n2` } })
    expect(leerEntrada(next.entrada)!.renglones[0].tratamiento).toBe('IVA_0')
    expect(next.taxCents).toBe(0)
    expect((await row(o.id)).status).toBe('CANCELLED')
    expect(await seals(c.id)).toBe(0)
  })
})
