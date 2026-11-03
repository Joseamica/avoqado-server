/**
 * El aviso del banco (webhook de AngelPay) de UNA cuenta: darlo de alta donde no hay nada.
 *
 * D11, versión mínima (ruling del 2-nov): sólo actúa en cuentas SIN secreto. Una cuenta con `angelpayWebhookSecret`, con o sin
 * endpoint, ya tiene canal: se contesta como tal, con cero llamadas. Por eso nunca se pierde un secreto con el que todavía se verifica
 * dinero (R1 de `review-D5-D11-preflight-conjunto.md`), y por eso no hace falta historial de secretos ni tabla nueva.
 * ponytail: una cuenta con secreto viejo y canal muerto no se repara aquí: sigue pidiendo soporte manual.
 *
 * Es el único escritor de `angelpayWebhookSecret` y `angelpayWebhookEndpointId`; lo usan el alta y el botón del SUPERADMIN.
 *
 * - **Registrar no prueba que los avisos lleguen.** `angelpayWebhookLastReceivedAt` lo escribe sólo quien recibe; aquí no se toca.
 * - **Sin candado:** el POST a AngelPay no puede ir dentro de una transacción. Lo que protege es que la escritura final sea condicional
 *   a que la cuenta siga sin secreto: dos entradas a la vez pueden dejar un endpoint de más en AngelPay, cuyos avisos no validan, pero
 *   el secreto guardado no se pisa. Herramienta interna de soporte que casi no se usa: no se diseña para evitar ese endpoint de más.
 * - **Resultado incierto:** si AngelPay no contestó, no se guarda nada y se dice que no se sabe. Reintentar crea otro; nunca se borra.
 *
 * 🚨 Nunca a un log ni a un mensaje: la llave, el token, el secreto, ni lo que conteste AngelPay o Prisma (pueden repetir lo enviado).
 */
import logger from '../../config/logger'
import { BASE_URL } from '../../config/env'
import AppError, { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import {
  angelPayIntegrationsApiClient,
  AngelPayIntegrationsApiError,
  type AngelPayEnvironment,
} from '../integrations/angelpay-integrations-api.client'

// BASE_URL is `.optional()` in env.ts (unset in local dev). Same fallback pattern as `cfdi.public.controller.ts` — never build the
// AngelPay webhook URL against a literal "undefined/api/v1/...".
const PUBLIC_BASE_URL = BASE_URL || 'https://api.avoqado.io'

// Registered on every AngelPay webhook — see angelpay-integrations-api.client.ts header.
const ANGELPAY_WEBHOOK_EVENTS = ['send_transaction', 'offline_event', 'canceled_transaction']

const NOMBRE_DE_AMBIENTE: Record<AngelPayEnvironment, string> = { PROD: 'Producción', QA: 'QA' }

export interface RegistroDeAvisoInput {
  merchantAccountId: string
  /** Se usa sólo durante esta llamada: ni se guarda ni se devuelve. */
  apiKey?: string
  environment?: AngelPayEnvironment
  actor?: { staffId?: string | null; ipAddress?: string; userAgent?: string }
}

/** La llave sólo se manda a validar: si esto falla, en AngelPay no se creó nada. */
function falloAlValidarLaLlave(error: unknown, ambiente: AngelPayEnvironment): AppError {
  const status = error instanceof AngelPayIntegrationsApiError ? error.status : undefined
  if (status === 401 || status === 422) {
    return new ValidationError(`AngelPay rechazó la llave: es inválida o no es de ${NOMBRE_DE_AMBIENTE[ambiente]}. No se registró nada.`)
  }
  logger.warn('[AngelPay] No se pudo validar la llave para registrar el aviso', { status })
  return new ServiceUnavailableError('No se pudo validar la llave con AngelPay. No se registró nada: reintenta en un momento.')
}

/** Un 4xx es un rechazo: no se creó. Todo lo demás (sin respuesta, 5xx, respuesta sin secreto) puede haberlo creado. */
function falloAlCrear(error: unknown, merchantAccountId: string): AppError {
  const status = error instanceof AngelPayIntegrationsApiError ? error.status : undefined
  logger.warn('[AngelPay] No se pudo dar de alta el aviso del banco', { merchantAccountId, status })
  if (status !== undefined && status >= 400 && status < 500) {
    return new AppError(
      `AngelPay rechazó el alta del aviso (${status}). No quedó registrado; si esta cuenta ya tiene uno en AngelPay, hay que revisarlo con ellos.`,
      502,
      true,
      'ANGELPAY_WEBHOOK_RECHAZADO',
    )
  }
  return new ServiceUnavailableError(
    'No sabemos si AngelPay creó el aviso: no contestó lo esperado. Aquí no se guardó nada y la cuenta sigue sin registrar. Puedes reintentar.',
    'ANGELPAY_WEBHOOK_RESULTADO_INCIERTO',
  )
}

export async function registrarAvisoAngelPay(input: RegistroDeAvisoInput): Promise<{ alreadyRegistered: boolean }> {
  const { merchantAccountId, apiKey, actor } = input

  const cuenta = await prisma.merchantAccount.findUnique({
    where: { id: merchantAccountId },
    select: {
      externalMerchantId: true,
      angelpayUserAccountId: true,
      displayName: true,
      active: true,
      angelpayWebhookSecret: true,
      angelpayWebhookEndpointId: true,
      provider: { select: { code: true } },
      angelpayUserAccount: { select: { environment: true, venueId: true } },
    },
  })
  if (!cuenta) throw new NotFoundError('Cuenta de comercio no encontrada')
  if (cuenta.provider.code !== 'ANGELPAY') throw new ValidationError('Esta cuenta no es de AngelPay')
  if (cuenta.angelpayWebhookSecret) return { alreadyRegistered: true }
  if (!cuenta.active) throw new ValidationError('La cuenta está inactiva: actívala antes de registrar su aviso del banco.')
  if (!apiKey)
    throw new ValidationError('Falta la llave de API de AngelPay de esta cuenta: sin ella no se puede registrar su aviso del banco.')

  const guardado = cuenta.angelpayUserAccount?.environment
  const ambienteGuardado = guardado === 'QA' || guardado === 'PROD' ? guardado : null
  if (ambienteGuardado && input.environment && input.environment !== ambienteGuardado) {
    throw new ValidationError(
      `Esta cuenta es de ${NOMBRE_DE_AMBIENTE[ambienteGuardado]}: no se puede registrar en ${NOMBRE_DE_AMBIENTE[input.environment]}.`,
    )
  }
  const ambiente = ambienteGuardado ?? input.environment
  if (!ambiente) throw new ValidationError('Esta cuenta no tiene ambiente guardado: elige QA o Producción.')

  let autenticado: { accessToken: string; merchantId: string }
  try {
    autenticado = await angelPayIntegrationsApiClient.auth(apiKey, ambiente)
  } catch (error) {
    throw falloAlValidarLaLlave(error, ambiente)
  }
  if (autenticado.merchantId !== cuenta.externalMerchantId) {
    throw new ValidationError(
      `Esta llave es del comercio ${autenticado.merchantId} y esta cuenta es del comercio ${cuenta.externalMerchantId}. No se registró nada.`,
    )
  }

  let creado: { endpointId: string; secret: string }
  try {
    creado = await angelPayIntegrationsApiClient.registerWebhook(autenticado.accessToken, ambiente, {
      url: `${PUBLIC_BASE_URL}/api/v1/webhooks/angelpay/${merchantAccountId}`,
      events: ANGELPAY_WEBHOOK_EVENTS,
      description: `Avoqado ${cuenta.displayName ?? ''}`.trim(),
    })
  } catch (error) {
    throw falloAlCrear(error, merchantAccountId)
  }

  let guardadas: number
  try {
    const { count } = await prisma.merchantAccount.updateMany({
      // Si la identidad cambió mientras se llamaba a AngelPay, este secreto ya no es de esta cuenta.
      where: {
        id: merchantAccountId,
        angelpayWebhookSecret: null,
        externalMerchantId: cuenta.externalMerchantId,
        angelpayUserAccountId: cuenta.angelpayUserAccountId,
      },
      data: { angelpayWebhookSecret: creado.secret, angelpayWebhookEndpointId: creado.endpointId },
    })
    guardadas = count
  } catch {
    // Sin el error: su texto puede traer los valores de la consulta, y ahí va el secreto.
    logger.error('🚨 [AngelPay] Se creó el aviso del banco y NO se pudo guardar: su secreto se perdió y la cuenta sigue sin aviso', {
      merchantAccountId,
      endpointId: creado.endpointId,
    })
    throw new ServiceUnavailableError(
      'AngelPay creó el aviso, pero aquí no se pudo guardar: la cuenta sigue sin registrar. Puedes reintentar.',
      'ANGELPAY_WEBHOOK_NO_GUARDADO',
    )
  }

  if (guardadas === 0) {
    const actual = await prisma.merchantAccount.findUnique({ where: { id: merchantAccountId }, select: { angelpayWebhookSecret: true } })
    if (actual?.angelpayWebhookSecret) {
      logger.warn('[AngelPay] Otra entrada registró primero el aviso de esta cuenta: este endpoint queda de más y sus avisos no validan', {
        merchantAccountId,
        endpointId: creado.endpointId,
      })
      return { alreadyRegistered: true }
    }
    throw new ConflictError('La cuenta cambió mientras se registraba su aviso del banco. No se guardó nada: recarga y reintenta.')
  }

  await logAction({
    staffId: actor?.staffId ?? null,
    venueId: cuenta.angelpayUserAccount?.venueId ?? null,
    action: 'MERCHANT_ACCOUNT_ANGELPAY_WEBHOOK_REGISTERED',
    entity: 'MerchantAccount',
    entityId: merchantAccountId,
    data: {
      environment: ambiente,
      externalMerchantId: cuenta.externalMerchantId,
      endpointId: creado.endpointId,
      ...(cuenta.angelpayWebhookEndpointId ? { endpointIdAnterior: cuenta.angelpayWebhookEndpointId } : {}),
    },
    ipAddress: actor?.ipAddress,
    userAgent: actor?.userAgent,
  })
  return { alreadyRegistered: false }
}
