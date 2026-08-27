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
import * as deliveryChannelLinkService from '@/services/delivery-channels/core/deliveryChannelLink.service'
import prisma from '@/utils/prismaClient'

import {
  buildUberAuthorizeUrl,
  exchangeUberAuthCode,
  uberRequest,
  type UberCredentials,
} from '@/services/delivery-channels/providers/uber-eats/uber.http'
import { getWritableStores } from '@/services/delivery-channels/providers/uber-eats/uber.client'
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

/**
 * Llave para firmar el `state`. LANZA si falta.
 *
 * 🔴 Antes caía a la cadena literal `'sin-llave'`, que está en el código fuente: cualquiera
 * podía forjar un `state` válido. Un default de firma NUNCA puede ser público. Hallado por
 * auditoría externa el 2026-08-20.
 */
function stateKey(): string {
  const key = env.UBER_WEBHOOK_SIGNING_KEY
  if (!key) {
    throw new Error('Falta UBER_WEBHOOK_SIGNING_KEY: sin ella no se puede firmar el state del OAuth de forma segura.')
  }
  return key
}

const STATE_TTL_MS = 10 * 60 * 1000

/**
 * `state` de un solo uso, con caducidad.
 *
 * ⚠️ El registro vive en memoria del proceso. Es válido mientras producción corra UNA sola
 * instancia (`.claude/rules/una-sola-instancia.md`); al pasar a varias hay que moverlo a
 * Redis o a una tabla, igual que el challenge store de auth móvil.
 */
const statesEmitidos = new Map<string, number>()

function signState(payload: string): string {
  const mac = crypto.createHmac('sha256', stateKey()).update(payload).digest('hex').slice(0, 32)
  return `${payload}.${mac}`
}

/**
 * @param venueId A qué negocio de Avoqado pertenecen las tiendas que el comercio va a
 *   autorizar. Viaja DENTRO del state firmado y NO como parámetro suelto — si viniera del
 *   query, cualquiera podría enlazar las tiendas de un comercio al negocio que quisiera.
 *   El HMAC es lo que hace que sólo nosotros podamos emitirlo.
 */
function issueState(venueId?: string): string {
  const ahora = Date.now()
  for (const [k, exp] of statesEmitidos) if (exp < ahora) statesEmitidos.delete(k)

  // El venueId va en el payload firmado. Sin `:` cuando no hay venue, para que los states
  // viejos (sin venue) sigan siendo válidos y una sesión en curso no se rompa al desplegar.
  const nonce = `${crypto.randomBytes(12).toString('hex')}.${ahora}${venueId ? `.${venueId}` : ''}`
  const state = signState(nonce)
  statesEmitidos.set(state, ahora + STATE_TTL_MS)
  return state
}

/** El venue que viajó dentro del state, si venía uno. Sólo se lee DESPUÉS de verificar la firma. */
function venueDelState(state: string): string | null {
  const payload = state.slice(0, state.lastIndexOf('.'))
  const partes = payload.split('.')
  return partes.length >= 3 ? partes[2] : null
}

/** Verifica firma, caducidad y que NO se haya usado. Consume el state al validarlo. */
function consumeState(state: string): boolean {
  const i = state.lastIndexOf('.')
  if (i <= 0) return false

  const esperado = signState(state.slice(0, i))
  const a = Buffer.from(state)
  const b = Buffer.from(esperado)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false

  // Firma válida no basta: sin esto, UN state robado sirve para siempre (replay).
  const expira = statesEmitidos.get(state)
  if (!expira || expira < Date.now()) return false
  statesEmitidos.delete(state)
  return true
}

/**
 * 🔴 Escapa TODO lo que venga de fuera antes de meterlo en HTML. Estas rutas son públicas y
 * sin sesión: interpolar `error_description` de la query o el nombre de una tienda que
 * devuelve Uber es XSS reflejado bajo el origen de la API. Hallado por auditoría externa.
 */
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function page(titulo: string, cuerpo: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${esc(titulo)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:56px auto;padding:0 20px;color:#1a1a1a}
code{background:#f2f2f0;padding:2px 6px;border-radius:4px;font-size:14px}
.ok{color:#1d7a4d}.bad{color:#b32020}li{margin:6px 0}</style>
<h1>${esc(titulo)}</h1>${cuerpo}`
}

/** Paso 1: manda al comerciante a autorizar. */
export async function startUberOAuth(req: Request, res: Response): Promise<void> {
  try {
    const url = buildUberAuthorizeUrl({
      environment: environment(),
      clientId: credentials().clientId,
      redirectUri: redirectUri(req),
      // `venueId` sólo se acepta de una petición ya autenticada (ver la ruta del dashboard
      // que lo emite); aquí llega ya validado y se sella dentro del state.
      state: issueState(typeof req.query.venueId === 'string' ? req.query.venueId : undefined),
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

  // 🔴 El `state` se valida ANTES de tocar nada más: sin eso, `error`/`error_description`
  // de un GET arbitrario llegaban a la respuesta sin haber probado que el flujo nació aquí.
  // El venue viaja DENTRO del state firmado; se lee antes de consumirlo, pero sólo se usa
  // después de que `consumeState` haya validado la firma — leerlo no lo autentica.
  const venueDelFlujo = state ? venueDelState(state) : null

  if (!state || !consumeState(state)) {
    res
      .status(400)
      .send(
        page('Estado inválido', '<p class="bad">El <code>state</code> no se pudo verificar, ya se usó, o caducó. Reinicia el flujo.</p>'),
      )
    return
  }
  if (error) {
    res.status(400).send(page('Uber rechazó la autorización', `<p class="bad"><code>${esc(error)}</code> ${esc(desc)}</p>`))
    return
  }
  if (!code) {
    res.status(400).send(page('Falta el código', '<p class="bad">Uber no mandó <code>code</code>.</p>'))
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
    // uAPI (`/v1/delivery/stores`): es el "Get Stores to User" que la validación de Uber
    // rastrea (caso 59605086) — el clásico `/v1/eats/stores` ya no cuenta para ellos.
    const lista = await uberRequest(
      { environment: e, token: userToken.access_token, writableStores: new Set() },
      { method: 'GET', path: '/v1/delivery/stores' },
    )

    // 🔴 Un 401/500 de Uber NO es "no hay tiendas". Antes ambos casos devolvían 200 con el
    // mismo mensaje, así que un fallo real se leía como éxito vacío.
    if (lista.status >= 400) {
      logger.error('Uber falló al listar las tiendas del comerciante', { status: lista.status, cuerpo: lista.text.slice(0, 300) })
      res
        .status(502)
        .send(page('Uber no devolvió tus tiendas', `<p class="bad">Uber respondió HTTP ${lista.status}. No se activó nada. Reintenta.</p>`))
      return
    }

    // uAPI: cada tienda trae `id`; la familia clásica traía `store_id`. Se aceptan ambos —
    // un shape inesperado no puede convertir una cuenta con tiendas en "sin tiendas".
    const tiendas: Array<{ id?: string; store_id?: string; name?: string }> = (lista.json as { stores?: [] })?.stores ?? []
    if (tiendas.length === 0) {
      res.status(200).send(page('Autorizado, pero sin tiendas', '<p>Uber no devolvió ninguna tienda para esta cuenta.</p>'))
      return
    }

    // Activar la app contra cada tienda. Esto es lo que da acceso PERPETUO al token
    // de aplicación; sin ello, seguiríamos viendo 401.
    // 🔴 El candado REAL, no uno fabricado al vuelo. Antes esta línea construía
    // `new Set([storeId])`, o sea que autorizaba justo la tienda que iba a escribir: el
    // default-deny quedaba anulado y una lista vacía permitía escribir en CUALQUIER tienda
    // que Uber devolviera — incluida una real. Hallado por auditoría externa el 2026-08-20.
    const permitidas = getWritableStores(e)

    const filas: string[] = []
    let activadas = 0
    let fallidas = 0
    let bloqueadas = 0

    for (const t of tiendas) {
      const storeId = t.id ?? t.store_id
      if (!storeId) continue

      let link = await prisma.deliveryChannelLink.findUnique({
        where: { provider_externalLocationId: { provider: 'UBER_EATS', externalLocationId: storeId } },
        select: { venueId: true, venue: { select: { name: true } } },
      })

      // 🔴 EL VÍNCULO SE CREA AQUÍ, y es lo que convierte esto en algo que un CLIENTE puede
      // usar. Antes sólo buscaba: había un huevo-y-gallina imposible de resolver solo —
      // hacía falta el id de tienda de Uber para crear el canal, y ese id sólo aparece
      // DESPUÉS de que el comercio autoriza. El resultado era que cada alta la teníamos que
      // rematar a mano contra la base.
      //
      // El `venueId` viene del state FIRMADO, no del query: si viniera del query, cualquiera
      // podría enlazar las tiendas de un comercio al negocio que quisiera.
      if (!link && venueDelFlujo) {
        try {
          await deliveryChannelLinkService.createChannelLink(venueDelFlujo, {
            provider: 'UBER_EATS',
            externalLocationId: storeId,
            externalAccountId: t.name ?? null,
          })
          link = await prisma.deliveryChannelLink.findUnique({
            where: { provider_externalLocationId: { provider: 'UBER_EATS', externalLocationId: storeId } },
            select: { venueId: true, venue: { select: { name: true } } },
          })
          logger.info('🛵 [UberOAuth] canal creado automáticamente al autorizar', { venueId: venueDelFlujo, storeId })
        } catch (err) {
          // Una tienda que no se pudo vincular NO detiene a las demás: un comercio con seis
          // sucursales no se queda sin conectar ninguna porque una falló.
          logger.error('🚨 [UberOAuth] no se pudo crear el canal', {
            venueId: venueDelFlujo,
            storeId,
            error: err instanceof Error ? err.message : err,
          })
        }
      }

      const encabezado = `<strong>${esc(t.name ?? '(sin nombre)')}</strong><br><code>${esc(storeId)}</code><br>`
      const negocio = `<br>negocio en Avoqado: ${link?.venue?.name ? esc(link.venue.name) : '<span class="bad">sin vincular</span>'}`

      if (!permitidas.has(storeId.toLowerCase())) {
        bloqueadas++
        filas.push(
          `<li>${encabezado}<span class="bad">NO activada</span> — no está en la lista de tiendas escribibles ` +
            `(<code>UBER_WRITABLE_STORE_IDS_${esc(e)}</code>). Es la protección que impide tocar un comercio real.${negocio}</li>`,
        )
        continue
      }

      const activacion = await uberRequest(
        { environment: e, token: userToken.access_token, writableStores: permitidas },
        {
          method: 'POST',
          path: `/v1/eats/stores/${encodeURIComponent(storeId)}/pos_data`,
          storeId,
          body: {
            integrator_store_id: link?.venueId ?? storeId,
            integrator_brand_id: 'avoqado',
            // 🔴 `is_order_manager` ES EL INTERRUPTOR. Sin él, la tienda queda con
            // `integration_enabled: true` y todo PARECE bien —el webhook llega, el pedido
            // se trae, se ingiere con su comanda de cocina— pero `accept_pos_order`
            // responde `403 user_not_allowed` y Uber cancela a los ~11.5 min. El cliente se
            // queda sin comida y el log sólo dice "user not allowed".
            //
            // Medido con un pedido REAL el 2026-08-20 (`00012fba-…`, "Avoqado Sandbox 1").
            // Ningún test lo podía atrapar: todos mockean la red.
            //
            // ⚠️ NO es `pos_integration_enabled`: ése está DEPRECADO y Uber lo IGNORA en
            // silencio — se probó mandándolo, el POST devolvió 200 y el flag siguió en
            // `false`. Lo dice nuestra propia investigación (ANEXO §Flujo
            // integrator-initiated, paso 4) y se confirmó contra la API real.
            is_order_manager: true,
            // AUTO: que Uber no exija que un humano confirme en su app. Nuestro
            // `orderAcceptanceMode` por canal es quien decide si aceptamos solos.
            require_manual_acceptance: false,
          },
        },
      )

      const ok = activacion.status < 400
      // `if` y no un ternario: un ternario cuyo valor se tira es una expresión sin efecto
      // declarado, y el linter lo marca con razón — el incremento es el efecto, no el valor.
      if (ok) activadas++
      else fallidas++
      filas.push(
        `<li>${encabezado}activación: <span class="${ok ? 'ok' : 'bad'}">HTTP ${activacion.status}</span>` +
          (ok ? '' : ` — ${esc(activacion.text.slice(0, 200))}`) +
          `${negocio}</li>`,
      )
    }

    // 🔴 "completada" sólo si de verdad se activó algo y nada falló. Antes se logueaba
    // "activación completada" aunque todas las tiendas hubieran fallado.
    const huboProblema = fallidas > 0 || activadas === 0
    logger[huboProblema ? 'warn' : 'info']('Uber OAuth: fin de la activación', {
      tiendas: tiendas.length,
      activadas,
      fallidas,
      bloqueadas,
    })

    const titulo = activadas > 0 && fallidas === 0 ? 'Avoqado quedó conectado' : 'Activación incompleta'
    res
      .status(huboProblema ? 207 : 200)
      .send(page(titulo, `<ul>${filas.join('')}</ul><p>Activadas: ${activadas} · fallidas: ${fallidas} · bloqueadas: ${bloqueadas}</p>`))
  } catch (err) {
    logger.error('Falló el callback de OAuth de Uber', { error: (err as Error).message })
    res.status(500).send(page('Falló la activación', `<p class="bad">${(err as Error).message}</p>`))
  }
}
