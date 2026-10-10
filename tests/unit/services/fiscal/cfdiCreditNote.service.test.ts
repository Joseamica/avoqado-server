import {
  LoadedRefundForCreditNote,
  MOTIVO_ORIGINAL_EN_CANCELACION,
  MOTIVO_ORIGINAL_CANCELACION_ENVIANDOSE,
  MOTIVO_ORIGINAL_CANCELACION_EN_DUDA,
  MOTIVO_ORIGINAL_EN_SUSTITUCION,
  MOTIVO_ORIGINAL_EN_SUSTITUCION_ATORADA,
  MOTIVO_SIN_FORMA_DE_PAGO,
  buildCreditNoteLines,
  checkCreditNoteEligibility,
  fiscalDelTicketEnLaGlobal,
  folioDelTicket,
  formaPagoDeLaNota,
  loadRefundForCreditNoteFromDb,
  montosDeReales,
  NOTA_A_GLOBAL_LLEVA_BLOQUE,
  notaPorTratamiento,
  porRenglonValido,
  capturarEgreso,
  leerEgreso,
  emitRefundCreditNote,
  getRefundCreditNoteStatus,
  ANTIGUEDAD_MAXIMA_SIN_XML_MS,
  LIMITE_ESPERA_XML_EN_LA_NOTA_MS,
  LIMITE_ESPERA_XML_EN_LA_VISTA_MS,
  MOTIVO_XML_ATRASADO,
  MOTIVO_XML_ILEGIBLE,
  MOTIVO_XML_NO_DISPONIBLE,
  acumularNota,
  MEMORIA_DE_GLOBALES,
  MOTIVO_GLOBAL_CANCELADA,
  olvidarGlobalesEvaluadas,
  asegurarGlobalVigente,
  VIGENCIA_MINIMA_ANTES_DE_LOS_CANDADOS_MS,
  alternativaPorImporte,
  huellaDelReparto,
  MOTIVO_FALTA_LA_HUELLA,
  MOTIVO_REPARTO_CAMBIO,
  MOTIVO_NOTA_CAMBIO,
} from '@/services/fiscal/cfdiCreditNote.service'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import * as servicioDeGlobal from '@/services/fiscal/cfdiGlobal.service'
import { marcaDeXmlIlegible } from '@/services/fiscal/finalizadorCfdi'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { montoComercialCents } from '@/services/fiscal/globalPorTratamiento'
import * as payloadBuilder from '@/services/fiscal/cfdiPayloadBuilder'
import * as regla from '@/services/fiscal/reglaDelPac'
import { CFDI_VIVO } from '@/services/fiscal/exclusionGlobal'
import { ENVIO_TERMINADO_MS } from '@/services/fiscal/cfdi.service'
import { huellaDeEntrada } from '@/services/fiscal/entradaDocumental'
import {
  cuadrarLaGlobal,
  montosDesdeDocumento,
  paramsDeLaGlobal,
  SIN_FILAS_D16,
  type ConceptoReal,
  type PorTratamientoGlobal,
} from '@/services/fiscal/globalPorTratamiento'
import { closedPeriodFor } from '@/services/fiscal/globalPeriod'
import { splitIvaIncluded } from '@/services/fiscal/ivaMath'
import {
  asignacionFiscal,
  documentoDeConceptos,
  leerXmlConceptos,
  MOTIVO_SALDO_DEL_DOCUMENTO,
  resumenDeConceptos,
  TRATAMIENTOS_DE_NOTA,
  unidadesDeConceptos,
  type Asignacion,
  type DocumentoFiscal,
} from '@/services/fiscal/saldoFiscal'
import { xmlConceptosDe } from '../../../__helpers__/xml-del-pac'

// ─── C2 · Tarea 7: ayudantes (las pruebas siguen la 6b; nunca fijan millonésimas a mano) ───
/** El de la Tarea 4: un concepto con IVA incluido (`null` = no objeto). */
const incluido = (cents: number, factor: 'Tasa' | 'Exento' | null, rate = 0, discountCents = 0) => ({
  satProductKey: '90101500',
  satUnitKey: 'E48',
  description: 'x',
  quantity: 1,
  unitPriceCents: cents,
  discountCents,
  taxIncluded: true,
  objetoImp: factor ? '02' : '01',
  taxes: factor ? [{ type: 'IVA' as const, factor, rate, withholding: false }] : [],
})
const tratamientoDe = (it: any) =>
  !it.taxes.length
    ? 'NO_OBJETO'
    : it.taxes[0].factor === 'Exento'
      ? 'EXENTO'
      : it.taxes[0].rate === 0.16
        ? 'IVA_16'
        : it.taxes[0].rate === 0.08
          ? 'IVA_8'
          : 'IVA_0'
/** `xmlConceptos` y `taxBreakdown` del XML que timbraría el PAC (leído con los lectores reales). */
const xmlDe = (items: any[]) => {
  const r = xmlConceptosDe(items)
  return [r.xmlConceptos, r.taxBreakdown] as const
}
const asignacionDe = (items: any[]) =>
  (
    asignacionFiscal(
      unidadesDeConceptos(items, () => 'n'),
      documentoDeConceptos(items),
      resumenDeConceptos(items),
    ) as Asignacion
  ).porTratamiento
const receptorDe = {
  rfc: 'EKU9003173C9',
  razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
  regimenFiscal: '601',
  codigoPostal: '64000',
  usoCfdi: 'G03',
}
/** Una entrada v1 de hoy para esos conceptos, con `montosPorRenglon` de la Tarea 6 (`articuloDe(i)` = el artículo de cada concepto). */
function entradaDe(items: any[], articuloDe: (i: number) => string = i => `a${i}`) {
  const montos = montosDesdeDocumento(documentoDeConceptos(items) as DocumentoFiscal)
  const a = asignacionFiscal(unidadesDeConceptos(items, articuloDe), documentoDeConceptos(items), resumenDeConceptos(items)) as Asignacion
  const ids = [...new Set(items.map((_, i) => articuloDe(i)))]
  const renglones = ids.map(id => {
    const ts = items.filter((_, i) => articuloDe(i) === id).map(tratamientoDe)
    return { orderItemId: id, tratamiento: ts.find(t => t !== 'IVA_16') ?? 'IVA_16' }
  })
  const montosPorRenglon = [...a.porClave]
    .map(([orderItemId, m]) => {
      const porTratamiento: Record<string, number> = {}
      for (const t of TRATAMIENTOS_DE_NOTA) if (m[t]) porTratamiento[t] = m[t]!.totalCents
      return { orderItemId, totalCents: Object.values(porTratamiento).reduce((x, y) => x + y, 0), porTratamiento }
    })
    .sort((x, y) => (x.orderItemId < y.orderItemId ? -1 : 1))
  return {
    version: 1,
    orderId: 'o1',
    fiscalEmisorId: 'e1',
    replacesCfdiId: null,
    contratoDePrecio: 'IVA_INCLUIDO',
    paymentStatus: 'PAID',
    clasificacion: renglones.some(r => r.tratamiento !== 'IVA_16') ? 'MIXTA' : 'TODO_16',
    paidCents: montos.totalCents,
    montos,
    renglones,
    params: { receptor: receptorDe, items, formaPago: '04', metodoPago: 'PUE', serie: 'F', idempotencyKey: 'o1' },
    montosPorRenglon,
  }
}
/** La original todo-16 de hoy: un pan de $116 al 16 %, con entrada, `montosPorRenglon` y su XML. */
const entradaTodo16 = () => entradaDe([incluido(11600, 'Tasa', 0.16)], () => 'pan')

/**
 * Una original. Por omisión la de HOY (entrada v1 todo-16 con su XML); con `entrada` en `over`, la huella, los montos de la cabecera y el
 * XML salen de esa entrada (salvo que `over` los fije); con `entrada: null` y sin protocolo, una histórica (pásale su XML).
 */
function makeOriginal(over: Partial<NonNullable<LoadedRefundForCreditNote['original']>> = {}) {
  const entrada: any = 'entrada' in over ? over.entrada : entradaTodo16()
  const [xmlConceptos, taxBreakdown] = entrada?.params?.items ? xmlDe(entrada.params.items) : [null, null]
  return {
    id: 'cfdi-ingreso-1',
    orderId: 'o1',
    protocoloIva: entrada ? 1 : null,
    entrada: entrada ?? null,
    entradaHuella: entrada ? huellaDeEntrada(entrada) : null,
    uuid: 'UUID-INGRESO-1',
    serie: 'F',
    folio: '12',
    status: 'STAMPED',
    cancelStatus: null,
    subtotalCents: entrada?.montos?.subtotalCents ?? 10000,
    taxCents: entrada?.montos?.taxCents ?? 1600,
    totalCents: entrada?.montos?.totalCents ?? 11600,
    formaPago: '04',
    metodoPago: 'PUE' as const,
    receptorRfc: 'EKU9003173C9',
    receptorNombre: 'ESCUELA KEMPER URGATE SA DE CV',
    receptorRegimen: '601',
    receptorCp: '64000',
    receptorEmail: 'cliente@example.com',
    xmlConceptos,
    taxBreakdown,
    fiscalEmisor: { id: 'e1', provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE', serie: 'F' },
    ...over,
  } as LoadedRefundForCreditNote['original']
}
/** Una original individual de hoy con esos conceptos. */
const originalDe = (items: any[], articuloDe: (i: number) => string = i => `a${i}`) =>
  makeOriginal({ entrada: entradaDe(items, articuloDe) })
/** La mezclada del plan: café $200 al 0 % + pan $58 al 16 %. */
const originalMixta = () => originalDe([incluido(20000, 'Tasa', 0), incluido(5800, 'Tasa', 0.16)], i => ['cafe', 'pan'][i])
/** Una histórica: sin protocolo ni entrada; sólo su XML (C2-P5). */
const originalHistorica = (xmlConceptos: unknown, taxBreakdown: unknown, totalCents: number) =>
  makeOriginal({ entrada: null, protocoloIva: null, xmlConceptos, taxBreakdown, totalCents })

function makeLoaded(over: Partial<LoadedRefundForCreditNote> = {}): LoadedRefundForCreditNote {
  return {
    venueId: 'v1',
    venueSlug: 'demo',
    refund: {
      id: 'pay-refund-1',
      orderId: 'o1',
      type: 'REFUND',
      status: 'COMPLETED',
      // El reembolso se guarda NEGATIVO; el loader lo entrega en centavos POSITIVOS ya separado.
      salesRefundCents: 11600,
      tipRefundCents: 0,
      method: 'CREDIT_CARD',
      tenderSatFormaPago: null,
    },
    original: makeOriginal(),
    // El desglose real de tasas de la orden (una sola tasa 16% por defecto).
    grossByRate: [{ rate: 0.16, grossCents: 11600 }],
    alreadyCreditedCents: 0,
    acreditado: { notas: [], desconocidoCents: 0, porRenglon: new Map(), alreadyCreditedCents: 0, extraida: false },
    ...over,
  }
}

describe('checkCreditNoteEligibility (puro) — lo que decide si el botón se pinta', () => {
  it('caso normal → elegible, sin mensaje', () => {
    expect(checkCreditNoteEligibility(makeLoaded())).toEqual({ eligible: true, reason: null, message: null })
  })

  it('🔴 cuando NO procede, siempre trae un motivo Y un texto en español (apagado se VE y se EXPLICA)', () => {
    const cases: Array<[LoadedRefundForCreditNote, string]> = [
      [makeLoaded({ original: null }), 'NO_ORIGINAL_CFDI'],
      [makeLoaded({ original: makeOriginal({ cancelStatus: 'CANCELLED' }) }), 'ORIGINAL_CANCELLED'],
      // C2 T7: lo acreditado es la asignación de las notas vivas (`acreditado`), no un total suelto.
      [
        makeLoaded({ acreditado: { ...makeLoaded().acreditado, notas: [asignacionDe([incluido(11600, 'Tasa', 0.16)])] } }),
        'EXCEEDS_REMAINING',
      ],
    ]
    for (const [loaded, reason] of cases) {
      const res = checkCreditNoteEligibility(loaded)
      expect(res.eligible).toBe(false)
      expect(res.reason).toBe(reason)
      expect(res.message && res.message.length).toBeGreaterThan(10)
    }
  })

  it('acreditar EXACTAMENTE el saldo restante sí procede (el tope es inclusivo)', () => {
    const loaded = makeLoaded({ acreditado: { ...makeLoaded().acreditado, notas: [asignacionDe([incluido(5000, 'Tasa', 0.16)])] } })
    loaded.refund.salesRefundCents = 6600 // 11600 - 5000
    expect(checkCreditNoteEligibility(loaded).eligible).toBe(true)
  })
})

// C2 · Tarea 3: ninguna nota contra una original con cancelación en trámite. `REQUESTED` es la columna; su estado fino (anotada,
// enviándose, en duda, acusada) lo deriva `estadoDeCancelacion` y la guarda bloquea con cualquiera de ellos.
describe('C2 · cancelación en trámite', () => {
  // T10 (M2 de la T3), cambio A PROPÓSITO: el texto «en trámite ante el SAT» es el de una cancelación ACUSADA (el SAT la tiene); antes
  // salía también con la intención sólo anotada. Los otros estados tienen su texto (abajo, «C2 · T10 · el texto según el estado»).
  it('🔴 original con cancelación en trámite (acusada) ⇒ la nota espera, con su texto', () => {
    const acusada = { cancelStatus: 'REQUESTED', cancelIntento: 1, cancelEnviadaAt: new Date(), cancelAcusadaAt: new Date() } as any
    expect(checkCreditNoteEligibility(makeLoaded({ original: makeOriginal(acusada) }))).toEqual({
      eligible: false,
      reason: 'ORIGINAL_CANCEL_PENDING',
      message: MOTIVO_ORIGINAL_EN_CANCELACION,
    })
  })
  it('🔴 también con una original con entrada (protocolo 1): la guarda va antes de leer la entrada', () => {
    const loaded = makeLoaded({ original: makeOriginal({ cancelStatus: 'REQUESTED', protocoloIva: 1 }) })
    expect(checkCreditNoteEligibility(loaded).reason).toBe('ORIGINAL_CANCEL_PENDING')
  })
  it('control: una cancelación rechazada no estorba (la original sigue vigente)', () => {
    expect(checkCreditNoteEligibility(makeLoaded({ original: makeOriginal({ cancelStatus: 'REJECTED' }) })).eligible).toBe(true)
  })
  it('control: una cancelación aceptada o cancelada sigue diciendo ORIGINAL_CANCELLED (no «en trámite»)', () => {
    for (const cancelStatus of ['ACCEPTED', 'CANCELLED'])
      expect(checkCreditNoteEligibility(makeLoaded({ original: makeOriginal({ cancelStatus }) })).reason).toBe('ORIGINAL_CANCELLED')
  })
})

// C2 · Tarea 3, ronda 1 (I1, el espejo de G4): con una sustitución EN CURSO de la original, la nota espera. Si saliera, la cancelación
// motivo 01 de la original la encontraría viva y se rechazaría: dos facturas de ingreso vivas por la misma venta.
describe('C2 · sustitución en curso (I1)', () => {
  it('🔴 original con una sustituta viva en curso ⇒ la nota espera, con su texto', () => {
    expect(checkCreditNoteEligibility(makeLoaded({ original: makeOriginal({ sustitutaEnCurso: true }) }))).toEqual({
      eligible: false,
      reason: 'ORIGINAL_EN_SUSTITUCION',
      message: MOTIVO_ORIGINAL_EN_SUSTITUCION,
    })
  })
  it('control: sin sustituta en curso (false o sin el campo) la nota procede', () => {
    expect(checkCreditNoteEligibility(makeLoaded({ original: makeOriginal({ sustitutaEnCurso: false }) })).eligible).toBe(true)
    expect(checkCreditNoteEligibility(makeLoaded()).eligible).toBe(true)
  })

  /** Un `tx` doble: la original elegida es `c1`; `sustituta` es lo que devuelve la búsqueda por `replacesCfdiId`. */
  function txConSustituta(sustituta: { id: string } | null) {
    const findFirst = jest.fn(async ({ where }: any) =>
      where.replacesCfdiId !== undefined ? sustituta : { id: 'c1', orderId: 'o1', cancelStatus: null, entrada: null },
    )
    const tx = {
      payment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'r1',
          venueId: 'v1',
          orderId: 'o1',
          type: 'REFUND',
          status: 'COMPLETED',
          amount: -10,
          tipAmount: 0,
          method: 'CASH',
          tenderSatFormaPago: null,
        }),
      },
      order: { findUnique: jest.fn().mockResolvedValue({ venue: { slug: 'demo' } }) },
      cfdi: {
        findFirst,
        aggregate: jest.fn().mockResolvedValue({ _sum: { totalCents: 0 } }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any
    return { tx, findFirst }
  }

  it('🔴 el cargador pregunta por la sustituta VIVA de la original elegida (INGRESO, replacesCfdiId, CFDI_VIVO) y lo dice', async () => {
    const { tx, findFirst } = txConSustituta({ id: 'B' })
    const loaded = await loadRefundForCreditNoteFromDb('v1', 'r1', tx)
    expect(loaded!.original!.sustitutaEnCurso).toBe(true)
    const busqueda = findFirst.mock.calls.map(c => c[0]).find(a => a.where.replacesCfdiId !== undefined)
    // T10 (N1 de la re-revisión de la T3), cambio A PROPÓSITO: el `select` gana `status` y `enviadoAt` (¿la sustituta se atoró?).
    expect(busqueda).toEqual({
      where: { venueId: 'v1', replacesCfdiId: 'c1', type: 'INGRESO', ...CFDI_VIVO },
      select: { id: true, status: true, enviadoAt: true },
    })
  })
  it('control: sin sustituta viva, el cargador dice false', async () => {
    const { tx } = txConSustituta(null)
    expect((await loadRefundForCreditNoteFromDb('v1', 'r1', tx))!.original!.sustitutaEnCurso).toBe(false)
  })
})

// C2 · Tarea 10 (M2 de la T3): el texto dice en qué va la cancelación de la original (se está enviando · en duda · en trámite). Bloquear
// sigue siendo lo correcto en los tres (alguien todavía puede ganar el envío sobre un REQUESTED).
describe('C2 · T10 · el texto según el estado de la cancelación de la original (M2 de la T3)', () => {
  const T = new Date('2026-10-05T18:00:00.000Z')
  afterEach(() => jest.useRealTimers())
  const motivoA = (ahora: Date, over: Record<string, unknown>) => {
    jest.useFakeTimers({ now: ahora, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
    const e = checkCreditNoteEligibility(makeLoaded({ original: makeOriginal({ cancelStatus: 'REQUESTED', ...over } as any) }))
    jest.useRealTimers()
    return e
  }
  it('🔴 anotada (sin enviar) o enviándose ⇒ «se está enviando al SAT», nunca «en trámite»', () => {
    for (const e of [
      motivoA(T, { cancelIntento: 1, cancelEnviadaAt: null, cancelAcusadaAt: null }),
      motivoA(new Date(T.getTime() + 30_000), { cancelIntento: 1, cancelEnviadaAt: T, cancelAcusadaAt: null }),
    ]) {
      expect(e).toEqual({ eligible: false, reason: 'ORIGINAL_CANCEL_PENDING', message: MOTIVO_ORIGINAL_CANCELACION_ENVIANDOSE })
      expect(e.message).not.toMatch(/en trámite/)
    }
  })
  it('🔴 en duda ⇒ «en duda … hasta 24 horas»', () => {
    const e = motivoA(new Date(T.getTime() + ENVIO_TERMINADO_MS + 1_000), { cancelIntento: 1, cancelEnviadaAt: T, cancelAcusadaAt: null })
    expect(e).toEqual({ eligible: false, reason: 'ORIGINAL_CANCEL_PENDING', message: MOTIVO_ORIGINAL_CANCELACION_EN_DUDA })
    expect(e.message).toMatch(/en duda/)
    expect(e.message).toMatch(/hasta 24 horas/)
  })
  it('control — acusada o de antes de C2 (intento 0) ⇒ el texto de «en trámite ante el SAT»', () => {
    expect(motivoA(T, { cancelIntento: 1, cancelEnviadaAt: T, cancelAcusadaAt: T }).message).toBe(MOTIVO_ORIGINAL_EN_CANCELACION)
    expect(motivoA(T, { cancelIntento: 0, cancelEnviadaAt: null, cancelAcusadaAt: null }).message).toBe(MOTIVO_ORIGINAL_EN_CANCELACION)
  })
  it('🔴 el cargador trae lo que hace falta para derivarlo (intento, envío y acuse de la original)', async () => {
    const findFirst = jest.fn(async ({ where }: any) =>
      where.replacesCfdiId !== undefined ? null : { id: 'c1', orderId: 'o1', cancelStatus: null, entrada: null },
    )
    const tx = {
      payment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'r1',
          venueId: 'v1',
          orderId: 'o1',
          type: 'REFUND',
          status: 'COMPLETED',
          amount: -10,
          tipAmount: 0,
          method: 'CASH',
          tenderSatFormaPago: null,
        }),
      },
      order: { findUnique: jest.fn().mockResolvedValue({ venue: { slug: 'demo' } }) },
      cfdi: { findFirst, aggregate: jest.fn().mockResolvedValue({ _sum: { totalCents: 0 } }), findMany: jest.fn().mockResolvedValue([]) },
    } as any
    await loadRefundForCreditNoteFromDb('v1', 'r1', tx)
    const deLaOriginal = findFirst.mock.calls.map(c => c[0]).find(a => a.where.replacesCfdiId === undefined)
    expect(deLaOriginal.select).toMatchObject({ cancelIntento: true, cancelEnviadaAt: true, cancelAcusadaAt: true })
  })
})

// C2 · Tarea 10 (N1 de la re-revisión de la T3): «espera a que termine» no puede prometer que alguien la termine. Una sustituta ENVIADA
// al PAC hace más de una hora y sin resolver se queda viva hasta que soporte la resuelva: el texto lo dice.
describe('C2 · T10 · sustituta atorada (N1 de la T3)', () => {
  it('🔴 sustituta en curso y atorada ⇒ el texto pide escribir a soporte', () => {
    const e = checkCreditNoteEligibility(makeLoaded({ original: makeOriginal({ sustitutaEnCurso: true, sustitutaAtorada: true } as any) }))
    expect(e).toEqual({ eligible: false, reason: 'ORIGINAL_EN_SUSTITUCION', message: MOTIVO_ORIGINAL_EN_SUSTITUCION_ATORADA })
    expect(e.message).toMatch(/soporte/)
    expect(e.message).not.toMatch(/espera a que termine/)
  })
  it('control — en curso sin atorarse ⇒ «espera a que termine»', () => {
    const e = checkCreditNoteEligibility(makeLoaded({ original: makeOriginal({ sustitutaEnCurso: true, sustitutaAtorada: false } as any) }))
    expect(e.message).toBe(MOTIVO_ORIGINAL_EN_SUSTITUCION)
  })
  it('🔴 el cargador la marca atorada sólo si se ENVIÓ hace más de una hora y no se timbró', async () => {
    const hora = 60 * 60_000
    const casos: Array<[{ status: string; enviadoAt: Date | null } | null, boolean]> = [
      [{ status: 'STAMPING', enviadoAt: new Date(Date.now() - hora - 1_000) }, true],
      [{ status: 'STAMP_FAILED', enviadoAt: new Date(Date.now() - 2 * hora) }, true],
      [{ status: 'STAMPING', enviadoAt: new Date(Date.now() - 5 * 60_000) }, false],
      [{ status: 'STAMPING', enviadoAt: null }, false],
      [null, false],
    ]
    for (const [sustituta, atorada] of casos) {
      const findFirst = jest.fn(async ({ where }: any) =>
        where.replacesCfdiId !== undefined
          ? sustituta && { id: 'B', ...sustituta }
          : { id: 'c1', orderId: 'o1', cancelStatus: null, entrada: null },
      )
      const tx = {
        payment: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'r1',
            venueId: 'v1',
            orderId: 'o1',
            type: 'REFUND',
            status: 'COMPLETED',
            amount: -10,
            tipAmount: 0,
            method: 'CASH',
            tenderSatFormaPago: null,
          }),
        },
        order: { findUnique: jest.fn().mockResolvedValue({ venue: { slug: 'demo' } }) },
        cfdi: { findFirst, aggregate: jest.fn().mockResolvedValue({ _sum: { totalCents: 0 } }), findMany: jest.fn().mockResolvedValue([]) },
      } as any
      const o = (await loadRefundForCreditNoteFromDb('v1', 'r1', tx))!.original!
      expect([sustituta, !!o.sustitutaAtorada]).toEqual([sustituta, atorada])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Helper puro de reparto (cuadre al centavo)
// ─────────────────────────────────────────────────────────────────────────────
describe('buildCreditNoteLines (puro)', () => {
  it('una sola tasa → una partida por el importe completo', () => {
    const lines = buildCreditNoteLines(11600, [{ rate: 0.16, grossCents: 11600 }], 0.16)
    expect(lines).toEqual([{ grossCents: 11600, rate: 0.16 }])
  })

  it('sin desglose de la orden → una partida a la tasa de respaldo', () => {
    expect(buildCreditNoteLines(5000, [], 0)).toEqual([{ grossCents: 5000, rate: 0 }])
  })

  it('🔴 reparto proporcional que NO divide exacto: las partes suman EXACTAMENTE el importe', () => {
    const lines = buildCreditNoteLines(
      1000,
      [
        { rate: 0.16, grossCents: 3333 },
        { rate: 0.08, grossCents: 3333 },
        { rate: 0, grossCents: 3334 },
      ],
      0.16,
    )
    expect(lines.reduce((a, l) => a + l.grossCents, 0)).toBe(1000)
  })

  it('descarta las tasas a las que no les tocó ni un centavo', () => {
    const lines = buildCreditNoteLines(
      100,
      [
        { rate: 0.16, grossCents: 1000000 },
        { rate: 0, grossCents: 1 },
      ],
      0.16,
    )
    expect(lines.every(l => l.grossCents > 0)).toBe(true)
    expect(lines.reduce((a, l) => a + l.grossCents, 0)).toBe(100)
  })
})

describe('precondiciones fiscales conservadas', () => {
  it.each([
    ['type', 'REGULAR', 'NOT_A_REFUND'],
    ['status', 'PENDING', 'REFUND_NOT_COMPLETED'],
    ['salesRefundCents', 0, 'TIP_ONLY'],
  ] as const)('%s inválido no permite emitir', (field, value, reason) => {
    const loaded = makeLoaded()
    Object.assign(loaded.refund, { [field]: value })
    expect(checkCreditNoteEligibility(loaded)).toMatchObject({ eligible: false, reason })
  })
  // C2 T7: la histórica ya no es «la de por omisión»: se arma con su XML (C2-P5).
  it('sólo protocoloNULL sin entrada puede usar compatibilidad histórica', () => {
    const loaded = makeLoaded({ original: originalHistorica(...xmlDe([incluido(11600, 'Tasa', 0.16)]), 11600) })
    loaded.original!.protocoloIva = 1
    expect(checkCreditNoteEligibility(loaded).reason).toBe('ORIGINAL_ENTRADA_INVALIDA')
    loaded.original!.protocoloIva = null
    expect(checkCreditNoteEligibility(loaded).eligible).toBe(true)
  })
})

describe('D9: la nota relee el precio por kilo de 6 decimales de la factura original', () => {
  const entradaPeso = (unitPriceDecimal: string) => ({
    version: 1,
    orderId: 'o1',
    fiscalEmisorId: 'e1',
    replacesCfdiId: null,
    contratoDePrecio: 'IVA_INCLUIDO',
    paymentStatus: 'PAID',
    clasificacion: 'TODO_16',
    paidCents: 6916,
    montos: { subtotalCents: 5962, taxCents: 954, totalCents: 6916 },
    renglones: [{ orderItemId: 'oi-jamon', tratamiento: 'IVA_16' }],
    params: {
      receptor: {
        rfc: 'EKU9003173C9',
        razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
        regimenFiscal: '601',
        codigoPostal: '64000',
        usoCfdi: 'G03',
      },
      items: [
        {
          satProductKey: '50112000',
          satUnitKey: 'KGM',
          description: 'Jamón',
          quantity: 1.537,
          unitPriceCents: 4500,
          unitPriceDecimal,
          discountCents: 0,
          objetoImp: '02',
          taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
          taxIncluded: true,
        },
      ],
      formaPago: '04',
      metodoPago: 'PUE',
      serie: 'F',
      idempotencyKey: 'o1',
    },
  })
  const conEntrada = (entrada: any) =>
    makeLoaded({
      refund: { ...makeLoaded().refund, salesRefundCents: 6916 },
      original: makeOriginal({
        protocoloIva: 1,
        entrada,
        entradaHuella: huellaDeEntrada(entrada),
        subtotalCents: 5962,
        taxCents: 954,
        totalCents: 6916,
      }),
      grossByRate: [{ rate: 0.16, grossCents: 6916 }],
    })

  it('🔴 con el precio decimal, la entrada cuadra y la nota procede (con $45.00 daría 69.17 y la tomaría por inválida)', () => {
    expect(checkCreditNoteEligibility(conEntrada(entradaPeso('44.996747')))).toEqual({ eligible: true, reason: null, message: null })
  })
  it('control: un precio decimal mal formado (7 decimales) invalida la entrada', () => {
    expect(checkCreditNoteEligibility(conEntrada(entradaPeso('44.9967471'))).reason).toBe('ORIGINAL_ENTRADA_INVALIDA')
  })
})

describe('6b: una factura ajustada guarda los montos del PAC (base neta, IVA por tasa, total = lo cobrado)', () => {
  // $65 con $2.50 propios, IVA incluido: el PAC daba $62.49, el cargador bajó el descuento a $2.49 y guardó lo que dice el XML.
  const entradaAjustada = (montos: { subtotalCents: number; taxCents: number; totalCents: number }) => ({
    version: 1,
    orderId: 'o1',
    fiscalEmisorId: 'e1',
    replacesCfdiId: null,
    contratoDePrecio: 'IVA_INCLUIDO',
    paymentStatus: 'PAID',
    clasificacion: 'TODO_16',
    paidCents: 6250,
    montos,
    renglones: [{ orderItemId: 'oi-latte', tratamiento: 'IVA_16' }],
    params: {
      receptor: {
        rfc: 'EKU9003173C9',
        razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
        regimenFiscal: '601',
        codigoPostal: '64000',
        usoCfdi: 'G03',
      },
      items: [
        {
          satProductKey: '90101500',
          satUnitKey: 'E48',
          description: 'Latte',
          quantity: 1,
          unitPriceCents: 6500,
          discountCents: 249,
          objetoImp: '02',
          taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
          taxIncluded: true,
        },
      ],
      formaPago: '04',
      metodoPago: 'PUE',
      serie: 'F',
      idempotencyKey: 'o1',
    },
  })
  const conMontos = (montos: { subtotalCents: number; taxCents: number; totalCents: number }) => {
    const entrada = entradaAjustada(montos)
    return makeLoaded({
      refund: { ...makeLoaded().refund, salesRefundCents: 6250 },
      original: makeOriginal({ protocoloIva: 1, entrada, entradaHuella: huellaDeEntrada(entrada), ...montos }),
      grossByRate: [{ rate: 0.16, grossCents: 6250 }],
    })
  }

  it('6b: una factura ajustada (montos del PAC) se puede acreditar', () => {
    expect(checkCreditNoteEligibility(conMontos({ subtotalCents: 5388, taxCents: 862, totalCents: 6250 }))).toEqual({
      eligible: true,
      reason: null,
      message: null,
    })
  })
  it('6b: montos que suman bien pero no son ni por concepto ni del PAC ⇒ ORIGINAL_ENTRADA_INVALIDA', () => {
    // 5389 + 861 = 6250: suman, así que sólo la regla nueva (Codex r2 N8) puede rechazarlos.
    expect(checkCreditNoteEligibility(conMontos({ subtotalCents: 5389, taxCents: 861, totalCents: 6250 })).reason).toBe(
      'ORIGINAL_ENTRADA_INVALIDA',
    )
  })
  it('control: montos que ni siquiera suman ⇒ ORIGINAL_ENTRADA_INVALIDA', () => {
    expect(checkCreditNoteEligibility(conMontos({ subtotalCents: 5388, taxCents: 862, totalCents: 6251 })).reason).toBe(
      'ORIGINAL_ENTRADA_INVALIDA',
    )
  })
})

// ─── Bloque C1, Tarea 2: control de la factura con IVA aparte y ajuste de la 6b (B3a F1; v9, C1-46) ───
describe('C1 · control — una factura con IVA aparte ajustada por la 6b guarda los montos del PAC y se puede acreditar', () => {
  // R1 de la 6b: 2 × $2.03 con $1 c/u, IVA APARTE. El PAC daría $2.39 y se cobró $2.38 ⇒ uno de los descuentos pasa a $1.01.
  // Lo que se guarda es lo que dice el XML (2.05 + 0.33 = 2.38), no el subtotal bruto de la cabecera (4.06).
  const pieza = (discountCents: number) => ({
    satProductKey: '90101500',
    satUnitKey: 'E48',
    description: 'PIEZA',
    quantity: 1,
    unitPriceCents: 203,
    discountCents,
    objetoImp: '02',
    taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
    taxIncluded: false,
  })
  const entradaIvaAparte = () => ({
    version: 1,
    orderId: 'o1',
    fiscalEmisorId: 'e1',
    replacesCfdiId: null,
    contratoDePrecio: 'IVA_APARTE',
    paymentStatus: 'PAID',
    clasificacion: 'TODO_16',
    paidCents: 238,
    montos: { subtotalCents: 205, taxCents: 33, totalCents: 238 },
    renglones: [
      { orderItemId: 'oi-a', tratamiento: 'IVA_16' },
      { orderItemId: 'oi-b', tratamiento: 'IVA_16' },
    ],
    params: {
      receptor: {
        rfc: 'EKU9003173C9',
        razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
        regimenFiscal: '601',
        codigoPostal: '64000',
        usoCfdi: 'G03',
      },
      items: [pieza(101), pieza(100)],
      formaPago: '04',
      metodoPago: 'PUE',
      serie: 'F',
      idempotencyKey: 'o1',
    },
  })

  it('control — entrada TODO_16 con IVA aparte y ajuste (2.05 + 0.33 = 2.38), reembolso de $1 ⇒ elegible, sin motivo ni mensaje', () => {
    const entrada = entradaIvaAparte()
    const montos = { subtotalCents: 205, taxCents: 33, totalCents: 238 }
    const loaded = makeLoaded({
      refund: { ...makeLoaded().refund, salesRefundCents: 100 },
      original: makeOriginal({ protocoloIva: 1, entrada, entradaHuella: huellaDeEntrada(entrada), ...montos }),
      grossByRate: [{ rate: 0.16, grossCents: 238 }],
    })
    expect(checkCreditNoteEligibility(loaded)).toEqual({ eligible: true, reason: null, message: null })
  })
})

// ─── C2 · Tarea 7: la nota v2 ─────────────────────────────────────────────────
describe('C2 · notas v2', () => {
  it('🔴 original todo-16 de hoy: la nota sale v2 con 84111506/ACT, PUE y G02 (C2-P3)', () => {
    const r = notaPorTratamiento(makeLoaded({})) as any
    expect(r.items).toEqual([
      expect.objectContaining({
        satProductKey: '84111506',
        satUnitKey: 'ACT',
        unitPriceCents: makeLoaded({}).refund.salesRefundCents,
        taxIncluded: true,
      }),
    ])
  })
  it('🔴 C2-13: una original con entrada pero SIN el XML (sin xmlConceptos) espera; con su XML, sale (v2 no esperaba)', () => {
    expect(checkCreditNoteEligibility(makeLoaded({ original: makeOriginal({ xmlConceptos: null }) }))).toMatchObject({
      eligible: false,
      reason: 'ESPERA_XML',
    })
    expect(checkCreditNoteEligibility(makeLoaded({ original: makeOriginal({ taxBreakdown: null }) }))).toMatchObject({
      eligible: false,
      reason: 'ESPERA_XML',
    })
    expect(checkCreditNoteEligibility(makeLoaded({})).eligible).toBe(true)
  })
  it('🔴 C2-10: original de $65 IVA incluido con $2.49 de descuento: queda lo del documento (62.50); devolver 62.50 cabe y 62.51 no', () => {
    const loaded = makeLoaded({ original: originalDe([incluido(6500, 'Tasa', 0.16, 249)]) }) // entrada + xmlDe; montos del documento
    loaded.refund.salesRefundCents = 6250
    expect(checkCreditNoteEligibility(loaded).eligible).toBe(true)
    loaded.refund.salesRefundCents = 6251
    expect(checkCreditNoteEligibility(loaded)).toMatchObject({ eligible: false, reason: 'EXCEEDS_REMAINING' })
  })
  it('🔴 por artículos (sólo el café) sobre una original mezclada: todo al 0 %, con su porRenglon', () => {
    const loaded = makeLoaded({ original: originalMixta() })
    loaded.refund.salesRefundCents = 20000
    loaded.refund.processorData = { refundedItems: [{ orderItemId: 'cafe', amountCents: 20000 }] }
    expect(notaPorTratamiento(loaded)).toMatchObject({
      entradaParcial: {
        modalidad: 'POR_ARTICULOS',
        brutoPorTratamiento: { IVA_0: 20000 },
        porRenglon: [{ orderItemId: 'cafe', totalCents: 20000, porTratamiento: { IVA_0: 20000 } }],
      },
    })
  })
  it('🔴 C2-12: una factura sin montosPorRenglon (anterior a C2) con UNA sola tasa: por artículos se detiene (falta evidencia)', () => {
    const loaded = makeLoaded({ original: makeOriginal({ entrada: { ...entradaTodo16(), montosPorRenglon: undefined } }) })
    loaded.refund.processorData = { refundedItems: [{ orderItemId: 'pan', amountCents: loaded.refund.salesRefundCents }] }
    expect(checkCreditNoteEligibility(loaded)).toMatchObject({ eligible: false, reason: 'SIN_MONTO_POR_ARTICULO' })
  })
  it('🔴 C2-5/C2-8: histórica al 0 % ⇒ la nota sale al 0 %, no como «no objeto» (C2-P5: por su XML)', () => {
    const items = [incluido(5000, 'Tasa', 0)]
    const loaded = makeLoaded({ original: originalHistorica(...xmlDe(items), 5000) })
    loaded.refund.salesRefundCents = 2000
    // (el plan leía `items[0].taxes`; con el cuerpo neutro eso es un TypeError: se compara la lista, rojo por aserción)
    expect((notaPorTratamiento(loaded) as any).items.map((i: any) => i.taxes)).toEqual([
      [{ type: 'IVA', factor: 'Tasa', rate: 0, withholding: false }],
    ])
  })
  it('🔴 C2-14: histórica de $116 al 16 % + $0.01 no objeto: devolver todo da $116 al 16 % y $0.01 no objeto (v2 sumaba el centavo al 16 %); una histórica toda no objeto de $0.01 tiene nota', () => {
    const items = [incluido(11600, 'Tasa', 0.16), incluido(1, null)]
    const loaded = makeLoaded({ original: originalHistorica(...xmlDe(items), 11601) })
    loaded.refund.salesRefundCents = 11601
    expect((notaPorTratamiento(loaded) as any).entradaParcial.brutoPorTratamiento).toEqual({ IVA_16: 11600, NO_OBJETO: 1 })
    const soloNoObjeto = makeLoaded({ original: originalHistorica(...xmlDe([incluido(1, null)]), 1) })
    soloNoObjeto.refund.salesRefundCents = 1
    expect(checkCreditNoteEligibility(soloNoObjeto).eligible).toBe(true)
  })
  it('🔴 una original con entrada cuyo XML no coincide con sus conceptos ⇒ revisión de soporte', () => {
    const mal = originalMixta()!
    mal.taxBreakdown = [{ impuesto: '002', tipoFactor: 'Tasa', tasa: '0.160000', base: '50.00', importe: '8.01' }]
    expect(checkCreditNoteEligibility(makeLoaded({ original: mal }))).toMatchObject({ reason: 'ORIGINAL_ENTRADA_INVALIDA' })
  })
  it('🔴 una nota previa v2 al 0 % por $150: lo que queda del café es $50 y devolver $100 del café se detiene', () => {
    const loaded = makeLoaded({ original: originalMixta() })
    loaded.acreditado = {
      ...loaded.acreditado,
      notas: [{ IVA_0: { baseCents: 15000, ivaCents: 0, totalCents: 15000 } }],
      porRenglon: new Map([['cafe', { IVA_0: 15000 }]]),
      alreadyCreditedCents: 15000,
    }
    loaded.refund.salesRefundCents = 10000
    loaded.refund.processorData = { refundedItems: [{ orderItemId: 'cafe', amountCents: 10000 }] }
    expect(checkCreditNoteEligibility(loaded)).toMatchObject({ eligible: false, reason: 'ARTICULO_EXCEDE_LO_FACTURADO' })
  })
  it('🔴 C2-19: un artículo facturado 100/100 (16 % / 0 %) con una nota previa por artículos de 101 (51/50): la segunda de 99 sale 49/50', () => {
    const loaded = makeLoaded({ original: originalDe([incluido(100, 'Tasa', 0.16), incluido(100, 'Tasa', 0)], () => 'a') }) // dos conceptos del MISMO artículo
    loaded.acreditado = {
      ...loaded.acreditado,
      notas: [asignacionDe([incluido(51, 'Tasa', 0.16), incluido(50, 'Tasa', 0)])],
      porRenglon: new Map([['a', { IVA_16: 51, IVA_0: 50 }]]),
      alreadyCreditedCents: 101,
    }
    loaded.refund.salesRefundCents = 99
    loaded.refund.processorData = { refundedItems: [{ orderItemId: 'a', amountCents: 99 }] }
    expect(notaPorTratamiento(loaded)).toMatchObject({
      entradaParcial: {
        brutoPorTratamiento: { IVA_16: 49, IVA_0: 50 },
        porRenglon: [{ orderItemId: 'a', totalCents: 99, porTratamiento: { IVA_16: 49, IVA_0: 50 } }],
      },
    })
  })
  it('🔴 C1-30 en la nota: un error de armado (los conceptos no suman lo devuelto de su tasa) ⇒ se detiene con «error al armarla» y la búsqueda no corre', () => {
    const real = payloadBuilder.conceptosDeNota
    const armado = jest
      .spyOn(payloadBuilder, 'conceptosDeNota')
      .mockImplementation((...a: any[]) => real(...(a as [any, any, any])).map(c => ({ ...c, unitPriceCents: c.unitPriceCents + 100 })))
    const busqueda = jest.spyOn(regla, 'cuadrarConElPac')
    const loaded = makeLoaded({ original: originalMixta() })
    loaded.refund.salesRefundCents = 20000
    loaded.refund.processorData = { refundedItems: [{ orderItemId: 'cafe', amountCents: 20000 }] }
    expect(notaPorTratamiento(loaded)).toMatchObject({
      eligible: false,
      reason: 'NO_CUADRA_CON_EL_PAC',
      message: expect.stringContaining('error al armarla'),
    })
    expect(busqueda).not.toHaveBeenCalled()
    armado.mockRestore()
    busqueda.mockRestore()
  })
  it('🔴 C2-19: porRenglonValido — cada renglón suma su total por tratamiento y los renglones suman lo devuelto y el bruto', () => {
    const e = {
      modalidad: 'POR_ARTICULOS',
      devueltoCents: 99,
      brutoPorTratamiento: { IVA_16: 49, IVA_0: 50 },
      porRenglon: [{ orderItemId: 'a', totalCents: 99, porTratamiento: { IVA_16: 49, IVA_0: 50 } }],
    } as any
    expect(porRenglonValido(e)).toBe(true)
    expect(porRenglonValido({ ...e, porRenglon: [{ ...e.porRenglon[0], porTratamiento: { IVA_16: 50, IVA_0: 49 } }] })).toBe(false)
    expect(porRenglonValido({ ...e, porRenglon: [{ orderItemId: 'a', totalCents: 99 }] })).toBe(false)
    expect(porRenglonValido({ ...e, modalidad: 'POR_IMPORTE' })).toBe(false)
  })
  it('🔴 C2-15 (C2-P8): original de $0.04 con una nota previa de $0.02: la segunda de $0.02 cabe y registra 1 ¢ de BASE en el ámbito de la factura', () => {
    const loaded = makeLoaded({ original: originalDe([incluido(4, 'Tasa', 0.16)]) })
    loaded.acreditado = { ...loaded.acreditado, notas: [asignacionDe([incluido(2, 'Tasa', 0.16)])], alreadyCreditedCents: 2 }
    loaded.refund.salesRefundCents = 2
    expect(notaPorTratamiento(loaded)).toMatchObject({
      entradaParcial: { redondeo: [{ tratamiento: 'IVA_16', componente: 'BASE', cents: 1, ambito: 'FACTURA' }] },
    })
  })

  it('🔴 C2-15 (P8), Review Focus 2: $100 al 16 % devueltos en dos de $50: la segunda agota con 1 ¢ de IVA de más (registrado); una tercera no cabe', () => {
    const loaded = makeLoaded({ original: originalDe([incluido(10000, 'Tasa', 0.16)]) })
    loaded.refund.salesRefundCents = 5000
    const primera = notaPorTratamiento(loaded) as any
    expect(primera.entradaParcial.redondeo).toEqual([])
    loaded.acreditado = { ...loaded.acreditado, notas: [primera.entradaParcial.porTratamiento], alreadyCreditedCents: 5000 }
    expect(notaPorTratamiento(loaded)).toMatchObject({
      entradaParcial: { redondeo: [{ tratamiento: 'IVA_16', componente: 'IVA', cents: 1, ambito: 'FACTURA' }] },
    })
    const segunda = (notaPorTratamiento(loaded) as any).entradaParcial.porTratamiento
    loaded.acreditado = { ...loaded.acreditado, notas: [primera.entradaParcial.porTratamiento, segunda], alreadyCreditedCents: 10000 }
    loaded.refund.salesRefundCents = 1
    expect(checkCreditNoteEligibility(loaded)).toMatchObject({ eligible: false, reason: 'EXCEEDS_REMAINING' })
  })

  // ─── Lo que agregan los «Ajustes del controlador» (9-oct) y las notas de T2-T6 ───
  it('🔴 la entrada parcial lleva lo fiscal de la NOTA con la misma asignación (C2-10) y lo devuelto; la original mezclada por importe se reparte sobre lo que queda', () => {
    const loaded = makeLoaded({ original: originalMixta() })
    loaded.refund.salesRefundCents = 5800 // $258 facturados: 200 al 0 % y 58 al 16 %
    const r = notaPorTratamiento(loaded) as any
    expect(r.entradaParcial.modalidad).toBe('POR_IMPORTE')
    expect(r.entradaParcial.devueltoCents).toBe(5800)
    expect(r.entradaParcial.brutoPorTratamiento).toEqual({ IVA_16: 1304, IVA_0: 4496 }) // 58/258 y 200/258 de $58
    expect(r.entradaParcial.porTratamiento).toEqual(asignacionDe(r.items))
    expect(r.items.map((i: any) => i.unitPriceCents)).toEqual([1304, 4496])
  })
  it('🔴 la propina nunca entra: lo que se acredita es la venta devuelta', () => {
    const loaded = makeLoaded({})
    loaded.refund.salesRefundCents = 5000
    loaded.refund.tipRefundCents = 1000
    expect((notaPorTratamiento(loaded) as any).entradaParcial.brutoPorTratamiento).toEqual({ IVA_16: 5000 })
  })
  it('🔴 un reparto de delivery inválido detiene (nunca cae a proporcional)', () => {
    const loaded = makeLoaded({})
    loaded.refund.processorData = { provenance: 'PROVIDER_ADJUSTMENT', fiscalByRateCents: 'basura' }
    expect(checkCreditNoteEligibility(loaded)).toMatchObject({ eligible: false, reason: 'REPARTO_DE_ENTREGA_INVALIDO' })
  })
  it('🔴 8 % fronterizo: una nota que tendría algo al 8 % se detiene con su motivo', () => {
    const loaded = makeLoaded({ original: originalDe([incluido(10800, 'Tasa', 0.08)]) })
    loaded.refund.salesRefundCents = 10800
    expect(checkCreditNoteEligibility(loaded)).toMatchObject({
      eligible: false,
      reason: 'OCHO_SIN_REGLA',
      message: regla.MOTIVO_OCHO_SIN_REGLA,
    })
  })
  // C2 · OF-2 (nit N-a, cambia A PROPÓSITO): «que se facturó en» (el número es lo FACTURADO del artículo), no «que cobró».
  it('🔴 «comparar lo devuelto de verdad»: el texto de un artículo que excede nombra el artículo y los dos montos', () => {
    const loaded = makeLoaded({ original: originalMixta() })
    loaded.refund.salesRefundCents = 10000
    loaded.refund.processorData = { refundedItems: [{ orderItemId: 'pan', amountCents: 10000, productName: 'Pan dulce' }] }
    expect(checkCreditNoteEligibility(loaded)).toEqual({
      eligible: false,
      reason: 'ARTICULO_EXCEDE_LO_FACTURADO',
      message:
        'Se devolvieron $100.00 de «Pan dulce» que se facturó en $58.00: $42.00 de más. La nota no acredita más de lo facturado de ese artículo; revisa la devolución con tu contador.',
    })
  })
  it('🔴 (B): un artículo que la 6b dejó 1 ¢ debajo de lo cobrado se devuelve COMPLETO (cabe en su tasa) y el centavo queda registrado', () => {
    // A $19 − $2.50 y B $35: la 6b deja el descuento de A en $2.49 (el PAC daría otro total) ⇒ A queda en 16.51 y B en 34.99.
    const original = originalDe([incluido(1900, 'Tasa', 0.16, 249), incluido(3500, 'Tasa', 0.16)], i => ['A', 'B'][i])
    expect((original!.entrada as any).montosPorRenglon).toEqual([
      { orderItemId: 'A', totalCents: 1651, porTratamiento: { IVA_16: 1651 } },
      { orderItemId: 'B', totalCents: 3499, porTratamiento: { IVA_16: 3499 } },
    ])
    const loaded = makeLoaded({ original })
    loaded.refund.salesRefundCents = 3500
    loaded.refund.processorData = { refundedItems: [{ orderItemId: 'B', amountCents: 3500 }] }
    expect(notaPorTratamiento(loaded)).toMatchObject({
      entradaParcial: {
        brutoPorTratamiento: { IVA_16: 3500 },
        porRenglon: [{ orderItemId: 'B', totalCents: 3500, porTratamiento: { IVA_16: 3500 } }],
        redondeo: [{ tratamiento: 'IVA_16', componente: 'ARTICULO', cents: 1, ambito: 'FACTURA', orderItemId: 'B' }],
      },
    })
    // Y la tasa no se relaja: después de devolver A completo (16.51), B ya no cabe ni por un centavo de más.
    loaded.acreditado = {
      ...loaded.acreditado,
      notas: [asignacionDe([incluido(1651, 'Tasa', 0.16)])],
      porRenglon: new Map([['A', { IVA_16: 1651 }]]),
      alreadyCreditedCents: 1651,
    }
    expect(checkCreditNoteEligibility(loaded)).toMatchObject({ eligible: false, reason: 'EXCEEDS_REMAINING' })
    loaded.refund.salesRefundCents = 3499
    loaded.refund.processorData = { refundedItems: [{ orderItemId: 'B', amountCents: 3499 }] }
    expect(checkCreditNoteEligibility(loaded).eligible).toBe(true)
  })
  it('🔴 G8: forma de pago = la del reembolso; si no, la de la original (no 99); si no, 15 sólo con original PPD sin pagos; si no, se detiene', () => {
    const loaded = makeLoaded({})
    loaded.refund.method = 'CASH'
    expect(formaPagoDeLaNota(loaded)).toBe('01')
    loaded.refund.method = 'OTHER' as any
    expect(formaPagoDeLaNota(loaded)).toBe('04')
    loaded.original = makeOriginal({ formaPago: '99', metodoPago: 'PPD' as any })
    expect(formaPagoDeLaNota(loaded)).toBe('15')
    loaded.original = makeOriginal({ formaPago: '99', metodoPago: 'PPD' as any, tienePagos: true })
    expect(formaPagoDeLaNota(loaded)).toMatchObject({ eligible: false, reason: 'SIN_FORMA_DE_PAGO', message: MOTIVO_SIN_FORMA_DE_PAGO })
    expect(checkCreditNoteEligibility(loaded)).toMatchObject({ eligible: false, reason: 'SIN_FORMA_DE_PAGO' })
    loaded.original = makeOriginal({ formaPago: '99', metodoPago: 'PUE' })
    expect(formaPagoDeLaNota(loaded)).toMatchObject({ reason: 'SIN_FORMA_DE_PAGO' })
  })
  it('control — un artículo devuelto en $0 (cortesía D9) no participa; si es lo único, no hay nota que armar', () => {
    const loaded = makeLoaded({})
    loaded.refund.salesRefundCents = 0
    loaded.refund.processorData = { refundedItems: [{ orderItemId: 'pan', amountCents: 0 }] }
    expect(checkCreditNoteEligibility(loaded)).toMatchObject({ eligible: false, reason: 'TIP_ONLY' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C2 · Tarea 8: la nota de un ticket que entró en la factura GLOBAL
// ─────────────────────────────────────────────────────────────────────────────

/** El periodo de las globales de prueba: mayo de 2026 (MENSUAL), como la integración de C1. */
const PERIODO_GLOBAL = closedPeriodFor('MENSUAL', new Date('2026-06-03T17:00:00Z'))
type Articulo = [orderItemId: string, cents: number, tratamiento: 'IVA_16' | 'IVA_0' | 'EXENTO' | 'NO_OBJETO', descuentoCents?: number]
/**
 * Un ticket de la entrada v2 de la global (la forma que congela C1): sus renglones, lo cobrado por tratamiento y —salvo `sinReales`— sus
 * conceptos reales (con su descuento ORIGINAL), con su huella.
 */
function ticketGlobal(
  orderId: string,
  folio: string,
  porTratamiento: PorTratamientoGlobal,
  articulos: Articulo[],
  o: { sinReales?: boolean; formaPago?: string; lineas?: any[] } = {},
) {
  const renglones = articulos.map(([orderItemId, , tratamiento]) => ({ orderItemId, tratamiento }))
  const conceptosReales: ConceptoReal[] | null =
    o.sinReales || !articulos.length
      ? null
      : articulos.map(([orderItemId, cents, tratamiento, descuentoCents]) => ({
          orderItemId,
          productId: null,
          descripcion: orderItemId,
          precio: (cents / 100).toFixed(2),
          cantidad: 1,
          descuentoCents: descuentoCents ?? 0,
          ivaIncluido: true,
          tratamiento,
        }))
  const paidCents = Object.values(porTratamiento).reduce((s, c) => s + (c ?? 0), 0)
  const formaPago = o.formaPago ?? '04'
  const t = {
    orderId,
    folio,
    formaPago,
    paidCents,
    renglones,
    porTratamiento,
    ...(o.lineas ? { lineas: o.lineas } : {}),
    conceptosReales,
    filasD16: [] as string[][],
  }
  return {
    ...t,
    huella: huellaDeEntrada({
      renglones,
      porTratamiento,
      lineas: o.lineas ?? null,
      conceptosReales,
      folio,
      formaPago,
      filasD16: [],
    }),
  }
}
/**
 * Una global v2 timbrada con esos tickets (`paramsDeLaGlobal` + `cuadrarLaGlobal` de C1), con su XML (`xmlDe` de sus conceptos), como la
 * fila que lee el cargador: `esGlobal`, sin orden, el Público en General y la llave de la principal (o `-c2` si es complementaria).
 */
function globalDe(
  ordenes: Array<ReturnType<typeof ticketGlobal>>,
  over: Partial<NonNullable<LoadedRefundForCreditNote['original']>> & { complementaria?: boolean } = {},
) {
  const { complementaria, ...resto } = over
  const base = paramsDeLaGlobal({ lugarExpedicion: '01000' }, ordenes, PERIODO_GLOBAL)
  const cobrado = ordenes.reduce((s, o) => s + o.paidCents, 0)
  const porTasa: PorTratamientoGlobal = {}
  for (const o of ordenes)
    for (const [t, c] of Object.entries(o.porTratamiento) as Array<[keyof PorTratamientoGlobal, number]>) porTasa[t] = (porTasa[t] ?? 0) + c
  const c = cuadrarLaGlobal(base.items, cobrado, { cobradoPorTasa: porTasa, filasD16: SIN_FILAS_D16 })
  if (!c.ok) throw new Error(`la global de prueba no cuadra: ${c.motivo}`)
  const globalPeriod = { periodicidad: PERIODO_GLOBAL.satPeriodicidad, meses: PERIODO_GLOBAL.meses, anio: PERIODO_GLOBAL.anio }
  const entrada = {
    version: 2,
    tipo: 'GLOBAL',
    fiscalEmisorId: 'e1',
    globalPeriod,
    periodo: { desde: PERIODO_GLOBAL.periodStart.toISOString(), hasta: PERIODO_GLOBAL.periodEnd.toISOString() },
    montos: c.montos,
    excluidas: {},
    excluidasPorIvaMixto: 0,
    ordenes,
    formaDelMezclado: 'UN_CONCEPTO',
    cuadre: { ok: true },
    ajustes: c.ajustes,
    params: { ...base, items: c.items },
    ...(complementaria ? { complementariaDe: 'cfdi-global-principal' } : {}),
  }
  const llave = `cfdi-global-e1-${PERIODO_GLOBAL.anio}-${PERIODO_GLOBAL.meses}-${PERIODO_GLOBAL.satPeriodicidad}`
  return makeOriginal({
    id: complementaria ? 'cfdi-global-c2' : 'cfdi-global-1',
    orderId: null,
    esGlobal: true,
    idempotencyKey: complementaria ? `${llave}-c2` : llave,
    fiscalEmisorId: 'e1',
    globalPeriod,
    entrada,
    uuid: complementaria ? 'UUID-GLOBAL-C2' : 'UUID-GLOBAL-1',
    serie: 'G',
    folio: '7',
    formaPago: '04',
    metodoPago: 'PUE',
    receptorRfc: 'XAXX010101000',
    receptorNombre: 'PÚBLICO EN GENERAL',
    receptorRegimen: '616',
    receptorCp: '01000',
    receptorEmail: null,
    ...resto,
  })
}
/** Los tres tickets del plan: `o1` todo-16 $116; `o2` mezclado café $200 al 0 % + pan $58 al 16 % (con reales); `o3` sin artículos $50. */
const ticketsDelPlan = (o: { sinReales?: boolean } = {}) => [
  ticketGlobal('o1', 'ORD-1', { IVA_16: 11600 }, [['o1-a', 11600, 'IVA_16']], o),
  ticketGlobal(
    'o2',
    'ORD-2',
    { IVA_16: 5800, IVA_0: 20000 },
    [
      ['o2-cafe', 20000, 'IVA_0'],
      ['o2-pan', 5800, 'IVA_16'],
    ],
    o,
  ),
  ticketGlobal('o3', 'ORD-3', { IVA_16: 5000 }, []),
]
const originalGlobal = (
  o: { sinReales?: boolean } & Partial<NonNullable<LoadedRefundForCreditNote['original']>> & { complementaria?: boolean } = {},
) => {
  const { sinReales, ...over } = o
  return globalDe(ticketsDelPlan({ sinReales }), over)
}
/** Una global todo-16 IVA incluido de esos tickets sin artículos (el `orderId` es el folio). */
const originalGlobalDe = (tickets: Array<[folio: string, cents: number]>) =>
  globalDe(tickets.map(([folio, cents]) => ticketGlobal(folio, folio, { IVA_16: cents }, [])))
/** Una global de un solo ticket `o1` de esos centavos al 16 %. */
const originalGlobalDeUnTicket = (cents: number) => globalDe([ticketGlobal('o1', 'ORD-1', { IVA_16: cents }, [])])
/** Un reembolso del ticket `orderId` de esa global, por `cents` (y, si se dan, por esos artículos). */
function devolucionEnLaGlobal(original: ReturnType<typeof globalDe>, orderId: string, cents: number, articulos?: Array<[string, number]>) {
  const loaded = makeLoaded({ original })
  loaded.refund.orderId = orderId
  loaded.refund.salesRefundCents = cents
  if (articulos)
    loaded.refund.processorData = { refundedItems: articulos.map(([orderItemId, amountCents]) => ({ orderItemId, amountCents })) }
  return loaded
}
const tramoDe = (g: ReturnType<typeof globalDe>, orderId: string) => {
  const l = makeLoaded({ original: g })
  l.refund.orderId = orderId
  return (fiscalDelTicketEnLaGlobal(l, leerXmlConceptos(g!.xmlConceptos)!) as any).fiscal
}

describe('C2 · nota de un ticket que está en la global', () => {
  it('control — la Tarea 1 midió G02_SIN_BLOQUE: la nota a la global NO lleva el bloque InformacionGlobal', () => {
    expect(NOTA_A_GLOBAL_LLEVA_BLOQUE).toBe(false)
  })
  it('🔴 C2-10: los tramos de los tickets salen de la asignación de TODA la global y suman la global', () => {
    const g = originalGlobal()
    const tramos = ['o1', 'o2', 'o3'].map(o => tramoDe(g, o))
    const total = tramos.flatMap(t => Object.values(t)).reduce((s: number, c: any) => s + c.totalCents, 0)
    expect(total).toBe(g!.totalCents)
    // Y cada tasa del documento es la suma de sus tramos (base e IVA incluidos): nada se redondea por fuera.
    for (const t of ['IVA_16', 'IVA_0'] as const)
      for (const k of ['baseCents', 'ivaCents', 'totalCents'] as const)
        expect(tramos.reduce((s, tr) => s + (tr[t]?.[k] ?? 0), 0)).toBe(
          (
            asignacionFiscal(
              unidadesDeConceptos((g!.entrada as any).params.items, () => 'g'),
              documentoDeConceptos((g!.entrada as any).params.items),
              resumenDeConceptos((g!.entrada as any).params.items),
            ) as Asignacion
          ).porTratamiento[t]![k],
        )
    expect(tramos[1]).toEqual({
      IVA_16: { baseCents: 5000, ivaCents: 800, totalCents: 5800 },
      IVA_0: { baseCents: 20000, ivaCents: 0, totalCents: 20000 },
    })
    // Donde el redondeo de cada ticket por su cuenta NO da la global: tres tickets de $0.04 (cada uno solo: 0.03 + 0.01; la global: 0.10 +
    // 0.02). Los tramos salen del reparto del documento: su base, su IVA y su total suman los de la global.
    const chica = originalGlobalDe([
      ['A', 4],
      ['B', 4],
      ['C', 4],
    ])
    const suyos = ['A', 'B', 'C'].map(o => tramoDe(chica, o))
    expect(['baseCents', 'ivaCents', 'totalCents'].map(k => suyos.reduce((s, t) => s + (t.IVA_16?.[k] ?? 0), 0))).toEqual([10, 2, 12])
  })
  it('🔴 elegible, con el saldo DEL TICKET, por artículos (con sus conceptosReales), G02 y NoIdentificacion = folio', () => {
    const loaded = devolucionEnLaGlobal(originalGlobal(), 'o2', 5800, [['o2-pan', 5800]])
    expect(checkCreditNoteEligibility(loaded).eligible).toBe(true)
    expect(notaPorTratamiento(loaded)).toMatchObject({
      items: [
        expect.objectContaining({
          unitPriceCents: 5800,
          sku: 'ORD-2',
          satProductKey: '84111506',
          taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
        }),
      ],
      entradaParcial: { modalidad: 'POR_ARTICULOS', originalEsGlobal: true, folio: 'ORD-2', redondeo: [] },
    })
  })
  it('🔴 el folio lo garantizamos nosotros: cada nota lleva el folio de SU ticket, nunca el de otro', () => {
    const g = originalGlobal()
    expect(folioDelTicket(devolucionEnLaGlobal(g, 'o1', 100))).toBe('ORD-1')
    expect(folioDelTicket(devolucionEnLaGlobal(g, 'o3', 100))).toBe('ORD-3')
    expect(notaPorTratamiento(devolucionEnLaGlobal(g, 'o3', 1000))).toMatchObject({ items: [expect.objectContaining({ sku: 'ORD-3' })] })
    expect(folioDelTicket(makeLoaded({}))).toBeNull() // una factura individual no tiene folio de ticket
    expect((notaPorTratamiento(makeLoaded({})) as any).items[0].sku).toBeUndefined()
  })
  it('control — un ticket que no está en la global (u otra orden) ⇒ revisión de soporte, nunca el tramo de otro', () => {
    expect(checkCreditNoteEligibility(devolucionEnLaGlobal(originalGlobal(), 'o9', 100))).toMatchObject({
      eligible: false,
      reason: 'ORIGINAL_ENTRADA_INVALIDA',
    })
  })
  it('🔴 C2-17: global de dos tickets de $100 al 16 %: cada tramo es $100.00 y devolver los $100 de cada uno cabe (la segunda con su centavo declarado)', () => {
    const g = originalGlobalDe([
      ['A', 10000],
      ['B', 10000],
    ])
    expect(tramoDe(g, 'A')).toMatchObject({ IVA_16: { totalCents: 10000 } })
    expect(tramoDe(g, 'B')).toMatchObject({ IVA_16: { totalCents: 10000 } })
    expect([tramoDe(g, 'A').IVA_16, tramoDe(g, 'B').IVA_16]).toEqual([
      { baseCents: 8620, ivaCents: 1380, totalCents: 10000 },
      { baseCents: 8621, ivaCents: 1379, totalCents: 10000 },
    ])
    const notaB = devolucionEnLaGlobal(g, 'B', 10000)
    expect(checkCreditNoteEligibility(notaB).eligible).toBe(true)
    const notaA = devolucionEnLaGlobal(g, 'A', 10000)
    notaA.acreditadoDelDocumento = {
      ...notaA.acreditado,
      notas: [asignacionDe([incluido(10000, 'Tasa', 0.16)])],
      alreadyCreditedCents: 10000,
    } // la de B cuenta en el documento, no en el ticket A
    expect(notaPorTratamiento(notaA)).toMatchObject({
      entradaParcial: {
        redondeo: expect.arrayContaining([expect.objectContaining({ componente: 'BASE', cents: 1, ambito: 'DOCUMENTO_GLOBAL' })]),
      },
    })
  })
  it('🔴 devolver más de lo que el ticket tenía (aunque la global tenga de sobra) ⇒ se detiene', () => {
    expect(checkCreditNoteEligibility(devolucionEnLaGlobal(originalGlobal(), 'o2', 30000))).toEqual({
      eligible: false,
      reason: 'EXCEEDS_REMAINING',
      message: 'Lo que se devuelve ($300.00) excede lo que queda por acreditar de este ticket en la factura global ($258.00).',
    })
  })
  it('🔴 C2-3: lo que cabe en el ticket pero ya no en el documento (otras notas de la global) ⇒ se detiene con el texto del documento', () => {
    const loaded = devolucionEnLaGlobal(originalGlobal(), 'o3', 5000)
    loaded.acreditadoDelDocumento = { ...loaded.acreditado, notas: [], desconocidoCents: 22400 - 4999, alreadyCreditedCents: 17401 }
    expect(checkCreditNoteEligibility(loaded)).toMatchObject({
      eligible: false,
      reason: 'EXCEEDS_REMAINING',
      message: MOTIVO_SALDO_DEL_DOCUMENTO,
    })
  })
  it('🔴 C2-12: un ticket de una global sin conceptosReales (v1): por artículos se detiene por falta de evidencia', () => {
    const loaded = devolucionEnLaGlobal(originalGlobal({ sinReales: true }), 'o1', 1000, [['o1-a', 1000]])
    expect(checkCreditNoteEligibility(loaded)).toMatchObject({ eligible: false, reason: 'SIN_MONTO_POR_ARTICULO' })
  })
  it('🔴 ticket de cobro sin artículos (C2-9): sus tratamientos salen del concepto congelado ⇒ por importe, al 16 %', () => {
    expect(notaPorTratamiento(devolucionEnLaGlobal(originalGlobal(), 'o3', 1000))).toMatchObject({
      entradaParcial: { modalidad: 'POR_IMPORTE', brutoPorTratamiento: { IVA_16: 1000 } },
    })
  })
  it('🔴 C2-13: la global sin su XML espera (v2 no esperaba); con un XML que no coincide ⇒ soporte', () => {
    expect(checkCreditNoteEligibility(devolucionEnLaGlobal(originalGlobal({ xmlConceptos: null }), 'o1', 1000))).toMatchObject({
      eligible: false,
      reason: 'ESPERA_XML',
    })
    const mal = originalGlobal({
      taxBreakdown: [{ impuesto: '002', tipoFactor: 'Tasa', tasa: '0.160000', base: '1.00', importe: '0.16' }],
    })
    expect(checkCreditNoteEligibility(devolucionEnLaGlobal(mal, 'o1', 1000))).toMatchObject({ reason: 'ORIGINAL_ENTRADA_INVALIDA' })
  })
  it('🔴 C2-15: la nota que agota el ticket y el documento registra cada centavo con SU ámbito', () => {
    const loaded = devolucionEnLaGlobal(originalGlobalDeUnTicket(4), 'o1', 2) // una global de un solo ticket de $0.04 al 16 %
    loaded.acreditado = { ...loaded.acreditado, notas: [asignacionDe([incluido(2, 'Tasa', 0.16)])] }
    loaded.acreditadoDelDocumento = { ...loaded.acreditado }
    expect(notaPorTratamiento(loaded)).toMatchObject({
      entradaParcial: {
        redondeo: [
          { tratamiento: 'IVA_16', componente: 'BASE', cents: 1, ambito: 'TICKET' },
          { tratamiento: 'IVA_16', componente: 'BASE', cents: 1, ambito: 'DOCUMENTO_GLOBAL' },
        ],
      },
    })
    expect((notaPorTratamiento(loaded) as any).entradaParcial?.redondeo).toHaveLength(2)
  })
  it('🔴 C1 (I2): un ticket que entró en una COMPLEMENTARIA se acredita igual contra ella; una llave de principal con «complementariaDe» ⇒ soporte', () => {
    const c2 = originalGlobal({ complementaria: true })
    expect(c2!.idempotencyKey).toMatch(/-c2$/)
    expect(checkCreditNoteEligibility(devolucionEnLaGlobal(c2, 'o2', 5800, [['o2-pan', 5800]])).eligible).toBe(true)
    const revuelta = { ...c2!, idempotencyKey: originalGlobal()!.idempotencyKey }
    expect(checkCreditNoteEligibility(devolucionEnLaGlobal(revuelta, 'o2', 5800))).toMatchObject({
      eligible: false,
      reason: 'ORIGINAL_ENTRADA_INVALIDA',
    })
  })
  it('🔴 dos tickets con el MISMO folio (Order.orderNumber no es único) no se juntan: cada uno conserva su tramo', () => {
    const g = globalDe([ticketGlobal('x1', 'F-1', { IVA_16: 11600 }, []), ticketGlobal('x2', 'F-1', { IVA_16: 5800 }, [])])
    expect(tramoDe(g, 'x1')).toEqual({ IVA_16: expect.objectContaining({ totalCents: 11600 }) })
    expect(tramoDe(g, 'x2')).toEqual({ IVA_16: expect.objectContaining({ totalCents: 5800 }) })
    expect(checkCreditNoteEligibility(devolucionEnLaGlobal(g, 'x2', 5801))).toMatchObject({ eligible: false, reason: 'EXCEEDS_REMAINING' })
  })
  it('🔴 (B) en la global: el artículo que sus conceptos reales dejan 1 ¢ abajo se devuelve completo, con su centavo en el ámbito del TICKET', () => {
    // El mismo caso que la individual: A $19 − $2.50 y B $35 ⇒ con la regla del PAC, A 16.51 y B 34.99 (el ticket cobró $51.50).
    const g = globalDe([
      ticketGlobal('o1', 'ORD-1', { IVA_16: 5150 }, [
        ['A', 1900, 'IVA_16', 250],
        ['B', 3500, 'IVA_16'],
      ]),
    ])
    const loaded = devolucionEnLaGlobal(g, 'o1', 3500, [['B', 3500]])
    expect(notaPorTratamiento(loaded)).toMatchObject({
      entradaParcial: {
        brutoPorTratamiento: { IVA_16: 3500 },
        redondeo: [{ tratamiento: 'IVA_16', componente: 'ARTICULO', cents: 1, ambito: 'TICKET', orderItemId: 'B' }],
      },
    })
  })
  it('🔴 montosDeReales: lo facturado de cada artículo, con la regla del PAC y lo cobrado del ticket por tasa; los que no cuadran ⇒ null', () => {
    const [, o2] = ticketsDelPlan()
    expect(montosDeReales(o2.conceptosReales!, o2.porTratamiento, o2.filasD16)).toEqual(
      new Map([
        ['o2-cafe', { totalCents: 20000, porTratamiento: { IVA_0: 20000 } }],
        ['o2-pan', { totalCents: 5800, porTratamiento: { IVA_16: 5800 } }],
      ]),
    )
    const reales = ticketGlobal('o1', 'ORD-1', { IVA_16: 5150 }, [
      ['A', 1900, 'IVA_16', 250],
      ['B', 3500, 'IVA_16'],
    ]).conceptosReales!
    expect(montosDeReales(reales, { IVA_16: 5150 }, [])).toEqual(
      new Map([
        ['A', { totalCents: 1651, porTratamiento: { IVA_16: 1651 } }],
        ['B', { totalCents: 3499, porTratamiento: { IVA_16: 3499 } }],
      ]),
    )
    expect(montosDeReales(reales, { IVA_16: 6150 }, [])).toBeNull() // un peso de más: error de armado, no redondeo
  })
  /** Un `tx` doble del cargador: el reembolso es de `o2`; `individual` y `global` son lo que devuelve cada búsqueda de la original. */
  function txDelCargador(individual: any, global: any) {
    const findFirst = jest.fn(async ({ where }: any) =>
      where.replacesCfdiId !== undefined ? null : where.isGlobal === true ? global : individual,
    )
    const findMany = jest.fn().mockResolvedValue([])
    const tx = {
      payment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'r1',
          venueId: 'v1',
          orderId: 'o2',
          type: 'REFUND',
          status: 'COMPLETED',
          amount: -58,
          tipAmount: 0,
          method: 'CREDIT_CARD',
          tenderSatFormaPago: null,
          processorData: null,
        }),
      },
      order: { findUnique: jest.fn().mockResolvedValue({ venue: { slug: 'demo' } }) },
      cfdi: {
        findFirst,
        findMany,
        aggregate: jest.fn().mockResolvedValue({ _sum: { totalCents: 0 } }),
        count: jest.fn().mockResolvedValue(0),
      },
    } as any
    return { tx, findFirst, findMany }
  }
  it('🔴 el cargador: sin factura individual, la global VIVA cuyo manifiesto tiene la orden (principal o complementaria), con lo que lee leerGlobal; lo acreditado del ticket y del documento', async () => {
    const g = originalGlobal()
    const { tx, findFirst, findMany } = txDelCargador(null, { ...g, isGlobal: true })
    const loaded = await loadRefundForCreditNoteFromDb('v1', 'r1', tx, 'cfdi-esta')
    expect(loaded!.original).toMatchObject({ id: 'cfdi-global-1', esGlobal: true, receptorEmail: null })
    const busqueda = findFirst.mock.calls.map(c => c[0]).find(a => a.where.isGlobal === true)
    expect(busqueda?.where).toEqual({
      venueId: 'v1',
      type: 'INGRESO',
      // Ronda 1 (M2), cambio A PROPÓSITO: también la CANCELADA (para decirlo con su motivo; la más reciente gana).
      status: { in: ['STAMPED', 'CANCELLED'] },
      isGlobal: true,
      uuid: { not: null },
      manifiestoGlobal: { some: { orderId: 'o2' } },
    })
    expect(busqueda?.select).toMatchObject({
      idempotencyKey: true,
      fiscalEmisorId: true,
      globalPeriod: true,
      isGlobal: true,
      entrada: true,
      entradaHuella: true,
      taxBreakdown: true,
      xmlConceptos: true,
      // Ronda 1 (M5): el lugar de expedición VIGENTE del emisor (el CP del receptor genérico de la nota).
      fiscalEmisor: { select: expect.objectContaining({ lugarExpedicion: true }) },
    })
    // Lo del ticket (por su orden) y lo del documento (por `entrada.originalCfdiId`), los dos sin la nota que se está capturando.
    const dondes = findMany.mock.calls.map(c => c[0].where)
    expect(dondes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderId: 'o2', id: { not: 'cfdi-esta' } }),
        expect.objectContaining({ entrada: { path: ['originalCfdiId'], equals: 'cfdi-global-1' }, id: { not: 'cfdi-esta' } }),
      ]),
    )
    expect(loaded!.acreditadoDelDocumento).toMatchObject({ notas: [], desconocidoCents: 0 })
  })
  it('control — con factura individual el cargador no busca la global ni el saldo del documento', async () => {
    const { tx, findFirst } = txDelCargador({ ...makeOriginal(), isGlobal: false }, null)
    const loaded = await loadRefundForCreditNoteFromDb('v1', 'r1', tx)
    expect(loaded!.original!.esGlobal).toBeFalsy()
    expect(findFirst.mock.calls.some(c => c[0].where.isGlobal === true)).toBe(false)
    expect(loaded!.acreditadoDelDocumento).toBeUndefined()
  })
  /** Una global v1 (de antes de C1: todo al 16 %, un concepto por ticket), con o sin `sku` en sus conceptos. */
  function globalV1De(tickets: Array<[orderId: string, cents: number, sku?: string]>) {
    const items = tickets.map(([, cents, sku]) => ({
      satProductKey: '01010101',
      satUnitKey: 'ACT',
      description: 'Venta',
      quantity: 1,
      unitPriceCents: cents,
      discountCents: 0,
      objetoImp: '02',
      taxes: [{ type: 'IVA' as const, factor: 'Tasa' as const, rate: 0.16, withholding: false }],
      taxIncluded: true,
      ...(sku ? { sku } : {}),
    }))
    const partes = items.map(i => splitIvaIncluded(i.unitPriceCents, 0.16))
    const subtotalCents = partes.reduce((s, x) => s + x.netCents, 0)
    const taxCents = partes.reduce((s, x) => s + x.taxCents, 0)
    const globalPeriod = { periodicidad: '04', meses: PERIODO_GLOBAL.meses, anio: PERIODO_GLOBAL.anio }
    const entrada = {
      version: 1,
      tipo: 'GLOBAL',
      fiscalEmisorId: 'e1',
      globalPeriod,
      montos: { subtotalCents, taxCents, totalCents: subtotalCents + taxCents },
      excluidasPorIvaMixto: 0,
      ordenes: tickets.map(([orderId]) => ({
        orderId,
        huella: 'a'.repeat(64),
        renglones: [{ orderItemId: `${orderId}-a`, tratamiento: 'IVA_16' }],
      })),
      params: {
        receptor: { legal_name: 'PÚBLICO EN GENERAL', tax_id: 'XAXX010101000', tax_system: '616', address: { zip: '01000' } },
        items,
        payment_form: '04',
        use: 'S01',
        global: { periodicity: 'month', months: PERIODO_GLOBAL.meses, year: PERIODO_GLOBAL.anio },
      },
    }
    return makeOriginal({
      id: 'cfdi-global-v1',
      orderId: null,
      esGlobal: true,
      idempotencyKey: `cfdi-global-e1-${PERIODO_GLOBAL.anio}-${PERIODO_GLOBAL.meses}-04`,
      fiscalEmisorId: 'e1',
      globalPeriod,
      entrada,
      receptorRfc: 'XAXX010101000',
      receptorNombre: 'PÚBLICO EN GENERAL',
      receptorRegimen: '616',
      receptorCp: '01000',
      receptorEmail: null,
    })
  }
  it('🔴 el folio es el TIMBRADO del ticket: una global v1 con `sku` lleva ese folio (no el id de la orden); sin `sku` no hay folio que llevar ⇒ soporte', () => {
    const conSku = globalV1De([
      ['o1', 11600, 'F-1'],
      ['o2', 5800, 'F-2'],
    ])
    expect(notaPorTratamiento(devolucionEnLaGlobal(conSku, 'o2', 1000))).toMatchObject({
      items: [expect.objectContaining({ sku: 'F-2', unitPriceCents: 1000 })],
      entradaParcial: { folio: 'F-2', modalidad: 'POR_IMPORTE' },
    })
    const sinSku = globalV1De([
      ['o1', 11600],
      ['o2', 5800],
    ])
    expect(checkCreditNoteEligibility(devolucionEnLaGlobal(sinSku, 'o2', 1000))).toMatchObject({
      eligible: false,
      reason: 'ORIGINAL_ENTRADA_INVALIDA',
    })
  })
  it('control — una nota individual de hoy no cambia: sin folio, sin receptor genérico, ámbito FACTURA', () => {
    const r = notaPorTratamiento(makeLoaded({})) as any
    expect(r.entradaParcial.originalEsGlobal).toBeUndefined()
    expect(r.entradaParcial.folio).toBeUndefined()
  })
})

// ─── C2 · Tarea 7, ronda de arreglos 1 ─────────────────────────────────────────
/** Un concepto de `cantidad` piezas con IVA incluido (`null` = no objeto). */
const pieza = (cents: number, cantidad: number, factor: 'Tasa' | 'Exento' | null, rate = 0, discountCents = 0) => ({
  ...incluido(cents, factor, rate, discountCents),
  quantity: cantidad,
})
/**
 * La 6b REAL sobre la venta (como el cargador individual: `cuadrarConElPac` del documento entero contra lo cobrado): los conceptos ya
 * ajustados forman la original (con su XML). Devuelve también lo que COBRÓ cada artículo (lo que regresa una devolución completa).
 */
function conLa6b(items: any[], articuloDe: (i: number) => string = i => `a${i}`) {
  const cs = items.map(regla.conceptoDesdeElPayload)
  const cobrado = montoComercialCents(cs)
  const r = regla.cuadrarConElPac(cs, cobrado, { desbloqueado: false })
  if (!r.ok) throw new Error(`la venta de prueba no cuadra: ${r.motivo}`)
  const ajustados = items.map((it, i) => {
    const a = r.ajustes.find(x => x.indice === i)
    return a ? { ...it, discountCents: a.aCents } : it
  })
  return {
    original: originalDe(ajustados, articuloDe),
    ajustes: r.ajustes,
    cobradoDe: (i: number) => montoComercialCents([cs[i]]),
  }
}
const porArticulo = (original: any, id: string, cents: number, acreditado?: LoadedRefundForCreditNote['acreditado']) => {
  const loaded = makeLoaded({ original })
  if (acreditado) loaded.acreditado = acreditado
  loaded.refund.salesRefundCents = cents
  loaded.refund.processorData = { refundedItems: [{ orderItemId: id, amountCents: cents }] }
  return loaded
}
/** Lo acreditado después de una nota (su asignación y su porRenglon), como lo daría `acreditadoContra`. */
function despuesDe(nota: any, antes = makeLoaded().acreditado): LoadedRefundForCreditNote['acreditado'] {
  const porRenglon = new Map(antes.porRenglon)
  for (const f of nota.entradaParcial.porRenglon ?? []) {
    const a: any = { ...(porRenglon.get(f.orderItemId) ?? {}) }
    for (const [t, c] of Object.entries(f.porTratamiento)) a[t] = (a[t] ?? 0) + (c as number)
    porRenglon.set(f.orderItemId, a)
  }
  return {
    ...antes,
    notas: [...antes.notas, nota.entradaParcial.porTratamiento],
    porRenglon,
    alreadyCreditedCents: antes.alreadyCreditedCents + nota.entradaParcial.devueltoCents,
  }
}

describe('C2 · T7 ronda 1 · I1: el tope por el TOTAL (una nota v1 de otro tratamiento también baja el saldo)', () => {
  const v1NoObjeto = (cents: number) => ({ NO_OBJETO: { baseCents: cents, ivaCents: 0, totalCents: cents } })
  it.each([
    ['al 0 %', 'Tasa' as const],
    ['exenta', 'Exento' as const],
  ])('🔴 histórica %s con su nota v1 «no objeto» por todo: otra devolución ya no cabe (antes se acreditaba dos veces)', (_n, factor) => {
    const original = originalHistorica(...xmlDe([incluido(5000, factor, 0)]), 5000)
    const loaded = makeLoaded({ original })
    loaded.acreditado = { ...loaded.acreditado, notas: [v1NoObjeto(5000)], alreadyCreditedCents: 5000 }
    loaded.refund.salesRefundCents = 5000
    expect(checkCreditNoteEligibility(loaded)).toEqual({
      eligible: false,
      reason: 'EXCEEDS_REMAINING',
      message: 'Ya no queda nada por acreditar en la factura original.',
    })
    // Con una v1 parcial, cabe exactamente lo que falta por el total, ni un centavo más.
    loaded.acreditado = { ...loaded.acreditado, notas: [v1NoObjeto(2000)], alreadyCreditedCents: 2000 }
    loaded.refund.salesRefundCents = 3000
    expect(checkCreditNoteEligibility(loaded).eligible).toBe(true)
    loaded.refund.salesRefundCents = 3001
    expect(checkCreditNoteEligibility(loaded)).toEqual({
      eligible: false,
      reason: 'EXCEEDS_REMAINING',
      message: 'Lo que se devuelve ($30.01) excede lo que queda por acreditar en la factura original ($30.00).',
    })
  })
  it('🔴 mixta ($116 al 16 % + $100 al 0 %) con su nota v1 al 16 % por los $216: $100 más (al 0 %) ya no cabe', () => {
    const loaded = makeLoaded({ original: originalHistorica(...xmlDe([incluido(11600, 'Tasa', 0.16), incluido(10000, 'Tasa', 0)]), 21600) })
    loaded.acreditado = {
      ...loaded.acreditado,
      notas: [{ IVA_16: { baseCents: 18621, ivaCents: 2979, totalCents: 21600 } }],
      alreadyCreditedCents: 21600,
    }
    loaded.refund.salesRefundCents = 10000
    expect(checkCreditNoteEligibility(loaded)).toMatchObject({ eligible: false, reason: 'EXCEEDS_REMAINING' })
  })
  it('🔴 lo ilegible (desconocido) también baja el total, aunque su tratamiento no se sepa', () => {
    const loaded = makeLoaded({})
    loaded.acreditado = { ...loaded.acreditado, desconocidoCents: 11000, alreadyCreditedCents: 11000 }
    loaded.refund.salesRefundCents = 601
    expect(checkCreditNoteEligibility(loaded)).toMatchObject({ eligible: false, reason: 'EXCEEDS_REMAINING' })
  })
  it('🔴 T8: el ticket de la global queda igual de protegido — una nota de otro tratamiento en el TICKET o en el DOCUMENTO baja su total', () => {
    const g = originalGlobal()
    const t = devolucionEnLaGlobal(g, 'o1', 11600)
    t.acreditado = { ...t.acreditado, notas: [v1NoObjeto(11600)], alreadyCreditedCents: 11600 }
    expect(checkCreditNoteEligibility(t)).toEqual({
      eligible: false,
      reason: 'EXCEEDS_REMAINING',
      message: 'Ya no queda nada por acreditar de este ticket en la factura global.',
    })
    const d = devolucionEnLaGlobal(g, 'o3', 5000)
    d.acreditadoDelDocumento = {
      ...makeLoaded().acreditado,
      notas: [v1NoObjeto(g!.totalCents - 2000)],
      alreadyCreditedCents: g!.totalCents - 2000,
    }
    expect(checkCreditNoteEligibility(d)).toEqual({ eligible: false, reason: 'EXCEEDS_REMAINING', message: MOTIVO_SALDO_DEL_DOCUMENTO })
  })
  it('control — una secuencia legítima nunca choca con el tope: $100 al 16 % en tres notas (33.33 + 33.33 + 33.34) caben todas', () => {
    let acreditado = makeLoaded().acreditado
    const original = originalDe([incluido(10000, 'Tasa', 0.16)])
    for (const cents of [3333, 3333, 3334]) {
      const loaded = makeLoaded({ original })
      loaded.acreditado = acreditado
      loaded.refund.salesRefundCents = cents
      const n = notaPorTratamiento(loaded) as any
      expect(n.items).toBeDefined()
      acreditado = despuesDe(n, acreditado)
    }
  })
})

describe('C2 · T7 ronda 1 · I3: los centavos de redondeo de una mixta se dicen con un texto que no miente, y se cuentan', () => {
  it('🔴 caso 1 (6b real): 0 % $71.91 · 16 % 2×$97.28 − $55.91 · no objeto 3×$31.69 ⇒ el no objeto completo ($95.07) excede 1 ¢ lo congelado', () => {
    const v = conLa6b([pieza(7191, 1, 'Tasa', 0), pieza(9728, 2, 'Tasa', 0.16, 5591), pieza(3169, 3, null)])
    expect((v.original!.entrada as any).montosPorRenglon.find((m: any) => m.orderItemId === 'a2').totalCents).toBe(9506)
    expect(checkCreditNoteEligibility(porArticulo(v.original, 'a2', v.cobradoDe(2)))).toEqual({
      eligible: false,
      reason: 'CENTAVOS_DE_REDONDEO',
      message:
        'La devolución de un artículo excede por 1 ¢ lo que se facturó de él. Una diferencia de centavos así suele venir del redondeo de la factura original; esta nota no se puede timbrar aquí: hazla con tu contador.',
    })
  })
  const caso2 = () =>
    conLa6b([pieza(7299, 3, 'Tasa', 0.16, 7498), pieza(3213, 3, 'Exento'), pieza(2071, 2, 'Tasa', 0.16), pieza(9706, 1, 'Exento', 0, 3421)])
  it('🔴 caso 2 (6b real): a0 completo (con su centavo de (B)) y luego a2 ($41.42, sin desfase) ⇒ el total de su TASA excede 1 ¢: texto honesto', () => {
    const v = caso2()
    const n1 = notaPorTratamiento(porArticulo(v.original, 'a0', v.cobradoDe(0))) as any
    expect(n1.entradaParcial.redondeo).toEqual([expect.objectContaining({ componente: 'ARTICULO', cents: 1, orderItemId: 'a0' })])
    expect(checkCreditNoteEligibility(porArticulo(v.original, 'a2', v.cobradoDe(2), despuesDe(n1)))).toEqual({
      eligible: false,
      reason: 'CENTAVOS_DE_REDONDEO',
      message:
        'La devolución excede por 1 ¢ lo que queda por acreditar de su tasa. Una diferencia de centavos así suele venir del redondeo de la factura original; esta nota no se puede timbrar aquí: hazla con tu contador.',
    })
  })
  it('🔴 caso 3 (6b real, orden inverso): a2 y luego a0 ⇒ a0 excede 1 ¢ el total de su tasa: texto honesto', () => {
    const v = caso2()
    const n1 = notaPorTratamiento(porArticulo(v.original, 'a2', v.cobradoDe(2))) as any
    expect(n1.items).toBeDefined()
    expect(checkCreditNoteEligibility(porArticulo(v.original, 'a0', v.cobradoDe(0), despuesDe(n1)))).toMatchObject({
      eligible: false,
      reason: 'CENTAVOS_DE_REDONDEO',
    })
  })
  // C2 · OF-2 (T7 N2, cambia A PROPÓSITO): el texto dice que se pasa la BASE, no «la devolución» (su total sí cabe). Sigue contándose (mixta).
  it('🔴 caso 4 (6b real, de la medición): la nota cabe por su total pero su BASE se pasa 1 ¢ de lo que queda (el centavo del ajuste) ⇒ texto honesto, no «$136.02 excede $136.03»', () => {
    const v = conLa6b([
      pieza(7125, 3, 'Tasa', 0.16, 9257),
      pieza(7502, 1, null, 0, 3278),
      pieza(6801, 2, 'Tasa', 0.16),
      pieza(2459, 1, 'Exento', 0, 423),
    ])
    expect(v.ajustes).toEqual([{ indice: 1, deCents: 3278, aCents: 3279 }])
    const n1 = notaPorTratamiento(porArticulo(v.original, 'a0', v.cobradoDe(0))) as any
    expect(n1.items).toBeDefined()
    expect(checkCreditNoteEligibility(porArticulo(v.original, 'a2', v.cobradoDe(2), despuesDe(n1)))).toEqual({
      eligible: false,
      reason: 'CENTAVOS_DE_REDONDEO',
      message:
        'La base de la devolución excede por 1 ¢ la base que queda por acreditar de su tasa. Una diferencia de centavos así suele venir del redondeo de la factura original; esta nota no se puede timbrar aquí: hazla con tu contador.',
    })
  })
  it('control — una tasa sola: un exceso de centavos más allá de (B) sigue diciendo «excede» (no es redondeo de la factura)', () => {
    // Dos artículos de la misma tasa (con uno solo, el tope por el total ya lo detiene antes: EXCEEDS_REMAINING).
    const loaded = porArticulo(
      originalDe([incluido(5000, 'Tasa', 0.16), incluido(5000, 'Tasa', 0.16)], i => ['pan', 'te'][i]),
      'pan',
      5001,
    )
    expect(checkCreditNoteEligibility(loaded)).toMatchObject({ eligible: false, reason: 'ARTICULO_EXCEDE_LO_FACTURADO' })
  })
  it('🔴 M2: la emisión y la vista CUENTAN cada detención por centavos de redondeo en el log (etiqueta fija)', async () => {
    const v = conLa6b([pieza(7191, 1, 'Tasa', 0), pieza(9728, 2, 'Tasa', 0.16, 5591), pieza(3169, 3, null)])
    const loaded = porArticulo(v.original, 'a2', v.cobradoDe(2))
    ;(logger.warn as jest.Mock).mockClear()
    await expect(
      emitRefundCreditNote(
        { venueId: 'v1', refundPaymentId: 'pay-refund-1', sandbox: true },
        { findExistingCfdi: async () => null, loadRefundForCreditNote: async () => loaded },
      ),
    ).rejects.toThrow(/redondeo de la factura original/)
    expect(logger.warn).toHaveBeenCalledWith('[cfdi-nota] C2_CENTAVOS_DE_REDONDEO', { venueId: 'v1', refundPaymentId: 'pay-refund-1' })
    ;(logger.warn as jest.Mock).mockClear()
    ;(prisma.cfdi.findUnique as jest.Mock).mockResolvedValueOnce(null)
    ;(prisma.merchantFiscalConfig.findMany as jest.Mock).mockResolvedValueOnce([{ facturacionEnabled: true }])
    expect(
      (await getRefundCreditNoteStatus('v1', 'pay-refund-1', { loadRefundForCreditNote: async () => loaded }))!.eligibility.reason,
    ).toBe('CENTAVOS_DE_REDONDEO')
    expect(logger.warn).toHaveBeenCalledWith('[cfdi-nota] C2_CENTAVOS_DE_REDONDEO', { venueId: 'v1', refundPaymentId: 'pay-refund-1' })
  })
})

describe('C2 · T7 ronda 1 · I2/M1/M2/M4: la espera del XML', () => {
  const sinXml = (over: any = {}) => makeLoaded({ original: makeOriginal({ xmlConceptos: null, ...over }) })
  const emitir = (deps: any) =>
    emitRefundCreditNote({ venueId: 'v1', refundPaymentId: 'pay-refund-1', sandbox: true }, { findExistingCfdi: async () => null, ...deps })
  const vista = (deps: any) => {
    ;(prisma.cfdi.findUnique as jest.Mock).mockResolvedValueOnce(null)
    ;(prisma.merchantFiscalConfig.findMany as jest.Mock).mockResolvedValueOnce([{ facturacionEnabled: true }])
    return getRefundCreditNoteStatus('v1', 'pay-refund-1', deps)
  }
  it('🔴 M2: la nota (POST) espera hasta 20 s e INSISTE (pasa del enfriamiento); la vista espera como mucho 2 s', async () => {
    expect(LIMITE_ESPERA_XML_EN_LA_NOTA_MS).toBe(20_000)
    expect(LIMITE_ESPERA_XML_EN_LA_VISTA_MS).toBeLessThanOrEqual(2_000)
    const repararArchivos = jest.fn(async () => 'FALLO' as const)
    expect(await emitir({ loadRefundForCreditNote: async () => sinXml(), repararArchivos })).toMatchObject({ status: 'VALIDATION_FAILED' })
    expect(repararArchivos).toHaveBeenCalledWith('cfdi-ingreso-1', {
      sandbox: true,
      limiteMs: LIMITE_ESPERA_XML_EN_LA_NOTA_MS,
      insistir: true,
    })
    repararArchivos.mockClear()
    await vista({ loadRefundForCreditNote: async () => sinXml(), repararArchivos })
    expect(repararArchivos).toHaveBeenCalledWith('cfdi-ingreso-1', { limiteMs: LIMITE_ESPERA_XML_EN_LA_VISTA_MS })
  })
  it('🔴 I2: si la reparación sigue en curso, la vista dice que está esperando el XML («reparando») y no lee otra vez la fila', async () => {
    const cargar = jest.fn(async () => sinXml())
    const st = await vista({ loadRefundForCreditNote: cargar, repararArchivos: async () => 'EN_CURSO' })
    expect(st!.eligibility).toMatchObject({ eligible: false, reason: 'ESPERA_XML' })
    expect(cargar).toHaveBeenCalledTimes(1)
  })
  it('🔴 I2: el veredicto «ilegible» PERSISTIDO detiene la nota sin red: ni la vista ni el POST vuelven a pedir los archivos', async () => {
    const marcada = makeLoaded({ original: makeOriginal({ xmlConceptos: marcaDeXmlIlegible('el XML no trae Total') }) })
    expect(checkCreditNoteEligibility(marcada)).toEqual({ eligible: false, reason: 'XML_IRRECUPERABLE', message: MOTIVO_XML_ILEGIBLE })
    const repararArchivos = jest.fn()
    expect((await vista({ loadRefundForCreditNote: async () => marcada, repararArchivos }))!.eligibility.reason).toBe('XML_IRRECUPERABLE')
    await expect(emitir({ loadRefundForCreditNote: async () => marcada, repararArchivos })).rejects.toThrow(MOTIVO_XML_ILEGIBLE)
    expect(repararArchivos).not.toHaveBeenCalled()
  })
  it('🔴 M1: el PAC ya no entrega el XML (404/401/403) ⇒ se detiene con su motivo, en el POST y en la vista', async () => {
    const repararArchivos = jest.fn(async () => 'XML_NO_DISPONIBLE' as const)
    expect(await emitir({ loadRefundForCreditNote: async () => sinXml(), repararArchivos })).toMatchObject({
      status: 'VALIDATION_FAILED',
      reasons: [MOTIVO_XML_NO_DISPONIBLE],
    })
    expect((await vista({ loadRefundForCreditNote: async () => sinXml(), repararArchivos }))!.eligibility).toEqual({
      eligible: false,
      reason: 'XML_IRRECUPERABLE',
      message: MOTIVO_XML_NO_DISPONIBLE,
    })
  })
  it('🔴 M1, tope por antigüedad: una original timbrada hace más de un día que sigue sin XML deja de prometer «en unos minutos»', async () => {
    const vieja = () => sinXml({ stampedAt: new Date(Date.now() - ANTIGUEDAD_MAXIMA_SIN_XML_MS - 60_000) })
    const repararArchivos = jest.fn(async () => 'FALLO' as const)
    expect(await emitir({ loadRefundForCreditNote: async () => vieja(), repararArchivos })).toMatchObject({
      status: 'VALIDATION_FAILED',
      reasons: [MOTIVO_XML_ATRASADO],
    })
    expect((await vista({ loadRefundForCreditNote: async () => vieja(), repararArchivos }))!.eligibility).toEqual({
      eligible: false,
      reason: 'XML_IRRECUPERABLE',
      message: MOTIVO_XML_ATRASADO,
    })
    // Una reciente sigue esperando (la promesa «en unos minutos» es verdad).
    expect(
      (await vista({ loadRefundForCreditNote: async () => sinXml({ stampedAt: new Date() }), repararArchivos }))!.eligibility.reason,
    ).toBe('ESPERA_XML')
  })
  it('🔴 M4: con la nota ya timbrada, la vista no repara ni calcula la elegibilidad', async () => {
    ;(prisma.cfdi.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'n1',
      type: 'EGRESO',
      venueId: 'v1',
      status: 'STAMPED',
      protocoloIva: 1,
    })
    ;(prisma.merchantFiscalConfig.findMany as jest.Mock).mockResolvedValueOnce([{ facturacionEnabled: true }])
    const repararArchivos = jest.fn()
    const st = await getRefundCreditNoteStatus('v1', 'pay-refund-1', { loadRefundForCreditNote: async () => sinXml(), repararArchivos })
    expect(repararArchivos).not.toHaveBeenCalled()
    expect(st!.creditNote).toMatchObject({ status: 'STAMPED' })
    expect(st!.eligibility).toEqual({ eligible: false, reason: null, message: 'Este reembolso ya tiene su nota de crédito timbrada.' })
  })
})

describe('C2 · T7 ronda 1 · M3: el lector v2 rechaza cada manipulación (con la huella recalculada)', () => {
  const capturada = () => {
    const loaded = makeLoaded({ original: originalMixta() })
    loaded.refund.salesRefundCents = 20000
    loaded.refund.processorData = { refundedItems: [{ orderItemId: 'cafe', amountCents: 20000 }] }
    const c = capturarEgreso(loaded, 'cfdi-refund-pay-refund-1')
    return { ...c.base, protocoloIva: 1, entrada: c.entrada as any, entradaHuella: huellaDeEntrada(c.entrada) }
  }
  it('control — la fila tal como se capturó se lee', () => {
    expect(leerEgreso(capturada())).toMatchObject({ version: 2, modalidad: 'POR_ARTICULOS' })
  })
  it.each([
    ['porTratamiento (1 ¢ de base)', (e: any) => (e.porTratamiento.IVA_0.baseCents -= 1)],
    ['porTratamiento (otro tratamiento)', (e: any) => (e.porTratamiento = { IVA_16: e.porTratamiento.IVA_0 })],
    [
      'redondeo ARTICULO de un artículo ajeno',
      (e: any) => (e.redondeo = [{ tratamiento: 'IVA_0', componente: 'ARTICULO', cents: 1, ambito: 'FACTURA', orderItemId: 'pan' }]),
    ],
    [
      'redondeo ARTICULO de 3 ¢',
      (e: any) => (e.redondeo = [{ tratamiento: 'IVA_0', componente: 'ARTICULO', cents: 3, ambito: 'FACTURA', orderItemId: 'cafe' }]),
    ],
    ['redondeo BASE de 2 ¢', (e: any) => (e.redondeo = [{ tratamiento: 'IVA_0', componente: 'BASE', cents: 2, ambito: 'FACTURA' }])],
    [
      'redondeo de un tratamiento que la nota no tiene',
      (e: any) => (e.redondeo = [{ tratamiento: 'IVA_16', componente: 'IVA', cents: 1, ambito: 'FACTURA' }]),
    ],
    ['redondeo con ámbito inventado', (e: any) => (e.redondeo = [{ tratamiento: 'IVA_0', componente: 'BASE', cents: 1, ambito: 'OTRO' }])],
    ['porRenglon (otro artículo)', (e: any) => (e.porRenglon[0].orderItemId = 123)],
    ['porRenglon (tratamientos cambiados)', (e: any) => (e.porRenglon[0].porTratamiento = { IVA_16: 20000 })],
    ['porRenglon que no suma lo devuelto', (e: any) => (e.porRenglon[0].totalCents = 19999)],
    ['modalidad por importe con porRenglon', (e: any) => (e.modalidad = 'POR_IMPORTE')],
    ['modalidad inventada', (e: any) => (e.modalidad = 'REGALO')],
    ['elegidoPor sin modalidad elegida', (e: any) => (e.elegidoPor = 'staff-1')],
    ['devuelto distinto del documento', (e: any) => (e.devueltoCents = 20001)],
  ])('control — %s ⇒ revisión de soporte', (_n, cambia) => {
    const fila = capturada()
    cambia(fila.entrada)
    fila.entradaHuella = huellaDeEntrada(fila.entrada)
    expect(() => leerEgreso(fila)).toThrow(/soporte/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C2 · Tarea 8 · ronda de arreglos 1
// ─────────────────────────────────────────────────────────────────────────────

/** Una LECTURA nueva de la misma fila (objetos nuevos, como los devuelve la base). */
const releer = (g: ReturnType<typeof globalDe>) => JSON.parse(JSON.stringify(g)) as NonNullable<LoadedRefundForCreditNote['original']>
/** Lo acreditado vacío (ticket o documento). */
const nada = (): LoadedRefundForCreditNote['acreditado'] => ({
  notas: [],
  desconocidoCents: 0,
  porRenglon: new Map(),
  alreadyCreditedCents: 0,
  extraida: false,
})

describe('C2 · T8 ronda 1 · I1: UNA sola evaluación de la global por emisión (la vista previa también la reutiliza)', () => {
  beforeEach(() => olvidarGlobalesEvaluadas())
  afterEach(() => jest.restoreAllMocks())
  const devolucionDe = (g: ReturnType<typeof globalDe>) => devolucionEnLaGlobal(releer(g), 'o2', 5800, [['o2-pan', 5800]])

  it('🔴 vista previa (elegibilidad + nota) → elegibilidad de fuera → elegibilidad y captura bajo candado: tres lecturas de la fila, la global se evalúa UNA vez', () => {
    const lee = jest.spyOn(servicioDeGlobal, 'leerGlobal')
    const g = originalGlobal()
    const vista = devolucionDe(g)
    expect(checkCreditNoteEligibility(vista).eligible).toBe(true)
    expect(notaPorTratamiento(vista)).toMatchObject({ entradaParcial: { folio: 'ORD-2' } })
    expect(checkCreditNoteEligibility(devolucionDe(g)).eligible).toBe(true)
    const bajoCandado = devolucionDe(g)
    expect(checkCreditNoteEligibility(bajoCandado).eligible).toBe(true)
    expect(capturarEgreso(bajoCandado, 'cfdi-refund-pay-refund-1').base.status).toBe('STAMPING')
    expect(lee).toHaveBeenCalledTimes(1)
  })
  it.each([
    ['el total de la fila', (o: any) => (o.totalCents += 1)],
    ['la huella de la entrada', (o: any) => (o.entradaHuella = 'f'.repeat(64))],
    ['el emisor de la fila', (o: any) => (o.fiscalEmisorId = 'e2')],
    ['el periodo de la fila', (o: any) => (o.globalPeriod = { ...o.globalPeriod, anio: 2025 })],
    ['la llave de la fila', (o: any) => (o.idempotencyKey = `${o.idempotencyKey}-c2`)],
    ['el resumen del XML', (o: any) => (o.taxBreakdown[0].base = '1.00')],
    ['los conceptos del XML', (o: any) => (o.xmlConceptos.conceptos[0].importe = '1.000000')],
  ])('control — la memoria es por CONTENIDO: una lectura con %s distinto se evalúa de nuevo (y aquí no se lee)', (_n, cambia) => {
    const lee = jest.spyOn(servicioDeGlobal, 'leerGlobal')
    const g = originalGlobal()
    expect(checkCreditNoteEligibility(devolucionDe(g)).eligible).toBe(true)
    const otra = devolucionDe(g)
    cambia(otra.original)
    expect(checkCreditNoteEligibility(otra)).toMatchObject({ eligible: false, reason: 'ORIGINAL_ENTRADA_INVALIDA' })
    expect(lee).toHaveBeenCalledTimes(2)
  })
  it('🔴 M3: mutar el MISMO objeto ya evaluado (sus montos) ⇒ se evalúa de nuevo y se detiene (nunca un veredicto viejo)', () => {
    const loaded = devolucionDe(originalGlobal())
    expect(checkCreditNoteEligibility(loaded).eligible).toBe(true)
    loaded.original!.totalCents += 1
    expect(checkCreditNoteEligibility(loaded)).toMatchObject({ eligible: false, reason: 'ORIGINAL_ENTRADA_INVALIDA' })
  })
  it('🔴 la memoria es acotada: caduca a los MEMORIA_DE_GLOBALES.ms y guarda a lo más MEMORIA_DE_GLOBALES.maximo globales', () => {
    expect(MEMORIA_DE_GLOBALES).toEqual({ maximo: 4, ms: 120_000 })
    const lee = jest.spyOn(servicioDeGlobal, 'leerGlobal')
    const ahora = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const g = originalGlobal()
    checkCreditNoteEligibility(devolucionDe(g))
    ahora.mockReturnValue(1_000_000 + MEMORIA_DE_GLOBALES.ms)
    checkCreditNoteEligibility(devolucionDe(g)) // todavía vive
    expect(lee).toHaveBeenCalledTimes(1)
    ahora.mockReturnValue(1_000_000 + MEMORIA_DE_GLOBALES.ms + 1)
    checkCreditNoteEligibility(devolucionDe(g)) // caducó
    expect(lee).toHaveBeenCalledTimes(2)
    for (let i = 0; i < MEMORIA_DE_GLOBALES.maximo; i++)
      checkCreditNoteEligibility(devolucionDe(originalGlobal({ uuid: `OTRA-${i}`, id: `g${i}` })))
    expect(lee).toHaveBeenCalledTimes(2 + MEMORIA_DE_GLOBALES.maximo)
    checkCreditNoteEligibility(devolucionDe(g)) // la más vieja salió
    expect(lee).toHaveBeenCalledTimes(3 + MEMORIA_DE_GLOBALES.maximo)
  })
  // C2 · OF-2 (T8 N5, `task-8-rereview-2.md`): la memoria no reordenaba en un acierto (FIFO) y expulsaba primero a la más vieja… que es justo la
  // que `asegurarGlobalVigente` acababa de usar. Ahora un acierto la vuelve la más reciente: sale la que de verdad lleva más sin usarse.
  it('🔴 N5: un acierto (el de `asegurarGlobalVigente`) la vuelve la más reciente: la siguiente global nueva expulsa a OTRA', () => {
    const lee = jest.spyOn(servicioDeGlobal, 'leerGlobal')
    const g = originalGlobal()
    checkCreditNoteEligibility(devolucionDe(g)) // la vista previa la evalúa (la más vieja de la memoria)
    for (let i = 0; i < MEMORIA_DE_GLOBALES.maximo - 1; i++)
      checkCreditNoteEligibility(devolucionDe(originalGlobal({ uuid: `OTRA-${i}`, id: `g${i}` })))
    asegurarGlobalVigente(devolucionDe(g)) // acierto: sigue viva
    expect(lee).toHaveBeenCalledTimes(MEMORIA_DE_GLOBALES.maximo)
    checkCreditNoteEligibility(devolucionDe(originalGlobal({ uuid: 'NUEVA', id: 'g-nueva' }))) // llena: sale la menos usada
    checkCreditNoteEligibility(devolucionDe(g)) // bajo los candados: sigue en la memoria
    expect(lee).toHaveBeenCalledTimes(MEMORIA_DE_GLOBALES.maximo + 1)
  })
})

describe('C2 · T8 ronda 1 · I2: P8 POR TICKET; el documento sólo exige su total y una deriva ≤ las tolerancias por ticket ya usadas', () => {
  beforeEach(() => olvidarGlobalesEvaluadas())
  /** Devuelve completos los tickets en ese orden, cada nota con lo de las anteriores en el documento (como lo leería `acreditadoContra`). */
  function devolverTodos(g: ReturnType<typeof globalDe>, orden: string[], cents: (o: string) => number) {
    const documento = nada()
    const notas: any[] = []
    for (const o of orden) {
      const loaded = devolucionEnLaGlobal(releer(g), o, cents(o))
      loaded.acreditadoDelDocumento = {
        ...documento,
        notas: [...documento.notas],
        toleranciaDeTickets: { ...documento.toleranciaDeTickets },
      }
      expect(checkCreditNoteEligibility(loaded)).toEqual({ eligible: true, reason: null, message: null })
      const n = notaPorTratamiento(loaded) as any
      notas.push(n)
      acumularNota(documento, n.entradaParcial)
    }
    return { notas, documento }
  }
  const sumaDe = (notas: any[], k: 'baseCents' | 'ivaCents' | 'totalCents') =>
    notas.reduce((s, n) => s + (n.entradaParcial.porTratamiento.IVA_16?.[k] ?? 0), 0)
  const redondeoDe = (notas: any[], ambito: string, componente: string) =>
    notas.flatMap(n => n.entradaParcial.redondeo).filter((r: any) => r.ambito === ambito && r.componente === componente)

  it.each([
    ['en orden', ['A', 'B', 'C', 'D', 'E']],
    ['al revés', ['E', 'D', 'C', 'B', 'A']],
  ])(
    '🔴 5 tickets de $100 devueltos completos (%s) ⇒ salen las 5; el total nunca se pasa y la deriva de base se registra en el documento',
    (_n, orden) => {
      const g = originalGlobalDe(['A', 'B', 'C', 'D', 'E'].map(x => [x, 10000] as [string, number]))
      const doc = (fiscalDelTicketEnLaGlobal(devolucionEnLaGlobal(g, 'A', 1), leerXmlConceptos(g!.xmlConceptos)!) as any).documentoSinRestar
        .IVA_16
      const { notas, documento } = devolverTodos(g, orden, () => 10000)
      expect(notas).toHaveLength(5)
      expect(sumaDe(notas, 'totalCents')).toBe(doc.totalCents) // el total, exacto
      // Cada ticket: total exacto y a lo más +1 ¢ de base o de IVA, declarado en SU ámbito.
      const deTicket = redondeoDe(notas, 'TICKET', 'BASE')
      expect(deTicket.every((r: any) => r.cents === 1)).toBe(true)
      // El documento: la base pasa a lo más la suma de lo que los tickets usaron, y lo que pasa queda registrado; el IVA nunca pasa.
      const deriva = sumaDe(notas, 'baseCents') - doc.baseCents
      expect(deriva).toBeGreaterThan(0)
      expect(deriva).toBeLessThanOrEqual(deTicket.reduce((s: number, r: any) => s + r.cents, 0))
      // Ronda 2 (N1), cambio A PROPÓSITO: cada nota registra lo que ELLA agrega a la deriva; su suma es la deriva del documento.
      expect(redondeoDe(notas, 'DOCUMENTO_GLOBAL', 'BASE').reduce((s: number, r: any) => s + r.cents, 0)).toBe(deriva)
      expect(sumaDe(notas, 'ivaCents')).toBeLessThanOrEqual(doc.ivaCents)
      expect(documento.toleranciaDeTickets).toEqual({ IVA_16: { baseCents: deTicket.length, ivaCents: 0 } })
    },
  )
  it('🔴 20 tickets de $100 devueltos completos, en un orden revuelto ⇒ salen las 20; ningún total ni ninguna tasa se pasa', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `T${String(i).padStart(2, '0')}`)
    const g = originalGlobalDe(ids.map(x => [x, 10000] as [string, number]))
    const doc = (fiscalDelTicketEnLaGlobal(devolucionEnLaGlobal(g, ids[0], 1), leerXmlConceptos(g!.xmlConceptos)!) as any)
      .documentoSinRestar.IVA_16
    const orden = ids
      .map((x, i) => [x, (i * 7) % 20] as const)
      .sort((a, b) => a[1] - b[1])
      .map(([x]) => x)
    const { notas } = devolverTodos(g, orden, () => 10000)
    expect(notas).toHaveLength(20)
    expect(sumaDe(notas, 'totalCents')).toBe(doc.totalCents)
    const toleranciaUsada = redondeoDe(notas, 'TICKET', 'BASE').reduce((s: number, r: any) => s + r.cents, 0)
    expect(sumaDe(notas, 'baseCents') - doc.baseCents).toBeLessThanOrEqual(toleranciaUsada)
    expect(sumaDe(notas, 'ivaCents') - doc.ivaCents).toBeLessThanOrEqual(redondeoDe(notas, 'TICKET', 'IVA').length)
  })
  it('🔴 la deriva del documento NUNCA pasa las tolerancias usadas: una nota anterior que tomó base sin declararla deja a la siguiente detenida', () => {
    const g = originalGlobalDe([
      ['A', 10000],
      ['B', 10000],
    ])
    // B es exacta en su ticket (8621/1379) y no usa tolerancia; una nota anterior (de A) se llevó 8621 de base SIN declarar su centavo.
    const loaded = devolucionEnLaGlobal(releer(g), 'B', 10000)
    loaded.acreditadoDelDocumento = { ...nada(), notas: [{ IVA_16: { baseCents: 8621, ivaCents: 1379, totalCents: 10000 } }] }
    expect(checkCreditNoteEligibility(loaded)).toEqual({
      eligible: false,
      reason: 'EXCEEDS_REMAINING',
      message: MOTIVO_SALDO_DEL_DOCUMENTO,
    })
    // Con su centavo declarado, cabe y la deriva queda registrada en el documento.
    loaded.acreditadoDelDocumento = { ...loaded.acreditadoDelDocumento, toleranciaDeTickets: { IVA_16: { baseCents: 1, ivaCents: 0 } } }
    expect(notaPorTratamiento(loaded)).toMatchObject({
      entradaParcial: { redondeo: [{ tratamiento: 'IVA_16', componente: 'BASE', cents: 1, ambito: 'DOCUMENTO_GLOBAL' }] },
    })
  })
  it('control — el TOTAL de cada tasa del documento nunca se pasa, aunque el total del documento alcance y sobre tolerancia', () => {
    // X e Y al 0 % ($100 cada uno) y Z al 16 % ($116). Una nota anterior se llevó $100.01 al 0 % (un centavo de más, sin declararlo):
    // al documento le quedan $215.99 en total —el tope por el total deja pasar los $100 de Y—, pero al 0 % sólo $99.99.
    const g = globalDe([
      ticketGlobal('x', 'F-X', { IVA_0: 10000 }, []),
      ticketGlobal('y', 'F-Y', { IVA_0: 10000 }, []),
      ticketGlobal('z', 'F-Z', { IVA_16: 11600 }, []),
    ])
    const loaded = devolucionEnLaGlobal(releer(g), 'y', 10000)
    loaded.acreditadoDelDocumento = {
      ...nada(),
      notas: [{ IVA_0: { baseCents: 10001, ivaCents: 0, totalCents: 10001 } }],
      toleranciaDeTickets: { IVA_0: { baseCents: 50, ivaCents: 50 } },
    }
    expect(checkCreditNoteEligibility(loaded)).toEqual({
      eligible: false,
      reason: 'EXCEEDS_REMAINING',
      message: MOTIVO_SALDO_DEL_DOCUMENTO,
    })
  })
  it('🔴 el lector acepta la deriva del documento (> 1 ¢) en una nota a una global, y la rechaza en una nota individual o si pasa su propia base', () => {
    const g = originalGlobalDe(['A', 'B', 'C', 'D', 'E'].map(x => [x, 10000] as [string, number]))
    const documento = nada()
    let ultima: any
    let loaded!: LoadedRefundForCreditNote
    for (const o of ['A', 'B', 'C', 'D', 'E']) {
      loaded = devolucionEnLaGlobal(releer(g), o, 10000)
      loaded.acreditadoDelDocumento = {
        ...documento,
        notas: [...documento.notas],
        toleranciaDeTickets: { ...documento.toleranciaDeTickets },
      }
      ultima = notaPorTratamiento(loaded)
      expect(ultima).toHaveProperty('entradaParcial') // cada nota sale (si no, se detiene aquí, por aserción)
      acumularNota(documento, ultima.entradaParcial)
    }
    const deriva = ultima.entradaParcial.redondeo.find((r: any) => r.ambito === 'DOCUMENTO_GLOBAL')
    expect(deriva?.cents).toBeGreaterThan(1)
    const c = capturarEgreso(loaded, 'cfdi-refund-pay-refund-1')
    const fila = { ...c.base, protocoloIva: 1, entrada: c.entrada as any, entradaHuella: huellaDeEntrada(c.entrada) }
    expect(leerEgreso(fila)).toMatchObject({ version: 2, originalEsGlobal: true })
    const mala = JSON.parse(JSON.stringify(fila))
    mala.entrada.redondeo.find((r: any) => r.ambito === 'DOCUMENTO_GLOBAL').cents = mala.entrada.porTratamiento.IVA_16.baseCents + 1
    mala.entradaHuella = huellaDeEntrada(mala.entrada)
    expect(() => leerEgreso(mala)).toThrow(/soporte/)
    // Una nota INDIVIDUAL con una deriva de documento global: el lector la rechaza.
    const individual = (() => {
      const l = makeLoaded({})
      const ci = capturarEgreso(l, 'cfdi-refund-pay-refund-1')
      const e: any = ci.entrada
      e.redondeo = [{ tratamiento: 'IVA_16', componente: 'BASE', cents: 1, ambito: 'DOCUMENTO_GLOBAL' }]
      return { ...ci.base, protocoloIva: 1, entrada: e, entradaHuella: huellaDeEntrada(e) }
    })()
    expect(() => leerEgreso(individual)).toThrow(/soporte/)
  })
})

describe('C2 · T8 ronda 1 · minors', () => {
  beforeEach(() => olvidarGlobalesEvaluadas())
  it('🔴 M1: sin forma SAT en el reembolso, la nota toma la forma del TICKET (03), no la de la global (04)', () => {
    const g = globalDe([
      ticketGlobal('t1', 'F-1', { IVA_16: 11600 }, [], { formaPago: '04' }),
      ticketGlobal('t2', 'F-2', { IVA_16: 1000 }, [], { formaPago: '03' }),
    ])
    expect((g!.entrada as any).params.payment_form).toBe('04')
    const loaded = devolucionEnLaGlobal(g, 't2', 1000)
    loaded.refund.method = 'DIGITAL_WALLET' as any
    expect(formaPagoDeLaNota(loaded)).toBe('03')
    expect(capturarEgreso(loaded, 'cfdi-refund-pay-refund-1').base.formaPago).toBe('03')
    loaded.refund.method = 'CASH' // con forma propia, la del reembolso
    expect(formaPagoDeLaNota(loaded)).toBe('01')
  })
  it.each([
    ['status CANCELLED', { status: 'CANCELLED', cancelStatus: 'CANCELLED' }],
    ['cancelación aceptada', { cancelStatus: 'ACCEPTED' }],
  ])('🔴 M2: una global cancelada (%s) se detiene con su motivo propio', (_n, over) => {
    const loaded = devolucionEnLaGlobal(originalGlobal(over as any), 'o1', 1000)
    expect(checkCreditNoteEligibility(loaded)).toEqual({ eligible: false, reason: 'ORIGINAL_CANCELLED', message: MOTIVO_GLOBAL_CANCELADA })
  })
  it('control — M2: una individual cancelada conserva su texto de siempre', () => {
    expect(checkCreditNoteEligibility(makeLoaded({ original: makeOriginal({ cancelStatus: 'CANCELLED' }) }))).toMatchObject({
      reason: 'ORIGINAL_CANCELLED',
      message: 'La factura original fue cancelada; una nota de crédito no aplica sobre un CFDI cancelado.',
    })
  })
  it('🔴 M5: el CP del receptor genérico es el lugar de expedición VIGENTE del emisor (el de la nota), no el de la global', () => {
    const g = originalGlobal({
      fiscalEmisor: { id: 'e1', provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE', serie: 'G', lugarExpedicion: '06000' },
    })
    expect(g!.receptorCp).toBe('01000')
    const loaded = devolucionEnLaGlobal(g, 'o1', 1000)
    const c = capturarEgreso(loaded, 'cfdi-refund-pay-refund-1')
    expect(c.entrada.params.receptor).toMatchObject({ rfc: 'XAXX010101000', codigoPostal: '06000' })
    expect(c.base.receptorCp).toBe('06000')
    expect(leerEgreso({ ...c.base, protocoloIva: 1, entrada: c.entrada as any, entradaHuella: huellaDeEntrada(c.entrada) })).toMatchObject({
      version: 2,
    })
  })
  it('control — M6: un ticket todo-16 con IVA aparte (`lineas`) cuyo concepto recibió el centavo de la 6b: su tramo es 1 ¢ menos de lo que cobró; devolverlo completo se detiene con su texto, nunca se acredita de más', () => {
    // G6 de C1 (forma real): netos $10.15 y $20.15 ⇒ cobrados 11.77 + 23.37; el PAC daría 35.15 ⇒ la 6b pone 1 ¢ de descuento.
    const aparte = (orderId: string, netCents: number) => {
      const cobrado = Math.round(netCents * 1.16)
      const sub = Math.round(cobrado / 1.16)
      const linea = {
        orderId,
        orderNumber: `F-${orderId}`,
        totalCents: cobrado,
        subtotalCents: sub,
        taxCents: cobrado - sub,
        formaPago: '04',
        priceIncludesIva: false,
        taxRate: 0.16,
        objetoImp: '02',
      }
      return ticketGlobal(orderId, `F-${orderId}`, { IVA_16: cobrado }, [[`${orderId}-a`, cobrado, 'IVA_16']], {
        sinReales: true,
        lineas: [linea],
      })
    }
    const tickets = [aparte('a', 1015), aparte('b', 2015)]
    const g = globalDe(tickets)
    expect((g!.entrada as any).ajustes).toHaveLength(1)
    const tramos = tickets.map(t => tramoDe(g, t.orderId).IVA_16.totalCents)
    expect(tramos.reduce((s, c) => s + c, 0)).toBe(tickets.reduce((s, t) => s + t.paidCents, 0)) // los tramos suman lo cobrado
    const corto = tickets.findIndex((t, i) => tramos[i] < t.paidCents)
    expect(corto).toBeGreaterThanOrEqual(0)
    expect(tickets[corto].paidCents - tramos[corto]).toBe(1)
    const completo = devolucionEnLaGlobal(g, tickets[corto].orderId, tickets[corto].paidCents)
    expect(checkCreditNoteEligibility(completo)).toEqual({
      eligible: false,
      reason: 'EXCEEDS_REMAINING',
      message: `Lo que se devuelve ($${(tickets[corto].paidCents / 100).toFixed(2)}) excede lo que queda por acreditar de este ticket en la factura global ($${(tramos[corto] / 100).toFixed(2)}).`,
    })
    expect(checkCreditNoteEligibility(devolucionEnLaGlobal(g, tickets[corto].orderId, tramos[corto])).eligible).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C2 · Tarea 9: «acreditar por importe» (P10; Codex C2-16)
// ─────────────────────────────────────────────────────────────────────────────

describe('C2 · T9 · acreditar por importe (P10)', () => {
  /** La todo-16 de hoy SIN `montosPorRenglon` y un reembolso por artículos del pan completo. */
  const sinEvidencia = () => {
    const l = makeLoaded({ original: makeOriginal({ entrada: { ...entradaTodo16(), montosPorRenglon: undefined } }) })
    l.refund.processorData = { refundedItems: [{ orderItemId: 'pan', amountCents: l.refund.salesRefundCents }] }
    return l
  }
  /** La mezclada (café $200 al 0 % + pan $58 al 16 %) SIN `montosPorRenglon`; el reembolso por artículos de `cents` del pan. */
  const mixtaSinEvidencia = (cents = 5800, acreditado?: LoadedRefundForCreditNote['acreditado']) => {
    const o = originalMixta()
    const loaded = porArticulo(makeOriginal({ entrada: { ...(o!.entrada as any), montosPorRenglon: undefined } }), 'pan', cents, acreditado)
    return loaded
  }
  /** La alternativa ofrecida (si no hay, la prueba cae aquí, por aserción). */
  const ofrecida = (l: LoadedRefundForCreditNote) => {
    const a = alternativaPorImporte(l)
    expect(a).not.toBeNull()
    return a!
  }
  /** Lo acreditado con una nota viva de `cents` toda al 0 % (cambia la proporción de lo que queda). */
  const conNotaAl0 = (cents: number): LoadedRefundForCreditNote['acreditado'] => ({
    ...makeLoaded().acreditado,
    notas: [{ IVA_0: { baseCents: cents, ivaCents: 0, totalCents: cents } }],
    alreadyCreditedCents: cents,
  })
  const porImporte = (l: LoadedRefundForCreditNote) => {
    const x = { ...l, refund: { ...l.refund, processorData: undefined } }
    return notaPorTratamiento(x) as any
  }

  it('🔴 la vista previa ofrece la alternativa con desglose y huella SÓLO cuando falta evidencia', () => {
    expect(alternativaPorImporte(sinEvidencia())).toMatchObject({
      huella: expect.any(String),
      entradaParcial: { modalidad: 'POR_IMPORTE_ELEGIDO' },
    })
    const excede = makeLoaded({ original: originalMixta() })
    excede.refund.salesRefundCents = 5900
    excede.refund.processorData = { refundedItems: [{ orderItemId: 'pan', amountCents: 5900 }] } // I-8: no se ofrece
    expect(checkCreditNoteEligibility(excede).reason).toBe('ARTICULO_EXCEDE_LO_FACTURADO')
    expect(alternativaPorImporte(excede)).toBeNull()
  })
  it('control — con la elección y la huella vigente, la nota sale POR_IMPORTE_ELEGIDO; con evidencia, la elección se rechaza', () => {
    const l = sinEvidencia()
    l.modalidadElegida = 'POR_IMPORTE'
    expect(notaPorTratamiento(l)).toMatchObject({ entradaParcial: { modalidad: 'POR_IMPORTE_ELEGIDO' } })
    const conEvidencia = makeLoaded({ original: originalMixta() })
    conEvidencia.refund.salesRefundCents = 20000
    conEvidencia.refund.processorData = { refundedItems: [{ orderItemId: 'cafe', amountCents: 20000 }] }
    conEvidencia.modalidadElegida = 'POR_IMPORTE'
    expect(checkCreditNoteEligibility(conEvidencia)).toMatchObject({ eligible: false, reason: 'MODALIDAD_NO_PERMITIDA' })
  })
  it('🔴 la alternativa es LA MISMA cuenta que una devolución por importe (proporcional a lo que queda), y su huella es la del reparto', () => {
    const l = mixtaSinEvidencia()
    expect(checkCreditNoteEligibility(l).reason).toBe('SIN_MONTO_POR_ARTICULO')
    const alt = ofrecida(l)
    const igual = porImporte(l)
    expect(alt.entradaParcial.brutoPorTratamiento).toEqual(igual.entradaParcial.brutoPorTratamiento)
    expect(alt.entradaParcial.porTratamiento).toEqual(igual.entradaParcial.porTratamiento)
    expect(Object.keys(alt.entradaParcial.brutoPorTratamiento).sort()).toEqual(['IVA_0', 'IVA_16']) // repartido, no todo al pan
    expect(alt.items).toEqual(igual.items)
    // Ronda 1 (M-1), cambio A PROPÓSITO: la huella ata también el redondeo y la factura original.
    expect(alt.huella).toBe(
      huellaDeEntrada({
        refundPaymentId: 'pay-refund-1',
        originalUuid: 'UUID-INGRESO-1',
        brutoPorTratamiento: alt.entradaParcial.brutoPorTratamiento,
        porTratamiento: alt.entradaParcial.porTratamiento,
        ajustes: alt.entradaParcial.ajustes,
        redondeo: alt.entradaParcial.redondeo,
      }),
    )
    expect(huellaDelReparto({ refundPaymentId: 'pay-refund-1', originalUuid: 'UUID-INGRESO-1', ...alt.entradaParcial })).toBe(alt.huella)
    // Otra nota viva que cambia la PROPORCIÓN de lo que queda (p. ej. un ajuste de entregas todo al 0 %) ⇒ otro reparto ⇒ otra huella.
    const otra = ofrecida(mixtaSinEvidencia(5800, conNotaAl0(10000)))
    expect(otra.entradaParcial.brutoPorTratamiento).not.toEqual(alt.entradaParcial.brutoPorTratamiento)
    expect(otra.huella).not.toBe(alt.huella)
  })
  it('🔴 ARTICULO_SIN_EVIDENCIA (un artículo que la factura no tiene, p. ej. una cortesía): se ofrece, y la vista dice que ese dinero no se facturó', () => {
    const l = makeLoaded({ original: originalMixta() })
    l.refund.salesRefundCents = 2500
    l.refund.processorData = { refundedItems: [{ orderItemId: 'cortesia', amountCents: 2500, productName: 'Galleta de cortesía' }] }
    expect(checkCreditNoteEligibility(l).reason).toBe('ARTICULO_SIN_EVIDENCIA')
    const alt = ofrecida(l)
    expect(alt.entradaParcial.modalidad).toBe('POR_IMPORTE_ELEGIDO')
    expect(alt.aviso).toContain('«Galleta de cortesía»')
    expect(alt.aviso).toMatch(/no aparece en la factura/)
    // Sin evidencia por falta de montos (no por un artículo ajeno), no hay aviso de «no se facturó».
    expect(ofrecida(mixtaSinEvidencia()).aviso).toBeUndefined()
  })
  it.each([
    [
      'CENTAVOS_DE_REDONDEO',
      () => {
        const l = makeLoaded({ original: originalMixta() })
        l.refund.salesRefundCents = 5801
        l.refund.processorData = { refundedItems: [{ orderItemId: 'pan', amountCents: 5801 }] }
        return l
      },
    ],
    [
      'ARTICULOS_NO_CUADRAN',
      () => {
        const l = sinEvidencia()
        l.refund.processorData = { refundedItems: [{ orderItemId: 'pan', amountCents: 100 }] }
        return l
      },
    ],
    [
      'ORIGINAL_CANCELLED',
      () => {
        const l = sinEvidencia()
        l.original = { ...l.original!, status: 'CANCELLED' }
        return l
      },
    ],
    [
      'ORIGINAL_CANCEL_PENDING',
      () => {
        const l = sinEvidencia()
        l.original = { ...l.original!, cancelStatus: 'REQUESTED' }
        return l
      },
    ],
  ])('control — con %s NO se ofrece (no es falta de evidencia)', (motivo, armar) => {
    const l = armar()
    expect(checkCreditNoteEligibility(l).reason).toBe(motivo)
    expect(alternativaPorImporte(l)).toBeNull()
  })
  it('control — ni cuando ya es elegible (por importe o por artículos con evidencia), ni cuando la elección ya está hecha', () => {
    expect(alternativaPorImporte(makeLoaded())).toBeNull()
    expect(alternativaPorImporte(porArticulo(originalMixta(), 'pan', 5800))).toBeNull()
    const elegida = sinEvidencia()
    elegida.modalidadElegida = 'POR_IMPORTE'
    expect(alternativaPorImporte(elegida)).toBeNull()
  })
  it('🔴 un ticket de una global SIN conceptos reales: se ofrece, proporcional a lo que queda DEL TICKET', () => {
    olvidarGlobalesEvaluadas()
    const g = originalGlobal({ sinReales: true })
    const l = devolucionEnLaGlobal(g, 'o2', 5800, [['o2-pan', 5800]])
    expect(checkCreditNoteEligibility(l).reason).toBe('SIN_MONTO_POR_ARTICULO')
    const alt = ofrecida(l)
    expect(alt.entradaParcial).toMatchObject({ modalidad: 'POR_IMPORTE_ELEGIDO', originalEsGlobal: true, folio: 'ORD-2' })
    expect(alt.entradaParcial.brutoPorTratamiento).toEqual(
      porImporte(devolucionEnLaGlobal(g, 'o2', 5800)).entradaParcial.brutoPorTratamiento,
    )
  })
  it('🔴 si «por importe» TAMBIÉN se detiene, no se ofrece, y la vista no promete lo que no hay (dice por qué)', async () => {
    // El reembolso no tiene forma SAT y la original es 99 con pagos: ninguna modalidad tiene forma de pago.
    const l = sinEvidencia()
    l.refund.method = 'OTHER' as any
    l.original = { ...l.original!, formaPago: '99', metodoPago: 'PPD', tienePagos: true }
    expect(alternativaPorImporte(l)).toBeNull()
    ;(prisma.cfdi.findUnique as jest.Mock).mockResolvedValueOnce(null)
    ;(prisma.merchantFiscalConfig.findMany as jest.Mock).mockResolvedValueOnce([{ facturacionEnabled: true }])
    const st = await getRefundCreditNoteStatus('v1', 'pay-refund-1', { loadRefundForCreditNote: async () => l })
    expect(st!.preview!.alternativa).toBeUndefined()
    expect(st!.eligibility.reason).toBe('SIN_MONTO_POR_ARTICULO')
    expect(st!.eligibility.message).not.toMatch(/Puedes acreditar/)
    expect(st!.eligibility.message).toContain(MOTIVO_SIN_FORMA_DE_PAGO)
  })
  it('🔴 la vista previa (GET) trae `preview.alternativa` con el desglose, el redondeo y la huella', async () => {
    ;(prisma.cfdi.findUnique as jest.Mock).mockResolvedValueOnce(null)
    ;(prisma.merchantFiscalConfig.findMany as jest.Mock).mockResolvedValueOnce([{ facturacionEnabled: true }])
    const l = mixtaSinEvidencia()
    const st = await getRefundCreditNoteStatus('v1', 'pay-refund-1', { loadRefundForCreditNote: async () => l })
    const alt = ofrecida(mixtaSinEvidencia())
    expect(st!.eligibility).toMatchObject({ eligible: false, reason: 'SIN_MONTO_POR_ARTICULO' })
    expect(st!.preview!.desglose).toBeUndefined() // lo de por artículos no existe; el reparto ofrecido va en `alternativa`
    expect(st!.preview!.alternativa).toEqual({
      modalidad: 'POR_IMPORTE',
      desglose: Object.entries(alt.entradaParcial.porTratamiento).map(([tratamiento, c]: [string, any]) => ({
        tratamiento,
        cents: c.totalCents,
        baseCents: c.baseCents,
        ivaCents: c.ivaCents,
      })),
      redondeo: alt.entradaParcial.redondeo,
      huella: alt.huella,
    })
    expect(st!.preview!.alternativa!.desglose.reduce((s, d) => s + d.cents, 0)).toBe(5800)
  })
  it('🔴 la captura ELEGIDA escribe `elegidoPor` (quien confirmó) y el lector v2 la acepta; otra modalidad nunca lleva `elegidoPor`', () => {
    const l = mixtaSinEvidencia()
    l.modalidadElegida = 'POR_IMPORTE'
    const c = capturarEgreso(l, 'cfdi-refund-pay-refund-1', 'staff-9')
    expect(c.entrada).toMatchObject({ modalidad: 'POR_IMPORTE_ELEGIDO', elegidoPor: 'staff-9' })
    const fila = { ...c.base, protocoloIva: 1, entrada: c.entrada as any, entradaHuella: huellaDeEntrada(c.entrada) }
    expect(leerEgreso(fila)).toMatchObject({ version: 2, modalidad: 'POR_IMPORTE_ELEGIDO', elegidoPor: 'staff-9' })
    // Sin quién (p. ej. una llamada interna): `null`, nunca ausente.
    expect(capturarEgreso(l, 'cfdi-refund-pay-refund-1').entrada).toMatchObject({ elegidoPor: null })
    // Por artículos con evidencia: aunque llegue alguien, la entrada no lleva `elegidoPor` (el lector lo exige).
    const art = capturarEgreso(porArticulo(originalMixta(), 'pan', 5800), 'cfdi-refund-pay-refund-1', 'staff-9')
    expect(art.entrada.modalidad).toBe('POR_ARTICULOS')
    expect('elegidoPor' in art.entrada).toBe(false)
  })
})

describe('C2 · T9 · la emisión «por importe»: huella obligatoria y comparada bajo los candados', () => {
  const mixtaSinEvidencia = (cents = 5800, acreditado?: LoadedRefundForCreditNote['acreditado']) => {
    const o = originalMixta()
    return porArticulo(makeOriginal({ entrada: { ...(o!.entrada as any), montosPorRenglon: undefined } }), 'pan', cents, acreditado)
  }
  const tx = {
    $queryRaw: jest.fn(async () => [{ venueId: 'v1', organizationId: 'org-1' }]),
    $executeRaw: jest.fn(async () => 0),
    cfdi: { findUnique: jest.fn(async () => null) },
  }
  const PARADA = new Error('PARADA: aquí se habría reservado')
  /** La huella que la vista previa le enseñó a la persona: el reparto por importe de ESA lectura (la fórmula del plan). */
  const huellaVista = (l: LoadedRefundForCreditNote) => {
    const n = notaPorTratamiento({ ...l, modalidadElegida: 'POR_IMPORTE' }) as any
    // Ronda 1 (M-1), cambio A PROPÓSITO: la fórmula ata también la factura original y el redondeo.
    return huellaDeEntrada({
      refundPaymentId: l.refund.id,
      originalUuid: l.original!.uuid,
      brutoPorTratamiento: n.entradaParcial.brutoPorTratamiento,
      porTratamiento: n.entradaParcial.porTratamiento,
      ajustes: n.entradaParcial.ajustes,
      redondeo: n.entradaParcial.redondeo,
    })
  }
  const deps = (fuera: () => LoadedRefundForCreditNote, dentro: () => LoadedRefundForCreditNote) => {
    const reserveCfdi = jest.fn(async () => {
      throw PARADA
    })
    const loadRefundForCreditNote = jest.fn(async (_v: string, _r: string, t?: unknown) => (t ? dentro() : fuera()))
    return {
      findExistingCfdi: async () => null,
      loadRefundForCreditNote,
      resolveProvider: () => ({ name: 'doble', createCreditNote: jest.fn() }),
      runInTransaction: async (fn: any) => fn(tx),
      reserveCfdi,
    } as any
  }
  const emitir = (p: Record<string, unknown>, d: any) =>
    emitRefundCreditNote({ venueId: 'v1', refundPaymentId: 'pay-refund-1', sandbox: true, requestedByStaffId: 'staff-9', ...p }, d)

  it('🔴 «por importe» sin huella ⇒ BadRequestError (400) y no carga nada', async () => {
    const d = deps(mixtaSinEvidencia, mixtaSinEvidencia)
    const findExistingCfdi = jest.fn()
    await expect(emitir({ modalidad: 'POR_IMPORTE' }, { ...d, findExistingCfdi })).rejects.toThrow(BadRequestError)
    await expect(emitir({ modalidad: 'POR_IMPORTE' }, { ...d, findExistingCfdi })).rejects.toThrow(MOTIVO_FALTA_LA_HUELLA)
    expect(findExistingCfdi).not.toHaveBeenCalled()
    expect(d.loadRefundForCreditNote).not.toHaveBeenCalled()
  })
  it('🔴 con una huella vieja (otra nota cambió lo que queda entre la vista previa y el POST) ⇒ ConflictError y NO reserva', async () => {
    const huella = huellaVista(mixtaSinEvidencia())
    // Entre la vista previa y el POST se timbró una nota (un ajuste de entregas) toda al 0 %: cambia la proporción de lo que queda.
    const conNotaAl0 = { ...makeLoaded().acreditado, notas: [{ IVA_0: { baseCents: 10000, ivaCents: 0, totalCents: 10000 } }] }
    const d = deps(mixtaSinEvidencia, () => mixtaSinEvidencia(5800, conNotaAl0))
    await expect(emitir({ modalidad: 'POR_IMPORTE', huellaDelReparto: huella }, d)).rejects.toThrow(ConflictError)
    await expect(emitir({ modalidad: 'POR_IMPORTE', huellaDelReparto: huella }, d)).rejects.toThrow(MOTIVO_REPARTO_CAMBIO)
    expect(d.reserveCfdi).not.toHaveBeenCalled()
  })
  it('🔴 con la huella vigente reserva la captura ELEGIDA, con quién la eligió; la carga dentro y fuera lleva la elección', async () => {
    const huella = huellaVista(mixtaSinEvidencia())
    const d = deps(mixtaSinEvidencia, mixtaSinEvidencia)
    await expect(emitir({ modalidad: 'POR_IMPORTE', huellaDelReparto: huella }, d)).rejects.toBe(PARADA)
    expect(d.reserveCfdi).toHaveBeenCalledTimes(1)
    const data = (d.reserveCfdi.mock.calls[0] as any)[0]
    expect(data.entrada).toMatchObject({
      modalidad: 'POR_IMPORTE_ELEGIDO',
      elegidoPor: 'staff-9',
      brutoPorTratamiento: (notaPorTratamiento({ ...mixtaSinEvidencia(), modalidadElegida: 'POR_IMPORTE' }) as any).entradaParcial
        .brutoPorTratamiento,
    })
    expect(data.entradaHuella).toBe(huellaDeEntrada(data.entrada))
  })
  it('control — sin elegir, la misma devolución sigue detenida por falta de evidencia (nunca cambia en silencio de modalidad)', async () => {
    const d = deps(mixtaSinEvidencia, mixtaSinEvidencia)
    await expect(emitir({}, d)).rejects.toThrow(/no registró cuánto se facturó/)
    expect(d.reserveCfdi).not.toHaveBeenCalled()
  })
  it('🔴 eligiendo «por importe» con evidencia (por artículos sí se puede) ⇒ se rechaza y no reserva', async () => {
    const conEvidencia = () => porArticulo(originalMixta(), 'pan', 5800)
    const d = deps(conEvidencia, conEvidencia)
    await expect(emitir({ modalidad: 'POR_IMPORTE', huellaDelReparto: 'x'.repeat(64) }, d)).rejects.toThrow(/sólo se puede elegir/)
    expect(d.reserveCfdi).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C2 · Tarea 8 · ronda de arreglos 2
// ─────────────────────────────────────────────────────────────────────────────

type PorTasa = Partial<Record<'IVA_16' | 'IVA_0' | 'EXENTO', number>>
/**
 * Simula devoluciones sucesivas de tickets de una global, como las vería la emisión real: cada nota con lo de las anteriores en SU ticket y
 * en el documento (`acumularNota`, la misma que usa `acreditadoContra`); la que sale se CAPTURA (`capturarEgreso`) y se relee con el lector
 * de la nota (`leerEgreso`), igual que después del commit. Devuelve lo que salió (con su entrada) y lo que se detuvo (con su motivo).
 */
function simular(g: ReturnType<typeof globalDe>, pasos: Array<[orderId: string, cents: number]>) {
  const delTicket = new Map<string, LoadedRefundForCreditNote['acreditado']>()
  const documento = nada()
  const salieron: any[] = []
  const detenidas: Array<{ paso: number; reason: string | null; message: string | null }> = []
  pasos.forEach(([o, cents], i) => {
    const loaded = devolucionEnLaGlobal(releer(g), o, cents)
    loaded.refund.id = `r${i}`
    const t = delTicket.get(o) ?? nada()
    delTicket.set(o, t)
    loaded.acreditado = { ...t, notas: [...t.notas], toleranciaDeTickets: structuredClone(t.toleranciaDeTickets) }
    loaded.acreditadoDelDocumento = {
      ...documento,
      notas: [...documento.notas],
      toleranciaDeTickets: structuredClone(documento.toleranciaDeTickets),
    }
    const e = checkCreditNoteEligibility(loaded)
    if (!e.eligible) return void detenidas.push({ paso: i, reason: e.reason, message: e.message })
    const c = capturarEgreso(loaded, `cfdi-refund-r${i}`)
    const fila = { ...c.base, protocoloIva: 1, entrada: c.entrada as any, entradaHuella: huellaDeEntrada(c.entrada) }
    expect(c.base.status).toBe('STAMPING')
    expect(() => leerEgreso(fila)).not.toThrow() // 🔴 N1: la nota reservada se lee (nunca «revisión de soporte» después del commit)
    acumularNota(t, c.entrada)
    acumularNota(documento, c.entrada)
    salieron.push(c.entrada)
  })
  return { salieron, detenidas }
}
/** Las invariantes del documento (por tasa): el total nunca se pasa; base/IVA ≤ tolerancias de ticket; toda deriva, registrada (y sólo ella). */
function revisarDocumento(g: ReturnType<typeof globalDe>, salieron: any[], primerTicket: string) {
  const doc = (fiscalDelTicketEnLaGlobal(devolucionEnLaGlobal(releer(g), primerTicket, 1), leerXmlConceptos(g!.xmlConceptos)!) as any)
    .documentoSinRestar as Record<string, { baseCents: number; ivaCents: number; totalCents: number }>
  const suma = (t: string, k: 'baseCents' | 'ivaCents' | 'totalCents') => salieron.reduce((s, e) => s + (e.porTratamiento[t]?.[k] ?? 0), 0)
  const registrado = (t: string, ambito: string, componente: string) =>
    salieron
      .flatMap(e => e.redondeo)
      .filter((r: any) => r.tratamiento === t && r.ambito === ambito && r.componente === componente)
      .reduce((s: number, r: any) => s + r.cents, 0)
  for (const t of Object.keys(doc)) {
    expect(suma(t, 'totalCents')).toBeLessThanOrEqual(doc[t].totalCents)
    for (const [k, c] of [
      ['baseCents', 'BASE'],
      ['ivaCents', 'IVA'],
    ] as const) {
      const deriva = Math.max(0, suma(t, k) - doc[t][k])
      expect(deriva).toBeLessThanOrEqual(registrado(t, 'TICKET', c))
      expect(registrado(t, 'DOCUMENTO_GLOBAL', c)).toBe(deriva)
    }
  }
  // Ninguna nota registra en el documento más que su propia base o IVA de esa tasa (el tope del lector es verdad).
  for (const e of salieron)
    for (const r of e.redondeo.filter((x: any) => x.ambito === 'DOCUMENTO_GLOBAL'))
      expect(r.cents).toBeLessThanOrEqual(
        r.componente === 'BASE' ? e.porTratamiento[r.tratamiento].baseCents : e.porTratamiento[r.tratamiento].ivaCents,
      )
}

describe('C2 · T8 ronda 2 · N1: cada nota registra sólo lo que ELLA agrega a la deriva del documento', () => {
  beforeEach(() => olvidarGlobalesEvaluadas())
  it('🔴 5 × $100: 4 completos + $99.99 + $0.01 ⇒ las 6 notas salen, se capturan y se LEEN; la deriva del documento queda registrada como suma', () => {
    const g = originalGlobalDe(['A', 'B', 'C', 'D', 'E'].map(x => [x, 10000] as [string, number]))
    const { salieron, detenidas } = simular(g, [
      ['A', 10000],
      ['B', 10000],
      ['C', 10000],
      ['D', 10000],
      ['E', 9999],
      ['E', 1],
    ])
    expect(detenidas).toEqual([])
    expect(salieron).toHaveLength(6)
    revisarDocumento(g, salieron, 'A')
  })
  it('🔴 20 × $100 + uno de $0.05 devueltos completos (el chico al final) ⇒ las 21 salen y se leen', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `T${String(i).padStart(2, '0')}`)
    const g = originalGlobalDe([...ids.map(x => [x, 10000] as [string, number]), ['CH', 5]])
    const { salieron, detenidas } = simular(g, [...ids.map(x => [x, 10000] as [string, number]), ['CH', 5]])
    expect(detenidas).toEqual([])
    expect(salieron).toHaveLength(21)
    revisarDocumento(g, salieron, 'T00')
  })
  it('control — la comprobación del documento es la ACUMULADA: si ya iba 2 ¢ arriba en IVA (lo declarado), una nota que agrega 1 ¢ más se detiene', () => {
    const g = originalGlobalDe([
      ['A', 10000],
      ['B', 10000],
    ])
    // $0.08 al 16 %: base 7 ¢, IVA 1 ¢. El documento (IVA 27.59) ya va 2 ¢ arriba por una nota anterior que declaró sus 2 ¢.
    const loaded = devolucionEnLaGlobal(releer(g), 'B', 8)
    loaded.acreditadoDelDocumento = {
      ...nada(),
      notas: [{ IVA_16: { baseCents: 7238, ivaCents: 2761, totalCents: 9999 } }],
      toleranciaDeTickets: { IVA_16: { baseCents: 0, ivaCents: 2 } },
    }
    expect(notaPorTratamiento(loaded)).toEqual({ eligible: false, reason: 'EXCEEDS_REMAINING', message: MOTIVO_SALDO_DEL_DOCUMENTO })
  })
  /** Generador determinista (mulberry32). */
  const generador = (semilla0: number) => {
    let semilla = semilla0
    const azar = () => {
      semilla = (semilla + 0x6d2b79f5) | 0
      let x = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla)
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296
    }
    return { azar, entre: (a: number, b: number) => a + Math.floor(azar() * (b - a + 1)) }
  }
  /**
   * Corre `globales` globales al azar y revisa todo: `cierre` = cada ticket se devuelve casi entero y sus centavos sueltos (1-5 ¢) cierran la
   * global AL FINAL (el régimen de la re-revisión); si no, cada ticket en 1-3 partes intercaladas al azar.
   */
  function alAzar(semilla0: number, globales: number, cierre: boolean) {
    const { azar, entre } = generador(semilla0)
    let notas = 0
    let hechas = 0
    const motivos: Record<string, number> = {}
    for (let k = 0; k < globales; k++) {
      olvidarGlobalesEvaluadas()
      const n = entre(2, 14)
      const igual = cierre && azar() < 0.6 ? entre(100, 50000) : 0 // tickets iguales: el reparto del documento deja la base desfasada
      const tickets = Array.from({ length: n }, (_, i) => {
        const id = `g${k}t${i}`
        const mezclado = k % 3 === 0 && azar() < 0.5
        const p: PorTasa = mezclado
          ? { IVA_16: entre(1, 30000), IVA_0: entre(1, 30000), ...(azar() < 0.5 ? { EXENTO: entre(1, 9000) } : {}) }
          : { IVA_16: igual || entre(1, 205000) }
        return ticketGlobal(id, `F-${id}`, p, [])
      })
      let g: ReturnType<typeof globalDe>
      try {
        g = globalDe(tickets)
      } catch {
        continue // una global que C1 no cuadra no se timbra
      }
      hechas++
      const grandes: Array<[string, number]> = []
      const chicos: Array<[string, number]> = []
      for (const t of tickets) {
        if (cierre) {
          const c = t.paidCents > 5 && azar() < 0.7 ? entre(1, 5) : 0
          grandes.push([t.orderId, t.paidCents - c])
          if (c) chicos.push([t.orderId, c])
          continue
        }
        const partes = Math.min(entre(1, 3), t.paidCents)
        let queda = t.paidCents
        for (let j = partes; j > 1; j--) {
          const c = entre(1, queda - (j - 1))
          grandes.push([t.orderId, c])
          queda -= c
        }
        grandes.push([t.orderId, queda])
      }
      const barajar = (xs: Array<[string, number]>) => {
        for (let i = xs.length - 1; i > 0; i--) {
          const j = entre(0, i)
          ;[xs[i], xs[j]] = [xs[j], xs[i]]
        }
        return xs
      }
      const { salieron, detenidas } = simular(g, [...barajar(grandes), ...barajar(chicos)])
      notas += salieron.length
      for (const d of detenidas) motivos[d.reason ?? '?'] = (motivos[d.reason ?? '?'] ?? 0) + 1
      expect(detenidas.filter(d => d.message === MOTIVO_SALDO_DEL_DOCUMENTO)).toEqual([]) // el documento no detiene ninguna
      revisarDocumento(g, salieron, tickets[0].orderId)
    }
    return { hechas, notas, motivos }
  }
  it('🔴 al azar, cerrando cada global con centavos sueltos al final (tickets iguales y distintos, 16 % y mezclados) ⇒ toda nota que sale se lee, ningún total se pasa, toda deriva queda registrada y el DOCUMENTO no detiene ninguna', () => {
    const r = alAzar(20261009, 120, true)
    console.log(`N1 al azar (cierre): ${JSON.stringify(r)}`)
    expect(r.hechas).toBeGreaterThan(100)
    expect(r.notas).toBeGreaterThan(1200)
    // Lo que sí puede detenerse es P8 DENTRO de un ticket (como en una factura sola), nunca el documento.
    expect(Object.keys(r.motivos).every(m => ['CENTAVOS_DE_REDONDEO', 'EXCEEDS_REMAINING'].includes(m))).toBe(true)
  })
  it('control — al azar, cada ticket en 1-3 partes intercaladas: las mismas invariantes', () => {
    const r = alAzar(77, 60, false)
    console.log(`N1 al azar (intercalado): ${JSON.stringify(r)}`)
    expect(r.hechas).toBeGreaterThan(40)
    expect(r.notas).toBeGreaterThan(500)
    expect(Object.keys(r.motivos).every(m => ['CENTAVOS_DE_REDONDEO', 'EXCEEDS_REMAINING'].includes(m))).toBe(true)
  })
})

describe('C2 · T8 ronda 2 · N2: si la evaluación está por vencer, se reevalúa FUERA de los candados', () => {
  beforeEach(() => olvidarGlobalesEvaluadas())
  afterEach(() => jest.restoreAllMocks())
  it('🔴 la vista previa evaluó hace 119 s; se emite y la espera del candado pasa de los 120 s ⇒ bajo candado NO se evalúa en frío', async () => {
    const lee = jest.spyOn(servicioDeGlobal, 'leerGlobal')
    const ahora = jest.spyOn(Date, 'now').mockReturnValue(5_000_000)
    const g = originalGlobal()
    const leer = () => devolucionEnLaGlobal(releer(g), 'o2', 5800, [['o2-pan', 5800]])
    expect(checkCreditNoteEligibility(leer()).eligible).toBe(true) // la vista previa
    expect(lee).toHaveBeenCalledTimes(1)
    ahora.mockReturnValue(5_000_000 + 119_000) // a la evaluación le queda 1 s
    const tx = {
      $queryRaw: jest.fn(async () => [{ venueId: 'v1', organizationId: 'org-1' }]),
      $executeRaw: jest.fn(async () => 0),
      cfdi: { findUnique: jest.fn(async () => null) },
    }
    const PARADA = new Error('PARADA: aquí se habría reservado')
    let alTomarElCandado = -1
    await expect(
      emitRefundCreditNote({ venueId: 'v1', refundPaymentId: 'pay-refund-1', sandbox: true }, {
        findExistingCfdi: async () => null,
        loadRefundForCreditNote: async () => leer(),
        resolveProvider: () => ({ name: 'doble', createCreditNote: jest.fn() }) as any,
        runInTransaction: async (fn: any) => fn(tx),
        reserveCfdi: async () => {
          throw PARADA
        },
        despuesDelCandadoDeLaGlobal: async () => {
          ahora.mockReturnValue(5_000_000 + 125_000) // esperó el candado: la evaluación de la vista previa ya habría vencido
          alTomarElCandado = lee.mock.calls.length
        },
      } as any),
    ).rejects.toBe(PARADA)
    expect(alTomarElCandado).toBeGreaterThan(0)
    expect(lee).toHaveBeenCalledTimes(alTomarElCandado) // bajo candado, ninguna evaluación en frío
  })
  it('control — con vida de sobra no se reevalúa (la vista previa y la emisión siguen pagando UNA evaluación)', () => {
    expect(VIGENCIA_MINIMA_ANTES_DE_LOS_CANDADOS_MS).toBe(60_000)
    const lee = jest.spyOn(servicioDeGlobal, 'leerGlobal')
    const ahora = jest.spyOn(Date, 'now').mockReturnValue(7_000_000)
    const g = originalGlobal()
    const leer = () => devolucionEnLaGlobal(releer(g), 'o2', 5800, [['o2-pan', 5800]])
    checkCreditNoteEligibility(leer())
    ahora.mockReturnValue(7_000_000 + 30_000)
    asegurarGlobalVigente(leer())
    expect(lee).toHaveBeenCalledTimes(1)
  })
})

describe('C2 · T8 ronda 2 · N3: lo que entrega la memoria está congelado', () => {
  beforeEach(() => olvidarGlobalesEvaluadas())
  it('🔴 el tramo y el documento que devuelve fiscalDelTicketEnLaGlobal no se pueden mutar; otra petición ve lo de siempre', () => {
    const g = originalGlobal()
    const f = fiscalDelTicketEnLaGlobal(devolucionEnLaGlobal(releer(g), 'o2', 1), leerXmlConceptos(g!.xmlConceptos)!) as any
    expect(() => (f.fiscal.IVA_16.totalCents = 1)).toThrow(TypeError)
    expect(() => (f.documentoSinRestar.IVA_0 = { baseCents: 0, ivaCents: 0, totalCents: 0 })).toThrow(TypeError)
    const otra = fiscalDelTicketEnLaGlobal(devolucionEnLaGlobal(releer(g), 'o2', 1), leerXmlConceptos(g!.xmlConceptos)!) as any
    expect(otra.fiscal).toEqual({
      IVA_16: { baseCents: 5000, ivaCents: 800, totalCents: 5800 },
      IVA_0: { baseCents: 20000, ivaCents: 0, totalCents: 20000 },
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C2 · Tarea 9 · ronda de arreglos 1
// ─────────────────────────────────────────────────────────────────────────────

describe('C2 · T9 ronda 1 · I-1: la cortesía D9 se detecta por su RENGLÓN (también en una factura SIN montos) y el aviso la nombra', () => {
  /** La mezclada sin `montosPorRenglon`; el reembolso por artículos: el pan ($58) y una galleta de cortesía ($10) que la factura no lleva. */
  const conCortesia = (noFacturados?: LoadedRefundForCreditNote['refund']['noFacturados'], nombreEnElReembolso = true) => {
    const o = originalMixta()
    const l = makeLoaded({ original: makeOriginal({ entrada: { ...(o!.entrada as any), montosPorRenglon: undefined } }) })
    l.refund.salesRefundCents = 6800
    l.refund.processorData = {
      refundedItems: [
        { orderItemId: 'pan', amountCents: 5800, productName: 'Pan' },
        { orderItemId: 'galleta', amountCents: 1000, ...(nombreEnElReembolso ? { productName: 'Galleta de cortesía' } : {}) },
      ],
    }
    if (noFacturados) l.refund.noFacturados = noFacturados
    return l
  }
  it('🔴 factura SIN montos: se ofrece «por importe» y el aviso nombra la galleta y su importe (no el pan)', () => {
    const l = conCortesia([{ orderItemId: 'galleta', nombre: 'Galleta de cortesía' }])
    expect(checkCreditNoteEligibility(l).reason).toBe('SIN_MONTO_POR_ARTICULO')
    const alt = alternativaPorImporte(l)
    expect(alt).not.toBeNull()
    expect(alt!.aviso).toEqual(expect.stringContaining('«Galleta de cortesía» no aparece en la factura'))
    expect(alt!.aviso).toContain('($10.00)')
    expect(alt!.aviso).not.toContain('Pan')
  })
  it('🔴 sin el nombre en el reembolso, el aviso usa el del renglón', () => {
    const alt = alternativaPorImporte(conCortesia([{ orderItemId: 'galleta', nombre: 'Galleta' }], false))
    expect(alt).not.toBeNull()
    expect(alt!.aviso).toContain('«Galleta»')
  })
  it('control — sin cortesías marcadas, una factura sin montos no lleva aviso', () => {
    const alt = alternativaPorImporte(conCortesia([]))
    expect(alt).not.toBeNull()
    expect(alt!.aviso).toBeUndefined()
  })
  it('🔴 el aviso de un ticket en la global dice «de este ticket en la factura global» (M-3)', () => {
    olvidarGlobalesEvaluadas()
    const l = devolucionEnLaGlobal(originalGlobal({ sinReales: true }), 'o2', 6800, [
      ['o2-pan', 5800],
      ['o2-galleta', 1000],
    ])
    l.refund.noFacturados = [{ orderItemId: 'o2-galleta', nombre: 'Galleta' }]
    const alt = alternativaPorImporte(l)
    expect(alt).not.toBeNull()
    expect(alt!.aviso).toContain('«Galleta»')
    expect(alt!.aviso).toContain('lo que queda de este ticket en la factura global')
  })
  it('🔴 el cargador marca la cortesía por su renglón (neto 0), acotado a los artículos devueltos de ESA orden', async () => {
    const findManyItems = jest.fn().mockResolvedValue([
      { id: 'pan', productName: 'Pan', total: 58, discountAmount: 0, orderPromotionId: null, isCortesia: false },
      { id: 'galleta', productName: 'Galleta', total: 10, discountAmount: 10, orderPromotionId: null, isCortesia: true },
      { id: 'regalo', productName: 'Regalo', total: 0, discountAmount: 0, orderPromotionId: null, isCortesia: false },
    ])
    const tx = {
      payment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'r1',
          venueId: 'v1',
          orderId: 'o1',
          type: 'REFUND',
          status: 'COMPLETED',
          amount: -78,
          tipAmount: 0,
          method: 'CREDIT_CARD',
          tenderSatFormaPago: null,
          processorData: {
            refundedItems: [
              { orderItemId: 'pan', amountCents: 5800 },
              { orderItemId: 'galleta', amountCents: 1000 },
              { orderItemId: 'regalo', amountCents: 1000 },
              { orderItemId: 'pan', amountCents: 0 },
            ],
          },
        }),
      },
      order: { findUnique: jest.fn().mockResolvedValue({ venue: { slug: 'demo' } }) },
      orderItem: { findMany: findManyItems },
      cfdi: {
        findFirst: jest.fn(async ({ where }: any) => (where.replacesCfdiId !== undefined ? null : { ...makeOriginal(), isGlobal: false })),
        findMany: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { totalCents: 0 } }),
        count: jest.fn().mockResolvedValue(0),
      },
    } as any
    const loaded = await loadRefundForCreditNoteFromDb('v1', 'r1', tx)
    expect(findManyItems).toHaveBeenCalledTimes(1)
    const q = findManyItems.mock.calls[0][0]
    expect(q.where).toEqual({ id: { in: ['pan', 'galleta', 'regalo'] }, orderId: 'o1' })
    expect(q.take).toBe(3)
    expect(loaded!.refund.noFacturados).toEqual([
      { orderItemId: 'galleta', nombre: 'Galleta' },
      { orderItemId: 'regalo', nombre: 'Regalo' },
    ])
  })
  it('control — sin artículos devueltos el cargador no lee renglones', async () => {
    const findManyItems = jest.fn()
    const tx = {
      payment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'r1',
          venueId: 'v1',
          orderId: 'o1',
          type: 'REFUND',
          status: 'COMPLETED',
          amount: -58,
          tipAmount: 0,
          method: 'CREDIT_CARD',
          tenderSatFormaPago: null,
          processorData: null,
        }),
      },
      order: { findUnique: jest.fn().mockResolvedValue({ venue: { slug: 'demo' } }) },
      orderItem: { findMany: findManyItems },
      cfdi: {
        findFirst: jest.fn(async ({ where }: any) => (where.replacesCfdiId !== undefined ? null : { ...makeOriginal(), isGlobal: false })),
        findMany: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { totalCents: 0 } }),
        count: jest.fn().mockResolvedValue(0),
      },
    } as any
    const loaded = await loadRefundForCreditNoteFromDb('v1', 'r1', tx)
    expect(findManyItems).not.toHaveBeenCalled()
    expect(loaded!.refund.noFacturados ?? []).toEqual([])
  })
})

describe('C2 · T9 ronda 1 · M-1: la huella ata el redondeo y la factura original', () => {
  /** Una factura de $0.04 al 16 % sin montos; la devolución por artículos de $0.02. */
  const chica = (acreditado?: LoadedRefundForCreditNote['acreditado'], uuid = 'UUID-INGRESO-1') => {
    const e = { ...entradaDe([incluido(4, 'Tasa', 0.16)], () => 'pan'), montosPorRenglon: undefined }
    const l = porArticulo(makeOriginal({ entrada: e, uuid }), 'pan', 2, acreditado)
    return l
  }
  it('🔴 otra nota de $0.02 entre la vista y el POST cambia el REDONDEO (no el reparto) ⇒ otra huella', () => {
    const a = alternativaPorImporte(chica())
    expect(a).not.toBeNull()
    expect(a!.entradaParcial.redondeo).toEqual([])
    const previa = notaPorTratamiento({ ...chica(), modalidadElegida: 'POR_IMPORTE' }) as any
    const b = alternativaPorImporte(chica(despuesDe(previa)))
    expect(b).not.toBeNull()
    expect(b!.entradaParcial.brutoPorTratamiento).toEqual(a!.entradaParcial.brutoPorTratamiento)
    expect(b!.entradaParcial.redondeo).not.toEqual([])
    expect(b!.huella).not.toBe(a!.huella)
  })
  it('🔴 el mismo reparto contra OTRA factura original ⇒ otra huella', () => {
    const a = alternativaPorImporte(chica())
    const b = alternativaPorImporte(chica(undefined, 'UUID-SUSTITUTA'))
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(b!.entradaParcial).toEqual(a!.entradaParcial)
    expect(b!.huella).not.toBe(a!.huella)
  })
})

describe('C2 · T9 ronda 1 · M-2: elegir «por importe» con un EXCESO o con centavos de redondeo se rechaza y no reserva', () => {
  const tx = {
    $queryRaw: jest.fn(async () => [{ venueId: 'v1', organizationId: 'org-1' }]),
    $executeRaw: jest.fn(async () => 0),
    cfdi: { findUnique: jest.fn(async () => null) },
  }
  const deps = (cargar: () => LoadedRefundForCreditNote) =>
    ({
      findExistingCfdi: async () => null,
      loadRefundForCreditNote: jest.fn(async () => cargar()),
      resolveProvider: () => ({ name: 'doble', createCreditNote: jest.fn() }),
      runInTransaction: async (fn: any) => fn(tx),
      reserveCfdi: jest.fn(async () => {
        throw new Error('no debía reservar')
      }),
    }) as any
  it.each([
    ['ARTICULO_EXCEDE_LO_FACTURADO', () => porArticulo(originalMixta(), 'pan', 5900)],
    ['CENTAVOS_DE_REDONDEO', () => porArticulo(originalMixta(), 'pan', 5801)],
  ])('control — %s: la elección se rechaza (MODALIDAD_NO_PERMITIDA) y no reserva', async (motivo, cargar) => {
    expect(checkCreditNoteEligibility(cargar()).reason).toBe(motivo)
    const d = deps(cargar)
    await expect(
      emitRefundCreditNote(
        { venueId: 'v1', refundPaymentId: 'pay-refund-1', sandbox: true, modalidad: 'POR_IMPORTE', huellaDelReparto: 'f'.repeat(64) },
        d,
      ),
    ).rejects.toThrow(/sólo se puede elegir cuando no hay forma de comprobar/)
    expect(d.reserveCfdi).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C2 · Tarea 10, ronda 1 (M9): la emisión NORMAL también ata lo que se vio. La vista previa (GET) trae `preview.huella`; el POST la manda y,
// bajo los candados, si lo que se va a timbrar ya no es eso, 409 sin timbrar. Sin huella (clientes viejos), como siempre.
// ─────────────────────────────────────────────────────────────────────────────
describe('C2 · T10 ronda 1 (M9) — la emisión normal compara la huella de la vista previa bajo los candados', () => {
  const conEvidencia = (cents = 5800, acreditado?: LoadedRefundForCreditNote['acreditado']) =>
    porArticulo(originalMixta(), 'pan', cents, acreditado)
  const tx = {
    $queryRaw: jest.fn(async () => [{ venueId: 'v1', organizationId: 'org-1' }]),
    $executeRaw: jest.fn(async () => 0),
    cfdi: { findUnique: jest.fn(async () => null) },
  }
  const PARADA = new Error('PARADA: aquí se habría reservado')
  const deps = (fuera: () => LoadedRefundForCreditNote, dentro: () => LoadedRefundForCreditNote) => {
    const reserveCfdi = jest.fn(async () => {
      throw PARADA
    })
    return {
      findExistingCfdi: async () => null,
      loadRefundForCreditNote: jest.fn(async (_v: string, _r: string, t?: unknown) => (t ? dentro() : fuera())),
      resolveProvider: () => ({ name: 'doble', createCreditNote: jest.fn() }),
      runInTransaction: async (fn: any) => fn(tx),
      reserveCfdi,
    } as any
  }
  const emitir = (p: Record<string, unknown>, d: any) =>
    emitRefundCreditNote({ venueId: 'v1', refundPaymentId: 'pay-refund-1', sandbox: true, requestedByStaffId: 'staff-9', ...p }, d)
  const vistaPrevia = async (l: LoadedRefundForCreditNote) => {
    ;(prisma.cfdi.findUnique as jest.Mock).mockResolvedValueOnce(null)
    ;(prisma.merchantFiscalConfig.findMany as jest.Mock).mockResolvedValueOnce([{ facturacionEnabled: true }])
    return (await getRefundCreditNoteStatus('v1', 'pay-refund-1', { loadRefundForCreditNote: async () => l }))!
  }
  // Entre la vista previa y el POST se timbró otra nota de la misma factura (toda al 0 %): cambia lo que queda.
  const conNotaAl0 = () => ({ ...makeLoaded().acreditado, notas: [{ IVA_0: { baseCents: 10000, ivaCents: 0, totalCents: 10000 } }] })

  it('🔴 la vista previa ELEGIBLE trae `preview.huella`: la del reparto que se timbraría (la misma fórmula que «por importe»)', async () => {
    const l = conEvidencia()
    const st = await vistaPrevia(l)
    expect(st.eligibility.eligible).toBe(true)
    const n = notaPorTratamiento(l) as any
    expect((st.preview as any).huella).toBe(
      huellaDelReparto({ refundPaymentId: l.refund.id, originalUuid: l.original!.uuid, ...n.entradaParcial }),
    )
  })
  /** Por importe (sin artículos) sobre la mezclada: lo devuelto se reparte en proporción a lo que QUEDA de cada tasa. */
  const porImporteMixta = (acreditado?: LoadedRefundForCreditNote['acreditado']) => {
    const l = makeLoaded({ original: originalMixta() })
    l.refund.salesRefundCents = 5800
    if (acreditado) l.acreditado = acreditado
    return l
  }
  it('🔴 con la huella de la vista previa y la factura cambiada bajo los candados ⇒ ConflictError «La factura cambió…» y NO reserva', async () => {
    const huella = (await vistaPrevia(porImporteMixta())).preview as any
    expect(huella.huella).toEqual(expect.any(String))
    const d = deps(porImporteMixta, () => porImporteMixta(conNotaAl0()))
    await expect(emitir({ huellaDelReparto: huella.huella }, d)).rejects.toThrow(ConflictError)
    await expect(emitir({ huellaDelReparto: huella.huella }, d)).rejects.toThrow(MOTIVO_NOTA_CAMBIO)
    expect(d.reserveCfdi).not.toHaveBeenCalled()
  })
  it('control — por artículos, otra nota de OTRA tasa no cambia lo que se timbraría: la misma huella sigue valiendo', async () => {
    const huella = huellaDelReparto({
      refundPaymentId: conEvidencia().refund.id,
      originalUuid: conEvidencia().original!.uuid,
      ...(notaPorTratamiento(conEvidencia()) as any).entradaParcial,
    })
    const d = deps(conEvidencia, () => conEvidencia(5800, conNotaAl0()))
    await expect(emitir({ huellaDelReparto: huella }, d)).rejects.toBe(PARADA)
  })
  it('control — la emisión normal con huella vieja NO usa el texto de «por importe» («El reparto cambió…»)', async () => {
    const vista = (await vistaPrevia(porImporteMixta())).preview as any
    const d = deps(porImporteMixta, () => porImporteMixta(conNotaAl0()))
    await expect(emitir({ huellaDelReparto: vista.huella }, d)).rejects.not.toThrow(MOTIVO_REPARTO_CAMBIO)
  })
  it('🔴 una huella que no es la de lo que se va a timbrar (aunque nada cambió) ⇒ 409 y NO reserva', async () => {
    const d = deps(conEvidencia, conEvidencia)
    await expect(emitir({ huellaDelReparto: 'f'.repeat(64) }, d)).rejects.toThrow(MOTIVO_NOTA_CAMBIO)
    expect(d.reserveCfdi).not.toHaveBeenCalled()
  })
  it('control — la huella que dio la vista previa (GET) vale en el POST si nada cambió: reserva', async () => {
    const huella = (await vistaPrevia(conEvidencia())).preview as any
    const d = deps(conEvidencia, conEvidencia)
    await expect(emitir({ huellaDelReparto: huella.huella }, d)).rejects.toBe(PARADA)
    expect(d.reserveCfdi).toHaveBeenCalledTimes(1)
  })
  // M9 (desviación necesaria): el POST lee lo que queda SIN la nota propia del reembolso (`excludeCfdiId`); la vista previa también, para
  // que una reserva propia sin enviar (un proceso que murió entre la reserva y el envío) no haga que la huella nunca coincida.
  it('🔴 la vista previa lee lo que queda SIN la nota propia (como el POST): su huella vale para reintentar una reserva sin enviar', async () => {
    const propia = {
      id: 'n-propia',
      venueId: 'v1',
      type: 'EGRESO',
      status: 'STAMPING',
      protocoloIva: 1,
      enviadoAt: null,
      falloDefinitivo: false,
      cancelStatus: null,
    }
    ;(prisma.cfdi.findUnique as jest.Mock).mockResolvedValueOnce(propia)
    ;(prisma.merchantFiscalConfig.findMany as jest.Mock).mockResolvedValueOnce([{ facturacionEnabled: true }])
    const loadRefundForCreditNote = jest.fn(async () => conEvidencia())
    await getRefundCreditNoteStatus('v1', 'pay-refund-1', { loadRefundForCreditNote })
    expect(loadRefundForCreditNote).toHaveBeenCalledWith('v1', 'pay-refund-1', undefined, 'n-propia')
  })
  it('control — sin huella (cliente viejo) se comporta como siempre: reserva con lo que haya bajo los candados', async () => {
    const d = deps(conEvidencia, () => conEvidencia(5800, conNotaAl0()))
    await expect(emitir({}, d)).rejects.toBe(PARADA)
    expect(d.reserveCfdi).toHaveBeenCalledTimes(1)
  })
})

// ─── OF-1 · T11 H1: el lector v1 (las notas que producción timbre hasta el despliegue son v1) ─────────────────────────────────────────
import { acreditadoContra, creditNoteIdempotencyKey } from '@/services/fiscal/cfdiCreditNote.service'

// El lector no cambia: estas pruebas pasan desde el inicio (por eso «control —»). Sus dientes se midieron rompiendo el lector en un clon.
describe('OF-1 · T11 H1 · `leerEgreso` lee una nota v1 (de antes de C2) y manda a soporte una corrupta', () => {
  /** Una nota v1 como la capturaba el código de antes de C2: un concepto `01010101`/ACT, IVA incluido, al 16 % o no objeto (sin IVA). */
  const notaV1 = (sinIva = false, id = 'n-v1') => {
    const totalCents = 11600
    const montos = sinIva ? { subtotalCents: totalCents, taxCents: 0, totalCents } : { subtotalCents: 10000, taxCents: 1600, totalCents } // splitIvaIncluded(11600, 0.16)
    const receptor = {
      rfc: 'MTE123456AB1',
      razonSocial: 'MAVERICKS TELECOM',
      regimenFiscal: '601',
      codigoPostal: '76000',
      usoCfdi: 'G02',
      email: 'finanzas@cliente.mx',
    }
    const entrada = {
      version: 1,
      tipo: 'EGRESO',
      orderId: 'o1',
      refundPaymentId: 'pay-refund-1',
      originalCfdiId: 'orig-1',
      originalUuid: 'UUID-ORIGINAL',
      fiscalEmisorId: 'e1',
      ...(sinIva ? { originalSinIvaHistorico: true } : {}),
      montos,
      params: {
        relationship: '01',
        relatedUuids: ['UUID-ORIGINAL'],
        receptor,
        formaPago: '04',
        metodoPago: 'PUE',
        items: [
          {
            description: 'Devolución sobre factura A-36',
            quantity: 1,
            unitPriceCents: totalCents,
            discountCents: 0,
            taxIncluded: true,
            satProductKey: '01010101',
            satUnitKey: 'ACT',
            objetoImp: sinIva ? '01' : '02',
            taxes: sinIva ? [] : [{ type: 'IVA', rate: 0.16, factor: 'Tasa', withholding: false }],
          },
        ],
      },
    }
    return {
      id,
      type: 'EGRESO',
      protocoloIva: 1,
      orderId: 'o1',
      fiscalEmisorId: 'e1',
      idempotencyKey: creditNoteIdempotencyKey('pay-refund-1'),
      ...montos,
      receptorRfc: receptor.rfc,
      receptorNombre: receptor.razonSocial,
      receptorRegimen: receptor.regimenFiscal,
      receptorCp: receptor.codigoPostal,
      formaPago: '04',
      metodoPago: 'PUE',
      entrada: entrada as any,
      entradaHuella: huellaDeEntrada(entrada),
    }
  }

  it.each([
    ['al 16 %', false],
    ['sin IVA histórico (`originalSinIvaHistorico`, no objeto)', true],
  ])('control — una v1 válida %s ⇒ versión 1, con su original', (_caso, sinIva) => {
    const e = leerEgreso(notaV1(sinIva))
    expect(e).toMatchObject({ version: 1, tipo: 'EGRESO', originalCfdiId: 'orig-1', originalUuid: 'UUID-ORIGINAL' })
    expect((e as { originalSinIvaHistorico?: true }).originalSinIvaHistorico).toBe(sinIva ? true : undefined)
  })

  it.each([
    ['otra versión del concepto (no 01010101)', (f: any) => (f.entrada.params.items[0].satProductKey = '84111506')],
    ['montos que no son los de la fila', (f: any) => (f.entrada.montos.totalCents = 11601)],
    ['IVA que no sale del 16 % incluido', (f: any) => ((f.entrada.montos.taxCents = 1601), (f.entrada.montos.subtotalCents = 9999))],
    ['sin IVA histórico con un impuesto', (f: any) => (f.entrada.originalSinIvaHistorico = 'sí')],
    ['relación con otra factura', (f: any) => (f.entrada.params.relatedUuids = ['OTRA'])],
    ['de otro reembolso (llave distinta)', (f: any) => (f.entrada.refundPaymentId = 'pay-refund-2')],
  ])('control — una v1 corrupta (%s, con la huella recalculada) ⇒ revisión de soporte', (_n, cambia) => {
    const fila = notaV1()
    cambia(fila)
    fila.entradaHuella = huellaDeEntrada(fila.entrada)
    expect(() => leerEgreso(fila)).toThrow(ConflictError)
    expect(() => leerEgreso(fila)).toThrow(/soporte/)
  })

  it('control — una v1 cuya huella no es la de su entrada ⇒ revisión de soporte', () => {
    const fila = notaV1()
    fila.entrada.montos = { ...fila.entrada.montos }
    fila.entradaHuella = 'otra'
    expect(() => leerEgreso(fila)).toThrow(/soporte/)
  })

  it('control — en lo acreditado: la v1 al 16 % cuenta en su tasa, la sin IVA como no objeto, y la corrupta como «desconocido»', async () => {
    const corrupta = notaV1(false, 'n-mala')
    corrupta.entrada.params.items[0].satUnitKey = 'H87'
    corrupta.entradaHuella = huellaDeEntrada(corrupta.entrada)
    const tx = {
      cfdi: {
        aggregate: jest.fn(async () => ({ _sum: { totalCents: null } })),
        findMany: jest.fn(async () => [notaV1(false, 'n-16'), notaV1(true, 'n-sin-iva'), corrupta]),
      },
    }
    const r = await acreditadoContra(tx as any, { venueId: 'v1', orderId: 'o1', originalCfdiId: 'orig-1' })
    expect(r.notas).toEqual([
      { IVA_16: { baseCents: 10000, ivaCents: 1600, totalCents: 11600 } },
      { NO_OBJETO: { baseCents: 11600, ivaCents: 0, totalCents: 11600 } },
    ])
    expect(r.desconocidoCents).toBe(11600)
    // Lo desconocido también baja el saldo (conservador): las dos legibles + la corrupta.
    expect(r.alreadyCreditedCents).toBe(34800)
  })
})

// C2 · OF-2 (T7 N2 y N3, `task-7-rereview-1.md`).
describe('C2 · OF-2 · T7 N2: el texto de centavos dice QUÉ componente se pasa, y con UNA tasa no culpa a la factura ni se cuenta', () => {
  const tresDe = (cents: number[]) => {
    let acreditado = makeLoaded().acreditado
    const original = originalDe([incluido(10000, 'Tasa', 0.16)])
    let ultima: any
    for (const c of cents) {
      const loaded = makeLoaded({ original })
      loaded.acreditado = acreditado
      loaded.refund.salesRefundCents = c
      ultima = loaded
      const n = notaPorTratamiento(loaded) as any
      if (n.items) acreditado = despuesDe(n, acreditado)
    }
    return ultima as LoadedRefundForCreditNote
  }
  it('🔴 UNA tasa: $100 al 16 % en $33.33 + $33.33 + $33.33 ⇒ la tercera se detiene por su IVA, con el redondeo de las notas anteriores y SIN contarla', async () => {
    const loaded = tresDe([3333, 3333, 3333])
    expect(checkCreditNoteEligibility(loaded)).toEqual({
      eligible: false,
      reason: 'EXCEEDS_REMAINING',
      message:
        'El redondeo de las notas anteriores dejó el IVA que queda por acreditar 1 ¢ por debajo del de esta devolución; no se puede timbrar aquí: hazla con tu contador o escríbenos a soporte.',
    })
    ;(logger.warn as jest.Mock).mockClear()
    await expect(
      emitRefundCreditNote(
        { venueId: 'v1', refundPaymentId: 'pay-refund-1', sandbox: true },
        { findExistingCfdi: async () => null, loadRefundForCreditNote: async () => loaded },
      ),
    ).rejects.toThrow(/redondeo de las notas anteriores/)
    expect(logger.warn).not.toHaveBeenCalledWith('[cfdi-nota] C2_CENTAVOS_DE_REDONDEO', expect.anything())
  })
  it('control — la misma secuencia legítima (33.33 + 33.33 + 33.34) sigue cabiendo', () => {
    const n = notaPorTratamiento(tresDe([3333, 3333, 3334])) as any
    expect(n.items).toBeDefined()
  })
})

describe('C2 · OF-2 · T7 N3: lo desconocido (ilegible) no se resta del IVA de una tasa SIN IVA', () => {
  const conDesconocido = (cents: number) => {
    const loaded = makeLoaded({ original: originalHistorica(...xmlDe([incluido(10000, 'Tasa', 0)]), 10000) })
    loaded.acreditado = {
      ...loaded.acreditado,
      notas: [{ IVA_0: { baseCents: 4000, ivaCents: 0, totalCents: 4000 } }],
      desconocidoCents: 2000,
      alreadyCreditedCents: 6000,
    }
    loaded.refund.salesRefundCents = cents
    return loaded
  }
  it('🔴 histórica al 0 % de $100, una v2 de $40 y $20 ilegibles ⇒ $10 y $1 caben (antes: «excede … IVA $0.00»)', () => {
    expect(checkCreditNoteEligibility(conDesconocido(1000)).eligible).toBe(true)
    expect(checkCreditNoteEligibility(conDesconocido(100)).eligible).toBe(true)
  })
  it('🔴 lo que queda entero ($40) cabe, y lo desconocido SÍ baja el total: $40.01 no', () => {
    expect(checkCreditNoteEligibility(conDesconocido(4000)).eligible).toBe(true)
    expect(checkCreditNoteEligibility(conDesconocido(4001))).toMatchObject({ eligible: false, reason: 'EXCEEDS_REMAINING' })
  })
})

// C2 · OF-2 (M3, `review-final.md`): el aviso «La facturación de este comercio está apagada» mira la configuración del COMERCIO del cobro
// original, no «algún comercio del RFC». Sin comercio (efectivo, transferencia), el criterio de siempre. La nota NUNCA se bloquea (G6).
describe('C2 · OF-2 (M3) — el aviso de facturación apagada es del comercio de la venta', () => {
  const AVISO = 'La facturación de este comercio está apagada; esta nota corrige una factura que ya se emitió.'
  const conCobro = () => {
    const l = makeLoaded()
    l.refund.processorData = { originalPaymentId: 'pay-orig' }
    return l
  }
  const vista = async (l: LoadedRefundForCreditNote, pago: unknown, suConfig: unknown, delRfc: unknown[]) => {
    ;(prisma.cfdi.findUnique as jest.Mock).mockResolvedValueOnce(null)
    ;(prisma.payment.findFirst as jest.Mock).mockReset().mockResolvedValueOnce(pago)
    ;(prisma.merchantFiscalConfig.findUnique as jest.Mock).mockReset().mockResolvedValueOnce(suConfig)
    ;(prisma.merchantFiscalConfig.findMany as jest.Mock).mockReset().mockResolvedValueOnce(delRfc)
    return (await getRefundCreditNoteStatus('v1', 'pay-refund-1', { loadRefundForCreditNote: async () => l }))!
  }
  // El mismo RFC con dos comercios: «Mostrador» apagado y «Web» encendido.
  const delRfc = [{ facturacionEnabled: false }, { facturacionEnabled: true }]

  it('🔴 la venta es de «Mostrador» (apagado) aunque «Web» del mismo RFC esté encendido ⇒ el aviso sale, y la nota sigue elegible (G6)', async () => {
    const st = await vista(
      conCobro(),
      { merchantAccountId: 'm-mostrador', ecommerceMerchantId: null },
      { facturacionEnabled: false },
      delRfc,
    )
    expect(st.preview!.avisoFacturacionApagada).toBe(AVISO)
    expect(st.eligibility.eligible).toBe(true)
    expect(prisma.payment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'pay-orig', venueId: 'v1' } }))
    expect(prisma.merchantFiscalConfig.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { merchantAccountId: 'm-mostrador' } }),
    )
  })
  it('🔴 un comercio en línea (`ecommerceMerchantId`) también se resuelve por SU configuración', async () => {
    const st = await vista(conCobro(), { merchantAccountId: null, ecommerceMerchantId: 'e-web' }, { facturacionEnabled: false }, delRfc)
    expect(st.preview!.avisoFacturacionApagada).toBe(AVISO)
    expect(prisma.merchantFiscalConfig.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ecommerceMerchantId: 'e-web' } }),
    )
  })
  it('control — la venta es de «Web» (encendido) aunque «Mostrador» esté apagado ⇒ sin aviso', async () => {
    const st = await vista(conCobro(), { merchantAccountId: 'm-web', ecommerceMerchantId: null }, { facturacionEnabled: true }, delRfc)
    expect(st.preview).not.toHaveProperty('avisoFacturacionApagada')
  })
  it('control — sin comercio en el cobro (efectivo): el criterio de siempre, por todo el RFC', async () => {
    const encendido = await vista(conCobro(), { merchantAccountId: null, ecommerceMerchantId: null }, null, delRfc)
    expect(encendido.preview).not.toHaveProperty('avisoFacturacionApagada')
    const apagado = await vista(conCobro(), { merchantAccountId: null, ecommerceMerchantId: null }, null, [{ facturacionEnabled: false }])
    expect(apagado.preview!.avisoFacturacionApagada).toBe(AVISO)
  })
})

// C2 · ronda QA (D7): el panel y los diálogos de la nota escribían la original «F12» y la lista «F-12». `etiqueta` (aditivo) trae el formato
// de la lista; `folio` no cambia (lo leen el MCP y clientes ya desplegados).
describe('C2 · ronda QA (D7) — `facturaOriginal.etiqueta` con el formato de la lista', () => {
  it('🔴 la vista previa trae `etiqueta: "F-12"` y conserva `folio: "F12"`', async () => {
    ;(prisma.cfdi.findUnique as jest.Mock).mockResolvedValueOnce(null)
    ;(prisma.merchantFiscalConfig.findMany as jest.Mock).mockResolvedValueOnce([{ facturacionEnabled: true }])
    const vista = await getRefundCreditNoteStatus('v1', 'pay-refund-1', { loadRefundForCreditNote: async () => makeLoaded() })
    expect(vista!.preview!.facturaOriginal).toMatchObject({ folio: 'F12', etiqueta: 'F-12', uuid: 'UUID-INGRESO-1' })
  })
})

// Micro-ronda final (review-QA-rereview, nit c): consultar la NOTA (MCP, `lookupOnly`) sin respuesta del PAC decía «La factura de esta
// venta se está procesando». El «en proceso» de la nota nombra la nota y no invita a emitirla otra vez.
describe('micro-ronda final — el «en proceso» de la nota nombra la NOTA', () => {
  it('🔴 consultar sin una nota enviada ⇒ «La nota de crédito de este reembolso se está procesando…», nunca «La factura de esta venta»', async () => {
    const consulta = emitRefundCreditNote(
      { venueId: 'v1', refundPaymentId: 'pay-refund-1', sandbox: true, lookupOnly: true },
      { findExistingCfdi: async () => null },
    )
    await expect(consulta).rejects.toThrow(/^La nota de crédito de este reembolso se está procesando/)
    await expect(consulta).rejects.not.toThrow(/La factura de esta venta/)
  })
})
