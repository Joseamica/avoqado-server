/**
 * S5 — la oferta, como la lee la landing (spec 2026-09-17 § 3.3).
 *
 * 🔴 SIN AUTENTICAR y sin un solo dato interno: no expone el cupo, ni el conteo (D10), ni ids,
 * ni el id del cupón de Stripe. Y la vista NO DISPONIBLE no trae **ninguna** llave de precio —
 * una página enlazada desde un anuncio viejo vive meses, y pintar ahí un precio que ya no se
 * cobra es publicidad engañosa.
 */
import { NextFunction, Request, Response } from 'express'
import { buildLaunchOfferView } from '../../services/launchCampaigns/launchOfferMath'
import { findBySlug, findFeaturedByVertical, toOfferRow } from '../../services/launchCampaigns/launchCampaign.service'
import { CAMPAIGN_STATUS } from '../../services/launchCampaigns/launchCampaignEnums'
import { NotFoundError } from '../../errors/AppError'

/**
 * 30 s en el borde y 60 s de «sirve lo viejo mientras revalida»: pausar una ficha apaga el
 * precio en ~90 s como mucho (D8). Cualquier cobro posterior se rechaza al instante en el
 * servidor, así que la ventana de caché no puede producir un cargo equivocado.
 */
const CACHE_DISPONIBLE = 'public, max-age=0, s-maxage=30, stale-while-revalidate=60'
const CACHE_NO_ENCONTRADO = 'public, max-age=0, s-maxage=30'

export async function getLaunchOffer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const campaign = await findBySlug(req.params.slug)

    // 🔴 Una ficha en DRAFT es un 404, no una vista «no disponible»: mientras nadie la publica,
    // su dirección no existe para el mundo. Decir «pausada» filtraría que la estamos preparando.
    if (!campaign || campaign.status === CAMPAIGN_STATUS.DRAFT) {
      res.set('Cache-Control', CACHE_NO_ENCONTRADO)
      throw new NotFoundError('Esa oferta no existe', 'LAUNCH_OFFER_NOT_FOUND')
    }

    res.set('Cache-Control', CACHE_DISPONIBLE)
    res.status(200).json({ success: true, data: buildLaunchOfferView(toOfferRow(campaign), new Date()) })
  } catch (error) {
    next(error)
  }
}

/**
 * La VITRINA de un giro: la campaña que el superadmin marcó para la página de ese giro (hoy
 * `/restaurants` ⇒ FOOD_SERVICE), que no lleva el slug en su URL. Sustituye a la variable de
 * entorno de la landing: cambiar la oferta de esa página ya no exige desplegar nada.
 *
 * 🔴 MISMA vista y MISMAS reglas que por slug — deliberadamente, para que una oferta pausada,
 * vencida o agotada se vea igual por las dos puertas: sin campaña marcada o marcada en DRAFT ⇒
 * 404; marcada pero no vendible ⇒ 200 `available:false` sin una sola llave de precio. En los dos
 * casos la landing calla el precio y dice «Escríbenos».
 */
export async function getFeaturedLaunchOffer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const campaign = await findFeaturedByVertical(req.params.vertical)

    if (!campaign || campaign.status === CAMPAIGN_STATUS.DRAFT) {
      res.set('Cache-Control', CACHE_NO_ENCONTRADO)
      throw new NotFoundError('Ese giro no tiene oferta en vitrina', 'LAUNCH_OFFER_NOT_FOUND')
    }

    res.set('Cache-Control', CACHE_DISPONIBLE)
    res.status(200).json({ success: true, data: buildLaunchOfferView(toOfferRow(campaign), new Date()) })
  } catch (error) {
    next(error)
  }
}
