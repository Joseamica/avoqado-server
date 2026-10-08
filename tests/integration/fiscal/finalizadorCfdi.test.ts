import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import prisma from '@/utils/prismaClient'
import { finalizarTimbre, completarArchivos, escalarIntentoIncierto } from '@/services/fiscal/finalizadorCfdi'
import { reconcileStuckCfdi } from '@/services/fiscal/cfdiReconcile.service'
import { sellarRenglones } from '@/services/fiscal/sellosIva'

const { isDisposableH1Url } = require('../../../scripts/h1-test-database.cjs')
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
// Sólo las bases fiscales locales existentes o una desechable H1 validada por el lanzador.
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !(['/av_db_25_iva_test', '/avoqado_h1a_test_20260808'].includes(database.pathname) || isDisposableH1Url(database))
)
  throw new Error('Exige av_db_25_iva_test o una base H1 desechable validada, locales.')
const xml = readFileSync(join(__dirname, '../../fixtures/cfdi/iva16-exento.xml'))

describe('finalizador y conciliación reales', () => {
  const fixture = `finalizador-${randomUUID()}`
  let venueId: string, fiscalEmisorId: string, productId: string
  const stamped = {
    status: 'valid' as const,
    providerInvoiceId: 'pac',
    uuid: 'uuid',
    serie: 'F',
    folio: '9',
    stampedAt: new Date(),
    totalCents: 11600,
  }
  const provider = {
    getInvoice: jest.fn(),
    findByExternalId: jest.fn(),
    searchInvoices: jest.fn(),
    downloadXml: jest.fn(),
    downloadPdf: jest.fn(),
  }
  const storeArtifact = jest.fn(async (_buffer: Buffer, path: string) => `https://example.test/${path}`)
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
    venueId = (await prisma.venue.create({ data: { organizationId: fixture, name: fixture, slug: fixture } })).id
    const category = await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })
    productId = (await prisma.product.create({ data: { venueId, categoryId: category.id, name: fixture, sku: fixture, price: 116 } })).id
    fiscalEmisorId = (
      await prisma.fiscalEmisor.create({
        data: { venueId, rfc: 'AAA010101AAA', legalName: fixture, regimenFiscal: '601', lugarExpedicion: '01000' },
      })
    ).id
  })
  beforeEach(() => {
    stamped.uuid = randomUUID()
    provider.getInvoice.mockReset().mockResolvedValue(stamped)
    provider.findByExternalId.mockReset().mockResolvedValue(null)
    provider.searchInvoices.mockReset().mockResolvedValue({ invoices: [stamped], truncated: false })
    provider.downloadXml.mockReset().mockResolvedValue(xml)
    provider.downloadPdf.mockReset().mockResolvedValue(Buffer.from('%PDF'))
    storeArtifact.mockClear()
  })
  afterAll(async () => {
    if (!venueId) return
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.orderItemSelloIva.deleteMany({ where: { cfdi: { venueId } } })
    await prisma.cfdi.deleteMany({ where: { venueId } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: fixture } })
  })
  async function reservation(extra = {}) {
    const order = await prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        subtotal: 100,
        taxAmount: 16,
        total: 116,
        items: { create: { productId, quantity: 1, unitPrice: 100, taxAmount: 16, total: 116 } },
      },
      include: { items: true },
    })
    const cfdi = await prisma.cfdi.create({
      data: {
        venueId,
        fiscalEmisorId,
        orderId: order.id,
        flow: 'STAFF_B',
        status: 'STAMPING',
        attempts: 1,
        protocoloIva: 1,
        enviadoAt: new Date(),
        idempotencyKey: randomUUID(),
        receptorRfc: 'XAXX010101000',
        receptorNombre: 'PUBLICO',
        receptorRegimen: '616',
        receptorCp: '01000',
        usoCfdi: 'S01',
        formaPago: '01',
        metodoPago: 'PUE',
        subtotalCents: 10000,
        taxCents: 1600,
        totalCents: 11600,
        ...extra,
      },
    })
    await prisma.$transaction(tx =>
      sellarRenglones(tx, { cfdiId: cfdi.id, intento: 1, renglones: [{ orderItemId: order.items[0].id, tratamiento: 'IVA_16' }] }),
    )
    return cfdi
  }
  const current = (id: string) => prisma.cfdi.findUniqueOrThrow({ where: { id } })
  const seals = (id: string) => prisma.orderItemSelloIva.findMany({ where: { cfdiId: id } })
  const finish = (row: any, extra = {}) =>
    finalizarTimbre({
      cfdiId: row.id,
      idempotencyKey: row.idempotencyKey,
      version: row.attempts,
      identidad: { ...stamped, facturapiId: stamped.providerInvoiceId },
      ...extra,
    })
  const reconcile = (row: any) =>
    reconcileStuckCfdi({ cfdi: row, now: new Date(), sandbox: true }, { resolveProvider: () => provider as any, storeArtifact })
  const artifacts = (row: any) =>
    completarArchivos(
      {
        cfdiId: row.id,
        idempotencyKey: row.idempotencyKey,
        providerInvoiceId: 'pac',
        venueSlug: fixture,
        uuid: stamped.uuid,
        provider: provider as any,
      },
      { storeArtifact },
    )
  it('RESET conserva sellos y versión; el timbre tardío finaliza sin resellar', async () => {
    const row = await reservation(),
      before = await seals(row.id)
    expect((await reconcile(row)).outcome).toBe('RESET')
    expect(await current(row.id)).toMatchObject({ status: 'STAMP_FAILED', attempts: 1, falloDefinitivo: false })
    expect(await seals(row.id)).toEqual(before)
    expect(await finish(row)).toBe('FINALIZADO')
    expect(await current(row.id)).toMatchObject({ status: 'STAMPED', uuid: stamped.uuid })
    expect(await seals(row.id)).toEqual(before)
  })
  it('recupera pending por id y conserva UUID, serie y folio', async () => {
    const row = await reservation({ facturapiId: 'pac' })
    expect((await reconcile(row)).outcome).toBe('COMPLETED')
    expect(provider.getInvoice).toHaveBeenCalledWith('pac')
    expect(await current(row.id)).toMatchObject({ status: 'STAMPED', uuid: stamped.uuid, serie: 'F', folio: '9', attempts: 1 })
  })
  it('pausa controlada: RESET tardío no degrada un timbre concurrente', async () => {
    const row = await reservation()
    let release!: () => void, searched!: () => void
    const found = new Promise<void>(resolve => {
      searched = resolve
    })
    const resume = new Promise<void>(resolve => {
      release = resolve
    })
    provider.findByExternalId.mockImplementationOnce(async () => {
      searched()
      await resume
      return null
    })
    const pending = reconcile(row)
    await found
    await finish(row)
    release()
    expect((await pending).outcome).toBe('SKIPPED')
    expect(await current(row.id)).toMatchObject({ status: 'STAMPED', uuid: stamped.uuid, attempts: 1 })
  })
  it.each([{ attempts: 2 }, { status: 'CANCELLED' as const }])('detecta respuesta vieja/cancelada %p', async extra => {
    const row = await reservation(extra),
      before = await current(row.id),
      originalSeals = await seals(row.id)
    expect(await finish(row, { version: 1 })).toBe('DUPLICADO')
    expect(await current(row.id)).toEqual(before)
    expect(await seals(row.id)).toEqual(originalSeals)
    expect(await prisma.activityLog.count({ where: { venueId, entityId: row.id, action: 'CFDI_TIMBRE_DUPLICADO' } })).toBe(1)
  })
  it('idempotente sólo si coincide versión, identidad y estado STAMPED', async () => {
    const row = await reservation()
    expect(await finish(row)).toBe('FINALIZADO')
    expect(await finish(row)).toBe('YA_FINALIZADO')
    await prisma.cfdi.update({ where: { id: row.id }, data: { status: 'CANCELLED' } })
    expect(await finish(row)).toBe('DUPLICADO')
  })
  it('otra identidad o versión sobre STAMPED no cuenta como idempotencia', async () => {
    const row = await reservation()
    await finish(row)
    const before = await current(row.id)
    expect(await finish(row, { identidad: { ...stamped, facturapiId: 'otro-pac' } })).toBe('DUPLICADO')
    expect(await finish(row, { version: 0 })).toBe('DUPLICADO')
    expect(await current(row.id)).toEqual(before)
  })
  it('protocolo 1 jamás recupera por RFC+total; incierto sigue consultable por versión', async () => {
    const row = await reservation()
    await reconcile(row)
    expect(provider.searchInvoices).not.toHaveBeenCalled()
    expect(provider.findByExternalId).toHaveBeenCalledWith(`${row.idempotencyKey}#1`)
    expect((await current(row.id)).facturapiId).toBeNull()
    provider.findByExternalId.mockResolvedValueOnce(stamped)
    expect((await reconcile(await current(row.id))).outcome).toBe('COMPLETED')
  })
  it.each([
    { status: 'pending', uuid: null },
    { status: 'valid', uuid: null },
  ])('no finaliza PAC incompleto %p', async response => {
    const row = await reservation({ facturapiId: 'pac' })
    provider.getInvoice.mockResolvedValueOnce({ ...stamped, ...response })
    expect((await reconcile(row)).outcome).toBe('INCONCLUSIVE')
    expect((await current(row.id)).status).toBe('STAMPING')
  })
  it('fallar storage no oculta un timbre válido', async () => {
    const row = await reservation({ facturapiId: 'pac' })
    provider.downloadXml.mockRejectedValueOnce(new Error('storage offline'))
    expect((await reconcile(row)).outcome).toBe('COMPLETED')
    expect(await current(row.id)).toMatchObject({ status: 'STAMPED', uuid: stamped.uuid, xmlUrl: null })
  })
  it.each([false, true])('escala una sola vez tras 61 minutos, PAC falla=%s y consulta concurrente', async failure => {
    const row = await reservation({ status: 'STAMP_FAILED', enviadoAt: new Date(Date.now() - 61 * 60_000) }),
      before = await current(row.id),
      originalSeals = await seals(row.id)
    if (failure) provider.findByExternalId.mockRejectedValue(new Error('PAC offline'))
    await Promise.all([reconcile(row), escalarIntentoIncierto(row)])
    await reconcile(row)
    expect(await prisma.activityLog.count({ where: { venueId, entityId: row.id, action: 'CFDI_INTENTO_INCIERTO_ESCALADO' } })).toBe(1)
    expect(await current(row.id)).toEqual(before)
    expect(await seals(row.id)).toEqual(originalSeals)
  })
  it('archivos y desglose del XML; una cancelación durante descarga impide escribirlos', async () => {
    const row = await reservation()
    await finish(row)
    expect(await artifacts(row)).toBe('OK')
    expect(await current(row.id)).toMatchObject({
      xmlUrl: expect.stringContaining('.xml'),
      pdfUrl: expect.stringContaining('.pdf'),
      taxBreakdown: [
        { impuesto: '002', tipoFactor: 'Tasa', tasa: '0.160000', base: '100.00', importe: '16.00' },
        { impuesto: '002', tipoFactor: 'Exento', tasa: null, base: '50.00', importe: null },
      ],
    })
    const cancelled = await reservation()
    stamped.uuid = randomUUID()
    await finish(cancelled)
    provider.downloadXml.mockImplementationOnce(async () => {
      await prisma.cfdi.update({ where: { id: cancelled.id }, data: { status: 'CANCELLED' } })
      return xml
    })
    expect(await artifacts(cancelled)).toBe('FALLO')
    expect(await current(cancelled.id)).toMatchObject({ status: 'CANCELLED', xmlUrl: null, pdfUrl: null, taxBreakdown: null })
  })
})
