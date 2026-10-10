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

const { isDisposableH1Url } = require('../../../scripts/h1-test-database.cjs')
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
// Sólo las bases fiscales locales existentes o una desechable H1 validada por el lanzador.
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !(['/av_db_25_iva_test', '/avoqado_h1a_test_20260808'].includes(database.pathname) || isDisposableH1Url(database))
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
    if (fiscalEmisorId) await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisorId } }) // id undefined = toda la tabla
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
    // C2 · OF-2 (T2 R4, cambia A PROPÓSITO): en la directa, el ganador deja «solicitada» (`CFDI_CANCELLED`, el controlador) y, como su
    // petición terminó en el hecho al instante, también «confirmada» (`CFDI_CANCEL_CONFIRMED`, origen DUENO). El perdedor, nada: una de cada una.
    const bitacora = await prisma.activityLog.findMany({
      where: { entityId: c.id, action: { in: ['CFDI_CANCELLED', 'CFDI_CANCEL_CONFIRMED'] } },
      select: { action: true },
      take: 10,
    })
    expect(bitacora.map(b => b.action).sort()).toEqual(
      path === 'directa' ? ['CFDI_CANCELLED', 'CFDI_CANCEL_CONFIRMED'] : ['CFDI_CANCEL_CONFIRMED'],
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
  // Plan 4b (Ruling 4b-R13): TODAS las órdenes antes del primer producto. La conciliación de Uber toma el producto con
  // FOR NO KEY UPDATE; si la cancelación lo tuviera mientras espera la orden que retiene la conciliación, habría 40P01.
  it('global sin orderId bloquea todas las órdenes del manifiesto, en orden, antes del producto que comparten y antes de liberar', async () => {
    const { o, c } = await fixtureFor('directa')
    const second = await order() // el MISMO producto del fixture: las dos órdenes lo comparten
    await prisma.cfdi.update({ where: { id: c.id }, data: { isGlobal: true, orderId: null } })
    await prisma.cfdiGlobalOrden.createMany({ data: [second.id, o.id].map(orderId => ({ cfdiId: c.id, orderId, huella: 'test' })) })
    await prisma.$transaction(tx =>
      sellosIva.sellarRenglones(tx, { cfdiId: c.id, intento: 1, renglones: [{ orderItemId: second.items[0].id, tratamiento: 'IVA_16' }] }),
    )
    const [, mayor] = [o.id, second.id].sort()
    const lock = jest.spyOn(admisionIva, 'bloquearOrdenesParaFacturar')
    let unlock!: () => void
    let locked!: () => void
    const held = new Promise<void>(resolve => {
      locked = resolve
    })
    const gate = new Promise<void>(resolve => {
      unlock = resolve
    })
    // Lo que tiene tomado una conciliación de Uber sobre la otra orden de la global.
    const holder = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${mayor} FOR UPDATE`
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
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"Order"%FOR UPDATE%'`
        waiting = waiters[0].n > 0
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
      // Detenida en la orden mayor, la cancelación no retiene el producto que comparten (con el bucle orden por orden: 55P03 aquí).
      await prisma.$transaction(tx => tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR NO KEY UPDATE NOWAIT`)
      expect(await seals(c.id)).toBe(2)
      expect((await row(o.id)).status).toBe('STAMPED')
    } finally {
      unlock()
      await holder
      await cancelling
    }
    // Sin negocio: el manifiesto ya está acotado por la factura (Ruling 4b-R13, mismas filas que el bucle por id de antes).
    // C2 · Tarea 2 (cambia a propósito): la INTENCIÓN de cancelar se anota bajo los mismos candados de la emisión, antes del PAC
    // (`anotarIntencionDeCancelar`), y el desenlace los vuelve a tomar (`aplicarCancelacion`): dos tomas, las dos con TODAS las órdenes
    // del manifiesto, en orden y sin negocio.
    const todas = [[o.id, second.id].sort(), undefined]
    expect(lock.mock.calls.map(call => [call[1], call[2]])).toEqual([todas, todas])
    expect(await seals(c.id)).toBe(0)
    expect((await currentItem(o.items[0].id)).ivaTratamiento).toBeNull()
    expect((await currentItem(second.items[0].id)).ivaTratamiento).toBeNull()
  })
  // C2 · Tarea 2 · ronda 1 (M4): la de arriba se detiene ahora en la INTENCIÓN (la primera toma de candados). Esta variante toma el
  // candado de la orden DESPUÉS de anotar la intención —entre la consulta al PAC y el desenlace—, así que es `aplicarCancelacion` la que
  // espera la orden mayor: tampoco retiene el producto que comparten mientras espera, ni libera sellos antes de tenerlas todas.
  it('control — global, bajo contención ENTRE el PAC y el desenlace: el desenlace espera la orden mayor sin retener el producto ni liberar antes', async () => {
    const { o, c } = await fixtureFor('directa')
    const second = await order()
    await prisma.cfdi.update({ where: { id: c.id }, data: { isGlobal: true, orderId: null } })
    await prisma.cfdiGlobalOrden.createMany({ data: [second.id, o.id].map(orderId => ({ cfdiId: c.id, orderId, huella: 'test' })) })
    await prisma.$transaction(tx =>
      sellosIva.sellarRenglones(tx, { cfdiId: c.id, intento: 1, renglones: [{ orderItemId: second.items[0].id, tratamiento: 'IVA_16' }] }),
    )
    const [, mayor] = [o.id, second.id].sort()
    let unlock!: () => void
    let locked!: () => void
    const held = new Promise<void>(resolve => {
      locked = resolve
    })
    const gate = new Promise<void>(resolve => {
      unlock = resolve
    })
    let holder: Promise<unknown> = Promise.resolve()
    let lock!: jest.SpyInstance
    // La consulta previa al PAC ocurre DESPUÉS de anotar la intención: ahí una conciliación de Uber toma la orden mayor.
    provider.getCancellationStatus.mockImplementationOnce(async () => {
      expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ cancelStatus: 'REQUESTED', cancelIntento: 1 })
      lock = jest.spyOn(admisionIva, 'bloquearOrdenesParaFacturar') // sólo la toma del DESENLACE
      holder = prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${mayor} FOR UPDATE`
          locked()
          await gate
        },
        { timeout: 15000 },
      )
      await held
      return { status: 'canceled', cancelledAt: new Date() }
    })
    const cancelling = cancel('directa', c)
    try {
      await held
      let waiting = false
      for (let tries = 0; tries < 200 && !waiting; tries++) {
        const waiters = await prisma.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"Order"%FOR UPDATE%'`
        waiting = waiters[0].n > 0
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
      expect(lock).toHaveBeenCalledTimes(1) // la toma del DESENLACE (la de la intención terminó antes de la consulta)
      // Detenido en la orden mayor, el desenlace no retiene el producto que comparten.
      await prisma.$transaction(tx => tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR NO KEY UPDATE NOWAIT`)
      expect(await seals(c.id)).toBe(2)
      expect((await row(o.id)).status).toBe('STAMPED')
    } finally {
      unlock()
      await holder
      await cancelling
    }
    const todas = [[o.id, second.id].sort(), undefined]
    expect(lock.mock.calls.map(call => [call[1], call[2]])).toEqual([todas])
    expect(await seals(c.id)).toBe(0)
    expect((await row(o.id)).status).toBe('CANCELLED')
  })

  // Plan 4b (Ruling 4b-R13, «mismas filas»): una orden de la global que después se movió a otro negocio de la organización
  // (playtelecomEventSimReassignment) sigue siendo de ESTA factura: la cancelación la toma igual, por id, antes de liberar sus
  // sellos. Filtrar por el negocio de la factura la dejaba sin candado.
  it('global: la orden del manifiesto que se movió a otro negocio de la organización también se bloquea antes de liberar', async () => {
    const { o, c } = await fixtureFor('directa')
    const movida = await order()
    await prisma.cfdi.update({ where: { id: c.id }, data: { isGlobal: true, orderId: null } })
    await prisma.cfdiGlobalOrden.createMany({ data: [o.id, movida.id].map(orderId => ({ cfdiId: c.id, orderId, huella: 'test' })) })
    await prisma.$transaction(tx =>
      sellosIva.sellarRenglones(tx, { cfdiId: c.id, intento: 1, renglones: [{ orderItemId: movida.items[0].id, tratamiento: 'IVA_16' }] }),
    )
    const otroNegocio = `${fixture}-b`
    await prisma.venue.create({ data: { id: otroNegocio, organizationId: fixture, name: otroNegocio, slug: otroNegocio } })
    await prisma.order.update({ where: { id: movida.id }, data: { venueId: otroNegocio } })
    let unlock!: () => void
    let locked!: (pid: number) => void
    const held = new Promise<number>(resolve => {
      locked = resolve
    })
    const gate = new Promise<void>(resolve => {
      unlock = resolve
    })
    // Lo que retiene otro actor sobre la orden movida (una emisión o una nota de crédito sobre sus renglones).
    const holder = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${movida.id} FOR UPDATE`
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        locked(pid)
        await gate
      },
      { timeout: 15000 },
    )
    const holderPid = await held
    const cancelling = cancel('directa', c)
    try {
      let waiting = false
      for (let tries = 0; tries < 200 && !waiting; tries++) {
        const waiters = await prisma.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
            AND query LIKE '%"Order"%FOR UPDATE%'`
        waiting = waiters[0].n > 0
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true) // la cancelación espera la orden movida: la tomó por id
      expect(await seals(c.id)).toBe(2)
      expect((await row(o.id)).status).toBe('STAMPED')
    } finally {
      unlock()
      await holder
      await cancelling
      await prisma.order.update({ where: { id: movida.id }, data: { venueId } })
      await prisma.venue.deleteMany({ where: { id: otroNegocio } })
    }
    expect(await seals(c.id)).toBe(0)
    expect((await currentItem(movida.items[0].id)).ivaTratamiento).toBeNull()
    expect((await row(o.id)).status).toBe('CANCELLED')
  })
  // C2 · Tarea 2 (cambia a propósito): con la intención anotada ANTES del PAC, mientras el POST vuela la fila ya está `REQUESTED`, y el
  // webhook manda una fila `REQUESTED` a la CONSULTA (`refreshPendingCancellation`), no a la sincronización externa: es esa consulta la que
  // aplica el hecho en `ENVIANDO` (C2-29). La consulta previa al POST no ve cancelación (el doble de este archivo dice «cancelada» por
  // defecto). El dueño que envió reporta lo que quedó (`applied`: él mandó el intento).
  it('pending directo atrasado no degrada una confirmación que llegó por la consulta ni libera dos veces', async () => {
    const { o, c } = await fixtureFor('directa')
    let entered!: () => void
    let respond!: (result: any) => void
    const ready = new Promise<void>(resolve => {
      entered = resolve
    })
    provider.getCancellationStatus.mockResolvedValueOnce({ status: 'none', cancelledAt: null }) // la consulta previa al POST
    provider.cancelInvoice.mockImplementation(() => {
      entered()
      return new Promise(resolve => {
        respond = resolve
      })
    })
    const direct = cancel('directa', c)
    await ready
    const release = jest.spyOn(sellosIva, 'liberarSellosDe')
    const enVuelo = await prisma.cfdi.findUniqueOrThrow({ where: { id: c.id }, include: { fiscalEmisor: true } })
    expect(enVuelo).toMatchObject({ cancelStatus: 'REQUESTED', cancelEnviadaAt: expect.any(Date) })
    await cancel('pendiente', enVuelo) // el aviso del webhook: el PAC ya dice «cancelada»
    respond({ status: 'pending', cancelledAt: null })
    expect(await direct).toMatchObject({ cancelStatus: 'CANCELLED' })
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
