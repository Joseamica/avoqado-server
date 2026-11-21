/**
 * Máquina de efectivo QuickPay Mini · fase 1a (plan `docs/superpowers/plans/2026-11-20-maquina-de-efectivo-fase-1a.md`). Rediseño tras
 * la ronda 3 de Codex sobre el código (D1–D4 y los ajustes de `codex-r6.md` 1–6). Cada mensaje de un folio (`referenceCC`) — el cierre
 * de la PC, su duda o lo que declara un gerente — pasa por DOS pasos:
 *
 *  1. RECIBIR (D1, r6-1): bajo el candado del folio, en su propia transacción, se guarda la evidencia ANTES que nada: la observación
 *     (`CashMachineObservation`), el folio congelado si es el primer mensaje (carrito completo, turno, reparto, dueño y emparejamiento),
 *     el desenlace si es el primer cierre comprobado, y las incidencias. Si esta transacción no pudo escribir (interbloqueo agotado,
 *     candado ocupado) → 409 `CASH_MACHINE_CLOSE_RETRY`, y es lo ÚNICO que contesta ese código.
 *  2. TERMINAR: con el desenlace guardado se arma la venta (o el cierre) SIEMPRE desde lo congelado, con el escritor de siempre (cuenta +
 *     pago + cierre en UNA transacción, llaves únicas). Un carrito ilegible, un descuento, un premio, la llave del folio ocupada o la
 *     venta rechazada dejan el cierre físico SIN venta y su incidencia: 202 TERMINADO con la deuda que dicen los importes físicos. Algo
 *     transitorio deja el folio RECIBIDO: 202 `ack: 'RECIBIDO'`, y el reenvío del mismo mensaje lo reanuda.
 *
 * El acuse de todo POST y GET dice `ack` (`RECIBIDO` o `TERMINADO`) y el `deviceId` dueño del folio: la PC sólo retira su pendiente con
 * TERMINADO y su propio aparato (r3 #7). Qué hace cada mensaje lo decide `decidirSobreElFolio` (`decisionDelFolio.ts`), pura.
 */
import { Prisma, type CashMachineClose, type CashMachineFolio } from '@prisma/client'

import logger from '../../config/logger'
import AppError, { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { operationHash } from '../../utils/operationHash'
import {
  isDeadlockError,
  isModelLockTimeoutError,
  isRetryableDbError,
  withDeadlockRetry,
  type TxConReintento,
} from '../../utils/serializableRetry'
import { logAction } from '../dashboard/activity-log.service'
import { CuentaDeLaMaquinaYaExiste, venderLoQueCobroLaMaquina, type CreateOrderInput } from '../mobile/order.mobile.service'
import { candadoDeLaLlave } from '../mobile/pagarDespuesLlave'
import {
  acumularEnLaIncidencia,
  decidirSobreElFolio,
  huellaDeLaObservacion,
  type DecisionDelFolio,
  type DecisionGuardada,
  type EstadoDelFolio,
  type VinculoDelIntento,
} from './decisionDelFolio'
import { aparatoDe, exigirAparatoEmparejado } from './emparejamiento'

/** Folio de la máquina: `AQ` + 12 `[0-9A-Z]`. La llave del pago y de la cuenta es `"maquina-" + referenceCC`. */
export const CASH_MACHINE_REF = /^AQ[0-9A-Z]{12}$/
export const DESENLACES_DE_LA_MAQUINA = ['PAGADO', 'CANCELADO', 'GUARDADO'] as const
export type DesenlaceDeLaMaquina = (typeof DESENLACES_DE_LA_MAQUINA)[number]
export type DeudaConElCliente = 'CAMBIO' | 'GUARDADO' | 'NO_DEVUELTO' | 'EXCEDENTE'
export type EstadoDelTurnoDeLaMaquina = 'EN_TURNO' | 'TURNO_CERRADO' | 'POR_CONCILIAR'
export type QuienResolvio = 'MAQUINA' | 'GERENTE'
/**
 * `TRAS_REVOCAR`: un folio de una PC revocada (decisión d del founder): queda para que el gerente lo revise.
 * `POR_TERMINAR` (H5, Codex servidor r5): el folio tiene su desenlace guardado pero la venta no se terminó (RECIBIDO) y su
 * emparejamiento ya no está activo (relevaron la PC): sólo el gerente lo termina, desde lo congelado (`resolve` con la `version`).
 */
export type TipoDeIncidencia = 'CONFLICTO' | 'IMPOSIBLE' | 'NO_SE_PUDO_REGISTRAR' | 'TRAS_REVOCAR' | 'POR_TERMINAR'
/**
 * Por qué un PAGADO comprobado quedó sin venta (202, el dinero en su cierre y su incidencia):
 *  · `DESCUENTO`: la fase 1a no cobra descuentos en la máquina (decisión a del founder);
 *  · `PC_REVOCADA`: la PC revocada cobró después de que la revocaron, o sin hora (decisión d, r6-6);
 *  · `SIN_SALDAR`: la cuenta no nacía pagada con lo que entró (Codex r1 #1);
 *  · `SIN_CARRITO` / `CARRITO_ILEGIBLE`: el folio llegó sin carrito, o con uno que no se puede leer (r3 #1);
 *  · `VENTA_RECHAZADA`: la venta ya no se arma (un producto borrado, el personal…; R5#1);
 *  · `PREMIO_PENDIENTE`: el carrito trae un premio de sellos (R5#4);
 *  · `LLAVE_OCUPADA`: la llave del folio ya es de otra cuenta u operación: repetirla nunca lo resuelve (r3 #6);
 *  · `REPARTO_DESCUADRADO`: el adeudo congelado no es la venta más la propina (F4): el comprobante es legible, la venta no se arma.
 */
export type MotivoSinRegistro =
  | 'DESCUENTO'
  | 'PC_REVOCADA'
  | 'SIN_SALDAR'
  | 'SIN_CARRITO'
  | 'CARRITO_ILEGIBLE'
  | 'VENTA_RECHAZADA'
  | 'PREMIO_PENDIENTE'
  | 'LLAVE_OCUPADA'
  | 'REPARTO_DESCUADRADO'

/** Lo que la máquina dijo al cerrar, en CENTAVOS (así los manda la PC). */
export interface CierreDeLaMaquina {
  outcome: DesenlaceDeLaMaquina
  dueCents: number
  /** El reparto venta/propina (administrativo, la máquina no lo conoce). H3/H4: null = no llegó como número. */
  saleCents: number | null
  tipCents: number | null
  creditCents: number
  changeDispensedCents: number
  /** Hora física del cierre (ISO). Sólo cuenta con `occurredAtKnown`. */
  occurredAt?: string | null
  occurredAtKnown: boolean
  /** El turno A con el que la PC vendió (sólo lo que mandó; manda el congelado del folio). */
  saleShiftId?: string | null
  /** El `cancel` que mandó la PC — `'1'` devolver, `'2'` guardar — (Codex r1 #12). Sin él una cancelación es imposible (422). */
  cancelMode?: '1' | '2' | null
}

/** r6-1: el acuse. La PC conserva su pendiente hasta TERMINADO (y su propio `deviceId`). */
export type AcuseDelFolio = 'RECIBIDO' | 'TERMINADO'

/** 200: la venta o el cierre quedó. IGUAL en el primer éxito, la repetición y el GET (R4-1, R5#7). */
export interface RespuestaDeLaMaquina {
  ack: 'TERMINADO'
  referenceCC: string
  /** r3 #7: el aparato DUEÑO del folio. */
  deviceId: string | null
  outcome: string
  resolvedBy: string
  owedKind: string | null
  orderId: string | null
  paymentId: string | null
  dueCents: number
  /** null = el reparto que llegó no eran centavos enteros (H3/H4). */
  saleCents: number | null
  tipCents: number | null
  appliedCents: number
  excedenteCents: number
  creditCents: number
  changeDispensedCents: number
  owedCents: number
  shiftStatus: string | null
}

/** 202 TERMINADO: el PAGADO comprobado quedó sin venta; el dinero está en su cierre y en la incidencia `incidentId` (r3 #1, #5). */
export interface RespuestaSinRegistro {
  ack: 'TERMINADO'
  referenceCC: string
  deviceId: string | null
  incident: 'NO_SE_PUDO_REGISTRAR'
  incidentId: string | null
  motivo: string
  outcome: string
  resolvedBy: string
  dueCents: number
  saleCents: number | null
  tipCents: number | null
  creditCents: number
  changeDispensedCents: number
  /** r3 #5: lo que se le debe al cliente SÓLO por los importes físicos (el cambio que faltó, lo guardado o no devuelto). */
  owedKind: string | null
  owedCents: number
}

/** 202 RECIBIDO (r6-1): la evidencia y el desenlace quedaron; la venta todavía no. El reenvío del mismo mensaje la reanuda. */
export interface RespuestaRecibida {
  ack: 'RECIBIDO'
  referenceCC: string
  deviceId: string | null
  outcome: string | null
}

export type ResultadoDeLaMaquina =
  | { status: 200; body: RespuestaDeLaMaquina }
  | { status: 202; body: RespuestaSinRegistro | RespuestaRecibida }

/** Quién sube: la sesión (procesa el cobro), el aparato del encabezado `X-Device-Id` y su credencial (`X-Cash-Machine-Credential`). */
export interface AutorDeLaMaquina {
  userId: string
  deviceUid: string | null
  credencial: string | null
}

/** Lee el carrito congelado como `POST /orders` con la autoridad de la sesión de quien lo termina (el controlador lo arma). */
export type LectorDelPedido = (crudo: unknown, vendedorPorOmision: string) => Promise<CreateOrderInput>

export interface EntradaDeLaMaquina {
  referenceCC: string
  cierre: CierreDeLaMaquina
  /** El carrito tal cual (el JSON de `POST /orders`). Ausente o ilegible NO es 400 (r3 #1): queda como dinero sin venta. */
  pedido?: unknown
  /** r6-6: el emparejamiento con el que la PC empezó este cobro. Ausente = el de su credencial. */
  bindingId?: string | null
}

/** Centavos enteros ≥ 0 que caben en las columnas enteras del folio y del cierre. */
export const centavosGuardables = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 2_147_483_647

/** Codex r1 #12 (decisión h): la máquina sólo cobra un adeudo mayor que $0 y múltiplo de $0.50. */
export const adeudoCobrable = (dueCents: number): boolean => Number.isInteger(dueCents) && dueCents > 0 && dueCents % 50 === 0

/**
 * R3#9, R5#5, R4-7 #6: ¿esta combinación de importes puede salir de la máquina? Cualquier otra cosa es 422 con incidencia.
 *  · lo FÍSICO (adeudo, lo que entró y el cambio) en enteros ≥ 0 y el adeudo mayor que 0 y múltiplo de 50 centavos (Codex r1 #12);
 *  · `PAGADO`: `credit ≥ due` y `0 ≤ change ≤ credit − due`;
 *  · `CANCELADO` y `GUARDADO`: `credit < due`; `GUARDADO` no devuelve nada y `CANCELADO` no devuelve más de lo que entró; y el modo del
 *    `cancel` coincide (`'1'` / `'2'`): sin él, revisión (Codex r1 #12).
 * F4 (Codex servidor r4): el reparto venta/propina NO es de la máquina (ella sólo conoce el adeudo). Un reparto descuadrado con lo
 * físico posible es un comprobante legible: se guarda y la venta no se arma (`REPARTO_DESCUADRADO`), nunca un 400/422 sin rastro.
 * H3/H4 (Codex servidor r5): lo mismo un reparto con fracción de centavo o que no llegó como número: aquí no cuenta.
 */
export function validarCierre(c: CierreDeLaMaquina): 'OK' | 'IMPOSIBLE' {
  if (!DESENLACES_DE_LA_MAQUINA.includes(c.outcome)) return 'IMPOSIBLE'
  const fisicos = [c.dueCents, c.creditCents, c.changeDispensedCents]
  if (!fisicos.every(centavosGuardables)) return 'IMPOSIBLE'
  if (!adeudoCobrable(c.dueCents)) return 'IMPOSIBLE'
  if (c.outcome === 'PAGADO') {
    return c.creditCents >= c.dueCents && c.changeDispensedCents <= c.creditCents - c.dueCents ? 'OK' : 'IMPOSIBLE'
  }
  if (c.creditCents >= c.dueCents) return 'IMPOSIBLE'
  if (c.outcome === 'GUARDADO') return c.changeDispensedCents === 0 && c.cancelMode === '2' ? 'OK' : 'IMPOSIBLE'
  return c.changeDispensedCents <= c.creditCents && c.cancelMode === '1' ? 'OK' : 'IMPOSIBLE'
}

/** H3/H4: un número que sí llegó (aun con fracción); cualquier otra cosa, `null` («no llegó como número»). */
export const numeroQueLlego = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** El reparto venta/propina se puede vender: centavos enteros que suman el adeudo (si no, `REPARTO_DESCUADRADO`). */
export const repartoVendible = (i: { dueCents: number; saleCents: number | null; tipCents: number | null }): boolean =>
  i.saleCents !== null &&
  i.tipCents !== null &&
  centavosGuardables(i.saleCents) &&
  centavosGuardables(i.tipCents) &&
  i.dueCents === i.saleCents + i.tipCents

/** Para las columnas enteras del cierre: el centavo entero, o null si lo que llegó no lo era. */
const enteroONulo = (n: number | null): number | null => (n !== null && centavosGuardables(n) ? n : null)

/**
 * H3/H4 (Codex servidor r5): «primero la evidencia» en la frontera HTTP. La ruta sólo exige folio, credencial y que lo FÍSICO (adeudo,
 * lo que entró, el cambio) sean números legibles y que el desenlace sea un texto; TODO lo demás se lee aquí, DESPUÉS de guardar la
 * evidencia, y lo que no sirve cuenta como desconocido, nunca como un 400 sin rastro:
 *  · la hora «conocida» sin fecha válida es hora desconocida (por conciliar);
 *  · el reparto venta/propina que no llegó como número queda en null (la venta no se arma: `REPARTO_DESCUADRADO`);
 *  · el turno que no es un texto corto y el modo de cancelación que no es '1' o '2' quedan en null (sin modo, una cancelación es
 *    IMPOSIBLE: incidencia con su evidencia).
 */
export function leerCierreDeLaPc(c: Record<string, unknown>): CierreDeLaMaquina {
  const hora = typeof c.occurredAt === 'string' && !Number.isNaN(Date.parse(c.occurredAt)) ? c.occurredAt : null
  const conocida = c.occurredAtKnown === true && hora !== null
  return {
    outcome: c.outcome as DesenlaceDeLaMaquina,
    dueCents: c.dueCents as number,
    saleCents: numeroQueLlego(c.saleCents),
    tipCents: numeroQueLlego(c.tipCents),
    creditCents: c.creditCents as number,
    changeDispensedCents: c.changeDispensedCents as number,
    occurredAt: conocida ? hora : null,
    occurredAtKnown: conocida,
    saleShiftId: typeof c.saleShiftId === 'string' && c.saleShiftId.length <= 64 ? c.saleShiftId : null,
    cancelMode: c.cancelMode === '1' || c.cancelMode === '2' ? c.cancelMode : null,
  }
}

/** Lo que la máquina le debe al cliente. `excedenteCents`: lo que se cobró de más porque el precio del servidor era menor. */
export function deudaDelCierre(c: CierreDeLaMaquina, excedenteCents: number): { owedCents: number; owedKind: DeudaConElCliente | null } {
  if (c.outcome === 'PAGADO') {
    const owedCents = c.creditCents - c.dueCents - c.changeDispensedCents + excedenteCents
    return { owedCents, owedKind: excedenteCents > 0 ? 'EXCEDENTE' : owedCents > 0 ? 'CAMBIO' : null }
  }
  const owedCents = c.creditCents - c.changeDispensedCents
  return { owedCents, owedKind: owedCents > 0 ? (c.outcome === 'GUARDADO' ? 'GUARDADO' : 'NO_DEVUELTO') : null }
}

function horaDelCierre(c: CierreDeLaMaquina): Date | null {
  if (!c.occurredAtKnown || !c.occurredAt) return null
  const hora = new Date(c.occurredAt)
  return Number.isNaN(hora.getTime()) ? null : hora
}

/** F13: una hora ISO como instante UTC (`11:58-06:00` y `17:58Z` son la misma). Lo que no es hora se queda como llegó. */
export const instante = (iso: string): string => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? iso : new Date(t).toISOString()
}

/**
 * R4-7 #8: el turno del cierre. Con el turno A (el CONGELADO del folio, r3 #3) y la hora física: A abierto → A; A cerrado y el dinero
 * entró durante A → sin turno (`SALE_SHIFT_CLOSED`, como la cola); el dinero entró ANTES de que A empezara o después de que terminó
 * (Codex r1 #11), sin hora, sin turno o con un turno que no es del negocio → por conciliar. Nunca el turno vivo.
 */
export function turnoDeLaMaquina(
  c: CierreDeLaMaquina,
  turnoA: { id: string; status: string; startTime: Date; endTime: Date | null } | null,
): { expectedShiftId: string | null; porConciliar: boolean; shiftStatus: EstadoDelTurnoDeLaMaquina } {
  const hora = horaDelCierre(c)
  if (!c.saleShiftId || !hora || !turnoA || hora < turnoA.startTime || (turnoA.endTime && hora > turnoA.endTime)) {
    return { expectedShiftId: null, porConciliar: true, shiftStatus: 'POR_CONCILIAR' }
  }
  return {
    expectedShiftId: turnoA.id,
    porConciliar: false,
    shiftStatus: turnoA.status === 'OPEN' && !turnoA.endTime ? 'EN_TURNO' : 'TURNO_CERRADO',
  }
}

/**
 * r6-1 (y la cotización, R4-2): la huella del carrito COMPLETO tal cual llegó —cliente, premio, `catalogAt`, todo—. La misma que firma
 * el `quoteId`. `null` = sin carrito.
 */
export const huellaDelCarritoCompleto = (crudo: unknown): string | null => (crudo == null ? null : operationHash(crudo))

/**
 * Decisión a del founder (Codex r1 #1 #9 #10): en la fase 1a la máquina no cobra NINGÚN descuento — de renglón (catálogo, «Ajuste de
 * precio», cortesía), de cuenta (libre, de catálogo, del cliente), cupón, promoción ni premio de sellos —.
 */
export function pedidoConDescuento(p: CreateOrderInput): boolean {
  return Boolean(
    (p.discount ?? 0) > 0 ||
      p.orderDiscountId ||
      p.couponCode ||
      p.descuentoDelCliente ||
      p.descuentoDeCatalogoId ||
      p.stampRewardId ||
      p.items.some(i => i.discountId || i.isCortesia || i.adjustedUnitPrice != null || i.promotionRef),
  )
}

/** Por qué un PAGADO con este pedido no se vuelve venta, con la MISMA regla en cotización y venta (Codex r2 #11). */
export function motivoSinVentaDelPedido(p: CreateOrderInput | undefined): MotivoSinRegistro | undefined {
  if (!p) return 'SIN_CARRITO'
  if (p.stampRewardId) return 'PREMIO_PENDIENTE'
  return pedidoConDescuento(p) ? 'DESCUENTO' : undefined
}

// ─── Lectura del folio bajo su candado ────────────────────────────────────────────────────────────────────────────────────────────

type Db = Pick<
  Prisma.TransactionClient,
  'cashMachineFolio' | 'cashMachineClose' | 'cashMachineIncident' | 'cashMachineObservation' | 'cashMachineBinding'
>

export interface LecturaDelFolio {
  folio: CashMachineFolio | null
  cierre: CashMachineClose | null
  duda: { id: string; status: string; deviceId: string | null; payload: unknown } | null
  estado: EstadoDelFolio
}

const decisionDe = (folio: Pick<CashMachineFolio, 'decision'> | null): DecisionGuardada | null =>
  (folio?.decision ?? null) as unknown as DecisionGuardada | null

export async function leerElFolio(db: Db, venueId: string, referenceCC: string): Promise<LecturaDelFolio> {
  const folio = await db.cashMachineFolio.findUnique({ where: { venueId_referenceCC: { venueId, referenceCC } } })
  const cierre = await db.cashMachineClose.findUnique({ where: { venueId_referenceCC: { venueId, referenceCC } } })
  const duda = await db.cashMachineIncident.findUnique({
    where: { venueId_referenceCC_kind: { venueId, referenceCC, kind: 'ESPERANDO' } },
    select: { id: true, status: true, deviceId: true, payload: true },
  })
  return {
    folio,
    cierre,
    duda,
    estado: {
      folio: folio
        ? {
            deviceId: folio.deviceId,
            cartHash: folio.cartHash,
            saleShiftId: folio.saleShiftId,
            dueCents: folio.dueCents,
            saleCents: folio.saleCents,
            tipCents: folio.tipCents,
            version: folio.version,
            decision: decisionDe(folio),
          }
        : null,
      terminado: cierre !== null,
      duda: duda !== null,
    },
  }
}

/**
 * Algo de la BASE o de la red que reintentar SÍ puede resolver: interbloqueo o serialización agotados, candado ocupado, transacción
 * vencida, conexión caída o sin lugar en el pool, un 503. F3 (Codex servidor r4): sólo esto es pasajero; lo demás no se arregla
 * repitiendo y nunca deja un folio RECIBIDO para siempre.
 */
function esTransitorio(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return (
    code === 'CASH_MACHINE_CLOSE_RETRY' ||
    isDeadlockError(error) ||
    isRetryableDbError(error) ||
    isModelLockTimeoutError(error) ||
    (typeof code === 'string' && /^P1\d{3}$/.test(code)) ||
    code === 'P2024' ||
    code === 'P2028' ||
    code === 'P2034' ||
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError ||
    (error instanceof AppError && error.statusCode === 503)
  )
}

/**
 * Bajo el candado del folio (el mismo de la cuenta `maquina-<folio>`): lo que el folio ya tiene, leído DENTRO de la transacción.
 * D1, r6-1: si la transacción no pudo con algo transitorio, NADA quedó escrito: es el único `CASH_MACHINE_CLOSE_RETRY`.
 */
export async function conElFolio<T>(
  venueId: string,
  referenceCC: string,
  fn: (tx: TxConReintento, lectura: LecturaDelFolio) => Promise<T>,
): Promise<T> {
  try {
    return await withDeadlockRetry(
      async tx => {
        await tx.$queryRaw(candadoDeLaLlave(venueId, `maquina-${referenceCC}`))
        return fn(tx, await leerElFolio(tx, venueId, referenceCC))
      },
      { etiqueta: 'conElFolio' },
    )
  } catch (error) {
    if (!esTransitorio(error)) throw error
    throw new ConflictError('No se pudo guardar este folio de la máquina ahora. Intenta otra vez.', 'CASH_MACHINE_CLOSE_RETRY')
  }
}

// ─── Observaciones e incidencias (siempre bajo el candado del folio) ──────────────────────────────────────────────────────────────

/** ¿Esta huella ya está en el historial del folio? (r6-3: contra TODO el historial, sin tope). */
export const yaObservada = async (tx: Db, venueId: string, referenceCC: string, fingerprint: string) =>
  (await tx.cashMachineObservation.findUnique({
    where: { venueId_referenceCC_fingerprint: { venueId, referenceCC, fingerprint } },
    select: { id: true },
  })) !== null

/** Guarda la observación (si es nueva) y sube la versión del folio. Devuelve si era nueva y el folio al día. */
export async function observar(
  tx: Db,
  venueId: string,
  referenceCC: string,
  fingerprint: string,
  repetida: boolean,
  payload: Record<string, unknown>,
  folio: CashMachineFolio | null,
): Promise<{ nueva: boolean; folio: CashMachineFolio | null }> {
  if (repetida) return { nueva: false, folio }
  await tx.cashMachineObservation.create({
    data: { venueId, referenceCC, fingerprint, payload: payload as Prisma.InputJsonValue },
  })
  if (!folio) return { nueva: true, folio }
  return { nueva: true, folio: await tx.cashMachineFolio.update({ where: { id: folio.id }, data: { version: { increment: 1 } } }) }
}

/** Lo que una transacción del folio dejó anotado: a la bitácora del dueño DESPUÉS del commit, sólo lo nuevo (D4). */
export interface IncidenciaAnotada {
  kind: TipoDeIncidencia
  id: string
  evento: Record<string, unknown>
  nueva: boolean
}

/**
 * La incidencia durable: una fila por folio y tipo. La evidencia nueva reabre la fila y sube su versión; una retransmisión sólo cuenta
 * (`acumularEnLaIncidencia`). Quien llama tiene el candado del folio.
 */
export async function anotar(
  tx: Db,
  venueId: string,
  referenceCC: string,
  deviceId: string | null,
  anotadas: IncidenciaAnotada[],
  kind: TipoDeIncidencia,
  evento: Record<string, unknown>,
  nueva: boolean,
): Promise<string> {
  const previa = await tx.cashMachineIncident.findUnique({
    where: { venueId_referenceCC_kind: { venueId, referenceCC, kind } },
    select: { id: true, payload: true, status: true },
  })
  const payload = acumularEnLaIncidencia(previa?.payload ?? null, evento, nueva) as Prisma.InputJsonValue
  const fila = previa
    ? await tx.cashMachineIncident.update({
        where: { id: previa.id },
        data: { payload, status: nueva ? 'ABIERTO' : previa.status },
        select: { id: true },
      })
    : await tx.cashMachineIncident.create({
        data: { venueId, referenceCC, kind, status: 'ABIERTO', payload, deviceId },
        select: { id: true },
      })
  anotadas.push({ kind, id: fila.id, evento, nueva: !previa || nueva })
  return fila.id
}

const ACCION_DE_LA_INCIDENCIA: Record<TipoDeIncidencia, string> = {
  CONFLICTO: 'CASH_MACHINE_CLOSE_CONFLICT',
  IMPOSIBLE: 'CASH_MACHINE_CLOSE_IMPOSSIBLE',
  NO_SE_PUDO_REGISTRAR: 'CASH_MACHINE_SALE_NOT_RECORDED',
  TRAS_REVOCAR: 'CASH_MACHINE_FOLIO_AFTER_UNPAIR',
  POR_TERMINAR: 'CASH_MACHINE_FOLIO_TO_FINISH',
}

/**
 * H1 (Codex servidor r5): lo que la bandeja enseña de una duda ABIERTA es la evidencia física MÁS ALTA de su folio: lo que entró (el
 * mayor que haya visto una PC, en un cierre o en una duda) y lo último que vio la PC. Cualquier observación NUEVA de una PC lo actualiza
 * —también la que se anotó como conflicto porque cambió el reparto—, en la MISMA transacción que sube la `version` del folio: el gerente
 * nunca confirma una versión que enseñe dinero viejo. Lo que vio la PC con MENOS crédito que el ya visto (un reenvío que llegó tarde) no
 * tapa al mayor. Quien llama tiene el candado del folio.
 */
export async function anotarEnLaDuda(
  tx: Db,
  duda: { id: string; status: string; payload: unknown } | null,
  ev: { creditCents: number | null; lastSeen?: unknown },
): Promise<void> {
  if (!duda || duda.status !== 'ABIERTO') return
  const previa = (duda.payload ?? {}) as Record<string, unknown>
  const mayor = typeof previa.creditCents === 'number' ? previa.creditCents : null
  const menor = ev.creditCents !== null && mayor !== null && ev.creditCents < mayor
  const payload = {
    ...previa,
    ...(ev.creditCents !== null && !menor ? { creditCents: ev.creditCents } : {}),
    ...('lastSeen' in ev && !menor ? { lastSeen: ev.lastSeen ?? null } : {}),
  }
  await tx.cashMachineIncident.update({ where: { id: duda.id }, data: { payload: payload as Prisma.InputJsonValue } })
}

export async function anotarEnBitacora(venueId: string, referenceCC: string, staffId: string, anotadas: IncidenciaAnotada[]) {
  for (const a of anotadas) {
    if (!a.nueva) continue
    await logAction({
      action: ACCION_DE_LA_INCIDENCIA[a.kind],
      entity: 'CashMachineIncident',
      entityId: a.id,
      venueId,
      staffId,
      data: { referenceCC, kind: a.kind, ...a.evento } as unknown as Prisma.InputJsonValue,
    })
  }
}

/**
 * H5 (Codex servidor r5): el folio RECIBIDO (desenlace guardado, venta sin terminar) de un emparejamiento que ya no está activo va a la
 * bandeja del gerente. Una fila por folio (la llave única de la incidencia); repetirla no hace nada. Sin aviso al crearse: el cierre la
 * quita en su misma transacción (o la deja RESUELTA a nombre del gerente que lo terminó, con su bitácora).
 */
export async function pendienteDeTerminar(tx: Db, venueId: string, referenceCC: string, deviceId: string | null): Promise<void> {
  await tx.cashMachineIncident.upsert({
    where: { venueId_referenceCC_kind: { venueId, referenceCC, kind: 'POR_TERMINAR' } },
    create: {
      venueId,
      referenceCC,
      kind: 'POR_TERMINAR',
      status: 'ABIERTO',
      payload: { motivo: 'PC_RELEVADA' } as Prisma.InputJsonValue,
      deviceId,
    },
    update: {},
  })
}

/** Lo que el PRIMER mensaje de un folio congela (D2): carrito completo, su huella, dueño, emparejamiento, turno y reparto. */
export interface LoQueSeCongela {
  deviceId: string | null
  bindingId: string | null
  pedido: unknown
  cartHash: string | null
  saleShiftId: string | null
  dueCents: number
  saleCents: number | null
  tipCents: number | null
}

/**
 * D2 y F12 (Codex servidor r4): el primer mensaje congela el folio AUNQUE su cierre sea imposible; lo que llegue después no sustituye
 * carrito, clienta, turno ni reparto. Quien llama tiene el candado del folio. H3 (Codex servidor r5): SIEMPRE, también con importes que
 * no son centavos enteros (se guardan tal cual): antes ese primer mensaje no congelaba y el reenvío corregido sustituía a la clienta.
 */
export async function congelarElFolio(
  tx: Db,
  venueId: string,
  referenceCC: string,
  c: LoQueSeCongela,
  decision: DecisionGuardada | null = null,
): Promise<CashMachineFolio> {
  return tx.cashMachineFolio.create({
    data: {
      venueId,
      referenceCC,
      deviceId: c.deviceId,
      bindingId: c.bindingId,
      pedido: c.pedido != null ? (c.pedido as Prisma.InputJsonValue) : Prisma.JsonNull,
      cartHash: c.cartHash,
      saleShiftId: c.saleShiftId,
      dueCents: c.dueCents,
      saleCents: c.saleCents,
      tipCents: c.tipCents,
      ...(decision ? { decision: decision as unknown as Prisma.InputJsonValue } : {}),
    },
  })
}

/**
 * r6-6, F7: el emparejamiento FIJO del intento, con cuándo nació y cuándo lo revocaron. Uno que ya no existe cuenta como revocado
 * desde siempre (nunca se concede por un dato que falta).
 */
export async function vinculoDelIntento(
  tx: Db,
  venueId: string,
  bindingId: string | null,
  bindingDeLaCredencial: string | null,
): Promise<VinculoDelIntento | null> {
  if (!bindingId) return null
  const v = await tx.cashMachineBinding.findFirst({
    where: { id: bindingId, venueId },
    select: { active: true, createdAt: true, revokedAt: true },
  })
  if (!v) return { creadoEn: new Date(0), revocadoEn: new Date(0), esElDeLaCredencial: false }
  return {
    creadoEn: v.createdAt,
    revocadoEn: v.active ? null : (v.revokedAt ?? new Date(0)),
    esElDeLaCredencial: bindingId === bindingDeLaCredencial,
  }
}

// ─── Las respuestas ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const idDeLaIncidencia = async (db: Db, venueId: string, referenceCC: string, kind: string) =>
  (
    await db.cashMachineIncident.findUnique({
      where: { venueId_referenceCC_kind: { venueId, referenceCC, kind } },
      select: { id: true },
    })
  )?.id ?? null

/** El acuse TERMINADO de un folio con su cierre: 200 con venta, o 202 con el dinero sin venta y su incidencia. */
export async function respuestaDelCierre(db: Db, fila: CashMachineClose, dueño: string | null): Promise<ResultadoDeLaMaquina> {
  if (fila.motivoSinRegistro) {
    return {
      status: 202,
      body: {
        ack: 'TERMINADO',
        referenceCC: fila.referenceCC,
        deviceId: dueño,
        incident: 'NO_SE_PUDO_REGISTRAR',
        incidentId: await idDeLaIncidencia(db, fila.venueId, fila.referenceCC, 'NO_SE_PUDO_REGISTRAR'),
        motivo: fila.motivoSinRegistro,
        outcome: fila.outcome,
        resolvedBy: fila.resolvedBy,
        dueCents: fila.dueCents,
        saleCents: fila.saleCents,
        tipCents: fila.tipCents,
        creditCents: fila.creditCents,
        changeDispensedCents: fila.changeDispensedCents,
        owedKind: fila.owedKind,
        owedCents: fila.owedCents,
      },
    }
  }
  return {
    status: 200,
    body: {
      ack: 'TERMINADO',
      referenceCC: fila.referenceCC,
      deviceId: dueño,
      outcome: fila.outcome,
      resolvedBy: fila.resolvedBy,
      owedKind: fila.owedKind,
      orderId: fila.orderId,
      paymentId: fila.paymentId,
      dueCents: fila.dueCents,
      saleCents: fila.saleCents,
      tipCents: fila.tipCents,
      appliedCents: fila.appliedCents,
      excedenteCents: fila.excedenteCents,
      creditCents: fila.creditCents,
      changeDispensedCents: fila.changeDispensedCents,
      owedCents: fila.owedCents,
      shiftStatus: fila.shiftStatus,
    },
  }
}

const recibido = (referenceCC: string, folio: Pick<CashMachineFolio, 'deviceId' | 'decision'> | null): ResultadoDeLaMaquina => ({
  status: 202,
  body: { ack: 'RECIBIDO', referenceCC, deviceId: folio?.deviceId ?? null, outcome: decisionDe(folio)?.cierre.outcome ?? null },
})

/** Lo que el folio ya tenía, para el 409 de su dueño. A OTRA PC no se le enseña (r1 #4). */
const loRegistrado = (l: LecturaDelFolio): Record<string, unknown> | null =>
  l.folio
    ? {
        dueCents: l.folio.dueCents,
        saleCents: l.folio.saleCents,
        tipCents: l.folio.tipCents,
        outcome: decisionDe(l.folio)?.cierre.outcome ?? null,
        creditCents: decisionDe(l.folio)?.cierre.creditCents ?? null,
        changeDispensedCents: decisionDe(l.folio)?.cierre.changeDispensedCents ?? null,
      }
    : null

// ─── El núcleo: recibir un cierre (de la PC o del gerente) y terminarlo ────────────────────────────────────────────────────────────

/** Un cierre que llega al folio: de la PC (con su aparato y su emparejamiento) o declarado por un gerente sobre la duda de la PC. */
export type CierreQueLlega =
  | {
      origen: 'PC'
      referenceCC: string
      cierre: CierreDeLaMaquina
      pedido?: unknown
      userId: string
      deviceId: string | null
      bindingId: string | null
      /** H6: el emparejamiento de la credencial que presentó la PC (sin hora, el intento sólo vale si es éste). */
      bindingDeLaCredencial: string | null
    }
  | {
      origen: 'GERENTE'
      referenceCC: string
      cierre: CierreDeLaMaquina
      userId: string
      evidence: string
      versionVista: number
    }

/** La duda que se resuelve también entra aquí: `subidoPor` es el vendedor por omisión del carrito congelado. */
export async function recibirCierreDeLaMaquina(
  venueId: string,
  entrada: CierreQueLlega,
  leerPedido: LectorDelPedido,
): Promise<ResultadoDeLaMaquina> {
  const { referenceCC } = entrada
  const deviceId = entrada.origen === 'PC' ? entrada.deviceId : null
  const hora = horaDelCierre(entrada.cierre)
  // F13: la hora física como instante UTC desde aquí (la huella, la decisión guardada y el cierre la ven igual en cualquier zona).
  const cierre: CierreDeLaMaquina = { ...entrada.cierre, occurredAt: hora?.toISOString() ?? null }
  const carritoRecibido = entrada.origen === 'PC' ? huellaDelCarritoCompleto(entrada.pedido) : null
  const imposible = validarCierre(cierre) === 'IMPOSIBLE'
  const observacion: Record<string, unknown> = {
    que: 'CIERRE',
    origen: entrada.origen,
    outcome: cierre.outcome,
    cancelMode: cierre.cancelMode ?? null,
    dueCents: cierre.dueCents,
    saleCents: cierre.saleCents,
    tipCents: cierre.tipCents,
    creditCents: cierre.creditCents,
    changeDispensedCents: cierre.changeDispensedCents,
    occurredAt: cierre.occurredAt,
    ...(entrada.origen === 'PC'
      ? { deviceId, bindingId: entrada.bindingId, saleShiftId: cierre.saleShiftId ?? null, cartHash: carritoRecibido }
      : { evidence: entrada.evidence }),
    ...(imposible ? { imposible: true } : {}),
    userId: entrada.userId,
    recibidoEn: new Date().toISOString(),
  }

  // 1. RECIBIR: la evidencia (y el desenlace, si es el primero) bajo el candado del folio, antes de intentar la venta. También lo
  // imposible (F12): se guarda y congela el folio si es su primer mensaje, después de revisar la versión del gerente (F5).
  const r = await conElFolio(venueId, referenceCC, async (tx, l) => {
    const huella = huellaDeLaObservacion({ ...observacion, congelado: l.folio?.cartHash ?? carritoRecibido })
    const repetida = await yaObservada(tx, venueId, referenceCC, huella)
    const vinculo =
      entrada.origen === 'PC'
        ? await vinculoDelIntento(tx, venueId, l.folio ? l.folio.bindingId : entrada.bindingId, entrada.bindingDeLaCredencial)
        : null
    const d: DecisionDelFolio =
      entrada.origen === 'PC'
        ? decidirSobreElFolio(l.estado, {
            que: 'CIERRE',
            origen: 'PC',
            deviceId,
            cierre,
            carritoRecibido,
            turnoRecibido: cierre.saleShiftId ?? null,
            vinculo,
            imposible,
          })
        : decidirSobreElFolio(l.estado, {
            que: 'CIERRE',
            origen: 'GERENTE',
            cierre,
            versionVista: entrada.versionVista,
            repeticion: repetida,
            imposible,
          })
    if (d.accion === 'VERSION') return { d, l, anotadas: [] as IncidenciaAnotada[], folio: l.folio }
    const observada = await observar(tx, venueId, referenceCC, huella, repetida, observacion, l.folio)
    const nueva = observada.nueva
    // H1: lo que entró según ESTE cierre de la PC (también uno imposible o en conflicto) es evidencia de la duda abierta del folio.
    if (nueva && entrada.origen === 'PC') {
      await anotarEnLaDuda(tx, l.duda, { creditCents: centavosGuardables(cierre.creditCents) ? cierre.creditCents : null })
    }
    const anotadas: IncidenciaAnotada[] = []
    const dueño = l.folio?.deviceId ?? deviceId
    const loDeLaPc = (): LoQueSeCongela | null =>
      entrada.origen === 'PC'
        ? {
            deviceId,
            bindingId: entrada.bindingId,
            pedido: entrada.pedido,
            cartHash: carritoRecibido,
            saleShiftId: cierre.saleShiftId ?? null,
            dueCents: cierre.dueCents,
            saleCents: cierre.saleCents,
            tipCents: cierre.tipCents,
          }
        : null
    let folio = observada.folio
    if (d.accion === 'IMPOSIBLE') {
      const congelar = loDeLaPc()
      if (!folio && congelar) folio = await congelarElFolio(tx, venueId, referenceCC, congelar)
      await anotar(tx, venueId, referenceCC, deviceId ?? dueño, anotadas, 'IMPOSIBLE', { cierre, ...observacion }, nueva)
      return { d, l, anotadas, folio }
    }
    if (d.accion === 'ACEPTAR') {
      const decision: DecisionGuardada = {
        // Los importes CONGELADOS (iguales a los del cierre: si no, la decisión fue CONFLICTO).
        cierre: { ...cierre, saleShiftId: l.folio ? l.folio.saleShiftId : (cierre.saleShiftId ?? null) },
        resolvedBy: entrada.origen === 'PC' ? 'MAQUINA' : 'GERENTE',
        userId: entrada.userId,
        vendedorPorOmision: vendedorDelFolio(l) ?? entrada.userId,
        evidence: entrada.origen === 'GERENTE' ? entrada.evidence : null,
        trasRevocar: d.trasRevocar,
        motivoSinVenta: d.motivoSinVenta,
      }
      const congelar = loDeLaPc()
      folio = folio
        ? await tx.cashMachineFolio.update({
            where: { id: folio.id },
            data: { decision: decision as unknown as Prisma.InputJsonValue },
          })
        : congelar && (await congelarElFolio(tx, venueId, referenceCC, congelar, decision))
      if (d.trasRevocar) {
        await anotar(tx, venueId, referenceCC, dueño, anotadas, 'TRAS_REVOCAR', { ...observacion, registrable: !d.motivoSinVenta }, nueva)
      }
      // H5 (Codex servidor r5): el desenlace de un folio cuyo emparejamiento ya no está activo se guarda YA como «pendiente de
      // terminar» (sin aviso: el cierre lo quita en su misma transacción). Si la venta queda RECIBIDA y esa PC no vuelve, el gerente lo
      // ve y lo termina; un relevo posterior lo anota al revocar (`emparejamiento.ts`).
      if (vinculo?.revocadoEn) await pendienteDeTerminar(tx, venueId, referenceCC, dueño)
    }
    if (d.accion === 'CONFLICTO') {
      await anotar(tx, venueId, referenceCC, deviceId ?? dueño, anotadas, 'CONFLICTO', { ...observacion, motivo: d.motivo }, nueva)
    } else if ((d.accion === 'ACEPTAR' || d.accion === 'SEGUIR') && d.discrepancia) {
      // D2: otro carrito, turno u hora: se anota para revisión; la venta sigue armándose de lo congelado.
      await anotar(tx, venueId, referenceCC, dueño, anotadas, 'CONFLICTO', { ...observacion, motivo: 'DISCREPANCIA' }, nueva)
    }
    return { d, l, anotadas, folio }
  })
  await anotarEnBitacora(venueId, referenceCC, entrada.userId, r.anotadas)

  if (r.d.accion === 'VERSION') {
    throw new ConflictError(
      'Llegó evidencia nueva de este cobro mientras lo resolvías. Vuelve a leerlo antes de resolverlo.',
      'CASH_MACHINE_DOUBT_CHANGED',
      { version: r.l.folio?.version ?? 1 },
    )
  }
  if (r.d.accion === 'IMPOSIBLE') {
    throw new AppError(
      'Los importes de este cierre de la máquina no son posibles. Quedó registrado para que el gerente lo revise.',
      422,
      true,
      'CASH_MACHINE_CLOSE_IMPOSSIBLE',
      { incidentId: r.anotadas.find(a => a.kind === 'IMPOSIBLE')?.id ?? null },
    )
  }
  if (r.d.accion === 'CONFLICTO') {
    const otraPc = r.d.motivo === 'OTRA_PC'
    throw new ConflictError(
      'Este folio de la máquina ya tiene otro desenlace o es de otra PC. Quedó registrado para que el gerente lo revise.',
      'CASH_MACHINE_CLOSE_CONFLICT',
      {
        motivo: r.d.motivo,
        deviceId: r.l.folio?.deviceId ?? null,
        registrado: otraPc ? null : loRegistrado(r.l),
        // La evidencia quedó guardada ANTES de este 409 (contrato con el POS: con ella marca su fila como subida).
        incidentId: r.anotadas.find(a => a.kind === 'CONFLICTO')?.id ?? null,
      },
    )
  }
  // 2. TERMINAR desde lo congelado (o contestar lo que ya quedó). Nunca lanza: lo recibido ya está guardado (F8).
  return terminarElFolio(venueId, referenceCC, r.folio, r.l.cierre, leerPedido)
}

/** El vendedor por omisión del carrito congelado: quien subió la duda (si la hay). */
function vendedorDelFolio(l: LecturaDelFolio): string | null {
  const subidoPor = (l.duda?.payload as { subidoPor?: unknown } | null)?.subidoPor
  return typeof subidoPor === 'string' ? subidoPor : null
}

/** La venta de lo congelado cambió de manos a media escritura (otra petición la terminó): se revierte y se contesta lo que quedó. */
class YaTerminado extends Error {}

const esChoqueDeUnico = (error: unknown): boolean => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

/**
 * Por qué la venta de lo congelado no se arma (r3 #6, F3): `null` = pasajero (la base, o un choque 409 que el reenvío vuelve a
 * intentar); lo demás no se arregla repitiendo y deja el dinero sin venta con su motivo, nunca un folio RECIBIDO para siempre.
 */
function motivoPermanente(error: unknown): MotivoSinRegistro | null {
  if (error instanceof CuentaDeLaMaquinaYaExiste) return 'LLAVE_OCUPADA'
  if (esTransitorio(error)) return null
  if (error instanceof AppError) {
    if (error.statusCode === 409) return error.code === 'IDEMPOTENCY_KEY_REUSED' ? 'LLAVE_OCUPADA' : null
    if (error.code === 'CASH_MACHINE_SALE_WITH_DISCOUNT') return 'DESCUENTO'
    if (error.code === 'CASH_MACHINE_SALE_NOT_SETTLED') return 'SIN_SALDAR'
  }
  return 'VENTA_RECHAZADA'
}

/**
 * TERMINAR el folio desde su desenlace congelado. Con su cierre ya escrito, contesta ése. Lo llaman la PC (cierre y duda) y el gerente;
 * un reenvío del mismo mensaje lo reanuda (r6-1).
 *
 * F8 (Codex servidor r4): NUNCA lanza. Quien llama ya guardó la evidencia y el desenlace en su primera transacción, así que cualquier
 * falla de aquí en adelante contesta 202 RECIBIDO (jamás `CASH_MACHINE_CLOSE_RETRY`, que dice «no se escribió nada»). El reenvío del
 * mismo mensaje la reanuda o, si otra petición ya lo terminó, contesta el TERMINADO guardado.
 */
export async function terminarElFolio(
  venueId: string,
  referenceCC: string,
  folio: CashMachineFolio | null,
  cierreYaEscrito: CashMachineClose | null,
  leerPedido: LectorDelPedido,
  /** H5: el gerente que termina un folio «pendiente de terminar» (resuelve su incidencia y deja su aviso). */
  terminadoPor: string | null = null,
): Promise<ResultadoDeLaMaquina> {
  try {
    return await terminar(venueId, referenceCC, folio, cierreYaEscrito, leerPedido, terminadoPor)
  } catch (error) {
    logger.warn('[MAQUINA] el folio quedó RECIBIDO sin terminar; el reenvío lo reanuda', {
      venueId,
      referenceCC,
      error: error instanceof Error ? error.message : String(error),
    })
    return recibido(referenceCC, folio)
  }
}

async function terminar(
  venueId: string,
  referenceCC: string,
  folio: CashMachineFolio | null,
  cierreYaEscrito: CashMachineClose | null,
  leerPedido: LectorDelPedido,
  terminadoPor: string | null,
): Promise<ResultadoDeLaMaquina> {
  if (cierreYaEscrito) return respuestaDelCierre(prisma, cierreYaEscrito, folio?.deviceId ?? cierreYaEscrito.deviceId)
  const dec = decisionDe(folio)
  if (!folio || !dec) throw new NotFoundError('Ese folio de la máquina no tiene un cierre registrado.', 'CASH_MACHINE_SALE_NOT_FOUND')
  const c = dec.cierre
  const turnoA = folio.saleShiftId
    ? await prisma.shift.findFirst({
        where: { id: folio.saleShiftId, venueId },
        select: { id: true, status: true, startTime: true, endTime: true },
      })
    : null
  const turno = turnoDeLaMaquina({ ...c, saleShiftId: folio.saleShiftId }, turnoA)
  const hora = horaDelCierre(c)
  const gerente = dec.resolvedBy === 'GERENTE' ? dec.userId : null

  const filaDelCierre = (cobro: {
    orderId: string | null
    paymentId: string | null
    appliedCents: number
    shiftStatus: EstadoDelTurnoDeLaMaquina
    motivoSinRegistro?: MotivoSinRegistro
  }): Prisma.CashMachineCloseUncheckedCreateInput => {
    const excedenteCents = c.outcome === 'PAGADO' && !cobro.motivoSinRegistro ? (folio.saleCents ?? 0) - cobro.appliedCents : 0
    return {
      venueId,
      referenceCC,
      outcome: c.outcome,
      resolvedBy: dec.resolvedBy,
      resolvedByStaffId: gerente,
      evidence: dec.evidence,
      // El adeudo de un desenlace siempre es cobrable (entero); el reparto, sólo si llegó en centavos enteros (H3/H4).
      dueCents: folio.dueCents,
      saleCents: enteroONulo(folio.saleCents),
      tipCents: enteroONulo(folio.tipCents),
      creditCents: c.creditCents,
      changeDispensedCents: c.changeDispensedCents,
      appliedCents: cobro.appliedCents,
      excedenteCents,
      ...deudaDelCierre(c, excedenteCents),
      orderId: cobro.orderId,
      paymentId: cobro.paymentId,
      saleShiftId: folio.saleShiftId,
      shiftStatus: cobro.shiftStatus,
      deviceId: folio.deviceId,
      occurredAt: hora,
      occurredAtKnown: hora !== null,
      cartHash: folio.cartHash,
      motivoSinRegistro: cobro.motivoSinRegistro ?? null,
    }
  }

  /**
   * Bajo el candado: si otra petición ya lo terminó, se revierte (`YaTerminado`); si no, el cierre, la duda de ESA PC (D4) y el
   * «pendiente de terminar» (H5), y el folio queda `terminado` en la MISMA transacción.
   */
  const escribirCierreEnTx = async (tx: TxConReintento, datos: Prisma.CashMachineCloseUncheckedCreateInput) => {
    if (await tx.cashMachineClose.findUnique({ where: { venueId_referenceCC: { venueId, referenceCC } }, select: { id: true } }))
      throw new YaTerminado()
    const fila = await tx.cashMachineClose.create({ data: datos })
    await tx.cashMachineFolio.update({ where: { id: folio.id }, data: { terminado: true } })
    const ahora = new Date()
    const { count } = await tx.cashMachineIncident.updateMany({
      where: { venueId, referenceCC, kind: 'ESPERANDO', status: 'ABIERTO', deviceId: folio.deviceId },
      data: { status: 'RESUELTO', resolvedByStaffId: gerente, resolvedAt: ahora },
    })
    // H5: el «pendiente de terminar» es sólo un recordatorio (la evidencia vive en el folio y su cierre): si lo termina un gerente queda
    // RESUELTO a su nombre; si lo termina la PC (su reenvío), se quita de la bandeja sin dejar ruido.
    const donde = { venueId, referenceCC, kind: 'POR_TERMINAR', status: 'ABIERTO' }
    const pendiente = terminadoPor
      ? await tx.cashMachineIncident.updateMany({
          where: donde,
          data: { status: 'RESUELTO', resolvedByStaffId: terminadoPor, resolvedAt: ahora },
        })
      : await tx.cashMachineIncident.deleteMany({ where: donde })
    return { fila, dudaCerrada: count === 1, pendienteCerrado: pendiente.count === 1 }
  }

  /** Lo que quedó cuando otra petición ganó la carrera: su cierre, o RECIBIDO si todavía no hay. */
  const loQueQuedo = async () => {
    const l = await conElFolio(venueId, referenceCC, async (_tx, lectura) => lectura)
    return l.cierre ? respuestaDelCierre(prisma, l.cierre, l.folio?.deviceId ?? null) : recibido(referenceCC, l.folio)
  }

  /** D1: el PAGADO comprobado sin venta: su cierre físico (deuda SÓLO de los importes físicos) y su incidencia, una vez. */
  const sinVenta = async (motivo: MotivoSinRegistro, detalle: Record<string, unknown> = {}) => {
    try {
      const r = await conElFolio(venueId, referenceCC, async tx => {
        const anotadas: IncidenciaAnotada[] = []
        const escrito = await escribirCierreEnTx(
          tx,
          filaDelCierre({ orderId: null, paymentId: null, appliedCents: 0, shiftStatus: turno.shiftStatus, motivoSinRegistro: motivo }),
        )
        await anotar(
          tx,
          venueId,
          referenceCC,
          folio.deviceId,
          anotadas,
          'NO_SE_PUDO_REGISTRAR',
          { cierre: c, resolvedBy: dec.resolvedBy, motivo, ...detalle },
          true,
        )
        return { ...escrito, anotadas }
      })
      await anotarEnBitacora(venueId, referenceCC, dec.userId, r.anotadas)
      return despues(r.fila, r.dudaCerrada, r.pendienteCerrado)
    } catch (error) {
      if (error instanceof YaTerminado || esChoqueDeUnico(error)) return loQueQuedo()
      if (esTransitorio(error)) return recibido(referenceCC, folio)
      throw error
    }
  }

  /** Después del commit, sólo quien escribió (D4): la deuda con el cliente y la resolución del gerente. */
  const despues = async (fila: CashMachineClose, dudaCerrada: boolean, pendienteCerrado: boolean): Promise<ResultadoDeLaMaquina> => {
    if (fila.owedCents > 0) {
      await logAction({
        action: 'CASH_MACHINE_OWES_CUSTOMER',
        entity: 'CashMachineClose',
        entityId: fila.id,
        venueId,
        staffId: dec.userId,
        data: {
          referenceCC,
          outcome: fila.outcome,
          resolvedBy: fila.resolvedBy,
          owedKind: fila.owedKind,
          owedPesos: fila.owedCents / 100,
          orderId: fila.orderId,
          motivoSinRegistro: fila.motivoSinRegistro,
        },
      })
    }
    if (dudaCerrada && dec.resolvedBy === 'GERENTE') {
      await logAction({
        action: 'CASH_MACHINE_DOUBT_RESOLVED',
        entity: 'CashMachineClose',
        entityId: fila.id,
        venueId,
        staffId: dec.userId,
        data: {
          referenceCC,
          outcome: c.outcome,
          cancelMode: c.cancelMode ?? null,
          creditPesos: c.creditCents / 100,
          changeDispensedPesos: c.changeDispensedCents / 100,
          occurredAt: hora?.toISOString() ?? null,
          evidence: dec.evidence,
          ...(fila.motivoSinRegistro
            ? { incident: 'NO_SE_PUDO_REGISTRAR', motivo: fila.motivoSinRegistro }
            : { paymentId: fila.paymentId }),
        },
      })
    }
    // H5: el gerente terminó un folio «pendiente de terminar» (sólo quien cerró la incidencia lo anuncia, D4).
    if (pendienteCerrado && terminadoPor) {
      await logAction({
        action: 'CASH_MACHINE_FOLIO_FINISHED',
        entity: 'CashMachineClose',
        entityId: fila.id,
        venueId,
        staffId: terminadoPor,
        data: {
          referenceCC,
          outcome: fila.outcome,
          deviceId: folio.deviceId,
          ...(fila.motivoSinRegistro
            ? { incident: 'NO_SE_PUDO_REGISTRAR', motivo: fila.motivoSinRegistro }
            : { paymentId: fila.paymentId }),
        },
      })
    }
    return respuestaDelCierre(prisma, fila, folio.deviceId)
  }

  if (c.outcome !== 'PAGADO') {
    try {
      const r = await conElFolio(venueId, referenceCC, tx =>
        escribirCierreEnTx(tx, filaDelCierre({ orderId: null, paymentId: null, appliedCents: 0, shiftStatus: turno.shiftStatus })),
      )
      return despues(r.fila, r.dudaCerrada, r.pendienteCerrado)
    } catch (error) {
      if (error instanceof YaTerminado || esChoqueDeUnico(error)) return loQueQuedo()
      if (esTransitorio(error)) return recibido(referenceCC, folio)
      throw error
    }
  }

  // PAGADO: ¿se puede vender lo congelado?
  if (dec.motivoSinVenta) return sinVenta(dec.motivoSinVenta)
  // F4 y H3/H4: el reparto venta/propina congelado no cuadra con el adeudo, trae fracción de centavo o no llegó como número: el dinero
  // queda, la venta no se arma.
  if (!repartoVendible(folio)) return sinVenta('REPARTO_DESCUADRADO')
  const saleCents = folio.saleCents as number
  const tipCents = folio.tipCents as number
  if (folio.pedido == null) return sinVenta('SIN_CARRITO')
  let pedido: CreateOrderInput
  try {
    pedido = await leerPedido(folio.pedido, dec.vendedorPorOmision)
  } catch (error) {
    // F3: sólo la base es pasajera (RECIBIDO, el reenvío lo reanuda). Cualquier otro error al leer la copia congelada —un 4xx del
    // lector, una línea nula, una cantidad rota— se repetiría igual cada vez: el carrito no se puede leer como venta (r3 #1).
    if (esTransitorio(error)) {
      logger.warn('[MAQUINA] no se pudo leer el carrito congelado; el folio queda RECIBIDO', { venueId, referenceCC })
      return recibido(referenceCC, folio)
    }
    return sinVenta('CARRITO_ILEGIBLE', { detalle: error instanceof Error ? error.message : String(error) })
  }
  const motivoDelPedido = motivoSinVentaDelPedido(pedido)
  if (motivoDelPedido) return sinVenta(motivoDelPedido)

  try {
    const r = await venderLoQueCobroLaMaquina(venueId, {
      venta: pedido,
      referenceCC,
      saleCents,
      tipCents,
      procesadoPor: dec.userId,
      horaDelCierre: hora,
      turno: { shiftIdDeLaVenta: turno.expectedShiftId, porConciliar: turno.porConciliar },
      cerrarEnTx: async (tx, cobro) => {
        const shiftStatus: EstadoDelTurnoDeLaMaquina = cobro.shiftId ? 'EN_TURNO' : turno.porConciliar ? 'POR_CONCILIAR' : 'TURNO_CERRADO'
        const escrito = await escribirCierreEnTx(tx, filaDelCierre({ ...cobro, shiftStatus }))
        // Codex r1 #13: la venta de la máquina sin turno se avisa SIEMPRE, en la misma transacción.
        if (!cobro.shiftId) {
          await tx.activityLog.create({
            data: {
              action: 'CASH_MACHINE_SALE_WITHOUT_SHIFT',
              entity: 'Payment',
              entityId: cobro.paymentId,
              staffId: dec.userId,
              venueId,
              data: {
                referenceCC,
                orderId: cobro.orderId,
                shiftStatus,
                saleShiftId: folio.saleShiftId,
                totalPesos: (cobro.appliedCents + tipCents) / 100,
              },
            },
          })
        }
        return escrito
      },
    })
    return despues(r.fila, r.dudaCerrada, r.pendienteCerrado)
  } catch (error) {
    if (error instanceof YaTerminado || esChoqueDeUnico(error)) return loQueQuedo()
    const motivo = motivoPermanente(error)
    if (motivo) {
      const codigo = error instanceof AppError ? error.code : undefined
      return sinVenta(motivo, { detalle: error instanceof Error ? error.message : String(error), ...(codigo ? { codigo } : {}) })
    }
    // Pasajero: la evidencia y el desenlace ya están guardados; el reenvío lo reanuda (r6-1).
    logger.warn('[MAQUINA] la venta del folio quedó RECIBIDA sin terminar', {
      venueId,
      referenceCC,
      error: error instanceof Error ? error.message : String(error),
    })
    return recibido(referenceCC, folio)
  }
}

/** `POST /mobile/venues/:venueId/cash-machine/sales`. */
export async function registrarVentaDeLaMaquina(
  venueId: string,
  autor: AutorDeLaMaquina,
  entrada: EntradaDeLaMaquina,
  leerPedido: LectorDelPedido,
): Promise<ResultadoDeLaMaquina> {
  if (!CASH_MACHINE_REF.test(entrada.referenceCC)) {
    throw new BadRequestError('El folio de la máquina debe ser AQ seguido de 12 letras mayúsculas o números.')
  }
  const deviceId = await aparatoDe(venueId, autor.deviceUid)
  // R4-3: sólo una credencial de ESTA PC, antes de escribir nada (tampoco una incidencia). r6-6: el emparejamiento del intento.
  const { bindingId, bindingDeLaCredencial } = await exigirAparatoEmparejado(venueId, deviceId, autor.credencial, entrada.bindingId ?? null)
  return recibirCierreDeLaMaquina(
    venueId,
    {
      origen: 'PC',
      referenceCC: entrada.referenceCC,
      // H3/H4: lo que no es físico se lee aquí (lo desconocido cuenta como desconocido), nunca en la ruta.
      cierre: leerCierreDeLaPc(entrada.cierre as unknown as Record<string, unknown>),
      pedido: entrada.pedido,
      userId: autor.userId,
      deviceId,
      bindingId,
      bindingDeLaCredencial,
    },
    leerPedido,
  )
}

/**
 * `GET /mobile/venues/:venueId/cash-machine/sales/:referenceCC`: el MISMO acuse que el POST — 200/202 TERMINADO con el cierre, o 202
 * RECIBIDO si el desenlace quedó y la venta todavía no —. Sin desenlace, 404. Lee bajo el candado: nunca escribe.
 */
export async function consultarVentaDeLaMaquina(venueId: string, referenceCC: string): Promise<ResultadoDeLaMaquina> {
  const l = await conElFolio(venueId, referenceCC, async (_tx, lectura) => lectura)
  const d = decidirSobreElFolio(l.estado, { que: 'CONSULTA' })
  if (d.accion === 'TERMINADO' && l.cierre) return respuestaDelCierre(prisma, l.cierre, l.folio?.deviceId ?? l.cierre.deviceId)
  if (d.accion === 'RECIBIDO') return recibido(referenceCC, l.folio)
  throw new NotFoundError('Ese folio de la máquina no tiene un cierre registrado.', 'CASH_MACHINE_SALE_NOT_FOUND')
}
