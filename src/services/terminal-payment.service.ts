/**
 * Terminal Payment Service
 *
 * Bridges POS HTTP requests (iOS/Android/Desktop) to TPV terminals via Socket.IO.
 * POS sends POST → backend holds connection → emits to terminal →
 * terminal processes payment → emits result → backend resolves HTTP response.
 *
 * Concurrency (arbitration): a physical PAX runs ONE EMV transaction at a time.
 * The durable `TerminalPaymentRequest` row + its partial UNIQUE index on
 * terminalId (active statuses only) is the authoritative per-terminal mutex —
 * correct across process restarts and multiple server instances. The in-memory
 * `pendingPayments` Map is ONLY the transport that resolves the long-poll; it is
 * never the source of truth. Recovery (result lost, restart, TPV crash) is via
 * the row: the TPV's idempotent REST payment-record closes it, and a watchdog
 * reconciles stale rows against the Payment table (holding the slot on UNKNOWN,
 * never freeing it blind — which would risk a double charge).
 * See Avoqado-HQ/specs/2026-07-11-terminal-payment-arbitration.md.
 */

import { v4 as uuidv4 } from 'uuid'
import { Prisma, TerminalPaymentRequestStatus, TransactionStatus, PaymentMethod, PaymentType } from '@prisma/client'
import type { TerminalPaymentRequest as FilaDeCobroRemoto } from '@prisma/client'
import prisma from '../utils/prismaClient'
import { terminalRegistry, normalizeTerminalId } from '../communication/sockets/terminal-registry'
import { PATRON_SQL_TRIM_COMO_JS } from '../utils/terminalSerial'
import { estadoBancarioSql } from './tpv/estadoBancario'
import socketManager from '../communication/sockets/managers/socketManager'
import logger from '../config/logger'
import AppError, {
  BadRequestError,
  OrderAlreadyPaidError,
  TerminalBusyError,
  TerminalPaymentAdmissionRetryError,
  TerminalUnavailableError,
  type TerminalBusyBlockingRequest,
} from '../errors/AppError'
import { resolveTerminalRefundTarget } from './tpv/terminalRefundTarget'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { logAction } from './dashboard/activity-log.service'
import { sendOpsAlert } from './alerts/opsAlert.service'
import { getVenuesEstrictos } from './terminal-payment-strictness'
import {
  procedenciaDelPagoDeSolicitud,
  whereElegibleComoCobroDeSolicitud,
  type PagoConProcedencia,
} from './shared/procedenciaDelPagoDeSolicitud'

export interface TerminalPaymentRequest {
  terminalId: string
  amountCents: number
  tipCents?: number
  rating?: number
  skipReview?: boolean
  orderId?: string
  venueId: string
  requestedBy: string // userId
  senderDeviceName?: string
  processedByStaffId?: string
  requestId?: string // Client-generated for cancel tracking + idempotency
  /**
   * El cliente que el cajero eligió en el POS para esta venta.
   *
   * 🔴 Se persiste en la fila y NO se manda a la terminal. La TPV registra el cobro con
   * su propio payload (que no lleva cliente), así que sin esto la venta con TARJETA nace
   * anónima mientras la misma venta en efectivo sí lleva cliente. Mandarlo por el socket
   * sería PII viajando al aparato sin ningún consumidor — y obligaría a desplegar la TPV
   * (3-5 días por la firma PAX) para un arreglo que es sólo del server.
   */
  customerId?: string | null
}

export interface TerminalPaymentResult {
  requestId: string
  status: 'success' | 'failed' | 'cancelled' | 'timeout'
  /** Per-result evidence; legacy negative outcomes remain uncertain without it. */
  outcomeEvidence?: 'PRE_AUTHORIZATION' | 'PROCESSOR_DECLINED'
  paymentId?: string
  transactionId?: string
  cardDetails?: {
    lastFour?: string
    brand?: string
    entryMode?: string
  }
  errorMessage?: string
  receipt?: {
    receiptUrl?: string
    receiptAccessKey?: string
  }
}

export interface TerminalPaymentStatus {
  requestId: string
  venueId: string
  terminalId: string
  status: TerminalPaymentRequestStatus
  amount: number // PESOS (major units)
  tip: number // PESOS
  orderId: string | null
  paymentId: string | null
  senderDevice: string | null
  lateResult: boolean
  cancelDisposition?: string | null
  /**
   * Crudo, sólo diagnóstico. Una lápida de admisión sale FAILED con `REJECTED_…`: prueba que ese cobro no se creó
   * (las apps publicadas sólo leen `status` y con FAILED sueltan su llave).
   */
  failureCode?: string | null
  /* §8 C.1 — desenlace canónico. ADITIVO: opcionales, y `status` conserva sus valores de siempre. Un cliente nuevo
   * decide con `outcome`; los publicados siguen decidiendo con `status`, que se traduce para protegerlos. */
  outcome?: TerminalOutcome
  outcomeEvidence?: TerminalOutcomeEvidence | null
  evidenceClass?: TerminalEvidenceClass | null
  reconciliationRequired?: boolean
  createdAt: string // ISO
  updatedAt: string // ISO
}

/* S6 (checkpoint 1 del webhook): lo que la TERMINAL puede saber de SU intento. El resultado del INTENTO (el Payment
 * cuya llave es este `attemptId`, nunca el de otro) va aparte del estado de la SOLICITUD (la proyección de siempre).
 * Ningún valor de `AttemptOutcome` significa «no cobrado»: `NOT_RECORDED` es «este servidor no tiene dinero registrado
 * para este intento», y la evidencia del procesador viaja aparte (`DECLINED` tampoco es final: S7 admite un `approved`
 * posterior del mismo intento). */
/**
 * Checkpoint 2 · N0: la capacidad del servidor viaja EN la solicitud. La TPV sólo espera el ACK del vínculo intento→solicitud (S1,
 * `terminal:payment_attempt_opened`) si la solicitud que está cobrando trae `attemptLinkVersion ≥ 1`; una solicitud entregada o
 * reentregada por un servidor anterior (rollback, staging) no la trae y la terminal sigue por el camino legacy sin pagar la espera.
 * Va en los DOS payloads (entrega fresca y replay). Aditivo: ningún campo se quita.
 */
export const TERMINAL_ATTEMPT_LINK_VERSION = 1

export type AttemptOutcome = 'RECORDED' | 'SECOND_CAPTURE_EVIDENCE' | 'REFERENCE_COLLISION_EVIDENCE' | 'NOT_RECORDED'
export type AttemptProcessorEvidence = 'APPROVED' | 'DECLINED' | 'NONE'

export interface TerminalAttemptStatus {
  attemptId: string
  requestId: string
  attempt: {
    attemptId: string
    outcome: AttemptOutcome
    /** El Payment de ESTE intento (`idempotencyKey === attemptId`), o null. Nunca el ganador de otro intento. */
    paymentId: string | null
    paymentStatus: TransactionStatus | null
    recordedVia: 'terminal' | 'webhook' | null
    amountCents: number | null
    tipCents: number | null
    /** `true` sólo si el Payment de este intento es el que cerró la solicitud. */
    isWinner: boolean
    /** En `SECOND_CAPTURE_EVIDENCE`: el Payment que sí ganó la solicitud (el dinero de este intento se concilia). */
    winnerPaymentId: string | null
    processorEvidence: AttemptProcessorEvidence
    processorEvidenceAt: string | null
    /** Existe un Payment con la llave del intento que NO es atribuible a esta solicitud/terminal: se conservó la incertidumbre. */
    paymentContradiction: boolean
    /** Existe evidencia del procesador para este intento con el serial de OTRA terminal: no cuenta, y se declara. */
    evidenceContradiction: boolean
    linkedAt: string
  }
  request: TerminalPaymentStatus & { closedVia: string | null; winnerAttemptId: string | null }
}

/**
 * §8 C.2 — lo que contesta el POST de cancelación. `cancelIntent` dice si la INTENCIÓN quedó guardada; `payment` es
 * la MISMA proyección del GET, releída tras el CAS, para que el POS no tenga que adivinar el estado con un booleano.
 *
 * - `RECORDED`: la fila quedó en CANCEL_REQUESTED (sigue ocupando la terminal: cancelar no prueba que no se cobró).
 * - `ALREADY_FINAL`: existe, pero el CAS no aplicó — ya tenía desenlace, o no está en esa terminal. Lo aclara `payment`.
 * - `NOT_FOUND`: no hay fila con ese `requestId` en este establecimiento.
 * - `MISSING_REQUEST_ID`: sin identidad no se cancela un cobro cualquiera que esté vivo en la terminal.
 */
export interface CancelPaymentOutcome {
  cancelIntent: 'RECORDED' | 'ALREADY_FINAL' | 'NOT_FOUND' | 'MISSING_REQUEST_ID'
  /** Emitido a un socket del registro. NO prueba que la terminal lo recibiera. */
  cancelEmitted: boolean
  payment: TerminalPaymentStatus | null
}

export interface TerminalReceiptPrintRequest {
  terminalId: string
  venueId: string
  requestedBy: string
  requestId?: string
  receipt: Record<string, unknown>
}

export interface TerminalReceiptPrintResult {
  requestId: string
  status: 'success' | 'failed' | 'timeout'
  errorMessage?: string
}

export interface TerminalRefundRequest {
  terminalId: string
  venueId: string
  paymentId: string
  requestedBy: string
  requestId?: string
  reason?: string
}

/**
 * 🔑 El desenlace de este evento es "¿se abrió la devolución en la terminal?",
 * NO "¿se devolvió el dinero?". La devolución la termina una persona en el
 * aparato (en Blumon hay que volver a pasar la tarjeta) y puede tardar
 * minutos; quedarse esperando eso congelaría al cajero. Cuando el dinero se
 * mueve, la propia TPV lo registra por la ruta REST de reembolsos que ya
 * existe, y ahí es donde aparece en Avoqado.
 */
export interface TerminalRefundResult {
  requestId: string
  status: 'opened' | 'rejected' | 'timeout'
  errorMessage?: string
}

interface PendingPayment {
  resolve: (result: TerminalPaymentResult) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  requestId: string
  terminalId: string
  venueId: string
  createdAt: Date
}

interface PendingRefundRequest {
  resolve: (result: TerminalRefundResult) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  requestId: string
  terminalId: string
  venueId: string
  paymentId: string
  createdAt: Date
}

interface PendingReceiptPrint {
  resolve: (result: TerminalReceiptPrintResult) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  requestId: string
  terminalId: string
  venueId: string
  createdAt: Date
}

const PAYMENT_TIMEOUT_MS = 300_000 // 5 minutes
/** Codex R1 (P2): el vencimiento del long-poll se acota por entorno SÓLO fuera de producción, para PROBAR el vencimiento real. */
function longPollMs(): number {
  const override = Number(process.env.TERMINAL_PAYMENT_LONG_POLL_MS)
  return Number.isFinite(override) && override >= 100 && process.env.NODE_ENV !== 'production' ? override : PAYMENT_TIMEOUT_MS
}
const PAYMENT_DELIVERY_ACK_TIMEOUT_MS = 5_000
const RECEIPT_PRINT_TIMEOUT_MS = 30_000 // 30 seconds
// Sólo se espera el ACK de "abrí la pantalla", no que alguien pase la tarjeta.
const REFUND_OPEN_TIMEOUT_MS = 20_000 // 20 seconds
const CANCEL_GRACE_MS = 30_000 // watchdog grace before a CANCEL_REQUESTED row is resolved
// Connectivity is diagnostic only; a heartbeat never proves the SDK stopped.
const TERMINAL_ALIVE_WINDOW_MS = 5 * 60_000
// After an automatic/manual release, a payment recorded WITHOUT the request id (old queues) still
// has to reach the row: released rows are swept for this long.
const RELEASED_LATE_RECONCILE_WINDOW_MS = 30 * 60_000
const RELEASE_FAILURE_CODES = ['AUTO_RELEASED', 'MANUAL_RELEASE']

/**
 * Cuánto se espera, DESDE QUE VIMOS VOLVER a la terminal, antes de soltar su ranura.
 *
 * 🔴 20 min y no 5 (Square caduca su checkout a los 5): la cola offline de la PAX subía cada 15,
 * así que con 5 se soltaría antes de que el aparato tuviera ocasión de contar lo que pasó. Desde el
 * 7-sep la cola reintenta al instante (`PaymentSyncScheduler.runNow`), pero el plazo se queda en 20
 * hasta MEDIRLO en hardware: bajarlo es la dirección que cuesta dinero, y no hay plazo seguro
 * demostrado (auditoría de Codex, 12-sep).
 */
const UNKNOWN_AUTO_RELEASE_GRACE_MS = 20 * 60_000

// Statuses that HOLD the per-terminal slot (must match the partial UNIQUE index
// in the migration). UNKNOWN holds the slot on purpose — a terminal whose
// outcome we can't determine may still be mid-charge, so we never free it blind.
const SLOT_HELD: TerminalPaymentRequestStatus[] = [
  TerminalPaymentRequestStatus.PENDING,
  TerminalPaymentRequestStatus.SENT,
  TerminalPaymentRequestStatus.CANCEL_REQUESTED,
  TerminalPaymentRequestStatus.UNKNOWN,
]
// A live request still awaiting its result (subset of SLOT_HELD, excludes UNKNOWN).
const IN_FLIGHT: TerminalPaymentRequestStatus[] = [
  TerminalPaymentRequestStatus.PENDING,
  TerminalPaymentRequestStatus.SENT,
  TerminalPaymentRequestStatus.CANCEL_REQUESTED,
]

/**
 * Procedencia de una ENTREGA (Codex, 11-sep): se escribe ANTES de emitir, por solicitud. `LEGACY` = socket sin
 * capacidad de ACK (la app de entonces no tenía bandeja durable); `DURABLE` = socket con ACK. La lista vive en
 * `TerminalPaymentRequest.deliveryProvenance = { deliveries: [...] }`; `null` es procedencia DESCONOCIDA (fila
 * anterior a la columna) y nunca se lee como «no entregada».
 */
export type TerminalDeliveryRecord = {
  protocol: 'LEGACY' | 'DURABLE'
  ackVersion: number
  cancelDispositionVersion: number
  probeVersion: number
  socketId: string
  at: string
  replay: boolean
}
export function leerProcedencia(value: unknown): TerminalDeliveryRecord[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const deliveries = (value as { deliveries?: unknown }).deliveries
  if (!Array.isArray(deliveries)) return null
  // Una sola entrada que no se sabe leer vuelve DESCONOCIDA toda la procedencia. Filtrarla la convertiría en
  // «nunca se entregó» ([]), que es justo lo que autoriza a la sonda a liberar y al replay a reenviar.
  const legibles = deliveries.every(
    d =>
      !!d &&
      typeof d === 'object' &&
      ((d as TerminalDeliveryRecord).protocol === 'LEGACY' || (d as TerminalDeliveryRecord).protocol === 'DURABLE'),
  )
  return legibles ? (deliveries as TerminalDeliveryRecord[]) : null
}

/* ── §8 C.1: el vocabulario de la LISTA BLANCA. Vive ARRIBA de los predicados a propósito: los `const` tienen zona
 * muerta temporal y el predicado se evalúa al cargar el módulo — declararlos después reventaría el arranque. ── */

/** Prefijo de las LÁPIDAS de admisión (H.5/H.6): el cobro se rechazó antes de existir. */
const PREFIJO_LAPIDA = 'REJECTED_'
/** La evidencia que la TERMINAL manda en el sobre y que sí acredita «no se cobró». */
const EVIDENCIA_ACREDITADA_DE_TERMINAL = ['PROCESSOR_DECLINED', 'PRE_AUTHORIZATION'] as const
/**
 * Códigos de FAILED que acreditan «no se cobró» por sí solos. `TPV_CONFIRMED_NO_CHARGE` NO está aquí: ése exige
 * además la evidencia dentro del sobre (la escribe `closeRow`, que degrada a `timeout` cualquier failed/cancelled
 * sin ella). Los dos últimos todavía no tienen escritor — los escribirán A (identidad de bandeja) y B (conciliación).
 */
const CODIGOS_SIN_COBRO: Record<string, { evidencia: TerminalOutcomeEvidence; clase: TerminalEvidenceClass }> = {
  TPV_NEVER_RECEIVED: { evidencia: 'NEVER_DELIVERED', clase: 'SERVER' },
  TPV_INBOX_NOT_FOUND: { evidencia: 'NOT_FOUND_CONTINUOUS_INBOX', clase: 'TERMINAL' },
  OPERATOR_RECONCILED_NO_CHARGE: { evidencia: 'OPERATOR_RECONCILED', clase: 'OPERATOR' },
  // 🔴 Lo escribe SÓLO `releaseUnprovenNegative` (Task 2): una terminal que lo mande en su sobre se degrada igual que
  // cualquier negativo sin evidencia (`closeRow` sólo acredita PRE_AUTHORIZATION / PROCESSOR_DECLINED).
  NO_EVIDENCE_AFTER_WINDOW: { evidencia: 'NO_EVIDENCE_AFTER_WINDOW', clase: 'SERVER' },
}

/**
 * «El sobre de la terminal NO trae una evidencia que acredite» — en SQL y NULL-safe.
 *
 * 🔴 Medido contra Postgres el 11-sep, no supuesto: Prisma NO acepta `NOT` alrededor de un filtro de ruta JSON (ni
 * `in`/`notIn` sobre una ruta), y un `NOT` sobre una columna que puede ser NULL devuelve NULL —o sea, EXCLUYE la
 * fila— en vez de TRUE. Las dos piezas de abajo son las únicas formas que sí expresan «no acredita» cubriendo
 * columna nula, llave ausente, sobre que no es objeto y cualquier otro valor.
 */
const EVIDENCIA_NO_ACREDITADA: Prisma.TerminalPaymentRequestWhereInput = {
  OR: [
    { resultJson: { path: ['outcomeEvidence'], equals: Prisma.DbNull } },
    { AND: EVIDENCIA_ACREDITADA_DE_TERMINAL.map(evidencia => ({ resultJson: { path: ['outcomeEvidence'], not: evidencia } })) },
  ],
}

/**
 * El predicado de BLOQUEO (ranura de la terminal y cancelación de la orden), EQUIVALENTE a
 * `desenlaceCanonico(row).outcome === 'UNRESOLVED'` — lo que incluye, a propósito, las filas EN VUELO.
 *
 * 🔴 Es la misma LISTA BLANCA de §8 C.1 escrita en SQL: bloquea salvo que la fila acredite un desenlace. Antes era
 * una lista NEGRA de tres códigos, así que un FAILED con cualquier otro código (histórico, manual o nuevo) liberaba
 * la terminal sin que nadie hubiera acreditado nada. La equivalencia con la función la fija una prueba de tabla
 * contra Postgres real (`terminalPaymentRecovery.integration.test.ts`), no una lectura del código.
 */
export const UNRESOLVED_FINANCIAL_OUTCOME: Prisma.TerminalPaymentRequestWhereInput = {
  OR: [
    // En vuelo, UNKNOWN y TIMED_OUT: ningún `failureCode` los acredita.
    { status: { in: [...SLOT_HELD, TerminalPaymentRequestStatus.TIMED_OUT] } },
    // COMPLETED sin `Payment`: el estado dice «cerrada», pero nada prueba el dinero. La cadena VACÍA cuenta como
    // ausente igual que NULL (`paymentId` es referencia blanda, sin FK) — así el SQL dice lo mismo que la función.
    { status: TerminalPaymentRequestStatus.COMPLETED, OR: [{ paymentId: null }, { paymentId: '' }] },
    // FAILED sin código: no está en la lista blanca. (Va aparte porque un `NOT`/`notIn` deja fuera los NULL.)
    { status: TerminalPaymentRequestStatus.FAILED, failureCode: null },
    {
      status: TerminalPaymentRequestStatus.FAILED,
      AND: [
        { failureCode: { not: null } },
        // …ni lápida de admisión (probó que el cobro no se creó)…
        { NOT: { failureCode: { startsWith: PREFIJO_LAPIDA } } },
        // …ni uno de los códigos que acreditan por sí solos…
        { failureCode: { notIn: Object.keys(CODIGOS_SIN_COBRO) } },
        // …ni un «la terminal confirmó que no cobró» CON su evidencia.
        { OR: [{ failureCode: { not: 'TPV_CONFIRMED_NO_CHARGE' } }, EVIDENCIA_NO_ACREDITADA] },
      ],
    },
    // Sólo la aceptación explícita de la terminal acredita una cancelación.
    { status: TerminalPaymentRequestStatus.CANCELLED, OR: [{ cancelDisposition: null }, { cancelDisposition: { not: 'ACCEPTED' } }] },
  ],
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * EL INTERRUPTOR POR VENUE (I.6 del diseño v3, 11-sep-2026)
 *
 * 🔴 Por qué: la lista blanca de arriba es correcta, y desplegarla de golpe bloquearía 375 filas HISTÓRICAS de
 * producción (305 en la PAX de Testarudo, 53 y 12 en las Nexgo; medido el 11-sep en sólo lectura) — filas que
 * producción liberó por tiempo (`AUTO_RELEASED`) o que nacieron sin `cancelDisposition`, porque esa columna no
 * existía allá. Dejarían las terminales muertas, y **B —la conciliación documentada, única salida— todavía no
 * existe**. El auditor independiente RECHAZÓ el orden de despliegue anterior justamente por esto.
 *
 * La forma: `Venue.terminalPaymentStrictSince`. `null` = APAGADO; una fecha F = ENCENDIDO desde F. Una sola
 * columna resuelve las dos cosas que I.6 pide —el flag por venue Y la «migración acotada por fecha»—, y apagar es
 * volver a `null`, así que la marcha atrás no necesita despliegue.
 *
 * 🔑 Lo que hace correcta la composición: **el permisivo es un SUBCONJUNTO del estricto.** `SLOT_HELD` (en vuelo +
 * UNKNOWN) está dentro de la primera rama de `UNRESOLVED_FINANCIAL_OUTCOME`, así que «permisivo O rama estricta»
 * sólo puede AÑADIR filas al bloqueo, nunca quitarlas. Si fueran conjuntos cruzados, encender el flag podría
 * LIBERAR una fila que hoy retiene la ranura — la única dirección que cuesta dinero. Hay una prueba contra
 * Postgres que lo fija (`terminalPaymentStrictFlag.integration.test.ts`).
 *
 * 🔴 El flag es por el venue DE LA FILA, no por el que pregunta: `getBusyTerminalIds` consulta a propósito sin
 * filtrar venue (la reserva es FÍSICA, del aparato, y una terminal puede haber cambiado de sucursal). La pregunta
 * que responde el predicado es «¿esta fila tiene desenlace acreditado?», y eso depende de si las terminales de SU
 * venue ya están migradas.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Venues donde ya rige la lista blanca estricta, con la fecha desde la que rige. Vacío = nadie migró todavía. */
export type EstrictoPorVenue = ReadonlyMap<string, Date>

/**
 * Lo que bloquea SIEMPRE, en los dos modos: exactamente lo que bloquea producción hoy (HEAD `3000f3d0`,
 * `status: { in: SLOT_HELD }`). No se deriva de la lista blanca a propósito — es el comportamiento heredado, y
 * tiene que poder leerse y compararse contra el de producción sin desenredar nada.
 */
const BLOQUEO_HEREDADO: Prisma.TerminalPaymentRequestWhereInput = { status: { in: SLOT_HELD } }

/**
 * Lo que el servidor SOLTÓ A SABIENDAS: por tiempo (`AUTO_RELEASED`) o a mano (`MANUAL_RELEASE`).
 *
 * 🔴 Libera la RANURA en los DOS regímenes, y NUNCA la VENTA. Son dos candados distintos y ésta es
 * la única fila donde se separan:
 *
 *   · RANURA  — «¿puede este aparato cobrar otra cosa?» → SÍ. Lo que entre después es OTRA venta,
 *     de otro cliente. Sin esto la terminal queda muerta para siempre, que es exactamente la queja
 *     que originó este trabajo.
 *   · VENTA   — «¿puede esta orden recibir otro cobro?» → NO, y sigue estricto SIEMPRE
 *     (`UNRESOLVED_FINANCIAL_OUTCOME`, que esta constante NO toca). Por eso soltar la ranura no
 *     invita a un doble cobro: esa venta no se puede recobrar ni aquí ni en ninguna otra terminal
 *     de la sucursal, y eso está probado con 14 aparatos en `terminalPaymentRecovery`.
 *
 * 🔑 El tiempo NO acredita «no se cobró» — y por eso la fila **se conserva** con su desenlace
 * pendiente: la sonda le sigue preguntando (`SIN_DESENLACE_ACREDITADO` se deriva de UNRESOLVED, no
 * de esto) y un `Payment` tardío la reconcilia gritando 🚨. Se suelta CAPACIDAD, no obligación.
 *
 * 🔑 Un `TIMED_OUT` SIN código NO entra: eso no es una liberación deliberada sino una fila
 * histórica sin explicación, y ésa sigue reteniendo su ranura en estricto.
 */
const SOLTADA_POR_POLITICA: Prisma.TerminalPaymentRequestWhereInput = {
  status: TerminalPaymentRequestStatus.TIMED_OUT,
  failureCode: { in: RELEASE_FAILURE_CODES },
}

/** Su complemento, NULL-seguro (ver el comentario en `predicadoDeBloqueo`). */
const NO_SOLTADA_POR_POLITICA: Prisma.TerminalPaymentRequestWhereInput[] = [
  { status: { not: TerminalPaymentRequestStatus.TIMED_OUT } },
  { failureCode: null },
  { failureCode: { notIn: RELEASE_FAILURE_CODES } },
]

/**
 * El predicado de bloqueo REAL, parametrizado por qué venues ya migraron.
 *
 * Con el mapa vacío es el comportamiento de producción tal cual. Con un venue dentro, sus filas desde el corte se
 * juzgan además con la lista blanca estricta; las anteriores al corte, no (su verdad se concilia con B).
 */
export function predicadoDeBloqueo(estrictos: EstrictoPorVenue): Prisma.TerminalPaymentRequestWhereInput {
  if (estrictos.size === 0) return BLOQUEO_HEREDADO
  return {
    OR: [
      BLOQUEO_HEREDADO,
      ...[...estrictos].map(([venueId, desde]) => ({
        venueId,
        createdAt: { gte: desde },
        // 🔴 «pendiente de desenlace» Y «no soltada por política» — ver `SOLTADA_POR_POLITICA`.
        //
        // 🔑 Va como AND de dos bloques y NO como `{...UNRESOLVED, OR: […]}`: el spread PISA el `OR`
        // que `UNRESOLVED_FINANCIAL_OUTCOME` ya trae dentro, y con él se va la lista blanca entera
        // (medido: pasaban a bloquear COMPLETED con Payment, CANCELLED/ACCEPTED y las lápidas — o
        // sea, terminales sanas muertas). Lo cazó la prueba de equivalencia contra Postgres.
        //
        // 🔑 Y el complemento va como OR explícito, NO como `NOT: {status, failureCode: {in}}`: con
        // el NOT, una fila `TIMED_OUT` con `failureCode` NULL evalúa a NULL en SQL (no a TRUE) y se
        // caía del filtro, dejando de bloquear una fila que DEBE bloquear. Es la misma trampa que
        // `UNRESOLVED_FINANCIAL_OUTCOME` ya declara arriba para los FAILED sin código.
        AND: [UNRESOLVED_FINANCIAL_OUTCOME, { OR: NO_SOLTADA_POR_POLITICA }],
      })),
    ],
  }
}

/**
 * Las filas que SÓLO bloquean en modo estricto: la diferencia exacta entre los dos regímenes.
 *
 * Es el número que decide si encender el flag en un venue es seguro — cada una de estas filas pasaría a reservar
 * su terminal, y sin la conciliación B no hay forma de liberarlas. Por eso se enseña en la vista previa antes de
 * confirmar, en vez de dejar que el operador lo descubra con las terminales ya muertas.
 */
export const SOLO_BLOQUEA_EN_ESTRICTO: Prisma.TerminalPaymentRequestWhereInput = {
  AND: [UNRESOLVED_FINANCIAL_OUTCOME, { NOT: { status: { in: SLOT_HELD } } }],
}

/** Lo mínimo que hay que leer de la fila para saber si retiene la ranura. */
export interface FilaDeBloqueo extends FilaDeDesenlace {
  venueId: string
  createdAt: Date
}

/**
 * La función ESPEJO de `predicadoDeBloqueo`: ¿esta fila retiene la ranura de su terminal?
 *
 * 🔴 Tiene que contestar lo MISMO que el SQL en los dos modos. Si divergieran, el mismo cobro diría una cosa al
 * admitir (que consulta la base) y otra al proyectar el estado (que consulta la función), y ese desacuerdo se
 * paga con un cobro doble o con una terminal muerta. La equivalencia la fija una prueba de tabla contra Postgres
 * real, no una lectura del código.
 */
export function bloqueaLaRanura(row: FilaDeBloqueo, estrictos: EstrictoPorVenue): boolean {
  if (SLOT_HELD.includes(row.status)) return true
  const desde = estrictos.get(row.venueId)
  if (!desde || row.createdAt < desde) return false
  if (fueSoltadaPorPolitica(row)) return false
  return desenlaceCanonico(row).outcome === 'UNRESOLVED'
}

/** El espejo en función de `SOLTADA_POR_POLITICA`. Los dos tienen que contestar lo MISMO. */
export function fueSoltadaPorPolitica(row: { status: TerminalPaymentRequestStatus; failureCode?: string | null }): boolean {
  return row.status === TerminalPaymentRequestStatus.TIMED_OUT && RELEASE_FAILURE_CODES.includes(row.failureCode ?? '')
}

/**
 * Filas a las que la SONDA les pregunta y que un resultado tardío puede cerrar: sin desenlace acreditado y ya fuera
 * de vuelo. Se DERIVA del predicado de bloqueo para que no puedan separarse — una fila que bloquea y que nadie puede
 * sondear ni cerrar sería una terminal ocupada para siempre.
 *
 * Se restan las filas EN VUELO (las gobiernan `replayPendingForTerminal` y el vigía) y las COMPLETED **con
 * `Payment`** (ésas sí son dinero registrado: no se sondean ni se reescriben).
 *
 * 🔴 Una COMPLETED **sin** `Payment` SÍ se sondea (P1-4 de la auditoría de Codex, 11-sep). Antes se excluían
 * TODAS las COMPLETED por «ser dinero registrado», y una sin pago no lo es: bloqueaba la terminal, la sonda no
 * le preguntaba nunca y la liberación manual sólo acepta `UNKNOWN` — o sea, terminal muerta sin salida. Medido
 * en producción ese día: **0 filas** en ese estado (1093 COMPLETED, todas con pago), así que esto cierra un
 * agujero teórico antes de que lo abra el primer escritor que se equivoque, no un incidente vivo.
 */
export const SIN_DESENLACE_ACREDITADO: Prisma.TerminalPaymentRequestWhereInput = {
  AND: [
    UNRESOLVED_FINANCIAL_OUTCOME,
    { NOT: { status: { in: IN_FLIGHT } } },
    // COMPLETED se resta sólo cuando acredita: las que UNRESOLVED deja pasar son justo las que no tienen pago.
    { NOT: { AND: [{ status: TerminalPaymentRequestStatus.COMPLETED }, { paymentId: { not: null } }, { paymentId: { not: '' } }] } },
  ],
}
const PROBE_BATCH = 25
/**
 * Cuánto se deja de sondear una solicitud cuya última respuesta NO trajo evidencia acreditada. Preguntar
 * cada 30 s a una terminal que ya dijo «cancelado, sin más» no produce evidencia nueva: sólo ruido. Un
 * reinicio del servidor la vuelve a preguntar una vez, que es lo correcto.
 */
const PROBE_UNACCREDITED_BACKOFF_MS = 15 * 60_000

type ContratoDelCobro = {
  requested: { amountCents: number; tipCents: number; totalCents: number }
  reported: { amountCents: number; tipCents: number; totalCents: number }
}

/**
 * ¿El dinero cobrado coincide con el que pidió el POS? Devuelve el contrato SÓLO cuando
 * difieren; `null` cuando cuadra o cuando la fila no guarda importes comparables.
 *
 * 🔴 Vive en UNA sola función a propósito. El MISMO descuadre se descubre por DOS rutas —el
 * cierre dentro de la transacción del pago (`closeRowFromPaymentTx`) y el barrido que recupera
 * un cobro tardío (`reconcileStaleRequests`)— y tenerlo escrito una sola vez es lo que impide
 * que una avise y la otra no. Es exactamente el defecto que ya ocurrió con el aviso de
 * «cobro sobre una petición cancelada».
 *
 * Sin importes pedidos utilizables devuelve `null`: no hay contrato que comparar, y afirmar un
 * descuadre a partir de un dato ausente sería inventarlo.
 */
function contratoDescuadrado(
  pedido: { amountCents?: number | null; tipCents?: number | null },
  cobrado: { amountCents: number; tipCents: number },
): ContratoDelCobro | null {
  if (!Number.isSafeInteger(pedido.amountCents) || !Number.isSafeInteger(pedido.tipCents)) return null
  const requestedAmount = pedido.amountCents as number
  const requestedTip = pedido.tipCents as number
  const requested = {
    amountCents: requestedAmount,
    tipCents: requestedTip,
    totalCents: requestedAmount + requestedTip,
  }
  const reported = {
    amountCents: cobrado.amountCents,
    tipCents: cobrado.tipCents,
    totalCents: cobrado.amountCents + cobrado.tipCents,
  }
  const cuadra =
    reported.amountCents === requested.amountCents &&
    reported.tipCents === requested.tipCents &&
    reported.totalCents === requested.totalCents
  return cuadra ? null : { requested, reported }
}

/**
 * La MARCA que deja una fila cerrada como COMPLETED cuando el importe cobrado no es el que pidió
 * el POS: los campos para esparcir dentro del `data:`, más el contrato para el 🚨.
 *
 * 🔴 Existe porque la comprobación vivía en DOS de las CINCO rutas que cierran una fila. El
 * cierre dentro de la transacción del pago y el barrido de peticiones viejas sí marcaban; el
 * barrido de UNKNOWN, el de RELEASED y la intervención manual la cerraban «pagada» sin dejar
 * rastro del descuadre — la orden quedaba saldada y la diferencia no aparecía en ningún lado.
 * Escrito una sola vez es lo único que impide que una ruta marque y otra no.
 *
 * El dinero NO se rechaza: ya salió de la tarjeta. Se cierra igual, pero MARCADO, para que un
 * humano lo concilie. Sin importes pedidos comparables no hay marca: inventar un descuadre a
 * partir de un dato ausente sería peor que no decir nada.
 */
function marcaDeDescuadre(
  pedido: { requestId: string; amountCents?: number | null; tipCents?: number | null },
  payment: { id: string; amount?: Prisma.Decimal | null; tipAmount?: Prisma.Decimal | null },
) {
  // 🔴 Sin importes COBRADOS utilizables no hay marca — y, sobre todo, no hay excepción: esto
  // corre dentro de un barrido de hasta 200 filas, y un `throw` aquí abortaría la conciliación
  // de TODAS las demás por culpa de una. Mismo principio que `contratoDescuadrado`: un dato
  // ausente no prueba un descuadre.
  const cobradoAmount = Number(payment.amount?.mul(100))
  const cobradoTip = Number(payment.tipAmount?.mul(100))
  const cobrado =
    Number.isSafeInteger(cobradoAmount) && Number.isSafeInteger(cobradoTip) ? { amountCents: cobradoAmount, tipCents: cobradoTip } : null
  const contrato = cobrado ? contratoDescuadrado(pedido, cobrado) : null
  return {
    contrato,
    campos: contrato
      ? {
          failureCode: 'CONTRACT_MISMATCH',
          resultJson: {
            requestId: pedido.requestId,
            status: 'success',
            paymentId: payment.id,
            reconciliationRequired: true,
            requested: contrato.requested,
            reported: contrato.reported,
          },
        }
      : {},
  }
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * §8 C.1 — DESENLACE CANÓNICO. Una sola función, LISTA BLANCA por `(status, failureCode)`.
 *
 * 🔴 Por qué lista blanca: la traducción anterior (`hasUnprovenLegacyOutcome`) enumeraba los códigos MALOS, así que
 * cualquier código nuevo, manual o desconocido salía como desenlace FINAL — y las apps publicadas leen FAILED como
 * «no se cobró» y sueltan su llave durable. Un código que nadie clasificó tiene que ser UNRESOLVED: es la única
 * dirección que no regala dinero. Todo escritor nuevo de `failureCode` se clasifica AQUÍ, o queda UNRESOLVED.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

export type TerminalOutcome = 'CHARGED' | 'NOT_CHARGED' | 'UNRESOLVED'
export type TerminalOutcomeEvidence =
  | 'PAYMENT_RECORDED'
  | 'PROCESSOR_DECLINED'
  | 'PRE_AUTHORIZATION'
  | 'CANCEL_ACCEPTED'
  | 'NEVER_DELIVERED'
  | 'REJECTED_AT_ADMISSION'
  | 'NOT_FOUND_CONTINUOUS_INBOX'
  | 'OPERATOR_RECONCILED'
  /** La ventana de confirmación venció sin webhook, sin historial y sin cajero: el SERVIDOR libera y vigila 30 min (plan 16-sep). */
  | 'NO_EVIDENCE_AFTER_WINDOW'
/** Quién acredita el desenlace: la TERMINAL (lo dijo el aparato), el SERVIDOR (nunca salió de aquí) o un OPERADOR. */
export type TerminalEvidenceClass = 'TERMINAL' | 'SERVER' | 'OPERATOR'

export interface TerminalPaymentDesenlace {
  outcome: TerminalOutcome
  outcomeEvidence: TerminalOutcomeEvidence | null
  evidenceClass: TerminalEvidenceClass | null
  /** Sólo cuando va en `true`: el dinero salió pero no cuadra con lo que pidió el POS (`CONTRACT_MISMATCH`). */
  reconciliationRequired?: boolean
}

/** Lo mínimo que hay que leer de la fila para clasificarla. */
export interface FilaDeDesenlace {
  status: TerminalPaymentRequestStatus
  failureCode?: string | null
  cancelDisposition?: string | null
  paymentId?: string | null
  resultJson?: Prisma.JsonValue | null
}

const SIN_DESENLACE: TerminalPaymentDesenlace = { outcome: 'UNRESOLVED', outcomeEvidence: null, evidenceClass: null }

/** La evidencia que la terminal dejó en el sobre, o `null` si el sobre no la trae legible. */
function evidenciaDelSobre(resultJson: Prisma.JsonValue | null | undefined): string | null {
  if (!resultJson || typeof resultJson !== 'object' || Array.isArray(resultJson)) return null
  const evidencia = (resultJson as Record<string, unknown>).outcomeEvidence
  return typeof evidencia === 'string' ? evidencia : null
}

/**
 * ¿Se cobró, no se cobró, o no se sabe? ÚNICA respuesta del servidor a esa pregunta: la usan el GET de estado, la
 * réplica idempotente del POST, el predicado de bloqueo y el MCP, para que no puedan divergir entre sí.
 */
export function desenlaceCanonico(row: FilaDeDesenlace): TerminalPaymentDesenlace {
  switch (row.status) {
    case TerminalPaymentRequestStatus.COMPLETED:
      // 🔴 Sin `Payment` no hay cobro acreditado: COMPLETED es el estado, el dinero lo prueba la fila de pago.
      // 🔴 La cadena VACÍA cuenta como ausente, y el SQL de abajo la cubre igual (P2-5 de Codex): `paymentId` es
      // una referencia BLANDA sin FK, así que `''` cabe en el esquema. Divergían —JS bloqueaba, el predicado no—
      // y la divergencia se resuelve hacia el lado SEGURO: sin un id de pago real no hay cobro acreditado, así
      // que se retiene la ranura. Alinearlo al revés habría acreditado un cobro inexistente.
      if (!row.paymentId) return SIN_DESENLACE
      return {
        outcome: 'CHARGED',
        outcomeEvidence: 'PAYMENT_RECORDED',
        evidenceClass: 'TERMINAL',
        // El dinero NO se rechaza (ya salió de la tarjeta); se marca para que un humano lo concilie.
        ...(row.failureCode === 'CONTRACT_MISMATCH' ? { reconciliationRequired: true } : {}),
      }

    case TerminalPaymentRequestStatus.FAILED: {
      const codigo = row.failureCode ?? ''
      if (codigo.startsWith(PREFIJO_LAPIDA)) {
        return { outcome: 'NOT_CHARGED', outcomeEvidence: 'REJECTED_AT_ADMISSION', evidenceClass: 'SERVER' }
      }
      // 🔴 `Object.hasOwn`, no el acceso pelón (P2-5 de la auditoría de Codex, 11-sep): un `failureCode` que se
      // llame `constructor` o `__proto__` encuentra una propiedad HEREDADA, sale truthy y acredita un
      // «no se cobró» con evidencia `undefined` — mientras el SQL lo mantiene bloqueado. Nadie escribe hoy esos
      // códigos, pero la equivalencia función↔SQL es lo único que impide que el mismo cobro diga dos cosas.
      // `hasOwnProperty.call` y no `Object.hasOwn`: el target de este proyecto es anterior a ES2022.
      const fijo = Object.prototype.hasOwnProperty.call(CODIGOS_SIN_COBRO, codigo) ? CODIGOS_SIN_COBRO[codigo] : undefined
      if (fijo) return { outcome: 'NOT_CHARGED', outcomeEvidence: fijo.evidencia, evidenceClass: fijo.clase }
      if (codigo === 'TPV_CONFIRMED_NO_CHARGE') {
        const evidencia = evidenciaDelSobre(row.resultJson)
        if ((EVIDENCIA_ACREDITADA_DE_TERMINAL as readonly string[]).includes(evidencia ?? '')) {
          return { outcome: 'NOT_CHARGED', outcomeEvidence: evidencia as TerminalOutcomeEvidence, evidenceClass: 'TERMINAL' }
        }
      }
      return SIN_DESENLACE
    }

    case TerminalPaymentRequestStatus.CANCELLED:
      // Sólo la aceptación EXPLÍCITA de la terminal antes de ejecutar acredita que no se cobró.
      return row.cancelDisposition === 'ACCEPTED'
        ? { outcome: 'NOT_CHARGED', outcomeEvidence: 'CANCEL_ACCEPTED', evidenceClass: 'TERMINAL' }
        : SIN_DESENLACE

    // PENDING / SENT / CANCEL_REQUESTED (en vuelo), UNKNOWN y TIMED_OUT: ningún código los acredita.
    default:
      return SIN_DESENLACE
  }
}

/**
 * `cancelDisposition` tal como lo ve el cliente. Android 2.18.x e iOS 1.10.x evalúan `ACTIVE` ANTES que `status`, así
 * que una fila cerrada por otra vía con un `ACTIVE` viejo encima les dice «el cobro sigue activo» PARA SIEMPRE y su
 * llave durable no se suelta nunca (auditoría 11-sep, P1).
 * 🔴 `ACCEPTED` NUNCA se anula: es la única vía por la que esas mismas apps acreditan «no se cobró» por cancelación.
 */
export function proyectarCancelDisposition(guardada: string | null | undefined, desenlace: TerminalPaymentDesenlace): string | null {
  if (guardada === 'ACTIVE' && desenlace.outcome !== 'UNRESOLVED') return null
  return guardada ?? null
}

/**
 * `status` tal como lo ve el cliente. Las apps publicadas sólo leen `status`, y leen FAILED/CANCELLED como
 * «no se cobró»: un desenlace UNRESOLVED con esos estados se muestra UNKNOWN.
 * 🔴 Una LÁPIDA (`FAILED` + `REJECTED_…`) NO se traduce: sale FAILED, que es justo lo que permite a esas apps
 * soltar su llave sabiendo que el cobro nunca se creó.
 */
export function proyectarStatus(row: FilaDeDesenlace, desenlace: TerminalPaymentDesenlace): TerminalPaymentRequestStatus {
  const traducible = row.status === TerminalPaymentRequestStatus.FAILED || row.status === TerminalPaymentRequestStatus.CANCELLED
  return traducible && desenlace.outcome === 'UNRESOLVED' ? TerminalPaymentRequestStatus.UNKNOWN : row.status
}

/** La fila que hace falta para proyectar el estado completo hacia el cliente. */
export interface FilaProyectable extends FilaDeDesenlace {
  requestId: string
  venueId: string
  terminalId: string
  amountCents: number
  tipCents: number
  orderId: string | null
  senderDevice: string | null
  lateResult: boolean
  createdAt: Date
  updatedAt: Date
}

/**
 * La proyección ÚNICA del estado de un cobro hacia cualquier cliente (GET móvil, POST cancel y MCP). Vive una sola
 * vez para que el POS y el operador no puedan leer dos verdades distintas de la misma fila.
 */
export function proyectarEstado(row: FilaProyectable): TerminalPaymentStatus {
  const desenlace = desenlaceCanonico(row)
  return {
    requestId: row.requestId,
    venueId: row.venueId,
    terminalId: row.terminalId,
    status: proyectarStatus(row, desenlace),
    amount: row.amountCents / 100,
    tip: row.tipCents / 100,
    orderId: row.orderId,
    paymentId: row.paymentId ?? null,
    senderDevice: row.senderDevice,
    lateResult: row.lateResult,
    cancelDisposition: proyectarCancelDisposition(row.cancelDisposition, desenlace),
    // Una lápida (`REJECTED_…`) sale FAILED y con su motivo: NO se traduce a UNKNOWN, sí prueba que no se creó.
    failureCode: row.failureCode ?? null,
    outcome: desenlace.outcome,
    outcomeEvidence: desenlace.outcomeEvidence,
    evidenceClass: desenlace.evidenceClass,
    ...(desenlace.reconciliationRequired ? { reconciliationRequired: true } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * What the cashier reads on the tablet when the terminal is busy (Android shows this string as-is).
 * "Ocupada" alone sent Testarudo into a reboot loop; the amount, the age and the sender let them
 * tell a live charge from an unresolved one without promising a blind release.
 */
function busyMessage(
  terminalId: string,
  blocker: { status: TerminalPaymentRequestStatus; amountCents: number; senderDevice: string | null; createdAt: Date } | null,
): string {
  if (!blocker) return `La terminal ${terminalId} está ocupada procesando otro cobro`
  const minutes = Math.max(0, Math.floor((Date.now() - blocker.createdAt.getTime()) / 60_000))
  const amount = `$${(blocker.amountCents / 100).toFixed(2)}`
  if (blocker.status === TerminalPaymentRequestStatus.UNKNOWN) {
    return `La terminal ${terminalId} está ocupada por un cobro de ${amount} que quedó sin respuesta hace ${minutes} min; confirma el resultado en la terminal antes de volver a cobrar`
  }
  const desde = blocker.senderDevice ? ` desde ${blocker.senderDevice}` : ''
  return `La terminal ${terminalId} está ocupada por un cobro de ${amount} enviado hace ${minutes} min${desde}`
}

/**
 * Codex R14-4: `FOR UPDATE NOWAIT` sobre una fila tomada por otra transacción ⇒ `lock_not_available` (55P03). Prisma lo entrega
 * como error de consulta cruda con `meta.code` o con el texto de Postgres («could not obtain lock on row»).
 */
function esFilaTomadaSinEsperar(error: unknown): boolean {
  const texto = error instanceof Error ? error.message : String(error)
  const codigo = (error as { meta?: { code?: unknown } } | null)?.meta?.code
  return codigo === '55P03' || /55P03|could not obtain lock/i.test(texto)
}

/** La proyección de un Payment con la que se juzga su procedencia (`procedenciaDelPagoDeSolicitud`). */
const SELECCION_DE_PROCEDENCIA = {
  processorData: true,
  amount: true,
  tipAmount: true,
  source: true,
  orderId: true,
  terminalPaymentRequestId: true,
  terminal: { select: { serialNumber: true } },
} as const

function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') ||
    (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002')
  )
}

function resultToStatus(status: TerminalPaymentResult['status']): TerminalPaymentRequestStatus {
  switch (status) {
    case 'success':
      return TerminalPaymentRequestStatus.COMPLETED
    case 'failed':
      return TerminalPaymentRequestStatus.FAILED
    case 'cancelled':
      return TerminalPaymentRequestStatus.CANCELLED
    case 'timeout':
    default:
      return TerminalPaymentRequestStatus.UNKNOWN
  }
}

/** Reconstruct a client-facing result from a stored row (for idempotent replay). */
function resultFromRow(row: {
  requestId: string
  status: TerminalPaymentRequestStatus
  paymentId: string | null
  resultJson: Prisma.JsonValue | null
  failureCode?: string | null
  cancelDisposition?: string | null
}): TerminalPaymentResult {
  // 🔴 La réplica y el GET clasifican con la MISMA función (§8 C.1): si divergieran, el mismo cobro diría una cosa
  // al reintentar el POST y otra al consultar su estado.
  const desenlace = desenlaceCanonico(row)
  const sobre =
    row.resultJson && typeof row.resultJson === 'object' && !Array.isArray(row.resultJson)
      ? (row.resultJson as Record<string, unknown>)
      : null

  // A committed Payment is authoritative even if an earlier socket cancellation
  // remains in the stored response envelope.
  if (desenlace.outcome === 'CHARGED') {
    return { ...(sobre ?? {}), requestId: row.requestId, status: 'success', paymentId: row.paymentId ?? undefined } as TerminalPaymentResult
  }
  // Sin desenlace acreditado la réplica NO puede decir «falló» ni «cancelado»: las apps leen los dos como finales y
  // sueltan su llave. Se conserva el texto guardado sólo si ya era un `timeout` (el mensaje concreto ayuda al cajero).
  if (desenlace.outcome === 'UNRESOLVED') {
    const mensaje =
      sobre?.status === 'timeout' && typeof sobre.errorMessage === 'string'
        ? sobre.errorMessage
        : 'Resultado pendiente de confirmar en la terminal'
    return { requestId: row.requestId, status: 'timeout', errorMessage: mensaje }
  }
  if (sobre) {
    return sobre as unknown as TerminalPaymentResult
  }
  switch (row.status) {
    case TerminalPaymentRequestStatus.FAILED:
      return { requestId: row.requestId, status: 'failed', errorMessage: 'El cobro falló' }
    case TerminalPaymentRequestStatus.CANCELLED:
      return { requestId: row.requestId, status: 'cancelled', errorMessage: 'Cancelado' }
    case TerminalPaymentRequestStatus.TIMED_OUT:
      return { requestId: row.requestId, status: 'timeout', errorMessage: 'La terminal no respondió a tiempo' }
    case TerminalPaymentRequestStatus.UNKNOWN:
    default:
      return { requestId: row.requestId, status: 'timeout', errorMessage: 'Resultado desconocido — verifica el estado en la terminal' }
  }
}

function validateReplayContract(
  row: {
    venueId: string
    terminalId: string
    amountCents: number
    tipCents: number
    orderId: string | null
    customerId?: string | null
    processedByStaffId?: string | null
    rating?: number | null
    skipReview?: boolean
  },
  request: TerminalPaymentRequest,
): void {
  const conflict =
    row.venueId !== request.venueId ||
    normalizeTerminalId(row.terminalId) !== normalizeTerminalId(request.terminalId) ||
    row.amountCents !== request.amountCents ||
    row.tipCents !== (request.tipCents ?? 0) ||
    row.orderId !== (request.orderId ?? null) ||
    (request.customerId !== undefined && row.customerId !== request.customerId) ||
    (request.processedByStaffId !== undefined && row.processedByStaffId !== request.processedByStaffId) ||
    (request.rating !== undefined && row.rating !== request.rating) ||
    (request.skipReview !== undefined && row.skipReview !== request.skipReview)
  if (conflict) throw new BadRequestError('Esta solicitud ya pertenece a otro cobro. Consulta el resultado original antes de continuar.')
}

/**
 * Transacción de admisión del cobro remoto: espera el candado de la terminal y el de la orden (otra admisión o un
 * registro de dinero en curso). Si no puede decidir en ese tiempo sale con 503 «reintenta con la misma solicitud»
 * (P2028/P2034), nunca con un 500 sin código.
 */
const ADMISSION_TX_TIMEOUT_MS = 15_000
const ADMISSION_TX_MAX_WAIT_MS = 5_000

/**
 * Motivos de rechazo de la ADMISIÓN que dejan lápida (H.5/H.6, 11-sep). El prefijo `REJECTED_` es lo que distingue una
 * lápida —prueba de «este cobro no se creó»— de cualquier otro FAILED. Ninguno está en `UNRESOLVED_FINANCIAL_OUTCOME`
 * ni en `SIN_DESENLACE_ACREDITADO`: una lápida no ocupa la terminal (FAILED no está en el índice parcial de la
 * ranura), no bloquea la orden, no la pregunta la sonda, no la barre el vigía, no la reentrega el replay, y el GET la
 * devuelve FAILED tal cual.
 */
type MotivoDeRechazo =
  | 'REJECTED_TERMINAL_NOT_CONNECTED'
  | 'REJECTED_TERMINAL_NO_SOCKET'
  | 'REJECTED_TERMINAL_OTHER_VENUE'
  | 'REJECTED_TERMINAL_BUSY'
  | 'REJECTED_ORDER_BUSY'
  | 'REJECTED_ORDER_CANCELLED'
  | 'REJECTED_ORDER_PAID'
  | 'REJECTED_ORDER_NOT_FOUND'

/** Lo que decide la transacción de admisión. El rechazo se DEVUELVE (no se lanza: el throw revertiría la lápida). */
type Admision =
  | { tipo: 'replica'; fila: FilaDeCobroRemoto }
  | { tipo: 'rechazada'; error: AppError }
  | { tipo: 'creada'; terminalEntry: NonNullable<ReturnType<typeof terminalRegistry.getTerminal>>; socketId: string }

/** ¿Es la lápida de un rechazo de admisión? Una fila FAILED cuyo `failureCode` empieza con `REJECTED_`. */
function esLapida(row: { status: TerminalPaymentRequestStatus; failureCode?: string | null }): boolean {
  return (
    row.status === TerminalPaymentRequestStatus.FAILED && typeof row.failureCode === 'string' && row.failureCode.startsWith('REJECTED_')
  )
}

/**
 * El `resultJson` de una lápida: la respuesta original (`httpStatus`, `code`, `message`, `details`) para reproducirla
 * idéntica. `status: 'failed'` + `errorMessage` lo dejan legible también para `resultFromRow` (respaldo: la réplica
 * normal NO pasa por ahí, lanza el mismo error).
 */
function respuestaDeLapida(requestId: string, error: AppError): Prisma.InputJsonObject {
  return {
    requestId,
    status: 'failed',
    errorMessage: error.message,
    httpStatus: error.statusCode,
    code: error.code ?? null,
    message: error.message,
    details: (error.details ?? null) as Prisma.InputJsonValue | null,
  }
}

/**
 * Reconstruye el MISMO rechazo desde la lápida: clase de error por el `failureCode` (columna tipada), y mensaje,
 * `details` y estado HTTP desde lo guardado. Si lo guardado no se puede leer, se reproduce igual con un texto genérico:
 * la fila sigue probando que el cobro no se creó.
 */
function errorDeLapida(row: { failureCode?: string | null; resultJson: Prisma.JsonValue | null }, requestId: string): AppError {
  const guardada =
    row.resultJson && typeof row.resultJson === 'object' && !Array.isArray(row.resultJson)
      ? (row.resultJson as Record<string, unknown>)
      : {}
  const detallesGuardados =
    guardada.details && typeof guardada.details === 'object' && !Array.isArray(guardada.details)
      ? (guardada.details as Record<string, unknown>)
      : {}
  const details = { ...detallesGuardados, requestId }
  const mensaje = (porDefecto: string) =>
    typeof guardada.message === 'string' && guardada.message.length > 0 ? guardada.message : porDefecto
  switch (row.failureCode as MotivoDeRechazo) {
    case 'REJECTED_TERMINAL_NOT_CONNECTED':
      return new TerminalUnavailableError(mensaje('La terminal no está conectada'), 404, 'TERMINAL_NOT_CONNECTED', details)
    case 'REJECTED_TERMINAL_NO_SOCKET':
      return new TerminalUnavailableError(
        mensaje('La terminal está registrada pero no tiene conexión de socket. Reinicia la app de la terminal.'),
        422,
        'TERMINAL_NO_SOCKET',
        details,
      )
    case 'REJECTED_TERMINAL_OTHER_VENUE':
      return new TerminalUnavailableError(mensaje('La terminal no pertenece a este establecimiento'), 403, 'TERMINAL_NOT_IN_VENUE', details)
    case 'REJECTED_TERMINAL_BUSY':
    case 'REJECTED_ORDER_BUSY': {
      const guardado = detallesGuardados.blockingRequest as Partial<TerminalBusyBlockingRequest> | undefined
      const blockingRequest: TerminalBusyBlockingRequest =
        guardado && typeof guardado === 'object' && typeof guardado.requestId === 'string'
          ? (guardado as TerminalBusyBlockingRequest)
          : { requestId: 'unknown', ageSeconds: 0 }
      return new TerminalBusyError(mensaje('La terminal está ocupada procesando otro cobro'), blockingRequest, requestId)
    }
    case 'REJECTED_ORDER_CANCELLED':
      return new BadRequestError(
        mensaje('La cuenta está cancelada: no se puede cobrar. Actualiza la lista de órdenes.'),
        'ORDER_CANCELLED_NO_NEW_CHARGE',
        details,
      )
    case 'REJECTED_ORDER_PAID':
      return new OrderAlreadyPaidError(mensaje('La cuenta ya está pagada por completo. Actualiza la lista de órdenes.'), details)
    case 'REJECTED_ORDER_NOT_FOUND':
      return new BadRequestError(
        mensaje('La cuenta no existe en este establecimiento. Actualiza la lista de órdenes.'),
        'ORDER_NOT_FOUND',
        details,
      )
    default: {
      // Un motivo que este código no conoce (lo escribió una versión más nueva): se reproduce lo guardado tal cual.
      const httpStatus = typeof guardada.httpStatus === 'number' ? guardada.httpStatus : 400
      return new AppError(
        mensaje('Este cobro no se creó.'),
        httpStatus,
        true,
        typeof guardada.code === 'string' ? guardada.code : undefined,
        details,
      )
    }
  }
}

/**
 * El cobro que ocupa, tal como se le describe al cajero (monto, antigüedad, aparato). Sin claves en `undefined`: el
 * mismo objeto se guarda en la lápida y la réplica lo devuelve idéntico. `null` = el que ocupa es de OTRO venue y no
 * se describe (ni monto ni aparato ajenos).
 */
function bloqueadorVisible(
  row: { requestId: string; amountCents: number; senderDevice: string | null; createdAt: Date } | null,
): TerminalBusyBlockingRequest {
  if (!row) return { requestId: 'unknown', ageSeconds: 0 }
  return {
    requestId: row.requestId,
    amountCents: row.amountCents,
    ...(row.senderDevice ? { senderDevice: row.senderDevice } : {}),
    ageSeconds: Math.max(0, Math.floor((Date.now() - row.createdAt.getTime()) / 1000)),
  }
}

/** P2028 (tiempo agotado / transacción cerrada) o P2034 (conflicto o deadlock): la admisión no pudo decidir. */
function esContencionDeTransaccion(err: unknown): boolean {
  const code =
    err instanceof Prisma.PrismaClientKnownRequestError
      ? err.code
      : typeof err === 'object' && err !== null
        ? (err as { code?: unknown }).code
        : undefined
  return code === 'P2028' || code === 'P2034'
}

/** `details.requestId` sólo con llave del cliente: sin ella no hay nada durable que lo respalde. */
function detallesDelCliente(idDelCliente: string | null): { requestId: string } | undefined {
  return idDelCliente ? { requestId: idDelCliente } : undefined
}

/** S0 (Codex, 13-sep-2026): el veredicto del ARBITRAJE de un registro que dice pertenecer a una solicitud POS→terminal. */
export type FilaArbitrada = {
  requestId: string
  status: TerminalPaymentRequestStatus
  orderId: string | null
  amountCents: number
  tipCents: number
}
export type ArbitrajeDeRegistro =
  | { kind: 'NO_REQUEST' }
  | {
      kind: 'INVALID_ASSOCIATION'
      reason: 'NO_TERMINAL_IDENTITY' | 'TERMINAL_MISMATCH' | 'ORDER_MISMATCH' | 'ATTEMPT_LINKED_ELSEWHERE'
    }
  | { kind: 'WINNER'; row: FilaArbitrada }
  | { kind: 'RETRY_OF_WINNER'; winnerPaymentId: string }
  | { kind: 'SECOND_CAPTURE'; winnerPaymentId: string; winnerOrderId: string; winnerIdempotencyKey: string | null; row: FilaArbitrada }

/** S0: lo que `closeRowFromPaymentTx` hizo de verdad. «No lanzó» ≠ ligó. */
export type CloseRowOutcome =
  | {
      bound: true
      reopened: boolean
      contractMismatch: boolean
      /** El estado de la fila ANTES de ligar el Payment. */
      previousStatus: TerminalPaymentRequestStatus
      /** EXACTAMENTE la condición de la alarma 🚨 de abajo (`reopened || CANCEL_REQUESTED`): dinero sobre una fila que ya dábamos por cerrada o en cancelación. */
      alarmed: boolean
    }
  | {
      bound: false
      reason:
        | 'NO_REQUEST'
        | 'ALREADY_BOUND'
        | 'PAYMENT_NOT_ELIGIBLE'
        | 'PAYMENT_BOUND_ELSEWHERE'
        | 'PAYMENT_TAGGED_FOR_ANOTHER_REQUEST'
        | 'NO_TERMINAL_IDENTITY'
        | 'TERMINAL_MISMATCH'
        | 'SOCKET_ATTRIBUTION_MISMATCH'
        | 'ERROR'
    }

/**
 * S1 (checkpoint 1 del webhook como primer confirmador, Codex 13-sep-2026): veredicto del vínculo intento → solicitud
 * que anuncia la terminal. Viaja ENTERO en el ack del socket — un booleano no le diría a la terminal si puede ejecutar.
 *  · `LINKED`          intento nuevo sobre una solicitud con la ranura retenida (en vuelo o UNKNOWN);
 *  · `ALREADY_LINKED`  el mismo vínculo repetido (idempotente, aunque la solicitud ya haya terminado);
 *  · `LATE_EVIDENCE`   intento nuevo sobre una solicitud ya cerrada: se guarda como evidencia para correlacionar un
 *                      webhook o una consulta por intento, pero `executionAuthorized: false` — no autoriza el SDK.
 *  `reason: 'ERROR'` sólo lo pone el cableado del socket cuando el handler revienta; el servicio nunca lo devuelve.
 */
export type AttemptLinkAck =
  | {
      success: true
      outcome: 'LINKED' | 'ALREADY_LINKED' | 'LATE_EVIDENCE'
      requestStatus: TerminalPaymentRequestStatus
      executionAuthorized: boolean
    }
  | { success: false; reason: 'INVALID' | 'NOT_OWNER' | 'ATTEMPT_OWNED_BY_OTHER_REQUEST' | 'ERROR' }

class TerminalPaymentService {
  private unknownCursor: { createdAt: Date; id: string } | null = null
  private pendingPayments = new Map<string, PendingPayment>()
  /** requestId → cuándo la terminal contestó a la sonda SIN evidencia acreditada (throttle del re-sondeo). */
  private unaccreditedProbeAnswers = new Map<string, number>()
  /** Asientos de anomalías ya escritos en ESTE proceso (`acción:fila`). Atajo: la bitácora es la verdad entre reinicios. */
  private anomaliasAuditadas = new Set<string>()
  private pendingReceiptPrints = new Map<string, PendingReceiptPrint>()
  private pendingRefundRequests = new Map<string, PendingRefundRequest>()

  /** Best-effort busy flag for the terminal picker (authoritative gate is the send itself). */
  async isTerminalBusy(terminalId: string, venueId: string): Promise<boolean> {
    const lockKey = normalizeTerminalId(terminalId)
    const active = await prisma.terminalPaymentRequest.findFirst({
      where: { terminalId: lockKey, venueId, ...predicadoDeBloqueo(getVenuesEstrictos()) },
      select: { id: true },
    })
    return active !== null
  }

  /** Normalized terminalIds that currently hold a slot (batch for the picker). */
  async getBusyTerminalIds(venueId: string, candidateTerminalIds: readonly string[]): Promise<Set<string>> {
    void venueId // los candidatos ya llegan acotados al venue por el picker; ver el porqué abajo.
    const candidates = [...new Set(candidateTerminalIds.map(normalizeTerminalId))]
    const busy = new Set<string>()
    // The legacy picker remains complete. Aggregate only its live candidates in
    // sequential batches; historical duplicates never cross the database boundary.
    // 🔴 SIN filtro de venue a propósito: la reserva es FÍSICA, del aparato. Una terminal que
    // cambió de sucursal con un cobro sin resolver en la anterior se anunciaba LIBRE en la nueva
    // —la admisión sí la bloqueaba, pero el picker la ofrecía—, y ofrecerla es mandarle un
    // segundo cobro al mismo aparato. Los candidatos ya vienen acotados al venue por quien
    // llama, y esto devuelve SÓLO el conjunto de ocupados: ningún dato financiero ajeno sale.
    for (let offset = 0; offset < candidates.length; offset += 100) {
      const rows = await prisma.terminalPaymentRequest.groupBy({
        by: ['terminalId'],
        where: { terminalId: { in: candidates.slice(offset, offset + 100) }, ...predicadoDeBloqueo(getVenuesEstrictos()) },
        orderBy: { terminalId: 'asc' },
        take: 100,
      })
      for (const row of rows) busy.add(row.terminalId)
    }
    return busy
  }

  /**
   * Send a payment request to a terminal and wait for the result.
   * Returns a Promise that resolves when the terminal responds or times out.
   *
   * 🔴 Admisión (H.5/H.6, 11-sep): la réplica, la terminal (registro, venue, socket), la ranura y la orden se deciden
   * TODAS bajo el candado de la terminal. Todo rechazo que el POS pueda leer como «este cobro no se creó» deja, en la
   * MISMA transacción, una LÁPIDA para su `requestId` (FAILED, `failureCode` `REJECTED_…`, sin entregas, vencida) y el
   * error se lanza DESPUÉS del commit. Una copia posterior del MISMO POST (reintento de transporte, duplicado, entrega
   * tardía de un proxy) encuentra la lápida y repite el mismo rechazo: ya no crea ni entrega un cobro que la tablet dio
   * por no enviado (y que el cajero ya cobró de otra forma). Sin `requestId` del cliente no hay lápida: nadie podría
   * reproducirla.
   */
  async sendPaymentToTerminal(request: TerminalPaymentRequest): Promise<TerminalPaymentResult> {
    const { terminalId, venueId } = request

    // NOTE: a registry socketId can be STALE (terminal dropped ungracefully; the HTTP
    // heartbeat preserves the old id — terminal-registry.ts). The emit below is
    // fire-and-forget, so a dead socket silently no-ops → the POS hangs the full 5 min →
    // watchdog parks the row UNKNOWN → the terminal is stuck-busy until manual reconcile.
    // The real fix is emit-with-ack + timeout (covers BOTH a fully-gone socket and a
    // half-open zombie), version-gated per the arbitration spec — deliberately NOT a
    // pre-INSERT liveness probe, which misses the half-open case we actually observe.

    // Use client-provided requestId if available, otherwise generate one
    const requestId = request.requestId || uuidv4()
    // La lápida sólo tiene sentido con la llave del CLIENTE: es la que traerá una copia posterior del mismo POST.
    const idDelCliente = request.requestId ? requestId : null
    // La MISMA normalización con la que el registro guarda sus entradas (`terminal-registry.ts`): candado, lápida y
    // fila quedan en la misma llave aunque la terminal no esté registrada.
    const lockKey = normalizeTerminalId(terminalId)

    // Acquire the durable per-terminal slot by INSERTing the row. The partial
    // UNIQUE index on terminalId (active statuses) is the mutex: a concurrent
    // second active charge fails with P2002 — correct across restarts and
    // multiple server instances, no in-memory lock needed.
    const persisted = true
    const reserve = async (tx: Prisma.TransactionClient): Promise<Admision> => {
      // Physical admission includes historical unresolved rows outside the partial UNIQUE index.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`
      const existing = await tx.terminalPaymentRequest.findFirst({ where: { requestId, venueId } })
      if (existing) return { tipo: 'replica', fila: existing }

      const detalles = idDelCliente ? { requestId: idDelCliente } : undefined
      /** El rechazo se DEVUELVE (no se lanza: el throw revertiría la lápida) y se lanza después del commit. */
      const rechazar = async (motivo: MotivoDeRechazo, error: AppError): Promise<Admision> => {
        if (idDelCliente) {
          await tx.terminalPaymentRequest.create({
            data: {
              requestId: idDelCliente,
              venueId,
              terminalId: lockKey,
              status: TerminalPaymentRequestStatus.FAILED,
              failureCode: motivo,
              amountCents: request.amountCents,
              tipCents: request.tipCents ?? 0,
              orderId: request.orderId ?? null,
              requestedById: request.requestedBy ?? null,
              senderDevice: request.senderDeviceName ?? null,
              customerId: request.customerId ?? null,
              processedByStaffId: request.processedByStaffId ?? null,
              rating: request.rating ?? null,
              skipReview: request.skipReview ?? true,
              // Vencida desde que nace y sin entregas: nadie la espera, nadie la reentrega y la sonda no la pregunta.
              expiresAt: new Date(),
              deliveryProvenance: { deliveries: [] },
              resultJson: respuestaDeLapida(idDelCliente, error),
            },
          })
        }
        logger.warn(`🪦 [TerminalPayment] Admission rejected${idDelCliente ? ' — tombstone written' : ''}`, {
          requestId,
          terminalId: lockKey,
          venueId,
          motivo,
        })
        return { tipo: 'rechazada', error }
      }

      // 🔴 La terminal se revisa AQUÍ, bajo el candado y después de la réplica (H.5). Antes se revisaba fuera y antes
      // de buscar la fila: un «no está conectada» sin rastro dejaba pasar una copia posterior del mismo POST.
      const terminalEntry = terminalRegistry.getTerminal(terminalId)
      if (!terminalEntry) {
        logger.error(`❌ [TerminalPayment] Terminal not found in registry`, {
          terminalId,
          registeredTerminals: terminalRegistry.getAllTerminalIds(),
        })
        return rechazar(
          'REJECTED_TERMINAL_NOT_CONNECTED',
          new TerminalUnavailableError(`La terminal ${terminalId} no está conectada`, 404, 'TERMINAL_NOT_CONNECTED', detalles),
        )
      }
      if (terminalEntry.venueId !== venueId) {
        // Nunca se le habla a la terminal de otro negocio (antes lo cortaba el controlador, sin lápida).
        return rechazar(
          'REJECTED_TERMINAL_OTHER_VENUE',
          new TerminalUnavailableError('La terminal no pertenece a este establecimiento', 403, 'TERMINAL_NOT_IN_VENUE', detalles),
        )
      }
      const socketId = terminalEntry.socketId
      if (!socketId) {
        return rechazar(
          'REJECTED_TERMINAL_NO_SOCKET',
          new TerminalUnavailableError(
            `La terminal ${terminalId} está registrada pero no tiene conexión de socket. Reinicia la app de la terminal.`,
            422,
            'TERMINAL_NO_SOCKET',
            detalles,
          ),
        )
      }

      const terminalBlocker = await tx.terminalPaymentRequest.findFirst({
        where: { terminalId: lockKey, ...predicadoDeBloqueo(getVenuesEstrictos()) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      if (terminalBlocker) {
        const visible = terminalBlocker.venueId === venueId ? terminalBlocker : null
        return rechazar(
          'REJECTED_TERMINAL_BUSY',
          new TerminalBusyError(busyMessage(terminalId, visible), bloqueadorVisible(visible), idDelCliente ?? undefined),
        )
      }
      if (request.orderId) {
        // All requests for a sale serialize here, even on different terminals.
        // The order lock is also used by payment settlement.
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${request.orderId} AND "venueId" = ${venueId} FOR UPDATE`
        const mine = await tx.terminalPaymentRequest.findFirst({ where: { requestId, venueId } })
        if (mine) return { tipo: 'replica', fila: mine }
        const order = await tx.order.findFirst({
          where: { id: request.orderId, venueId },
          select: { paymentStatus: true, orderNumber: true, status: true },
        })
        if (!order) {
          return rechazar(
            'REJECTED_ORDER_NOT_FOUND',
            new BadRequestError('La cuenta no existe en este establecimiento. Actualiza la lista de órdenes.', 'ORDER_NOT_FOUND', detalles),
          )
        }
        // Codex 11-sep (409, P1): bajo el MISMO lock que `cancelOrder`, una orden cancelada no admite una autorización
        // NUEVA. (Registrar una aprobación bancaria que YA ocurrió es otro camino y no se toca: ese dinero se registra.)
        if (order.status === 'CANCELLED' || order.status === 'DELETED') {
          // Con código y `requestId`: el servidor PRUEBA que este cobro no se creó (va después de la réplica y bajo el lock),
          // así que el POS puede soltar su llave en vez de leer un 400 ambiguo.
          return rechazar(
            'REJECTED_ORDER_CANCELLED',
            new BadRequestError(
              `La cuenta ${order.orderNumber ?? request.orderId} está cancelada: no se puede cobrar. Actualiza la lista de órdenes.`,
              'ORDER_CANCELLED_NO_NEW_CHARGE',
              detalles,
            ),
          )
        }
        if (order.paymentStatus === 'PAID') {
          return rechazar(
            'REJECTED_ORDER_PAID',
            new OrderAlreadyPaidError(
              `La cuenta ${order.orderNumber ?? request.orderId} ya está pagada por completo. Actualiza la lista de órdenes.`,
              detalles,
            ),
          )
        }
        const blocker = await tx.terminalPaymentRequest.findFirst({
          where: {
            venueId,
            orderId: request.orderId,
            // 🔴 La ORDEN se juzga SIEMPRE con la lista blanca estricta, apagado el interruptor o no (decisión del
            // founder, 11-sep, tras la auditoría de Codex). El interruptor existe para destrabar APARATOS, no para
            // permitir un segundo cobro de la MISMA venta: el riesgo de que el primero sí haya cobrado no caduca.
            ...UNRESOLVED_FINANCIAL_OUTCOME,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        })
        if (blocker) {
          return rechazar(
            'REJECTED_ORDER_BUSY',
            new TerminalBusyError(
              'Esta venta tiene un cobro pendiente de confirmar. Consulta su resultado antes de volver a pasar la tarjeta.',
              bloqueadorVisible(blocker),
              idDelCliente ?? undefined,
            ),
          )
        }
      } else {
        // 🔴 EL RODEO DEL PAGO RÁPIDO (P1-2 de la auditoría de Codex, 11-sep). El candado de arriba sólo corre
        // `if (request.orderId)`: un cobro SIN orden no pasa por él. Así que la venta cuya cuenta quedó protegida
        // se puede volver a cobrar tecleando el monto a mano en la misma terminal.
        //
        // ⚠️ ALCANCE REAL, medido en producción el 11-sep (auditoría de Fable, P2-1): este camino —un cobro
        // REMOTO sin `orderId`— tiene **1 sola fila en toda la historia** contra 1477 con orden en 30 días. La
        // tablet siempre manda la cuenta. O sea que esto NO cierra el recobro realista, que es el **Pago rápido
        // LOCAL de la propia terminal**: ése no pasa por esta admisión ni por ningún candado del servidor, y
        // sigue siendo la decisión de producto pendiente («registro como Tarjeta (otra terminal)», relevo §8).
        // Este rastro cubre el camino remoto, que es el único que el servidor puede ver.
        //
        // NO se rechaza, y la razón importa: el servidor no puede distinguir «es la misma venta otra vez» de «es
        // una venta nueva legítima» — el cobro rápido no trae identidad. Rechazarlo volvería a trabar el aparato,
        // que es exactamente lo que el interruptor viene a evitar, y dejaría al cajero sin poder cobrarle al
        // siguiente cliente. Lo que sí se puede es dejar CONSTANCIA: quien concilie verá que sobre esa terminal
        // entró un cobro sin identidad mientras otro seguía sin desenlace, y podrá cruzar importes.
        //
        // Exige una acción deliberada del cajero (el sistema ya le dijo que la cuenta estaba bloqueada), así que
        // el rastro es la respuesta proporcionada; cerrarlo de verdad pide identidad en el cobro rápido.
        const sinIdentidad = await tx.terminalPaymentRequest.findFirst({
          where: { terminalId: lockKey, venueId, orderId: { not: null }, ...UNRESOLVED_FINANCIAL_OUTCOME },
          select: { requestId: true, orderId: true, amountCents: true, createdAt: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        })
        if (sinIdentidad) {
          // 🚨 token estable para la regla de Better Stack — NO renombrar.
          logger.error(
            '🚨 [Terminal-payment] Cobro SIN orden admitido en una terminal con una venta sin desenlace — posible recobro de la misma venta',
            {
              requestId,
              venueId,
              terminalId: lockKey,
              amountCents: request.amountCents,
              bloqueadorSinDesenlace: sinIdentidad.requestId,
              ordenDelBloqueador: sinIdentidad.orderId,
              montoDelBloqueador: sinIdentidad.amountCents,
              desde: sinIdentidad.createdAt.toISOString(),
            },
          )
        }
      }
      await tx.terminalPaymentRequest.create({
        data: {
          requestId,
          venueId,
          terminalId: lockKey,
          status: TerminalPaymentRequestStatus.PENDING,
          amountCents: request.amountCents,
          tipCents: request.tipCents ?? 0,
          orderId: request.orderId ?? null,
          requestedById: request.requestedBy ?? null,
          senderDevice: request.senderDeviceName ?? null,
          // El cliente de la venta viaja AQUÍ (no por el socket): es de donde
          // `recordFastPayment` lo recoge cuando la TPV registra el cobro.
          customerId: request.customerId ?? null,
          processedByStaffId: request.processedByStaffId ?? null,
          rating: request.rating ?? null,
          skipReview: request.skipReview ?? true,
          expiresAt: new Date(Date.now() + PAYMENT_TIMEOUT_MS),
          // `[]` = creada y todavía no entregada a ningún socket (distinto de `null` = procedencia desconocida).
          deliveryProvenance: { deliveries: [] },
        },
      })
      return { tipo: 'creada', terminalEntry, socketId }
    }

    const admitir = async (): Promise<Admision> => {
      for (let intento = 1; ; intento++) {
        try {
          return await prisma.$transaction(reserve, { timeout: ADMISSION_TX_TIMEOUT_MS, maxWait: ADMISSION_TX_MAX_WAIT_MS })
        } catch (err) {
          if (esContencionDeTransaccion(err)) {
            // No se sabe si la transacción alcanzó a confirmar: «reintenta con la MISMA solicitud», nunca «no se creó».
            logger.warn(
              `⏳ [TerminalPayment] Admission could not decide (transaction contention/timeout) — retry with the same requestId`,
              {
                requestId,
                terminalId: lockKey,
                venueId,
                error: err instanceof Error ? err.message : String(err),
              },
            )
            throw new TerminalPaymentAdmissionRetryError(detallesDelCliente(idDelCliente))
          }
          if (!isPrismaUniqueViolation(err)) throw err
          // Disambiguate WITHOUT parsing meta.target: look up MY requestId.
          // - my row exists  → another copy of this requestId won (its charge or its tombstone) → replay it
          // - my row absent  → the terminal slot is held by ANOTHER request the admission did not see
          const mine = await prisma.terminalPaymentRequest.findFirst({ where: { requestId, venueId } })
          if (mine) return { tipo: 'replica', fila: mine }
          if (!idDelCliente) return { tipo: 'rechazada', error: await this.busyTrasChoqueDeRanura(terminalId, lockKey, venueId, requestId) }
          // Con llave del cliente, un «no se creó» exige lápida: se re-decide UNA vez bajo el candado (verá a quien ocupa
          // la ranura ⇒ lápida + ocupada). Si aun así no se puede, se dice «todavía no se sabe», nunca «no se creó».
          if (intento >= 2) {
            logger.error(
              `❌ [TerminalPayment] Admission kept colliding without a visible holder — answering «retry», never «not created»`,
              {
                requestId,
                terminalId: lockKey,
                venueId,
              },
            )
            throw new TerminalPaymentAdmissionRetryError(detallesDelCliente(idDelCliente))
          }
        }
      }
    }

    const admision = await admitir()
    if (admision.tipo === 'replica') {
      validateReplayContract(admision.fila, request)
      if (esLapida(admision.fila)) {
        // La MISMA solicitud repite el MISMO rechazo (clase, código, mensaje y `details`), aunque el mundo haya cambiado.
        logger.info(`🪦 [TerminalPayment] Replaying the admission rejection stored for requestId`, {
          requestId,
          failureCode: admision.fila.failureCode,
        })
        throw errorDeLapida(admision.fila, requestId)
      }
      // Terminal (or UNKNOWN) state → idempotent replay of the stored outcome
      logger.info(`♻️ [TerminalPayment] Idempotent replay for requestId`, { requestId, status: admision.fila.status })
      return resultFromRow(admision.fila)
    }
    if (admision.tipo === 'rechazada') throw admision.error
    const { terminalEntry, socketId } = admision

    logger.info(`💳 [TerminalPayment] Sending payment request to terminal`, {
      requestId,
      terminalId,
      venueId,
      amountCents: request.amountCents,
      tipCents: request.tipCents,
      orderId: request.orderId,
      persisted,
    })

    const io = socketManager.getServer()
    if (!io) {
      // Never leak the slot if we bail before storing the pending payment.
      if (persisted)
        await this.closeRow(requestId, venueId, {
          requestId,
          status: 'failed',
          outcomeEvidence: 'PRE_AUTHORIZATION',
          errorMessage: 'Servidor no inicializado',
        })
      throw new Error('Servidor de Socket.IO no inicializado')
    }

    return new Promise<TerminalPaymentResult>((resolve, reject) => {
      // The in-memory timeout only resolves the long-poll (POS gets 'timeout').
      // It does NOT close the DB row — the charge may still have happened, so
      // the watchdog owns the row's fate (reconcile vs Payment, else UNKNOWN).
      const timeout = setTimeout(() => {
        if (!this.pendingPayments.has(requestId)) return
        this.pendingPayments.delete(requestId)
        // S5: antes de contestar «timeout», la FILA manda. El webhook pudo cerrarla desde otra instancia, o el aviso
        // en memoria perderse: contestar timeout con el Payment ya escrito manda al POS a consultar (o a un 504) por
        // un cobro que ya consta. Si la lectura falla, se contesta como siempre: incierto, nunca «no se cobró».
        void this.desenlaceDurableAlVencer(requestId, venueId).then(durable => {
          if (durable) {
            logger.info(`🔁 [TerminalPayment] Long-poll resolved from durable state at timeout`, {
              requestId,
              terminalId,
              paymentId: durable.paymentId,
            })
            resolve(durable)
            return
          }
          logger.warn(`⏰ [TerminalPayment] Long-poll timed out (row left for watchdog)`, { requestId, terminalId })
          resolve({
            requestId,
            status: 'timeout',
            errorMessage: 'La terminal no respondió en 5 minutos',
          })
        })
      }, longPollMs())

      this.pendingPayments.set(requestId, {
        resolve,
        reject,
        timeout,
        requestId,
        terminalId,
        venueId,
        createdAt: new Date(),
      })

      // 🔴 `customerId` NO va aquí, a propósito: la TPV no lo consume y sería PII enviada
      // al aparato sin ningún uso. El cliente vive en la fila de arbitraje, que el server
      // relee al registrar el cobro. Guardarraíl en
      // `tests/unit/services/terminal-payment.service.test.ts`.
      const paymentPayload = {
        requestId,
        terminalId,
        amountCents: request.amountCents,
        tipCents: request.tipCents ?? 0,
        rating: request.rating,
        skipReview: request.skipReview ?? true,
        orderId: request.orderId,
        senderDeviceName: request.senderDeviceName,
        processedByStaffId: request.processedByStaffId,
        venueId,
        timestamp: new Date().toISOString(),
        attemptLinkVersion: TERMINAL_ATTEMPT_LINK_VERSION,
      }

      const directSocket = io.sockets.sockets.get(socketId)
      if (!directSocket) {
        clearTimeout(timeout)
        this.pendingPayments.delete(requestId)
        // 🔴 La entrega es INCIERTA, no un rechazo. El socket capturado pudo perderse DESPUÉS
        // de que la terminal recibiera y ejecutara el cobro (reconexión, reemplazo, o un replay
        // que ya entregó por otra vía). Un `BadRequestError` sale como HTTP 400, y para un POS
        // publicado eso significa «rechazado»: le da permiso para volver a pasar la tarjeta —
        // el doble cobro exacto que este carril existe para evitar.
        // Se responde con el MISMO desenlace canónico que el ACK perdido (HTTP 504 en los
        // clientes ya publicados) y la fila queda RETENIDA en UNKNOWN por `failUndelivered`;
        // se resuelve DESPUÉS de esa escritura, para no contestar «incierto» sobre una fila
        // que todavía dice PENDING.
        const inciertoPorSocketPerdido: TerminalPaymentResult = {
          requestId,
          status: 'timeout',
          errorMessage: 'No pudimos confirmar el cobro. Consulta su estado antes de volver a pasar la tarjeta.',
        }
        const retenerIncierto = persisted ? this.failUndelivered(requestId, venueId, 'SOCKET_NOT_FOUND') : Promise.resolve()
        void retenerIncierto
          .catch(err => {
            // PENDING sigue siendo una obligación durable protegida si esta escritura falla.
            logger.error('❌ [TerminalPayment] Could not persist lost-socket delivery outcome', { requestId, error: String(err) })
          })
          .then(() => resolve(inciertoPorSocketPerdido))
        return
      }

      const legacy = (terminalEntry.terminalPaymentAckVersion ?? 0) < 1
      const entregar = async () => {
        // 🔴 Procedencia durable ANTES de emitir (Codex 11-sep): protocolo, capacidades e identidad del socket, por
        // solicitud. Si no se puede escribir, NO se emite: una entrega sin rastro volvería a ser «nunca recibida»
        // para la sonda y liberaría a ciegas.
        const grabada = await this.recordDelivery(requestId, venueId, terminalEntry, socketId, false)
        if (!grabada) {
          if (!this.pendingPayments.has(requestId)) return
          clearTimeout(timeout)
          this.pendingPayments.delete(requestId)
          const incierto: TerminalPaymentResult = {
            requestId,
            status: 'timeout',
            errorMessage: 'No pudimos confirmar el cobro. Consulta su estado antes de volver a pasar la tarjeta.',
          }
          await this.failUndelivered(requestId, venueId, 'DELIVERY_NOT_RECORDED').catch(err => {
            logger.error('❌ [TerminalPayment] Could not retain the unrecorded delivery as uncertain', { requestId, error: String(err) })
          })
          resolve(incierto)
          return
        }
        if (legacy) {
          // Compatibilidad backend-first: APKs publicadas aún no conocen el ACK ni tienen inbox durable. Se entrega
          // una sola vez; la procedencia LEGACY (y `lastDeliveredAt` sin ACK) ya quedó escrita arriba.
          directSocket.emit('terminal:payment_request', paymentPayload)
          logger.info(`📡 [TerminalPayment] Emitted once to legacy socket ${socketId}`, { requestId, terminalId })
          return
        }
        directSocket
          .timeout(PAYMENT_DELIVERY_ACK_TIMEOUT_MS)
          .emit(
            'terminal:payment_request',
            paymentPayload,
            (error: Error | null, response?: { accepted?: boolean; requestId?: string }) => {
              const stillPending = this.pendingPayments.has(requestId)
              if (error || response?.accepted !== true || response.requestId !== requestId) {
                if (!stillPending) return
                clearTimeout(timeout)
                this.pendingPayments.delete(requestId)
                // The terminal may have persisted and executed the command before its ACK
                // was lost. Resolve as timeout (HTTP 504 for released POS clients), never
                // as a rejection that grants permission to authorize another charge.
                const result: TerminalPaymentResult = {
                  requestId,
                  status: 'timeout',
                  errorMessage: 'No pudimos confirmar el cobro. Consulta su estado antes de volver a pasar la tarjeta.',
                }
                const persistUnknown = persisted
                  ? prisma.terminalPaymentRequest.updateMany({
                      where: { requestId, venueId, status: TerminalPaymentRequestStatus.PENDING },
                      data: {
                        status: TerminalPaymentRequestStatus.UNKNOWN,
                        failureCode: error ? 'ACK_TIMEOUT' : 'ACK_REJECTED',
                      },
                    })
                  : Promise.resolve()
                void persistUnknown
                  .catch(err => {
                    // PENDING remains a durable, protected obligation if this write fails.
                    logger.error('❌ [TerminalPayment] Could not persist unknown delivery outcome', { requestId, error: String(err) })
                  })
                  .then(() => resolve(result))
                return
              }

              if (persisted) void this.markDelivered(requestId, venueId)
              logger.info(`📡 [TerminalPayment] Durable ACK received from socket ${socketId}`, { requestId, terminalId })
            },
          )
      }
      void entregar().catch(err => {
        logger.error('❌ [TerminalPayment] Delivery aborted before emit', { requestId, error: String(err) })
        if (!this.pendingPayments.has(requestId)) return
        clearTimeout(timeout)
        this.pendingPayments.delete(requestId)
        resolve({
          requestId,
          status: 'timeout',
          errorMessage: 'No pudimos confirmar el cobro. Consulta su estado antes de volver a pasar la tarjeta.',
        })
      })
    })
  }

  /**
   * Choque del índice de la ranura SIN `requestId` del cliente (legado): la ranura la tiene OTRA solicitud que la
   * admisión no vio bajo el candado. Sin llave del cliente no hay lápida posible (nadie podría reproducirla), así que
   * se contesta como siempre. Acotado al venue: la ranura es GLOBAL por terminal, y el cobro de otro venue (terminal
   * migrada) no se le describe al cajero de éste (`busyMessage` queda genérico).
   */
  private async busyTrasChoqueDeRanura(
    terminalId: string,
    lockKey: string,
    venueId: string,
    requestId: string,
  ): Promise<TerminalBusyError> {
    const blocker = await prisma.terminalPaymentRequest.findFirst({
      where: { terminalId: lockKey, venueId, ...predicadoDeBloqueo(getVenuesEstrictos()) },
      orderBy: { createdAt: 'desc' },
    })
    if (!blocker) {
      logger.warn(`🔒 [TerminalPayment] Slot held by a request of ANOTHER venue (migrated terminal?)`, { lockKey, venueId })
    }
    logger.warn(`🔒 [TerminalPayment] Terminal busy, rejecting`, {
      lockKey,
      blockerRequestId: blocker?.requestId,
      incomingRequestId: requestId,
    })
    return new TerminalBusyError(busyMessage(terminalId, blocker), bloqueadorVisible(blocker))
  }

  /**
   * ¿Hay que escribir el asiento de esta anomalía de esta fila? `true` sólo la PRIMERA vez: ni en este proceso ni en la
   * bitácora. La marca se pone ANTES de consultar (dos llamadas concurrentes no escriben dos asientos) y se retira si la
   * consulta falla (si no, la fila perdería su única auditoría en este proceso). El filtro por `entity` usa el índice
   * `[entity, entityId]` de ActivityLog. Una sola regla para las cuatro anomalías (replay, dos de sonda, contradicción).
   */
  private async debeAuditar(action: string, rowId: string): Promise<boolean> {
    const clave = `${action}:${rowId}`
    if (this.anomaliasAuditadas.has(clave)) return false
    if (this.anomaliasAuditadas.size >= 10_000) this.anomaliasAuditadas.clear()
    this.anomaliasAuditadas.add(clave)
    try {
      return !(await prisma.activityLog.findFirst({
        where: { action, entity: 'TerminalPaymentRequest', entityId: rowId },
        select: { id: true },
      }))
    } catch (err) {
      this.anomaliasAuditadas.delete(clave)
      throw err
    }
  }

  /** Deja una fila sin re-sondear durante `PROBE_UNACCREDITED_BACKOFF_MS`: la misma respuesta no produce evidencia nueva. */
  private marcarEsperaDeSonda(requestId: string): void {
    if (this.unaccreditedProbeAnswers.size >= 10_000 && !this.unaccreditedProbeAnswers.has(requestId)) this.unaccreditedProbeAnswers.clear()
    this.unaccreditedProbeAnswers.set(requestId, Date.now())
  }

  private async auditReplaySkip(rowId: string, requestId: string, venueId: string, terminalId: string, reason: string): Promise<void> {
    if (!(await this.debeAuditar('TERMINAL_PAYMENT_REPLAY_SKIPPED', rowId))) return
    logger.warn('🔎 [TerminalPayment] Replay skipped: provenance does not allow re-delivery (operator)', { requestId, terminalId, reason })
    void logAction({
      venueId,
      action: 'TERMINAL_PAYMENT_REPLAY_SKIPPED',
      entity: 'TerminalPaymentRequest',
      entityId: rowId,
      data: { requestId, terminalId, reason },
    })
  }

  /**
   * Escribe la procedencia de UNA entrega de forma atómica (append en jsonb) y devuelve si la fila estaba en un
   * estado entregable. En el camino LEGACY deja además `lastDeliveredAt` sin `acknowledgedAt` (firma de «entregada
   * sin acuse»). Nunca lanza: un error se registra y se trata como «no grabada».
   */
  private async recordDelivery(
    requestId: string,
    venueId: string,
    entry: { terminalPaymentAckVersion?: number; terminalPaymentCancelDispositionVersion?: number; terminalPaymentProbeVersion?: number },
    socketId: string,
    replay: boolean,
  ): Promise<boolean> {
    const ackVersion = entry.terminalPaymentAckVersion ?? 0
    const record: TerminalDeliveryRecord = {
      protocol: ackVersion < 1 ? 'LEGACY' : 'DURABLE',
      ackVersion,
      cancelDispositionVersion: entry.terminalPaymentCancelDispositionVersion ?? 0,
      probeVersion: entry.terminalPaymentProbeVersion ?? 0,
      socketId,
      at: new Date().toISOString(),
      replay,
    }
    try {
      const count = await prisma.$executeRaw`
        UPDATE "TerminalPaymentRequest"
           SET "deliveryProvenance" = jsonb_build_object('deliveries', COALESCE("deliveryProvenance"->'deliveries', '[]'::jsonb) || ${JSON.stringify([record])}::jsonb),
               "deliveryAttempts" = "deliveryAttempts" + 1,
               "lastDeliveredAt" = CASE WHEN ${record.protocol === 'LEGACY'} THEN (now() AT TIME ZONE 'UTC') ELSE "lastDeliveredAt" END,
               "updatedAt" = (now() AT TIME ZONE 'UTC')
         WHERE "requestId" = ${requestId} AND "venueId" = ${venueId}
           AND status IN ('PENDING', 'SENT', 'CANCEL_REQUESTED')`
      if (count === 0) logger.warn('🛑 [TerminalPayment] Delivery not recorded: row is not in a deliverable state', { requestId, venueId })
      return count > 0
    } catch (err) {
      logger.error('❌ [TerminalPayment] Could not record delivery provenance', { requestId, error: String(err) })
      return false
    }
  }

  /**
   * ACK de una REENTREGA (replay). Sólo confirma una fila PENDING —igual que `markDelivered` en el camino fresco—.
   * Re-auditoría 11-sep (P2-1): renovar la vigencia de una fila ya SENT en cada reconexión la dejaba «en curso» para
   * siempre, sin que el vigía la pasara nunca a UNKNOWN ni avisara. (P2-3): el filtro de estado es también lo único que
   * impide que un ACK tardío reviva una fila cerrada o en cancelación. Devuelve cuántas filas cambió.
   */
  private async registrarAckDeReplay(requestId: string, venueId: string): Promise<number> {
    const acknowledgedAt = new Date()
    const r = await prisma.terminalPaymentRequest.updateMany({
      where: { requestId, venueId, status: TerminalPaymentRequestStatus.PENDING },
      data: {
        status: TerminalPaymentRequestStatus.SENT,
        acknowledgedAt,
        lastDeliveredAt: acknowledgedAt,
        // Contado ya por `recordDelivery(…, replay: true)`: el ACK no es otra entrega.
        expiresAt: new Date(acknowledgedAt.getTime() + PAYMENT_TIMEOUT_MS),
      },
    })
    return r.count
  }

  private async markDelivered(requestId: string, venueId: string): Promise<void> {
    const acknowledgedAt = new Date()
    await prisma.terminalPaymentRequest.updateMany({
      where: { requestId, venueId, status: TerminalPaymentRequestStatus.PENDING },
      data: {
        status: TerminalPaymentRequestStatus.SENT,
        acknowledgedAt,
        lastDeliveredAt: acknowledgedAt,
        // `deliveryAttempts` lo suma `recordDelivery` al ENTREGAR; el ACK no es otra entrega.
        expiresAt: new Date(acknowledgedAt.getTime() + PAYMENT_TIMEOUT_MS),
      },
    })
  }

  private async failUndelivered(requestId: string, venueId: string, failureCode: string): Promise<void> {
    await prisma.terminalPaymentRequest.updateMany({
      where: { requestId, venueId, status: TerminalPaymentRequestStatus.PENDING },
      data: {
        status: TerminalPaymentRequestStatus.UNKNOWN,
        failureCode,
        resultJson: {
          requestId,
          status: 'timeout',
          errorMessage: 'La entrega no pudo confirmarse. Consulta el resultado en la terminal antes de volver a cobrar',
        },
      },
    })
  }

  /**
   * Reentrega al reconectar. Está capability-gated: una APK sin inbox durable no
   * recibe replays porque no podría distinguirlos de un cobro nuevo.
   */
  async replayPendingForTerminal(terminalId: string, venueId: string | undefined, socketId: string): Promise<void> {
    if (!venueId) return
    const entry = terminalRegistry.getTerminal(terminalId)
    if (!entry || entry.socketId !== socketId || entry.venueId !== venueId || (entry.terminalPaymentAckVersion ?? 0) < 1) return

    const io = socketManager.getServer()
    const directSocket = io?.sockets.sockets.get(socketId)
    if (!directSocket) return

    const normalizedTerminalId = normalizeTerminalId(terminalId)
    const rows = await prisma.terminalPaymentRequest.findMany({
      where: {
        terminalId: normalizedTerminalId,
        venueId,
        status: { in: IN_FLIGHT },
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'asc' },
      take: 1,
    })

    for (const row of rows) {
      // Codex 11-sep (3): una fila entregada a un socket SIN bandeja no se reenvía nunca (ni a la misma terminal ya
      // actualizada: su bandeja no la conoce y la ejecutaría otra vez); una de procedencia desconocida tampoco.
      const procedencia = leerProcedencia(row.deliveryProvenance)
      const motivo = procedencia === null ? 'UNKNOWN_PROVENANCE' : procedencia.some(d => d.protocol === 'LEGACY') ? 'LEGACY_DELIVERY' : null
      if (motivo) {
        await this.auditReplaySkip(row.id, row.requestId, venueId, terminalId, motivo)
        continue
      }
      if (row.status === TerminalPaymentRequestStatus.CANCEL_REQUESTED) {
        directSocket.emit('terminal:payment_cancel', {
          requestId: row.requestId,
          terminalId,
          reason: 'Cancelación pendiente durante reconexión',
          timestamp: new Date().toISOString(),
        })
        continue
      }

      const payload = {
        requestId: row.requestId,
        terminalId,
        amountCents: row.amountCents,
        tipCents: row.tipCents,
        rating: row.rating ?? undefined,
        skipReview: row.skipReview,
        orderId: row.orderId ?? undefined,
        senderDeviceName: row.senderDevice ?? undefined,
        processedByStaffId: row.processedByStaffId ?? undefined,
        venueId,
        timestamp: new Date().toISOString(),
        attemptLinkVersion: TERMINAL_ATTEMPT_LINK_VERSION,
      }
      const grabada = await this.recordDelivery(row.requestId, venueId, entry, socketId, true)
      if (!grabada) continue
      directSocket
        .timeout(PAYMENT_DELIVERY_ACK_TIMEOUT_MS)
        .emit('terminal:payment_request', payload, (error: Error | null, response?: { accepted?: boolean; requestId?: string }) => {
          if (error || response?.accepted !== true || response.requestId !== row.requestId) return
          // 🔴 Antes era `void prisma…updateMany(…)` pelón, y una consulta de Prisma es PEREZOSA: sin `await`/`.then`
          // no se ejecuta NUNCA, así que el ACK de un replay jamás se escribía. El método es `async` (corre al llamarlo)
          // y `.catch` evita un rechazo sin manejar, que `server.ts` convierte en gracefulShutdown.
          void this.registrarAckDeReplay(row.requestId, venueId).catch(err =>
            logger.warn('⚠️ [TerminalPayment] Could not record replay ACK', { requestId: row.requestId, error: String(err) }),
          )
        })
    }
  }

  /**
   * Handle payment result from a terminal (socket 'terminal:payment_result').
   * The durable winner determines the HTTP response, including when a Payment
   * committed before a delayed cancellation arrived.
   */
  handlePaymentResult(result: TerminalPaymentResult): boolean {
    const pending = this.pendingPayments.get(result.requestId)

    if (!pending) {
      logger.warn(`⚠️ [TerminalPayment] No in-flight long-poll for requestId`, { requestId: result.requestId })
      return false
    }

    void this.closeRow(result.requestId, pending.venueId, result).then(outcome => pending.resolve(outcome))

    clearTimeout(pending.timeout)
    this.pendingPayments.delete(result.requestId)

    logger.info(`✅ [TerminalPayment] Payment result received`, {
      requestId: result.requestId,
      status: result.status,
      paymentId: result.paymentId,
      terminalId: pending.terminalId,
    })

    return true
  }

  /**
   * Frontera autenticada TPV → server. El requestId del payload no basta: se ata
   * a la terminal y venue derivados del socket, y sólo entonces puede cerrar dinero.
   */
  async handlePaymentResultFromSocket(
    result: TerminalPaymentResult,
    terminal: { socketId: string | null; terminalId: string; venueId: string },
  ): Promise<boolean> {
    if (!result.requestId || !['success', 'failed', 'cancelled', 'timeout'].includes(result.status)) return false
    const row = await prisma.terminalPaymentRequest.findFirst({
      where: {
        requestId: result.requestId,
        terminalId: normalizeTerminalId(terminal.terminalId),
        venueId: terminal.venueId,
      },
      select: { requestId: true },
    })
    if (!row) {
      logger.warn('🛑 [TerminalPayment] Result rejected: request is not owned by authenticated terminal socket', {
        requestId: result.requestId,
        terminalId: terminal.terminalId,
        venueId: terminal.venueId,
        socketId: terminal.socketId,
      })
      return false
    }

    const pending = this.pendingPayments.get(result.requestId)
    const outcome = await this.closeRow(result.requestId, terminal.venueId, result)
    if (!pending) {
      logger.warn(`⚠️ [TerminalPayment] Authenticated late result closed row without an HTTP waiter`, { requestId: result.requestId })
      return false
    }
    clearTimeout(pending.timeout)
    this.pendingPayments.delete(result.requestId)
    pending.resolve(outcome)
    return true
  }

  /**
   * Transition a request row to its terminal status (CAS, immutable terminals).
   * - in-flight → terminal: normal close.
   * - TIMED_OUT/UNKNOWN → terminal: LATE result wins (flag lateResult); the POS
   *   was already told timeout, but the money truth is captured.
   * - already terminal: no-op (log the conflict).
   */
  private async closeRow(requestId: string, venueId: string, result: TerminalPaymentResult): Promise<TerminalPaymentResult> {
    try {
      if (
        (result.status === 'failed' || result.status === 'cancelled') &&
        !(result.outcomeEvidence === 'PRE_AUTHORIZATION' || (result.status === 'failed' && result.outcomeEvidence === 'PROCESSOR_DECLINED'))
      )
        result = { requestId, status: 'timeout', errorMessage: 'El resultado del cobro sigue pendiente de confirmar' }
      if (result.status === 'success') {
        const socketResult = result
        const winner = socketResult.paymentId
          ? await prisma.$transaction(async tx => {
              await this.closeRowFromPaymentTx(tx, requestId, socketResult.paymentId!, venueId, undefined, 'SOCKET')
              const row = await tx.terminalPaymentRequest.findFirst({ where: { requestId, venueId } })
              if (row?.status !== TerminalPaymentRequestStatus.COMPLETED || !row.paymentId) return null
              if (row.paymentId !== socketResult.paymentId) return resultFromRow(row)
              const stored = row.resultJson && typeof row.resultJson === 'object' && !Array.isArray(row.resultJson) ? row.resultJson : {}
              const canonical = { ...socketResult, ...stored, requestId, status: 'success' as const, paymentId: row.paymentId }
              await tx.terminalPaymentRequest.updateMany({
                where: { requestId, venueId, status: TerminalPaymentRequestStatus.COMPLETED, paymentId: row.paymentId },
                data: { resultJson: canonical as unknown as Prisma.InputJsonValue },
              })
              return canonical
            })
          : null
        if (winner) return winner
        result = { requestId, status: 'timeout', errorMessage: 'El pago sigue pendiente de confirmar en Avoqado' }
      }
      // Codex R12-6: un resultado NO-success no tiene ganador. Un `paymentId` que venga en un timeout/failed/cancelled
      // no se escribe ni en la columna ni en `resultJson` ni viaja al POS: sólo el camino `success` (validado arriba
      // contra el Payment real) decide quién ganó. El campo se admite en la interfaz para cualquier estado, así que
      // aquí se descarta — y se deja rastro, porque un cliente que lo manda merece investigarse.
      if (result.paymentId !== undefined) {
        logger.error('🚨 [TerminalPayment] Non-success socket result carried a paymentId — ignored, a negative outcome has no winner', {
          requestId,
          venueId,
          status: result.status,
          ignoredPaymentId: result.paymentId,
        })
        const { paymentId: _ignorado, ...sinGanador } = result
        result = sinGanador
      }
    } catch (err) {
      logger.error('[TerminalPayment] Cannot verify socket payment evidence', {
        requestId,
        venueId,
        error: err instanceof Error ? err.message : String(err),
      })
      return { requestId, status: 'timeout', errorMessage: 'El resultado sigue pendiente de confirmar' }
    }
    const newStatus = resultToStatus(result.status)
    const data: Prisma.TerminalPaymentRequestUpdateManyMutationInput = {
      status: newStatus,
      resultJson: result as unknown as Prisma.InputJsonValue,
      failureCode: result.status === 'failed' ? 'TPV_CONFIRMED_NO_CHARGE' : null,
      ...(result.status === 'cancelled' ? { cancelDisposition: 'ACCEPTED' } : {}),
    }
    try {
      const inFlight = await prisma.terminalPaymentRequest.updateMany({
        where: { requestId, venueId, status: { in: IN_FLIGHT } },
        data,
      })
      if (inFlight.count > 0) return result

      // Un resultado tardío CON evidencia (ya pasó el filtro de arriba: un failed/cancelled sin
      // `outcomeEvidence` se degradó a `timeout`) resuelve también las filas que quedaron FAILED por
      // un ACK perdido o CANCELLED sin confirmación de la terminal — antes sólo TIMED_OUT/UNKNOWN,
      // y esas otras dos quedaban ocupando la terminal para siempre (PAX 2841548417, 10-sep).
      const late = await prisma.terminalPaymentRequest.updateMany({
        where: {
          requestId,
          venueId,
          ...(newStatus === TerminalPaymentRequestStatus.TIMED_OUT
            ? { status: { in: [TerminalPaymentRequestStatus.TIMED_OUT, TerminalPaymentRequestStatus.UNKNOWN] } }
            : SIN_DESENLACE_ACREDITADO),
        },
        data: { ...data, lateResult: true },
      })
      if (late.count > 0) {
        logger.warn(`🕰️ [TerminalPayment] Late result reconciled a stale row`, { requestId, newStatus })
        return result
      }
      // Neither matched → row already in a final immutable state (or never existed).
      logger.info(`ℹ️ [TerminalPayment] closeRow no-op (row absent or already final)`, { requestId, newStatus })
      const winner = await prisma.terminalPaymentRequest.findFirst({ where: { requestId, venueId } })
      if (winner) return resultFromRow(winner)
    } catch (err) {
      logger.error(`❌ [TerminalPayment] closeRow failed`, { requestId, error: err instanceof Error ? err.message : String(err) })
    }
    return { requestId, status: 'timeout', errorMessage: 'El resultado sigue pendiente de confirmar' }
  }

  /**
   * S0 (checkpoint 1 del webhook, Codex 13-sep-2026): el ARBITRAJE de un registro que dice pertenecer a una solicitud
   * POS→terminal. Corre DENTRO de la transacción del registrador, con la fila de la solicitud bajo `FOR UPDATE`
   * (orden de candados: [sesión de vales → tickets →] Order → TerminalPaymentRequest → Payment → Shift), ANTES de
   * reclamar turno o de crear cualquier Payment. Decide una de cinco cosas:
   *
   *  · `NO_REQUEST`          la solicitud no existe en este venue: cobro normal, sin ligar (como hoy);
   *  · `INVALID_ASSOCIATION` el payload nombra una solicitud que NO es de esta terminal AUTENTICADA, o de otra orden,
   *                          o el intento ya está vinculado (S1) a otra solicitud: el cobro se registra NORMAL (el
   *                          dinero es real y no se pierde) pero sin ligar ni tocar al ganador ajeno, con 🚨 — el
   *                          `requestId` del payload no puede decidir qué cobro se excluye de ventas (P1-2);
   *  · `WINNER`              todavía no hay ganador: este intento lo será (el vínculo lo escribe `closeRowFromPaymentTx`);
   *  · `RETRY_OF_WINNER`     el ganador existe y es ESTE mismo intento (misma llave): reintento idempotente;
   *  · `SECOND_CAPTURE`      el ganador existe y es OTRO intento: posible segunda captura — evidencia + conciliación.
   *
   * El ganador es `row.paymentId` (también en filas históricas ligadas sólo por `processorData`) o el Payment COMPLETED
   * no-REFUND con `Payment.terminalPaymentRequestId` (el índice único parcial garantiza a lo sumo uno). Un ganador
   * reembolsado después sigue siendo el ganador: la fila conserva su `paymentId`.
   */
  async arbitrarRegistroDeSolicitud(
    tx: Prisma.TransactionClient,
    input: {
      requestId: string
      venueId: string
      attemptKey: string | null
      targetOrderId: string | null
      authenticatedSerial: string | null
    },
  ): Promise<ArbitrajeDeRegistro> {
    await tx.$queryRaw`SELECT "id" FROM "TerminalPaymentRequest" /* arbitraje */ WHERE "requestId" = ${input.requestId} AND "venueId" = ${input.venueId} FOR UPDATE`
    const row = await tx.terminalPaymentRequest.findFirst({
      where: { requestId: input.requestId, venueId: input.venueId },
      select: { requestId: true, status: true, orderId: true, terminalId: true, paymentId: true, amountCents: true, tipCents: true },
    })
    if (!row) return { kind: 'NO_REQUEST' }
    const rechazo = (reason: Extract<ArbitrajeDeRegistro, { kind: 'INVALID_ASSOCIATION' }>['reason']): ArbitrajeDeRegistro => {
      logger.error(
        '🚨 [TerminalPayment] Registro con una solicitud que NO le corresponde — se registra como cobro normal, sin ligar ni tocar al ganador',
        {
          requestId: input.requestId,
          venueId: input.venueId,
          reason,
          requestTerminalId: row.terminalId,
          authenticatedSerial: input.authenticatedSerial,
          requestOrderId: row.orderId,
          targetOrderId: input.targetOrderId,
          attemptKey: input.attemptKey,
        },
      )
      return { kind: 'INVALID_ASSOCIATION', reason }
    }
    if (!input.authenticatedSerial) return rechazo('NO_TERMINAL_IDENTITY')
    if (normalizeTerminalId(input.authenticatedSerial) !== normalizeTerminalId(row.terminalId)) return rechazo('TERMINAL_MISMATCH')
    if (input.targetOrderId && row.orderId && input.targetOrderId !== row.orderId) return rechazo('ORDER_MISMATCH')
    if (input.attemptKey) {
      const link = await tx.terminalPaymentAttemptLink.findUnique({ where: { attemptId: input.attemptKey }, select: { requestId: true } })
      if (link && link.requestId !== row.requestId) return rechazo('ATTEMPT_LINKED_ELSEWHERE')
    }
    const fila: FilaArbitrada = {
      requestId: row.requestId,
      status: row.status,
      orderId: row.orderId,
      amountCents: row.amountCents,
      tipCents: row.tipCents,
    }
    const seleccion = {
      id: true,
      orderId: true,
      idempotencyKey: true,
      processorData: true,
      terminalPaymentRequestId: true,
      terminal: { select: { serialNumber: true } },
    } as const
    // Codex R12-6: el puntero de la fila NO decide por sí solo. Un ganador histórico tiene que ser un cobro de ESTA
    // solicitud con el MISMO criterio que el cierre financiero (elegible, etiquetado con esta solicitud y cobrado en esta
    // terminal). Un puntero sin procedencia —o a un Payment que ya no existe en este venue— se ignora con 🚨 y bitácora,
    // y se cae a la columna del ganador (`Payment.terminalPaymentRequestId`, índice único parcial): así el cargo auténtico
    // liga la fila en vez de quedar como «segunda captura» de una venta ajena.
    let winner = row.paymentId
      ? await tx.payment.findFirst({
          where: { id: row.paymentId, venueId: input.venueId, ...whereElegibleComoCobroDeSolicitud(row, 'ganador') },
          select: seleccion,
        })
      : null
    let punteroIgnorado: { reason: string } | null = null
    if (row.paymentId) {
      const procedencia = winner ? procedenciaDelPagoDeSolicitud(winner, row, { fase: 'ganador' }) : null
      if (!procedencia?.acreditada) {
        punteroIgnorado = { reason: procedencia ? procedencia.reason : 'WINNER_MISSING' }
        winner = null
      }
    }
    if (!winner)
      winner = await tx.payment.findFirst({
        where: {
          venueId: input.venueId,
          terminalPaymentRequestId: row.requestId,
          ...(row.paymentId ? { id: { not: row.paymentId } } : {}),
          ...whereElegibleComoCobroDeSolicitud({ orderId: null }, 'ligar'),
        },
        select: seleccion,
      })
    if (punteroIgnorado && row.paymentId)
      this.punteroSinProcedencia(
        {
          requestId: row.requestId,
          venueId: input.venueId,
          ignoredPaymentId: row.paymentId,
          reason: punteroIgnorado.reason,
          origen: 'arbitraje',
        },
        // Si este intento va a ser el ganador, el cierre reemplaza el puntero y deja la bitácora; si no, nadie más lo hará.
        winner !== null,
      )
    if (!winner) return { kind: 'WINNER', row: fila }
    if (input.attemptKey && winner.idempotencyKey === input.attemptKey) return { kind: 'RETRY_OF_WINNER', winnerPaymentId: winner.id }
    return {
      kind: 'SECOND_CAPTURE',
      winnerPaymentId: winner.id,
      winnerOrderId: winner.orderId,
      winnerIdempotencyKey: winner.idempotencyKey,
      row: fila,
    }
  }

  /**
   * Codex R12-6: la fila apunta a un Payment que NO es un cobro acreditado de esta solicitud (fila histórica contaminada
   * por un resultado no-success del socket, o un ganador que ya no existe en este venue). Se deja rastro en el log (🚨) y en
   * la bitácora — fuera de la transacción del llamador, best-effort — y el llamador sigue como si no hubiera puntero.
   */
  private punteroSinProcedencia(
    ctx: {
      requestId: string
      venueId: string
      ignoredPaymentId: string
      reason: string
      origen: 'arbitraje' | 'cierre'
    },
    /** UNA entrada de bitácora por puntero ignorado: la escribe quien lo REEMPLAZA (el cierre), o el árbitro cuando nadie lo va a reemplazar. */
    bitacora: boolean,
  ) {
    logger.error('🚨 [TerminalPayment] The row points at a winner that is NOT an accredited charge of this request — pointer ignored', ctx)
    if (!bitacora) return
    void logAction({
      action: 'TERMINAL_PAYMENT_UNACCREDITED_WINNER_IGNORED',
      entity: 'TerminalPaymentRequest',
      entityId: ctx.requestId,
      venueId: ctx.venueId,
      data: {
        requestId: ctx.requestId,
        ignoredPaymentId: ctx.ignoredPaymentId,
        reason: ctx.reason,
        origen: ctx.origen,
        resolution:
          'El puntero no era un cobro acreditado de esta solicitud y se ignoró; el cargo auténtico liga la fila. Revisa por qué la fila apuntaba ahí.',
      },
    })
  }

  /**
   * Cierra la fila POS→terminal con un Payment REGISTRADO — la verdad de que el dinero se movió, que gana a
   * cualquier cancel/fail/timeout previo (reconcilia cualquier fila no ligada a COMPLETED para que el estado nunca
   * diga «cancelado» de un cobro que sí cayó, que es lo que invita al cajero a volver a cobrar). Camino ROBUSTO
   * (sobrevive a la caída del socket / reinicio): cuando la TPV manda `terminalPaymentRequestId` (= el requestId
   * del POS), un Payment registrado liga la fila; las TPV viejas no lo mandan → cierran por socket o por el vigía.
   * Best-effort: nunca lanza (no puede revertir una escritura real de dinero).
   *
   * S0 (checkpoint 1 del webhook, 13-sep-2026): DEVUELVE lo que hizo — «no lanzó» ≠ ligó (Codex). Escribe
   * `Payment.terminalPaymentRequestId` (la columna del ganador, con su índice único parcial) sólo si el CAS sobre la
   * fila ganó, y PRIMERO la fila, DESPUÉS el Payment: al revés, el perdedor de una carrera estampaba su Payment con
   * la columna y el índice reventaba DENTRO de la transacción del registrador, que en Postgres queda abortada — el
   * dinero del perdedor no se registraba. Y una fila ya COMPLETED pero SIN `paymentId` (cerrada por el socket antes
   * de que llegara el registro) SÍ liga: antes salía en falso y dejaba al primer registro sin vínculo, y al segundo
   * sin nadie que le dijera que era el segundo. Una fila YA ligada nunca cambia de ganador (idempotente).
   */
  async closeRowFromPaymentTx(
    tx: Prisma.TransactionClient,
    requestId: string,
    paymentId: string,
    venueId: string,
    reported?: { amountCents: number; tipCents: number },
    source: 'REST' | 'SOCKET' = 'REST',
    /**
     * Serial AUTENTICADO del aparato que registró el cobro: `paymentData.deviceSerialNumber`, que el
     * controlador inyecta desde `authContext.terminalSerialNumber` (el esquema del registro de cobro no
     * lo acepta del cuerpo). Es la procedencia cuando la FK `Payment.terminal` no resolvió.
     */
    capturedBySerial?: string | null,
    /** S8: quién cerró. Se escribe UNA vez, junto con `paymentId`, y conserva al ganador original. */
    closedVia: 'terminal' | 'webhook' = 'terminal',
  ): Promise<CloseRowOutcome> {
    try {
      // P1-5 (Codex): el MISMO orden de candados que el registrador — la SOLICITUD antes que el Payment — también
      // cuando se llega desde el socket. (Payment → Request) contra (Request → Payment) es un interbloqueo.
      await tx.$queryRaw`SELECT "id" FROM "TerminalPaymentRequest" WHERE "requestId" = ${requestId} AND "venueId" = ${venueId} FOR UPDATE`
      const before = await tx.terminalPaymentRequest.findFirst({
        where: { requestId, venueId },
        select: { status: true, amountCents: true, tipCents: true, orderId: true, terminalId: true, paymentId: true },
      })
      if (!before) return { bound: false, reason: 'NO_REQUEST' }
      const solicitud = { requestId, orderId: before.orderId, terminalId: before.terminalId }
      const seleccionDeProcedencia = {
        processorData: true,
        amount: true,
        tipAmount: true,
        source: true,
        orderId: true,
        terminalPaymentRequestId: true,
        terminal: { select: { serialNumber: true } },
      } as const
      // Codex R12-6: «ya ligada» sólo si el puntero es un cobro ACREDITADO de esta solicitud (el mismo criterio que el
      // árbitro). Un puntero sin procedencia (una fila histórica contaminada por un resultado no-success del socket) no
      // puede excluir al cargo auténtico: se reemplaza EXACTAMENTE ese puntero (CAS sobre su valor), con 🚨 y bitácora.
      let punteroAReemplazar: string | null = null
      if (before.paymentId) {
        if (before.paymentId === paymentId) return { bound: false, reason: 'ALREADY_BOUND' }
        const actual = await tx.payment.findFirst({
          where: { id: before.paymentId, venueId, ...whereElegibleComoCobroDeSolicitud(before, 'ganador') },
          select: seleccionDeProcedencia,
        })
        const procedencia = actual ? procedenciaDelPagoDeSolicitud(actual, solicitud, { fase: 'ganador' }) : null
        if (procedencia?.acreditada) return { bound: false, reason: 'ALREADY_BOUND' }
        this.punteroSinProcedencia(
          {
            requestId,
            venueId,
            ignoredPaymentId: before.paymentId,
            reason: procedencia ? procedencia.reason : 'WINNER_MISSING',
            origen: 'cierre',
          },
          true,
        )
        punteroAReemplazar = before.paymentId
      }

      // Concurrent callbacks cannot bind the same Payment to two requests.
      await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${paymentId} AND "venueId" = ${venueId} FOR UPDATE`
      const payment = await tx.payment.findFirst({
        where: { id: paymentId, venueId, ...whereElegibleComoCobroDeSolicitud(before, 'ligar') },
        select: seleccionDeProcedencia,
      })
      if (!payment) return { bound: false, reason: 'PAYMENT_NOT_ELIGIBLE' }
      // Codex R13-7: una reclamación de OTRA solicitud sobre este Payment sólo veta el cierre si está ACREDITADA por el mismo
      // criterio (elegible para ella, etiquetado con ella y cobrado en su terminal). Un puntero sin procedencia es un ALIAS
      // contaminado: se registra y se resuelve (CAS sobre su valor), y el cargo auténtico sigue cerrando ESTA solicitud.
      const ajenas = await this.reclamacionesAjenas(tx, { paymentId, venueId, requestId, origen: 'cierre' }, payment)
      if (ajenas.vetada) return { bound: false, reason: 'PAYMENT_BOUND_ELSEWHERE' }
      // El MISMO criterio de procedencia que el árbitro (`procedenciaDelPagoDeSolicitud`, fase «ligar»): la etiqueta de
      // OTRA solicitud rechaza; la de ésta la escribe este mismo cierre más abajo.
      const procedencia = procedenciaDelPagoDeSolicitud(payment, solicitud, { fase: 'ligar', capturedBySerial })
      if (!procedencia.acreditada && procedencia.reason === 'PAYMENT_TAGGED_FOR_ANOTHER_REQUEST') {
        logger.error('[TerminalPayment] Refused to bind one payment to a different request', { requestId, paymentId, venueId })
        return { bound: false, reason: 'PAYMENT_TAGGED_FOR_ANOTHER_REQUEST' }
      }
      // 🔴 ATRIBUCIÓN FÍSICA, en CUALQUIER origen. La estrictez de abajo estaba condicionada a
      // `source === 'SOCKET'`, y las dos llamadas reales (`payment.tpv.service.ts`, orden y venta rápida)
      // entran por el valor por DEFECTO, que es REST: un Payment cobrado en OTRO aparato cerraba
      // esta solicitud, liberaba el slot de una terminal que quizá seguía ejecutando el suyo y daba
      // por cobrado un importe que no salió de ahí. El Payment NO se toca ni se le estampa la
      // etiqueta: sólo se le niega cerrar ESTA petición.
      //
      // 🔑 De dónde sale la identidad, en orden: la `Terminal` ligada al Payment (resuelta al crearlo
      // desde el serial del token), el serial AUTENTICADO que pasa el llamador, y el serial que quedó
      // persistido en `processorData` (respaldo para recuperaciones posteriores). Todo token de TPV
      // lleva `terminalSerialNumber` —el login exige una `Terminal`—, así que un cierre SIN ninguna
      // de las tres no es un cliente viejo: es una llamada sin procedencia, y NO cierra (auditoría del
      // 10-sep: «la ausencia no prueba que el Payment sea del aparato reservado»). El Payment se
      // conserva y la fila queda para la recuperación.
      if (!procedencia.acreditada) {
        if (procedencia.reason === 'NO_TERMINAL_IDENTITY') {
          logger.error('🚨 [Terminal-payment] Refused to close a request: the Payment carries no accredited terminal identity', {
            requestId,
            paymentId,
            venueId,
            requestTerminalId: before.terminalId,
            source,
          })
          return { bound: false, reason: 'NO_TERMINAL_IDENTITY' }
        }
        logger.error('🚨 [Terminal-payment] Refused to close a request with a Payment captured by another terminal', {
          requestId,
          paymentId,
          venueId,
          requestTerminalId: before.terminalId,
          reason: procedencia.reason,
        })
        return { bound: false, reason: 'TERMINAL_MISMATCH' }
      }
      const { serial: serialDelPago, serialPersistido, metadata } = procedencia
      if (
        source === 'SOCKET' &&
        (metadata.terminalPaymentRequestId !== requestId ||
          payment.source !== 'TPV' ||
          !payment.terminal?.serialNumber ||
          normalizeTerminalId(payment.terminal.serialNumber) !== normalizeTerminalId(before.terminalId))
      )
        return { bound: false, reason: 'SOCKET_ATTRIBUTION_MISMATCH' }
      reported ??= { amountCents: Number(payment.amount.mul(100)), tipCents: Number(payment.tipAmount.mul(100)) }

      // `lateResult` = this row had already been closed/timed-out when the money truth
      // arrived (reopened), vs a normal in-flight close. Una fila COMPLETED sin `paymentId` la cerró la TERMINAL con
      // éxito antes de que llegara el registro (la secuencia normal de AngelPay): ligarla no es reabrirla.
      const cerradaConExitoSinPago = before.status === TerminalPaymentRequestStatus.COMPLETED
      const reopened = !IN_FLIGHT.includes(before.status) && !cerradaConExitoSinPago
      // La MISMA regla que aplica el barrido de recuperación, en un solo sitio.
      const descuadre = contratoDescuadrado(before, reported)
      const requested = descuadre?.requested
      const reportedContract = descuadre?.reported
      const contractMismatch = descuadre !== null

      // PRIMERO la fila: el CAS es «todavía sin ganador» (`paymentId: null`), no «todavía no COMPLETED» — o, Codex R12-6,
      // «todavía con el puntero sin procedencia que se va a reemplazar» (nunca un ganador acreditado escrito en medio).
      const ganada = await tx.terminalPaymentRequest.updateMany({
        where: { requestId, venueId, paymentId: punteroAReemplazar },
        data: {
          status: TerminalPaymentRequestStatus.COMPLETED,
          paymentId,
          closedVia,
          lateResult: reopened,
          cancelDisposition: null,
          resultJson: { requestId, status: 'success', paymentId },
          ...(contractMismatch
            ? {
                failureCode: 'CONTRACT_MISMATCH',
                resultJson: {
                  requestId,
                  status: 'success',
                  paymentId,
                  reconciliationRequired: true,
                  requested,
                  reported: reportedContract,
                },
              }
            : {}),
        },
      })
      if (ganada.count !== 1) return { bound: false, reason: 'ALREADY_BOUND' }

      // DESPUÉS el Payment: la columna del ganador y la procedencia, en la misma transacción que la fila.
      await tx.payment.updateMany({
        where: { id: paymentId, venueId },
        data: {
          terminalPaymentRequestId: requestId,
          processorData: {
            ...metadata,
            terminalPaymentRequestId: requestId,
            // La procedencia se CONSERVA aunque la FK no haya resuelto: es lo que permite a la
            // recuperación acreditar este Payment después.
            ...(serialPersistido ? {} : { deviceSerialNumber: serialDelPago }),
          } as Prisma.InputJsonObject,
        },
      })

      if (contractMismatch) {
        logger.error('🚨 [Terminal-payment contract mismatch] Payment was recorded with values different from the POS request', {
          requestId,
          paymentId,
          venueId,
          requested,
          reported: reportedContract,
        })
      }

      // Money landed on a row that was NOT in flight (o sobre un cancel que perdió la carrera):
      // el cobro pasó A PESAR de que aquí ya lo dábamos por cerrado, y una persona tiene que
      // enterarse. 🚨 = the stable Better Stack token.
      //
      // 🔴 La condición cuelga de `reopened` (= NO estaba en vuelo), no de una lista escrita a
      // mano: ésa se quedó corta y dejó MUDOS a `TIMED_OUT` y `UNKNOWN` (auditoría 12-sep).
      // `TIMED_OUT` es justo donde más duele — una fila soltada por TIEMPO liberó la ranura por
      // POLÍTICA y sin evidencia de que no se cobró, así que un Payment posterior es el caso
      // con más probabilidad de ser un DOBLE COBRO, y era el único que se cerraba en silencio.
      // Colgarlo de `reopened` lo vuelve exhaustivo por construcción: un estado nuevo del enum
      // queda cubierto salvo que alguien lo declare explícitamente en IN_FLIGHT.
      const alarmed = reopened || before.status === TerminalPaymentRequestStatus.CANCEL_REQUESTED
      if (alarmed) {
        logger.error(
          `🚨 [Terminal-payment] Payment recorded for an already-${before.status} request — reconciled to COMPLETED (money moved despite cancel/close/release)`,
          {
            requestId,
            paymentId,
            venueId,
            priorStatus: before.status,
            closedVia,
          },
        )
      }
      // `alarmed` viaja en el desenlace para que quien cierra por WEBHOOK deje bitácora con la MISMA condición (S8), no con otra lista.
      return { bound: true, reopened, contractMismatch, previousStatus: before.status, alarmed }
    } catch (err) {
      logger.error(`❌ [TerminalPayment] closeRowFromPaymentTx failed (non-fatal)`, {
        requestId,
        paymentId,
        error: err instanceof Error ? err.message : String(err),
      })
      return { bound: false, reason: 'ERROR' }
    }
  }

  /**
   * True when the order has a terminal charge that could still move money.
   * A requested cancellation is only an intent, not a confirmed financial result.
   * Used to block cancelOrder:
   * cancelling the order under one of these lets the charge land on a
   * CANCELLED order (recorded & settled, but excluded from reports).
   *
   */
  async hasChargeBlockingOrderCancel(venueId: string, orderId: string, client: Prisma.TransactionClient = prisma): Promise<boolean> {
    return (await this.findChargeBlockingOrderCancel(venueId, orderId, client)) !== null
  }

  /** El cobro que impide cancelar la orden (el más reciente), o `null`. Con `client` corre dentro de la transacción del llamador. */
  async findChargeBlockingOrderCancel(
    venueId: string,
    orderId: string,
    client: Prisma.TransactionClient = prisma,
  ): Promise<{ requestId: string } | null> {
    return client.terminalPaymentRequest.findFirst({
      where: {
        venueId,
        orderId,
        // 🔴 Estricto SIEMPRE: ver el bloqueador de orden de la admisión. Cancelar la orden es la otra forma de
        // eludir la protección del cobro incierto, así que comparte su régimen.
        ...UNRESOLVED_FINANCIAL_OUTCOME,
      },
      select: { requestId: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
  }

  /** Read a request's current status (mobile status endpoint + MCP tool). */
  async getPaymentStatus(requestId: string, venueId: string): Promise<TerminalPaymentStatus | null> {
    const row = await prisma.terminalPaymentRequest.findFirst({ where: { requestId, venueId } })
    if (!row) return null
    return proyectarEstado(row)
  }

  /**
   * Watchdog sweep: reconcile stale active rows. Runs every ~30s + at boot.
   * - stale in-flight (past expiresAt) or CANCEL_REQUESTED past a short grace:
   *   if a Payment exists for the order → COMPLETED (late); else → UNKNOWN
   *   (HOLD the slot, never free blind) and alert. Returns a small summary.
   * The entry read is retry-wrapped per .claude/rules/cron-jobs.md.
   */
  async reconcileStaleRequests(now: Date = new Date()): Promise<{ completed: number; unknown: number; cancelled: number }> {
    const cancelCutoff = new Date(now.getTime() - CANCEL_GRACE_MS)
    const stale = await retry(
      () =>
        prisma.terminalPaymentRequest.findMany({
          where: {
            status: { in: IN_FLIGHT },
            OR: [{ expiresAt: { lt: now } }, { status: TerminalPaymentRequestStatus.CANCEL_REQUESTED, updatedAt: { lt: cancelCutoff } }],
          },
          take: 200,
        }),
      { retries: 3, shouldRetry: shouldRetryDbConnectionError, context: 'terminal-payment-watchdog:findStale' },
    )

    let completed = 0
    let unknown = 0
    const cancelled = 0

    for (const row of stale) {
      // Reconcile only an exact request reference; other payments on the sale prove nothing.
      const payment = await this.findReconcilablePayment(row)

      if (payment) {
        // 🔴 El importe COBRADO puede no ser el que pidió el POS (el cajero tecleó otro en la
        // terminal, la propina cambió). El cierre dentro de la transacción del pago ya lo marca
        // como CONTRACT_MISMATCH y dispara el 🚨; esta ruta —el barrido que recupera un cobro
        // tardío— lo cerraba como si nada, y la diferencia no aparecía en ningún lado: la orden
        // quedaba «pagada» y el descuadre invisible. El dinero NO se rechaza (ya salió de la
        // tarjeta): se cierra igual, pero MARCADO y con aviso, para que un humano lo concilie.
        const marca = marcaDeDescuadre(row, payment)
        const descuadre = marca.contrato
        const r = await prisma.terminalPaymentRequest.updateMany({
          where: { id: row.id, status: { in: IN_FLIGHT } },
          data: {
            status: TerminalPaymentRequestStatus.COMPLETED,
            paymentId: payment.id,
            lateResult: true,
            ...marca.campos,
          },
        })
        completed += r.count
        if (r.count > 0 && descuadre) {
          // 🚨 token estable que machea la regla de Better Stack — NO renombrar. Es el MISMO
          // mensaje que emite el cierre por transacción: un solo hecho, una sola alarma.
          logger.error('🚨 [Terminal-payment contract mismatch] Payment was recorded with values different from the POS request', {
            requestId: row.requestId,
            paymentId: payment.id,
            venueId: row.venueId,
            requested: descuadre.requested,
            reported: descuadre.reported,
          })
        }
        // 🔴 El MISMO evento de dinero se descubre por dos rutas y sólo una avisaba:
        // closeRowFromPaymentTx dispara el 🚨 cuando la fila venía cancelada, y esta no
        // disparaba nada. Si el hallazgo llegaba por aquí, nadie se enteraba de que el
        // cajero canceló y el dinero se fue igual.
        //
        // No se puede prevenir en la caja: medido en esta base, el registro tardío llega
        // entre 65 s y 3 HORAS después del cobro. Retener la venta ese tiempo sería mucho
        // peor que el problema — dejaría un fantasma bloqueando cada venta cancelada
        // durante toda una tarde. Si no se puede prevenir, lo mínimo es que un humano se
        // entere y pueda devolver el dinero.
        //
        // 🚨 token estable que machea la regla de Better Stack — NO renombrar.
        if (r.count > 0 && row.status === TerminalPaymentRequestStatus.CANCEL_REQUESTED) {
          logger.error(
            `🚨 [Terminal-payment watchdog] Payment recorded for an already-${row.status} request — reconciled to COMPLETED (money moved despite cancel)`,
            { requestId: row.requestId, paymentId: payment.id, priorStatus: row.status },
          )
        }
        continue
      }

      // Unknown outcome — HOLD the slot (never free blind), alert, flag for manual reconcile.
      // 🚨 token is the stable string Better Stack's alert rule matches — do NOT rename.
      logger.error(`🚨 [Terminal-payment watchdog] Row went UNKNOWN — manual reconcile needed`, {
        requestId: row.requestId,
        terminalId: row.terminalId,
        venueId: row.venueId,
        orderId: row.orderId,
        ageSeconds: Math.floor((now.getTime() - row.createdAt.getTime()) / 1000),
      })
      const r = await prisma.terminalPaymentRequest.updateMany({
        where: { id: row.id, status: { in: IN_FLIGHT } },
        data: { status: TerminalPaymentRequestStatus.UNKNOWN, failureCode: 'TIMED_OUT' },
      })
      unknown += r.count
      if (r.count > 0) {
        // Second channel, independent of the log pipeline (see opsAlert.service.ts). Outside
        // any retry/transaction on purpose, and NOT awaited: a hung mail provider must never stall
        // this tick (the job's isRunning latch would then skip every following sweep, including
        // reconciliation of requested cancellations). sendOpsAlert never throws.
        void sendOpsAlert({
          subject: `Terminal ${row.terminalId}: cobro sin respuesta (${row.venueId})`,
          lines: [
            `Un cobro de $${(row.amountCents / 100).toFixed(2)} enviado a la terminal ${row.terminalId} no obtuvo respuesta en 5 minutos (requestId ${row.requestId}, orden ${row.orderId ?? 'sin orden'}).`,
            'La terminal conserva la reserva hasta confirmar el resultado del cobro y que terminó su ejecución; reconectar o esperar no la libera.',
            'Confirma el resultado en la terminal o concilia con el procesador. No vuelvas a pasar la tarjeta mientras siga pendiente.',
          ],
        })
      }
    }

    if (completed || unknown || cancelled) {
      logger.info(`🧹 [Terminal-payment watchdog] reconciled`, { completed, unknown, cancelled, scanned: stale.length })
    }
    return { completed, unknown, cancelled }
  }

  /** Exact recorded request identity, completed card payment, and single ownership. */
  private async findReconcilablePayment(row: {
    id: string
    requestId: string
    orderId: string | null
    venueId: string
    terminalId: string
    createdAt: Date
  }): Promise<{ id: string; amount: Prisma.Decimal; tipAmount: Prisma.Decimal } | null> {
    const candidate = await prisma.payment.findFirst({
      where: {
        ...(row.orderId ? { orderId: row.orderId } : {}),
        venueId: row.venueId,
        processorData: { path: ['terminalPaymentRequestId'], equals: row.requestId },
        status: TransactionStatus.COMPLETED,
        method: { in: [PaymentMethod.CREDIT_CARD, PaymentMethod.DEBIT_CARD] },
      },
      select: {
        id: true,
        source: true,
        amount: true,
        tipAmount: true,
        orderId: true,
        processorData: true,
        terminalPaymentRequestId: true,
        terminal: { select: { serialNumber: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    if (!candidate) return null
    // 🔴 La MISMA atribución física que exige el camino del socket (ver `closeRowFromPaymentTx`),
    // que la recuperación se saltaba por entrar como 'REST': un Payment con la etiqueta correcta
    // y del mismo venue puede haberse cobrado en OTRO aparato. Cerrar la petición con él libera
    // el slot de una terminal que quizá sigue ejecutando el suyo — y da por cobrado un importe
    // que no salió de ahí. El Payment NO se toca: sólo se le niega cerrar ESTA petición.
    const serialRespaldo =
      candidate.processorData && typeof candidate.processorData === 'object' && !Array.isArray(candidate.processorData)
        ? (candidate.processorData as Record<string, unknown>).deviceSerialNumber
        : undefined
    const serialAcreditado = candidate.terminal?.serialNumber ?? (typeof serialRespaldo === 'string' ? serialRespaldo : null)
    if (candidate.source !== 'TPV' || !serialAcreditado || normalizeTerminalId(serialAcreditado) !== normalizeTerminalId(row.terminalId)) {
      logger.warn('[TerminalPayment] Recovery refused a Payment attributed to another terminal/source', {
        requestId: row.requestId,
        venueId: row.venueId,
        expectedTerminalId: row.terminalId,
      })
      return null
    }
    // Codex R13-7: el barrido aplica el MISMO criterio que el cierre — sólo una reclamación ajena ACREDITADA descarta al candidato;
    // un alias contaminado se registra, se resuelve y el cargo auténtico cierra la fila.
    // Codex R14-4: la limpieza ESCRIBE (CAS por alias con NOWAIT + SAVEPOINT), así que corre en una transacción REAL y con el
    // MISMO orden de candados que el cierre — la solicitud propia, después el Payment, y las ajenas sólo sin esperar.
    const ajenas = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "TerminalPaymentRequest" WHERE "id" = ${row.id} FOR UPDATE`
      await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${candidate.id} AND "venueId" = ${row.venueId} FOR UPDATE`
      return this.reclamacionesAjenas(
        tx,
        { paymentId: candidate.id, venueId: row.venueId, requestId: row.requestId, origen: 'barrido' },
        candidate,
      )
    })
    return ajenas.vetada ? null : candidate
  }

  /**
   * Codex R14-4: una fila UNKNOWN cuyo puntero NO es un cobro acreditado suyo — un alias que un cierre ajeno DIFIRIÓ (la fila
   * estaba tomada en ese instante) o una contaminación histórica — lo suelta en el barrido, aunque el cierre que lo difirió ya
   * haya terminado COMPLETED: el diferido queda recuperable por el propio barrido, no por una bitácora sin consumidor. Bajo el
   * candado de la fila (el primero del orden del cierre), releyendo el puntero y revalidando la procedencia antes del CAS. Un
   * puntero ACREDITADO (un cobro real suyo que todavía no cierra la fila) se conserva.
   */
  private async retirarAliasPropio(row: {
    id: string
    requestId: string
    orderId: string | null
    terminalId: string
    venueId: string
    paymentId: string | null
  }): Promise<boolean> {
    if (!row.paymentId) return false
    return prisma.$transaction(async tx => {
      const [vigente] = await tx.$queryRaw<{ paymentId: string | null }[]>`
        SELECT "paymentId" FROM "TerminalPaymentRequest" WHERE "id" = ${row.id} AND "status" = 'UNKNOWN' FOR UPDATE`
      if (!vigente?.paymentId) return false
      const pago = await tx.payment.findFirst({
        where: { id: vigente.paymentId, venueId: row.venueId, ...whereElegibleComoCobroDeSolicitud(row, 'ganador') },
        select: SELECCION_DE_PROCEDENCIA,
      })
      const procedencia = pago ? procedenciaDelPagoDeSolicitud(pago, row, { fase: 'ganador' }) : null
      if (procedencia?.acreditada) return false
      const retirado = await tx.terminalPaymentRequest.updateMany({
        where: { id: row.id, paymentId: vigente.paymentId },
        data: { paymentId: null },
      })
      if (retirado.count !== 1) return false
      const contexto = {
        requestId: row.requestId,
        paymentId: vigente.paymentId,
        venueId: row.venueId,
        reason: procedencia ? procedencia.reason : 'WINNER_MISSING',
        origen: 'barrido' as const,
      }
      logger.error('🚨 [TerminalPayment] UNKNOWN row pointed at a Payment WITHOUT provenance — stale alias retired by the sweep', contexto)
      void logAction({
        action: 'TERMINAL_PAYMENT_CONTAMINATED_ALIAS_RESOLVED',
        entity: 'TerminalPaymentRequest',
        entityId: row.requestId,
        venueId: row.venueId,
        data: {
          ...contexto,
          resolution:
            'La solicitud apuntaba a un Payment que no es un cobro acreditado suyo (alias diferido o contaminado); el barrido retiró ese puntero. Revisa por qué la fila apuntaba ahí.',
        },
      })
      return true
    })
  }

  /**
   * Codex R13-7: las reclamaciones de OTRAS solicitudes (del mismo venue) sobre un Payment que va a cerrar `requestId`. R12-6
   * corrigió «mi solicitud apunta a un Payment ajeno»; quedaba la inversa: «otra solicitud apunta a MI Payment», que vetaba el
   * cierre por MERA EXISTENCIA del puntero (`PAYMENT_BOUND_ELSEWHERE`), también en el barrido — una fila UNKNOWN contaminada por el
   * antiguo productor no-success podía dejar a la solicitud auténtica reteniendo la terminal con su cobro demostrado.
   *  · Una reclamación ACREDITADA por el criterio compartido (`procedenciaDelPagoDeSolicitud`, fase «ganador»: elegible para ESA
   *    solicitud —misma orden si la tiene—, etiquetado con ella y cobrado en su terminal) VETA: el dueño auténtico se conserva.
   *  · Un puntero sin procedencia es un ALIAS contaminado: 🚨, bitácora `TERMINAL_PAYMENT_CONTAMINATED_ALIAS_RESOLVED` y se
   *    retira EXACTAMENTE ese puntero (CAS sobre su valor) — nunca se sobrescribe una reclamación acreditada concurrente (si el
   *    valor ya cambió, el CAS no toca nada). Acotado: un Payment tiene una o dos reclamaciones; más es corrupción visible.
   */
  private async reclamacionesAjenas(
    db: Pick<Prisma.TransactionClient, 'terminalPaymentRequest' | '$queryRaw' | '$executeRaw'>,
    ctx: { paymentId: string; venueId: string; requestId: string; origen: 'cierre' | 'barrido' },
    pago: PagoConProcedencia & { orderId: string | null },
  ): Promise<{ vetada: true; por: string } | { vetada: false; aliasResueltos: number; aliasDiferidos: number }> {
    const otras = await db.terminalPaymentRequest.findMany({
      where: { paymentId: ctx.paymentId, venueId: ctx.venueId, requestId: { not: ctx.requestId } },
      select: { id: true, requestId: true, orderId: true, terminalId: true, status: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 10,
    })
    let aliasResueltos = 0
    let aliasDiferidos = 0
    for (const otra of otras) {
      const elegible = !otra.orderId || pago.orderId === otra.orderId
      const procedencia = elegible ? procedenciaDelPagoDeSolicitud(pago, otra, { fase: 'ganador' }) : null
      if (procedencia?.acreditada) return { vetada: true, por: otra.requestId }
      const desenlace = await this.retirarAliasAjeno(db, ctx, pago, otra, procedencia ? procedencia.reason : 'ORDER_MISMATCH')
      if (desenlace === 'VETADA') return { vetada: true, por: otra.requestId }
      if (desenlace === 'RETIRADO') aliasResueltos++
      if (desenlace === 'DIFERIDO') aliasDiferidos++
    }
    return { vetada: false, aliasResueltos, aliasDiferidos }
  }

  /**
   * Codex R14-4: retira UN alias ajeno sin esperar jamás a otra solicitud. El cierre ya posee su solicitud y su Payment; esperar
   * aquí la fila de OTRA solicitud —que a su vez puede estar cerrando y esperando la nuestra— es la espera circular
   * (Q1→P2 / Q2→P1 con dos replays simultáneos). Por eso la fila ajena se toma con `FOR UPDATE NOWAIT` dentro de un SAVEPOINT:
   *  · tomada por otra transacción (55P03) ⇒ se revierte al savepoint (la transacción propia sigue sana) y el alias se DIFIERE
   *    con bitácora `TERMINAL_PAYMENT_CONTAMINATED_ALIAS_DEFERRED`; lo recupera el barrido (`retirarAliasPropio`) o el propio
   *    cierre de esa otra solicitud, que reemplaza su puntero sin procedencia;
   *  · cualquier otro error se propaga;
   *  · tomada ⇒ se RELEE el puntero bajo el candado (el `findMany` de arriba fue sin candado): si ya no apunta aquí, no hay nada
   *    que retirar; si sigue apuntando y ahora está ACREDITADA para ella, veta; si no, CAS exacto sobre su valor.
   */
  private async retirarAliasAjeno(
    db: Pick<Prisma.TransactionClient, 'terminalPaymentRequest' | '$queryRaw' | '$executeRaw'>,
    ctx: { paymentId: string; venueId: string; requestId: string; origen: 'cierre' | 'barrido' },
    pago: PagoConProcedencia & { orderId: string | null },
    otra: { id: string; requestId: string; status: TerminalPaymentRequestStatus },
    reason: string,
  ): Promise<'RETIRADO' | 'DIFERIDO' | 'VETADA' | 'SIN_CAMBIO'> {
    const base = {
      requestId: otra.requestId,
      paymentId: ctx.paymentId,
      authenticRequestId: ctx.requestId,
      venueId: ctx.venueId,
      origen: ctx.origen,
    }
    await db.$executeRaw`SAVEPOINT alias_ajeno`
    let vigente: { paymentId: string | null; orderId: string | null; terminalId: string; status: TerminalPaymentRequestStatus } | undefined
    try {
      ;[vigente] = await db.$queryRaw<NonNullable<typeof vigente>[]>`
        SELECT "paymentId", "orderId", "terminalId", "status" FROM "TerminalPaymentRequest" /* alias ajeno */ WHERE "id" = ${otra.id} FOR UPDATE NOWAIT`
    } catch (error) {
      if (!esFilaTomadaSinEsperar(error)) throw error
      await db.$executeRaw`ROLLBACK TO SAVEPOINT alias_ajeno`
      logger.error(
        '🚨 [TerminalPayment] Another request pointed at this Payment WITHOUT provenance — its row is held elsewhere: alias DEFERRED',
        {
          ...base,
          reason,
          priorStatus: otra.status,
        },
      )
      void logAction({
        action: 'TERMINAL_PAYMENT_CONTAMINATED_ALIAS_DEFERRED',
        entity: 'TerminalPaymentRequest',
        entityId: otra.requestId,
        venueId: ctx.venueId,
        data: {
          ...base,
          reason,
          priorStatus: otra.status,
          resolution:
            'La solicitud apuntaba a un Payment que no es un cobro acreditado suyo, pero su fila estaba tomada por otra transacción: no se esperó (evitaría una espera circular). El barrido o su propio cierre retiran el puntero.',
        },
      })
      return 'DIFERIDO'
    }
    await db.$executeRaw`RELEASE SAVEPOINT alias_ajeno`
    if (!vigente || vigente.paymentId !== ctx.paymentId) return 'SIN_CAMBIO'
    // Relectura: la fila pudo cambiar de orden/terminal/estado entre el `findMany` y el candado — se revalida con lo vigente.
    const elegibleAhora = !vigente.orderId || pago.orderId === vigente.orderId
    const procedenciaAhora = elegibleAhora
      ? procedenciaDelPagoDeSolicitud(
          pago,
          { requestId: otra.requestId, orderId: vigente.orderId, terminalId: vigente.terminalId },
          { fase: 'ganador' },
        )
      : null
    if (procedenciaAhora?.acreditada) return 'VETADA'
    const retirado = await db.terminalPaymentRequest.updateMany({
      where: { id: otra.id, paymentId: ctx.paymentId },
      data: { paymentId: null },
    })
    const contexto = {
      ...base,
      reason: procedenciaAhora ? procedenciaAhora.reason : 'ORDER_MISMATCH',
      priorStatus: vigente.status,
      retirado: retirado.count === 1,
    }
    logger.error('🚨 [TerminalPayment] Another request pointed at this Payment WITHOUT provenance — contaminated alias resolved', contexto)
    void logAction({
      action: 'TERMINAL_PAYMENT_CONTAMINATED_ALIAS_RESOLVED',
      entity: 'TerminalPaymentRequest',
      entityId: otra.requestId,
      venueId: ctx.venueId,
      data: {
        ...contexto,
        resolution:
          'La solicitud apuntaba a un Payment que no es un cobro acreditado suyo; se retiró ese puntero y el cargo cierra su solicitud auténtica. Revisa por qué la fila apuntaba ahí.',
      },
    })
    return retirado.count === 1 ? 'RETIRADO' : 'SIN_CAMBIO'
  }

  /**
   * Terminal row for a normalized lock key (serial with or without AVQD-, case-insensitive — the
   * serial rule of the heartbeat middleware). Deliberately NOT scoped by venue: `Terminal.serialNumber`
   * is globally unique and a terminal migrated to another venue still has to be recognised as "back",
   * or its old venue's UNKNOWN row would hold the global slot forever (the incident, again).
   */
  private async findTerminalForRow(row: { terminalId: string }): Promise<{ id: string; lastHeartbeat: Date | null } | null> {
    return prisma.terminal.findFirst({
      where: {
        OR: [
          { serialNumber: { equals: row.terminalId, mode: 'insensitive' } },
          { serialNumber: { equals: `AVQD-${row.terminalId}`, mode: 'insensitive' } },
        ],
      },
      select: { id: true, lastHeartbeat: true },
    })
  }

  /**
   * Reconcile UNKNOWN against recorded money. Connectivity stamps remain useful
   * diagnostics, but elapsed time and heartbeats never release an execution.
   * Previously released rows remain eligible for late financial reconciliation.
   */
  async reconcileUnknownRequests(
    now: Date = new Date(),
  ): Promise<{ completed: number; marked: number; released: number; reset: number; lateReconciled: number; aliasesRetirados: number }> {
    const rows = await retry(
      () =>
        prisma.terminalPaymentRequest.findMany({
          where: {
            status: TerminalPaymentRequestStatus.UNKNOWN,
            ...(this.unknownCursor
              ? {
                  OR: [
                    { createdAt: { gt: this.unknownCursor.createdAt } },
                    { createdAt: this.unknownCursor.createdAt, id: { gt: this.unknownCursor.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 200,
        }),
      { retries: 3, shouldRetry: shouldRetryDbConnectionError, context: 'terminal-payment-watchdog:findUnknown' },
    )

    const last = rows[rows.length - 1]
    this.unknownCursor = rows.length === 200 && last ? { createdAt: last.createdAt, id: last.id } : null

    // El barrido no libera por tiempo. Lo que sí hace es PREGUNTAR: a cada terminal en línea e
    // identificada con capacidad de sonda, una vez por pasada, por sus filas sin desenlace.
    const terminalesVistas = new Set<string>()
    let sondasEnviadas = 0
    for (const row of rows) {
      if (terminalesVistas.has(row.terminalId)) continue
      terminalesVistas.add(row.terminalId)
      const entry = terminalRegistry.getTerminal(row.terminalId)
      if (entry?.socketId && entry.venueId === row.venueId) {
        sondasEnviadas += await this.probeUnresolvedForTerminal(row.terminalId, row.venueId, entry.socketId).catch(() => 0)
      }
    }
    if (sondasEnviadas > 0)
      logger.info('🔎 [TerminalPayment watchdog] probes sent', { terminals: terminalesVistas.size, rows: sondasEnviadas })

    let completed = 0
    let marked = 0
    let released = 0
    let reset = 0
    let lateReconciled = 0
    let aliasesRetirados = 0

    for (const row of rows) {
      const payment = await this.findReconcilablePayment(row)
      // Codex R14-4: sin cobro propio que la cierre, una fila UNKNOWN que apunta a un Payment SIN procedencia suelta ese alias
      // (diferido por un cierre ajeno, o contaminación histórica): recuperable desde el barrido, no sólo desde una bitácora.
      if (!payment && row.paymentId && (await this.retirarAliasPropio(row))) aliasesRetirados++
      if (payment) {
        const r = await prisma.terminalPaymentRequest.updateMany({
          where: { id: row.id, status: TerminalPaymentRequestStatus.UNKNOWN },
          data: {
            status: TerminalPaymentRequestStatus.COMPLETED,
            paymentId: payment.id,
            lateResult: true,
            ...marcaDeDescuadre(row, payment).campos,
          },
        })
        if (r.count > 0) {
          completed += r.count
          // 🚨 stable token for Better Stack — do NOT rename.
          logger.error(
            `🚨 [Terminal-payment watchdog] Payment recorded for an UNKNOWN request — reconciled to COMPLETED (money moved after the POS gave up)`,
            {
              requestId: row.requestId,
              paymentId: payment.id,
              terminalId: row.terminalId,
              venueId: row.venueId,
            },
          )
          await logAction({
            venueId: row.venueId,
            action: 'TERMINAL_PAYMENT_LATE_RECONCILED',
            entity: 'TerminalPaymentRequest',
            entityId: row.id,
            data: { requestId: row.requestId, terminalId: row.terminalId, paymentId: payment.id, priorStatus: row.status },
          })
        }
        continue
      }

      const terminal = await this.findTerminalForRow(row)
      const lastHeartbeat = terminal?.lastHeartbeat ?? null

      if (!row.terminalReturnedAt) {
        if (lastHeartbeat && lastHeartbeat.getTime() > row.expiresAt.getTime()) {
          // Stamped with the time we OBSERVED it, not the heartbeat's own time: after a server
          // outage the heartbeat may be 10 min old and would otherwise satisfy the grace at once.
          const r = await prisma.terminalPaymentRequest.updateMany({
            where: { id: row.id, status: TerminalPaymentRequestStatus.UNKNOWN, terminalReturnedAt: null },
            data: { terminalReturnedAt: now },
          })
          marked += r.count
        }
        continue
      }

      // Keep connectivity diagnostics current without drawing financial conclusions.
      if (!lastHeartbeat || lastHeartbeat.getTime() < now.getTime() - TERMINAL_ALIVE_WINDOW_MS) {
        const r = await prisma.terminalPaymentRequest.updateMany({
          where: { id: row.id, status: TerminalPaymentRequestStatus.UNKNOWN, terminalReturnedAt: row.terminalReturnedAt },
          data: { terminalReturnedAt: null },
        })
        reset += r.count
        continue
      }

      // El latido y la gracia sólo describen CONECTIVIDAD: no certifican que la autorización
      // terminara ni que su desenlace quedara guardado. Por eso lo que sigue NO acredita «no se
      // cobró» — suelta la RANURA y conserva la obligación:
      //
      //   · la fila se queda pendiente de desenlace ⇒ su VENTA sigue cerrada a un cobro nuevo, en
      //     ésta y en cualquier otra terminal de la sucursal;
      //   · la SONDA le sigue preguntando a la terminal (`SIN_DESENLACE_ACREDITADO` se deriva de
      //     UNRESOLVED, no del predicado de ranura), así que la evidencia real todavía puede llegar;
      //   · y si aparece un `Payment` tardío, `closeRowFromPaymentTx` lo reconcilia gritando 🚨.
      //
      // 🔴 Sin esto la terminal queda muerta para siempre cuando la evidencia no llega nunca —el
      // caso medido en hardware el 12-sep: la app se reinicia a media venta y su bandeja pierde la
      // solicitud, así que NADIE puede contestar. Es la queja que originó este trabajo, y el
      // incidente de Testarudo del 4-sep (3 h sin poder cobrar).
      if (now.getTime() < row.terminalReturnedAt.getTime() + UNKNOWN_AUTO_RELEASE_GRACE_MS) continue

      const r = await prisma.terminalPaymentRequest.updateMany({
        where: { id: row.id, status: TerminalPaymentRequestStatus.UNKNOWN },
        data: { status: TerminalPaymentRequestStatus.TIMED_OUT, failureCode: 'AUTO_RELEASED' },
      })
      if (r.count === 0) continue // un resultado tardío la cerró antes — su respuesta gana
      released += r.count

      const ageMinutes = Math.floor((now.getTime() - row.createdAt.getTime()) / 60_000)
      // 🚨 token estable para Better Stack — NO renombrar.
      logger.error(`🚨 [Terminal-payment watchdog] UNKNOWN request auto-released — terminal came back with no card payment`, {
        requestId: row.requestId,
        terminalId: row.terminalId,
        venueId: row.venueId,
        orderId: row.orderId,
        amountCents: row.amountCents,
        terminalReturnedAt: row.terminalReturnedAt.toISOString(),
        ageMinutes,
      })
      await logAction({
        venueId: row.venueId,
        action: 'TERMINAL_PAYMENT_AUTO_RELEASED',
        entity: 'TerminalPaymentRequest',
        entityId: row.id,
        data: {
          requestId: row.requestId,
          terminalId: row.terminalId,
          amountCents: row.amountCents,
          orderId: row.orderId,
          terminalReturnedAt: row.terminalReturnedAt.toISOString(),
          graceMs: UNKNOWN_AUTO_RELEASE_GRACE_MS,
          reason: 'La terminal volvió a reportar y pasaron 20 min sin ningún pago con tarjeta para este cobro',
        },
      })
      void sendOpsAlert({
        subject: `Terminal ${row.terminalId} liberada sola tras un cobro sin respuesta (${row.venueId})`,
        lines: [
          `El cobro de $${(row.amountCents / 100).toFixed(2)} (requestId ${row.requestId}, orden ${row.orderId ?? 'sin orden'}) quedó sin respuesta ${ageMinutes} min.`,
          'La terminal volvió a reportar y en 20 minutos no apareció ningún pago con tarjeta, así que el servidor liberó LA TERMINAL. Ya se puede volver a cobrar en ella.',
          'La VENTA sigue protegida: no se puede volver a cobrar esa misma cuenta en ninguna terminal hasta que su desenlace conste.',
          'Si más tarde llegara un pago de ese cobro, el servidor lo reconcilia como cobrado y avisa con 🚨 (revisar que la orden no quede pagada dos veces).',
        ],
      })
    }

    // Released rows are not forgotten: a payment recorded afterwards WITHOUT the request id (old
    // offline queues) never reaches closeRowFromPaymentTx, and the status endpoint would keep
    // answering "timeout" — an invitation to charge again. Sweep them for a bounded window.
    const releasedRows = await retry(
      () =>
        prisma.terminalPaymentRequest.findMany({
          where: {
            status: TerminalPaymentRequestStatus.TIMED_OUT,
            failureCode: { in: RELEASE_FAILURE_CODES },
            updatedAt: { gte: new Date(now.getTime() - RELEASED_LATE_RECONCILE_WINDOW_MS) },
          },
          orderBy: { updatedAt: 'asc' },
          take: 200,
        }),
      { retries: 3, shouldRetry: shouldRetryDbConnectionError, context: 'terminal-payment-watchdog:findReleased' },
    )
    for (const row of releasedRows) {
      const payment = await this.findReconcilablePayment(row)
      if (!payment) continue
      const r = await prisma.terminalPaymentRequest.updateMany({
        where: { id: row.id, status: TerminalPaymentRequestStatus.TIMED_OUT },
        data: {
          status: TerminalPaymentRequestStatus.COMPLETED,
          paymentId: payment.id,
          lateResult: true,
          ...marcaDeDescuadre(row, payment).campos,
        },
      })
      if (r.count === 0) continue
      lateReconciled += r.count
      // 🚨 stable token for Better Stack — do NOT rename. This is the double-charge alarm: the slot
      // was freed and the money then showed up → someone must check the order is not paid twice.
      logger.error(
        `🚨 [Terminal-payment watchdog] Payment recorded for a RELEASED request — reconciled to COMPLETED (check the order for a double charge)`,
        {
          requestId: row.requestId,
          paymentId: payment.id,
          terminalId: row.terminalId,
          venueId: row.venueId,
          orderId: row.orderId,
          failureCode: row.failureCode,
        },
      )
      await logAction({
        venueId: row.venueId,
        action: 'TERMINAL_PAYMENT_LATE_RECONCILED',
        entity: 'TerminalPaymentRequest',
        entityId: row.id,
        data: {
          requestId: row.requestId,
          terminalId: row.terminalId,
          paymentId: payment.id,
          priorStatus: row.status,
          failureCode: row.failureCode,
        },
      })
      void sendOpsAlert({
        subject: `Terminal ${row.terminalId}: llegó el pago de un cobro YA liberado — revisar doble cobro (${row.venueId})`,
        lines: [
          `El cobro ${row.requestId} (orden ${row.orderId ?? 'sin orden'}) se había liberado como sin respuesta y ahora aparece un pago con tarjeta (${payment.id}).`,
          'Revisa que la orden no haya quedado pagada dos veces; si sí, hay que devolver uno de los dos cobros.',
        ],
      })
    }

    if (completed || marked || released || reset || lateReconciled) {
      logger.info(`🧹 [Terminal-payment watchdog] unknown sweep`, {
        completed,
        marked,
        released,
        reset,
        lateReconciled,
        scanned: rows.length,
      })
    }
    return { completed, marked, released, reset, lateReconciled, aliasesRetirados }
  }

  /**
   * Manual release (MCP / superadmin / a manager on the tablet). Same money rule as the
   * watchdog: if a reconcilable card payment exists the row is closed as COMPLETED and NOT
   * released — nobody frees a slot on top of money. Tenant-scoped by venueId in every query.
   */
  async releaseUnknownRequest(input: {
    requestId: string
    venueId: string
    actor: { staffId?: string | null; source: 'MCP' | 'SUPERADMIN' | 'MOBILE' }
    reason: string
  }): Promise<{ requestId: string; released: boolean; status: TerminalPaymentRequestStatus | null; paymentId?: string }> {
    const { requestId, venueId, actor, reason } = input
    const row = await prisma.terminalPaymentRequest.findFirst({ where: { requestId, venueId } })
    if (!row) return { requestId, released: false, status: null }
    if (row.status !== TerminalPaymentRequestStatus.UNKNOWN) {
      return { requestId, released: false, status: row.status, paymentId: row.paymentId ?? undefined }
    }

    const payment = await this.findReconcilablePayment(row)
    if (payment) {
      const rc = await prisma.terminalPaymentRequest.updateMany({
        where: { id: row.id, venueId, status: TerminalPaymentRequestStatus.UNKNOWN },
        data: {
          status: TerminalPaymentRequestStatus.COMPLETED,
          paymentId: payment.id,
          lateResult: true,
          ...marcaDeDescuadre(row, payment).campos,
        },
      })
      if (rc.count === 0) {
        // Someone else closed it first (late socket result / REST record): report what it became.
        const fresh = await prisma.terminalPaymentRequest.findFirst({
          where: { requestId, venueId },
          select: { status: true, paymentId: true },
        })
        return { requestId, released: false, status: fresh?.status ?? null, paymentId: fresh?.paymentId ?? undefined }
      }
      logger.error(`🚨 [TerminalPayment] Manual release refused — a card payment exists for the UNKNOWN request; reconciled to COMPLETED`, {
        requestId,
        venueId,
        paymentId: payment.id,
        source: actor.source,
      })
      await logAction({
        staffId: actor.staffId ?? null,
        venueId,
        action: 'TERMINAL_PAYMENT_LATE_RECONCILED',
        entity: 'TerminalPaymentRequest',
        entityId: row.id,
        data: { requestId, terminalId: row.terminalId, paymentId: payment.id, priorStatus: row.status, source: actor.source, reason },
      })
      return { requestId, released: false, status: TerminalPaymentRequestStatus.COMPLETED, paymentId: payment.id }
    }

    // Neither elapsed time, a reconnect nor an operator's request proves that
    // the processor stopped executing. Keep the reservation until an explicit
    // terminal outcome or exact recorded payment resolves it.
    logger.warn('[TerminalPayment] Release awaits execution confirmation', { requestId, venueId, source: actor.source })
    return { requestId, released: false, status: TerminalPaymentRequestStatus.UNKNOWN }
  }

  /**
   * Send a receipt print request to a terminal and wait for the result.
   */
  async printReceiptOnTerminal(request: TerminalReceiptPrintRequest): Promise<TerminalReceiptPrintResult> {
    const { terminalId, venueId } = request
    const terminalEntry = terminalRegistry.getTerminal(terminalId)
    if (!terminalEntry) {
      throw new Error(`La terminal ${terminalId} no está conectada`)
    }
    if (!terminalEntry.socketId) {
      throw new Error(`La terminal ${terminalId} está registrada pero no tiene conexión de socket. Reinicia la app de la terminal.`)
    }
    const socketId = terminalEntry.socketId

    const io = socketManager.getServer()
    if (!io) {
      throw new Error('Servidor de Socket.IO no inicializado')
    }

    const requestId = request.requestId || uuidv4()

    return new Promise<TerminalReceiptPrintResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingReceiptPrints.delete(requestId)
        logger.warn(`⏰ [TerminalReceiptPrint] Request timed out`, { requestId, terminalId })
        resolve({
          requestId,
          status: 'timeout',
          errorMessage: 'La terminal no respondió a la impresión',
        })
      }, RECEIPT_PRINT_TIMEOUT_MS)

      this.pendingReceiptPrints.set(requestId, {
        resolve,
        reject,
        timeout,
        requestId,
        terminalId,
        venueId,
        createdAt: new Date(),
      })

      io.to(socketId).emit('terminal:print_receipt_request', {
        requestId,
        terminalId,
        venueId,
        receipt: request.receipt,
        timestamp: new Date().toISOString(),
      })
      logger.info(`🖨️ [TerminalReceiptPrint] Emitted to socket ${socketId}`, { requestId, terminalId })
    })
  }

  /**
   * Handle receipt print result from a terminal.
   */
  handleReceiptPrintResult(result: TerminalReceiptPrintResult): boolean {
    const pending = this.pendingReceiptPrints.get(result.requestId)
    if (!pending) {
      logger.warn(`⚠️ [TerminalReceiptPrint] No pending print request for requestId`, {
        requestId: result.requestId,
      })
      return false
    }

    clearTimeout(pending.timeout)
    this.pendingReceiptPrints.delete(result.requestId)

    logger.info(`🖨️ [TerminalReceiptPrint] Result received`, {
      requestId: result.requestId,
      status: result.status,
      terminalId: pending.terminalId,
    })

    pending.resolve(result)
    return true
  }

  /**
   * Abrir en una terminal la devolución de un cobro con tarjeta.
   *
   * 🔴 Este evento NO autoriza que se mueva dinero: le dice a la terminal
   * "abre la pantalla de devolución de ESTE cobro". Quien la completa es una
   * persona en el aparato, y el registro en Avoqado sigue pasando por la ruta
   * de reembolsos de siempre —con su candado de fila y su validación de monto
   * reembolsable—. Por eso no hace falta una fila durable de arbitraje: si el
   * evento se pierde o se duplica, lo peor que pasa es que se abre una
   * pantalla de más, y ninguna devolución ocurre sin que alguien la confirme.
   */
  async requestRefundOnTerminal(request: TerminalRefundRequest): Promise<TerminalRefundResult> {
    const { terminalId, venueId, paymentId } = request

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, venueId: true, status: true, method: true, amount: true, tipAmount: true, processorData: true },
    })

    const processorData = (payment?.processorData ?? {}) as { refundedAmount?: number | string }
    const target = resolveTerminalRefundTarget(
      payment
        ? {
            id: payment.id,
            venueId: payment.venueId,
            status: payment.status,
            method: payment.method,
            amount: Number(payment.amount),
            tipAmount: Number(payment.tipAmount),
            refundedAmount: Number(processorData.refundedAmount ?? 0),
          }
        : null,
      venueId,
    )

    if (!target.eligible) {
      logger.warn(`🚫 [TerminalRefund] Cobro no elegible para devolución en terminal`, {
        paymentId,
        venueId,
        terminalId,
        reason: target.reason,
      })
      throw new BadRequestError(target.message)
    }

    const terminalEntry = terminalRegistry.getTerminal(terminalId)
    if (!terminalEntry) {
      throw new Error(`La terminal ${terminalId} no está conectada`)
    }
    if (terminalEntry.venueId !== venueId) {
      // Misma defensa que el cobro: nunca se le habla a la terminal de otro negocio.
      throw new BadRequestError('La terminal no pertenece a este establecimiento')
    }
    if (!terminalEntry.socketId) {
      throw new Error(`La terminal ${terminalId} está registrada pero no tiene conexión de socket. Reinicia la app de la terminal.`)
    }
    const socketId = terminalEntry.socketId

    // Una terminal hace UNA transacción EMV a la vez: si está a media venta,
    // abrirle una devolución encima le quitaría la pantalla al cliente que
    // está pagando. Se reporta QUIÉN la tiene ocupada, igual que en el cobro,
    // para que el cajero no se quede adivinando.
    const blocker = await prisma.terminalPaymentRequest.findFirst({
      where: { terminalId: normalizeTerminalId(terminalId), venueId, status: { in: SLOT_HELD } },
      select: { requestId: true, amountCents: true, senderDevice: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    })
    if (blocker) {
      throw new TerminalBusyError(`La terminal ${terminalId} está ocupada con un cobro. Espera a que termine e inténtalo de nuevo.`, {
        requestId: blocker.requestId,
        amountCents: blocker.amountCents,
        senderDevice: blocker.senderDevice ?? undefined,
        ageSeconds: Math.max(0, Math.floor((Date.now() - blocker.createdAt.getTime()) / 1000)),
      })
    }

    const io = socketManager.getServer()
    if (!io) {
      throw new Error('Servidor de Socket.IO no inicializado')
    }

    const requestId = request.requestId || uuidv4()

    return new Promise<TerminalRefundResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRefundRequests.delete(requestId)
        logger.warn(`⏰ [TerminalRefund] La terminal no confirmó que abrió la devolución`, { requestId, terminalId, paymentId })
        resolve({
          requestId,
          status: 'timeout',
          errorMessage: 'La terminal no respondió. Revisa que la app esté abierta.',
        })
      }, REFUND_OPEN_TIMEOUT_MS)

      this.pendingRefundRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        requestId,
        terminalId,
        venueId,
        paymentId,
        createdAt: new Date(),
      })

      io.to(socketId).emit('terminal:refund_request', {
        requestId,
        terminalId,
        venueId,
        paymentId,
        // Informativo para la pantalla de la terminal: lo que manda al validar
        // es el servicio de reembolsos, no este número.
        maxRefundableCents: target.remainingRefundableCents,
        reason: request.reason,
        requestedBy: request.requestedBy,
        timestamp: new Date().toISOString(),
      })
      logger.info(`↩️ [TerminalRefund] Devolución enviada a la terminal`, { requestId, terminalId, paymentId, venueId })
    })
  }

  /**
   * ACK de la terminal: abrió (o no pudo abrir) la pantalla de devolución.
   */
  handleRefundRequestResult(result: TerminalRefundResult): boolean {
    const pending = this.pendingRefundRequests.get(result.requestId)
    if (!pending) {
      logger.warn(`⚠️ [TerminalRefund] Llegó un ACK sin solicitud pendiente`, { requestId: result.requestId })
      return false
    }

    clearTimeout(pending.timeout)
    this.pendingRefundRequests.delete(result.requestId)

    logger.info(`↩️ [TerminalRefund] ACK recibido`, {
      requestId: result.requestId,
      status: result.status,
      terminalId: pending.terminalId,
      paymentId: pending.paymentId,
    })

    pending.resolve(result)
    return true
  }

  /**
   * Cancel a pending payment and notify the terminal.
   * requestId ensures TPV only cancels if it's still processing THAT specific payment.
   * The row goes to CANCEL_REQUESTED (still holds the slot): if the card was
   * already authorized, a later result wins → COMPLETED. Silence from the
   * terminal leaves the outcome unknown and never certifies a cancellation.
   */
  async cancelPayment(
    terminalId: string,
    requestId: string | undefined,
    reason: string | undefined,
    venueId: string,
  ): Promise<CancelPaymentOutcome> {
    // Legacy callers without an identity cannot safely cancel an arbitrary live sale.
    if (!requestId) return { cancelIntent: 'MISSING_REQUEST_ID', cancelEmitted: false, payment: null }
    const terminalEntry = terminalRegistry.getTerminal(terminalId)

    // The cancel INTENT must be recorded even when the terminal is unreachable:
    // returning early used to leave the row PENDING/SENT holding the slot until
    // expiresAt (5 min) while the POS had already moved on. The row CAS + long-poll
    // resolve run regardless; only the socket emit needs a live terminal. `venueId`
    // scopes the write so a requestId alone can never touch another venue's row.
    if (requestId) {
      // Mark the durable row as cancel-requested (CAS, still holds the slot).
      try {
        const intent = await prisma.terminalPaymentRequest.updateMany({
          where: { requestId, venueId, terminalId: normalizeTerminalId(terminalId), status: { in: IN_FLIGHT } },
          data: { status: TerminalPaymentRequestStatus.CANCEL_REQUESTED },
        })
        if (intent.count === 0) {
          // 🔴 La intención no se registró. `payment` (releído) es lo que dice POR QUÉ y con qué desenlace quedó el
          // cobro: sin él, `success:false` mezclaba «no existe», «ya era final» y «terminal apagada» en un solo dato
          // que las apps no podían distinguir — y ninguna de las tres se parece a las otras.
          const fila = await prisma.terminalPaymentRequest.findFirst({ where: { requestId, venueId } })
          return fila
            ? { cancelIntent: 'ALREADY_FINAL', cancelEmitted: false, payment: proyectarEstado(fila) }
            : { cancelIntent: 'NOT_FOUND', cancelEmitted: false, payment: null }
        }
      } catch (err) {
        logger.error(`❌ [TerminalPayment] cancel row update failed`, {
          requestId,
          error: err instanceof Error ? err.message : String(err),
        })
        // No command is sent unless the durable intent exists. A reconnect can
        // replay a saved cancellation, never an intent that disappeared on crash.
        throw err
      }

      // Resolve the long-poll so the POS UI unblocks (existing behavior).
      const pending = this.pendingPayments.get(requestId)
      if (pending) {
        clearTimeout(pending.timeout)
        this.pendingPayments.delete(requestId)
        pending.resolve({
          requestId,
          status: 'timeout',
          errorMessage: 'Cancelación solicitada. Confirma el resultado en la terminal antes de volver a cobrar.',
        })
      }
    }

    // `cancelEmitted` significa EMITIDO a un socket del registro. No promete recepción: la terminal puede estar
    // dormida (Doze) con el socket todavía registrado, y el APK publicado ni siquiera contesta la disposición.
    const cancelEmitted = await this.emitCancelToTerminal(terminalEntry?.socketId, terminalId, requestId, reason)
    // Se relee DESPUÉS del CAS y de la emisión: la terminal puede haber contestado ACCEPTED en ese hueco, y la
    // proyección tiene que decir la verdad de ESTE instante, no la que se supuso al escribir la intención.
    const fila = await prisma.terminalPaymentRequest.findFirst({ where: { requestId, venueId } })
    return { cancelIntent: 'RECORDED', cancelEmitted, payment: fila ? proyectarEstado(fila) : null }
  }

  /**
   * S1 (checkpoint 1 del webhook como primer confirmador, Codex 13-sep-2026). La terminal anuncia
   * `terminal:payment_attempt_opened { requestId, attemptId }` tras abrir un intento en su libreta, y aquí se decide
   * el DUEÑO de ese intento una sola vez y para siempre:
   *
   *  · sólo la terminal AUTENTICADA dueña de la solicitud (mismo venue, misma llave de terminal) puede vincular —
   *    la identidad sale del socket, nunca del payload;
   *  · `attemptId` es único global: el mismo intento sobre OTRA solicitud es 🚨 y NO se guarda;
   *  · repetir el mismo vínculo es idempotente, aunque la solicitud ya haya terminado;
   *  · sobre una solicitud cerrada, un intento NUEVO se guarda como EVIDENCIA TARDÍA: correlaciona un webhook o una
   *    consulta por intento, pero no autoriza volver a ejecutar el SDK. Con la ranura retenida (UNKNOWN) el intento
   *    sigue siendo en vuelo: es justo la evidencia que a esa fila le faltaba.
   *
   * El ack sale DESPUÉS de que la fila quedó escrita (la escritura se espera antes de contestar); un timeout de ese
   * ack en la terminal no bloquea el cobro ni autoriza otro intento — el registro y la recuperación siguen su camino
   * actual. Dos entregas simultáneas del mismo vínculo las resuelve el índice único: el perdedor relee al dueño.
   * Sin `ActivityLog`: es tráfico de cada cobro, no una anomalía.
   */
  async handleAttemptOpenedFromSocket(
    event: { requestId?: unknown; attemptId?: unknown },
    terminal: { socketId: string | null; terminalId: string; venueId: string },
  ): Promise<AttemptLinkAck> {
    const requestId = typeof event.requestId === 'string' ? event.requestId.trim() : ''
    const attemptId = typeof event.attemptId === 'string' ? event.attemptId.trim() : ''
    if (!requestId || !attemptId || requestId.length > 64 || attemptId.length > 64) return { success: false, reason: 'INVALID' }

    const terminalKey = normalizeTerminalId(terminal.terminalId)
    const row = await prisma.terminalPaymentRequest.findFirst({
      where: { requestId, venueId: terminal.venueId, terminalId: terminalKey },
      select: { requestId: true, venueId: true, status: true },
    })
    if (!row) {
      logger.warn('🛑 [TerminalPayment] Attempt link rejected: request is not owned by authenticated terminal socket', {
        requestId,
        attemptId,
        terminalId: terminal.terminalId,
        venueId: terminal.venueId,
        socketId: terminal.socketId,
      })
      return { success: false, reason: 'NOT_OWNER' }
    }
    // Codex R1 (P2): el permiso de EJECUTAR se contesta con el estado VIGENTE tras escribir el vínculo (una cancelación o
    // confirmación entre la lectura y la escritura no puede colarse como «autorizado»), y sólo lo da una solicitud en
    // vuelo de verdad (PENDING/SENT): CANCEL_REQUESTED y UNKNOWN retienen la ranura y conservan la evidencia, pero no
    // autorizan otra ejecución.
    const AUTORIZA_EJECUCION: TerminalPaymentRequestStatus[] = [TerminalPaymentRequestStatus.PENDING, TerminalPaymentRequestStatus.SENT]
    const veredicto = async (outcome: 'LINKED' | 'ALREADY_LINKED' | 'LATE_EVIDENCE'): Promise<AttemptLinkAck> => {
      const vigente = await prisma.terminalPaymentRequest.findFirst({
        where: { requestId, venueId: terminal.venueId },
        select: { status: true },
      })
      const status = vigente?.status ?? row.status
      return {
        success: true,
        outcome: outcome === 'ALREADY_LINKED' ? outcome : SLOT_HELD.includes(status) ? 'LINKED' : 'LATE_EVIDENCE',
        requestStatus: status,
        executionAuthorized: AUTORIZA_EJECUCION.includes(status),
      }
    }
    const otroDueno = (requestIdDueno: string): AttemptLinkAck => {
      logger.error('🚨 [TerminalPayment] attemptId already belongs to ANOTHER request — link refused, nothing written', {
        attemptId,
        requestId,
        ownerRequestId: requestIdDueno,
        terminalId: terminal.terminalId,
        venueId: terminal.venueId,
      })
      return { success: false, reason: 'ATTEMPT_OWNED_BY_OTHER_REQUEST' }
    }

    // 🔴 El índice único de `attemptId` es el ÚNICO árbitro del dueño: no hay pre-lectura. Una lectura previa
    // «para ahorrarse la excepción» esconde la carrera entre entregas simultáneas y deja este `catch` como código
    // muerto — el sabotaje de quitarlo no tumbaba ninguna prueba (13-sep). Un vínculo repetido o un intento de
    // otra solicitud llegan aquí como P2002 y se contestan por lo que quedó ESCRITO, nunca por lo que se leyó antes.
    // Codex R4-5 / R5-5: un approved de ESTE intento que llegó ANTES del vínculo pudo caer en el matcher débil y quedar
    // PROCESSED sobre el Payment de OTRO cobro del mismo segundo. El vínculo y la REAPERTURA de esos eventos son UNA
    // transacción: no existe vínculo sin que se hayan reabierto (el worker los confirma después por el vínculo, S2). Si la
    // reapertura falla, el vínculo no se escribe y la terminal reintenta el anuncio — el ACK sólo llega con lo durable.
    const { recuperarEventosDebilesPorVinculo } = await import('./tpv/angelpay-webhook.service')
    const { OPCIONES_DE_TRANSACCION_DEL_INTENTO, candadoDeIntento } = await import('./tpv/candadoDeIntento')
    try {
      await prisma.$transaction(async tx => {
        // Codex R6-2: la EXCLUSIÓN por intento va PRIMERO — antes del INSERT y de consultar eventos. Un escritor débil que
        // conozca esta llave espera aquí; cuando este commit lo suelte, verá el vínculo publicado y decidirá por él.
        await candadoDeIntento(tx, attemptId)
        await tx.terminalPaymentAttemptLink.create({ data: { requestId, attemptId, venueId: row.venueId, terminalId: terminalKey } })
        await recuperarEventosDebilesPorVinculo(attemptId, requestId, tx)
      }, OPCIONES_DE_TRANSACCION_DEL_INTENTO)
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const dueno = await prisma.terminalPaymentAttemptLink.findUnique({ where: { attemptId }, select: { requestId: true } })
        if (dueno?.requestId === requestId) {
          // Codex R5-5: el vínculo REPETIDO también vuelve a mirar los eventos débiles (idempotente y barato). Aquí va fuera
          // de la transacción del vínculo, que ya es durable: un fallo se registra y no cambia el ACK.
          try {
            await recuperarEventosDebilesPorVinculo(attemptId, requestId)
          } catch (reaperturaError) {
            logger.error('⚠️ [TerminalPayment] No se pudieron reabrir los eventos débiles al repetir el vínculo', {
              attemptId,
              requestId,
              error: reaperturaError instanceof Error ? reaperturaError.message : String(reaperturaError),
            })
          }
          return await veredicto('ALREADY_LINKED')
        }
        return otroDueno(dueno?.requestId ?? 'desconocido')
      }
      throw error
    }
    return await veredicto(SLOT_HELD.includes(row.status) ? 'LINKED' : 'LATE_EVIDENCE')
  }

  /**
   * S5 (checkpoint 1): el webhook fue el PRIMER confirmador de la solicitud. Despierta al POS que sigue esperando en el
   * long-poll (hoy cerrar la fila no lo resolvía: 5 min y un 504) y avisa a la terminal por su socket, sin ACK
   * obligatorio — la terminal decide qué hacer con su libreta (checkpoint 2: nunca cierra AUTORIZANDO con el SDK
   * dentro). Si el aviso se pierde o el POS vive en otra instancia, el resultado durable ya está en la fila.
   */
  async confirmFromWebhook(input: {
    requestId: string
    venueId: string
    paymentId: string
    attemptId: string
    amountCents: number
    tipCents: number
  }): Promise<{ posAwakened: boolean; terminalNotified: boolean }> {
    let posAwakened = false
    const pending = this.pendingPayments.get(input.requestId)
    if (pending && pending.venueId === input.venueId) {
      clearTimeout(pending.timeout)
      this.pendingPayments.delete(input.requestId)
      pending.resolve({ requestId: input.requestId, status: 'success', paymentId: input.paymentId })
      posAwakened = true
    }
    let terminalNotified = false
    const row = await prisma.terminalPaymentRequest.findFirst({
      where: { requestId: input.requestId, venueId: input.venueId },
      select: { terminalId: true },
    })
    const entry = row ? terminalRegistry.getTerminal(row.terminalId) : undefined
    const socket = entry?.socketId ? socketManager.getServer()?.sockets.sockets.get(entry.socketId) : undefined
    if (socket && entry?.venueId === input.venueId) {
      socket.emit('terminal:payment_confirmed', {
        requestId: input.requestId,
        attemptId: input.attemptId,
        paymentId: input.paymentId,
        amountCents: input.amountCents,
        tipCents: input.tipCents,
        via: 'webhook',
        timestamp: new Date().toISOString(),
      })
      terminalNotified = true
    }
    logger.info('📣 [TerminalPayment] Confirmado por webhook', {
      requestId: input.requestId,
      venueId: input.venueId,
      paymentId: input.paymentId,
      posAwakened,
      terminalNotified,
    })
    return { posAwakened, terminalNotified }
  }

  /** El dueño de un intento (S1), para el webhook (S2) y la consulta por intento (S6). `null` = intento desconocido. */
  async findAttemptLink(attemptId: string): Promise<{ requestId: string; venueId: string; terminalId: string; createdAt: Date } | null> {
    if (!attemptId) return null
    return prisma.terminalPaymentAttemptLink.findUnique({
      where: { attemptId },
      select: { requestId: true, venueId: true, terminalId: true, createdAt: true },
    })
  }

  /**
   * S6: la consulta durable POR INTENTO que hace la terminal al reconectar (checkpoint 2, N3). Contesta dos cosas por
   * separado —qué pasó con ESTE intento y en qué está la solicitud— y sólo para intentos de la terminal autenticada y
   * del venue del token. Un intento desconocido, de otra terminal o de otro venue se contesta IGUAL (`null`): sin
   * evidencia. 🔴 Nunca se traduce a «no cobrado»: la ausencia de Payment, un timeout de la solicitud o un rechazo
   * aislado no acreditan ausencia de cargo (S7 admite un `approved` posterior del mismo intento).
   * Nunca atribuye a A el Payment de B: el Payment del intento es el de SU llave (`idempotencyKey === attemptId`);
   * el ganador de la solicitud viaja aparte, en `request`.
   */
  async consultarIntentoDeTerminal(input: {
    attemptId: string
    venueId: string
    terminalSerial: string
  }): Promise<TerminalAttemptStatus | null> {
    const attemptId = typeof input.attemptId === 'string' ? input.attemptId.trim() : ''
    const terminalKey = typeof input.terminalSerial === 'string' ? normalizeTerminalId(input.terminalSerial) : ''
    if (!attemptId || attemptId.length > 64 || !terminalKey || !input.venueId) return null

    const link = await this.findAttemptLink(attemptId)
    if (!link || link.venueId !== input.venueId || normalizeTerminalId(link.terminalId) !== terminalKey) return null
    const row = await prisma.terminalPaymentRequest.findFirst({ where: { requestId: link.requestId, venueId: input.venueId } })
    if (!row) return null

    // Codex R1 (P1-7 / P2): la EVIDENCIA se acota al venue del vínculo (un approved recibido por el merchant de OTRO venue
    // —LINK_VENUE_MISMATCH— no es evidencia de este intento — ver la consulta SQL de evidencia más abajo); y un Payment
    // con `type` NULL (fila vieja) cuenta igual que uno REGULAR.
    const [candidato, ganador] = await Promise.all([
      prisma.payment.findFirst({
        where: { venueId: input.venueId, idempotencyKey: attemptId, OR: [{ type: null }, { type: { not: PaymentType.REFUND } }] },
        select: {
          id: true,
          status: true,
          amount: true,
          tipAmount: true,
          idempotencyKey: true,
          terminalPaymentRequestId: true,
          processorData: true,
          terminal: { select: { serialNumber: true } },
        },
      }),
      row.paymentId
        ? prisma.payment.findUnique({ where: { id: row.paymentId }, select: { id: true, idempotencyKey: true } })
        : Promise.resolve(null),
    ])

    // Codex R1 (P1-7): el Payment con la llave del intento sólo es de ESTE intento si su procedencia lo ata a esta
    // solicitud (columna, huella o conciliación de segunda captura) o, sin solicitud, a esta terminal. Un Payment con
    // la misma llave pero de otra solicitud u otra terminal es una CONTRADICCIÓN: se conserva la incertidumbre
    // (NOT_RECORDED) y se declara, nunca se presenta como dinero propio.
    const datosCandidato =
      candidato?.processorData && typeof candidato.processorData === 'object' && !Array.isArray(candidato.processorData)
        ? (candidato.processorData as Record<string, unknown>)
        : null
    const reconciliacionCandidato =
      datosCandidato?.reconciliation && typeof datosCandidato.reconciliation === 'object'
        ? (datosCandidato.reconciliation as Record<string, unknown>)
        : null
    const serialKey = (valor: unknown): string | null => (typeof valor === 'string' && valor.trim() ? normalizeTerminalId(valor) : null)
    const atribuible =
      !!candidato &&
      (candidato.terminalPaymentRequestId === row.requestId ||
        datosCandidato?.terminalPaymentRequestId === row.requestId ||
        reconciliacionCandidato?.requestId === row.requestId ||
        (candidato.terminalPaymentRequestId == null &&
          datosCandidato?.terminalPaymentRequestId == null &&
          (serialKey(datosCandidato?.deviceSerialNumber) === terminalKey || serialKey(candidato.terminal?.serialNumber) === terminalKey)))
    const paymentContradiction = !!candidato && !atribuible
    if (paymentContradiction && candidato) {
      logger.error(
        '🚨 [TerminalPayment] Un Payment con la llave del intento NO es atribuible a esta solicitud/terminal — se conserva la incertidumbre',
        {
          attemptId,
          requestId: row.requestId,
          terminalKey,
          paymentId: candidato.id,
          paymentRequestId: candidato.terminalPaymentRequestId,
        },
      )
    }
    const pago = atribuible ? candidato : null

    // Evidencia del procesador SOBRE ESTE INTENTO: un `approved` cuenta aunque no haya creado dinero (importe distinto ⇒
    // conciliación); un veredicto distinto de approved es DECLINED; un evento sin `status` legible no es veredicto.
    // Codex R2/R3/R4 (P1-7 / P2): la evidencia también exige PROCEDENCIA, y se resuelve EXACTA en una sola consulta —
    // sin presupuesto de páginas que un intento con miles de eventos pudiera agotar. Un webhook firmado del mismo venue cuyo
    // serial es de otra terminal (S2 lo rechazó: `LINK_TERMINAL_MISMATCH`, o su serial normalizado no es el de esta
    // terminal) no es evidencia — es una CONTRADICCIÓN que se declara (`evidenceContradiction`), sin descartar un approved
    // legítimo de esta terminal con importe discrepante. El serial se normaliza en SQL con la MISMA regla que
    // `terminalIdentityKey` (trim, sin prefijo AVQD-, minúsculas). Codex R14-3: el estado bancario se clasifica con la MISMA regla
    // que el receptor y el backfill (`estadoBancarioSql`: tipo JSON + trim como JS): sólo APROBADO cuenta como aprobación y sólo
    // RECHAZADO como rechazo; `null` presente, un número, un objeto o una cadena vacía NO son veredicto (antes `->>` volvía texto
    // un `123` o un `{}` y S6 publicaba DECLINED sin rechazo bancario acreditado).
    // Lógica trivalente de SQL: un `errorReason` NULL (evento sano) no puede volver NULL la contradicción entera — por eso
    // `IS NOT DISTINCT FROM` y no `=`; sin eso, el approved propio del evento CONFIRMADO desaparecía de la evidencia.
    const evidencia = await prisma.$queryRaw<{ contradicciones: bigint | number; aprobadoAt: Date | null; veredictoAt: Date | null }[]>`
      WITH eventos AS (
        SELECT
          e."createdAt",
          e."errorReason",
          ${estadoBancarioSql(Prisma.sql`coalesce(e."payload"->'payload'->'status', e."payload"->'status')`)} AS estado,
          nullif(regexp_replace(coalesce(e."payload"->'payload'->>'terminalSerial', ''), ${PATRON_SQL_TRIM_COMO_JS}, '', 'g'), '') AS serial
        FROM "ProviderEventLog" e
        WHERE e."provider" = 'PAYMENT_PROCESSOR'
          AND e."attemptId" = ${attemptId}
          AND e."venueId" = ${link.venueId}
          AND e."eventId" LIKE 'angelpay-%'
      ), clasificados AS (
        SELECT
          "createdAt",
          estado,
          (
            "errorReason" IS NOT DISTINCT FROM 'LINK_TERMINAL_MISMATCH'
            OR (serial IS NOT NULL AND lower(regexp_replace(serial, '^AVQD-', '', 'i')) <> ${terminalKey})
          ) AS contradice
        FROM eventos
      )
      SELECT
        (SELECT count(*) FROM clasificados WHERE contradice) AS contradicciones,
        (SELECT max("createdAt") FROM clasificados WHERE NOT contradice AND estado = 'APROBADO') AS "aprobadoAt",
        (SELECT max("createdAt") FROM clasificados WHERE NOT contradice AND estado = 'RECHAZADO') AS "veredictoAt"`
    const resumen = evidencia[0] ?? { contradicciones: 0, aprobadoAt: null, veredictoAt: null }
    const evidenceContradiction = Number(resumen.contradicciones) > 0
    const propioAprobado = resumen.aprobadoAt ? { createdAt: new Date(resumen.aprobadoAt) } : null
    const propioConVeredicto = resumen.veredictoAt ? { createdAt: new Date(resumen.veredictoAt) } : null
    if (evidenceContradiction) {
      logger.error(
        '🚨 [TerminalPayment] Evidencia del procesador con el serial de OTRA terminal para este intento — no cuenta como evidencia',
        {
          attemptId,
          requestId: row.requestId,
          terminalKey,
        },
      )
    }
    const conVeredicto = propioAprobado ?? propioConVeredicto
    const processorEvidence: AttemptProcessorEvidence = propioAprobado ? 'APPROVED' : conVeredicto ? 'DECLINED' : 'NONE'

    const datos = pago ? datosCandidato : null
    const reconciliacion =
      datos?.reconciliation && typeof datos.reconciliation === 'object' && !Array.isArray(datos.reconciliation)
        ? (datos.reconciliation as Record<string, unknown>)
        : null
    // Codex R5 (P2): la evidencia PENDING puede ser de dos tipos (segunda captura o COLISIÓN de referencia, R4-6); ninguna
    // es «cobrado» ni «no cobrado» — la terminal las ve como lo que son.
    const evidenciaPendiente = !!pago && pago.status !== TransactionStatus.COMPLETED ? reconciliacion?.kind : null
    const esSegundaCaptura = evidenciaPendiente === 'POSSIBLE_SECOND_CAPTURE'
    const outcome: AttemptOutcome =
      pago?.status === TransactionStatus.COMPLETED
        ? 'RECORDED'
        : esSegundaCaptura
          ? 'SECOND_CAPTURE_EVIDENCE'
          : evidenciaPendiente === 'POSSIBLE_REFERENCE_COLLISION'
            ? 'REFERENCE_COLLISION_EVIDENCE'
            : 'NOT_RECORDED'
    const centavos = (valor: Prisma.Decimal | number | string | null | undefined) =>
      valor === null || valor === undefined ? null : new Prisma.Decimal(valor).mul(100).round().toNumber()

    let winnerAttemptId: string | null = null
    if (ganador?.idempotencyKey) {
      if (ganador.idempotencyKey === attemptId) winnerAttemptId = attemptId
      else {
        const vinculoDelGanador = await this.findAttemptLink(ganador.idempotencyKey)
        winnerAttemptId = vinculoDelGanador?.requestId === row.requestId ? ganador.idempotencyKey : null
      }
    }

    return {
      attemptId,
      requestId: row.requestId,
      attempt: {
        attemptId,
        outcome,
        paymentId: pago?.id ?? null,
        paymentStatus: pago?.status ?? null,
        recordedVia: pago ? (datos?.registradoVia === 'webhook' ? 'webhook' : 'terminal') : null,
        amountCents: pago ? centavos(pago.amount) : null,
        tipCents: pago ? centavos(pago.tipAmount) : null,
        isWinner: !!pago && row.paymentId === pago.id,
        winnerPaymentId: esSegundaCaptura
          ? ((typeof reconciliacion?.winnerPaymentId === 'string' ? reconciliacion.winnerPaymentId : null) ?? row.paymentId ?? null)
          : null,
        processorEvidence,
        processorEvidenceAt: conVeredicto?.createdAt.toISOString() ?? null,
        paymentContradiction,
        evidenceContradiction,
        linkedAt: link.createdAt.toISOString(),
      },
      request: { ...proyectarEstado(row), closedVia: row.closedVia ?? null, winnerAttemptId },
    }
  }

  /**
   * S5: recuperación del long-poll desde la FILA. Un POS que sigue esperando en memoria mientras la solicitud ya quedó
   * COMPLETED con Payment (el webhook confirmó desde otra instancia, o el aviso —socket o webhook— se perdió) recibe
   * el resultado durable en vez de un 504 a los 5 min. Sólo despierta con dinero acreditado (`CHARGED`); un desenlace
   * negativo o incierto sigue su camino de siempre (nunca se inventa). La llama el vigía cada tick, en un solo lote.
   */
  async resolvePendingFromDurableState(): Promise<{ resolved: number; checked: number }> {
    const esperando = [...this.pendingPayments.values()]
    if (esperando.length === 0) return { resolved: 0, checked: 0 }
    // Codex R1 (P2): por LOTES acotados — el mapa en memoria no tiene tope y una consulta con cientos de ids no es una consulta.
    const LOTE = 100
    const seleccion = {
      requestId: true,
      venueId: true,
      status: true,
      paymentId: true,
      resultJson: true,
      failureCode: true,
      cancelDisposition: true,
    } as const
    const rows: Prisma.TerminalPaymentRequestGetPayload<{ select: typeof seleccion }>[] = []
    for (let i = 0; i < esperando.length; i += LOTE) {
      const lote = esperando.slice(i, i + LOTE)
      rows.push(
        ...(await prisma.terminalPaymentRequest.findMany({
          where: {
            requestId: { in: lote.map(p => p.requestId) },
            status: TerminalPaymentRequestStatus.COMPLETED,
            paymentId: { not: null },
          },
          take: lote.length,
          select: seleccion,
        })),
      )
    }
    let resolved = 0
    for (const row of rows) {
      const pending = this.pendingPayments.get(row.requestId)
      if (!pending || pending.venueId !== row.venueId) continue
      if (desenlaceCanonico(row).outcome !== 'CHARGED') continue
      clearTimeout(pending.timeout)
      this.pendingPayments.delete(row.requestId)
      pending.resolve(resultFromRow(row))
      resolved++
      logger.info('🔁 [TerminalPayment] Long-poll resolved from durable state (notice lost or confirmed elsewhere)', {
        requestId: row.requestId,
        venueId: row.venueId,
        paymentId: row.paymentId,
      })
    }
    return { resolved, checked: esperando.length }
  }

  /** La fila al vencer el long-poll: el resultado durable si ya hay dinero acreditado, o `null` (incierto, como siempre). */
  private async desenlaceDurableAlVencer(requestId: string, venueId: string): Promise<TerminalPaymentResult | null> {
    try {
      const row = await prisma.terminalPaymentRequest.findFirst({
        where: { requestId, venueId },
        select: { requestId: true, status: true, paymentId: true, resultJson: true, failureCode: true, cancelDisposition: true },
      })
      if (!row || desenlaceCanonico(row).outcome !== 'CHARGED') return null
      return resultFromRow(row)
    } catch (error) {
      logger.error('❌ [TerminalPayment] Could not read durable state at long-poll timeout', { requestId, error: String(error) })
      return null
    }
  }

  /** Authenticated cancellation admission; this is distinct from a payment result. */
  async handleCancelDispositionFromSocket(
    event: { requestId: string; disposition: string },
    terminal: { socketId: string | null; terminalId: string; venueId: string },
  ): Promise<boolean> {
    if (!event.requestId || !['ACTIVE', 'ACCEPTED', 'ALREADY_RESOLVED'].includes(event.disposition)) return false
    const where = { requestId: event.requestId, venueId: terminal.venueId, terminalId: normalizeTerminalId(terminal.terminalId) }
    const row = await prisma.terminalPaymentRequest.findFirst({ where, select: { id: true, status: true } })
    if (!row) return false

    // A late/repeated cancellation cannot overwrite a financial result. The
    // terminal replays its actual result separately for ALREADY_RESOLVED.
    if (event.disposition === 'ALREADY_RESOLVED' || !SLOT_HELD.includes(row.status)) return true
    const accepted = event.disposition === 'ACCEPTED'
    const result: TerminalPaymentResult = {
      requestId: event.requestId,
      status: 'cancelled',
      errorMessage: 'Cancelado antes de iniciar el cobro',
    }
    const updated = await prisma.terminalPaymentRequest.updateMany({
      where: { ...where, status: { in: SLOT_HELD } },
      data: {
        cancelDisposition: event.disposition,
        ...(accepted ? { status: TerminalPaymentRequestStatus.CANCELLED, resultJson: result as unknown as Prisma.InputJsonValue } : {}),
      },
    })
    if (accepted && updated.count > 0) {
      const pending = this.pendingPayments.get(event.requestId)
      if (pending?.venueId === terminal.venueId) {
        clearTimeout(pending.timeout)
        this.pendingPayments.delete(event.requestId)
        pending.resolve(result)
      }
    }
    return true
  }

  /**
   * SONDA DE CONCILIACIÓN. Le pregunta a la terminal —sólo si está identificada y anunció la
   * capacidad— por sus filas sin desenlace acreditado. No cambia ningún estado al emitir: la
   * evidencia llega en `terminal:payment_probe_result` y se aplica en `handleProbeResultFromSocket`.
   * Un APK viejo no anuncia la capacidad ⇒ no se le pregunta ⇒ ninguna liberación falsa.
   */
  async probeUnresolvedForTerminal(terminalId: string, venueId: string | undefined, socketId: string): Promise<number> {
    if (!venueId) return 0
    const entry = terminalRegistry.getTerminal(terminalId)
    if (
      !entry ||
      entry.socketId !== socketId ||
      entry.venueId !== venueId ||
      !entry.identityVerified ||
      (entry.terminalPaymentProbeVersion ?? 0) < 1
    )
      return 0
    const io = socketManager.getServer()
    const directSocket = io?.sockets.sockets.get(socketId)
    if (!directSocket) return 0

    const rows = await prisma.terminalPaymentRequest.findMany({
      where: { terminalId: normalizeTerminalId(terminalId), venueId, ...SIN_DESENLACE_ACREDITADO },
      select: { requestId: true, amountCents: true, tipCents: true, status: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PROBE_BATCH,
    })
    const ahora = Date.now()
    const candidatas = rows.filter(row => {
      const contestadaSinEvidencia = this.unaccreditedProbeAnswers.get(row.requestId)
      return !(contestadaSinEvidencia && ahora - contestadaSinEvidencia < PROBE_UNACCREDITED_BACKOFF_MS)
    })
    for (const row of candidatas) {
      directSocket.timeout(PAYMENT_DELIVERY_ACK_TIMEOUT_MS).emit(
        'terminal:payment_probe',
        {
          requestId: row.requestId,
          terminalId,
          venueId,
          amountCents: row.amountCents,
          tipCents: row.tipCents,
          timestamp: new Date().toISOString(),
        },
        () => undefined, // la respuesta viaja por su propio evento; el ack sólo evita colgar el emit
      )
    }
    if (candidatas.length > 0) {
      logger.info('🔎 [TerminalPayment] Probe sent for unresolved rows', {
        terminalId,
        venueId,
        count: candidatas.length,
        enEspera: rows.length - candidatas.length,
      })
    }
    return candidatas.length
  }

  /**
   * Respuesta de la terminal a la sonda, desde su bandeja DURABLE (nunca desde la UI):
   *   RESOLVED / RECEIVED_CANCELLED ⇒ trae el resultado final; se aplica por `closeRow`, que exige
   *     `outcomeEvidence` para dar por no cobrado (sin ella se degrada a timeout y NO libera).
   *   ACTIVE    ⇒ la terminal sigue con ese intento: se conserva la reserva.
   *   NOT_FOUND ⇒ libera SÓLO una fila que NUNCA se entregó a ningún socket (procedencia exactamente `[]`,
   *     comprobado dentro del propio UPDATE). Una fila entregada —legacy, o durable con el ACK perdido— o de
   *     procedencia desconocida (`null`) se conserva y se audita UNA vez (`TERMINAL_PAYMENT_PROBE_UNACCREDITED`):
   *     la bandeja pudo haberse vaciado después de ejecutarla (downgrade, borrado de datos, reinstalación).
   *     Con ACK registrado, o sobre una fila todavía EN VUELO, NOT_FOUND es una contradicción —la terminal perdió
   *     una solicitud que sí persistió, o contesta por una que el servidor aún considera entregándose— y se conserva
   *     con 🚨, auditada UNA vez y sin re-sondear durante la ventana de espera.
   */
  async handleProbeResultFromSocket(
    event: { requestId?: string; disposition?: string; finalResult?: Partial<TerminalPaymentResult> | null },
    terminal: { socketId: string | null; terminalId: string; venueId: string },
  ): Promise<boolean> {
    const { requestId, disposition } = event
    if (!requestId || !disposition || !['RESOLVED', 'RECEIVED_CANCELLED', 'ACTIVE', 'NOT_FOUND'].includes(disposition)) return false
    const where = { requestId, venueId: terminal.venueId, terminalId: normalizeTerminalId(terminal.terminalId) }
    const row = await prisma.terminalPaymentRequest.findFirst({
      where,
      select: {
        id: true,
        status: true,
        acknowledgedAt: true,
        lastDeliveredAt: true,
        deliveryProvenance: true,
        expiresAt: true,
        terminalId: true,
      },
    })
    if (!row) {
      logger.warn('🛑 [TerminalPayment] Probe answer rejected: request is not owned by the authenticated terminal', {
        requestId,
        terminalId: terminal.terminalId,
        venueId: terminal.venueId,
      })
      return false
    }
    if (row.status === TerminalPaymentRequestStatus.COMPLETED) return true

    if (disposition === 'ACTIVE') {
      logger.info('🔎 [TerminalPayment] Probe: terminal still executing the attempt — reservation kept', { requestId })
      return true
    }

    if (disposition === 'RESOLVED' || disposition === 'RECEIVED_CANCELLED') {
      const fr = event.finalResult
      if (!fr || fr.requestId !== requestId || !fr.status || !['success', 'failed', 'cancelled', 'timeout'].includes(fr.status))
        return false
      const result: TerminalPaymentResult = {
        requestId,
        status: fr.status,
        ...(fr.outcomeEvidence === 'PRE_AUTHORIZATION' || fr.outcomeEvidence === 'PROCESSOR_DECLINED'
          ? { outcomeEvidence: fr.outcomeEvidence }
          : {}),
        ...(typeof fr.paymentId === 'string' ? { paymentId: fr.paymentId } : {}),
        ...(typeof fr.errorMessage === 'string' ? { errorMessage: fr.errorMessage } : {}),
      }
      // 🔴 Sin evidencia acreditada no hay nada que «reconciliar». Un `cancelled`/`failed` pelón (lo que
      // guardó un APK anterior a `outcomeEvidence`) o un `timeout` no dicen si la tarjeta se cobró. Pasarlo
      // por `closeRow` sólo re-marcaba la fila como UNKNOWN en cada barrido de 30 s, con dos avisos
      // engañosos y sin rastro (medido en la PAX 2841548417 el 10-sep). Se conserva la fila tal cual, se
      // audita UNA vez lo que la terminal guardó —evidencia «clase B», que decide un operador con
      // `releaseUnknownRequest`— y no se vuelve a preguntar en la ventana de espera. Un `success` sí entra:
      // `closeRow` va a buscar el Payment, que es la evidencia de verdad.
      const acreditado = result.status === 'success' || result.outcomeEvidence !== undefined
      if (!acreditado) {
        // Una vez por proceso y una vez por fila entre reinicios (bitácora): sin las dos, o se audita en cada
        // barrido o se pierde la única entrada al reiniciar. Y no se vuelve a preguntar en la ventana de espera.
        this.marcarEsperaDeSonda(requestId)
        const yaAuditada = !(await this.debeAuditar('TERMINAL_PAYMENT_PROBE_UNACCREDITED', row.id))
        logger.warn('🔎 [TerminalPayment] Probe answer carries no accredited evidence: row kept for an operator', {
          requestId,
          terminalId: row.terminalId,
          status: row.status,
          terminalStatus: fr.status,
          audited: !yaAuditada,
        })
        if (!yaAuditada) {
          const completedAt = (fr as { completedAt?: unknown }).completedAt
          await logAction({
            venueId: terminal.venueId,
            action: 'TERMINAL_PAYMENT_PROBE_UNACCREDITED',
            entity: 'TerminalPaymentRequest',
            entityId: row.id,
            data: {
              requestId,
              terminalId: row.terminalId,
              status: row.status,
              disposition,
              terminalOutcome: {
                status: fr.status,
                errorMessage: fr.errorMessage ?? null,
                completedAt: typeof completedAt === 'string' ? completedAt : null,
              },
            },
          })
        }
        return true
      }
      this.unaccreditedProbeAnswers.delete(requestId)
      const outcome = await this.closeRow(requestId, terminal.venueId, result)
      const after = await prisma.terminalPaymentRequest.findFirst({
        where,
        select: { status: true, failureCode: true, cancelDisposition: true },
      })
      const resuelta =
        !!after &&
        (after.status === TerminalPaymentRequestStatus.COMPLETED ||
          (after.status === TerminalPaymentRequestStatus.FAILED && after.failureCode === 'TPV_CONFIRMED_NO_CHARGE') ||
          (after.status === TerminalPaymentRequestStatus.CANCELLED && after.cancelDisposition === 'ACCEPTED'))
      if (resuelta && row.status !== after?.status) {
        void logAction({
          venueId: terminal.venueId,
          action: 'TERMINAL_PAYMENT_PROBE_RESOLVED',
          entity: 'TerminalPaymentRequest',
          entityId: row.id,
          data: {
            requestId,
            terminalId: row.terminalId,
            priorStatus: row.status,
            status: after?.status,
            outcome: outcome.status,
            evidence: result.outcomeEvidence ?? null,
          },
        })
      }
      // Un `success` que no logró ligar su Payment tampoco produce evidencia nueva en el siguiente
      // barrido: entra al mismo backoff (el barrido de UNKNOWN por Payment sigue vivo aparte).
      if (!resuelta) this.marcarEsperaDeSonda(requestId)
      const pending = this.pendingPayments.get(requestId)
      if (pending && pending.venueId === terminal.venueId && resuelta) {
        clearTimeout(pending.timeout)
        this.pendingPayments.delete(requestId)
        pending.resolve(outcome)
      }
      return true
    }

    // NOT_FOUND
    const fueraDeVuelo = !IN_FLIGHT.includes(row.status)
    if (row.acknowledgedAt || !fueraDeVuelo) {
      // Re-auditoría 11-sep (P2-2): la evidencia no cambia entre barridos. Sin la espera, cada barrido de 30 s volvía a
      // preguntar y escribía otro 🚨 y otro asiento (≈2 880 al día por fila).
      this.marcarEsperaDeSonda(requestId)
      const auditar = await this.debeAuditar('TERMINAL_PAYMENT_PROBE_CONTRADICTION', row.id)
      logger.error(
        '🚨 [Terminal-payment] Probe contradiction: the terminal acknowledged this request but no longer has it — reservation kept',
        {
          requestId,
          terminalId: row.terminalId,
          venueId: terminal.venueId,
          status: row.status,
          acknowledgedAt: row.acknowledgedAt,
          audited: auditar,
        },
      )
      if (auditar)
        void logAction({
          venueId: terminal.venueId,
          action: 'TERMINAL_PAYMENT_PROBE_CONTRADICTION',
          entity: 'TerminalPaymentRequest',
          entityId: row.id,
          data: { requestId, terminalId: row.terminalId, status: row.status, acknowledgedAt: row.acknowledgedAt },
        })
      return true
    }
    // Codex 11-sep (3, 4): NOT_FOUND sólo acredita «nunca recibida» si la fila NUNCA se entregó a ningún socket
    // (procedencia `[]`). Con entregas (legacy o durable con ACK perdido) o con procedencia desconocida (fila anterior
    // a la columna), es evidencia clase B: se conserva la reserva, se audita UNA vez y no se re-sondea en la ventana.
    const procedencia = leerProcedencia(row.deliveryProvenance)
    const noAcreditable = procedencia === null ? 'NOT_FOUND_UNKNOWN_PROVENANCE' : procedencia.length > 0 ? 'NOT_FOUND_AFTER_DELIVERY' : null
    if (noAcreditable) {
      this.marcarEsperaDeSonda(requestId)
      const yaAuditada = !(await this.debeAuditar('TERMINAL_PAYMENT_PROBE_UNACCREDITED', row.id))
      logger.warn('🔎 [TerminalPayment] Probe NOT_FOUND cannot accredit non-receipt: reservation kept for an operator', {
        requestId,
        terminalId: row.terminalId,
        status: row.status,
        evidence: noAcreditable,
        deliveries: procedencia?.length ?? null,
        audited: !yaAuditada,
      })
      if (!yaAuditada) {
        void logAction({
          venueId: terminal.venueId,
          action: 'TERMINAL_PAYMENT_PROBE_UNACCREDITED',
          entity: 'TerminalPaymentRequest',
          entityId: row.id,
          data: { requestId, terminalId: row.terminalId, status: row.status, deliveries: procedencia, evidence: noAcreditable },
        })
      }
      return true
    }
    const result: TerminalPaymentResult = {
      requestId,
      status: 'failed',
      errorMessage: 'La terminal nunca recibió esta solicitud (nunca se entregó a ningún socket): no se inició ningún cobro',
    }
    // La condición «nunca entregada» va DENTRO del UPDATE (procedencia exactamente `{deliveries: []}`), no sólo en la
    // lectura de arriba: así la liberación es atómica frente a cualquier entrega que se grabe entre ambas, y una fila
    // con procedencia desconocida (`null`) nunca puede liberarse por esta vía aunque la lectura se equivoque.
    const r = await prisma.terminalPaymentRequest.updateMany({
      where: {
        id: row.id,
        acknowledgedAt: null,
        lastDeliveredAt: null,
        deliveryProvenance: { equals: { deliveries: [] } },
        ...SIN_DESENLACE_ACREDITADO,
      },
      data: {
        status: TerminalPaymentRequestStatus.FAILED,
        failureCode: 'TPV_NEVER_RECEIVED',
        lateResult: true,
        cancelDisposition: null,
        resultJson: result as unknown as Prisma.InputJsonValue,
      },
    })
    if (r.count > 0) {
      logger.warn('🔎 [TerminalPayment] Probe released a never-acknowledged request', {
        requestId,
        terminalId: row.terminalId,
        priorStatus: row.status,
      })
      void logAction({
        venueId: terminal.venueId,
        action: 'TERMINAL_PAYMENT_PROBE_RELEASED',
        entity: 'TerminalPaymentRequest',
        entityId: row.id,
        data: { requestId, terminalId: row.terminalId, priorStatus: row.status, evidence: 'NOT_FOUND_NEVER_DELIVERED' },
      })
      const pending = this.pendingPayments.get(requestId)
      if (pending && pending.venueId === terminal.venueId) {
        clearTimeout(pending.timeout)
        this.pendingPayments.delete(requestId)
        pending.resolve(result)
      }
    }
    return true
  }

  /**
   * Emit the cancel to the terminal. Returns false when it couldn't be delivered.
   *
   * 🔴 P2-14 (2ª mitad) NO se implementa, y se declara por qué: registrar el cancel en `deliveryProvenance` con su
   * propia clase (`kind:'CANCEL'`) ROMPERÍA las dos reglas del plan D que dependen de esa columna, medido el 11-sep:
   *  - la sonda sólo libera con procedencia EXACTAMENTE `{deliveries: []}` (`equals` compara el objeto COMPLETO), así
   *    que cualquier llave hermana o entrada extra deja de coincidir y la fila se vuelve INLIBERABLE en silencio;
   *  - el replay descarta una fila si ALGUNA entrada es `LEGACY`, así que un cancel emitido a un socket viejo
   *    bloquearía para siempre la reentrega del COBRO.
   * Guardarlo aparte exige una columna nueva; es dato forense, no del camino del dinero, y no entra en este trabajo.
   * Mientras tanto el cancel sí deja rastro: la fila queda en CANCEL_REQUESTED y la emisión se registra en el log.
   */
  private async emitCancelToTerminal(
    socketId: string | null | undefined,
    terminalId: string,
    requestId?: string,
    reason?: string,
  ): Promise<boolean> {
    if (!socketId) {
      logger.warn(`⚠️ [TerminalPayment] Cannot notify terminal of cancel - not online (intent remains pending)`, { terminalId })
      return false
    }
    const io = socketManager.getServer()
    if (!io) return false

    logger.info(`🚫 [TerminalPayment] Sending cancel to terminal`, { terminalId, requestId, reason })
    io.to(socketId).emit('terminal:payment_cancel', {
      terminalId,
      requestId, // TPV checks: if currentRequestId !== requestId, ignore cancel
      reason: reason || 'Cancelado por el usuario',
      timestamp: new Date().toISOString(),
    })
    return true
  }

  /**
   * Get count of pending payments (for monitoring).
   */
  getPendingCount(): number {
    return this.pendingPayments.size
  }
}

// Singleton
export const terminalPaymentService = new TerminalPaymentService()
