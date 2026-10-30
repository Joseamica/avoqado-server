import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { assertHybridOnboardingPurchase } from '../launchCampaigns/hybridPurchase.service'
import { PLAN_ACTIVATION_STATUS } from '../launchCampaigns/launchCampaignEnums'
import * as onboardingProgressService from './onboardingProgress.service'
import * as venueCreationService from './venueCreation.service'

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
export type ViaDelCierre = 'cobro' | 'navegador' | 'aviso-stripe' | 'barrido'

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

  if (p.planActivationStatus !== PLAN_ACTIVATION_STATUS.ACTIVE) return { estado: 'NADA', motivo: 'PLAN_NO_CONFIRMADO' }
  if (!p.termsAcceptedAt) return { estado: 'NADA', motivo: 'SIN_TERMINOS' }
  if (!venue) return { estado: 'NADA', motivo: 'SIN_NEGOCIO' }
  if (terminada) return { estado: 'YA_TERMINADA', venue }
  const parcial = !!p.completedAt
  if (parcial && !opciones.repararParcial) return { estado: 'NADA', motivo: 'CIERRE_EN_CURSO' }

  // Lo que la persona escribió en el asistente, antes de activar (como `completeV2Onboarding`). Idempotente y nunca bloquea:
  // el negocio ya existe.
  const businessInfo = { ...datos.businessInfo, name: datos.businessInfo?.name?.trim() || 'Mi Negocio' }
  await venueCreationService.applyBusinessInfoToVenue(venue.id, businessInfo, opciones.staffId).catch(error => {
    logger.error('terminarAltaCobrada: no se pudieron aplicar los datos del negocio', { organizationId, venueId: venue.id, error })
  })

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
    await assertHybridOnboardingPurchase(organizationId, plan?.hybridPurchaseId, tx)
    const marca = await tx.onboardingProgress.updateMany({
      where: parcial
        ? { organizationId, completedAt: { not: null }, planActivationStatus: PLAN_ACTIVATION_STATUS.ACTIVE }
        : { organizationId, completedAt: null, planActivationStatus: PLAN_ACTIVATION_STATUS.ACTIVE },
      data: parcial ? { currentStep: 7 } : { completedAt: ahora, currentStep: 7 },
    })
    if (marca.count === 0) return false
    // Sólo ONBOARDING → ACTIVE: un negocio suspendido o en revisión no se reactiva por terminar el alta.
    await tx.venue.updateMany({ where: { id: venue.id, status: 'ONBOARDING' }, data: { status: 'ACTIVE' } })
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
