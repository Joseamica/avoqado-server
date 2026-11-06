import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { assertHybridOnboardingPurchase } from '../launchCampaigns/hybridPurchase.service'
import { PLAN_ACTIVATION_STATUS } from '../launchCampaigns/launchCampaignEnums'
import * as onboardingProgressService from './onboardingProgress.service'
import * as venueCreationService from './venueCreation.service'
import { ALTA_DEL_ASISTENTE, altaSinTerminar } from '../mobile/altaSinTerminar'

/**
 * 🔴 H0 (28-oct-2026): el alta cuyo plan ya quedó CONFIRMADO (cobrado o en prueba) se termina sola, sin esperar a que el
 * navegador toque «Entrar a Avoqado». Medido en prod: quien pagaba y cerraba la página quedaba con el negocio en
 * ONBOARDING y el POS le contestaba «Termina de crear tu cuenta» (`mobile/altaSinTerminar.ts`).
 * Promesa y mapa de entradas: Avoqado/docs/audit/2026-10-28-alta-pagada-se-termina-sola/promesa.md.
 *
 * Hace lo mismo que `completeV2Onboarding` con el plan ya cobrado, pero TODO-O-NADA (Codex r1 #1): el progreso, el
 * negocio y la organización se escriben en una sola transacción, bajo el mismo candado de organización que el botón.
 * Antes, una caída entre «marcar el progreso» y «activar el negocio» dejaba un alta a medias que nadie volvía a mirar.
 *
 * Nunca cobra, nunca toca Stripe ni manda correos: el cobro (`activatePlan`) ya mandó los suyos.
 */
export type ViaDelCierre = 'cobro' | 'navegador' | 'aviso-stripe' | 'barrido' | 'plan-regalado'

/**
 * Con un plan REGALADO por el SUPERADMIN (D1, 5-nov-2026) el plan ya está confirmado sin Stripe: cuenta el alta que no
 * llegó a cobrar (NONE), la que rechazó la tarjeta (DECLINED) o la ya cobrada. Nunca con un cobro del alta EN CURSO.
 */
const ESTADOS_DEL_REGALO = [PLAN_ACTIVATION_STATUS.NONE, PLAN_ACTIVATION_STATUS.DECLINED, PLAN_ACTIVATION_STATUS.ACTIVE]
/** Documentos en revisión: ese negocio lo activa el SUPERADMIN al revisarlos, no un regalo. */
const KYC_EN_REVISION = ['PENDING_REVIEW', 'IN_REVIEW'] as const

type NegocioDelAlta = { id: string; slug: string; name: string; status: string }

export type ResultadoDelCierre =
  | { estado: 'TERMINADA' | 'YA_TERMINADA'; venue: NegocioDelAlta }
  | { estado: 'NADA'; motivo: 'PLAN_NO_CONFIRMADO' | 'SIN_TERMINOS' | 'SIN_NEGOCIO' | 'CIERRE_EN_CURSO' }

export interface OpcionesDelCierre {
  via: ViaDelCierre
  /** Quien lo dispara (la dueña en el navegador o en el cobro). El barrido y el aviso no tienen persona. */
  staffId?: string
  /** Idioma del panel al tocar «Entrar»; los demás caminos no lo conocen y no lo tocan. */
  language?: 'es' | 'en'
  /**
   * Sólo el barrido: un cierre viejo a medias (progreso marcado, organización o negocio sin terminar) se completa. El
   * cobro y el navegador NO lo hacen: esa marca también es el candado de un «Entrar» que puede seguir en curso.
   */
  repararParcial?: boolean
  /** Sólo `plan-regalado`: el negocio al que se le regaló el plan. Si el alta de la organización es de otro, no se cierra. */
  venueId?: string
}

async function leerAlta(organizationId: string) {
  const datos = await onboardingProgressService.getV2SetupDataForCompletion(organizationId)
  const [organizacion, venue] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId }, select: { onboardingCompletedAt: true } }),
    prisma.venue.findFirst({
      where: { organizationId },
      select: { id: true, slug: true, name: true, status: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])
  const p = datos.progress as {
    id: string
    completedAt: Date | null
    termsAcceptedAt: Date | null
    planActivationStatus: string | null
    v2SetupData: unknown
  }
  const terminada = !!p.completedAt && !!organizacion?.onboardingCompletedAt && !!venue && venue.status !== 'ONBOARDING'
  return { datos, p, venue, terminada }
}

export async function terminarAltaCobrada(organizationId: string, opciones: OpcionesDelCierre): Promise<ResultadoDelCierre> {
  const { datos, p, venue, terminada } = await leerAlta(organizationId)

  const regalo = opciones.via === 'plan-regalado'
  const confirmado = regalo
    ? (ESTADOS_DEL_REGALO as readonly string[]).includes(String(p.planActivationStatus))
    : p.planActivationStatus === PLAN_ACTIVATION_STATUS.ACTIVE
  if (!confirmado) return { estado: 'NADA', motivo: 'PLAN_NO_CONFIRMADO' }
  if (!p.termsAcceptedAt) return { estado: 'NADA', motivo: 'SIN_TERMINOS' }
  if (!venue || (regalo && venue.id !== opciones.venueId)) return { estado: 'NADA', motivo: 'SIN_NEGOCIO' }
  if (terminada) return { estado: 'YA_TERMINADA', venue }
  const parcial = !!p.completedAt
  if (parcial && !opciones.repararParcial) return { estado: 'NADA', motivo: 'CIERRE_EN_CURSO' }

  // Lo que la persona escribió en el asistente, antes de activar (como `completeV2Onboarding`). Idempotente y nunca bloquea:
  // el negocio ya existe.
  // 🔴 Con un plan regalado NO (Codex D1 r1 #2): esa escritura va fuera de la transacción, así que un cierre fallido dejaría
  // el negocio cambiado, y pisaría lo que el SUPERADMIN ya corrigió en el panel. El negocio ya nació con esos datos.
  if (!regalo) {
    const businessInfo = { ...datos.businessInfo, name: datos.businessInfo?.name?.trim() || 'Mi Negocio' }
    await venueCreationService.applyBusinessInfoToVenue(venue.id, businessInfo, opciones.staffId).catch(error => {
      logger.error('terminarAltaCobrada: no se pudieron aplicar los datos del negocio', { organizationId, venueId: venue.id, error })
    })
  }

  const datosDelNegocio: Record<string, string> = {}
  if (datos.identityInfo?.rfc) datosDelNegocio.rfc = datos.identityInfo.rfc
  if (datos.entityInfo?.commercialName) datosDelNegocio.legalName = datos.entityInfo.commercialName
  else if (datos.identityInfo?.legalFirstName && datos.identityInfo?.legalLastName) {
    datosDelNegocio.legalName = `${datos.identityInfo.legalFirstName} ${datos.identityInfo.legalLastName}`
  }
  if (opciones.language) datosDelNegocio.language = opciones.language

  const plan = onboardingProgressService.parseV2Plan(p.v2SetupData)
  const ahora = new Date()
  const cerrada = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    // Con un regalo, la compra del alta que eligió y no pagó no cuenta (el plan es el regalado); una compra PENDIENTE sí frena.
    await assertHybridOnboardingPurchase(organizationId, regalo ? undefined : plan?.hybridPurchaseId, tx)
    const marca = await tx.onboardingProgress.updateMany({
      where: parcial
        ? { organizationId, completedAt: { not: null }, planActivationStatus: PLAN_ACTIVATION_STATUS.ACTIVE }
        : {
            organizationId,
            completedAt: null,
            planActivationStatus: regalo ? { in: [...ESTADOS_DEL_REGALO] } : PLAN_ACTIVATION_STATUS.ACTIVE,
          },
      data: parcial ? { currentStep: 7 } : { completedAt: ahora, currentStep: 7 },
    })
    if (marca.count === 0) return false
    // Sólo ONBOARDING → ACTIVE: un negocio suspendido o en revisión no se reactiva por terminar el alta.
    // 🔴 Con un regalo, también sin documentos en revisión EN ESTA MISMA ESCRITURA (Codex D1 r2): unos documentos enviados
    // entre la lectura y aquí lo dejarían activo. Si ya no se cumple, se deshace TODO el cierre (ninguna marca queda).
    const activado = await tx.venue.updateMany({
      where: { id: venue.id, status: 'ONBOARDING', ...(regalo ? { kycStatus: { notIn: [...KYC_EN_REVISION] } } : {}) },
      data: { status: 'ACTIVE' },
    })
    if (regalo && activado.count === 0) throw new Error('El negocio cambió (documentos en revisión o ya no está en el alta): no se cierra')
    if (Object.keys(datosDelNegocio).length > 0) await tx.venue.update({ where: { id: venue.id }, data: datosDelNegocio })
    await tx.organization.updateMany({ where: { id: organizationId, onboardingCompletedAt: null }, data: { onboardingCompletedAt: ahora } })
    return true
  })

  if (!cerrada) {
    // Otro cierre (el botón, el aviso o el barrido) ganó el candado: se contesta lo que dejó.
    const despues = await leerAlta(organizationId)
    return despues.terminada && despues.venue
      ? { estado: 'YA_TERMINADA', venue: despues.venue }
      : { estado: 'NADA', motivo: 'CIERRE_EN_CURSO' }
  }

  void logAction({
    staffId: opciones.staffId ?? null,
    organizationId,
    venueId: venue.id,
    action: 'ONBOARDING_COMPLETED',
    entity: 'OnboardingProgress',
    entityId: p.id,
    data: { via: opciones.via, reparado: parcial },
  })
  logger.info('✅ Alta terminada con el plan confirmado', { organizationId, venueId: venue.id, via: opciones.via, reparado: parcial })
  return { estado: 'TERMINADA', venue: { ...venue, status: venue.status === 'ONBOARDING' ? 'ACTIVE' : venue.status } }
}

/**
 * Para los caminos donde el dinero ya se movió (el cobro, el aviso de Stripe): un fallo al terminar el alta se registra
 * y NO cambia la respuesta. Lo retoma el barrido `altas-a-medio-pago`.
 */
export async function terminarAltaCobradaSinRomper(organizationId: string, opciones: OpcionesDelCierre): Promise<void> {
  try {
    await terminarAltaCobrada(organizationId, opciones)
  } catch (error) {
    logger.error('🚨 No se pudo terminar el alta con el plan confirmado — la retoma el barrido', {
      organizationId,
      via: opciones.via,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * 🔴 D1 (5-nov-2026): el SUPERADMIN regala el plan («Dar días de prueba», «Asignar plan comp», «Activar Pro») a quien se quedó
 * en la pantalla de la tarjeta. Antes el plan quedaba vivo y el negocio en ONBOARDING: el DASHBOARD lo regresaba a `/setup` y
 * el POS le decía «Termina de crear tu cuenta» (Taqueria El Patio, 5-nov). Ahora el alta se cierra como la del cobro.
 *
 * Sólo el alta VIGENTE sin terminar (`altaSinTerminar`) y sin documentos en revisión: un negocio que el SUPERADMIN tiene en
 * ONBOARDING mientras revisa su KYC no se activa por esto. Nunca lanza ni deshace el regalo: un fallo se registra y el negocio queda como estaba.
 */
export async function terminarAltaPorPlanRegalado(venueId: string, staffId?: string): Promise<boolean> {
  try {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { status: true, kycStatus: true, organizationId: true, organization: ALTA_DEL_ASISTENTE },
    })
    if (!venue || !altaSinTerminar(venue)) return false
    // 🔴 Con sus documentos en revisión lo activa el SUPERADMIN al revisar, no un regalo (Codex D1 r1 #1): un negocio dado de
    // alta por el SUPERADMIN cuyo dueño aceptó los términos en el asistente nuevo también cumple `altaSinTerminar`.
    if ((KYC_EN_REVISION as readonly string[]).includes(venue.kycStatus)) return false
    const r = await terminarAltaCobrada(venue.organizationId, { via: 'plan-regalado', staffId, venueId })
    if (r.estado === 'NADA') logger.warn('Plan regalado sobre un alta sin terminar que no se pudo cerrar', { venueId, motivo: r.motivo })
    return r.estado !== 'NADA'
  } catch (error) {
    logger.error('🚨 Plan regalado: no se pudo cerrar el alta; el negocio sigue en ONBOARDING', {
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
