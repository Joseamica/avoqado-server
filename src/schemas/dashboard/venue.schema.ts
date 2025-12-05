import { EntityType, VenueType } from '@prisma/client' // Importa enums directamente de Prisma
import { z } from 'zod'

// Schema de Zod para la creación de Venues
export const createVenueSchema = z.object({
  // Este es el schema que usará tu middleware
  body: z.object({
    name: z
      .string({ required_error: 'El nombre del venue es requerido.' })
      .min(2, { message: 'El nombre debe tener al menos 2 caracteres.' })
      .max(100, { message: 'El nombre no puede exceder los 100 caracteres.' }),

    slug: z
      .string()
      .min(2, { message: 'El slug debe tener al menos 2 caracteres.' })
      .max(100, { message: 'El slug no puede exceder los 100 caracteres.' })
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
        message: 'El slug solo puede contener letras minúsculas, números y guiones, y no puede empezar ni terminar con guion.',
      })
      .optional(),

    type: z.nativeEnum(VenueType, { errorMap: () => ({ message: 'Tipo de venue inválido.' }) }).default(VenueType.RESTAURANT),

    timezone: z.string().optional().default('America/Mexico_City'),
    currency: z.string().min(3).max(3).optional().default('MXN'),

    address: z.string().min(5, { message: 'La dirección debe tener al menos 5 caracteres.' }).optional().nullable(),

    city: z.string().min(2, { message: 'La ciudad debe tener al menos 2 caracteres.' }).optional().nullable(),

    state: z.string().min(2, { message: 'El estado/provincia debe tener al menos 2 caracteres.' }).optional().nullable(),

    country: z.string().min(2).max(2).optional().default('MX'),

    zipCode: z.string().min(4, { message: 'El código postal debe tener al menos 4 caracteres.' }).optional().nullable(),

    latitude: z.number({ invalid_type_error: 'La latitud debe ser un número.' }).min(-90).max(90).optional().nullable(),

    longitude: z.number({ invalid_type_error: 'La longitud debe ser un número.' }).min(-180).max(180).optional().nullable(),

    phone: z
      .string()
      .min(7, { message: 'El teléfono debe tener al menos 7 dígitos.' })
      .regex(/^[+]?[0-9\s-()]*$/, { message: 'Formato de teléfono inválido.' })
      .optional()
      .nullable(),

    email: z.string().email({ message: 'Formato de email inválido.' }).optional().nullable(),

    website: z.string().url({ message: 'Formato de URL de sitio web inválido.' }).optional().nullable(),
    logo: z.string().url({ message: 'URL de logo inválida.' }).optional().nullable(),
    primaryColor: z
      .string()
      .regex(/^#(?:[0-9a-fA-F]{3}){1,2}$/, { message: 'Color primario debe ser un código hexadecimal válido.' })
      .optional()
      .nullable(),
    secondaryColor: z
      .string()
      .regex(/^#(?:[0-9a-fA-F]{3}){1,2}$/, { message: 'Color secundario debe ser un código hexadecimal válido.' })
      .optional()
      .nullable(),
    operationalSince: z.coerce.date({ invalid_type_error: 'Fecha de inicio de operaciones inválida.' }).optional().nullable(),
  }),
  // Puedes añadir .strict() al final de z.object si quieres que falle si hay campos extra no definidos en el schema
  // ej. body: z.object({ ... }).strict()
})

// Ahora puedes inferir tu tipo DTO desde el schema de Zod para asegurar consistencia
export type CreateVenueDto = z.infer<typeof createVenueSchema.shape.body>

// Otros Schemas
export const updateVenueSchema = createVenueSchema.deepPartial()
export type UpdateVenueDto = z.infer<typeof updateVenueSchema.shape.body>

export const venueIdParamSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
})

// Schema para ListVenuesQueryDto si quieres validarlo con Zod también
export const listVenuesQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().optional().default(1),
    limit: z.coerce.number().int().positive().optional().default(10),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
    search: z.string().optional(),
  }),
})
export type ListVenuesQueryDto = z.infer<typeof listVenuesQuerySchema.shape.query>

// Schema for converting demo venue to real venue
// Follows Blumonpay requirements for KYC documentation
export const convertDemoVenueSchema = z.object({
  body: z
    .object({
      // Entity type (required) - determines required documents
      entityType: z.nativeEnum(EntityType, {
        errorMap: () => ({ message: 'Tipo de persona es requerido o inválido' }),
      }),

      // Basic business info (required for all)
      rfc: z
        .string({ required_error: 'RFC es requerido' })
        .min(12, { message: 'RFC debe tener al menos 12 caracteres' })
        .max(13, { message: 'RFC debe tener máximo 13 caracteres' })
        .regex(/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/, { message: 'Formato de RFC inválido' }),
      legalName: z
        .string({ required_error: 'Razón social es requerida' })
        .min(3, { message: 'Razón social debe tener al menos 3 caracteres' }),
      fiscalRegime: z.string({ required_error: 'Régimen fiscal es requerido' }).min(1, { message: 'Régimen fiscal es requerido' }),

      // Documents - Required for ALL entity types (Blumonpay requirements)
      idDocumentUrl: z.string({ required_error: 'Identificación oficial es requerida' }).url({ message: 'URL de identificación inválida' }),
      rfcDocumentUrl: z
        .string({ required_error: 'Constancia de situación fiscal es requerida' })
        .url({ message: 'URL de constancia fiscal inválida' }),
      comprobanteDomicilioUrl: z
        .string({ required_error: 'Comprobante de domicilio es requerido' })
        .url({ message: 'URL de comprobante de domicilio inválida' }),
      caratulaBancariaUrl: z
        .string({ required_error: 'Carátula bancaria es requerida' })
        .url({ message: 'URL de carátula bancaria inválida' }),

      // Documents - PERSONA_MORAL only
      actaDocumentUrl: z.string().url({ message: 'URL de acta constitutiva inválida' }).optional().nullable(),
      poderLegalUrl: z.string().url({ message: 'URL de poder legal inválida' }).optional().nullable(),

      // Legacy field (keeping for backwards compatibility, maps to rfcDocumentUrl)
      taxDocumentUrl: z.string().url().optional().nullable(),

      // Stripe integration fields (optional)
      selectedFeatures: z.array(z.string()).optional(),
      paymentMethodId: z.string().optional(),
    })
    .refine(
      data => {
        // Acta Constitutiva is required for PERSONA_MORAL
        if (data.entityType === EntityType.PERSONA_MORAL) {
          return !!data.actaDocumentUrl
        }
        return true
      },
      { message: 'Acta Constitutiva es requerida para Persona Moral', path: ['actaDocumentUrl'] },
    ),
})

export type ConvertDemoVenueDto = z.infer<typeof convertDemoVenueSchema.shape.body>

// Schema for adding features to venue
export const addVenueFeaturesSchema = z.object({
  body: z.object({
    featureCodes: z
      .array(z.string())
      .min(1, { message: 'Al menos un feature code es requerido' })
      .max(10, { message: 'Máximo 10 features a la vez' }),
    trialPeriodDays: z.number().int().min(0).max(365).optional().default(2), // Stripe allows up to 730 days
  }),
})

export type AddVenueFeaturesDto = z.infer<typeof addVenueFeaturesSchema.shape.body>

// Schema for updating venue payment method
export const updatePaymentMethodSchema = z.object({
  body: z.object({
    paymentMethodId: z
      .string({ required_error: 'Payment method ID is required' })
      .min(1, { message: 'Payment method ID cannot be empty' })
      .startsWith('pm_', { message: 'Invalid Stripe payment method ID format' }),
  }),
})

export type UpdatePaymentMethodDto = z.infer<typeof updatePaymentMethodSchema.shape.body>

// Schema for creating Stripe Customer Portal session
export const createBillingPortalSessionSchema = z.object({
  body: z.object({
    returnUrl: z.string({ required_error: 'Return URL is required' }).url({ message: 'Invalid URL format' }),
  }),
})

export type CreateBillingPortalSessionDto = z.infer<typeof createBillingPortalSessionSchema.shape.body>
