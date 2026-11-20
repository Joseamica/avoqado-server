import crypto from 'crypto'
import type { SupportConversation, SupportDataResult } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { getSupportDataConfig } from '@/config/supportWhatsapp'
import { isActiveSuperAdmin } from '@/mcp/scope'
import { isSupportAccessLost, readSupportContext, type SupportContext } from '../context.service'
import { supportCipher } from '../link.service'
import { within } from '../notices.service'
import {
  DATA_CAPABILITIES,
  DataReadRefusal,
  capabilityGates,
  checkCapabilityAccess,
  type AnyDataCapability,
  type DataCatalog,
  type DataRequest,
  type DataScope,
} from './catalog'
import { checkRendered, type Rendered } from './check'
import { readDataValidity } from './consent.service'
import { countDataReadsToday, paramsHmac } from './log'
import {
  SUPPORT_DATA_CHECK_FAILED,
  SUPPORT_DATA_DAILY_CAP,
  SUPPORT_DATA_LINK_FIRST,
  SUPPORT_DATA_NEEDS_UNLOCK,
  SUPPORT_DATA_OFF,
  SUPPORT_DATA_OTHER_VENUE,
  SUPPORT_DATA_QUERY_FAILED,
  SUPPORT_DATA_SUPERADMIN,
  supportDataOutOfCatalog,
  supportDataRefusal,
} from './texts'

/**
 * El orquestador de la B: de una pregunta ya clasificada a UNA salida, una respuesta sellada o un texto fijo. No escribe nada:
 * el renglón del registro (`log`) lo guarda el worker en la transacción que guarda la respuesta (recordSupportDataQuery).
 * T-B43: una negativa es SIEMPRE un texto fijo de texts.ts, nunca un dato: el worker la guarda como ayuda, sin cifrar, y llega tal
 * cual al historial del modelo. Lo que elige una capacidad (una llave) pasa por supportDataRefusal, que falla cerrado.
 * T-B44: las negativas, la etiqueta y el objeto se leen de lo que nació congelado (texts.ts y la capacidad congelada al registrarla, `dataCatalog`).
 */

export interface DataEnvelope {
  v: 1
  capability: string
  text: string
  validity: string
  preparedAt: string
}
export const sealDataEnvelope = (e: DataEnvelope): string => supportCipher.encryptToBase64(JSON.stringify(e))
/** null si falta, no descifra o no cumple la forma. */
export function openDataEnvelope(cipher: string | null): DataEnvelope | null {
  if (!cipher) return null
  try {
    const e = JSON.parse(supportCipher.decryptFromBase64(cipher))
    const ok =
      e?.v === 1 &&
      [e.capability, e.text, e.validity, e.preparedAt].every(x => typeof x === 'string') &&
      Number.isFinite(Date.parse(e.preparedAt))
    return ok ? { v: 1, capability: e.capability, text: e.text, validity: e.validity, preparedAt: e.preparedAt } : null
  } catch {
    return null
  }
}

/** La huella de acceso de una respuesta de datos: la de readSupportContext leída con el candado de la capacidad, más el puesto. */
export function dataAccessFingerprint(ctx: SupportContext): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ access: ctx.fingerprint, role: ctx.access?.role ?? null }))
    .digest('hex')
}

export type DataLog = { staffId: string; venueId: string; capability: string; paramsHmac: string; result: SupportDataResult; day: string }
export type DataOutcome =
  | { kind: 'answer'; capability: string; envelope: DataEnvelope; accessFingerprint: string; log: DataLog }
  | { kind: 'refusal'; capability: string | null; text: string; log: DataLog | null }

/** `available()` de una capacidad. Si lanza o rechaza, está apagada (falla cerrado): sin el mensaje, que puede traer datos. */
async function capabilityIsOn(def: AnyDataCapability): Promise<boolean> {
  try {
    return def.available ? await def.available() : true
  } catch (err) {
    logger.warn('Support data capability check failed', {
      capability: def.key,
      name: (err as Error)?.name,
      code: (err as { code?: unknown })?.code,
    })
    return false
  }
}

/** Las capacidades que hoy se ofrecen, en el orden del catálogo: una con `available()` falso (o que falla) no existe para la persona. */
async function offeredCapabilities(capabilities: DataCatalog): Promise<AnyDataCapability[]> {
  const all = Object.values(capabilities)
  const on = await Promise.all(all.map(capabilityIsOn))
  return all.filter((_, i) => on[i])
}

const refusal = (text: string, capability: string | null = null, log: DataLog | null = null): DataOutcome => ({
  kind: 'refusal',
  capability,
  text,
  log,
})

export async function prepareDataAnswer(
  input: { conversation: SupportConversation; request: DataRequest; message: string; now: Date },
  capabilities: DataCatalog = DATA_CAPABILITIES,
): Promise<DataOutcome> {
  const { conversation, request, message, now } = input
  // 1. La B apagada: nada de esto corre.
  const config = getSupportDataConfig()
  if (!config) return refusal(SUPPORT_DATA_OFF)
  // 2. Un error de esta lectura NO se atrapa: sube tal cual y el worker saca el aviso público (isSupportAccessLost).
  const base = await readSupportContext(conversation, [], now)
  if (!base.context) return refusal(SUPPORT_DATA_LINK_FIRST)
  const { staffId, venueId } = base.context
  // 3. Ni con la sesión de otro: un superadmin no consulta datos de negocios por WhatsApp.
  if (await isActiveSuperAdmin(staffId)) return refusal(SUPPORT_DATA_SUPERADMIN)
  // 4. Fuera del catálogo (incluye 'other' y lo que hoy está apagado): la lista de lo que sí puede.
  const offered = await offeredCapabilities(capabilities)
  const def = offered.find(c => c.key === request.capability)
  if (!def) return refusal(supportDataOutOfCatalog(offered.map(c => c.label)))
  // Una sola lectura de la vigencia; su huella va tal cual al sobre (nunca se recalcula aquí).
  const validity = await readDataValidity(prisma, { staffId, venueId, linkId: conversation.linkId, now })
  const log = (result: SupportDataResult): DataLog => ({
    staffId,
    venueId,
    capability: def.key,
    paramsHmac: paramsHmac(request),
    result,
    day: validity.day,
  })
  const refuse = (text: string, result: SupportDataResult) => refusal(text, def.key, log(result))
  // 5. Otra sucursal: no se consulta.
  if (request.otherVenue) return refuse(SUPPORT_DATA_OTHER_VENUE, 'PARAM_INVALID')
  // 6. El desbloqueo va antes que el permiso: sin el toque del día, el texto es el mismo para todas las capacidades.
  if (!validity.accepted || !validity.unlocked) return refuse(SUPPORT_DATA_NEEDS_UNLOCK, 'NEEDS_UNLOCK')
  // 7. Permiso, puesto y plan, sobre el acceso leído con el candado de esta capacidad.
  const ctx = await readSupportContext(conversation, capabilityGates(def), now)
  // No se alcanza (la misma plática que en el paso 2, que ya tenía sucursal), pero `access` es `HelpAccess | null` y TypeScript pide el descarte.
  if (!ctx.access) return refusal(SUPPORT_DATA_LINK_FIRST)
  const denied = checkCapabilityAccess(def, ctx.access)
  if (denied) return refuse(denied.text, denied.result)
  const scope: DataScope = {
    venueId,
    organizationId: validity.organizationId,
    venueName: validity.venueName,
    timezone: validity.timezone,
    day: validity.day,
    kycVerified: validity.kycVerified,
    now,
    rows: config.rows,
    openOrdersDays: config.openOrdersDays,
    depositGroups: config.depositGroups,
    depositTimeoutMs: config.depositTimeoutMs,
  }
  // T-B44: cada llamada a la capacidad recibe su propio alcance, con su propia copia de la hora. Un `setHours` sobre `scope.now` que
  // se colara de la guardia no mueve la hora de las demás llamadas ni la del sobre (`preparedAt` sale de `now`, que nunca se entrega).
  const own = (): DataScope => ({ ...scope, now: new Date(now.getTime()) })
  // Lo que corre de la capacidad antes de leer falla cerrado si lanza, como la lectura y la plantilla: un error suyo, o una escritura
  // sobre lo que nace congelado (T-B44: una negativa, su etiqueta o su objeto). Sin el mensaje del error, que puede traer el alcance.
  const broken = (err: unknown) => {
    logger.warn('Support data capability failed', { capability: def.key, error: (err as Error)?.name })
    return refuse(SUPPORT_DATA_QUERY_FAILED, 'QUERY_FAILED')
  }
  // 8. No se ofrece en esta sucursal (sigue en el catálogo: se clasifica y contesta su texto). Cualquier valor que no sea null es
  //    una negativa: uno vacío o de otro tipo no deja pasar a la lectura.
  let notOffered: unknown
  try {
    notOffered = def.notOffered?.(own())
  } catch (err) {
    return broken(err)
  }
  if (notOffered !== null && notOffered !== undefined) return refuse(supportDataRefusal(notOffered), 'NOT_OFFERED')
  // 9. Los parámetros, contra el mensaje.
  let params: ReturnType<AnyDataCapability['params']>
  try {
    params = def.params(request, message, own())
  } catch (err) {
    return broken(err)
  }
  if (!params.ok) return refuse(supportDataRefusal(params.refusal), 'PARAM_INVALID')
  // 10. El tope del día cuenta sólo lo que sí leyó. Hasta aquí, cero lecturas.
  if ((await countDataReadsToday(staffId, validity.day)) >= config.dailyCap) return refusal(SUPPORT_DATA_DAILY_CAP, def.key)
  // 11. UNA lectura. Una que falla nunca da una respuesta parcial.
  // ponytail: el tiempo máximo corta la espera, no la consulta en Postgres; statement_timeout por transacción si un día hace falta
  let result: unknown
  try {
    result = await within(def.read(own(), params.value), config.queryTimeoutMs)
  } catch (err) {
    if (err instanceof DataReadRefusal) return refuse(supportDataRefusal(err.refusal), err.result)
    // Sin el mensaje: el de Prisma puede traer los argumentos de la consulta (un monto).
    logger.warn('Support data read failed', { capability: def.key, error: (err as Error)?.name, code: (err as { code?: unknown })?.code })
    return refuse(SUPPORT_DATA_QUERY_FAILED, 'QUERY_FAILED')
  }
  // 12. La plantilla y el cotejo: sin una cifra confirmada no sale ninguna.
  let rendered: Rendered | null = null
  try {
    rendered = def.render(own(), params.value, result)
  } catch {
    rendered = null
  }
  if (!rendered || !checkRendered(rendered, scope.timezone)) {
    logger.warn('Support data check failed', { capability: def.key })
    return refuse(SUPPORT_DATA_CHECK_FAILED, 'CHECK_FAILED')
  }
  // 13. El sobre.
  return {
    kind: 'answer',
    capability: def.key,
    envelope: { v: 1, capability: def.key, text: rendered.text, validity: validity.fingerprint, preparedAt: now.toISOString() },
    accessFingerprint: dataAccessFingerprint(ctx),
    log: log('ANSWERED'),
  }
}

/**
 * Lo que dice cada revisión de la entrega. OK: se manda. ACCESS: cambió un permiso, el puesto o el plan, o la persona es superadmin.
 * STALE: cambió la vigencia del dato. OFF: la B se apagó. GONE: el contexto personal ya no existe (el vínculo o el acceso a la
 * sucursal): es el ÚNICO veredicto que regresa la plática a la ayuda pública en la segunda revisión.
 */
export type DataDeliveryVerdict = 'OK' | 'ACCESS' | 'STALE' | 'OFF' | 'GONE'
export async function checkDataDelivery(
  conversation: SupportConversation,
  savedAccessFingerprint: string | null,
  envelope: DataEnvelope | null,
  now = new Date(),
  capabilities: DataCatalog = DATA_CAPABILITIES,
): Promise<DataDeliveryVerdict> {
  const def = envelope ? (await offeredCapabilities(capabilities)).find(c => c.key === envelope.capability) : undefined
  // 1. GONE primero: quien ya no tiene vínculo o sucursal nunca recibe un texto de plática personal. Un error de acceso perdido
  //    nunca escapa: se regresa como veredicto. Cualquier otro error sube tal cual.
  let ctx: SupportContext
  try {
    ctx = await readSupportContext(conversation, def ? capabilityGates(def) : [], now)
  } catch (err) {
    if (isSupportAccessLost(err)) return 'GONE'
    throw err
  }
  // 2. La B apagada.
  const config = getSupportDataConfig()
  if (!config) return 'OFF'
  // 3. Sin sobre, o su capacidad ya no está en el catálogo.
  if (!envelope || !def) return 'STALE'
  // 4. Superadmin, o cambió un permiso, el puesto o el plan.
  if (!ctx.context || (await isActiveSuperAdmin(ctx.context.staffId)) || dataAccessFingerprint(ctx) !== savedAccessFingerprint)
    return 'ACCESS'
  // 5. La vigencia: aviso y desbloqueo de hoy, la misma huella (zona, día, desbloqueo, aviso, verificación) y 10 min.
  const validity = await readDataValidity(prisma, {
    staffId: ctx.context.staffId,
    venueId: ctx.context.venueId,
    linkId: conversation.linkId,
    now,
  })
  if (
    !validity.accepted ||
    !validity.unlocked ||
    validity.fingerprint !== envelope.validity ||
    !(now.getTime() - Date.parse(envelope.preparedAt) <= config.freshMs)
  )
    return 'STALE'
  return 'OK'
}
