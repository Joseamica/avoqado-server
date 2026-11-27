import { versionQueCobra } from '@/services/billing/planOffer'
import logger from '@/config/logger'
import { planesPublicos } from '@/services/billing/planesPublicos'
import { asyncHandler } from '@/utils/asyncHandler'
import { BadRequestError } from '@/errors/AppError'
import { z } from 'zod'
import { featureCatalogQuery, listFeatureCatalog } from '@/services/launchCampaigns/featureCatalog.service'
import {
  getCurrentHybridPurchase,
  getHybridReplacementOptions,
  createHybridQuote,
  acceptHybridQuote,
  getHybridPurchaseStatus,
  hybridPurchaseView,
} from '@/services/launchCampaigns/hybridPurchase.service'
import { provisionHybridPurchase } from '@/services/launchCampaigns/hybridProvision.service'
import { getBasicPlanRow, saveBasicPlan } from '@/services/launchCampaigns/hybridListPrice.service'
import { getHybridFeatureGrid } from '@/services/launchCampaigns/hybridFeatureGrid.service'
import { cancelHybridPurchase, reconcileHybridPurchase } from '@/services/launchCampaigns/hybridLifecycle.service'
import { listHybridContracts, scheduleHybridSelection, cancelHybridContract } from '@/services/launchCampaigns/hybridManagement.service'
import {
  listHybridRedemptions,
  createHybridCampaign,
  updateHybridCampaign,
  publishHybridCampaign,
  setHybridCampaignStatus,
  getHybridCampaign,
  listHybridCampaigns,
  listPublicHybridOffers,
  getPublicHybridOffer,
  getPublicBasicPlan,
} from '@/services/launchCampaigns/hybridCampaign.service'

export const quote = asyncHandler(async (req, res) =>
  res
    .status(201)
    .json({ success: true, data: hybridPurchaseView(await createHybridQuote(req.params.venueId, req.authContext!.userId, req.body)) }),
)
export const accept = asyncHandler(async (req, res) => {
  const purchase = await acceptHybridQuote(req.params.venueId, req.authContext!.userId, req.params.id, req.body)
  const data =
    purchase.status === 'COMPLETED'
      ? { purchaseId: purchase.id, status: 'ACTIVE' }
      : await provisionHybridPurchase(req.params.venueId, purchase.id)
  res.status(202).json({ success: true, data })
})
export const status = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await getHybridPurchaseStatus(req.params.venueId, req.params.id) }),
)
export const resume = asyncHandler(async (req, res) => {
  const result = await reconcileHybridPurchase(req.params.venueId, req.params.id)
  const data =
    result.status === 'PAYMENT_PENDING'
      ? await provisionHybridPurchase(req.params.venueId, req.params.id)
      : { purchaseId: req.params.id, ...result }
  res.json({ success: true, data })
})
export const cancel = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await cancelHybridPurchase(req.params.venueId, req.params.id, req.authContext!.userId) }),
)
export const contracts = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await listHybridContracts(req.params.venueId, req.query) }),
)
export const scheduleSelection = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await scheduleHybridSelection(req.params.venueId, req.params.id, req.authContext!.userId, req.body) }),
)
export const cancelContract = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await cancelHybridContract(req.params.venueId, req.params.id, req.authContext!.userId, req.body) }),
)
export const campaigns = asyncHandler(async (req, res) => res.json({ success: true, data: await listHybridCampaigns(req.query) }))
export const campaign = asyncHandler(async (req, res) => res.json({ success: true, data: await getHybridCampaign(req.params.id) }))
export const createCampaign = asyncHandler(async (req, res) =>
  res.status(201).json({ success: true, data: await createHybridCampaign(req.body, req.authContext!.userId) }),
)
export const updateCampaign = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await updateHybridCampaign(req.params.id, req.body, req.authContext!.userId) }),
)
export const publishCampaign = asyncHandler(async (req, res) => {
  const parsed = z.object({ expectedRevision: z.number().int().positive() }).strict().safeParse(req.body)
  if (!parsed.success) throw new BadRequestError('Indica la versión vigente de la campaña.')
  res.json({ success: true, data: await publishHybridCampaign(req.params.id, parsed.data.expectedRevision, req.authContext!.userId) })
})
export const campaignStatus = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await setHybridCampaignStatus(req.params.id, req.body, req.authContext!.userId) }),
)
export const publicOffers = asyncHandler(async (req, res) => res.json({ success: true, data: await listPublicHybridOffers(req.query) }))
export const campaignCatalog = asyncHandler(async (req, res) => {
  const query = featureCatalogQuery.safeParse(req.query)
  if (!query.success) throw new BadRequestError('Revisa los filtros del catálogo.')
  res.json({ success: true, data: listFeatureCatalog(query.data) })
})
/** Planes editables (B4): los planes pagados vigentes, sólo campos públicos. Con la vigente dañada, el 503 de `ofertaVigente`. */
export const publicPlanOffer = asyncHandler(async (_req, res) => {
  const data = await planesPublicos()
  res.set('Cache-Control', 'public, max-age=30')
  res.json({ success: true, data })
})
/**
 * Planes editables (B4): con una versión del editor el Básico ya no se vende → `data: null`. Sin ella, lo de hoy (y sus errores
 * siguen al manejador). Si leer la versión lanza, aviso y lo de hoy.
 */
export const publicBasicPlan = asyncHandler(async (_req, res) => {
  let conVersion = false
  try {
    conVersion = (await versionQueCobra()) !== null
  } catch (error) {
    logger.warn('publicBasicPlan: no se pudo leer la versión de la oferta; se responde el Básico de hoy', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  res.json({ success: true, data: conVersion ? null : await getPublicBasicPlan() })
})
export const basicPlan = asyncHandler(async (_req, res) => res.json({ success: true, data: await getBasicPlanRow() }))
const basicPlanBody = z
  .object({
    name: z.string(),
    featureCodes: z.array(z.string()),
    price: z.number(),
    seatCap: z.number().int().nullable(),
    expectedRevision: z.number().int().positive().nullable(),
  })
  .strict()
export const saveBasicPlanCtrl = asyncHandler(async (req, res) => {
  const parsed = basicPlanBody.safeParse(req.body)
  if (!parsed.success) throw new BadRequestError('Revisa los datos del Plan Básico.', 'HYBRID_BASIC_INVALID')
  res.json({ success: true, data: await saveBasicPlan(parsed.data, req.authContext!.userId) })
})
export const publicOffer = asyncHandler(async (req, res) => res.json({ success: true, data: await getPublicHybridOffer(req.params.slug) }))

export const campaignRedemptions = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await listHybridRedemptions(req.params.id, req.query) }),
)

export const currentPurchase = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await getCurrentHybridPurchase(req.params.venueId) }),
)
export const replacementOptions = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await getHybridReplacementOptions(req.params.venueId) }),
)
export const featureGrid = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await getHybridFeatureGrid(req.params.venueId) }),
)
