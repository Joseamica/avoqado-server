/**
 * IVA por producto, bloque C3 · Tarea 2: la NOTA DE EXTRACCIÓN. Un ticket que ya está en una factura global viva se factura aparte: primero
 * un egreso relacionado con la global por lo que queda de ese ticket en ella (Público en General, G02, PUE, 84111506/ACT, NoIdentificacion =
 * folio), que congela los productos que quedan; luego (Tarea 4) la factura del cliente con ellos. Puro salvo `emitirExtraccion`, que corre
 * aquí con dobles (la integración real está en `tests/integration/fiscal/extraccionYNominativa.test.ts`).
 */
import prisma from '@/utils/prismaClient'
import * as payloadBuilder from '@/services/fiscal/cfdiPayloadBuilder'
import * as regla from '@/services/fiscal/reglaDelPac'
import * as cfdiService from '@/services/fiscal/cfdi.service'
import * as creditNote from '@/services/fiscal/cfdiCreditNote.service'
import {
  acreditadoContra,
  acumularNota,
  fiscalDelTicketEnLaGlobal,
  leerEgreso,
  montosDeReales,
  notaPorTratamiento,
  olvidarGlobalesEvaluadas,
  type AcreditadoContra,
  type EntradaEgresoV2,
  type LoadedRefundForCreditNote,
} from '@/services/fiscal/cfdiCreditNote.service'
import {
  construirExtraccion,
  emitirExtraccion,
  llaveDeExtraccion,
  MOTIVO_ESPERA_XML_DE_LA_GLOBAL,
  MOTIVO_GLOBAL_EN_CANCELACION,
  MOTIVO_GLOBAL_TIMBRANDOSE,
  MOTIVO_SIN_SALDO_EN_GLOBAL,
  MOTIVO_XML_DE_LA_GLOBAL_IRRECUPERABLE,
  motivoExtraccionCancelada,
  motivoExtraccionSinGlobal,
  type ExtraccionArmada,
} from '@/services/fiscal/cfdiExtraccion.service'
import { MOTIVO_REMANENTE_NO_TRAZABLE, MOTIVO_SIN_CONCEPTOS_REALES } from '@/services/fiscal/nominativaPorExtraccion'
import { MOTIVO_OCHO_SIN_REGLA } from '@/services/fiscal/reglaDelPac'
import { huellaDeEntrada } from '@/services/fiscal/entradaDocumental'
import { marcaDeXmlIlegible } from '@/services/fiscal/finalizadorCfdi'
import { leerXmlConceptos, MOTIVO_SALDO_DEL_DOCUMENTO, TRATAMIENTOS_DE_NOTA } from '@/services/fiscal/saldoFiscal'
import { globalDe, originalGlobal, ticketGlobal } from '../../../__helpers__/global-de-prueba'

/** La fila de la global de prueba (`globalDe` la tipa como la original del cargador, que puede faltar). */
type Global = LoadedRefundForCreditNote['original']
type ParcialDeNota = EntradaEgresoV2 // lo que importa de una nota para lo acreditado: su `porTratamiento`, `porRenglon`, `redondeo`, `modalidad`

const acreditadoVacio = (): AcreditadoContra => ({
  alreadyCreditedCents: 0,
  notas: [],
  desconocidoCents: 0,
  porRenglon: new Map(),
  extraida: false,
  sinTrazaPorArticulo: false,
})
/** Lo acreditado por esas notas, como lo leería `acreditadoContra` (la misma `acumularNota`; una que no es por artículos no deja rastro). */
function acreditadoCon(notas: Array<Pick<ParcialDeNota, 'porTratamiento' | 'porRenglon' | 'redondeo' | 'modalidad'>>): AcreditadoContra {
  const r = acreditadoVacio()
  for (const n of notas) {
    acumularNota(r, n)
    if (n.modalidad !== 'POR_ARTICULOS') r.sinTrazaPorArticulo = true
  }
  return r
}
/** La nota REAL de C2 (`notaPorTratamiento`) de una devolución del ticket `orderId` de esa global (por artículos si se dan), tras `antes`. */
function notaDe(g: Global, orderId: string, cents: number, articulos?: Array<[string, number]>, antes: ParcialDeNota[] = []) {
  const doc = acreditadoCon(antes)
  const loaded = {
    venueId: 'v1',
    venueSlug: 'demo',
    refund: {
      id: `r-${orderId}-${cents}`,
      orderId,
      type: 'REFUND',
      status: 'COMPLETED',
      salesRefundCents: cents,
      tipRefundCents: 0,
      method: 'CREDIT_CARD',
      tenderSatFormaPago: null,
      ...(articulos
        ? { processorData: { refundedItems: articulos.map(([orderItemId, amountCents]) => ({ orderItemId, amountCents })) } }
        : {}),
    },
    original: g,
    grossByRate: [],
    alreadyCreditedCents: 0,
    acreditado: acreditadoCon(antes.filter(n => n.orderId === orderId)),
    acreditadoDelDocumento: doc,
  } as unknown as LoadedRefundForCreditNote
  const n = notaPorTratamiento(loaded)
  if ('eligible' in n) throw new Error(`la nota de prueba no sale: ${n.message}`)
  return { ...n.entradaParcial, orderId } as ParcialDeNota
}
/** El tramo del ticket en la asignación de TODA la global (C2), por su total. */
const tramoDe = (g: Global, orderId: string) =>
  Object.values(
    (fiscalDelTicketEnLaGlobal({ original: g, refund: { orderId } } as any, leerXmlConceptos(g!.xmlConceptos)!) as any).fiscal as Record<
      string,
      { totalCents: number }
    >,
  ).reduce((s, c) => s + c.totalCents, 0)
/** Lo facturado de un artículo del ticket (sus reales repartidos con la regla de C2). */
const montoFacturadoDe = (g: Global, orderId: string, orderItemId: string) => {
  const t = (g!.entrada as any).ordenes.find((o: any) => o.orderId === orderId)
  return montosDeReales(t.conceptosReales, t.porTratamiento, t.filasD16)!.get(orderItemId)!.totalCents
}
const arma = (g: Global, orderId: string, acreditado = acreditadoVacio(), acreditadoDelDocumento = acreditado) =>
  construirExtraccion({ viva: g!, orderId, acreditado, acreditadoDelDocumento }) as any

beforeEach(() => olvidarGlobalesEvaluadas())
afterEach(() => jest.restoreAllMocks())

describe('C3 · llaveDeExtraccion — una sola por (global, ticket) (C3-P9 = B)', () => {
  it('siempre la misma llave, sin sufijo de generación', () => expect(llaveDeExtraccion('g1', 'o2')).toBe('cfdi-extraccion-g1-o2'))
})

describe('C3 · construirExtraccion — arma la extracción Y prueba la factura del cliente (C3-7)', () => {
  const g = originalGlobal()
  it('🔴 el ticket mezclado sin devoluciones: lo extraído es su tramo de la asignación de TODA la global; congela los dos productos', () => {
    const r = arma(g, 'o2')
    expect(r.extraidoCents).toBe(tramoDe(g, 'o2'))
    expect(r.remanentes?.map((x: any) => x.orderItemId).sort()).toEqual(['o2-cafe', 'o2-pan'])
    expect(r.items.every((i: any) => i.satProductKey === '84111506' && i.satUnitKey === 'ACT' && i.sku === 'ORD-2')).toBe(true)
    expect(r.items.every((i: any) => i.description === 'Venta del ticket ORD-2 facturada aparte (factura global G7)')).toBe(true)
    expect(r.ticket).toMatchObject({ folio: 'ORD-2', formaPago: '04' })
    expect(r.filasD16).toEqual([])
  })
  it('🔴 el pan devuelto completo (nota por artículos): extrae lo que queda y congela SÓLO el café', () => {
    const pan = notaDe(g, 'o2', montoFacturadoDe(g, 'o2', 'o2-pan'), [['o2-pan', montoFacturadoDe(g, 'o2', 'o2-pan')]])
    const r = arma(g, 'o2', acreditadoCon([pan]))
    expect(r.remanentes?.map((x: any) => x.orderItemId)).toEqual(['o2-cafe'])
    expect(r.extraidoCents).toBe(tramoDe(g, 'o2') - pan.devueltoCents)
  })
  it('🔴 C3-7: el pan devuelto EN PARTE ⇒ no hay extracción (la factura del cliente no se podría demostrar)', () => {
    expect(arma(g, 'o2', acreditadoCon([notaDe(g, 'o2', 2900, [['o2-pan', 2900]])]))).toEqual({ motivo: MOTIVO_REMANENTE_NO_TRAZABLE })
  })
  it('una nota por importe del ticket ⇒ no hay extracción', () => {
    expect(arma(g, 'o2', acreditadoCon([notaDe(g, 'o2', 1000)]))).toEqual({ motivo: MOTIVO_REMANENTE_NO_TRAZABLE })
  })
  it('sin saldo del ticket (ya devuelto completo) ⇒ sinSaldo', () => {
    const pan = notaDe(g, 'o2', montoFacturadoDe(g, 'o2', 'o2-pan'), [['o2-pan', montoFacturadoDe(g, 'o2', 'o2-pan')]])
    const cafe = notaDe(g, 'o2', montoFacturadoDe(g, 'o2', 'o2-cafe'), [['o2-cafe', montoFacturadoDe(g, 'o2', 'o2-cafe')]], [pan])
    expect(arma(g, 'o2', acreditadoCon([pan, cafe]))).toEqual({ sinSaldo: true })
  })
  it('🔴 B7: la global sin su XML ⇒ espera, con un texto de la factura (no «la nota de crédito»)', () => {
    expect(arma(originalGlobal({ xmlConceptos: null }), 'o2')).toEqual({ motivo: MOTIVO_ESPERA_XML_DE_LA_GLOBAL, espera: true })
    expect(MOTIVO_ESPERA_XML_DE_LA_GLOBAL).not.toMatch(/nota de crédito/)
  })
  it('🔴 B7: la marca de XML ilegible se mira PRIMERO (aunque además falte el resumen): se detiene, nunca espera', () => {
    expect(arma(originalGlobal({ xmlConceptos: marcaDeXmlIlegible('roto'), taxBreakdown: null }), 'o2')).toEqual({
      motivo: MOTIVO_XML_DE_LA_GLOBAL_IRRECUPERABLE,
    })
  })
  it('🔴 M5: un ticket sin conceptos reales (o sin artículos) ⇒ MOTIVO_SIN_CONCEPTOS_REALES (no hay respaldo genérico)', () => {
    expect(arma(originalGlobal({ sinReales: true }), 'o2')).toEqual({ motivo: MOTIVO_SIN_CONCEPTOS_REALES })
    expect(arma(g, 'o3')).toEqual({ motivo: MOTIVO_SIN_CONCEPTOS_REALES })
  })
  it('🔴 C1-30 en la extracción: un error de armado (los conceptos no suman lo extraído de su tasa) ⇒ se detiene con «error al armarla»; la búsqueda no corre', () => {
    const real = payloadBuilder.conceptosDeNota
    jest
      .spyOn(payloadBuilder, 'conceptosDeNota')
      .mockImplementation((...a: any[]) => real(...(a as [any, any, any])).map(c => ({ ...c, unitPriceCents: c.unitPriceCents + 100 })))
    const busqueda = jest.spyOn(regla, 'cuadrarConElPac')
    expect(arma(g, 'o2')).toMatchObject({ motivo: expect.stringContaining('error al armarla') })
    // La global y los reales del ticket sí se cuadran (eso es C1/C2); lo que NO corre es la búsqueda sobre los conceptos de la extracción.
    const sobreLaExtraccion = busqueda.mock.calls.filter(([cs]) => cs.some(c => String(c.nombre).startsWith('Venta del ticket')))
    expect(sobreLaExtraccion).toEqual([])
  })
  it('🔴 M3: 4 tickets de $100 devueltos completos y el 5.º se EXTRAE ⇒ sale: el documento admite lo que los tickets ya usaron de P8 (y lo registra)', () => {
    const ids = ['A', 'B', 'C', 'D', 'E']
    const cinco = globalDe(ids.map(id => ticketGlobal(id, id, { IVA_16: 10000 }, [[`${id}-a`, 10000, 'IVA_16']])))
    const notas: ParcialDeNota[] = []
    for (const id of ids.slice(0, 4)) notas.push(notaDe(cinco, id, 10000, [[`${id}-a`, 10000]], notas))
    const r = arma(cinco, 'E', acreditadoVacio(), acreditadoCon(notas))
    expect(r).toMatchObject({ extraidoCents: 10000 })
    expect(r.redondeo?.some((x: any) => x.ambito === 'DOCUMENTO_GLOBAL')).toBe(true)
  })
  it('🔴 M3: el tope por el TOTAL del ticket: una nota (v1) de un tratamiento que el ticket no tiene también baja lo que queda', () => {
    const ticket = acreditadoVacio()
    ticket.notas = [{ NO_OBJETO: { baseCents: 1000, ivaCents: 0, totalCents: 1000 } }] // `restar` no la ve (el ticket no es no objeto)
    ticket.sinTrazaPorArticulo = true
    expect(arma(g, 'o2', ticket, acreditadoVacio())).toEqual({
      motivo: `Lo que se devuelve ($${(tramoDe(g, 'o2') / 100).toFixed(2)}) excede lo que queda por acreditar de este ticket en la factura global ($${((tramoDe(g, 'o2') - 1000) / 100).toFixed(2)}).`,
    })
  })
  it('control — M3: lo extraído tampoco pasa lo que queda del DOCUMENTO (la global menos TODO lo acreditado contra ella)', () => {
    const doc = acreditadoVacio()
    doc.desconocidoCents = g!.totalCents - tramoDe(g, 'o2') + 1 // una nota ilegible de otro ticket deja 1 ¢ menos de lo que pide el ticket
    expect(arma(g, 'o2', acreditadoVacio(), doc)).toEqual({ motivo: MOTIVO_SALDO_DEL_DOCUMENTO })
  })
  it('🔴 M7: el pan devuelto completo POR LO COBRADO (1 ¢ distinto de lo facturado, dentro del ajuste de su tasa) ⇒ sale y registra ese centavo CON signo', () => {
    // El ticket de la medición M7 (T3): $65 − $2.50 + 2 tortas de $58, todo al 16 %: el ajuste del PAC deja lo facturado de cada artículo a 1 ¢.
    const t = ticketGlobal('m7', 'ORD-M7', { IVA_16: 6250 + 11600 }, [
      ['m7-pan', 6500, 'IVA_16', 250],
      ['m7-torta', 5800, 'IVA_16', 0, 2],
    ])
    const m7 = globalDe([t])
    const facturado = montoFacturadoDe(m7, 'm7', 'm7-pan')
    expect(Math.abs(facturado - 6250)).toBe(1) // control: el caso existe
    const r = arma(m7, 'm7', acreditadoCon([notaDe(m7, 'm7', 6250, [['m7-pan', 6250]])]))
    expect(r.remanentes?.map((x: any) => x.orderItemId)).toEqual(['m7-torta'])
    expect(r.redondeoDeRemanentes).toEqual([{ orderItemId: 'm7-pan', tratamiento: 'IVA_16', cents: 6250 - facturado }])
  })
})

// ─── emitirExtraccion, con dobles ────────────────────────────────────────────────────────────────────────────────────────────
type Opciones = {
  formaDelTicket?: string
  existente?: any
  global?: Global | null
  globalCancelStatus?: string
  acreditadoBajoElCandado?: AcreditadoContra
  globalSinXml?: boolean
  pac?: any
}
/** Los dobles de la extracción: la global `cfdi-global-1` (folio G7) con sus tres tickets; el PAC timbra; la transacción es un doble. */
function depsExtraccion(o: Opciones = {}) {
  const ordenes = [
    ticketGlobal('o1', 'ORD-1', { IVA_16: 11600 }, [['o1-a', 11600, 'IVA_16']]),
    ticketGlobal(
      'o2',
      'ORD-2',
      { IVA_16: 5800, IVA_0: 20000 },
      [
        ['o2-cafe', 20000, 'IVA_0'],
        ['o2-pan', 5800, 'IVA_16'],
      ],
      { formaPago: o.formaDelTicket ?? '04' },
    ),
    ticketGlobal('o3', 'ORD-3', { IVA_16: 5000 }, []),
  ]
  const global =
    o.global !== undefined
      ? o.global
      : globalDe(ordenes, {
          ...(o.globalCancelStatus ? { cancelStatus: o.globalCancelStatus } : {}),
          ...(o.globalSinXml ? { xmlConceptos: null, taxBreakdown: null } : {}),
        })
  const tx: any = {
    $queryRaw: jest.fn(async () => [{ venueId: 'v1', organizationId: 'org-1' }]),
    $executeRaw: jest.fn(async () => 1),
    cfdi: {
      findUnique: jest.fn(async ({ where }: any) => (where.id ? global : where.idempotencyKey ? (o.existente ?? null) : null)),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => ({
        ...o.existente,
        ...tx.cfdi.updateMany.mock.calls.at(-1)?.[0]?.data,
        id: where.id,
      })),
    },
  }
  const pac = o.pac ?? {
    name: 'facturapi',
    createCreditNote: jest.fn(),
    findByExternalId: jest.fn(async () => null),
    getInvoice: jest.fn(async () => null),
  }
  return {
    tx,
    pac,
    cargarGlobalViva: jest.fn(async () => global),
    findExistingCfdi: jest.fn(async () => o.existente ?? null),
    acreditadoContra: jest.fn(async (_tx: any, p: any) =>
      p.todoElDocumento ? acreditadoVacio() : (o.acreditadoBajoElCandado ?? acreditadoVacio()),
    ),
    resolveProvider: jest.fn(() => pac),
    loadEmisor: jest.fn(async () => ({ id: 'e1' })),
    loadVenueSlug: jest.fn(async () => 'demo'),
    reserveCfdi: jest.fn(async (data: any) => ({ id: 'x1', ...data })),
    repararArchivos: jest.fn(),
    runInTransaction: jest.fn(async (work: any) => work(tx)),
  }
}
/** El envío al PAC (`enviarIntentoCapturado`, de C1) se sustituye: aquí se prueba qué se captura, no el transporte. */
const enviar = () =>
  jest
    .spyOn(cfdiService, 'enviarIntentoCapturado')
    .mockImplementation(async (cfdi: any) => ({ status: 'STAMPED', cfdi: { ...cfdi, status: 'STAMPED', uuid: 'UUID-EXTRACCION' } }))
const sinMotivos = async () => [] as string[]
const emitir = (d: ReturnType<typeof depsExtraccion>, over: Partial<Parameters<typeof emitirExtraccion>[0]> = {}) =>
  emitirExtraccion({ venueId: 'v1', orderId: 'o2', sandbox: true, staffId: null, comprobarNominativa: sinMotivos, ...over }, d as any)

describe('C3 · emitirExtraccion', () => {
  beforeEach(() => (prisma.activityLog.create as jest.Mock).mockReset())

  it('🔴 C3-12: bajo el candado de la reserva, la preparación REAL de la factura del cliente dice que no ⇒ no se reserva; recibe la transacción y lo armado', async () => {
    const d = depsExtraccion()
    const comprobar = jest.fn(async (_tx: any, _c: ExtraccionArmada) => ['Autofactura no habilitada para este comercio'])
    expect(await emitir(d, { comprobarNominativa: comprobar })).toEqual({
      status: 'VALIDATION_FAILED',
      reasons: ['Autofactura no habilitada para este comercio'],
    })
    expect(comprobar).toHaveBeenCalledWith(d.tx, expect.objectContaining({ remanentes: expect.any(Array), bruto: expect.any(Object) }))
    expect(d.reserveCfdi).not.toHaveBeenCalled()
  })
  it('🔴 G1: la comprobación de la factura del cliente corre DESPUÉS del FOR UPDATE de la orden (el candado que toman las devoluciones)', async () => {
    const d = depsExtraccion()
    enviar()
    let candadosAntes = 0
    await emitir(d, { comprobarNominativa: async () => ((candadosAntes = d.tx.$queryRaw.mock.calls.length), []) })
    const sql = d.tx.$queryRaw.mock.calls.map((c: any) => c[0].join('?'))
    expect(sql[0]).toMatch(/FROM "Order" o[\s\S]*FOR UPDATE OF o/)
    expect(candadosAntes).toBeGreaterThanOrEqual(3) // la orden, sus productos y la fila de la global
  })
  it('🔴 la fila reservada: llave de (global, ticket), causa EXTRACCION, Público en General, G02, PUE, la forma del ticket, remanentes y redondeo', async () => {
    const d = depsExtraccion({ formaDelTicket: '28' })
    enviar()
    expect((await emitir(d)).status).toBe('STAMPED')
    const fila = (d.reserveCfdi as jest.Mock).mock.calls[0]?.[0]
    expect(fila).toMatchObject({
      idempotencyKey: 'cfdi-extraccion-cfdi-global-1-o2',
      type: 'EGRESO',
      orderId: 'o2',
      flow: 'STAFF_B',
      status: 'STAMPING',
      receptorRfc: 'XAXX010101000',
      receptorNombre: 'PÚBLICO EN GENERAL',
      receptorRegimen: '616',
      usoCfdi: 'G02',
      metodoPago: 'PUE',
      formaPago: '28',
      attempts: 1,
      protocoloIva: 1,
    })
    expect(fila.entrada).toMatchObject({
      version: 2,
      causa: 'EXTRACCION',
      refundPaymentId: null,
      generacion: 1,
      originalCfdiId: 'cfdi-global-1',
      originalUuid: 'UUID-GLOBAL-1',
      originalEsGlobal: true,
      folio: 'ORD-2',
      modalidad: 'POR_IMPORTE',
      remanentes: expect.arrayContaining([expect.objectContaining({ orderItemId: 'o2-cafe' })]),
      filasD16: [],
      redondeo: expect.arrayContaining([]), // (`structuredClone` da arreglos de otro reino: `expect.any(Array)` no los reconoce)
    })
    expect(
      fila.entrada.params.items.every((i: any) => i.description === 'Venta del ticket ORD-2 facturada aparte (factura global G7)'),
    ).toBe(true)
    expect(fila.entrada.params).toMatchObject({ relationship: '01', relatedUuids: ['UUID-GLOBAL-1'], formaPago: '28', metodoPago: 'PUE' })
    expect('global' in fila.entrada.params).toBe(false) // G02_SIN_BLOQUE (C2 T1)
    // Lo que se reservó se lee con el lector de las notas (y es lo que se manda al PAC).
    expect(leerEgreso({ id: 'x1', ...fila })).toMatchObject({ causa: 'EXTRACCION' })
    // El evento de la extracción, una vez, en el mismo punto que la recuperación (C3-22).
    expect(prisma.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'CFDI_EXTRACCION_EMITIDA', entity: 'Cfdi', entityId: 'x1', staffId: null }),
    })
  })
  it('🔴 B14: en la autofactura la fila nace con el flujo del pedido, no con el del personal', async () => {
    const d = depsExtraccion()
    enviar()
    await emitir(d, { flow: 'AUTOFACTURA_A' })
    expect((d.reserveCfdi as jest.Mock).mock.calls[0]?.[0].flow).toBe('AUTOFACTURA_A')
  })
  it('ya timbrada: la devuelve sin volver a timbrar, y registra el evento (C3-23: nunca se pierde)', async () => {
    const existente = { id: 'x0', status: 'STAMPED', type: 'EGRESO', venueId: 'v1', entrada: { orderId: 'o2' } }
    const d = depsExtraccion({ existente })
    expect(await emitir(d, { staffId: 's1' })).toMatchObject({ status: 'STAMPED', cfdi: existente })
    expect(d.reserveCfdi).not.toHaveBeenCalled()
    expect(prisma.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'CFDI_EXTRACCION_EMITIDA', entityId: 'x0', staffId: 's1' }),
    })
  })
  it('la global con cancelación en trámite: no se emite (C2)', async () => {
    await expect(emitir(depsExtraccion({ globalCancelStatus: 'REQUESTED' }))).rejects.toThrow(/cancelación en trámite/)
    expect(MOTIVO_GLOBAL_EN_CANCELACION).toMatch(/cancelación en trámite/)
  })
  it('🔴 B12: la global viva todavía sin timbrar ⇒ «se está timbrando», no «no está en una global»', async () => {
    const enCurso = { ...originalGlobal(), status: 'STAMPING', uuid: null } as any
    await expect(emitir(depsExtraccion({ global: enCurso }))).rejects.toThrow(MOTIVO_GLOBAL_TIMBRANDOSE)
    await expect(emitir(depsExtraccion({ global: null }))).rejects.toThrow(/no está en una factura global vigente/)
  })
  it('🔴 C3-7: la devolución parcial entró DESPUÉS de cualquier comprobación previa: la reserva la ve bajo su candado y no reserva', async () => {
    const g = originalGlobal()
    const d = depsExtraccion({ acreditadoBajoElCandado: acreditadoCon([notaDe(g, 'o2', 2900, [['o2-pan', 2900]])]) })
    expect(await emitir(d)).toEqual({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_REMANENTE_NO_TRAZABLE] })
    expect(d.reserveCfdi).not.toHaveBeenCalled()
  })
  it('sin saldo (todo devuelto) ⇒ SIN_SALDO con su motivo, sin reservar', async () => {
    const g = originalGlobal()
    const pan = notaDe(g, 'o2', montoFacturadoDe(g, 'o2', 'o2-pan'), [['o2-pan', montoFacturadoDe(g, 'o2', 'o2-pan')]])
    const cafe = notaDe(g, 'o2', montoFacturadoDe(g, 'o2', 'o2-cafe'), [['o2-cafe', montoFacturadoDe(g, 'o2', 'o2-cafe')]], [pan])
    const d = depsExtraccion({ acreditadoBajoElCandado: acreditadoCon([pan, cafe]) })
    expect(await emitir(d)).toEqual({ status: 'SIN_SALDO', reasons: [MOTIVO_SIN_SALDO_EN_GLOBAL] })
    expect(d.reserveCfdi).not.toHaveBeenCalled()
  })
  it('la global sin su XML: pide los archivos una vez; si siguen sin llegar, espera sin reservar', async () => {
    const d = depsExtraccion({ globalSinXml: true })
    expect(await emitir(d)).toEqual({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_ESPERA_XML_DE_LA_GLOBAL] })
    expect(d.repararArchivos).toHaveBeenCalledTimes(1)
    expect(d.repararArchivos).toHaveBeenCalledWith('cfdi-global-1', expect.objectContaining({ sandbox: true, insistir: true }))
    expect(d.reserveCfdi).not.toHaveBeenCalled()
  })
  it('🔴 C3-20: una extracción ENVIADA en duda se recupera PRIMERO por su identidad: sin pedir el XML de la global; si el PAC no la tiene, «se está procesando»', async () => {
    const existente = {
      id: 'x1',
      venueId: 'v1',
      type: 'EGRESO',
      status: 'STAMP_FAILED',
      protocoloIva: 1,
      attempts: 1,
      enviadoAt: new Date(),
      falloDefinitivo: false,
      facturapiId: null,
      idempotencyKey: 'cfdi-extraccion-cfdi-global-1-o2',
      fiscalEmisorId: 'e1',
    }
    const d = depsExtraccion({ existente, globalSinXml: true })
    await expect(emitir(d)).rejects.toThrow(/se está procesando/)
    expect(d.pac.findByExternalId).toHaveBeenCalledWith('cfdi-extraccion-cfdi-global-1-o2#1')
    expect(d.repararArchivos).not.toHaveBeenCalled()
    expect(d.reserveCfdi).not.toHaveBeenCalled()
  })
  it('🔴 M4: una extracción enviada y RECHAZADA en definitiva: consulta la identidad anterior y se recaptura con identidad nueva (#2), bajo su CAS', async () => {
    const enviadoAt = new Date()
    const existente = {
      id: 'x1',
      venueId: 'v1',
      type: 'EGRESO',
      status: 'STAMP_FAILED',
      protocoloIva: 1,
      attempts: 1,
      enviadoAt,
      falloDefinitivo: true,
      cancelStatus: null,
      facturapiId: null,
      idempotencyKey: 'cfdi-extraccion-cfdi-global-1-o2',
      fiscalEmisorId: 'e1',
    }
    const d = depsExtraccion({ existente })
    const envio = enviar()
    expect((await emitir(d)).status).toBe('STAMPED')
    expect(d.pac.findByExternalId).toHaveBeenCalledWith('cfdi-extraccion-cfdi-global-1-o2#1')
    const [cas] = (d.tx.cfdi.updateMany.mock.calls[0] ?? []) as any[]
    expect(cas.where).toEqual({ id: 'x1', status: 'STAMP_FAILED', attempts: 1, enviadoAt, falloDefinitivo: true })
    expect(cas.data).toMatchObject({ attempts: 2, enviadoAt: null, falloDefinitivo: false, facturapiId: null, status: 'STAMPING' })
    expect(envio.mock.calls[0]?.[0]).toMatchObject({ id: 'x1', attempts: 2 })
    expect(d.reserveCfdi).not.toHaveBeenCalled()
  })
  it('🔴 M7: el centavo con signo de un artículo devuelto completo queda en la entrada (`redondeoDeRemanentes`) y el lector lo acepta', async () => {
    const t = ticketGlobal('m7', 'ORD-M7', { IVA_16: 6250 + 11600 }, [
      ['m7-pan', 6500, 'IVA_16', 250],
      ['m7-torta', 5800, 'IVA_16', 0, 2],
    ])
    const m7 = globalDe([t])
    const d = depsExtraccion({ global: m7, acreditadoBajoElCandado: acreditadoCon([notaDe(m7, 'm7', 6250, [['m7-pan', 6250]])]) })
    enviar()
    expect((await emitir(d, { orderId: 'm7' })).status).toBe('STAMPED')
    const fila = (d.reserveCfdi as jest.Mock).mock.calls[0]?.[0]
    expect(fila.entrada.redondeoDeRemanentes).toEqual([{ orderItemId: 'm7-pan', tratamiento: 'IVA_16', cents: expect.any(Number) }])
    expect(leerEgreso({ id: 'x1', ...fila })).toMatchObject({ causa: 'EXTRACCION' })
  })
})

// ─── El lector de la extracción y lo acreditado (C2 abre su lector a `causa: 'EXTRACCION'`) ─────────────────────────────────────
describe('C3 · el lector v2 lee la extracción (M8: forma y huella; la concordancia en dinero se exige al capturar)', () => {
  /** La fila de la extracción del ticket `o2` tal como la reserva `emitirExtraccion`. */
  async function filaDeExtraccion() {
    const d = depsExtraccion()
    enviar()
    await emitir(d)
    expect(d.reserveCfdi).toHaveBeenCalledTimes(1)
    return { id: 'x1', ...(d.reserveCfdi as jest.Mock).mock.calls[0]?.[0] }
  }
  const conHuella = (f: any) => ((f.entradaHuella = huellaDeEntrada(f.entrada)), f)

  it('🔴 la extracción sana se lee', async () => {
    expect(leerEgreso(await filaDeExtraccion())).toMatchObject({ causa: 'EXTRACCION', generacion: 1, refundPaymentId: null })
  })
  it.each<[string, (f: any) => void]>([
    ['con un reembolso', f => (f.entrada.refundPaymentId = 'x')],
    ['con otra llave', f => (f.idempotencyKey = 'cfdi-extraccion-otra-o2')],
    ['con generación 2', f => (f.entrada.generacion = 2)],
    ['con la llave de una «generación» (-n2)', f => (f.idempotencyKey = `${f.idempotencyKey}-n2`)],
    ['con remanentes vacíos', f => (f.entrada.remanentes = [])],
    ['con un remanente malformado', f => (f.entrada.remanentes[0].precio = 'diez')],
    ['sin filas D16', f => delete f.entrada.filasD16],
    ['con una fila D16 que no es arreglo de cadenas', f => (f.entrada.filasD16 = [[1]])],
    ['por artículos', f => (f.entrada.modalidad = 'POR_ARTICULOS')],
    ['sin la marca de global', f => delete f.entrada.originalEsGlobal],
    ['con otro texto en sus conceptos', f => f.entrada.params.items.forEach((i: any) => (i.description = 'Devolución sobre factura G7'))],
    ['con una causa inventada', f => (f.entrada.causa = 'REGALO')],
    [
      'con un centavo de remanente de un artículo que sigue en los remanentes',
      f => (f.entrada.redondeoDeRemanentes = [{ orderItemId: 'o2-cafe', tratamiento: 'IVA_0', cents: 1 }]),
    ],
    [
      'con un centavo de remanente en cero',
      f => (f.entrada.redondeoDeRemanentes = [{ orderItemId: 'o2-otro', tratamiento: 'IVA_16', cents: 0 }]),
    ],
    [
      'con un centavo de remanente de 3 ¢',
      f => (f.entrada.redondeoDeRemanentes = [{ orderItemId: 'o2-otro', tratamiento: 'IVA_16', cents: -3 }]),
    ],
  ])('control — una extracción %s (con la huella recalculada) ⇒ revisión de soporte', async (_n, cambia) => {
    const f = await filaDeExtraccion()
    cambia(f)
    expect(() => leerEgreso(conHuella(f))).toThrow(/soporte/)
  })
  it('🔴 una DEVOLUCIÓN con campos de extracción (filas D16, remanentes, generación o centavos de remanentes) ⇒ soporte', async () => {
    const f = await filaDeExtraccion()
    /** La misma nota leída como una DEVOLUCIÓN sana de un reembolso (su llave y su texto de devolución), sin nada de extracción. */
    const comoDevolucion = () => {
      const dev = structuredClone(f)
      dev.entrada.causa = 'DEVOLUCION'
      dev.entrada.refundPaymentId = 'pay-1'
      dev.idempotencyKey = 'cfdi-refund-pay-1'
      dev.entrada.params.items.forEach((i: any) => (i.description = 'Devolución sobre factura G7'))
      for (const x of ['filasD16', 'remanentes', 'generacion', 'redondeoDeRemanentes']) delete dev.entrada[x]
      return dev
    }
    expect(leerEgreso(conHuella(comoDevolucion()))).toMatchObject({ causa: 'DEVOLUCION' }) // control: sin ellos, se lee
    for (const [k, v] of [
      ['filasD16', []],
      ['remanentes', f.entrada.remanentes],
      ['generacion', 1],
      ['redondeoDeRemanentes', [{ orderItemId: 'o2-otro', tratamiento: 'IVA_16', cents: 1 }]],
    ] as const) {
      const dev = comoDevolucion()
      dev.entrada[k] = v
      expect(() => leerEgreso(conHuella(dev))).toThrow(/soporte/)
    }
  })
  it('control — M8: un remanente cuyo dinero hoy ya no concordaría (otro precio) se sigue LEYENDO: la concordancia se exigió al capturar', async () => {
    const f = await filaDeExtraccion()
    f.entrada.remanentes[0].precio = '1.00'
    expect(leerEgreso(conHuella(f))).toMatchObject({ causa: 'EXTRACCION' })
  })
  it('🔴 T3 (6): una extracción viva cuenta en lo acreditado como extracción y NO marca `sinTrazaPorArticulo`', async () => {
    const f = await filaDeExtraccion()
    const r = await acreditadoContra(
      { cfdi: { aggregate: jest.fn(async () => ({ _sum: { totalCents: null } })), findMany: jest.fn(async () => [f]) } } as any,
      { venueId: 'v1', orderId: 'o2', originalCfdiId: 'cfdi-global-1' },
    )
    expect(r).toMatchObject({ extraida: true, sinTrazaPorArticulo: false, desconocidoCents: 0 })
    expect(r.notas).toHaveLength(1)
    expect(TRATAMIENTOS_DE_NOTA.filter(t => r.notas[0][t]).sort()).toEqual(['IVA_0', 'IVA_16'])
  })
})

describe('C3 · B8: el 8 % no tiene regla de la 6b', () => {
  it('🔴 un tramo al 8 % ⇒ MOTIVO_OCHO_SIN_REGLA, antes de armar nada', () => {
    // Una global real no lleva tickets al 8 % (C1 los deja fuera con `OCHO_SIN_REGLA`): el freno es defensa. Se simula el tramo del ticket
    // todo-16 renombrado al 8 % en la lectura de la original (la función que la extracción llama del módulo de C2).
    const g = originalGlobal()
    const real = creditNote.fiscalDeLaOriginal
    jest.spyOn(creditNote, 'fiscalDeLaOriginal').mockImplementation(l => {
      const f = real(l) as any
      return {
        ...f,
        fiscal: { IVA_8: f.fiscal.IVA_16 },
        documento: { IVA_8: f.documento.IVA_16 },
        documentoSinRestar: { IVA_8: f.documentoSinRestar.IVA_16 },
      }
    })
    const busqueda = jest.spyOn(regla, 'cuadrarConElPac')
    expect(arma(g, 'o1')).toEqual({ motivo: MOTIVO_OCHO_SIN_REGLA })
    expect(busqueda.mock.calls.filter(([cs]) => cs.some(c => String(c.nombre).startsWith('Venta del ticket')))).toEqual([])
  })
})

// Ola final de C3 (M-2 / T4-5): el folio de la nota se dice igual en todo texto al usuario («E-123», como `folioDe`), y una nota que
// todavía no tiene serie/folio/UUID (reservada, sin enviar) no se escribe «null».
describe('C3 · M-2: el folio de la nota en los textos al usuario', () => {
  it('🔴 la nota cancelada y la sin global dicen «E-123» (serie-folio), no «E123»', () => {
    const e = { serie: 'E', folio: '123', uuid: 'U-1', totalCents: 11600 }
    expect(motivoExtraccionCancelada(e)).toContain('(E-123)')
    expect(motivoExtraccionSinGlobal(e)).toContain('con la nota E-123 por $116.00')
  })
  it('sin serie ni folio dice el UUID (como `folioDe`)', () => {
    const e = { serie: null, folio: null, uuid: 'U-1', totalCents: 11600 }
    expect(motivoExtraccionCancelada(e)).toContain('(U-1)')
    expect(motivoExtraccionSinGlobal(e)).toContain('con la nota U-1 por $116.00')
  })
  it('🔴 sin serie, folio ni UUID (reservada, sin enviar) nunca dice «null»: dice que se está confirmando', () => {
    const e = { serie: null, folio: null, uuid: null, totalCents: 11600 }
    expect(motivoExtraccionCancelada(e)).not.toMatch(/null|undefined/)
    expect(motivoExtraccionSinGlobal(e)).not.toMatch(/null|undefined/)
    expect(motivoExtraccionSinGlobal(e)).toContain('con una nota que todavía se está confirmando por $116.00')
  })
})
