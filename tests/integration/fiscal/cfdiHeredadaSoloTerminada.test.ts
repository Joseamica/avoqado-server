// Las regresiones de abajo usan los servicios con sus dependencias reales (cancelación, consulta del trámite, confirmación
// externa); sólo el PAC es de mentira, igual que en liberarAlCancelar.
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { CfdiStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import { issueCfdiForOrder, cancelCfdi, refreshPendingCancellation, sincronizarCancelacionExterna } from '@/services/fiscal/cfdi.service'
import { replaceCfdi } from '@/services/fiscal/cfdiReplacement.service'
import { encenderIvaPorProducto } from '../../__helpers__/iva-por-producto'

const { isDisposableH1Url } = require('../../../scripts/h1-test-database.cjs')
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
// Misma guarda que emisionIndividualSellada: base local desechable (o la de CI), nunca otra. Se admite además la base
// desechable propia de este bloque (av_db_25_iva_test_b3c).
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !(
    ['/av_db_25_iva_test', '/av_db_25_iva_test_b3c', '/avoqado_h1a_test_20260808'].includes(database.pathname) ||
    isDisposableH1Url(database)
  )
) {
  throw new Error('Esta suite exige la base local av_db_25_iva_test(_b3c) o una base H1 desechable validada.')
}

type Extra = { protocoloIva: number | null; status: CfdiStatus }

/**
 * IVA por producto, D21 (decisión del founder 1-oct, opción A): una reserva heredada (sin protocoloIva) sólo puede existir
 * terminada. Así la ruta vieja de emisión no puede volver a timbrar ni dejar una venta facturada sin sellar.
 */
describe('Cfdi_heredada_solo_terminada', () => {
  const NO_TERMINADOS = ['DRAFT', 'VALIDATING', 'VALIDATION_FAILED', 'STAMPING', 'STAMP_FAILED'] as const
  const TERMINADOS = ['STAMPED', 'CANCEL_REQUESTED', 'CANCELLED'] as const
  const fixture = `heredada-${randomUUID()}`
  let venueId: string
  let fiscalEmisorId: string

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
    venueId = (await prisma.venue.create({ data: { id: fixture, organizationId: fixture, name: fixture, slug: fixture } })).id
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
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.cfdi.deleteMany({ where: { venueId } })
    await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: fixture } })
  })

  const datos = (extra: Extra) => ({
    venueId,
    fiscalEmisorId,
    type: 'INGRESO' as const,
    flow: 'AUTOFACTURA_A' as const,
    receptorRfc: 'EKU9003173C9',
    receptorNombre: 'ESCUELA KEMPER URGATE',
    receptorRegimen: '601',
    receptorCp: '64000',
    usoCfdi: 'G03',
    formaPago: '01',
    metodoPago: 'PUE',
    subtotalCents: 10000,
    taxCents: 1600,
    totalCents: 11600,
    idempotencyKey: `heredada-${randomUUID()}`,
    updatedAt: new Date(),
    ...extra,
  })
  const crearCfdi = (extra: Extra) => prisma.cfdi.create({ data: datos(extra) })

  it.each(NO_TERMINADOS)('una heredada NO puede crearse en %s', async status => {
    await expect(crearCfdi({ protocoloIva: null, status })).rejects.toThrow(/Cfdi_heredada_solo_terminada/)
    expect(await prisma.cfdi.count({ where: { venueId, protocoloIva: null, status } })).toBe(0)
  })

  it.each(NO_TERMINADOS)('una heredada STAMPED NO puede pasar a %s', async status => {
    const c = await crearCfdi({ protocoloIva: null, status: 'STAMPED' })
    await expect(prisma.cfdi.update({ where: { id: c.id }, data: { status } })).rejects.toThrow(/Cfdi_heredada_solo_terminada/)
    expect((await prisma.cfdi.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('STAMPED')
  })

  it.each(TERMINADOS)('una heredada SÍ puede estar en %s (cancelar una vieja sigue funcionando)', async status => {
    await expect(crearCfdi({ protocoloIva: null, status })).resolves.toBeDefined()
  })

  it('una heredada STAMPED puede ir y volver por la cancelación (STAMPED → CANCEL_REQUESTED → STAMPED → CANCELLED)', async () => {
    const c = await crearCfdi({ protocoloIva: null, status: 'STAMPED' })
    for (const status of ['CANCEL_REQUESTED', 'STAMPED', 'CANCELLED'] as const) {
      await prisma.cfdi.update({ where: { id: c.id }, data: { status } })
    }
    expect((await prisma.cfdi.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('CANCELLED')
  })

  it.each([...NO_TERMINADOS, ...TERMINADOS])('con protocoloIva = 1, %s sigue permitido', async status => {
    await expect(crearCfdi({ protocoloIva: 1, status })).resolves.toBeDefined()
  })

  it('la migración FALLA (y no queda a medias) en una base con una heredada sin terminar', async () => {
    const sql = readFileSync(
      join(__dirname, '../../../prisma/migrations/20261003170000_cfdi_heredada_solo_terminada/migration.sql'),
      'utf8',
    )
    const ROLLBACK = new Error('ROLLBACK_A_PROPOSITO')
    let falla: unknown
    await expect(
      prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe('ALTER TABLE "Cfdi" DROP CONSTRAINT "Cfdi_heredada_solo_terminada"')
        await tx.cfdi.create({ data: datos({ protocoloIva: null, status: 'STAMPING' }) })
        try {
          await tx.$executeRawUnsafe(sql)
        } catch (e) {
          falla = e
        }
        throw ROLLBACK
      }),
    ).rejects.toBe(ROLLBACK)
    expect(String((falla as Error | undefined)?.message ?? falla)).toMatch(/Cfdi_heredada_solo_terminada/)
    // La base quedó como estaba: la restricción sigue y la fila de la transacción no existe.
    const [{ n }] = await prisma.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*) AS n FROM pg_constraint WHERE conname = 'Cfdi_heredada_solo_terminada'`
    expect(Number(n)).toBe(1)
    expect(await prisma.cfdi.count({ where: { venueId, protocoloIva: null, status: 'STAMPING' } })).toBe(0)
  })
})

/**
 * Lo que SÍ sigue funcionando con las heredadas que pueden existir (las TERMINADAS: 25 timbradas + 3 canceladas en producción
 * al 1-oct). Motor real; sólo el PAC es de mentira. Si alguna de estas fallara con la restricción puesta, sería un camino que
 * escribe una heredada sin terminar.
 */
describe('D21: lo que sigue funcionando con una heredada terminada', () => {
  const fixture = `heredada-motor-${randomUUID()}`
  const receptor = {
    rfc: 'EKU9003173C9',
    razonSocial: 'ESCUELA KEMPER URGATE',
    regimenFiscal: '601',
    codigoPostal: '64000',
    usoCfdi: 'G03',
  }
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
  const timbre = () => ({
    providerInvoiceId: randomUUID(),
    uuid: randomUUID(),
    serie: 'F',
    folio: '1',
    totalCents: 11600,
    stampedAt: new Date(),
    status: 'valid',
  })

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
    provider.createInvoice.mockReset().mockImplementation(async () => timbre())
    provider.findByExternalId.mockReset().mockResolvedValue(null)
    provider.getInvoice.mockReset()
    provider.cancelInvoice.mockReset().mockResolvedValue({ status: 'canceled', cancelledAt: new Date() })
    provider.getCancellationStatus.mockReset().mockResolvedValue({ status: 'canceled', cancelledAt: new Date() })
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
  /** Una factura de la ruta heredada como las de producción: sin protocoloIva ni entrada, ya timbrada (o cancelada). */
  function heredada(orderId: string, extra: { status: 'STAMPED' | 'CANCELLED'; cancelStatus?: 'CANCELLED' }) {
    return prisma.cfdi.create({
      data: {
        venueId,
        fiscalEmisorId,
        orderId,
        type: 'INGRESO',
        flow: 'STAFF_B',
        protocoloIva: null,
        idempotencyKey: `cfdi-order-${orderId}`,
        uuid: randomUUID(),
        facturapiId: randomUUID(),
        serie: 'F',
        folio: '7',
        stampedAt: new Date(),
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
        ...extra,
      },
      include: { fiscalEmisor: true },
    })
  }
  const fila = (id: string) => prisma.cfdi.findUniqueOrThrow({ where: { id } })

  it('1 · refacturar una venta cuya heredada se CANCELÓ va por la ruta nueva: llave …-n2, STAMPED, protocoloIva 1; la original intacta', async () => {
    const o = await order()
    const original = await heredada(o.id, { status: 'CANCELLED', cancelStatus: 'CANCELLED' })
    const antes = await fila(original.id)
    const result = await issueCfdiForOrder({ orderId: o.id, receptor, sandbox: true, expectedVenueId: venueId }, deps)
    expect(result.status).toBe('STAMPED')
    const nueva = await prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: `cfdi-order-${o.id}-n2` } })
    expect(result.cfdi.id).toBe(nueva.id)
    expect(nueva).toMatchObject({ status: 'STAMPED', protocoloIva: 1, attempts: 1, orderId: o.id })
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: nueva.id } })).toBe(1)
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(await fila(original.id)).toEqual(antes)
  })

  it.each([
    ['pending', { status: 'STAMPED', cancelStatus: 'REQUESTED' }, true],
    ['canceled', { status: 'CANCELLED', cancelStatus: 'CANCELLED' }, false],
  ] as const)(
    '2 · sustituir una heredada STAMPED: la sustituta nace por la ruta nueva; el PAC contesta %s a la cancelación de la original',
    async (respuesta, original, pendiente) => {
      const o = await order()
      const vieja = await heredada(o.id, { status: 'STAMPED' })
      provider.cancelInvoice.mockResolvedValue({ status: respuesta, cancelledAt: respuesta === 'canceled' ? new Date() : null })
      const result = await replaceCfdi({ cfdiId: vieja.id, sandbox: true, expectedVenueId: venueId }, deps as any)
      expect(result).toMatchObject({ status: 'REPLACED', cancelPendiente: pendiente })
      const sustituta = await prisma.cfdi.findFirstOrThrow({ where: { replacesCfdiId: vieja.id } })
      expect(sustituta).toMatchObject({
        status: 'STAMPED',
        protocoloIva: 1,
        replacesCfdiId: vieja.id,
        idempotencyKey: `cfdi-order-${o.id}-r1`,
      })
      expect(provider.cancelInvoice).toHaveBeenCalledWith(
        expect.objectContaining({ providerInvoiceId: vieja.facturapiId, motivo: '01', substituteUuid: sustituta.uuid }),
      )
      expect(await fila(vieja.id)).toMatchObject({ ...original, protocoloIva: null })
    },
  )

  type Camino = 'directa' | 'en trámite' | 'externa' | 'otra vez tras rechazo'
  const CANCELADA = { status: 'CANCELLED', cancelStatus: 'CANCELLED' } as const
  const ACEPTADA = { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } as const
  const VIGENTE_RECHAZADA = { status: 'STAMPED', cancelStatus: 'REJECTED' } as const
  it.each([
    ['pendiente (queda en trámite)', 'directa', 'pending', { status: 'STAMPED', cancelStatus: 'REQUESTED' }],
    ['rechazo del receptor', 'directa', 'rejected', VIGENTE_RECHAZADA],
    ['expiración sin respuesta', 'directa', 'expired', VIGENTE_RECHAZADA],
    ['aceptación', 'directa', 'accepted', ACEPTADA],
    ['cancelación confirmada', 'directa', 'canceled', CANCELADA],
    ['en trámite que después se confirma', 'en trámite', 'canceled', CANCELADA],
    ['en trámite que después se acepta', 'en trámite', 'accepted', ACEPTADA],
    ['en trámite que después se rechaza', 'en trámite', 'rejected', VIGENTE_RECHAZADA],
    ['en trámite que después expira', 'en trámite', 'expired', VIGENTE_RECHAZADA],
    ['confirmación externa (cancelada fuera de Avoqado)', 'externa', 'canceled', CANCELADA],
    ['confirmación externa aceptada', 'externa', 'accepted', ACEPTADA],
    ['rechazada y vuelta a pedir: se confirma', 'otra vez tras rechazo', 'canceled', CANCELADA],
  ] as const)('3 · cancelar una heredada STAMPED por los servicios reales — %s', async (_caso, camino: Camino, respuesta, esperado) => {
    const o = await order()
    const c = await heredada(o.id, { status: 'STAMPED' })
    const pac = { status: respuesta, cancelledAt: respuesta === 'canceled' || respuesta === 'accepted' ? new Date() : null }
    const cancelar = () => cancelCfdi({ cfdiId: c.id, motivo: '02', sandbox: true, expectedVenueId: venueId })
    if (camino === 'directa') {
      provider.cancelInvoice.mockResolvedValue(pac)
      await cancelar()
    } else if (camino === 'en trámite') {
      provider.cancelInvoice.mockResolvedValue({ status: 'pending', cancelledAt: null })
      await cancelar()
      const enTramite = await prisma.cfdi.findUniqueOrThrow({ where: { id: c.id }, include: { fiscalEmisor: true } })
      expect(enTramite).toMatchObject({ status: 'STAMPED', cancelStatus: 'REQUESTED', protocoloIva: null })
      provider.getCancellationStatus.mockResolvedValue(pac)
      await refreshPendingCancellation(enTramite, { sandbox: true })
    } else if (camino === 'externa') {
      provider.getCancellationStatus.mockResolvedValue(pac)
      await sincronizarCancelacionExterna(c, { sandbox: true })
    } else {
      provider.cancelInvoice.mockResolvedValueOnce({ status: 'rejected', cancelledAt: null })
      await cancelar()
      expect(await fila(c.id)).toMatchObject({ ...VIGENTE_RECHAZADA, protocoloIva: null })
      provider.cancelInvoice.mockResolvedValueOnce(pac)
      await cancelar()
    }
    expect(await fila(c.id)).toMatchObject({ ...esperado, protocoloIva: null })
  })
})
