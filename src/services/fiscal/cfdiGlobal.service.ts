// La reserva global congela el periodo completo; sólo su entrada llega al PAC.
import { CsdStatus, Prisma } from '@prisma/client'
import type { GlobalPeriodicity } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, ConflictError } from '../../errors/AppError'
import { uploadFileToStorage } from '../storage.service'
import { resolveFiscalProvider } from './fiscalProvider.factory'
import { formaPagoDeLaGlobal, GlobalInvoiceLine, GlobalLineItemInput, groupOrderIntoGlobalLines } from './cfdiPayloadBuilder'
import { splitIvaIncluded } from './ivaMath'
import {
  esCobroElegible,
  importeConceptoCents,
  motivosDeOrden,
  reconstruirConceptos,
  totalDelDocumentoCents,
  OrdenParaConceptos,
  renglonConTratamiento,
  MOTIVO_MEDIO_CENTAVO_SIN_REGLA,
  MOTIVO_OCHO_SIN_REGLA,
  MOTIVO_TODO_CORTESIA,
  type RenglonParaCfdi,
  consultarIntentoCapturado,
  enviarIntentoCapturado,
  finalizarEmision,
  IssueCfdiDeps,
  PROCESANDO,
} from './cfdi.service'
import {
  closedPeriodFor,
  ClosedPeriod,
  mismoPeriodo,
  motivoDePeriodicidad,
  periodicidadDeCodigo,
  periodoDeGlobalPeriod,
  periodoRecienteQueEmpiezaEn,
  periodosCerradosRecientes,
  satDePeriodicidad,
  MOTIVO_BIMESTRAL_CAPTURA_DESCARTADA,
  MOTIVO_BIMESTRAL_FILA_APARTADA,
  MOTIVO_BIMESTRAL_RECHAZADA_DESCARTADA,
  MOTIVO_PERIODO_VIEJO,
  PERIODOS_A_REVISAR,
  anioPermitido,
  MOTIVO_ANIO_FUERA,
} from './globalPeriod'
import { validateBeforeStamp } from './cfdiValidation'
import { mapFormaPago } from './satCatalog'
import type { CfdiItemInput, GlobalInvoiceParams } from './providers/fiscal-provider.interface'
import { tomarAdmisionCompartida, bloquearOrdenesParaFacturar } from './admisionIva'
import { liberarSellosDe, sellarRenglones } from './sellosIva'
import { CFDI_VIVO, EXTRAIDO, esLlaveComplementaria, llavePrincipalDe } from './exclusionGlobal'
import {
  aplicarAjustes,
  conceptoDeReal,
  conceptosDeOrdenGlobal,
  conceptosValidos,
  cuadrarLaGlobal,
  cuadrarPorTasa,
  filasD16DeOrdenGlobal,
  filasD16DeReales,
  montosDesdeDocumento,
  paramsDeLaGlobal,
  sumarExcluida,
  sumarFilasD16,
  FORMA_DEL_MEZCLADO,
  MOTIVOS_DE_CONFIGURACION,
  MOTIVOS_DE_IVA,
  TEXTO_EXCLUSION_GLOBAL,
  TEXTO_FORMA_DE_PAGO_SIN_CATALOGO,
  TRATAMIENTOS_GLOBAL,
  type ConceptoReal,
  type ExcluidasPorMotivo,
  type FormaDelMezclado,
  type MotivoExclusionGlobal,
  type OrdenGlobalV2,
  type Pertenencia,
  type PorTratamientoGlobal,
  type TratamientoGlobal,
} from './globalPorTratamiento'
import { clasificarOrden, hayBloqueados, resolverTratamiento } from './ivaDeRenglon'
import { leerReparto, MOTIVO_SIN_REPARTO_IVA_MEZCLADO } from '../shared/repartoDescuento'
import type { IvaTratamiento } from './ivaTratamiento'
import { huellaDeEntrada } from './entradaDocumental'
import { DESCUENTOS_PARA_CONCEPTOS } from './descuentoPorRenglon'
import { filasDeDescuentoCompletas } from './filasDeDescuentoTx'
import { conceptosDesdeElPayload, documentoSegunElPac, totalSegunElPacCents, type AjusteAlCobro } from './reglaDelPac'

/** `ERROR` sólo lo produce la pasada del job (`emitirGlobalesPendientes`): un error aislado de UNA fila o UN periodo que no detiene el resto. */
export type IssueGlobalStatus =
  | 'STAMPED'
  | 'NOTHING_TO_INVOICE'
  | 'SKIPPED'
  | 'VALIDATION_FAILED'
  | 'STAMP_FAILED'
  | 'ERROR'
  /** Ronda 1 de la T8 (I1): un `ConflictError` que NO es «en proceso» (revisión de soporte, cancelada en el PAC, periodo fuera de ventana). */
  | 'DETENIDO'
export interface IssueGlobalResult {
  status: IssueGlobalStatus
  cfdi?: any
  reasons?: string[]
  reason?: string
  period?: ClosedPeriod
  candidateCount?: number
  excluidasPorIvaMixto?: number
  /** C1: cuántas ventas del periodo quedaron fuera, por motivo (v1: `{}`). Nuevo y opcional. */
  excluidas?: ExcluidasPorMotivo
  /** C1 (Tarea 11): el id de la global principal cuando el resultado es de su complementaria. Nuevo y opcional. */
  complementariaDe?: string
  /** Ronda 1 de la T11 (m4): la llave ya estaba timbrada; no se emitió nada ahora (no se audita ni se dice «emitida»). */
  yaTimbrada?: boolean
}
export interface GlobalEmisor {
  id: string
  venueId: string
  globalPeriodicity: any
  /** C1 (Tarea 9): el régimen ACTUAL del emisor, el que el PAC pondrá en el documento (la bimestral sólo con `621`). */
  regimenFiscal: string
  serie: string | null
  lugarExpedicion: string
  csdStatus: CsdStatus
  providerKeyEnc: string | null
  provider: any
  invoiceCashSales: boolean
  /** Ajuste del founder (7-oct): ¿la global de este RFC toma las ventas cobradas sólo fuera de la terminal? (apagado de fábrica) */
  includeOffTerminalSalesInGlobal: boolean
}
export interface IssueGlobalDeps {
  loadEmisor: (id: string) => Promise<GlobalEmisor | null>
  findExistingGlobal: (key: string) => Promise<any | null>
  /**
   * Sólo ids; páginas completas y ordenadas, la elegibilidad se relee en la reserva. `self`: la reserva que se retoma (sus propios
   * tickets siguen siendo candidatos, Codex C1-13).
   */
  loadGlobalCandidates: (emisor: GlobalEmisor, period: ClosedPeriod, unSoloEmisor: boolean, self?: string) => Promise<string[]>
  /** C1 (Codex C1-8): cuántos RFC tiene el negocio; se cuenta UNA vez por emisión (`unSoloEmisor`). */
  contarEmisores: (venueId: string) => Promise<number>
  /** C1 (Tarea 10): lo que queda fuera por configuración, contado con la misma regla que los candidatos (fuera de la transacción). */
  contarExcluidasPorConfiguracion: (
    emisor: GlobalEmisor,
    period: ClosedPeriod,
    unSoloEmisor: boolean,
    self?: string,
  ) => Promise<ExcluidasPorMotivo>
  resolveProvider: typeof resolveFiscalProvider
  storeArtifact: IssueCfdiDeps['storeArtifact']
  persistCfdi: IssueCfdiDeps['persistCfdi']
  reserveCfdi: IssueCfdiDeps['reserveCfdi']
  persistArtifacts: IssueCfdiDeps['persistArtifacts']
  runInTransaction: NonNullable<IssueCfdiDeps['runInTransaction']>
  loadVenueSlug: (venueId: string) => Promise<string>
  /** C1 (Tarea 8, C1-15): una página (10) de las globales sin timbrar del emisor, de cualquier periodo, después del cursor `(updatedAt, id)`. */
  loadGlobalesSinTimbrar: (emisorId: string, cursor: CursorDePendientes | null) => Promise<any[]>
  /** C1 (Tarea 8): la global PRINCIPAL de un periodo, por su llave (o null). */
  findGlobalDelPeriodo: (emisorId: string, period: ClosedPeriod) => Promise<any | null>
  /** C1 (Tarea 8): emitir un periodo con su llave; siempre por `issueGlobalForPeriod` (el único camino al motor). */
  emitirPeriodo: typeof issueGlobalForPeriod
  /** Ronda 1 de la T8 (I1): el último aviso de un periodo entre `acciones` (ActivityLog del emisor), o null. */
  ultimoAvisoDelPeriodo: (
    emisor: GlobalEmisor,
    period: ClosedPeriod,
    acciones: string[],
  ) => Promise<{ action: string; motivo: string | null; createdAt?: Date } | null>
  /** Ronda 1 de la T8 (I1): deja un aviso del periodo en `ActivityLog`. */
  registrarAvisoDelPeriodo: (emisor: GlobalEmisor, period: ClosedPeriod, action: string, data: Record<string, unknown>) => Promise<void>
  /** Ronda 1 de la T8 (I1 c): ¿el periodo todavía tiene ventas candidatas? (una sola fila, acotada) */
  tieneCandidatos: (emisor: GlobalEmisor, period: ClosedPeriod, unSoloEmisor: boolean) => Promise<boolean>
  /**
   * Ronda 1 de la T8 (m1): mueve al final de la cola una fila pendiente que su intento no escribió. Ola final (N2-bis): devuelve la marca con la
   * que la movió (su nuevo `updatedAt`), o null si no la movió (el intento la escribió: perdió el CAS); el aviso del periodo se compara con ella.
   */
  tocarPendiente: (fila: any) => Promise<Date | null | void>
  /**
   * C1 (Tarea 10, m1 de la T9): las globales sin timbrar del emisor con OTRA periodicidad que la suya de hoy, la más reciente primero
   * (a lo más `MAX_OTRAS_PERIODICIDADES + 1`, para saber si hay más).
   */
  globalesDeOtraPeriodicidad: (
    emisorId: string,
    satPeriodicidad: string,
    /** Ronda 2 (N5 b): la página siguiente, después de esta fila (`createdAt desc, id desc`). */
    despues?: { createdAt: Date; id: string } | null,
  ) => Promise<any[]>
  /**
   * C1 (Tarea 10, ronda 1, I1): la global de OTRA periodicidad que todavía tiene apartadas ventas de este periodo (viva y sin timbrar, y este
   * periodo queda CONTENIDO entero en el suyo: ronda 2, R1), o null.
   */
  globalApartadaQueCubre: (emisorId: string, period: ClosedPeriod) => Promise<any | null>
  /** C1 (Tarea 11): las complementarias de una principal (por su llave `-c<n>`), la más vieja primero (a lo más `MAX_COMPLEMENTARIAS + 1`). */
  complementariasDe: (principal: { id: string; idempotencyKey: string; fiscalEmisorId: string }) => Promise<ComplementariaExistente[]>
  /** C1 (Tarea 11, C1-27): cuántas ventas del periodo, sin global viva, entrarían HOY (entre las primeras 200 revisadas). */
  contarCorregidasPendientes: (
    emisor: GlobalEmisor,
    period: ClosedPeriod,
    unSoloEmisor: boolean,
    /** Ronda 1 (I4): la complementaria abierta y nunca enviada: sus propias ventas cuentan (su recaptura las tomaría). */
    self?: string,
  ) => Promise<{ n: number; completo: boolean }>
  /**
   * Ola final de C1 («apagado se VE y se EXPLICA»): ¿el RFC tiene AL MENOS un comercio cuyas ventas entran a su global
   * (`configQueEntraALaGlobal`: este RFC + facturación + «Incluir en la global»)? Un `findFirst` por índice (`fiscalEmisorId`).
   */
  comercioEnLaGlobal: (emisorId: string) => Promise<boolean>
}
/** C1 (Tarea 8): dónde se quedó la pasada de pendientes de un emisor (el job lo guarda por emisor). */
export type CursorDePendientes = { updatedAt: Date; id: string }
/** Ola final (N2-bis): una fila de la cola que la pasada movió al final: con qué marca, y el `lastError` que conserva (el intento no la escribió). */
type FilaMovida = { en: Date; lastError: string | null }
/** La entrada de antes de C1 (todo al 16 %, un item por ticket). Se sigue leyendo: filas timbradas y reservas sin enviar de antes del despliegue. */
export interface EntradaGlobalV1 {
  version: 1
  tipo: 'GLOBAL'
  fiscalEmisorId: string
  globalPeriod: { periodicidad: string; meses: string; anio: number }
  montos: { subtotalCents: number; taxCents: number; totalCents: number }
  excluidasPorIvaMixto: number
  ordenes: Array<{ orderId: string; huella: string; renglones: Array<{ orderItemId: string; tratamiento: IvaTratamiento }> }>
  params: GlobalInvoiceParams
}
/**
 * C1 (Codex C1-2): la foto de la global con varias tasas. `cuadre.ok: false` = captura DIAGNÓSTICA (Codex C1-12): se guardó para mostrar
 * el motivo y recapturar; nunca se envía ni se recupera. `ajustes` = los centavos de descuento que puso la 6b para dar lo cobrado,
 * CONGELADOS (el lector los reproduce sin buscar). `complementariaDe` = id de la global principal del periodo (Tarea 11).
 */
export interface EntradaGlobalV2 {
  version: 2
  tipo: 'GLOBAL'
  fiscalEmisorId: string
  globalPeriod: { periodicidad: string; meses: string; anio: number }
  /** El periodo exacto (ISO), para que la identidad del periodo se demuestre y no se infiera (Codex C1-14). */
  periodo: { desde: string; hasta: string }
  montos: { subtotalCents: number; taxCents: number; totalCents: number }
  excluidas: ExcluidasPorMotivo
  excluidasPorIvaMixto: number
  ordenes: OrdenGlobalV2[]
  formaDelMezclado: FormaDelMezclado
  cuadre: { ok: true } | { ok: false; motivo: string }
  ajustes: AjusteAlCobro[]
  params: GlobalInvoiceParams
  complementariaDe?: string
  /**
   * Ola final (m5 de la revisión de la T12): cuándo se capturó (ISO, reloj de la app). Sólo informativo (`ultimaCaptura.al` del listado); el lector
   * no lo valida y entra en la huella como el resto. Opcional: una entrada v2 de antes de esta ola no lo trae (ninguna en producción).
   */
  capturadaAl?: string
}
export type EntradaGlobal = EntradaGlobalV1 | EntradaGlobalV2
/** `PARA_ENVIAR`: el envío, la recuperación y el saldo (C2/C3). `DIAGNOSTICO`: una fila `VALIDATION_FAILED` que se muestra o se recaptura. */
export type ModoDeLectura = 'PARA_ENVIAR' | 'DIAGNOSTICO'
/** C1-23: la captura sin tickets (diagnóstica, nunca `ok`). */
export const MOTIVO_SIN_TICKETS = 'No hay tickets por facturar en el periodo.'
const PAGE = 100
/**
 * C1 (Tarea 10, N1 de la re-revisión de la T8): lo que se guarda y se devuelve cuando un periodo truena con un error que NO es `ConflictError`
 * (p. ej. de la base). El detalle crudo sólo va al `logger.error`; el panel y el resumen del job nunca muestran un texto de Prisma.
 */
export const MOTIVO_ERROR_DEL_PERIODO =
  'No pudimos emitir la factura global de este periodo; lo reintentaremos. Si sigue, escríbenos a soporte.'
/** C1 (Tarea 10, ronda 1, m4): el mismo error cuando no hay periodo (al leer la página de pendientes del emisor o una fila vieja). */
export const MOTIVO_ERROR_DE_LA_PASADA =
  'No pudimos revisar las facturas globales pendientes de este RFC; lo reintentaremos. Si sigue, escríbenos a soporte.'
/**
 * C1 (Tarea 10, ronda 1, I1): un periodo cuyas fechas siguen apartadas en una global de OTRA periodicidad (de cuando el RFC tenía otra) no se
 * emite: saldría un segundo documento por las mismas fechas mientras aquél sigue pendiente.
 */
export const MOTIVO_PERIODO_CUBIERTO =
  'Estas fechas siguen apartadas en otra factura global sin timbrar, de cuando el RFC tenía otra periodicidad (la ves en «Otras periodicidades»). Ésta no se emite mientras aquélla siga pendiente; si no se resuelve sola, escríbenos a soporte.'
/**
 * Ola final (T1 de la re-revisión 2 de la T10): con la contención, quien espera es la CONTENIDA, y la que la contiene puede ser la de la
 * periodicidad de HOY (MENSUAL→BIMESTRAL: julio espera a jul-ago; DIARIO→MENSUAL: el 1-sep espera a septiembre). Ahí el texto de arriba
 * mentía en sus dos afirmaciones (no es «de cuando tenía otra» ni está en «Otras periodicidades»).
 */
export const MOTIVO_PERIODO_CUBIERTO_POR_LA_ACTUAL =
  'Estas fechas también están en la factura global de tu periodicidad actual, que todavía no se timbra. Ésta no se emite mientras aquélla siga pendiente; si no se resuelve sola, escríbenos a soporte.'
/**
 * El texto de «periodo cubierto» según QUIÉN lo cubre (`globalApartadaQueCubre` devuelve la fila con su `globalPeriod`): de la periodicidad de
 * hoy del emisor ⇒ `MOTIVO_PERIODO_CUBIERTO_POR_LA_ACTUAL`; si no (o sin dato), `MOTIVO_PERIODO_CUBIERTO`.
 */
export function motivoDePeriodoCubierto(emisor: Pick<GlobalEmisor, 'globalPeriodicity'>, cubridora: unknown): string {
  const gp = esObjeto(cubridora) && esObjeto(cubridora.globalPeriod) ? cubridora.globalPeriod : null
  const deHoy = !!gp && gp.periodicidad === satDePeriodicidad(emisor.globalPeriodicity)
  return deHoy ? MOTIVO_PERIODO_CUBIERTO_POR_LA_ACTUAL : MOTIVO_PERIODO_CUBIERTO
}
/** C1 (Tarea 10, ronda 1, I1): cuántas globales de otra periodicidad trae el panel (más ⇒ `completo: false`). */
export const MAX_OTRAS_PERIODICIDADES = 10
/** Ronda 2 (N5 b): cuántas páginas de `MAX_OTRAS_PERIODICIDADES + 1` lee el panel, a lo más, si se salta filas sin periodo demostrable. */
const PAGINAS_DE_OTRAS = 3
/** «Otra solicitud lo tiene en proceso» (el texto del motor individual, el mismo objeto). Es lo ÚNICO que la pasada del job trata como `SKIPPED`. */
export const MOTIVO_EN_PROCESO = PROCESANDO

/**
 * C1: lee la entrada de una global (v1 o v2) y la valida entera; si algo no corresponde, «revisión de soporte». `modo` (Codex C1-12):
 * `PARA_ENVIAR` exige una captura autorizada; `DIAGNOSTICO` acepta además la diagnóstica.
 */
export function leerGlobal(cfdi: any, modo: ModoDeLectura = 'PARA_ENVIAR'): EntradaGlobal {
  // Ronda 1 de la T11 (I2): la llave decide si la entrada debe traer `complementariaDe`. Una fila leída sin ella (un SELECT que no la trae) es un
  // error de PROGRAMACIÓN, no una entrada inválida: falla de inmediato y con su nombre, también con una principal (así ninguna prueba lo esconde).
  if (typeof cfdi?.idempotencyKey !== 'string')
    throw new Error('leerGlobal necesita la fila con su idempotencyKey: agrégala al select de la factura global.')
  // T11 (C1-P7), en los dos modos: una entrada trae `complementariaDe` ⇔ su llave es la de una complementaria (`-c<n>`). Una principal con
  // `complementariaDe`, o una `-c<n>` sin él, no se lee (se enviaría como lo que no es).
  const traeComplementaria = esObjeto(cfdi?.entrada) && cfdi.entrada.complementariaDe !== undefined
  if (traeComplementaria !== esLlaveComplementaria(cfdi?.idempotencyKey)) throw new ConflictError(MOTIVO_COMPLEMENTARIA_INVALIDA)
  return cfdi?.entrada?.version === 2 ? leerGlobalV2(cfdi, modo) : leerGlobalV1(cfdi)
}

const REVISION_DE_SOPORTE = 'La entrada fiscal de esta factura requiere revisión de soporte.'
const esCentavos = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const esObjeto = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v)
const esTratamientoGlobal = (t: unknown): t is TratamientoGlobal => TRATAMIENTOS_GLOBAL.includes(t as TratamientoGlobal)
/** Lo cobrado de cada tratamiento de la global: la suma de lo de sus tickets (Codex C1-35: cada tasa se cuadra contra lo suyo). */
function cobradoPorTasaDe(ordenes: Array<Pick<OrdenGlobalV2, 'porTratamiento'>>): PorTratamientoGlobal {
  const m: PorTratamientoGlobal = {}
  for (const o of ordenes)
    for (const [t, c] of Object.entries(o.porTratamiento) as Array<[TratamientoGlobal, number]>) m[t] = (m[t] ?? 0) + c
  return m
}
/** La huella de la foto de UN ticket: lo que se congela de él (Codex C1-43: también sus filas D16; C1-34: sus reales, su folio y su forma). */
const huellaDeLaOrden = (o: Omit<OrdenGlobalV2, 'huella'>) =>
  huellaDeEntrada({
    renglones: o.renglones,
    porTratamiento: o.porTratamiento,
    lineas: o.lineas ?? null,
    conceptosReales: o.conceptosReales,
    folio: o.folio,
    formaPago: o.formaPago,
    filasD16: o.filasD16,
  })

/**
 * C1 (Codex C1-2, C1-12, C1-34, C1-40, C1-43): una entrada v2 sólo se acepta si TODO corresponde: la fila, el periodo exacto, cada ticket
 * con su huella y su dinero, sus reales (que cuadran por la misma puerta que la individual) y, con `cuadre.ok`, los conceptos que se mandan =
 * los de sus tickets con los ajustes congelados reproducidos (`aplicarAjustes`: barrera N3 y confinamiento por tasa, sin buscar). La
 * diagnóstica (`cuadre.ok: false`) sólo en `DIAGNOSTICO`: con sus conceptos ORIGINALES, sin ajustes y con su motivo. Nunca lanza otra cosa
 * que «revisión de soporte»: un JSON mal formado no puede tumbar al lector con un `TypeError`.
 */
function leerGlobalV2(cfdi: any, modo: ModoDeLectura): EntradaGlobalV2 {
  let valida = false
  try {
    valida = entradaV2Valida(cfdi, cfdi.entrada, modo)
  } catch {
    valida = false
  }
  if (!valida) throw new ConflictError(REVISION_DE_SOPORTE)
  return cfdi.entrada as EntradaGlobalV2
}

function realValido(r: unknown): boolean {
  return (
    esObjeto(r) &&
    (r.orderItemId === null || typeof r.orderItemId === 'string') &&
    (r.productId === null || typeof r.productId === 'string') &&
    typeof r.descripcion === 'string' &&
    typeof r.precio === 'string' &&
    /^\d+(\.\d{1,6})?$/.test(r.precio) &&
    typeof r.cantidad === 'number' &&
    Number.isFinite(r.cantidad) &&
    r.cantidad > 0 &&
    esCentavos(r.descuentoCents) &&
    typeof r.ivaIncluido === 'boolean' &&
    esTratamientoGlobal(r.tratamiento)
  )
}

/** Un ticket de la v2: identidad, dinero (lo de cada tratamiento suma lo cobrado), sus líneas, sus filas D16, sus reales (h) y su huella (b). */
function ordenV2Valida(o: unknown, ids: Set<string>, itemIds: Set<string>): boolean {
  if (!esObjeto(o) || typeof o.orderId !== 'string' || !o.orderId || ids.has(o.orderId)) return false
  ids.add(o.orderId)
  if (typeof o.huella !== 'string' || !/^[a-f0-9]{64}$/.test(o.huella)) return false
  if (typeof o.folio !== 'string' || !o.folio.trim()) return false
  // Un ticket «por definir» nunca entra (Tarea 6): su forma es una clave SAT de dos dígitos distinta de 99.
  if (typeof o.formaPago !== 'string' || !/^\d{2}$/.test(o.formaPago) || o.formaPago === '99') return false
  if (!Number.isSafeInteger(o.paidCents) || o.paidCents <= 0) return false
  if (
    !Array.isArray(o.renglones) ||
    !o.renglones.every((r: unknown) => {
      if (!esObjeto(r) || typeof r.orderItemId !== 'string' || itemIds.has(r.orderItemId) || !esTratamientoGlobal(r.tratamiento))
        return false
      itemIds.add(r.orderItemId)
      return true
    })
  )
    return false
  if (!esObjeto(o.porTratamiento)) return false
  const partes = Object.entries(o.porTratamiento)
  if (!partes.length || !partes.every(([t, c]) => esTratamientoGlobal(t) && esCentavos(c))) return false
  if (partes.reduce((s, [, c]) => s + (c as number), 0) !== o.paidCents) return false
  if (o.lineas !== undefined) {
    // Las líneas de hoy del ticket todo al 16 %: suyas, con su folio (el `sku` que viaja) y sumando lo cobrado.
    if (!Array.isArray(o.lineas) || !o.lineas.length) return false
    const suyas = o.lineas.every(
      (l: unknown) => esObjeto(l) && l.orderId === o.orderId && (l.orderNumber ?? l.orderId) === o.folio && esCentavos(l.totalCents),
    )
    if (!suyas || o.lineas.reduce((s: number, l: any) => s + l.totalCents, 0) !== o.paidCents) return false
  }
  if (!Array.isArray(o.filasD16) || !o.filasD16.every((f: unknown) => Array.isArray(f) && f.every(x => typeof x === 'string'))) return false
  if (o.conceptosReales !== null) {
    if (!Array.isArray(o.conceptosReales) || !o.conceptosReales.length || !o.conceptosReales.every(realValido)) return false
    // (h) v6 (Codex C1-34): los reales son ORIGEN comercial, con su descuento original; el ajuste se RECALCULA por la misma puerta (barrera
    // N3 y cada tasa sola), con las filas D16 congeladas del ticket (C1-43). Nunca se exige que los originales ya den lo cobrado.
    const reales = o.conceptosReales as ConceptoReal[]
    const c = cuadrarPorTasa(reales.map(conceptoDeReal), o.paidCents, {
      cobradoPorTasa: o.porTratamiento,
      filasD16: filasD16DeReales(o.filasD16, reales),
    })
    if (!c.ok) return false
  }
  return o.huella === huellaDeLaOrden(o as OrdenGlobalV2)
}

function entradaV2Valida(cfdi: any, e: unknown, modo: ModoDeLectura): boolean {
  if (!esObjeto(e) || e.version !== 2 || e.tipo !== 'GLOBAL' || e.fiscalEmisorId !== cfdi.fiscalEmisorId) return false
  if (huellaDeEntrada(e) !== cfdi.entradaHuella) return false
  // Los montos son los de la fila (y cuadran entre sí).
  const m = e.montos
  if (!esObjeto(m) || !esCentavos(m.subtotalCents) || !esCentavos(m.taxCents) || !esCentavos(m.totalCents)) return false
  if (m.subtotalCents + m.taxCents !== m.totalCents) return false
  if (m.subtotalCents !== cfdi.subtotalCents || m.taxCents !== cfdi.taxCents || m.totalCents !== cfdi.totalCents) return false
  // (a) El periodo exacto: un periodo CERRADO de su periodicidad, con el mismo mes y año que su `globalPeriod` (el de la fila).
  const gp = e.globalPeriod
  if (!esObjeto(gp) || huellaDeEntrada(gp) !== huellaDeEntrada(cfdi.globalPeriod)) return false
  const periodicidad = periodicidadDeCodigo(gp.periodicidad)
  if (!periodicidad || !esObjeto(e.periodo) || typeof e.periodo.desde !== 'string' || typeof e.periodo.hasta !== 'string') return false
  const q = closedPeriodFor(periodicidad, new Date(e.periodo.hasta))
  if (q.periodStart.toISOString() !== e.periodo.desde || q.periodEnd.toISOString() !== e.periodo.hasta) return false
  if (q.meses !== gp.meses || q.anio !== gp.anio) return false
  // Receptor, uso y periodo del documento (lo de v1), sin identidad (la pone cada envío).
  const p = e.params
  if (!esObjeto(p) || !Array.isArray(p.items) || p.externalId !== undefined || p.idempotencyKey !== undefined) return false
  const r = p.receptor
  if (!esObjeto(r) || r.tax_id !== 'XAXX010101000' || r.tax_system !== '616' || r.legal_name !== 'PÚBLICO EN GENERAL') return false
  if (typeof r.address?.zip !== 'string' || p.use !== 'S01' || typeof p.payment_form !== 'string') return false
  if (!esObjeto(p.global) || p.global.periodicity !== q.facturaPeriodicity || p.global.months !== gp.meses || p.global.year !== gp.anio)
    return false
  // Las excluidas por motivo (lista cerrada) y el campo viejo, que es su suma de motivos de IVA.
  const ex = e.excluidas
  // Ronda 1 (M5): sólo llaves PROPIAS de la lista cerrada (`in` aceptaría `toString` o `constructor`, heredadas de `Object`). `Object.hasOwn`
  // no está en los tipos del target es2020: es lo mismo.
  const esMotivo = (k: string) => Object.prototype.hasOwnProperty.call(TEXTO_EXCLUSION_GLOBAL, k)
  if (!esObjeto(ex) || !Object.entries(ex).every(([k, n]) => esMotivo(k) && esCentavos(n))) return false
  if (e.excluidasPorIvaMixto !== MOTIVOS_DE_IVA.reduce((s, k) => s + (ex[k] ?? 0), 0)) return false
  if (e.formaDelMezclado !== 'UN_CONCEPTO' && e.formaDelMezclado !== 'POR_TRATAMIENTO') return false
  if (e.complementariaDe !== undefined && (typeof e.complementariaDe !== 'string' || !e.complementariaDe)) return false
  const cuadre = e.cuadre
  if (!esObjeto(cuadre) || (cuadre.ok !== true && cuadre.ok !== false)) return false
  const ajustes = e.ajustes
  if (!Array.isArray(ajustes) || !ajustes.every(a => esObjeto(a) && esCentavos(a.indice) && esCentavos(a.deCents) && esCentavos(a.aCents)))
    return false
  // Cada ticket, una vez (ids y renglones únicos).
  const ids = new Set<string>()
  const itemIds = new Set<string>()
  if (!Array.isArray(e.ordenes) || !e.ordenes.every(o => ordenV2Valida(o, ids, itemIds))) return false
  const ordenes = e.ordenes as OrdenGlobalV2[]
  const items = p.items as CfdiItemInput[]
  // (g2) C1-23: la captura SIN tickets es diagnóstica (nunca `ok`), sin conceptos, en ceros; se lee sólo para mostrar su motivo y recapturar.
  if (!ordenes.length)
    return (
      modo === 'DIAGNOSTICO' &&
      cuadre.ok === false &&
      cuadre.motivo === MOTIVO_SIN_TICKETS &&
      !items.length &&
      !ajustes.length &&
      m.totalCents === 0 &&
      m.subtotalCents === 0
    )
  const originales = ordenes.flatMap(o => conceptosDeOrdenGlobal(o, e.formaDelMezclado))
  const cobradoCents = ordenes.reduce((s, o) => s + o.paidCents, 0)
  if (cuadre.ok) {
    // (c) v6/v7: los conceptos que se mandan son los de sus tickets con los ajustes congelados, reproducidos SIN buscar detrás de la misma
    // barrera N3 (cota por tasa con las filas D16 congeladas) y confinados por tasa (Codex C1-36, C1-39, C1-43).
    const esperados = aplicarAjustes(originales, ajustes as AjusteAlCobro[], cobradoCents, {
      cobradoPorTasa: cobradoPorTasaDe(ordenes),
      filasD16: sumarFilasD16(ordenes.map(filasD16DeOrdenGlobal)),
    })
    if (!esperados || huellaDeEntrada(esperados) !== huellaDeEntrada(items)) return false
    if (m.totalCents !== cobradoCents) return false // (f) la autorizada da exactamente lo cobrado
    if (!conceptosValidos(items)) return false // (d) cada concepto, válido ante el SAT (el mezclado con su regla: bases, cantidad 1…)
  } else {
    // (c2)/(f) v7 (Codex C1-40): la diagnóstica no se reproduce contra lo cobrado (es justo la igualdad que no se alcanzó): se exige lo que
    // guardó la captura. Nunca se envía ni se recupera.
    if (modo !== 'DIAGNOSTICO' || ajustes.length || typeof cuadre.motivo !== 'string' || !cuadre.motivo.trim()) return false
    if (huellaDeEntrada(originales) !== huellaDeEntrada(items)) return false
  }
  // (e) Los montos son el documento de sus conceptos según el PAC (la 6b), no una suma propia.
  const doc = montosDesdeDocumento(documentoSegunElPac(items.flatMap(conceptosDesdeElPayload)))
  if (doc.subtotalCents !== m.subtotalCents || doc.taxCents !== m.taxCents || doc.totalCents !== m.totalCents) return false
  // (g) La forma de la global es la que suma más entre sus tickets (H4, ronda 1 de la T6), nunca «por definir».
  return p.payment_form === formaPagoDeLaGlobal(ordenes) && p.payment_form !== '99'
}

/** Hash más forma/identidad/dinero: JSON válido no implica una entrada fiscal válida. */
function leerGlobalV1(cfdi: any): EntradaGlobalV1 {
  const e = cfdi.entrada as EntradaGlobalV1 | null
  const cents = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
  const ids = new Set<string>()
  const itemIds = new Set<string>()
  if (
    !e ||
    e.version !== 1 ||
    e.tipo !== 'GLOBAL' ||
    e.fiscalEmisorId !== cfdi.fiscalEmisorId ||
    !e.montos ||
    !Object.values(e.montos).every(cents) ||
    !cents(e.excluidasPorIvaMixto) ||
    e.montos.subtotalCents + e.montos.taxCents !== e.montos.totalCents ||
    e.montos.subtotalCents !== cfdi.subtotalCents ||
    e.montos.taxCents !== cfdi.taxCents ||
    e.montos.totalCents !== cfdi.totalCents ||
    !e.globalPeriod ||
    huellaDeEntrada(e.globalPeriod) !== huellaDeEntrada(cfdi.globalPeriod) ||
    !Array.isArray(e.ordenes) ||
    !e.ordenes.every(o => {
      if (!o || typeof o.orderId !== 'string' || ids.has(o.orderId) || !/^[a-f0-9]{64}$/.test(o.huella) || !Array.isArray(o.renglones))
        return false
      ids.add(o.orderId)
      return o.renglones.every(r => {
        if (!r || typeof r.orderItemId !== 'string' || itemIds.has(r.orderItemId) || r.tratamiento !== 'IVA_16') return false
        itemIds.add(r.orderItemId)
        return true
      })
    }) ||
    !e.params ||
    !Array.isArray(e.params.items) ||
    e.params.items.length !== e.ordenes.length ||
    e.params.externalId !== undefined ||
    e.params.idempotencyKey !== undefined ||
    e.params.receptor?.tax_id !== 'XAXX010101000' ||
    e.params.receptor?.tax_system !== '616' ||
    e.params.use !== 'S01' ||
    e.params.receptor.legal_name !== 'PÚBLICO EN GENERAL' ||
    typeof e.params.receptor.address?.zip !== 'string' ||
    !e.params.global ||
    e.params.global.months !== e.globalPeriod.meses ||
    e.params.global.year !== e.globalPeriod.anio ||
    !['day', 'week', 'fortnight', 'month', 'two_months'].includes(e.params.global.periodicity) ||
    typeof e.params.payment_form !== 'string' ||
    !e.params.items.every(
      i =>
        i &&
        typeof i === 'object' &&
        i.quantity === 1 &&
        typeof i.taxIncluded === 'boolean' &&
        i.satProductKey === '01010101' &&
        i.satUnitKey === 'ACT' &&
        i.description === 'Venta' &&
        cents(i.unitPriceCents) &&
        i.discountCents === 0 &&
        i.objetoImp === '02' &&
        Array.isArray(i.taxes) &&
        i.taxes.length === 1 &&
        i.taxes[0]?.type === 'IVA' &&
        i.taxes[0].rate === 0.16 &&
        i.taxes[0].factor === 'Tasa' &&
        i.taxes[0].withholding === false,
    ) ||
    huellaDeEntrada(e) !== cfdi.entradaHuella
  )
    throw new ConflictError('La entrada fiscal de esta factura requiere revisión de soporte.')
  const totals = e.params.items.reduce(
    (sum, i) => {
      const part = i.taxIncluded
        ? splitIvaIncluded(i.unitPriceCents, 0.16)
        : { netCents: i.unitPriceCents, taxCents: Math.round(i.unitPriceCents * 0.16) }
      return { netCents: sum.netCents + part.netCents, taxCents: sum.taxCents + part.taxCents }
    },
    { netCents: 0, taxCents: 0 },
  )
  if (totals.netCents !== e.montos.subtotalCents || totals.taxCents !== e.montos.taxCents)
    throw new ConflictError('La entrada fiscal de esta factura requiere revisión de soporte.')
  return e
}

const DIA_MX = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' })
/**
 * Ronda 1 (M5): `AAAAMMDD` en hora de México, armado con las PARTES de la fecha (año, mes y día por tipo), no con el texto que formatee ICU:
 * es parte de una llave de idempotencia, y si el formato cambiara entre despliegues nacería una segunda fila para el mismo periodo.
 */
function aaaammddEnMexico(d: Date): string {
  const parte = (tipo: Intl.DateTimeFormatPartTypes) => DIA_MX.formatToParts(d).find(x => x.type === tipo)?.value ?? ''
  const [anio, mes, dia] = [parte('year'), parte('month'), parte('day')]
  if (!/^\d{4}$/.test(anio) || !/^\d{2}$/.test(mes) || !/^\d{2}$/.test(dia))
    throw new Error(`Fecha sin año/mes/día de dos cifras: ${d.toISOString()}`)
  return `${anio}${mes}${dia}`
}
/**
 * C1 (Codex C1-7): la llave de la global de UN periodo. Hasta hoy, DIARIO/SEMANAL/QUINCENAL compartían la llave de su mes: sólo el
 * primer periodo se emitía y los demás devolvían «STAMPED» con él (sus ventas nunca entraban). Ahora llevan el día de inicio.
 * MENSUAL y BIMESTRAL conservan la de hoy (son un periodo por llave). Las filas con la llave vieja se resuelven por identidad
 * (Tarea 8), nunca se recalcula su llave.
 */
export function llaveDeLaGlobal(emisorId: string, period: ClosedPeriod): string {
  const base = `cfdi-global-${emisorId}-${period.anio}-${period.meses}-${period.satPeriodicidad}`
  return ['01', '02', '03'].includes(period.satPeriodicidad) ? `${base}-${aaaammddEnMexico(period.periodStart)}` : base
}

/**
 * Cada ticket con SU tramo de conceptos (con los ajustes congelados): lo usan C2 (saldo) y C3 (extracción). v1 (todo al 16 %): un item por
 * ticket, en el mismo orden; folio = la orden, forma = la de la global, sin reales (C3 no los usa de una v1 sin reconstruirlos).
 */
export function ordenesDeLaGlobal(e: EntradaGlobal): Array<{
  orderId: string
  folio: string
  formaPago: string
  renglones: Array<{ orderItemId: string; tratamiento: IvaTratamiento }>
  porTratamiento: PorTratamientoGlobal
  paidCents: number
  conceptos: GlobalInvoiceParams['items']
  conceptosReales: ConceptoReal[] | null
  filasD16: string[][]
}> {
  if (e.version === 2) {
    let at = 0
    return e.ordenes.map(o => {
      const n = conceptosDeOrdenGlobal(o, e.formaDelMezclado).length
      const conceptos = e.params.items.slice(at, (at += n))
      return {
        orderId: o.orderId,
        folio: o.folio,
        formaPago: o.formaPago,
        renglones: o.renglones,
        porTratamiento: o.porTratamiento,
        paidCents: o.paidCents,
        conceptos,
        conceptosReales: o.conceptosReales,
        filasD16: o.filasD16,
      }
    })
  }
  return e.ordenes.map((o, i) => {
    const it = e.params.items[i]
    const paidCents = it.taxIncluded ? it.unitPriceCents : totalSegunElPacCents(conceptosDesdeElPayload(it))
    return {
      orderId: o.orderId,
      folio: o.orderId,
      formaPago: e.params.payment_form,
      renglones: o.renglones,
      porTratamiento: { IVA_16: paidCents },
      paidCents,
      conceptos: [it],
      conceptosReales: null,
      filasD16: [],
    }
  })
}

/**
 * C1: la global de un periodo cerrado (envoltorio). Sin `desde`, el último periodo cerrado (el botón de siempre); con `desde` (Tarea 8,
 * C1-P16 = B), el inicio EXACTO de uno de los periodos recientes que revisa el job (`periodoRecienteQueEmpiezaEn`); un periodo más viejo
 * —o una fecha que no es el inicio de un periodo— responde «pídelo a soporte» (`BadRequestError`). El periodo y la llave (la de su global
 * principal) se calculan aquí y se los pasa a `issueGlobalForPeriod`, el ÚNICO camino al motor (ahí vive la guarda de la complementaria,
 * Tarea 11).
 */
export async function issueGlobalForEmisor(
  params: { emisorId: string; now: Date; sandbox: boolean; desde?: string },
  overrides: Partial<IssueGlobalDeps> = {},
): Promise<IssueGlobalResult> {
  const deps = { ...defaultDeps, ...overrides }
  const emisor = await deps.loadEmisor(params.emisorId)
  if (!emisor) throw new Error(`FiscalEmisor ${params.emisorId} not found`)
  let period = closedPeriodFor(emisor.globalPeriodicity, params.now)
  if (params.desde !== undefined) {
    const elegido = periodoRecienteQueEmpiezaEn(emisor.globalPeriodicity, new Date(params.desde), params.now)
    if (!elegido) throw new BadRequestError(MOTIVO_PERIODO_VIEJO)
    period = elegido
  }
  return issueGlobalForPeriod(
    { emisorId: params.emisorId, now: params.now, sandbox: params.sandbox, period, key: llaveDeLaGlobal(emisor.id, period) },
    overrides,
  )
}

/** C1: la global de UN periodo con su llave (las calcula quien llama: el envoltorio, los pendientes del job o la complementaria). */
export async function issueGlobalForPeriod(
  params: { emisorId: string; now: Date; sandbox: boolean; period: ClosedPeriod; key: string; complementariaDe?: string },
  overrides: Partial<IssueGlobalDeps> = {},
): Promise<IssueGlobalResult> {
  const deps = { ...defaultDeps, ...overrides }
  // T11: `complementariaDe` sólo lo pone la persona (`emitirGlobalComplementaria`) y sólo con la llave de una complementaria.
  if (params.complementariaDe !== undefined && (!params.complementariaDe || !esLlaveComplementaria(params.key)))
    throw new Error('Una global complementaria se emite con la llave de su complementaria (`<llave de la principal>-c<n>`).')
  const emisor = await deps.loadEmisor(params.emisorId)
  if (!emisor) throw new Error(`FiscalEmisor ${params.emisorId} not found`)
  return emitirGlobalDelPeriodo(emisor, deps, {
    sandbox: params.sandbox,
    period: params.period,
    key: params.key,
    now: params.now,
    complementariaDe: params.complementariaDe,
  })
}

// ── C1 · Tarea 11: la global COMPLEMENTARIA (C1-P7, C1-P12; Codex C1-16, C1-24, C1-25, C1-27, C1-29) ──
/** Tope de complementarias por principal (`-c2` … `-c21`). Ponytail: subirlo con la medición de un negocio que lo alcance. */
export const MAX_COMPLEMENTARIAS = 20
/** Una complementaria existente de una principal, lo que hace falta para elegir la siguiente llave y para el panel. */
export interface ComplementariaExistente {
  id: string
  idempotencyKey: string
  status: string
  falloDefinitivo: boolean
  enviadoAt: Date | null
  folio: string | null
  /** Ronda 1 (m2): su último motivo (el rechazo del PAC, la guarda…), para el panel de una no timbrada. */
  lastError?: string | null
}
export const llaveDeComplementaria = (llavePrincipal: string, n: number): string => `${llavePrincipal}-c${n}`
/**
 * Una complementaria TERMINADA ya no se retoma: timbrada (también con su cancelación en trámite: sigue siendo un documento timbrado),
 * cancelada, o anulada sin enviar. Decisión A del founder (7-oct): una ENVIADA y rechazada en definitiva NO está terminada: se reintenta ella
 * (consulta al PAC y recaptura con identidad nueva), nunca se salta a la siguiente n.
 */
const terminada = (c: { status: string; falloDefinitivo: boolean; enviadoAt: Date | null }) =>
  c.status === 'STAMPED' ||
  c.status === 'CANCEL_REQUESTED' ||
  c.status === 'CANCELLED' ||
  (c.status === 'STAMP_FAILED' && c.falloDefinitivo && !c.enviadoAt)
/** C1-P7: la llave de la complementaria que toca: la que está sin terminar (una a la vez por periodo) o la siguiente; null con el tope lleno. */
export function siguienteComplementaria(
  llavePrincipal: string,
  existentes: Array<{ idempotencyKey: string; status: string; falloDefinitivo: boolean; enviadoAt: Date | null }>,
): string | null {
  const propias = existentes.filter(c => llavePrincipalDe(c.idempotencyKey) === llavePrincipal)
  const abierta = propias.find(c => !terminada(c))
  if (abierta) return abierta.idempotencyKey
  if (propias.length >= MAX_COMPLEMENTARIAS) return null
  const ns = propias.map(c => Number(c.idempotencyKey.slice(llavePrincipal.length + 2))).filter(Number.isSafeInteger)
  return llaveDeComplementaria(llavePrincipal, Math.max(1, ...ns) + 1)
}
export const MOTIVO_SIN_PRINCIPAL = 'La factura global principal de este periodo todavía no está timbrada; emítela primero.'
/** Ronda 1 (m7): la principal con su cancelación en trámite (`CANCEL_REQUESTED`). */
export const MOTIVO_PRINCIPAL_EN_CANCELACION = 'Su cancelación está en trámite ante el SAT; espera a que se resuelva.'
/** Ronda 1 (I1): la principal heredada timbrada, sin manifiesto de sus ventas. */
export const MOTIVO_PRINCIPAL_HEREDADA = 'Esta factura global es de antes del registro de sus ventas; su complementaria se pide a soporte.'
export const MOTIVO_COMPLEMENTARIA_DEL_JOB = 'Esta global complementaria espera a que una persona la emita.'
const MOTIVO_COMPLEMENTARIA_INVALIDA =
  'La entrada fiscal de esta factura global complementaria no corresponde a su llave; requiere revisión de soporte.'

/** C1 (Tarea 11): las complementarias de una principal (por su llave `-c<n>`), la más vieja primero; acotada a `MAX_COMPLEMENTARIAS + 1`. */
export async function complementariasDe(principal: {
  id: string
  idempotencyKey: string
  fiscalEmisorId: string
}): Promise<ComplementariaExistente[]> {
  const filas = await prisma.cfdi.findMany({
    where: {
      fiscalEmisorId: principal.fiscalEmisorId,
      isGlobal: true,
      type: 'INGRESO',
      idempotencyKey: { startsWith: `${principal.idempotencyKey}-c` },
    },
    select: { id: true, idempotencyKey: true, status: true, falloDefinitivo: true, enviadoAt: true, folio: true, lastError: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_COMPLEMENTARIAS + 1,
  })
  // `startsWith` también aceptaría `<llave>-cX`: sólo cuentan las llaves EXACTAS de esta principal.
  return filas
    .filter(f => f.idempotencyKey !== null && llavePrincipalDe(f.idempotencyKey) === principal.idempotencyKey)
    .map(f => ({ ...f, idempotencyKey: f.idempotencyKey as string }))
}

/**
 * C1-18/C1-27/C1-P7: cuántas ventas del periodo, sin global viva ni extracción (`candidateWhere`, los MISMOS filtros que la captura), entrarían
 * HOY, entre las primeras `maxRevisar`. Devuelve lo ENCONTRADO y si la revisión fue completa: nunca convierte ventas revisadas en elegibles.
 */
export async function contarCorregidasPendientes(
  emisor: GlobalEmisor,
  period: ClosedPeriod,
  unSoloEmisor: boolean,
  maxRevisar = 200,
  /** Ronda 1 (I4): la complementaria abierta y nunca enviada; sus propias ventas siguen siendo candidatas (como en su recaptura). */
  self?: string,
): Promise<{ n: number; completo: boolean }> {
  const where = candidateWhere(emisor, period, unSoloEmisor, self)
  const POR_PAGINA = 50
  let n = 0
  let revisadas = 0
  let despues: string | undefined
  for (;;) {
    const page = await prisma.order.findMany({
      where: { AND: [where, ...(despues ? [{ id: { gt: despues } }] : [])] },
      select: ORDER_SELECT,
      orderBy: { id: 'asc' },
      take: POR_PAGINA,
    })
    for (const o of page) {
      if (revisadas === maxRevisar) return { n, completo: false }
      revisadas++
      if (ticketParaGlobal({ ...o, orderDiscounts: await filasDeDescuentoCompletas(prisma, o.id, o.orderDiscounts) }).ok) n++
    }
    if (page.length < POR_PAGINA) return { n, completo: true }
    despues = page[page.length - 1].id
  }
}

/**
 * C1-25 / C1-41 (v7): la global principal por su id, con su periodo GUARDADO (no el de la periodicidad de hoy). SÓLO identidad —emisor, que
 * sea principal, periodo demostrable— y en CUALQUIER estado (la Tarea 12 la consulta también reservada, pendiente o detenida).
 */
export async function globalPrincipalPorId(
  deps: Pick<IssueGlobalDeps, 'loadEmisor'>,
  p: { venueId: string; emisorId: string; principalId: string },
): Promise<{ emisor: GlobalEmisor; principal: any; period: ClosedPeriod }> {
  const emisor = await deps.loadEmisor(p.emisorId)
  if (!emisor || emisor.venueId !== p.venueId) throw new Error('Emisor fiscal not found')
  const principal = await prisma.cfdi.findFirst({
    where: { id: p.principalId, fiscalEmisorId: emisor.id, venueId: p.venueId, isGlobal: true, type: 'INGRESO' },
  })
  if (!principal || typeof principal.idempotencyKey !== 'string' || esLlaveComplementaria(principal.idempotencyKey))
    throw new BadRequestError('Esa factura no es una factura global principal de este emisor.')
  const period = periodoDeLaFila({
    entrada: principal.entrada,
    globalPeriod: principal.globalPeriod,
    idempotencyKey: principal.idempotencyKey,
  })
  if (!period)
    throw new BadRequestError(
      'Esta factura global es de antes del cambio de llaves y su periodo no se puede demostrar; su complementaria no se puede emitir desde Avoqado.',
    )
  return { emisor, principal, period }
}
/** Para previsualizar o emitir su COMPLEMENTARIA: además, la principal timbrada o cancelada (C1-41: esta exigencia es sólo de la complementaria). */
async function principalPorId(deps: Pick<IssueGlobalDeps, 'loadEmisor'>, p: { venueId: string; emisorId: string; principalId: string }) {
  const r = await globalPrincipalPorId(deps, p)
  // Ronda 1 (m7): la cancelación en trámite tiene su propio texto (no «todavía no está timbrada»).
  if (r.principal.status === 'CANCEL_REQUESTED') throw new BadRequestError(MOTIVO_PRINCIPAL_EN_CANCELACION)
  if (r.principal.status !== 'STAMPED' && r.principal.status !== 'CANCELLED') throw new BadRequestError(MOTIVO_SIN_PRINCIPAL)
  if (!admiteComplementaria(r.principal)) throw new BadRequestError(MOTIVO_PRINCIPAL_HEREDADA)
  return r
}
/**
 * Ronda 1 (I1): una principal HEREDADA (`protocoloIva !== 1`) nunca escribió el manifiesto de sus ventas, así que la ventana fiscal no las ve
 * ocupadas: su complementaria volvería a facturar TODO su periodo. Timbrada, no tiene complementaria (se pide a soporte); CANCELADA sí (sus ventas ya
 * no están documentadas). La de protocolo 1 siempre (su manifiesto dice qué documenta).
 */
const admiteComplementaria = (principal: { status: string; protocoloIva: number | null }) =>
  principal.status === 'CANCELLED' || (principal.status === 'STAMPED' && principal.protocoloIva === 1)
/** Ronda 1 (I4): la complementaria abierta y NUNCA enviada de una principal (su reserva se recapturaría con sus propias ventas), o undefined. */
function abiertaSinEnviar(llavePrincipal: string, existentes: ComplementariaExistente[]): string | undefined {
  const llave = siguienteComplementaria(llavePrincipal, existentes)
  const abierta = existentes.find(c => c.idempotencyKey === llave)
  return abierta && abierta.enviadoAt === null ? abierta.id : undefined
}
/** El periodo como lo ven el panel y el MCP (ISO). */
const periodoVisible = (q: ClosedPeriod) => ({
  desde: q.periodStart.toISOString(),
  hasta: q.periodEnd.toISOString(),
  meses: q.meses,
  anio: q.anio,
})

export interface VistaPreviaComplementaria {
  periodo: { desde: string; hasta: string; meses: string; anio: number }
  estadoPrincipal: 'TIMBRADA' | 'CANCELADA'
  corregidasPendientes: { n: number; completo: boolean }
  siguienteLlave: string | null
  motivo: string | null
}
/** C1 (Tarea 11): lo que la persona ve antes de emitir la complementaria de una principal (el periodo guardado de ÉSTA, no el de hoy). */
export async function vistaPreviaComplementaria(
  p: { venueId: string; emisorId: string; principalId: string; now: Date },
  overrides: Partial<IssueGlobalDeps> = {},
): Promise<VistaPreviaComplementaria> {
  const deps = { ...defaultDeps, ...overrides }
  const { emisor, principal, period } = await principalPorId(deps, p)
  const unSoloEmisor = (await deps.contarEmisores(emisor.venueId)) === 1
  const existentes = await deps.complementariasDe(principal)
  return {
    periodo: periodoVisible(period),
    estadoPrincipal: principal.status === 'STAMPED' ? 'TIMBRADA' : 'CANCELADA',
    // Ronda 1 (I4): con la abierta sin enviar como `self`, `n` cuenta lo que su recaptura de verdad tomaría.
    corregidasPendientes: await deps.contarCorregidasPendientes(
      emisor,
      period,
      unSoloEmisor,
      abiertaSinEnviar(principal.idempotencyKey, existentes),
    ),
    siguienteLlave: siguienteComplementaria(principal.idempotencyKey, existentes),
    // T10, ronda 2 (N1): las mismas guardas que el motor (el año; el periodo cubierto, salvo que la abierta ya se haya enviado y sólo se recupere).
    motivo: await motivoAntesDeEmitir(deps, emisor, period, p.now, !abiertaEnviada(principal.idempotencyKey, existentes)),
  }
}
/** T10, ronda 2 (N1): ¿la complementaria abierta (la que se retomaría) ya se envió y no está rechazada? Entonces el motor sólo la recupera. */
function abiertaEnviada(llavePrincipal: string, existentes: ComplementariaExistente[]): boolean {
  const llave = siguienteComplementaria(llavePrincipal, existentes)
  const abierta = existentes.find(c => c.idempotencyKey === llave)
  return !!abierta && abierta.enviadoAt !== null && abierta.falloDefinitivo !== true
}

/** C1 (Tarea 11, MCP `emit_global_invoice`): lo que una persona ve antes de emitir A MANO la principal de un periodo reciente. */
export interface VistaPreviaPrincipal {
  periodo: { desde: string; hasta: string; meses: string; anio: number }
  estado: EstadoDelPeriodo
  cfdiId: string | null
  ventas: { n: number; completo: boolean }
  motivo: string | null
}
/**
 * El mismo periodo que aceptaría el disparo con `desde` (`periodoRecienteQueEmpiezaEn`; uno viejo ⇒ `MOTIVO_PERIODO_VIEJO`, C1-P16 = B), su
 * principal y cuántas ventas entrarían hoy (`contarCorregidasPendientes`: los candidatos del periodo sin global viva).
 */
export async function vistaPreviaPrincipal(
  p: { venueId: string; emisorId: string; desde: string; now: Date },
  overrides: Partial<IssueGlobalDeps> = {},
): Promise<VistaPreviaPrincipal> {
  const deps = { ...defaultDeps, ...overrides }
  const emisor = await deps.loadEmisor(p.emisorId)
  if (!emisor || emisor.venueId !== p.venueId) throw new Error(`FiscalEmisor ${p.emisorId} not found`)
  const period = periodoRecienteQueEmpiezaEn(emisor.globalPeriodicity, new Date(p.desde), p.now)
  if (!period) throw new BadRequestError(MOTIVO_PERIODO_VIEJO)
  const encontrada = await deps.findGlobalDelPeriodo(emisor.id, period)
  const fila = encontrada && encontrada.fiscalEmisorId === emisor.id ? encontrada : null
  const unSoloEmisor = (await deps.contarEmisores(emisor.venueId)) === 1
  // N1 de la T11: con la principal reservada y nunca enviada, su recaptura toma también SUS ventas (`self`, como el motor).
  const self = fila && fila.enviadoAt === null ? fila.id : undefined
  return {
    periodo: periodoVisible(period),
    estado: estadoDeLaPrincipal(fila),
    cfdiId: fila?.id ?? null,
    ventas: await deps.contarCorregidasPendientes(emisor, period, unSoloEmisor, self),
    // Ola final (nit de la re-revisión 2 de la T10): una principal HEREDADA (`protocoloIva: null`) va al camino viejo del motor
    // (`emitirGlobalLegacy`), que no aplica la guarda de periodo cubierto: la vista previa tampoco la dice.
    motivo: await motivoAntesDeEmitir(
      deps,
      emisor,
      period,
      p.now,
      !(fila && fila.protocoloIva === null) && (!fila || fila.enviadoAt === null || fila.falloDefinitivo === true),
    ),
  }
}

/**
 * T10, ronda 2 (N1): lo que la vista previa (MCP) dice antes de emitir, con las MISMAS guardas del motor que no dependen de la fila: el año y el
 * periodo cubierto por otra global pendiente (ésta sólo si el motor fuera a capturar: lo ya enviado se recupera sin guardas).
 */
async function motivoAntesDeEmitir(
  deps: IssueGlobalDeps,
  emisor: GlobalEmisor,
  period: ClosedPeriod,
  now: Date,
  vaACapturar: boolean,
): Promise<string | null> {
  if (!anioPermitido(period.anio, now)) return MOTIVO_ANIO_FUERA
  const cubridora = vaACapturar ? await deps.globalApartadaQueCubre(emisor.id, period) : null
  // Ola final (T1): el mismo texto que daría el motor.
  return cubridora ? motivoDePeriodoCubierto(emisor, cubridora) : null
}

/**
 * C1-P7/C1-P12 (Codex C1-16/C1-24/C1-25): emite (o retoma) la complementaria de una principal. SÓLO la llama una persona (panel o MCP): es la
 * única que pasa `complementariaDe` al motor. El periodo es el GUARDADO de la principal; la llave, la sin terminar o la siguiente.
 */
export async function emitirGlobalComplementaria(
  params: { venueId: string; emisorId: string; principalId: string; now: Date; sandbox: boolean },
  overrides: Partial<IssueGlobalDeps> = {},
): Promise<IssueGlobalResult> {
  const deps = { ...defaultDeps, ...overrides }
  const { emisor, principal, period } = await principalPorId(deps, params)
  const key = siguienteComplementaria(principal.idempotencyKey, await deps.complementariasDe(principal))
  if (!key)
    throw new BadRequestError(`Este periodo ya tiene ${MAX_COMPLEMENTARIAS} facturas globales complementarias; pide ayuda a soporte.`)
  // (C1-33/C1-37: la guarda del año vive en el motor, después de recuperar; la misma para el job y para la persona.)
  const r = await issueGlobalForPeriod(
    { emisorId: emisor.id, now: params.now, sandbox: params.sandbox, period, key, complementariaDe: principal.id },
    overrides,
  )
  return { ...r, complementariaDe: principal.id }
}

export const MOTIVO_FILA_VIEJA_ANULADA =
  'Esta factura global de antes del cambio de llaves nunca se envió y no se puede saber a qué día pertenecía; se anuló sin enviar y sus ventas entran en la global del día de su cobro.'
/** C1-22: una fila vieja corta ENVIADA cuyo desenlace el PAC todavía no confirma: sigue reservada (nunca se libera por reloj). */
export const MOTIVO_FILA_VIEJA_EN_RECUPERACION =
  'Factura global de antes del cambio de llaves en recuperación: se envió y el PAC todavía no la confirma; sus ventas siguen reservadas.'
/** Ronda 1 de la T8 (I1 c): un periodo sin principal que salió de la ventana con ventas por facturar. */
export const MOTIVO_PERIODO_FUERA_DE_VENTANA =
  'Este periodo ya no está entre los que se revisan solos y todavía tiene ventas sin factura global; ya no se emite desde aquí: pídelo a soporte.'
export const AVISO_PERIODO_DETENIDO = 'CFDI_GLOBAL_PERIODO_DETENIDO'
export const AVISO_PERIODO_REANUDADO = 'CFDI_GLOBAL_PERIODO_REANUDADO'
export const AVISO_PERIODO_FUERA_DE_VENTANA = 'CFDI_GLOBAL_PERIODO_FUERA_DE_VENTANA'
/** Una fila sin timbrar cuyo periodo no se puede demostrar (C1-14): no se adivina; va a soporte. */
export const MOTIVO_PERIODO_SIN_DEMOSTRAR = 'No se pudo saber a qué periodo pertenece esta factura global; requiere revisión de soporte.'

/**
 * C1 (C1-14): una fila con la llave vieja de una periodicidad corta. Hasta C1, DIARIO/SEMANAL/QUINCENAL usaban la llave del MES
 * (`cfdi-global-<emisor>-<año>-<mes>-<periodicidad>`, sin día): se reconoce sólo si es EXACTAMENTE esa llave armada con los datos de la propia
 * fila (su emisor y su `globalPeriod`), nunca por parecido.
 */
/** Las periodicidades CORTAS (diaria, semanal, quincenal) cuya llave VIEJA era la del mes: `cfdi-global-<emisor>-<año>-<mes>-<periodicidad>`. */
export const PERIODICIDADES_CORTAS: readonly string[] = ['01', '02', '03']
/**
 * Ola final (Minor 2 de la revisión final): el final de una llave vieja corta, para el `where` de `globalesSinTimbrar` (Prisma no puede llamar a
 * `esLlaveViejaCorta`). Sale de la MISMA lista; la prueba «la llave vieja corta se reconoce igual en SQL y en memoria» comprueba que ninguna llave
 * nueva (de ninguna periodicidad, ni su complementaria) termina así.
 */
export const SUFIJOS_DE_LLAVE_VIEJA_CORTA: readonly string[] = PERIODICIDADES_CORTAS.map(p => `-${p}`)
export function esLlaveViejaCorta(fila: { idempotencyKey: string; globalPeriod: any; fiscalEmisorId?: string }): boolean {
  const gp = fila.globalPeriod
  if (!esObjeto(gp) || !PERIODICIDADES_CORTAS.includes(gp.periodicidad as string) || typeof fila.fiscalEmisorId !== 'string') return false
  return fila.idempotencyKey === `cfdi-global-${fila.fiscalEmisorId}-${gp.anio}-${gp.meses}-${gp.periodicidad}`
}

/**
 * C1 (C1-14): el periodo de una fila. v2: el congelado, sólo si es exactamente un periodo cerrado de su periodicidad con el mismo mes y año
 * que su `globalPeriod` (la misma regla del lector). Vieja mensual/bimestral: el de su `globalPeriod` (uno por mes o bimestre). Vieja corta
 * (diaria/semanal/quincenal con la llave del mes): null — su día no se puede demostrar (el motor pudo recapturarla para otro día sin
 * cambiar `createdAt`), así que NUNCA se adivina.
 */
export function periodoDeLaFila(fila: { entrada: any; globalPeriod: any; idempotencyKey: string }): ClosedPeriod | null {
  const gp = fila.globalPeriod
  const p = esObjeto(gp) ? periodicidadDeCodigo(gp.periodicidad) : null
  if (!p) return null
  const e = fila.entrada
  if (esObjeto(e) && e.version === 2) {
    const periodo = e.periodo
    if (!esObjeto(periodo) || typeof periodo.desde !== 'string' || typeof periodo.hasta !== 'string') return null
    const hasta = new Date(periodo.hasta)
    if (!Number.isFinite(hasta.getTime())) return null
    const q = closedPeriodFor(p, hasta)
    const exacto =
      q.periodStart.toISOString() === periodo.desde &&
      q.periodEnd.toISOString() === periodo.hasta &&
      q.meses === gp.meses &&
      q.anio === gp.anio
    return exacto ? q : null
  }
  return periodoDeGlobalPeriod(gp)
}

/**
 * C1-26: TODAS las órdenes del manifiesto de una global, por páginas de 100, ordenadas por id (el recorrido que repiten la reserva del
 * motor y el rechazo definitivo de `enviarIntentoCapturado`).
 */
export async function ordenesDelManifiesto(db: Pick<Prisma.TransactionClient, 'cfdiGlobalOrden'>, cfdiId: string): Promise<string[]> {
  const ids: string[] = []
  let after: string | undefined
  for (;;) {
    const page = await db.cfdiGlobalOrden.findMany({
      where: { cfdiId, ...(after ? { orderId: { gt: after } } : {}) },
      orderBy: { orderId: 'asc' },
      take: PAGE,
      select: { orderId: true },
    })
    ids.push(...page.map(m => m.orderId))
    if (page.length < PAGE) return ids
    after = page[page.length - 1].orderId
  }
}

/**
 * C1 (C1-14/C1-22/C1-26): anula SIN ENVIAR una fila vieja corta que NUNCA se envió. Una sola transición atómica: el CAS exige
 * `enviadoAt: null` —el mismo campo que el motor marca con su CAS antes del POST (`enviarIntentoCapturado`)—, así que la anulación y el envío
 * se excluyen sin relojes: o gana la anulación y el envío ya no puede ocurrir, o ganó el envío y la anulación no toca nada (`'PERDIDA'`).
 * Antes, TODO el manifiesto (por páginas) bajo los candados de sus órdenes (por id, sin filtrar negocio: son las de ESTA factura, como en la
 * cancelación, Ruling 4b-R13) → productos → admisión compartida. Gana ⇒ sellos liberados, manifiesto vacío y el rastro en `ActivityLog`, en la
 * misma transacción: sus ventas vuelven a ser candidatas del periodo de su último cobro.
 */
export async function anularFilaVieja(fila: any, now: Date = new Date()): Promise<'ANULADA' | 'PERDIDA'> {
  return (await anularFilaViejaConMotivo(fila, now)).resultado
}

/** Ronda 1 de la T8 (I2): el rango del ÚLTIMO cobro elegible de las ventas de un manifiesto (su fecha fiscal, Tarea 5) y cuántas caen antes de `inicio`. */
interface RangoDeCobros {
  desde: Date | null
  hasta: Date | null
  fueraDeVentana: number
  fueraDesde: Date | null
  fueraHasta: Date | null
}
async function rangoDeUltimosCobros(
  tx: Prisma.TransactionClient,
  venueId: string,
  ordenes: string[],
  inicio: Date,
): Promise<RangoDeCobros> {
  const r: RangoDeCobros = { desde: null, hasta: null, fueraDeVentana: 0, fueraDesde: null, fueraHasta: null }
  const min = (a: Date | null, b: Date) => (a && a <= b ? a : b)
  const max = (a: Date | null, b: Date) => (a && a >= b ? a : b)
  // Por páginas de 100 órdenes del manifiesto: un renglón agregado por orden (acotado al manifiesto).
  for (let at = 0; at < ordenes.length; at += PAGE) {
    const ultimos = await tx.payment.groupBy({
      by: ['orderId'],
      where: { orderId: { in: ordenes.slice(at, at + PAGE) }, venueId, AND: [COBRO] },
      _max: { createdAt: true },
    })
    for (const u of ultimos) {
      const t = u._max.createdAt
      if (!t) continue
      r.desde = min(r.desde, t)
      r.hasta = max(r.hasta, t)
      if (t < inicio) {
        r.fueraDeVentana++
        r.fueraDesde = min(r.fueraDesde, t)
        r.fueraHasta = max(r.fueraHasta, t)
      }
    }
  }
  return r
}
/** Las partes de una fecha en hora de México (para los textos y el `data` de los avisos). */
function partesMx(d: Date) {
  const parte = (tipo: Intl.DateTimeFormatPartTypes) => DIA_MX.formatToParts(d).find(x => x.type === tipo)?.value ?? ''
  return { anio: parte('year'), mes: parte('month'), dia: parte('day') }
}
const fechaMx = (d: Date) => (p => `${p.dia}/${p.mes}/${p.anio}`)(partesMx(d))
const diaIsoMx = (d: Date | null) => (d ? (p => `${p.anio}-${p.mes}-${p.dia}`)(partesMx(d)) : null)

/**
 * Ronda 1 de la T8 (I2): la anulación dice la verdad. Bajo los mismos candados, lee el último cobro elegible de cada venta del manifiesto;
 * si alguna cae antes del primer periodo que revisa el job (con la periodicidad de HOY del emisor, la del bucle 2), su periodo ya no se emite
 * solo: el motivo lo dice con fechas («pídelo a soporte»), el `ActivityLog` lleva el rango y se escribe un `logger.error`.
 */
async function anularFilaViejaConMotivo(fila: any, now: Date): Promise<{ resultado: 'ANULADA' | 'PERDIDA'; motivo?: string }> {
  const r = await prisma.$transaction(
    async tx => {
      const ordenes = await ordenesDelManifiesto(tx, fila.id)
      await bloquearOrdenesParaFacturar(tx, ordenes)
      const { organizationId } = await tx.venue.findUniqueOrThrow({ where: { id: fila.venueId }, select: { organizationId: true } })
      await tomarAdmisionCompartida(tx, organizationId)
      const periodicidad =
        (await tx.fiscalEmisor.findUnique({ where: { id: fila.fiscalEmisorId }, select: { globalPeriodicity: true } }))
          ?.globalPeriodicity ??
        periodicidadDeCodigo(fila.globalPeriod?.periodicidad) ??
        'DIARIO'
      const ventana = periodosCerradosRecientes(periodicidad, now)
      const rango = await rangoDeUltimosCobros(tx, fila.venueId, ordenes, ventana[ventana.length - 1].periodStart)
      const motivo =
        rango.fueraDeVentana && rango.fueraDesde && rango.fueraHasta
          ? `Esta factura global de antes del cambio de llaves nunca se envió y no se puede saber a qué día pertenecía; se anuló sin enviar. Sus ventas del ${fechaMx(rango.fueraDesde)} al ${fechaMx(rango.fueraHasta)} quedaron libres; ese periodo ya no se emite desde aquí: pídelo a soporte.${rango.fueraDeVentana < ordenes.length ? ' Las demás entran en la global del día de su cobro.' : ''}`
          : MOTIVO_FILA_VIEJA_ANULADA
      const { count } = await tx.cfdi.updateMany({
        where: { id: fila.id, status: fila.status, attempts: fila.attempts, uuid: null, enviadoAt: null },
        data: { status: 'STAMP_FAILED', falloDefinitivo: true, lastError: motivo },
      })
      if (count !== 1) return { resultado: 'PERDIDA' as const }
      await liberarSellosDe(tx, fila.id)
      await tx.cfdiGlobalOrden.deleteMany({ where: { cfdiId: fila.id } })
      await tx.activityLog.create({
        data: {
          venueId: fila.venueId,
          action: 'CFDI_GLOBAL_VIEJA_ANULADA',
          entity: 'Cfdi',
          entityId: fila.id,
          data: {
            idempotencyKey: fila.idempotencyKey,
            attempts: fila.attempts,
            ordenes: ordenes.length,
            desde: diaIsoMx(rango.desde),
            hasta: diaIsoMx(rango.hasta),
            fueraDeVentana: rango.fueraDeVentana,
            fueraDesde: diaIsoMx(rango.fueraDesde),
            fueraHasta: diaIsoMx(rango.fueraHasta),
          },
        },
      })
      return { resultado: 'ANULADA' as const, motivo, rango }
    },
    { timeout: 60_000 },
  )
  if (r.resultado === 'ANULADA' && r.rango.fueraDeVentana)
    logger.error(
      `[cfdiGlobal] la global vieja ${fila.id} (${fila.idempotencyKey}) se anuló sin enviar y ${r.rango.fueraDeVentana} venta(s) del ` +
        `${fechaMx(r.rango.fueraDesde!)} al ${fechaMx(r.rango.fueraHasta!)} quedaron libres FUERA de los periodos que se revisan solos: pídelo a soporte.`,
    )
  return { resultado: r.resultado, motivo: r.resultado === 'ANULADA' ? r.motivo : undefined }
}

/**
 * C1 (Tarea 8, C1-15/C1-42): una página de 10 globales de INGRESO del emisor sin timbrar, de cualquier periodo, después del cursor
 * `(updatedAt, id)`. Conserva las enviadas inciertas y (decisión A del founder, 7-oct) las ENVIADAS y rechazadas en definitiva: el motor las
 * consulta al PAC y las recaptura con identidad nueva (la cadencia diaria del job es su tope de reintentos). Descarta sólo lo que no tiene
 * salida: las anuladas sin enviar (`enviadoAt: null`) y las viejas cortas rechazadas (llave del MES de una periodicidad corta, `-01/-02/-03`:
 * su día no se puede demostrar y sus ventas quedaron libres con el rechazo; ninguna llave nueva termina así).
 */
export async function globalesSinTimbrar(emisorId: string, cursor: CursorDePendientes | null): Promise<any[]> {
  return prisma.cfdi.findMany({
    where: {
      fiscalEmisorId: emisorId,
      isGlobal: true,
      type: 'INGRESO',
      status: { in: ['STAMPING', 'STAMP_FAILED', 'VALIDATION_FAILED'] },
      NOT: [
        { status: 'STAMP_FAILED', falloDefinitivo: true, enviadoAt: null },
        {
          status: 'STAMP_FAILED',
          falloDefinitivo: true,
          // La vieja corta (`esLlaveViejaCorta`) por su final, que en SQL es lo único que se puede mirar: los sufijos salen de la MISMA lista.
          OR: SUFIJOS_DE_LLAVE_VIEJA_CORTA.map(fin => ({ idempotencyKey: { endsWith: fin } })),
        },
      ],
      ...(cursor ? { OR: [{ updatedAt: { gt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, id: { gt: cursor.id } }] } : {}),
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: PAGINA_DE_PENDIENTES,
  })
}
const PAGINA_DE_PENDIENTES = 10

/**
 * C1 (Tarea 8): la global PRINCIPAL de un periodo, por su llave. Mensual y bimestral conservan la llave de siempre, así que sus filas viejas
 * se encuentran; las viejas cortas (llave del mes) ya no se atribuyen a ningún día (las resuelve la pasada de pendientes).
 */
export async function globalPrincipalDelPeriodo(emisorId: string, period: ClosedPeriod): Promise<any | null> {
  return prisma.cfdi.findUnique({ where: { idempotencyKey: llaveDeLaGlobal(emisorId, period) } })
}

/**
 * C1 (Tarea 10, m1 de la revisión de la T9): las globales apartadas (sin timbrar) del emisor cuya periodicidad NO es la suya de hoy: el emisor
 * cambió de periodicidad y esas filas ya no caen en ninguno de los periodos del panel. Acotada (10, por `createdAt`).
 */
export async function globalesDeOtraPeriodicidad(
  emisorId: string,
  satPeriodicidad: string,
  despues?: { createdAt: Date; id: string } | null,
): Promise<any[]> {
  return prisma.cfdi.findMany({
    where: {
      fiscalEmisorId: emisorId,
      isGlobal: true,
      type: 'INGRESO',
      status: { in: ['STAMPING', 'STAMP_FAILED', 'VALIDATION_FAILED'] },
      NOT: { globalPeriod: { path: ['periodicidad'], equals: satPeriodicidad } },
      // Ronda 2 (N5 b): la página siguiente, en el mismo orden (`createdAt desc, id desc`).
      ...(despues ? { OR: [{ createdAt: { lt: despues.createdAt } }, { createdAt: despues.createdAt, id: { lt: despues.id } }] } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_OTRAS_PERIODICIDADES + 1, // uno de más: si llega, el panel dice que hay más (`completo: false`)
  })
}

/**
 * C1 (Tarea 10, ronda 1, I1): la global de OTRA periodicidad que todavía tiene apartadas ventas de este periodo: sin timbrar y viva (reservada,
 * o enviada sin respuesta; nunca la diagnóstica ni la rechazada en definitiva, que ya soltaron sus ventas) y con este periodo CONTENIDO entero
 * en su periodo GUARDADO (ronda 2, R1). Acotada: son filas raras (el emisor cambió de periodicidad con una global pendiente).
 */
export async function globalApartadaQueCubre(emisorId: string, period: ClosedPeriod): Promise<any | null> {
  const filas = await prisma.cfdi.findMany({
    where: {
      fiscalEmisorId: emisorId,
      isGlobal: true,
      type: 'INGRESO',
      status: { in: ['STAMPING', 'STAMP_FAILED'] },
      // Ronda 2 (N5 a): una global que CONTIENE este periodo cierra en o después de su fin, y se crea después de cerrar: el rango del índice
      // `(fiscalEmisorId, isGlobal, createdAt)` lee sólo las recientes, no todo el historial del emisor.
      createdAt: { gte: period.periodEnd },
      AND: [CFDI_VIVO, { NOT: { globalPeriod: { path: ['periodicidad'], equals: period.satPeriodicidad } } }],
    },
    select: { id: true, idempotencyKey: true, globalPeriod: true, entrada: true, status: true, enviadoAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 50,
  })
  return (
    filas.find(f => {
      const q = f.idempotencyKey !== null ? periodoDeLaFila({ ...f, idempotencyKey: f.idempotencyKey }) : null
      // Ronda 2 (R1): sólo si este periodo queda CONTENIDO entero en la otra (con cruzarse no basta: las fechas de fuera no están apartadas, y
      // dos filas que se cruzan se bloquearían entre sí). La contención es un orden estricto: nunca hay ciclo.
      return !!q && q.periodStart <= period.periodStart && period.periodEnd <= q.periodEnd
    }) ?? null
  )
}

/**
 * C1 (C1-6/C1-15): lo que corre el job por emisor. (1) Reanuda UNA página de las globales sin timbrar (de cualquier periodo), con cursor;
 * (2) emite los periodos cerrados recientes (`PERIODOS_A_REVISAR`) sin global principal, del más viejo al más nuevo. Cada fila y cada periodo
 * va aislado: un error queda en su resultado y la pasada sigue (un periodo detenido no frena a los siguientes). Completar ventas de un
 * periodo ya timbrado es la complementaria (Tarea 11): el job nunca la emite. La guarda vive en el motor, al que sólo se llega por
 * `issueGlobalForPeriod`: esta pasada manda cada fila con su llave y SIN `complementariaDe`, así que una complementaria sólo se recupera si se envió.
 */
export async function emitirGlobalesPendientes(
  params: { emisorId: string; now: Date; sandbox: boolean; cursor?: CursorDePendientes | null },
  overrides: Partial<IssueGlobalDeps> = {},
): Promise<{ resultados: IssueGlobalResult[]; cursor: CursorDePendientes | null }> {
  const deps = { ...defaultDeps, ...overrides }
  const emisor = await deps.loadEmisor(params.emisorId)
  if (!emisor) throw new Error(`FiscalEmisor ${params.emisorId} not found`)
  if (emisor.csdStatus !== 'ACTIVE') return { resultados: [{ status: 'SKIPPED', reason: 'CSD inactivo' }], cursor: null }
  const resultados: IssueGlobalResult[] = []
  const etiqueta = (period?: ClosedPeriod) => (period ? ` periodo ${period.periodStart.toISOString()}` : '')
  /**
   * Ronda 1 (I1 b): el rastro en la base de un periodo detenido; no se repite con el mismo motivo. Sin red de seguridad, no tumba la pasada.
   * 🔴 Ola final (N2-bis): `movida` = la fila de la cola que la pasada acaba de mover (su marca y el `lastError` que conserva). Si el último aviso
   * es MÁS VIEJO que esa marca y la fila no dice ya este motivo, se deja uno nuevo aunque diga lo mismo: el panel (`motivoDeLaFila`) sólo cree al
   * aviso si es más nuevo que la fila, y sin esto, desde la 2.ª pasada con el mismo desenlace, volvía a `motivo: null` (o al `lastError` viejo).
   * Si la fila ya lo dice, el panel lo lee de ella: no se repite. Acotado: a lo más uno por fila de la página (10) y por pasada.
   */
  const avisarDetenido = async (period: ClosedPeriod, motivo: string, status: IssueGlobalStatus, movida: FilaMovida | null = null) => {
    try {
      const ultimo = await deps.ultimoAvisoDelPeriodo(emisor, period, [AVISO_PERIODO_DETENIDO, AVISO_PERIODO_REANUDADO])
      const vigente =
        !movida || movida.lastError === motivo || (!!ultimo?.createdAt && new Date(ultimo.createdAt).getTime() >= movida.en.getTime())
      if (ultimo?.action === AVISO_PERIODO_DETENIDO && ultimo.motivo === motivo && vigente) return
      await deps.registrarAvisoDelPeriodo(emisor, period, AVISO_PERIODO_DETENIDO, { motivo, status })
    } catch (err) {
      logger.error(`[cfdiGlobal] emisor ${emisor.id}${etiqueta(period)}: no se pudo dejar el aviso de periodo detenido: ${String(err)}`)
    }
  }
  /** Un periodo que estuvo detenido y ya no tiene nada que facturar: el panel deja de mostrar el motivo viejo. */
  const avisarReanudado = async (period: ClosedPeriod) => {
    try {
      const ultimo = await deps.ultimoAvisoDelPeriodo(emisor, period, [AVISO_PERIODO_DETENIDO, AVISO_PERIODO_REANUDADO])
      if (ultimo?.action === AVISO_PERIODO_DETENIDO)
        await deps.registrarAvisoDelPeriodo(emisor, period, AVISO_PERIODO_REANUDADO, { motivo: null })
    } catch (err) {
      logger.error(`[cfdiGlobal] emisor ${emisor.id}${etiqueta(period)}: no se pudo dejar el aviso de periodo reanudado: ${String(err)}`)
    }
  }
  /**
   * Una fila o un periodo, aislado: su error queda en su resultado y la pasada sigue. `null` = nada que hacer (no deja renglón). Ronda 1 (I1 a):
   * SÓLO «en proceso» (el `PROCESANDO` exacto) es `SKIPPED` con `warn`; cualquier otro `ConflictError` (revisión de soporte, cancelada en el PAC)
   * es `DETENIDO` y otro error `ERROR`, los dos con `logger.error` y, si es un periodo de la pasada (`avisar`), con su aviso en la base.
   * T10 (N1): un `ERROR` guarda y devuelve `MOTIVO_ERROR_DEL_PERIODO`; su texto crudo (p. ej. de Prisma) sólo va al `logger.error`.
   * T10 (preocupación 2 y m1 de la T9): un `VALIDATION_FAILED` cuyo motivo NO quedó en su fila (sin fila, o la guarda que no escribe la fila
   * apartada) deja el MISMO aviso DETENIDO; cualquier otro desenlace que no sea «en proceso» deja el periodo «reanudado» si estaba detenido, para
   * que un aviso viejo nunca tape lo que dice la fila.
   */
  const aislado = async (
    trabajo: () => Promise<IssueGlobalResult | null>,
    period?: ClosedPeriod,
    avisar = false,
    // T10, ronda 2 (N2): lo que va ANTES de dejar el aviso (en la cola: moverla al final). Así la última escritura de la fila es anterior al aviso
    // y el panel (`motivoDeLaFila`: aviso más nuevo que la fila ⇒ manda) muestra el motivo de la fila detenida. Ola final (N2-bis): devuelve la
    // fila movida (su marca y su `lastError`), o null, que decide si el aviso de ayer todavía vale.
    antesDelAviso?: () => Promise<FilaMovida | null>,
  ) => {
    let tocadaEn: FilaMovida | null = null
    try {
      let r: IssueGlobalResult | null
      try {
        r = await trabajo()
      } finally {
        tocadaEn = (await antesDelAviso?.()) ?? null
      }
      if (!r) return
      resultados.push(period && !r.period ? { ...r, period } : r)
      if (!avisar || !period) return
      const motivo = (r.reasons ?? []).join(' | ')
      // Ronda 1 (I2): la captura diagnóstica (fila `VALIDATION_FAILED` con su motivo en `lastError`) ya lo dice en su fila; cualquier otro
      // `VALIDATION_FAILED` (sin fila, o una guarda sobre una fila que conserva su estado) deja el aviso.
      if (r.status === 'VALIDATION_FAILED' && (!r.cfdi || r.cfdi.status !== 'VALIDATION_FAILED' || r.cfdi.lastError !== motivo))
        await avisarDetenido(period, motivo, r.status, tocadaEn)
      else if (r.status === 'STAMP_FAILED' && r.cfdi?.falloDefinitivo === true) {
        // T11 (decisión A): el PAC volvió a rechazar el reintento en definitiva. Se reintenta en la siguiente pasada (una por día); mientras, el
        // periodo queda DETENIDO con el motivo del PAC, visible en el panel.
        const delPac = r.cfdi.lastError ?? 'El PAC rechazó la factura global.'
        logger.error(`[cfdiGlobal] emisor ${emisor.id}${etiqueta(period)}: el PAC rechazó la global ${r.cfdi.id}: ${delPac}`)
        await avisarDetenido(period, delPac, r.status, tocadaEn)
      } else if (r.status !== 'SKIPPED') await avisarReanudado(period)
    } catch (err) {
      const crudo = err instanceof Error ? err.message : String(err)
      if (esEnProceso(err)) {
        logger.warn(`[cfdiGlobal] emisor ${emisor.id}${etiqueta(period)}: ${crudo}`)
        resultados.push({ status: 'SKIPPED', reason: crudo, ...(period ? { period } : {}) })
        return
      }
      const status: IssueGlobalStatus = err instanceof ConflictError ? 'DETENIDO' : 'ERROR'
      logger.error(`[cfdiGlobal] emisor ${emisor.id}${etiqueta(period)} ${status}: ${crudo}`)
      // Un `ConflictError` es un texto nuestro, en español; cualquier otro error puede ser un texto técnico: nunca sale al panel.
      // Ronda 1 (m4): sin periodo (la página de pendientes, una fila vieja) el texto no habla «de este periodo».
      const reason = status === 'ERROR' ? (period ? MOTIVO_ERROR_DEL_PERIODO : MOTIVO_ERROR_DE_LA_PASADA) : crudo
      resultados.push({ status, reason, ...(period ? { period } : {}) })
      if (avisar && period) await avisarDetenido(period, reason, status, tocadaEn)
    }
  }
  const base = { emisorId: emisor.id, now: params.now, sandbox: params.sandbox }
  // m2: leer la página también va aislado; si truena, el bucle 2 corre igual y el cursor no se pierde.
  let filas: any[] = []
  let leidas = false
  await aislado(async () => {
    filas = await deps.loadGlobalesSinTimbrar(emisor.id, params.cursor ?? null)
    leidas = true
    return null
  })
  for (const fila of filas) {
    const period = periodoDeLaFila(fila)
    // m1: si el intento no escribió la fila, se mueve al final de la cola (si la escribió, el CAS por `updatedAt` no toca nada). Ronda 2 (N2): se
    // hace ANTES del aviso del periodo (dentro de `aislado`), para que el aviso quede más nuevo que la fila.
    const tocar = async (): Promise<FilaMovida | null> => {
      try {
        // Si la movió, el intento no la escribió: su `lastError` sigue siendo el que se leyó con la página.
        const en = await deps.tocarPendiente(fila)
        return en ? { en, lastError: fila.lastError ?? null } : null
      } catch (err) {
        logger.warn(`[cfdiGlobal] emisor ${emisor.id}: no se pudo mover al final de la cola la global ${fila.id}: ${String(err)}`)
        return null
      }
    }
    if (period) await aislado(() => deps.emitirPeriodo({ ...base, period, key: fila.idempotencyKey }, overrides), period, true, tocar)
    else if (esLlaveViejaCorta(fila)) await aislado(() => resolverFilaVieja(fila, emisor, params, deps), undefined, false, tocar)
    else
      await aislado(
        async () => ({ status: 'VALIDATION_FAILED', cfdi: fila, reasons: [MOTIVO_PERIODO_SIN_DEMOSTRAR] }),
        undefined,
        false,
        tocar,
      )
  }
  const n = PERIODOS_A_REVISAR[emisor.globalPeriodicity as GlobalPeriodicity]
  const vigilados = periodosCerradosRecientes(emisor.globalPeriodicity, params.now, n + PERIODOS_QUE_SALEN_A_VIGILAR)
  for (const period of vigilados.slice(0, n).reverse()) {
    if (resultados.some(r => r.period && mismoPeriodo(r.period, period))) continue
    await aislado(
      async () => {
        if (await deps.findGlobalDelPeriodo(emisor.id, period)) return null // ya tiene principal (timbrada, cancelada o en proceso)
        return deps.emitirPeriodo({ ...base, period, key: llaveDeLaGlobal(emisor.id, period) }, overrides)
      },
      period,
      true,
    )
  }
  // I1 (c): los periodos que acaban de salir de la ventana. Sin principal y con ventas por facturar ⇒ se avisa UNA vez («pídelo a soporte»);
  // nunca se emiten desde aquí (C1-P16 = B).
  let unSoloEmisor: boolean | undefined
  for (const period of vigilados.slice(n)) {
    await aislado(async () => {
      if (await deps.ultimoAvisoDelPeriodo(emisor, period, [AVISO_PERIODO_FUERA_DE_VENTANA])) return null
      if (await deps.findGlobalDelPeriodo(emisor.id, period)) return null
      unSoloEmisor ??= (await deps.contarEmisores(emisor.venueId)) === 1
      if (!(await deps.tieneCandidatos(emisor, period, unSoloEmisor))) return null
      logger.error(`[cfdiGlobal] emisor ${emisor.id}${etiqueta(period)}: ${MOTIVO_PERIODO_FUERA_DE_VENTANA}`)
      await deps.registrarAvisoDelPeriodo(emisor, period, AVISO_PERIODO_FUERA_DE_VENTANA, { motivo: MOTIVO_PERIODO_FUERA_DE_VENTANA })
      return { status: 'DETENIDO', reason: MOTIVO_PERIODO_FUERA_DE_VENTANA }
    }, period)
  }
  const ultima = filas[filas.length - 1]
  if (!leidas) return { resultados, cursor: params.cursor ?? null }
  return {
    resultados,
    cursor: filas.length === PAGINA_DE_PENDIENTES && ultima ? { updatedAt: ultima.updatedAt, id: ultima.id } : null,
  }
}
/** Ronda 1 (I1 c): cuántos periodos, de los que acaban de salir de la ventana, se vigilan (cubre dos días sin job en un emisor diario). */
const PERIODOS_QUE_SALEN_A_VIGILAR = 3
/** Ronda 1 (I1 a): «otra solicitud lo tiene en proceso» = el `ConflictError` con el texto EXACTO del motor; nada más. */
export const esEnProceso = (err: unknown): boolean => err instanceof ConflictError && err.message === PROCESANDO

/**
 * C1-14/C1-22: una fila vieja corta (llave del mes, sin día). Enviada: sólo se consulta al PAC por su identidad (`consultarIntentoCapturado`);
 * si la tiene, se termina tal cual; si no, SE QUEDA reservada (el reloj y la ausencia remota nunca liberan ventas; el motor escala a los 60
 * min) y la pasada dice «en recuperación». No enviada: se anula con el CAS que exige `enviadoAt: null`. La rechazada en definitiva ya no
 * llega aquí (la descarta `globalesSinTimbrar`; si llegara, se salta: no tiene salida y sus ventas ya están libres).
 */
async function resolverFilaVieja(
  fila: any,
  emisor: GlobalEmisor,
  params: { sandbox: boolean; now: Date },
  deps: IssueGlobalDeps,
): Promise<IssueGlobalResult> {
  const { sandbox } = params
  if (fila.falloDefinitivo)
    return { status: 'SKIPPED', reason: 'El PAC rechazó esta factura global de antes del cambio de llaves; sus ventas ya están libres.' }
  if (fila.enviadoAt !== null) {
    const provider = deps.resolveProvider(emisor, { sandbox })
    let recuperada
    try {
      recuperada = await consultarIntentoCapturado(fila, provider, deps.runInTransaction)
    } catch (err) {
      if (esEnProceso(err)) return { status: 'SKIPPED', cfdi: fila, reason: MOTIVO_FILA_VIEJA_EN_RECUPERACION }
      throw err
    }
    if (!recuperada) return { status: 'SKIPPED', cfdi: fila, reason: MOTIVO_FILA_VIEJA_EN_RECUPERACION }
    const shared = { ...deps, findExistingCfdi: deps.findExistingGlobal }
    return {
      ...(await finalizarEmision(fila, recuperada, provider, await deps.loadVenueSlug(emisor.venueId), shared)),
      ...cuentasSinLeer(fila),
    }
  }
  const anulada = await anularFilaViejaConMotivo(fila, params.now)
  if (anulada.resultado === 'ANULADA')
    return { status: 'VALIDATION_FAILED', cfdi: fila, reasons: [anulada.motivo ?? MOTIVO_FILA_VIEJA_ANULADA] }
  // Perdió contra el envío (o la fila cambió): ya no es «nunca enviada»; la siguiente pasada la consulta por su identidad.
  return { status: 'SKIPPED', cfdi: fila, reason: PROCESANDO }
}

export type EstadoDelPeriodo = 'TIMBRADA' | 'SIN_TIMBRAR' | 'SIN_GLOBAL' | 'CANCELADA'
/**
 * C1 (Tarea 10, ronda 1, I1): una global sin timbrar de OTRA periodicidad que la de hoy (el emisor cambió la suya). Sólo para mostrar: nunca se
 * emite desde el panel (su `desde` es de otra periodicidad). `estado`: `APARTADA` (tiene ventas apartadas: reservada o enviada sin respuesta),
 * `RECHAZADA` (el PAC la rechazó en definitiva; sus ventas quedaron libres), `DETENIDA` (captura que no se emitió; no apartó ventas).
 */
export interface GlobalDeOtraPeriodicidad {
  cfdiId: string
  /** La periodicidad GUARDADA en la fila (la del documento), p. ej. `BIMESTRAL`. */
  periodicidad: GlobalPeriodicity
  desde: string
  hasta: string
  meses: string
  anio: number
  estado: 'APARTADA' | 'RECHAZADA' | 'DETENIDA'
  folio: string | null
  motivo: string | null
  /** El id de su principal si es una complementaria; `null` en una principal. */
  complementariaDe: string | null
}
export interface PeriodoDeLaGlobal {
  desde: string
  hasta: string
  meses: string
  anio: number
  estado: EstadoDelPeriodo
  cfdiId: string | null
  folio: string | null
  motivo: string | null
  /** T11: con la principal TIMBRADA (STAMPED) o CANCELADA, cuántas ventas entrarían hoy en su complementaria (M9); si no, `null`. */
  corregidasPendientes: { n: number; completo: boolean } | null
  /** T11: las complementarias de la principal (timbrada, en cancelación o cancelada), la más vieja primero; si no, `[]`. */
  complementarias: Array<{
    cfdiId: string
    folio: string | null
    estado: 'TIMBRADA' | 'CANCELADA' | 'SIN_TIMBRAR'
    /** Ronda 1 (m2): el motivo de una complementaria SIN_TIMBRAR (p. ej. el rechazo del PAC); ausente en las demás. */
    motivo?: string | null
  }>
}

/** T11: el estado de una complementaria para el panel (la misma regla que la principal: en cancelación sigue timbrada). */
const estadoDeLaComplementaria = (c: { status: string }): 'TIMBRADA' | 'CANCELADA' | 'SIN_TIMBRAR' => {
  const e = estadoDeLaPrincipal(c)
  return e === 'SIN_GLOBAL' ? 'SIN_TIMBRAR' : e
}
/** Ronda 1 (m1): ¿la fila tiene sus ventas apartadas? (la misma regla que `CFDI_VIVO` para una fila sin timbrar). */
const apartaSusVentas = (f: { status: string; falloDefinitivo?: boolean | null }) =>
  f.status !== 'VALIDATION_FAILED' && !(f.status === 'STAMP_FAILED' && f.falloDefinitivo === true)
/**
 * Ronda 1 (I2): el motivo de una fila sin timbrar para el panel. El aviso DETENIDO sólo manda si es MÁS NUEVO que la última escritura de la
 * fila (un rechazo del PAC o un intento manual posterior escriben la fila y su `lastError` vuelve a mandar); si no, el `lastError`.
 */
function motivoDeLaFila(fila: any, aviso: { action: string; motivo: string | null; createdAt?: Date } | null): string | null {
  const escrita = fila?.updatedAt ? new Date(fila.updatedAt).getTime() : NaN
  const avisada = aviso?.createdAt ? new Date(aviso.createdAt).getTime() : NaN
  // `>=`: el aviso que se deja justo después de la última escritura (en el mismo milisegundo) es el más nuevo (ronda 2, N2).
  if (aviso?.action === AVISO_PERIODO_DETENIDO && avisada >= escrita) return aviso.motivo ?? null
  return fila?.lastError ?? null
}
/** Ronda 1 (I1): el estado de una global de otra periodicidad (sólo para mostrar). */
const estadoDeOtra = (f: { status: string; falloDefinitivo?: boolean | null }): GlobalDeOtraPeriodicidad['estado'] =>
  f.status === 'VALIDATION_FAILED' ? 'DETENIDA' : apartaSusVentas(f) ? 'APARTADA' : 'RECHAZADA'

/** El estado de la global principal de un periodo para el panel. Una cancelación en curso sigue timbrada hasta que se confirme. */
function estadoDeLaPrincipal(fila: any | null): EstadoDelPeriodo {
  if (!fila) return 'SIN_GLOBAL'
  if (fila.status === 'STAMPED' || fila.status === 'CANCEL_REQUESTED') return 'TIMBRADA'
  if (fila.status === 'CANCELLED') return 'CANCELADA'
  return 'SIN_TIMBRAR'
}

/**
 * Ola final de C1 (principio del founder: «apagado se VE y se EXPLICA»): la factura global de Avoqado está APAGADA para este RFC cuando
 * ninguna de sus ventas puede entrar por configuración: ningún comercio suyo está en la global (`configQueEntraALaGlobal`) Y las ventas
 * cobradas fuera de la terminal tampoco (`fueraDeTerminalPedida`: el interruptor apagado, O más de un RFC en el negocio, donde son
 * `SIN_EMISOR` — agregado del coordinador). Es el estado de Testarudo el día de publicar (1 RFC, efectivo ON, 0 comercios en la global,
 * interruptor de fábrica). `unSoloEmisor`: si quien llama ya lo contó (el listado), no se vuelve a contar; con el interruptor apagado no se cuenta.
 */
export async function estaApagadaLaGlobal(
  emisor: Pick<GlobalEmisor, 'id' | 'venueId' | 'includeOffTerminalSalesInGlobal'>,
  deps: Pick<IssueGlobalDeps, 'comercioEnLaGlobal' | 'contarEmisores'>,
  unSoloEmisor?: boolean,
): Promise<boolean> {
  if (emisor.includeOffTerminalSalesInGlobal) {
    const uno = unSoloEmisor ?? (await deps.contarEmisores(emisor.venueId)) === 1
    if (fueraDeTerminalPedida(emisor, uno)) return false
  }
  return !(await deps.comercioEnLaGlobal(emisor.id))
}

/**
 * C1 (Tarea 8, C1-P16 = B): los periodos cerrados recientes (`PERIODOS_A_REVISAR`) del emisor, el más reciente primero, cada uno con su
 * global principal (por su llave): `STAMPED` ⇒ TIMBRADA; `CANCELLED` ⇒ CANCELADA; otra ⇒ SIN_TIMBRAR con su `lastError` como motivo; ninguna ⇒
 * SIN_GLOBAL. Sin paginación hacia atrás: un periodo más viejo se pide a soporte. `corregidasPendientes` y `complementarias` los llena la
 * Tarea 11.
 */
export async function periodosDeLaGlobal(
  p: { venueId: string; emisorId: string; now: Date },
  overrides: Partial<IssueGlobalDeps> = {},
): Promise<{
  periodos: PeriodoDeLaGlobal[]
  otrasPeriodicidades: { globales: GlobalDeOtraPeriodicidad[]; completo: boolean }
  /** Ola final de C1: `estaApagadaLaGlobal` (aditivo; el dashboard muestra «apagada» en vez de periodos con «Emitir»). */
  globalApagada: boolean
}> {
  const deps = { ...defaultDeps, ...overrides }
  const emisor = await deps.loadEmisor(p.emisorId)
  if (!emisor || emisor.venueId !== p.venueId) throw new Error(`FiscalEmisor ${p.emisorId} not found`)
  const periodos: PeriodoDeLaGlobal[] = []
  let unSoloEmisor: boolean | undefined
  for (const q of periodosCerradosRecientes(emisor.globalPeriodicity, p.now)) {
    const encontrada = await deps.findGlobalDelPeriodo(emisor.id, q)
    const fila = encontrada && encontrada.fiscalEmisorId === emisor.id ? encontrada : null
    const estado = estadoDeLaPrincipal(fila)
    // T11: las complementarias de una principal timbrada o cancelada (también con su cancelación en trámite: ya las tiene) y «cuántas ventas
    // entrarían» en la siguiente —sólo donde se puede emitir (principal STAMPED o CANCELLED, como exige `emitirGlobalComplementaria`)—.
    const existentes = fila && (estado === 'TIMBRADA' || estado === 'CANCELADA') ? await deps.complementariasDe(fila) : []
    const complementarias = existentes.map(c => {
      const e = estadoDeLaComplementaria(c)
      // Ronda 1 (m2): la no timbrada dice por qué (el rechazo del PAC, la guarda…); las demás no llevan `motivo`.
      return { cfdiId: c.id, folio: c.folio, estado: e, ...(e === 'SIN_TIMBRAR' ? { motivo: c.lastError ?? null } : {}) }
    })
    let corregidasPendientes: { n: number; completo: boolean } | null = null
    // Sólo donde `emitirGlobalComplementaria` sí emite: principal STAMPED de protocolo 1 o CANCELADA (ronda 1, I1: nunca una heredada timbrada).
    if (fila && admiteComplementaria(fila)) {
      unSoloEmisor ??= (await deps.contarEmisores(emisor.venueId)) === 1
      // Ronda 1 (I4): con la abierta sin enviar como `self`, para que una reserva que tronó antes del envío se vea y se retome desde aquí.
      corregidasPendientes = await deps.contarCorregidasPendientes(
        emisor,
        q,
        unSoloEmisor,
        abiertaSinEnviar(fila.idempotencyKey, existentes),
      )
    }
    // Ronda 1 (I1 b): un periodo sin global puede estar DETENIDO antes de reservar; su motivo vive en el último aviso (una consulta por periodo).
    // T10, ronda 1 (I2): en uno SIN_TIMBRAR, el aviso DETENIDO sólo manda si es más nuevo que la última escritura de la fila (`motivoDeLaFila`).
    const aviso =
      estado === 'SIN_GLOBAL' || estado === 'SIN_TIMBRAR'
        ? await deps.ultimoAvisoDelPeriodo(emisor, q, [AVISO_PERIODO_DETENIDO, AVISO_PERIODO_REANUDADO])
        : null
    const detenido = aviso?.action === AVISO_PERIODO_DETENIDO ? (aviso.motivo ?? null) : null
    periodos.push({
      desde: q.periodStart.toISOString(),
      hasta: q.periodEnd.toISOString(),
      meses: q.meses,
      anio: q.anio,
      estado,
      cfdiId: fila?.id ?? null,
      folio: fila?.folio ?? null,
      motivo: estado === 'SIN_TIMBRAR' ? motivoDeLaFila(fila, aviso) : detenido,
      corregidasPendientes,
      complementarias,
    })
  }
  // T10 (m1 de la T9) y ronda 1 (I1): las globales sin timbrar de OTRA periodicidad (el emisor cambió la suya) no caen en ninguno de los
  // periodos de arriba ni se pueden emitir con su `desde` (se resolvería con la periodicidad de HOY). Van APARTE, sólo para mostrar: su periodo
  // GUARDADO, su estado y su motivo; también las rechazadas (m5) y las complementarias pendientes de una principal de otra periodicidad.
  // Ronda 2 (N5 b): `completo` cuenta sólo las que se muestran: si en una página se saltan filas (sin periodo demostrable, p. ej. una vieja corta),
  // se pide la siguiente (a lo más `PAGINAS_DE_OTRAS`) hasta tener una de más o agotar la consulta.
  type Valida = { fila: any; q: ClosedPeriod; periodicidad: GlobalPeriodicity }
  const validas: Valida[] = []
  let despues: { createdAt: Date; id: string } | null = null
  let agotada = false
  for (let pagina = 0; pagina < PAGINAS_DE_OTRAS && !agotada && validas.length <= MAX_OTRAS_PERIODICIDADES; pagina++) {
    const filas = await deps.globalesDeOtraPeriodicidad(emisor.id, satDePeriodicidad(emisor.globalPeriodicity), despues)
    agotada = filas.length <= MAX_OTRAS_PERIODICIDADES
    for (const fila of filas) {
      const q = fila.fiscalEmisorId === emisor.id ? periodoDeLaFila(fila) : null
      const periodicidad = q ? periodicidadDeCodigo(q.satPeriodicidad) : null
      if (q && periodicidad) validas.push({ fila, q, periodicidad })
    }
    const ultima = filas[filas.length - 1]
    despues = ultima ? { createdAt: ultima.createdAt, id: ultima.id } : null
  }
  const globales: GlobalDeOtraPeriodicidad[] = []
  for (const { fila, q, periodicidad } of validas.slice(0, MAX_OTRAS_PERIODICIDADES)) {
    const complementariaDe =
      esObjeto(fila.entrada) && typeof fila.entrada.complementariaDe === 'string' ? (fila.entrada.complementariaDe as string) : null
    // Una complementaria comparte el periodo (y sus avisos) con su principal: su motivo es el de su fila; si espera a una persona, eso.
    const motivo = complementariaDe
      ? (fila.lastError ?? (fila.status === 'STAMPING' && fila.enviadoAt === null ? MOTIVO_COMPLEMENTARIA_DEL_JOB : null))
      : motivoDeLaFila(fila, await deps.ultimoAvisoDelPeriodo(emisor, q, [AVISO_PERIODO_DETENIDO, AVISO_PERIODO_REANUDADO]))
    globales.push({
      cfdiId: fila.id,
      periodicidad,
      desde: q.periodStart.toISOString(),
      hasta: q.periodEnd.toISOString(),
      meses: q.meses,
      anio: q.anio,
      estado: estadoDeOtra(fila),
      folio: fila.folio ?? null,
      motivo,
      complementariaDe,
    })
  }
  return {
    periodos,
    otrasPeriodicidades: { globales, completo: validas.length <= MAX_OTRAS_PERIODICIDADES && agotada },
    globalApagada: await estaApagadaLaGlobal(emisor, deps, unSoloEmisor),
  }
}

// ── C1 · Tarea 12: el listado de las ventas que no entraron a la global (Codex C1-9, C1-18, C1-32, C1-41, C1-49) ──────────────────────
/** D7 (P13): tope del total exacto del listado y de sus corregidas pendientes; más allá, `completo: false` («al menos N»). */
export const MAX_REVISAR_TOTALES = 500
/**
 * La regla de la heredada (T11, ronda 1, I1) también en el listado: una global principal de antes del registro de sus ventas
 * (`protocoloIva !== 1`) y timbrada documenta ventas que su fila no nombra (sin manifiesto), así que el listado no puede decir cuáles entraron.
 */
export const MOTIVO_LISTADO_HEREDADA =
  'Esta factura global es de antes del registro de sus ventas: no se puede saber cuáles entraron. Pide a soporte la lista de las que quedaron fuera.'
/**
 * Ajuste del controlador (M6 de la T5): con un solo RFC en el negocio, una venta cobrada con un comercio configurado al RFC de OTRO negocio
 * (`AJENA`) no entra a ninguna global ni a ningún listado. Se lista aquí como `COMERCIO_FUERA` con este detalle.
 */
export const DETALLE_OTRA_SUCURSAL =
  'Se cobró con un comercio configurado al RFC de otra sucursal, así que no entra a la factura global de este RFC ni a la de esa sucursal. Revisa la configuración fiscal del comercio.'
/** Una venta del periodo que no entra a la global de este emisor, con su motivo. */
export interface VentaExcluidaDeLaGlobal {
  orderId: string
  folio: string
  cobradoCents: number
  motivo: MotivoExclusionGlobal
  texto: string
  detalle: string
}
export interface ListadoDeExcluidas {
  periodo: { meses: string; anio: number; desde: Date; hasta: Date }
  estadoDelPeriodo: EstadoDelPeriodo
  totales: { porMotivo: ExcluidasPorMotivo; total: number; completo: boolean; revisadas: number } | null
  corregidasPendientes: { n: number; completo: boolean } | null
  ultimaCaptura: { al: Date; excluidas: ExcluidasPorMotivo } | null
  excluidas: VentaExcluidaDeLaGlobal[]
  siguiente: string | null
  revisadas: number
  /** Ola final de C1: `estaApagadaLaGlobal` (aditivo): con `true`, lo que no entró es porque la global de Avoqado está apagada para este RFC. */
  globalApagada: boolean
}
/** Las filas: páginas de 50 órdenes por `id` (cursor); como mucho `MAX_REVISADAS` órdenes revisadas por llamada. */
const PAGINA_DE_EXCLUIDAS = 50
const MAX_REVISADAS = 200
type MotivoDeLaVenta = { motivo: MotivoExclusionGlobal; detalle: string }
type OrdenDelListado = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>
/** Lo que decide el predicado del listado, igual para filas y totales. */
interface ContextoDelListado {
  emisor: GlobalEmisor
  unSoloEmisor: boolean
  period: ClosedPeriod
  /** T11 (ronda 1, I4): la complementaria abierta y nunca enviada; sus ventas cuentan (su recaptura las tomaría). */
  self: string | undefined
  /** `CORREGIDA_DESPUES` sólo donde la principal admite complementaria (STAMPED de protocolo 1 o CANCELLED). */
  conCorregidas: boolean
}

/**
 * Lo de CONTENIDO de órdenes candidatas ya cargadas con `ORDER_SELECT` (el mismo `select` de la captura): `ticketParaGlobal` con sus filas
 * de descuento COMPLETAS. Una que entraría hoy es `CORREGIDA_DESPUES` sólo si su principal admite complementaria; si no, no tiene motivo
 * (entrará a la principal cuando se emita). La comparten las filas y el recorrido de los totales: una sola regla.
 */
async function motivosDeContenido(ordenes: OrdenDelListado[], conCorregidas: boolean): Promise<Map<string, MotivoDeLaVenta>> {
  const motivos = new Map<string, MotivoDeLaVenta>()
  for (const o of ordenes) {
    const t = ticketParaGlobal({ ...o, orderDiscounts: await filasDeDescuentoCompletas(prisma, o.id, o.orderDiscounts) })
    if (!t.ok) motivos.set(o.id, { motivo: t.motivo, detalle: t.detalle })
    else if (conCorregidas) motivos.set(o.id, { motivo: 'CORREGIDA_DESPUES', detalle: TEXTO_EXCLUSION_GLOBAL.CORREGIDA_DESPUES })
  }
  return motivos
}

/**
 * El motivo de cada venta de una página de ids (ya dentro de la ventana del listado), con el predicado ÚNICO del listado: configuración
 * (`MOTIVOS_DE_CONFIGURACION`; con un solo RFC, `AJENA` = otra sucursal) → `YA_EXTRAIDO` → contenido. Una venta, una clase.
 */
async function motivosDeUnaPagina(ctx: ContextoDelListado, ids: string[]): Promise<Map<string, MotivoDeLaVenta>> {
  const motivos = new Map<string, MotivoDeLaVenta>()
  const deLaPagina = async (w: Prisma.OrderWhereInput, cuales: string[]) =>
    (await prisma.order.findMany({ where: { AND: [{ id: { in: cuales } }, w] }, select: { id: true }, take: cuales.length })).map(o => o.id)
  // Las clases de configuración (con un solo RFC, también la otra sucursal): la MISMA lista que cuentan los totales y la captura.
  for (const c of clasesDeConfiguracion(ctx.emisor, ctx.unSoloEmisor))
    for (const id of await deLaPagina(c.where, ids)) motivos.set(id, { motivo: c.motivo, detalle: c.detalle })
  // C3-15 / C1-45: una venta extraída (viva o cancelada) es YA_EXTRAIDO y su contenido no se revisa.
  const candidatas = ids.filter(id => !motivos.has(id))
  if (candidatas.length)
    for (const id of await deLaPagina(EXTRAIDO, candidatas))
      motivos.set(id, { motivo: 'YA_EXTRAIDO', detalle: TEXTO_EXCLUSION_GLOBAL.YA_EXTRAIDO })
  const porContenido = ids.filter(id => !motivos.has(id))
  if (porContenido.length) {
    const ordenes = await prisma.order.findMany({
      where: { id: { in: porContenido } },
      select: ORDER_SELECT,
      orderBy: { id: 'asc' },
      take: porContenido.length,
    })
    for (const [id, m] of await motivosDeContenido(ordenes, ctx.conCorregidas)) motivos.set(id, m)
  }
  return motivos
}

/**
 * Los totales del listado (sólo la primera página), con el MISMO predicado que las filas: configuración exacta (`count`), otra sucursal y
 * `YA_EXTRAIDO` (`count`), y lo de contenido + `CORREGIDA_DESPUES` recorriendo `candidateWhere` (los filtros de la captura) hasta
 * `MAX_REVISAR_TOTALES`. Cada venta cae en UNA clase; la estadística de la captura NUNCA se suma aquí (C1-18).
 */
async function totalesDelListado(
  ctx: ContextoDelListado,
  ventana: Prisma.OrderWhereInput,
): Promise<NonNullable<ListadoDeExcluidas['totales']>> {
  // Configuración, con la otra sucursal incluida (`clasesDeConfiguracion`, ola final m2/m3 de la T12): el mismo conteo que congela la captura.
  const porMotivo: ExcluidasPorMotivo = {
    ...(await contarExcluidasPorConfiguracion(ctx.emisor, ctx.period, ctx.unSoloEmisor, ctx.self)),
  }
  const yaExtraidas = await prisma.order.count({
    where: { AND: [ventana, dondePertenece(ctx.emisor, ctx.unSoloEmisor, 'CANDIDATA'), EXTRAIDO] },
  })
  if (yaExtraidas) porMotivo.YA_EXTRAIDO = yaExtraidas
  const candidatas = candidateWhere(ctx.emisor, ctx.period, ctx.unSoloEmisor, ctx.self)
  let revisadas = 0
  let completo = true
  let despues: string | undefined
  for (;;) {
    const resta = MAX_REVISAR_TOTALES - revisadas
    // Una de más que las que caben: si llega, hubo más que revisar (`completo: false`, «al menos N»).
    const pide = Math.min(PAGINA_DE_EXCLUIDAS, resta + 1)
    const pagina = await prisma.order.findMany({
      where: { AND: [candidatas, ...(despues ? [{ id: { gt: despues } }] : [])] },
      select: ORDER_SELECT,
      orderBy: { id: 'asc' },
      take: pide,
    })
    const caben = pagina.slice(0, resta)
    for (const [, m] of await motivosDeContenido(caben, ctx.conCorregidas)) sumarExcluida(porMotivo, m.motivo)
    revisadas += caben.length
    if (pagina.length > resta) {
      completo = false
      break
    }
    if (pagina.length < pide) break
    despues = pagina[pagina.length - 1].id
  }
  return { porMotivo, total: Object.values(porMotivo).reduce((s, n) => s + (n ?? 0), 0), completo, revisadas }
}

/**
 * C1 (§4.3, Codex C1-9/C1-18): las ventas de un periodo que no entran a la global de este emisor. Filas y totales con el MISMO predicado:
 * en la ventana fiscal (sin global viva ni factura individual viva), no `AJENA` (salvo, con un solo RFC, la de otra sucursal), y con motivo
 * —de configuración; si no, `YA_EXTRAIDO`; si no, de contenido; si no, `CORREGIDA_DESPUES` donde la principal admite complementaria—. Sin
 * motivo (entrará a la principal cuando se emita) no aparece.
 * El periodo: el GUARDADO de una global que ya existe (`principalId`, en cualquier estado: C1-32, C1-41); si no, uno RECIENTE (`desde`,
 * C1-P16 = B); por omisión, el último cerrado. `totales` y `corregidasPendientes` sólo en la primera página (sin `cursor`); `ultimaCaptura`
 * es la estadística HISTÓRICA de la captura de la principal, aparte.
 */
export async function listarExcluidasDeLaGlobal(
  p: {
    venueId: string
    emisorId: string
    now: Date
    principalId?: string
    desde?: string
    cursor?: string
    limite?: number
  },
  overrides: Partial<IssueGlobalDeps> = {},
): Promise<ListadoDeExcluidas> {
  const deps = { ...defaultDeps, ...overrides }
  let emisor: GlobalEmisor
  let period: ClosedPeriod
  let principal: any | null
  if (p.principalId) {
    // C1-32 / C1-41: sólo identidad (emisor, principal, periodo demostrable); cualquier estado.
    ;({ emisor, principal, period } = await globalPrincipalPorId(deps, {
      venueId: p.venueId,
      emisorId: p.emisorId,
      principalId: p.principalId,
    }))
  } else {
    const encontrado = await deps.loadEmisor(p.emisorId)
    if (!encontrado || encontrado.venueId !== p.venueId) throw new Error('Emisor fiscal not found')
    emisor = encontrado
    const q = p.desde
      ? periodoRecienteQueEmpiezaEn(emisor.globalPeriodicity, new Date(p.desde), p.now)
      : closedPeriodFor(emisor.globalPeriodicity, p.now)
    if (!q) throw new BadRequestError(MOTIVO_PERIODO_VIEJO)
    period = q
    const fila = await deps.findGlobalDelPeriodo(emisor.id, period)
    principal = fila && fila.fiscalEmisorId === emisor.id ? fila : null
  }
  // La regla de la heredada (T11, ronda 1, I1): timbrada, documenta ventas que su fila no nombra; el listado no puede decir cuáles.
  if (principal && principal.protocoloIva !== 1 && (principal.status === 'STAMPED' || principal.status === 'CANCEL_REQUESTED'))
    throw new BadRequestError(MOTIVO_LISTADO_HEREDADA)
  const conCorregidas = !!principal && admiteComplementaria(principal)
  const ctx: ContextoDelListado = {
    emisor,
    period,
    conCorregidas,
    unSoloEmisor: (await deps.contarEmisores(emisor.venueId)) === 1,
    // T10, ronda 2 (m4 de la T12): con la PRINCIPAL reservada y nunca enviada, su recaptura toma también SUS ventas (`self`, el mismo criterio
    // que `vistaPreviaPrincipal` y el motor): el listado cuenta el mismo conjunto que la vista previa y el panel.
    self: conCorregidas
      ? abiertaSinEnviar(principal.idempotencyKey, await deps.complementariasDe(principal))
      : principal && principal.enviadoAt === null
        ? principal.id
        : undefined,
  }
  const ventana = ventanaFiscal(emisor.venueId, period, ctx.self)
  const totales = p.cursor ? null : await totalesDelListado(ctx, ventana)

  const filas: Prisma.OrderWhereInput = {
    AND: [ventana, ...(ctx.unSoloEmisor ? [] : [{ NOT: dondePertenece(emisor, false, 'AJENA') }])],
  }
  const limite = Math.min(Math.max(Math.trunc(p.limite ?? PAGINA_DE_EXCLUIDAS), 1), PAGINA_DE_EXCLUIDAS)
  const excluidas: VentaExcluidaDeLaGlobal[] = []
  let cursor = p.cursor
  let revisadas = 0
  let hayMas = true
  while (excluidas.length < limite && revisadas < MAX_REVISADAS && hayMas) {
    // C1-49: el folio sale de la PÁGINA, para toda clase (las de configuración y la extraída no cargan la orden).
    const pagina = await prisma.order.findMany({
      where: { AND: [filas, ...(cursor ? [{ id: { gt: cursor } }] : [])] },
      select: { id: true, orderNumber: true },
      orderBy: { id: 'asc' },
      take: PAGINA_DE_EXCLUIDAS,
    })
    hayMas = pagina.length === PAGINA_DE_EXCLUIDAS
    if (!pagina.length) break
    const motivos = await motivosDeUnaPagina(
      ctx,
      pagina.map(o => o.id),
    )
    const conMotivo = pagina.filter(o => motivos.has(o.id)).map(o => o.id)
    // El importe: TODOS los cobros elegibles de la venta (el mismo `COBRO` de la pertenencia y de la captura), sumados en la base.
    const cobrado = new Map<string, number>(
      conMotivo.length
        ? (
            await prisma.payment.groupBy({
              by: ['orderId'],
              where: { orderId: { in: conMotivo }, AND: [COBRO] },
              _sum: { amount: true },
            })
          ).map(g => [g.orderId, aCentavos(g._sum.amount)])
        : [],
    )
    for (const [i, o] of pagina.entries()) {
      revisadas++
      cursor = o.id
      const m = motivos.get(o.id)
      if (m)
        excluidas.push({
          orderId: o.id,
          folio: o.orderNumber ?? o.id,
          cobradoCents: cobrado.get(o.id) ?? 0,
          motivo: m.motivo,
          texto: TEXTO_EXCLUSION_GLOBAL[m.motivo],
          detalle: m.detalle,
        })
      if (excluidas.length === limite) {
        hayMas = hayMas || i < pagina.length - 1
        break
      }
    }
  }
  const e: unknown = principal?.entrada
  return {
    periodo: { meses: period.meses, anio: period.anio, desde: period.periodStart, hasta: period.periodEnd },
    estadoDelPeriodo: estadoDeLaPrincipal(principal),
    totales,
    // D7: lo encontrado entre las primeras `MAX_REVISAR_TOTALES` (C1-27); `completo: false` ⇒ «al menos N». Ola final (m6 de la T12): sólo donde
    // se puede emitir la complementaria (`conCorregidas`, la misma regla del panel); si no, `null` (antes `{ n: 0 }` con la principal en cancelación).
    corregidasPendientes: totales && ctx.conCorregidas ? { n: totales.porMotivo.CORREGIDA_DESPUES ?? 0, completo: totales.completo } : null,
    // Ola final (m5 de la T12): la fecha es la de la CAPTURA (`capturadaAl` de la entrada), no el `updatedAt` de la fila; sin ella, `null`.
    ultimaCaptura:
      esObjeto(e) && e.version === 2 && esObjeto(e.excluidas) && typeof e.capturadaAl === 'string' && !isNaN(Date.parse(e.capturadaAl))
        ? { al: new Date(e.capturadaAl), excluidas: e.excluidas as ExcluidasPorMotivo }
        : null,
    excluidas,
    siguiente: hayMas ? (cursor ?? null) : null,
    revisadas,
    globalApagada: await estaApagadaLaGlobal(emisor, deps, ctx.unSoloEmisor),
  }
}

/** Los conteos de una entrada para el resultado: tickets dentro, excluidas por IVA (campo viejo) y por motivo (v1: `{}`). */
const cuentasDe = (e: EntradaGlobal) => ({
  candidateCount: e.ordenes.length,
  excluidasPorIvaMixto: e.excluidasPorIvaMixto,
  excluidas: e.version === 2 ? e.excluidas : {},
})
/** Ronda 1 (M4): los conteos de una global que el PAC ya timbró: de su entrada si pasa el lector; si no, sin leerla (y se avisa). */
function cuentasDeLaRecuperada(cfdi: any) {
  try {
    return cuentasDe(leerGlobal(cfdi, 'PARA_ENVIAR'))
  } catch {
    logger.warn(`[cfdiGlobal] la global ${cfdi.id} la timbró el PAC pero su entrada no pasa el lector; se finalizó con su UUID. Revísala.`)
    return cuentasSinLeer(cfdi)
  }
}
/** Los conteos de una fila que no se vuelve a leer (timbrada o rechazada en definitiva): lo que diga su entrada, sin validarla. */
const cuentasSinLeer = (cfdi: any) => ({
  candidateCount: 0,
  excluidasPorIvaMixto: cfdi.entrada?.excluidasPorIvaMixto ?? 0,
  excluidas: (cfdi.entrada?.excluidas ?? {}) as ExcluidasPorMotivo,
})

/**
 * El motor de la global de UN periodo con su llave. Orden de las guardas (el plan no lo fija; T9 y T11 lo documentan aquí):
 *  1. CSD activo; 2. la fila de la llave (de este emisor; timbrada ⇒ se devuelve; heredada ⇒ su camino; otros estados ⇒ «procesando»);
 *  3. T11 (C1-24): la guarda del job para la COMPLEMENTARIA; 4. la recuperación por identidad de lo ENVIADO (M4 de la T7; también lo rechazado
 *  en definitiva: decisión A); 5. T9: bimestral sólo con 621, y 6. T11 (C1-33/C1-37): el año, las dos sólo si el flujo va a capturar o
 *  recapturar; 7. candidatos, captura (cuadre al centavo) y envío.
 */
async function emitirGlobalDelPeriodo(
  emisor: GlobalEmisor,
  deps: IssueGlobalDeps,
  params: { sandbox: boolean; period: ClosedPeriod; key: string; now: Date; complementariaDe?: string },
): Promise<IssueGlobalResult> {
  if (emisor.csdStatus !== 'ACTIVE') return { status: 'SKIPPED', reason: 'CSD inactivo' }
  const { period, key, complementariaDe } = params
  const shared = { ...deps, findExistingCfdi: deps.findExistingGlobal }
  let cfdi = await deps.findExistingGlobal(key)
  if (cfdi && (cfdi.venueId !== emisor.venueId || cfdi.fiscalEmisorId !== emisor.id)) throw new Error('Emisor fiscal not found')
  // Ronda 1 de la T11 (m4): ya estaba timbrada: no se emitió nada ahora (quien llama no audita ni dice «emitida»).
  if (cfdi?.status === 'STAMPED') return { status: 'STAMPED', yaTimbrada: true, cfdi, period, ...cuentasSinLeer(cfdi) }
  if (cfdi && cfdi.protocoloIva === null) return emitirGlobalLegacy(cfdi, emisor, period, deps, params.sandbox)
  if (cfdi && !['STAMPING', 'STAMP_FAILED', 'VALIDATION_FAILED'].includes(cfdi.status)) throw new ConflictError(PROCESANDO)
  // T11: la complementaria que se pide es la de ESTA principal (la llave sale de la suya; la entrada lo congela).
  const deLaFila = esObjeto(cfdi?.entrada) ? cfdi.entrada.complementariaDe : undefined
  if (complementariaDe && deLaFila !== undefined && deLaFila !== complementariaDe) throw new ConflictError(MOTIVO_COMPLEMENTARIA_INVALIDA)
  // 🔴 T11 (C1-P12, Codex C1-24): el job NUNCA emite una complementaria. Sólo la persona pasa `complementariaDe` (`emitirGlobalComplementaria`);
  // sin él —la pasada del job, que manda cada fila pendiente con su propia llave— lo ya ENVIADO sólo se RECUPERA por su identidad (si el PAC
  // lo tiene, se termina tal cual); nunca se reserva, se captura, se recaptura ni se envía.
  if (!complementariaDe && (esLlaveComplementaria(key) || deLaFila !== undefined)) {
    if (cfdi && cfdi.enviadoAt !== null) {
      const provider = deps.resolveProvider(emisor, { sandbox: params.sandbox })
      const recovered = await consultarIntentoCapturado(cfdi, provider, deps.runInTransaction)
      if (recovered)
        return {
          ...(await finalizarEmision(cfdi, recovered, provider, await deps.loadVenueSlug(emisor.venueId), shared)),
          period,
          ...cuentasDeLaRecuperada(cfdi),
        }
    }
    return {
      status: 'SKIPPED',
      reason: MOTIVO_COMPLEMENTARIA_DEL_JOB,
      period,
      ...(cfdi ? { cfdi, ...cuentasSinLeer(cfdi) } : { candidateCount: 0, excluidasPorIvaMixto: 0, excluidas: {} }),
    }
  }
  if (cfdi) {
    // C1-12: una `VALIDATION_FAILED` nunca se envió: se lee en DIAGNÓSTICO (puede ser la captura que no cuadró) y va directo a recapturar.
    // 🔴 Ola final (I2 de la revisión final): si su entrada ya NO pasa el lector (la regla del PAC —6b— o la cota de B3a cambiaron desde que se
    // guardó, o alguien la tocó a mano), no se detiene en «revisión de soporte»: una diagnóstica nunca se envió ni aparta ventas, y la recaptura
    // de abajo relee las órdenes desde cero bajo los candados (su manifiesto sale de la tabla, no de la entrada) y vuelve a validar en memoria.
    // Detenerla dejaba el periodo sin global hasta que soporte borrara la fila. Queda el aviso en el log (C1-40: que se note) y se sigue.
    if (cfdi.status === 'VALIDATION_FAILED') {
      try {
        leerGlobal(cfdi, 'DIAGNOSTICO')
      } catch (err: unknown) {
        logger.warn(
          `[cfdiGlobal] la diagnóstica ${cfdi.id} (${cfdi.idempotencyKey}) no pasa el lector (${err instanceof Error ? err.message : String(err)}); se recaptura`,
        )
      }
    } else if (cfdi.enviadoAt !== null) {
      // Ronda 1 (M4): primero se le pregunta al PAC por la identidad del intento; lo que el PAC timbró manda y se finaliza con su UUID aunque
      // la entrada ya no pase el lector (`finalizarEmision` no la usa). Sin respuesta, la enviada lanza «procesando» (nunca se reenvía).
      // T8 (re-revisión de la T7, a): SÓLO si alguna vez se envió. El CAS del envío (`cfdi.service.ts`, `enviarIntentoCapturado`) pone
      // `enviadoAt` ANTES del POST, así que una fila con `enviadoAt: null` nunca llegó al PAC: se recaptura sin preguntarle (un PAC caído no
      // la deja «procesando») y su entrada vieja se descarta sin leerla. La lectura en PARA_ENVIAR queda sólo para lo que se va a enviar.
      // 🔴 Decisión A del founder (7-oct; reemplaza C1-38 «se detiene y va a soporte»): la ENVIADA y rechazada en definitiva también se consulta
      // aquí por la identidad del intento anterior (`key#n`): con UUID se finaliza; si el PAC no responde, «procesando» sin reenviar; si
      // confirma que no existe (`consultarIntentoCapturado` devuelve null SÓLO para la rechazada), se recaptura abajo con `attempts + 1` ⇒
      // identidad NUEVA (`key#n+1`). Nunca se reenvía la MISMA identidad.
      const provider = deps.resolveProvider(emisor, { sandbox: params.sandbox })
      const recovered = await consultarIntentoCapturado(cfdi, provider, deps.runInTransaction)
      if (recovered)
        return {
          ...(await finalizarEmision(cfdi, recovered, provider, await deps.loadVenueSlug(emisor.venueId), shared)),
          period,
          ...cuentasDeLaRecuperada(cfdi),
        }
    }
  }
  // Después de la recuperación sólo llega lo que se va a CAPTURAR o RECAPTURAR: sin fila, una fila que nunca se envió, o (decisión A) la
  // rechazada en definitiva que el PAC confirmó que no tiene. Una enviada incierta nunca llega aquí (la consulta lanza «procesando»).
  if (!cfdi || cfdi.enviadoAt === null || cfdi.falloDefinitivo === true) {
    // C1 · Tarea 9 (Codex C1-4, C1-19): la periodicidad del DOCUMENTO (la de este periodo, no la configurada hoy) contra el régimen ACTUAL del
    // emisor, el que el PAC pondrá en el CFDI: «05» sólo con «621».
    // T10, ronda 1 (I2 b): una guarda que detiene ANTES de capturar deja su motivo en la fila nunca enviada (CAS que exige `enviadoAt: null`; no
    // la reescribe si ya lo dice), sin tocar su estado ni su manifiesto: el panel lo lee de la fila.
    const fila0 = cfdi
    const detenerAntesDeCapturar = async (motivo: string): Promise<IssueGlobalResult> => {
      let fila = fila0
      if (fila0 && fila0.enviadoAt === null && fila0.lastError !== motivo)
        fila =
          (await deps.persistCfdi(
            { lastError: motivo },
            { id: fila0.id, status: fila0.status, attempts: fila0.attempts, enviadoAt: null },
          )) ?? fila0
      return {
        status: 'VALIDATION_FAILED',
        ...(fila ? { cfdi: fila } : {}),
        reasons: [motivo],
        period,
        ...(fila ? cuentasSinLeer(fila) : { candidateCount: 0, excluidasPorIvaMixto: 0, excluidas: {} }),
      }
    }
    const motivoPeriodicidad = motivoDePeriodicidad(period.satPeriodicidad, emisor.regimenFiscal)
    // T10 (m1 de la T9) y ronda 1 (m1): con fila, el texto dice la verdad según ella. La que tiene sus ventas APARTADAS (reservada sin enviar)
    // no se libera cambiando la periodicidad ⇒ soporte; la que no apartó nada (diagnóstica, o rechazada en definitiva) ⇒ sus ventas ya entran a
    // la global de la periodicidad de hoy.
    if (motivoPeriodicidad)
      return detenerAntesDeCapturar(
        !cfdi
          ? motivoPeriodicidad
          : apartaSusVentas(cfdi)
            ? MOTIVO_BIMESTRAL_FILA_APARTADA
            : // Ronda 2 (N3): si la periodicidad de HOY sigue siendo la bimestral, sus ventas no tienen otra global: «elige otra o corrige el régimen».
              emisor.globalPeriodicity === 'BIMESTRAL'
              ? motivoPeriodicidad
              : cfdi.status === 'VALIDATION_FAILED'
                ? MOTIVO_BIMESTRAL_CAPTURA_DESCARTADA
                : MOTIVO_BIMESTRAL_RECHAZADA_DESCARTADA,
      )
    // 🔴 T11 (Codex C1-33, C1-37): el año del periodo tiene que ser el de la emisión o el anterior (Guía del CFDI global). Fuera de esa ventana no
    // se captura ni se envía nada nuevo —ni la persona, ni la complementaria, ni el job que retoma pendientes—; lo ya enviado se recuperó arriba.
    // Una fila que nunca se envió conserva su estado y gana el motivo (CAS con `enviadoAt: null`; no se reescribe si ya lo dice).
    if (!anioPermitido(period.anio, params.now)) {
      let fila = cfdi
      if (cfdi && cfdi.enviadoAt === null && cfdi.lastError !== MOTIVO_ANIO_FUERA)
        fila =
          (await deps.persistCfdi(
            { lastError: MOTIVO_ANIO_FUERA },
            { id: cfdi.id, status: cfdi.status, attempts: cfdi.attempts, enviadoAt: null },
          )) ?? cfdi
      return {
        status: 'SKIPPED',
        reason: MOTIVO_ANIO_FUERA,
        period,
        ...(fila ? { cfdi: fila, ...cuentasSinLeer(fila) } : { candidateCount: 0, excluidasPorIvaMixto: 0, excluidas: {} }),
      }
    }
    // T10, ronda 1 (I1): si las fechas de este periodo siguen apartadas en una global de OTRA periodicidad (de cuando el RFC tenía otra), no se
    // captura: saldría un segundo documento por las mismas fechas mientras aquél sigue pendiente. Aplica igual al botón (un `desde` que coincide
    // con el de la otra), a la complementaria y al job; lo ya enviado se recuperó arriba.
    const cubridora = await deps.globalApartadaQueCubre(emisor.id, period)
    // Ola final (T1): el texto según quién la cubre (la de la periodicidad de HOY, o una de cuando el RFC tenía otra).
    if (cubridora) return detenerAntesDeCapturar(motivoDePeriodoCubierto(emisor, cubridora))
  }
  const unSoloEmisor = (await deps.contarEmisores(emisor.venueId)) === 1
  const candidateIds = await deps.loadGlobalCandidates(emisor, period, unSoloEmisor, cfdi?.id)
  // C1 (Tarea 10): lo que queda fuera por CONFIGURACIÓN, contado con la misma regla, fuera de la transacción (como los candidatos). Se congela
  // en la captura junto a lo excluido por contenido; es estadística: no decide qué entra (eso lo relee la captura bajo los candados).
  const porConfiguracion = await deps.contarExcluidasPorConfiguracion(emisor, period, unSoloEmisor, cfdi?.id)
  const previous = cfdi
  const reserved = await deps
    .runInTransaction(async tx => {
      const venue = await tx.venue.findUniqueOrThrow({ where: { id: emisor.venueId }, select: { organizationId: true } })
      // Match admission order: all order/product locks precede the shared organization lock.
      const oldIds = previous ? await ordenesDelManifiesto(tx, previous.id) : []
      // C1-13: la UNIÓN de los tickets de la reserva anterior y de los candidatos: se bloquean todos y se recapturan todos (una reserva
      // sin enviar conserva sus tickets aunque la lista leída fuera de la transacción no los traiga).
      const ids = [...new Set([...oldIds, ...candidateIds])].sort()
      await bloquearOrdenesParaFacturar(tx, ids, emisor.venueId)
      await tomarAdmisionCompartida(tx, venue.organizationId)
      const current = await tx.cfdi.findUnique({ where: { idempotencyKey: key } })
      if (!previous && current) return { cfdi: current, fresh: false, reasons: [] as string[], empty: false, excluded: 0, excluidas: {} }
      if (previous) {
        // Se recaptura lo que NUNCA se envió y (decisión A del founder, como en producción) lo rechazado en definitiva que el PAC confirmó que no
        // tiene. Una enviada incierta nunca gana este CAS. La recaptura sube `attempts` ⇒ la identidad del siguiente envío es NUEVA.
        const claimed = await tx.cfdi.updateMany({
          where: {
            id: previous.id,
            status: previous.status,
            attempts: previous.attempts,
            protocoloIva: 1,
            OR: [{ enviadoAt: null }, { falloDefinitivo: true }],
          },
          data: { status: 'STAMPING' },
        })
        if (claimed.count !== 1) throw new ConflictError(PROCESANDO)
        // Ronda 1 de la T11 (m1): la recaptura sobrescribe `lastError`, `enviadoAt` y `falloDefinitivo`; el intento rechazado deja su rastro en la
        // MISMA transacción (si la recaptura no se confirma, tampoco el rastro).
        if (previous.falloDefinitivo)
          await tx.activityLog.create({
            data: {
              venueId: emisor.venueId,
              action: 'CFDI_GLOBAL_INTENTO_RECHAZADO',
              entity: 'Cfdi',
              entityId: previous.id,
              data: {
                identidad: `${previous.idempotencyKey}#${previous.attempts}`,
                lastError: previous.lastError ?? null,
                enviadoAt: previous.enviadoAt ? new Date(previous.enviadoAt).toISOString() : null,
              },
            },
          })
        await liberarSellosDe(tx, previous.id)
        await tx.cfdiGlobalOrden.deleteMany({ where: { cfdiId: previous.id } })
      }
      const captured = await capturarGlobal(tx, emisor, period, ids, unSoloEmisor, previous?.id, porConfiguracion, {
        key,
        complementariaDe,
      })
      if (!captured.entrada.ordenes.length && !previous)
        return {
          cfdi: null,
          fresh: true,
          reasons: [],
          empty: true,
          excluded: captured.entrada.excluidasPorIvaMixto,
          excluidas: captured.entrada.excluidas,
        }
      const reasons = captured.reasons
      const attempts = (previous?.attempts ?? 0) + (reasons.length ? 0 : 1)
      const data = {
        ...baseGlobalCfdiData(emisor, key, period, captured.entrada),
        status: reasons.length ? 'VALIDATION_FAILED' : 'STAMPING',
        protocoloIva: 1,
        entrada: captured.entrada as unknown as Prisma.InputJsonValue,
        entradaHuella: huellaDeEntrada(captured.entrada),
        attempts,
        enviadoAt: null,
        falloDefinitivo: false,
        facturapiId: null,
        uuid: null,
        lastError: reasons.length ? reasons.join(' | ') : null,
      }
      let saved
      if (previous) {
        const changed = await tx.cfdi.updateMany({
          where: { id: previous.id, status: 'STAMPING', attempts: previous.attempts },
          data: data as any,
        })
        if (changed.count !== 1) throw new ConflictError(PROCESANDO)
        saved = await tx.cfdi.findUniqueOrThrow({ where: { id: previous.id } })
      } else saved = await deps.reserveCfdi(data, tx)
      if (!reasons.length) {
        for (let at = 0; at < captured.entrada.ordenes.length; at += PAGE) {
          const page = captured.entrada.ordenes.slice(at, at + PAGE)
          await tx.cfdiGlobalOrden.createMany({ data: page.map(o => ({ cfdiId: saved.id, orderId: o.orderId, huella: o.huella })) })
          await sellarRenglones(tx, { cfdiId: saved.id, intento: attempts, renglones: page.flatMap(o => o.renglones) })
        }
      }
      // C1-23: una reserva que perdió TODOS sus tickets queda guardada como diagnóstica (`VALIDATION_FAILED` con su motivo): no es «nada que
      // facturar», es una fila que se lee y se recaptura.
      return {
        cfdi: saved,
        fresh: true,
        reasons,
        empty: false,
        excluded: captured.entrada.excluidasPorIvaMixto,
        excluidas: captured.entrada.excluidas,
      }
    })
    .catch(err => {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictError(PROCESANDO)
      throw err
    })
  cfdi = reserved.cfdi
  if (reserved.empty)
    return {
      status: 'NOTHING_TO_INVOICE',
      period,
      candidateCount: 0,
      excluidasPorIvaMixto: reserved.excluded ?? 0,
      excluidas: reserved.excluidas ?? {},
    }
  if (!cfdi || cfdi.protocoloIva !== 1) throw new ConflictError(PROCESANDO)
  // Una diagnóstica ajena (otra solicitud llegó antes) no se lee para enviar: le pertenece a quien la capturó (C1-12).
  if (!reserved.fresh && cfdi.status === 'VALIDATION_FAILED') throw new ConflictError(PROCESANDO)
  // C1-12 (b): la que no pasó la validación se devuelve con sus motivos, leída en DIAGNÓSTICO (puede no cuadrar: nunca se envía).
  if (reserved.reasons.length)
    return { status: 'VALIDATION_FAILED', cfdi, reasons: reserved.reasons, period, ...cuentasDe(leerGlobal(cfdi, 'DIAGNOSTICO')) }
  // El envío y la recuperación leen SIEMPRE en modo «para enviar».
  const entrada = leerGlobal(cfdi, 'PARA_ENVIAR')
  const counts = { period, ...cuentasDe(entrada) }
  // Otra solicitud la timbró mientras ésta esperaba los candados (m4: tampoco es una emisión de ésta).
  if (cfdi.status === 'STAMPED') return { status: 'STAMPED', yaTimbrada: true, cfdi, ...counts }
  const provider = deps.resolveProvider(emisor, { sandbox: params.sandbox })
  const recovered = reserved.fresh ? null : await consultarIntentoCapturado(cfdi, provider, deps.runInTransaction)
  // A concurrent unsent reservation belongs to its original caller; only that caller can send it.
  if (!reserved.fresh && !recovered) throw new ConflictError(PROCESANDO)
  return {
    ...(await enviarIntentoCapturado(
      cfdi,
      { tipo: 'GLOBAL', params: entrada.params },
      recovered,
      provider,
      await deps.loadVenueSlug(emisor.venueId),
      shared,
    )),
    ...counts,
  }
}

const COBRO_ELEGIBLE: Prisma.PaymentWhereInput = { OR: [{ type: { in: ['REGULAR', 'FAST'] } }, { type: null }] }
/** Un cobro que cuenta para la global: completado y elegible (`REGULAR`/`FAST`/sin tipo). */
const COBRO: Prisma.PaymentWhereInput = { status: 'COMPLETED', AND: [COBRO_ELEGIBLE] }
const algun = (w: Prisma.PaymentWhereInput): Prisma.OrderWhereInput => ({ payments: { some: { AND: [COBRO, w] } } })
const ninguno = (w: Prisma.PaymentWhereInput): Prisma.OrderWhereInput => ({ payments: { none: { AND: [COBRO, w] } } })
/** Ninguna orden (`id IN ()`): la rama que no aplica a este emisor. */
const NUNCA: Prisma.OrderWhereInput = { id: { in: [] } }

/**
 * C1 (Codex C1-5): el ticket es del periodo de su ÚLTIMO cobro elegible (`Payment.createdAt` no cambia): ni confirmar su contrato ni
 * otra escritura en la orden lo mueven. Fuera lo que ya tiene factura individual viva y lo que ya está en una global viva (salvo la
 * del propio intento, `self`).
 */
export function ventanaFiscal(
  venueId: string,
  period: Pick<ClosedPeriod, 'periodStart' | 'periodEnd'>,
  self?: string,
): Prisma.OrderWhereInput {
  return {
    venueId,
    paymentStatus: 'PAID',
    AND: [
      // `venueId` en el cobro (revisión T5, Importante 1): la búsqueda entra por `Payment(venueId, status, createdAt)` y lee sólo los
      // cobros de ESTA sucursal en el periodo, no la historia entera. En producción ningún cobro tiene otra sucursal que su orden.
      // 🔴 No se filtra `Order.createdAt < fin`: se edita desde el dashboard y en SoftRestaurant viene de otro reloj; con ese filtro una
      // venta con su orden movida de fecha quedaría fuera de TODA global.
      algun({ venueId, createdAt: { gte: period.periodStart, lt: period.periodEnd } }),
      ninguno({ venueId, createdAt: { gte: period.periodEnd } }),
      { cfdis: { none: { isGlobal: false, type: 'INGRESO', ...CFDI_VIVO } } },
      { enGlobales: { none: { cfdi: { ...CFDI_VIVO, ...(self ? { id: { not: self } } : {}) } } } },
    ],
  }
}

/**
 * La configuración de un comercio cuyas ventas ENTRAN a la global de este RFC (`compatible` de `dondePertenece`, y `pertenenciaAlEmisor` en
 * memoria): configurado a este RFC, con la facturación encendida y «Incluir en la factura global». Una sola regla para la pertenencia y para
 * `globalApagada` (ola final de C1).
 */
export const configQueEntraALaGlobal = (fiscalEmisorId: string) =>
  ({ fiscalEmisorId, facturacionEnabled: true, includeInGlobal: true }) satisfies Prisma.MerchantFiscalConfigWhereInput
/**
 * Ajuste del founder (7-oct): lo cobrado SÓLO fuera de la terminal entra a la global de este RFC únicamente con UN solo RFC en el negocio y si el
 * dueño lo pidió (el interruptor). La misma regla para la pertenencia (`dondePertenece`) y para `estaApagadaLaGlobal` (ola final).
 */
export const fueraDeTerminalPedida = (emisor: Pick<GlobalEmisor, 'includeOffTerminalSalesInGlobal'>, unSoloEmisor: boolean): boolean =>
  unSoloEmisor && emisor.includeOffTerminalSalesInGlobal

/** C1 (Codex C1-8): `pertenenciaAlEmisor` en SQL, clase por clase. La prueba de integración compara las dos con datos reales. */
export function dondePertenece(
  emisor: { id: string; invoiceCashSales: boolean; includeOffTerminalSalesInGlobal: boolean },
  unSoloEmisor: boolean,
  p: Pertenencia,
): Prisma.OrderWhereInput {
  const conComercio: Prisma.PaymentWhereInput = { OR: [{ merchantAccountId: { not: null } }, { ecommerceMerchantId: { not: null } }] }
  const deConfig = (cfg: Prisma.MerchantFiscalConfigWhereInput): Prisma.PaymentWhereInput => ({
    OR: [{ merchantAccount: { fiscalConfig: cfg } }, { ecommerceMerchant: { fiscalConfig: cfg } }],
  })
  const nuestro = deConfig({ fiscalEmisorId: emisor.id })
  const compatible = deConfig(configQueEntraALaGlobal(emisor.id))
  const ajeno = deConfig({ fiscalEmisorId: { not: emisor.id } })
  const incompatible: Prisma.PaymentWhereInput = { AND: [conComercio, { NOT: compatible }] }
  const efectivo: Prisma.PaymentWhereInput = { method: 'CASH' }
  const conEfectivo = emisor.invoiceCashSales ? NUNCA : algun(efectivo)
  const sinEfectivo = emisor.invoiceCashSales ? {} : ninguno(efectivo)
  // Ajuste del founder (7-oct): lo cobrado SÓLO fuera de la terminal (ningún cobro con comercio), con un solo RFC, se revisa como efectivo o
  // candidata únicamente si el dueño pidió esas ventas en su global; si no, es SIN_TERMINAL. Con varios RFC sigue siendo SIN_EMISOR.
  const pedida = fueraDeTerminalPedida(emisor, unSoloEmisor)
  switch (p) {
    case 'AJENA':
      return { AND: [ninguno(nuestro), algun(ajeno)] }
    case 'SIN_EMISOR':
      return { OR: [{ AND: [algun(conComercio), ninguno(nuestro), ninguno(ajeno)] }, unSoloEmisor ? NUNCA : ninguno(conComercio)] }
    case 'COMERCIO_FUERA':
      return { AND: [algun(nuestro), algun(incompatible)] }
    case 'EFECTIVO':
      return {
        OR: [
          { AND: [algun(compatible), ninguno(incompatible), conEfectivo] },
          pedida ? { AND: [ninguno(conComercio), conEfectivo] } : NUNCA,
        ],
      }
    case 'CANDIDATA':
      return {
        OR: [
          { AND: [algun(compatible), ninguno(incompatible), sinEfectivo] },
          pedida ? { AND: [ninguno(conComercio), sinEfectivo] } : NUNCA,
        ],
      }
    case 'SIN_TERMINAL':
      return unSoloEmisor && !emisor.includeOffTerminalSalesInGlobal ? ninguno(conComercio) : NUNCA
  }
}

/**
 * Ola final (m2 y m3 de la revisión de la T12): las clases de CONFIGURACIÓN que se cuentan y se listan, en UN solo sitio: las de
 * `MOTIVOS_DE_CONFIGURACION` y, con un solo RFC, `AJENA` (M6 de la T5: un comercio configurado al RFC de OTRA sucursal, que no entra a ninguna
 * global) como `COMERCIO_FUERA` con `DETALLE_OTRA_SUCURSAL`. Con varios RFC, `AJENA` es del otro RFC y no se cuenta ni se lista aquí
 * (pertenencia única). La usan la estadística de la captura (`contarExcluidasPorConfiguracion`), los totales del listado y sus filas.
 */
function clasesDeConfiguracion(
  emisor: Pick<GlobalEmisor, 'id' | 'invoiceCashSales' | 'includeOffTerminalSalesInGlobal'>,
  unSoloEmisor: boolean,
): Array<{ where: Prisma.OrderWhereInput; motivo: MotivoExclusionGlobal; detalle: string }> {
  return [
    ...MOTIVOS_DE_CONFIGURACION.map(m => ({
      where: dondePertenece(emisor, unSoloEmisor, m),
      motivo: m,
      detalle: TEXTO_EXCLUSION_GLOBAL[m],
    })),
    ...(unSoloEmisor
      ? [{ where: dondePertenece(emisor, true, 'AJENA'), motivo: 'COMERCIO_FUERA' as const, detalle: DETALLE_OTRA_SUCURSAL }]
      : []),
  ]
}

/**
 * C1 (§4.3, Codex C1-8; Tarea 10): lo que NO es candidato por configuración, contado con `count` y con la MISMA regla que los candidatos
 * (`ventanaFiscal` + `dondePertenece`), clase por clase de `clasesDeConfiguracion` (ola final: con un solo RFC, la otra sucursal cuenta como
 * `COMERCIO_FUERA`; con varios, `AJENA` no se cuenta: es de otro emisor). `self` = la global que se está recapturando.
 */
export async function contarExcluidasPorConfiguracion(
  emisor: Pick<GlobalEmisor, 'id' | 'venueId' | 'invoiceCashSales' | 'includeOffTerminalSalesInGlobal'>,
  period: Pick<ClosedPeriod, 'periodStart' | 'periodEnd'>,
  unSoloEmisor: boolean,
  self?: string,
  db: Pick<Prisma.TransactionClient, 'order'> = prisma,
): Promise<ExcluidasPorMotivo> {
  const excluidas: ExcluidasPorMotivo = {}
  // Las clases de configuración son excluyentes entre sí y con `CANDIDATA` (la matriz pura ⇔ SQL lo demuestra), así que cada venta cuenta
  // una vez. Sin `filtrosDeExclusion()`: lo de configuración se decide ANTES que `YA_EXTRAIDO` (el listado, Tarea 12, cuenta éste aparte).
  for (const c of clasesDeConfiguracion(emisor, unSoloEmisor)) {
    const n = await db.order.count({ where: { AND: [ventanaFiscal(emisor.venueId, period, self), c.where] } })
    if (n) excluidas[c.motivo] = (excluidas[c.motivo] ?? 0) + n
  }
  return excluidas
}

function candidateWhere(emisor: GlobalEmisor, period: ClosedPeriod, unSoloEmisor: boolean, self?: string): Prisma.OrderWhereInput {
  return { AND: [ventanaFiscal(emisor.venueId, period, self), dondePertenece(emisor, unSoloEmisor, 'CANDIDATA'), ...filtrosDeExclusion()] }
}
export const ORDER_SELECT = {
  id: true,
  orderNumber: true,
  subtotal: true,
  taxAmount: true,
  total: true,
  discountAmount: true,
  serviceChargeAmount: true,
  // C1: el contrato decide si un ticket con IVA mezclado entra (IVA incluido) o sale con su motivo.
  contratoDePrecio: true,
  // B3a: las filas de descuento con su reparto, como la individual (una página y una de más; ver filasDeDescuentoCompletas).
  orderDiscounts: DESCUENTOS_PARA_CONCEPTOS,
  payments: {
    where: { status: 'COMPLETED' as const, ...COBRO_ELEGIBLE },
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    // C1: `id`/`createdAt` (plan T6). Ronda 1: `tenderTypeId` dice si la forma SAT de un cobro se puede corregir en Tipos de pago (I2).
    select: { id: true, createdAt: true, method: true, tenderSatFormaPago: true, tenderTypeId: true, amount: true, type: true },
  },
  items: {
    orderBy: { id: 'asc' as const },
    select: {
      id: true,
      productId: true, // C1 → C3: el producto de cada concepto real
      ivaTratamiento: true,
      productName: true,
      quantity: true,
      unitPrice: true,
      discountAmount: true,
      taxAmount: true,
      total: true,
      weightQuantity: true,
      orderPromotionId: true,
      isCortesia: true,
      modifiers: { select: { name: true, price: true, quantity: true } },
      // Ronda 1 (I1): `name`, como la individual: un renglón sin `productName` toma el nombre del producto (`examinarRenglon`), no «Producto».
      product: {
        select: { name: true, ivaTratamiento: true, taxRate: true, objetoImp: true, satProductKey: true, satUnitKey: true },
      },
    },
  },
} satisfies Prisma.OrderSelect

/**
 * C1 (Codex C1-2): la foto v2 de la global. `ids` = la UNIÓN de los tickets de la reserva anterior y de los candidatos (Codex C1-13): cada uno
 * se vuelve a leer bajo los candados con la MISMA pertenencia (`candidateWhere`) y pasa por `ticketParaGlobal` con sus filas de descuento
 * COMPLETAS (B3a y las filas D16 las leen enteras): entra con su foto o sale con su motivo. Después, la regla del founder: la global da
 * exactamente lo cobrado —en total y en cada tasa— con la regla del PAC (`cuadrarLaGlobal`, la 6b detrás de la barrera N3), y el ajuste que
 * ponga la 6b se CONGELA (`ajustes`). Si no cuadra, la captura es DIAGNÓSTICA (C1-12): se guarda con su motivo y nunca se envía; sin tickets,
 * también (C1-23).
 */
async function capturarGlobal(
  tx: Prisma.TransactionClient,
  emisor: GlobalEmisor,
  period: ClosedPeriod,
  ids: string[],
  unSoloEmisor: boolean,
  self: string | undefined,
  porConfiguracion: ExcluidasPorMotivo,
  /** T11: la llave de la fila que se guardará (la relectura en memoria la valida; ronda 1, I2: obligatoria) y, si es complementaria, su principal. */
  identidad: { key: string; complementariaDe?: string },
): Promise<{ entrada: EntradaGlobalV2; reasons: string[] }> {
  const ordenes: OrdenGlobalV2[] = []
  // C1 (Tarea 10): la estadística de la captura = lo de configuración (contado antes, `contarExcluidasPorConfiguracion`) + lo de contenido.
  const excluidas: ExcluidasPorMotivo = { ...porConfiguracion }
  for (let at = 0; at < ids.length; at += PAGE) {
    const orders = await tx.order.findMany({
      where: { AND: [candidateWhere(emisor, period, unSoloEmisor, self), { id: { in: ids.slice(at, at + PAGE) } }] },
      select: ORDER_SELECT,
      orderBy: { id: 'asc' },
      take: PAGE,
    })
    for (const order of orders) {
      const t = ticketParaGlobal({ ...order, orderDiscounts: await filasDeDescuentoCompletas(tx, order.id, order.orderDiscounts) })
      if (!t.ok) {
        sumarExcluida(excluidas, t.motivo)
        logger.info(`[cfdiGlobal] orden ${order.id} fuera de la global (${t.motivo}): ${t.detalle}`)
        continue
      }
      // El ticket entra igual (la global no usa sus reales); su extracción (C3) se detendrá con este motivo.
      if (t.motivoReales) logger.info(`[cfdiGlobal] orden ${order.id}: sus conceptos reales no cuadran (${t.motivoReales})`)
      ordenes.push({ ...t.orden, huella: huellaDeLaOrden(t.orden) })
    }
  }
  const base = paramsDeLaGlobal(emisor, ordenes, period, FORMA_DEL_MEZCLADO)
  const cobradoCents = ordenes.reduce((s, o) => s + o.paidCents, 0)
  // 🔴 Regla del founder (5-oct): la global da exactamente lo cobrado con el redondeo del PAC (6b), o no se timbra.
  // C1-35: también lo cobrado de cada tasa (la suma de los tickets), para que cada tasa se cuadre contra lo suyo.
  // C1-43 (v7): las filas D16 que participan (sólo las de tickets con `lineas`; ver `filasD16DeOrdenGlobal`), las mismas que usará el lector.
  const cuadre = ordenes.length
    ? cuadrarLaGlobal(base.items, cobradoCents, {
        cobradoPorTasa: cobradoPorTasaDe(ordenes),
        filasD16: sumarFilasD16(ordenes.map(filasD16DeOrdenGlobal)),
      })
    : null // sin órdenes: captura diagnóstica vacía (C1-23)
  // Un concepto que ni siquiera se puede leer (montos en cero de `cuadrarLaGlobal`) no es un documento: no se guarda como diagnóstica (el
  // lector no podría reproducirla). Con los conceptos que arma `conceptosDeOrdenGlobal` no pasa; si pasa, es un defecto: a soporte.
  if (cuadre && !cuadre.ok && !itemsLegibles(base.items)) throw new ConflictError(REVISION_DE_SOPORTE)
  const params = cuadre?.ok ? { ...base, items: cuadre.items } : base
  const montos = cuadre?.montos ?? { subtotalCents: 0, taxCents: 0, totalCents: 0 }
  // `validateBeforeStamp` no recalcula por concepto (sólo exige subtotal + IVA = total): recibe los montos del PAC (`montosDesdeDocumento`).
  const reasons = ordenes.length
    ? [
        ...validateBeforeStamp({
          csdStatus: emisor.csdStatus,
          formaPago: params.payment_form,
          receptor: {
            rfc: 'XAXX010101000',
            razonSocial: 'PÚBLICO EN GENERAL',
            regimenFiscal: '616',
            codigoPostal: emisor.lugarExpedicion,
            usoCfdi: 'S01',
          },
          items: params.items,
          expectedSubtotalCents: montos.subtotalCents,
          expectedTaxCents: montos.taxCents,
          expectedTotalCents: montos.totalCents,
          isGlobal: true,
        }).reasons,
        ...(cuadre && !cuadre.ok ? [cuadre.motivo] : []),
      ]
    : [MOTIVO_SIN_TICKETS]
  const entrada: EntradaGlobalV2 = {
    version: 2,
    tipo: 'GLOBAL',
    fiscalEmisorId: emisor.id,
    globalPeriod: { periodicidad: period.satPeriodicidad, meses: period.meses, anio: period.anio },
    periodo: { desde: period.periodStart.toISOString(), hasta: period.periodEnd.toISOString() },
    montos,
    excluidas,
    excluidasPorIvaMixto: MOTIVOS_DE_IVA.reduce((s, m) => s + (excluidas[m] ?? 0), 0),
    ordenes,
    formaDelMezclado: FORMA_DEL_MEZCLADO,
    // C1-12: la que no cuadra queda como captura DIAGNÓSTICA, con su motivo; nunca se envía.
    // C1-23: sin órdenes también es diagnóstica (nunca `ok`): se lee para mostrar su motivo y recapturar; nunca se envía.
    cuadre: !cuadre ? { ok: false, motivo: MOTIVO_SIN_TICKETS } : cuadre.ok ? { ok: true } : { ok: false, motivo: cuadre.motivo },
    ajustes: cuadre?.ok ? cuadre.ajustes : [],
    params,
    // T11 (C1-P7): la complementaria congela el id de su principal (entra en la huella).
    ...(identidad.complementariaDe ? { complementariaDe: identidad.complementariaDe } : {}),
    // Ola final (m5 de la T12): el momento de ESTA captura; el `updatedAt` de la fila lo mueven la cola y la cancelación.
    capturadaAl: new Date().toISOString(),
  }
  // Ronda 1 (M1): la captura falla CERRADO. Lo que se va a guardar tiene que pasar el MISMO lector que lo enviará (o lo mostrará, si va con
  // motivos), sobre una fila armada con los montos que se guardan; si no, se lanza aquí, dentro de la transacción: no queda reserva, manifiesto ni
  // sellos, y una reserva anterior queda como estaba. Así una divergencia entre la captura y el lector nunca congela el periodo.
  leerGlobal(
    {
      fiscalEmisorId: emisor.id,
      idempotencyKey: identidad.key,
      globalPeriod: entrada.globalPeriod,
      entrada,
      entradaHuella: huellaDeEntrada(entrada),
      ...entrada.montos,
    },
    reasons.length ? 'DIAGNOSTICO' : 'PARA_ENVIAR',
  )
  return { entrada, reasons }
}
/** `true` si cada concepto se puede leer como lo suma el PAC (`conceptosDesdeElPayload` lanza con uno mal armado). */
function itemsLegibles(items: CfdiItemInput[]): boolean {
  try {
    items.forEach(i => conceptosDesdeElPayload(i))
    return true
  } catch {
    return false
  }
}
function baseGlobalCfdiData(emisor: GlobalEmisor, key: string, period: ClosedPeriod, entrada: EntradaGlobal) {
  return {
    venueId: emisor.venueId,
    fiscalEmisorId: emisor.id,
    orderId: null,
    flow: 'GLOBAL_C' as const,
    idempotencyKey: key,
    isGlobal: true,
    globalPeriod: { periodicidad: period.satPeriodicidad, meses: period.meses, anio: period.anio },
    type: 'INGRESO' as const,
    receptorRfc: 'XAXX010101000',
    receptorNombre: 'PÚBLICO EN GENERAL',
    receptorRegimen: '616',
    receptorCp: emisor.lugarExpedicion,
    usoCfdi: 'S01',
    formaPago: entrada.params.payment_form,
    metodoPago: 'PUE',
    ...entrada.montos,
  }
}

/** Histórico: identidad sin versión y reintentos compatibles, sin inventar sellos ni entrada. */
async function emitirGlobalLegacy(
  cfdi: any,
  emisor: GlobalEmisor,
  period: ClosedPeriod,
  deps: IssueGlobalDeps,
  sandbox: boolean,
): Promise<IssueGlobalResult> {
  const provider = deps.resolveProvider(emisor, { sandbox })
  const shared = { ...deps, findExistingCfdi: deps.findExistingGlobal }
  let found
  try {
    found = cfdi.facturapiId ? await provider.getInvoice(cfdi.facturapiId) : await provider.findByExternalId(cfdi.idempotencyKey)
  } catch {
    throw new ConflictError(PROCESANDO)
  }
  if (found?.status === 'canceled')
    throw new ConflictError('Esta cuenta ya tiene una factura cancelada en el PAC; revísala antes de volver a facturar.')
  if (found?.status === 'valid' && found.uuid)
    return {
      ...(await finalizarEmision(cfdi, found, provider, await deps.loadVenueSlug(emisor.venueId), shared)),
      period,
      candidateCount: 0,
      excluidasPorIvaMixto: 0,
    }
  if (found) throw new ConflictError(PROCESANDO)
  if (
    !['STAMPING', 'STAMP_FAILED', 'VALIDATION_FAILED'].includes(cfdi.status) ||
    (cfdi.status === 'STAMPING' && Date.now() - new Date(cfdi.updatedAt ?? cfdi.createdAt).getTime() < 3 * 60000)
  )
    throw new ConflictError(PROCESANDO)
  const unSoloEmisor = (await deps.contarEmisores(emisor.venueId)) === 1
  const ids = await deps.loadGlobalCandidates(emisor, period, unSoloEmisor, cfdi.id)
  const porConfiguracion = await deps.contarExcluidasPorConfiguracion(emisor, period, unSoloEmisor, cfdi.id)
  const reserved = await deps.runInTransaction(async tx => {
    await bloquearOrdenesParaFacturar(tx, ids, emisor.venueId)
    const venue = await tx.venue.findUniqueOrThrow({ where: { id: emisor.venueId }, select: { organizationId: true } })
    await tomarAdmisionCompartida(tx, venue.organizationId)
    const captured = await capturarGlobal(tx, emisor, period, ids, unSoloEmisor, cfdi.id, porConfiguracion, {
      key: cfdi.idempotencyKey,
    })
    if (!captured.entrada.ordenes.length) return { cfdi: null, ...captured }
    const { count } = await tx.cfdi.updateMany({
      where: { id: cfdi.id, status: cfdi.status, attempts: cfdi.attempts, protocoloIva: null },
      data: {
        ...baseGlobalCfdiData(emisor, cfdi.idempotencyKey, period, captured.entrada),
        attempts: { increment: 1 },
        status: captured.reasons.length ? 'VALIDATION_FAILED' : 'STAMPING',
        lastError: captured.reasons.join(' | ') || null,
      },
    })
    if (count !== 1) throw new ConflictError(PROCESANDO)
    return { cfdi: await tx.cfdi.findUniqueOrThrow({ where: { id: cfdi.id } }), ...captured }
  })
  if (!reserved.cfdi)
    return {
      status: 'NOTHING_TO_INVOICE',
      period,
      candidateCount: 0,
      excluidasPorIvaMixto: reserved.entrada.excluidasPorIvaMixto,
      excluidas: reserved.entrada.excluidas,
    }
  cfdi = reserved.cfdi
  const counts = { period, ...cuentasDe(reserved.entrada) }
  if (reserved.reasons.length) return { status: 'VALIDATION_FAILED', cfdi, reasons: reserved.reasons, ...counts }
  const where = { id: cfdi.id, status: 'STAMPING' as const, attempts: cfdi.attempts }
  let stamped
  try {
    stamped = await provider.createGlobalInvoice({ ...reserved.entrada.params, externalId: cfdi.idempotencyKey })
  } catch (err) {
    const updated = await deps.persistCfdi({ status: 'STAMP_FAILED', lastError: err instanceof Error ? err.message : String(err) }, where)
    if (!updated) throw new ConflictError(PROCESANDO)
    return { status: 'STAMP_FAILED', cfdi: updated, ...counts }
  }
  if (stamped.status !== 'valid' || !stamped.uuid) {
    await deps.persistCfdi({ facturapiId: stamped.providerInvoiceId }, where)
    throw new ConflictError(PROCESANDO)
  }
  return { ...(await finalizarEmision(cfdi, stamped, provider, await deps.loadVenueSlug(emisor.venueId), shared)), ...counts }
}
/**
 * Los candidatos de un periodo (sólo ids; páginas completas y ordenadas; la elegibilidad se relee en la reserva). Suelta y exportada (Tarea 11)
 * para envolverla en las pruebas de concurrencia; `defaultDeps.loadGlobalCandidates` es ésta.
 */
export async function loadGlobalCandidates(
  emisor: GlobalEmisor,
  period: ClosedPeriod,
  unSoloEmisor: boolean,
  self?: string,
): Promise<string[]> {
  const ids: string[] = []
  let after: string | undefined
  for (;;) {
    const page = await prisma.order.findMany({
      where: { AND: [candidateWhere(emisor, period, unSoloEmisor, self), ...(after ? [{ id: { gt: after } }] : [])] },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: PAGE,
    })
    ids.push(...page.map(o => o.id))
    if (page.length < PAGE) return ids
    after = page[page.length - 1].id
  }
}
const defaultDeps: IssueGlobalDeps = {
  loadEmisor: id => prisma.fiscalEmisor.findUnique({ where: { id } }),
  findExistingGlobal: idempotencyKey => prisma.cfdi.findUnique({ where: { idempotencyKey } }),
  loadGlobalCandidates: (emisor, period, unSoloEmisor, self) => loadGlobalCandidates(emisor, period, unSoloEmisor, self),
  complementariasDe: principal => complementariasDe(principal),
  contarCorregidasPendientes: (emisor, period, unSoloEmisor, self) => contarCorregidasPendientes(emisor, period, unSoloEmisor, 200, self),
  contarEmisores: venueId => prisma.fiscalEmisor.count({ where: { venueId } }),
  contarExcluidasPorConfiguracion: (emisor, period, unSoloEmisor, self) =>
    contarExcluidasPorConfiguracion(emisor, period, unSoloEmisor, self),
  globalesDeOtraPeriodicidad: (emisorId, sat, despues) => globalesDeOtraPeriodicidad(emisorId, sat, despues),
  globalApartadaQueCubre: (emisorId, period) => globalApartadaQueCubre(emisorId, period),
  comercioEnLaGlobal: async emisorId =>
    !!(await prisma.merchantFiscalConfig.findFirst({ where: configQueEntraALaGlobal(emisorId), select: { id: true } })),
  resolveProvider: resolveFiscalProvider,
  storeArtifact: uploadFileToStorage,
  reserveCfdi: (data, tx = prisma) => tx.cfdi.create({ data: data as any }),
  runInTransaction: work => prisma.$transaction(work, { timeout: 60000 }),
  persistCfdi: async (data, where) => {
    if (!where) throw new Error('La escritura del intento global exige versión y estado de origen.')
    const { count } = await prisma.cfdi.updateMany({ where, data })
    return count === 1 ? prisma.cfdi.findFirst({ where: { id: where.id as string } }) : null
  },
  persistArtifacts: async (idempotencyKey, data, attempts) => {
    const { count } = await prisma.cfdi.updateMany({ where: { idempotencyKey, attempts, status: 'STAMPED' }, data })
    return count === 1 ? prisma.cfdi.findUnique({ where: { idempotencyKey } }) : null
  },
  loadVenueSlug: async id => (await prisma.venue.findUniqueOrThrow({ where: { id }, select: { slug: true } })).slug,
  loadGlobalesSinTimbrar: (emisorId, cursor) => globalesSinTimbrar(emisorId, cursor),
  findGlobalDelPeriodo: (emisorId, period) => globalPrincipalDelPeriodo(emisorId, period),
  emitirPeriodo: (params, overrides) => issueGlobalForPeriod(params, overrides),
  // Ronda 1 de la T8 (I1): los avisos de un periodo viven en `ActivityLog` del emisor (índice `entity, entityId`), por su inicio y periodicidad.
  ultimoAvisoDelPeriodo: async (emisor, period, acciones) => {
    const a = await prisma.activityLog.findFirst({
      where: {
        venueId: emisor.venueId,
        entity: 'FiscalEmisor',
        entityId: emisor.id,
        action: { in: acciones },
        AND: [
          { data: { path: ['desde'], equals: period.periodStart.toISOString() } },
          { data: { path: ['periodicidad'], equals: period.satPeriodicidad } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { action: true, data: true, createdAt: true },
    })
    if (!a) return null
    const data: unknown = a.data
    const motivo = esObjeto(data) && typeof data.motivo === 'string' ? data.motivo : null
    return { action: a.action, motivo, createdAt: a.createdAt }
  },
  registrarAvisoDelPeriodo: async (emisor, period, action, data) => {
    await prisma.activityLog.create({
      data: {
        // Ronda 2 (N5 c): con el reloj de la APP, el mismo de `Cfdi.updatedAt` (`@updatedAt`, `tocarPendiente`), con el que `motivoDeLaFila` lo compara.
        createdAt: new Date(),
        venueId: emisor.venueId,
        action,
        entity: 'FiscalEmisor',
        entityId: emisor.id,
        data: {
          emisorId: emisor.id,
          desde: period.periodStart.toISOString(),
          hasta: period.periodEnd.toISOString(),
          meses: period.meses,
          anio: period.anio,
          periodicidad: period.satPeriodicidad,
          ...data,
        } as Prisma.InputJsonValue,
      },
    })
  },
  // Una sola fila basta para saber si quedan ventas (acotado).
  tieneCandidatos: async (emisor, period, unSoloEmisor) =>
    !!(await prisma.order.findFirst({ where: candidateWhere(emisor, period, unSoloEmisor), select: { id: true } })),
  // m1: sólo si el intento NO escribió la fila (mismo intento, estado y `updatedAt` que se leyeron). Ningún CAS de la global usa `updatedAt`.
  // Ola final (N2-bis): devuelve la marca escrita (null si perdió el CAS) para que el aviso del periodo se compare con ella.
  tocarPendiente: async fila => {
    const marca = new Date()
    const { count } = await prisma.cfdi.updateMany({
      where: { id: fila.id, attempts: fila.attempts, status: fila.status, updatedAt: fila.updatedAt },
      data: { updatedAt: marca },
    })
    return count === 1 ? marca : null
  },
}

/**
 * Exclusiones que comparten candidatos, corregidas, páginas y totales (Codex C3-15): una venta que alguna vez tuvo una extracción
 * timbrada —viva o cancelada— no vuelve sola a ninguna global (C1-45). La pertenencia al emisor ya no vive aquí: es `dondePertenece`.
 */
export function filtrosDeExclusion(): Prisma.OrderWhereInput[] {
  return [{ NOT: EXTRAIDO }]
}

/** Fila de orden tal como la carga `loadGlobalCandidates` (PURA para poder probarla sin Prisma). */
export interface GlobalCandidateOrder {
  id: string
  orderNumber: string | null
  subtotal: any
  taxAmount: any
  total: any
  discountAmount?: any
  serviceChargeAmount?: any
  /** C1: el contrato con que se cobró (IVA incluido / aparte / sin constancia). Opcional sólo para las pruebas de antes de C1. */
  contratoDePrecio?: string | null
  /** B3a: filas `OrderDiscount` con su reparto (B2). Ausente = ninguna. */
  orderDiscounts?: Array<{ amount: any; reparto?: unknown }> | null
  /** C1: `tenderTypeId` (ronda 1, I2): el cobro se hizo con un tipo de pago PROPIO, cuya forma SAT se edita en Tipos de pago. */
  payments: Array<{
    id?: string
    createdAt?: Date | string | null
    method: any
    tenderSatFormaPago: string | null
    tenderTypeId?: string | null
    amount?: any
    type?: string | null
  }>
  items: Array<{
    id?: string
    /** C1 → C3: el producto del renglón (los conceptos reales lo guardan; las claves SAT se resuelven al facturar). */
    productId?: string | null
    ivaTratamiento?: IvaTratamiento | null
    productName?: string | null
    quantity: number
    unitPrice: any
    discountAmount: any
    taxAmount: any
    total?: any
    weightQuantity?: any
    orderPromotionId?: string | null
    isCortesia?: boolean | null
    modifiers?: Array<{ name?: string | null; price: any; quantity?: number }> | null
    product: { name?: string | null; taxRate: any; objetoImp: string | null; ivaTratamiento?: IvaTratamiento | null } | null
  }>
}

const aCentavos = (d: any): number => Math.round(Number(d ?? 0) * 100)
const pesosTxt = (cents: number) => `$${(cents / 100).toFixed(2)}`
/** Orden de ids estable en cualquier máquina (por código de carácter, no por idioma). */
const porId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const tratamientoDelItem = (it: GlobalCandidateOrder['items'][number]): IvaTratamiento =>
  resolverTratamiento({ selladoIva: it.ivaTratamiento, productoIva: it.product?.ivaTratamiento, tieneProducto: !!it.product })

/** El motivo de `motivosDeOrden` (cfdi.service.ts) para el cargo por servicio, y el de `motivoNoCuadra` (reglaDelPac.ts): se reconocen por su inicio. */
const INICIO_CARGO_POR_SERVICIO = 'La cuenta lleva cargo por servicio'
const INICIO_NO_CUADRA_DEL_PAC = 'Con el redondeo que usa el SAT'

/**
 * C1: los motivos de B3a/6b de UNA venta (los textos de `reconstruirConceptos`, `motivosDeOrden`, la regla del PAC) → UN motivo de la
 * lista cerrada. El texto original va en `detalle`. Lo que no tiene clase propia es `OTRO` (su texto dice qué corregir).
 */
export function clasificarMotivos(motivos: string[]): MotivoExclusionGlobal {
  const hay = (f: (m: string) => boolean) => motivos.some(f)
  if (hay(m => m.startsWith(INICIO_CARGO_POR_SERVICIO))) return 'CARGO_POR_SERVICIO'
  if (hay(m => m === MOTIVO_OCHO_SIN_REGLA)) return 'OCHO_SIN_REGLA'
  if (hay(m => m === MOTIVO_SIN_REPARTO_IVA_MEZCLADO)) return 'DESCUENTO_SIN_REPARTO'
  if (hay(m => m === MOTIVO_TODO_CORTESIA)) return 'SIN_IMPORTE'
  if (hay(m => m.startsWith(INICIO_NO_CUADRA_DEL_PAC) || m === MOTIVO_MEDIO_CENTAVO_SIN_REGLA)) return 'NO_CUADRA'
  return 'OTRO'
}

/** Las líneas de hoy de un ticket todo al 16 % (y los conceptos de B3a con que se armaron), o el motivo por el que no las tiene. */
export type LineasDeHoy =
  | { lineas: GlobalInvoiceLine[]; conceptos: RenglonParaCfdi[] | null; priceIncludesIva: boolean }
  | { motivo: MotivoExclusionGlobal; detalle: string }

/**
 * One order → one or more global lines, grouped by each product's REAL tax rate (16/8/0/exento).
 * taxAmount=0 ⇒ gross (IVA-included) prices, e.g. TPV. Non-zero taxAmount ⇒ separated-tax source.
 *
 * 🔴 MISMA verdad de dinero que la factura individual (`conceptosDesdeRenglon`, descuento de orden,
 * cobros elegibles): con `unitPrice × quantity` la global declaraba MENOS de lo cobrado en cualquier
 * ticket con extras (Testarudo, 21-sep-2026). Y la misma BARRERA: si el documento de una orden no
 * cuadra con lo cobrado, la orden se EXCLUYE de la global (con aviso) — nunca se declara mal.
 *
 * C1 (Tarea 6): el cuerpo de hoy, con un motivo de la lista cerrada en cada salida temprana y la forma de pago de la MAYOR cantidad cobrada,
 * sumada por forma (`formaPagoDelTicket`, H4; ronda 1 I3) en lugar de la del cobro más reciente. `conceptos` = los de B3a (`null` sin renglones), para no recalcularlos.
 */
export function lineasDeHoy(o: GlobalCandidateOrder): LineasDeHoy {
  if (clasificarOrden(o.items.map(tratamientoDelItem)) === 'MIXTA')
    return { motivo: 'OTRO', detalle: 'Tiene productos con IVA distinto de 16 %: la línea de hoy sólo arma tickets todo al 16 %.' }
  o = { ...o, items: o.items.map(renglonConTratamiento) }
  const pays = o.payments.filter(p => esCobroElegible(p))
  if (!pays.length) return { motivo: 'SIN_PAGAR', detalle: TEXTO_EXCLUSION_GLOBAL.SIN_PAGAR }
  const paidCents = pays.reduce((sum, p) => sum + aCentavos(p.amount), 0)
  if (paidCents <= 0) return { motivo: 'SIN_IMPORTE', detalle: TEXTO_EXCLUSION_GLOBAL.SIN_IMPORTE }
  const sinRenglones = o.items.length === 0
  const priceIncludesIva = aCentavos(o.taxAmount) === 0 || sinRenglones
  const formaPago = formaPagoDelTicket(o.payments)
  const meta = { orderId: o.id, orderNumber: o.orderNumber, formaPago, priceIncludesIva }

  // Preferred path: derive per-product tax groups from the items.
  if (!sinRenglones) {
    const { items: conceptos, motivos } = reconstruirConceptos(o as OrdenParaConceptos, o.id)
    if (motivos.length > 0) return { motivo: clasificarMotivos(motivos), detalle: motivos.join(' ') }
    const documentoCents = totalDelDocumentoCents({ items: conceptos as any, pricesIncludeIva: priceIncludesIva })
    if (documentoCents !== paidCents) {
      return {
        motivo: 'NO_CUADRA',
        detalle: `Sus productos suman ${pesosTxt(documentoCents)} y se cobraron ${pesosTxt(paidCents)}; no se declara distinto de lo cobrado.`,
      }
    }
    const lineItems: GlobalLineItemInput[] = conceptos.map(it => {
      const rate = it.product ? Number(it.product.taxRate) : 0.16
      const objetoImp = it.product?.objetoImp ?? (rate > 0 ? '02' : '01')
      const lineNet = importeConceptoCents(it) - aCentavos(it.discountAmount)
      // Gross items already include IVA; net items add their separated tax to reach the paid gross.
      const grossCents = priceIncludesIva ? lineNet : Math.round(lineNet * (1 + rate))
      return { grossCents, taxRate: rate, objetoImp }
    })
    return { lineas: groupOrderIntoGlobalLines(lineItems, meta), conceptos, priceIncludesIva }
  }

  // Fallback (order with no items): one line for what was PAID (never `order.total`, which may carry
  // the tip), IVA included, assuming 16%. Las exclusiones de ORDEN aplican igual sin renglones.
  const motivosOrden = motivosDeOrden(o as OrdenParaConceptos)
  if (motivosOrden.length > 0) return { motivo: clasificarMotivos(motivosOrden), detalle: motivosOrden.join(' ') }
  const totalCents = paidCents
  const { netCents, taxCents } = splitIvaIncluded(totalCents, 0.16)
  return {
    lineas: [{ ...meta, totalCents, subtotalCents: netCents, taxCents, taxRate: 0.16, objetoImp: '02' }],
    conceptos: null,
    priceIncludesIva,
  }
}

/** El camino de hoy (captura v1 y sus pruebas): las líneas del ticket, o `[]` con el motivo en el log. */
export function globalLinesFromOrder(o: GlobalCandidateOrder): GlobalInvoiceLine[] {
  const r = lineasDeHoy(o)
  if ('motivo' in r) {
    logger.warn(`[cfdiGlobal] orden ${o.id} excluida de la global (${r.motivo}): ${r.detalle}`)
    return []
  }
  return r.lineas
}

/**
 * C1 (H4; Guía de llenado del Anexo 20, FormaPago: «la clave de la forma de pago con la que se liquida la mayor cantidad del pago»).
 * Ronda 1 de la T6 (I3): la guía prevé el empate «cuando se reciban dos o más formas de pago con el mismo importe» ⇒ se suma POR FORMA:
 * los cobros elegibles se agrupan por su forma SAT (`mapFormaPago`) y gana la de mayor suma; a igual suma, la forma con el cobro suelto mayor;
 * y si también empata, la clave SAT menor (el SAT deja elegir; ni la hora ni el id del cobro deciden). Con $300 + $300 con tarjeta y $500 en
 * efectivo gana la tarjeta (04), no el efectivo del cobro suelto mayor.
 * Si la forma ganadora es '99' (la mayor cantidad se cobró sin forma SAT), el ticket no entra a la global: nunca se toma la de otra forma.
 * `pagos` = los de la forma ganadora (para decir al dueño qué hacer).
 */
function formaGanadoraDelTicket(pagos: GlobalCandidateOrder['payments']): { forma: string; pagos: GlobalCandidateOrder['payments'] } {
  const grupos = new Map<string, { sumaCents: number; mayorCents: number; pagos: GlobalCandidateOrder['payments'] }>()
  for (const p of pagos.filter(x => esCobroElegible(x))) {
    const forma = mapFormaPago(p.method, p.tenderSatFormaPago)
    const g = grupos.get(forma) ?? { sumaCents: 0, mayorCents: 0, pagos: [] }
    const cents = aCentavos(p.amount)
    grupos.set(forma, { sumaCents: g.sumaCents + cents, mayorCents: Math.max(g.mayorCents, cents), pagos: [...g.pagos, p] })
  }
  const [ganadora] = [...grupos].sort(([fa, a], [fb, b]) => b.sumaCents - a.sumaCents || b.mayorCents - a.mayorCents || porId(fa, fb))
  return ganadora ? { forma: ganadora[0], pagos: ganadora[1].pagos } : { forma: '99', pagos: [] }
}

/** La forma de pago del ticket: la de mayor suma de sus cobros elegibles (ver `formaGanadoraDelTicket`); '99' si no hay o si ésa no tiene forma. */
export function formaPagoDelTicket(pagos: GlobalCandidateOrder['payments']): string {
  return formaGanadoraDelTicket(pagos).forma
}

/**
 * C1 v7 (Codex C1-43): las filas D16 del ticket, con el MISMO predicado del cargador individual (`cfdi.service.ts:1759`): sólo con IVA aparte,
 * sólo las de `reduceImpuesto`. Cada una con los `orderItemId` que toca (llaves de su `reparto.renglones`), para atribuirla a su tasa.
 */
export function filasD16DelTicket(o: Pick<GlobalCandidateOrder, 'contratoDePrecio' | 'orderDiscounts'>): string[][] {
  if (o.contratoDePrecio !== 'IVA_APARTE') return []
  return (o.orderDiscounts ?? []).flatMap(f => {
    const r = leerReparto(f.reparto)
    return r?.reduceImpuesto === true ? [Object.keys(r.renglones)] : []
  })
}

/**
 * C1 → C3: los conceptos REALES del ticket (B3a), comprobados contra lo cobrado con `cuadrarPorTasa` (v5: barrera N3 y cada tasa sola).
 * Se guardan con su descuento ORIGINAL: el ajuste del PAC se recalcula donde se usa (C2 `montosDeReales`, C3 la factura del cliente), siempre
 * detrás de la misma barrera (Codex C1-30, C3-18). `null` + motivo si no cuadran: el ticket igual entra a la global (ésta no los usa),
 * pero su extracción (C3) se detendrá con ese motivo.
 * El producto de cada concepto es el de su renglón (`origen`): un extra lleva el producto al que acompaña, como en la individual (que le
 * da sus mismas claves SAT).
 */
function conceptosRealesDelTicket(
  conceptos: RenglonParaCfdi[],
  ivaIncluido: boolean,
  paidCents: number,
  porTratamiento: PorTratamientoGlobal,
  filasD16: string[][],
  renglon: (c: RenglonParaCfdi) => { productId: string | null; tratamiento: IvaTratamiento },
): { reales: ConceptoReal[] | null; motivo: string | null } {
  const reales: ConceptoReal[] = conceptos.map(c => ({
    orderItemId: c.origen ?? null,
    productId: renglon(c).productId,
    descripcion: c.productName ?? 'Producto',
    precio: new Prisma.Decimal(String(c.unitPrice)).toFixed(6), // el mismo precio que usa la 6b en el cargador
    cantidad: c.quantity,
    descuentoCents: aCentavos(c.discountAmount),
    ivaIncluido,
    tratamiento: renglon(c).tratamiento,
  }))
  // C1-30/C1-35: barrera y lo cobrado de cada tasa. C1-39/C1-43 (v7): con las filas D16 del ticket, por tasa.
  const cuadre = cuadrarPorTasa(reales.map(conceptoDeReal), paidCents, {
    cobradoPorTasa: porTratamiento,
    filasD16: filasD16DeReales(filasD16, reales),
  })
  if (!cuadre.ok) return { reales: null, motivo: cuadre.motivo }
  return { reales, motivo: null } // con el descuento ORIGINAL: el ajuste no se congela aquí
}

/** El concepto de una venta sin renglones (importe libre): el MISMO que arma la factura individual (`loadOrderForCfdiFromDb`). */
const ventaSinRenglones = (paidCents: number): RenglonParaCfdi => ({
  productName: 'Venta',
  quantity: 1,
  unitPrice: new Prisma.Decimal(paidCents).div(100),
  discountAmount: 0,
  product: null,
  tratamiento: 'IVA_16',
})

/** C1: un ticket entra a la global con su foto, o sale con UN motivo de la lista cerrada. */
export type TicketGlobal =
  | { ok: true; orden: Omit<OrdenGlobalV2, 'huella'>; motivoReales: string | null }
  | { ok: false; motivo: MotivoExclusionGlobal; detalle: string }

/**
 * C1 (§4.3, H4, D4): la foto de UN ticket para la global, o el motivo por el que no entra. Se decide en este orden (una venta, un motivo):
 * 1. `SIN_PAGAR` (ningún cobro que sea venta) · `SIN_IMPORTE` (se cobró $0).
 * 2. `FORMA_DE_PAGO_SIN_DEFINIR`: la forma con la que se cobró la MAYOR cantidad (suma por forma, ronda 1 I3) no tiene forma SAT (nunca se toma
 *    otra; con '99' toda la global quedaría detenida). El `detalle` manda a Tipos de pago sólo si esa parte se cobró con tipos propios (I2).
 * 3. `OTRO` si no tiene folio o un renglón no tiene id (sin folio se pierde el NoIdentificacion; sin id no se puede sellar).
 * 4. `PRODUCTO_POR_REVISAR` (objeto 03/04) · `CARGO_POR_SERVICIO` · `OCHO_SIN_REGLA` (algún renglón al 8 %).
 * 5. Todo al 16 %: entra con sus líneas de hoy (`lineasDeHoy`; su salida temprana trae su motivo, p. ej. `NO_CUADRA`), con IVA incluido o aparte.
 * 6. IVA mezclado (o todo a una tasa distinta de 16 %): sólo con el contrato IVA incluido (`IVA_APARTE_MIXTA`, `CONTRATO_DESCONOCIDO`); los
 *    conceptos de B3a (`DESCUENTO_SIN_REPARTO`, `SIN_IMPORTE`, `OTRO` con su texto) y lo cobrado por tratamiento, que tiene que sumar lo cobrado
 *    (`NO_CUADRA`).
 * Al entrar: folio (`orderNumber ?? id`, el mismo que el `sku` de la línea), forma, renglones (uno por OrderItem: lo que se sella), lo cobrado
 * por tratamiento, sus conceptos reales (C3) y sus filas D16 congeladas (C1-43).
 */
export function ticketParaGlobal(o: GlobalCandidateOrder): TicketGlobal {
  const fuera = (motivo: MotivoExclusionGlobal, detalle: string = TEXTO_EXCLUSION_GLOBAL[motivo]): TicketGlobal => ({
    ok: false,
    motivo,
    detalle,
  })
  const pagos = o.payments.filter(p => esCobroElegible(p))
  if (!pagos.length) return fuera('SIN_PAGAR')
  const paidCents = pagos.reduce((s, p) => s + aCentavos(p.amount), 0)
  if (paidCents <= 0) return fuera('SIN_IMPORTE')
  const { forma: formaPago, pagos: sinForma } = formaGanadoraDelTicket(o.payments)
  // Ronda 1 (I2): «asígnala en Tipos de pago» sólo se puede hacer si TODO lo que se cobró sin forma fue con tipos de pago propios
  // (`tenderTypeId`); un monedero, la cripto o un OTHER suelto no están ahí ⇒ el texto que sí se puede atender (soporte).
  if (formaPago === '99')
    return fuera(
      'FORMA_DE_PAGO_SIN_DEFINIR',
      sinForma.every(p => !!p.tenderTypeId) ? TEXTO_EXCLUSION_GLOBAL.FORMA_DE_PAGO_SIN_DEFINIR : TEXTO_FORMA_DE_PAGO_SIN_CATALOGO,
    )
  // Revisión de la T4: el folio es el NoIdentificacion (`sku`) de sus conceptos; el proveedor no manda un `sku` vacío, así que un folio vacío
  // perdería la identificación del ticket en silencio. `orderNumber` es obligatorio en el esquema: esto no debería pasar nunca.
  const folio = o.orderNumber ?? o.id
  if (!folio.trim())
    return fuera('OTRO', 'La venta no tiene folio y la factura global identifica cada ticket por su folio. Repórtala a soporte.')
  if (o.items.some(it => !it.id))
    return fuera('OTRO', 'Un renglón de la venta no tiene identificador, así que no se puede marcar como facturado. Repórtala a soporte.')
  const renglones = o.items.map(it => ({ orderItemId: it.id!, tratamiento: tratamientoDelItem(it) }))
  const tratamientos = renglones.map(r => r.tratamiento)
  if (hayBloqueados(tratamientos)) {
    // Ronda 1 (I1): el mismo nombre que la individual (`examinarRenglon`): el del renglón, si no el del producto.
    const nombres = o.items
      .filter((_, i) => hayBloqueados([tratamientos[i]]))
      .map(it => `«${it.productName?.trim() || it.product?.name?.trim() || 'Producto'}»`)
    return fuera('PRODUCTO_POR_REVISAR', `${TEXTO_EXCLUSION_GLOBAL.PRODUCTO_POR_REVISAR} (${[...new Set(nombres)].join(', ')})`)
  }
  if (aCentavos(o.serviceChargeAmount) > 0) return fuera('CARGO_POR_SERVICIO')
  if (tratamientos.includes('IVA_8')) return fuera('OCHO_SIN_REGLA')

  // C1-43 (v7): las filas D16 del ticket, congeladas en la foto; todo lector cuenta con éstas.
  const filasD16 = filasD16DelTicket(o)
  const porRenglon = new Map(o.items.map((it, i) => [it.id!, { productId: it.productId ?? null, tratamiento: tratamientos[i] }] as const))
  // El renglón de cada concepto (`origen`); sin origen (la venta sin renglones), el concepto mismo. Un concepto legacy sin tratamiento usa el
  // de su renglón (sellado > producto > IVA_16), el mismo que se sella.
  const renglonDe = (c: RenglonParaCfdi) => {
    const r = c.origen ? porRenglon.get(c.origen) : undefined
    return {
      productId: r ? r.productId : ((c as { productId?: string | null }).productId ?? null),
      tratamiento: c.tratamiento ?? r?.tratamiento ?? 'IVA_16',
    }
  }
  const foto = (
    porTratamiento: PorTratamientoGlobal,
    lineas: GlobalInvoiceLine[] | undefined,
    conceptos: RenglonParaCfdi[],
    ivaIncluido: boolean,
  ): TicketGlobal => {
    const { reales, motivo } = conceptosRealesDelTicket(conceptos, ivaIncluido, paidCents, porTratamiento, filasD16, renglonDe)
    return {
      ok: true,
      orden: {
        orderId: o.id,
        folio,
        formaPago,
        paidCents,
        renglones,
        porTratamiento,
        ...(lineas ? { lineas } : {}),
        conceptosReales: reales,
        filasD16,
      },
      motivoReales: motivo,
    }
  }

  if (clasificarOrden(tratamientos) === 'TODO_16') {
    // Todo al 16 % (también la venta sin renglones): la línea de hoy, con IVA incluido o aparte, como hoy. Sus reales con el MISMO criterio de
    // «precio con IVA» que la factura individual y la línea (`taxAmount` = 0 o sin renglones).
    const hoy = lineasDeHoy(o)
    if ('motivo' in hoy) return fuera(hoy.motivo, hoy.detalle)
    return foto({ IVA_16: paidCents }, hoy.lineas, hoy.conceptos ?? [ventaSinRenglones(paidCents)], hoy.priceIncludesIva)
  }

  // IVA mezclado: sólo con el precio cobrado con IVA incluido (§4.2; la individual pide lo mismo).
  if (o.contratoDePrecio === 'IVA_APARTE') return fuera('IVA_APARTE_MIXTA')
  if (o.contratoDePrecio !== 'IVA_INCLUIDO') return fuera('CONTRATO_DESCONOCIDO')
  const { items: conceptos, motivos } = reconstruirConceptos(
    { ...o, items: o.items.map(renglonConTratamiento) } as OrdenParaConceptos,
    o.id,
  )
  if (motivos.length > 0) return fuera(clasificarMotivos(motivos), motivos.join(' '))
  // Lo cobrado de cada tratamiento: lo que el cliente pagó por cada concepto (IVA incluido), con su descuento.
  const porTratamiento: PorTratamientoGlobal = {}
  for (const c of conceptos) {
    const t = renglonDe(c).tratamiento as TratamientoGlobal
    porTratamiento[t] = (porTratamiento[t] ?? 0) + importeConceptoCents(c) - aCentavos(c.discountAmount)
  }
  const sumaCents = Object.values(porTratamiento).reduce((s, c) => s + c!, 0)
  if (sumaCents !== paidCents)
    return fuera(
      'NO_CUADRA',
      `Sus productos suman ${pesosTxt(sumaCents)} y se cobraron ${pesosTxt(paidCents)}; no se declara distinto de lo cobrado.`,
    )
  return foto(porTratamiento, undefined, conceptos, true)
}
