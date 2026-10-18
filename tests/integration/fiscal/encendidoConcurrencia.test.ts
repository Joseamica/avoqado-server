// tests/integration/fiscal/encendidoConcurrencia.test.ts
//
/**
 * Plan 6b (spec D10, §11 «Candados»): encender contra cada camino que bloquea órdenes o productos, con transacciones REALES. Ninguno se
 * traba (40P01 / P2034) y ninguno escribe sobre lo que el otro decidió.
 *
 * Técnica determinista (sin `sleep` ni ganchos en el código): un «tapón» —una transacción de la prueba que retiene una fila y sabe su
 * `pg_backend_pid()`— detiene a un camino en un punto exacto, y cada espera se identifica por pid (`pg_blocking_pids`), nunca con un
 * conteo de toda la base. Con el orden VIEJO (orden → productos → admisión) el otro camino ya tiene la orden y sus productos y espera la
 * admisión mientras el encendido pide ese producto: Postgres aborta a uno con 40P01. Con el orden de D10, el otro camino espera la
 * admisión SIN tener nada y los dos terminan.
 */
import { randomUUID } from 'crypto'
import { DeliveryChannelLink, DeliveryProvider, OrderSource, Prisma, StaffRole, Unit, UnitType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { updateProduct } from '@/services/dashboard/product.dashboard.service'
import { lockRecipeCostGraphsForRawMaterialUpdateV1 } from '@/services/dashboard/recipe-cost-graph-lock'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { reconcileDeliveryOrderFromProvider } from '@/services/delivery-channels/core/deliveryReconciliation.service'
import type { NormalizedDeliveryOrder, NormalizedDeliveryPayment } from '@/services/delivery-channels/core/types'
import { uberAdapter } from '@/services/delivery-channels/providers/uber-eats/uber.adapter'
import { anotarIntencionDeCancelar, issueCfdiForOrder } from '@/services/fiscal/cfdi.service'
import { encenderBajoCandados } from '@/services/fiscal/encendidoIva.service'
import { planDeSelladoHeredado, SIN_REPARAR } from '@/services/fiscal/sellosHeredados'
import { PosRechazadoPorIva } from '@/services/pos-sync/exclusionIva'
import { processPosOrderEvent } from '@/services/pos-sync/posSyncOrder.service'
import type { RichPosPayload } from '@/types/pos.types'
import { limpiarNegocios, nuevoNegocio, type Negocio } from './exclusionContable.fixtures'

// La observación de 30 días de los aparatos se da por cumplida (su valor real lo prueba la Tarea 3).
jest.mock('@/services/mobile/deviceRegistry.service', () => ({
  ...jest.requireActual('@/services/mobile/deviceRegistry.service'),
  OBSERVADOR_POS_DESDE: new Date('2026-08-01T00:00:00Z'),
}))

// Antes de registrar cualquier siembra o limpieza: nunca aceptar la base compartida.
const { isDisposableH1Url } = require('../../../scripts/h1-test-database.cjs')
const testDatabase = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(testDatabase.hostname) ||
  !(
    ['/av_db_25_iva_test', '/av_db_25_iva_test_b3c', '/avoqado_h1a_test_20260808'].includes(testDatabase.pathname) ||
    isDisposableH1Url(testDatabase)
  )
) {
  throw new Error('Esta suite exige la base local av_db_25_iva_test o una base H1 desechable validada.')
}

jest.setTimeout(60_000)

/** Los backends que esperan un candado que tiene `pid` (sólo los de ESTE caso). */
async function esperarBloqueadosPor(pid: number, n = 1): Promise<number[]> {
  // 1200 × 25 ms = 30 s (el brief decía 400 = 10 s): el mismo margen que la suite hermana del POS (Tarea 7) para una Mac cargada.
  for (let i = 0; i < 1200; i++) {
    const filas = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`
    if (filas.length >= n) return filas.map(f => f.pid)
    await new Promise(res => setTimeout(res, 25))
  }
  throw new Error(`nadie quedó esperando al backend ${pid}`)
}

/** Una transacción de la prueba que retiene una fila hasta `soltar()`; `tomado` entrega su pid. */
function tapon(retener: (t: Prisma.TransactionClient) => Promise<unknown>) {
  let soltar!: () => void
  const suelto = new Promise<void>(res => (soltar = res))
  let listo!: (pid: number) => void
  const tomado = new Promise<number>(res => (listo = res))
  const tx = prisma.$transaction(
    async t => {
      const [{ pid }] = await t.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      await retener(t)
      listo(pid)
      await suelto
    },
    { timeout: 30_000 },
  )
  return { tomado, soltar, tx }
}
/** Detiene al encendido justo después de su admisión exclusiva (lo siguiente que pide es la organización). */
const taponDeOrganizacion = (organizationId: string) =>
  tapon(t => t.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR NO KEY UPDATE`)
/** Detiene a quien pida ese producto para escribir (delivery lo toma FOR NO KEY UPDATE). */
const taponDeProducto = (productId: string) => tapon(t => t.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR SHARE`)

const sinBloqueoMutuo = (r: PromiseSettledResult<unknown>) => {
  if (r.status === 'rejected') expect(String((r.reason as Error)?.message ?? r.reason)).not.toMatch(/40P01|deadlock|P2034/i)
}
/** `a < b` con la intercalación de la base (la que usan los `ORDER BY id` de los candados). */
const menor = async (a: string, b: string) => (await prisma.$queryRaw<Array<{ ok: boolean }>>`SELECT ${a}::text < ${b}::text AS ok`)[0].ok

type Humano = { type: 'HUMAN'; staffId: string; impersonating: false }

const receptor = { rfc: 'EKU9003173C9', razonSocial: 'ESCUELA KEMPER URGATE', regimenFiscal: '601', codigoPostal: '64000', usoCfdi: 'G03' }
/** El PAC doble: timbra siempre (y guarda lo que se le mandó). */
const enviados: any[] = []
const timbre = () => ({
  providerInvoiceId: randomUUID(),
  uuid: randomUUID(),
  serie: 'F',
  folio: '1',
  totalCents: 11600,
  stampedAt: new Date(),
  status: 'valid',
})
const provider = {
  name: 'facturapi',
  createInvoice: async (params: unknown) => (enviados.push(params), timbre()),
  findByExternalId: async () => null,
  getInvoice: async () => timbre(),
  downloadXml: async () => Buffer.from('<xml/>'),
  downloadPdf: async () => Buffer.from('%PDF'),
}
const deps = { resolveProvider: () => provider as any, storeArtifact: async () => 'https://test/file' }
const issue = (x: Negocio, orderId: string) =>
  issueCfdiForOrder({ orderId, receptor, sandbox: true, expectedVenueId: x.venueId }, deps as any)

/** El XML de una factura vieja (heredada): un concepto al 16 %. */
const xml16 = {
  version: 1,
  subTotal: '100.00',
  descuento: '0.00',
  total: '116.00',
  totalImpuestosTrasladados: '16.00',
  conceptos: [
    {
      noIdentificacion: null,
      objetoImp: '02',
      importe: '100.00',
      descuento: '0.00',
      traslados: [{ impuesto: '002', tipoFactor: 'Tasa', tasa: '0.160000', base: '100.00', importe: '16.00' }],
    },
  ],
}

describe('encendido del IVA por producto contra los demás caminos que bloquean órdenes o productos (Postgres real)', () => {
  const negocios: Negocio[] = []
  const staffs: string[] = []
  const comercios: Array<{ providerId: string; merchantAccountId: string }> = []

  afterEach(() => jest.restoreAllMocks())
  afterAll(async () => {
    const venueId = { in: negocios.map(n => n.venueId) }
    const pagos = (await prisma.payment.findMany({ where: { venueId }, select: { id: true } })).map(p => p.id)
    await prisma.deliveryLineAction.deleteMany({ where: { venueId } })
    await prisma.venueTransaction.deleteMany({ where: { venueId } })
    await prisma.paymentEffect.deleteMany({ where: { paymentId: { in: pagos } } })
    await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: pagos } } })
    await prisma.payment.deleteMany({ where: { venueId } }) // antes de sus formas de pago (Payment_venueId_tenderTypeId_fkey)
    await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId } } } })
    await prisma.kdsOrder.deleteMany({ where: { venueId } })
    await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
    await prisma.venueTenderTypeRevision.deleteMany({ where: { venueId } })
    await prisma.venueTenderType.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { staffId: { in: staffs } } })
    await prisma.staff.deleteMany({ where: { id: { in: staffs } } })
    await limpiarNegocios() // también los productos: sus recetas y renglones caen en cascada; los insumos, con el negocio
    await prisma.merchantAccount.deleteMany({ where: { id: { in: comercios.map(c => c.merchantAccountId) } } })
    await prisma.paymentProvider.deleteMany({ where: { id: { in: comercios.map(c => c.providerId) } } })
    await prisma.$disconnect()
  })

  /** Un `Staff` real dueño de la sede: el primer encendido lo exige (Tarea 6, Paso 4b). */
  const dueno = async (venueId: string): Promise<Humano> => {
    const staffId = (await prisma.staff.create({ data: { email: `enc8-${randomUUID()}@t.mx`, firstName: 'IVA', lastName: 'Tarea8' } })).id
    staffs.push(staffId)
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.OWNER, active: true } })
    return { type: 'HUMAN', staffId, impersonating: false }
  }
  const productoDe = async (x: Negocio, name: string) =>
    prisma.product.create({
      data: {
        venueId: x.venueId,
        categoryId: (
          await prisma.menuCategory.create({ data: { venueId: x.venueId, name: 'IVA', slug: `iva-${randomUUID().slice(0, 8)}` } })
        ).id,
        sku: `E8-${randomUUID().slice(0, 8)}`,
        name,
        price: 116,
      },
    })
  /** Negocio apagado y limpio (otra organización por caso: la admisión es por organización), su dueño, emisor y un producto al 16 %. */
  const armar = async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    negocios.push(x)
    const humano = await dueno(x.venueId)
    const emisor = await prisma.fiscalEmisor.create({
      data: {
        venueId: x.venueId,
        rfc: 'AAA010101AAA',
        legalName: 'Negocio de prueba',
        regimenFiscal: '601',
        lugarExpedicion: '01000',
        csdStatus: 'ACTIVE',
        invoiceCashSales: true,
      },
    })
    // Facturación habilitada en un comercio del emisor (lo que exige la emisión de una venta en efectivo).
    const code = `enc8-${randomUUID()}`
    const providerId = (await prisma.paymentProvider.create({ data: { code, name: code, type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] } }))
      .id
    const merchantAccountId = (
      await prisma.merchantAccount.create({ data: { providerId, externalMerchantId: code, credentialsEncrypted: {} } })
    ).id
    comercios.push({ providerId, merchantAccountId })
    await prisma.merchantFiscalConfig.create({
      data: { merchantAccountId, fiscalEmisorId: emisor.id, facturacionEnabled: true, autofacturaEnabled: true },
    })
    const p = await productoDe(x, 'Café en grano')
    return { x, humano, p }
  }
  /** Una venta pagada en efectivo con el producto (como emisionIndividualSellada.test.ts). */
  const ventaPagada = (x: Negocio, productId: string) =>
    prisma.order.create({
      data: {
        venueId: x.venueId,
        orderNumber: `E8-${randomUUID().slice(0, 8)}`,
        subtotal: 116,
        taxAmount: 0,
        total: 116,
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        items: { create: { productId, productName: 'Producto', quantity: 1, unitPrice: 116, taxAmount: 0, total: 116 } },
        payments: {
          create: { venueId: x.venueId, amount: 116, feePercentage: 0, feeAmount: 0, netAmount: 116, method: 'CASH', status: 'COMPLETED' },
        },
      },
      include: { items: true },
    })
  /** Una factura VIEJA (sin `protocoloIva`, timbrada por la ruta vieja) sobre la orden, con su XML al 16 %: el encendido la sella. */
  const heredada = async (x: Negocio, orderId: string) =>
    prisma.cfdi.create({
      data: {
        venueId: x.venueId,
        fiscalEmisorId: (await prisma.fiscalEmisor.findFirstOrThrow({ where: { venueId: x.venueId }, select: { id: true } })).id,
        orderId,
        type: 'INGRESO',
        status: 'STAMPED',
        flow: 'AUTOFACTURA_A',
        protocoloIva: null,
        xmlConceptos: xml16 as Prisma.InputJsonValue,
        serie: 'A',
        folio: String(Math.floor(Math.random() * 1_000_000)),
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
        idempotencyKey: `enc8-${randomUUID()}`,
        attempts: 1,
        updatedAt: new Date(),
      } as Prisma.CfdiUncheckedCreateInput,
    })
  const iva = async (productId: string) =>
    (await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { ivaTratamiento: true } })).ivaTratamiento
  const encendido = async (venueId: string) => (await prisma.venueIvaPorProducto.count({ where: { venueId } })) === 1

  it('encender contra emitir la factura de una venta con el producto que se edita', async () => {
    const { x, humano, p } = await armar()
    const orden = await ventaPagada(x, p.id)
    enviados.length = 0
    const t = taponDeOrganizacion(x.organizationId)
    let encender: Promise<unknown> | undefined
    let emitir: Promise<unknown> | undefined
    try {
      const pidTapon = await t.tomado
      encender = updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, humano)
      const [pidEncender] = await esperarBloqueadosPor(pidTapon)
      emitir = issue(x, orden.id)
      await esperarBloqueadosPor(pidEncender) // D10: espera la admisión; orden viejo: ya tiene la orden y P, y espera la admisión
    } finally {
      t.soltar()
    }
    const [a, b] = await Promise.allSettled([encender, emitir])
    await t.tx
    sinBloqueoMutuo(a)
    sinBloqueoMutuo(b)
    expect(a.status).toBe('fulfilled')
    expect(b.status).toBe('fulfilled')
    expect((b as PromiseFulfilledResult<{ status: string }>).value.status).toBe('STAMPED')
    // Sin escrituras cruzadas: la emisión corrió DESPUÉS del encendido y facturó con el IVA nuevo, sellado.
    expect(await encendido(x.venueId)).toBe(true)
    expect(await iva(p.id)).toBe('IVA_0')
    const renglon = await prisma.orderItem.findFirstOrThrow({ where: { orderId: orden.id } })
    expect(renglon.ivaTratamiento).toBe('IVA_0')
    expect(enviados).toHaveLength(1)
    expect(enviados[0]).toMatchObject({ items: [{ taxes: [{ rate: 0 }] }] })
  })

  it('encender contra cancelar una factura nueva de una venta con el producto: los dos terminan y la intención se anota DESPUÉS', async () => {
    const { x, humano, p } = await armar()
    const orden = await ventaPagada(x, p.id)
    expect((await issue(x, orden.id)).status).toBe('STAMPED') // la factura nueva, sellada al 16 % con el negocio apagado
    const cfdi = await prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: `cfdi-order-${orden.id}` } })
    expect(cfdi).toMatchObject({ status: 'STAMPED', protocoloIva: 1, cancelStatus: null })
    const t = taponDeOrganizacion(x.organizationId)
    let encender: Promise<unknown> | undefined
    let cancelar: Promise<unknown> | undefined
    try {
      const pidTapon = await t.tomado
      encender = updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, humano)
      const [pidEncender] = await esperarBloqueadosPor(pidTapon)
      cancelar = anotarIntencionDeCancelar(cfdi.id, cfdi.attempts, { motivo: '02' })
      await esperarBloqueadosPor(pidEncender) // D10: espera la admisión sin tener nada; orden viejo: ya tiene la orden y P
    } finally {
      t.soltar()
    }
    const [a, b] = await Promise.allSettled([encender, cancelar])
    await t.tx
    sinBloqueoMutuo(a)
    sinBloqueoMutuo(b)
    expect(a.status).toBe('fulfilled') // el encendido NO se detuvo por «documentos en vuelo»: la intención llegó después
    expect(b.status).toBe('fulfilled')
    expect((b as PromiseFulfilledResult<unknown>).value).toEqual({ estado: 'ANOTADA', intento: 1 })
    expect(await encendido(x.venueId)).toBe(true)
    expect(await iva(p.id)).toBe('IVA_0')
    expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: cfdi.id } })).toMatchObject({ cancelStatus: 'REQUESTED', cancelIntento: 1 })
    // Lo ya facturado se queda como está: el renglón conserva el 16 % de su factura.
    expect((await prisma.orderItem.findFirstOrThrow({ where: { orderId: orden.id } })).ivaTratamiento).toBe('IVA_16')
  })

  it('encender contra conciliar delivery: delivery (orden → producto, sin admisión) termina primero y luego enciende', async () => {
    const { x, humano } = await armar()
    const link: DeliveryChannelLink = await prisma.deliveryChannelLink.create({
      data: {
        venueId: x.venueId,
        provider: DeliveryProvider.UBER_EATS,
        externalLocationId: `store-enc8-${randomUUID()}`,
        webhookSecret: 'x',
      },
    })
    const pago = (venta: string): NormalizedDeliveryPayment => ({
      currency: 'MXN',
      saleAmount: venta,
      merchantFees: '0.00',
      discountAmount: '0.00',
      tipAmount: '0.00',
      externallyPaidSale: venta,
      externallyPaidTip: '0.00',
      cashDueSale: '0.00',
      cashDueTip: '0.00',
    })
    const sufijo = randomUUID().slice(0, 8)
    const renglon = (linea: string, nombre: string, precio: string) => ({
      externalId: `${linea}-${sufijo}`,
      lineId: linea,
      name: `${nombre} ${sufijo}`,
      quantity: 1,
      unitPrice: precio,
      total: precio,
    })
    const pedido: NormalizedDeliveryOrder = {
      externalId: `enc8-${sufijo}`,
      displayId: `E8${sufijo}`,
      source: OrderSource.UBER_EATS,
      items: [renglon('a', 'Cochinita', '150.00'), renglon('b', 'Horchata', '50.00')],
      payment: pago('200.00'),
      customer: { name: 'Cliente T8' },
      raw: { fuente: 'test' },
      placedAt: new Date(),
    }
    const { order: d } = await ingestDeliveryOrder(pedido, link)
    const filas = await prisma.orderItem.findMany({ where: { orderId: d.id }, select: { externalLineId: true, productId: true } })
    const P = filas.find(f => f.externalLineId === 'a')!.productId!
    const X = filas.find(f => f.externalLineId === 'b')!.productId!
    const h = await heredada(x, d.id) // el encendido bloquea D para sellarla
    const E = await productoDe(x, 'Consulta') // el encendido edita OTRO producto: P recibe la regla C con el ajuste
    // El proveedor retiró la horchata: la foto fresca trae sólo la cochinita y $150.
    jest.spyOn(uberAdapter, 'fetchOrder').mockResolvedValue({ ...pedido, items: [pedido.items[0]], payment: pago('150.00') } as any)
    jest.spyOn(uberAdapter, 'normalizeOrder').mockImplementation(raw => raw as NormalizedDeliveryOrder)

    const t = taponDeProducto(P)
    let conciliar: Promise<{ outcome: string }> | undefined
    let encender: Promise<unknown> | undefined
    try {
      const pidTapon = await t.tomado
      conciliar = reconcileDeliveryOrderFromProvider(d.id, { trigger: 'ROUTE' }) // toma D y espera P
      const [pidDelivery] = await esperarBloqueadosPor(pidTapon)
      encender = updateProduct(x.venueId, E.id, { ivaTratamiento: 'IVA_0' } as any, humano) // admisión, organización, negocio… y D
      await esperarBloqueadosPor(pidDelivery)
    } finally {
      t.soltar()
    }
    const [a, b] = await Promise.allSettled([conciliar, encender])
    await t.tx
    sinBloqueoMutuo(a)
    sinBloqueoMutuo(b)
    expect(a.status).toBe('fulfilled')
    expect(b.status).toBe('fulfilled')
    expect((a as PromiseFulfilledResult<{ outcome: string }>).value.outcome).toBe('REFUNDED')
    // Delivery primero: su reembolso de $50 con P al 16 % y la marca de la regla C en sus productos.
    const reembolsos = await prisma.payment.findMany({ where: { orderId: d.id, type: 'REFUND' }, select: { amount: true } })
    expect(reembolsos.map(r => r.amount.toString())).toEqual(['-50'])
    const marcas = await prisma.product.findMany({ where: { id: { in: [P, X] } }, select: { ajusteDeliveryAlgunaVez: true } })
    expect(marcas).toEqual([{ ajusteDeliveryAlgunaVez: true }, { ajusteDeliveryAlgunaVez: true }])
    // Luego el encendido: E al 0 %, la bandera, y D sellada con la tasa de SU XML (16 %), no con lo que decidió delivery ni E.
    expect(await encendido(x.venueId)).toBe(true)
    expect(await iva(E.id)).toBe('IVA_0')
    expect([await iva(P), await iva(X)]).toEqual(['IVA_16', 'IVA_16'])
    expect(await prisma.orderItem.findMany({ where: { orderId: d.id }, select: { ivaTratamiento: true } })).toEqual([
      { ivaTratamiento: 'IVA_16' },
      { ivaTratamiento: 'IVA_16' },
    ])
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: h.id } })).toBe(2)
  })

  it('encender contra sincronizar el POS: el POS espera la admisión, ve la bandera y rechaza sin escribir; el encendido termina', async () => {
    const { x, humano, p } = await armar()
    await prisma.venue.update({ where: { id: x.venueId }, data: { posType: 'NONE' } }) // sin POS conectado ni latido
    const externalId = `SR1:1:${randomUUID().slice(0, 8)}`
    const payload: RichPosPayload = {
      venueId: x.venueId,
      orderData: {
        externalId,
        orderNumber: externalId.split(':').pop()!,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        subtotal: 100,
        taxAmount: 16,
        discountAmount: 0,
        tipAmount: 0,
        total: 116,
        createdAt: new Date().toISOString(),
        completedAt: null,
        posRawData: { test: 'enc8' },
      },
      staffData: { externalId: null, name: null, pin: null },
      tableData: { externalId: null },
      shiftData: { externalId: null, startTime: null },
      payments: [],
      paymentMethodsCatalog: [],
    }
    const t = taponDeOrganizacion(x.organizationId)
    let encender: Promise<unknown> | undefined
    let sincronizar: Promise<unknown> | undefined
    try {
      const pidTapon = await t.tomado
      encender = updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, humano)
      const [pidEncender] = await esperarBloqueadosPor(pidTapon)
      sincronizar = processPosOrderEvent(payload)
      await esperarBloqueadosPor(pidEncender) // la primera sentencia del escritor del POS: la admisión compartida
    } finally {
      t.soltar()
    }
    const [a, b] = await Promise.allSettled([encender, sincronizar])
    await t.tx
    sinBloqueoMutuo(a)
    sinBloqueoMutuo(b)
    expect(a.status).toBe('fulfilled')
    expect(b.status).toBe('rejected')
    expect((b as PromiseRejectedResult).reason).toBeInstanceOf(PosRechazadoPorIva)
    expect(await encendido(x.venueId)).toBe(true)
    expect(await iva(p.id)).toBe('IVA_0')
    expect(await prisma.order.count({ where: { venueId: x.venueId } })).toBe(0)
  })

  it('encender contra recalcular el costo de recetas cruzadas: los productos por id antes del bucle de recetas', async () => {
    const { x, humano } = await armar()
    const P = await productoDe(x, 'Pan dulce')
    const Q = await productoDe(x, 'Pastel')
    expect(await menor(P.id, Q.id)).toBe(true)
    const insumo = await prisma.rawMaterial.create({
      data: {
        venueId: x.venueId,
        name: 'Harina',
        sku: `E8-RM-${randomUUID().slice(0, 8)}`,
        category: 'OTHER',
        currentStock: 1000,
        minimumStock: 0,
        reorderPoint: 0,
        costPerUnit: 0.5,
        avgCostPerUnit: 0.5,
        unit: Unit.GRAM,
        unitType: UnitType.WEIGHT,
      },
    })
    const receta = (productId: string) =>
      prisma.recipe.create({
        data: {
          productId,
          portionYield: 1,
          totalCost: 50,
          lines: { create: { rawMaterialId: insumo.id, quantity: 100, unit: Unit.GRAM, costPerServing: 50, displayOrder: 0 } },
        },
      })
    // El orden de id de las recetas es el INVERSO del de sus productos.
    const recetaQ = await receta(Q.id)
    const recetaP = await receta(P.id)
    expect(await menor(recetaQ.id, recetaP.id)).toBe(true)
    // Una factura vieja de una venta con Q: el encendido de P bloquea P y Q en UNA pasada por id.
    const venta = await ventaPagada(x, Q.id)
    const h = await heredada(x, venta.id)

    const org = taponDeOrganizacion(x.organizationId)
    const fila = tapon(t => t.$queryRaw`SELECT id FROM "Recipe" WHERE id = ${recetaP.id} FOR UPDATE`)
    let encender: Promise<unknown> | undefined
    let costo: Promise<string[]> | undefined
    try {
      const [pidOrg, pidReceta] = await Promise.all([org.tomado, fila.tomado])
      encender = updateProduct(x.venueId, P.id, { ivaTratamiento: 'IVA_0' } as any, humano)
      await esperarBloqueadosPor(pidOrg)
      costo = prisma.$transaction(tx => lockRecipeCostGraphsForRawMaterialUpdateV1(tx, x.venueId, [recetaQ.id, recetaP.id], insumo.id), {
        timeout: 30_000,
      })
      const [pidCosto] = await esperarBloqueadosPor(pidReceta) // bucle viejo: ya tiene Q; con los productos antes del bucle, P y Q
      org.soltar()
      await esperarBloqueadosPor(pidCosto) // el encendido pide P (o Q, con el bucle viejo), que tiene la edición de costo
    } finally {
      org.soltar()
      fila.soltar()
    }
    const [a, b] = await Promise.allSettled([encender, costo])
    await Promise.all([org.tx, fila.tx])
    sinBloqueoMutuo(a)
    sinBloqueoMutuo(b)
    expect(a.status).toBe('fulfilled')
    expect(b.status).toBe('fulfilled')
    expect((b as PromiseFulfilledResult<string[]>).value).toEqual([recetaQ.id, recetaP.id])
    expect(await encendido(x.venueId)).toBe(true)
    expect([await iva(P.id), await iva(Q.id)]).toEqual(['IVA_0', 'IVA_16'])
    // La venta vieja con Q queda sellada con la tasa de su XML.
    expect((await prisma.orderItem.findFirstOrThrow({ where: { orderId: venta.id } })).ivaTratamiento).toBe('IVA_16')
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: h.id } })).toBe(1)
  })

  // Revisión final, I-1: una global o una nota de crédito retienen la admisión COMPARTIDA hasta 60 s. Un encendido que la espera en
  // exclusiva forma detrás a TODA admisión compartida que llegue después (cola justa de Postgres). Con el tope, sale de la cola con un
  // 409 claro y la facturación de la organización sigue.
  const admisionCompartida = (organizationId: string) =>
    tapon(t => t.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('iva-emision:' || ${organizationId}, 0))`)
  const admisionExclusiva = (organizationId: string) =>
    tapon(t => t.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('iva-emision:' || ${organizationId}, 0))`)
  /** Lo que tenga la promesa a los `ms` (o «sigue esperando»): así una espera sin tope es un fallo de aserción, no un timeout de jest. */
  const a_los = <T>(p: Promise<T>, ms: number) =>
    Promise.race([
      p.then(
        v => ({ v }),
        (e: unknown) => ({ e }),
      ),
      new Promise<'sigue esperando'>(res => setTimeout(() => res('sigue esperando'), ms)),
    ])

  it('I-1: con la admisión compartida retenida, el encendido responde 409 IVA_ENCENDIDO_OCUPADO en ~5 s y una emisión que llega DESPUÉS pasa sin esperarlo', async () => {
    const { x, humano, p } = await armar()
    const orden = await ventaPagada(x, p.id)
    enviados.length = 0
    const warn = jest.spyOn(logger, 'warn')
    const t = admisionCompartida(x.organizationId)
    let encender: ReturnType<typeof a_los> | undefined
    let emitir: ReturnType<typeof a_los> | undefined
    let msEncendido = 0
    try {
      const pidTapon = await t.tomado
      const t0 = Date.now()
      encender = a_los(
        updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, humano).finally(() => (msEncendido = Date.now() - t0)),
        12_000,
      )
      const [pidEncender] = await esperarBloqueadosPor(pidTapon) // el encendido espera la admisión en exclusiva
      emitir = a_los(issue(x, orden.id), 12_000)
      await esperarBloqueadosPor(pidEncender) // la emisión se formó DETRÁS del encendido (cola justa), no detrás del tapón
      const r = await encender
      expect(r).toEqual({ e: expect.objectContaining({ statusCode: 409, code: 'IVA_ENCENDIDO_OCUPADO' }) })
      expect((r as { e: Error }).e.message).toBe('Hay facturas o ventas en proceso en tu organización; vuelve a intentar en un momento.')
      expect(msEncendido).toBeGreaterThanOrEqual(4_500)
      expect(msEncendido).toBeLessThan(9_000)
      // La emisión termina con el tapón TODAVÍA retenido: ya no espera al encendido.
      expect(await emitir).toEqual({ v: expect.objectContaining({ status: 'STAMPED' }) })
    } finally {
      t.soltar()
    }
    await t.tx
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('IVA_ENCENDIDO_OCUPADO'), expect.objectContaining({ venueId: x.venueId }))
    // Nada a medias: el negocio sigue apagado y el producto a 16 %; la emisión facturó al 16 %.
    expect(await encendido(x.venueId)).toBe(false)
    expect(await iva(p.id)).toBe('IVA_16')
    expect(enviados).toHaveLength(1)
    expect(enviados[0]).toMatchObject({ items: [{ taxes: [{ rate: 0.16 }] }] })
  })

  it('I-1 paso 3: con un encendido reteniendo la admisión, el POS sale con IVA_ADMISION_OCUPADA (transitorio) antes del timeout de su transacción', async () => {
    const { x } = await armar()
    await prisma.venue.update({ where: { id: x.venueId }, data: { posType: 'NONE' } })
    const externalId = `SR1:1:${randomUUID().slice(0, 8)}`
    const payload = {
      venueId: x.venueId,
      orderData: {
        externalId,
        orderNumber: externalId.split(':').pop()!,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        subtotal: 100,
        taxAmount: 16,
        discountAmount: 0,
        tipAmount: 0,
        total: 116,
        createdAt: new Date().toISOString(),
        completedAt: null,
        posRawData: { test: 'enc8-ocupada' },
      },
      staffData: { externalId: null, name: null, pin: null },
      tableData: { externalId: null },
      shiftData: { externalId: null, startTime: null },
      payments: [],
      paymentMethodsCatalog: [],
    } as unknown as RichPosPayload
    const t = admisionExclusiva(x.organizationId)
    let r: Awaited<ReturnType<typeof a_los>> | undefined
    const t0 = Date.now()
    try {
      await t.tomado
      r = await a_los(processPosOrderEvent(payload), 14_000)
    } finally {
      t.soltar()
    }
    await t.tx
    expect(r).toEqual({ e: expect.objectContaining({ statusCode: 409, code: 'IVA_ADMISION_OCUPADA' }) })
    expect(Date.now() - t0).toBeLessThan(14_000) // antes de los 15 s de su transacción (el P2028 iba a la cola muerta)
    expect(await prisma.order.count({ where: { venueId: x.venueId } })).toBe(0)
  })

  /** Un evento de orden del POS (SoftRestaurant) nuevo para el negocio. */
  const ordenDelPos = (x: Negocio, prueba: string) => {
    const externalId = `SR1:1:${randomUUID().slice(0, 8)}`
    return {
      venueId: x.venueId,
      orderData: {
        externalId,
        orderNumber: externalId.split(':').pop()!,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        subtotal: 100,
        taxAmount: 16,
        discountAmount: 0,
        tipAmount: 0,
        total: 116,
        createdAt: new Date().toISOString(),
        completedAt: null,
        posRawData: { test: prueba },
      },
      staffData: { externalId: null, name: null, pin: null },
      tableData: { externalId: null },
      shiftData: { externalId: null, startTime: null },
      payments: [],
      paymentMethodsCatalog: [],
    } as unknown as RichPosPayload
  }

  // Codex código r1 #2 (Ruling CX-2): el presupuesto del POS cubría sólo la admisión; la fila de `Organization` se pedía después SIN tope
  // (`lock_timeout` 0) y una publicación de catálogo la retiene hasta 90 s: la transacción vencía (P2028) y el evento iba a la cola muerta.
  it('CX-2: con la fila de la organización retenida (no la admisión), el POS sale con IVA_ADMISION_OCUPADA dentro de su presupuesto', async () => {
    const { x } = await armar()
    await prisma.venue.update({ where: { id: x.venueId }, data: { posType: 'NONE' } })
    const t = taponDeOrganizacion(x.organizationId)
    let r: Awaited<ReturnType<typeof a_los>> | undefined
    const t0 = Date.now()
    try {
      const pidTapon = await t.tomado
      const pos = a_los(processPosOrderEvent(ordenDelPos(x, 'cx2-organizacion')), 14_000)
      await esperarBloqueadosPor(pidTapon) // el POS ya tiene la admisión y espera la fila de la organización
      r = await pos
    } finally {
      t.soltar()
    }
    await t.tx
    expect(r).toEqual({ e: expect.objectContaining({ statusCode: 409, code: 'IVA_ADMISION_OCUPADA' }) })
    expect(Date.now() - t0).toBeLessThan(14_000) // antes de los 15 s de su transacción
    expect(await prisma.order.count({ where: { venueId: x.venueId } })).toBe(0)
  })

  // Codex código r2 N1 (Ruling CX-11): PostgreSQL aplica `lock_timeout` a CADA adquisición. Con un solo `tomarCandado` para las dos, la
  // admisión podía esperar ~6 s y la fila de la organización otros 9 s: 15 s, la transacción vencía (P2028) y el evento iba a la cola
  // muerta. Con un presupuesto compartido, la fila sólo espera lo que QUEDA de los 9 s.
  it('CX-11: espera de la admisión (~6 s) y después de la fila de la organización: IVA_ADMISION_OCUPADA al agotar los 9 s JUNTOS', async () => {
    const { x } = await armar()
    await prisma.venue.update({ where: { id: x.venueId }, data: { posType: 'NONE' } })
    const admision = admisionExclusiva(x.organizationId)
    const fila = taponDeOrganizacion(x.organizationId)
    let r: Awaited<ReturnType<typeof a_los>> | undefined
    let ms = 0
    try {
      const pidAdmision = await admision.tomado
      await fila.tomado
      const t0 = Date.now()
      const pos = a_los(
        processPosOrderEvent(ordenDelPos(x, 'cx11-acumulado')).finally(() => (ms = Date.now() - t0)),
        12_000,
      )
      await esperarBloqueadosPor(pidAdmision) // primero espera la admisión
      await new Promise(res => setTimeout(res, 6_000))
      admision.soltar() // la admisión se libera: ahora espera la fila de la organización
      r = await pos
    } finally {
      admision.soltar()
      fila.soltar()
    }
    await Promise.all([admision.tx, fila.tx])
    expect(r).toEqual({ e: expect.objectContaining({ statusCode: 409, code: 'IVA_ADMISION_OCUPADA' }) })
    expect(ms).toBeGreaterThanOrEqual(8_000) // esperó las dos
    expect(ms).toBeLessThan(10_500) // y no más que el presupuesto conjunto (9 s) con margen
    expect(await prisma.order.count({ where: { venueId: x.venueId } })).toBe(0)
  })

  // Codex código r1 #1 (Ruling CX-1): la venta de una heredada se movió a OTRA organización después del plan, y esa organización está
  // encendiendo (retiene su admisión EXCLUSIVA). Antes, el encendido de A pedía la admisión de B con la exclusiva de A en la mano: si el
  // de B pedía la de A, ciclo A↔B. Ahora no la pide: 409 de reintento al instante.
  it('CX-1: venta de una heredada movida a OTRA organización que está encendiendo ⇒ 409 IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION sin esperar su admisión', async () => {
    const { x, humano, p } = await armar()
    const otra = await nuevoNegocio({ contabilidad: false })
    negocios.push(otra)
    const venta = await ventaPagada(x, p.id)
    await heredada(x, venta.id)
    const plan = await planDeSelladoHeredado(x.venueId, { reparar: SIN_REPARAR })
    expect(plan.sellables.map(s => s.orderId)).toEqual([venta.id])
    await prisma.order.update({ where: { id: venta.id }, data: { venueId: otra.venueId } })
    try {
      const t = admisionExclusiva(otra.organizationId) // el encendido de B, en curso
      let r: Awaited<ReturnType<typeof a_los>> | undefined
      try {
        await t.tomado
        r = await a_los(
          prisma.$transaction(
            tx => encenderBajoCandados(tx, { venueId: x.venueId, productId: p.id, plan, staffId: humano.staffId, origen: 'DASHBOARD' }),
            { timeout: 30_000 },
          ),
          4_000,
        )
      } finally {
        t.soltar()
      }
      await t.tx
      expect(r).toEqual({ e: expect.objectContaining({ statusCode: 409, code: 'IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION' }) })
      expect(await encendido(x.venueId)).toBe(false)
      expect(await prisma.orderItemSelloIva.count({ where: { orderItem: { orderId: venta.id } } })).toBe(0)
    } finally {
      // La limpieza borra los sellos por la sede de la orden: de vuelta a la suya, para que no queden sellos de una factura borrada.
      await prisma.order.update({ where: { id: venta.id }, data: { venueId: x.venueId } })
    }
  })

  // Codex código r1 #1 (Ruling CX-1): la factura es de A y su venta hoy vive en B. La cancelación tomaba sólo la admisión de B y podía
  // anotar REQUESTED después de que el encendido de A revisó «documentos en vuelo». Ahora espera también la de A.
  it('CX-1: cancelar una factura de A cuya venta vive en B espera la admisión de A (un encendido de A en curso la retiene)', async () => {
    const { x, p } = await armar()
    const otra = await nuevoNegocio({ contabilidad: false })
    negocios.push(otra)
    const orden = await ventaPagada(x, p.id)
    expect((await issue(x, orden.id)).status).toBe('STAMPED')
    const cfdi = await prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: `cfdi-order-${orden.id}` } })
    await prisma.order.update({ where: { id: orden.id }, data: { venueId: otra.venueId } })
    try {
      const t = admisionExclusiva(x.organizationId) // el encendido de A, en curso
      let cancelar: Promise<unknown> | undefined
      try {
        const pidTapon = await t.tomado
        cancelar = anotarIntencionDeCancelar(cfdi.id, cfdi.attempts, { motivo: '02' })
        expect(await a_los(cancelar, 2_000)).toBe('sigue esperando') // no anota nada mientras A está retenida
        await esperarBloqueadosPor(pidTapon) // y lo que espera es justo la admisión de A
        expect((await prisma.cfdi.findUniqueOrThrow({ where: { id: cfdi.id } })).cancelStatus).toBeNull()
      } finally {
        t.soltar()
      }
      await t.tx
      expect(await cancelar).toEqual({ estado: 'ANOTADA', intento: 1 })
    } finally {
      await prisma.order.update({ where: { id: orden.id }, data: { venueId: x.venueId } }) // como arriba: la limpieza va por sede
    }
  })

  // Ruling T8-a (Review Focus 2, «Tarea 8 (real)»): la relectura de la bandera bajo la admisión exclusiva, con la competencia GARANTIZADA.
  it('dos guardados que encienden el mismo negocio a la vez: uno enciende; el otro espera la admisión, ve la bandera y sigue', async () => {
    const { x, humano: autorA, p } = await armar()
    const autorB = await dueno(x.venueId) // otro dueño: así se ve de quién es cada escritura
    const q = await productoDe(x, 'Fruta')
    const t = taponDeOrganizacion(x.organizationId)
    let guardadoA: Promise<unknown> | undefined
    let guardadoB: Promise<unknown> | undefined
    try {
      const pidTapon = await t.tomado
      guardadoA = updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, autorA)
      const [pidA] = await esperarBloqueadosPor(pidTapon) // A ya tiene la admisión exclusiva y pide la organización
      guardadoB = updateProduct(x.venueId, q.id, { ivaTratamiento: 'EXENTO' } as any, autorB)
      await esperarBloqueadosPor(pidA) // B, también apagado al prepararse, espera la admisión exclusiva que tiene A
    } finally {
      t.soltar()
    }
    const [a, b] = await Promise.allSettled([guardadoA, guardadoB])
    await t.tx
    sinBloqueoMutuo(a)
    sinBloqueoMutuo(b)
    // El resultado entero y no `.status`: si alguno se rechazó (P2002, 409), el fallo enseña el motivo.
    expect(a).toEqual({ status: 'fulfilled', value: expect.anything() })
    expect(b).toEqual({ status: 'fulfilled', value: expect.anything() })
    expect([await iva(p.id), await iva(q.id)]).toEqual(['IVA_0', 'EXENTO'])
    // UNA bandera y UNA activación, las de A; B guardó como negocio encendido y dejó sólo su cambio.
    expect(await prisma.venueIvaPorProducto.findMany({ where: { venueId: x.venueId }, select: { habilitadoPorStaffId: true } })).toEqual([
      { habilitadoPorStaffId: autorA.staffId },
    ])
    const bitacora = (action: string) =>
      prisma.activityLog.findMany({ where: { venueId: x.venueId, action }, select: { staffId: true, entityId: true, data: true } })
    expect(await bitacora('IVA_POR_PRODUCTO_ACTIVADO')).toEqual([
      expect.objectContaining({ staffId: autorA.staffId, data: expect.objectContaining({ productoId: p.id }) }),
    ])
    const cambios = await bitacora('PRODUCT_IVA_CHANGED')
    expect(cambios).toHaveLength(2)
    expect(cambios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ staffId: autorA.staffId, entityId: p.id }),
        expect.objectContaining({
          staffId: autorB.staffId,
          entityId: q.id,
          data: expect.objectContaining({ antes: { ivaTratamiento: 'IVA_16' }, despues: { ivaTratamiento: 'EXENTO' } }),
        }),
      ]),
    )
  })
})
