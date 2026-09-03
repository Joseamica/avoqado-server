import { Prisma, ShiftStatus } from '@prisma/client'

import prisma from '../../utils/prismaClient'
import { isAutoClosedSession } from './cashDrawerAutoClose'

/**
 * LA PAREJA DEL CIERRE — cómo se repara un «gesto único» que murió a media operación.
 *
 * El cierre unificado (`shared/turnoDeCaja.ts`, Task 5) son DOS commits: quien recibe el gesto
 * cierra su registro y sólo después cierra el otro. Si el proceso muere en medio —o la segunda
 * mitad falla— queda una PAREJA A MEDIAS, y con la apertura ya unificada (Task 4) eso NO «degrada
 * a lo de hoy». Degrada a dos daños concretos, los dos verificados contra el código:
 *
 *   · **MEZCLAR JORNADAS.** La tablet cierra y cuenta la gaveta a las 15:00; el turno se queda
 *     OPEN. A las 15:05 la cajera de la tarde abre: `abrirTurnoDeCaja` ve el turno con
 *     `startTime >= corteDelDiaDeNegocio` y lo REUSA — crea una gaveta nueva y la deja sin ligar,
 *     porque `CashDrawerSession.shiftId` es `@unique` y la de la mañana ya reclamó el turno.
 *     Cuando la tarde cierre, su conteo cerrará un turno cuyos totales cubren TODO el día,
 *     incluida la mañana que ya se contó aparte. Un solo turno firmando dos arqueos.
 *   · **ACEPTAR DINERO SOBRE UNA GAVETA CUYO TURNO YA CERRÓ.** La PAX cierra el turno a las 20:05
 *     y la mitad de la gaveta falla. `turnoAbiertoDelNegocio` ya devuelve `null`, así que cada
 *     cobro nuevo nace sin turno — pero `cashDrawerPosting` sigue posteando su `CASH_SALE` a la
 *     gaveta, que sigue OPEN. El efectivo se acumula en una caja que ya nadie va a cuadrar.
 *
 * 🔴 **Por qué NO hace falta una tabla de outbox: la mitad que SÍ commiteó es el registro durable.**
 * Un outbox existe para recordar una intención que no deja rastro. Aquí la intención deja rastro
 * por construcción — una gaveta CERRADA junto a su turno ABIERTO no es un estado legítimo — y
 * además los cuatro datos que haría falta recordar YA están persistidos en la fila que ganó:
 *
 *   | qué             | de la gaveta                    | del turno                          |
 *   |-----------------|---------------------------------|------------------------------------|
 *   | conteo          | `actualAmount`                  | `cashDeclared`                     |
 *   | esperado        | `actualAmount − overShort`      | `cashDeclared − cashDifference`    |
 *   | actor           | `closedByStaffId`               | `closedById`                       |
 *   | instante        | `closedAt`                      | `endTime`                          |
 *
 * Lo único que NO se deriva es **de qué turno era la gaveta**, y para eso no hace falta inventar
 * nada: `CashDrawerSession.shiftId` existe desde la Task 4 y significa exactamente eso. Lo que sí
 * hace falta es garantizar que esté puesto ANTES del primer commit — eso lo hace `asegurarLaLiga`.
 *
 * 🔴 Y por qué NO es «una sola transacción», que sería más pequeña todavía: el cierre del turno
 * (`closeShiftUsingRequest`) es él mismo multi-commit —reclama `OPEN → CLOSING` en un commit
 * aparte para que otros lo VEAN, agrega pagos/órdenes/inventario durante segundos, y publica al
 * POS por RabbitMQ y al socket— y nada de eso puede vivir dentro de la transacción que cierra la
 * gaveta: sostendría el candado de la fila del cajón —el mismo que serializa cada venta en
 * efectivo (`createEventUnderSessionLock`)— durante toda esa agregación, y metería una llamada de
 * red en una transacción, que este repo prohíbe con razón. Al revés tampoco: meter el cierre de la
 * gaveta dentro de la transacción del turno haría que un fallo del cajón REVIERTA un cierre de
 * turno ya calculado, convirtiendo un cierre bueno en un error en el mostrador (y dejando el turno
 * atorado en `CLOSING` hasta el vigilante). Es justo lo que la regla 3 del cierre unificado
 * prohíbe. La reparación durable es lo que queda, y aquí sale sin tabla nueva ni migración.
 */

/** Lo mínimo de la gaveta para decidir. Es un subconjunto de `CashDrawerSession`, no una copia. */
export interface GavetaDeLaPareja {
  id: string
  venueId: string
  shiftId: string | null
  status: string
  openedAt: Date
  closedAt: Date | null
  actualAmount: Prisma.Decimal | null
  overShort: Prisma.Decimal | null
  closedByStaffId: string | null
}

/** Lo mínimo del turno para decidir. Subconjunto de `Shift`. */
export interface TurnoDeLaPareja {
  id: string
  venueId: string
  status: string
  startTime: Date
  endTime: Date | null
  cashDeclared: Prisma.Decimal | null
  cashDifference: Prisma.Decimal | null
  closedById: string | null
}

export type MotivoNoReparable =
  /** Los dos abiertos o los dos cerrados: no hay gesto a medias. */
  | 'PAREJA_COMPLETA'
  /** Hay un cierre de turno en vuelo (`CLOSING`). Se espera: puede terminar o revertirse solo. */
  | 'CIERRE_EN_VUELO'
  /** La gaveta la cerró el barrido de las 04:00 o el relevo. Nadie contó y no es este gesto. */
  | 'CIERRE_AUTOMATICO'
  /** El negocio ya siguió: hay un turno abierto usando esa gaveta. Se reporta, no se toca. */
  | 'EL_NEGOCIO_SIGUIO'
  /** Falta el instante, o hay conteo sin diferencia firmada. No se firma lo que no se puede derivar. */
  | 'SIN_NUMEROS_PAREJOS'
  /** La liga apunta a otro negocio. Imposible por FK, pero no se adivina. */
  | 'NEGOCIOS_DISTINTOS'

export interface ReparacionDelCierre {
  reparable: true
  venueId: string
  shiftId: string
  cashDrawerSessionId: string
  /** Qué mitad quedó sin cerrar. */
  falta: 'TURNO' | 'GAVETA'
  /** 🔴 `null` = nadie contó, y entonces NADA se inventa (regla 1 del cierre unificado). */
  conteo: Prisma.Decimal | null
  /** El esperado que la mitad ganadora ya firmó. Nunca se recalcula: una foto, dos firmas. */
  esperado: Prisma.Decimal | null
  actorStaffId: string | null
  /** El instante que firmó la primera mitad. El cierre que falta se firma con ÉL, no con el del barrido. */
  momento: Date
}

export interface NoReparable {
  reparable: false
  motivo: MotivoNoReparable
}

/**
 * ¿Esta pareja quedó a medias, y con qué números se cierra la mitad que falta? PURA: sin base y sin
 * reloj — el instante sale de lo que la primera mitad firmó.
 *
 * `hayTurnoAbierto` es el único dato que no vive en las dos filas, y es el que impide el daño peor:
 * cerrarle la gaveta a un mostrador que está vendiendo.
 */
export function decidirReparacionDelCierre(
  gaveta: GavetaDeLaPareja,
  turno: TurnoDeLaPareja,
  contexto: { hayTurnoAbierto: boolean },
): ReparacionDelCierre | NoReparable {
  if (gaveta.venueId !== turno.venueId) return { reparable: false, motivo: 'NEGOCIOS_DISTINTOS' }

  // 🔴 `CLOSING` no es «cerrado»: es un cierre reclamado que puede terminar bien o que el vigilante
  // (`shift-close-watchdog`) devolverá a `OPEN`. Tocarlo aquí sería pelearse con él.
  if (turno.status === ShiftStatus.CLOSING) return { reparable: false, motivo: 'CIERRE_EN_VUELO' }

  const gavetaCerrada = gaveta.status === 'CLOSED'
  const turnoCerrado = turno.status === ShiftStatus.CLOSED
  if (gavetaCerrada === turnoCerrado) return { reparable: false, motivo: 'PAREJA_COMPLETA' }

  if (gavetaCerrada) {
    // ── Falta el TURNO: la gaveta ya firmó ────────────────────────────────────────────────
    //
    // 🔴 Una gaveta que cerró SOLA queda fuera, y la exclusión hace dos trabajos a la vez: (1) el
    // barrido de las 04:00 y el relevo cierran cajas sin conteo y sin actor, y su contraparte es el
    // relevo del turno, no esto; (2) esa misma firma es la que `isAutoClosedSession` ya reconoce en
    // todo el repo, así que no se estrena una segunda definición de «nadie contó».
    if (isAutoClosedSession(gaveta)) return { reparable: false, motivo: 'CIERRE_AUTOMATICO' }
    if (!gaveta.closedAt) return { reparable: false, motivo: 'SIN_NUMEROS_PAREJOS' }

    const numeros = numerosParejos(gaveta.actualAmount, gaveta.overShort)
    if (!numeros) return { reparable: false, motivo: 'SIN_NUMEROS_PAREJOS' }

    return {
      reparable: true,
      venueId: gaveta.venueId,
      shiftId: turno.id,
      cashDrawerSessionId: gaveta.id,
      falta: 'TURNO',
      conteo: numeros.conteo,
      esperado: numeros.esperado,
      actorStaffId: gaveta.closedByStaffId,
      momento: gaveta.closedAt,
    }
  }

  // ── Falta la GAVETA: el turno ya firmó ──────────────────────────────────────────────────
  //
  // 🔴 Si el negocio tiene un turno abierto, esa gaveta ya no es una huérfana: es la caja con la
  // que están cobrando ahora mismo (`abrirTurnoDeCaja` reusa la gaveta abierta del día). Cerrarla
  // le dejaría el mostrador sin caja a media venta. Es también lo que hace inofensivo el relevo,
  // que cierra el turno de ayer y crea el de hoy en la MISMA transacción: nunca hay un instante
  // con el turno viejo cerrado y ningún turno abierto.
  if (contexto.hayTurnoAbierto) return { reparable: false, motivo: 'EL_NEGOCIO_SIGUIO' }
  if (!turno.endTime) return { reparable: false, motivo: 'SIN_NUMEROS_PAREJOS' }

  const numeros = numerosParejos(turno.cashDeclared, turno.cashDifference)
  if (!numeros) return { reparable: false, motivo: 'SIN_NUMEROS_PAREJOS' }

  return {
    reparable: true,
    venueId: turno.venueId,
    shiftId: turno.id,
    cashDrawerSessionId: gaveta.id,
    falta: 'GAVETA',
    conteo: numeros.conteo,
    esperado: numeros.esperado,
    actorStaffId: turno.closedById,
    momento: turno.endTime,
  }
}

/**
 * Conteo y esperado, o nada. `esperado = conteo − diferencia`, la identidad que las dos mitades ya
 * usan al firmar (`overShort = conteo − esperado`).
 *
 * 🔴 Las DOS combinaciones legítimas son «ambos ausentes» (nadie contó) y «ambos presentes». Un
 * conteo con la diferencia en `NULL` es el turno que se NEGÓ a firmarla —`IGNORED_OVERFLOW`, cuando
 * no cabe en `Decimal(10,2)`—, y ahí no se repara: recalcular el esperado desde los eventos le daría
 * a la otra mitad un número que la primera acaba de rechazar. Reportar es la única salida honesta.
 * ⚠️ `!= null` y nunca truthiness: `Decimal(0)` es un objeto, y contar cero es un conteo REAL.
 */
function numerosParejos(
  conteo: Prisma.Decimal | null,
  diferencia: Prisma.Decimal | null,
): { conteo: Prisma.Decimal | null; esperado: Prisma.Decimal | null } | null {
  if (conteo == null && diferencia == null) return { conteo: null, esperado: null }
  if (conteo == null || diferencia == null) return null
  return { conteo, esperado: new Prisma.Decimal(conteo).sub(diferencia) }
}
