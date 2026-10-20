/**
 * La factura global y las ventas DEVUELTAS COMPLETAS (QA de la guía de Facturación, 14-oct): la global del 13-oct de la copia QA metió por
 * sus $174 una venta que ya se había devuelto completa ANTES de emitirse. La regla es la de F6 (decisión 1 del founder, 12-oct): devuelta
 * completa ⇒ no se factura. Aquí, contra una base de pruebas propia y con el camino REAL de la devolución (`issueRefund` del dashboard):
 * - la devuelta completa no entra a la global y sale en «ventas fuera de la global» (y en el MCP) con su motivo propio;
 * - la devuelta en PARTE sigue como hoy: entra por todo lo cobrado (su devolución se acredita con la nota contra la global, C2);
 * - la decisión se toma con lo leído BAJO el candado que la global toma de sus órdenes: una devolución que hace commit mientras la global
 *   espera ese candado también se ve;
 * - la devolución que llega DESPUÉS de timbrar no mueve la global (eso lo cubre la nota de crédito contra ella).
 * El PAC es SIEMPRE un doble de prueba (Facturapi nunca real).
 */
jest.mock('@/services/access/access.service', () => ({ hasPermission: jest.fn(() => true) }))
jest.mock('@/services/access/basePlan.service', () => ({ venuesWithFeatureAccess: jest.fn(async (ids: string[]) => new Set(ids)) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/mcp/guard', () => ({ createGuard: () => ({ venueFilter: jest.fn(), requirePermission: jest.fn() }) }))
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))
jest.mock('@/services/storage.service', () => ({
  ...jest.requireActual('@/services/storage.service'),
  uploadFileToStorage: jest.fn(async () => 'https://test/file'),
}))
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { issueGlobalForEmisor, listarExcluidasDeLaGlobal, vistaPreviaPrincipal } from '@/services/fiscal/cfdiGlobal.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { getRefundCreditNoteStatus } from '@/services/fiscal/cfdiCreditNote.service'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import { registerCfdiTools } from '@/mcp/tools/cfdi'
import type { McpScope } from '@/mcp/scope'
import { xmlDeLaFila } from '../../__helpers__/xml-del-pac'
import { encenderIvaPorProducto } from '../../__helpers__/iva-por-producto'
import { TOPES_POR_ORDEN } from '@/services/fiscal/librosDeOrdenes'
import { ProviderHttpError } from '@/services/fiscal/providers/facturapi.provider'

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
/** El texto que ve quien factura (pantalla y MCP): qué pasó, en español llano. */
const TEXTO_DEVUELTA = 'Se devolvió completa antes de emitir la factura global: no hay nada que facturar.'
const valid = () => ({
  providerInvoiceId: randomUUID(),
  uuid: randomUUID(),
  serie: 'G',
  folio: String(Math.floor(Math.random() * 1e6)),
  totalCents: 0,
  stampedAt: new Date(),
  status: 'valid' as const,
})

describe('La factura global no incluye una venta devuelta completa', () => {
  const fixture = `global-devuelta-${randomUUID()}`
  const m1 = fixture
  let venueId: string
  let p16: string
  let fiscalEmisorId: string
  const provider = {
    name: 'facturapi',
    createInvoice: jest.fn(),
    createGlobalInvoice: jest.fn(),
    createCreditNote: jest.fn(),
    cancelInvoice: jest.fn(),
    findByExternalId: jest.fn(),
    getInvoice: jest.fn(),
    downloadXml: jest.fn(),
    downloadPdf: jest.fn(),
  }
  // El MCP `global_invoice_excluded_sales` con su handler real (guard, permisos y plan, de prueba).
  const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
    venueId = (await prisma.venue.create({ data: { id: fixture, organizationId: fixture, name: fixture, slug: fixture } })).id
    await encenderIvaPorProducto(venueId)
    const category = await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })
    p16 = (await prisma.product.create({ data: { venueId, categoryId: category.id, name: fixture, sku: fixture, price: 116 } })).id
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
    await prisma.merchantAccount.create({ data: { id: m1, providerId: fixture, externalMerchantId: m1, credentialsEncrypted: {} } })
    await prisma.merchantFiscalConfig.create({
      data: { merchantAccountId: m1, fiscalEmisorId, facturacionEnabled: true, autofacturaEnabled: true, includeInGlobal: true },
    })
    const reg = { tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never
    registerCfdiTools(reg, { staffId: 's1', activeOrg: fixture, allowedVenueIds: [venueId], perVenueAccess: new Map() } as McpScope)
  })

  async function limpiarVentas() {
    if (!venueId) return
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.orderItemSelloIva.deleteMany({ where: { cfdi: { venueId } } })
    await prisma.cfdiGlobalOrden.deleteMany({ where: { cfdi: { venueId } } })
    await prisma.cfdi.deleteMany({ where: { venueId } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
  }
  beforeEach(async () => {
    await limpiarVentas()
    jest.clearAllMocks()
    for (const f of Object.values(provider)) if (typeof f === 'function') (f as jest.Mock).mockReset()
    jest.mocked(resolveFiscalProvider).mockReturnValue(provider as any)
    provider.createGlobalInvoice.mockImplementation(async () => valid())
    provider.findByExternalId.mockResolvedValue(null)
    provider.downloadXml.mockImplementation(async (id: string) => xmlDeLaFila(prisma, id))
    provider.downloadPdf.mockResolvedValue(Buffer.from('%PDF'))
  })
  afterEach(() => jest.restoreAllMocks())
  afterAll(async () => {
    if (!venueId) return
    await limpiarVentas()
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisorId } })
    await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
    await prisma.merchantAccount.deleteMany({ where: { id: m1 } })
    await prisma.paymentProvider.deleteMany({ where: { id: fixture } })
    await prisma.venue.delete({ where: { id: venueId } })
    await prisma.organization.delete({ where: { id: fixture } })
  })

  /** Una venta de mayo ($116 + $58 = $174, como la de la QA), cobrada en mostrador con el comercio m1: entra a la global de mayo. */
  async function venta() {
    return prisma.order.create({
      data: {
        venueId,
        orderNumber: `F-${randomUUID().slice(0, 8)}`,
        subtotal: 174,
        taxAmount: 0,
        total: 174,
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        items: {
          create: [
            { productId: p16, productName: 'Comida', quantity: 1, unitPrice: 116, taxAmount: 0, total: 116 },
            { productId: p16, productName: 'Pan', quantity: 1, unitPrice: 58, taxAmount: 0, total: 58 },
          ],
        },
        payments: {
          create: {
            venueId,
            merchantAccountId: m1,
            amount: 174,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: 174,
            method: 'CASH',
            status: 'COMPLETED',
            createdAt: MAYO,
          },
        },
      },
      include: { items: true, payments: true },
    })
  }
  type Venta = Awaited<ReturnType<typeof venta>>
  /** La devolución por el camino REAL del dashboard (`issueRefund`): por artículos, sin propina. */
  const devolver = (v: Venta, cuales: Array<'Comida' | 'Pan'>) =>
    issueRefund({
      venueId,
      paymentId: v.payments[0].id,
      items: cuales.map(n => ({ orderItemId: v.items.find(i => i.productName === n)!.id })),
      reason: 'RETURNED_GOODS',
    })
  const emitir = () => issueGlobalForEmisor({ emisorId: fiscalEmisorId, now: NOW, sandbox: true })
  const listar = () => listarExcluidasDeLaGlobal({ venueId, emisorId: fiscalEmisorId, now: NOW })
  /** El MCP lee con el reloj real: el periodo se le da por la global (`principalCfdiId`, su periodo guardado). */
  const mcp = async (principalCfdiId: string) =>
    JSON.parse((await handlers.get('global_invoice_excluded_sales')!({ venueId, principalCfdiId }, {})).content[0].text)

  it('🔴 devuelta completa ANTES de emitir: no entra a la global (y lo dice el MCP); la intacta y la devuelta en parte sí, por todo lo cobrado (como hoy)', async () => {
    const intacta = await venta()
    const devuelta = await venta()
    const parcial = await venta()
    expect((await devolver(devuelta, ['Comida', 'Pan'])).amount).toBe(174)
    const rParcial = await devolver(parcial, ['Pan'])
    expect(rParcial.amount).toBe(58)
    // El escritor real deja la orden PAGADA (no la marca devuelta) y escribe un `Payment` REFUND aparte: la global no puede fiarse del estado.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: devuelta.id } })).paymentStatus).toBe('PAID')

    // La vista previa (MCP `emit_global_invoice`) ya no cuenta la devuelta entre las que entrarían.
    const periodo = (await listar()).periodo
    expect(
      (await vistaPreviaPrincipal({ venueId, emisorId: fiscalEmisorId, desde: periodo.desde.toISOString(), now: NOW })).ventas,
    ).toEqual({
      n: 2,
      completo: true,
    })

    const g = await emitir()
    expect(g.status).toBe('STAMPED')
    expect(g.excluidas).toEqual({ DEVUELTA: 1 })
    const fila = await prisma.cfdi.findUniqueOrThrow({ where: { id: g.cfdi.id } })
    const entrada = fila.entrada as any
    expect(entrada.ordenes.map((o: any) => o.orderId).sort()).toEqual([intacta.id, parcial.id].sort())
    // La parcial, como hoy: por TODO lo cobrado ($174); su devolución de $58 va en la nota de crédito contra la global (C2).
    expect(entrada.ordenes.find((o: any) => o.orderId === parcial.id).paidCents).toBe(17400)
    expect(fila.totalCents).toBe(34800)
    // …y su devolución se acredita como hoy: con la nota de crédito contra ESTA global, que ofrece el panel del reembolso (o el MCP).
    expect(await getRefundCreditNoteStatus(venueId, rParcial.refundId)).toMatchObject({
      eligibility: { eligible: true },
      preview: { facturaOriginal: { esGlobal: true, uuid: fila.uuid } },
    })
    expect(entrada.excluidas).toEqual({ DEVUELTA: 1 })
    const manifiesto = await prisma.cfdiGlobalOrden.findMany({ where: { cfdiId: fila.id }, select: { orderId: true } })
    expect(manifiesto.map(m => m.orderId).sort()).toEqual([intacta.id, parcial.id].sort())
    expect(JSON.stringify(provider.createGlobalInvoice.mock.calls[0][0].items)).not.toContain(devuelta.orderNumber)
    expect(await prisma.orderItemSelloIva.count({ where: { orderItem: { orderId: devuelta.id } } })).toBe(0)

    // Sigue fuera después de timbrar: con su motivo, nunca como «corregida después» (no hay complementaria que emitir por ella).
    const despues = await listar()
    expect(despues.excluidas).toEqual([
      expect.objectContaining({ orderId: devuelta.id, folio: devuelta.orderNumber, motivo: 'DEVUELTA', texto: TEXTO_DEVUELTA }),
    ])
    expect(despues.totales!.porMotivo).toEqual({ DEVUELTA: 1 })
    expect(despues.corregidasPendientes).toEqual({ n: 0, completo: true })
    // El MCP `global_invoice_excluded_sales` comparte la función: el mismo motivo y el mismo texto.
    const porMcp = await mcp(fila.id)
    expect(porMcp.ok).toBe(true)
    expect(porMcp.ventas).toEqual([
      expect.objectContaining({ orderId: devuelta.id, motivo: 'DEVUELTA', texto: TEXTO_DEVUELTA, cobradoMxn: 174 }),
    ])
    expect(porMcp.totales.porMotivo).toEqual({ DEVUELTA: 1 })
  })

  it('🔴 la devuelta completa aparece en «ventas fuera de la global» con su motivo propio (antes de emitir)', async () => {
    const intacta = await venta()
    const devuelta = await venta()
    await devolver(devuelta, ['Comida', 'Pan'])

    const r = await listar()
    expect(r.excluidas).toEqual([
      {
        orderId: devuelta.id,
        folio: devuelta.orderNumber,
        cobradoCents: 17400,
        motivo: 'DEVUELTA',
        texto: TEXTO_DEVUELTA,
        detalle: TEXTO_DEVUELTA,
      },
    ])
    expect(r.totales).toMatchObject({ porMotivo: { DEVUELTA: 1 }, total: 1, completo: true })
    expect(r.excluidas.map(x => x.orderId)).not.toContain(intacta.id)
  })

  it('🔴 sólo la devuelta: la global no tiene nada que facturar (sin PAC), y lo dice por qué', async () => {
    const devuelta = await venta()
    await devolver(devuelta, ['Pan'])
    await devolver(devuelta, ['Comida']) // dos devoluciones que juntas cubren lo cobrado
    const g = await emitir()
    expect(g).toMatchObject({ status: 'NOTHING_TO_INVOICE', excluidas: { DEVUELTA: 1 } })
    expect(provider.createGlobalInvoice).not.toHaveBeenCalled()
    expect(await prisma.cfdi.count({ where: { venueId } })).toBe(0)
  })

  it('🔴 ruling GD-1: por ENCIMA del tope de movimientos (2,001 devoluciones chicas que suman lo cobrado) también queda fuera', async () => {
    const intacta = await venta()
    const devuelta = await venta()
    // 2,000 de $0.08 + una de $14.00 = $174.00, en 2,001 movimientos: uno más que el tope de una orden.
    expect(TOPES_POR_ORDEN.movimientos).toBe(2000)
    await prisma.payment.createMany({
      data: Array.from({ length: 2001 }, (_, i) => {
        const pesos = i < 2000 ? 0.08 : 14
        return {
          venueId,
          orderId: devuelta.id,
          type: 'REFUND' as const,
          amount: -pesos,
          tipAmount: 0,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: -pesos,
          method: 'CASH' as const,
          status: 'COMPLETED' as const,
        }
      }),
    })
    const g = await emitir()
    expect(g).toMatchObject({ status: 'STAMPED', excluidas: { DEVUELTA: 1 } })
    expect(((await prisma.cfdi.findUniqueOrThrow({ where: { id: g.cfdi.id } })).entrada as any).ordenes.map((o: any) => o.orderId)).toEqual(
      [intacta.id],
    )
    expect((await listar()).excluidas).toEqual([expect.objectContaining({ orderId: devuelta.id, motivo: 'DEVUELTA' })])
  })

  it('🔴 recaptura: la global rechazada se vuelve a capturar SIN la venta que se devolvió completa entre un intento y otro', async () => {
    const a = await venta()
    const b = await venta()
    provider.createGlobalInvoice.mockRejectedValueOnce(new ProviderHttpError(400, 'invalid_request', 'bad'))
    await emitir().catch(() => undefined)
    const antes = await prisma.cfdi.findFirstOrThrow({ where: { venueId, isGlobal: true } })
    expect(antes).toMatchObject({ falloDefinitivo: true, attempts: 1 })
    expect((antes.entrada as any).ordenes.map((o: any) => o.orderId).sort()).toEqual([a.id, b.id].sort())
    await devolver(a, ['Comida', 'Pan'])
    const g = await emitir()
    expect(g).toMatchObject({ status: 'STAMPED', excluidas: { DEVUELTA: 1 }, cfdi: { id: antes.id } })
    expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: antes.id } })).toMatchObject({ attempts: 2, totalCents: 17400 })
    expect((await prisma.cfdiGlobalOrden.findMany({ where: { cfdiId: antes.id } })).map(m => m.orderId)).toEqual([b.id])
    expect(JSON.stringify(provider.createGlobalInvoice.mock.calls[1][0].items)).not.toContain(a.orderNumber)
  })

  // Ruling GD-2: lo que el agregado de `devueltasCompletas` NO cuenta. Cada venta ($174) sigue entrando a la global por su total.
  /** Un REFUND escrito directo (la venta en `amount`, la propina aparte en `tipAmount`, ambas negativas), con el estado que se pida. */
  const reembolsoDirecto = (orderId: string, pesos: number, propina: number, status: 'COMPLETED' | 'PENDING' | 'FAILED' = 'COMPLETED') =>
    prisma.payment.create({
      data: {
        venueId,
        orderId,
        type: 'REFUND',
        amount: -pesos,
        tipAmount: -propina,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -(pesos + propina),
        method: 'CASH',
        status,
      },
    })
  it.each([
    [
      '(a) parcial cuya propina completa lo cobrado ($58 de venta + $116 de propina): la propina no cuenta',
      (id: string) => reembolsoDirecto(id, 58, 116),
    ],
    ['(b) sólo de propina ($0 de venta, $174 de propina)', (id: string) => reembolsoDirecto(id, 0, 174)],
    [
      '(c) por el total pero PENDING y otra FAILED: sólo cuenta COMPLETED',
      async (id: string) => {
        await reembolsoDirecto(id, 174, 0, 'PENDING')
        await reembolsoDirecto(id, 174, 0, 'FAILED')
      },
    ],
  ])('🔴 GD-2 · %s ⇒ sigue entrando a la global por su total', async (_caso, devolver: (orderId: string) => Promise<unknown>) => {
    const v = await venta()
    await devolver(v.id)
    const g = await emitir()
    expect([g.status, g.excluidas]).toEqual(['STAMPED', {}])
    const entrada = (await prisma.cfdi.findUniqueOrThrow({ where: { id: g.cfdi.id } })).entrada as any
    expect(entrada.ordenes.map((o: any) => [o.orderId, o.paidCents])).toEqual([[v.id, 17400]])
    expect((await listar()).excluidas).toEqual([])
  })

  it('🔴 carrera: la devolución completa que hace commit MIENTRAS la global espera el candado de la orden también se ve', async () => {
    const intacta = await venta()
    const devuelta = await venta()
    // 1. La devolución toma el `FOR UPDATE` de la orden (como `lockExistingOrderForPayment`), escribe su REFUND y se queda abierta.
    let soltar!: () => void
    const esperaSoltar = new Promise<void>(r => (soltar = r))
    let avisarTomado!: (pid: number) => void
    const tomado = new Promise<number>(r => (avisarTomado = r))
    const tx = prisma.$transaction(
      async db => {
        const [{ pid }] = await db.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        await db.$queryRaw`SELECT id FROM "Order" WHERE id = ${devuelta.id} FOR UPDATE`
        await db.payment.create({
          data: {
            venueId,
            orderId: devuelta.id,
            type: 'REFUND',
            amount: -174,
            tipAmount: 0,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: -174,
            method: 'CASH',
            status: 'COMPLETED',
          },
        })
        avisarTomado(pid)
        await esperaSoltar
      },
      { timeout: 30_000, maxWait: 10_000 },
    )
    try {
      const pidDevolucion = await tomado
      // 2. La global arranca y espera el candado: alguien quedó bloqueado POR la transacción de la devolución (`pg_blocking_pids`).
      const enCurso = emitir().then(
        v => ({ ok: true as const, v }),
        e => ({ ok: false as const, e }),
      )
      let esperando = false
      for (let i = 0; i < 200 && !esperando; i++) {
        const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity a WHERE ${pidDevolucion}::int = ANY(pg_blocking_pids(a.pid))`
        esperando = n > 0
        if (!esperando) await new Promise(r => setTimeout(r, 25))
      }
      expect(esperando).toBe(true)
      // 3. La devolución hace commit; la global obtiene el candado, la ve y la deja fuera.
      soltar()
      await tx
      const r = await enCurso
      expect(r).toMatchObject({ ok: true, v: { status: 'STAMPED', excluidas: { DEVUELTA: 1 } } })
      const entrada = (await prisma.cfdi.findFirstOrThrow({ where: { venueId, isGlobal: true } })).entrada as any
      expect(entrada.ordenes.map((o: any) => o.orderId)).toEqual([intacta.id])
    } finally {
      soltar() // nunca deja la transacción de la devolución abierta, aunque una aserción falle
      await tx.catch(() => undefined)
    }
  })

  it('control — la devolución que llega DESPUÉS de timbrar no mueve la global (la cubre la nota de crédito contra ella)', async () => {
    const v = await venta()
    const g = await emitir()
    expect(g.status).toBe('STAMPED')
    const antes = await prisma.cfdi.findUniqueOrThrow({ where: { id: g.cfdi.id } })
    await devolver(v, ['Comida', 'Pan'])
    const otra = await emitir()
    expect(otra).toMatchObject({ status: 'STAMPED', cfdi: { id: antes.id } })
    const ahora = await prisma.cfdi.findUniqueOrThrow({ where: { id: antes.id } })
    expect([ahora.entradaHuella, ahora.totalCents, ahora.status]).toEqual([antes.entradaHuella, 17400, 'STAMPED'])
    expect((await prisma.cfdiGlobalOrden.findMany({ where: { cfdiId: antes.id } })).map(m => m.orderId)).toEqual([v.id])
    expect(provider.createGlobalInvoice).toHaveBeenCalledTimes(1)
    // Está en una global viva: no es una venta «fuera de la global».
    expect((await listar()).excluidas).toEqual([])
  })
})
