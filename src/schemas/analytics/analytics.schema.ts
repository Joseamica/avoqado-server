import { z } from 'zod'

// Time presets supported by the dashboard
export const timePresetEnum = z.enum(['7d', '30d', '90d', 'qtd', 'ytd', '12m'])

export const analyticsOverviewQuerySchema = z.object({
  query: z
    .object({
      timeRange: timePresetEnum.optional().default('30d'),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      compareTo: z.enum(['previous_period', 'previous_year']).optional(),
      orgId: z.string().optional(),
      venueId: z.string().optional(),
      // Optional UI language hint for localized labels/messages
      lang: z.enum(['en', 'es']).optional(),
      segments: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .transform(val => (typeof val === 'string' ? [val] : val)),
    })
    // If custom range is provided, require both from and to
    .refine(
      data => {
        if ((data.from && data.to) || (!data.from && !data.to)) return true
        return false
      },
      { message: 'Both from and to must be provided for custom range' },
    ),
})

export type AnalyticsOverviewQuery = z.infer<typeof analyticsOverviewQuerySchema>['query']
