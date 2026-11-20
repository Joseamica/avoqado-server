/**
 * Máquina de efectivo QuickPay Mini · fase 1a (plan `docs/superpowers/plans/2026-11-20-maquina-de-efectivo-fase-1a.md`, R4-1, R4-7,
 * R3#6, R3#9, R5#1, R5#5, R5#7). La PC de WINDOWS sube UNA petición por operación de la máquina (folio = `referenceCC`):
 *
 *  · `PAGADO`: la cuenta nace, se paga y se cierra en UNA transacción (`venderLoQueCobroLaMaquina`); nadie la vio abierta.
 *  · `CANCELADO` / `GUARDADO`: sólo el cierre, sin cuenta ni pago.
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
import { withDeadlockRetry } from '../../utils/serializableRetry'
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
type QuienResolvio = 'MAQUINA' | 'GERENTE'
type TipoDeIncidencia = 'CONFLICTO' | 'IMPOSIBLE' | 'NO_SE_PUDO_REGISTRAR'

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

export type ResultadoDeLaMaquina =
  | { status: 200; body: RespuestaDeLaMaquina }
  | { status: 202; body: { referenceCC: string; incident: 'NO_SE_PUDO_REGISTRAR' } }

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

/**
 * R3#9, R5#5, R4-7 #6: ¿esta combinación de importes puede salir de la máquina? Cualquier otra cosa es 422 con incidencia.
 *  · todos enteros ≥ 0 y `due = sale + tip`;
 *  · `PAGADO`: `credit ≥ due` y `0 ≤ change ≤ credit − due`;
 *  · `CANCELADO` y `GUARDADO`: `credit < due` (con el adeudo cubierto no hay cancelación posible); `GUARDADO` no devuelve nada y
 *    `CANCELADO` no devuelve más de lo que entró.
 */
export function validarCierre(c: CierreDeLaMaquina): 'OK' | 'IMPOSIBLE' {
  if (!DESENLACES_DE_LA_MAQUINA.includes(c.outcome)) return 'IMPOSIBLE'
  const importes = [c.dueCents, c.saleCents, c.tipCents, c.creditCents, c.changeDispensedCents]
  if (!importes.every(n => Number.isInteger(n) && n >= 0)) return 'IMPOSIBLE'
  if (c.dueCents !== c.saleCents + c.tipCents) return 'IMPOSIBLE'
  if (c.outcome === 'PAGADO') {
    return c.creditCents >= c.dueCents && c.changeDispensedCents <= c.creditCents - c.dueCents ? 'OK' : 'IMPOSIBLE'
  }
  if (c.creditCents >= c.dueCents) return 'IMPOSIBLE'
  if (c.outcome === 'GUARDADO') return c.changeDispensedCents === 0 ? 'OK' : 'IMPOSIBLE'
  return c.changeDispensedCents <= c.creditCents ? 'OK' : 'IMPOSIBLE'
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
 * turno (`SALE_SHIFT_CLOSED`, como la cola); el dinero entró después de que A terminó, sin hora, sin turno o con un turno que no es
 * del negocio → por conciliar. Nunca el turno vivo.
 */
export function turnoDeLaMaquina(
  c: CierreDeLaMaquina,
  turnoA: { id: string; status: string; endTime: Date | null } | null,
): { expectedShiftId: string | null; porConciliar: boolean; shiftStatus: EstadoDelTurnoDeLaMaquina } {
  const hora = horaDelCierre(c)
  if (!c.saleShiftId || !hora || !turnoA || (turnoA.endTime && hora > turnoA.endTime)) {
    return { expectedShiftId: null, porConciliar: true, shiftStatus: 'POR_CONCILIAR' }
  }
  return {
    expectedShiftId: turnoA.id,
    porConciliar: false,
    shiftStatus: turnoA.status === 'OPEN' && !turnoA.endTime ? 'EN_TURNO' : 'TURNO_CERRADO',
  }
}

function respuestaDe(fila: CashMachineClose): RespuestaDeLaMaquina {
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

/**
 * La venta ya no se puede armar (400/403/404/422: un producto o un extra borrado, el personal, una cortesía sin permiso). Un 409 NO lo
 * es: es concurrencia (`withDeadlockRetry` agotado, otro cobro a la vez) y la PC reintenta el mismo folio.
 */
const esRechazoDeLaVenta = (error: unknown): boolean =>
  error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 409

const esChoqueDeUnico = (error: unknown): boolean => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

/**
 * La incidencia DURABLE: una fila por folio y tipo, en UNA sentencia aparte (nunca dentro de la transacción que se revierte). Si
 * falla, el error sube: la PC no recibe un 409/422/202 «final» sin la evidencia guardada y reintenta.
 * ponytail: guarda los primeros 50 eventos y cuenta todos (`veces`); una PC que reintenta para siempre no infla la fila.
 */
async function guardarIncidencia(
  venueId: string,
  referenceCC: string,
  kind: TipoDeIncidencia,
  deviceId: string | null,
  evento: Record<string, unknown>,
): Promise<string | null> {
  const ahora = new Date()
  const payload = JSON.stringify({ eventos: [evento], veces: 1 })
  const filas = await prisma.$queryRaw<Array<{ id: string }>>`
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
}

/** La incidencia (la evidencia) y, además, su renglón en la bitácora del dueño. */
async function anotarIncidencia(
  venueId: string,
  referenceCC: string,
  kind: TipoDeIncidencia,
  autor: { userId: string; deviceId: string | null },
  evento: Record<string, unknown>,
): Promise<void> {
  const incidenciaId = await guardarIncidencia(venueId, referenceCC, kind, autor.deviceId, evento)
  await logAction({
    action: ACCION_DE_LA_INCIDENCIA[kind],
    entity: 'CashMachineIncident',
    entityId: incidenciaId ?? undefined,
    venueId,
    staffId: autor.userId,
    data: { referenceCC, kind, ...evento } as Prisma.InputJsonValue,
  })
}

/** `POST /mobile/venues/:venueId/cash-machine/sales`. */
export async function registrarVentaDeLaMaquina(
  venueId: string,
  autor: AutorDeLaMaquina,
  entrada: EntradaDeLaMaquina,
): Promise<ResultadoDeLaMaquina> {
  const { referenceCC, cierre } = entrada
  if (!CASH_MACHINE_REF.test(referenceCC)) {
    throw new BadRequestError('El folio de la máquina debe ser AQ seguido de 12 letras mayúsculas o números.')
  }
  if ((cierre.outcome === 'PAGADO') !== Boolean(entrada.pedido)) {
    throw new BadRequestError('El pedido va sólo con un cierre PAGADO.')
  }
  const deviceId = await aparatoDe(venueId, autor.deviceUid)
  // R4-3: antes de escribir nada (tampoco una incidencia): sólo la PC emparejada, o la revocada repitiendo SU folio (R5#2).
  await exigirAparatoEmparejado(venueId, referenceCC, deviceId, autor.credencial)
  const quien = { userId: autor.userId, deviceId }
  const evidencia = { cierre, deviceId, recibidoEn: new Date().toISOString() }

  if (validarCierre(cierre) === 'IMPOSIBLE') {
    await anotarIncidencia(venueId, referenceCC, 'IMPOSIBLE', quien, evidencia)
    throw new AppError(
      'Los importes de este cierre de la máquina no son posibles. Quedó registrado para que el gerente lo revise.',
      422,
      true,
      'CASH_MACHINE_CLOSE_IMPOSSIBLE',
    )
  }

  const huella = huellaDelCierre(venueId, referenceCC, cierre, 'MAQUINA')
  /** El folio ya tiene su cierre: la misma operación responde lo mismo; otra, 409 con incidencia. */
  const yaRegistrado = async (fila: CashMachineClose): Promise<ResultadoDeLaMaquina> => {
    if (huellaDelCierre(venueId, referenceCC, fila as unknown as CierreDeLaMaquina, fila.resolvedBy) === huella) {
      return { status: 200, body: respuestaDe(fila) }
    }
    await anotarIncidencia(venueId, referenceCC, 'CONFLICTO', quien, { ...evidencia, registrado: respuestaDe(fila) })
    throw new ConflictError(
      'Este folio de la máquina ya se registró con otros importes. Quedó registrado para que el gerente lo revise.',
      'CASH_MACHINE_CLOSE_CONFLICT',
      { registrado: respuestaDe(fila) },
    )
  }
  const cierreDelFolio = () => prisma.cashMachineClose.findUnique({ where: { venueId_referenceCC: { venueId, referenceCC } } })

  const previo = await cierreDelFolio()
  if (previo) return yaRegistrado(previo)

  const turnoA = cierre.saleShiftId
    ? await prisma.shift.findFirst({ where: { id: cierre.saleShiftId, venueId }, select: { id: true, status: true, endTime: true } })
    : null
  const turno = turnoDeLaMaquina(cierre, turnoA)
  const hora = horaDelCierre(cierre)
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
      resolvedBy: 'MAQUINA' satisfies QuienResolvio,
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
        procesadoPor: autor.userId,
        horaDelCierre: hora,
        turno: { shiftIdDeLaVenta: turno.expectedShiftId, porConciliar: turno.porConciliar },
        cerrarEnTx: (tx, cobro) =>
          tx.cashMachineClose.create({
            data: filaDelCierre({
              ...cobro,
              shiftStatus: cobro.shiftId ? 'EN_TURNO' : turno.porConciliar ? 'POR_CONCILIAR' : 'TURNO_CERRADO',
            }),
          }),
      })
    } else {
      fila = await withDeadlockRetry(
        async tx => {
          // El MISMO candado que la cuenta de un `PAGADO` de este folio: los dos desenlaces se forman uno detrás del otro.
          await tx.$queryRaw(candadoDeLaLlave(venueId, `maquina-${referenceCC}`))
          if (await tx.cashMachineClose.findUnique({ where: { venueId_referenceCC: { venueId, referenceCC } }, select: { id: true } })) {
            throw new CierreYaRegistrado()
          }
          return tx.cashMachineClose.create({
            data: filaDelCierre({ orderId: null, paymentId: null, appliedCents: 0, shiftStatus: turno.shiftStatus }),
          })
        },
        { etiqueta: 'registrarVentaDeLaMaquina' },
      )
    }
  } catch (error) {
    if (error instanceof CierreYaRegistrado || error instanceof CuentaDeLaMaquinaYaExiste || esChoqueDeUnico(error)) {
      const ganadora = await cierreDelFolio()
      if (ganadora) return yaRegistrado(ganadora)
      // Un choque sin cierre no es de este folio: sube tal cual (la PC reintenta). La cuenta con la llave del folio sin su cierre sí:
      // la tomó otro escritor y esta venta ya no se puede armar.
      if (!(error instanceof CuentaDeLaMaquinaYaExiste)) throw error
    } else if (!(cierre.outcome === 'PAGADO' && esRechazoDeLaVenta(error))) {
      throw error
    }
    // R5#1: la cuenta ya no se puede armar (un producto o un extra que se borró, el personal, la llave). El dinero real queda visible.
    await anotarIncidencia(venueId, referenceCC, 'NO_SE_PUDO_REGISTRAR', quien, {
      ...evidencia,
      pedido: entrada.pedido as unknown as Record<string, unknown>,
      motivo: error instanceof Error ? error.message : String(error),
      ...(error instanceof AppError && error.code ? { codigo: error.code } : {}),
    })
    return { status: 202, body: { referenceCC, incident: 'NO_SE_PUDO_REGISTRAR' } }
  }

  // La máquina le debe dinero al cliente: renglón para el dueño (las deudas se adjudican en la 1c).
  if (fila.owedCents > 0) {
    await logAction({
      action: 'CASH_MACHINE_OWES_CUSTOMER',
      entity: 'CashMachineClose',
      entityId: fila.id,
      venueId,
      staffId: autor.userId,
      data: { referenceCC, outcome: fila.outcome, owedKind: fila.owedKind, owedPesos: fila.owedCents / 100, orderId: fila.orderId },
    })
  }
  return { status: 200, body: respuestaDe(fila) }
}

/** `GET /mobile/venues/:venueId/cash-machine/sales/:referenceCC`: la MISMA respuesta que el POST. */
export async function consultarVentaDeLaMaquina(venueId: string, referenceCC: string): Promise<RespuestaDeLaMaquina> {
  const fila = await prisma.cashMachineClose.findUnique({ where: { venueId_referenceCC: { venueId, referenceCC } } })
  if (!fila) throw new NotFoundError('Ese folio de la máquina no tiene un cierre registrado.', 'CASH_MACHINE_SALE_NOT_FOUND')
  return respuestaDe(fila)
}
