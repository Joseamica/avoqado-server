/**
 * El ALTA de un negocio nuevo: organización + su dueño + el progreso del asistente, con la
 * atribución del anuncio y el consentimiento legal — en UNA transacción.
 *
 * 🔴 Existe como módulo aparte porque la hacen DOS puertas: el alta por correo
 * (`signup.service.ts → signupUser`) y el alta con Google (`googleOAuth.service.ts →
 * loginWithGoogle` con un sobre `signup`). Si cada una armara sus filas, se separarían —es
 * exactamente lo que pasó con la aceptación de invitaciones por Google (ver
 * `tests/unit/services/googleOAuth.invitationAccept.test.ts`)— y quien entrara por un anuncio con
 * Google se quedaría sin la oferta y sin atribución, pagando precio de lista.
 */
import type { Prisma } from '@prisma/client'
import { OrgRole } from '@prisma/client'
import { isAcceptedLegalVersion } from '../../config/legal'
import { findClaimableByCodeOrSlug } from '../launchCampaigns/launchCampaign.service'

export interface AtribucionDelAlta {
  legalVersion?: string
  launchCampaignCode?: string
  utm?: Record<string, string>
}

export interface AtribucionResuelta {
  campanaId: string | null
  utm: Record<string, string> | undefined
  /** La versión legal SÓLO si es una que existe; una desconocida se ignora (el asistente la re-pide). */
  legalVersion: string | undefined
}

/**
 * 🔴 Se resuelve FUERA de la transacción: es una lectura que no puede alargar el alta, y si
 * falla el alta sigue sin campaña — nunca al revés. La atribución vale mucho menos que la cuenta.
 */
export async function resolverAtribucionDelAlta(a: AtribucionDelAlta): Promise<AtribucionResuelta> {
  const campana = a.launchCampaignCode ? await findClaimableByCodeOrSlug(a.launchCampaignCode).catch(() => null) : null
  return {
    campanaId: campana?.id ?? null,
    utm: a.utm && Object.keys(a.utm).length > 0 ? a.utm : undefined,
    legalVersion: isAcceptedLegalVersion(a.legalVersion) ? a.legalVersion : undefined,
  }
}

export interface DatosNegocioNuevo {
  email: string
  /** Hash de bcrypt; `null` para quien entra sólo con Google. */
  hashedPassword: string | null
  firstName: string
  lastName: string
  organizationName: string
  emailVerified: boolean
  photoUrl?: string | null
  googleId?: string | null
  wizardVersion?: number
  /** De qué pantalla salió el alta (`dashboard_signup`, `dashboard_signup_google`…). */
  acquisitionSource: string
  atribucion: AtribucionResuelta
  ipAddress?: string | null
}

export async function crearNegocioNuevo(tx: Prisma.TransactionClient, d: DatosNegocioNuevo) {
  const email = d.email.toLowerCase()
  const organization = await tx.organization.create({
    data: {
      name: d.organizationName || 'Nuevo Negocio',
      email, // el correo del dueño: es lo que el login usa para reconocerlo como dueño del alta
      phone: '', // se completa en el asistente
    },
  })

  const staff = await tx.staff.create({
    data: {
      email,
      ...(d.hashedPassword ? { password: d.hashedPassword } : {}),
      firstName: d.firstName,
      lastName: d.lastName,
      ...(d.photoUrl ? { photoUrl: d.photoUrl } : {}),
      ...(d.googleId ? { googleId: d.googleId } : {}),
      active: true,
      emailVerified: d.emailVerified,
      lastLoginAt: new Date(),
    },
  })

  await tx.staffOrganization.create({
    data: { staffId: staff.id, organizationId: organization.id, role: OrgRole.OWNER, isPrimary: true, isActive: true },
  })

  const { campanaId, utm, legalVersion } = d.atribucion
  await tx.onboardingProgress.create({
    data: {
      organizationId: organization.id,
      currentStep: 0,
      completedSteps: [],
      ...(d.wizardVersion ? { wizardVersion: d.wizardVersion } : {}),
      // Atribución y consentimiento, en la MISMA transacción que el alta (spec § 3.5).
      acquisitionSource: d.acquisitionSource,
      ...(utm ? { acquisitionUtm: utm } : {}),
      ...(campanaId ? { launchCampaignId: campanaId, launchCampaignClaimedAt: new Date() } : {}),
      ...(legalVersion
        ? {
            termsAcceptedAt: new Date(),
            privacyAcceptedAt: new Date(),
            termsVersion: legalVersion,
            termsIpAddress: d.ipAddress ?? null,
          }
        : {}),
    },
  })

  return { organization, staff }
}
