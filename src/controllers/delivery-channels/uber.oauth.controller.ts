/**
 * Activación de Uber Eats por OAuth — el comerciante autoriza a Avoqado sobre sus tiendas.
 *
 * POR QUÉ EXISTE: una tienda sólo queda alcanzable por nuestro token de aplicación
 * DESPUÉS de que su dueño autorice la app y se llame `POST /pos_data`
 * [doc: developer.uber.com/docs/eats/guides/integration-activation-flows]. Sin este
 * flujo, cada alta dependería de un ticket a soporte de Uber.
 *
 * El token del COMERCIANTE se usa una sola vez y se descarta: tras la activación el
 * acceso es perpetuo vía `client_credentials`, así que guardarlo sería conservar una
 * credencial ajena sin necesidad.
 *
 * ⚠️ Rutas PÚBLICAS (Uber redirige el navegador aquí, sin sesión de Avoqado). Por eso
 * el `state` es obligatorio y se firma: sin él, cualquiera podría disparar el callback.
 */
import crypto from 'crypto'
import { Request, Response } from 'express'

import { env } from '@/config/env'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

import {
  buildUberAuthorizeUrl,
  exchangeUberAuthCode,
  uberRequest,
  type UberCredentials,
} from '@/services/delivery-channels/providers/uber-eats/uber.http'
import { type UberEnvironment } from '@/services/delivery-channels/providers/uber-eats/uber.storeAllowlist'

function environment(): UberEnvironment {
  return env.UBER_ENVIRONMENT as UberEnvironment
}

function credentials(): UberCredentials {
  const e = environment()
  const clientId = e === 'SANDBOX' ? env.UBER_CLIENT_ID_SANDBOX : env.UBER_CLIENT_ID_PRODUCTION
  const clientSecret = e === 'SANDBOX' ? env.UBER_CLIENT_SECRET_SANDBOX : env.UBER_CLIENT_SECRET_PRODUCTION
  if (!clientId || !clientSecret) {
    throw new Error(`Faltan UBER_CLIENT_ID_${e} / UBER_CLIENT_SECRET_${e} en el .env`)
  }
  return { clientId, clientSecret }
}

/** La URL de retorno DEBE ser idéntica al pedir y al canjear: OAuth lo exige. */
function redirectUri(req: Request): string {
  const base = env.UBER_OAUTH_REDIRECT_BASE || `${req.protocol}://${req.get('host')}`
  return `${base}/api/v1/delivery/uber/oauth/callback`
}

/** `state` firmado con la llave del webhook: prueba que el callback nació aquí. */
function signState(payload: string): string {
  const key = env.UBER_WEBHOOK_SIGNING_KEY || 'sin-llave'
  const mac = crypto.createHmac('sha256', key).update(payload).digest('hex').slice(0, 32)
  return `${payload}.${mac}`
}

function verifyState(state: string): string | null {
  const i = state.lastIndexOf('.')
  if (i <= 0) return null
  const payload = state.slice(0, i)
  const esperado = signState(payload)
  const a = Buffer.from(state)
  const b = Buffer.from(esperado)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  return payload
}

function page(titulo: string, cuerpo: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${titulo}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:56px auto;padding:0 20px;color:#1a1a1a}
code{background:#f2f2f0;padding:2px 6px;border-radius:4px;font-size:14px}
.ok{color:#1d7a4d}.bad{color:#b32020}li{margin:6px 0}</style>
<h1>${titulo}</h1>${cuerpo}`
}

/** Paso 1: manda al comerciante a autorizar. */
export async function startUberOAuth(req: Request, res: Response): Promise<void> {
  try {
    const nonce = crypto.randomBytes(12).toString('hex')
    const url = buildUberAuthorizeUrl({
      environment: environment(),
      clientId: credentials().clientId,
      redirectUri: redirectUri(req),
      state: signState(nonce),
    })
    res.redirect(url)
  } catch (e) {
    logger.error('No se pudo iniciar el OAuth de Uber', { error: (e as Error).message })
    res.status(500).send(page('No se pudo iniciar', `<p class="bad">${(e as Error).message}</p>`))
  }
}

/** Paso 2: recibe el código, canjea, lista tiendas y activa Avoqado contra cada una. */
export async function uberOAuthCallback(req: Request, res: Response): Promise<void> {
  const { code, state, error, error_description: desc } = req.query as Record<string, string>

  if (error) {
    res.status(400).send(page('Uber rechazó la autorización', `<p class="bad"><code>${error}</code> ${desc ?? ''}</p>`))
    return
  }
  if (!code) {
    res.status(400).send(page('Falta el código', '<p class="bad">Uber no mandó <code>code</code>.</p>'))
    return
  }
  if (!state || !verifyState(state)) {
    res.status(400).send(page('Estado inválido', '<p class="bad">El <code>state</code> no se pudo verificar. Reinicia el flujo.</p>'))
    return
  }

  try {
    const e = environment()
    const creds = credentials()

    const userToken = await exchangeUberAuthCode({
      environment: e,
      credentials: creds,
      code,
      redirectUri: redirectUri(req),
    })

    // Con el token del COMERCIANTE: sus tiendas, no las nuestras.
    const lista = await uberRequest(
      { environment: e, token: userToken.access_token, writableStores: new Set() },
      { method: 'GET', path: '/v1/eats/stores' },
    )

    const tiendas: Array<{ store_id?: string; name?: string }> = (lista.json as { stores?: [] })?.stores ?? []
    if (tiendas.length === 0) {
      res
        .status(200)
        .send(
          page('Autorizado, pero sin tiendas', `<p>Uber no devolvió tiendas para esta cuenta.</p><pre>${lista.text.slice(0, 500)}</pre>`),
        )
      return
    }

    // Activar la app contra cada tienda. Esto es lo que da acceso PERPETUO al token
    // de aplicación; sin ello, seguiríamos viendo 401.
    const filas: string[] = []
    for (const t of tiendas) {
      const storeId = t.store_id
      if (!storeId) continue

      const link = await prisma.deliveryChannelLink.findUnique({
        where: { provider_externalLocationId: { provider: 'UBER_EATS', externalLocationId: storeId } },
        select: { venueId: true, venue: { select: { name: true } } },
      })

      const activacion = await uberRequest(
        { environment: e, token: userToken.access_token, writableStores: new Set([storeId.toLowerCase()]) },
        {
          method: 'POST',
          path: `/v1/eats/stores/${encodeURIComponent(storeId)}/pos_data`,
          storeId,
          body: { integrator_store_id: link?.venueId ?? storeId, integrator_brand_id: 'avoqado' },
        },
      )

      const ok = activacion.status < 400
      filas.push(
        `<li><strong>${t.name ?? '(sin nombre)'}</strong><br>` +
          `<code>${storeId}</code><br>` +
          `activación: <span class="${ok ? 'ok' : 'bad'}">HTTP ${activacion.status}</span>` +
          (ok ? '' : ` — ${activacion.text.slice(0, 200)}`) +
          `<br>negocio en Avoqado: ${link?.venue?.name ?? '<span class="bad">sin vincular</span>'}</li>`,
      )
    }

    logger.info('Uber OAuth: activación completada', { tiendas: tiendas.length })
    res.status(200).send(page('Avoqado quedó conectado', `<ul>${filas.join('')}</ul><p>Ya puedes cerrar esta pestaña.</p>`))
  } catch (err) {
    logger.error('Falló el callback de OAuth de Uber', { error: (err as Error).message })
    res.status(500).send(page('Falló la activación', `<p class="bad">${(err as Error).message}</p>`))
  }
}
