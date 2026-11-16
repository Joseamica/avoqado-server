/**
 * El ingreso o retiro de caja hecho sin internet guarda su hora REAL (encargo 921513, hz:e5ee98bc:D14; founder 16-nov «A»).
 *
 * Antes, un retiro hecho sin red a las 20:03 quedaba a las 20:11:42, la hora en que SUBIÓ (ensayo general, escenario 14b). El POS
 * ahora manda la hora del movimiento y aquí se decide cuánto se le cree. Pieza pura, sin base ni reloj propio: quien llama pasa la
 * llegada.
 *
 * Las ventas y los cobros sin red NO usan esto todavía: su `createdAt` también es la «hora de llegada» de unas 20 reglas de dinero
 * (cortes, turnos, terminales, pago al personal); va aparte, con decisión del founder (docs/audit/2026-11-16-hora-real-sin-red/).
 */

/**
 * La hora de un movimiento del cajón dentro de la vida de SU caja: `[openedAt, closedAt ?? llegada]`. Es la misma regla que ya usa
 * `/cash-drawer/sync` con una caja explícita: la identidad de la caja manda aunque el reloj del aparato vaya mal, y la fecha sólo se
 * acota a esa caja (nunca queda antes de abrirla, detrás de su corte ni en el futuro). Acepta ISO, epoch ms o `Date`. `undefined` si no
 * vino o no se entiende: la base pone la de hoy, como siempre.
 */
export function horaDentroDeLaCaja(
  hora: string | number | Date | null | undefined,
  caja: { openedAt: Date; closedAt: Date | null },
  llegada: Date,
): Date | undefined {
  if (hora === null || hora === undefined || hora === '') return undefined
  if (typeof hora !== 'string' && typeof hora !== 'number' && !(hora instanceof Date)) return undefined
  const t = new Date(hora).getTime()
  if (!Number.isFinite(t)) return undefined
  const desde = new Date(caja.openedAt).getTime()
  const hasta = caja.closedAt ? new Date(caja.closedAt).getTime() : llegada.getTime()
  return new Date(Math.min(Math.max(t, desde), Math.max(hasta, desde)))
}

/** Edad máxima creíble de un movimiento de la cola (como `edadDeLaVentaMs` del cobro): más es un reloj roto. */
const TREINTA_DIAS_MS = 30 * 24 * 60 * 60 * 1000

/**
 * La hora REAL de un ingreso o retiro que sube de la cola, ya dentro de su caja. El aparato manda su hora (`createdAt`) y cuánto
 * esperó en la cola (`edadMs` = su «ahora» − esa hora, medido con SU reloj). Con una edad creíble, la hora es `llegada − edadMs`:
 * un reloj adelantado o atrasado se cancela solo (Codex r2). Sin edad creíble (app que no la manda, o un reloj movido hacia atrás
 * durante la espera, que da edad negativa), la hora que dijo el aparato. Las dos, acotadas a la vida de la caja (`horaDentroDeLaCaja`).
 */
export function horaDelMovimientoDeLaCola(
  aparato: { createdAt?: string | number | Date | null; edadMs?: unknown },
  caja: { openedAt: Date; closedAt: Date | null },
  llegada: Date,
): Date | undefined {
  const e = aparato.edadMs
  const edadCreible = typeof e === 'number' && Number.isFinite(e) && e >= 0 && e <= TREINTA_DIAS_MS
  return horaDentroDeLaCaja(edadCreible ? new Date(llegada.getTime() - (e as number)) : aparato.createdAt, caja, llegada)
}
