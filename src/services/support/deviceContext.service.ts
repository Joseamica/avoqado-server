// Versión de la app y equipo (PAX/Nexgo) de quien escribe, para escoger las páginas del modo híbrido (R1-06). Lo que dijo en
// la plática gana; lo que falta sólo se deduce de los aparatos vivos de UNA sucursal, y sólo si todos dicen lo mismo.
import type { Prisma, SupportConversation, TerminalType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ForbiddenError } from '@/errors/AppError'
import { listSupportVenues } from './access.service'
import { resolveRegisteredSupportPhone } from './registeredPhone.service'
import type { HelpApp } from './knowledge.service'

export interface SupportDeviceContext {
  version?: string
  family?: 'PAX' | 'NEXGO'
}
type Family = NonNullable<SupportDeviceContext['family']>
export type DeviceGroup = { type: TerminalType | string; brand: string | null; version: string | null }

const VERSION = /(?<![\d.])(\d{1,3}\.\d{1,3}(?:\.\d{1,4})?)(?!\d|\.\d)/
/**
 * La versión N.N(.N) suelta de un texto de hasta 40 caracteres: «2.25.42-escritorio» → «2.25.42», «2.19.0 (130)» → «2.19.0».
 * El punto final de una frase no cuenta («la 2.19.» → «2.19»); un punto seguido de un dígito sí la invalida («1.2.3.4»).
 */
export function normalizeAppVersion(raw: string | null): string | null {
  return raw && raw.length <= 40 ? (raw.match(VERSION)?.[1] ?? null) : null
}
export function deviceFamilyOf(brand: string | null): Family | null {
  return /^pax/i.test(brand ?? '') ? 'PAX' : /^nexgo/i.test(brand ?? '') ? 'NEXGO' : null
}

/** App de cada aparato, como scripts/versiones-vivas.py: la terminal de cobro, el POS de Windows («-escritorio») o el de Android. */
const appOf = (g: DeviceGroup): HelpApp | null =>
  g.type === 'TPV_ANDROID' ? 'tpv' : g.version?.includes('escritorio') ? 'windows' : g.type === 'POS_ANDROID' ? 'android' : null
const TYPES: Partial<Record<HelpApp, TerminalType[]>> = {
  tpv: ['TPV_ANDROID'],
  android: ['POS_ANDROID', 'POS_DESKTOP'],
  windows: ['POS_ANDROID', 'POS_DESKTOP'],
}
/** El único valor de la lista; uno desconocido (null) o dos distintos → nada. */
const only = <T>(values: (T | null)[]): T | undefined =>
  values.length && values.every(v => v !== null && v === values[0]) ? values[0]! : undefined

/** Lo que dijo la plática gana; cada dato que falta sale de los grupos tipo·marca·versión de los aparatos de esa app. */
export function mergeDeviceContext(
  app: HelpApp,
  said: { appVersion: string | null; deviceFamily: string | null },
  groups: DeviceGroup[],
): SupportDeviceContext {
  const mine = groups.filter(g => appOf(g) === app)
  const version = normalizeAppVersion(said.appVersion) ?? only(mine.map(g => normalizeAppVersion(g.version)))
  const family = deviceFamilyOf(said.deviceFamily) ?? only(mine.map(g => deviceFamilyOf(g.brand)))
  return { ...(version ? { version } : {}), ...(family ? { family } : {}) }
}

/** La sucursal de la que se puede deducir: la elegida, o la única del número registrado. Varias o ninguna → null. */
async function soleVenue(conversation: SupportConversation, db: Prisma.TransactionClient): Promise<string | null> {
  if (conversation.mode === 'PERSONAL') return conversation.venueId
  if (conversation.mode !== 'PUBLIC') return null
  const { soleStaffId } = await resolveRegisteredSupportPhone(conversation.phone, db)
  if (!soleStaffId) return null
  try {
    const page = await listSupportVenues(soleStaffId, { limit: 2 }, db)
    return page.total === 1 ? page.items[0].id : null
  } catch (err) {
    if (err instanceof ForbiddenError) return null
    throw err
  }
}

const GROUPS = 20
export async function resolveSupportDeviceContext(
  conversation: SupportConversation,
  now: Date,
  db: Prisma.TransactionClient = prisma,
): Promise<SupportDeviceContext> {
  const app = conversation.app as HelpApp,
    types = TYPES[app]
  const known = normalizeAppVersion(conversation.appVersion) && deviceFamilyOf(conversation.deviceFamily)
  const venueId = types && !known ? await soleVenue(conversation, db) : null
  if (!types || !venueId) return mergeDeviceContext(app, conversation, [])
  // Una consulta acotada: los grupos tipo·marca·versión de los aparatos vistos en 30 días. Más de 20 = recortado → nada.
  const groups = await db.terminal.groupBy({
    by: ['type', 'brand', 'version'],
    where: { venueId, type: { in: types }, lastHeartbeat: { gt: new Date(now.getTime() - 30 * 86400_000) } },
    orderBy: [{ type: 'asc' }, { brand: 'asc' }, { version: 'asc' }],
    take: GROUPS + 1,
  })
  return mergeDeviceContext(app, conversation, groups.length > GROUPS ? [] : groups)
}
