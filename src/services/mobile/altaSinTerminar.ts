import type { VenueStatus } from '@prisma/client'

/**
 * Negocio a medio alta del asistente `/setup` (D7, 26-oct-2026): nace en ONBOARDING en el paso «tipo de negocio», ANTES
 * del plan y la tarjeta. El DASHBOARD regresa a su dueño a `/setup`; las apps del POS tampoco lo dejan entrar (login,
 * passkey, renovación y cambio de usuario por PIN), o con descargar Avoqado POS se saltaba el plan.
 *
 * 🔴 ONBOARDING solo no basta: el SUPERADMIN da de alta negocios en ONBOARDING mientras revisa su KYC y ésos sí entran,
 * aunque su dueño haya abierto el asistente viejo (`/onboarding` crea un progreso de la versión 1). Lo que marca el alta
 * sin terminar es el progreso del asistente VIGENTE (`wizardVersion = 2`) con `completedAt = null`. Sin esa fila, o sin
 * `organization` en la consulta, no se frena a nadie. Medido en prod el 26-oct: los 18 negocios así son el único negocio
 * de su organización.
 */
export type VenueConAlta = {
  status: VenueStatus
  organization?: { onboardingProgress: { completedAt: Date | null; wizardVersion: number } | null } | null
}

/** Lo que la regla lee: va en el `select` del venue de cada consulta que decide si alguien entra a la app. */
export const ALTA_DEL_ASISTENTE = {
  select: { onboardingProgress: { select: { completedAt: true, wizardVersion: true } } },
} as const

export const ALTA_SIN_TERMINAR = 'Termina de crear tu cuenta en dashboard.avoqado.io para empezar a usar Avoqado.'

export function altaSinTerminar(venue: VenueConAlta): boolean {
  const progreso = venue.organization?.onboardingProgress
  return venue.status === 'ONBOARDING' && !!progreso && progreso.wizardVersion === 2 && progreso.completedAt === null
}
