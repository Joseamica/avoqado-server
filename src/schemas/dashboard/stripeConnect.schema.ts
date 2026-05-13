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
    // Optional: dashboard path Stripe should redirect back to after onboarding.
    // Lets the same flow land on /edit/integrations OR /ecommerce-merchants
    // depending on where the user kicked it off.
    returnPath: z
      .string()
      .regex(/^\/[A-Za-z0-9/_-]*$/, 'returnPath debe ser una ruta relativa válida')
      .optional(),
  }),
})

export const getStripeOnboardingStatusSchema = z.object({
  params,
})
