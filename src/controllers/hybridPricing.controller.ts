import { z } from 'zod'
import { asyncHandler } from '@/utils/asyncHandler'
import { BadRequestError } from '@/errors/AppError'
import { listPriceBoard, retryListPrice, saveListPrice, setListPriceStatus } from '@/services/launchCampaigns/hybridListPrice.service'
import { priceGapSummary, priceGapVenues } from '@/services/launchCampaigns/hybridPriceGap.service'
import {
  createPercentPromotion,
  getPromotionGroup,
  listPromotionGroups,
  previewPercentPromotion,
  recalculatePromotionGroup,
  setPromotionGroupStatus,
} from '@/services/launchCampaigns/hybridPromotionGroup.service'

const errorMap: z.ZodErrorMap = () => ({ message: 'Valor requerido o formato no válido' })
const PRODUCT_KEY = /^(FEATURE:[A-Z][A-Z0-9_]{0,63}|PLAN:(PRO|PREMIUM))$/
const revision = z.number({ errorMap }).int('La revisión debe ser entera').positive('Revisión no válida')
// Numbers stay numbers: a price sent as text is a client bug, not something to coerce. Range and decimals are the service's.
const listPriceBody = z
  .object({ price: z.number({ errorMap }).finite('El precio debe ser finito'), expectedRevision: revision.nullable() }, { errorMap })
  .strict('Campo no admitido')
const listStatusBody = z
  .object({ status: z.enum(['ACTIVE', 'PAUSED'], { errorMap }), expectedRevision: revision }, { errorMap })
  .strict('Campo no admitido')
const recalculateBody = z.object({ expectedRevision: revision }, { errorMap }).strict('Campo no admitido')
// The revision of the row whose pending price the admin retries; optional for clients from before the field.
const retryBody = z.object({ expectedRevision: revision.optional() }, { errorMap }).strict('Campo no admitido')
const gapVenuesQuery = z
  .object(
    {
      page: z.coerce
        .number({ errorMap })
        .int('La página debe ser entera')
        .min(1, 'La página mínima es 1')
        .max(10_000, 'La página máxima es 10,000')
        .default(1),
      pageSize: z.coerce
        .number({ errorMap })
        .int('El tamaño debe ser entero')
        .min(1, 'Mínimo 1 por página')
        .max(100, 'Máximo 100 por página')
        .default(50),
    },
    { errorMap },
  )
  .strict('Filtro no admitido')

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input)
  if (!result.success)
    throw new BadRequestError(
      result.error.issues.map(issue => (issue.path.length ? `${issue.path.join('.')}: ` : '') + issue.message).join('. '),
      'HYBRID_PRICING_INVALID',
    )
  return result.data
}

/** `FEATURE:<code>` or `PLAN:PRO|PREMIUM`, sent URL-encoded (`FEATURE%3ACFDI`). */
function productKey(raw: string): string {
  let key = ''
  try {
    key = decodeURIComponent(raw)
  } catch {
    // A malformed escape is rejected below like any other invalid key.
  }
  if (!PRODUCT_KEY.test(key)) throw new BadRequestError('Producto no válido.', 'HYBRID_PRICING_INVALID')
  return key
}

export const board = asyncHandler(async (_req, res) => res.json({ success: true, data: await listPriceBoard() }))
export const saveList = asyncHandler(async (req, res) => {
  const key = productKey(req.params.productKey)
  const body = parse(listPriceBody, req.body)
  res.json({ success: true, data: await saveListPrice({ productKey: key, ...body }, req.authContext!.userId) })
})
export const retryList = asyncHandler(async (req, res) => {
  const key = productKey(req.params.productKey)
  const { expectedRevision } = parse(retryBody, req.body ?? {})
  res.json({ success: true, data: await retryListPrice(key, req.authContext!.userId, expectedRevision) })
})
export const listStatus = asyncHandler(async (req, res) => {
  const key = productKey(req.params.productKey)
  const body = parse(listStatusBody, req.body)
  res.json({ success: true, data: await setListPriceStatus({ productKey: key, ...body }, req.authContext!.userId) })
})
export const gaps = asyncHandler(async (_req, res) => res.json({ success: true, data: await priceGapSummary() }))
export const gapVenues = asyncHandler(async (req, res) => {
  const key = productKey(req.params.productKey)
  const { page, pageSize } = parse(gapVenuesQuery, req.query)
  res.json({ success: true, data: await priceGapVenues(key, page, pageSize) })
})
export const percentGroups = asyncHandler(async (req, res) => res.json({ success: true, data: await listPromotionGroups(req.query) }))
export const previewPercent = asyncHandler(async (req, res) => res.json({ success: true, data: await previewPercentPromotion(req.body) }))
export const createPercent = asyncHandler(async (req, res) =>
  res.status(201).json({ success: true, data: await createPercentPromotion(req.body, req.authContext!.userId) }),
)
export const percentGroup = asyncHandler(async (req, res) => res.json({ success: true, data: await getPromotionGroup(req.params.groupId) }))
export const percentStatus = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await setPromotionGroupStatus(req.params.groupId, req.body, req.authContext!.userId) }),
)
export const recalculatePercent = asyncHandler(async (req, res) => {
  const { expectedRevision } = parse(recalculateBody, req.body)
  res.json({ success: true, data: await recalculatePromotionGroup(req.params.groupId, expectedRevision, req.authContext!.userId) })
})
