// src/services/dashboard/cashDrawer.dashboard.service.ts

/**
 * LECTURA del cajón físico para el dashboard y el MCP — fase 1 de la unificación de caja.
 *
 * El cajón (`CashDrawerSession` + `CashDrawerEvent`) lo escriben Android y, desde el 16-ago,
 * la TPV al cobrar en efectivo (`cashDrawerPosting.ts`). Calcula el esperado y el
 * sobrante/faltante en cada cierre, y hasta hoy sólo tenía rutas /mobile: el dueño no podía
 * verlo desde ningún lado. Veía "Turnos" (`Shift`, la PAX) y creía que eso era la caja.
 *
 * Esta capa NO escribe nada, NO toca el modelo ni el servicio mobile (sólo reusa su fórmula
 * de esperado, para que el dueño vea el MISMO número que vio el cajero), y se apaga quitando
 * la ruta. Tres decisiones que vienen de la auditoría de Codex (27-ago, §7 fase 1):
 *
 *   · `counted` es explícito. Una sesión cerrada sin conteo trae `actualAmount = null` y
 *     `overShort = null`; el dashboard debe decir "sin conteo", nunca "cuadró".
 *   · Dos sesiones OPEN en el mismo venue (carrera al abrir, sin índice único) NO se
 *     esconden: `anomalies` lo reporta en vez de elegir una al azar como hace `findFirst`.
 *   · El historial trae TODAS las sesiones, no sólo las cerradas: una caja abierta y
 *     olvidada hace semanas tiene que aparecer.
 */

import prisma from '@/utils/prismaClient'
import { calculateExpectedAmount } from '@/services/mobile/cash-drawer.mobile.service'

const money = (v: unknown): number => Number(Number(v).toFixed(2))

export interface DrawerSessionView {
  id: string
  status: string
  deviceName: string | null
  openedByStaffId: string
  openedByName: string
  openedAt: string
  closedByStaffId: string | null
  closedByName: string | null
  closedAt: string | null
  /**
   * El turno de caja al que pertenece esta gaveta (Fase 2, 3-sep-2026). Desde que abrir es UN solo
   * gesto (`abrirTurnoDeCaja`), las dos verdades del mismo dinero quedan atadas y el dueño —o el
   * MCP— puede ir de una a la otra sin adivinar por ventana de tiempo.
   *
   * `null` en las sesiones anteriores a la unificación y en cualquiera que se haya abierto sin
   * turno: no se adivina la liga hacia atrás. NO es dinero, así que no lo esconde el conteo ciego.
   */
  shiftId: string | null
  // 🔴 OPCIONALES por el conteo ciego: a quien no tiene `cash-drawer:view-expected` no se
  // le sirven mientras la caja está ABIERTA. No basta con ocultar `expectedAmount`, porque
  // `startingAmount + cashSales + payIns − payOuts` ES el esperado.
  startingAmount?: number
  cashSales?: number
  payIns?: number
  payOuts?: number
  expectedAmount?: number
  /** true sólo si el cajero CONTÓ al cerrar; con false, `actualAmount` y `overShort` son null */
  counted: boolean
  actualAmount: number | null
  overShort: number | null
  closingNote: string | null
  eventCount: number
}

export interface DrawerAnomaly {
  code: 'MULTIPLE_OPEN_SESSIONS'
  sessionIds: string[]
  message: string
}

export interface DrawerStatus {
  open: DrawerSessionView | null
  anomalies: DrawerAnomaly[]
}

function sumByType(events: Array<{ type: string; amount: unknown }>, type: string): number {
  return money(events.filter(e => e.type === type).reduce((acc, e) => acc + Number(e.amount), 0))
}

/**
 * @param incluirEsperado ¿el llamante tiene `cash-drawer:view-expected`? Con `false` —el
 * default, para que un llamador nuevo que lo olvide oculte en vez de filtrar— se omiten el
 * esperado y sus sumandos MIENTRAS la caja está abierta. Una vez cerrada el resultado ya
 * está firmado y se revela: eso es justamente el diseño del conteo ciego.
 */
function toView(session: any, incluirEsperado = false): DrawerSessionView {
  const events: Array<{ type: string; amount: unknown }> = session.events ?? []
  const counted = session.actualAmount !== null && session.actualAmount !== undefined
  const revelar = incluirEsperado || session.status !== 'OPEN'
  return {
    id: session.id,
    status: session.status,
    deviceName: session.deviceName ?? null,
    openedByStaffId: session.openedByStaffId,
    openedByName: session.openedByName,
    openedAt: session.openedAt.toISOString(),
    closedByStaffId: session.closedByStaffId ?? null,
    closedByName: session.closedByName ?? null,
    closedAt: session.closedAt ? session.closedAt.toISOString() : null,
    shiftId: session.shiftId ?? null,
    ...(revelar
      ? {
          startingAmount: money(session.startingAmount),
          cashSales: sumByType(events, 'CASH_SALE'),
          payIns: sumByType(events, 'PAY_IN'),
          payOuts: sumByType(events, 'PAY_OUT'),
          expectedAmount: calculateExpectedAmount({ ...session, events }),
        }
      : {}),
    counted,
    actualAmount: counted ? money(session.actualAmount) : null,
    overShort: counted && session.overShort !== null && session.overShort !== undefined ? money(session.overShort) : null,
    closingNote: session.closingNote ?? null,
    eventCount: events.length,
  }
}

const EVENTS_INCLUDE = { events: { orderBy: { createdAt: 'asc' as const } } }

/** La caja de AHORA: la sesión abierta (si hay) y las anomalías que el dueño debe saber. */
export async function getDrawerStatus(venueId: string, incluirEsperado = false): Promise<DrawerStatus> {
  const open = await prisma.cashDrawerSession.findMany({
    where: { venueId, status: 'OPEN' },
    include: EVENTS_INCLUDE,
    orderBy: { openedAt: 'desc' },
  })

  const anomalies: DrawerAnomaly[] = []
  if (open.length > 1) {
    anomalies.push({
      code: 'MULTIPLE_OPEN_SESSIONS',
      sessionIds: open.map(s => s.id),
      message: `Hay ${open.length} cajas abiertas al mismo tiempo; el sistema espera una sola por sucursal.`,
    })
  }

  return { open: open.length ? toView(open[0], incluirEsperado) : null, anomalies }
}

export interface DrawerSessionsQuery {
  page: number
  pageSize: number
}

/** Historial completo (abiertas y cerradas), la más reciente primero. */
export async function getDrawerSessions(venueId: string, { page, pageSize }: DrawerSessionsQuery, incluirEsperado = false) {
  const skip = (page - 1) * pageSize
  const where = { venueId }

  const [rows, total] = await Promise.all([
    prisma.cashDrawerSession.findMany({ where, include: EVENTS_INCLUDE, orderBy: { openedAt: 'desc' }, skip, take: pageSize }),
    prisma.cashDrawerSession.count({ where }),
  ])

  return {
    sessions: rows.map(r => toView(r, incluirEsperado)),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  }
}
