/**
 * Avisa al equipo (correo interno + HubSpot) de un registro DIRECTO en el dashboard.
 *
 * Los que llenan el formulario de la landing ya avisan («Nuevo prospecto» y HubSpot desde
 * `landing.public.controller`). Los directos —correo y contraseña, o Google— no avisaban nada hasta
 * crear el negocio, y quien se iba antes de escribir el nombre nunca existió para ventas (27-oct).
 *
 * Nunca lanza: corre después de que la cuenta ya quedó creada y verificada, y un correo o HubSpot
 * caídos no pueden tumbar el registro.
 */
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import * as resendService from '@/services/resend.service'
import { sendLeadToHubspot } from '@/services/integrations/hubspot.client'
import { getPrimaryOrganizationId } from '@/services/staffOrganization.service'
import { referenteLegible, utmLegible } from './atribucionLegible'

export async function avisarRegistroDirecto(staffId: string, metodo: 'correo' | 'google'): Promise<void> {
  try {
    const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { email: true, firstName: true, lastName: true } })
    if (!staff) return
    const orgId = await getPrimaryOrganizationId(staffId).catch(() => null)
    const progreso = orgId
      ? await prisma.onboardingProgress.findUnique({
          where: { organizationId: orgId },
          select: { acquisitionSource: true, acquisitionUtm: true, launchCampaign: { select: { code: true } } },
        })
      : null
    // Una cuenta de la landing también puede canjear su código por /onboarding/verify-email: ya avisó al crearse
    // («Nuevo prospecto» y HubSpot), así que aquí no se vuelve a anunciar como directa (Codex r1, 27-oct).
    if (progreso?.acquisitionSource?.startsWith('landing')) return
    const nombre = `${staff.firstName ?? ''} ${staff.lastName ?? ''}`.trim()

    await Promise.all([
      resendService.sendDirectSignupNotice({
        email: staff.email,
        nombre,
        metodo,
        origen: progreso?.acquisitionSource ?? null,
        campanaUtm: utmLegible(progreso?.acquisitionUtm),
        ofertaCodigo: progreso?.launchCampaign?.code ?? null,
        llegoDesde: referenteLegible(progreso?.acquisitionUtm),
      }),
      // Vacíos a propósito: `sendLeadToHubspot` quita los campos vacíos antes de mandarlos (el directo
      // no pide teléfono ni negocio). Si el formulario de HubSpot los exige, HubSpot lo rechaza y sólo
      // queda el correo interno: el registro nunca se pierde.
      sendLeadToHubspot({
        email: staff.email,
        firstName: staff.firstName ?? '',
        lastName: staff.lastName ?? '',
        phone: '',
        companyName: '',
        pageName: 'Registro directo (dashboard)',
        pageUri: 'https://dashboard.avoqado.io/signup',
      }),
    ])
  } catch (error) {
    logger.warn('avisarRegistroDirecto: no se pudo avisar al equipo', {
      staffId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
