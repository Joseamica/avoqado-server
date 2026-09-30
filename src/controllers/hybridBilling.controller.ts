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
