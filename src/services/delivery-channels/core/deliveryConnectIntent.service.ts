/**
 * La intención de conexión de una tienda de Uber Eats — spec 2026-09-21 §4.1.
 *
 * POR QUÉ EXISTE: conectar una tienda de Uber a un negocio de Avoqado desvía pedidos REALES.
 * Antes el `venueId` viajaba por la URL pública del OAuth (`/start?venueId=…`): cualquiera
 * podía armar el enlace de un negocio ajeno. Ahora el enlace lleva una intención emitida por
 * una petición AUTENTICADA, firmada, con caducidad, y que se revalida en cada paso.
 *
 * Máquina de estados, y cada transición es un CAS (`updateMany where state = <de>`):
 *
 *   CREATED ──callback──▶ EXCHANGED ──selección──▶ ACTIVATING ──todas finales──▶ CONSUMED
 *      │                     │                        │
 *      └─────────────────────┴────── cualquier fallo ─┴──▶ FAILED        (vencido ⇒ EXPIRED, job)
 *
 * `activar` es REENTRANTE pero EXCLUSIVA: toma un lease con dueño (`activationOwner`) y
 * vencimiento; toda escritura hecha bajo el lease lleva al dueño en su `where`, así una
 * ejecución muerta no escribe nada aunque su respuesta de Uber llegue tarde.
 *
 * 🔴 Nunca se loguean tokens, códigos, sobres ni llaves: sólo ids.
 */
import crypto from 'crypto'
import { DeliveryConnectIntent, OrderAcceptanceMode, Prisma } from '@prisma/client'

import { env } from '@/config/env'
import logger from '@/config/logger'
import AppError from '@/errors/AppError'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'

export type EstadoIntent = 'CREATED' | 'EXCHANGED' | 'ACTIVATING' | 'CONSUMED' | 'FAILED' | 'EXPIRED'
/** Para qué sirve una firma: un enlace de `/start` no vale como `state` del callback ni como `state2`. */
export type Proposito = 'start' | 'callback' | 'activate'

const TERMINALES: EstadoIntent[] = ['CONSUMED', 'FAILED', 'EXPIRED']
const VIVOS: EstadoIntent[] = ['CREATED', 'EXCHANGED', 'ACTIVATING']
const INTENT_TTL_MS = 10 * 60_000
const LEASE_MS = 2 * 60_000

/** Único resultado de tienda que NO es final: el «Reintentar» lo repite. */
export const RESULTADO_REINTENTABLE = 'LOCAL_WRITE_FAILED'

// ─── Llaves ─────────────────────────────────────────────────────────────────────────────

/**
 * `UBER_WEBHOOK_SIGNING_KEY` es opcional en `env.ts` (el server arranca sin ella) pero
 * OBLIGATORIA para este flujo: sin llave no hay forma segura de firmar ni de cifrar.
 */
function llaveMaestra(): string {
  const k = env.UBER_WEBHOOK_SIGNING_KEY
  if (!k) {
    throw new AppError(
      'La conexión con Uber Eats no está configurada en el servidor (falta UBER_WEBHOOK_SIGNING_KEY).',
      500,
      true,
      'UBER_CONNECT_NOT_CONFIGURED',
    )
  }
  return k
}

/** Una llave por uso (HKDF con `info` distinto): la del HMAC nunca descifra un token, ni al revés. */
function derivar(info: string, salt: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', llaveMaestra(), salt, info, 32))
}

function clientIdVigente(environment: string): string | undefined {
  return environment === 'PRODUCTION' ? env.UBER_CLIENT_ID_PRODUCTION : env.UBER_CLIENT_ID_SANDBOX
}

// ─── Firma del enlace ───────────────────────────────────────────────────────────────────

function hmac(id: string, proposito: Proposito): string {
  return crypto.createHmac('sha256', derivar('uber-connect-intent', '')).update(`${proposito}:${id}`).digest('base64url')
}

export function firmarIntent(id: string, proposito: Proposito): string {
  return `${id}.${hmac(id, proposito)}`
}

/** El id del intent si la firma es válida PARA ESE propósito; `null` si no. */
export function leerFirma(firmado: unknown, proposito: Proposito): string | null {
  if (typeof firmado !== 'string') return null
  const i = firmado.lastIndexOf('.')
  if (i <= 0) return null
  const id = firmado.slice(0, i)
  const recibido = Buffer.from(firmado.slice(i + 1))
  const esperado = Buffer.from(hmac(id, proposito))
  return recibido.length === esperado.length && crypto.timingSafeEqual(recibido, esperado) ? id : null
}

// ─── Token del comerciante, cifrado en reposo ───────────────────────────────────────────

type Identidad = Pick<DeliveryConnectIntent, 'id' | 'environment' | 'venueId' | 'clientId'>

/** El AAD ata el sobre a SU fila: copiado a otro intent (o con la identidad cambiada) no abre. */
const aad = (i: Identidad) => Buffer.from(`${i.id}|${i.environment}|${i.venueId}|${i.clientId}`)

/** `v1:<iv 12 B>:<tag 16 B>:<ciphertext>` en base64, AES-256-GCM, llave HKDF(salt = intent.id). */
export function cifrarTokenComerciante(intent: Identidad, token: string): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', derivar('uber-merchant-token', intent.id), iv)
  c.setAAD(aad(intent))
  const ct = Buffer.concat([c.update(token, 'utf8'), c.final()])
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`
}

/** `null` ante CUALQUIER falla (sobre ausente, llave rotada o ausente, AAD distinto, formato). */
export function descifrarTokenComerciante(intent: Identidad & { merchantTokenEnvelope: string | null }): string | null {
  try {
    const [v, iv, tag, ct] = (intent.merchantTokenEnvelope ?? '').split(':')
    if (v !== 'v1' || !iv || !tag || !ct) return null
    // 🔴 La etiqueta mide 16 B exactos: GCM acepta etiquetas RECORTADAS (hasta 4 B) si no se exige
    // el largo, y un prefijo de la buena verifica — la resistencia a falsificación caería a ~2^32.
    const etiqueta = Buffer.from(tag, 'base64')
    if (etiqueta.length !== 16) return null
    const d = crypto.createDecipheriv('aes-256-gcm', derivar('uber-merchant-token', intent.id), Buffer.from(iv, 'base64'), {
      authTagLength: 16,
    })
    d.setAAD(aad(intent))
    d.setAuthTag(etiqueta)
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')
  } catch {
    return null
  }
}

// ─── Estados ────────────────────────────────────────────────────────────────────────────

export async function crearIntent(params: {
  venueId: string
  staffId: string
  orderAcceptanceMode?: OrderAcceptanceMode
}): Promise<{ intent: DeliveryConnectIntent; firmado: string }> {
  llaveMaestra() // sin llave no se emite nada que después no se pueda verificar
  const environment = env.UBER_ENVIRONMENT
  const clientId = clientIdVigente(environment)
  if (!clientId) {
    throw new AppError(
      `La conexión con Uber Eats no está configurada en el servidor (falta UBER_CLIENT_ID_${environment}).`,
      500,
      true,
      'UBER_CONNECT_NOT_CONFIGURED',
    )
  }
  const intent = await prisma.deliveryConnectIntent.create({
    data: {
      venueId: params.venueId,
      staffId: params.staffId,
      provider: 'UBER_EATS',
      environment,
      clientId,
      orderAcceptanceMode: params.orderAcceptanceMode ?? OrderAcceptanceMode.AUTO,
      expiresAt: new Date(Date.now() + INTENT_TTL_MS),
    },
  })
  return { intent, firmado: firmarIntent(intent.id, 'start') }
}

/**
 * CAS de estado. Salir a un estado terminal borra SIEMPRE el token y el lease: un sobre
 * sólo existe mientras la intención puede usarlo.
 */
export async function casEstado(
  id: string,
  de: EstadoIntent | EstadoIntent[],
  a: EstadoIntent,
  data: Prisma.DeliveryConnectIntentUpdateManyMutationInput = {},
  donde: Prisma.DeliveryConnectIntentWhereInput = {},
): Promise<boolean> {
  const terminal = TERMINALES.includes(a) ? { merchantTokenEnvelope: null, activationOwner: null, activationLeaseUntil: null } : {}
  const { count } = await prisma.deliveryConnectIntent.updateMany({
    where: { ...donde, id, state: Array.isArray(de) ? { in: de } : de },
    data: { ...data, ...terminal, state: a },
  })
  return count === 1
}

export async function fallar(id: string, motivo: string): Promise<boolean> {
  const ok = await casEstado(id, VIVOS, 'FAILED', { failureReason: motivo })
  if (ok) logger.warn('🛵 [UberConnect] intent FAILED', { intentId: id, motivo })
  return ok
}

/**
 * Se corre en `/start`, en el callback y en CADA entrada a `activar`. Comprueba que lo que
 * autorizó la emisión SIGUE siendo cierto: vigencia, ambiente y app de Uber vigentes, que el
 * empleado siga activo en el negocio con `delivery-channels:manage`, y que el plan lo cubra.
 * Falla ⇒ `FAILED` con motivo (token borrado) y devuelve el motivo; todo bien ⇒ `null`.
 */
export async function revalidar(intent: DeliveryConnectIntent): Promise<string | null> {
  let motivo: string | null = null
  if (intent.expiresAt.getTime() <= Date.now()) motivo = 'EXPIRED'
  else if (intent.environment !== env.UBER_ENVIRONMENT) motivo = 'ENVIRONMENT_CHANGED'
  else if (intent.clientId !== clientIdVigente(intent.environment)) motivo = 'CLIENT_ID_CHANGED'
  else if (
    // La MISMA definición de permiso que `checkPermission` (rol del venue, set propio, SUPERADMIN).
    !(await tienePermisoEnVenue(
      { authContext: { userId: intent.staffId }, params: { venueId: intent.venueId }, headers: {} } as never,
      'delivery-channels:manage',
    ))
  )
    motivo = 'STAFF_NOT_AUTHORIZED'
  else if (!(await venueHasFeatureAccess(intent.venueId, 'DELIVERY_CHANNELS'))) motivo = 'PLAN_REQUIRED'

  if (motivo) await fallar(intent.id, motivo)
  return motivo
}

// ─── Lease de activación ────────────────────────────────────────────────────────────────

/** El dueño nuevo, o `null` si otra ejecución tiene el lease vivo (⇒ «activación en curso»). */
export async function tomarLeaseDeActivacion(id: string): Promise<string | null> {
  const owner = crypto.randomUUID()
  const ahora = new Date()
  const { count } = await prisma.deliveryConnectIntent.updateMany({
    where: { id, state: 'ACTIVATING', OR: [{ activationLeaseUntil: null }, { activationLeaseUntil: { lt: ahora } }] },
    data: { activationOwner: owner, activationLeaseUntil: new Date(ahora.getTime() + LEASE_MS), activationAttempt: { increment: 1 } },
  })
  return count === 1 ? owner : null
}

/** Sólo un dueño con el lease AÚN vivo lo renueva: uno vencido podría estar ya reemplazado. */
export async function renovarLease(id: string, owner: string): Promise<boolean> {
  const ahora = new Date()
  const { count } = await prisma.deliveryConnectIntent.updateMany({
    where: { id, state: 'ACTIVATING', activationOwner: owner, activationLeaseUntil: { gt: ahora } },
    data: { activationLeaseUntil: new Date(ahora.getTime() + LEASE_MS) },
  })
  return count === 1
}

export async function liberarLease(id: string, owner: string): Promise<boolean> {
  const { count } = await prisma.deliveryConnectIntent.updateMany({
    where: { id, activationOwner: owner },
    data: { activationOwner: null, activationLeaseUntil: null },
  })
  return count === 1
}

/**
 * Anota el resultado de UNA tienda. El `where` exige estado, dueño y lease vivo EN LA MISMA
 * sentencia: si otra ejecución recuperó el intent, esta escritura no pasa (count 0).
 * Merge con `||` de jsonb: no hay lectura-modificación-escritura que pueda pisar otra tienda.
 */
async function registrarResultado(id: string, owner: string, storeId: string, resultado: ResultadoTienda): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE "DeliveryConnectIntent"
       SET "resultsJson" = COALESCE("resultsJson", '{}'::jsonb) || jsonb_build_object(${storeId}::text, ${JSON.stringify(resultado)}::jsonb),
           "updatedAt" = ${utcTs(new Date())}
     WHERE "id" = ${id}
       AND "state" = 'ACTIVATING'
       AND "activationOwner" = ${owner}
       AND "activationLeaseUntil" > ${utcTs(new Date())}`
  return n === 1
}

// ─── Activación ─────────────────────────────────────────────────────────────────────────

export interface TiendaUber {
  id: string
  name: string | null
}
export interface ResultadoTienda {
  outcome: string
  [k: string]: unknown
}
export type ActivarTienda = (ctx: {
  intent: DeliveryConnectIntent
  owner: string
  token: string
  storeId: string
  store: TiendaUber | undefined
}) => Promise<ResultadoTienda>

export type ResultadoActivacion =
  | { estado: 'NO_DISPONIBLE'; motivo: string | null }
  | { estado: 'FAILED'; motivo: string }
  | { estado: 'EN_CURSO' }
  | { estado: 'CONSUMED' | 'INCOMPLETO' | 'INTERRUMPIDO'; resultados: Record<string, ResultadoTienda> }

const esFinal = (r: ResultadoTienda | undefined) => !!r && r.outcome !== RESULTADO_REINTENTABLE

/**
 * Corre la activación de un intent en `ACTIVATING`. Una sola función para el callback (una
 * tienda) y para `POST /oauth/activate` (varias, y el «Reintentar»).
 *
 * @param activarTienda el trabajo por tienda (hoy: `pos_data`; T18: reclamar + finalizar por CAS).
 */
export async function activar(id: string, activarTienda: ActivarTienda): Promise<ResultadoActivacion> {
  const leido = await prisma.deliveryConnectIntent.findUnique({ where: { id } })
  if (!leido || leido.state !== 'ACTIVATING') return { estado: 'NO_DISPONIBLE', motivo: leido?.failureReason ?? null }

  const motivo = await revalidar(leido)
  if (motivo) return { estado: 'FAILED', motivo }

  const owner = await tomarLeaseDeActivacion(id)
  if (!owner) return { estado: 'EN_CURSO' }

  // Se relee CON el lease: una recuperación tiene que ver lo que la ejecución anterior ya anotó.
  const intent = await prisma.deliveryConnectIntent.findUniqueOrThrow({ where: { id } })
  const token = descifrarTokenComerciante(intent)
  if (!token) {
    await fallar(id, 'TOKEN_UNREADABLE')
    return { estado: 'FAILED', motivo: 'TOKEN_UNREADABLE' }
  }

  const seleccion = (intent.selectionJson as string[] | null) ?? []
  const tiendas = (intent.storesJson as TiendaUber[] | null) ?? []
  const resultados = { ...((intent.resultsJson as Record<string, ResultadoTienda> | null) ?? {}) }

  for (const storeId of seleccion) {
    if (esFinal(resultados[storeId])) continue
    if (!(await renovarLease(id, owner))) return { estado: 'INTERRUMPIDO', resultados }

    let r: ResultadoTienda
    try {
      r = await activarTienda({ intent, owner, token, storeId, store: tiendas.find(t => t.id === storeId) })
    } catch (e) {
      logger.error('🚨 [UberConnect] la activación de una tienda lanzó', { intentId: id, storeId, error: (e as Error).message })
      r = { outcome: RESULTADO_REINTENTABLE }
    }
    // Ejecución muerta (otro dueño o lease vencido) ⇒ ni este resultado ni nada más.
    if (!(await registrarResultado(id, owner, storeId, { ...r, at: new Date().toISOString() }))) {
      logger.warn('🛵 [UberConnect] resultado descartado: la ejecución perdió el lease', { intentId: id, storeId })
      return { estado: 'INTERRUMPIDO', resultados }
    }
    resultados[storeId] = r
  }

  if (seleccion.every(s => esFinal(resultados[s]))) {
    const ok = await casEstado(id, 'ACTIVATING', 'CONSUMED', {}, { activationOwner: owner, activationLeaseUntil: { gt: new Date() } })
    return { estado: ok ? 'CONSUMED' : 'INTERRUMPIDO', resultados }
  }
  // Algo quedó sin finalizar por un fallo local: sigue ACTIVATING, con token y selección, para «Reintentar».
  await liberarLease(id, owner)
  return { estado: 'INCOMPLETO', resultados }
}
