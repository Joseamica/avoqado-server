/**
 * S11 — las campañas ligeras de lanzamiento, desde el MCP (spec 2026-09-17 § 3.9).
 *
 * 🔴 SOLO SUPERADMIN, con defensa doble: `registerAllTools` ni siquiera las registra para un
 * cliente, y cada handler vuelve a comprobarlo. Son fichas de PLATAFORMA (deciden cuánto se le
 * cobra a un negocio), no datos de un local.
 *
 * 🔴 Las escrituras van por `requireWriteScopeAlways`: un token de sólo lectura que puede
 * cambiar una oferta que se cobra con tarjeta es un agujero, no un riesgo de despliegue.
 *
 * 🔴 La bitácora usa `logAction`, NO `auditMcpWrite`: aquél exige `venueId` y estas filas no
 * pertenecen a ningún local.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { text } from '../respond'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import {
  createLaunchCampaign,
  endLaunchCampaign,
  getLaunchCampaignDetail,
  listLaunchCampaigns,
  listRedemptions,
  pauseLaunchCampaign,
  toOfferRow,
} from '@/services/launchCampaigns/launchCampaign.service'
import prisma from '@/utils/prismaClient'
import { LAUNCH_CAMPAIGN_SELECT } from '@/services/launchCampaigns/launchCampaign.service'
import { activateLaunchCampaign, previewLaunchOffer } from '@/services/launchCampaigns/launchCampaignStripe.service'
import { launchOfferAvailability } from '@/services/launchCampaigns/launchOfferMath'
import { CAMPAIGN_CHANNEL_VALUES, CAMPAIGN_STATUS_VALUES, CAMPAIGN_VERTICAL_VALUES } from '@/services/launchCampaigns/launchCampaignEnums'

const SOLO_AVOQADO = 'Solo Avoqado puede ver o cambiar las ofertas de lanzamiento.'

/** Pesos con dos decimales, para que el texto que lee una persona no hable en centavos. */
const pesos = (cents: number) => `$${(cents / 100).toFixed(2)}`

export function registerLaunchCampaignTools(server: McpServer, scope: McpScope): void {
  server.tool(
    'list_launch_campaigns',
    'Ofertas de lanzamiento de Avoqado (la ficha que un anuncio promete: precio por mes, cuántos meses y cuántos lugares). ' +
      'Dice cuáles se pueden vender ahora y cuántos lugares se han tomado. Solo para Avoqado.',
    {
      status: z.enum(CAMPAIGN_STATUS_VALUES).optional().describe('Filtra por estado: borrador, activa, pausada o terminada'),
      limit: z.number().int().min(1).max(50).default(25).describe('Cuántas ofertas listar'),
    },
    async ({ status, limit }) => {
      if (!scope.isSuperAdmin) return text({ ok: false, error: SOLO_AVOQADO })
      const { data, meta } = await listLaunchCampaigns({ status, page: 1, pageSize: limit } as never)
      return text({
        ok: true,
        total: meta.total,
        campanas: data.map(c => ({
          codigo: c.code,
          nombre: c.name,
          direccion: `/oferta/${c.landingSlug}`,
          plan: c.planTier,
          precioMensual: pesos(c.advertisedPriceCents),
          meses: c.discountMonths,
          renovacion: c.listPriceCentsSnapshot ? pesos(c.listPriceCentsSnapshot) : null,
          cupo: `${c.redemptionCount} / ${c.redemptionCap}`,
          estado: c.status,
          sePuedeVender: c.availability.available,
          motivoSiNo: c.availability.available ? null : c.availability.reason,
          vigencia: { desde: c.validFrom.toISOString(), hasta: c.validUntil.toISOString() },
        })),
      })
    },
  )

  server.tool(
    'get_launch_campaign',
    'Una oferta de lanzamiento con sus números: cuántas cuentas la reclamaron, cuántos lugares están apartados, ' +
      'cuántos ya se cobraron y cuántos se liberaron. Incluye las últimas redenciones con el nombre del negocio ' +
      '(sin correos). Solo para Avoqado.',
    { code: z.string().describe('El código de la oferta, p. ej. POS22') },
    async ({ code }) => {
      if (!scope.isSuperAdmin) return text({ ok: false, error: SOLO_AVOQADO })
      const ficha = await prisma.launchCampaign.findUnique({ where: { code: code.trim().toUpperCase() }, select: { id: true } })
      if (!ficha) return text({ ok: false, error: `No existe una oferta con el código ${code}.` })

      const detalle = await getLaunchCampaignDetail(ficha.id)
      const { data: redenciones } = await listRedemptions(ficha.id, { page: 1, pageSize: 20 } as never)
      return text({
        ok: true,
        codigo: detalle.code,
        nombre: detalle.name,
        estado: detalle.status,
        sePuedeVender: detalle.availability.available,
        precioMensual: pesos(detalle.advertisedPriceCents),
        meses: detalle.discountMonths,
        metricas: {
          reclamaron: detalle.metrics.claimed,
          apartados: detalle.metrics.reserved,
          cobrados: detalle.metrics.applied,
          liberados: detalle.metrics.released,
          cupo: `${detalle.metrics.count} / ${detalle.metrics.cap}`,
          // Lo único que hace visible que un lugar apartado se quede consumiendo cupo.
          apartadosHaceMasDe30Min: detalle.metrics.staleReserved,
        },
        ultimasRedenciones: redenciones.map(r => ({
          negocio: r.organization.name,
          local: r.venue?.name ?? null,
          estado: r.status,
          precio: pesos(r.advertisedPriceCents),
          origen: r.acquisitionSource,
          campana: r.utmCampaign,
          apartado: r.reservedAt.toISOString(),
          cobrado: r.appliedAt?.toISOString() ?? null,
        })),
      })
    },
  )

  server.tool(
    'create_launch_campaign',
    'Crea una oferta de lanzamiento. Nace SIEMPRE como borrador: crear no la publica ni cobra nada — para eso ' +
      'está set_launch_campaign_status. Sin confirm devuelve una vista previa con los montos exactos. Solo para Avoqado.',
    {
      code: z.string().describe('Código que viaja en los formularios y los anuncios, p. ej. POS22'),
      name: z.string().describe('Nombre para el equipo, p. ej. "POS $22 septiembre"'),
      landingSlug: z.string().describe('Dirección de la página: /oferta/<esto>'),
      planTier: z.enum(['PRO', 'PREMIUM']).describe('Qué plan se ofrece'),
      advertisedPriceCents: z.number().int().describe('Precio mensual ANUNCIADO con IVA, en centavos (2200 = $22.00)'),
      discountMonths: z.number().int().min(1).max(24).describe('Cuántos meses dura el precio promocional'),
      redemptionCap: z.number().int().min(1).describe('Cuántos negocios pueden tomarla'),
      validFrom: z.string().describe('Desde cuándo (ISO)'),
      validUntil: z.string().describe('Hasta cuándo (ISO)'),
      vertical: z.enum(CAMPAIGN_VERTICAL_VALUES).optional().describe('Giro al que apunta el anuncio (solo etiqueta)'),
      channel: z.enum(CAMPAIGN_CHANNEL_VALUES).optional().describe('Dónde se anuncia'),
      headline: z.string().optional(),
      subheadline: z.string().optional(),
      confirm: z.boolean().optional().describe('true para crearla de verdad'),
    },
    async args => {
      if (!scope.isSuperAdmin) return text({ ok: false, error: SOLO_AVOQADO })
      requireWriteScopeAlways(scope, 'launch-campaigns:write', 'crea una oferta que se cobra con tarjeta')

      const preview = await previewLaunchOffer({
        planTier: args.planTier,
        advertisedPriceCents: args.advertisedPriceCents,
        discountMonths: args.discountMonths,
        code: args.code.trim().toUpperCase(),
      })

      if (!args.confirm) {
        return text({
          ok: true,
          requiresConfirmation: true,
          preview: {
            hoyPaga: pesos(preview.firstChargeCents),
            durante: `${args.discountMonths} meses`,
            totalDeLaPromocion: pesos(preview.promoTotalCents),
            despues: `${pesos(preview.renewalMonthlyCents)} al mes`,
            descuento: pesos(preview.discountAmountCents),
            cupon: preview.couponId,
            avisos: preview.problems,
          },
          mensaje: 'Vuelve a llamar con confirm: true para crear la oferta. Nacerá como BORRADOR, sin publicarse.',
        })
      }

      const creada = await createLaunchCampaign(
        {
          code: args.code.trim().toUpperCase(),
          name: args.name,
          landingSlug: args.landingSlug.trim().toLowerCase(),
          planTier: args.planTier,
          billingInterval: 'MONTHLY',
          advertisedPriceCents: args.advertisedPriceCents,
          discountMonths: args.discountMonths,
          redemptionCap: args.redemptionCap,
          validFrom: new Date(args.validFrom),
          validUntil: new Date(args.validUntil),
          vertical: args.vertical ?? 'ALL',
          channel: args.channel ?? null,
          headline: args.headline ?? null,
          subheadline: args.subheadline ?? null,
          bullets: [],
        } as never,
        scope.staffId,
      )
      return text({
        ok: true,
        codigo: creada.code,
        estado: creada.status,
        mensaje: 'Oferta creada como BORRADOR. Actívala cuando esté lista.',
      })
    },
  )

  server.tool(
    'set_launch_campaign_status',
    'Publica, pausa o termina una oferta de lanzamiento. Publicar es lo que crea el descuento y lo que hace que ' +
      'la página del anuncio muestre el precio; pausar lo apaga; terminar es definitivo. Sin confirm devuelve ' +
      'una vista previa de lo que va a pasar. Solo para Avoqado.',
    {
      code: z.string().describe('El código de la oferta'),
      action: z.enum(['activate', 'pause', 'end']).describe('Qué hacer con ella'),
      reason: z.string().optional().describe('Por qué (obligatorio al pausar y al terminar)'),
      confirm: z.boolean().optional().describe('true para aplicarlo de verdad'),
    },
    async ({ code, action, reason, confirm }) => {
      if (!scope.isSuperAdmin) return text({ ok: false, error: SOLO_AVOQADO })
      requireWriteScopeAlways(scope, 'launch-campaigns:write', 'cambia una oferta que se cobra con tarjeta')

      const ficha = await prisma.launchCampaign.findUnique({ where: { code: code.trim().toUpperCase() }, select: LAUNCH_CAMPAIGN_SELECT })
      if (!ficha) return text({ ok: false, error: `No existe una oferta con el código ${code}.` })
      if (action !== 'activate' && !reason) {
        return text({ ok: false, error: 'Hace falta el motivo para pausar o terminar una oferta.' })
      }

      if (!confirm) {
        const siguiente = action === 'activate' ? 'ACTIVE' : action === 'pause' ? 'PAUSED' : 'ENDED'
        let preview: Record<string, unknown> = {}
        if (action === 'activate') {
          const p = await previewLaunchOffer({
            planTier: ficha.planTier as 'PRO' | 'PREMIUM',
            advertisedPriceCents: ficha.advertisedPriceCents,
            discountMonths: ficha.discountMonths,
            code: ficha.code,
            offerVersion: ficha.offerVersion,
          })
          preview = {
            cupon: p.couponId,
            hoyPaga: pesos(p.firstChargeCents),
            despues: `${pesos(p.renewalMonthlyCents)} al mes`,
            avisos: p.problems,
          }
        }
        return text({
          ok: true,
          requiresConfirmation: true,
          actual: ficha.status,
          siguiente,
          cupoTomado: `${ficha.redemptionCount} / ${ficha.redemptionCap}`,
          ...preview,
          mensaje:
            action === 'end'
              ? 'Terminar es DEFINITIVO: para cambiar el precio se crea otra oferta. Vuelve a llamar con confirm: true.'
              : 'Vuelve a llamar con confirm: true para aplicarlo.',
        })
      }

      // Con `confirm` se llama al MISMO servicio que usa el superadmin: un segundo camino que
      // creara cupones sería un segundo sitio donde equivocarse con el dinero.
      const resultado =
        action === 'activate'
          ? await activateLaunchCampaign(ficha.id, scope.staffId, reason)
          : action === 'pause'
            ? await pauseLaunchCampaign(ficha.id, reason as string, scope.staffId)
            : await endLaunchCampaign(ficha.id, reason as string, scope.staffId)

      const disponible = launchOfferAvailability(toOfferRow(resultado), new Date())
      return text({
        ok: true,
        codigo: resultado.code,
        estado: resultado.status,
        sePuedeVender: disponible.available,
        cupon: resultado.stripeCouponId,
      })
    },
  )
}
