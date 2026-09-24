/**
 * Webhook de Facturapi — la vía PRINCIPAL para enterarnos de que el SAT resolvió una cancelación.
 *
 * Antes sólo existía el barrido del job `cfdi-reconcile`, que le preguntaba al PAC cada 5 minutos por cada
 * cancelación en trámite. Ahora Facturapi nos avisa, y el barrido se queda como red de seguridad (1×hora):
 * Facturapi no documenta cuántas veces reintenta un aviso que no pudimos recibir.
 *
 * Dos piezas:
 *  - `asegurarWebhookDelEmisor`: da de alta el webhook de UNA organización (cada emisor/RFC es una org de
 *    Facturapi con su propia llave). Idempotente.
 *  - `procesarAvisoDeFacturapi`: valida la firma y, en vez de creerle al cuerpo, le vuelve a preguntar al PAC
 *    por esa factura (la misma función que usa el barrido). Un aviso falsificado o viejo no puede escribir nada.
 *
 * Medido en el sandbox de Facturapi el 24-sep-2026 (no está en su documentación):
 *  - el SECRETO sólo viene en la respuesta de crear; `list`/`retrieve` no lo devuelven;
 *  - crear dos veces el mismo webhook DUPLICA (la doc dice que devuelve el existente).
 */
import { createHmac, timingSafeEqual } from 'crypto'

import { env } from '@/config/env'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { refreshPendingCancellation, sincronizarCancelacionExterna } from './cfdi.service'
import { resolveFacturapiKey } from './fiscalProvider.factory'
import { decryptProviderKey, encryptProviderKey } from './fiscalKey.service'
import { clienteDeWebhooksDeFacturapi, type ClienteDeWebhooks } from './providers/facturapiWebhooks'

/** Lo que nos interesa: cancelaciones (las que pedimos) y cambios de estado (las canceladas por fuera). */
export const EVENTOS_DEL_WEBHOOK = ['invoice.cancellation_status_updated', 'invoice.status_updated'] as const

/** La URL pública del webhook de un emisor. `null` sin `BASE_URL` https: Facturapi no puede llamar a localhost. */
export function urlDelWebhook(emisorId: string, baseUrl: string | undefined): string | null {
  if (!baseUrl || !/^https:\/\//i.test(baseUrl)) return null
  return `${baseUrl.replace(/\/+$/, '')}/api/v1/webhooks/facturapi/${encodeURIComponent(emisorId)}`
}

/**
 * La BASE_URL sólo cuenta en production/staging. En desarrollo no hay URL pública, y un `BASE_URL` copiado de
 * producción haría que un server LOCAL creara webhooks con la URL de producción y borrara el bueno como
 * «duplicado» (misma URL). Con `undefined` el alta termina en SIN_URL_PUBLICA sin tocar Facturapi.
 */
export function urlPublicaDelEntorno(nodeEnv: string | undefined, baseUrl: string | undefined): string | undefined {
  // Producción cae a la API pública, como el resto del server (BASE_URL no está en render.yaml). Staging no:
  // sin su propia BASE_URL sus webhooks apuntarían a producción.
  if (nodeEnv === 'production') return baseUrl || 'https://api.avoqado.io'
  return nodeEnv === 'staging' ? baseUrl : undefined
}

// ─── Alta del webhook ─────────────────────────────────────────────────────────

export interface EmisorParaWebhook {
  id: string
  provider: string
  providerKeyEnc: string | null
  webhookId: string | null
  webhookSecretEnc: string | null
  webhookUrl: string | null
}

export interface AsegurarWebhookDeps {
  findEmisor: (emisorId: string) => Promise<EmisorParaWebhook | null>
  /** Cliente con la llave con la que timbra ESTE emisor, o `null` si no hay llave. */
  clienteDeWebhooks: (emisor: EmisorParaWebhook) => ClienteDeWebhooks | null
  guardarWebhook: (
    emisorId: string,
    data: { webhookId: string; webhookSecretEnc: string; webhookUrl: string; webhookConfiguredAt: Date },
  ) => Promise<void>
  encrypt: (plaintext: string) => string
  baseUrl: () => string | undefined
  now: () => Date
}

export type ResultadoAlta = 'CREADO' | 'YA_ESTABA' | 'SIN_URL_PUBLICA' | 'SIN_LLAVE' | 'NO_ES_FACTURAPI'

export async function asegurarWebhookDelEmisor(
  emisorId: string,
  deps: AsegurarWebhookDeps,
): Promise<{ resultado: ResultadoAlta; webhookId?: string }> {
  const emisor = await deps.findEmisor(emisorId)
  if (!emisor) throw new Error(`Emisor ${emisorId} not found`)
  if (emisor.provider !== 'FACTURAPI') return { resultado: 'NO_ES_FACTURAPI' }

  const url = urlDelWebhook(emisor.id, deps.baseUrl())
  if (!url) return { resultado: 'SIN_URL_PUBLICA' }

  const cliente = deps.clienteDeWebhooks(emisor)
  if (!cliente) return { resultado: 'SIN_LLAVE' }

  // Sólo los que apuntan a NUESTRA URL: la organización puede tener webhooks propios del negocio.
  const nuestros = (await cliente.listar()).filter(w => w.url === url)

  const vigente = nuestros.find(
    w =>
      w.id === emisor.webhookId &&
      w.status === 'enabled' &&
      EVENTOS_DEL_WEBHOOK.every(e => w.enabledEvents.includes(e) || w.enabledEvents.includes('*')),
  )
  if (vigente && emisor.webhookSecretEnc && emisor.webhookUrl === url) {
    await borrarSinTumbar(
      cliente,
      nuestros.filter(w => w.id !== vigente.id),
      emisorId,
    )
    return { resultado: 'YA_ESTABA', webhookId: vigente.id }
  }

  // Se crea y se GUARDA el nuevo antes de borrar los viejos: si algo falla en medio, nunca queda el emisor
  // sin un webhook válido guardado mientras en Facturapi sí existe uno (o al revés).
  const creado = await cliente.crear(url, EVENTOS_DEL_WEBHOOK)
  if (!creado.secret) {
    // Sin secreto no se puede validar ningún aviso, y Facturapi no lo vuelve a entregar: no sirve.
    await borrarSinTumbar(cliente, [{ id: creado.id }], emisorId)
    throw new Error(`Facturapi no devolvió el secreto del webhook del emisor ${emisorId}`)
  }
  await deps.guardarWebhook(emisor.id, {
    webhookId: creado.id,
    webhookSecretEnc: deps.encrypt(creado.secret),
    webhookUrl: url,
    webhookConfiguredAt: deps.now(),
  })
  await borrarSinTumbar(
    cliente,
    nuestros.filter(w => w.id !== creado.id),
    emisorId,
  )
  logger.info(`[facturapi-webhook] webhook dado de alta para el emisor ${emisorId}`, { webhookId: creado.id })
  return { resultado: 'CREADO', webhookId: creado.id }
}

/** Un duplicado que no se deja borrar sólo genera avisos de más (con firma que ya no validamos): no tumba nada. */
async function borrarSinTumbar(cliente: ClienteDeWebhooks, webhooks: { id: string }[], emisorId: string): Promise<void> {
  for (const w of webhooks) {
    try {
      await cliente.borrar(w.id)
    } catch (err: unknown) {
      logger.warn(
        `[facturapi-webhook] no se pudo borrar el webhook ${w.id} del emisor ${emisorId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

export interface AsegurarFaltantesDeps {
  baseUrl: () => string | undefined
  /** Ids de emisores de Facturapi con llave y sin webhook guardado, acotados. */
  findSinWebhook: () => Promise<string[]>
  asegurar: (emisorId: string) => Promise<{ resultado: ResultadoAlta }>
}

/** Cuántos emisores sin webhook se atienden por pasada del job (cada uno son 2-3 llamadas a Facturapi). */
export const WEBHOOKS_FALTANTES_POR_PASADA = 10

/**
 * La pasada horaria del job da de alta el webhook a los emisores que no lo tienen: los que ya existían antes
 * de esta función (Testarudo) y aquellos cuyo alta falló al provisionar. Sin script manual en producción.
 */
export async function asegurarWebhooksFaltantes(
  deps: AsegurarFaltantesDeps,
): Promise<{ revisados: number; creados: number; errores: number }> {
  const tally = { revisados: 0, creados: 0, errores: 0 }
  if (!deps.baseUrl()) return tally
  for (const emisorId of await deps.findSinWebhook()) {
    tally.revisados += 1
    try {
      const r = await deps.asegurar(emisorId)
      if (r.resultado === 'CREADO') tally.creados += 1
    } catch (err: unknown) {
      tally.errores += 1
      logger.warn(
        `[facturapi-webhook] no se pudo dar de alta el webhook del emisor ${emisorId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return tally
}

// ─── Recepción de avisos ──────────────────────────────────────────────────────

export interface ProcesarAvisoDeps {
  findEmisor: (emisorId: string) => Promise<{ id: string; providerOrgId: string | null; webhookSecretEnc: string | null } | null>
  decrypt: (enc: string) => string
  /** La factura con ese id de Facturapi, SÓLO si es de este emisor. */
  findCfdi: (facturapiId: string, emisorId: string) => Promise<any | null>
  /** La misma consulta al PAC que usa el barrido para una cancelación que NOSOTROS pedimos. */
  refreshPending: (cfdi: any) => Promise<any>
  /** Para una factura timbrada que alguien canceló por fuera (portal de Facturapi). */
  sincronizarCancelacionExterna: (cfdi: any) => Promise<any>
}

export type ResultadoAviso =
  | 'REVISADA'
  | 'SIN_CAMBIO'
  | 'SIN_FACTURA'
  | 'IGNORADO'
  | 'ORG_DISTINTA'
  | 'SIN_ID'
  | 'FIRMA_INVALIDA'
  | 'SIN_SECRETO'
  | 'EMISOR_DESCONOCIDO'
  | 'JSON_INVALIDO'

/** Firma de Facturapi: hex(HMAC-SHA256(secreto, cuerpo crudo)), en el header `Facturapi-Signature`. */
export function firmaValida(secreto: string, cuerpo: Buffer, firma: string | undefined): boolean {
  if (!firma || !/^[0-9a-f]+$/i.test(firma) || firma.length % 2 !== 0) return false
  const esperada = createHmac('sha256', secreto).update(cuerpo).digest()
  const recibida = Buffer.from(firma, 'hex')
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida)
}

/**
 * Procesa un aviso. Devuelve el status HTTP a responder. Si consultar al PAC falla, el error SUBE para que el
 * controlador responda 5xx y Facturapi reintente (y el barrido horario lo recoge de todos modos).
 */
export async function procesarAvisoDeFacturapi(
  params: { emisorId: string; cuerpo: Buffer; firma: string | undefined },
  deps: ProcesarAvisoDeps,
): Promise<{ http: number; resultado: ResultadoAviso }> {
  const emisor = await deps.findEmisor(params.emisorId)
  if (!emisor) return { http: 404, resultado: 'EMISOR_DESCONOCIDO' }
  if (!emisor.webhookSecretEnc) return { http: 401, resultado: 'SIN_SECRETO' }
  if (!firmaValida(deps.decrypt(emisor.webhookSecretEnc), params.cuerpo, params.firma)) {
    return { http: 401, resultado: 'FIRMA_INVALIDA' }
  }

  let evento: any
  try {
    evento = JSON.parse(params.cuerpo.toString('utf8'))
  } catch {
    return { http: 400, resultado: 'JSON_INVALIDO' }
  }

  // Firma válida pero de otra organización: sólo pasaría con el secreto cruzado. No se toca nada.
  if (emisor.providerOrgId && evento?.organization && evento.organization !== emisor.providerOrgId) {
    logger.warn(`[facturapi-webhook] aviso de la organización ${evento.organization} en el webhook del emisor ${emisor.id}`)
    return { http: 200, resultado: 'ORG_DISTINTA' }
  }
  if (!EVENTOS_DEL_WEBHOOK.includes(evento?.type)) return { http: 200, resultado: 'IGNORADO' }

  const facturapiId = evento?.data?.object?.id
  if (typeof facturapiId !== 'string' || facturapiId.length === 0) return { http: 200, resultado: 'SIN_ID' }

  const cfdi = await deps.findCfdi(facturapiId, emisor.id)
  if (!cfdi) return { http: 200, resultado: 'SIN_FACTURA' }

  if (cfdi.cancelStatus === 'REQUESTED') {
    await deps.refreshPending(cfdi)
    return { http: 200, resultado: 'REVISADA' }
  }
  // Timbrada y sin cancelación en trámite (nunca pedida, o una anterior que el SAT rechazó): pudieron
  // cancelarla por fuera, p. ej. desde el portal de Facturapi.
  if (cfdi.status === 'STAMPED') {
    await deps.sincronizarCancelacionExterna(cfdi)
    return { http: 200, resultado: 'REVISADA' }
  }
  return { http: 200, resultado: 'SIN_CAMBIO' }
}

// ─── Dependencias reales ──────────────────────────────────────────────────────

const sandbox = () => env.NODE_ENV !== 'production'

const SELECT_EMISOR_WEBHOOK = {
  id: true,
  provider: true,
  providerKeyEnc: true,
  webhookId: true,
  webhookSecretEnc: true,
  webhookUrl: true,
} as const

export function defaultAsegurarWebhookDeps(): AsegurarWebhookDeps {
  return {
    findEmisor: id => prisma.fiscalEmisor.findUnique({ where: { id }, select: SELECT_EMISOR_WEBHOOK }),
    clienteDeWebhooks: emisor => {
      const key = resolveFacturapiKey(emisor as any, { sandbox: sandbox() })
      return key ? clienteDeWebhooksDeFacturapi(key) : null
    },
    guardarWebhook: async (emisorId, data) => {
      await prisma.fiscalEmisor.update({ where: { id: emisorId }, data })
    },
    encrypt: encryptProviderKey,
    baseUrl: () => urlPublicaDelEntorno(env.NODE_ENV, env.BASE_URL),
    now: () => new Date(),
  }
}

export function defaultProcesarAvisoDeps(): ProcesarAvisoDeps {
  return {
    findEmisor: id => prisma.fiscalEmisor.findUnique({ where: { id }, select: { id: true, providerOrgId: true, webhookSecretEnc: true } }),
    decrypt: decryptProviderKey,
    findCfdi: (facturapiId, emisorId) =>
      prisma.cfdi.findFirst({ where: { facturapiId, fiscalEmisorId: emisorId }, include: { fiscalEmisor: true } }),
    refreshPending: cfdi => refreshPendingCancellation(cfdi, { sandbox: sandbox() }),
    sincronizarCancelacionExterna: cfdi => sincronizarCancelacionExterna(cfdi, { sandbox: sandbox() }),
  }
}

export function defaultAsegurarFaltantesDeps(): AsegurarFaltantesDeps {
  const alta = defaultAsegurarWebhookDeps()
  return {
    baseUrl: alta.baseUrl,
    findSinWebhook: async () =>
      (
        await prisma.fiscalEmisor.findMany({
          where: { provider: 'FACTURAPI', providerKeyEnc: { not: null }, webhookId: null },
          orderBy: { createdAt: 'asc' },
          take: WEBHOOKS_FALTANTES_POR_PASADA,
          select: { id: true },
        })
      ).map(e => e.id),
    asegurar: emisorId => asegurarWebhookDelEmisor(emisorId, alta),
  }
}
