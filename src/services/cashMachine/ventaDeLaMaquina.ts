/**
 * Máquina de efectivo QuickPay Mini · fase 1a (plan `docs/superpowers/plans/2026-11-20-maquina-de-efectivo-fase-1a.md`, R4-1, R4-7,
 * R3#6, R3#9, R5#1, R5#5, R5#7). La PC de WINDOWS sube UNA petición por operación de la máquina (folio = `referenceCC`):
 *
 *  · `PAGADO`: la cuenta nace, se paga y se cierra en UNA transacción (`venderLoQueCobroLaMaquina`); nadie la vio abierta.
 *  · `CANCELADO` / `GUARDADO`: sólo el cierre, sin cuenta ni pago.
 *
 * El mismo núcleo (`registrarCierreDeLaMaquina`) registra lo que un GERENTE resuelve de una duda (`dudasDeLaMaquina.ts`, R4-4), y
 * cierra la duda del folio en la misma transacción que el cierre.
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
 *  · `VENTA_RECHAZADA`: la venta ya no se arma (un producto borrado, el personal…; R5#1).
 */
export type MotivoSinRegistro = 'DESCUENTO' | 'PC_REVOCADA' | 'SIN_SALDAR' | 'SIN_CARRITO' | 'VENTA_RECHAZADA'

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

/** El cierre bajo el candado del folio ya existía (otra petición lo guardó primero). */
class CierreYaRegistrado extends Error {}
/** Bajo el candado del folio: el folio ya quedó como «no se pudo registrar» (Codex r1 #3). */
class FolioSinRegistro extends Error {}
/** Bajo el candado del folio: su duda la subió OTRA PC (Codex r1 #4). */
class FolioDeOtraPc extends Error {
  constructor(readonly dueno: string | null) {
    super('FOLIO_DE_OTRA_PC')
  }
}

/**
 * La venta ya no se puede armar (400/403/404/422: un producto o un extra borrado, el personal, un descuento, la cuenta que no nace
 * pagada). Un 409 NO lo es: es concurrencia (`withDeadlockRetry` agotado, otro cobro a la vez) y la PC reintenta el mismo folio.
 */
const esRechazoDeLaVenta = (error: unknown): boolean =>
  error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 409

const esChoqueDeUnico = (error: unknown): boolean => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

/**
 * La incidencia DURABLE: una fila por folio y tipo, en UNA sentencia aparte de la transacción que se revierte (o, con `db` = la
 * transacción del candado del folio, junto con lo que decide ese folio). Si falla, el error sube: la PC no recibe un 409/422/202
 * «final» sin la evidencia guardada y reintenta.
 * ponytail: guarda los primeros 50 eventos y cuenta todos (`veces`); una PC que reintenta para siempre no infla la fila.
 */
async function guardarIncidencia(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  venueId: string,
  referenceCC: string,
  kind: TipoDeIncidencia,
  deviceId: string | null,
  evento: Record<string, unknown>,
): Promise<string | null> {
  const ahora = new Date()
  const payload = JSON.stringify({ eventos: [evento], veces: 1 })
  const filas = await db.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "CashMachineIncident" ("id", "venueId", "referenceCC", "kind", "status", "payload", "deviceId", "createdAt", "updatedAt")
    VALUES (${cuid()}, ${venueId}, ${referenceCC}, ${kind}, 'ABIERTO', ${payload}::jsonb, ${deviceId}, ${utcTs(ahora)}, ${utcTs(ahora)})
    ON CONFLICT ("venueId", "referenceCC", "kind") DO UPDATE SET
      "payload" = jsonb_build_object(
        'eventos',
        CASE
          WHEN jsonb_array_length(COALESCE("CashMachineIncident"."payload" -> 'eventos', '[]'::jsonb)) < 50
            THEN COALESCE("CashMachineIncident"."payload" -> 'eventos', '[]'::jsonb) || (EXCLUDED."payload" -> 'eventos')
          ELSE "CashMachineIncident"."payload" -> 'eventos'
        END,
        'veces', COALESCE(("CashMachineIncident"."payload" ->> 'veces')::int, 1) + 1
      ),
      "status" = 'ABIERTO',
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

/** La incidencia (la evidencia) y, además, su renglón en la bitácora del dueño. */
export async function anotarIncidencia(
  venueId: string,
  referenceCC: string,
  kind: TipoDeIncidencia,
  autor: { userId: string; deviceId: string | null },
  evento: Record<string, unknown>,
): Promise<void> {
  const incidenciaId = await guardarIncidencia(prisma, venueId, referenceCC, kind, autor.deviceId, evento)
  await logAction({
    action: ACCION_DE_LA_INCIDENCIA[kind],
    entity: 'CashMachineIncident',
    entityId: incidenciaId ?? undefined,
    venueId,
    staffId: autor.userId,
    data: { referenceCC, kind, ...evento } as Prisma.InputJsonValue,
  })
}

/**
 * La duda de este folio (`ESPERANDO`) queda RESUELTO: lo decidió la máquina (la PC subió el cierre real) o un gerente (`staffId`). Se
 * llama dentro de la transacción que guarda el cierre o el «no se pudo registrar» del folio. `resolucion` se mezcla en el payload: es
 * lo que hace idempotente una resolución que no dejó cierre.
 */
export function marcarDudaResuelta(
  db: Pick<Prisma.TransactionClient, '$executeRaw'>,
  venueId: string,
  referenceCC: string,
  staffId: string | null,
  resolucion: Record<string, unknown>,
): Promise<number> {
  const ahora = new Date()
  return db.$executeRaw`
    UPDATE "CashMachineIncident"
    SET "status" = 'RESUELTO', "resolvedByStaffId" = ${staffId}, "resolvedAt" = ${utcTs(ahora)}, "updatedAt" = ${utcTs(ahora)},
        "payload" = "payload" || jsonb_build_object('resolucion', ${JSON.stringify(resolucion)}::jsonb)
    WHERE "venueId" = ${venueId} AND "referenceCC" = ${referenceCC} AND "kind" = 'ESPERANDO' AND "status" = 'ABIERTO'`
}

/** El «no se pudo registrar» del folio (Codex r1 #3): una vez escrito, es EL desenlace del folio; nada lo vuelve venta. */
export const sinRegistroDelFolio = (venueId: string, referenceCC: string) =>
  prisma.cashMachineIncident.findUnique({
    where: { venueId_referenceCC_kind: { venueId, referenceCC, kind: 'NO_SE_PUDO_REGISTRAR' } },
    select: { payload: true, deviceId: true },
  })

type EventoSinRegistro = { cierre?: CierreDeLaMaquina; motivo?: MotivoSinRegistro; resolvedBy?: string; huella?: string }
const primerEvento = (payload: unknown): EventoSinRegistro | undefined =>
  (payload as { eventos?: EventoSinRegistro[] } | null)?.eventos?.[0]

/** El comprobante estable de un folio sin registro: el PRIMER evento guardado (los importes físicos de ese momento). */
export function respuestaSinRegistro(referenceCC: string, payload: unknown): RespuestaSinRegistro | null {
  const ev = primerEvento(payload)
  if (!ev?.cierre) return null
  const c = ev.cierre
  return {
    referenceCC,
    incident: 'NO_SE_PUDO_REGISTRAR',
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
  // R4-3: antes de escribir nada (tampoco una incidencia): sólo la PC emparejada, o la revocada con SU folio o uno nuevo (R5#2).
  const { revocadaEn } = await exigirAparatoEmparejado(venueId, entrada.referenceCC, deviceId, autor.credencial)
  let sinAutoridad: MotivoSinRegistro | undefined
  if (revocadaEn) {
    // Decisión d (Codex r1 #5): la PC cobró sin red y la revocaron antes de que subiera. Lo que entró ANTES de revocarla (hora del
    // comprobante) se registra; lo de después o sin hora no es venta, pero su dinero queda como incidencia. Las dos, a revisión.
    // El candado no hace falta: la hora decide, y un comprobante anterior a la revocación lo es aunque la revoquen a media subida.
    const hora = horaDelCierre(entrada.cierre)
    const antes = hora !== null && hora <= revocadaEn
    await anotarIncidencia(
      venueId,
      entrada.referenceCC,
      'TRAS_REVOCAR',
      { userId: autor.userId, deviceId },
      { cierre: entrada.cierre, deviceId, revocadaEn: revocadaEn.toISOString(), registrable: antes, recibidoEn: new Date().toISOString() },
    )
    if (!antes) sinAutoridad = 'PC_REVOCADA'
  }
  return registrarCierreDeLaMaquina(venueId, { ...entrada, resolvedBy: 'MAQUINA', userId: autor.userId, deviceId, sinAutoridad })
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
  /** Un `PAGADO` que no puede ser venta aunque sus importes sean posibles (la PC revocada, decisión d): su dinero queda en la incidencia. */
  sinAutoridad?: MotivoSinRegistro
}

/**
 * El núcleo: valida, guarda el cierre (y con `PAGADO`, la venta pagada) UNA vez por folio, cierra la duda del folio en la misma
 * transacción y responde la evidencia. Lo llaman la venta de la PC (ya emparejada) y la resolución del gerente (`dudasDeLaMaquina`).
 */
export async function registrarCierreDeLaMaquina(venueId: string, entrada: CierreQueSeRegistra): Promise<ResultadoDeLaMaquina> {
  const { referenceCC, cierre, resolvedBy, deviceId } = entrada
  if ((cierre.outcome === 'PAGADO') !== Boolean(entrada.pedido)) {
    throw new BadRequestError('El pedido va sólo con un cierre PAGADO.')
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
    await anotarIncidencia(venueId, referenceCC, 'IMPOSIBLE', quien, evidencia)
    throw new AppError(
      'Los importes de este cierre de la máquina no son posibles. Quedó registrado para que el gerente lo revise.',
      422,
      true,
      'CASH_MACHINE_CLOSE_IMPOSSIBLE',
    )
  }

  const huella = huellaDelCierre(venueId, referenceCC, cierre, resolvedBy)
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
  /** Otra operación con este folio: 409 con la incidencia durable (también si el folio es de OTRA PC, Codex r1 #4). */
  const conflicto = async (registrado: unknown, extra: Record<string, unknown> = {}): Promise<never> => {
    await anotarIncidencia(venueId, referenceCC, 'CONFLICTO', quien, { ...evidencia, ...extra, registrado })
    throw new ConflictError(
      'Este folio de la máquina ya se registró con otros importes o desde otra PC. Quedó registrado para que el gerente lo revise.',
      'CASH_MACHINE_CLOSE_CONFLICT',
      { registrado },
    )
  }
  /** El folio ya tiene su cierre: la misma operación de la MISMA PC responde lo mismo; otra, 409 con incidencia. */
  const yaRegistrado = async (fila: CashMachineClose): Promise<ResultadoDeLaMaquina> => {
    if (fila.deviceId !== deviceId) return conflicto(respuestaDe(fila), { motivo: 'OTRA_PC' })
    if (huellaDelCierre(venueId, referenceCC, fila as unknown as CierreDeLaMaquina, fila.resolvedBy) === huella) {
      return { status: 200, body: respuestaDe(fila) }
    }
    return conflicto(respuestaDe(fila))
  }
  /** El folio ya quedó «no se pudo registrar» (Codex r1 #3): la misma operación recibe el MISMO comprobante; otra, 409. */
  const repetirSinRegistro = async (fila: { payload: unknown; deviceId: string | null }): Promise<ResultadoDeLaMaquina> => {
    const previa = respuestaSinRegistro(referenceCC, fila.payload)
    if (previa && fila.deviceId === deviceId && primerEvento(fila.payload)?.huella === huella) return { status: 202, body: previa }
    return conflicto(previa ?? fila.payload, fila.deviceId !== deviceId ? { motivo: 'OTRA_PC' } : {})
  }
  /**
   * El folio PAGADO no se vuelve venta: bajo el candado del folio se guarda UNA vez el «no se pudo registrar» con el dinero real y se
   * cierra su duda (R5#1, Codex r1 #3). Si mientras tanto el folio se cerró o ya tenía su «no se pudo», manda ése.
   */
  const noSePudoRegistrar = async (motivo: MotivoSinRegistro, detalle: Record<string, unknown> = {}): Promise<ResultadoDeLaMaquina> => {
    const evento = {
      ...evidencia,
      resolvedBy,
      huella,
      motivo,
      ...detalle,
      pedido: entrada.pedido as unknown as Record<string, unknown>,
    }
    const r: { cerrado?: CashMachineClose; previa?: { payload: unknown; deviceId: string | null }; id?: string | null } =
      await withDeadlockRetry(
        async tx => {
          await tx.$queryRaw(candadoDeLaLlave(venueId, `maquina-${referenceCC}`))
          const cerrado = await tx.cashMachineClose.findUnique({ where: { venueId_referenceCC: { venueId, referenceCC } } })
          if (cerrado) return { cerrado }
          const previa = await tx.cashMachineIncident.findUnique({
            where: { venueId_referenceCC_kind: { venueId, referenceCC, kind: 'NO_SE_PUDO_REGISTRAR' } },
            select: { payload: true, deviceId: true },
          })
          if (previa) return { previa }
          const id = await guardarIncidencia(tx, venueId, referenceCC, 'NO_SE_PUDO_REGISTRAR', deviceId, evento)
          // La duda del folio (si la había) también se cierra: el dinero quedó en la incidencia y la PC deja de esperar.
          await marcarDudaResuelta(tx, venueId, referenceCC, gerente, { ...resolucion, incident: 'NO_SE_PUDO_REGISTRAR', motivo })
          return { id }
        },
        { etiqueta: 'registrarCierreDeLaMaquina' },
      )
    if (r.cerrado) return yaRegistrado(r.cerrado)
    if (r.previa) return repetirSinRegistro(r.previa)
    await logAction({
      action: ACCION_DE_LA_INCIDENCIA.NO_SE_PUDO_REGISTRAR,
      entity: 'CashMachineIncident',
      entityId: r.id ?? undefined,
      venueId,
      staffId: entrada.userId,
      data: { referenceCC, kind: 'NO_SE_PUDO_REGISTRAR', ...evento } as unknown as Prisma.InputJsonValue,
    })
    return { status: 202, body: respuestaSinRegistro(referenceCC, { eventos: [evento] })! }
  }
  const cierreDelFolio = () => prisma.cashMachineClose.findUnique({ where: { venueId_referenceCC: { venueId, referenceCC } } })

  const previo = await cierreDelFolio()
  if (previo) return yaRegistrado(previo)
  const sinRegistro = await sinRegistroDelFolio(venueId, referenceCC)
  if (sinRegistro) return repetirSinRegistro(sinRegistro)
  // Codex r1 #4 (decisión e): la duda del folio es de la PC que la subió primero; otra PC emparejada no la cierra.
  const duda = await prisma.cashMachineIncident.findUnique({
    where: { venueId_referenceCC_kind: { venueId, referenceCC, kind: 'ESPERANDO' } },
    select: { deviceId: true },
  })
  if (duda && duda.deviceId !== deviceId) return conflicto({ duenoDeLaDuda: duda.deviceId }, { motivo: 'OTRA_PC' })
  if (cierre.outcome === 'PAGADO') {
    const motivo = entrada.sinAutoridad ?? (entrada.pedido && pedidoConDescuento(entrada.pedido) ? 'DESCUENTO' : undefined)
    if (motivo) return noSePudoRegistrar(motivo)
  }

  const turnoA = cierre.saleShiftId
    ? await prisma.shift.findFirst({
        where: { id: cierre.saleShiftId, venueId },
        select: { id: true, status: true, startTime: true, endTime: true },
      })
    : null
  const turno = turnoDeLaMaquina(cierre, turnoA)
  const hora = horaDelCierre(cierre)
  /** Bajo el candado del folio, lo que llegó mientras tanto manda: su «no se pudo registrar» o la duda de otra PC (Codex r1 #3, #4). */
  const loQueYaTieneElFolio = async (tx: TxConReintento): Promise<void> => {
    const otras = await tx.cashMachineIncident.findMany({
      where: { venueId, referenceCC, kind: { in: ['ESPERANDO', 'NO_SE_PUDO_REGISTRAR'] } },
      select: { kind: true, deviceId: true },
      take: 2,
    })
    if (otras.some(i => i.kind === 'NO_SE_PUDO_REGISTRAR')) throw new FolioSinRegistro()
    const suDuda = otras.find(i => i.kind === 'ESPERANDO')
    if (suDuda && suDuda.deviceId !== deviceId) throw new FolioDeOtraPc(suDuda.deviceId)
  }
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
          await loQueYaTieneElFolio(tx)
          const shiftStatus: EstadoDelTurnoDeLaMaquina = cobro.shiftId ? 'EN_TURNO' : turno.porConciliar ? 'POR_CONCILIAR' : 'TURNO_CERRADO'
          const creado = await tx.cashMachineClose.create({ data: filaDelCierre({ ...cobro, shiftStatus }) })
          await marcarDudaResuelta(tx, venueId, referenceCC, gerente, resolucion)
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
      fila = await withDeadlockRetry(
        async tx => {
          // El MISMO candado que la cuenta de un `PAGADO` de este folio: los dos desenlaces se forman uno detrás del otro.
          await tx.$queryRaw(candadoDeLaLlave(venueId, `maquina-${referenceCC}`))
          if (await tx.cashMachineClose.findUnique({ where: { venueId_referenceCC: { venueId, referenceCC } }, select: { id: true } })) {
            throw new CierreYaRegistrado()
          }
          await loQueYaTieneElFolio(tx)
          const creado = await tx.cashMachineClose.create({
            data: filaDelCierre({ orderId: null, paymentId: null, appliedCents: 0, shiftStatus: turno.shiftStatus }),
          })
          await marcarDudaResuelta(tx, venueId, referenceCC, gerente, resolucion)
          return creado
        },
        { etiqueta: 'registrarCierreDeLaMaquina' },
      )
    }
  } catch (error) {
    if (error instanceof FolioSinRegistro) {
      const ganadora = await sinRegistroDelFolio(venueId, referenceCC)
      if (ganadora) return repetirSinRegistro(ganadora)
      throw error
    }
    if (error instanceof FolioDeOtraPc) return conflicto({ duenoDeLaDuda: error.dueno }, { motivo: 'OTRA_PC' })
    if (error instanceof CierreYaRegistrado || error instanceof CuentaDeLaMaquinaYaExiste || esChoqueDeUnico(error)) {
      const ganadora = await cierreDelFolio()
      if (ganadora) return yaRegistrado(ganadora)
      // Un choque sin cierre no es de este folio: sube tal cual (la PC reintenta). La cuenta con la llave del folio sin su cierre sí:
      // la tomó otro escritor y esta venta ya no se puede armar.
      if (!(error instanceof CuentaDeLaMaquinaYaExiste)) throw error
    } else if (!(cierre.outcome === 'PAGADO' && esRechazoDeLaVenta(error))) {
      throw error
    }
    // R5#1: la cuenta ya no se puede armar (un producto o un extra que se borró, el personal, la llave, un descuento, una cuenta que no
    // nace pagada). El dinero real queda visible y el folio queda con ESE desenlace.
    const codigo = error instanceof AppError ? error.code : undefined
    const motivo: MotivoSinRegistro =
      codigo === 'CASH_MACHINE_SALE_WITH_DISCOUNT'
        ? 'DESCUENTO'
        : codigo === 'CASH_MACHINE_SALE_NOT_SETTLED'
          ? 'SIN_SALDAR'
          : 'VENTA_RECHAZADA'
    return noSePudoRegistrar(motivo, {
      detalle: error instanceof Error ? error.message : String(error),
      ...(codigo ? { codigo } : {}),
    })
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
 * comprobante estable del «no se pudo registrar» (Codex r1 #3) —. Sin ninguno de los dos, 404.
 */
export async function consultarVentaDeLaMaquina(venueId: string, referenceCC: string): Promise<ResultadoDeLaMaquina> {
  const fila = await prisma.cashMachineClose.findUnique({ where: { venueId_referenceCC: { venueId, referenceCC } } })
  if (fila) return { status: 200, body: respuestaDe(fila) }
  const sinRegistro = await sinRegistroDelFolio(venueId, referenceCC)
  const cuerpo = sinRegistro ? respuestaSinRegistro(referenceCC, sinRegistro.payload) : null
  if (cuerpo) return { status: 202, body: cuerpo }
  throw new NotFoundError('Ese folio de la máquina no tiene un cierre registrado.', 'CASH_MACHINE_SALE_NOT_FOUND')
}
