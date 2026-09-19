/**
 * S4 — ACTIVAR una ficha: lo único que crea cupones de campaña (spec 2026-09-17 § 3.4).
 *
 * 🔴 Este archivo es la ÚNICA puerta por la que nace un cupón `LC_*`. No hay un segundo camino,
 * ni un script, ni una tool del MCP que lo cree por su cuenta: la tool llama a esta función.
 *
 * 🔴 Y NUNCA borra un cupón. Se aparta a propósito de `ensureCoupon` (scripts/seed-plan-pro.ts),
 * que sí borra y vuelve a crear: un `coupons.del` sobre un cupón vivo le sube el precio, en el
 * siguiente ciclo, a TODOS los clientes que ya lo llevan puesto. Si el cupón que encuentra no
 * coincide con la oferta, esto responde 409 y no toca nada.
 */
import Stripe from 'stripe'
import { CAMPAIGN_STATUS } from './launchCampaignEnums'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { ConflictError, NotFoundError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import { planLookupKey } from '../stripe.service'
import { computeCouponAmountOff, ivaBreakdownIsExact, promoPeriodTotalCents, splitIvaInclusive } from './launchOfferMath'
import { LAUNCH_CAMPAIGN_SELECT, LaunchCampaignRow } from './launchCampaign.service'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

/** El id del cupón de una ficha. Versionado: es lo que ata cada redención a lo que se consintió. */
export function launchCouponId(code: string, offerVersion: number): string {
  return `LC_${code}_V${offerVersion}`
}

export interface PlanListPrice {
  id: string
  unitAmount: number
  /** Producto de Stripe al que pertenece el precio: es lo que acota el cupón con `applies_to`. */
  productId: string
}

/**
 * Lee el precio de lista VIVO en Stripe y comprueba que sirva para esta oferta.
 *
 * 🔴 Las cinco comprobaciones no son ceremonia: cada una produce un cobro equivocado si falta.
 * `tax_behavior !== 'inclusive'` es la más silenciosa — Stripe le sumaría el IVA encima al
 * precio, y entonces lo anunciado ($22.00 «IVA incluido») y lo cobrado dejan de coincidir.
 */
export async function readPlanListPrice(planTier: 'PRO' | 'PREMIUM', advertisedPriceCents: number): Promise<PlanListPrice> {
  const tierCode = planTier === 'PREMIUM' ? ('PLAN_PREMIUM' as const) : ('PLAN_PRO' as const)
  const lookupKey = planLookupKey(tierCode, 'monthly')
  const prices = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 })
  const price = prices.data[0]

  const problema = (motivo: string): never => {
    throw new ConflictError(
      `El precio de lista del plan no sirve para esta oferta: ${motivo}. Revisa \`${lookupKey}\` en Stripe.`,
      'PLAN_PRICE_UNAVAILABLE',
      { lookupKey, motivo },
    )
  }

  if (!price) return problema('no existe')
  if (price.currency !== 'mxn') return problema(`está en ${price.currency.toUpperCase()}, no en MXN`)
  if (price.recurring?.interval !== 'month') return problema('no es mensual')
  if (price.tax_behavior !== 'inclusive') return problema('no trae el IVA incluido (tax_behavior)')
  if (typeof price.unit_amount !== 'number') return problema('no tiene importe fijo')
  if (price.unit_amount <= advertisedPriceCents) {
    return problema(`el precio de lista (${price.unit_amount}) no es mayor que el anunciado (${advertisedPriceCents})`)
  }
  // El producto es lo que permite acotar el cupón con `applies_to`: sin él, el descuento se
  // aplicaría a cualquier cosa que el negocio contrate después.
  const productId = typeof price.product === 'string' ? price.product : (price.product as { id?: string } | null)?.id
  if (!productId) return problema('no tiene producto asociado en Stripe')
  return { id: price.id, unitAmount: price.unit_amount, productId }
}

export interface LaunchOfferPreview {
  listPriceCents: number
  discountAmountCents: number
  firstChargeCents: number
  promoTotalCents: number
  renewalMonthlyCents: number
  promo: { subtotalCents: number; ivaCents: number; ivaExact: boolean }
  couponId: string | null
  problems: string[]
}

/**
 * Vista previa de lo que se va a cobrar. SOLO LEE de Stripe: no crea nada.
 * Es lo que el superadmin ve antes de apretar «Activar», y lo que el MCP devuelve sin `confirm`.
 */
export async function previewLaunchOffer(input: {
  planTier: 'PRO' | 'PREMIUM'
  advertisedPriceCents: number
  discountMonths: number
  code?: string
  offerVersion?: number
}): Promise<LaunchOfferPreview> {
  const price = await readPlanListPrice(input.planTier, input.advertisedPriceCents)
  const discountAmountCents = computeCouponAmountOff({
    listPriceCents: price.unitAmount,
    advertisedPriceCents: input.advertisedPriceCents,
  })
  const promo = splitIvaInclusive(input.advertisedPriceCents)
  const ivaExact = ivaBreakdownIsExact(input.advertisedPriceCents)

  const problems: string[] = []
  if (!ivaExact) {
    // No bloquea: es un AVISO a tiempo. El desglose de $22.00 (18.97 + 3.03) no se puede rotular
    // «16 %» porque el 16 % de 18.97 es 3.04. Un precio limpio ($23.20 = $20.00 + $3.20) sí.
    problems.push(
      'El desglose de este precio no cuadra al centavo con el 16 %: la pantalla mostrará el total con «IVA incluido», sin partirlo en dos renglones.',
    )
  }

  return {
    listPriceCents: price.unitAmount,
    discountAmountCents,
    firstChargeCents: input.advertisedPriceCents,
    promoTotalCents: promoPeriodTotalCents({
      advertisedPriceCents: input.advertisedPriceCents,
      discountMonths: input.discountMonths,
    }),
    renewalMonthlyCents: price.unitAmount,
    promo: { subtotalCents: promo.subtotalCents, ivaCents: promo.ivaCents, ivaExact },
    couponId: input.code ? launchCouponId(input.code, input.offerVersion ?? 1) : null,
    problems,
  }
}

/**
 * ACTIVAR. El orden importa: primero se valida el estado, después se lee Stripe, después se
 * resuelve el cupón, y sólo al final se escribe el CAS que congela el snapshot.
 */
export async function activateLaunchCampaign(id: string, staffId?: string | null, reason?: string): Promise<LaunchCampaignRow> {
  const campaign = await prisma.launchCampaign.findUnique({ where: { id }, select: LAUNCH_CAMPAIGN_SELECT })
  if (!campaign) throw new NotFoundError('Campaña no encontrada', 'LAUNCH_CAMPAIGN_NOT_FOUND')

  // 1. Estado y vigencia.
  if (campaign.status !== CAMPAIGN_STATUS.DRAFT && campaign.status !== CAMPAIGN_STATUS.PAUSED) {
    throw new ConflictError(`No se puede activar una campaña en estado ${campaign.status}`, 'LAUNCH_CAMPAIGN_BAD_STATE', {
      currentStatus: campaign.status,
    })
  }
  const now = new Date()
  if (campaign.validUntil <= now) {
    throw new ConflictError('Esa campaña ya venció: cambia la vigencia antes de activarla.', 'LAUNCH_CAMPAIGN_EXPIRED')
  }
  if (campaign.planTier !== 'PRO' && campaign.planTier !== 'PREMIUM') {
    throw new ConflictError('Una campaña sólo puede ofrecer un plan de pago (PRO o PREMIUM)', 'LAUNCH_CAMPAIGN_INVALID_OFFER')
  }

  // 2. Precio de lista vivo en Stripe.
  const price = await readPlanListPrice(campaign.planTier, campaign.advertisedPriceCents)

  // 3. El descuento es una RESTA, nunca un porcentaje: un porcentaje redondeado por Stripe
  //    cobraría $22.01 o $21.99 sobre un anuncio que prometió $22.00 exactos.
  let amountOff: number
  try {
    amountOff = computeCouponAmountOff({ listPriceCents: price.unitAmount, advertisedPriceCents: campaign.advertisedPriceCents })
  } catch (error) {
    throw new ConflictError(error instanceof Error ? error.message : 'Oferta inválida', 'LAUNCH_CAMPAIGN_INVALID_OFFER')
  }

  const couponId = launchCouponId(campaign.code, campaign.offerVersion)

  if (campaign.stripeCouponId) {
    // 5. Se REACTIVA desde PAUSED: el cupón ya existe y el snapshot ya está congelado.
    //    🔴 Se comprueba que el precio de lista NO se haya movido debajo: si cambió, el cupón
    //    viejo ya no produce el importe anunciado y hay que terminar la ficha y crear otra.
    const cupon = await stripe.coupons.retrieve(campaign.stripeCouponId)
    if (!cupon || cupon.valid === false) {
      throw new ConflictError(
        'El cupón de esta campaña ya no es válido en Stripe. Termina esta ficha y crea otra.',
        'LAUNCH_CAMPAIGN_COUPON_CONFLICT',
        { couponId: campaign.stripeCouponId },
      )
    }
    if (price.unitAmount !== campaign.listPriceCentsSnapshot) {
      throw new ConflictError('El precio de lista cambió en Stripe: termina esta ficha y crea otra.', 'PLAN_PRICE_MISMATCH', {
        snapshot: campaign.listPriceCentsSnapshot,
        stripe: price.unitAmount,
      })
    }
  } else {
    // 4. Primera activación de esta versión: se reutiliza el cupón si YA coincide, se crea si no
    //    existe, y se rechaza si existe con otra forma. Nunca se borra.
    const existente = await stripe.coupons.retrieve(couponId).catch((error: unknown) => {
      // Stripe contesta 404 `resource_missing` cuando no existe; cualquier otro error SÍ sube,
      // porque «no pude ver» nunca puede leerse como «no existe» antes de crear dinero.
      if (error && typeof error === 'object' && (error as { code?: string }).code === 'resource_missing') return null
      throw error
    })

    if (existente) {
      const coincide =
        existente.amount_off === amountOff &&
        existente.currency === 'mxn' &&
        existente.duration === 'repeating' &&
        existente.duration_in_months === campaign.discountMonths &&
        existente.valid !== false
      if (!coincide) {
        throw new ConflictError(
          `Ya existe un cupón ${couponId} en Stripe con otra oferta. Termina esta ficha y crea otra con otro código.`,
          'LAUNCH_CAMPAIGN_COUPON_CONFLICT',
          {
            couponId,
            esperado: { amount_off: amountOff, duration_in_months: campaign.discountMonths },
            encontrado: { amount_off: existente.amount_off, duration_in_months: existente.duration_in_months },
          },
        )
      }
      logger.info(`launchCampaign: reutilizando el cupón ${couponId} que ya coincide con la oferta`)
    } else {
      await stripe.coupons.create(
        {
          id: couponId,
          amount_off: amountOff,
          currency: 'mxn',
          duration: 'repeating',
          duration_in_months: campaign.discountMonths,
          // 🔴 El cupón es DINERO, no una promesa de precio: sin `applies_to` Stripe lo aplica a
          // cualquier producto de la suscripción, y la actualización de precio CONSERVA los
          // descuentos. Un `LC_POS22_V1` abierto sobrevive a un cambio de plan y descuenta sus
          // $1,136.84 de lo que sea — sobre PREMIUM el recurrente sería $834, no $22; sobre un
          // paquete de $500 se lo comería entero. (Auditoría de Codex, 18-sep, hallazgo #9.)
          //
          // ⚠️ Stripe NO deja modificar `applies_to` de un cupón ya creado: esto protege a las
          // campañas que se activen desde hoy, no a las que ya tienen su cupón abierto.
          applies_to: { products: [price.productId] },
          name: `${campaign.name} v${campaign.offerVersion}`,
          metadata: { launchCampaignId: campaign.id, code: campaign.code, offerVersion: String(campaign.offerVersion) },
        },
        // La llave de idempotencia hace que un reintento del superadmin (doble clic, red lenta)
        // devuelva el MISMO cupón en vez de chocar con un id tomado.
        { idempotencyKey: `lc-coupon:${couponId}` },
      )
      logger.info(`launchCampaign: cupón ${couponId} creado con amount_off ${amountOff}`)
    }
  }

  // 6. CAS a ACTIVE que congela el snapshot. `activatedAt` sólo se pone la primera vez: es lo que
  //    marca «esta ficha ya se publicó» y lo que congela el slug y la oferta para siempre.
  const r = await prisma.launchCampaign.updateMany({
    where: { id, status: campaign.status, updatedAt: campaign.updatedAt },
    data: {
      status: CAMPAIGN_STATUS.ACTIVE,
      stripeCouponId: couponId,
      stripePriceId: price.id,
      listPriceCentsSnapshot: price.unitAmount,
      discountAmountCents: amountOff,
      activatedAt: campaign.activatedAt ?? now,
      statusReason: reason ?? null,
      updatedById: staffId ?? null,
    },
  })
  if (r.count === 0) throw new ConflictError('Alguien más cambió esta campaña. Vuelve a abrirla.', 'LAUNCH_CAMPAIGN_STALE')

  const actualizada = await prisma.launchCampaign.findUniqueOrThrow({ where: { id }, select: LAUNCH_CAMPAIGN_SELECT })
  await logAction({
    staffId,
    action: 'LAUNCH_CAMPAIGN_ACTIVATED',
    entity: 'LaunchCampaign',
    entityId: id,
    data: {
      code: actualizada.code,
      offerVersion: actualizada.offerVersion,
      couponId,
      listPriceCents: price.unitAmount,
      advertisedPriceCents: actualizada.advertisedPriceCents,
      reason: reason ?? null,
    },
  })
  return actualizada
}
