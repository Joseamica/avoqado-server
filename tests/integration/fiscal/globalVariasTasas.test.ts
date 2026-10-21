/**
 * IVA por producto, bloque C1 (Tarea 5, Codex C1-5 y C1-8), contra una base de pruebas propia:
 * - la ventana fiscal estable: un ticket es del periodo de su ÚLTIMO cobro elegible (`Payment.createdAt`), no de `Order.updatedAt`;
 * - la pertenencia única: el `where` de cada clase (`dondePertenece`) dice exactamente lo mismo que la función pura (`pertenenciaAlEmisor`);
 * - lo extraído (C3) no vuelve solo a la global (Codex C1-45, C3-15).
 */
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))
jest.mock('@/services/storage.service', () => ({
  buildStoragePath: (s: string) => s,
  uploadFileToStorage: jest.fn(async () => 'https://test/file'),
}))
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import {
  anularFilaVieja,
  contarExcluidasPorConfiguracion,
  dondePertenece,
  emitirGlobalesPendientes,
  globalesSinTimbrar,
  issueGlobalForEmisor,
  issueGlobalForPeriod,
  leerGlobal,
  llaveDeLaGlobal,
  ordenesDeLaGlobal,
  ventanaFiscal,
  MOTIVO_FILA_VIEJA_ANULADA,
  MOTIVO_COMPLEMENTARIA_DEL_JOB,
  emitirGlobalComplementaria,
  loadGlobalCandidates,
  vistaPreviaComplementaria,
  vistaPreviaPrincipal,
  MOTIVO_PERIODO_FUERA_DE_VENTANA,
  MOTIVO_PERIODO_SIN_DEMOSTRAR,
  periodosDeLaGlobal,
  MOTIVO_SIN_TICKETS,
  MOTIVO_ERROR_DEL_PERIODO,
  MOTIVO_PERIODO_CUBIERTO,
  MOTIVO_PERIODO_CUBIERTO_POR_LA_ACTUAL,
  MOTIVO_SIN_PRINCIPAL,
  listarExcluidasDeLaGlobal,
  filtrosDeExclusion,
  MAX_REVISAR_TOTALES,
  MOTIVO_LISTADO_HEREDADA,
  DETALLE_OTRA_SUCURSAL,
  type GlobalEmisor,
} from '@/services/fiscal/cfdiGlobal.service'
import * as admisionIva from '@/services/fiscal/admisionIva'
import logger from '@/config/logger'
import {
  conceptosDeOrdenGlobal,
  cuadrarLaGlobal,
  pertenenciaAlEmisor,
  sumarExcluida,
  MOTIVOS_DE_CONFIGURACION,
  SIN_FILAS_D16,
  TEXTO_EXCLUSION_GLOBAL,
  type ExcluidasPorMotivo,
  type Pertenencia,
} from '@/services/fiscal/globalPorTratamiento'
import { huellaDeEntrada } from '@/services/fiscal/entradaDocumental'
import { sellarRenglones } from '@/services/fiscal/sellosIva'
import { ProviderHttpError } from '@/services/fiscal/providers/facturapi.provider'
import {
  closedPeriodFor,
  periodoDeGlobalPeriod,
  periodosCerradosRecientes,
  MOTIVO_BIMESTRAL_FILA_APARTADA,
  MOTIVO_BIMESTRAL_SOLO_621,
  MOTIVO_ANIO_FUERA,
  anioPermitido,
} from '@/services/fiscal/globalPeriod'
import { ConflictError } from '@/errors/AppError'
import { cancelCfdi } from '@/services/fiscal/cfdi.service'
import { PREFIJO_EXTRACCION } from '@/services/fiscal/exclusionGlobal'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
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
const MAYO = new Date('2026-05-15T12:00:00Z')
const JUNIO = new Date('2026-06-02T12:00:00Z')
// Mayo en hora de México: [2026-05-01T06:00Z, 2026-06-01T06:00Z).
const periodoMayo = closedPeriodFor('MENSUAL', NOW)
const CLASES: readonly Pertenencia[] = ['CANDIDATA', 'AJENA', 'EFECTIVO', 'COMERCIO_FUERA', 'SIN_EMISOR', 'SIN_TERMINAL']
const valid = () => ({
  providerInvoiceId: randomUUID(),
  uuid: randomUUID(),
  serie: 'F',
  folio: '1',
  totalCents: 11600,
  stampedAt: new Date(),
  status: 'valid' as const,
})
type Cobro = [string, string | null, Date]
type Config = { fiscalEmisorId: string; facturacionEnabled: boolean; includeInGlobal: boolean }

describe('C1 · ventana fiscal estable y pertenencia única', () => {
  const fixture = `global-varias-${randomUUID()}`
  const m1 = fixture
  let venueId: string
  let p16: string
  let p0: string
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
  const global = () => issueGlobalForEmisor({ emisorId: fiscalEmisorId, now: NOW, sandbox: true })
  /** Ajuste del founder (7-oct): `fueraDeTerminal` = «Incluir en la global las ventas cobradas fuera de la terminal» (apagado de fábrica). */
  const emisorDe = (invoiceCashSales = true, fueraDeTerminal = false) => ({
    id: fiscalEmisorId,
    invoiceCashSales,
    includeOffTerminalSalesInGlobal: fueraDeTerminal,
  })
  type EmisorDePrueba = ReturnType<typeof emisorDe>
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
    venueId = (await prisma.venue.create({ data: { id: fixture, organizationId: fixture, name: fixture, slug: fixture } })).id
    await encenderIvaPorProducto(venueId)
    const category = await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })
    p16 = (
      await prisma.product.create({ data: { venueId, categoryId: category.id, name: `${fixture}-16`, sku: `${fixture}-16`, price: 116 } })
    ).id
    p0 = (
      await prisma.product.create({
        data: { venueId, categoryId: category.id, name: `${fixture}-0`, sku: `${fixture}-0`, price: 100, ivaTratamiento: 'IVA_0' },
      })
    ).id
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
      data: { id: m1, providerId: fixture, externalMerchantId: m1, credentialsEncrypted: {} },
    })
    await prisma.merchantFiscalConfig.create({
      data: { merchantAccountId: m1, fiscalEmisorId, facturacionEnabled: true, autofacturaEnabled: true, includeInGlobal: true },
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
  })
  afterEach(() => jest.restoreAllMocks())
  afterAll(async () => {
    if (!venueId) return
    await cleanOrders()
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisorId } })
    await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
    await prisma.merchantAccount.deleteMany({ where: { id: m1 } })
    await prisma.paymentProvider.deleteMany({ where: { id: fixture } })
    await prisma.venue.delete({ where: { id: venueId } })
    await prisma.organization.delete({ where: { id: fixture } })
  })

  /** Un comercio de la prueba, con su configuración fiscal o sin ella. */
  async function comercio(sufijo: string, config: Config | null) {
    const id = `${fixture}-${sufijo}`
    await prisma.merchantAccount.create({ data: { id, providerId: fixture, externalMerchantId: id, credentialsEncrypted: {} } })
    if (config) await prisma.merchantFiscalConfig.create({ data: { merchantAccountId: id, autofacturaEnabled: false, ...config } })
    return id
  }
  /** Un segundo RFC en el mismo negocio. */
  async function segundoEmisor() {
    return (
      await prisma.fiscalEmisor.create({
        data: {
          venueId,
          rfc: 'BBB010101BBB',
          legalName: `${fixture}-e2`,
          regimenFiscal: '601',
          lugarExpedicion: '01000',
          csdStatus: 'ACTIVE',
          globalPeriodicity: 'MENSUAL',
          invoiceCashSales: false,
        },
      })
    ).id
  }
  /** Borra lo que creó una prueba: primero las ventas (sus cobros apuntan a los comercios), luego configuraciones, comercios y emisores. */
  async function borrar(comercios: string[], emisores: string[]) {
    await cleanOrders()
    await prisma.merchantFiscalConfig.deleteMany({ where: { merchantAccountId: { in: comercios } } })
    await prisma.merchantAccount.deleteMany({ where: { id: { in: comercios } } })
    await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisorId: { in: emisores } } })
    await prisma.fiscalEmisor.deleteMany({ where: { id: { in: emisores } } })
  }

  /** Una venta pagada; cada cobro: [método, comercio | null, fecha]. */
  async function venta(cobros: Cobro[], renglones: Array<{ productId: string; precio: number }> = [{ productId: p16, precio: 116 }]) {
    const total = renglones.reduce((s, r) => s + r.precio, 0)
    const porCobro = Math.round((total / cobros.length) * 100) / 100
    return prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        subtotal: total,
        taxAmount: 0,
        total,
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        items: {
          create: renglones.map(r => ({
            productId: r.productId,
            productName: 'Producto',
            quantity: 1,
            unitPrice: r.precio,
            taxAmount: 0,
            total: r.precio,
          })),
        },
        payments: {
          create: cobros.map(([method, merchantAccountId, createdAt], i) => ({
            venueId,
            merchantAccountId,
            amount: i === cobros.length - 1 ? total - porCobro * (cobros.length - 1) : porCobro,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: porCobro,
            method: method as any,
            status: 'COMPLETED' as const,
            createdAt,
          })),
        },
      },
      include: { items: true, payments: true },
    })
  }

  /** Las clases cuyo `where` encuentra la venta (debe ser exactamente una). */
  async function clasesEnSql(orderId: string, emisor: EmisorDePrueba, unSolo: boolean) {
    const encontradas: Pertenencia[] = []
    for (const clase of CLASES) {
      const n = await prisma.order.count({
        where: { AND: [{ id: orderId }, ventanaFiscal(venueId, periodoMayo), dondePertenece(emisor, unSolo, clase)] },
      })
      if (n) encontradas.push(clase)
    }
    return encontradas
  }
  /** La función pura con los cobros REALES de la venta, leídos de la base. */
  async function claseEnLaFuncion(orderId: string, emisor: EmisorDePrueba, unSolo: boolean) {
    const cfg = { select: { fiscalEmisorId: true, facturacionEnabled: true, includeInGlobal: true } }
    const pagos = await prisma.payment.findMany({
      where: { orderId, status: 'COMPLETED' },
      select: {
        method: true,
        merchantAccountId: true,
        ecommerceMerchantId: true,
        merchantAccount: { select: { fiscalConfig: cfg } },
        ecommerceMerchant: { select: { fiscalConfig: cfg } },
      },
      take: 20,
    })
    return pertenenciaAlEmisor(
      pagos.map(p => ({
        method: p.method,
        conComercio: p.merchantAccountId !== null || p.ecommerceMerchantId !== null,
        config: p.merchantAccount?.fiscalConfig ?? p.ecommerceMerchant?.fiscalConfig ?? null,
      })),
      emisor,
      unSolo,
    )
  }

  it('🔴 la ventana es el ÚLTIMO cobro: tocar la orden después no la cambia de periodo; un cobro en junio la lleva a junio', async () => {
    // `a` lleva un renglón al 0 %: la ventana no mira el contenido del ticket, sólo sus cobros.
    const a = await venta(
      [['CREDIT_CARD', m1, MAYO]],
      [
        { productId: p16, precio: 116 },
        { productId: p0, precio: 100 },
      ],
    )
    const b = await venta([
      ['CREDIT_CARD', m1, MAYO],
      ['CREDIT_CARD', m1, JUNIO],
    ])
    await prisma.order.update({ where: { id: a.id }, data: { contratoDePrecio: 'IVA_INCLUIDO', updatedAt: JUNIO } }) // como confirmarContratoDePrecio
    const ids = (await prisma.order.findMany({ where: ventanaFiscal(venueId, periodoMayo), select: { id: true }, take: 10 })).map(o => o.id)
    expect(ids).toContain(a.id)
    expect(ids).not.toContain(b.id)
  })

  it('🔴 los bordes del periodo en hora de México: el inicio entra, el fin (ya junio en México) no', async () => {
    const enElInicio = await venta([['CREDIT_CARD', m1, periodoMayo.periodStart]])
    const ultimoInstante = await venta([['CREDIT_CARD', m1, new Date(periodoMayo.periodEnd.getTime() - 1)]])
    const enElFin = await venta([['CREDIT_CARD', m1, periodoMayo.periodEnd]])
    const antes = await venta([['CREDIT_CARD', m1, new Date(periodoMayo.periodStart.getTime() - 1)]])
    const ids = (await prisma.order.findMany({ where: ventanaFiscal(venueId, periodoMayo), select: { id: true }, take: 10 })).map(o => o.id)
    expect([enElInicio, ultimoInstante, enElFin, antes].map(o => ids.includes(o.id))).toEqual([true, true, false, false])
  })

  it('🔴 la ventana se acota por sucursal: un cobro registrado en OTRA sucursal no hace elegible la orden de ésta', async () => {
    // Revisión T5, Importante 1: el `venueId` en el filtro del cobro deja entrar por `Payment(venueId, status, createdAt)` y leer sólo
    // los cobros del periodo de ESTA sucursal. En producción ningún cobro tiene otra sucursal que su orden (medido el 6-oct, B4b).
    const otraSucursal = `${fixture}-otra`
    await prisma.venue.create({ data: { id: otraSucursal, organizationId: fixture, name: otraSucursal, slug: otraSucursal } })
    try {
      const cobroDeOtraSucursal = await venta([['CREDIT_CARD', m1, MAYO]])
      await prisma.payment.updateMany({ where: { orderId: cobroDeOtraSucursal.id }, data: { venueId: otraSucursal } })
      const control = await venta([['CREDIT_CARD', m1, MAYO]])
      const ids = (await prisma.order.findMany({ where: ventanaFiscal(venueId, periodoMayo), select: { id: true }, take: 10 })).map(
        o => o.id,
      )
      expect([cobroDeOtraSucursal, control].map(o => ids.includes(o.id))).toEqual([false, true])
    } finally {
      await cleanOrders() // borrar las órdenes arrastra sus cobros (también el de la otra sucursal)
      await prisma.venue.delete({ where: { id: otraSucursal } })
    }
  })

  it('control — 🔴 editar la fecha de la ORDEN después del periodo no la saca de su periodo (C1-5): la fecha fiscal es la del cobro', async () => {
    // `Order.createdAt` se edita desde el dashboard (`order.dashboard.service.ts` `updateOrder`, sin guarda) y en la sincronización de
    // SoftRestaurant viene del reloj de ese sistema. Por eso la ventana NO filtra por `Order.createdAt < fin`: una venta con su cobro en
    // mayo y la orden movida a junio quedaría fuera de mayo (por la orden) y de junio (sin cobro en junio), es decir, de TODA global.
    const editada = await venta([['CREDIT_CARD', m1, MAYO]])
    await prisma.order.update({ where: { id: editada.id }, data: { createdAt: JUNIO } })
    const ids = (await prisma.order.findMany({ where: ventanaFiscal(venueId, periodoMayo), select: { id: true }, take: 10 })).map(o => o.id)
    expect(ids).toContain(editada.id)
  })

  // ── Ola final (M3 de la revisión de la T5): las filas que faltaban para lo que la ventana y la pertenencia ignoran a propósito. Hoy pasan por
  // construcción (`COBRO` es común); si alguien quita `COBRO` del «ninguno después», o deja de mirar el comercio de e-commerce, caen aquí. ──
  const periodoJunio = closedPeriodFor('MENSUAL', new Date('2026-07-03T17:00:00Z'))
  const enVentana = async (periodo: typeof periodoMayo) =>
    (await prisma.order.findMany({ where: ventanaFiscal(venueId, periodo), select: { id: true }, take: 20 })).map(o => o.id)

  it('control — T5 M3: una venta de mayo con un cobro REFUND, FAILED o TEST en junio SIGUE en mayo (sólo los cobros elegibles mueven la ventana)', async () => {
    const extras = [
      { type: 'REFUND' as const, status: 'COMPLETED' as const, amount: -116 },
      { type: 'REGULAR' as const, status: 'FAILED' as const, amount: 116 },
      { type: 'TEST' as const, status: 'COMPLETED' as const, amount: 116 },
    ]
    const ventas: string[] = []
    for (const x of extras) {
      const v = await venta([['CREDIT_CARD', m1, MAYO]])
      await prisma.payment.create({
        data: {
          venueId,
          orderId: v.id,
          merchantAccountId: m1,
          amount: x.amount,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: x.amount,
          method: 'CREDIT_CARD',
          type: x.type,
          status: x.status,
          createdAt: JUNIO,
        },
      })
      ventas.push(v.id)
    }
    const mayo = await enVentana(periodoMayo)
    const junio = await enVentana(periodoJunio)
    expect(ventas.map(id => [mayo.includes(id), junio.includes(id)])).toEqual([
      [true, false],
      [true, false],
      [true, false],
    ])
    for (const id of ventas) expect(await clasesEnSql(id, emisorDe(), true)).toEqual(['CANDIDATA'])
  })

  it('control — T5 M3: una venta cobrada SÓLO con un cobro TEST no está en ningún periodo', async () => {
    const v = await venta([['CREDIT_CARD', m1, MAYO]])
    await prisma.payment.updateMany({ where: { orderId: v.id }, data: { type: 'TEST' } })
    expect((await enVentana(periodoMayo)).includes(v.id)).toBe(false)
    expect((await enVentana(periodoJunio)).includes(v.id)).toBe(false)
  })

  it('control — T5 M3: `includeInGlobal: false` en un comercio de ESTE RFC ⇒ COMERCIO_FUERA (antes sólo se probó `facturacionEnabled: false`), SQL = función pura', async () => {
    const sinGlobal = await comercio('sin-global', { fiscalEmisorId, facturacionEnabled: true, includeInGlobal: false })
    try {
      const v = await venta([['CREDIT_CARD', sinGlobal, MAYO]])
      expect(await clasesEnSql(v.id, emisorDe(), true)).toEqual(['COMERCIO_FUERA'])
      expect(await claseEnLaFuncion(v.id, emisorDe(), true)).toBe('COMERCIO_FUERA')
    } finally {
      await borrar([sinGlobal], [])
    }
  })

  it('control — T5 M3: un comercio de E-COMMERCE (`ecommerceMerchantId`) es un comercio: en la global ⇒ CANDIDATA; con `includeInGlobal: false` ⇒ COMERCIO_FUERA (SQL = función pura)', async () => {
    const tienda = await prisma.ecommerceMerchant.create({
      data: {
        venueId,
        businessName: `${fixture}-web`,
        contactEmail: `${fixture}-web@example.test`,
        publicKey: `pk_test_${fixture}`,
        secretKeyHash: `hash-${fixture}`,
        providerId: fixture,
        providerCredentials: {},
      },
    })
    try {
      await prisma.merchantFiscalConfig.create({
        data: {
          ecommerceMerchantId: tienda.id,
          fiscalEmisorId,
          facturacionEnabled: true,
          autofacturaEnabled: false,
          includeInGlobal: true,
        },
      })
      const v = await venta([['CREDIT_CARD', null, MAYO]])
      await prisma.payment.updateMany({ where: { orderId: v.id }, data: { ecommerceMerchantId: tienda.id } })
      expect(await clasesEnSql(v.id, emisorDe(), true)).toEqual(['CANDIDATA'])
      expect(await claseEnLaFuncion(v.id, emisorDe(), true)).toBe('CANDIDATA')
      await prisma.merchantFiscalConfig.update({ where: { ecommerceMerchantId: tienda.id }, data: { includeInGlobal: false } })
      expect(await clasesEnSql(v.id, emisorDe(), true)).toEqual(['COMERCIO_FUERA'])
      expect(await claseEnLaFuncion(v.id, emisorDe(), true)).toBe('COMERCIO_FUERA')
    } finally {
      await cleanOrders()
      await prisma.merchantFiscalConfig.deleteMany({ where: { ecommerceMerchantId: tienda.id } })
      await prisma.ecommerceMerchant.delete({ where: { id: tienda.id } })
    }
  })

  it('🔴 la pertenencia en SQL dice exactamente lo mismo que la función pura (matriz de la unitaria, con datos reales)', async () => {
    const m2 = await comercio('m2', null) // un comercio SIN configuración
    try {
      // Cada fila de la matriz se crea como venta; para cada una: el `where` de su clase la encuentra y el de las demás no.
      const clases: Array<[Pertenencia, Cobro[]]> = [
        ['CANDIDATA', [['CREDIT_CARD', m1, MAYO]]],
        [
          'COMERCIO_FUERA',
          [
            ['CREDIT_CARD', m1, MAYO],
            ['CREDIT_CARD', m2, MAYO],
          ],
        ],
        ['SIN_EMISOR', [['CREDIT_CARD', m2, MAYO]]],
        // Ajuste del founder (7-oct): sin el interruptor de las ventas fuera de la terminal (el de fábrica), el efectivo puro y la
        // transferencia sin comercio quedan fuera aunque «Facturar efectivo» esté encendido.
        ['SIN_TERMINAL', [['CASH', null, MAYO]]],
        ['SIN_TERMINAL', [['BANK_TRANSFER', null, MAYO]]],
      ]
      const creadas = await Promise.all(clases.map(([, cobros]) => venta(cobros)))
      for (const [i, [clase]] of clases.entries())
        for (const otra of CLASES) {
          const n = await prisma.order.count({
            where: { AND: [{ id: creadas[i].id }, ventanaFiscal(venueId, periodoMayo), dondePertenece(emisorDe(), true, otra)] },
          })
          expect([clase, otra, n]).toEqual([clase, otra, clase === otra ? 1 : 0])
        }
    } finally {
      await borrar([m2], [])
    }
  })

  describe('con varios emisores en el negocio (e2 y su comercio m3) y el interruptor apagado', () => {
    it('🔴 la matriz completa (las 13 filas de la unitaria): una sola clase en SQL, la misma que la función pura', async () => {
      const e2 = await segundoEmisor()
      const ok = { fiscalEmisorId, facturacionEnabled: true, includeInGlobal: true }
      const comercios: string[] = []
      try {
        const m2 = await comercio('m2', null)
        const m3 = await comercio('m3', { ...ok, fiscalEmisorId: e2 })
        const apagada = await comercio('apagada', { ...ok, facturacionEnabled: false })
        comercios.push(m2, m3, apagada)
        // [nombre, esperado, cobros, «facturar efectivo», un solo emisor, «ventas fuera de la terminal» (founder, 7-oct)] — las filas de
        // la unitaria; el último valor, si falta, es el de fábrica (apagado).
        const filas: Array<[string, Pertenencia, Cobro[], boolean, boolean, boolean?]> = [
          ['tarjeta nuestra', 'CANDIDATA', [['CREDIT_CARD', m1, MAYO]], false, true],
          [
            'tarjeta nuestra + efectivo, sin el interruptor',
            'EFECTIVO',
            [
              ['CREDIT_CARD', m1, MAYO],
              ['CASH', null, MAYO],
            ],
            false,
            true,
          ],
          [
            'tarjeta nuestra + efectivo, con el interruptor',
            'CANDIDATA',
            [
              ['CREDIT_CARD', m1, MAYO],
              ['CASH', null, MAYO],
            ],
            true,
            true,
          ],
          ['nuestra con facturación apagada', 'COMERCIO_FUERA', [['CREDIT_CARD', apagada, MAYO]], false, true],
          [
            'nuestra + una de otro RFC',
            'COMERCIO_FUERA',
            [
              ['CREDIT_CARD', m1, MAYO],
              ['CREDIT_CARD', m3, MAYO],
            ],
            false,
            false,
          ],
          [
            'nuestra + un comercio sin configuración',
            'COMERCIO_FUERA',
            [
              ['CREDIT_CARD', m1, MAYO],
              ['CREDIT_CARD', m2, MAYO],
            ],
            false,
            true,
          ],
          ['sólo de otro RFC', 'AJENA', [['CREDIT_CARD', m3, MAYO]], false, false],
          ['sólo comercios sin configuración', 'SIN_EMISOR', [['CREDIT_CARD', m2, MAYO]], false, false],
          ['efectivo puro, un RFC, con los dos interruptores', 'CANDIDATA', [['CASH', null, MAYO]], true, true, true],
          [
            'efectivo puro, un RFC, fuera de terminal sí pero sin «facturar efectivo»',
            'EFECTIVO',
            [['CASH', null, MAYO]],
            false,
            true,
            true,
          ],
          ['efectivo puro con varios RFC', 'SIN_EMISOR', [['CASH', null, MAYO]], true, false],
          ['efectivo puro con varios RFC y el interruptor', 'SIN_EMISOR', [['CASH', null, MAYO]], true, false, true],
          ['transferencia sin comercio, un RFC, con el interruptor', 'CANDIDATA', [['BANK_TRANSFER', null, MAYO]], false, true, true],
          ['founder: efectivo puro, un RFC, «facturar efectivo» sin el interruptor', 'SIN_TERMINAL', [['CASH', null, MAYO]], true, true],
          ['founder: transferencia sin comercio, un RFC, sin el interruptor', 'SIN_TERMINAL', [['BANK_TRANSFER', null, MAYO]], true, true],
          ['founder: efectivo puro, un RFC, sin ninguno', 'SIN_TERMINAL', [['CASH', null, MAYO]], false, true],
          // T10, ronda 1 (m3): con el interruptor ENCENDIDO, las ventas CON comercio (y la transferencia con varios RFC) no cambian.
          [
            'm3: tarjeta nuestra + efectivo sin «facturar efectivo», interruptor encendido',
            'EFECTIVO',
            [
              ['CREDIT_CARD', m1, MAYO],
              ['CASH', null, MAYO],
            ],
            false,
            true,
            true,
          ],
          [
            'm3: nuestra + un comercio sin configuración, interruptor encendido',
            'COMERCIO_FUERA',
            [
              ['CREDIT_CARD', m1, MAYO],
              ['CREDIT_CARD', m2, MAYO],
            ],
            false,
            true,
            true,
          ],
          ['m3: sólo de otro RFC, interruptor encendido', 'AJENA', [['CREDIT_CARD', m3, MAYO]], false, false, true],
          ['m3: transferencia con varios RFC, interruptor encendido', 'SIN_EMISOR', [['BANK_TRANSFER', null, MAYO]], false, false, true],
          [
            'founder: tarjeta nuestra + efectivo, sin el interruptor ⇒ como hoy',
            'CANDIDATA',
            [
              ['CREDIT_CARD', m1, MAYO],
              ['CASH', null, MAYO],
            ],
            true,
            true,
          ],
          [
            'tarjeta nuestra + transferencia sin comercio',
            'CANDIDATA',
            [
              ['CREDIT_CARD', m1, MAYO],
              ['BANK_TRANSFER', null, MAYO],
            ],
            false,
            false,
          ],
        ]
        const creadas = await Promise.all(filas.map(([, , cobros]) => venta(cobros)))
        const vistas: Array<[string, Pertenencia[], Pertenencia]> = []
        for (const [i, [nombre, , , cash, unSolo, fuera = false]] of filas.entries())
          vistas.push([
            nombre,
            await clasesEnSql(creadas[i].id, emisorDe(cash, fuera), unSolo),
            await claseEnLaFuncion(creadas[i].id, emisorDe(cash, fuera), unSolo),
          ])
        expect(vistas).toEqual(filas.map(([nombre, esperado]) => [nombre, [esperado], esperado]))
      } finally {
        await borrar(comercios, [e2])
      }
    })

    it('control — 🔴 de punta a punta: el efectivo puro con un segundo RFC ya no es de nadie (SIN_EMISOR), y la global no lo toma', async () => {
      const e2 = await segundoEmisor()
      try {
        await venta([['CASH', null, MAYO]])
        expect(await global()).toMatchObject({ status: 'NOTHING_TO_INVOICE', candidateCount: 0 })
        expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
      } finally {
        await borrar([], [e2])
      }
    })
  })

  it('🔴 de punta a punta: el efectivo puro con un solo RFC y los dos interruptores entra a la global (antes, nunca)', async () => {
    // Ajuste del founder (7-oct): además de «Facturar efectivo» (el del fixture), el dueño pidió las ventas fuera de la terminal.
    await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { includeOffTerminalSalesInGlobal: true } })
    try {
      const o = await venta([['CASH', null, MAYO]])
      const r = await global()
      expect(r).toMatchObject({ status: 'STAMPED', candidateCount: 1 })
      expect(await prisma.cfdiGlobalOrden.findMany({ where: { cfdiId: r.cfdi.id }, select: { orderId: true }, take: 10 })).toEqual([
        { orderId: o.id },
      ])
    } finally {
      await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { includeOffTerminalSalesInGlobal: false } })
    }
  })

  it('🔴 una venta con una extracción timbrada —viva o cancelada— no vuelve sola a la global (C1-45); una que nunca se timbró no cuenta', async () => {
    const extraccion = (orderId: string, extra: Record<string, unknown>) =>
      prisma.cfdi.create({
        data: {
          venueId,
          fiscalEmisorId,
          orderId,
          flow: 'STAFF_B',
          type: 'EGRESO',
          protocoloIva: 1,
          idempotencyKey: `${PREFIJO_EXTRACCION}${randomUUID()}`,
          receptorRfc: 'EKU9003173C9',
          receptorNombre: 'ESCUELA KEMPER URGATE',
          receptorRegimen: '601',
          receptorCp: '64000',
          usoCfdi: 'G02',
          formaPago: '04',
          metodoPago: 'PUE',
          subtotalCents: 10000,
          taxCents: 1600,
          totalCents: 11600,
          ...extra,
        } as any,
      })
    const viva = await venta([['CREDIT_CARD', m1, MAYO]])
    const cancelada = await venta([['CREDIT_CARD', m1, MAYO]])
    const nuncaTimbrada = await venta([['CREDIT_CARD', m1, MAYO]])
    await extraccion(viva.id, { status: 'STAMPED', uuid: randomUUID() })
    await extraccion(cancelada.id, { status: 'CANCELLED', cancelStatus: 'ACCEPTED', uuid: randomUUID() })
    await extraccion(nuncaTimbrada.id, { status: 'VALIDATION_FAILED' })
    const r = await global()
    expect(r).toMatchObject({ status: 'STAMPED', candidateCount: 1 })
    expect(await prisma.cfdiGlobalOrden.findMany({ where: { cfdiId: r.cfdi.id }, select: { orderId: true }, take: 10 })).toEqual([
      { orderId: nuncaTimbrada.id },
    ])
  })

  // ── C1 · Tarea 7: la global se captura en v2 (cuadra con la 6b y congela el ajuste); el lector, la recuperación y la llave lo reproducen ──
  describe('C1 · Tarea 10 — lo que queda fuera por configuración se cuenta con la misma regla (y el ajuste del founder: SIN_TERMINAL)', () => {
    const emisorGlobal = async () =>
      (await prisma.fiscalEmisor.findUniqueOrThrow({ where: { id: fiscalEmisorId } })) as unknown as GlobalEmisor
    const filaDeMayo = () => prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: `cfdi-global-${fiscalEmisorId}-2026-05-04` } })
    const manifiesto = async (cfdiId: string) =>
      (await prisma.cfdiGlobalOrden.findMany({ where: { cfdiId }, select: { orderId: true }, take: 20 })).map(x => x.orderId).sort()
    // El fixture: un RFC MENSUAL 601, «Facturar efectivo» encendido, el interruptor nuevo apagado (el de fábrica) y m1 en la global.
    afterEach(async () => {
      await prisma.fiscalEmisor.update({
        where: { id: fiscalEmisorId },
        data: { invoiceCashSales: true, includeOffTerminalSalesInGlobal: false, globalPeriodicity: 'MENSUAL', regimenFiscal: '601' },
      })
      await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { includeInGlobal: true } })
    })

    it('🔴 ola final — `globalApagada` contra la base: Testarudo (1 RFC, efectivo ON, 0 comercios en la global, interruptor OFF) ⇒ true; un comercio de este RFC en la global o el interruptor (con UN RFC) ⇒ false; con DOS RFC el interruptor no la enciende', async () => {
      const enLosPeriodos = async () => (await periodosDeLaGlobal({ venueId, emisorId: fiscalEmisorId, now: NOW })).globalApagada
      const enElListado = async () => (await listarExcluidasDeLaGlobal({ venueId, emisorId: fiscalEmisorId, now: NOW })).globalApagada
      expect(await enLosPeriodos()).toBe(false) // control: el fixture tiene m1 en la global
      await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { includeInGlobal: false } })
      expect(await enLosPeriodos()).toBe(true) // el día de publicar en Testarudo
      expect(await enElListado()).toBe(true) // el resumen de «Ver cuáles» dice lo mismo
      const e2 = await segundoEmisor()
      const comercios: string[] = []
      try {
        // Ni uno de ESTE RFC con la facturación apagada, ni uno de OTRO RFC en SU global, encienden la de éste.
        comercios.push(await comercio('fact-off', { fiscalEmisorId, facturacionEnabled: false, includeInGlobal: true }))
        comercios.push(await comercio('otro-rfc', { fiscalEmisorId: e2, facturacionEnabled: true, includeInGlobal: true }))
        expect(await enLosPeriodos()).toBe(true)
        // Agregado del coordinador: con DOS RFC el interruptor no aplica (lo de fuera de la terminal es SIN_EMISOR): encenderlo no la enciende.
        await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { includeOffTerminalSalesInGlobal: true } })
        expect(await enLosPeriodos()).toBe(true)
        expect(await enElListado()).toBe(true)
        comercios.push(await comercio('en-global', { fiscalEmisorId, facturacionEnabled: true, includeInGlobal: true }))
        expect(await enLosPeriodos()).toBe(false)
        await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { includeOffTerminalSalesInGlobal: false } })
      } finally {
        await borrar(comercios, [e2])
      }
      expect(await enLosPeriodos()).toBe(true) // de vuelta a Testarudo
      await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { includeOffTerminalSalesInGlobal: true } })
      expect(await enLosPeriodos()).toBe(false) // el interruptor de las ventas fuera de la terminal la enciende
      expect(await enElListado()).toBe(false)
    })

    it('🔴 los conteos dicen lo mismo que la pertenencia: efectivo apagado, comercio sin configuración, varios RFC', async () => {
      // «Facturar efectivo» apagado; el interruptor de las ventas fuera de la terminal encendido para que el efectivo puro sea EFECTIVO (la
      // fila del plan); con el de fábrica sería SIN_TERMINAL (prueba de abajo).
      await prisma.fiscalEmisor.update({
        where: { id: fiscalEmisorId },
        data: { invoiceCashSales: false, includeOffTerminalSalesInGlobal: true },
      })
      const m2 = await comercio('m2', null)
      try {
        const ventas = [
          await venta([
            ['CREDIT_CARD', m1, MAYO],
            ['CASH', null, MAYO],
          ]), // EFECTIVO
          await venta([['CASH', null, MAYO]]), // EFECTIVO (un RFC, «Facturar efectivo» apagado)
          await venta([
            ['CREDIT_CARD', m1, MAYO],
            ['CREDIT_CARD', m2, MAYO],
          ]), // COMERCIO_FUERA
          await venta([['CREDIT_CARD', m2, MAYO]]), // SIN_EMISOR
          await venta([['CREDIT_CARD', m1, MAYO]]), // candidata
        ]
        provider.createGlobalInvoice.mockImplementation(async () => valid())
        const r = await global()
        expect(r).toMatchObject({ status: 'STAMPED', candidateCount: 1 })
        expect(r.excluidas).toEqual({ EFECTIVO: 2, COMERCIO_FUERA: 1, SIN_EMISOR: 1 })
        // La MISMA regla: la función pura sobre los cobros reales de cada venta da el mismo conteo.
        const segunLaFuncion: ExcluidasPorMotivo = {}
        for (const v of ventas) {
          const c = await claseEnLaFuncion(v.id, emisorDe(false, true), true)
          if ((MOTIVOS_DE_CONFIGURACION as readonly string[]).includes(c)) sumarExcluida(segunLaFuncion, c as any)
        }
        expect(r.excluidas).toEqual(segunLaFuncion)
        // La estadística se congela en la captura (la que lee el listado como «última captura», Tarea 12).
        expect((await filaDeMayo()).entrada).toMatchObject({ excluidas: { EFECTIVO: 2, COMERCIO_FUERA: 1, SIN_EMISOR: 1 } })
      } finally {
        await borrar([m2], [])
      }
    })

    it('🔴 una venta ya incluida en otra global viva no se cuenta como excluida aunque hoy cambie la configuración', async () => {
      await venta([['CREDIT_CARD', m1, MAYO]])
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      expect((await global()).status).toBe('STAMPED')
      await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { includeInGlobal: false } })
      expect(await contarExcluidasPorConfiguracion(await emisorGlobal(), periodoMayo, true)).toEqual({})
      // La misma regla SÍ cuenta una venta igual que no está en ninguna global (no es un conteo vacío por construcción).
      await venta([['CREDIT_CARD', m1, MAYO]])
      expect(await contarExcluidasPorConfiguracion(await emisorGlobal(), periodoMayo, true)).toEqual({ COMERCIO_FUERA: 1 })
    })

    it('🔴 la reserva que se retoma cuenta sus PROPIOS tickets que hoy quedan fuera por configuración (`self`)', async () => {
      const a = await venta([['CREDIT_CARD', m1, MAYO]])
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
      const reserva = await filaDeMayo()
      expect(reserva).toMatchObject({ status: 'STAMPING', enviadoAt: null })
      expect(await manifiesto(reserva.id)).toEqual([a.id])
      await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { includeInGlobal: false } })
      const r = await global()
      expect(r).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_SIN_TICKETS] })
      expect(r.excluidas).toEqual({ COMERCIO_FUERA: 1 })
      expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
    })

    it('🔴 founder · Testarudo: un RFC, «Facturar efectivo» encendido, comercios sin global, ventas de puro efectivo y de transferencia ⇒ 0 candidatas y SIN_TERMINAL contadas', async () => {
      await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { includeInGlobal: false } })
      await venta([['CASH', null, MAYO]])
      await venta([['CASH', null, MAYO]])
      await venta([['BANK_TRANSFER', null, MAYO]])
      await venta([['CREDIT_CARD', m1, MAYO]]) // con su comercio fuera de la global: COMERCIO_FUERA, como hoy
      const r = await global()
      expect(r).toMatchObject({ status: 'NOTHING_TO_INVOICE', candidateCount: 0 })
      expect(r.excluidas).toEqual({ SIN_TERMINAL: 3, COMERCIO_FUERA: 1 })
      expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
      expect(await prisma.cfdi.count({ where: { venueId, isGlobal: true } })).toBe(0)
    })

    it('🔴 founder: con el interruptor encendido, esas mismas ventas entran a la global', async () => {
      await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { includeOffTerminalSalesInGlobal: true } })
      await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { includeInGlobal: false } })
      const dentro = [
        await venta([['CASH', null, MAYO]]),
        await venta([['CASH', null, MAYO]]),
        await venta([['BANK_TRANSFER', null, MAYO]]),
      ]
      await venta([['CREDIT_CARD', m1, MAYO]])
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      const r = await global()
      expect(r).toMatchObject({ status: 'STAMPED', candidateCount: 3 })
      expect(r.excluidas).toEqual({ COMERCIO_FUERA: 1 })
      expect(await manifiesto(r.cfdi.id)).toEqual(dentro.map(v => v.id).sort())
    })

    const avisosDetenidos = () =>
      prisma.activityLog.findMany({
        where: { venueId, action: 'CFDI_GLOBAL_PERIODO_DETENIDO' },
        select: { data: true },
        orderBy: { createdAt: 'asc' },
        take: 20,
      })
    const pasada = () => emitirGlobalesPendientes({ emisorId: fiscalEmisorId, now: NOW, sandbox: true, cursor: null })

    it('🔴 T9 (preocupación 2): un VALIDATION_FAILED SIN fila en la pasada del job (emisor que quedó BIMESTRAL con 601) deja el aviso DETENIDO una vez y el panel lo muestra', async () => {
      await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { globalPeriodicity: 'BIMESTRAL', regimenFiscal: '601' } })
      const p1 = await pasada()
      expect(p1.resultados.filter(r => r.status === 'VALIDATION_FAILED' && !r.cfdi).map(r => r.reasons)).toEqual([
        [MOTIVO_BIMESTRAL_SOLO_621],
        [MOTIVO_BIMESTRAL_SOLO_621],
      ])
      await pasada() // la segunda pasada no repite el aviso (mismo motivo)
      const avisos = await avisosDetenidos()
      expect(avisos.map(a => (a.data as any).motivo)).toEqual([MOTIVO_BIMESTRAL_SOLO_621, MOTIVO_BIMESTRAL_SOLO_621])
      expect(avisos.map(a => (a.data as any).status)).toEqual(['VALIDATION_FAILED', 'VALIDATION_FAILED'])
      const { periodos } = await periodosDeLaGlobal({ venueId, emisorId: fiscalEmisorId, now: NOW })
      expect(periodos.map(p => [p.meses, p.estado, p.motivo])).toEqual([
        ['14', 'SIN_GLOBAL', MOTIVO_BIMESTRAL_SOLO_621],
        ['13', 'SIN_GLOBAL', MOTIVO_BIMESTRAL_SOLO_621],
      ])
      expect(await prisma.cfdi.count({ where: { venueId, isGlobal: true } })).toBe(0)
    })

    it('🔴 m1 de la T9 + ronda 1: la fila bimestral PENDIENTE con el emisor ya MENSUAL y 601 deja su motivo en la fila y el aviso DETENIDO (una vez); el panel la muestra APARTE y el mes que cubre dice por qué no se emite', async () => {
      // Un bimestre (mar-abr) reservado y nunca enviado con el emisor todavía BIMESTRAL 621.
      await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { globalPeriodicity: 'BIMESTRAL', regimenFiscal: '621' } })
      const v = await venta([['CREDIT_CARD', m1, new Date('2026-04-10T12:00:00Z')]])
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
      const fila = await prisma.cfdi.findFirstOrThrow({ where: { venueId, isGlobal: true } })
      expect(fila).toMatchObject({ status: 'STAMPING', enviadoAt: null, globalPeriod: { periodicidad: '05', meses: '14', anio: 2026 } })
      expect(await manifiesto(fila.id)).toEqual([v.id])
      // El dueño cambia a MENSUAL y 601 (lo que permite el formulario): la fila apartada conserva su periodicidad.
      await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { globalPeriodicity: 'MENSUAL', regimenFiscal: '601' } })
      const p1 = await pasada()
      expect(p1.resultados.find(r => r.cfdi?.id === fila.id)).toMatchObject({
        status: 'VALIDATION_FAILED',
        reasons: [MOTIVO_BIMESTRAL_FILA_APARTADA],
      })
      await pasada()
      // Su motivo queda en la fila (ronda 1, I2 b), sin tocar su estado ni su manifiesto.
      expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: fila.id } })).toMatchObject({
        status: 'STAMPING',
        enviadoAt: null,
        lastError: MOTIVO_BIMESTRAL_FILA_APARTADA,
      })
      expect(await manifiesto(fila.id)).toEqual([v.id])
      // Un aviso por periodo detenido, sin repetirse: el bimestre (su fila) y abril (ronda 1, I1: sus fechas siguen apartadas en el bimestre).
      const avisos = await avisosDetenidos()
      expect(avisos.map(a => [(a.data as any).periodicidad, (a.data as any).meses, (a.data as any).motivo])).toEqual([
        ['05', '14', MOTIVO_BIMESTRAL_FILA_APARTADA],
        ['04', '04', MOTIVO_PERIODO_CUBIERTO],
      ])
      const r = await periodosDeLaGlobal({ venueId, emisorId: fiscalEmisorId, now: NOW })
      expect(r.periodos.map(p => [p.meses, p.estado, p.cfdiId, p.motivo])).toEqual([
        ['05', 'SIN_GLOBAL', null, null],
        ['04', 'SIN_GLOBAL', null, MOTIVO_PERIODO_CUBIERTO],
      ])
      expect(r.otrasPeriodicidades).toEqual({
        completo: true,
        globales: [
          {
            cfdiId: fila.id,
            periodicidad: 'BIMESTRAL',
            desde: '2026-03-01T06:00:00.000Z',
            hasta: '2026-05-01T06:00:00.000Z',
            meses: '14',
            anio: 2026,
            estado: 'APARTADA',
            folio: null,
            motivo: MOTIVO_BIMESTRAL_FILA_APARTADA,
            complementariaDe: null,
          },
        ],
      })
      expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
    })

    it('🔴 ronda 1 (I1): un emisor que pasó de BIMESTRAL a MENSUAL ⇒ `periodos` sólo trae los mensuales (sin `desde` ni llave repetidos), la bimestral sale APARTE, y el POST con el `desde` de la bimestral NO timbra la mensual: responde su motivo', async () => {
      const MAYO_5 = new Date('2026-05-05T17:00:00Z') // bimestre cerrado: mar-abr; meses recientes: abril y MARZO (empieza el mismo día)
      await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { globalPeriodicity: 'BIMESTRAL', regimenFiscal: '621' } })
      const enElBimestre = await venta([['CREDIT_CARD', m1, new Date('2026-03-10T12:00:00Z')]])
      await expect(
        issueGlobalForEmisor(
          { emisorId: fiscalEmisorId, now: MAYO_5, sandbox: true },
          {
            resolveProvider: () => {
              throw new Error('sin proveedor')
            },
          },
        ),
      ).rejects.toThrow('sin proveedor')
      const bimestral = await prisma.cfdi.findFirstOrThrow({ where: { venueId, isGlobal: true } })
      expect(await manifiesto(bimestral.id)).toEqual([enElBimestre.id])
      await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { globalPeriodicity: 'MENSUAL', regimenFiscal: '601' } })
      // Una venta de marzo que NO quedó en el bimestre (llegó después de apartarlo): sin la guarda, la mensual de marzo la timbraría.
      const fuera = await venta([['CREDIT_CARD', m1, new Date('2026-03-20T12:00:00Z')]])
      const r = await periodosDeLaGlobal({ venueId, emisorId: fiscalEmisorId, now: MAYO_5 })
      expect(r.periodos.map(p => [p.meses, p.desde])).toEqual([
        ['04', '2026-04-01T06:00:00.000Z'],
        ['03', '2026-03-01T06:00:00.000Z'],
      ])
      expect(new Set(r.periodos.map(p => p.desde)).size).toBe(2)
      expect(r.otrasPeriodicidades.globales.map(g => [g.cfdiId, g.periodicidad, g.meses, g.desde, g.estado])).toEqual([
        [bimestral.id, 'BIMESTRAL', '14', '2026-03-01T06:00:00.000Z', 'APARTADA'],
      ])
      // El POST …/global con el `desde` de la bimestral (= el inicio de marzo) no timbra la MENSUAL de marzo: responde su motivo.
      const post = await issueGlobalForEmisor({ emisorId: fiscalEmisorId, now: MAYO_5, sandbox: true, desde: '2026-03-01T06:00:00.000Z' })
      expect(post).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_PERIODO_CUBIERTO] })
      expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
      expect(await prisma.cfdi.count({ where: { venueId, isGlobal: true } })).toBe(1) // sólo la bimestral apartada
      expect(await prisma.cfdiGlobalOrden.count({ where: { orderId: fuera.id } })).toBe(0)
      // Las llaves del panel no se repiten entre `periodos` y el aparte.
      const llaves = r.periodos.map(p => `${p.desde}|${p.meses}`).concat(r.otrasPeriodicidades.globales.map(g => `${g.desde}|${g.meses}`))
      expect(new Set(llaves).size).toBe(llaves.length)
    })

    it('🔴 ronda 1 (I2): con las fechas reales de la base, un aviso DETENIDO viejo no tapa el rechazo NUEVO del PAC; uno más nuevo que la fila, sí manda', async () => {
      await venta([['CREDIT_CARD', m1, MAYO]])
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
      const fila = await prisma.cfdi.findFirstOrThrow({ where: { venueId, isGlobal: true } })
      const aviso = (createdAt: Date, motivo: string) =>
        prisma.activityLog.create({
          data: {
            venueId,
            action: 'CFDI_GLOBAL_PERIODO_DETENIDO',
            entity: 'FiscalEmisor',
            entityId: fiscalEmisorId,
            createdAt,
            data: {
              emisorId: fiscalEmisorId,
              desde: periodoMayo.periodStart.toISOString(),
              hasta: periodoMayo.periodEnd.toISOString(),
              meses: periodoMayo.meses,
              anio: periodoMayo.anio,
              periodicidad: periodoMayo.satPeriodicidad,
              motivo,
              status: 'ERROR',
            },
          },
        })
      await aviso(new Date(Date.now() - 60_000), MOTIVO_ERROR_DEL_PERIODO) // 04:00, la pasada truena
      await prisma.cfdi.update({
        where: { id: fila.id },
        data: { status: 'STAMP_FAILED', falloDefinitivo: true, enviadoAt: new Date(), lastError: 'El SAT rechazó: CFDI40147' },
      }) // después, el rechazo del PAC queda en la fila
      const mayo = async () =>
        (await periodosDeLaGlobal({ venueId, emisorId: fiscalEmisorId, now: NOW })).periodos.find(p => p.meses === '05')
      expect(await mayo()).toMatchObject({ estado: 'SIN_TIMBRAR', motivo: 'El SAT rechazó: CFDI40147' })
      await aviso(new Date(Date.now() + 60_000), 'Un aviso posterior a la fila.')
      expect(await mayo()).toMatchObject({ estado: 'SIN_TIMBRAR', motivo: 'Un aviso posterior a la fila.' })
    })

    // ── T10, ronda 2: la guarda de periodo cubierto bloquea sólo un periodo CONTENIDO entero en otra global pendiente (R1); las que no
    // apartan ventas no cubren nada (N4); una fila de la cola detenida deja ver su motivo (N2) ──
    const SEP_5 = new Date('2026-09-05T17:00:00Z')
    const sinProveedor = {
      resolveProvider: () => {
        throw new Error('sin proveedor')
      },
    }
    const reservarSinEnviar = async (params: { now: Date; desde?: string }) => {
      await expect(issueGlobalForEmisor({ emisorId: fiscalEmisorId, sandbox: true, ...params }, sinProveedor as any)).rejects.toThrow(
        'sin proveedor',
      )
    }
    const emisorA = (data: { globalPeriodicity: 'DIARIO' | 'MENSUAL' | 'BIMESTRAL'; regimenFiscal?: string }) =>
      prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data })

    it('🔴 ronda 2 (R1): julio mensual PENDIENTE no bloquea la bimestral jul-ago (no la contiene entera): agosto entra; lo apartado de julio sigue en julio', async () => {
      await emisorA({ globalPeriodicity: 'MENSUAL', regimenFiscal: '621' })
      const enJulio = await venta([['CREDIT_CARD', m1, new Date('2026-07-10T12:00:00Z')]])
      await reservarSinEnviar({ now: SEP_5, desde: '2026-07-01T06:00:00.000Z' })
      const julio = await prisma.cfdi.findFirstOrThrow({ where: { venueId, isGlobal: true } })
      expect(julio).toMatchObject({ status: 'STAMPING', enviadoAt: null, globalPeriod: { periodicidad: '04', meses: '07' } })
      const enAgosto = await venta([['CREDIT_CARD', m1, new Date('2026-08-10T12:00:00Z')]])
      await emisorA({ globalPeriodicity: 'BIMESTRAL' })
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      const r = await issueGlobalForEmisor({ emisorId: fiscalEmisorId, now: SEP_5, sandbox: true })
      expect(r).toMatchObject({ status: 'STAMPED', period: { meses: '16', anio: 2026 } })
      expect(await manifiesto(r.cfdi.id)).toEqual([enAgosto.id])
      expect(await manifiesto(julio.id)).toEqual([enJulio.id])
    })

    it('🔴 ronda 2 (R1): una diaria PENDIENTE del 1-sep no bloquea septiembre (no lo contiene): el mes se timbra con lo demás', async () => {
      await emisorA({ globalPeriodicity: 'DIARIO' })
      const delPrimero = await venta([['CREDIT_CARD', m1, new Date('2026-09-01T18:00:00Z')]])
      await reservarSinEnviar({ now: new Date('2026-09-02T17:00:00Z') })
      const diaria = await prisma.cfdi.findFirstOrThrow({ where: { venueId, isGlobal: true } })
      expect(diaria).toMatchObject({ status: 'STAMPING', enviadoAt: null, globalPeriod: { periodicidad: '01' } })
      const delQuince = await venta([['CREDIT_CARD', m1, new Date('2026-09-15T18:00:00Z')]])
      await emisorA({ globalPeriodicity: 'MENSUAL' })
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      const r = await issueGlobalForEmisor({ emisorId: fiscalEmisorId, now: new Date('2026-10-03T17:00:00Z'), sandbox: true })
      expect(r).toMatchObject({ status: 'STAMPED', period: { meses: '09', anio: 2026 } })
      expect(await manifiesto(r.cfdi.id)).toEqual([delQuince.id])
      expect(await manifiesto(diaria.id)).toEqual([delPrimero.id])
    })

    it('🔴 ronda 2 (R1): dos filas sin enviar que se cruzan NO se bloquean entre sí: sólo espera la contenida (julio); la que la contiene avanza, y después julio también', async () => {
      await emisorA({ globalPeriodicity: 'MENSUAL', regimenFiscal: '621' })
      const enJulio = await venta([['CREDIT_CARD', m1, new Date('2026-07-10T12:00:00Z')]])
      await reservarSinEnviar({ now: SEP_5, desde: '2026-07-01T06:00:00.000Z' })
      const julio = await prisma.cfdi.findFirstOrThrow({ where: { venueId, isGlobal: true } })
      const enAgosto = await venta([['CREDIT_CARD', m1, new Date('2026-08-10T12:00:00Z')]])
      await emisorA({ globalPeriodicity: 'BIMESTRAL' })
      await reservarSinEnviar({ now: SEP_5 }) // la bimestral también queda apartada, sin enviar: julio no la frena
      const bimestral = await prisma.cfdi.findFirstOrThrow({ where: { venueId, isGlobal: true, id: { not: julio.id } } })
      expect(bimestral).toMatchObject({ status: 'STAMPING', enviadoAt: null, globalPeriod: { periodicidad: '05', meses: '16' } })
      const periodoDeJulio = periodoDeGlobalPeriod({ periodicidad: '04', meses: '07', anio: 2026 })!
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      // La contenida espera… (ola final, T1: la que la cubre es la bimestral de HOY, así que el texto no dice «de cuando tenía otra»)
      expect(
        await issueGlobalForPeriod({
          emisorId: fiscalEmisorId,
          now: SEP_5,
          sandbox: true,
          period: periodoDeJulio,
          key: julio.idempotencyKey!,
        }),
      ).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_PERIODO_CUBIERTO_POR_LA_ACTUAL] })
      // …la que la contiene avanza (julio no la contiene)…
      const rBim = await issueGlobalForEmisor({ emisorId: fiscalEmisorId, now: SEP_5, sandbox: true })
      expect(rBim).toMatchObject({ status: 'STAMPED', period: { meses: '16' } })
      expect(await manifiesto(bimestral.id)).toEqual([enAgosto.id])
      // …y ya timbrada, julio deja de estar cubierto: se timbra con su venta.
      const rJul = await issueGlobalForPeriod({
        emisorId: fiscalEmisorId,
        now: SEP_5,
        sandbox: true,
        period: periodoDeJulio,
        key: julio.idempotencyKey!,
      })
      expect(rJul).toMatchObject({ status: 'STAMPED' })
      expect(await manifiesto(julio.id)).toEqual([enJulio.id])
    })

    it('control — ronda 2 (N4): una global de otra periodicidad TIMBRADA, rechazada en definitiva, diagnóstica o cancelada NO cubre nada (contra la base)', async () => {
      const MAYO_5 = new Date('2026-05-05T17:00:00Z')
      const casos: Array<[string, Record<string, unknown>]> = [
        ['timbrada', { status: 'STAMPED', uuid: randomUUID(), enviadoAt: new Date() }],
        ['rechazada en definitiva', { status: 'STAMP_FAILED', falloDefinitivo: true, enviadoAt: new Date(), lastError: 'El SAT rechazó' }],
        ['diagnóstica', { status: 'VALIDATION_FAILED', lastError: 'no cuadra' }],
        ['cancelada', { status: 'CANCELLED', cancelStatus: 'ACCEPTED', uuid: randomUUID(), enviadoAt: new Date() }],
      ]
      for (const [caso, estado] of casos) {
        await cleanOrders()
        await emisorA({ globalPeriodicity: 'BIMESTRAL', regimenFiscal: '621' })
        await venta([['CREDIT_CARD', m1, new Date('2026-03-10T12:00:00Z')]])
        await reservarSinEnviar({ now: MAYO_5 })
        const bimestral = await prisma.cfdi.findFirstOrThrow({ where: { venueId, isGlobal: true } })
        await prisma.cfdi.update({ where: { id: bimestral.id }, data: estado as any })
        await emisorA({ globalPeriodicity: 'MENSUAL', regimenFiscal: '601' })
        await venta([['CREDIT_CARD', m1, new Date('2026-03-20T12:00:00Z')]])
        provider.createGlobalInvoice.mockImplementation(async () => valid())
        const r = await issueGlobalForEmisor({ emisorId: fiscalEmisorId, now: MAYO_5, sandbox: true, desde: '2026-03-01T06:00:00.000Z' })
        expect([caso, r.status, r.reasons ?? []]).toEqual([caso, 'STAMPED', []])
      }
    })

    it('🔴 ronda 2 (N2): una fila de la COLA que la pasada detiene deja ver su motivo en el panel (con los relojes reales)', async () => {
      await venta([['CREDIT_CARD', m1, MAYO]])
      await reservarSinEnviar({ now: NOW })
      const fila = await prisma.cfdi.findFirstOrThrow({ where: { venueId, isGlobal: true } })
      jest.spyOn(logger, 'error').mockImplementation(() => logger)
      await emitirGlobalesPendientes(
        { emisorId: fiscalEmisorId, now: NOW, sandbox: true, cursor: null },
        { emitirPeriodo: jest.fn().mockRejectedValue(new Error('se cayó la base')) },
      )
      const r = await periodosDeLaGlobal({ venueId, emisorId: fiscalEmisorId, now: NOW })
      expect(r.periodos.find(p => p.meses === '05')).toMatchObject({
        estado: 'SIN_TIMBRAR',
        cfdiId: fila.id,
        motivo: MOTIVO_ERROR_DEL_PERIODO,
      })
    })

    it('🔴 ola final (N2-bis): con el MISMO desenlace en la 2.ª pasada, el panel sigue diciendo el motivo (relojes y deduplicación reales)', async () => {
      await venta([['CREDIT_CARD', m1, MAYO]])
      await reservarSinEnviar({ now: NOW })
      const fila = await prisma.cfdi.findFirstOrThrow({ where: { venueId, isGlobal: true } })
      jest.spyOn(logger, 'error').mockImplementation(() => logger)
      const pasada = () =>
        emitirGlobalesPendientes(
          { emisorId: fiscalEmisorId, now: NOW, sandbox: true, cursor: null },
          { emitirPeriodo: jest.fn().mockRejectedValue(new Error('se cayó la base')) },
        )
      const enElPanel = async () =>
        (await periodosDeLaGlobal({ venueId, emisorId: fiscalEmisorId, now: NOW })).periodos.find(p => p.meses === '05')
      await pasada()
      expect(await enElPanel()).toMatchObject({ estado: 'SIN_TIMBRAR', cfdiId: fila.id, motivo: MOTIVO_ERROR_DEL_PERIODO })
      await pasada() // el día siguiente: la cola vuelve a mover la fila
      expect(await enElPanel()).toMatchObject({ estado: 'SIN_TIMBRAR', cfdiId: fila.id, motivo: MOTIVO_ERROR_DEL_PERIODO })
      // Mayo (la fila de la cola): un aviso por pasada en que la cola la movió, y el último más nuevo que la fila. Abril (sin fila, detenido
      // por el mismo error del doble) no se mueve: su aviso se deduplica (uno solo en las dos pasadas).
      const todos = await prisma.activityLog.findMany({
        where: { venueId, action: 'CFDI_GLOBAL_PERIODO_DETENIDO' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, data: true },
        take: 10,
      })
      const de = (meses: string) => todos.filter(a => (a.data as { meses?: string }).meses === meses)
      expect(de('04')).toHaveLength(1)
      const avisos = de('05')
      expect(avisos).toHaveLength(2)
      const despues = await prisma.cfdi.findUniqueOrThrow({ where: { id: fila.id }, select: { updatedAt: true } })
      expect(avisos[1].createdAt.getTime()).toBeGreaterThanOrEqual(despues.updatedAt.getTime())
    })

    it('🔴 ronda 2 (m4 de la T12): con la PRINCIPAL reservada y sin enviar, el listado cuenta CON `self`: su venta que hoy queda fuera por configuración se lista (como la recaptura la dejaría fuera)', async () => {
      const a = await venta([['CREDIT_CARD', m1, MAYO]])
      await reservarSinEnviar({ now: NOW })
      const principal = await prisma.cfdi.findFirstOrThrow({ where: { venueId, isGlobal: true } })
      expect(await manifiesto(principal.id)).toEqual([a.id])
      await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { includeInGlobal: false } })
      const r = await listarExcluidasDeLaGlobal({ venueId, emisorId: fiscalEmisorId, now: NOW })
      expect(r.excluidas.map(x => [x.orderId, x.motivo])).toEqual([[a.id, 'COMERCIO_FUERA']])
      expect(r.totales).toMatchObject({ porMotivo: { COMERCIO_FUERA: 1 }, total: 1 })
      // El mismo conjunto que la vista previa y que la recaptura: emitir ahora la deja fuera con ese motivo.
      expect(await global()).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_SIN_TICKETS], excluidas: { COMERCIO_FUERA: 1 } })
    })

    it('control — founder: una venta con comercio compatible + efectivo ⇒ igual que hoy (entra con «Facturar efectivo», interruptor apagado)', async () => {
      const o = await venta([
        ['CREDIT_CARD', m1, MAYO],
        ['CASH', null, MAYO],
      ])
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      const r = await global()
      expect(r).toMatchObject({ status: 'STAMPED', candidateCount: 1 })
      expect(r.excluidas).toEqual({}) // estricto: el efectivo de una venta que entra no se cuenta como excluido (sabotaje s1)
      expect(await manifiesto(r.cfdi.id)).toEqual([o.id])
    })
  })

  describe('C1 · Tarea 7 — la captura v2 de punta a punta', () => {
    const row = () => prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: `cfdi-global-${fiscalEmisorId}-2026-05-04` } })
    /** Una venta de v1: un cobro con tarjeta del comercio m1 en MAYO; cada renglón con su precio y, si trae, su descuento propio. */
    async function order(
      renglones: Array<{ productId: string; precio: number; descuento?: number }>,
      opts: { contratoDePrecio?: 'IVA_INCLUIDO' | 'IVA_APARTE' | 'DESCONOCIDO'; descuentoDeCuentaCents?: number } = {},
    ) {
      const bruto = renglones.reduce((s, r) => s + Math.round(r.precio * 100), 0)
      const descuento = renglones.reduce((s, r) => s + Math.round((r.descuento ?? 0) * 100), 0) + (opts.descuentoDeCuentaCents ?? 0)
      const cobrado = (bruto - descuento) / 100
      return prisma.order.create({
        data: {
          venueId,
          orderNumber: randomUUID(),
          subtotal: bruto / 100,
          taxAmount: 0,
          discountAmount: descuento / 100,
          total: cobrado,
          paymentStatus: 'PAID',
          contratoDePrecio: opts.contratoDePrecio ?? 'IVA_INCLUIDO',
          items: {
            create: renglones.map(r => ({
              productId: r.productId,
              productName: 'Producto',
              quantity: 1,
              unitPrice: r.precio,
              discountAmount: r.descuento ?? 0,
              taxAmount: 0,
              total: r.precio,
            })),
          },
          payments: {
            create: {
              venueId,
              merchantAccountId: m1,
              amount: cobrado,
              feePercentage: 0,
              feeAmount: 0,
              netAmount: cobrado,
              method: 'CREDIT_CARD',
              status: 'COMPLETED',
              createdAt: MAYO,
            },
          },
        },
        include: { items: true },
      })
    }
    /** Una venta todo al 16 % con IVA APARTE (precio neto; se cobra neto + IVA = round(neto × 1.16), como la suma B3a). */
    async function ventaConIvaAparte(netCents: number) {
      const g = Math.round(netCents * 1.16)
      return prisma.order.create({
        data: {
          venueId,
          orderNumber: randomUUID(),
          subtotal: netCents / 100,
          taxAmount: (g - netCents) / 100,
          total: g / 100,
          paymentStatus: 'PAID',
          contratoDePrecio: 'IVA_APARTE',
          items: {
            create: {
              productId: p16,
              productName: 'Producto',
              quantity: 1,
              unitPrice: netCents / 100,
              taxAmount: (g - netCents) / 100,
              total: netCents / 100,
            },
          },
          payments: {
            create: {
              venueId,
              merchantAccountId: m1,
              amount: g / 100,
              feePercentage: 0,
              feeAmount: 0,
              netAmount: g / 100,
              method: 'CREDIT_CARD',
              status: 'COMPLETED',
              createdAt: MAYO,
            },
          },
        },
      })
    }
    /**
     * G6 en su forma REAL (ajuste del controlador: con IVA incluido y sin descuento en el concepto la global suma exacto; la «sobra» nace
     * con IVA aparte): netos $10.15 y $20.15 ⇒ cobrados 11.77 + 23.37; el PAC daría 35.15 contra 35.14 ⇒ la 6b pone 1 ¢ de descuento.
     */
    const ordenesDeG6EnBase = async () => [await ventaConIvaAparte(1015), await ventaConIvaAparte(2015)]
    /** G8 en su forma real (los 5 tickets IVA aparte de la Tarea 3): cobrados Σ 3083.61; el PAC da 3083.60 y no hay descuento que bajar. */
    const NETOS_G8 = [51599, 77125, 36111, 64222, 36771]
    const ordenesDeG8EnBase = async () => {
      const r = []
      for (const n of NETOS_G8) r.push(await ventaConIvaAparte(n))
      return r
    }
    /**
     * Busca con las funciones reales el ticket que, junto con G8, da lo cobrado, y lo crea con el contrato pedido. Es un MEZCLADO (16 % +
     * 0 %, $100 al 0 %): con la Tarea 6 un ticket todo al 16 % entra sin importar el contrato, así que el único ticket que «contrato
     * desconocido» deja fuera es uno con IVA distinto (desviación del plan, que decía «todo-16»). Encontrado: $58.01 + $100.00.
     */
    async function ticketQueHaceCuadrarAG8EnBase(opts: { contratoDePrecio: 'DESCONOCIDO' | 'IVA_INCLUIDO' }) {
      const aparte = NETOS_G8.flatMap((n, i) => {
        const g = Math.round(n * 1.16)
        const sub = Math.round(g / 1.16)
        const linea = { orderId: `g${i}`, orderNumber: `g${i}`, totalCents: g, subtotalCents: sub, taxCents: g - sub, formaPago: '04' }
        return conceptosDeOrdenGlobal({
          folio: `g${i}`,
          porTratamiento: { IVA_16: g },
          lineas: [{ ...linea, priceIncludesIva: false, taxRate: 0.16 }],
        })
      })
      const cobrado8 = NETOS_G8.reduce((s, n) => s + Math.round(n * 1.16), 0)
      for (let p16Cents = 5800; p16Cents <= 50000; p16Cents++) {
        const x = conceptosDeOrdenGlobal({ folio: 'x', porTratamiento: { IVA_16: p16Cents, IVA_0: 10000 } })
        const c = cuadrarLaGlobal([...aparte, ...x], cobrado8 + p16Cents + 10000, {
          cobradoPorTasa: { IVA_16: cobrado8 + p16Cents, IVA_0: 10000 },
          filasD16: SIN_FILAS_D16,
        })
        if (c.ok)
          return order(
            [
              { productId: p16, precio: p16Cents / 100 },
              { productId: p0, precio: 100 },
            ],
            opts,
          )
      }
      throw new Error('no se encontró un ticket que haga cuadrar a G8')
    }
    /** Corre la reserva con un envío que nunca ocurre: el proveedor «truena» antes del POST. Devuelve la fila STAMPING sin enviar. */
    async function reservaV2SinEnviar(ids: string[]) {
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
      const r = await row()
      expect(r).toMatchObject({ status: 'STAMPING', enviadoAt: null })
      expect(
        (await prisma.cfdiGlobalOrden.findMany({ where: { cfdiId: r.id }, select: { orderId: true }, take: 10 }))
          .map(x => x.orderId)
          .sort(),
      ).toEqual([...ids].sort())
      return r
    }
    /** El PAC ya tiene la factura que se le mandó (la respuesta se perdió): la consulta por identidad la devuelve. */
    const timbradaEnElPac = (p: typeof provider, enviado: { items: unknown[] }) => {
      expect(enviado.items.length).toBeGreaterThan(0)
      const factura = valid()
      p.findByExternalId.mockResolvedValue(factura)
      p.getInvoice.mockResolvedValue(factura)
    }

    it('🔴 un ticket mezclado y uno todo-16: los dos entran; el mezclado sale neto con sus bases; manifiesto y sellos con su IVA', async () => {
      const a = await order([{ productId: p16, precio: 116 }])
      const b = await order([
        { productId: p0, precio: 200 },
        { productId: p16, precio: 58 },
      ])
      provider.createGlobalInvoice.mockImplementation(async params => {
        const c = await row()
        expect(c.entrada).toMatchObject({ version: 2, excluidas: {}, excluidasPorIvaMixto: 0, ajustes: [] })
        expect(await prisma.cfdiGlobalOrden.count({ where: { cfdiId: c.id } })).toBe(2)
        const sellos = await prisma.orderItem.findMany({ where: { orderId: b.id }, select: { ivaTratamiento: true }, take: 10 })
        expect(sellos.map(x => x.ivaTratamiento).sort()).toEqual(['IVA_0', 'IVA_16'])
        const [hoy, mezclado] = [
          params.items.find((i: any) => i.sku === a.orderNumber),
          params.items.find((i: any) => i.sku === b.orderNumber),
        ]
        expect(hoy).toMatchObject({ unitPriceCents: 11600, taxIncluded: true })
        expect(mezclado).toMatchObject({ taxIncluded: false, unitPriceCents: 25000 })
        expect(mezclado.taxes).toEqual([
          { type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false, base: '50.000000' },
          { type: 'IVA', factor: 'Tasa', rate: 0, withholding: false, base: '200.000000' },
        ])
        return valid()
      })
      expect((await global()).status).toBe('STAMPED')
      expect(await row()).toMatchObject({ subtotalCents: 35000, taxCents: 2400, totalCents: 37400 })
    })

    it('🔴 «sobra» (G6 en su forma real): se ajusta y se congela; si la respuesta del PAC se pierde, la recuperación termina el MISMO documento', async () => {
      await ordenesDeG6EnBase()
      // El PAC timbra pero la respuesta se pierde (envío incierto). Mismo doble de recuperación que usa globalManifiesto.test.ts.
      provider.createGlobalInvoice.mockRejectedValueOnce(new Error('ECONNRESET'))
      expect((await global()).status).not.toBe('STAMPED')
      const enviado = provider.createGlobalInvoice.mock.calls[0][0]
      expect(enviado.items.filter((i: any) => i.discountCents === 1)).toHaveLength(1)
      const antes = await row()
      expect((antes.entrada as any).ajustes).toHaveLength(1)
      expect(antes.totalCents).toBe(3514) // lo cobrado (el PAC sin ajuste daría 3515)
      timbradaEnElPac(provider, enviado)
      expect((await global()).status).toBe('STAMPED')
      expect(provider.createGlobalInvoice).toHaveBeenCalledTimes(1) // no se volvió a mandar: se recuperó
      const despues = await row()
      expect(despues.entrada).toEqual(antes.entrada) // la foto y el ajuste congelados no cambian
      expect(() => leerGlobal(despues)).not.toThrow()
      expect(despues.totalCents).toBe((antes.entrada as any).ordenes.reduce((s: number, o: any) => s + o.paidCents, 0))
    })

    it('🔴 C1-12: «falta» ⇒ motivo visible; el siguiente intento LEE la diagnóstica y recaptura; tras corregir, se timbra', async () => {
      await ordenesDeG8EnBase()
      const x = await ticketQueHaceCuadrarAG8EnBase({ contratoDePrecio: 'DESCONOCIDO' }) // excluido por contrato desconocido (CONTRATO_DESCONOCIDO)
      const r1 = await global()
      expect(r1).toMatchObject({ status: 'VALIDATION_FAILED', excluidas: { CONTRATO_DESCONOCIDO: 1 }, excluidasPorIvaMixto: 1 })
      expect(r1.reasons!.join(' ')).toMatch(/moviendo centavos/)
      expect(await global()).toMatchObject({ status: 'VALIDATION_FAILED' }) // se vuelve a leer y recapturar: no truena con «soporte»
      await prisma.order.update({ where: { id: x.id }, data: { contratoDePrecio: 'IVA_INCLUIDO' } }) // el dueño confirma el contrato
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      expect((await global()).status).toBe('STAMPED')
      expect(provider.createGlobalInvoice).toHaveBeenCalledTimes(1)
      expect(await row()).toMatchObject({
        totalCents: NETOS_G8.reduce((s, n) => s + Math.round(n * 1.16), 0) + Math.round(Number(x.total) * 100),
      })
    })

    it('🔴 ola final (I2): una diagnóstica cuya entrada ya NO pasa el lector se recaptura (nunca «soporte»); corregida, se timbra', async () => {
      await ordenesDeG8EnBase()
      const x = await ticketQueHaceCuadrarAG8EnBase({ contratoDePrecio: 'DESCONOCIDO' })
      const r1 = await global()
      expect(r1).toMatchObject({ status: 'VALIDATION_FAILED' })
      // La 6b (o la cota) cambia después de guardarla, o alguien la toca: la diagnóstica guardada deja de pasar el lector.
      const yaNoValida = () => prisma.cfdi.update({ where: { id: r1.cfdi!.id }, data: { entradaHuella: 'huella-que-ya-no-corresponde' } })
      await yaNoValida()
      const alterada = await row()
      expect(() => leerGlobal(alterada, 'DIAGNOSTICO')).toThrow(/soporte/) // control: el lector la rechaza
      // Sin corregir nada: se recaptura desde las órdenes (mismo motivo, misma fila) en vez de quedarse en «revisión de soporte».
      const r2 = await global()
      expect(r2).toMatchObject({ status: 'VALIDATION_FAILED', cfdi: { id: r1.cfdi!.id } })
      expect(r2.reasons!.join(' ')).toMatch(/moviendo centavos/)
      expect(() => leerGlobal(r2.cfdi!, 'DIAGNOSTICO')).not.toThrow() // la recaptura dejó una entrada que el lector acepta
      // El escenario de la revisión: vuelve a no validar, el dueño corrige y pulsa «Emitir» ⇒ se timbra (antes: 409 «soporte» cada día).
      await yaNoValida()
      await prisma.order.update({ where: { id: x.id }, data: { contratoDePrecio: 'IVA_INCLUIDO' } })
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      expect((await global()).status).toBe('STAMPED')
      expect(provider.createGlobalInvoice).toHaveBeenCalledTimes(1)
      expect(await row()).toMatchObject({
        id: r1.cfdi!.id,
        totalCents: NETOS_G8.reduce((s, n) => s + Math.round(n * 1.16), 0) + Math.round(Number(x.total) * 100),
      })
    })

    // Control: pasa también sin la unión, porque `loadGlobalCandidates` ya recibe la reserva (`self`, Tarea 5) y la lista trae sus tickets.
    // La que muerde la unión es la siguiente (la lista leída fuera de la transacción NO los trae).
    it('control — 🔴 C1-13: una reserva STAMPING sin enviar, con su manifiesto, se retoma con SUS tickets (no los expulsa)', async () => {
      const a = await order([{ productId: p16, precio: 116 }])
      const b = await order([{ productId: p16, precio: 58 }])
      const reserva = await reservaV2SinEnviar([a.id, b.id])
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      expect((await global()).status).toBe('STAMPED')
      expect(
        (await prisma.cfdiGlobalOrden.findMany({ where: { cfdiId: reserva.id }, select: { orderId: true }, take: 10 }))
          .map(x => x.orderId)
          .sort(),
      ).toEqual([a.id, b.id].sort())
    })

    it('🔴 C1-13: aunque la lista de candidatos (leída FUERA de la transacción) no los traiga, la reserva recaptura SUS tickets (la unión)', async () => {
      const a = await order([{ productId: p16, precio: 116 }])
      const b = await order([{ productId: p16, precio: 58 }])
      const reserva = await reservaV2SinEnviar([a.id, b.id])
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      const r = await issueGlobalForEmisor({ emisorId: fiscalEmisorId, now: NOW, sandbox: true }, { loadGlobalCandidates: async () => [] })
      expect(r).toMatchObject({ status: 'STAMPED', candidateCount: 2 })
      expect(
        (await prisma.cfdiGlobalOrden.findMany({ where: { cfdiId: reserva.id }, select: { orderId: true }, take: 10 }))
          .map(x => x.orderId)
          .sort(),
      ).toEqual([a.id, b.id].sort())
    })

    it('🔴 C1-23: una reserva existente pierde TODOS sus candidatos ⇒ VALIDATION_FAILED con su motivo; el siguiente intento la LEE y, corregido, se timbra', async () => {
      const a = await order([{ productId: p16, precio: 116 }])
      await reservaV2SinEnviar([a.id])
      await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { includeInGlobal: false } }) // deja de pertenecer
      try {
        const r = await global()
        expect(r).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_SIN_TICKETS] })
        const fila = await prisma.cfdi.findUniqueOrThrow({ where: { id: r.cfdi!.id } })
        expect(leerGlobal(fila, 'DIAGNOSTICO')).toMatchObject({ ordenes: [], cuadre: { ok: false, motivo: MOTIVO_SIN_TICKETS } })
        expect(() => leerGlobal(fila, 'PARA_ENVIAR')).toThrow()
      } finally {
        await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { includeInGlobal: true } }) // se corrige
      }
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      expect((await global()).status).toBe('STAMPED')
    })

    it('🔴 «falta» (G8 en su forma real): se detiene con el motivo de la 6b; ni PAC, ni sellos, ni manifiesto', async () => {
      await ordenesDeG8EnBase()
      const r = await global()
      expect(r).toMatchObject({ status: 'VALIDATION_FAILED' })
      expect(r.reasons!.join(' ')).toMatch(/moviendo centavos/)
      expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
      const c = await row()
      expect(await prisma.cfdiGlobalOrden.count({ where: { cfdiId: c.id } })).toBe(0)
      expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: c.id } })).toBe(0)
    })

    it('🔴 la captura lee las filas de descuento COMPLETAS (más de una página): un mezclado con 102 descuentos dirigidos al 0 % entra con lo suyo', async () => {
      // `ORDER_SELECT` trae una página de filas y una de más (101). Con sólo ésas, la fila 102 ($0.10) quedaría sin constancia y, con IVA
      // mezclado, la venta saldría como DESCUENTO_SIN_REPARTO. `capturarGlobal` las completa (`filasDeDescuentoCompletas`), como la individual.
      const o = await order(
        [
          { productId: p16, precio: 116 },
          { productId: p0, precio: 100 },
        ],
        { descuentoDeCuentaCents: 1020 },
      )
      const cero = o.items.find(i => i.productId === p0)!
      await prisma.orderDiscount.createMany({
        data: Array.from({ length: 102 }, () => ({
          orderId: o.id,
          type: 'FIXED_AMOUNT' as const,
          name: 'Descuento',
          value: 0.1,
          amount: 0.1,
          reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones: { [cero.id]: 10 } },
        })),
      })
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      expect(await global()).toMatchObject({ status: 'STAMPED', candidateCount: 1, excluidas: {} })
      const e = leerGlobal(await row())
      expect(ordenesDeLaGlobal(e)).toEqual([
        expect.objectContaining({ orderId: o.id, paidCents: 20580, porTratamiento: { IVA_16: 11600, IVA_0: 8980 } }),
      ])
    })

    it('🔴 ronda 1 (M1): la captura falla CERRADO: un cobro con una forma SAT de un dígito («4») detiene la global sin dejar reserva, manifiesto ni sellos', async () => {
      // `ticketParaGlobal` sólo excluye «99»; el lector exige dos dígitos. Antes quedaba una reserva STAMPING ilegible que congelaba el periodo
      // (y la factura individual de sus ventas). Ahora la captura se relee en memoria con el mismo lector y, si no pasa, se lanza dentro de la
      // transacción. Elección documentada: lanza (no excluye el ticket): la global de ese periodo espera a que soporte corrija ese cobro.
      const raro = await order([{ productId: p16, precio: 116 }])
      await prisma.payment.updateMany({ where: { orderId: raro.id }, data: { tenderSatFormaPago: '4' } })
      const sano = await order([{ productId: p16, precio: 58 }])
      await expect(global()).rejects.toThrow(/soporte/)
      expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
      expect(await prisma.cfdi.count({ where: { venueId } })).toBe(0)
      expect(await prisma.cfdiGlobalOrden.count({ where: { orderId: { in: [raro.id, sano.id] } } })).toBe(0)
      expect(await prisma.orderItemSelloIva.count({ where: { orderItem: { orderId: { in: [raro.id, sano.id] } } } })).toBe(0)
    })

    it('control — ola final (O2 de la re-revisión 1 de la T7): una RESERVA anterior sin enviar queda INTACTA si su recaptura lanza (fila, manifiesto y sellos)', async () => {
      const sano = await order([{ productId: p16, precio: 116 }])
      const reserva = await reservaV2SinEnviar([sano.id])
      const foto = async () => ({
        fila: await prisma.cfdi.findUniqueOrThrow({
          where: { id: reserva.id },
          select: {
            status: true,
            attempts: true,
            enviadoAt: true,
            falloDefinitivo: true,
            lastError: true,
            entrada: true,
            entradaHuella: true,
            totalCents: true,
            updatedAt: true,
          },
        }),
        manifiesto: await prisma.cfdiGlobalOrden.findMany({ where: { cfdiId: reserva.id }, orderBy: { orderId: 'asc' }, take: 10 }),
        sellos: await prisma.orderItemSelloIva.findMany({ where: { cfdiId: reserva.id }, orderBy: { id: 'asc' }, take: 20 }),
      })
      const antes = await foto()
      expect(antes.manifiesto.map(x => x.orderId)).toEqual([sano.id])
      expect(antes.sellos.length).toBeGreaterThan(0) // la reserva ya selló sus renglones: hay algo que se perdería
      // Entra al periodo un cobro con forma SAT de un dígito: la recaptura (que toma la unión) lanza «revisión de soporte» dentro de la transacción.
      const raro = await order([{ productId: p16, precio: 58 }])
      await prisma.payment.updateMany({ where: { orderId: raro.id }, data: { tenderSatFormaPago: '4' } })
      await expect(global()).rejects.toThrow(/soporte/)
      expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
      expect(await foto()).toEqual(antes) // ni el CAS a STAMPING, ni `attempts`, ni el manifiesto, ni los sellos se movieron
      expect(await prisma.cfdiGlobalOrden.count({ where: { orderId: raro.id } })).toBe(0)
    })

    it('🔴 ronda 1 (M4): una global ENVIADA e incierta se pregunta al PAC ANTES de leerla: si el PAC la timbró, se finaliza con su UUID aunque su entrada ya no pase el lector', async () => {
      await order([{ productId: p16, precio: 116 }])
      provider.createGlobalInvoice.mockRejectedValueOnce(new Error('ECONNRESET'))
      expect((await global()).status).toBe('STAMP_FAILED')
      const antes = await row()
      expect(antes).toMatchObject({ enviadoAt: expect.any(Date), falloDefinitivo: false })
      const entrada = antes.entrada as any
      entrada.params.items[0].unitPriceCents += 1 // la entrada deja de pasar el lector (el PAC ya tiene su documento)
      await prisma.cfdi.update({ where: { id: antes.id }, data: { entrada, entradaHuella: huellaDeEntrada(entrada) } })
      const alterada = await row()
      expect(() => leerGlobal(alterada)).toThrow(/soporte/)
      timbradaEnElPac(provider, provider.createGlobalInvoice.mock.calls[0][0])
      await expect(global()).resolves.toMatchObject({ status: 'STAMPED' })
      expect(provider.findByExternalId).toHaveBeenCalledWith(`${antes.idempotencyKey}#1`)
      expect(provider.createGlobalInvoice).toHaveBeenCalledTimes(1) // nunca se reenvía
      expect(await row()).toMatchObject({ status: 'STAMPED', uuid: expect.any(String) })
    })

    it('un ticket con producto por revisar no entra y se cuenta', async () => {
      const porRevisar = await prisma.product.create({
        data: {
          venueId,
          categoryId: (await prisma.product.findUniqueOrThrow({ where: { id: p0 } })).categoryId,
          name: `${fixture}-04`,
          sku: `${fixture}-04`,
          price: 200,
          ivaTratamiento: 'BLOQUEADO_04',
        },
      })
      await order([{ productId: porRevisar.id, precio: 200 }])
      await order([{ productId: p16, precio: 116 }])
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      expect(await global()).toMatchObject({
        status: 'STAMPED',
        candidateCount: 1,
        excluidas: { PRODUCTO_POR_REVISAR: 1 },
        excluidasPorIvaMixto: 1,
      })
    })

    it('🔴 C1-34 (ida y vuelta): un ticket de $65 − $2.50 al 16 % (el PAC daría 62.49 con el descuento original) se captura con sus reales ORIGINALES, se lee en PARA_ENVIAR sin error y devuelve la MISMA factura que se envía', async () => {
      const t = await order([{ productId: p16, precio: 65, descuento: 2.5 }]) // cobrado 62.50
      let capturada: any
      provider.createGlobalInvoice.mockImplementation(async (params: any) => ((capturada = params), valid()))
      expect((await global()).status).toBe('STAMPED')
      const fila = await row()
      const e = leerGlobal(fila, 'PARA_ENVIAR') // no lanza: (h) acepta reales originales
      expect(ordenesDeLaGlobal(e).find(x => x.orderId === t.id)).toMatchObject({
        conceptosReales: [expect.objectContaining({ precio: '65.000000', descuentoCents: 250 })],
      })
      expect(e.params.items).toEqual(capturada.items) // lo leído es exactamente lo que se mandó al PAC
      expect(fila.totalCents).toBe(6250)
    })

    it('🔴 C1-38: una global v1 RESERVADA SIN ENVIAR (de antes del despliegue) se lee como v1 y se recaptura en v2 con la misma llave', async () => {
      // La forma exacta de la v1, con la llave MENSUAL de hoy, en STAMPING con `enviadoAt: null` (nunca salió al PAC), con su manifiesto y sus sellos.
      const o = await order([{ productId: p16, precio: 116 }])
      const renglones = [{ orderItemId: o.items[0].id, tratamiento: 'IVA_16' as const }]
      const key = `cfdi-global-${fiscalEmisorId}-2026-05-04`
      const entrada = {
        version: 1,
        tipo: 'GLOBAL',
        fiscalEmisorId,
        globalPeriod: { periodicidad: '04', meses: '05', anio: 2026 },
        montos: { subtotalCents: 10000, taxCents: 1600, totalCents: 11600 },
        excluidasPorIvaMixto: 0,
        ordenes: [{ orderId: o.id, huella: huellaDeEntrada({ renglones }), renglones }],
        params: {
          receptor: { legal_name: 'PÚBLICO EN GENERAL', tax_id: 'XAXX010101000', tax_system: '616', address: { zip: '01000' } },
          items: [
            {
              satProductKey: '01010101',
              satUnitKey: 'ACT',
              description: 'Venta',
              quantity: 1,
              unitPriceCents: 11600,
              discountCents: 0,
              objetoImp: '02',
              taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
              taxIncluded: true,
            },
          ],
          payment_form: '04',
          use: 'S01',
          global: { periodicity: 'month', months: '05', year: 2026 },
        },
      }
      await prisma.$transaction(async tx => {
        const c = await tx.cfdi.create({
          data: {
            venueId,
            fiscalEmisorId,
            orderId: null,
            flow: 'GLOBAL_C',
            idempotencyKey: key,
            isGlobal: true,
            globalPeriod: entrada.globalPeriod,
            type: 'INGRESO',
            receptorRfc: 'XAXX010101000',
            receptorNombre: 'PÚBLICO EN GENERAL',
            receptorRegimen: '616',
            receptorCp: '01000',
            usoCfdi: 'S01',
            formaPago: '04',
            metodoPago: 'PUE',
            ...entrada.montos,
            status: 'STAMPING',
            protocoloIva: 1,
            entrada,
            entradaHuella: huellaDeEntrada(entrada),
            attempts: 1,
            enviadoAt: null,
          } as any,
        })
        await tx.cfdiGlobalOrden.create({ data: { cfdiId: c.id, orderId: o.id, huella: entrada.ordenes[0].huella } })
        await sellarRenglones(tx, { cfdiId: c.id, intento: 1, renglones })
      })
      expect(leerGlobal(await row()).version).toBe(1)
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      expect((await global()).status).toBe('STAMPED')
      expect(await row()).toMatchObject({ attempts: 2, entrada: expect.objectContaining({ version: 2, ajustes: [] }) })
    })

    // ── Decisión A del founder (7-oct): una global ENVIADA y rechazada en definitiva se reintenta sola, como en producción. Reemplaza la
    // dorada «C1-38: … NO se recaptura» (que detenía el periodo para siempre). Lo que C1-38 protege sigue: nunca se reenvía la MISMA identidad.
    it('🔴 decisión A (antes C1-38): una global ENVIADA y rechazada en definitiva se recaptura con identidad NUEVA, DESPUÉS de consultar al PAC por la anterior', async () => {
      await order([{ productId: p16, precio: 116 }])
      provider.createGlobalInvoice.mockRejectedValueOnce(new ProviderHttpError(422, 'invoice_stamping_validation_error', 'falla'))
      await global()
      const antes = await row()
      expect(antes).toMatchObject({ status: 'STAMP_FAILED', falloDefinitivo: true, enviadoAt: expect.any(Date), attempts: 1 })
      const llamadas: string[] = []
      provider.findByExternalId.mockImplementation(async (id: string) => (llamadas.push(`consulta ${id}`), null))
      provider.createGlobalInvoice.mockImplementation(async (p: any) => (llamadas.push(`envío ${p.externalId}`), valid()))
      expect((await global()).status).toBe('STAMPED')
      expect(llamadas).toEqual([`consulta ${antes.idempotencyKey}#1`, `envío ${antes.idempotencyKey}#2`])
      expect(await row()).toMatchObject({ status: 'STAMPED', attempts: 2, falloDefinitivo: false })
      // Ronda 1 de la T11 (m1): el intento rechazado deja rastro (la recaptura sobrescribe su `lastError` y su `enviadoAt`).
      const rastro = await prisma.activityLog.findMany({ where: { venueId, action: 'CFDI_GLOBAL_INTENTO_RECHAZADO' }, take: 5 })
      expect(rastro).toHaveLength(1)
      expect(rastro[0]).toMatchObject({
        entity: 'Cfdi',
        entityId: antes.id,
        data: { identidad: `${antes.idempotencyKey}#1`, lastError: antes.lastError, enviadoAt: antes.enviadoAt!.toISOString() },
      })
    })

    it('🔴 decisión A: si el PAC SÍ tiene la identidad anterior (`#1`) con UUID, se finaliza con ella y nunca se reenvía', async () => {
      await order([{ productId: p16, precio: 116 }])
      provider.createGlobalInvoice.mockRejectedValueOnce(new ProviderHttpError(422, 'invoice_stamping_validation_error', 'falla'))
      await global()
      const antes = await row()
      const factura = valid()
      provider.findByExternalId.mockResolvedValue(factura)
      expect(await global()).toMatchObject({ status: 'STAMPED' })
      expect(provider.findByExternalId).toHaveBeenCalledWith(`${antes.idempotencyKey}#1`)
      expect(provider.createGlobalInvoice).toHaveBeenCalledTimes(1) // sólo el envío original
      expect(await row()).toMatchObject({ status: 'STAMPED', attempts: 1, uuid: factura.uuid })
    })

    it('🔴 decisión A: si el PAC no responde, «procesando» sin recapturar ni reenviar', async () => {
      await order([{ productId: p16, precio: 116 }])
      provider.createGlobalInvoice.mockRejectedValueOnce(new ProviderHttpError(422, 'invoice_stamping_validation_error', 'falla'))
      await global()
      const antes = await row()
      provider.findByExternalId.mockRejectedValue(new Error('ECONNRESET'))
      await expect(global()).rejects.toThrow(/procesando/)
      expect(provider.createGlobalInvoice).toHaveBeenCalledTimes(1)
      expect(await row()).toMatchObject({
        status: 'STAMP_FAILED',
        attempts: antes.attempts,
        enviadoAt: antes.enviadoAt,
        entradaHuella: antes.entradaHuella,
      })
    })

    it('🔴 decisión A: la pasada del job la toma al día siguiente (el filtro de pendientes vuelve a ver las enviadas rechazadas) y la timbra con `#2`', async () => {
      await order([{ productId: p16, precio: 116 }])
      provider.createGlobalInvoice.mockRejectedValueOnce(new ProviderHttpError(422, 'invoice_stamping_validation_error', 'falla'))
      await global()
      const antes = await row()
      const r = await emitirGlobalesPendientes(
        { emisorId: fiscalEmisorId, now: new Date('2026-06-04T09:00:00Z'), sandbox: true },
        { resolveProvider: () => provider as any },
      )
      expect(r.resultados).toContainEqual(expect.objectContaining({ status: 'STAMPED' }))
      expect(provider.createGlobalInvoice.mock.calls.map(c => c[0].externalId)).toEqual([
        `${antes.idempotencyKey}#1`,
        `${antes.idempotencyKey}#2`,
      ])
      expect(await row()).toMatchObject({ status: 'STAMPED', attempts: 2 })
    })

    // ── C1 · Tarea 11: la global COMPLEMENTARIA (emisor mensual de mayo; la principal es la de `row()`) ──
    describe('C1 · Tarea 11 — la global complementaria', () => {
      afterEach(async () => {
        await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { globalPeriodicity: 'MENSUAL' } })
      })
      const complementaria = (principalId: string, now = NOW) =>
        emitirGlobalComplementaria(
          { venueId, emisorId: fiscalEmisorId, principalId, now, sandbox: true },
          { resolveProvider: () => provider as any },
        )
      const vistaPrevia = (principalId: string, now = NOW) =>
        vistaPreviaComplementaria({ venueId, emisorId: fiscalEmisorId, principalId, now })
      /** Un producto propio con el IVA por revisar (objeto 04): una venta con él queda fuera de la global hasta que se corrige. */
      async function productoPorRevisar() {
        const sufijo = randomUUID().slice(0, 8)
        return prisma.product.create({
          data: {
            venueId,
            categoryId: (await prisma.product.findUniqueOrThrow({ where: { id: p0 } })).categoryId,
            name: `${fixture}-rev-${sufijo}`,
            sku: `${fixture}-rev-${sufijo}`,
            price: 200,
            ivaTratamiento: 'BLOQUEADO_04',
            objetoImp: '04',
          },
        })
      }
      const corregir = (productId: string) => prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } }) // el enum manda: la base reescribe tasa y objeto
      const emisorConPeriodicidad = (globalPeriodicity: 'DIARIO' | 'MENSUAL') =>
        prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { globalPeriodicity } })
      /** Dos llegan a la barrera antes de que cualquiera reserve (con red de seguridad: nunca cuelga la prueba). */
      function barreraDeDos() {
        let llegaron = 0
        let soltar!: () => void
        const abierta = new Promise<void>(r => (soltar = r))
        const seguro = setTimeout(() => soltar(), 5000)
        return {
          esperar: async () => {
            if (++llegaron === 2) {
              clearTimeout(seguro)
              soltar()
            }
            await abierta
          },
        }
      }
      /** `n` ventas con un producto por revisar, cobradas en `fecha` (createMany: tres consultas, no 3n). */
      async function ventasPorRevisarEnLote(n: number, fecha: Date) {
        const px = await productoPorRevisar()
        const ids = Array.from({ length: n }, () => `${fixture}-lote-${randomUUID()}`)
        await prisma.order.createMany({
          data: ids.map(id => ({
            id,
            venueId,
            orderNumber: id,
            subtotal: 200,
            taxAmount: 0,
            total: 200,
            paymentStatus: 'PAID' as const,
            contratoDePrecio: 'IVA_INCLUIDO' as const,
          })),
        })
        await prisma.orderItem.createMany({
          data: ids.map(orderId => ({
            orderId,
            productId: px.id,
            productName: 'Producto',
            quantity: 1,
            unitPrice: 200,
            taxAmount: 0,
            total: 200,
          })),
        })
        await prisma.payment.createMany({
          data: ids.map(orderId => ({
            orderId,
            venueId,
            merchantAccountId: m1,
            amount: 200,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: 200,
            method: 'CREDIT_CARD' as const,
            status: 'COMPLETED' as const,
            createdAt: fecha,
          })),
        })
        return ids
      }

      it('🔴 una venta corregida después de timbrar entra en la complementaria `-c2`, sólo ella; la segunda vez no hay nada', async () => {
        const px = await productoPorRevisar()
        const a = await venta([['CREDIT_CARD', m1, MAYO]])
        const b = await venta([['CREDIT_CARD', m1, MAYO]], [{ productId: px.id, precio: 200 }])
        provider.createGlobalInvoice.mockImplementation(async () => valid())
        const principal = await global()
        expect((principal.cfdi.entrada as any).ordenes.map((o: any) => o.orderId)).toEqual([a.id])
        await corregir(px.id) // el dueño lo corrige
        expect(await vistaPrevia(principal.cfdi.id)).toMatchObject({
          estadoPrincipal: 'TIMBRADA',
          corregidasPendientes: { n: 1, completo: true },
          siguienteLlave: `${principal.cfdi.idempotencyKey}-c2`,
          motivo: null,
        })
        const c = await complementaria(principal.cfdi.id)
        expect(c).toMatchObject({ status: 'STAMPED', complementariaDe: principal.cfdi.id })
        expect(c.cfdi.idempotencyKey).toBe(`${principal.cfdi.idempotencyKey}-c2`)
        expect((c.cfdi.entrada as any).ordenes.map((o: any) => o.orderId)).toEqual([b.id])
        expect((c.cfdi.entrada as any).complementariaDe).toBe(principal.cfdi.id)
        expect(await prisma.cfdiGlobalOrden.count({ where: { orderId: a.id } })).toBe(1) // A nunca se repite
        expect((await complementaria(principal.cfdi.id)).status).toBe('NOTHING_TO_INVOICE')
        expect(await prisma.cfdi.count({ where: { idempotencyKey: { startsWith: `${principal.cfdi.idempotencyKey}-c` } } })).toBe(1)
        // El panel la lista con su principal y ya no hay nada pendiente.
        const { periodos } = await periodosDeLaGlobal({ venueId, emisorId: fiscalEmisorId, now: NOW })
        expect(periodos.find(p => p.cfdiId === principal.cfdi.id)).toMatchObject({
          corregidasPendientes: { n: 0, completo: true },
          complementarias: [{ cfdiId: c.cfdi.id, folio: expect.anything(), estado: 'TIMBRADA' }],
        })
      })

      it('🔴 C1-25: el emisor pasó de DIARIO a MENSUAL: la complementaria de la principal diaria del 4 de septiembre se pide por su id y usa SU periodo y SU llave', async () => {
        await emisorConPeriodicidad('DIARIO')
        const px = await productoPorRevisar()
        const v = await venta([['CREDIT_CARD', m1, new Date('2026-09-04T18:00:00Z')]], [{ productId: px.id, precio: 200 }])
        provider.createGlobalInvoice.mockImplementation(async () => valid())
        const otra = await venta([['CREDIT_CARD', m1, new Date('2026-09-04T19:00:00Z')]])
        const principal = await issueGlobalForEmisor(
          { emisorId: fiscalEmisorId, now: new Date('2026-09-05T09:00:00Z'), sandbox: true, desde: '2026-09-04T06:00:00.000Z' },
          { resolveProvider: () => provider as any },
        )
        expect((principal.cfdi.entrada as any).ordenes.map((o: any) => o.orderId)).toEqual([otra.id])
        await emisorConPeriodicidad('MENSUAL')
        await corregir(px.id)
        const c = await complementaria(principal.cfdi.id, new Date('2026-10-05T09:00:00Z'))
        expect(c).toMatchObject({ status: 'STAMPED' })
        expect(c.cfdi.idempotencyKey).toBe(`${principal.cfdi.idempotencyKey}-c2`)
        expect((c.cfdi.entrada as any).periodo).toEqual((principal.cfdi.entrada as any).periodo)
        expect((c.cfdi.entrada as any).ordenes.map((o: any) => o.orderId)).toEqual([v.id])
        expect(c.cfdi.globalPeriod).toEqual(principal.cfdi.globalPeriod)
      })

      it('🔴 C1-33: una principal de 2024 pedida en 2026 ⇒ la complementaria NUEVA se detiene antes de reservar; un intento de esa llave ya enviado sí se recupera por su identidad', async () => {
        const dic2024 = new Date('2024-12-03T17:00:00Z')
        await venta([['CREDIT_CARD', m1, new Date('2024-11-15T18:00:00Z')]])
        provider.createGlobalInvoice.mockImplementation(async () => valid())
        const principal = (await issueGlobalForEmisor({ emisorId: fiscalEmisorId, now: dic2024, sandbox: true })).cfdi
        expect(principal).toMatchObject({ status: 'STAMPED', globalPeriod: { meses: '11', anio: 2024 } })
        const ahora = new Date('2026-10-05T09:00:00Z')
        await venta([['CREDIT_CARD', m1, new Date('2024-11-20T18:00:00Z')]]) // llegó tarde a noviembre de 2024
        expect((await vistaPrevia(principal.id, ahora)).motivo).toBe(MOTIVO_ANIO_FUERA)
        expect(await complementaria(principal.id, ahora)).toMatchObject({ status: 'SKIPPED', reason: MOTIVO_ANIO_FUERA })
        expect(await prisma.cfdi.count({ where: { idempotencyKey: { startsWith: `${principal.idempotencyKey}-c` } } })).toBe(0)
        // En diciembre de 2024 (año admitido) se mandó la complementaria y la respuesta se perdió.
        provider.createGlobalInvoice.mockRejectedValueOnce(new Error('ETIMEDOUT'))
        expect((await complementaria(principal.id, dic2024)).status).toBe('STAMP_FAILED')
        const enviada = await prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: `${principal.idempotencyKey}-c2` } })
        expect(enviada).toMatchObject({ enviadoAt: expect.any(Date), falloDefinitivo: false })
        timbradaEnElPac(provider, (enviada.entrada as any).params)
        provider.createGlobalInvoice.mockClear()
        expect(await complementaria(principal.id, ahora)).toMatchObject({ status: 'STAMPED' })
        expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
        expect(anioPermitido(2025, ahora)).toBe(true)
        expect(anioPermitido(2024, ahora)).toBe(false)
      })

      it('🔴 C1-37: una PRINCIPAL mensual de 2024 en VALIDATION_FAILED, nunca enviada y corregida en 2026: el job que retoma pendientes NO la emite; la fila conserva su estado y dice el motivo', async () => {
        const dic2024 = new Date('2024-12-03T17:00:00Z')
        await venta([['CREDIT_CARD', m1, new Date('2024-11-15T18:00:00Z')]])
        await expect(
          issueGlobalForEmisor(
            { emisorId: fiscalEmisorId, now: dic2024, sandbox: true },
            {
              resolveProvider: () => {
                throw new Error('sin proveedor')
              },
            },
          ),
        ).rejects.toThrow('sin proveedor')
        // La venta deja de pertenecer: la reserva se recaptura vacía y queda VALIDATION_FAILED (C1-23); luego se corrige.
        await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { includeInGlobal: false } })
        try {
          expect(await issueGlobalForEmisor({ emisorId: fiscalEmisorId, now: dic2024, sandbox: true })).toMatchObject({
            status: 'VALIDATION_FAILED',
            reasons: [MOTIVO_SIN_TICKETS],
          })
        } finally {
          await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { includeInGlobal: true } })
        }
        const fila = await prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: `cfdi-global-${fiscalEmisorId}-2024-11-04` } })
        expect(fila).toMatchObject({ status: 'VALIDATION_FAILED', enviadoAt: null })
        const r = await emitirGlobalesPendientes(
          { emisorId: fiscalEmisorId, now: new Date('2026-10-05T09:00:00Z'), sandbox: true },
          { resolveProvider: () => provider as any },
        )
        expect(r.resultados).toContainEqual(expect.objectContaining({ status: 'SKIPPED', reason: MOTIVO_ANIO_FUERA }))
        expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: fila.id } })).toMatchObject({
          status: 'VALIDATION_FAILED',
          attempts: fila.attempts,
          enviadoAt: null,
          lastError: MOTIVO_ANIO_FUERA,
        })
        expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
      })

      it('🔴 decisión A (antes C1-38): una COMPLEMENTARIA enviada y rechazada en definitiva se recaptura con identidad NUEVA después de consultar al PAC', async () => {
        provider.createGlobalInvoice.mockImplementation(async () => valid())
        await venta([['CREDIT_CARD', m1, MAYO]])
        const principal = await global()
        const tarde = await venta([['CREDIT_CARD', m1, MAYO]])
        provider.createGlobalInvoice.mockRejectedValueOnce(new ProviderHttpError(422, 'invoice_stamping_validation_error', 'falla'))
        expect((await complementaria(principal.cfdi.id)).status).toBe('STAMP_FAILED')
        const c = await prisma.cfdi.findFirstOrThrow({ where: { idempotencyKey: `${principal.cfdi.idempotencyKey}-c2` } })
        expect(c).toMatchObject({ falloDefinitivo: true, enviadoAt: expect.any(Date), attempts: 1 })
        // El job no la recaptura (sólo la consulta): espera a la persona.
        const job = await emitirGlobalesPendientes(
          { emisorId: fiscalEmisorId, now: NOW, sandbox: true },
          { resolveProvider: () => provider as any },
        )
        expect(job.resultados).toContainEqual(expect.objectContaining({ status: 'SKIPPED', reason: MOTIVO_COMPLEMENTARIA_DEL_JOB }))
        expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ attempts: 1, status: 'STAMP_FAILED' })
        // La persona la reintenta: consulta `-c2#1` y, como el PAC no la tiene, recaptura y manda `-c2#2` (la MISMA complementaria, no `-c3`).
        provider.findByExternalId.mockClear()
        const r = await complementaria(principal.cfdi.id)
        expect(r).toMatchObject({ status: 'STAMPED', complementariaDe: principal.cfdi.id })
        expect(r.cfdi.idempotencyKey).toBe(`${principal.cfdi.idempotencyKey}-c2`)
        expect(provider.findByExternalId).toHaveBeenCalledWith(`${c.idempotencyKey}#1`)
        expect(provider.createGlobalInvoice.mock.calls.slice(-2).map(x => x[0].externalId)).toEqual([
          `${c.idempotencyKey}#1`,
          `${c.idempotencyKey}#2`,
        ])
        expect((r.cfdi.entrada as any).ordenes.map((o: any) => o.orderId)).toEqual([tarde.id])
        expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: 'STAMPED', attempts: 2 })
      })

      it('🔴 dos clics a la vez ⇒ una sola complementaria y un solo envío al PAC', async () => {
        await venta([['CREDIT_CARD', m1, MAYO]])
        provider.createGlobalInvoice.mockImplementation(async () => valid())
        const principal = await global()
        const b = await venta([['CREDIT_CARD', m1, MAYO]]) // llegó tarde al periodo ya timbrado (cobro con fecha de mayo)
        provider.createGlobalInvoice.mockClear()
        // Los dos calculan la llave y eligen candidatos ANTES de que cualquiera reserve (barrera antes de la reserva: al POST sólo llega uno).
        const barrera = barreraDeDos()
        const conBarrera = {
          resolveProvider: () => provider as any,
          loadGlobalCandidates: async (...a: Parameters<typeof loadGlobalCandidates>) => (
            await barrera.esperar(), loadGlobalCandidates(...a)
          ),
        }
        const r = await Promise.allSettled(
          [1, 2].map(() =>
            emitirGlobalComplementaria(
              { venueId, emisorId: fiscalEmisorId, principalId: principal.cfdi.id, now: NOW, sandbox: true },
              conBarrera,
            ),
          ),
        )
        expect(r.some(x => x.status === 'fulfilled' && (x.value as any).status === 'STAMPED')).toBe(true)
        for (const x of r) if (x.status === 'rejected') expect(x.reason).toBeInstanceOf(ConflictError)
        expect(provider.createGlobalInvoice).toHaveBeenCalledTimes(1)
        expect(await prisma.cfdi.count({ where: { fiscalEmisorId, isGlobal: true, idempotencyKey: { endsWith: '-c2' } } })).toBe(1)
        expect(await prisma.cfdiGlobalOrden.count({ where: { orderId: b.id } })).toBe(1)
      })

      it('sin principal timbrada ⇒ error claro, sin reservar', async () => {
        const a = await venta([['CREDIT_CARD', m1, MAYO]])
        const enProceso = await reservaV2SinEnviar([a.id]) // la principal STAMPING sin enviar
        await expect(complementaria(enProceso.id)).rejects.toThrow(/principal/)
        await expect(vistaPrevia(enProceso.id)).rejects.toThrow(/principal/)
        // (`contains: '-c'` del plan también contaría la principal: la llave lleva el id del emisor, un cuid que empieza con «c».)
        expect(
          await prisma.cfdi.count({
            where: { fiscalEmisorId, isGlobal: true, idempotencyKey: { startsWith: `${enProceso.idempotencyKey}-c` } },
          }),
        ).toBe(0)
      })

      it('🔴 una complementaria no es una principal: su complementaria se rechaza', async () => {
        await venta([['CREDIT_CARD', m1, MAYO]])
        provider.createGlobalInvoice.mockImplementation(async () => valid())
        const principal = await global()
        await venta([['CREDIT_CARD', m1, MAYO]])
        const c = await complementaria(principal.cfdi.id)
        expect(c).toMatchObject({ status: 'STAMPED' })
        await expect(complementaria(c.cfdi.id)).rejects.toThrow(/principal/)
      })

      it('🔴 la principal se canceló: la complementaria recoge sus tickets (C3-P7)', async () => {
        const a = await venta([['CREDIT_CARD', m1, MAYO]])
        provider.createGlobalInvoice.mockImplementation(async () => valid())
        const principal = await global()
        await cancelCfdi({ cfdiId: principal.cfdi.id, motivo: '02', sandbox: true, expectedVenueId: venueId }) // confirmada por el PAC
        expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: principal.cfdi.id } })).toMatchObject({ status: 'CANCELLED' })
        expect(await vistaPrevia(principal.cfdi.id)).toMatchObject({
          estadoPrincipal: 'CANCELADA',
          corregidasPendientes: { n: 1, completo: true },
        })
        const c = await complementaria(principal.cfdi.id)
        expect((c.cfdi.entrada as any).ordenes.map((o: any) => o.orderId)).toEqual([a.id])
        expect((c.cfdi.entrada as any).complementariaDe).toBe(principal.cfdi.id)
      })

      it('🔴 C1-29: timeout después del POST ⇒ STAMP_FAILED incierto (enviada, no definitiva); la pasada del job la RECUPERA consultando por su identidad, sin segundo envío', async () => {
        await venta([['CREDIT_CARD', m1, MAYO]])
        provider.createGlobalInvoice.mockImplementation(async () => valid())
        const principal = await global()
        await venta([['CREDIT_CARD', m1, MAYO]])
        provider.createGlobalInvoice.mockClear()
        provider.createGlobalInvoice.mockRejectedValueOnce(new Error('ETIMEDOUT'))
        const r = await complementaria(principal.cfdi.id)
        expect(r.status).toBe('STAMP_FAILED')
        const c2 = await prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: `${principal.cfdi.idempotencyKey}-c2` } })
        expect(c2).toMatchObject({ status: 'STAMP_FAILED', falloDefinitivo: false, enviadoAt: expect.any(Date) })
        timbradaEnElPac(provider, (c2.entrada as any).params)
        await emitirGlobalesPendientes({ emisorId: fiscalEmisorId, now: NOW, sandbox: true }, { resolveProvider: () => provider as any })
        expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: c2.id } })).toMatchObject({
          status: 'STAMPED',
          entrada: expect.objectContaining({ complementariaDe: principal.cfdi.id }),
        })
        expect(provider.createGlobalInvoice).toHaveBeenCalledTimes(1)
      })

      it('🔴 C1-24: una complementaria detenida por cuadre NO la emite el job aunque se corrija el catálogo; la emite la persona', async () => {
        await venta([['CREDIT_CARD', m1, MAYO]])
        provider.createGlobalInvoice.mockImplementation(async () => valid())
        const principal = await global()
        await ordenesDeG8EnBase() // la «falta» de G8 (Tarea 7): no cuadra
        const tarde = await ticketQueHaceCuadrarAG8EnBase({ contratoDePrecio: 'DESCONOCIDO' })
        expect((await complementaria(principal.cfdi.id)).status).toBe('VALIDATION_FAILED')
        await prisma.order.update({ where: { id: tarde.id }, data: { contratoDePrecio: 'IVA_INCLUIDO' } }) // se corrige
        provider.createGlobalInvoice.mockClear()
        const job = await emitirGlobalesPendientes(
          { emisorId: fiscalEmisorId, now: NOW, sandbox: true },
          { resolveProvider: () => provider as any },
        )
        expect(job.resultados).toContainEqual(expect.objectContaining({ status: 'SKIPPED', reason: expect.stringMatching(/una persona/) }))
        expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
        const c = await complementaria(principal.cfdi.id)
        expect(c).toMatchObject({ status: 'STAMPED' })
        expect(c.cfdi.idempotencyKey).toBe(`${principal.cfdi.idempotencyKey}-c2`) // la misma, no `-c3`
      })

      it('🔴 ronda 1 (I1): una principal HEREDADA (sin registro de sus ventas) timbrada no tiene complementaria; una heredada CANCELADA sí', async () => {
        await venta([['CREDIT_CARD', m1, MAYO]]) // documentada por la heredada, pero sin manifiesto que lo diga
        const heredada = await prisma.cfdi.create({
          data: {
            venueId,
            fiscalEmisorId,
            orderId: null,
            flow: 'GLOBAL_C',
            isGlobal: true,
            type: 'INGRESO',
            protocoloIva: null,
            idempotencyKey: `cfdi-global-${fiscalEmisorId}-2026-05-04`,
            globalPeriod: { periodicidad: '04', meses: '05', anio: 2026 },
            status: 'STAMPED',
            uuid: randomUUID(),
            facturapiId: randomUUID(),
            serie: 'F',
            folio: '3',
            stampedAt: new Date('2026-06-01T10:00:00Z'),
            receptorRfc: 'XAXX010101000',
            receptorNombre: 'PÚBLICO EN GENERAL',
            receptorRegimen: '616',
            receptorCp: '01000',
            usoCfdi: 'S01',
            formaPago: '04',
            metodoPago: 'PUE',
            subtotalCents: 10000,
            taxCents: 1600,
            totalCents: 11600,
          },
        })
        const texto = 'Esta factura global es de antes del registro de sus ventas; su complementaria se pide a soporte.'
        await expect(vistaPrevia(heredada.id)).rejects.toThrow(texto)
        await expect(complementaria(heredada.id)).rejects.toThrow(texto)
        expect(await prisma.cfdi.count({ where: { idempotencyKey: { startsWith: `${heredada.idempotencyKey}-c` } } })).toBe(0)
        expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
        // El panel no la ofrece (sin «cuántas entrarían»).
        const { periodos } = await periodosDeLaGlobal({ venueId, emisorId: fiscalEmisorId, now: NOW })
        expect(periodos.find(p => p.cfdiId === heredada.id)).toMatchObject({ estado: 'TIMBRADA', corregidasPendientes: null })
        // Cancelada, sus ventas ya no están documentadas: su complementaria sí procede.
        await prisma.cfdi.update({ where: { id: heredada.id }, data: { status: 'CANCELLED', cancelStatus: 'CANCELLED' } })
        expect(await vistaPrevia(heredada.id)).toMatchObject({
          estadoPrincipal: 'CANCELADA',
          corregidasPendientes: { n: 1, completo: true },
        })
      })

      it('🔴 ronda 1 (m7): una principal con su cancelación en trámite dice que se espere (no «todavía no está timbrada»)', async () => {
        await venta([['CREDIT_CARD', m1, MAYO]])
        provider.createGlobalInvoice.mockImplementation(async () => valid())
        const principal = await global()
        await prisma.cfdi.update({ where: { id: principal.cfdi.id }, data: { status: 'CANCEL_REQUESTED', cancelStatus: 'REQUESTED' } })
        const texto = 'Su cancelación está en trámite ante el SAT; espera a que se resuelva.'
        await expect(vistaPrevia(principal.cfdi.id)).rejects.toThrow(texto)
        await expect(complementaria(principal.cfdi.id)).rejects.toThrow(texto)
      })

      it('🔴 ronda 1 (I4): una complementaria reservada y NUNCA enviada (el envío tronó) cuenta sus ventas y se retoma con la MISMA llave', async () => {
        await venta([['CREDIT_CARD', m1, MAYO]])
        provider.createGlobalInvoice.mockImplementation(async () => valid())
        const principal = await global()
        const tarde = await venta([['CREDIT_CARD', m1, MAYO]])
        await expect(
          emitirGlobalComplementaria(
            { venueId, emisorId: fiscalEmisorId, principalId: principal.cfdi.id, now: NOW, sandbox: true },
            {
              resolveProvider: () => {
                throw new Error('sin proveedor')
              },
            },
          ),
        ).rejects.toThrow('sin proveedor')
        const llave = `${principal.cfdi.idempotencyKey}-c2`
        expect(await prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: llave } })).toMatchObject({
          status: 'STAMPING',
          enviadoAt: null,
        })
        expect(await vistaPrevia(principal.cfdi.id)).toMatchObject({
          corregidasPendientes: { n: 1, completo: true },
          siguienteLlave: llave,
        })
        const { periodos } = await periodosDeLaGlobal({ venueId, emisorId: fiscalEmisorId, now: NOW })
        expect(periodos.find(p => p.cfdiId === principal.cfdi.id)?.corregidasPendientes).toEqual({ n: 1, completo: true })
        const r = await complementaria(principal.cfdi.id)
        expect(r).toMatchObject({ status: 'STAMPED' })
        expect(r.cfdi.idempotencyKey).toBe(llave)
        expect((r.cfdi.entrada as any).ordenes.map((o: any) => o.orderId)).toEqual([tarde.id])
      })

      it('🔴 MCP (vista previa de la PRINCIPAL): el periodo reciente con su estado y cuántas ventas entrarían; uno viejo ⇒ «pídelo a soporte»', async () => {
        await venta([['CREDIT_CARD', m1, MAYO]])
        await venta([['CREDIT_CARD', m1, MAYO]])
        const desde = periodoMayo.periodStart.toISOString()
        expect(await vistaPreviaPrincipal({ venueId, emisorId: fiscalEmisorId, desde, now: NOW })).toEqual({
          periodo: { desde, hasta: periodoMayo.periodEnd.toISOString(), meses: '05', anio: 2026 },
          estado: 'SIN_GLOBAL',
          cfdiId: null,
          ventas: { n: 2, completo: true },
          motivo: null,
        })
        provider.createGlobalInvoice.mockImplementation(async () => valid())
        const principal = await global()
        expect(await vistaPreviaPrincipal({ venueId, emisorId: fiscalEmisorId, desde, now: NOW })).toMatchObject({
          estado: 'TIMBRADA',
          cfdiId: principal.cfdi.id,
          ventas: { n: 0, completo: true },
        })
        await expect(
          vistaPreviaPrincipal({ venueId, emisorId: fiscalEmisorId, desde: '2026-01-01T06:00:00.000Z', now: NOW }),
        ).rejects.toThrow(/soporte/)
      })

      it('🔴 C1-27: 201 candidatos sin global y todos siguen excluidos por contenido ⇒ { n: 0, completo: false } (nunca «200 o más»)', async () => {
        provider.createGlobalInvoice.mockImplementation(async () => valid())
        await venta([['CREDIT_CARD', m1, MAYO]])
        const principal = await global()
        await ventasPorRevisarEnLote(201, MAYO)
        expect((await vistaPrevia(principal.cfdi.id)).corregidasPendientes).toEqual({ n: 0, completo: false })
      })
    })
  })

  describe('C1 · Tarea 8 — ningún periodo se pierde (emisor DIARIO)', () => {
    const emisorId = () => fiscalEmisorId
    beforeAll(async () => {
      await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { globalPeriodicity: 'DIARIO' } })
    })
    afterAll(async () => {
      await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { globalPeriodicity: 'MENSUAL' } })
    })
    /** Renglones sellados por una global. */
    const sellosDe = (cfdiId: string) => prisma.orderItemSelloIva.count({ where: { cfdiId } })
    /** `n` ventas de $116 cobradas con tarjeta del comercio m1 en `fecha`. */
    async function ventasEnLote(n: number, fecha: Date) {
      const ids: string[] = []
      for (let i = 0; i < n; i++) ids.push((await venta([['CREDIT_CARD', m1, fecha]])).id)
      return ids.sort()
    }
    /** El PAC ya tiene la factura (la respuesta se perdió): la consulta por identidad la devuelve. */
    const timbradaEnElPac = (p: typeof provider, enviado: { items: unknown[] }) => {
      expect(enviado.items.length).toBeGreaterThan(0)
      const factura = valid()
      p.findByExternalId.mockResolvedValue(factura)
      p.getInvoice.mockResolvedValue(factura)
    }
    /**
     * Una global DIARIA de antes de C1, con la forma EXACTA de la v1 (protocolo 1, entrada v1 todo al 16 %) y la llave del MES (sin día):
     * su manifiesto y sus sellos. `createdAt` a mano: la fila «nació» un día, pero su día no se puede demostrar (C1-14).
     */
    async function reservaV1Diaria(o: {
      llave: string
      createdAt: Date
      orderIds: string[]
      status: string
      enviadoAt?: Date | null
      meses?: string
    }) {
      const meses = o.meses ?? '10'
      const ordenes = await prisma.order.findMany({
        where: { id: { in: o.orderIds } },
        orderBy: { id: 'asc' },
        take: o.orderIds.length,
        select: { id: true, total: true, items: { select: { id: true }, take: 10 } },
      })
      const conRenglones = ordenes.map(x => ({
        ...x,
        renglones: x.items.map(i => ({ orderItemId: i.id, tratamiento: 'IVA_16' as const })),
      }))
      const items = conRenglones.map(x => ({
        satProductKey: '01010101',
        satUnitKey: 'ACT',
        description: 'Venta',
        quantity: 1,
        unitPriceCents: Math.round(Number(x.total) * 100),
        discountCents: 0,
        objetoImp: '02',
        taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
        taxIncluded: true,
      }))
      const totalCents = items.reduce((s, i) => s + i.unitPriceCents, 0)
      const subtotalCents = items.reduce((s, i) => s + Math.round(i.unitPriceCents / 1.16), 0)
      const entrada = {
        version: 1,
        tipo: 'GLOBAL',
        fiscalEmisorId,
        globalPeriod: { periodicidad: '01', meses, anio: 2026 },
        montos: { subtotalCents, taxCents: totalCents - subtotalCents, totalCents },
        excluidasPorIvaMixto: 0,
        ordenes: conRenglones.map(x => ({ orderId: x.id, huella: huellaDeEntrada({ renglones: x.renglones }), renglones: x.renglones })),
        params: {
          receptor: { legal_name: 'PÚBLICO EN GENERAL', tax_id: 'XAXX010101000', tax_system: '616', address: { zip: '01000' } },
          items,
          payment_form: '04',
          use: 'S01',
          global: { periodicity: 'day', months: meses, year: 2026 },
        },
      }
      return prisma.$transaction(
        async tx => {
          const c = await tx.cfdi.create({
            data: {
              venueId,
              fiscalEmisorId,
              orderId: null,
              flow: 'GLOBAL_C',
              idempotencyKey: o.llave,
              isGlobal: true,
              globalPeriod: entrada.globalPeriod,
              type: 'INGRESO',
              receptorRfc: 'XAXX010101000',
              receptorNombre: 'PÚBLICO EN GENERAL',
              receptorRegimen: '616',
              receptorCp: '01000',
              usoCfdi: 'S01',
              formaPago: '04',
              metodoPago: 'PUE',
              ...entrada.montos,
              status: o.status,
              protocoloIva: 1,
              entrada,
              entradaHuella: huellaDeEntrada(entrada),
              attempts: 1,
              enviadoAt: o.enviadoAt ?? null,
              createdAt: o.createdAt,
              ...(o.status === 'STAMPED' ? { uuid: randomUUID(), facturapiId: randomUUID(), folio: '1' } : {}),
            } as any,
          })
          for (let at = 0; at < conRenglones.length; at += 100) {
            const page = conRenglones.slice(at, at + 100)
            await tx.cfdiGlobalOrden.createMany({
              data: page.map(x => ({ cfdiId: c.id, orderId: x.id, huella: huellaDeEntrada({ renglones: x.renglones }) })),
            })
            await sellarRenglones(tx, { cfdiId: c.id, intento: 1, renglones: page.flatMap(x => x.renglones) })
          }
          return c
        },
        { timeout: 60_000 },
      )
    }

    it('🔴 la global de un día falla ANTES de reservar; al día siguiente el job emite ese día y el nuevo', async () => {
      const lunes = await venta([['CREDIT_CARD', m1, new Date('2026-10-05T18:00:00Z')]])
      const martes = await venta([['CREDIT_CARD', m1, new Date('2026-10-06T18:00:00Z')]])
      const caida = jest.fn().mockRejectedValueOnce(new Error('se cayó la base'))
      await expect(
        issueGlobalForEmisor(
          { emisorId: emisorId(), now: new Date('2026-10-06T09:00:00Z'), sandbox: true },
          { loadGlobalCandidates: caida, resolveProvider: () => provider as any },
        ),
      ).rejects.toThrow()
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      const { resultados } = await emitirGlobalesPendientes(
        { emisorId: emisorId(), now: new Date('2026-10-07T09:00:00Z'), sandbox: true },
        { resolveProvider: () => provider as any },
      )
      const enGlobal = await prisma.cfdiGlobalOrden.findMany({
        where: { orderId: { in: [lunes.id, martes.id] } },
        select: { orderId: true },
        take: 10,
      })
      expect(enGlobal.map(x => x.orderId).sort()).toEqual([lunes.id, martes.id].sort())
      expect(resultados.filter(x => x.status === 'STAMPED')).toHaveLength(2)
    })

    it('🔴 C1-14: fila diaria con la LLAVE VIEJA reservada y nunca enviada ⇒ se anula sin enviar y su ticket entra en la global del día de su cobro', async () => {
      const v = await venta([['CREDIT_CARD', m1, new Date('2026-10-03T18:00:00Z')]]) // el 3, aunque la fila «nació» el 2
      const vieja = await reservaV1Diaria({
        llave: `cfdi-global-${emisorId()}-2026-10-01`,
        createdAt: new Date('2026-10-02T09:15:00Z'),
        orderIds: [v.id],
        status: 'STAMPING',
        enviadoAt: null,
      })
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      const { resultados } = await emitirGlobalesPendientes(
        { emisorId: emisorId(), now: new Date('2026-10-05T09:00:00Z'), sandbox: true },
        { resolveProvider: () => provider as any },
      )
      expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: vieja.id } })).toMatchObject({
        status: 'STAMP_FAILED',
        falloDefinitivo: true,
        enviadoAt: null,
        lastError: MOTIVO_FILA_VIEJA_ANULADA,
      })
      expect(resultados).toContainEqual(expect.objectContaining({ reasons: [MOTIVO_FILA_VIEJA_ANULADA] }))
      const enviados = provider.createGlobalInvoice.mock.calls.map(c => c[0].externalId as string)
      expect(enviados).not.toContain(vieja.idempotencyKey)
      expect(enviados.filter(x => x.startsWith(`${vieja.idempotencyKey}#`))).toEqual([])
      const suya = await prisma.cfdiGlobalOrden.findFirstOrThrow({ where: { orderId: v.id }, include: { cfdi: true } })
      expect(suya.cfdi.idempotencyKey).toBe(`cfdi-global-${emisorId()}-2026-10-01-20261003`)
      expect(suya.cfdi.status).toBe('STAMPED')
      expect(await sellosDe(vieja.id)).toBe(0)
      // La anulación deja rastro (una fila con dinero que cambió de destino).
      expect(await prisma.activityLog.count({ where: { venueId, entityId: vieja.id, action: 'CFDI_GLOBAL_VIEJA_ANULADA' } })).toBe(1)
      // Ronda 1 (I2): su venta está DENTRO de la ventana: nada quedó fuera.
      expect(
        (await prisma.activityLog.findFirstOrThrow({ where: { venueId, entityId: vieja.id, action: 'CFDI_GLOBAL_VIEJA_ANULADA' } })).data,
      ).toMatchObject({ desde: '2026-10-03', hasta: '2026-10-03', fueraDeVentana: 0 })
    })

    it('🔴 C1-42 + decisión A: el filtro del job descarta lo que no tiene salida (la anulada sin enviar y la vieja corta rechazada) y toma la ENVIADA rechazada y la incierta', async () => {
      const fila = async (dia: number, enviadoAt: Date | null, falloDefinitivo: boolean) => {
        const v = await venta([['CREDIT_CARD', m1, new Date(`2026-10-0${dia}T18:00:00Z`)]])
        const f = await reservaV1Diaria({
          llave: `cfdi-global-${emisorId()}-2026-10-01-x${dia}`,
          createdAt: new Date(`2026-10-0${dia}T09:15:00Z`),
          orderIds: [v.id],
          status: 'STAMP_FAILED',
          enviadoAt,
        })
        await prisma.cfdi.update({ where: { id: f.id }, data: { falloDefinitivo } })
        return f.id
      }
      const anulada = await fila(1, null, true)
      const rechazada = await fila(2, new Date('2026-10-02T09:16:00Z'), true)
      const incierta = await fila(3, new Date('2026-10-03T09:16:00Z'), false)
      // Una vieja corta (la llave del MES, sin día) ENVIADA y rechazada: su periodo no se puede demostrar y sus ventas ya están libres.
      const v = await venta([['CREDIT_CARD', m1, new Date('2026-10-04T18:00:00Z')]])
      const viejaCorta = await reservaV1Diaria({
        llave: `cfdi-global-${emisorId()}-2026-10-01`,
        createdAt: new Date('2026-10-04T09:15:00Z'),
        orderIds: [v.id],
        status: 'STAMP_FAILED',
        enviadoAt: new Date('2026-10-04T09:16:00Z'),
      })
      await prisma.cfdi.update({ where: { id: viejaCorta.id }, data: { falloDefinitivo: true } })
      const ids = (await globalesSinTimbrar(emisorId(), null)).map((f: any) => f.id)
      expect(ids).toContain(incierta)
      expect(ids).toContain(rechazada)
      expect(ids).not.toContain(anulada)
      expect(ids).not.toContain(viejaCorta.id)
    })

    it('el filtro del job: sólo globales de INGRESO de ESTE emisor sin timbrar, en páginas de 10 por (updatedAt, id)', async () => {
      const ventas = await ventasEnLote(12, new Date('2026-10-01T18:00:00Z'))
      const filas: string[] = []
      for (let i = 0; i < 12; i++)
        filas.push(
          (
            await reservaV1Diaria({
              llave: `cfdi-global-${emisorId()}-pagina-${String(i).padStart(2, '0')}`,
              createdAt: new Date('2026-10-02T09:15:00Z'),
              orderIds: [ventas[i]],
              status: i === 11 ? 'STAMPED' : 'STAMPING',
            })
          ).id,
        )
      const p1 = await globalesSinTimbrar(emisorId(), null)
      expect(p1).toHaveLength(10)
      const ultima = p1[9]
      const p2 = await globalesSinTimbrar(emisorId(), { updatedAt: ultima.updatedAt, id: ultima.id })
      expect(p2).toHaveLength(1) // la 11.ª; la timbrada no
      expect(new Set([...p1, ...p2].map((f: any) => f.id))).toEqual(new Set(filas.slice(0, 11)))
      expect(await globalesSinTimbrar('otro-emisor', null)).toEqual([])
    })

    it('fila vieja diaria ENVIADA e incierta que el PAC sí tiene ⇒ se termina por su identidad, sin recapturar', async () => {
      const v = await venta([['CREDIT_CARD', m1, new Date('2026-10-01T18:00:00Z')]])
      const vieja = await reservaV1Diaria({
        llave: `cfdi-global-${emisorId()}-2026-10-01`,
        createdAt: new Date('2026-10-02T09:15:00Z'),
        orderIds: [v.id],
        status: 'STAMP_FAILED',
        enviadoAt: new Date('2026-10-02T09:16:00Z'),
      })
      timbradaEnElPac(provider, (vieja.entrada as any).params)
      await emitirGlobalesPendientes(
        { emisorId: emisorId(), now: new Date('2026-10-05T09:00:00Z'), sandbox: true },
        { resolveProvider: () => provider as any },
      )
      expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: vieja.id } })).toMatchObject({ status: 'STAMPED', attempts: 1 })
      // La identidad de un intento protocolo 1 ante el PAC es `llave#intento` (cfdi.service.ts, `consultarIntentoCapturado`).
      expect(provider.findByExternalId).toHaveBeenCalledWith(`cfdi-global-${emisorId()}-2026-10-01#1`)
      expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
      expect(await prisma.cfdiGlobalOrden.count({ where: { cfdiId: vieja.id } })).toBe(1)
    })

    it('control — 🔴 C1-22: el barrido leyó la fila vieja SIN enviar y el emisor la marcó enviada antes de anular ⇒ la anulación pierde; sellos y manifiesto intactos', async () => {
      const v = await venta([['CREDIT_CARD', m1, new Date('2026-10-03T18:00:00Z')]])
      const vieja = await reservaV1Diaria({
        llave: `cfdi-global-${emisorId()}-2026-10-01`,
        createdAt: new Date('2026-10-02T09:15:00Z'),
        orderIds: [v.id],
        status: 'STAMPING',
        enviadoAt: null,
      })
      const leida = await prisma.cfdi.findUniqueOrThrow({ where: { id: vieja.id } }) // lo que vio el barrido
      await prisma.cfdi.updateMany({
        where: { id: vieja.id, status: 'STAMPING', attempts: leida.attempts, enviadoAt: null },
        data: { enviadoAt: new Date() },
      }) // el CAS del motor
      // Ola final (N4 de la T8): con reloj FIJO; con el real, en unos días sus ventas caerían «fuera de la ventana» y dejarían un `logger.error`.
      expect(await anularFilaVieja(leida, new Date('2026-10-05T09:00:00Z'))).toBe('PERDIDA')
      expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: vieja.id } })).toMatchObject({
        status: 'STAMPING',
        enviadoAt: expect.any(Date),
        falloDefinitivo: false,
      })
      expect(await prisma.cfdiGlobalOrden.count({ where: { cfdiId: vieja.id } })).toBe(1)
      expect(await sellosDe(vieja.id)).toBeGreaterThan(0)
      expect(await prisma.activityLog.count({ where: { venueId, action: 'CFDI_GLOBAL_VIEJA_ANULADA' } })).toBe(0)
    })

    it('🔴 C1-22: fila vieja ENVIADA que el PAC no tiene ⇒ se queda reservada (nunca se libera por reloj) y la pasada dice «en recuperación»', async () => {
      const v = await venta([['CREDIT_CARD', m1, new Date('2026-10-01T18:00:00Z')]])
      const vieja = await reservaV1Diaria({
        llave: `cfdi-global-${emisorId()}-2026-10-01`,
        createdAt: new Date('2026-10-02T09:15:00Z'),
        orderIds: [v.id],
        status: 'STAMP_FAILED',
        enviadoAt: new Date('2026-09-02T09:16:00Z'), // hace un mes
      })
      provider.findByExternalId.mockResolvedValue(null)
      const { resultados } = await emitirGlobalesPendientes(
        { emisorId: emisorId(), now: new Date('2026-10-05T09:00:00Z'), sandbox: true },
        { resolveProvider: () => provider as any },
      )
      expect(resultados).toContainEqual(expect.objectContaining({ status: 'SKIPPED', reason: expect.stringMatching(/recuperación/) }))
      expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: vieja.id } })).toMatchObject({
        status: 'STAMP_FAILED',
        falloDefinitivo: false,
      })
      expect(await prisma.cfdiGlobalOrden.count({ where: { cfdiId: vieja.id } })).toBe(1)
      expect(await sellosDe(vieja.id)).toBeGreaterThan(0)
      expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
    })

    it('🔴 C1-26: una fila vieja con 250 órdenes en el manifiesto se anula entera: las 250 bajo candado y las 250 liberadas', async () => {
      const ids = await ventasEnLote(250, new Date('2026-10-03T18:00:00Z'))
      const vieja = await reservaV1Diaria({
        llave: `cfdi-global-${emisorId()}-2026-10-01`,
        createdAt: new Date('2026-10-02T09:15:00Z'),
        orderIds: ids,
        status: 'STAMPING',
        enviadoAt: null,
      })
      expect(await prisma.cfdiGlobalOrden.count({ where: { cfdiId: vieja.id } })).toBe(250)
      const bloqueadas = jest.spyOn(admisionIva, 'bloquearOrdenesParaFacturar')
      // Ola final (N4 de la T8): con reloj FIJO (ver arriba).
      expect(
        await anularFilaVieja(await prisma.cfdi.findUniqueOrThrow({ where: { id: vieja.id } }), new Date('2026-10-05T09:00:00Z')),
      ).toBe('ANULADA')
      expect(bloqueadas).toHaveBeenCalledTimes(1)
      expect([...bloqueadas.mock.calls[0][1]].sort()).toEqual(ids)
      expect(await prisma.cfdiGlobalOrden.count({ where: { cfdiId: vieja.id } })).toBe(0)
      expect(await sellosDe(vieja.id)).toBe(0)
      expect(await prisma.orderItem.count({ where: { orderId: { in: ids }, ivaTratamiento: { not: null } } })).toBe(0)
    }, 120_000)

    it('control — fila vieja STAMPED: no se toca; sus tickets no se vuelven a facturar', async () => {
      const v = await venta([['CREDIT_CARD', m1, new Date('2026-10-01T18:00:00Z')]])
      const vieja = await reservaV1Diaria({
        llave: `cfdi-global-${emisorId()}-2026-10-01`,
        createdAt: new Date('2026-10-02T09:15:00Z'),
        orderIds: [v.id],
        status: 'STAMPED',
      })
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      await emitirGlobalesPendientes(
        { emisorId: emisorId(), now: new Date('2026-10-05T09:00:00Z'), sandbox: true },
        { resolveProvider: () => provider as any },
      )
      expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: vieja.id } })).toMatchObject({
        status: 'STAMPED',
        updatedAt: vieja.updatedAt,
      })
      expect(await prisma.cfdiGlobalOrden.count({ where: { orderId: v.id } })).toBe(1)
      expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
    })

    it('🔴 un diario de hace 3 días, sin fila, se emite a mano con `desde`; uno de hace 8 (fuera de la ventana) dice «pídelo a soporte» (C1-P16 = B)', async () => {
      const ahora = new Date('2026-10-12T09:00:00Z')
      const ps = periodosCerradosRecientes('DIARIO', ahora, 8)
      expect(ps).toHaveLength(8)
      const v = await venta([['CREDIT_CARD', m1, new Date(ps[2].periodStart.getTime() + 18 * 3_600_000)]])
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      expect(
        (
          await issueGlobalForEmisor(
            { emisorId: emisorId(), now: ahora, sandbox: true, desde: ps[2].periodStart.toISOString() },
            { resolveProvider: () => provider as any },
          )
        ).status,
      ).toBe('STAMPED')
      expect(await prisma.cfdiGlobalOrden.count({ where: { orderId: v.id } })).toBe(1)
      await expect(
        issueGlobalForEmisor({ emisorId: emisorId(), now: ahora, sandbox: true, desde: ps[7].periodStart.toISOString() }),
      ).rejects.toThrow(/soporte/)
      await expect(
        issueGlobalForEmisor({
          emisorId: emisorId(),
          now: ahora,
          sandbox: true,
          desde: new Date(ps[2].periodStart.getTime() + 1).toISOString(),
        }),
      ).rejects.toThrow(/soporte/)
    })

    it('🔴 re-revisión T7 (a): una reserva NUNCA enviada (`enviadoAt: null`) se recaptura SIN preguntarle al PAC, aunque el PAC esté caído', async () => {
      const ahora = new Date('2026-10-05T09:00:00Z')
      await venta([['CREDIT_CARD', m1, new Date('2026-10-04T18:00:00Z')]])
      await expect(
        issueGlobalForEmisor(
          { emisorId: emisorId(), now: ahora, sandbox: true },
          {
            resolveProvider: () => {
              throw new Error('sin proveedor')
            },
          },
        ),
      ).rejects.toThrow('sin proveedor')
      const reserva = await prisma.cfdi.findFirstOrThrow({ where: { venueId, isGlobal: true } })
      expect(reserva).toMatchObject({ status: 'STAMPING', enviadoAt: null, attempts: 1 })
      provider.findByExternalId.mockRejectedValue(new Error('PAC caído'))
      provider.getInvoice.mockRejectedValue(new Error('PAC caído'))
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      await expect(
        issueGlobalForEmisor({ emisorId: emisorId(), now: ahora, sandbox: true }, { resolveProvider: () => provider as any }),
      ).resolves.toMatchObject({ status: 'STAMPED' })
      expect(provider.findByExternalId).not.toHaveBeenCalled()
      expect(provider.getInvoice).not.toHaveBeenCalled()
      expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: reserva.id } })).toMatchObject({ status: 'STAMPED', attempts: 2 })
    })

    it('🔴 re-revisión T7 (b): un periodo DETENIDO (un cobro con forma SAT malformada hace lanzar su captura) no frena al periodo siguiente', async () => {
      const raro = await venta([['CREDIT_CARD', m1, new Date('2026-10-03T18:00:00Z')]])
      await prisma.payment.updateMany({ where: { orderId: raro.id }, data: { tenderSatFormaPago: '4' } })
      const sano = await venta([['CREDIT_CARD', m1, new Date('2026-10-04T18:00:00Z')]])
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      const { resultados } = await emitirGlobalesPendientes(
        { emisorId: emisorId(), now: new Date('2026-10-05T09:00:00Z'), sandbox: true },
        { resolveProvider: () => provider as any },
      )
      const dia = (iso: string) => resultados.find(r => r.period?.periodStart.toISOString() === iso)
      // Ronda 1 (I1): «revisión de soporte» no es «en proceso»: DETENIDO, y deja rastro en la base.
      expect(dia('2026-10-03T06:00:00.000Z')).toMatchObject({ status: 'DETENIDO', reason: expect.stringMatching(/soporte/) })
      expect(dia('2026-10-04T06:00:00.000Z')).toMatchObject({ status: 'STAMPED' })
      expect(await prisma.cfdiGlobalOrden.count({ where: { orderId: sano.id } })).toBe(1)
      expect(await prisma.cfdiGlobalOrden.count({ where: { orderId: raro.id } })).toBe(0)
      const avisos = () =>
        prisma.activityLog.findMany({
          where: { venueId, entityId: emisorId(), action: 'CFDI_GLOBAL_PERIODO_DETENIDO' },
          take: 10,
          select: { data: true },
        })
      expect((await avisos()).map(a => a.data)).toEqual([
        expect.objectContaining({ desde: '2026-10-03T06:00:00.000Z', periodicidad: '01', motivo: expect.stringMatching(/soporte/) }),
      ])
      // Otra pasada con el mismo motivo: no se repite el aviso.
      await emitirGlobalesPendientes(
        { emisorId: emisorId(), now: new Date('2026-10-05T09:00:00Z'), sandbox: true },
        { resolveProvider: () => provider as any },
      )
      expect(await avisos()).toHaveLength(1)
      // El panel lo muestra como motivo del día sin global.
      const { periodos } = await periodosDeLaGlobal({ venueId, emisorId: emisorId(), now: new Date('2026-10-05T09:00:00Z') })
      expect(periodos.find(p => p.desde === '2026-10-03T06:00:00.000Z')).toMatchObject({
        estado: 'SIN_GLOBAL',
        motivo: expect.stringMatching(/soporte/),
      })
    })

    it('🔴 ronda 1 (I1 c): un día SIN global que acaba de salir de la ventana y aún tiene ventas ⇒ aviso «pídelo a soporte» en la base, una sola vez; nunca se emite', async () => {
      const v = await venta([['CREDIT_CARD', m1, new Date('2026-10-03T18:00:00Z')]]) // el 12-oct la ventana es del 5 al 11: el 3 ya salió (es de los 3 que se vigilan al salir)
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      const pasada = () =>
        emitirGlobalesPendientes(
          { emisorId: emisorId(), now: new Date('2026-10-12T09:00:00Z'), sandbox: true },
          { resolveProvider: () => provider as any },
        )
      const { resultados } = await pasada()
      expect(resultados).toContainEqual(expect.objectContaining({ status: 'DETENIDO', reason: MOTIVO_PERIODO_FUERA_DE_VENTANA }))
      await pasada()
      const avisos = await prisma.activityLog.findMany({
        where: { venueId, entityId: emisorId(), action: 'CFDI_GLOBAL_PERIODO_FUERA_DE_VENTANA' },
        take: 10,
        select: { data: true },
      })
      expect(avisos.map(a => a.data)).toEqual([
        expect.objectContaining({ desde: '2026-10-03T06:00:00.000Z', motivo: MOTIVO_PERIODO_FUERA_DE_VENTANA }),
      ])
      expect(await prisma.cfdiGlobalOrden.count({ where: { orderId: v.id } })).toBe(0)
      expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
    })

    it('🔴 ronda 1 (I2): una fila vieja de SEPTIEMBRE anulada el 9-oct dice la verdad: sus ventas quedaron libres FUERA de la ventana (con fechas), y avisa', async () => {
      const error = jest.spyOn(logger, 'error')
      const v = await venta([['CREDIT_CARD', m1, new Date('2026-09-29T18:00:00Z')]])
      const vieja = await reservaV1Diaria({
        llave: `cfdi-global-${emisorId()}-2026-09-01`,
        createdAt: new Date('2026-09-30T09:15:00Z'),
        orderIds: [v.id],
        status: 'STAMPING',
        enviadoAt: null,
        meses: '09',
      })
      await emitirGlobalesPendientes(
        { emisorId: emisorId(), now: new Date('2026-10-09T09:00:00Z'), sandbox: true },
        { resolveProvider: () => provider as any },
      )
      const fila = await prisma.cfdi.findUniqueOrThrow({ where: { id: vieja.id } })
      expect(fila).toMatchObject({ status: 'STAMP_FAILED', falloDefinitivo: true, enviadoAt: null })
      expect(fila.lastError).not.toBe(MOTIVO_FILA_VIEJA_ANULADA)
      expect(fila.lastError).toMatch(/29\/09\/2026 al 29\/09\/2026/)
      expect(fila.lastError).toMatch(/pídelo a soporte/)
      expect(
        (await prisma.activityLog.findFirstOrThrow({ where: { venueId, entityId: vieja.id, action: 'CFDI_GLOBAL_VIEJA_ANULADA' } })).data,
      ).toMatchObject({ desde: '2026-09-29', hasta: '2026-09-29', fueraDeVentana: 1, fueraDesde: '2026-09-29', fueraHasta: '2026-09-29' })
      expect(error.mock.calls.filter(c => String(c[0]).includes(vieja.id))).toHaveLength(1)
      expect(await prisma.cfdiGlobalOrden.count({ where: { orderId: v.id } })).toBe(0) // libre, pero ningún periodo revisado la recoge
    })

    it('🔴 ronda 1 (m1): 11 filas que su intento no cambia y un REINICIO entre pasadas (cursor en null) ⇒ la 11.ª se procesa en la pasada siguiente', async () => {
      const ventas = await ventasEnLote(11, new Date('2026-10-01T18:00:00Z'))
      const ids: string[] = []
      for (let i = 0; i < 11; i++)
        ids.push(
          (
            await reservaV1Diaria({
              // Llave que no es la del mes ni la nueva: su periodo no se puede demostrar; el intento sólo la reporta (no la escribe).
              llave: `cfdi-global-${emisorId()}-cola-${String(i).padStart(2, '0')}`,
              createdAt: new Date('2026-10-02T09:15:00Z'),
              orderIds: [ventas[i]],
              status: 'STAMPING',
            })
          ).id,
        )
      const procesadas = async () =>
        (
          await emitirGlobalesPendientes(
            { emisorId: emisorId(), now: new Date('2026-10-05T09:00:00Z'), sandbox: true, cursor: null },
            { resolveProvider: () => provider as any },
          )
        ).resultados
          .filter(r => r.reasons?.includes(MOTIVO_PERIODO_SIN_DEMOSTRAR))
          .map(r => r.cfdi.id)
      const dia1 = await procesadas()
      expect(dia1).toHaveLength(10)
      const dia2 = await procesadas() // el job se reinició: su cursor en memoria volvió a null
      expect(dia2).toContain(ids.find(id => !dia1.includes(id)))
    })
  })

  // ── C1 · Tarea 12: el listado de las ventas que no entraron (filas y total con el MISMO predicado; la estadística de la captura, aparte) ──
  describe('C1 · Tarea 12 — el listado de las ventas que no entraron a la global', () => {
    const emisorGlobal = async () =>
      (await prisma.fiscalEmisor.findUniqueOrThrow({ where: { id: fiscalEmisorId } })) as unknown as GlobalEmisor
    const listar = (extra: Partial<Parameters<typeof listarExcluidasDeLaGlobal>[0]> = {}) =>
      listarExcluidasDeLaGlobal({ venueId, emisorId: fiscalEmisorId, now: NOW, ...extra })
    const motivos = (r: { excluidas: Array<{ orderId: string; motivo: string }> }) => r.excluidas.map(x => [x.orderId, x.motivo])
    const comerciosDeLaPrueba: string[] = []
    afterEach(async () => {
      if (comerciosDeLaPrueba.length) await borrar(comerciosDeLaPrueba.splice(0), [])
      await prisma.fiscalEmisor.update({
        where: { id: fiscalEmisorId },
        data: { invoiceCashSales: true, includeOffTerminalSalesInGlobal: false, globalPeriodicity: 'MENSUAL' },
      })
      await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { includeInGlobal: true } })
    })
    /** Un producto propio con el IVA por revisar (objeto 04); `p0` es compartido y el trigger no deja mandar `objetoImp` con el enum. */
    async function productoPorRevisar() {
      const sufijo = randomUUID().slice(0, 8)
      return prisma.product.create({
        data: {
          venueId,
          categoryId: (await prisma.product.findUniqueOrThrow({ where: { id: p0 } })).categoryId,
          name: `${fixture}-rev12-${sufijo}`,
          sku: `${fixture}-rev12-${sufijo}`,
          price: 200,
          ivaTratamiento: 'BLOQUEADO_04',
          objetoImp: '04',
        },
      })
    }
    const corregir = (productId: string) => prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } }) // el enum manda
    const emisorConPeriodicidad = (globalPeriodicity: 'DIARIO' | 'MENSUAL') =>
      prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { globalPeriodicity } })
    /** Una nota de extracción (C3) de una venta sobre una global, como la deja C3: EGRESO `cfdi-extraccion-<global>-<orden>`. */
    const extraccionDe = (orderId: string, globalId: string, extra: Record<string, unknown>) =>
      prisma.cfdi.create({
        data: {
          venueId,
          fiscalEmisorId,
          orderId,
          flow: 'STAFF_B',
          type: 'EGRESO',
          protocoloIva: 1,
          idempotencyKey: `${PREFIJO_EXTRACCION}${globalId}-${orderId}`,
          receptorRfc: 'EKU9003173C9',
          receptorNombre: 'ESCUELA KEMPER URGATE',
          receptorRegimen: '601',
          receptorCp: '64000',
          usoCfdi: 'G02',
          formaPago: '04',
          metodoPago: 'PUE',
          subtotalCents: 10000,
          taxCents: 1600,
          totalCents: 11600,
          ...extra,
        } as any,
      })
    const extraccionTimbradaDe = (orderId: string, globalId: string) =>
      extraccionDe(orderId, globalId, { status: 'STAMPED', uuid: randomUUID() })
    const extraccionNoTimbradaDe = (orderId: string, globalId: string) => extraccionDe(orderId, globalId, { status: 'VALIDATION_FAILED' })
    /** La extracción se cancela con la confirmación del SAT: ya no es `CFDI_VIVO`. */
    const cancelarExtraccionConfirmada = (id: string) =>
      prisma.cfdi.update({ where: { id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    /** La global se cancela por fuera, confirmada por el SAT (como la deja la sincronización). */
    const cancelarGlobalConfirmada = (id: string) =>
      prisma.cfdi.update({ where: { id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    /** Una venta de $116 por cobro con `n` cobros con tarjeta de m1; el último en efectivo si se pide. */
    async function ventaConCobros(n: number, o: { ultimoEnEfectivo: boolean }) {
      const cobros: Cobro[] = Array.from({ length: n }, (_, i) =>
        o.ultimoEnEfectivo && i === n - 1 ? ['CASH', null, MAYO] : ['CREDIT_CARD', m1, new Date(MAYO.getTime() - (n - i) * 1000)],
      )
      const v = await venta(cobros, [{ productId: p16, precio: 116 * n }])
      return { id: v.id, cobradoCents: Math.round(v.payments.reduce((s, p) => s + Number(p.amount), 0) * 100) }
    }
    /** `n` ventas de $116 con tarjeta de m1 cobradas en `fecha` (createMany: tres consultas, no 3n). */
    async function ventasEnLote(n: number, fecha: Date) {
      const ids = Array.from({ length: n }, () => `${fixture}-l12-${randomUUID()}`)
      await prisma.order.createMany({
        data: ids.map(id => ({
          id,
          venueId,
          orderNumber: id,
          subtotal: 116,
          taxAmount: 0,
          total: 116,
          paymentStatus: 'PAID' as const,
          contratoDePrecio: 'IVA_INCLUIDO' as const,
        })),
      })
      await prisma.orderItem.createMany({
        data: ids.map(orderId => ({
          orderId,
          productId: p16,
          productName: 'Producto',
          quantity: 1,
          unitPrice: 116,
          taxAmount: 0,
          total: 116,
        })),
      })
      await prisma.payment.createMany({
        data: ids.map(orderId => ({
          orderId,
          venueId,
          merchantAccountId: m1,
          amount: 116,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: 116,
          method: 'CREDIT_CARD' as const,
          status: 'COMPLETED' as const,
          createdAt: fecha,
        })),
      })
      return ids
    }

    it('🔴 C1-18: ANTES de capturar, las excluidas por contenido salen en las filas Y en el total; las que entrarán no salen', async () => {
      const px = await productoPorRevisar()
      await venta([['CREDIT_CARD', m1, MAYO]]) // entrará a la principal: no se lista
      const porRevisar = await venta([['CREDIT_CARD', m1, MAYO]], [{ productId: px.id, precio: 200 }])
      const r = await listar()
      expect(r.estadoDelPeriodo).toBe('SIN_GLOBAL')
      expect(r.periodo).toEqual({ meses: '05', anio: 2026, desde: periodoMayo.periodStart, hasta: periodoMayo.periodEnd })
      expect(motivos(r)).toEqual([[porRevisar.id, 'PRODUCTO_POR_REVISAR']])
      expect(r.totales).toEqual({ porMotivo: { PRODUCTO_POR_REVISAR: 1 }, total: 1, completo: true, revisadas: 2 })
      expect(r.corregidasPendientes).toBeNull() // ola final (m6 de la T12): sin principal no hay complementaria
      expect(r.ultimaCaptura).toBeNull()
      // Re-revisión de la T6: el `detalle` de `ticketParaGlobal` (nombra el producto), el texto del motivo y el folio de la venta.
      expect(r.excluidas[0]).toEqual({
        orderId: porRevisar.id,
        folio: porRevisar.orderNumber,
        cobradoCents: 20000,
        motivo: 'PRODUCTO_POR_REVISAR',
        texto: TEXTO_EXCLUSION_GLOBAL.PRODUCTO_POR_REVISAR,
        detalle: `${TEXTO_EXCLUSION_GLOBAL.PRODUCTO_POR_REVISAR} («Producto»)`,
      })
    })

    it('🔴 C1-18: después de timbrar y corregir, el total ya no cuenta la exclusión vieja; la corregida cuenta como pendiente; la captura se reporta aparte', async () => {
      const px = await productoPorRevisar()
      const dentro = await venta([['CREDIT_CARD', m1, MAYO]])
      const fuera = await venta([['CREDIT_CARD', m1, MAYO]], [{ productId: px.id, precio: 200 }])
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      const principal = await global()
      await corregir(px.id)
      const r = await listar()
      expect(r.estadoDelPeriodo).toBe('TIMBRADA')
      expect(motivos(r)).toEqual([[fuera.id, 'CORREGIDA_DESPUES']])
      expect(r.excluidas.some(x => x.orderId === dentro.id)).toBe(false)
      expect(r.totales).toMatchObject({ porMotivo: { CORREGIDA_DESPUES: 1 }, total: 1, completo: true })
      expect(r.corregidasPendientes).toEqual({ n: 1, completo: true })
      expect(r.ultimaCaptura).toEqual({ al: expect.any(Date), excluidas: { PRODUCTO_POR_REVISAR: 1 } })
      // Dice lo mismo que la vista previa de la complementaria (la que el botón emitiría).
      const vista = await vistaPreviaComplementaria({ venueId, emisorId: fiscalEmisorId, principalId: principal.cfdi.id, now: NOW })
      expect(r.corregidasPendientes).toEqual(vista.corregidasPendientes)
    })

    it('🔴 ola final (m5 de la T12): `ultimaCaptura.al` es el momento de la CAPTURA (lo guarda la entrada), no el `updatedAt` de la fila', async () => {
      const px = await productoPorRevisar()
      await venta([['CREDIT_CARD', m1, MAYO]])
      await venta([['CREDIT_CARD', m1, MAYO]], [{ productId: px.id, precio: 200 }])
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      const antes = Date.now()
      const principal = await global()
      const despues = Date.now()
      // Después la fila se escribe por otras razones (la cola la mueve, una cancelación…): su `updatedAt` ya no es el de la captura.
      await prisma.cfdi.update({ where: { id: principal.cfdi.id }, data: { updatedAt: new Date('2030-01-01T00:00:00Z') } })
      const r = await listar()
      expect(r.ultimaCaptura).toEqual({ al: expect.any(Date), excluidas: { PRODUCTO_POR_REVISAR: 1 } })
      const al = r.ultimaCaptura!.al.getTime()
      expect(al).toBeGreaterThanOrEqual(antes)
      expect(al).toBeLessThanOrEqual(despues)
      expect((await prisma.cfdi.findUniqueOrThrow({ where: { id: principal.cfdi.id } })).entrada).toMatchObject({
        capturadaAl: new Date(al).toISOString(),
      })
    })

    it('🔴 ola final (m6 de la T12): donde NO se puede emitir complementaria (sin global, o la principal en cancelación) `corregidasPendientes` es `null`, como en el panel', async () => {
      await venta([['CREDIT_CARD', m1, MAYO]])
      expect((await listar()).corregidasPendientes).toBeNull() // SIN_GLOBAL
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      const principal = await global()
      expect((await listar()).corregidasPendientes).toEqual({ n: 0, completo: true }) // TIMBRADA: sí aplica (0 hoy)
      await prisma.cfdi.update({ where: { id: principal.cfdi.id }, data: { status: 'CANCEL_REQUESTED', cancelStatus: 'REQUESTED' } })
      const r = await listar()
      expect(r.estadoDelPeriodo).toBe('TIMBRADA')
      expect(r.corregidasPendientes).toBeNull()
      const { periodos } = await periodosDeLaGlobal({ venueId, emisorId: fiscalEmisorId, now: NOW })
      expect(periodos.find(p => p.cfdiId === principal.cfdi.id)?.corregidasPendientes).toBeNull() // lo mismo que el panel
    })

    it('🔴 C3-15: una venta con extracción viva, su global cancelada y sin factura del cliente ⇒ total 1, YA_EXTRAIDO 1, CORREGIDA_DESPUES 0, sin invitación', async () => {
      const v = await venta([['CREDIT_CARD', m1, MAYO]])
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      const g = (await global()).cfdi
      await extraccionTimbradaDe(v.id, g.id)
      await cancelarGlobalConfirmada(g.id)
      const r = await listar()
      expect(r.estadoDelPeriodo).toBe('CANCELADA')
      expect(motivos(r)).toEqual([[v.id, 'YA_EXTRAIDO']])
      expect(r.totales).toMatchObject({ porMotivo: { YA_EXTRAIDO: 1 }, total: 1 })
      expect(r.totales!.porMotivo.CORREGIDA_DESPUES ?? 0).toBe(0)
      expect(r.corregidasPendientes).toEqual({ n: 0, completo: true })
      expect(await loadGlobalCandidates(await emisorGlobal(), periodoMayo, true)).not.toContain(v.id)
    })

    it('🔴 v8 · C1-45: extracción CANCELADA → global cancelada ⇒ la venta sigue excluida (YA_EXTRAIDO), nunca candidata ni CORREGIDA_DESPUES, y la complementaria no la toma', async () => {
      const v = await venta([['CREDIT_CARD', m1, MAYO]])
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      const g = (await global()).cfdi
      const ext = await extraccionTimbradaDe(v.id, g.id)
      await cancelarExtraccionConfirmada(ext.id)
      await cancelarGlobalConfirmada(g.id)
      const r = await listar()
      expect(motivos(r)).toEqual([[v.id, 'YA_EXTRAIDO']])
      // v9 (Codex C1-47): `texto` y `detalle` (no hay `nota`); el texto menciona soporte.
      expect(r.excluidas[0]).toMatchObject({ texto: expect.stringMatching(/soporte/i), detalle: TEXTO_EXCLUSION_GLOBAL.YA_EXTRAIDO })
      expect(r.excluidas[0]).not.toHaveProperty('nota')
      expect(r.totales).toMatchObject({ porMotivo: { YA_EXTRAIDO: 1 }, total: 1 })
      expect(r.totales!.porMotivo.CORREGIDA_DESPUES ?? 0).toBe(0)
      expect(r.corregidasPendientes).toEqual({ n: 0, completo: true })
      expect(await loadGlobalCandidates(await emisorGlobal(), periodoMayo, true)).not.toContain(v.id)
      expect(await prisma.order.count({ where: { id: v.id, AND: filtrosDeExclusion() } })).toBe(0) // el mismo predicado compartido
      // y una extracción que NUNCA se timbró (`VALIDATION_FAILED`) no excluye: ahí no hay ingreso documentado
      const w = await venta([['CREDIT_CARD', m1, MAYO]])
      await extraccionNoTimbradaDe(w.id, g.id)
      expect(await loadGlobalCandidates(await emisorGlobal(), periodoMayo, true)).toContain(w.id)
    })

    it('🔴 recorre por páginas; el total de la primera página es la cuenta exacta de todas las filas; el importe trae TODOS los cobros', async () => {
      const px = await productoPorRevisar()
      const porRevisar = await venta([['CREDIT_CARD', m1, MAYO]], [{ productId: px.id, precio: 200 }])
      const muchos = await ventaConCobros(60, { ultimoEnEfectivo: true }) // v1 sólo miraba 50 cobros
      await venta([['CREDIT_CARD', m1, MAYO]]) // entrará: no es fila ni cuenta
      await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { invoiceCashSales: false } })
      const vistas: Array<{ orderId: string; motivo: string; cobradoCents: number }> = []
      let cursor: string | undefined
      let primera: Awaited<ReturnType<typeof listar>> | undefined
      let paginas = 0
      do {
        const r = await listar({ cursor, limite: 1 })
        primera ??= r
        if (cursor) {
          expect(r.totales).toBeNull()
          expect(r.corregidasPendientes).toBeNull()
        }
        vistas.push(...r.excluidas)
        cursor = r.siguiente ?? undefined
        expect(++paginas).toBeLessThan(10)
      } while (cursor)
      expect(vistas.map(x => [x.orderId, x.motivo]).sort()).toEqual(
        [
          [muchos.id, 'EFECTIVO'],
          [porRevisar.id, 'PRODUCTO_POR_REVISAR'],
        ].sort(),
      )
      expect(primera!.totales!.total).toBe(vistas.length)
      expect(primera!.totales!.porMotivo).toEqual({ EFECTIVO: 1, PRODUCTO_POR_REVISAR: 1 })
      expect(vistas.find(x => x.orderId === muchos.id)!.cobradoCents).toBe(muchos.cobradoCents)
      expect(muchos.cobradoCents).toBe(60 * 11600)
    })

    it('más de MAX_REVISAR_TOTALES candidatos ⇒ `completo: false` (la pantalla dice «al menos»); cada llamada revisa a lo más 200 órdenes', async () => {
      await ventasEnLote(MAX_REVISAR_TOTALES + 1, MAYO)
      const r = await listar({ limite: 1 })
      expect(r.totales).toMatchObject({ completo: false, revisadas: MAX_REVISAR_TOTALES })
      expect(r.corregidasPendientes).toBeNull() // ola final (m6 de la T12): sin principal no hay complementaria (el «al menos» va en `totales`)
      expect(r.excluidas).toEqual([])
      expect(r.revisadas).toBe(200)
      expect(r.siguiente).not.toBeNull()
    })

    it.each([
      [
        'COMERCIO_FUERA',
        async () => {
          await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { includeInGlobal: false } })
          return venta([['CREDIT_CARD', m1, MAYO]])
        },
      ],
      [
        'EFECTIVO',
        async () => {
          await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { invoiceCashSales: false } })
          return venta([
            ['CREDIT_CARD', m1, MAYO],
            ['CASH', null, MAYO],
          ])
        },
      ],
      [
        'SIN_EMISOR',
        async () => {
          const sinConfig = await comercio(`sincfg-${randomUUID().slice(0, 8)}`, null)
          comerciosDeLaPrueba.push(sinConfig)
          return venta([['CREDIT_CARD', sinConfig, MAYO]])
        },
      ],
      ['SIN_TERMINAL', async () => venta([['CASH', null, MAYO]])],
      [
        'YA_EXTRAIDO',
        async () => {
          const v = await venta([['CREDIT_CARD', m1, MAYO]])
          await extraccionTimbradaDe(v.id, 'sin-global')
          return v
        },
      ],
    ] as const)(
      '🔴 C1-49 (D8): una venta %s sale con su FOLIO (no con el id interno), su importe, su texto y su detalle',
      async (motivo, preparar) => {
        const v = await preparar()
        expect(v.orderNumber).not.toBe(v.id)
        const r = await listar()
        expect(r.excluidas).toEqual([
          {
            orderId: v.id,
            folio: v.orderNumber,
            cobradoCents: 11600,
            motivo,
            texto: TEXTO_EXCLUSION_GLOBAL[motivo],
            detalle: TEXTO_EXCLUSION_GLOBAL[motivo],
          },
        ])
        expect(r.totales).toEqual({ porMotivo: { [motivo]: 1 }, total: 1, completo: true, revisadas: 0 })
      },
    )

    /** Otra sucursal del mismo grupo con su propio RFC (`e2`) y un comercio configurado a ESE RFC (`m3`); se borra al terminar. */
    async function conOtraSucursal(trabajo: (m3: string) => Promise<void>) {
      const venue2 = `${fixture}-b12`
      await prisma.venue.create({ data: { id: venue2, organizationId: fixture, name: venue2, slug: venue2 } })
      const e2 = (
        await prisma.fiscalEmisor.create({
          data: {
            venueId: venue2,
            rfc: 'CCC010101CCC',
            legalName: venue2,
            regimenFiscal: '601',
            lugarExpedicion: '01000',
            csdStatus: 'ACTIVE',
            globalPeriodicity: 'MENSUAL',
            invoiceCashSales: true,
          },
        })
      ).id
      const m3 = await comercio('m3-12', { fiscalEmisorId: e2, facturacionEnabled: true, includeInGlobal: true })
      try {
        await trabajo(m3)
      } finally {
        await borrar([m3], [e2])
        await prisma.venue.delete({ where: { id: venue2 } })
      }
    }

    it('🔴 M6 de la T5: con un solo RFC, la venta cobrada con un comercio del RFC de OTRA sucursal sale como COMERCIO_FUERA con su detalle (antes no salía en ningún listado)', async () => {
      await conOtraSucursal(async m3 => {
        const v = await venta([['CREDIT_CARD', m3, MAYO]])
        const r = await listar()
        expect(r.excluidas).toEqual([
          {
            orderId: v.id,
            folio: v.orderNumber,
            cobradoCents: 11600,
            motivo: 'COMERCIO_FUERA',
            texto: TEXTO_EXCLUSION_GLOBAL.COMERCIO_FUERA,
            detalle: DETALLE_OTRA_SUCURSAL,
          },
        ])
        expect(r.totales).toEqual({ porMotivo: { COMERCIO_FUERA: 1 }, total: 1, completo: true, revisadas: 0 })
      })
    })

    // Ola final (m1 de la revisión de la T12): esto NO es la regla deseada, es el HUECO 4(a) conocido (en la lista del founder): con dos RFC en ESTE
    // negocio, `AJENA` se trata como «de otro RFC» (puede ser el hermano) y no se lista, aunque el RFC sea de OTRA sucursal. Se fija como control
    // de lo que pasa HOY; el día que se cierre (comparar el `venueId` del emisor de la configuración), esta prueba cambia: no es una regresión.
    it('🔴 ola final (m2 de la T12): con un solo RFC, la venta de OTRA sucursal cuenta también en la estadística de la captura (COMERCIO_FUERA), igual que en el listado', async () => {
      await conOtraSucursal(async m3 => {
        await venta([['CREDIT_CARD', m3, MAYO]]) // otra sucursal
        await venta([['CREDIT_CARD', m1, MAYO]]) // entra
        provider.createGlobalInvoice.mockImplementation(async () => valid())
        const r = await global()
        expect(r).toMatchObject({ status: 'STAMPED', candidateCount: 1, excluidas: { COMERCIO_FUERA: 1 } })
        const l = await listar()
        // «Ver cuáles» y «última captura» dicen lo mismo: esa venta ya estaba fuera al capturar (no es una corrección posterior).
        expect(l.totales).toMatchObject({ porMotivo: { COMERCIO_FUERA: 1 }, total: 1 })
        expect(l.ultimaCaptura).toEqual({ al: expect.any(Date), excluidas: { COMERCIO_FUERA: 1 } })
      })
    })

    it('control — ola final (m3 de la T12): una venta fuera por CONFIGURACIÓN que además está extraída cuenta UNA vez (su clase de configuración, nunca también YA_EXTRAIDO)', async () => {
      const v = await venta([['CREDIT_CARD', m1, MAYO]])
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      const g = (await global()).cfdi
      await extraccionTimbradaDe(v.id, g.id)
      await cancelarGlobalConfirmada(g.id)
      await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { includeInGlobal: false } }) // el afterEach lo restaura
      const r = await listar()
      expect(motivos(r)).toEqual([[v.id, 'COMERCIO_FUERA']])
      expect(r.totales).toMatchObject({ porMotivo: { COMERCIO_FUERA: 1 }, total: 1 })
    })

    it('control — hoy no se lista (hueco 4a): con DOS RFC en el negocio, la venta de un comercio del RFC de OTRA sucursal no sale en el listado', async () => {
      await conOtraSucursal(async m3 => {
        await venta([['CREDIT_CARD', m3, MAYO]])
        const e3 = await segundoEmisor()
        try {
          const r2 = await listar()
          expect(r2.excluidas).toEqual([])
          expect(r2.totales).toEqual({ porMotivo: {}, total: 0, completo: true, revisadas: 0 })
        } finally {
          await prisma.fiscalEmisor.delete({ where: { id: e3 } })
        }
      })
    })

    it('🔴 la regla de la heredada (T11, ronda 1, I1): una principal heredada TIMBRADA no se lista (ni por id ni por periodo); CANCELADA sí, y sus ventas quedan pendientes de complementaria', async () => {
      const v = await venta([['CREDIT_CARD', m1, MAYO]]) // documentada por la heredada, pero sin manifiesto que lo diga
      const heredada = await prisma.cfdi.create({
        data: {
          venueId,
          fiscalEmisorId,
          orderId: null,
          flow: 'GLOBAL_C',
          isGlobal: true,
          type: 'INGRESO',
          protocoloIva: null,
          idempotencyKey: `cfdi-global-${fiscalEmisorId}-2026-05-04`,
          globalPeriod: { periodicidad: '04', meses: '05', anio: 2026 },
          status: 'STAMPED',
          uuid: randomUUID(),
          facturapiId: randomUUID(),
          serie: 'F',
          folio: '3',
          stampedAt: new Date('2026-06-01T10:00:00Z'),
          receptorRfc: 'XAXX010101000',
          receptorNombre: 'PÚBLICO EN GENERAL',
          receptorRegimen: '616',
          receptorCp: '01000',
          usoCfdi: 'S01',
          formaPago: '04',
          metodoPago: 'PUE',
          subtotalCents: 10000,
          taxCents: 1600,
          totalCents: 11600,
        },
      })
      await expect(listar({ principalId: heredada.id })).rejects.toThrow(MOTIVO_LISTADO_HEREDADA)
      await expect(listar()).rejects.toThrow(MOTIVO_LISTADO_HEREDADA)
      expect(MOTIVO_LISTADO_HEREDADA).toMatch(/soporte/)
      await prisma.cfdi.update({ where: { id: heredada.id }, data: { status: 'CANCELLED', cancelStatus: 'CANCELLED' } })
      const r = await listar({ principalId: heredada.id })
      expect(r.estadoDelPeriodo).toBe('CANCELADA')
      expect(motivos(r)).toEqual([[v.id, 'CORREGIDA_DESPUES']])
      expect(r.corregidasPendientes).toEqual({ n: 1, completo: true })
      expect(r.ultimaCaptura).toBeNull()
    })

    it('🔴 como la vista previa (T11, ronda 1, I4): una complementaria reservada y NUNCA enviada no esconde sus ventas: salen como CORREGIDA_DESPUES y cuentan como pendientes', async () => {
      await venta([['CREDIT_CARD', m1, MAYO]])
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      const principal = await global()
      const tarde = await venta([['CREDIT_CARD', m1, MAYO]])
      await expect(
        emitirGlobalComplementaria(
          { venueId, emisorId: fiscalEmisorId, principalId: principal.cfdi.id, now: NOW, sandbox: true },
          {
            resolveProvider: () => {
              throw new Error('sin proveedor')
            },
          },
        ),
      ).rejects.toThrow('sin proveedor')
      const r = await listar({ principalId: principal.cfdi.id })
      expect(motivos(r)).toEqual([[tarde.id, 'CORREGIDA_DESPUES']])
      expect(r.totales).toMatchObject({ porMotivo: { CORREGIDA_DESPUES: 1 }, total: 1, completo: true })
      expect(r.corregidasPendientes).toEqual({ n: 1, completo: true })
      const vista = await vistaPreviaComplementaria({ venueId, emisorId: fiscalEmisorId, principalId: principal.cfdi.id, now: NOW })
      expect(r.corregidasPendientes).toEqual(vista.corregidasPendientes)
    })

    it('🔴 C1-32: una principal diaria del 4 de septiembre, el emisor ya MENSUAL: su listado se pide por `principalId` y usa SU periodo (con `desde` daría «pídelo a soporte»)', async () => {
      await emisorConPeriodicidad('DIARIO')
      provider.createGlobalInvoice.mockImplementation(async () => valid())
      await venta([['CREDIT_CARD', m1, new Date('2026-09-04T19:00:00Z')]])
      const principal = await issueGlobalForEmisor(
        { emisorId: fiscalEmisorId, now: new Date('2026-09-05T09:00:00Z'), sandbox: true, desde: '2026-09-04T06:00:00.000Z' },
        { resolveProvider: () => provider as any },
      )
      await emisorConPeriodicidad('MENSUAL')
      const OCT_5 = new Date('2026-10-05T09:00:00Z')
      const r = await listar({ now: OCT_5, principalId: principal.cfdi.id })
      expect(r.periodo).toMatchObject({
        desde: new Date(principal.cfdi.entrada.periodo.desde),
        hasta: new Date(principal.cfdi.entrada.periodo.hasta),
      })
      expect(r.estadoDelPeriodo).toBe('TIMBRADA')
      await expect(listar({ now: OCT_5, desde: '2026-09-04T06:00:00.000Z' })).rejects.toThrow(/soporte/)
    })

    it.each([
      ['VALIDATION_FAILED', 'detenida (p. ej. MOTIVO_ANIO_FUERA)'],
      ['STAMP_FAILED', 'rechazada o pendiente de reintento'],
      ['STAMPING', 'reservada'],
    ] as const)(
      '🔴 C1-41 (Codex): una principal %s (%s) también se lista por `principalId` con SU periodo guardado; la complementaria sigue pidiendo la timbrada',
      async (status, _queEs) => {
        await emisorConPeriodicidad('DIARIO')
        provider.createGlobalInvoice.mockImplementation(async () => valid())
        await venta([['CREDIT_CARD', m1, new Date('2026-09-04T19:00:00Z')]])
        const principal = await issueGlobalForEmisor(
          { emisorId: fiscalEmisorId, now: new Date('2026-09-05T09:00:00Z'), sandbox: true, desde: '2026-09-04T06:00:00.000Z' },
          { resolveProvider: () => provider as any },
        )
        await prisma.cfdi.update({ where: { id: principal.cfdi.id }, data: { status } }) // el estado de la principal, lo único que cambia
        await emisorConPeriodicidad('MENSUAL')
        const OCT_5 = new Date('2026-10-05T09:00:00Z')
        const r = await listar({ now: OCT_5, principalId: principal.cfdi.id })
        expect(r.periodo).toMatchObject({ desde: new Date(principal.cfdi.entrada.periodo.desde) })
        expect(r.estadoDelPeriodo).toBe('SIN_TIMBRAR')
        await expect(
          vistaPreviaComplementaria({ venueId, emisorId: fiscalEmisorId, principalId: principal.cfdi.id, now: OCT_5 }),
        ).rejects.toThrow(MOTIVO_SIN_PRINCIPAL)
      },
    )

    it('un periodo fuera de la ventana reciente con `desde` ⇒ «pídelo a soporte» (C1-P16 = B); un `desde` que no es inicio de periodo, igual', async () => {
      const [, reciente, viejo] = periodosCerradosRecientes('MENSUAL', NOW, 3)
      await expect(listar({ desde: reciente.periodStart.toISOString() })).resolves.toMatchObject({
        periodo: { desde: reciente.periodStart },
      })
      await expect(listar({ desde: viejo.periodStart.toISOString() })).rejects.toThrow(/soporte/)
      await expect(listar({ desde: '2020-01-01T06:00:01.000Z' })).rejects.toThrow(/soporte/)
    })

    it('🔴 un id que no es una global principal de este emisor, por `principalId`, no se lista (sólo identidad: la regla de la T11)', async () => {
      await expect(listar({ principalId: 'no-existe' })).rejects.toThrow('Esa factura no es una factura global principal de este emisor.')
    })
  })

  describe('C1 · Tarea 9 — la bimestral sólo con el régimen 621 (emisor, candidatos y lector reales)', () => {
    const bimestre = periodoDeGlobalPeriod({ periodicidad: '05', meses: '17', anio: 2026 })!
    const ahora = new Date('2026-11-05T15:00:00Z')
    const emitir = () =>
      issueGlobalForPeriod({
        emisorId: fiscalEmisorId,
        now: ahora,
        sandbox: true,
        period: bimestre,
        key: llaveDeLaGlobal(fiscalEmisorId, bimestre),
      })
    afterEach(async () => {
      await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { regimenFiscal: '601' } })
    })

    it('🔴 C1-19: con el emisor real (MENSUAL, 601) un bimestre con ventas no se emite: su motivo, sin fila, sin manifiesto y sin PAC', async () => {
      const v = await venta([['CREDIT_CARD', m1, new Date('2026-09-15T18:00:00Z')]])
      const r = await emitir()
      expect(r).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_BIMESTRAL_SOLO_621] })
      expect(await prisma.cfdi.count({ where: { venueId } })).toBe(0)
      expect(await prisma.cfdiGlobalOrden.count({ where: { orderId: v.id } })).toBe(0)
      expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
    })

    it('control — el mismo bimestre con el régimen 621 se timbra con la periodicidad del documento (two_months · 17 · 2026)', async () => {
      await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { regimenFiscal: '621' } })
      await venta([['CREDIT_CARD', m1, new Date('2026-09-15T18:00:00Z')]])
      expect(await emitir()).toMatchObject({ status: 'STAMPED', candidateCount: 1 })
      expect(provider.createGlobalInvoice).toHaveBeenCalledWith(
        expect.objectContaining({ global: expect.objectContaining({ periodicity: 'two_months', months: '17', year: 2026 }) }),
      )
    })
  })
})
