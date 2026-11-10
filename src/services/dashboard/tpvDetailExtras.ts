/**
 * Aparatos claros, Paso 1 (8-nov-2026): lo que la ficha del aparato del DASHBOARD agrega para decir, arriba, su papel
 * («Emite vales de Panadería» o «Cobra») y su menú. Campos nuevos y opcionales: un dashboard viejo los ignora.
 * Son letreros: si su lectura falla, la ficha se ve como siempre.
 */

import type { TerminalType } from '@prisma/client'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { venueHasFeatureAccess } from '../access/basePlan.service'
import { DEVICE_MENUS_CODE, MAX_MENUS_POR_APARATO, POS_TERMINAL_TYPES } from '../devices/deviceMenus.service'
import { appliesDeviceMenus } from '../devices/deviceMenusAppVersion'

export interface ExtrasDeLaFicha {
  /** Los vales por área están prendidos en el negocio (plan + interruptor): sólo así «Emitir vales» cambia lo que hace la PC. */
  areaTicketsEnabled?: boolean
  /** Sólo en los POS. `menus` vacío = «Todos los menús» (también sin el plan: la PC ignora la elección). */
  deviceMenus?: { menus: Array<{ id: string; name: string }>; needsAppUpdate: boolean }
}

export async function extrasDeLaFicha(
  venueId: string,
  terminal: { id: string; type: TerminalType; version: string | null },
): Promise<ExtrasDeLaFicha> {
  try {
    const esPos = POS_TERMINAL_TYPES.includes(terminal.type)
    const [ajustes, filas] = await Promise.all([
      prisma.venueAreaTicketSettings.findUnique({ where: { venueId }, select: { enabled: true } }),
      esPos
        ? prisma.terminalMenu.findMany({
            where: { terminalId: terminal.id, menu: { venueId, active: true, appliesToDevices: true } },
            select: { menu: { select: { id: true, name: true } } },
            orderBy: [{ menu: { name: 'asc' } }, { menuId: 'asc' }],
            take: MAX_MENUS_POR_APARATO,
          })
        : Promise.resolve(null),
    ])
    const areaTicketsEnabled = Boolean(ajustes?.enabled) && (await venueHasFeatureAccess(venueId, 'AREA_TICKETS'))
    if (!filas) return { areaTicketsEnabled }
    const conPlan = filas.length > 0 && (await venueHasFeatureAccess(venueId, DEVICE_MENUS_CODE))
    const menus = conPlan ? filas.map(f => f.menu) : []
    return {
      areaTicketsEnabled,
      deviceMenus: { menus, needsAppUpdate: menus.length > 0 && !appliesDeviceMenus(terminal.type, terminal.version) },
    }
  } catch (error) {
    logger.warn('[Ficha del aparato] no se pudieron leer papel y menú; se muestra sin ellos', { venueId, terminalId: terminal.id, error })
    return {}
  }
}
