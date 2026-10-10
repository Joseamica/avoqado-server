/**
 * IVA por producto, bloque C2 (Tarea 8), contra una base de pruebas propia: la nota de crédito de un ticket que entró en la factura GLOBAL.
 * - la nota va relacionada con la global (01), a Público en General (XAXX010101000 / 616 / CP de la global), uso G02, PUE, sin el bloque
 *   `InformacionGlobal` (veredicto G02_SIN_BLOQUE de la Tarea 1), con `NoIdentificacion` = el folio del ticket (lo garantizamos nosotros: el
 *   PAC no lo coteja);
 * - el saldo del ticket sale de la asignación de TODA la global (Codex C2-10) y la nota también tiene que caber en lo que queda del
 *   documento entero (C2-3); dos notas de tickets distintos se serializan sobre la fila de la global (`FOR UPDATE`);
 * - una venta que entró en una COMPLEMENTARIA tiene su nota contra ella (C1, I2); la global sin su XML espera y lo pide (C2-13).
 * El PAC es SIEMPRE un doble de prueba (Facturapi nunca real); su `downloadXml` arma el XML de lo que se le mandó (`xmlDeLaFila`).
 */
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))
jest.mock('@/services/storage.service', () => ({
  ...jest.requireActual('@/services/storage.service'),
  uploadFileToStorage: jest.fn(async () => 'https://test/file'),
}))
import { Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { emitirGlobalComplementaria, issueGlobalForEmisor } from '@/services/fiscal/cfdiGlobal.service'
import {
  acreditadoContra,
  emitRefundCreditNote,
  getRefundCreditNoteStatus,
  MOTIVO_ORIGINAL_EN_CANCELACION,
  MOTIVO_GLOBAL_CANCELADA,
  olvidarGlobalesEvaluadas,
} from '@/services/fiscal/cfdiCreditNote.service'
import * as servicioDeGlobal from '@/services/fiscal/cfdiGlobal.service'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import { huellaDeEntrada } from '@/services/fiscal/entradaDocumental'
import { xmlDeLaFila } from '../../__helpers__/xml-del-pac'
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
const PUBLICO_EN_GENERAL = {
  rfc: 'XAXX010101000',
  razonSocial: 'PÚBLICO EN GENERAL',
  regimenFiscal: '616',
  codigoPostal: '01000',
  usoCfdi: 'G02',
}
const IVA = (rate: number) => [{ type: 'IVA', factor: 'Tasa', rate, withholding: false }]
const valid = () => ({
  providerInvoiceId: randomUUID(),
  uuid: randomUUID(),
  serie: 'G',
  folio: String(Math.floor(Math.random() * 1e6)),
  totalCents: 0,
  stampedAt: new Date(),
  status: 'valid' as const,
})

/** Sondea cada 20 ms hasta 5 s. */
async function esperarHasta(fn: () => Promise<boolean>) {
  for (let i = 0; i < 250; i++) {
    if (await fn()) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('esperarHasta: no se cumplió en 5 s')
}
/**
 * ¿Otra transacción tiene tomada la fila `id` de "Cfdi" (`FOR UPDATE`)? Se pregunta por ESA fila con `SKIP LOCKED` desde otra conexión: si
 * vuelve vacía, alguien la tiene. No espera ni se queda con nada (la transacción de la sonda termina en el acto).
 */
async function bloqueosSobre(id: string): Promise<number> {
  const libres = await prisma.$transaction(
    tx => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Cfdi" WHERE id = ${id} FOR UPDATE SKIP LOCKED`,
  )
  return libres.length ? 0 : 1
}

describe('C2 · Tarea 8 — la nota de un ticket que entró en la factura global', () => {
  const fixture = `nota-global-${randomUUID()}`
  const m1 = fixture
  let venueId: string
  let p16: string
  let p0: string
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
        data: { venueId, categoryId: category.id, name: `${fixture}-0`, sku: `${fixture}-0`, price: 200, ivaTratamiento: 'IVA_0' },
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
    await prisma.merchantAccount.create({ data: { id: m1, providerId: fixture, externalMerchantId: m1, credentialsEncrypted: {} } })
    await prisma.merchantFiscalConfig.create({
      data: { merchantAccountId: m1, fiscalEmisorId, facturacionEnabled: true, autofacturaEnabled: true, includeInGlobal: true },
    })
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
    await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { includeInGlobal: true } })
    await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { lugarExpedicion: '01000' } })
    olvidarGlobalesEvaluadas()
    jest.clearAllMocks()
    for (const f of Object.values(provider)) if (typeof f === 'function') (f as jest.Mock).mockReset()
    jest.mocked(resolveFiscalProvider).mockReturnValue(provider as any)
    provider.createInvoice.mockImplementation(async () => valid())
    provider.createGlobalInvoice.mockImplementation(async () => valid())
    provider.createCreditNote.mockImplementation(async () => valid())
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

  /** Una venta de mayo cobrada con tarjeta del comercio m1 (entra a la global de mayo); su folio es su `orderNumber`. */
  async function venta(renglones: Array<{ productId: string; precio: number }>) {
    const total = renglones.reduce((s, r) => s + r.precio, 0)
    return prisma.order.create({
      data: {
        venueId,
        orderNumber: `F-${randomUUID().slice(0, 8)}`,
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
          create: {
            venueId,
            merchantAccountId: m1,
            amount: total,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: total,
            method: 'CREDIT_CARD',
            status: 'COMPLETED',
            createdAt: MAYO,
          },
        },
      },
      include: { items: true },
    })
  }
  /** La global de mayo, timbrada con el doble del PAC (y con su XML: `completarArchivos` escribe `xmlConceptos`). */
  async function laGlobal() {
    const g = await issueGlobalForEmisor({ emisorId: fiscalEmisorId, now: NOW, sandbox: true })
    expect(g.status).toBe('STAMPED')
    const fila = await prisma.cfdi.findUniqueOrThrow({ where: { id: g.cfdi.id } })
    expect(fila.xmlConceptos).not.toBeNull()
    return fila
  }
  /** Un reembolso (con tarjeta) de `cents` de esa venta; con `articulos`, por artículos (`processorData.refundedItems`). */
  async function reembolso(orderId: string, cents: number, articulos?: Array<[string, number]>) {
    return prisma.payment.create({
      data: {
        venueId,
        orderId,
        type: 'REFUND',
        amount: -cents / 100,
        tipAmount: 0,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -cents / 100,
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        ...(articulos
          ? { processorData: { refundedItems: articulos.map(([orderItemId, amountCents]) => ({ orderItemId, amountCents })) } }
          : {}),
      },
    })
  }
  const emit = (id: string, over = {}) => emitRefundCreditNote({ venueId, refundPaymentId: id, sandbox: true }, over)
  const nota = (refundId: string) => prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: `cfdi-refund-${refundId}` } })

  it('🔴 la nota del pan del ticket mezclado sale relacionada con la global: Público en General, G02, PUE, NoIdentificacion = folio; luego el café al 0 %; un peso más no cabe', async () => {
    const todo16 = await venta([{ productId: p16, precio: 116 }])
    const mezclado = await venta([
      { productId: p0, precio: 200 },
      { productId: p16, precio: 58 },
    ])
    const global = await laGlobal()
    expect((global.entrada as any).ordenes.map((o: any) => o.orderId).sort()).toEqual([todo16.id, mezclado.id].sort())
    // d-1: el dueño apaga «incluir en la global» DESPUÉS; la devolución de un ticket que ya está en una global viva merece su nota igual.
    await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { includeInGlobal: false } })
    const pan = mezclado.items.find(i => i.productId === p16)!
    const r1 = await reembolso(mezclado.id, 5800, [[pan.id, 5800]])
    const logAction = jest.fn()
    expect((await emit(r1.id, { logAction })).status).toBe('STAMPED')
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    const enviado = provider.createCreditNote.mock.calls[0][0]
    expect(enviado.receptor).toEqual(PUBLICO_EN_GENERAL) // sin correo: el Público en General no tiene
    expect(enviado).toMatchObject({ metodoPago: 'PUE', formaPago: '04', relationship: '01', relatedUuids: [global.uuid] })
    expect('global' in enviado).toBe(false) // G02_SIN_BLOQUE (Tarea 1)
    expect(enviado.items).toEqual([
      expect.objectContaining({
        satProductKey: '84111506',
        satUnitKey: 'ACT',
        unitPriceCents: 5800,
        sku: mezclado.orderNumber,
        taxes: IVA(0.16),
      }),
    ])
    const n1 = await nota(r1.id)
    expect(n1).toMatchObject({
      status: 'STAMPED',
      orderId: mezclado.id,
      receptorRfc: 'XAXX010101000',
      receptorNombre: 'PÚBLICO EN GENERAL',
      receptorRegimen: '616',
      receptorCp: '01000',
      usoCfdi: 'G02',
      metodoPago: 'PUE',
      totalCents: 5800,
    })
    expect(n1.entrada).toMatchObject({
      version: 2,
      originalEsGlobal: true,
      folio: mezclado.orderNumber,
      originalCfdiId: global.id,
      originalUuid: global.uuid,
      modalidad: 'POR_ARTICULOS',
      redondeo: [],
    })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CFDI_CREDIT_NOTE_ISSUED',
        data: expect.objectContaining({ originalEsGlobal: true, relatedCfdiId: global.id, modalidad: 'POR_ARTICULOS' }),
      }),
    )
    // El café, por su saldo, al 0 %; la vista previa dice que la original es una global.
    const cafe = mezclado.items.find(i => i.productId === p0)!
    const r2 = await reembolso(mezclado.id, 20000, [[cafe.id, 20000]])
    expect(await getRefundCreditNoteStatus(venueId, r2.id)).toMatchObject({
      eligibility: { eligible: true },
      preview: {
        facturaOriginal: { esGlobal: true, uuid: global.uuid },
        receptor: { rfc: 'XAXX010101000', nombre: 'PÚBLICO EN GENERAL' },
        usoCfdi: 'G02',
        desglose: [{ tratamiento: 'IVA_0', cents: 20000, baseCents: 20000, ivaCents: 0 }],
      },
    })
    expect((await emit(r2.id)).status).toBe('STAMPED')
    expect(provider.createCreditNote.mock.calls[1][0].items).toEqual([
      expect.objectContaining({ unitPriceCents: 20000, sku: mezclado.orderNumber, taxes: IVA(0) }),
    ])
    // Las dos notas se leen (v2, por tratamiento): ninguna cae a «desconocido».
    expect(await acreditadoContra(prisma, { venueId, orderId: mezclado.id, originalCfdiId: global.id })).toMatchObject({
      notas: [
        { IVA_16: { baseCents: 5000, ivaCents: 800, totalCents: 5800 } },
        { IVA_0: { baseCents: 20000, ivaCents: 0, totalCents: 20000 } },
      ],
      desconocidoCents: 0,
    })
    // Un peso más del MISMO ticket no cabe, aunque la global tenga de sobra (el ticket de $116 sigue intacto).
    const r3 = await reembolso(mezclado.id, 100)
    expect((await getRefundCreditNoteStatus(venueId, r3.id))!.eligibility).toMatchObject({ eligible: false, reason: 'EXCEEDS_REMAINING' })
    await expect(emit(r3.id)).rejects.toThrow('Ya no queda nada por acreditar de este ticket en la factura global.')
    expect(await prisma.cfdi.count({ where: { idempotencyKey: `cfdi-refund-${r3.id}` } })).toBe(0)
    // El otro ticket sí: su saldo es el suyo.
    const r4 = await reembolso(todo16.id, 11600)
    expect((await emit(r4.id)).status).toBe('STAMPED')
    expect(provider.createCreditNote).toHaveBeenCalledTimes(3)
  })

  it('🔴 con la global en cancelación en trámite ⇒ ORIGINAL_CANCEL_PENDING, sin reservar nada', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const global = await laGlobal()
    await prisma.cfdi.update({ where: { id: global.id }, data: { cancelStatus: 'REQUESTED' } })
    const r = await reembolso(t.id, 1000)
    expect((await getRefundCreditNoteStatus(venueId, r.id))!.eligibility).toMatchObject({ reason: 'ORIGINAL_CANCEL_PENDING' })
    await expect(emit(r.id)).rejects.toThrow(MOTIVO_ORIGINAL_EN_CANCELACION)
    expect(await prisma.cfdi.count({ where: { venueId, type: 'EGRESO' } })).toBe(0)
    expect(provider.createCreditNote).not.toHaveBeenCalled()
  })

  it('🔴 C1 (I2): una venta que entró en la COMPLEMENTARIA tiene su nota contra la complementaria', async () => {
    const porRevisar = await prisma.product.create({
      data: {
        venueId,
        categoryId: (await prisma.product.findUniqueOrThrow({ where: { id: p0 } })).categoryId,
        name: `${fixture}-rev`,
        sku: `${fixture}-rev`,
        price: 200,
        ivaTratamiento: 'BLOQUEADO_04',
        objetoImp: '04',
      },
    })
    const a = await venta([{ productId: p16, precio: 116 }])
    const b = await venta([{ productId: porRevisar.id, precio: 200 }])
    const principal = await laGlobal()
    expect((principal.entrada as any).ordenes.map((o: any) => o.orderId)).toEqual([a.id])
    await prisma.product.update({ where: { id: porRevisar.id }, data: { ivaTratamiento: 'IVA_0' } }) // el dueño lo corrige
    const c = await emitirGlobalComplementaria({ venueId, emisorId: fiscalEmisorId, principalId: principal.id, now: NOW, sandbox: true })
    expect(c.status).toBe('STAMPED')
    expect(c.cfdi.idempotencyKey).toBe(`${principal.idempotencyKey}-c2`)
    const r = await reembolso(b.id, 5000)
    expect((await emit(r.id)).status).toBe('STAMPED')
    const enviado = provider.createCreditNote.mock.calls[0][0]
    expect(enviado.relatedUuids).toEqual([c.cfdi.uuid])
    expect(enviado.items).toEqual([expect.objectContaining({ unitPriceCents: 5000, sku: b.orderNumber, taxes: IVA(0) })])
    expect((await nota(r.id)).entrada).toMatchObject({ originalCfdiId: c.cfdi.id, originalEsGlobal: true, folio: b.orderNumber })
  })

  it('🔴 C2-13: la global sin su XML: el POST pide sus archivos con la identidad de la global y la nota sale', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const global = await laGlobal()
    await prisma.cfdi.update({ where: { id: global.id }, data: { xmlConceptos: Prisma.DbNull, taxBreakdown: Prisma.DbNull } })
    provider.downloadXml.mockClear()
    const r = await reembolso(t.id, 11600)
    expect((await emit(r.id)).status).toBe('STAMPED')
    expect(provider.downloadXml.mock.calls[0]).toEqual([global.facturapiId])
    expect((await prisma.cfdi.findUniqueOrThrow({ where: { id: global.id } })).xmlConceptos).not.toBeNull()
  })

  it('🔴 dos notas de tickets distintos a la vez se serializan sobre la fila de la global: la segunda ve a la primera', async () => {
    const t1 = await venta([{ productId: p16, precio: 116 }])
    const t2 = await venta([{ productId: p16, precio: 58 }])
    const global = await laGlobal()
    const reembolsoO1 = await reembolso(t1.id, 11600)
    const reembolsoO2 = await reembolso(t2.id, 5800)
    let soltar!: () => void
    const pausa = new Promise<void>(r => (soltar = r))
    const seguro = setTimeout(() => soltar(), 10_000) // red de seguridad: la prueba nunca cuelga
    let aTomo = false
    const vistos: number[] = []
    const a = emitRefundCreditNote(
      { venueId, refundPaymentId: reembolsoO1.id, sandbox: true },
      {
        despuesDelCandadoDeLaGlobal: async () => {
          aTomo = true
          await pausa
        },
      },
    )
    let b: ReturnType<typeof emitRefundCreditNote> | undefined
    try {
      await esperarHasta(async () => aTomo) // A llegó a su barrera (después de tomar la fila y releer)
      expect(await bloqueosSobre(global.id)).toBe(1) // la fila de la global quedó tomada por A
      b = emitRefundCreditNote(
        { venueId, refundPaymentId: reembolsoO2.id, sandbox: true },
        {
          despuesDelCandadoDeLaGlobal: async ac => {
            vistos.push(ac.notasDelDocumento.length)
          },
        },
      )
      await new Promise(r => setTimeout(r, 300))
      expect(vistos).toEqual([]) // B espera el candado
    } finally {
      soltar()
      clearTimeout(seguro)
      await Promise.allSettled(b ? [a, b] : [a]) // nunca queda una emisión viva para la limpieza
    }
    const [ra, rb] = await Promise.all([a, b!])
    expect(vistos).toEqual([1]) // B calculó el saldo del documento con la nota de A ya reservada
    expect([ra.status, rb.status]).toEqual(['STAMPED', 'STAMPED'])
  })

  it('🔴 el lector de la nota a la global: la sana se lee; con otro receptor, con el bloque de la global, o sin la marca de global (RFC genérico en una individual) ⇒ ilegible', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const global = await laGlobal()
    const r = await reembolso(t.id, 11600)
    expect((await emit(r.id)).status).toBe('STAMPED')
    const leer = () => acreditadoContra(prisma, { venueId, orderId: t.id, originalCfdiId: global.id })
    expect(await leer()).toMatchObject({ notas: [{ IVA_16: expect.objectContaining({ totalCents: 11600 }) }], desconocidoCents: 0 })
    const fila = await nota(r.id)
    const e0 = fila.entrada as any
    const reescribir = (e: any, columnas: Record<string, unknown> = {}) =>
      prisma.cfdi.update({ where: { id: fila.id }, data: { entrada: e, entradaHuella: huellaDeEntrada(e), ...columnas } })
    const ilegible = { notas: [], desconocidoCents: 11600 }
    // (1) Un receptor que no es el Público en General (coherente con su fila): la nota a la global no es ésa.
    await reescribir(
      { ...e0, params: { ...e0.params, receptor: { ...e0.params.receptor, rfc: 'EKU9003173C9', regimenFiscal: '601' } } },
      { receptorRfc: 'EKU9003173C9', receptorRegimen: '601' },
    )
    expect(await leer()).toMatchObject(ilegible)
    // (2) Con el bloque de la global (la Tarea 1 midió que NO va).
    await reescribir(
      { ...e0, params: { ...e0.params, global: { periodicity: 'month', months: '05', year: 2026 } } },
      { receptorRfc: 'XAXX010101000', receptorRegimen: '616' },
    )
    expect(await leer()).toMatchObject(ilegible)
    // (3) Sin la marca de global y sin folio: una nota «individual» con el RFC genérico no se lee.
    const { originalEsGlobal: _marca, folio: _folio, ...sinMarca } = e0
    void _marca
    void _folio
    await reescribir({ ...sinMarca, params: { ...e0.params, items: e0.params.items.map(({ sku: _sku, ...i }: any) => i) } })
    expect(await leer()).toMatchObject(ilegible)
    // Control: la original vuelve a leerse.
    await reescribir(e0)
    expect(await leer()).toMatchObject({ desconocidoCents: 0 })
  })

  // ── Ronda de arreglos 1 ──────────────────────────────────────────────────────────────────────────────────────────────
  it('🔴 ronda 1 (I1): vista previa y emisión leen la fila de la global tres veces y la evalúan UNA', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    const r = await reembolso(t.id, 11600)
    const lee = jest.spyOn(servicioDeGlobal, 'leerGlobal')
    expect((await getRefundCreditNoteStatus(venueId, r.id))!.eligibility).toMatchObject({ eligible: true })
    expect((await emit(r.id)).status).toBe('STAMPED')
    expect(lee).toHaveBeenCalledTimes(1)
  })

  it('🔴 ronda 1 (I2): 5 tickets de $100 devueltos completos ⇒ salen las 5 notas; el total de la global nunca se pasa y la deriva queda registrada', async () => {
    const ventas = []
    for (let i = 0; i < 5; i++) ventas.push(await venta([{ productId: p16, precio: 100 }]))
    const global = await laGlobal()
    for (const v of ventas) expect((await emit((await reembolso(v.id, 10000)).id)).status).toBe('STAMPED')
    const notas = await prisma.cfdi.findMany({ where: { venueId, type: 'EGRESO' }, orderBy: { createdAt: 'asc' } })
    expect(notas).toHaveLength(5)
    expect(notas.reduce((s, n) => s + n.totalCents, 0)).toBe(global.totalCents)
    // La base de las notas pasa la de la global a lo más lo que los tickets usaron (declarado), y el IVA nunca la pasa.
    const redondeo = notas.flatMap(n => (n.entrada as any).redondeo)
    const deTicket = redondeo
      .filter((x: any) => x.ambito === 'TICKET' && x.componente === 'BASE')
      .reduce((s: number, x: any) => s + x.cents, 0)
    expect(notas.reduce((s, n) => s + n.subtotalCents, 0) - global.subtotalCents).toBeLessThanOrEqual(deTicket)
    expect(notas.reduce((s, n) => s + n.taxCents, 0)).toBeLessThanOrEqual(global.taxCents)
    expect(redondeo.some((x: any) => x.ambito === 'DOCUMENTO_GLOBAL')).toBe(true)
    // Las cinco se leen (v2): ninguna cae a «desconocido» por llevar una deriva de documento de más de 1 ¢.
    expect(await acreditadoContra(prisma, { venueId, orderId: null, originalCfdiId: global.id, todoElDocumento: true })).toMatchObject({
      desconocidoCents: 0,
      toleranciaDeTickets: { IVA_16: { baseCents: deTicket, ivaCents: 0 } },
    })
  })

  it('🔴 ronda 1 (M2): con la global CANCELADA ⇒ ORIGINAL_CANCELLED con su motivo propio, sin reservar nada', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const global = await laGlobal()
    await prisma.cfdi.update({
      where: { id: global.id },
      data: { status: 'CANCELLED', cancelStatus: 'CANCELLED', cancelledAt: new Date() },
    })
    const r = await reembolso(t.id, 1000)
    expect((await getRefundCreditNoteStatus(venueId, r.id))!.eligibility).toEqual({
      eligible: false,
      reason: 'ORIGINAL_CANCELLED',
      message: MOTIVO_GLOBAL_CANCELADA,
    })
    await expect(emit(r.id)).rejects.toThrow(MOTIVO_GLOBAL_CANCELADA)
    expect(await prisma.cfdi.count({ where: { venueId, type: 'EGRESO' } })).toBe(0)
  })

  it('🔴 ronda 1 (M5): si el emisor cambió de CP después de la global, el receptor genérico de la nota lleva el VIGENTE', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { lugarExpedicion: '06000' } })
    const r = await reembolso(t.id, 11600)
    expect((await emit(r.id)).status).toBe('STAMPED')
    expect(provider.createCreditNote.mock.calls[0][0].receptor).toMatchObject({ rfc: 'XAXX010101000', codigoPostal: '06000' })
    expect((await nota(r.id)).receptorCp).toBe('06000')
  })

  // ── Ronda de arreglos 2 ──────────────────────────────────────────────────────────────────────────────────────────────
  it('🔴 ronda 2 (N1): 5 × $100 devueltos en 4 completos + $99.99 + $0.01 ⇒ las 6 notas se timbran (ninguna se queda en STAMPING ni en «soporte») y las 6 se leen', async () => {
    const ventas = []
    for (let i = 0; i < 5; i++) ventas.push(await venta([{ productId: p16, precio: 100 }]))
    const global = await laGlobal()
    const pasos: Array<[string, number]> = [
      ...ventas.slice(0, 4).map(v => [v.id, 10000] as [string, number]),
      [ventas[4].id, 9999],
      [ventas[4].id, 1],
    ]
    for (const [orderId, cents] of pasos) expect((await emit((await reembolso(orderId, cents)).id)).status).toBe('STAMPED')
    const notas = await prisma.cfdi.findMany({ where: { venueId, type: 'EGRESO' } })
    expect(notas).toHaveLength(6)
    expect(notas.every(n => n.status === 'STAMPED')).toBe(true)
    expect(notas.reduce((s, n) => s + n.totalCents, 0)).toBe(global.totalCents)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(6)
    // Lo que cada nota registró en el documento es SU parte de la deriva: la suma es la deriva, y ninguna pasa su propia base.
    const deriva = notas.reduce((s, n) => s + n.subtotalCents, 0) - global.subtotalCents
    const delDocumento = notas.flatMap(n =>
      ((n.entrada as any).redondeo as any[]).filter(r => r.ambito === 'DOCUMENTO_GLOBAL' && r.componente === 'BASE').map(r => ({ r, n })),
    )
    expect(delDocumento.reduce((s, x) => s + x.r.cents, 0)).toBe(Math.max(0, deriva))
    expect(delDocumento.every(x => x.r.cents <= x.n.subtotalCents)).toBe(true)
    expect(await acreditadoContra(prisma, { venueId, orderId: null, originalCfdiId: global.id, todoElDocumento: true })).toMatchObject({
      desconocidoCents: 0,
      notas: expect.arrayContaining([expect.anything()]),
    })
    expect(
      (await acreditadoContra(prisma, { venueId, orderId: null, originalCfdiId: global.id, todoElDocumento: true })).notas,
    ).toHaveLength(6)
  })
})
