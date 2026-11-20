/**
 * Máquina de efectivo QuickPay Mini · fase 1a (plan `docs/superpowers/plans/2026-11-20-maquina-de-efectivo-fase-1a.md`, R4-1, R4-7,
 * R3#6, R3#9, R5#1, R5#5, R5#7). La PC de WINDOWS sube UNA petición por operación de la máquina (folio = `referenceCC`):
 *
 *  · `PAGADO`: la cuenta nace, se paga y se cierra en UNA transacción (`venderLoQueCobroLaMaquina`); nadie la vio abierta.
 *  · `CANCELADO` / `GUARDADO`: sólo el cierre, sin cuenta ni pago.
 *
 * El mismo núcleo (`registrarCierreDeLaMaquina`) registra lo que un GERENTE resuelve de una duda (`dudasDeLaMaquina.ts`, R4-4), y
 * cierra la duda del folio en la misma transacción que el cierre. Quién puede escribir el desenlace lo decide UNA función pura,
 * `decidirEscrituraDelFolio` (`decisionDelFolio.ts`, Codex servidor r2 familia A), bajo el candado del folio.
 *
 * Un folio se guarda una sola vez (`CashMachineClose @@unique([venueId, referenceCC])`). La misma operación repetida responde lo
 * mismo; otra con el mismo folio es 409, la imposible 422 y la que ya no se puede armar 202: las tres quedan como
 * `CashMachineIncident` DURABLE, escrita en su propia sentencia (nunca dentro de la transacción que se revierte).
 */
import { Prisma, type CashMachineClose } from '@prisma/client'
import cuid from 'cuid'

import AppError, { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { operationHash } from '../../utils/operationHash'
import { withDeadlockRetry, type TxConReintento } from '../../utils/serializableRetry'
import { utcTs } from '../../utils/sqlDates'
import { logAction } from '../dashboard/activity-log.service'
import { CuentaDeLaMaquinaYaExiste, venderLoQueCobroLaMaquina, type CreateOrderInput } from '../mobile/order.mobile.service'
import { candadoDeLaLlave } from '../mobile/pagarDespuesLlave'
import { acumularEvento, decidirEscrituraDelFolio, type EstadoDelFolio, type PeticionSobreElFolio } from './decisionDelFolio'
import { aparatoDe, exigirAparatoEmparejado } from './emparejamiento'

/** Folio de la máquina: `AQ` + 12 `[0-9A-Z]`. La llave del pago y de la cuenta es `"maquina-" + referenceCC`. */
export const CASH_MACHINE_REF = /^AQ[0-9A-Z]{12}$/
export const DESENLACES_DE_LA_MAQUINA = ['PAGADO', 'CANCELADO', 'GUARDADO'] as const
export type DesenlaceDeLaMaquina = (typeof DESENLACES_DE_LA_MAQUINA)[number]
export type DeudaConElCliente = 'CAMBIO' | 'GUARDADO' | 'NO_DEVUELTO' | 'EXCEDENTE'
export type EstadoDelTurnoDeLaMaquina = 'EN_TURNO' | 'TURNO_CERRADO' | 'POR_CONCILIAR'
export type QuienResolvio = 'MAQUINA' | 'GERENTE'
/** `TRAS_REVOCAR`: la PC revocada subió un folio nuevo (decisión d del founder, Codex r1 #5): queda para que el gerente lo revise. */
export type TipoDeIncidencia = 'CONFLICTO' | 'IMPOSIBLE' | 'NO_SE_PUDO_REGISTRAR' | 'TRAS_REVOCAR'
/**
 * Por qué un folio PAGADO quedó sin venta (202), con su dinero en la incidencia:
 *  · `DESCUENTO`: la fase 1a no cobra descuentos en la máquina (decisión a del founder);
 *  · `PC_REVOCADA`: la PC revocada cobró después de que la revocaron, o sin hora (decisión d);
 *  · `SIN_SALDAR`: la cuenta no nacía pagada con lo que entró (Codex r1 #1);
 *  · `SIN_CARRITO`: el gerente confirmó un cobro de una duda sin carrito;
 *  · `VENTA_RECHAZADA`: la venta ya no se arma (un producto borrado, el personal…; R5#1);
 *  · `PREMIO_PENDIENTE`: el carrito trae un premio de sellos (R5#4): la cotización ya lo excluía (Codex r2 #11).
 */
export type MotivoSinRegistro = 'DESCUENTO' | 'PC_REVOCADA' | 'SIN_SALDAR' | 'SIN_CARRITO' | 'VENTA_RECHAZADA' | 'PREMIO_PENDIENTE'

/** Lo que la máquina dijo al cerrar, en CENTAVOS (así los manda la PC). */
export interface CierreDeLaMaquina {
  outcome: DesenlaceDeLaMaquina
  dueCents: number
  saleCents: number
  tipCents: number
  creditCents: number
  changeDispensedCents: number
  /** Hora física del cierre (ISO). Sólo cuenta con `occurredAtKnown`. */
  occurredAt?: string | null
  occurredAtKnown: boolean
  /** El turno A con el que la PC vendió. */
  saleShiftId?: string | null
  /**
   * Codex r1 #12 (R4-7 #6): el `cancel` que mandó la PC — `'1'` devolver, `'2'` guardar —. Sólo con él una cancelación es lo que dice:
   * `CANCELADO` exige `'1'` y `GUARDADO` `'2'`; sin él (cancelaron desde la pantalla de la máquina) el modo es desconocido → revisión.
   */
  cancelMode?: '1' | '2' | null
}

/** La evidencia completa: IGUAL en el primer éxito, la repetición y el GET (R4-1, R5#7). */
export interface RespuestaDeLaMaquina {
  referenceCC: string
  outcome: string
  resolvedBy: string
  owedKind: string | null
  orderId: string | null
  paymentId: string | null
  dueCents: number
  saleCents: number
  tipCents: number
  appliedCents: number
  excedenteCents: number
  creditCents: number
  changeDispensedCents: number
  owedCents: number
  shiftStatus: string | null
}

/**
 * Codex r1 #3: el comprobante ESTABLE de un folio que no se pudo registrar como venta. Sale igual en el primer 202, en cada repetición,
 * en el GET y en la consulta de la duda: los importes físicos del PRIMER registro, para que la PC retire su pendiente.
 */
export interface RespuestaSinRegistro {
  referenceCC: string
  incident: 'NO_SE_PUDO_REGISTRAR'
  /** La incidencia DURABLE que guarda el dinero (contrato con el POS: sólo con ella marca su fila como subida). */
  incidentId: string | null
  motivo: MotivoSinRegistro
  outcome: string
  resolvedBy: string
  dueCents: number
  saleCents: number
  tipCents: number
  creditCents: number
  changeDispensedCents: number
}

export type ResultadoDeLaMaquina = { status: 200; body: RespuestaDeLaMaquina } | { status: 202; body: RespuestaSinRegistro }

/** Quién sube: la sesión (procesa el cobro), el aparato del encabezado `X-Device-Id` y su credencial (`X-Cash-Machine-Credential`). */
export interface AutorDeLaMaquina {
  userId: string
  deviceUid: string | null
  credencial: string | null
}

export interface EntradaDeLaMaquina {
  referenceCC: string
  cierre: CierreDeLaMaquina
  /** Sólo con `PAGADO`: el pedido ya leído como `POST /orders` (`leerVentaDeMostrador` + `autoridadDeLaVenta`). */
  pedido?: CreateOrderInput
}

/** Codex r1 #12 (decisión h): la máquina sólo cobra un adeudo mayor que $0 y múltiplo de $0.50. */
export const adeudoCobrable = (dueCents: number): boolean => Number.isInteger(dueCents) && dueCents > 0 && dueCents % 50 === 0

/**
 * R3#9, R5#5, R4-7 #6: ¿esta combinación de importes puede salir de la máquina? Cualquier otra cosa es 422 con incidencia.
 *  · todos enteros ≥ 0, `due = sale + tip` y el adeudo mayor que 0 y múltiplo de 50 centavos (Codex r1 #12);
 *  · `PAGADO`: `credit ≥ due` y `0 ≤ change ≤ credit − due`;
 *  · `CANCELADO` y `GUARDADO`: `credit < due` (con el adeudo cubierto no hay cancelación posible); `GUARDADO` no devuelve nada y
 *    `CANCELADO` no devuelve más de lo que entró; y el modo del `cancel` coincide (`'1'` / `'2'`): sin él, revisión (Codex r1 #12).
 */
export function validarCierre(c: CierreDeLaMaquina): 'OK' | 'IMPOSIBLE' {
  if (!DESENLACES_DE_LA_MAQUINA.includes(c.outcome)) return 'IMPOSIBLE'
  const importes = [c.dueCents, c.saleCents, c.tipCents, c.creditCents, c.changeDispensedCents]
  if (!importes.every(n => Number.isInteger(n) && n >= 0)) return 'IMPOSIBLE'
  if (c.dueCents !== c.saleCents + c.tipCents || !adeudoCobrable(c.dueCents)) return 'IMPOSIBLE'
  if (c.outcome === 'PAGADO') {
    return c.creditCents >= c.dueCents && c.changeDispensedCents <= c.creditCents - c.dueCents ? 'OK' : 'IMPOSIBLE'
  }
  if (c.creditCents >= c.dueCents) return 'IMPOSIBLE'
  if (c.outcome === 'GUARDADO') return c.changeDispensedCents === 0 && c.cancelMode === '2' ? 'OK' : 'IMPOSIBLE'
  return c.changeDispensedCents <= c.creditCents && c.cancelMode === '1' ? 'OK' : 'IMPOSIBLE'
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

/**
 * Lo que hace que dos envíos del mismo folio sean LA MISMA operación: sucursal, folio, desenlace, quién lo resolvió y los importes.
 * La cuenta es la del folio (`maquina-<folio>`); la hora y el turno no entran (un reenvío de la PC los repite tal cual).
 */
export function huellaDelCierre(
  venueId: string,
  referenceCC: string,
  c: Pick<CierreDeLaMaquina, 'outcome' | 'dueCents' | 'saleCents' | 'tipCents' | 'creditCents' | 'changeDispensedCents'>,
  resolvedBy: string,
): string {
  return operationHash({
    venueId,
    referenceCC,
    outcome: c.outcome,
    resolvedBy,
    dueCents: c.dueCents,
    saleCents: c.saleCents,
    tipCents: c.tipCents,
    creditCents: c.creditCents,
    changeDispensedCents: c.changeDispensedCents,
  })
}

function horaDelCierre(c: CierreDeLaMaquina): Date | null {
  if (!c.occurredAtKnown || !c.occurredAt) return null
  const hora = new Date(c.occurredAt)
  return Number.isNaN(hora.getTime()) ? null : hora
}

/**
 * R4-7 #8: el turno del cierre. Con el turno A de la PC y la hora física: A abierto → A; A cerrado y el dinero entró durante A → sin
 * turno (`SALE_SHIFT_CLOSED`, como la cola); el dinero entró ANTES de que A empezara o después de que terminó (Codex r1 #11: los dos
 * extremos), sin hora, sin turno o con un turno que no es del negocio → por conciliar. Nunca el turno vivo.
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

export function respuestaDe(fila: CashMachineClose): RespuestaDeLaMaquina {
  return {
    referenceCC: fila.referenceCC,
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
  }
}

/**
 * Codex r2 #5 (familia C): la huella de los ARTÍCULOS del carrito —producto (cada variante es su propio producto), nombre de un renglón
 * libre, cantidad, peso, extras, precios mostrados o escritos y lo que pide un descuento o promoción—, no sólo el total: dos carritos con
 * el mismo importe y otra mercancía son operaciones distintas. Sin orden: el mismo carrito reordenado es el mismo. `null` = sin carrito.
 */
export function huellaDelCarrito(pedido: { items?: unknown } | null | undefined): string | null {
  const items = pedido && Array.isArray(pedido.items) ? (pedido.items as Array<Record<string, unknown> | null>) : null
  if (!items) return null
  const renglones = items.map(i => {
    const r = i ?? {}
    return operationHash({
      productId: r.productId ?? null,
      name: r.productId ? null : (r.name ?? null),
      unitPrice: r.unitPrice ?? null,
      quantity: r.quantity ?? null,
      weightQuantity: r.weightQuantity ?? null,
      modifierIds: Array.isArray(r.modifierIds) ? r.modifierIds.map(String).sort() : [],
      displayedUnitPrice: r.displayedUnitPrice ?? null,
      displayedModifierPrices: r.displayedModifierPrices ?? null,
      adjustedUnitPrice: r.adjustedUnitPrice ?? null,
      discountId: r.discountId ?? null,
      isCortesia: r.isCortesia === true,
      promotionRef: r.promotionRef ?? null,
    })
  })
  return operationHash(renglones.sort())
}

/** Dentro de la transacción de la venta, el folio cambió desde la primera decisión: se revierte y se vuelve a decidir. */
class DecisionDistinta extends Error {}

/**
 * La venta ya no se puede armar (400/403/404/422: un producto o un extra borrado, el personal, un descuento, la cuenta que no nace
 * pagada). Un 409 NO lo es: es concurrencia (`withDeadlockRetry` agotado, otro cobro a la vez) y la PC reintenta el mismo folio.
 */
const esRechazoDeLaVenta = (error: unknown): boolean =>
  error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 409

const esChoqueDeUnico = (error: unknown): boolean => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

type DbDelFolio = Pick<Prisma.TransactionClient, 'cashMachineIncident' | 'cashMachineClose'>

/**
 * La incidencia DURABLE: una fila por folio y tipo. Quien llama TIENE el candado del folio (lee la evidencia anterior y la acumula sin
 * perder entregas, `acumularEvento`: primer y último evento real, repeticiones idénticas aparte, la revisión se conserva). Una entrega
 * idéntica no reabre la fila; una nueva sí. Si falla, el error sube: la PC no recibe un 409/422/202 «final» sin la evidencia guardada.
 */
async function guardarIncidencia(
  tx: DbDelFolio & Pick<Prisma.TransactionClient, '$queryRaw'>,
  venueId: string,
  referenceCC: string,
  kind: TipoDeIncidencia,
  deviceId: string | null,
  evento: Record<string, unknown>,
): Promise<string | null> {
  const previa = await tx.cashMachineIncident.findUnique({
    where: { venueId_referenceCC_kind: { venueId, referenceCC, kind } },
    select: { payload: true, status: true },
  })
  const { payload, nueva } = acumularEvento(previa?.payload ?? null, evento)
  const status = !previa || nueva ? 'ABIERTO' : previa.status
  const ahora = new Date()
  const filas = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "CashMachineIncident" ("id", "venueId", "referenceCC", "kind", "status", "payload", "deviceId", "createdAt", "updatedAt")
    VALUES (${cuid()}, ${venueId}, ${referenceCC}, ${kind}, 'ABIERTO', ${JSON.stringify(payload)}::jsonb, ${deviceId}, ${utcTs(ahora)}, ${utcTs(ahora)})
    ON CONFLICT ("venueId", "referenceCC", "kind") DO UPDATE SET
      "payload" = EXCLUDED."payload",
      "status" = ${status},
      "updatedAt" = EXCLUDED."updatedAt"
    RETURNING "id"`
  return filas[0]?.id ?? null
}

const ACCION_DE_LA_INCIDENCIA: Record<TipoDeIncidencia, string> = {
  CONFLICTO: 'CASH_MACHINE_CLOSE_CONFLICT',
  IMPOSIBLE: 'CASH_MACHINE_CLOSE_IMPOSSIBLE',
  NO_SE_PUDO_REGISTRAR: 'CASH_MACHINE_SALE_NOT_RECORDED',
  TRAS_REVOCAR: 'CASH_MACHINE_FOLIO_AFTER_UNPAIR',
}

/** Lo que una transacción del folio dejó anotado: va a la bitácora del dueño DESPUÉS del commit. */
export interface IncidenciaAnotada {
  kind: TipoDeIncidencia
  id: string | null
  evento: Record<string, unknown>
}

export async function anotarEnTx(
  tx: TxConReintento,
  venueId: string,
  referenceCC: string,
  deviceId: string | null,
  anotadas: IncidenciaAnotada[],
  kind: TipoDeIncidencia,
  evento: Record<string, unknown>,
): Promise<void> {
  anotadas.push({ kind, evento, id: await guardarIncidencia(tx, venueId, referenceCC, kind, deviceId, evento) })
}

export async function anotarEnBitacora(venueId: string, referenceCC: string, staffId: string, anotadas: IncidenciaAnotada[]) {
  for (const a of anotadas) {
    await logAction({
      action: ACCION_DE_LA_INCIDENCIA[a.kind],
      entity: 'CashMachineIncident',
      entityId: a.id ?? undefined,
      venueId,
      staffId,
      data: { referenceCC, kind: a.kind, ...a.evento } as unknown as Prisma.InputJsonValue,
    })
  }
}

/** Bajo el candado del folio (el mismo de la cuenta `maquina-<folio>`): lo que el folio ya tiene, leído DENTRO de la transacción. */
export async function conElFolio<T>(
  venueId: string,
  referenceCC: string,
  fn: (tx: TxConReintento, lectura: LecturaDelFolio) => Promise<T>,
): Promise<T> {
  return withDeadlockRetry(
    async tx => {
      await tx.$queryRaw(candadoDeLaLlave(venueId, `maquina-${referenceCC}`))
      return fn(tx, await leerEstadoDelFolio(tx, venueId, referenceCC))
    },
    { etiqueta: 'conElFolio' },
  )
}

/** La incidencia sola (un 422 de importes imposibles), con su candado, y su renglón en la bitácora. Devuelve su id. */
export async function anotarIncidencia(
  venueId: string,
  referenceCC: string,
  kind: TipoDeIncidencia,
  autor: { userId: string; deviceId: string | null },
  evento: Record<string, unknown>,
): Promise<string | null> {
  const anotadas = await conElFolio(venueId, referenceCC, async tx => {
    const a: IncidenciaAnotada[] = []
    await anotarEnTx(tx, venueId, referenceCC, autor.deviceId, a, kind, evento)
    return a
  })
  await anotarEnBitacora(venueId, referenceCC, autor.userId, anotadas)
  return anotadas[0]?.id ?? null
}

/**
 * La duda de este folio (`ESPERANDO`) queda RESUELTO: lo decidió la máquina (la PC subió el cierre real) o un gerente (`staffId`). Se
 * llama dentro de la transacción que guarda el cierre o el «no se pudo registrar» del folio. 🔴 Codex r2 #4: sólo la duda de ESA PC
 * (`deviceId`): un desenlace escrito para otra PC nunca cierra la de la dueña.
 */
export function marcarDudaResuelta(
  db: Pick<Prisma.TransactionClient, '$executeRaw'>,
  venueId: string,
  referenceCC: string,
  deviceId: string | null,
  staffId: string | null,
  resolucion: Record<string, unknown>,
): Promise<number> {
  const ahora = new Date()
  return db.$executeRaw`
    UPDATE "CashMachineIncident"
    SET "status" = 'RESUELTO', "resolvedByStaffId" = ${staffId}, "resolvedAt" = ${utcTs(ahora)}, "updatedAt" = ${utcTs(ahora)},
        "payload" = "payload" || jsonb_build_object('resolucion', ${JSON.stringify(resolucion)}::jsonb)
    WHERE "venueId" = ${venueId} AND "referenceCC" = ${referenceCC} AND "kind" = 'ESPERANDO' AND "status" = 'ABIERTO'
      AND "deviceId" IS NOT DISTINCT FROM ${deviceId}`
}

type EventoSinRegistro = {
  cierre?: CierreDeLaMaquina
  motivo?: MotivoSinRegistro
  resolvedBy?: string
  huella?: string
  huellaDelCarrito?: string | null
}
const primerEvento = (payload: unknown): EventoSinRegistro | undefined =>
  (payload as { eventos?: EventoSinRegistro[] } | null)?.eventos?.[0]

/** El comprobante estable de un folio sin registro: el PRIMER evento guardado (los importes físicos de ese momento) y su incidencia. */
export function respuestaSinRegistro(referenceCC: string, payload: unknown, incidentId: string | null): RespuestaSinRegistro | null {
  const ev = primerEvento(payload)
  if (!ev?.cierre) return null
  const c = ev.cierre
  return {
    referenceCC,
    incident: 'NO_SE_PUDO_REGISTRAR',
    incidentId,
    motivo: ev.motivo ?? 'VENTA_RECHAZADA',
    outcome: c.outcome,
    resolvedBy: ev.resolvedBy ?? 'MAQUINA',
    dueCents: c.dueCents,
    saleCents: c.saleCents,
    tipCents: c.tipCents,
    creditCents: c.creditCents,
    changeDispensedCents: c.changeDispensedCents,
  }
}

/** La duda guardada (`ESPERANDO`): lo que subió la PC. Sólo lo que la decisión y la resolución necesitan. */
export interface DudaGuardadaDelFolio {
  dueCents: number
  saleCents: number
  tipCents: number
  pedido?: Record<string, unknown>
  huellaDelCarrito?: string | null
}

/** Lo que el folio tiene, leído bajo su candado: las filas (para responder) y su estado (para decidir). La duda va PRIMERO (r1 #6). */
export interface LecturaDelFolio {
  duda: { id: string; deviceId: string | null; status: string; payload: unknown } | null
  cierre: CashMachineClose | null
  sinRegistro: { id: string; payload: unknown; deviceId: string | null } | null
  estado: EstadoDelFolio
}

export async function leerEstadoDelFolio(db: DbDelFolio, venueId: string, referenceCC: string): Promise<LecturaDelFolio> {
  const duda = await db.cashMachineIncident.findUnique({
    where: { venueId_referenceCC_kind: { venueId, referenceCC, kind: 'ESPERANDO' } },
    select: { id: true, deviceId: true, status: true, payload: true },
  })
  const cierre = await db.cashMachineClose.findUnique({ where: { venueId_referenceCC: { venueId, referenceCC } } })
  const sinRegistro = await db.cashMachineIncident.findUnique({
    where: { venueId_referenceCC_kind: { venueId, referenceCC, kind: 'NO_SE_PUDO_REGISTRAR' } },
    select: { id: true, payload: true, deviceId: true },
  })
  const ev = sinRegistro ? primerEvento(sinRegistro.payload) : undefined
  const d = duda ? ((duda.payload ?? {}) as unknown as DudaGuardadaDelFolio) : null
  return {
    duda,
    cierre,
    sinRegistro,
    estado: {
      cierre: cierre
        ? {
            deviceId: cierre.deviceId,
            huella: huellaDelCierre(venueId, referenceCC, cierre as unknown as CierreDeLaMaquina, cierre.resolvedBy),
            huellaDelCarrito: cierre.cartHash ?? null,
            dueCents: cierre.dueCents,
            saleCents: cierre.saleCents,
            tipCents: cierre.tipCents,
          }
        : null,
      sinRegistro: sinRegistro
        ? {
            deviceId: sinRegistro.deviceId,
            huella: ev?.huella ?? null,
            huellaDelCarrito: ev?.huellaDelCarrito ?? null,
            dueCents: ev?.cierre?.dueCents ?? 0,
            saleCents: ev?.cierre?.saleCents ?? 0,
            tipCents: ev?.cierre?.tipCents ?? 0,
          }
        : null,
      duda:
        duda && d
          ? {
              deviceId: duda.deviceId,
              abierta: duda.status === 'ABIERTO',
              huella: null,
              huellaDelCarrito: d.huellaDelCarrito ?? huellaDelCarrito(d.pedido),
              dueCents: d.dueCents,
              saleCents: d.saleCents,
              tipCents: d.tipCents,
            }
          : null,
    },
  }
}

/** Lo que el folio ya tenía, para el 409 y su incidencia. A OTRA PC no se le enseña la evidencia de la dueña (r1 #4). */
function loRegistrado(referenceCC: string, lectura: LecturaDelFolio): Record<string, unknown> | null {
  if (lectura.cierre) return respuestaDe(lectura.cierre) as unknown as Record<string, unknown>
  if (lectura.sinRegistro) {
    return (respuestaSinRegistro(referenceCC, lectura.sinRegistro.payload, lectura.sinRegistro.id) ?? null) as Record<
      string,
      unknown
    > | null
  }
  const d = lectura.estado.duda
  return d ? { dueCents: d.dueCents, saleCents: d.saleCents, tipCents: d.tipCents } : null
}

/**
 * Decisión a del founder (Codex r1 #1 #9 #10): en la fase 1a la máquina no cobra NINGÚN descuento — de renglón (catálogo, «Ajuste de
 * precio», cortesía), de cuenta (libre, de catálogo, del cliente), cupón, promoción ni premio de sellos —. Así la máquina nunca aplica
 * uno que nadie autorizó, y la autorización no se pierde ni aparece entre la cotización, la venta y la resolución del gerente.
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

/**
 * Por qué un PAGADO con este pedido no se vuelve venta, con la MISMA regla en cotización, venta y resolución (Codex r2 #11): el premio de
 * sellos pendiente (lo conserva el lector del carrito de la máquina aunque la caja no declare `stampRewardAware`), cualquier descuento, o
 * ningún carrito (el gerente confirmó el cobro de una duda que ya no tiene uno).
 */
export function motivoSinVentaDelPedido(p: CreateOrderInput | undefined): MotivoSinRegistro | undefined {
  if (!p) return 'SIN_CARRITO'
  if (p.stampRewardId) return 'PREMIO_PENDIENTE'
  return pedidoConDescuento(p) ? 'DESCUENTO' : undefined
}

/** `POST /mobile/venues/:venueId/cash-machine/sales`. */
export async function registrarVentaDeLaMaquina(
  venueId: string,
  autor: AutorDeLaMaquina,
  entrada: EntradaDeLaMaquina,
): Promise<ResultadoDeLaMaquina> {
  if (!CASH_MACHINE_REF.test(entrada.referenceCC)) {
    throw new BadRequestError('El folio de la máquina debe ser AQ seguido de 12 letras mayúsculas o números.')
  }
  const deviceId = await aparatoDe(venueId, autor.deviceUid)
  // R4-3: antes de escribir nada (tampoco una incidencia): sólo una credencial de ESTA PC. Si la revocaron, la hora del comprobante
  // decide bajo el candado del folio (`decidirEscrituraDelFolio`, Codex r2 #1).
  const { revocadaEn } = await exigirAparatoEmparejado(venueId, deviceId, autor.credencial)
  return registrarCierreDeLaMaquina(venueId, { ...entrada, resolvedBy: 'MAQUINA', userId: autor.userId, deviceId, revocadaEn })
}

/** Quién decidió el desenlace, para el núcleo compartido por la PC y el gerente (R4-4). */
export interface CierreQueSeRegistra extends EntradaDeLaMaquina {
  resolvedBy: QuienResolvio
  /** MAQUINA: la sesión de la PC. GERENTE: el gerente del token (nunca del cuerpo). Procesa el cobro y firma la bitácora. */
  userId: string
  /** `Terminal.id` de la PC de la máquina (la que es dueña del folio). */
  deviceId: string | null
  /** GERENTE: lo que leyó en la máquina. */
  evidence?: string
  /** MAQUINA: cuándo revocaron la credencial de la PC (`null` = activa). El gerente no se revoca: él declara. */
  revocadaEn?: Date | null
  /** GERENTE: la huella del carrito CONGELADO en la duda (el pedido se arma de él; sin pedido, la duda ya se cerró). */
  huellaDelCarrito?: string | null
}

/**
 * El núcleo: valida, decide bajo el candado del folio (`decidirEscrituraDelFolio`) y guarda el cierre (y con `PAGADO`, la venta pagada)
 * UNA vez por folio, cerrando la duda de ESA PC en la misma transacción. Lo llaman la venta de la PC y la resolución del gerente. La
 * repetición, el conflicto, el «no se pudo registrar» y la carrera P2002 salen todos de la MISMA decisión.
 */
export async function registrarCierreDeLaMaquina(venueId: string, entrada: CierreQueSeRegistra): Promise<ResultadoDeLaMaquina> {
  const { referenceCC, cierre, resolvedBy, deviceId } = entrada
  if (entrada.pedido && cierre.outcome !== 'PAGADO') throw new BadRequestError('El pedido va sólo con un cierre PAGADO.')
  if (cierre.outcome === 'PAGADO' && !entrada.pedido && resolvedBy !== 'GERENTE') {
    throw new BadRequestError('Un cierre PAGADO lleva el pedido de la venta.')
  }
  const gerente = resolvedBy === 'GERENTE' ? entrada.userId : null
  const quien = { userId: entrada.userId, deviceId }
  const evidencia = {
    cierre,
    deviceId,
    recibidoEn: new Date().toISOString(),
    ...(gerente ? { resolvedBy, evidence: entrada.evidence ?? null } : {}),
  }

  if (validarCierre(cierre) === 'IMPOSIBLE') {
    const incidentId = await anotarIncidencia(venueId, referenceCC, 'IMPOSIBLE', quien, evidencia)
    throw new AppError(
      'Los importes de este cierre de la máquina no son posibles. Quedó registrado para que el gerente lo revise.',
      422,
      true,
      'CASH_MACHINE_CLOSE_IMPOSSIBLE',
      { incidentId },
    )
  }

  const huella = huellaDelCierre(venueId, referenceCC, cierre, resolvedBy)
  const carrito = entrada.huellaDelCarrito !== undefined ? entrada.huellaDelCarrito : huellaDelCarrito(entrada.pedido)
  const hora = horaDelCierre(cierre)
  const revocadaEn = resolvedBy === 'GERENTE' ? null : (entrada.revocadaEn ?? null)
  const motivoDelPedido = cierre.outcome === 'PAGADO' ? motivoSinVentaDelPedido(entrada.pedido) : undefined
  const peticion = (motivoSinVenta: MotivoSinRegistro | undefined): PeticionSobreElFolio => ({
    que: 'CIERRE',
    quien: resolvedBy === 'GERENTE' ? { tipo: 'GERENTE', deviceId } : { tipo: 'PC', deviceId, revocadaEn },
    outcome: cierre.outcome,
    horaDelComprobante: hora,
    evidencia: { huella, huellaDelCarrito: carrito },
    importes: { dueCents: cierre.dueCents, saleCents: cierre.saleCents, tipCents: cierre.tipCents },
    ...(motivoSinVenta ? { motivoSinVenta } : {}),
  })
  /** Lo que la duda guarda al cerrarse (y compara una resolución repetida sin cierre). */
  const resolucion = {
    resolvedBy,
    huella,
    outcome: cierre.outcome,
    creditCents: cierre.creditCents,
    changeDispensedCents: cierre.changeDispensedCents,
    occurredAt: cierre.occurredAtKnown ? (cierre.occurredAt ?? null) : null,
    ...(gerente ? { evidence: entrada.evidence ?? null } : {}),
  }

  /**
   * Bajo el candado del folio: decide y escribe todo lo que NO es venta (el 409 con su evidencia, el TRAS_REVOCAR, el «no se pudo
   * registrar» con el dinero real y el cierre de la duda de ESA PC). `null` = se registra: quien llama escribe la venta o el cierre.
   */
  const decidirYResponder = async (
    motivoSinVenta: MotivoSinRegistro | undefined,
    detalle: Record<string, unknown> = {},
  ): Promise<ResultadoDeLaMaquina | null> => {
    const r = await conElFolio(venueId, referenceCC, async (tx, lectura) => {
      const d = decidirEscrituraDelFolio(lectura.estado, peticion(motivoSinVenta))
      const anotadas: IncidenciaAnotada[] = []
      let sinRegistro: Record<string, unknown> | null = null
      if (d.accion === 'CONFLICTO') {
        await anotarEnTx(tx, venueId, referenceCC, deviceId, anotadas, 'CONFLICTO', {
          ...evidencia,
          motivo: d.motivo,
          registrado: { ...loRegistrado(referenceCC, lectura), deviceId: lectura.cierre?.deviceId ?? lectura.duda?.deviceId ?? null },
        })
      }
      if ((d.accion === 'REGISTRAR' || d.accion === 'SIN_REGISTRO') && d.trasRevocar) {
        await anotarEnTx(tx, venueId, referenceCC, deviceId, anotadas, 'TRAS_REVOCAR', {
          ...evidencia,
          revocadaEn: revocadaEn?.toISOString() ?? null,
          registrable: d.accion === 'REGISTRAR',
        })
      }
      if (d.accion === 'SIN_REGISTRO') {
        sinRegistro = {
          ...evidencia,
          resolvedBy,
          huella,
          huellaDelCarrito: carrito,
          motivo: d.motivo,
          ...detalle,
          pedido: (entrada.pedido ?? null) as unknown as Record<string, unknown>,
        }
        await anotarEnTx(tx, venueId, referenceCC, deviceId, anotadas, 'NO_SE_PUDO_REGISTRAR', sinRegistro)
        // La duda de ESTA PC (si la había) también se cierra: el dinero quedó en la incidencia y la PC deja de esperar.
        await marcarDudaResuelta(tx, venueId, referenceCC, deviceId, gerente, {
          ...resolucion,
          incident: 'NO_SE_PUDO_REGISTRAR',
          motivo: d.motivo,
        })
      }
      return { d, lectura, anotadas, sinRegistro }
    })
    await anotarEnBitacora(venueId, referenceCC, entrada.userId, r.anotadas)
    const { d, lectura } = r
    if (d.accion === 'REGISTRAR') return null
    if (d.accion === 'REPETIR' && d.de === 'CIERRE' && lectura.cierre) return { status: 200, body: respuestaDe(lectura.cierre) }
    const cuerpo =
      d.accion === 'SIN_REGISTRO'
        ? respuestaSinRegistro(
            referenceCC,
            { eventos: [r.sinRegistro] },
            r.anotadas.find(a => a.kind === 'NO_SE_PUDO_REGISTRAR')?.id ?? null,
          )
        : d.accion === 'REPETIR' && lectura.sinRegistro
          ? respuestaSinRegistro(referenceCC, lectura.sinRegistro.payload, lectura.sinRegistro.id)
          : null
    if (cuerpo) return { status: 202, body: cuerpo }
    throw new ConflictError(
      'Este folio de la máquina ya se registró con otros importes o desde otra PC. Quedó registrado para que el gerente lo revise.',
      'CASH_MACHINE_CLOSE_CONFLICT',
      {
        motivo: d.accion === 'CONFLICTO' ? d.motivo : 'OTRA_EVIDENCIA',
        registrado: d.accion === 'CONFLICTO' && d.motivo === 'OTRA_PC' ? null : loRegistrado(referenceCC, lectura),
        // La evidencia nueva quedó guardada ANTES de este 409 (contrato con el POS: sólo con ella marca su fila como subida).
        incidentId: r.anotadas.find(a => a.kind === 'CONFLICTO')?.id ?? null,
      },
    )
  }
  /** Dentro de la transacción que escribe (ya con el candado del folio): la decisión no cambió. Si cambió, se revierte todo. */
  const siguePorRegistrar = async (tx: TxConReintento) => {
    const lectura = await leerEstadoDelFolio(tx, venueId, referenceCC)
    if (decidirEscrituraDelFolio(lectura.estado, peticion(motivoDelPedido)).accion !== 'REGISTRAR') throw new DecisionDistinta()
  }

  const primera = await decidirYResponder(motivoDelPedido)
  if (primera) return primera

  const turnoA = cierre.saleShiftId
    ? await prisma.shift.findFirst({
        where: { id: cierre.saleShiftId, venueId },
        select: { id: true, status: true, startTime: true, endTime: true },
      })
    : null
  const turno = turnoDeLaMaquina(cierre, turnoA)
  const filaDelCierre = (cobro: {
    orderId: string | null
    paymentId: string | null
    appliedCents: number
    shiftStatus: EstadoDelTurnoDeLaMaquina
  }): Prisma.CashMachineCloseUncheckedCreateInput => {
    const excedenteCents = cierre.outcome === 'PAGADO' ? cierre.saleCents - cobro.appliedCents : 0
    return {
      venueId,
      referenceCC,
      outcome: cierre.outcome,
      resolvedBy,
      resolvedByStaffId: gerente,
      evidence: gerente ? (entrada.evidence ?? null) : null,
      dueCents: cierre.dueCents,
      saleCents: cierre.saleCents,
      tipCents: cierre.tipCents,
      creditCents: cierre.creditCents,
      changeDispensedCents: cierre.changeDispensedCents,
      appliedCents: cobro.appliedCents,
      excedenteCents,
      ...deudaDelCierre(cierre, excedenteCents),
      orderId: cobro.orderId,
      paymentId: cobro.paymentId,
      saleShiftId: cierre.saleShiftId ?? null,
      shiftStatus: cobro.shiftStatus,
      deviceId,
      occurredAt: hora,
      occurredAtKnown: hora !== null,
      cartHash: carrito,
    }
  }

  let fila: CashMachineClose
  try {
    if (cierre.outcome === 'PAGADO' && entrada.pedido) {
      fila = await venderLoQueCobroLaMaquina(venueId, {
        venta: entrada.pedido,
        referenceCC,
        saleCents: cierre.saleCents,
        tipCents: cierre.tipCents,
        procesadoPor: entrada.userId,
        horaDelCierre: hora,
        turno: { shiftIdDeLaVenta: turno.expectedShiftId, porConciliar: turno.porConciliar },
        cerrarEnTx: async (tx, cobro) => {
          await siguePorRegistrar(tx)
          const shiftStatus: EstadoDelTurnoDeLaMaquina = cobro.shiftId ? 'EN_TURNO' : turno.porConciliar ? 'POR_CONCILIAR' : 'TURNO_CERRADO'
          const creado = await tx.cashMachineClose.create({ data: filaDelCierre({ ...cobro, shiftStatus }) })
          await marcarDudaResuelta(tx, venueId, referenceCC, deviceId, gerente, resolucion)
          // Codex r1 #13: la venta de la máquina sin turno se avisa SIEMPRE, con o sin la conciliación prendida, en la misma transacción.
          if (!cobro.shiftId) {
            await tx.activityLog.create({
              data: {
                action: 'CASH_MACHINE_SALE_WITHOUT_SHIFT',
                entity: 'Payment',
                entityId: cobro.paymentId,
                staffId: entrada.userId,
                venueId,
                data: {
                  referenceCC,
                  orderId: cobro.orderId,
                  shiftStatus,
                  saleShiftId: cierre.saleShiftId ?? null,
                  totalPesos: (cobro.appliedCents + cierre.tipCents) / 100,
                },
              },
            })
          }
          return creado
        },
      })
    } else {
      // El MISMO candado que la cuenta de un `PAGADO` de este folio: los dos desenlaces se forman uno detrás del otro.
      fila = await conElFolio(venueId, referenceCC, async (tx, lectura) => {
        if (decidirEscrituraDelFolio(lectura.estado, peticion(motivoDelPedido)).accion !== 'REGISTRAR') throw new DecisionDistinta()
        const creado = await tx.cashMachineClose.create({
          data: filaDelCierre({ orderId: null, paymentId: null, appliedCents: 0, shiftStatus: turno.shiftStatus }),
        })
        await marcarDudaResuelta(tx, venueId, referenceCC, deviceId, gerente, resolucion)
        return creado
      })
    }
  } catch (error) {
    // El folio cambió entre la primera decisión y la escritura (otra petición lo cerró, la duda de otra PC, la carrera P2002, la cuenta
    // con la llave del folio sin su cierre): se revirtió todo y se vuelve a decidir bajo el candado con lo que ya tiene.
    const cambio = error instanceof DecisionDistinta || error instanceof CuentaDeLaMaquinaYaExiste || esChoqueDeUnico(error)
    const rechazo = !cambio && cierre.outcome === 'PAGADO' && esRechazoDeLaVenta(error)
    if (!cambio && !rechazo) throw error
    const codigo = error instanceof AppError ? error.code : undefined
    // R5#1: la cuenta ya no se puede armar (un producto o un extra que se borró, el personal, la llave, un descuento, una cuenta que no
    // nace pagada). El dinero real queda visible y el folio queda con ESE desenlace.
    const motivo: MotivoSinRegistro | undefined = rechazo
      ? codigo === 'CASH_MACHINE_SALE_WITH_DISCOUNT'
        ? 'DESCUENTO'
        : codigo === 'CASH_MACHINE_SALE_NOT_SETTLED'
          ? 'SIN_SALDAR'
          : 'VENTA_RECHAZADA'
      : error instanceof CuentaDeLaMaquinaYaExiste
        ? 'VENTA_RECHAZADA'
        : motivoDelPedido
    const otra = await decidirYResponder(
      motivo,
      rechazo || error instanceof CuentaDeLaMaquinaYaExiste
        ? { detalle: error instanceof Error ? error.message : String(error), ...(codigo ? { codigo } : {}) }
        : {},
    )
    if (otra) return otra
    // Volvió a quedar «por registrar» (la otra escritura se revirtió): la PC reintenta el mismo folio.
    throw new ConflictError('Otro registro de este folio estaba en curso. Intenta otra vez.', 'CASH_MACHINE_CLOSE_RETRY')
  }

  // La máquina le debe dinero al cliente: renglón para el dueño (las deudas se adjudican en la 1c).
  if (fila.owedCents > 0) {
    await logAction({
      action: 'CASH_MACHINE_OWES_CUSTOMER',
      entity: 'CashMachineClose',
      entityId: fila.id,
      venueId,
      staffId: entrada.userId,
      data: {
        referenceCC,
        outcome: fila.outcome,
        resolvedBy: fila.resolvedBy,
        owedKind: fila.owedKind,
        owedPesos: fila.owedCents / 100,
        orderId: fila.orderId,
      },
    })
  }
  return { status: 200, body: respuestaDe(fila) }
}

/**
 * `GET /mobile/venues/:venueId/cash-machine/sales/:referenceCC`: la MISMA respuesta que el POST — 200 con el cierre, o 202 con el
 * comprobante estable del «no se pudo registrar» (Codex r1 #3) —. Sin ninguno de los dos, 404. Lee bajo el candado y responde lo que
 * dice `decidirEscrituraDelFolio` (CONSULTA): nunca escribe.
 */
export async function consultarVentaDeLaMaquina(venueId: string, referenceCC: string): Promise<ResultadoDeLaMaquina> {
  const lectura = await conElFolio(venueId, referenceCC, async (_tx, l) => l)
  const d = decidirEscrituraDelFolio(lectura.estado, { que: 'CONSULTA' })
  if (d.accion === 'REPETIR' && d.de === 'CIERRE' && lectura.cierre) return { status: 200, body: respuestaDe(lectura.cierre) }
  const cuerpo =
    d.accion === 'REPETIR' && lectura.sinRegistro
      ? respuestaSinRegistro(referenceCC, lectura.sinRegistro.payload, lectura.sinRegistro.id)
      : null
  if (cuerpo) return { status: 202, body: cuerpo }
  throw new NotFoundError('Ese folio de la máquina no tiene un cierre registrado.', 'CASH_MACHINE_SALE_NOT_FOUND')
}
