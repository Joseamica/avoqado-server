import { z } from 'zod'
import { commercialQuoteRequestSchema } from './commercialQuote.schema'

export const commercialQuoteSelectionV2Schema = commercialQuoteRequestSchema.shape.lines.element

export const commercialPublicQuotePreviewRequestV2Schema = z
  .object({
    market: z.literal('MX'),
    currency: z.literal('MXN'),
    acquisitionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    lines: z.array(commercialQuoteSelectionV2Schema).min(1).max(50),
  })
  .strict()

export const commercialDirectVenueQuoteRequestV2Schema = z
  .object({
    market: z.literal('MX'),
    currency: z.literal('MXN'),
    lines: z.array(commercialQuoteSelectionV2Schema).min(1).max(50),
  })
  .strict()

export const bridgeCommercialQuotePreviewRequestV2Schema = z
  .object({
    acquisitionBearer: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    previewToken: z.string().min(1).max(4096),
    normalizedLines: z.array(commercialQuoteSelectionV2Schema).min(1).max(50),
  })
  .strict()

export const commercialPublicQuotePreviewV2HttpRequestSchema = z.object({ body: commercialPublicQuotePreviewRequestV2Schema })
