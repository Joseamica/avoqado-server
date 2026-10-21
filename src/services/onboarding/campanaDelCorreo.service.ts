/**
 * La campaña con la que llegó una cuenta, para el correo de bienvenida:
 * - el texto de la oferta que reclamó (lo que va a pagar y por cuánto tiempo), y
 * - los parámetros que el enlace del correo debe conservar (la oferta y las UTM), para que
 *   la persona que vuelve días después desde su bandeja siga contando para el anuncio.
 */
import prisma from '@/utils/prismaClient'
import { UTM_KEYS } from '@/schemas/acquisition.schema'
import { buildLaunchOfferView } from '@/services/launchCampaigns/launchOfferMath'
import { LAUNCH_CAMPAIGN_SELECT, toOfferRow } from '@/services/launchCampaigns/launchCampaign.service'
import { getPrimaryOrganizationId } from '@/services/staffOrganization.service'

// Los montos de campaña viven en centavos (son campos de Stripe); aquí sólo se pintan.
const pesos = (centavos: number) => (centavos / 100).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })

/**
 * «Avoqado Pro a $10.00 al mes, IVA incluido, por 3 meses; después $1,158.84 al mes», o null si la
 * cuenta no reclamó campaña o la oferta ya no está disponible: nunca promete un precio que no se cobra.
 */
export async function ofertaReclamadaEnTexto(organizationId: string): Promise<string | null> {
  const progreso = await prisma.onboardingProgress.findUnique({
    where: { organizationId },
    select: { launchCampaign: { select: LAUNCH_CAMPAIGN_SELECT } },
  })
  const campana = progreso?.launchCampaign
  if (!campana) return null

  const vista = buildLaunchOfferView(toOfferRow(campana), new Date())
  if (!vista.available) return null

  const meses = vista.promo.months === 1 ? '1 mes' : `${vista.promo.months} meses`
  return `Avoqado ${vista.planName} a ${pesos(vista.promo.monthlyCents)} al mes, IVA incluido, por ${meses}; después ${pesos(vista.renewal.monthlyCents)} al mes`
}

/** Query string (sin «?») con `oferta=<slug>` y las UTM permitidas de la cuenta; '' si no hay nada. */
export async function parametrosDeCampanaDelStaff(staffId: string): Promise<string> {
  const organizationId = await getPrimaryOrganizationId(staffId)
  const progreso = await prisma.onboardingProgress.findUnique({
    where: { organizationId },
    select: { acquisitionUtm: true, launchCampaign: { select: { landingSlug: true } } },
  })

  const q = new URLSearchParams()
  const slug = progreso?.launchCampaign?.landingSlug
  if (slug) q.set('oferta', slug)

  const utm = progreso?.acquisitionUtm
  if (utm && typeof utm === 'object' && !Array.isArray(utm)) {
    for (const k of UTM_KEYS) {
      const v = (utm as Record<string, unknown>)[k]
      if (typeof v === 'string' && v.trim()) q.set(k, v.trim().slice(0, 200))
    }
  }
  return q.toString()
}
