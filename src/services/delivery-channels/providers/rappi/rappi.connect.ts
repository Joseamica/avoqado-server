/**
 * La intención de conexión de Rappi — el mismo contrato de seguridad que la de Uber (spec
 * 2026-09-21 §4.1), con SU llave. El venue viaja sólo dentro de la fila firmada; cada paso público
 * (start, callback, activate, result) exige una firma con SU propósito.
 *
 * Por qué no se reusa la firma de Uber: está derivada de UBER_WEBHOOK_SIGNING_KEY y su código es de
 * otra sesión. Lo que sí es genérico (el CAS de estado) se importa tal cual.
 * ponytail: copia de ~40 líneas de cripto de `deliveryConnectIntent.service.ts`; extraer a un módulo
 * común cuando esa sesión libere el archivo.
 *
 * El `code_verifier` de PKCE NO se guarda: se DERIVA de la llave y del id del intent. Es secreto
 * mientras la llave lo sea, y así no hace falta columna nueva.
 */
import crypto from 'crypto'
import { DeliveryConnectIntent, OrderAcceptanceMode } from '@prisma/client'

import AppError from '@/errors/AppError'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import prisma from '@/utils/prismaClient'

import { fallar } from '../../core/deliveryConnectIntent.service'

export type PropositoRappi = 'start' | 'callback' | 'activate' | 'result'
export interface ConnectDeps {
  llave: string
  ambiente: 'SANDBOX' | 'PRODUCTION'
  clientId: string
}
type Identidad = Pick<DeliveryConnectIntent, 'id' | 'environment' | 'venueId' | 'clientId'>

const INTENT_TTL_MS = 10 * 60_000
/** Mientras Rappi confirma (asíncrono) el intent sigue vivo: el re-chequeo necesita el id_token. */
export const TTL_ACTIVANDO_MS = 24 * 60 * 60_000
/** Una llave más corta que esto no aguanta HKDF/HMAC con seriedad: se rechaza en vez de firmar con ella. */
const LLAVE_MIN_CARACTERES = 32

const derivar = (d: ConnectDeps, info: string, salt: string) => Buffer.from(crypto.hkdfSync('sha256', d.llave, salt, info, 32))
const hmac = (d: ConnectDeps, id: string, p: PropositoRappi) =>
  crypto
    .createHmac('sha256', derivar(d, 'rappi-connect-intent', ''))
    .update(`${p}:${id}`)
    .digest('base64url')

export function firmar(d: ConnectDeps, id: string, p: PropositoRappi): string {
  return `${id}.${hmac(d, id, p)}`
}

export function leerFirma(d: ConnectDeps, firmado: unknown, p: PropositoRappi): string | null {
  if (typeof firmado !== 'string') return null
  const i = firmado.lastIndexOf('.')
  if (i <= 0) return null
  const id = firmado.slice(0, i)
  const recibido = Buffer.from(firmado.slice(i + 1))
  const esperado = Buffer.from(hmac(d, id, p))
  return recibido.length === esperado.length && crypto.timingSafeEqual(recibido, esperado) ? id : null
}

export function verifierDe(d: ConnectDeps, intentId: string): string {
  return derivar(d, 'rappi-pkce-verifier', intentId).toString('base64url') // 32 B → 43 caracteres
}

const aad = (i: Identidad) => Buffer.from(`${i.id}|${i.environment}|${i.venueId}|${i.clientId}`)

export function cifrarIdToken(d: ConnectDeps, intent: Identidad, token: string): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', derivar(d, 'rappi-merchant-token', intent.id), iv)
  c.setAAD(aad(intent))
  const ct = Buffer.concat([c.update(token, 'utf8'), c.final()])
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`
}

export function descifrarIdToken(d: ConnectDeps, intent: Identidad & { merchantTokenEnvelope: string | null }): string | null {
  try {
    const [v, iv, tag, ct] = (intent.merchantTokenEnvelope ?? '').split(':')
    if (v !== 'v1' || !iv || !tag || !ct) return null
    const etiqueta = Buffer.from(tag, 'base64')
    if (etiqueta.length !== 16) return null // GCM acepta etiquetas recortadas si no se exige el largo
    const dc = crypto.createDecipheriv('aes-256-gcm', derivar(d, 'rappi-merchant-token', intent.id), Buffer.from(iv, 'base64'), {
      authTagLength: 16,
    })
    dc.setAAD(aad(intent))
    dc.setAuthTag(etiqueta)
    return Buffer.concat([dc.update(Buffer.from(ct, 'base64')), dc.final()]).toString('utf8')
  } catch {
    return null
  }
}

export async function crearIntentRappi(d: ConnectDeps, p: { venueId: string; staffId: string }): Promise<{ id: string; firmado: string }> {
  const intent = await prisma.deliveryConnectIntent.create({
    data: {
      venueId: p.venueId,
      staffId: p.staffId,
      provider: 'RAPPI',
      environment: d.ambiente,
      clientId: d.clientId,
      orderAcceptanceMode: OrderAcceptanceMode.AUTO,
      expiresAt: new Date(Date.now() + INTENT_TTL_MS),
    },
  })
  return { id: intent.id, firmado: firmar(d, intent.id, 'start') }
}

/** Lo mismo que el `revalidar` de Uber, con la identidad de Rappi. Falla ⇒ FAILED + motivo. */
export async function revalidarRappi(d: ConnectDeps, intent: DeliveryConnectIntent): Promise<string | null> {
  let motivo: string | null = null
  if (intent.provider !== 'RAPPI') return 'WRONG_PROVIDER' // sin `fallar`: no es nuestro intent
  if (intent.expiresAt.getTime() <= Date.now()) motivo = 'EXPIRED'
  else if (intent.environment !== d.ambiente) motivo = 'ENVIRONMENT_CHANGED'
  else if (intent.clientId !== d.clientId) motivo = 'CLIENT_ID_CHANGED'
  else if (
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

export async function depsDesdeEnv(): Promise<ConnectDeps> {
  const { env } = await import('@/config/env')
  const { clientIdRappi, getRappiEnvironment } = await import('./rappi.client')
  const llave = env.RAPPI_CONNECT_SIGNING_KEY?.trim()
  let clientId: string | undefined
  try {
    clientId = clientIdRappi()
  } catch {
    clientId = undefined // sin credenciales de Rappi: mismo error que sin llave
  }
  if (!llave || llave.length < LLAVE_MIN_CARACTERES || !clientId) {
    throw new AppError('La conexión con Rappi no está configurada en el servidor.', 500, true, 'RAPPI_CONNECT_NOT_CONFIGURED')
  }
  return { llave, ambiente: getRappiEnvironment(), clientId }
}
