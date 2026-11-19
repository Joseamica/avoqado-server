// src/services/dashboard/cashDrawerWho.dashboard.service.ts

/**
 * QUIÉN abrió y quién cerró la caja física de una sucursal en un día, para la B (soporte por WhatsApp, C8). Es la lectura del bloque de
 * la caja de «Turnos de caja» (`cashDrawer.dashboard.service.ts`, `/cash-drawer/sessions`) reducida a lo que la B puede decir: ningún
 * importe, ni el aparato, ni la nota, ni los movimientos (la lista cerrada de campos la fija una prueba). Sólo lee.
 *
 * Un nombre sale sólo donde las dos fuentes coinciden: el guardado en la caja (`openedByName`, `closedByName`, lo que el panel ya le
 * enseña a este lector) y el del directorio de personal de ESA persona, buscado sólo entre quienes tienen fila en esta sucursal o en su
 * organización. Lo guardado lo pudo mandar un POS («Encargada», «fondo 85 mil»), y el directorio solo diría un nombre que el panel no
 * le enseña a este lector por esa caja (Codex r9 y r10; T-B14 y T-B16). Lo guardado no sale de este archivo: la plantilla recibe
 * `CashDrawerRow`, ya comparado.
 *
 * Índices: `CashDrawerSession(venueId, openedAt)` y `(venueId, closedAt)` para las ramas con fecha (C8, Paso 1), y el único parcial de
 * la caja abierta, `CashDrawerSession_venueId_open_key` (`(venueId) WHERE status = 'OPEN'`, migración 20260827151634), para «sigue
 * abierta». El directorio va por la llave de `Staff`, `StaffVenue @@unique([staffId, venueId])`, `StaffOrganization @@index([staffId])`
 * y la llave de `Venue`.
 */

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import type { TimeWindow } from '@/services/support/data/params'
import { strictDbText } from '@/services/support/data/sanitize'

/** Lista cerrada. Ningún importe, ni el aparato, ni la nota. Una prueba la fija. */
export const CASH_DRAWER_SELECT = {
  id: true,
  openedByStaffId: true,
  openedByName: true,
  openedAt: true,
  closedByStaffId: true,
  closedByName: true,
  closedAt: true,
  status: true,
} as const

/** Controles y separadores de renglón cuentan como espacio; los invisibles y los de formato (ancho cero, unión) se quitan. */
const AS_SPACE = /[\p{Cc}\p{Zl}\p{Zp}]/gu
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu
/** NFKC, sin invisibles ni caracteres de formato, todo espacio seguido vuelto uno y sin espacios en las orillas; con sus mayúsculas. */
const limpio = (s: string) =>
  s.normalize('NFKC').replace(AS_SPACE, ' ').replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim().normalize('NFKC')

/**
 * El nombre que la caja puede decir, o null («una persona»). La ÚNICA función que recibe un nombre guardado.
 * (1) Si falta cualquiera de los dos, null. (2) Los dos se normalizan igual (`limpio`, en minúsculas) y (3) si no quedan iguales, null.
 * (4) Si quedan iguales, sale EL GUARDADO, limpio, con sus mayúsculas: es lo que el panel enseña. (5) Última barrera: el filtro estricto
 * de la caja (`strictDbText`); si lo cambia en algo (un importe, 8 dígitos, una liga, más de 40 caracteres), null.
 */
export function nombreDeCajaVisible(guardado: string | null, delDirectorio: string | null): string | null {
  if (guardado === null || delDirectorio === null) return null
  const visible = limpio(guardado)
  if (!visible || visible.toLowerCase() !== limpio(delDirectorio).toLowerCase()) return null
  return strictDbText(visible, '') === visible ? visible : null
}

/** Lo que recibe la plantilla: ya sin openedByName ni closedByName. */
export interface CashDrawerRow {
  abrió: string | null
  openedAt: Date
  cerró: string | null
  closedAt: Date | null
  open: boolean
  /** La cerró el sistema: `CLOSED` sin persona (`closedByStaffId` NULL). No se usa `isAutoClosedSession`, que lee un importe. */
  autoClosed: boolean
}

/** El tope de cajas por respuesta: quien abrió y quien cerró de 5 cajas son, como máximo, los 10 ids de UNA consulta al directorio. */
const MAX_DRAWERS = 5

/**
 * Sólo la sucursal, la ventana del día y el tope: la organización la deriva la consulta del directorio (T-B41b).
 * Dos consultas con tope: (1) las cajas de la sucursal que se abrieron en la ventana, se cerraron en ella o siguen abiertas desde antes
 * de que la ventana termine, de la más vieja a la más nueva, con su conteo; (2) el directorio, UNA consulta por llave para las personas
 * de esas cajas, sólo con fila en esta sucursal (aunque esté inactiva) o en la organización de esta sucursal.
 * Sin el conteo de las abiertas (ronda 1): desde el 27-ago la base deja UNA caja abierta por sucursal (`CashDrawerSession_venueId_open_key`).
 */
export async function readCashDrawers(venueId: string, day: TimeWindow, take: number): Promise<{ total: number; rows: CashDrawerRow[] }> {
  const inDay = { gte: day.from, lte: day.to }
  // «Sigue abierta» sólo si ya estaba abierta en ese día: preguntado «ayer», la caja que se abrió hoy no es de ayer (ronda 1). Para «hoy»,
  // `day.to` es el corte, así que no cambia nada.
  const stillOpen = { status: 'OPEN' as const, openedAt: { lte: day.to } }
  const where = { venueId, OR: [{ openedAt: inDay }, { closedAt: inDay }, stillOpen] }
  const [total, sessions] = await prisma.$transaction([
    prisma.cashDrawerSession.count({ where }),
    prisma.cashDrawerSession.findMany({
      where,
      select: CASH_DRAWER_SELECT,
      orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(Math.trunc(take), 1), MAX_DRAWERS),
    }),
  ])
  const ids = [...new Set(sessions.flatMap(s => [s.openedByStaffId, s.closedByStaffId]))].filter((id): id is string => !!id)
  const staff = ids.length
    ? await prisma.staff.findMany({
        where: {
          id: { in: ids },
          OR: [{ venues: { some: { venueId } } }, { organizations: { some: { organization: { venues: { some: { id: venueId } } } } } }],
        },
        select: { id: true, firstName: true, lastName: true },
        take: 2 * MAX_DRAWERS,
      })
    : []
  // El nombre del directorio: nombre y apellido, sin los vacíos, unidos con un espacio (como lo guarda el servidor, `nombreDelCajero`)
  const directory = new Map(staff.map(s => [s.id, [s.firstName, s.lastName].filter(Boolean).join(' ')]))
  const fromDirectory = (id: string | null) => (id ? (directory.get(id) ?? null) : null)
  return {
    total,
    rows: sessions.map(s => {
      const autoClosed = s.status === 'CLOSED' && s.closedByStaffId === null
      return {
        abrió: nombreDeCajaVisible(s.openedByName, fromDirectory(s.openedByStaffId)),
        openedAt: s.openedAt,
        cerró: autoClosed ? null : nombreDeCajaVisible(s.closedByName, fromDirectory(s.closedByStaffId)),
        closedAt: s.closedAt,
        open: s.status === 'OPEN',
        autoClosed,
      }
    }),
  }
}

/** Un «no» se vuelve a preguntar a los 60 s; un «sí» vale para el proceso (un índice válido no deja de serlo solo). */
const ASK_AGAIN_MS = 60_000
let indexesReady = false
let asked: { at: number; answer: Promise<boolean> } | null = null

/**
 * Pregunta a `pg_index` cuántos de los tres índices que usan las ramas de la lectura existen, son válidos y están listos: los dos de C8 y
 * el único parcial de la caja abierta. Una construcción CONCURRENTLY interrumpida deja uno inválido, que `IF NOT EXISTS` salta al
 * reintentar: por eso, si faltan, lo dice en el log (sólo cuántos están listos, ningún dato; a lo más una vez por minuto y proceso).
 */
async function askIndexes(): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ ready: number }[]>`
    SELECT count(*)::int AS ready FROM pg_index
    WHERE indrelid = to_regclass('"CashDrawerSession"') AND indisvalid AND indisready
      AND indexrelid IN (
        to_regclass('"CashDrawerSession_venueId_openedAt_idx"'),
        to_regclass('"CashDrawerSession_venueId_closedAt_idx"'),
        to_regclass('"CashDrawerSession_venueId_open_key"'))`
  const ready = Array.isArray(rows) ? (rows[0]?.ready ?? 0) : 0
  indexesReady = ready === 3
  if (!indexesReady) logger.warn('Support data: the cash drawer indexes are not ready; the capability stays off', { ready })
  return indexesReady
}

/**
 * Los tres índices de la lectura existen y son válidos (pg_index.indisvalid e indisready). true se recuerda en el proceso; false se vuelve a preguntar
 * a los 60 s. Mientras no, la capacidad de la caja se trata como fuera del catálogo y nunca recorre la tabla. Sin parámetros: es la
 * única función del panel que una capacidad pasa como valor (`available`, T-B42). Si la base falla, rechaza (el orquestador la apaga)
 * y también se vuelve a preguntar a los 60 s.
 */
export async function cashDrawerIndexesReady(): Promise<boolean> {
  if (indexesReady) return true
  if (!asked || Date.now() - asked.at >= ASK_AGAIN_MS) asked = { at: Date.now(), answer: askIndexes() }
  return asked.answer
}
