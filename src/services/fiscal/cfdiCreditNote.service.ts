// src/services/fiscal/cfdiCreditNote.service.ts
//
// CFDI de EGRESO (nota de crédito) por un REEMBOLSO — emisión MANUAL, nunca automática.
//
// 🔴 Decisión del founder (2026-08-18), alineada con el mercado y con el SAT:
//   - Tras un reembolso la VENTA ORIGINAL NO SE MODIFICA (Toast documenta que `totalAmount`
//     no lo afectan los reembolsos; Square crea una orden de devolución aparte; Clip emite
//     una transacción nueva).
//   - El CFDI de ingreso original NO SE CANCELA. Una factura ya timbrada y pagada no se
//     "corrige" borrándola: el comprobante de la devolución es un documento NUEVO, tipo
//     EGRESO, RELACIONADO al original (TipoRelacion 01 "Nota de crédito de los documentos
//     relacionados", uso G02 "Devoluciones, descuentos o bonificaciones").
//   - Se emite con un BOTÓN. Nunca en automático: timbrar es irreversible (una nota de
//     crédito equivocada sólo se arregla cancelándola ante el SAT) y hay reembolsos que el
//     negocio NO quiere amparar fiscalmente todavía.
//
// Idempotencia: por `refundPaymentId`, vía el único `Cfdi.idempotencyKey`. Dos clics del
// mismo botón NO producen dos notas de crédito.

import { createHash } from 'crypto'
import { CsdStatus, PaymentMethod, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { uploadFileToStorage } from '../storage.service'
import { logAction as defaultLogAction } from '../dashboard/activity-log.service'
import { resolveFiscalProvider } from './fiscalProvider.factory'
import { CLAVE_NOTA_V1, conceptosDeNota, CREDIT_NOTE_RELATIONSHIP, CREDIT_NOTE_USO_CFDI, CreditNoteLine } from './cfdiPayloadBuilder'
import { validateBeforeStamp } from './cfdiValidation'
import { repartirProporcional, splitIvaIncluded } from './ivaMath'
import { mapFormaPago } from './satCatalog'
import {
  STAMPING_TTL_MS,
  consultarIntentoCapturado,
  enviarIntentoCapturado,
  estadoDeCancelacion,
  finalizarEmision,
  sustitutaAtorada,
  importeConceptoCents,
  IssueCfdiDeps,
} from './cfdi.service'
import { BadRequestError, ConflictError } from '../../errors/AppError'
import { bloquearOrdenParaFacturar, tomarAdmisionCompartida } from './admisionIva'
import { huellaDeEntrada, leerEntrada, leerMontosPorRenglon } from './entradaDocumental'
import { conceptoDesdeElPayload, documentoSegunElPac, MOTIVO_OCHO_SIN_REGLA } from './reglaDelPac'
import { netoRenglonCents } from './descuentoPorRenglon'
import {
  aplicarAjustes,
  conceptoDeReal,
  cuadrarPorTasa,
  filasD16DeReales,
  montosDesdeDocumento,
  SIN_FILAS_D16,
} from './globalPorTratamiento'
import { leerGlobal, ordenesDeLaGlobal } from './cfdiGlobal.service'
import { repartoCongeladoDeAjuste } from './deliveryFiscalDelta'
import logger from '../../config/logger'
import { CFDI_VIVO } from './exclusionGlobal'
import { correoCapturado } from './cfdiEmail.service'
import type { CfdiItemInput, CreditNoteParams } from './providers/fiscal-provider.interface'
import { esMarcaDeXmlIlegible, repararArchivosCompartido, type ResultadoDeReparacion } from './finalizadorCfdi'
import type { AjusteAlCobro } from './reglaDelPac'
import type { ConceptoReal } from './globalPorTratamiento'
import {
  asignacionFiscal,
  cabeEnElSaldo,
  cotejarConElXml,
  documentoDeConceptos,
  documentoDelXml,
  FALTA_DE_EVIDENCIA,
  leerXmlConceptos,
  MAX_AJUSTE_DOCUMENTO_CENTS,
  MOTIVO_SALDO_DEL_DOCUMENTO,
  motivoCentavosDeRedondeo,
  motivoExcedeElTotal,
  motivoRedondeoAcumulado,
  motivoRedondeoDeUnaTasa,
  type ComponenteQueSePasa,
  type Componentes,
  MOTIVO_ESPERA_XML,
  MOTIVO_XML_NO_CUADRA,
  REDONDEO_PERMITIDO_CENTS,
  repartoDeLaDevolucion,
  restar,
  resumenDeConceptos,
  resumenDeConceptosParaElPac,
  resumenDelXml,
  TRATAMIENTOS_DE_NOTA,
  unidadesDeConceptos,
  unidadesDeConceptosParaElPac,
  unidadesDelXml,
  type Ambito,
  type Asignacion,
  type FiscalDeNota,
  type MontosDeArticulo,
  type Modalidad,
  type Redondeo,
  type TratamientoDeNota,
  type ToleranciaDeTickets,
  type XmlConceptos,
  cabeEnElDocumentoGlobal,
} from './saldoFiscal'

// Micro-ronda final (nit c): el «en proceso» de la NOTA nombra la nota (antes decía «La factura de esta venta», el texto de la factura) y no
// invita a emitirla otra vez. Sigue diciendo «procesando».
const PROCESANDO = 'La nota de crédito de este reembolso se está procesando; consulta su estado en unos minutos y no la vuelvas a emitir.'
const ENTRADA_INVALIDA = 'La entrada fiscal de esta factura requiere revisión de soporte.'
const cents = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
/** D9: precio por kilo con hasta 6 decimales, como lo congela la entrada. */
const PRECIO_DECIMAL = /^\d{1,10}(\.\d{1,6})?$/

// ─── Tipos ────────────────────────────────────────────────────────────────────

/** El CFDI de ingreso que se va a acreditar (snapshot de la fila `Cfdi`). */
export interface OriginalCfdiForCreditNote {
  id: string
  /** La orden de una factura individual; `null` en una factura GLOBAL (C2 · Tarea 8: el ticket es `refund.orderId`). */
  orderId: string | null
  protocoloIva: number | null
  entrada: unknown
  entradaHuella: string | null
  uuid: string
  serie: string | null
  folio: string | null
  status: string
  cancelStatus: string | null
  subtotalCents: number
  taxCents: number
  totalCents: number
  formaPago: string
  metodoPago: string
  receptorRfc: string
  receptorNombre: string
  receptorRegimen: string
  receptorCp: string
  receptorEmail?: string | null
  /**
   * C2 · Tarea 3, ronda 1 (I1): la original tiene una sustituta VIVA en curso (`replacesCfdiId` = esta original, `CFDI_VIVO`). Lo llena
   * el cargador bajo el MISMO candado de la orden que toma la reserva de la sustituta. Nuevo y opcional.
   */
  sustitutaEnCurso?: boolean
  /** C2 · T10 (N1 de la T3): la sustituta en curso se ENVIÓ al PAC hace más de una hora y sigue sin resolverse. Nuevo y opcional. */
  sustitutaAtorada?: boolean
  /** C2 · T10 (M2 de la T3): con estas se deriva en qué va la cancelación (`estadoDeCancelacion`). Nuevas y opcionales. */
  cancelIntento?: number | null
  cancelEnviadaAt?: Date | null
  cancelAcusadaAt?: Date | null
  /** C2 T7, ronda 1 (M1): cuándo se timbró; el tope por antigüedad de la espera del XML. */
  stampedAt?: Date | null
  /** C2 (D5): el resumen de traslados del XML timbrado (`Cfdi.taxBreakdown`). Sin él, la nota espera el XML (`ESPERA_XML`). */
  taxBreakdown?: unknown
  /** C2 (D5, Tarea 5): los conceptos del XML timbrado (`Cfdi.xmlConceptos`). Sin ellos, la nota espera el XML (`ESPERA_XML`). */
  xmlConceptos?: unknown
  /**
   * C2 T7 (G8): la original PPD tiene complementos de pago vivos (`Cfdi` tipo PAGO de su orden). Sólo lo consulta el cargador cuando la
   * original es PPD; sin pagos, la nota de una original PPD con forma 99 sale con 15 (condonación).
   */
  tienePagos?: boolean
  /**
   * C2 · Tarea 8: la original es la factura GLOBAL (principal o complementaria) cuyo manifiesto tiene la orden del reembolso. La elige el
   * cargador sólo si la venta no tiene una factura individual timbrada. Nuevo y opcional.
   */
  esGlobal?: boolean
  /** C2 · Tarea 8: lo que `leerGlobal` compara de la fila (el emisor escalar, el periodo y la llave, C1 I2). Sólo los trae el cargador. */
  fiscalEmisorId?: string
  globalPeriod?: unknown
  idempotencyKey?: string | null
  /** Ronda 1 de la T8 (M5): `lugarExpedicion` vigente del emisor (el CP del receptor genérico de la nota a una global). */
  fiscalEmisor: {
    id: string
    provider: string
    providerKeyEnc: string | null
    csdStatus: CsdStatus
    serie: string | null
    lugarExpedicion?: string | null
  }
}

/** C2 (Codex C2-19): lo ya acreditado contra una original —por notas vivas— por tratamiento, y por artículo Y tratamiento. */
export interface AcreditadoContra {
  /** Compatibilidad: el total reservado por egresos vivos de esta original (incluidos intentos inciertos). */
  alreadyCreditedCents: number
  /** Lo fiscal de cada nota viva legible (v2: su asignación congelada; v1: sus montos). */
  notas: FiscalDeNota[]
  /** Lo que no se puede atribuir por tratamiento (notas ilegibles o heredadas): baja TODO lo que queda, por conservador. */
  desconocidoCents: number
  /** C2-19: lo acreditado de cada artículo, por tratamiento (de las notas v2 por artículos). */
  porRenglon: Map<string, Partial<Record<TratamientoDeNota, number>>>
  /** C3: alguna nota viva es una extracción (`causa: 'EXTRACCION'`). */
  extraida: boolean
  /**
   * Ronda 1 de la T8 (I2): lo que las notas vivas usaron de la tolerancia de P8 en el ámbito de su TICKET (sólo notas a una global). En el
   * documento global, la base y el IVA pueden pasar lo que queda a lo más esto (más lo de la nota nueva). Nuevo y opcional.
   */
  toleranciaDeTickets?: ToleranciaDeTickets
}

export interface LoadedRefundForCreditNote {
  venueId: string
  venueSlug: string
  refund: {
    id: string
    orderId: string
    type: string | null
    status: string
    /**
     * Parte de MERCANCÍA del reembolso, en centavos POSITIVOS.
     * 🔴 La propina va aparte a propósito: NUNCA formó parte del CFDI (`assembleSaleInput`
     * la excluye), así que acreditarla inventaría un importe que el SAT nunca vio.
     */
    salesRefundCents: number
    tipRefundCents: number
    method: PaymentMethod
    tenderSatFormaPago: string | null
    /** C2 (C2-4, C2-12): `processorData` del reembolso — sus artículos (`refundedItems`) o el reparto congelado de un ajuste de delivery. */
    processorData?: unknown
    /**
     * C2 · T9 ronda 1 (I-1): los artículos devueltos que la factura NO lleva porque no cobraron nada (D9: cortesía, descuento del 100 %),
     * según su RENGLÓN (`netoRenglonCents` = 0), no según `montosPorRenglon`. Lo llena el cargador, acotado a los artículos devueltos.
     */
    noFacturados?: Array<{ orderItemId: string; nombre?: string }>
  }
  /** `null` cuando la venta no tiene un CFDI de ingreso timbrado y vigente. */
  original: OriginalCfdiForCreditNote | null
  /** Compatibilidad de los consumidores previos; el egreso nunca consulta tasas del catálogo. */
  grossByRate: { rate: number; grossCents: number }[]
  /** Saldo reservado por egresos vivos de esta original, incluidos intentos inciertos. */
  alreadyCreditedCents: number
  /** C2 (C2-19): lo ya acreditado contra la original, por tratamiento y por artículo (`acreditadoContra`). */
  acreditado: AcreditadoContra
  /**
   * C2 · Tarea 8 (Codex C2-3): con una original GLOBAL, `acreditado` es lo del TICKET (notas de esta orden contra la global) y esto es lo
   * acreditado contra el DOCUMENTO entero (notas de cualquier ticket contra la global: `acreditadoContra(…, { todoElDocumento: true })`).
   */
  acreditadoDelDocumento?: AcreditadoContra
  /** C2 (P10, Tarea 9): «acreditar por importe» elegido por una persona, sólo si por artículos se detuvo por falta de evidencia. */
  modalidadElegida?: 'POR_IMPORTE'
}

export interface EmitRefundCreditNoteParams {
  venueId: string
  refundPaymentId: string
  sandbox: boolean
  requestedByStaffId?: string | null
  /** Recuperación interna del MCP: jamás autoriza capturar ni enviar. */
  lookupOnly?: boolean
  /**
   * C2 (P10, Tarea 9): «acreditar por importe», elegido por una persona con `cfdi:issue` viendo el importe y el reparto. Sólo se acepta
   * si la devolución por artículos se detuvo por falta de EVIDENCIA; exige `huellaDelReparto`.
   */
  modalidad?: 'POR_IMPORTE'
  /** C2 (Tarea 9): la huella del reparto que la persona vio en la vista previa (`preview.alternativa.huella`). */
  huellaDelReparto?: string
}

export interface EmitRefundCreditNoteDeps {
  findExistingCfdi: IssueCfdiDeps['findExistingCfdi']
  loadRefundForCreditNote: typeof loadRefundForCreditNoteFromDb
  resolveProvider: typeof resolveFiscalProvider
  storeArtifact: IssueCfdiDeps['storeArtifact']
  reserveCfdi: IssueCfdiDeps['reserveCfdi']
  persistCfdi: IssueCfdiDeps['persistCfdi']
  persistArtifacts: IssueCfdiDeps['persistArtifacts']
  runInTransaction: NonNullable<IssueCfdiDeps['runInTransaction']>
  loadEmisor: (id: string, venueId: string) => Promise<any | null>
  loadVenueSlug: (venueId: string) => Promise<string>
  logAction: (params: Record<string, any>) => void
  /**
   * C2 T7 (C2-13, N1): pide los archivos de la original que no tiene su XML. Hace red: se llama FUERA de candados y transacciones.
   * Por omisión la reparación COMPARTIDA (ronda 1, I2: una en vuelo por factura; `limiteMs` = cuánto la espera quien pregunta; `insistir`
   * = el POST pasa del enfriamiento de un `FALLO` reciente).
   */
  repararArchivos: (cfdiId: string, opts: { sandbox?: boolean; limiteMs?: number; insistir?: boolean }) => Promise<ResultadoDeReparacion>
  /**
   * C2 · Tarea 8, SÓLO PARA PRUEBAS (opcional; por omisión no hace nada): se llama dentro de la reserva de una nota a una global, justo
   * después de tomar la fila de la global `FOR UPDATE` y de releer lo acreditado bajo ese candado, con lo acreditado del ticket y del
   * documento. Sirve para pausar en una barrera determinista.
   */
  despuesDelCandadoDeLaGlobal?: (acreditado: { notasDelTicket: FiscalDeNota[]; notasDelDocumento: FiscalDeNota[] }) => Promise<void>
}

export interface EmitRefundCreditNoteResult {
  status: 'STAMPED' | 'VALIDATION_FAILED' | 'STAMP_FAILED'
  cfdi: any
  reasons?: string[]
}

/** Llave de idempotencia de la nota de crédito de UN reembolso. */
export function creditNoteIdempotencyKey(refundPaymentId: string): string {
  return `cfdi-refund-${refundPaymentId}`
}

// ─── Precondiciones (una sola definición, compartida por el botón y por el timbrado) ──

export type CreditNoteBlockReason =
  | 'NOT_A_REFUND'
  | 'REFUND_NOT_COMPLETED'
  | 'NO_ORIGINAL_CFDI'
  | 'ORIGINAL_CANCELLED'
  | 'ORIGINAL_CANCEL_PENDING'
  | 'ORIGINAL_EN_SUSTITUCION'
  | 'TIP_ONLY'
  | 'EXCEEDS_REMAINING'
  | 'ORIGINAL_IVA_MIXTO' // ya no se emite (C2): se conserva en el tipo
  | 'ORIGINAL_ENTRADA_INVALIDA'
  | 'ESPERA_XML'
  | 'XML_IRRECUPERABLE'
  | 'ARTICULO_SIN_EVIDENCIA'
  | 'ARTICULOS_NO_CUADRAN'
  | 'ARTICULO_EXCEDE_LO_FACTURADO'
  | 'CENTAVOS_DE_REDONDEO'
  | 'SIN_MONTO_POR_ARTICULO'
  | 'REPARTO_DE_ENTREGA_INVALIDO'
  | 'IMPORTE_DEVUELTO_INVALIDO'
  | 'OCHO_SIN_REGLA'
  | 'NO_CUADRA_CON_EL_PAC'
  | 'MODALIDAD_NO_PERMITIDA'
  | 'SIN_FORMA_DE_PAGO'

/**
 * C2 (Tarea 3): la original tiene una cancelación en trámite (`cancelStatus = 'REQUESTED'`: anotada, enviándose, en duda o acusada).
 * Solicitar no es cancelar, pero tampoco se timbra una nota contra ella: si el SAT acepta, la nota quedaría relacionada con un CFDI
 * cancelado. La captura la vuelve a revisar bajo el candado de la orden (la intención toma el mismo candado).
 */
export const MOTIVO_ORIGINAL_EN_CANCELACION =
  'La factura original tiene una cancelación en trámite ante el SAT; la nota de crédito se podrá emitir cuando se resuelva.'

/**
 * C2 (Tarea 3, ronda 1, I1 — el espejo de G4): la original se está sustituyendo (su sustituta está reservada, en el PAC o en duda). Si
 * la nota saliera contra ella, la cancelación de la original (motivo 01) la encontraría viva y se rechazaría: dos ingresos vivos por la
 * misma venta. Cuando la sustituta queda timbrada, la nota sale contra la corregida; si falla en definitiva, vuelve a salir contra ésta.
 */
export const MOTIVO_ORIGINAL_EN_SUSTITUCION = 'Esta factura se está sustituyendo; espera a que termine para hacer la nota de crédito.'
/**
 * C2 · T10 (M2 de la T3): el texto dice en qué va la cancelación de la original. «En trámite ante el SAT» (arriba) es sólo la ACUSADA;
 * anotada o enviándose, el SAT todavía no la tiene; en duda, puede tardar hasta 24 h (`PLAZO_DE_LA_DUDA_MS`). Bloquea igual en los tres.
 */
export const MOTIVO_ORIGINAL_CANCELACION_ENVIANDOSE =
  'La cancelación de la factura original se está enviando al SAT; la nota de crédito se podrá emitir cuando se resuelva.'
export const MOTIVO_ORIGINAL_CANCELACION_EN_DUDA =
  'La cancelación de la factura original está en duda: la estamos confirmando con el SAT (puede tardar hasta 24 horas). La nota de crédito se podrá emitir cuando se resuelva.'
/** C2 · T10 (M2 de la T3): el texto de la nota que espera, según en qué va la cancelación de la original. */
export function motivoOriginalEnCancelacion(
  original: Pick<OriginalCfdiForCreditNote, 'cancelStatus' | 'cancelIntento' | 'cancelEnviadaAt' | 'cancelAcusadaAt'>,
  ahora: Date,
): string {
  const e = estadoDeCancelacion(original, ahora)
  if (e === 'ANOTADA' || e === 'ENVIANDO') return MOTIVO_ORIGINAL_CANCELACION_ENVIANDOSE
  if (e === 'CANCELACION_EN_DUDA') return MOTIVO_ORIGINAL_CANCELACION_EN_DUDA
  return MOTIVO_ORIGINAL_EN_CANCELACION
}
/**
 * C2 · T10 (N1 de la re-revisión de la T3): la sustituta se ENVIÓ al PAC hace más de una hora (`sustitutaAtorada`) y no se resolvió:
 * nadie la va a terminar sola (política `CFDI_VIVO`); bloquear sigue siendo lo correcto, pero el texto no promete «espera a que termine».
 */
export const MOTIVO_ORIGINAL_EN_SUSTITUCION_ATORADA =
  'Esta factura se está sustituyendo y la factura nueva lleva más de una hora sin respuesta del PAC. Escríbenos a soporte para resolverla; después podrás hacer la nota de crédito.'

export interface CreditNoteEligibility {
  eligible: boolean
  reason: CreditNoteBlockReason | null
  /** Texto en español, listo para pintarse en la UI o devolverse como error. */
  message: string | null
}

const OK: CreditNoteEligibility = { eligible: true, reason: null, message: null }

// ─── C2 · Tarea 7: la nota v2 ─────────────────────────────────────────────────

/** C2 T7 (N1): el XML de la original se bajó y no se lee; volver a bajarlo da lo mismo. La nota se detiene (nunca espera para siempre). */
export const MOTIVO_XML_ILEGIBLE =
  'El XML timbrado de la factura original no se puede leer, así que la nota de crédito no se emite aquí. Escríbenos a soporte para revisarla.'
/** C2 T7 (N1): la original no tiene identidad del PAC con qué bajar su XML. */
export const MOTIVO_XML_IRRECUPERABLE =
  'No se puede recuperar el XML de la factura original (le falta su identificador del PAC), así que la nota de crédito no se emite aquí. Escríbenos a soporte.'
/** C2 T7 (G8): ni el reembolso, ni la original, ni la condonación dan una forma de pago válida para la nota. */
export const MOTIVO_SIN_FORMA_DE_PAGO =
  'No hay una forma de pago válida para la nota de crédito: el reembolso no tiene una y la factura original dice «por definir» (99) y ya tiene pagos. Hazla con tu contador.'
/** C2 T7 (C2-13): cuánto espera la nota (el botón) a que bajen los archivos de la original. */
export const LIMITE_ESPERA_XML_EN_LA_NOTA_MS = 20_000
/**
 * Ronda 1 (I2): cuánto espera la vista previa a la reparación COMPARTIDA; si no alcanza, dice «lo estamos recuperando» y la siguiente
 * consulta lee el resultado (la reparación sigue sola, una por factura).
 */
export const LIMITE_ESPERA_XML_EN_LA_VISTA_MS = 2_000
/**
 * C2 T7, (B′) DESCARTADA; ronda 1 (I3): cada vez que una nota se detiene por centavos de redondeo de la factura, queda en el log con una
 * etiqueta fija (`C2_CENTAVOS_DE_REDONDEO`) para contar esos casos (por `refundPaymentId`) y revisar (B′) cuando haya facturas mixtas de verdad.
 */
function contarCentavosDeRedondeo(e: CreditNoteEligibility, venueId: string, refundPaymentId: string): void {
  if (e.reason === 'CENTAVOS_DE_REDONDEO') logger.warn('[cfdi-nota] C2_CENTAVOS_DE_REDONDEO', { venueId, refundPaymentId })
}
/**
 * Ronda 1 (I2/M1): lo que dice la reparación del XML de la original. Lo permanente detiene con su motivo; `EN_CURSO` sigue esperando
 * («lo estamos recuperando»); `OK`/`FALLO` piden releer la fila (un `FALLO` pudo dejar escrita la evidencia del XML).
 */
function veredictoDeLaReparacion(r: ResultadoDeReparacion): CreditNoteEligibility | 'RELEER' {
  if (r === 'XML_ILEGIBLE') return detenida('XML_IRRECUPERABLE', MOTIVO_XML_ILEGIBLE)
  if (r === 'XML_NO_DISPONIBLE') return detenida('XML_IRRECUPERABLE', MOTIVO_XML_NO_DISPONIBLE)
  if (r === 'NO_APLICA') return detenida('XML_IRRECUPERABLE', MOTIVO_XML_IRRECUPERABLE)
  if (r === 'EN_CURSO') return detenida('ESPERA_XML', MOTIVO_ESPERA_XML)
  return 'RELEER'
}
/** Ronda 1 (M1): después de intentar, una original de hace más de un día que sigue sin XML deja de prometer «en unos minutos». */
function sigueSinXml(loaded: LoadedRefundForCreditNote): CreditNoteEligibility {
  const st = loaded.original?.stampedAt
  const vieja = !!st && Date.now() - new Date(st).getTime() > ANTIGUEDAD_MAXIMA_SIN_XML_MS
  return vieja ? detenida('XML_IRRECUPERABLE', MOTIVO_XML_ATRASADO) : detenida('ESPERA_XML', MOTIVO_ESPERA_XML)
}
/** C2 T7, ronda 1 (M1): el PAC contestó que ya no entrega ese XML (no lo encuentra, o no da permiso). */
export const MOTIVO_XML_NO_DISPONIBLE =
  'El PAC ya no entrega el XML de la factura original (no la encuentra o no da permiso), así que la nota de crédito no se emite aquí. Escríbenos a soporte.'
/** C2 T7, ronda 1 (M1): el tope por antigüedad: una original timbrada hace más de esto y todavía sin XML deja de prometer «en unos minutos». */
export const ANTIGUEDAD_MAXIMA_SIN_XML_MS = 24 * 60 * 60_000
export const MOTIVO_XML_ATRASADO =
  'No hemos podido recuperar el XML de la factura original (se timbró hace más de un día). Seguimos intentando; si no se resuelve, escríbenos a soporte.'
/** C2 T7 (G6): la nota manual NO se bloquea con la facturación apagada (corrige un documento que ya existe ante el SAT); sólo se avisa. */
export const AVISO_FACTURACION_APAGADA = 'La facturación de este comercio está apagada; esta nota corrige una factura que ya se emitió.'

/** C2 (Codex C2-19): la entrada de una nota v2. Toda nota nueva. Las v1 (ya timbradas) se siguen leyendo con su lector. */
export interface EntradaEgresoV2 {
  version: 2
  tipo: 'EGRESO'
  causa: 'DEVOLUCION'
  orderId: string
  refundPaymentId: string
  /** 🔴 La guarda C2-6 de la cancelación encuentra las notas vivas por esta llave (`documentoRelacionadoVivo`). */
  originalCfdiId: string
  originalUuid: string
  etiquetaOriginal: string
  fiscalEmisorId: string
  originalEsGlobal?: true
  folio?: string
  modalidad: Modalidad
  elegidoPor?: string | null
  devueltoCents: number
  brutoPorTratamiento: Partial<Record<TratamientoDeNota, number>>
  porTratamiento: FiscalDeNota
  porRenglon?: Array<{ orderItemId: string; totalCents: number; porTratamiento: Partial<Record<TratamientoDeNota, number>> }>
  redondeo: Redondeo[]
  ajustes: AjusteAlCobro[]
  montos: { subtotalCents: number; taxCents: number; totalCents: number }
  params: Omit<CreditNoteParams, 'externalId' | 'idempotencyKey' | 'protocoloIva'>
}

/**
 * C2 · Tarea 8 (veredicto `EGRESO_A_GLOBAL = G02_SIN_BLOQUE` de la Tarea 1, medido en el sandbox): la nota relacionada con una global NO
 * lleva el bloque `InformacionGlobal`. Por eso `CreditNoteParams` no gana `global` y el lector exige que no venga.
 */
export const NOTA_A_GLOBAL_LLEVA_BLOQUE = false

const invalida = (message: string): CreditNoteEligibility => ({ eligible: false, reason: 'ORIGINAL_ENTRADA_INVALIDA', message })
const detenida = (reason: CreditNoteBlockReason, message: string): CreditNoteEligibility => ({ eligible: false, reason, message })
/** El total de lo fiscal de un ámbito (todas sus tasas). */
const totalDe = (x: FiscalDeNota): number => Object.values(x).reduce((s, c) => s + (c?.totalCents ?? 0), 0)
/** Ronda 1 (I1): TODO lo acreditado —cada nota viva, en el tratamiento que sea, y lo ilegible—, por su total. */
const acreditadoTotal = (a: AcreditadoContra | undefined): number =>
  (a?.notas ?? []).reduce((s, n) => s + totalDe(n), 0) + (a?.desconocidoCents ?? 0)

/** Lo fiscal de la original: por tratamiento, lo facturado de cada artículo (si hay evidencia), su ámbito y el ajuste de cada tasa. */
export type FiscalDeLaOriginal = {
  fiscal: FiscalDeNota
  montosPorRenglon: Map<string, MontosDeArticulo> | null
  /** T8: el documento global (segundo ámbito). */
  documento?: FiscalDeNota
  /** Ronda 1 (I1): el documento global ENTERO (sin restarle nada): su total es el tope del documento. */
  documentoSinRestar?: FiscalDeNota
  ambito: Ambito
  /** (B): el ajuste de cada tasa en la asignación de la original (cotejada con su XML). */
  ajustePorTratamiento: Partial<Record<TratamientoDeNota, number>>
  /** T8: el folio del ticket en la global (el `NoIdentificacion` que quedó timbrado); la nota lo lleva en cada concepto. */
  folio?: string
}

/**
 * C2 (D5, Codex C2-10/C2-13/C2-14): lo fiscal de la original repartido con la regla del PAC; sin su XML, espera (`ESPERA_XML`). El XML
 * manda: con entrada, el modelo local se coteja concepto por concepto (C2-18) y, si coincide, asigna; si no, revisión de soporte. Una
 * histórica (sin protocolo ni entrada) sale SÓLO de su XML (C2-P5): el no objeto de sus conceptos `ObjetoImp 01` (C2-14). Pura; nunca lanza.
 */
export function fiscalDeLaOriginal(loaded: LoadedRefundForCreditNote): FiscalDeLaOriginal | CreditNoteEligibility {
  const original = loaded.original!
  // Ronda 1 (I2): el veredicto «ilegible» persistido detiene sin red (nadie lo vuelve a bajar).
  if (esMarcaDeXmlIlegible(original.xmlConceptos)) return detenida('XML_IRRECUPERABLE', MOTIVO_XML_ILEGIBLE)
  if (original.taxBreakdown == null || original.xmlConceptos == null) return detenida('ESPERA_XML', MOTIVO_ESPERA_XML)
  const xml = leerXmlConceptos(original.xmlConceptos)
  if (!xml) return invalida(MOTIVO_XML_NO_CUADRA)
  // Tarea 8: la original GLOBAL: el tramo del ticket en la asignación de TODO el documento (y el documento, segundo ámbito).
  if (original.esGlobal) return fiscalDelTicketEnLaGlobal(loaded, xml)
  const e = original.protocoloIva === 1 ? leerEntrada(original.entrada) : null
  if (original.protocoloIva === 1 && !e) return invalida(ENTRADA_INVALIDA)
  let a: ReturnType<typeof asignacionFiscal>
  if (e) {
    // El modelo coteja y asigna; el XML manda (D5). `montosPorRenglon` sólo vale si el cotejo pasó (T6).
    const items = e.params.items
    const cotejo = cotejarConElXml(items, original.taxBreakdown, xml)
    if (cotejo !== true) return invalida(cotejo.invalido)
    a = asignacionFiscal(
      unidadesDeConceptos(items, i => `c${i}`),
      documentoDeConceptos(items),
      resumenDeConceptos(items),
    )
  } else a = asignacionFiscal(unidadesDelXml(xml), documentoDelXml(xml), resumenDelXml(original.taxBreakdown)) // histórica (C2-P5)
  if ('invalido' in a) return invalida(a.invalido)
  const m = e ? leerMontosPorRenglon(e) : null // ronda 1 de la T6: sólo por el accesor (malformado ⇒ null ⇒ «por importe»)
  return {
    fiscal: a.porTratamiento,
    montosPorRenglon: m ? new Map(m.map(x => [x.orderItemId, { totalCents: x.totalCents, porTratamiento: x.porTratamiento }])) : null,
    ambito: 'FACTURA',
    ajustePorTratamiento: a.ajustePorTratamiento,
  }
}

/**
 * Los artículos de una devolución por artículos, como los escribe `issueRefund` (`amountCents`; en filas viejas, `amount` en pesos —la
 * misma lectura que `libroDeLaOrden.ts`—). Un elemento ilegible pasa con importe `NaN`: el reparto lo detiene (`ARTICULOS_NO_CUADRAN`),
 * nunca cambia en silencio de modalidad. El nombre (`productName`) sólo sirve para el texto.
 */
export function refundedItemsDe(processorData: unknown): Array<{ orderItemId: string; amountCents: number; nombre?: string }> {
  const items = (processorData as { refundedItems?: unknown } | null | undefined)?.refundedItems
  if (!Array.isArray(items)) return []
  return items.map(x => {
    const e = (x ?? {}) as { orderItemId?: unknown; amountCents?: unknown; amount?: unknown; productName?: unknown }
    const amountCents = Number.isInteger(e.amountCents)
      ? (e.amountCents as number)
      : e.amountCents === undefined && typeof e.amount === 'number'
        ? Math.round(e.amount * 100)
        : NaN
    return {
      orderItemId: typeof e.orderItemId === 'string' ? e.orderItemId : '',
      amountCents,
      ...(typeof e.productName === 'string' && e.productName.trim() ? { nombre: e.productName.trim() } : {}),
    }
  })
}

// ─── C2 · Tarea 8: la nota de un ticket que entró en la factura global ─────────────

/** El receptor de la nota a una global: el MISMO Público en General de la global (Guía de llenado; medido en el sandbox, T1 de C2). */
const PUBLICO_EN_GENERAL = { rfc: 'XAXX010101000', razonSocial: 'PÚBLICO EN GENERAL', regimenFiscal: '616' } as const

/** Ronda 1 de la T8 (M2): la global del ticket fue cancelada (su motivo propio; la individual conserva el suyo). */
export const MOTIVO_GLOBAL_CANCELADA =
  'La factura global en la que entró este ticket fue cancelada ante el SAT; una nota de crédito no aplica sobre un CFDI cancelado. Si el ticket entra en una nueva factura global, la nota se hace contra ésa.'

/** Ronda 1 de la T8 (I1): la memoria por CONTENIDO de la evaluación de una global (cuántas y cuánto duran). */
export const MEMORIA_DE_GLOBALES = { maximo: 4, ms: 120_000 } as const
/**
 * Ronda 2 de la T8 (N2): lo que le tiene que quedar de vida a la evaluación de la global ANTES de tomar los candados (el tope de la
 * transacción de la reserva, 60 s): así nunca vence —ni se evalúa en frío— con la orden, la admisión y la fila de la global tomadas.
 */
export const VIGENCIA_MINIMA_ANTES_DE_LOS_CANDADOS_MS = 60_000
/**
 * Ronda 2 de la T8 (N2): justo antes de tomar los candados, si a la evaluación de la global le queda menos de
 * `VIGENCIA_MINIMA_ANTES_DE_LOS_CANDADOS_MS`, se reevalúa AQUÍ (fuera de los candados) y se guarda con su vida entera. Así la de bajo candado
 * siempre acierta, aunque la espera del candado cruce los 120 s. Con una individual (o sin XML legible) no hace nada.
 */
export function asegurarGlobalVigente(loaded: LoadedRefundForCreditNote): void {
  const original = loaded.original
  const xml = original?.esGlobal ? leerXmlConceptos(original.xmlConceptos) : null
  if (original && xml) documentoDeLaGlobal(original, xml, VIGENCIA_MINIMA_ANTES_DE_LOS_CANDADOS_MS)
}
/** Ronda 1 de la T8 (I1): vacía la memoria por contenido (pruebas). */
export function olvidarGlobalesEvaluadas(): void {
  memoriaDeGlobales.clear()
}

/** Lo que una global aporta a la nota de CUALQUIERA de sus tickets: sus tickets, la asignación de TODO el documento y el folio de cada uno. */
type DocumentoDeLaGlobal = { ordenes: ReturnType<typeof ordenesDeLaGlobal>; a: Asignacion; folios: Map<string, string> }
/**
 * Ronda 1 de la T8 (I1): la memoria por CONTENIDO de la evaluación de una global. Leerla, cotejarla con su XML y repartirla entera retiene el
 * hilo ~0.9 s con 4,800 tickets (dos tercios son `leerGlobal`). La vista previa, la elegibilidad de fuera y la de bajo candado leen la MISMA
 * fila tres veces (objetos nuevos cada vez): con la llave por contenido la global se evalúa UNA vez —normalmente fuera de los candados— y las
 * demás lecturas sólo pagan la llave. La llave cubre TODO lo que la evaluación lee de la fila —lo que valida `leerGlobal` (id, llave, huella
 * de la entrada, emisor, periodo y montos) más el resumen y los conceptos del XML—: una lectura con cualquiera de esos datos distinto (otra
 * fila, una fila cambiada, o el mismo objeto mutado: M3) se evalúa de nuevo. La entrada entra por su HUELLA (que `leerGlobal` verifica contra
 * el contenido al evaluar): «misma fila y misma huella» (decisión del controlador). Acotada: `MEMORIA_DE_GLOBALES.maximo` globales, cada una
 * `MEMORIA_DE_GLOBALES.ms`; congelar los tramos (O(1) por nota) es del plan aparte de capacidad.
 */
const memoriaDeGlobales = new Map<string, { at: number; r: DocumentoDeLaGlobal | CreditNoteEligibility }>()
function llaveDeLaEvaluacion(original: OriginalCfdiForCreditNote, xml: XmlConceptos): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        original.id,
        original.idempotencyKey ?? null,
        original.entradaHuella ?? null,
        original.fiscalEmisorId ?? null,
        original.globalPeriod ?? null,
        original.subtotalCents,
        original.taxCents,
        original.totalCents,
        original.taxBreakdown ?? null,
      ]),
    )
    .update('\u0000')
    .update(JSON.stringify(xml))
    .digest('hex')
}
function documentoDeLaGlobal(
  original: OriginalCfdiForCreditNote,
  xml: XmlConceptos,
  vidaMinimaMs = 0, // ronda 2 (N2): lo que le tiene que quedar de vida para usarla; si no, se reevalúa
): DocumentoDeLaGlobal | CreditNoteEligibility {
  const llave = llaveDeLaEvaluacion(original, xml)
  const ahora = Date.now()
  const m = memoriaDeGlobales.get(llave)
  if (m && ahora - m.at <= MEMORIA_DE_GLOBALES.ms - vidaMinimaMs) {
    // C2 · OF-2 (T8 N5): un acierto la vuelve la más reciente (misma `at`: no le alarga la vida). Sin esto, la que `asegurarGlobalVigente`
    // acababa de usar podía ser la primera en salir. ponytail: con más de `maximo` globales DISTINTAS evaluadas entre el asegurar y los
    // candados se reevalúa bajo candado (costo, no error); si importa, subir `maximo`.
    memoriaDeGlobales.delete(llave)
    memoriaDeGlobales.set(llave, m)
    return m.r
  }
  const r = congelar(calcularDocumentoDeLaGlobal(original, xml))
  memoriaDeGlobales.delete(llave)
  memoriaDeGlobales.set(llave, { at: ahora, r })
  for (const [k, v] of memoriaDeGlobales) if (ahora - v.at > MEMORIA_DE_GLOBALES.ms) memoriaDeGlobales.delete(k)
  while (memoriaDeGlobales.size > MEMORIA_DE_GLOBALES.maximo) memoriaDeGlobales.delete(memoriaDeGlobales.keys().next().value!)
  return r
}
/**
 * Ronda 2 de la T8 (N3): lo que guarda la memoria se comparte entre peticiones hasta 120 s, así que se congela al guardarlo: los tramos de
 * cada ticket y el documento (lo que `fiscalDelTicketEnLaGlobal` entrega), sus componentes, los ajustes, y cada ticket y la lista. Los
 * `Map` internos no salen de este archivo. Se hace una vez por evaluación.
 */
function congelar<T extends DocumentoDeLaGlobal | CreditNoteEligibility>(r: T): T {
  if ('eligible' in r) {
    Object.freeze(r)
    return r
  }
  const fiscal = (f: FiscalDeNota) => {
    for (const c of Object.values(f)) Object.freeze(c)
    return Object.freeze(f)
  }
  fiscal(r.a.porTratamiento)
  for (const f of r.a.porClave.values()) fiscal(f)
  Object.freeze(r.a.ajustePorTratamiento)
  for (const o of r.ordenes) Object.freeze(o)
  Object.freeze(r.ordenes)
  Object.freeze(r)
  return r
}
function calcularDocumentoDeLaGlobal(original: OriginalCfdiForCreditNote, xml: XmlConceptos): DocumentoDeLaGlobal | CreditNoteEligibility {
  // La entrada entera, como para enviarla (C1: identidad, periodo, cada ticket con su huella y los ajustes congelados reproducidos).
  let g: ReturnType<typeof leerGlobal>
  try {
    g = leerGlobal(original, 'PARA_ENVIAR')
  } catch {
    return invalida(ENTRADA_INVALIDA)
  }
  // C2-13/C2-18: el XML manda; el modelo se coteja con él concepto por concepto (identificación incluida) y, si no coincide, no se usa.
  const cotejo = cotejarConElXml(g.params.items, original.taxBreakdown, xml)
  if (cotejo !== true) return invalida(cotejo.invalido)
  const ordenes = ordenesDeLaGlobal(g)
  // El dueño de cada concepto (los tramos de `ordenesDeLaGlobal` parten `params.items` en orden, y el cotejo ya exigió que el XML tenga esos
  // mismos conceptos en ese orden) y el folio de cada ticket: el `sku` de sus conceptos, que el cotejo exigió IGUAL al `NoIdentificacion`
  // timbrado. 🔴 El folio de la nota lo garantizamos nosotros (la T1 midió que el PAC no lo coteja): es el timbrado de ESE ticket; un ticket
  // sin uno (una global v1 sin `sku`) no tiene folio que llevar ⇒ revisión de soporte.
  const duenoDe: string[] = []
  const folios = new Map<string, string>()
  for (const o of ordenes) {
    const skus = new Set(o.conceptos.map(c => c.sku ?? ''))
    const [folio] = skus
    if (!o.conceptos.length || skus.size !== 1 || !folio) return invalida(ENTRADA_INVALIDA)
    folios.set(o.orderId, folio)
    for (let k = 0; k < o.conceptos.length; k++) duenoDe.push(o.orderId)
  }
  // C2-10 (ajuste de la T4, M-4): TODO el documento se reparte de una vez desde el XML timbrado, con una clave por TICKET: el concepto con el
  // folio (`NoIdentificacion`) de un ticket va a la clave de ESE ticket (su `orderId`). Así un ticket con varios conceptos es UNA clave, y dos
  // tickets con el mismo número (`Order.orderNumber` no es único) no se juntan, que es lo que pasaría agrupando por el texto del folio. La
  // suma de los tramos ES la global.
  const a = asignacionFiscal(
    unidadesDelXml(xml, i => duenoDe[i]),
    documentoDelXml(xml),
    resumenDelXml(original.taxBreakdown),
  )
  if ('invalido' in a) return invalida(a.invalido)
  return { ordenes, a, folios }
}

/**
 * C2 (D6, Codex C2-3/C2-9/C2-10/C2-12/C2-13): lo fiscal de UN ticket dentro de una global viva: su tramo de la asignación de TODO el
 * documento (sus tratamientos salen de SUS conceptos congelados, C2-9: un ticket de cobro sin artículos tiene su concepto al 16 %), lo
 * facturado de cada artículo (de sus conceptos reales, C2-12; sin ellos no hay evidencia), lo que queda del documento entero (C2-3: la global
 * menos TODAS las notas vivas contra ella) y su folio. Pura; nunca lanza.
 */
export function fiscalDelTicketEnLaGlobal(
  loaded: LoadedRefundForCreditNote,
  xml: XmlConceptos,
): FiscalDeLaOriginal | CreditNoteEligibility {
  const d = documentoDeLaGlobal(loaded.original!, xml)
  if ('eligible' in d) return d
  const ticket = d.ordenes.find(o => o.orderId === loaded.refund.orderId)
  const tramo = ticket && d.a.porClave.get(ticket.orderId)
  if (!ticket || !tramo) return invalida(ENTRADA_INVALIDA)
  const reales = ticket.conceptosReales ? asignacionDeReales(ticket.conceptosReales, ticket.porTratamiento, ticket.filasD16) : null
  const doc = loaded.acreditadoDelDocumento
  return {
    fiscal: tramo,
    montosPorRenglon: reales?.montos ?? null,
    // El documento compartido: la nota tiene que caber también en lo que queda de la global entera (ámbito `DOCUMENTO_GLOBAL`).
    documento: restar(d.a.porTratamiento, doc?.notas ?? [], doc?.desconocidoCents ?? 0),
    documentoSinRestar: d.a.porTratamiento,
    ambito: 'TICKET',
    // (B): el ajuste de cada tasa en la asignación de lo que se FACTURÓ de cada artículo (sus reales), la que dio `montosPorRenglon`.
    ajustePorTratamiento: reales?.ajustePorTratamiento ?? {},
    folio: d.folios.get(ticket.orderId)!,
  }
}

/**
 * C2-12 (v5-v7: C1-30, C1-34/35, C1-39/43): los conceptos reales de un ticket son ORIGEN comercial (con su descuento original): se cuadran
 * con `cuadrarPorTasa` (barrera N3 y cada tasa sola) contra lo COBRADO del ticket por tasa, con sus filas D16 congeladas, y el documento ya
 * cuadrado se reparte con la misma asignación. Devuelve lo de cada artículo y el ajuste de cada tasa ((B)); `null` si no cuadran.
 */
function asignacionDeReales(
  reales: ConceptoReal[],
  cobradoPorTasa: Partial<Record<TratamientoDeNota, number>>,
  filasD16: string[][],
): { montos: Map<string, MontosDeArticulo>; ajustePorTratamiento: Partial<Record<TratamientoDeNota, number>> } | null {
  const crudos = reales.map(conceptoDeReal)
  const total = Object.values(cobradoPorTasa).reduce((s, c) => s + (c ?? 0), 0)
  const cuadre = cuadrarPorTasa(crudos, total, { cobradoPorTasa, filasD16: filasD16DeReales(filasD16, reales) })
  if (!cuadre.ok) return null
  const cs = crudos.map((c, i) => ({ ...c, descuentoCents: cuadre.ajustes.find(x => x.indice === i)?.aCents ?? c.descuentoCents }))
  const a = asignacionFiscal(
    unidadesDeConceptosParaElPac(cs, i => reales[i].orderItemId ?? `__${i}`),
    documentoSegunElPac(cs),
    resumenDeConceptosParaElPac(cs),
  )
  if ('invalido' in a) return null
  const montos = new Map<string, MontosDeArticulo>()
  for (const [id, f] of a.porClave) {
    if (id.startsWith('__')) continue // un real sin artículo (p. ej. un cargo) no es evidencia de ningún artículo
    const porTratamiento = Object.fromEntries(
      (Object.entries(f) as Array<[TratamientoDeNota, { totalCents: number }]>).map(([t, c]) => [t, c.totalCents]),
    ) as Partial<Record<TratamientoDeNota, number>>
    montos.set(id, { totalCents: Object.values(porTratamiento).reduce((s, c) => s + (c ?? 0), 0), porTratamiento })
  }
  return { montos, ajustePorTratamiento: a.ajustePorTratamiento }
}

/**
 * C2-12: lo facturado de cada artículo de un ticket de la global, de sus conceptos reales repartidos con la misma regla (lo usa C3). Sin
 * artículo, no hay evidencia; si los reales no cuadran con lo cobrado del ticket, `null`.
 */
export function montosDeReales(
  reales: ConceptoReal[],
  cobradoPorTasa: Partial<Record<TratamientoDeNota, number>>,
  filasD16: string[][],
): Map<string, MontosDeArticulo> | null {
  return asignacionDeReales(reales, cobradoPorTasa, filasD16)?.montos ?? null
}

/** El ticket del reembolso en su global (de la evaluación en memoria), o `null` si la original no es una global o no se lee. */
function ticketDeLaGlobal(loaded: LoadedRefundForCreditNote): { folio: string; formaPago: string } | null {
  const original = loaded.original
  const xml = original?.esGlobal ? leerXmlConceptos(original.xmlConceptos) : null
  if (!original || !xml) return null
  const d = documentoDeLaGlobal(original, xml)
  if ('eligible' in d) return null
  const t = d.ordenes.find(o => o.orderId === loaded.refund.orderId)
  return t ? { folio: d.folios.get(t.orderId)!, formaPago: t.formaPago } : null
}

/** C2 · Tarea 8: el folio del ticket del reembolso en su global (el `NoIdentificacion` timbrado), o `null` si la original no es una global. */
export function folioDelTicket(loaded: LoadedRefundForCreditNote): string | null {
  return ticketDeLaGlobal(loaded)?.folio ?? null
}

export type NotaPorTratamiento = {
  items: CfdiItemInput[]
  entradaParcial: Pick<
    EntradaEgresoV2,
    | 'modalidad'
    | 'devueltoCents'
    | 'brutoPorTratamiento'
    | 'porTratamiento'
    | 'porRenglon'
    | 'redondeo'
    | 'ajustes'
    | 'originalEsGlobal'
    | 'folio'
  >
}

/**
 * C2: la nota de esta devolución por tratamiento, cuadrada con la regla del PAC y dentro de cada saldo; o por qué no. Pura: la decisión que
 * comparten el botón, la vista previa y la captura. Nunca lanza (ajuste de la T4): todo camino inválido sale «detenido con motivo».
 */
export function notaPorTratamiento(loaded: LoadedRefundForCreditNote): NotaPorTratamiento | CreditNoteEligibility {
  try {
    return notaPorTratamientoSinRed(loaded)
  } catch (err) {
    logger.error('[cfdi-nota] la nota no se pudo armar (defecto)', { refundPaymentId: loaded.refund.id, error: String(err) })
    return detenida('NO_CUADRA_CON_EL_PAC', ENTRADA_INVALIDA)
  }
}
function notaPorTratamientoSinRed(loaded: LoadedRefundForCreditNote): NotaPorTratamiento | CreditNoteEligibility {
  const original = loaded.original!
  const f = fiscalDeLaOriginal(loaded)
  if ('eligible' in f) return f
  const saldo = restar(f.fiscal, loaded.acreditado.notas, loaded.acreditado.desconocidoCents)
  // Ronda 1 (I1): el tope por el TOTAL. `restar` sólo recorre los tratamientos de la original: una nota (v1, o ilegible) de un tratamiento
  // que la original no tiene no bajaría ninguno. Ninguna nota pasa «total de la original − TODO lo acreditado», en cada ámbito.
  const devuelto = loaded.refund.salesRefundCents
  const queda = totalDe(f.fiscal) - acreditadoTotal(loaded.acreditado)
  if (devuelto > queda) return detenida('EXCEEDS_REMAINING', motivoExcedeElTotal(devuelto, queda, f.ambito))
  if (f.documentoSinRestar && devuelto > totalDe(f.documentoSinRestar) - acreditadoTotal(loaded.acreditadoDelDocumento))
    return detenida('EXCEEDS_REMAINING', MOTIVO_SALDO_DEL_DOCUMENTO)
  const reparto = repartoDeLaDevolucion(
    {
      salesRefundCents: loaded.refund.salesRefundCents,
      refundedItems: refundedItemsDe(loaded.refund.processorData),
      congelado: repartoCongeladoDeAjuste(loaded.refund.processorData, loaded.refund.salesRefundCents),
      ...(loaded.modalidadElegida ? { modalidadElegida: loaded.modalidadElegida } : {}),
    },
    {
      montosPorRenglon: f.montosPorRenglon,
      acreditadoPorRenglon: loaded.acreditado.porRenglon,
      saldo,
      ajustePorTratamiento: f.ajustePorTratamiento,
      ambito: f.ambito,
    },
  )
  if ('reason' in reparto) return detenida(reparto.reason, reparto.message)
  if (reparto.brutoPorTratamiento.IVA_8) return detenida('OCHO_SIN_REGLA', MOTIVO_OCHO_SIN_REGLA)
  const etiqueta = `${original.serie ?? ''}${original.folio ?? ''}` || original.uuid
  // Tarea 8: la nota a una global lleva en cada concepto el folio del ticket (`NoIdentificacion`), el que quedó timbrado en la global.
  const base = conceptosDeNota(reparto.brutoPorTratamiento, etiqueta, f.folio ? { sku: f.folio } : {})
  // 🔴 Regla del founder (5-oct): la nota da exactamente lo devuelto con el redondeo del PAC (6b), o no se timbra. v5 (Codex C1-30, C2-23):
  // por `cuadrarPorTasa` (C1): barrera N3 —lo de cada concepto ya es lo devuelto de su tasa— y cada tasa se cuadra sola. C1-43 (v7):
  // `SIN_FILAS_D16` — la nota no tiene filas de descuento: cada concepto ES lo devuelto de su tasa con IVA incluido.
  const opts = { cobradoPorTasa: reparto.brutoPorTratamiento, filasD16: SIN_FILAS_D16 }
  const cuadre = cuadrarPorTasa(base.map(conceptoDesdeElPayload), loaded.refund.salesRefundCents, opts)
  if (!cuadre.ok) return detenida('NO_CUADRA_CON_EL_PAC', cuadre.motivo)
  const items = aplicarAjustes(base, cuadre.ajustes, loaded.refund.salesRefundCents, opts) // C1-36: confinado por tasa
  if (!items) return detenida('NO_CUADRA_CON_EL_PAC', ENTRADA_INVALIDA)
  // Lo fiscal de la NOTA, con la misma asignación que su original (C2-10).
  const propia = asignacionFiscal(
    unidadesDeConceptos(items, () => 'nota'),
    documentoDeConceptos(items),
    resumenDeConceptos(items),
  )
  if ('invalido' in propia) return detenida('NO_CUADRA_CON_EL_PAC', propia.invalido)
  const cabe = cabeEnElSaldo(propia.porTratamiento, saldo, f.ambito)
  if (!cabe.ok) {
    // Ronda 1 (I3): una tasa que se pasa por CENTAVOS —en su total, su base o su IVA, fuera de la rama «agota» de I-3, que ya tiene su
    // texto— es el redondeo de la factura (la 6b pudo mover el centavo a otra tasa, o el ajuste de la tasa quedó en lo que queda; no hay
    // dato para saber cuál): se dice así, y se cuenta. Medido con la 6b real: el texto genérico decía «$136.02 excede $136.03». Más de
    // 2 ¢ sigue «excede».
    // C2 · OF-2 (T7 N2): cuánto se pasa y en QUÉ componente (el total primero en un empate).
    let sobra = -Infinity
    let componente: ComponenteQueSePasa = 'TOTAL'
    for (const [t, c] of Object.entries(propia.porTratamiento) as Array<[TratamientoDeNota, Componentes]>) {
      const q = saldo[t] ?? { baseCents: 0, ivaCents: 0, totalCents: 0 }
      for (const [k, comp] of [
        ['totalCents', 'TOTAL'],
        ['baseCents', 'BASE'],
        ['ivaCents', 'IVA'],
      ] as const) {
        if (c[k] - q[k] > sobra) [sobra, componente] = [c[k] - q[k], comp]
      }
    }
    const agota = cabe.message.startsWith(motivoRedondeoAcumulado(0).slice(0, 30))
    if (!agota && sobra >= 1 && sobra <= MAX_AJUSTE_DOCUMENTO_CENTS) {
      // Con UNA tasa no hay otra adonde la 6b haya movido el centavo: el reparto base/IVA lo dejaron las notas anteriores (o la original).
      // No es el caso que cuenta `C2_CENTAVOS_DE_REDONDEO`.
      if (Object.keys(saldo).length === 1) {
        const hayNotas = loaded.acreditado.notas.length > 0 || loaded.acreditado.desconocidoCents > 0
        return detenida('EXCEEDS_REMAINING', componente === 'TOTAL' ? cabe.message : motivoRedondeoDeUnaTasa(componente, sobra, hayNotas))
      }
      const nombres = refundedItemsDe(loaded.refund.processorData).filter(x => x.amountCents > 0)
      return detenida(
        'CENTAVOS_DE_REDONDEO',
        motivoCentavosDeRedondeo(nombres.length === 1 ? nombres[0].nombre : undefined, sobra, 'TASA', componente),
      )
    }
    return detenida('EXCEEDS_REMAINING', cabe.message)
  }
  let redondeo = [...(reparto.redondeo ?? []), ...cabe.redondeo]
  if (f.documento) {
    // Ronda 1 (I2): P8 es POR TICKET (arriba); el documento admite la deriva de base/IVA hasta lo que los tickets ya usaron de P8 —las notas
    // vivas y ésta—, y la registra (`cabeEnElDocumentoGlobal`). El total nunca se pasa.
    const tolerancia = sumarTolerancias(loaded.acreditadoDelDocumento?.toleranciaDeTickets ?? {}, cabe.redondeo)
    const doc = cabeEnElDocumentoGlobal(propia.porTratamiento, f.documento, tolerancia)
    if (!doc.ok) return detenida('EXCEEDS_REMAINING', doc.message)
    redondeo = [...redondeo, ...doc.redondeo]
  }
  return {
    items,
    entradaParcial: {
      modalidad: reparto.modalidad,
      devueltoCents: loaded.refund.salesRefundCents,
      brutoPorTratamiento: reparto.brutoPorTratamiento,
      porTratamiento: propia.porTratamiento,
      ...(reparto.porRenglon ? { porRenglon: reparto.porRenglon } : {}),
      redondeo,
      ajustes: cuadre.ajustes,
      ...(f.folio ? { originalEsGlobal: true as const, folio: f.folio } : {}),
    },
  }
}

/** Ronda 1 (I2): lo que las notas vivas usaron de P8 por ticket, más lo que usa ésta en SU ticket (su redondeo de ámbito `TICKET`). */
function sumarTolerancias(previas: ToleranciaDeTickets, propias: Redondeo[]): ToleranciaDeTickets {
  const r: ToleranciaDeTickets = {}
  for (const [t, c] of Object.entries(previas) as Array<[TratamientoDeNota, { baseCents: number; ivaCents: number }]>)
    r[t] = { baseCents: c.baseCents, ivaCents: c.ivaCents }
  for (const x of propias)
    if (x.ambito === 'TICKET' && (x.componente === 'BASE' || x.componente === 'IVA')) {
      const t = (r[x.tratamiento] ??= { baseCents: 0, ivaCents: 0 })
      if (x.componente === 'BASE') t.baseCents += x.cents
      else t.ivaCents += x.cents
    }
  return r
}

// ─── C2 · Tarea 9: «acreditar por importe» (P10; Codex C2-16) ─────────────────

/** C2 (Tarea 9): la elección «por importe» llegó sin la huella del reparto que la persona vio. */
export const MOTIVO_FALTA_LA_HUELLA =
  'Para acreditar por importe hace falta la huella del reparto que viste en la vista previa; vuelve a revisarla.'
/** C2 (Tarea 9): entre la vista previa y la confirmación cambió el reparto (p. ej. se timbró otra nota de la misma factura). */
export const MOTIVO_REPARTO_CAMBIO = 'El reparto cambió desde la vista previa; vuelve a revisarlo.'
/**
 * C2 · T10 ronda 1 (M9): la emisión NORMAL llegó con la huella de la vista previa que la persona vio y, bajo los candados, lo que se iba a
 * timbrar ya no es eso (p. ej. otra nota de la misma factura se timbró en medio y cambió el reparto por tasa). No se timbra nada.
 */
export const MOTIVO_NOTA_CAMBIO = 'La factura cambió desde que la revisaste; vuelve a revisar la nota.'

/** C2 (Tarea 9): lo que la vista previa ofrece cuando por artículos se detuvo por falta de evidencia. */
export type AlternativaPorImporte = NotaPorTratamiento & { huella: string; aviso?: string }

/**
 * C2 (Tarea 9): la huella del reparto «por importe» — lo que la persona vio y confirma: el reembolso, lo devuelto de cada tratamiento, lo
 * fiscal de la nota por tratamiento y los ajustes de la 6b. La reserva la recalcula bajo los candados con lo acreditado releído.
 */
export function huellaDelReparto(
  r: Pick<EntradaEgresoV2, 'refundPaymentId' | 'originalUuid' | 'brutoPorTratamiento' | 'porTratamiento' | 'ajustes' | 'redondeo'>,
): string {
  // Ronda 1 (M-1): también el REDONDEO declarado (una nota intermedia puede cambiarlo sin cambiar el reparto) y la factura ORIGINAL (una
  // sustitución en medio cambiaría con qué factura se relaciona la nota).
  return huellaDeEntrada({
    refundPaymentId: r.refundPaymentId,
    originalUuid: r.originalUuid,
    brutoPorTratamiento: r.brutoPorTratamiento,
    porTratamiento: r.porTratamiento,
    ajustes: r.ajustes,
    redondeo: r.redondeo,
  })
}

const pesos = (c: number) => `$${(c / 100).toFixed(2)}`
/** ¿El bloqueo es por falta de EVIDENCIA de lo facturado de cada artículo (P10)? */
const faltaEvidencia = (e: CreditNoteEligibility): boolean =>
  !e.eligible && (FALTA_DE_EVIDENCIA as readonly string[]).includes(e.reason ?? '')

/**
 * C2 (Tarea 9; ajuste del controlador; ronda 1, I-1): algún artículo devuelto NO está en la factura —una cortesía de D9 que no cobró nada
 * (lo dice su RENGLÓN: `refund.noFacturados`, lo llena el cargador) o un artículo fuera de `montosPorRenglon`— y la devolución por
 * artículos regresó dinero por él. Acreditar por importe acredita ese dinero contra lo que queda: la vista previa lo dice con todas sus
 * letras, nombrando el artículo. No depende de `montosPorRenglon` (las facturas de antes de C2 no lo traen).
 */
function avisoDeArticulosSinFactura(loaded: LoadedRefundForCreditNote): string | undefined {
  const f = fiscalDeLaOriginal(loaded)
  const montos = 'eligible' in f ? null : f.montosPorRenglon
  const cortesias = new Map((loaded.refund.noFacturados ?? []).map(x => [x.orderItemId, x.nombre]))
  const fuera = refundedItemsDe(loaded.refund.processorData).filter(
    x => x.amountCents > 0 && (cortesias.has(x.orderItemId) || (montos !== null && !montos.has(x.orderItemId))),
  )
  if (!fuera.length) return undefined
  const cuanto = pesos(fuera.reduce((s, x) => s + x.amountCents, 0))
  const nombre = fuera.length === 1 ? (fuera[0].nombre ?? cortesias.get(fuera[0].orderItemId)) : undefined
  const quien =
    fuera.length === 1 ? (nombre ? `«${nombre}»` : 'Un artículo de esta devolución') : `${fuera.length} artículos de esta devolución`
  const verbo = fuera.length === 1 ? 'no aparece' : 'no aparecen'
  // Ronda 1 (M-3): en una global lo que queda es lo del TICKET.
  const contra = loaded.original?.esGlobal ? 'lo que queda de este ticket en la factura global' : 'lo que queda de la factura'
  return (
    `${quien} ${verbo} en la factura (por ejemplo, una cortesía que no se cobró). Si acreditas por importe, lo que se devolvió ` +
    `(${cuanto}) también se acredita, repartido por tasa contra ${contra}. Confírmalo sólo si ese dinero sí se facturó.`
  )
}
/** C2 (P10): la alternativa «por importe», SÓLO cuando la devolución por artículos se detuvo por falta de EVIDENCIA. Pura. */
export function alternativaPorImporte(loaded: LoadedRefundForCreditNote): AlternativaPorImporte | null {
  if (loaded.modalidadElegida) return null
  // La elegibilidad ENTERA (no sólo la nota): una original cancelada, en trámite o en sustitución no ofrece nada, aunque además falte
  // evidencia.
  const e = checkCreditNoteEligibility(loaded)
  if (!faltaEvidencia(e)) return null
  const elegida: LoadedRefundForCreditNote = { ...loaded, modalidadElegida: 'POR_IMPORTE' }
  // Se ofrece sólo si «por importe» de verdad se podría emitir (cabe, cuadra con el PAC, tiene forma de pago…).
  if (!checkCreditNoteEligibility(elegida).eligible) return null
  const alt = notaPorTratamiento(elegida)
  if ('eligible' in alt) return null
  const aviso = avisoDeArticulosSinFactura(loaded) // ronda 1 (I-1): con cualquier falta de evidencia, no sólo ARTICULO_SIN_EVIDENCIA
  const huella = huellaDelReparto({ refundPaymentId: loaded.refund.id, originalUuid: loaded.original!.uuid, ...alt.entradaParcial })
  return { ...alt, huella, ...(aviso ? { aviso } : {}) }
}

/**
 * C2 (Tarea 9): la vista previa no promete lo que no hay. Si por artículos falta evidencia pero «por importe» TAMBIÉN se detendría, el
 * texto de la falta de evidencia («Puedes acreditar lo devuelto por importe…») se cambia por uno que dice por qué tampoco se puede. El
 * motivo (`reason`) se conserva.
 */
export function motivoTampocoPorImporte(porQue: string): string {
  return `No se puede comprobar lo facturado de cada artículo de esta devolución, y tampoco se puede acreditar por importe: ${porQue}`
}

/**
 * C2 T7 (G8; Anexo 20 pp. 6-7, Apéndice 5 pp. 65-66, FAQ 30 p. 86): la forma de pago de la nota es la del REEMBOLSO (así se devolvió el
 * dinero); si no tiene una SAT, la de la original si no es 99; si no, 15 (condonación) SÓLO si la original es PPD y no tiene pagos; si no, se
 * detiene con su motivo. La nota es siempre PUE.
 */
export function formaPagoDeLaNota(loaded: LoadedRefundForCreditNote): string | CreditNoteEligibility {
  const original = loaded.original!
  const refundForma = mapFormaPago(loaded.refund.method, loaded.refund.tenderSatFormaPago)
  if (refundForma !== '99') return refundForma
  // Ronda 1 de la T8 (M1): en una global, «la de la original» es la del TICKET (la congelada en la entrada, nunca 99), no la de la global
  // (la que más suma entre TODOS sus tickets). La global es PUE: no cae a 15.
  if (original.esGlobal) {
    const forma = ticketDeLaGlobal(loaded)?.formaPago
    return forma && forma !== '99' ? forma : detenida('SIN_FORMA_DE_PAGO', MOTIVO_SIN_FORMA_DE_PAGO)
  }
  if (original.formaPago && original.formaPago !== '99') return original.formaPago
  if (original.metodoPago === 'PPD' && !original.tienePagos) return '15'
  return detenida('SIN_FORMA_DE_PAGO', MOTIVO_SIN_FORMA_DE_PAGO)
}

const AMBITOS: readonly Ambito[] = ['FACTURA', 'TICKET', 'DOCUMENTO_GLOBAL']
const entero = (c: unknown) => Number.isSafeInteger(c) && (c as number) > 0
/** C2-19: sólo una nota por artículos lleva `porRenglon`; cada renglón suma su total por tratamiento, y los renglones suman lo devuelto y el bruto. */
export function porRenglonValido(e: EntradaEgresoV2): boolean {
  if (e.porRenglon === undefined) return e.modalidad !== 'POR_ARTICULOS'
  const filas = e.modalidad === 'POR_ARTICULOS' && Array.isArray(e.porRenglon) && e.porRenglon.length > 0 ? e.porRenglon : null
  if (!filas) return false
  const bruto: Record<string, number> = {}
  for (const f of filas) {
    const partes = Object.entries(f?.porTratamiento ?? {})
    if (
      typeof f?.orderItemId !== 'string' ||
      !entero(f.totalCents) ||
      !partes.length ||
      partes.some(([t, c]) => !TRATAMIENTOS_DE_NOTA.includes(t as TratamientoDeNota) || !entero(c))
    )
      return false
    if (partes.reduce((s, [, c]) => s + c!, 0) !== f.totalCents) return false
    for (const [t, c] of partes) bruto[t] = (bruto[t] ?? 0) + c!
  }
  return (
    filas.reduce((s, f) => s + f.totalCents, 0) === e.devueltoCents && huellaDeEntrada(bruto) === huellaDeEntrada(e.brutoPorTratamiento)
  )
}

/** El redondeo declarado de una entrada v2: BASE/IVA ≤ 1 ¢ por ámbito (P8); ARTICULO ≤ 2 ¢ de un artículo de la nota ((B)). */
function redondeoValido(e: EntradaEgresoV2): boolean {
  return (
    Array.isArray(e.redondeo) &&
    e.redondeo.every(
      r =>
        !!r &&
        typeof r.tratamiento === 'string' &&
        r.tratamiento in (e.porTratamiento ?? {}) &&
        AMBITOS.includes(r.ambito) &&
        Number.isSafeInteger(r.cents) &&
        r.cents >= 1 &&
        (r.componente === 'ARTICULO'
          ? r.cents <= MAX_AJUSTE_DOCUMENTO_CENTS &&
            typeof r.orderItemId === 'string' &&
            !!e.porRenglon?.some(f => f.orderItemId === r.orderItemId)
          : (r.componente === 'BASE' || r.componente === 'IVA') &&
            r.orderItemId === undefined &&
            (r.ambito === 'DOCUMENTO_GLOBAL'
              ? // Ronda 1 de la T8 (I2): la deriva del documento global puede pasar de 1 ¢ (la acota la suma de tolerancias por ticket al
                // capturar); sólo en una nota a una global y nunca más que su propia base o IVA de esa tasa.
                e.originalEsGlobal === true &&
                r.cents <=
                  (r.componente === 'BASE' ? e.porTratamiento[r.tratamiento]!.baseCents : e.porTratamiento[r.tratamiento]!.ivaCents)
              : r.cents <= REDONDEO_PERMITIDO_CENTS)),
    )
  )
}

/**
 * C2 T7: lo ya acreditado contra una original, por las notas VIVAS (incluidos intentos inciertos). Sale del cargador para reutilizarlo
 * (C3 lo usa con `todoElDocumento`: las notas de cualquier orden ligadas por `entrada.originalCfdiId`). Por cada nota viva leída de esta
 * original: v2 ⇒ su asignación congelada (`porTratamiento`) y, por artículo Y tratamiento, su `porRenglon` (C2-19); v1 ⇒ sus montos (todo
 * al 16 %, o todo no objeto si era sin IVA histórico). Ilegible o heredada (sin protocolo) ⇒ `desconocidoCents` (baja todo, conservador).
 * Consultas acotadas: páginas de 100 por `id`.
 */
export async function acreditadoContra(
  tx: Prisma.TransactionClient,
  p: { venueId: string; orderId: string | null; originalCfdiId: string; excludeCfdiId?: string; todoElDocumento?: boolean },
): Promise<AcreditadoContra> {
  const r: AcreditadoContra = { alreadyCreditedCents: 0, notas: [], desconocidoCents: 0, porRenglon: new Map(), extraida: false }
  const liveWhere: Prisma.CfdiWhereInput = {
    venueId: p.venueId,
    type: 'EGRESO',
    ...CFDI_VIVO,
    ...(p.todoElDocumento ? { entrada: { path: ['originalCfdiId'], equals: p.originalCfdiId } } : { orderId: p.orderId }),
    ...(p.excludeCfdiId ? { id: { not: p.excludeCfdiId } } : {}),
  }
  // Legacy sin vínculo fiable cuenta contra la orden (no se puede ligar a una global).
  if (!p.todoElDocumento) {
    const historical = await tx.cfdi.aggregate({ where: { ...liveWhere, protocoloIva: null }, _sum: { totalCents: true } })
    r.desconocidoCents += historical._sum.totalCents ?? 0
  }
  let after: string | undefined
  for (;;) {
    const page = await tx.cfdi.findMany({
      where: { ...liveWhere, protocoloIva: { not: null }, ...(after ? { AND: [CFDI_VIVO, { id: { gt: after } }] } : {}) },
      orderBy: { id: 'asc' },
      take: 100,
    })
    for (const cfdi of page) {
      let e: EntradaEgresoV1 | EntradaEgresoV2
      try {
        e = leerEgreso(cfdi)
      } catch {
        r.desconocidoCents += cfdi.totalCents // vínculo desconocido: reservar saldo
        continue
      }
      if (e.originalCfdiId !== p.originalCfdiId) continue
      if (e.version === 2) {
        acumularNota(r, e)
        if ((e as { causa?: string }).causa === 'EXTRACCION') r.extraida = true
      } else
        r.notas.push(
          e.originalSinIvaHistorico
            ? { NO_OBJETO: { baseCents: cfdi.totalCents, ivaCents: 0, totalCents: cfdi.totalCents } }
            : { IVA_16: { baseCents: cfdi.subtotalCents, ivaCents: cfdi.taxCents, totalCents: cfdi.totalCents } },
        )
      r.alreadyCreditedCents += cfdi.totalCents
    }
    if (page.length < 100) break
    after = page[page.length - 1].id
  }
  r.alreadyCreditedCents += r.desconocidoCents
  return r
}

/**
 * Lo que una nota v2 viva suma a lo acreditado: su asignación congelada (por tratamiento), lo de cada artículo por tratamiento (C2-19) y
 * —ronda 1 de la T8, I2— lo que usó de la tolerancia de P8 en el ámbito de su TICKET. Una sola definición: la usan `acreditadoContra` y las
 * pruebas que encadenan notas.
 */
export function acumularNota(
  r: AcreditadoContra,
  e: Pick<EntradaEgresoV2, 'porTratamiento' | 'porRenglon' | 'redondeo'>,
): AcreditadoContra {
  r.notas.push(e.porTratamiento)
  for (const f of e.porRenglon ?? []) {
    const a = r.porRenglon.get(f.orderItemId) ?? {}
    for (const [t, c] of Object.entries(f.porTratamiento) as Array<[TratamientoDeNota, number]>) a[t] = (a[t] ?? 0) + c
    r.porRenglon.set(f.orderItemId, a)
  }
  // I2: los centavos de base y de IVA que la nota usó de P8 en el ámbito de su TICKET (los del documento no: ésos son la deriva misma).
  for (const x of e.redondeo ?? [])
    if (x.ambito === 'TICKET' && (x.componente === 'BASE' || x.componente === 'IVA')) {
      const tol = (r.toleranciaDeTickets ??= {})
      const t = (tol[x.tratamiento] ??= { baseCents: 0, ivaCents: 0 })
      if (x.componente === 'BASE') t.baseCents += x.cents
      else t.ivaCents += x.cents
    }
  return r
}

/**
 * PURA. ¿Se puede emitir la nota de crédito de este reembolso?
 *
 * 🔴 Una sola definición a propósito: el botón del dashboard y el timbrado real leen ESTO.
 * Si la UI y el servicio evaluaran por su cuenta, el botón se vería habilitado y el clic
 * fallaría — o peor, al revés: escondido cuando sí procedía.
 */
export function checkCreditNoteEligibility(loaded: LoadedRefundForCreditNote): CreditNoteEligibility {
  const { refund, original } = loaded
  if (refund.type !== 'REFUND') {
    return {
      eligible: false,
      reason: 'NOT_A_REFUND',
      message: 'El pago indicado no es un reembolso; una nota de crédito sólo ampara devoluciones.',
    }
  }
  if (refund.status !== 'COMPLETED') {
    return {
      eligible: false,
      reason: 'REFUND_NOT_COMPLETED',
      message: 'El reembolso no está completado; no se puede facturar una devolución que aún no salió.',
    }
  }
  if (!original) {
    return {
      eligible: false,
      reason: 'NO_ORIGINAL_CFDI',
      message:
        'La venta no tiene una factura (CFDI de ingreso) timbrada, así que no hay nada que acreditar. Si el cliente necesita comprobante de la devolución, primero se factura la venta.',
    }
  }
  if (original.cancelStatus === 'CANCELLED' || original.cancelStatus === 'ACCEPTED' || original.status === 'CANCELLED') {
    return {
      eligible: false,
      reason: 'ORIGINAL_CANCELLED',
      // Ronda 1 de la T8 (M2): una global cancelada lo dice con su motivo propio (el ticket puede entrar en otra global).
      message: original.esGlobal
        ? MOTIVO_GLOBAL_CANCELADA
        : 'La factura original fue cancelada; una nota de crédito no aplica sobre un CFDI cancelado.',
    }
  }
  // C2 · Tarea 3: con la cancelación en trámite (anotada, enviándose, en duda o acusada) la nota espera. La reserva lo vuelve a
  // revisar con la original releída bajo el candado de la orden, el mismo que toma `anotarIntencionDeCancelar`.
  // T10 (M2 de la T3): el texto dice en qué va (se está enviando · en duda · en trámite); bloquea igual en los tres.
  if (original.cancelStatus === 'REQUESTED')
    return { eligible: false, reason: 'ORIGINAL_CANCEL_PENDING', message: motivoOriginalEnCancelacion(original, new Date()) }
  // C2 · Tarea 3, ronda 1 (I1, el espejo de G4): con una sustitución en curso, la nota espera; la revisión bajo candado lo relee.
  // T10 (N1 de la T3): si la sustituta se atoró en el PAC, el texto manda a soporte (nadie la va a terminar sola).
  if (original.sustitutaEnCurso)
    return {
      eligible: false,
      reason: 'ORIGINAL_EN_SUSTITUCION',
      message: original.sustitutaAtorada ? MOTIVO_ORIGINAL_EN_SUSTITUCION_ATORADA : MOTIVO_ORIGINAL_EN_SUSTITUCION,
    }
  // C2 · Tarea 8: la entrada de una GLOBAL no es la de una factura individual: la lee `leerGlobal` (y se coteja con su XML) al sacar el tramo.
  if (!original.esGlobal && !(original.protocoloIva === null && original.entrada == null)) {
    const e = leerEntrada(original.entrada)
    const tratamientos = ['IVA_16', 'IVA_8', 'IVA_0', 'EXENTO', 'NO_OBJETO', 'BLOQUEADO_03', 'BLOQUEADO_04']
    let valid = false
    try {
      valid =
        original.protocoloIva === 1 &&
        !!e &&
        e.orderId === refund.orderId &&
        original.orderId === refund.orderId &&
        e.fiscalEmisorId === original.fiscalEmisor.id &&
        huellaDeEntrada(e) === original.entradaHuella &&
        cents(e.paidCents) &&
        [e.montos.subtotalCents, e.montos.taxCents, e.montos.totalCents].every(cents) &&
        e.montos.subtotalCents === original.subtotalCents &&
        e.montos.taxCents === original.taxCents &&
        e.montos.totalCents === original.totalCents &&
        e.montos.subtotalCents + e.montos.taxCents === e.montos.totalCents &&
        e.renglones.every(r => r.orderItemId.length > 0 && tratamientos.includes(r.tratamiento)) &&
        new Set(e.renglones.map(r => r.orderItemId)).size === e.renglones.length &&
        e.params.receptor?.rfc === original.receptorRfc &&
        e.params.receptor.razonSocial === original.receptorNombre &&
        e.params.receptor.regimenFiscal === original.receptorRegimen &&
        e.params.receptor.codigoPostal === original.receptorCp &&
        ['PUE', 'PPD'].includes(e.params.metodoPago) &&
        Array.isArray(e.params.items) &&
        e.params.items.every(
          i =>
            i &&
            cents(i.unitPriceCents) &&
            cents(i.discountCents) &&
            (i.unitPriceDecimal === undefined || (typeof i.unitPriceDecimal === 'string' && PRECIO_DECIMAL.test(i.unitPriceDecimal))) &&
            typeof i.taxIncluded === 'boolean' &&
            Number.isFinite(i.quantity) &&
            i.quantity > 0 &&
            ['01', '02', '03', '04'].includes(i.objetoImp) &&
            Array.isArray(i.taxes) &&
            i.taxes.every(
              t =>
                t &&
                t.type === 'IVA' &&
                ['Tasa', 'Exento'].includes(t.factor) &&
                Number.isFinite(t.rate) &&
                typeof t.withholding === 'boolean',
            ) &&
            (e.clasificacion !== 'TODO_16' ||
              (i.objetoImp === '02' &&
                i.taxes.length === 1 &&
                i.taxes[0].rate === 0.16 &&
                i.taxes[0].factor === 'Tasa' &&
                i.taxes[0].withholding === false)),
        ) &&
        e.clasificacion === (e.renglones.some(r => r.tratamiento !== 'IVA_16') ? 'MIXTA' : 'TODO_16') &&
        validateBeforeStamp({
          csdStatus: 'ACTIVE',
          formaPago: e.params.formaPago,
          receptor: e.params.receptor,
          items: e.params.items,
          expectedSubtotalCents: e.montos.subtotalCents,
          expectedTaxCents: e.montos.taxCents,
          expectedTotalCents: e.montos.totalCents,
          isGlobal: false,
        }).valid
      if (valid && e!.clasificacion === 'TODO_16') {
        let cuadraPorConcepto = true
        let subtotalCents = 0
        let totalCents = 0
        for (const item of e!.params.items) {
          const precio =
            item.unitPriceDecimal !== undefined
              ? new Prisma.Decimal(item.unitPriceDecimal)
              : new Prisma.Decimal(item.unitPriceCents).div(100)
          // Mismo half-up por concepto y descuento por línea que la captura individual.
          const lineCents = importeConceptoCents({ unitPrice: precio, quantity: item.quantity }) - item.discountCents
          const total = item.taxIncluded ? lineCents : Math.round(lineCents * (1 + 0.16))
          const subtotal = item.taxIncluded ? splitIvaIncluded(lineCents, 0.16).netCents : lineCents
          if (![lineCents, subtotal, total].every(cents)) {
            cuadraPorConcepto = false
            break
          }
          subtotalCents += subtotal
          totalCents += total
        }
        cuadraPorConcepto =
          cuadraPorConcepto &&
          cents(subtotalCents) &&
          cents(totalCents) &&
          subtotalCents === e!.montos.subtotalCents &&
          totalCents - subtotalCents === e!.montos.taxCents &&
          totalCents === e!.montos.totalCents
        // B3a Tarea 6b: una factura ajustada guarda los montos del PAC (base neta del descuento, IVA por tasa, total = lo cobrado).
        const pac = documentoSegunElPac(e!.params.items.map(conceptoDesdeElPayload))
        const cuadraConElPac =
          pac.subtotalCents - pac.descuentoCents === e!.montos.subtotalCents &&
          pac.ivaCents === e!.montos.taxCents &&
          pac.totalCents === e!.montos.totalCents
        valid = cuadraPorConcepto || cuadraConElPac
      }
    } catch {
      valid = false
    }
    if (!valid) return { eligible: false, reason: 'ORIGINAL_ENTRADA_INVALIDA', message: ENTRADA_INVALIDA }
    // C2 (§4.4): una original con IVA distinto de 16 % ya no se detiene (`ORIGINAL_IVA_MIXTO`): su nota sale por tasa (abajo).
  }
  if (refund.salesRefundCents <= 0) {
    return {
      eligible: false,
      reason: 'TIP_ONLY',
      message: 'Este reembolso sólo devolvió propina, y la propina nunca formó parte del CFDI. No hay importe que acreditar fiscalmente.',
    }
  }
  // C2 T7: la nota por tratamiento —lo fiscal de la original y de la nota con la misma asignación, la modalidad con evidencia, cada saldo
  // por tratamiento y el redondeo declarado— y su forma de pago (G8). Lo que queda ya no es «total − notas»: lo dice `cabeEnElSaldo`.
  const nota = notaPorTratamiento(loaded)
  if ('eligible' in nota) return nota
  const forma = formaPagoDeLaNota(loaded)
  if (typeof forma !== 'string') return forma
  return OK
}

// ─── Reparto puro del importe acreditado entre las tasas reales ───────────────

/**
 * PURA. Reparte `salesRefundCents` (IVA-incluido) entre las TASAS reales de la venta, en
 * proporción a lo que cada tasa pesaba en la orden.
 *
 * Por qué proporcional y no "primero lo gravado": una devolución parcial no se refiere a
 * renglones concretos ("devuélveme $50"), así que el único reparto defendible es el que
 * conserva la mezcla fiscal de la venta. Con `repartirProporcional` la suma de las partes es
 * EXACTAMENTE el importe devuelto (los centavos sueltos van a los mayores remanentes), así que la
 * nota de crédito cuadra al centavo con el dinero que salió de la caja.
 *
 * Sin desglose (venta de importe libre, sin renglones) → una sola partida a `fallbackRate`.
 */
export function buildCreditNoteLines(
  salesRefundCents: number,
  grossByRate: { rate: number; grossCents: number }[],
  fallbackRate: number,
): CreditNoteLine[] {
  const meaningful = grossByRate.filter(r => r.grossCents > 0)
  if (meaningful.length === 0) return [{ grossCents: salesRefundCents, rate: fallbackRate }]
  const alloc = repartirProporcional(
    salesRefundCents,
    meaningful.map(r => r.grossCents),
  )
  return meaningful.map((r, i) => ({ grossCents: alloc[i], rate: r.rate })).filter(l => l.grossCents > 0)
}

// ─── Servicio ─────────────────────────────────────────────────────────────────

/** La entrada de una nota v1 (las ya timbradas antes de C2): un concepto `01010101` al 16 % o no objeto. Se sigue leyendo, no se reescribe. */
interface EntradaEgresoV1 {
  version: 1
  tipo: 'EGRESO'
  orderId: string
  refundPaymentId: string
  originalCfdiId: string
  originalUuid: string
  fiscalEmisorId: string
  originalSinIvaHistorico?: true
  montos: { subtotalCents: number; taxCents: number; totalCents: number }
  params: Omit<CreditNoteParams, 'externalId' | 'idempotencyKey' | 'protocoloIva'>
}

/** C2: el lector de la entrada de una nota, por versión. Lanza `ConflictError` (revisión de soporte) si no es coherente con su fila. */
export function leerEgreso(cfdi: any): EntradaEgresoV1 | EntradaEgresoV2 {
  return (cfdi?.entrada as { version?: unknown } | null)?.version === 2
    ? leerEgresoV2(cfdi, cfdi.entrada as EntradaEgresoV2)
    : leerEgresoV1(cfdi)
}

/**
 * C2 (Codex C2-19, D5): el lector de la nota v2. Reconstruye los conceptos desde lo congelado (`conceptosDeNota` + `aplicarAjustes`, con
 * barrera N3 y confinamiento por tasa, sin filas D16 como al capturarla) y exige que sean EXACTAMENTE los del payload; lo fiscal de la nota
 * con la misma asignación; los montos del documento = lo devuelto (regla del founder); `porRenglon` y redondeo válidos; 84111506/ACT, PUE y
 * G02; relación 01 con la original; receptor y forma de pago de la fila; y la huella.
 */
function leerEgresoV2(cfdi: any, e: EntradaEgresoV2): EntradaEgresoV2 {
  let ok = false
  try {
    const p = e.params as CreditNoteParams
    const aGlobal = e.originalEsGlobal === true
    const opts = { cobradoPorTasa: e.brutoPorTratamiento, filasD16: SIN_FILAS_D16 }
    const reconstruidos = aplicarAjustes(
      conceptosDeNota(e.brutoPorTratamiento ?? {}, e.etiquetaOriginal, e.originalEsGlobal ? { sku: e.folio } : {}),
      e.ajustes ?? [],
      e.devueltoCents,
      opts,
    )
    const docOInvalido = reconstruidos?.length ? documentoDeConceptos(reconstruidos) : null
    const doc = docOInvalido && !('invalido' in docOInvalido) ? montosDesdeDocumento(docOInvalido) : null
    const propia = reconstruidos?.length
      ? asignacionFiscal(
          unidadesDeConceptos(reconstruidos, () => 'nota'),
          documentoDeConceptos(reconstruidos),
          resumenDeConceptos(reconstruidos),
        )
      : null
    ok =
      cfdi.protocoloIva === 1 &&
      e.version === 2 &&
      e.tipo === 'EGRESO' &&
      e.causa === 'DEVOLUCION' &&
      e.orderId === cfdi.orderId &&
      e.fiscalEmisorId === cfdi.fiscalEmisorId &&
      typeof e.refundPaymentId === 'string' &&
      creditNoteIdempotencyKey(e.refundPaymentId) === cfdi.idempotencyKey &&
      typeof e.originalCfdiId === 'string' &&
      !!e.originalCfdiId &&
      typeof e.originalUuid === 'string' &&
      !!e.originalUuid &&
      typeof e.etiquetaOriginal === 'string' &&
      !!e.etiquetaOriginal &&
      (e.originalEsGlobal === undefined || (e.originalEsGlobal === true && typeof e.folio === 'string' && !!e.folio)) &&
      ['POR_ARTICULOS', 'POR_IMPORTE', 'POR_IMPORTE_ELEGIDO', 'DELIVERY'].includes(e.modalidad) &&
      (e.elegidoPor === undefined || e.elegidoPor === null || typeof e.elegidoPor === 'string') &&
      (e.modalidad === 'POR_IMPORTE_ELEGIDO' || e.elegidoPor === undefined) &&
      Number.isSafeInteger(e.devueltoCents) &&
      e.devueltoCents > 0 &&
      !!reconstruidos &&
      huellaDeEntrada(p.items) === huellaDeEntrada(reconstruidos) &&
      !!propia &&
      !('invalido' in propia) &&
      huellaDeEntrada(propia.porTratamiento) === huellaDeEntrada(e.porTratamiento) &&
      !!doc &&
      huellaDeEntrada(doc) === huellaDeEntrada(e.montos) &&
      e.montos.totalCents === e.devueltoCents && // regla del founder
      porRenglonValido(e) && // C2-19
      redondeoValido(e) &&
      e.montos.subtotalCents === cfdi.subtotalCents &&
      e.montos.taxCents === cfdi.taxCents &&
      e.montos.totalCents === cfdi.totalCents &&
      p.externalId === undefined &&
      p.idempotencyKey === undefined &&
      p.protocoloIva === undefined &&
      p.relationship === '01' &&
      Array.isArray(p.relatedUuids) &&
      p.relatedUuids.length === 1 &&
      p.relatedUuids[0] === e.originalUuid &&
      p.metodoPago === 'PUE' &&
      cfdi.metodoPago === 'PUE' &&
      p.receptor?.usoCfdi === 'G02' &&
      cfdi.usoCfdi === 'G02' &&
      p.receptor.rfc === cfdi.receptorRfc &&
      p.receptor.razonSocial === cfdi.receptorNombre &&
      p.receptor.regimenFiscal === cfdi.receptorRegimen &&
      p.receptor.codigoPostal === cfdi.receptorCp &&
      p.formaPago === cfdi.formaPago &&
      // C2 · Tarea 8: la nota a una global va a Público en General, sin correo, con el folio del ticket en CADA concepto y sin el bloque
      // `InformacionGlobal` (G02_SIN_BLOQUE, T1); el RFC genérico sólo pasa la validación con esta marca.
      (!aGlobal ||
        (p.receptor.rfc === PUBLICO_EN_GENERAL.rfc &&
          p.receptor.razonSocial === PUBLICO_EN_GENERAL.razonSocial &&
          p.receptor.regimenFiscal === PUBLICO_EN_GENERAL.regimenFiscal &&
          p.receptor.email === undefined &&
          p.items.every(i => i.sku === e.folio) &&
          (NOTA_A_GLOBAL_LLEVA_BLOQUE
            ? (p as { global?: unknown }).global !== undefined
            : (p as { global?: unknown }).global === undefined))) &&
      validateBeforeStamp({
        csdStatus: 'ACTIVE',
        formaPago: p.formaPago,
        receptor: p.receptor,
        items: p.items,
        expectedSubtotalCents: e.montos.subtotalCents,
        expectedTaxCents: e.montos.taxCents,
        expectedTotalCents: e.montos.totalCents,
        isGlobal: false,
        relacionadaConGlobal: aGlobal,
      }).valid &&
      huellaDeEntrada(e) === cfdi.entradaHuella
  } catch {
    ok = false
  }
  if (!ok) throw new ConflictError(ENTRADA_INVALIDA)
  return e
}

/** El lector de las notas v1 (de antes de C2), intacto salvo la clave, que ahora es `CLAVE_NOTA_V1`. */
function leerEgresoV1(cfdi: any): EntradaEgresoV1 {
  const e = cfdi.entrada as EntradaEgresoV1 | null
  const invalid = () => {
    throw new ConflictError(ENTRADA_INVALIDA)
  }
  if (
    cfdi.protocoloIva !== 1 ||
    !e ||
    e.version !== 1 ||
    e.tipo !== 'EGRESO' ||
    e.orderId !== cfdi.orderId ||
    e.fiscalEmisorId !== cfdi.fiscalEmisorId ||
    typeof e.refundPaymentId !== 'string' ||
    creditNoteIdempotencyKey(e.refundPaymentId) !== cfdi.idempotencyKey ||
    typeof e.originalCfdiId !== 'string' ||
    !e.originalCfdiId ||
    typeof e.originalUuid !== 'string' ||
    !e.originalUuid ||
    (e.originalSinIvaHistorico !== undefined && e.originalSinIvaHistorico !== true) ||
    !e.montos ||
    ![e.montos.subtotalCents, e.montos.taxCents, e.montos.totalCents].every(cents) ||
    e.montos.totalCents <= 0 ||
    e.montos.subtotalCents !== cfdi.subtotalCents ||
    e.montos.taxCents !== cfdi.taxCents ||
    e.montos.totalCents !== cfdi.totalCents ||
    e.montos.subtotalCents + e.montos.taxCents !== e.montos.totalCents ||
    huellaDeEntrada(e) !== cfdi.entradaHuella
  )
    return invalid()
  const p = e.params as CreditNoteParams
  const item = p?.items?.[0]
  if (
    !p ||
    p.externalId !== undefined ||
    p.idempotencyKey !== undefined ||
    p.protocoloIva !== undefined ||
    p.relationship !== '01' ||
    !Array.isArray(p.relatedUuids) ||
    p.relatedUuids.length !== 1 ||
    p.relatedUuids[0] !== e.originalUuid ||
    p.receptor?.usoCfdi !== 'G02' ||
    p.receptor.rfc !== cfdi.receptorRfc ||
    p.receptor.razonSocial !== cfdi.receptorNombre ||
    p.receptor.regimenFiscal !== cfdi.receptorRegimen ||
    p.receptor.codigoPostal !== cfdi.receptorCp ||
    p.formaPago !== cfdi.formaPago ||
    p.metodoPago !== cfdi.metodoPago ||
    !['PUE', 'PPD'].includes(p.metodoPago) ||
    !Array.isArray(p.items) ||
    p.items.length !== 1 ||
    !item ||
    item.quantity !== 1 ||
    item.unitPriceCents !== e.montos.totalCents ||
    item.discountCents !== 0 ||
    item.taxIncluded !== true ||
    item.satProductKey !== CLAVE_NOTA_V1 ||
    item.satUnitKey !== 'ACT' ||
    typeof item.description !== 'string' ||
    !item.description.startsWith('Devolución sobre factura ') ||
    !Array.isArray(item.taxes)
  )
    return invalid()
  if (e.originalSinIvaHistorico) {
    if (item.objetoImp !== '01' || item.taxes.length || e.montos.taxCents !== 0 || e.montos.subtotalCents !== e.montos.totalCents)
      return invalid()
  } else if (
    item.objetoImp !== '02' ||
    item.taxes.length !== 1 ||
    item.taxes[0]?.type !== 'IVA' ||
    item.taxes[0].rate !== 0.16 ||
    item.taxes[0].factor !== 'Tasa' ||
    item.taxes[0].withholding !== false
  )
    return invalid()
  const expected = splitIvaIncluded(e.montos.totalCents, e.originalSinIvaHistorico ? 0 : 0.16)
  if (expected.netCents !== e.montos.subtotalCents || expected.taxCents !== e.montos.taxCents) return invalid()
  if (
    !validateBeforeStamp({
      csdStatus: 'ACTIVE',
      formaPago: p.formaPago,
      receptor: p.receptor,
      items: p.items,
      expectedSubtotalCents: e.montos.subtotalCents,
      expectedTaxCents: e.montos.taxCents,
      expectedTotalCents: e.montos.totalCents,
      isGlobal: false,
    }).valid
  )
    return invalid()
  return e
}

function recuperable(cfdi: any): boolean {
  return (
    cfdi?.protocoloIva === 1 &&
    cfdi.enviadoAt != null &&
    cfdi.falloDefinitivo === false &&
    ['STAMPING', 'STAMP_FAILED'].includes(cfdi.status) &&
    !['ACCEPTED', 'CANCELLED'].includes(cfdi.cancelStatus)
  )
}

function verificarTenant(cfdi: any, venueId: string): void {
  if (cfdi && (cfdi.venueId !== venueId || cfdi.type !== 'EGRESO')) throw new Error('Reembolso no encontrado')
}

/**
 * C2 T7: la captura de TODA nota nueva es v2 (`notaPorTratamiento`): un concepto por tratamiento, 84111506/ACT, PUE, G02, la forma de pago
 * de G8 y la entrada v2 con su identidad (`originalCfdiId` incluido: la guarda C2-6 de la cancelación la busca por esa llave). Un bloqueo
 * (inalcanzable: la reserva acaba de revisar la elegibilidad con la misma fila) queda `VALIDATION_FAILED` con su motivo, como una
 * validación fallida.
 */
/** Exportada para las pruebas del lector v2 (M3 de la ronda 1). */
export function capturarEgreso(loaded: LoadedRefundForCreditNote, idempotencyKey: string, elegidoPor?: string | null) {
  const { refund } = loaded
  const original = loaded.original!
  const etiquetaOriginal = `${original.serie ?? ''}${original.folio ?? ''}` || original.uuid
  const nota = notaPorTratamiento(loaded)
  const forma = formaPagoDeLaNota(loaded)
  const bloqueo = 'eligible' in nota ? nota : typeof forma !== 'string' ? forma : null
  const formaPago = typeof forma === 'string' ? forma : original.formaPago
  const items = 'eligible' in nota ? [] : nota.items
  const documento = items.length ? documentoDeConceptos(items) : null
  const montos =
    documento && !('invalido' in documento) ? montosDesdeDocumento(documento) : { subtotalCents: 0, taxCents: 0, totalCents: 0 }
  // C2 · Tarea 8: la nota de un ticket en la global va a Público en General (el receptor de la global: 616 y su CP), sin correo (no tiene).
  const aGlobal = original.esGlobal === true
  // Ronda 1 (M5): con el RFC genérico, el SAT pide `DomicilioFiscalReceptor` = `LugarExpedicion` de ESTE comprobante, que es el lugar de
  // expedición VIGENTE del emisor (el PAC lo pone hoy), no el de la global si el emisor cambió de CP después.
  const receptor = aGlobal
    ? {
        ...PUBLICO_EN_GENERAL,
        codigoPostal: original.fiscalEmisor.lugarExpedicion || original.receptorCp,
        usoCfdi: CREDIT_NOTE_USO_CFDI,
      }
    : {
        rfc: original.receptorRfc,
        razonSocial: original.receptorNombre,
        regimenFiscal: original.receptorRegimen,
        codigoPostal: original.receptorCp,
        usoCfdi: CREDIT_NOTE_USO_CFDI,
        ...(original.receptorEmail ? { email: original.receptorEmail } : {}),
      }
  const params: EntradaEgresoV2['params'] = {
    receptor,
    items,
    formaPago,
    metodoPago: 'PUE', // C2-P3: toda nota nueva es PUE (la original PPD también)
    ...(original.fiscalEmisor.serie ? { serie: original.fiscalEmisor.serie } : {}),
    relationship: CREDIT_NOTE_RELATIONSHIP,
    relatedUuids: [original.uuid],
  }
  const parcial =
    'eligible' in nota
      ? {
          modalidad: 'POR_IMPORTE' as const,
          devueltoCents: refund.salesRefundCents,
          brutoPorTratamiento: {},
          porTratamiento: {},
          redondeo: [],
          ajustes: [],
        }
      : nota.entradaParcial
  const entrada: EntradaEgresoV2 = structuredClone({
    version: 2,
    tipo: 'EGRESO',
    causa: 'DEVOLUCION',
    orderId: refund.orderId,
    refundPaymentId: refund.id,
    originalCfdiId: original.id,
    originalUuid: original.uuid,
    etiquetaOriginal,
    fiscalEmisorId: original.fiscalEmisor.id,
    ...parcial,
    // Tarea 9: `elegidoPor` (quien confirmó «acreditar por importe»), SÓLO en la modalidad elegida (el lector v2 lo exige así); sin quién
    // (una llamada interna), `null`.
    ...(parcial.modalidad === 'POR_IMPORTE_ELEGIDO' ? { elegidoPor: elegidoPor ?? null } : {}),
    montos,
    params,
  })
  const validation = bloqueo
    ? { valid: false, reasons: [bloqueo.message!] }
    : validateBeforeStamp({
        csdStatus: original.fiscalEmisor.csdStatus,
        formaPago,
        receptor,
        items,
        expectedSubtotalCents: montos.subtotalCents,
        expectedTaxCents: montos.taxCents,
        expectedTotalCents: montos.totalCents,
        isGlobal: false,
        relacionadaConGlobal: aGlobal, // C2 · Tarea 8: el RFC genérico sólo en la nota relacionada con una global
      })
  const base = {
    venueId: loaded.venueId,
    fiscalEmisorId: original.fiscalEmisor.id,
    orderId: refund.orderId,
    type: 'EGRESO',
    flow: 'STAFF_B', // emisión manual por staff desde el dashboard (mismo flujo que el ingreso B)
    status: validation.valid ? 'STAMPING' : 'VALIDATION_FAILED',
    idempotencyKey,
    receptorRfc: receptor.rfc,
    receptorNombre: receptor.razonSocial,
    receptorRegimen: receptor.regimenFiscal,
    receptorCp: receptor.codigoPostal,
    usoCfdi: CREDIT_NOTE_USO_CFDI,
    formaPago,
    metodoPago: 'PUE',
    subtotalCents: montos.subtotalCents,
    taxCents: montos.taxCents,
    totalCents: montos.totalCents,
    lastError: validation.reasons.join(' | ') || null,
  }
  return { entrada, base, reasons: validation.reasons }
}

/**
 * C2 (Tarea 9): el cargador de la emisión. Con «por importe» elegido, toda lectura (fuera y bajo los candados) lleva la elección: la
 * elegibilidad y la captura la toman de ahí (`repartoDeLaDevolucion` sólo la acepta si por artículos falta evidencia).
 */
function cargadorConLaEleccion(deps: EmitRefundCreditNoteDeps, params: EmitRefundCreditNoteParams) {
  return async (tx?: Prisma.TransactionClient, excludeCfdiId?: string) => {
    const loaded = await deps.loadRefundForCreditNote(params.venueId, params.refundPaymentId, tx, excludeCfdiId)
    return loaded && params.modalidad === 'POR_IMPORTE' ? { ...loaded, modalidadElegida: 'POR_IMPORTE' as const } : loaded
  }
}
/**
 * C2 (Tarea 9): con «por importe», el reparto capturado tiene que tener la huella que la persona confirmó; si no, no se reserva nada.
 * T10 ronda 1 (M9): la emisión NORMAL también, si trae la huella de su vista previa (`preview.huella`); sin ella (clientes viejos), como antes.
 */
function verificarHuellaDelReparto(params: EmitRefundCreditNoteParams, entrada: EntradaEgresoV2): void {
  if (params.modalidad === 'POR_IMPORTE') {
    if (huellaDelReparto(entrada) !== params.huellaDelReparto) throw new ConflictError(MOTIVO_REPARTO_CAMBIO)
    return
  }
  if (params.huellaDelReparto !== undefined && huellaDelReparto(entrada) !== params.huellaDelReparto)
    throw new ConflictError(MOTIVO_NOTA_CAMBIO)
}

export async function emitRefundCreditNote(
  params: EmitRefundCreditNoteParams,
  overrides: Partial<EmitRefundCreditNoteDeps> = {},
): Promise<EmitRefundCreditNoteResult> {
  const deps = { ...defaultDeps, ...overrides }
  // C2 (Tarea 9, P10): «por importe» sólo con la huella del reparto que la persona vio; sin ella no se carga nada.
  if (params.modalidad === 'POR_IMPORTE' && !params.huellaDelReparto) throw new BadRequestError(MOTIVO_FALTA_LA_HUELLA)
  const cargar = cargadorConLaEleccion(deps, params)
  const key = creditNoteIdempotencyKey(params.refundPaymentId)
  const existing = await deps.findExistingCfdi(key)
  verificarTenant(existing, params.venueId)
  if (existing?.status === 'STAMPED') return { status: 'STAMPED', cfdi: existing }
  if (params.lookupOnly && !recuperable(existing)) throw new ConflictError(PROCESANDO)
  if (existing) {
    if (
      !['STAMPING', 'STAMP_FAILED', 'VALIDATION_FAILED'].includes(existing.status) ||
      ['ACCEPTED', 'CANCELLED'].includes(existing.cancelStatus)
    )
      throw new ConflictError(PROCESANDO)
    const emisor = await deps.loadEmisor(existing.fiscalEmisorId, params.venueId)
    if (!emisor) throw new Error('Reembolso no encontrado')
    const provider = deps.resolveProvider(emisor, { sandbox: params.sandbox })
    if (existing.protocoloIva === null) return emitirLegacy(existing, params, provider, deps)
    if (existing.protocoloIva !== 1) throw new ConflictError(ENTRADA_INVALIDA)
    const recovered = await consultarIntentoCapturado(existing, provider, deps.runInTransaction)
    if (recovered) return finalizarNota(existing, recovered, provider, params, deps)
    if (params.lookupOnly) throw new ConflictError(PROCESANDO)
  }
  let loaded = await cargar(undefined, existing?.id)
  if (!loaded) throw new Error('Reembolso no encontrado')
  let initial = checkCreditNoteEligibility(loaded)
  // C2-13 (D5) y N1: sin el XML de la original, se piden sus archivos AL MOMENTO (fuera de candados y transacciones: hace red) y se
  // vuelve a leer la fila (un `FALLO` pudo dejar escrita la evidencia del XML); si sigue sin XML, la nota espera sin reservar. Un XML que
  // se bajó y no se lee (o una original sin identidad del PAC) es permanente: la nota se detiene con su motivo, nunca espera para siempre.
  // Ronda 1 (I2): la reparación es la COMPARTIDA (una en vuelo por factura); el POST la espera 20 s e insiste (pasa del enfriamiento).
  if (initial.reason === 'ESPERA_XML') {
    const r = await deps.repararArchivos(loaded.original!.id, {
      sandbox: params.sandbox,
      limiteMs: LIMITE_ESPERA_XML_EN_LA_NOTA_MS,
      insistir: true,
    })
    const v = veredictoDeLaReparacion(r)
    if (v !== 'RELEER') return { status: 'VALIDATION_FAILED', cfdi: existing ?? null, reasons: [v.message!] }
    loaded = await cargar(undefined, existing?.id)
    if (!loaded) throw new Error('Reembolso no encontrado')
    initial = checkCreditNoteEligibility(loaded)
    if (initial.reason === 'ESPERA_XML')
      return { status: 'VALIDATION_FAILED', cfdi: existing ?? null, reasons: [sigueSinXml(loaded).message!] }
  }
  contarCentavosDeRedondeo(initial, params.venueId, params.refundPaymentId)
  if (!initial.eligible) throw new ConflictError(initial.message!)
  const provider = deps.resolveProvider(loaded.original!.fiscalEmisor as any, { sandbox: params.sandbox })
  if (!provider.createCreditNote)
    throw new ConflictError(`El proveedor fiscal (${provider.name}) no soporta notas de crédito (CFDI de egreso).`)
  asegurarGlobalVigente(loaded) // ronda 2 (N2): la evaluación en frío, si toca, fuera de los candados
  const reserved = await deps.runInTransaction(async tx => {
    const scope = await bloquearOrdenParaFacturar(tx, loaded.refund.orderId)
    if (!scope || scope.venueId !== params.venueId) throw new Error('Reembolso no encontrado')
    await tomarAdmisionCompartida(tx, scope.organizationId)
    // C2 · Tarea 8 (Codex C2-3): la nota a una global toma la fila de la global `FOR UPDATE` DESPUÉS de los candados de la orden y de la
    // admisión (el orden de la cancelación de la global: órdenes → admisión → su fila), y relee ahí lo que queda del ticket y del documento:
    // dos notas de tickets distintos de la misma global se serializan y la segunda ve la reserva de la primera.
    const globalId = loaded.original?.esGlobal ? loaded.original.id : null
    if (globalId) await tx.$queryRaw`SELECT id FROM "Cfdi" WHERE id = ${globalId} FOR UPDATE`
    const current = await tx.cfdi.findUnique({ where: { idempotencyKey: key } })
    verificarTenant(current, params.venueId)
    if (current?.status === 'STAMPED') return { cfdi: current, alreadyStamped: true as const }
    if (
      current &&
      (!existing ||
        current.attempts !== existing.attempts ||
        current.status !== existing.status ||
        current.enviadoAt?.getTime() !== existing.enviadoAt?.getTime())
    )
      throw new ConflictError(PROCESANDO)
    if (
      current &&
      (current.protocoloIva !== 1 ||
        !['STAMPING', 'STAMP_FAILED', 'VALIDATION_FAILED'].includes(current.status) ||
        ['ACCEPTED', 'CANCELLED'].includes(current.cancelStatus ?? '') ||
        (current.enviadoAt !== null && !current.falloDefinitivo))
    )
      throw new ConflictError(PROCESANDO)
    const live = await cargar(tx, current?.id)
    if (!live || live.refund.orderId !== loaded.refund.orderId) throw new Error('Reembolso no encontrado')
    if (live.original?.esGlobal) {
      // La original es OTRA global que la del candado (cambió entre la lectura y el candado): no se calcula sin su candado; otra vuelta.
      if (live.original.id !== globalId) throw new ConflictError(PROCESANDO)
      await deps.despuesDelCandadoDeLaGlobal?.({
        notasDelTicket: live.acreditado.notas,
        notasDelDocumento: live.acreditadoDelDocumento?.notas ?? [],
      })
    }
    const eligible = checkCreditNoteEligibility(live)
    if (!eligible.eligible) throw new ConflictError(eligible.message!)
    const captured = capturarEgreso(live, key, params.requestedByStaffId ?? null)
    // C2 (Tarea 9): bajo los candados y con lo acreditado releído, el reparto que se va a capturar tiene que ser el que la persona vio.
    verificarHuellaDelReparto(params, captured.entrada)
    const data = {
      ...captured.base,
      protocoloIva: 1,
      entrada: captured.entrada as unknown as Prisma.InputJsonValue,
      entradaHuella: huellaDeEntrada(captured.entrada),
      enviadoAt: null,
      falloDefinitivo: false,
      facturapiId: null,
      attempts: (current?.attempts ?? 0) + (captured.reasons.length ? 0 : 1),
    }
    let cfdi
    if (current) {
      const changed = await tx.cfdi.updateMany({
        where: {
          id: current.id,
          status: current.status,
          attempts: current.attempts,
          enviadoAt: current.enviadoAt,
          falloDefinitivo: current.falloDefinitivo,
        },
        data: data as any,
      })
      if (changed.count !== 1) throw new ConflictError(PROCESANDO)
      cfdi = await tx.cfdi.findUniqueOrThrow({ where: { id: current.id } })
    } else cfdi = await deps.reserveCfdi(data, tx)
    return { alreadyStamped: false as const, cfdi, ...captured, emisor: live.original!.fiscalEmisor, slug: live.venueSlug }
  })
  if (reserved.alreadyStamped) return { status: 'STAMPED', cfdi: reserved.cfdi }
  if (reserved.reasons.length) return { status: 'VALIDATION_FAILED', cfdi: reserved.cfdi, reasons: reserved.reasons }
  const entrada = leerEgreso(reserved.cfdi)
  const sendingProvider = deps.resolveProvider(reserved.emisor as any, { sandbox: params.sandbox })
  const result = await enviarIntentoCapturado(
    reserved.cfdi,
    { tipo: 'EGRESO', params: entrada.params },
    null,
    sendingProvider,
    reserved.slug,
    deps,
  )
  verificarTenant(result.cfdi, params.venueId)
  if (result.status === 'STAMPED') auditarNota(result.cfdi, params, deps, entrada)
  return result
}

async function finalizarNota(
  cfdi: any,
  found: any,
  provider: any,
  params: EmitRefundCreditNoteParams,
  deps: EmitRefundCreditNoteDeps,
  auditLink?: Pick<EntradaEgresoV1 | EntradaEgresoV2, 'originalUuid' | 'originalCfdiId'>,
) {
  const result = await finalizarEmision(cfdi, found, provider, await deps.loadVenueSlug(params.venueId), deps)
  verificarTenant(result.cfdi, params.venueId)
  auditarNota(result.cfdi, params, deps, cfdi.protocoloIva === 1 ? cfdi.entrada : auditLink)
  return result
}
function auditarNota(
  cfdi: any,
  params: EmitRefundCreditNoteParams,
  deps: EmitRefundCreditNoteDeps,
  entrada?: Pick<EntradaEgresoV1, 'originalUuid' | 'originalCfdiId'> | Partial<EntradaEgresoV2>,
) {
  // C2 T7: una nota v2 deja en la bitácora su reparto por tratamiento, el redondeo declarado, la modalidad, quién la eligió y si la
  // original es una global (Codex C2-15). Una v1 (o la heredada) deja lo de siempre.
  const v2 = (entrada as Partial<EntradaEgresoV2> | undefined)?.version === 2 ? (entrada as EntradaEgresoV2) : null
  deps.logAction({
    staffId: params.requestedByStaffId ?? null,
    venueId: params.venueId,
    action: 'CFDI_CREDIT_NOTE_ISSUED',
    entity: 'Cfdi',
    entityId: cfdi.id,
    data: {
      refundPaymentId: params.refundPaymentId,
      orderId: cfdi.orderId,
      relatedUuid: entrada?.originalUuid,
      relatedCfdiId: entrada?.originalCfdiId,
      uuid: cfdi.uuid,
      serie: cfdi.serie,
      folio: cfdi.folio,
      amount: cfdi.totalCents / 100,
      tipoRelacion: '01',
      usoCfdi: CREDIT_NOTE_USO_CFDI,
      ...(v2
        ? {
            porTratamiento: v2.porTratamiento,
            redondeo: v2.redondeo,
            modalidad: v2.modalidad,
            elegidoPor: v2.elegidoPor ?? null,
            originalEsGlobal: v2.originalEsGlobal === true,
          }
        : {}),
    },
  })
}

/** Persisted-NULL conserva su llave y política de reintento; desenlaces nunca pisan otra versión/cancelación. */
async function emitirLegacy(
  cfdi: any,
  params: EmitRefundCreditNoteParams,
  provider: any,
  deps: EmitRefundCreditNoteDeps,
): Promise<EmitRefundCreditNoteResult> {
  let found
  try {
    found = cfdi.facturapiId ? await provider.getInvoice(cfdi.facturapiId) : await provider.findByExternalId(cfdi.idempotencyKey)
  } catch {
    throw new ConflictError(PROCESANDO)
  }
  if (found?.status === 'canceled')
    throw new ConflictError('Esta cuenta ya tiene una factura cancelada en el PAC; revísala antes de volver a facturar.')
  if (found?.status === 'valid' && found.uuid) return finalizarNota(cfdi, found, provider, params, deps)
  if (found || (cfdi.status === 'STAMPING' && Date.now() - new Date(cfdi.updatedAt ?? cfdi.createdAt).getTime() < STAMPING_TTL_MS))
    throw new ConflictError(PROCESANDO)
  if (!provider.createCreditNote)
    throw new ConflictError(`El proveedor fiscal (${provider.name}) no soporta notas de crédito (CFDI de egreso).`)
  const reserved = await deps.runInTransaction(async tx => {
    const scope = await bloquearOrdenParaFacturar(tx, cfdi.orderId)
    if (!scope || scope.venueId !== params.venueId) throw new Error('Reembolso no encontrado')
    await tomarAdmisionCompartida(tx, scope.organizationId)
    const loaded = await cargadorConLaEleccion(deps, params)(tx, cfdi.id)
    if (!loaded || loaded.refund.orderId !== cfdi.orderId) throw new Error('Reembolso no encontrado')
    const eligible = checkCreditNoteEligibility(loaded)
    if (!eligible.eligible) throw new ConflictError(eligible.message!)
    const captured = capturarEgreso(loaded, cfdi.idempotencyKey, params.requestedByStaffId ?? null)
    verificarHuellaDelReparto(params, captured.entrada)
    const updated = await tx.cfdi.updateMany({
      where: { id: cfdi.id, attempts: cfdi.attempts, status: cfdi.status, protocoloIva: null },
      data: { ...captured.base, attempts: { increment: 1 } } as any,
    })
    if (updated.count !== 1) throw new ConflictError(PROCESANDO)
    return { cfdi: await tx.cfdi.findUniqueOrThrow({ where: { id: cfdi.id } }), ...captured }
  })
  cfdi = reserved.cfdi
  if (reserved.reasons.length) return { status: 'VALIDATION_FAILED', cfdi, reasons: reserved.reasons }
  const where = { id: cfdi.id, status: 'STAMPING' as const, attempts: cfdi.attempts }
  let stamped
  try {
    stamped = await provider.createCreditNote({
      ...reserved.entrada.params,
      externalId: cfdi.idempotencyKey,
      idempotencyKey: cfdi.idempotencyKey,
    })
  } catch (err) {
    const updated = await deps.persistCfdi({ status: 'STAMP_FAILED', lastError: err instanceof Error ? err.message : String(err) }, where)
    if (!updated) throw new ConflictError(PROCESANDO)
    return { status: 'STAMP_FAILED', cfdi: updated }
  }
  if (stamped.status !== 'valid' || !stamped.uuid) {
    await deps.persistCfdi({ facturapiId: stamped.providerInvoiceId }, where)
    throw new ConflictError(PROCESANDO)
  }
  return finalizarNota(cfdi, stamped, provider, params, deps, reserved.entrada)
}

// ─── Lectura: ¿este reembolso ya tiene nota de crédito? ───────────────────────

/** Devuelve la nota de crédito de un reembolso (cualquier estado), o `null`. */
export async function getRefundCreditNote(venueId: string, refundPaymentId: string): Promise<any | null> {
  const cfdi = await prisma.cfdi.findUnique({
    where: { idempotencyKey: creditNoteIdempotencyKey(refundPaymentId) },
    select: {
      id: true,
      type: true,
      status: true,
      uuid: true,
      serie: true,
      folio: true,
      totalCents: true,
      subtotalCents: true,
      taxCents: true,
      receptorRfc: true,
      receptorNombre: true,
      stampedAt: true,
      xmlUrl: true,
      pdfUrl: true,
      lastError: true,
      venueId: true,
      protocoloIva: true,
      enviadoAt: true,
      falloDefinitivo: true,
      cancelStatus: true,
    },
  })
  // Aislamiento por tenant: el idempotencyKey es global, la respuesta NO puede serlo.
  if (!cfdi || cfdi.venueId !== venueId || cfdi.type !== 'EGRESO') return null
  const { protocoloIva, enviadoAt, falloDefinitivo, cancelStatus, ...publicNote } = cfdi
  return { ...publicNote, recoveryOnly: recuperable(cfdi) }
}

export interface RefundCreditNoteStatus {
  recoveryOnly: boolean
  /** La nota de crédito ya emitida (cualquier estado), o `null`. */
  creditNote: any | null
  /** ¿Se puede emitir? Cuando no, `message` dice por qué — en español y para pintarse tal cual. */
  eligibility: CreditNoteEligibility
  /** Vista previa de lo que se timbraría (null si el reembolso no existe o no procede). */
  preview: {
    /** `esGlobal` (C2 · Tarea 8, nuevo y opcional): la original es la factura global en la que entró el ticket. */
    facturaOriginal: {
      folio: string
      /** C2 · ronda QA (D7, nuevo y opcional): el folio con el formato de la lista de Facturas («A-7»). */
      etiqueta?: string
      uuid: string
      totalCents: number
      esGlobal?: boolean
    } | null
    receptor: { rfc: string; nombre: string } | null
    amountToCreditCents: number
    tipRefundCents: number
    /** C2 T7 (nuevo, opcional): lo que se acreditaría por tratamiento (total, base e IVA), cuando es elegible. */
    desglose?: Array<{ tratamiento: TratamientoDeNota; cents: number; baseCents: number; ivaCents: number }>
    /** C2 T7 (nuevo, opcional; Codex C2-15): el redondeo que llevaría la nota, por componente y ámbito. */
    redondeo?: Redondeo[]
    /** C2 T7 (nuevo, opcional): el uso del CFDI de la nota (G02). */
    usoCfdi?: string
    /** C2 · T10 ronda 1 (M9, nuevo y opcional): la huella de lo que se timbraría; el POST normal la manda para atar lo que se vio. */
    huella?: string
    /** C2 T7 (nuevo, opcional; G6): la facturación del comercio está apagada (la nota NO se bloquea: corrige una factura ya emitida). */
    avisoFacturacionApagada?: string
    /**
     * C2 (Tarea 9, nuevo y opcional; P10): la devolución por artículos se detuvo por falta de evidencia y se puede «acreditar por importe»:
     * lo devuelto repartido por tasa en proporción a lo que queda, con su redondeo y la huella del reparto que se confirma. `aviso` (opcional)
     * dice cuándo se acreditaría dinero de un artículo que no aparece en la factura.
     */
    alternativa?: {
      modalidad: 'POR_IMPORTE'
      desglose: Array<{ tratamiento: TratamientoDeNota; cents: number; baseCents: number; ivaCents: number }>
      redondeo: Redondeo[]
      huella: string
      aviso?: string
    }
  } | null
}

/**
 * Todo lo que la UI necesita para decidir si pinta el botón, ya emitido, o el porqué del "no".
 *
 * Regla del workspace: **apagado se VE y se EXPLICA** — por eso esto nunca devuelve un
 * booleano pelón: siempre trae el texto que el usuario debe leer.
 */
export async function getRefundCreditNoteStatus(
  venueId: string,
  refundPaymentId: string,
  depsVista: Partial<Pick<EmitRefundCreditNoteDeps, 'loadRefundForCreditNote' | 'repararArchivos'>> = {},
): Promise<RefundCreditNoteStatus | null> {
  const cargar = depsVista.loadRefundForCreditNote ?? loadRefundForCreditNoteFromDb
  const reparar = depsVista.repararArchivos ?? defaultDeps.repararArchivos
  const stored = await getRefundCreditNote(venueId, refundPaymentId)
  const { recoveryOnly = false, ...publicNote } = stored ?? {}
  const creditNote = stored ? publicNote : null
  if (recoveryOnly)
    return { creditNote, recoveryOnly: true, eligibility: { eligible: false, reason: null, message: PROCESANDO }, preview: null }
  // T10 ronda 1 (M9): lo que queda se lee SIN la nota propia del reembolso, igual que el POST (`excludeCfdiId`), para que la huella de la
  // vista previa sea la de lo que el POST capturaría (una reserva propia sin enviar no la cambia).
  const propia: string | undefined = creditNote?.id ?? undefined
  let loaded = await cargar(venueId, refundPaymentId, undefined, propia)
  if (!loaded) return null
  // Ronda 1 (M4): con la nota ya timbrada no hay nada que decidir: ni reparación ni elegibilidad (el panel y el MCP muestran la nota).
  if (creditNote?.status === 'STAMPED')
    return {
      creditNote,
      recoveryOnly: false,
      eligibility: { eligible: false, reason: null, message: 'Este reembolso ya tiene su nota de crédito timbrada.' },
      preview: vistaPrevia(loaded, null, false),
    }
  let eligibility = checkCreditNoteEligibility(loaded)
  // C2-13 (D5) y N1: sin el XML de la original se piden sus archivos (fuera de toda transacción; hace red), con un límite corto para no
  // colgar la vista. Un XML ilegible (o sin identidad del PAC) se DICE: nunca «en unos minutos» para siempre.
  if (eligibility.reason === 'ESPERA_XML') {
    // Ronda 1 (I2): la reparación COMPARTIDA, esperada ≤ 2 s; si sigue en curso, «lo estamos recuperando» y la siguiente consulta lo lee.
    const v = veredictoDeLaReparacion(await reparar(loaded.original!.id, { limiteMs: LIMITE_ESPERA_XML_EN_LA_VISTA_MS }))
    if (v !== 'RELEER') eligibility = v
    else {
      const otra = await cargar(venueId, refundPaymentId, undefined, propia)
      if (!otra) return null
      loaded = otra
      eligibility = checkCreditNoteEligibility(loaded)
      if (eligibility.reason === 'ESPERA_XML') eligibility = sigueSinXml(loaded)
    }
  }
  contarCentavosDeRedondeo(eligibility, venueId, refundPaymentId)
  const nota = eligibility.eligible ? notaPorTratamiento(loaded) : null
  const parcial = nota && !('eligible' in nota) ? nota.entradaParcial : null
  // C2 (Tarea 9, P10): por artículos se detuvo por falta de EVIDENCIA ⇒ se ofrece «acreditar por importe» (con su reparto y su huella); si
  // tampoco se puede por importe, el texto lo dice en vez de prometerlo.
  const alternativa = faltaEvidencia(eligibility) ? alternativaPorImporte(loaded) : null
  if (faltaEvidencia(eligibility) && !alternativa) {
    const tampoco = checkCreditNoteEligibility({ ...loaded, modalidadElegida: 'POR_IMPORTE' })
    if (!tampoco.eligible && tampoco.message) eligibility = { ...eligibility, message: motivoTampocoPorImporte(tampoco.message) }
  }
  const apagada = loaded.original ? await facturacionApagada(loaded.original.fiscalEmisor.id, venueId, loaded.refund.processorData) : false
  return { creditNote, recoveryOnly: false, eligibility, preview: vistaPrevia(loaded, parcial, apagada, alternativa) }
}

/** La vista previa (lo que se timbraría): campos de siempre más, cuando es elegible, el desglose, el redondeo y el uso; y el aviso de G6. */
function vistaPrevia(
  loaded: LoadedRefundForCreditNote,
  parcial: NotaPorTratamiento['entradaParcial'] | null,
  apagada: boolean,
  alternativa: AlternativaPorImporte | null = null,
): NonNullable<RefundCreditNoteStatus['preview']> {
  const original = loaded.original
  return {
    facturaOriginal: original
      ? {
          folio: `${original.serie ?? ''}${original.folio ?? ''}` || original.uuid,
          // C2 · ronda QA (D7, aditivo): el folio como lo escribe la lista de Facturas («A-7»); `folio` se queda igual.
          etiqueta: [original.serie, original.folio].filter(Boolean).join('-') || original.uuid,
          uuid: original.uuid,
          totalCents: original.totalCents,
          ...(original.esGlobal ? { esGlobal: true } : {}),
        }
      : null,
    receptor: original ? { rfc: original.receptorRfc, nombre: original.receptorNombre } : null,
    amountToCreditCents: loaded.refund.salesRefundCents,
    tipRefundCents: loaded.refund.tipRefundCents,
    ...(parcial
      ? {
          desglose: desgloseDe(parcial),
          redondeo: parcial.redondeo,
          usoCfdi: CREDIT_NOTE_USO_CFDI,
          // T10 ronda 1 (M9): la huella de lo que se timbraría (la misma fórmula que «por importe»). El POST la manda y, bajo los candados,
          // si ya no es eso, 409 sin timbrar. Nueva y opcional.
          huella: huellaDelReparto({ refundPaymentId: loaded.refund.id, originalUuid: loaded.original!.uuid, ...parcial }),
        }
      : {}),
    ...(apagada ? { avisoFacturacionApagada: AVISO_FACTURACION_APAGADA } : {}),
    ...(alternativa
      ? {
          alternativa: {
            modalidad: 'POR_IMPORTE' as const,
            desglose: desgloseDe(alternativa.entradaParcial),
            redondeo: alternativa.entradaParcial.redondeo,
            huella: alternativa.huella,
            ...(alternativa.aviso ? { aviso: alternativa.aviso } : {}),
          },
        }
      : {}),
  }
}
/** Lo que se acreditaría por tratamiento (total, base e IVA), de la asignación de la nota. */
function desgloseDe(parcial: NotaPorTratamiento['entradaParcial']) {
  return (
    Object.entries(parcial.porTratamiento) as Array<[TratamientoDeNota, { baseCents: number; ivaCents: number; totalCents: number }]>
  ).map(([tratamiento, c]) => ({ tratamiento, cents: c.totalCents, baseCents: c.baseCents, ivaCents: c.ivaCents }))
}

/**
 * C2 T7 (G6): ¿la facturación está apagada? Sólo para avisar en la vista previa; la nota manual nunca se bloquea por esto (corrige un
 * documento que ya existe ante el SAT). C2 · OF-2 (M3): manda la configuración del COMERCIO del cobro original (el founder decide por RFC
 * Y por comercio); sin comercio en el cobro (efectivo, transferencia), el criterio de siempre: ningún comercio del emisor la tiene
 * encendida. Acotada: un cobro, una configuración, o hasta 50 del emisor.
 */
async function facturacionApagada(fiscalEmisorId: string, venueId: string, processorData: unknown): Promise<boolean> {
  const originalPaymentId = (processorData as { originalPaymentId?: unknown } | null | undefined)?.originalPaymentId
  const cobro =
    typeof originalPaymentId === 'string'
      ? await prisma.payment.findFirst({
          where: { id: originalPaymentId, venueId },
          select: { merchantAccountId: true, ecommerceMerchantId: true },
        })
      : null
  if (cobro?.merchantAccountId || cobro?.ecommerceMerchantId) {
    const suya = await prisma.merchantFiscalConfig.findUnique({
      where: cobro.merchantAccountId ? { merchantAccountId: cobro.merchantAccountId } : { ecommerceMerchantId: cobro.ecommerceMerchantId! },
      select: { facturacionEnabled: true },
    })
    return !suya?.facturacionEnabled
  }
  const configs = await prisma.merchantFiscalConfig.findMany({
    where: { fiscalEmisorId },
    select: { facturacionEnabled: true },
    take: 50,
  })
  return !configs.some(c => c.facturacionEnabled)
}

// ─── deps reales (DB + storage). Los tests inyectan las suyas. ───────────────

/** Ronda 1 de la T8 (M5): con `lugarExpedicion` (el CP del receptor genérico de la nota a una global es el lugar de expedición VIGENTE). */
const CFDI_EMISOR_SELECT = {
  id: true,
  provider: true,
  providerKeyEnc: true,
  csdStatus: true,
  serie: true,
  lugarExpedicion: true,
} as const
/**
 * Lo que se lee de una original (individual o global). C1 (I2): todo SELECT que lea una global para `leerGlobal` trae su llave; la global
 * además compara el emisor ESCALAR, el periodo y los montos de la fila (C2 · Tarea 8). C2 (D5): sin el resumen ni los conceptos del XML, la
 * nota espera (`ESPERA_XML`).
 */
const SELECT_DE_ORIGINAL = {
  id: true,
  orderId: true,
  stampedAt: true, // ronda 1 (M1): el tope por antigüedad de la espera del XML
  protocoloIva: true,
  entrada: true,
  entradaHuella: true,
  uuid: true,
  serie: true,
  folio: true,
  status: true,
  cancelStatus: true,
  // C2 · T10 (M2 de la T3): en qué va la cancelación (para el texto de la nota que espera).
  cancelIntento: true,
  cancelEnviadaAt: true,
  cancelAcusadaAt: true,
  subtotalCents: true,
  taxCents: true,
  totalCents: true,
  formaPago: true,
  metodoPago: true,
  receptorRfc: true,
  receptorNombre: true,
  receptorRegimen: true,
  receptorCp: true,
  idempotencyKey: true,
  taxBreakdown: true,
  xmlConceptos: true,
  isGlobal: true,
  fiscalEmisorId: true,
  globalPeriod: true,
  fiscalEmisor: { select: CFDI_EMISOR_SELECT },
} satisfies Prisma.CfdiSelect

/**
 * Carga el reembolso, su original fiscal y el saldo reservado, sin consultar el catálogo.
 * Extraída de `defaultDeps` para que el guard de tenant sea legible (y auditable) aparte.
 */
export async function loadRefundForCreditNoteFromDb(
  venueId: string,
  refundPaymentId: string,
  tx: Prisma.TransactionClient = prisma,
  excludeCfdiId?: string,
): Promise<LoadedRefundForCreditNote | null> {
  const payment = await tx.payment.findUnique({
    where: { id: refundPaymentId },
    select: {
      id: true,
      venueId: true,
      orderId: true,
      type: true,
      status: true,
      amount: true,
      tipAmount: true,
      method: true,
      tenderSatFormaPago: true,
      processorData: true, // C2 (C2-4, C2-12): artículos devueltos o reparto congelado de delivery
    },
  })
  // Aislamiento por tenant: un pago de otro venue es "no encontrado", nunca un 403 informativo.
  if (!payment || payment.venueId !== venueId) return null

  const [order, individual] = await Promise.all([
    tx.order.findUnique({
      where: { id: payment.orderId },
      select: {
        venue: { select: { slug: true } },
      },
    }),
    tx.cfdi.findFirst({
      where: {
        venueId,
        orderId: payment.orderId,
        type: 'INGRESO',
        status: 'STAMPED',
        isGlobal: false,
        uuid: { not: null },
      },
      orderBy: { stampedAt: 'desc' },
      select: SELECT_DE_ORIGINAL,
    }),
  ])
  if (!order) return null
  // C2 · Tarea 8 (D6): sin factura individual, la GLOBAL timbrada cuyo manifiesto tiene la orden —principal o complementaria: una
  // complementaria es tan original como la principal (C1 T11); un ticket está en UNA sola global viva—. Ronda 1 (M2): también una global
  // CANCELADA (su manifiesto se conserva al cancelar), para decirlo con su motivo propio (`MOTIVO_GLOBAL_CANCELADA`) y no «primero se factura
  // la venta». Gana la más reciente por `stampedAt`: si el ticket volvió a entrar en otra global ya timbrada, ésa. Sin filtro por
  // configuración (d-1): si el ticket está en una global, su devolución merece su nota aunque el dueño haya cambiado después qué entra.
  const original =
    individual ??
    (await tx.cfdi.findFirst({
      where: {
        venueId,
        type: 'INGRESO',
        status: { in: ['STAMPED', 'CANCELLED'] },
        isGlobal: true,
        uuid: { not: null },
        manifiestoGlobal: { some: { orderId: payment.orderId } },
      },
      orderBy: { stampedAt: 'desc' },
      select: SELECT_DE_ORIGINAL,
    }))
  const esGlobal = original?.isGlobal === true

  // C2 · Tarea 3, ronda 1 (I1): ¿la original elegida se está sustituyendo? Una sustituta VIVA (reservada, en el PAC o en duda) la
  // detiene; una muerta (validación o rechazo definitivo) no; una ya timbrada no llega aquí (el cargador la elige a ella por
  // `stampedAt`). Dentro de la transacción de la nota corre después de `bloquearOrdenParaFacturar`: el mismo candado de la orden que
  // toma la reserva de la sustituta (`admission` de `emitirConEntrada`), así que nota y sustitución se serializan en los dos órdenes.
  const sustituta = original
    ? await tx.cfdi.findFirst({
        where: { venueId, replacesCfdiId: original.id, type: 'INGRESO', ...CFDI_VIVO },
        // T10 (N1 de la T3): ¿se envió hace más de una hora y no se timbró? Entonces está atorada (la resuelve soporte).
        select: { id: true, status: true, enviadoAt: true },
      })
    : null
  const atorada = sustitutaAtorada(sustituta, new Date())

  // 🔴 El correo es el que el receptor dio en la factura ORIGINAL (su entrada congelada). Antes se tomaba el perfil fiscal
  // más reciente con ese RFC en el negocio: con un RFC repetido (genérico, o una empresa con varios empleados) era el de
  // otra persona, y la nota ahora se envía sola (Codex, 30-sep). Sin correo capturado, no se adivina: se reenvía a mano.
  const receptorEmail = esGlobal ? null : (correoCapturado(original?.entrada) ?? null) // el Público en General no tiene correo

  const toCents = (d: Prisma.Decimal | number | null | undefined): number => Math.round(Number(d ?? 0) * 100)
  // C2 · T9 ronda 1 (I-1): los artículos devueltos que la factura no lleva porque no cobraron nada (D9: cortesía, descuento del 100 %),
  // por su RENGLÓN —la misma regla que la emisión (`netoRenglonCents` = 0)—, no por `montosPorRenglon` (las facturas de antes de C2 no lo
  // traen). Acotado a los artículos devueltos de ESTA orden.
  const devueltos = [...new Set(refundedItemsDe(payment.processorData).map(x => x.orderItemId))].filter(id => id.length > 0)
  const noFacturados = devueltos.length
    ? (
        await tx.orderItem.findMany({
          where: { id: { in: devueltos }, orderId: payment.orderId },
          select: { id: true, productName: true, total: true, discountAmount: true, orderPromotionId: true, isCortesia: true },
          take: devueltos.length,
        })
      )
        .filter(it => it.total != null && netoRenglonCents(it) === 0)
        .map(it => ({ orderItemId: it.id, ...(it.productName?.trim() ? { nombre: it.productName.trim() } : {}) }))
    : []
  // Los REFUND se guardan NEGATIVOS (importe y propina): se entregan en positivo y SEPARADOS.
  const salesRefundCents = Math.abs(toCents(payment.amount))
  const tipRefundCents = Math.abs(toCents(payment.tipAmount))

  // C2 T7: lo acreditado contra ESTA original (por tratamiento y por artículo), dentro de la misma transacción cuando la reserva lo pide.
  // Legacy sin vínculo fiable cuenta contra la orden; una entrada corrupta cuenta conservadoramente, nunca libera capacidad en silencio.
  const acreditado = original
    ? await acreditadoContra(tx, { venueId, orderId: payment.orderId, originalCfdiId: original.id, excludeCfdiId })
    : { alreadyCreditedCents: 0, notas: [], desconocidoCents: 0, porRenglon: new Map(), extraida: false }
  // C2 · Tarea 8 (Codex C2-3): con una global, lo de arriba es lo del TICKET; lo del DOCUMENTO entero son las notas vivas de cualquier ticket
  // contra ella (por `entrada.originalCfdiId`), en la misma transacción cuando la reserva lo pide.
  const acreditadoDelDocumento =
    original && esGlobal
      ? await acreditadoContra(tx, { venueId, orderId: null, originalCfdiId: original.id, excludeCfdiId, todoElDocumento: true })
      : undefined
  const alreadyCreditedCents = acreditado.alreadyCreditedCents
  // C2 T7 (G8): ¿la original PPD tiene complementos de pago? Sólo se pregunta si es PPD (la única que puede caer a 15, condonación).
  const tienePagos =
    original?.metodoPago === 'PPD'
      ? (await tx.cfdi.count({ where: { venueId, orderId: payment.orderId, type: 'PAGO', ...CFDI_VIVO } })) > 0
      : false

  return {
    venueId,
    venueSlug: order.venue.slug,
    refund: {
      id: payment.id,
      orderId: payment.orderId,
      type: payment.type,
      status: payment.status,
      salesRefundCents,
      tipRefundCents,
      method: payment.method,
      tenderSatFormaPago: payment.tenderSatFormaPago ?? null,
      processorData: payment.processorData ?? null,
      noFacturados,
    },
    original: original
      ? ({
          ...original,
          esGlobal,
          receptorEmail,
          sustitutaEnCurso: !!sustituta,
          sustitutaAtorada: atorada,
          tienePagos,
        } as OriginalCfdiForCreditNote)
      : null,
    grossByRate: [],
    alreadyCreditedCents,
    acreditado,
    ...(acreditadoDelDocumento ? { acreditadoDelDocumento } : {}),
  }
}

const defaultDeps: EmitRefundCreditNoteDeps = {
  findExistingCfdi: idempotencyKey => prisma.cfdi.findUnique({ where: { idempotencyKey } }),
  loadRefundForCreditNote: loadRefundForCreditNoteFromDb,
  resolveProvider: resolveFiscalProvider,
  storeArtifact: uploadFileToStorage,
  reserveCfdi: (data, tx = prisma) => tx.cfdi.create({ data: data as any }),
  runInTransaction: work => prisma.$transaction(work, { timeout: 60000 }),
  persistCfdi: async (data, where) => {
    if (!where) throw new Error('La escritura del egreso exige versión y estado de origen.')
    const { count } = await prisma.cfdi.updateMany({ where, data })
    return count === 1 ? prisma.cfdi.findFirst({ where: { id: where.id as string } }) : null
  },
  persistArtifacts: async (idempotencyKey, data, attempts) => {
    const { count } = await prisma.cfdi.updateMany({ where: { idempotencyKey, attempts, status: 'STAMPED' }, data })
    return count === 1 ? prisma.cfdi.findUnique({ where: { idempotencyKey } }) : null
  },
  loadEmisor: (id, venueId) => prisma.fiscalEmisor.findFirst({ where: { id, venueId } }),
  loadVenueSlug: async id => (await prisma.venue.findUniqueOrThrow({ where: { id }, select: { slug: true } })).slug,
  logAction: params => void defaultLogAction(params as any),
  repararArchivos: (cfdiId, opts) =>
    repararArchivosCompartido(cfdiId, {
      sandbox: opts.sandbox,
      esperaMs: opts.limiteMs ?? LIMITE_ESPERA_XML_EN_LA_NOTA_MS,
      insistir: opts.insistir,
    }),
}
