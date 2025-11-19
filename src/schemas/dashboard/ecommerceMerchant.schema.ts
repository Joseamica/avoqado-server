import { z } from 'zod'

// ═══════════════════════════════════════════════════════════════════════════
// QUERY SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Schema for listing e-commerce merchants query parameters
 */
export const listEcommerceMerchantsQuerySchema = z.object({
  query: z.object({
    active: z
      .string()
      .optional()
      .transform(val => val === 'true'),
    sandboxMode: z
      .string()
      .optional()
      .transform(val => val === 'true'),
    providerId: z.string().optional(),
    limit: z.string().transform(Number).optional(),
    offset: z.string().transform(Number).optional(),
  }),
})

/**
 * Schema for e-commerce merchant ID parameter
 */
export const ecommerceMerchantIdParamSchema = z.object({
  params: z.object({
    id: z.string().min(1, 'E-commerce merchant ID is required'),
  }),
})

/**
 * Schema for venue ID parameter (for listing venue's e-commerce merchants)
 */
export const venueIdParamSchema = z.object({
  params: z.object({
    venueId: z.string().min(1, 'Venue ID is required'),
  }),
})

// ═══════════════════════════════════════════════════════════════════════════
// BODY SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Schema for creating a new e-commerce merchant
 */
export const createEcommerceMerchantSchema = z.object({
  body: z.object({
    // Venue relationship (REQUIRED)
    venueId: z.string().min(1, 'Venue ID is required'),

    // Channel identifier
    channelName: z.string().min(1, 'Channel name is required').default('Web Principal'),

    // Basic info
    businessName: z.string().min(1, 'Business name is required'),
    rfc: z.string().optional(),
    contactEmail: z.string().email('Invalid email format'),
    contactPhone: z.string().optional(),
    website: z.string().url('Invalid URL format').optional(),

    // Provider Integration
    providerId: z.string().min(1, 'Provider ID is required'),

    // Provider-specific credentials (JSON)
    // For Blumon: { blumonMerchantId, blumonApiKey, blumonPosId, webhookSecret }
    providerCredentials: z.record(z.any()).refine(val => typeof val === 'object', {
      message: 'Provider credentials must be a valid JSON object',
    }),

    // Cost Structure (optional, what provider charges Avoqado)
    costStructureId: z.string().optional(),

    // Pricing (optional, what we charge this client)
    pricingStructureId: z.string().optional(),

    // Webhook configuration (optional)
    webhookUrl: z.string().url('Invalid webhook URL').optional(),
    webhookEvents: z.array(z.string()).optional().default(['payment.completed', 'payment.failed']),

    // Dashboard access
    dashboardUserId: z.string().optional(),

    // Status & mode
    active: z.boolean().optional().default(true),
    sandboxMode: z.boolean().optional().default(true),
  }),
})

/**
 * Schema for updating an e-commerce merchant
 */
export const updateEcommerceMerchantSchema = z.object({
  body: z.object({
    // Channel identifier
    channelName: z.string().min(1).optional(),

    // Basic info (all optional for update)
    businessName: z.string().min(1).optional(),
    rfc: z.string().optional(),
    contactEmail: z.string().email('Invalid email format').optional(),
    contactPhone: z.string().optional(),
    website: z.string().url('Invalid URL format').optional(),

    // Provider Integration
    providerId: z.string().optional(),
    providerCredentials: z.record(z.any()).optional(),

    // Cost/Pricing Structures
    costStructureId: z.string().optional(),
    pricingStructureId: z.string().optional(),

    // Webhook configuration
    webhookUrl: z.string().url('Invalid webhook URL').optional(),
    webhookEvents: z.array(z.string()).optional(),

    // Dashboard access
    dashboardUserId: z.string().optional(),

    // Status & mode
    active: z.boolean().optional(),
    sandboxMode: z.boolean().optional(),
  }),
})

/**
 * Schema for toggling e-commerce merchant status
 */
export const toggleEcommerceMerchantStatusSchema = z.object({
  body: z.object({
    active: z.boolean({ required_error: 'Active status is required' }),
  }),
})

/**
 * Schema for regenerating API keys
 */
export const regenerateKeysSchema = z.object({
  body: z.object({
    sandboxMode: z.boolean().optional(), // If changing environment, specify new mode
  }),
})

// ═══════════════════════════════════════════════════════════════════════════
// COMBINED SCHEMAS (for validateRequest middleware)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Combined schema for GET /venues/:venueId/ecommerce-merchants/:id
 */
export const getEcommerceMerchantSchema = z.object({
  params: z.object({
    venueId: z.string().min(1),
    id: z.string().min(1),
  }),
})

/**
 * Combined schema for POST /venues/:venueId/ecommerce-merchants
 */
export const createEcommerceMerchantWithVenueSchema = z.object({
  params: z.object({
    venueId: z.string().min(1, 'Venue ID is required'),
  }),
  body: createEcommerceMerchantSchema.shape.body.omit({ venueId: true }), // venueId comes from params
})

/**
 * Combined schema for PUT /venues/:venueId/ecommerce-merchants/:id
 */
export const updateEcommerceMerchantWithVenueSchema = z.object({
  params: z.object({
    venueId: z.string().min(1),
    id: z.string().min(1),
  }),
  body: updateEcommerceMerchantSchema.shape.body,
})

/**
 * Combined schema for PATCH /venues/:venueId/ecommerce-merchants/:id/toggle
 */
export const toggleEcommerceMerchantWithVenueSchema = z.object({
  params: z.object({
    venueId: z.string().min(1),
    id: z.string().min(1),
  }),
  body: toggleEcommerceMerchantStatusSchema.shape.body,
})

/**
 * Combined schema for POST /venues/:venueId/ecommerce-merchants/:id/regenerate-keys
 */
export const regenerateKeysWithVenueSchema = z.object({
  params: z.object({
    venueId: z.string().min(1),
    id: z.string().min(1),
  }),
  body: regenerateKeysSchema.shape.body,
})

/**
 * Combined schema for GET /venues/:venueId/ecommerce-merchants
 */
export const listVenueEcommerceMerchantsSchema = z.object({
  params: z.object({
    venueId: z.string().min(1),
  }),
  query: listEcommerceMerchantsQuerySchema.shape.query,
})
