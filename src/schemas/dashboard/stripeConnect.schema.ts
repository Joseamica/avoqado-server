import { z } from 'zod'

const params = z.object({
  venueId: z.string().min(1, 'El venue es requerido'),
  id: z.string().min(1, 'La afiliación de e-commerce es requerida'),
})

export const createStripeOnboardingLinkSchema = z.object({
  params,
  body: z.object({
    businessType: z.enum(['company', 'individual'], {
      errorMap: () => ({ message: 'Selecciona persona moral o persona física' }),
    }),
  }),
})

export const getStripeOnboardingStatusSchema = z.object({
  params,
})
