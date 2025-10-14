import { z } from 'zod'
import {
  RawMaterialCategory,
  PurchaseOrderStatus,
  PricingStrategy,
  RawMaterialMovementType,
  AlertType,
  AlertStatus,
  Unit,
} from '@prisma/client'

// ==========================================
// RAW MATERIAL SCHEMAS
// ==========================================

export const CreateRawMaterialSchema = z.object({
  body: z
    .object({
      name: z.string().min(1, 'Name is required'),
      description: z.string().optional(),
      sku: z.string().min(1, 'SKU is required'),
      category: z.nativeEnum(RawMaterialCategory),
      currentStock: z.number().min(0, 'Stock must be non-negative'),
      unit: z.nativeEnum(Unit, { errorMap: () => ({ message: 'Invalid unit type' }) }),
      minimumStock: z.number().min(0, 'Minimum stock must be non-negative'),
      reorderPoint: z.number().min(0, 'Reorder point must be non-negative'),
      maximumStock: z.number().min(0).nullish(), // Accept null, undefined, or number
      costPerUnit: z.number().positive('Cost per unit must be positive'),
      avgCostPerUnit: z.number().positive().nullish(), // Accept null, undefined, or number
      perishable: z.boolean().default(false),
      shelfLifeDays: z.number().int().positive().nullish(), // Accept null, undefined, or number
    })
    .refine(data => data.minimumStock <= data.reorderPoint, {
      message: 'Minimum stock must be less than or equal to reorder point',
      path: ['minimumStock'],
    })
    .refine(
      data => {
        // Only validate if maximumStock is provided (not null and not undefined)
        if (data.maximumStock != null) {
          return data.reorderPoint <= data.maximumStock
        }
        return true
      },
      {
        message: 'Reorder point must be less than or equal to maximum stock',
        path: ['reorderPoint'],
      },
    )
    .refine(
      data => {
        // Only validate if maximumStock is provided (not null and not undefined)
        if (data.maximumStock != null) {
          return data.minimumStock <= data.maximumStock
        }
        return true
      },
      {
        message: 'Minimum stock must be less than or equal to maximum stock',
        path: ['minimumStock'],
      },
    )
    .refine(
      data => {
        // Perishable items MUST have shelfLifeDays (used to calculate batch expiration dates)
        if (data.perishable && !data.shelfLifeDays) {
          return false
        }
        return true
      },
      {
        message: 'Perishable items must have shelf life days',
        path: ['shelfLifeDays'],
      },
    ),
})

export const UpdateRawMaterialSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    rawMaterialId: z.string().cuid(),
  }),
  body: z
    .object({
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      sku: z.string().min(1).optional(),
      category: z.nativeEnum(RawMaterialCategory).optional(),
      currentStock: z.number().min(0).optional(),
      unit: z.nativeEnum(Unit, { errorMap: () => ({ message: 'Invalid unit type' }) }).optional(),
      minimumStock: z.number().min(0).optional(),
      reorderPoint: z.number().min(0).optional(),
      maximumStock: z.number().min(0).nullish(), // Accept null, undefined, or number
      costPerUnit: z.number().positive('Cost per unit must be positive').optional(),
      perishable: z.boolean().optional(),
      shelfLifeDays: z.number().int().positive().nullish(), // Accept null, undefined, or number
      active: z.boolean().optional(),
    })
    .refine(
      data => {
        // If both minimumStock and reorderPoint are provided, validate relationship
        if (data.minimumStock !== undefined && data.reorderPoint !== undefined) {
          return data.minimumStock <= data.reorderPoint
        }
        return true
      },
      {
        message: 'Minimum stock must be less than or equal to reorder point',
        path: ['minimumStock'],
      },
    )
    .refine(
      data => {
        // If both reorderPoint and maximumStock are provided, validate relationship
        if (data.reorderPoint != null && data.maximumStock != null) {
          return data.reorderPoint <= data.maximumStock
        }
        return true
      },
      {
        message: 'Reorder point must be less than or equal to maximum stock',
        path: ['reorderPoint'],
      },
    )
    .refine(
      data => {
        // If both minimumStock and maximumStock are provided, validate relationship
        if (data.minimumStock != null && data.maximumStock != null) {
          return data.minimumStock <= data.maximumStock
        }
        return true
      },
      {
        message: 'Minimum stock must be less than or equal to maximum stock',
        path: ['minimumStock'],
      },
    )
    .refine(
      data => {
        // If perishable is set to true, must have shelfLifeDays
        if (data.perishable === true && !data.shelfLifeDays) {
          return false
        }
        return true
      },
      {
        message: 'Perishable items must have shelf life days',
        path: ['shelfLifeDays'],
      },
    ),
})

export const AdjustStockSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    rawMaterialId: z.string().cuid(),
  }),
  body: z.object({
    quantity: z.number(),
    type: z.nativeEnum(RawMaterialMovementType),
    reason: z.string().optional(),
    reference: z.string().optional(),
  }),
})

export const GetRawMaterialsQuerySchema = z.object({
  query: z.object({
    category: z.nativeEnum(RawMaterialCategory).optional(),
    lowStock: z.enum(['true', 'false']).optional(),
    active: z.enum(['true', 'false']).optional(),
    search: z.string().optional(),
  }),
})

// ==========================================
// RECIPE SCHEMAS
// ==========================================

export const CreateRecipeSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    productId: z.string().cuid(),
  }),
  body: z.object({
    portionYield: z.number().int().positive().default(1),
    prepTime: z.number().int().positive().nullish(), // Accept null or undefined
    cookTime: z.number().int().positive().nullish(), // Accept null or undefined
    notes: z.string().optional(),
    lines: z.array(
      z.object({
        rawMaterialId: z.string().cuid(),
        quantity: z.number().positive(),
        unit: z.nativeEnum(Unit),
        isOptional: z.boolean().default(false),
        substituteNotes: z.string().optional(),
      }),
    ),
  }),
})

export const UpdateRecipeSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    productId: z.string().cuid(),
  }),
  body: z.object({
    portionYield: z.number().int().positive().optional(),
    prepTime: z.number().int().positive().optional(),
    cookTime: z.number().int().positive().optional(),
    notes: z.string().optional(),
    lines: z
      .array(
        z.object({
          rawMaterialId: z.string().cuid(),
          quantity: z.number().positive(),
          unit: z.nativeEnum(Unit),
          isOptional: z.boolean().default(false),
          substituteNotes: z.string().optional(),
        }),
      )
      .optional(),
  }),
})

export const AddRecipeLineSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    productId: z.string().cuid(),
  }),
  body: z.object({
    rawMaterialId: z.string().cuid(),
    quantity: z.number().positive(),
    unit: z.nativeEnum(Unit),
    isOptional: z.boolean().default(false),
    substituteNotes: z.string().optional(),
  }),
})

// ==========================================
// SUPPLIER SCHEMAS
// ==========================================

export const CreateSupplierSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required'),
    contactName: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    website: z.string().url().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().default('MX'),
    zipCode: z.string().optional(),
    taxId: z.string().optional(),
    leadTimeDays: z.number().int().positive().default(3),
    minimumOrder: z.number().min(0).optional(),
    notes: z.string().optional(),
  }),
})

export const UpdateSupplierSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    supplierId: z.string().cuid(),
  }),
  body: z.object({
    name: z.string().min(1).optional(),
    contactName: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    website: z.string().url().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    zipCode: z.string().optional(),
    taxId: z.string().optional(),
    rating: z.number().min(1).max(5).optional(),
    reliabilityScore: z.number().min(0).max(1).optional(),
    leadTimeDays: z.number().int().positive().optional(),
    minimumOrder: z.number().min(0).optional(),
    active: z.boolean().optional(),
    notes: z.string().optional(),
  }),
})

export const CreateSupplierPricingSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    supplierId: z.string().cuid(),
  }),
  body: z
    .object({
      rawMaterialId: z.string().cuid(),
      pricePerUnit: z.number().positive(),
      unit: z.nativeEnum(Unit),
      minimumQuantity: z.number().positive().default(1),
      bulkDiscount: z.number().min(0).max(1).optional(),
      effectiveFrom: z.string().datetime(),
      effectiveTo: z.string().datetime().optional(),
    })
    .refine(
      data => {
        // If effectiveTo is provided, it must be after effectiveFrom
        if (data.effectiveTo) {
          return new Date(data.effectiveTo) > new Date(data.effectiveFrom)
        }
        return true
      },
      {
        message: 'Effective end date must be after effective start date',
        path: ['effectiveTo'],
      },
    ),
})

export const GetSupplierRecommendationsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    rawMaterialId: z.string().cuid(),
  }),
  query: z.object({
    quantity: z.string().transform(Number).optional(),
  }),
})

// ==========================================
// PURCHASE ORDER SCHEMAS
// ==========================================

export const CreatePurchaseOrderSchema = z.object({
  body: z.object({
    supplierId: z.string().cuid(),
    orderDate: z.string().datetime(),
    expectedDeliveryDate: z.string().datetime().optional(),
    taxRate: z.number().min(0).max(1).default(0.16),
    notes: z.string().optional(),
    items: z.array(
      z.object({
        rawMaterialId: z.string().cuid(),
        quantityOrdered: z.number().positive(),
        unit: z.nativeEnum(Unit),
        unitPrice: z.number().positive(),
      }),
    ),
  }),
})

export const UpdatePurchaseOrderSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    purchaseOrderId: z.string().cuid(),
  }),
  body: z.object({
    status: z.nativeEnum(PurchaseOrderStatus).optional(),
    expectedDeliveryDate: z.string().datetime().optional(),
    notes: z.string().optional(),
    items: z
      .array(
        z.object({
          rawMaterialId: z.string().cuid(),
          quantityOrdered: z.number().positive(),
          unit: z.nativeEnum(Unit),
          unitPrice: z.number().positive(),
        }),
      )
      .optional(),
  }),
})

export const ReceivePurchaseOrderSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    purchaseOrderId: z.string().cuid(),
  }),
  body: z.object({
    receivedDate: z.string().datetime(),
    items: z.array(
      z.object({
        purchaseOrderItemId: z.string().cuid(),
        quantityReceived: z.number().positive(),
      }),
    ),
  }),
})

export const GetPurchaseOrdersQuerySchema = z.object({
  query: z.object({
    status: z.nativeEnum(PurchaseOrderStatus).optional(),
    supplierId: z.string().cuid().optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  }),
})

export const SubmitForApprovalSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    purchaseOrderId: z.string().cuid(),
  }),
})

export const ApprovePurchaseOrderSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    purchaseOrderId: z.string().cuid(),
  }),
  body: z.object({
    autoSend: z.boolean().default(false), // Automatically send to supplier after approval
  }),
})

export const RejectPurchaseOrderSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    purchaseOrderId: z.string().cuid(),
  }),
  body: z.object({
    reason: z.string().min(1, 'Rejection reason is required'),
  }),
})

export const TransitionPurchaseOrderStatusSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    purchaseOrderId: z.string().cuid(),
  }),
  body: z.object({
    newStatus: z.nativeEnum(PurchaseOrderStatus),
    reason: z.string().optional(),
    notes: z.string().optional(),
  }),
})

// ==========================================
// PRICING POLICY SCHEMAS
// ==========================================

export const CreatePricingPolicySchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    productId: z.string().cuid(),
  }),
  body: z.object({
    pricingStrategy: z.nativeEnum(PricingStrategy),
    targetFoodCostPercentage: z.number().min(0).max(100).optional(),
    targetMarkupPercentage: z.number().min(0).optional(),
    minimumPrice: z.number().min(0).optional(),
  }),
})

export const UpdatePricingPolicySchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    productId: z.string().cuid(),
  }),
  body: z.object({
    pricingStrategy: z.nativeEnum(PricingStrategy).optional(),
    targetFoodCostPercentage: z.number().min(0).max(100).optional(),
    targetMarkupPercentage: z.number().min(0).optional(),
    minimumPrice: z.number().min(0).optional(),
    currentPrice: z.number().min(0).optional(),
  }),
})

export const CalculatePriceSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    productId: z.string().cuid(),
  }),
})

// ==========================================
// ALERT SCHEMAS
// ==========================================

export const GetAlertsQuerySchema = z.object({
  query: z.object({
    status: z.nativeEnum(AlertStatus).optional(),
    alertType: z.nativeEnum(AlertType).optional(),
  }),
})

export const AcknowledgeAlertSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    alertId: z.string().cuid(),
  }),
})

export const ResolveAlertSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    alertId: z.string().cuid(),
  }),
})

// ==========================================
// REPORT SCHEMAS
// ==========================================

export const GetPMIXReportSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
  query: z
    .object({
      startDate: z.string().datetime(),
      endDate: z.string().datetime(),
    })
    .refine(
      data => {
        return new Date(data.endDate) > new Date(data.startDate)
      },
      {
        message: 'End date must be after start date',
        path: ['endDate'],
      },
    ),
})

export const GetProfitabilityReportSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
  query: z.object({
    categoryId: z.string().cuid().optional(),
  }),
})

export const GetIngredientUsageReportSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
  query: z
    .object({
      startDate: z.string().datetime(),
      endDate: z.string().datetime(),
      rawMaterialId: z.string().cuid().optional(),
    })
    .refine(
      data => {
        return new Date(data.endDate) > new Date(data.startDate)
      },
      {
        message: 'End date must be after start date',
        path: ['endDate'],
      },
    ),
})

// ==========================================
// COMMON SCHEMAS
// ==========================================

export const VenueIdParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
})

export const RawMaterialIdParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    rawMaterialId: z.string().cuid(),
  }),
})

export const SupplierIdParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    supplierId: z.string().cuid(),
  }),
})

export const PurchaseOrderIdParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    purchaseOrderId: z.string().cuid(),
  }),
})

export const ProductIdParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    productId: z.string().cuid(),
  }),
})

// ==========================================
// PRODUCT WIZARD SCHEMAS (NEW)
// ==========================================

export const InventoryTypeEnum = z.enum(['NONE', 'SIMPLE_STOCK', 'RECIPE_BASED'])

export const ProductWizardStep1Schema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
  body: z.object({
    name: z.string().min(1, 'Product name is required'),
    description: z.string().optional(),
    price: z.number().positive('Price must be positive'),
    categoryId: z.string().cuid('Valid category ID is required'),
    imageUrl: z.union([z.string().url(), z.literal('')]).optional(),
  }),
})

export const ProductWizardStep2Schema = z.object({
  params: z.object({
    productId: z.string().cuid(),
  }),
  body: z
    .object({
      useInventory: z.boolean(),
      inventoryType: InventoryTypeEnum.optional(),
    })
    .refine(
      data => {
        // If useInventory is true, inventoryType must be provided
        if (data.useInventory && !data.inventoryType) {
          return false
        }
        return true
      },
      {
        message: 'Inventory type is required when useInventory is true',
        path: ['inventoryType'],
      },
    ),
})

export const ProductWizardStep3SimpleStockSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    productId: z.string().cuid(),
  }),
  body: z.object({
    initialStock: z.number().min(0, 'Initial stock must be non-negative'),
    reorderPoint: z.number().min(0, 'Reorder point must be non-negative'),
    costPerUnit: z.number().positive('Cost per unit must be positive'),
  }),
})

export const ProductWizardStep3RecipeSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    productId: z.string().cuid(),
  }),
  body: z.object({
    portionYield: z.number().int().positive('Portion yield must be positive'),
    prepTime: z.number().int().positive().nullish(), // Accept null or undefined
    cookTime: z.number().int().positive().nullish(), // Accept null or undefined
    notes: z.string().optional(),
    ingredients: z
      .array(
        z.object({
          rawMaterialId: z.string().cuid(),
          quantity: z.number().positive('Quantity must be positive'),
          unit: z.nativeEnum(Unit),
          isOptional: z.boolean().default(false),
          substituteNotes: z.string().optional(),
        }),
      )
      .min(1, 'At least one ingredient is required'),
  }),
})

export const CreateProductWithInventorySchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
  body: z.object({
    product: z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      price: z.number().positive(),
      categoryId: z.string().cuid(),
      imageUrl: z.union([z.string().url(), z.literal('')]).optional(),
    }),
    inventory: z.object({
      useInventory: z.boolean(),
      inventoryType: InventoryTypeEnum.optional(),
    }),
    simpleStock: z
      .object({
        initialStock: z.number().min(0),
        reorderPoint: z.number().min(0),
        costPerUnit: z.number().positive(),
      })
      .optional(),
    recipe: z
      .object({
        portionYield: z.number().int().positive(),
        prepTime: z.number().int().positive().nullish(), // Accept null or undefined
        cookTime: z.number().int().positive().nullish(), // Accept null or undefined
        notes: z.string().optional(),
        ingredients: z.array(
          z.object({
            rawMaterialId: z.string().cuid(),
            quantity: z.number().positive(),
            unit: z.nativeEnum(Unit),
            isOptional: z.boolean().default(false),
            substituteNotes: z.string().optional(),
          }),
        ),
      })
      .optional(),
  }),
})

export const GetWizardProgressSchema = z.object({
  params: z.object({
    productId: z.string().cuid(),
  }),
})

export const SetProductInventoryTypeSchema = z.object({
  params: z.object({
    productId: z.string().cuid(),
  }),
  body: z.object({
    inventoryType: InventoryTypeEnum,
  }),
})

export const PreviewCostChangeSchema = z.object({
  params: z.object({
    rawMaterialId: z.string().cuid(),
  }),
  query: z.object({
    proposedNewCost: z
      .string()
      .transform(val => Number(val))
      .pipe(z.number().positive()),
  }),
})

export const TriggerCostRecalculationSchema = z.object({
  params: z.object({
    rawMaterialId: z.string().cuid(),
  }),
  body: z.object({
    oldCost: z.number().min(0),
    newCost: z.number().min(0),
  }),
})

export const GetRecipeCostVariancesSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
  query: z.object({
    minVariancePercentage: z.string().transform(Number).optional(),
    sort: z.enum(['highest', 'lowest', 'alphabetical']).optional(),
  }),
})

// Type exports for TypeScript
export type CreateRawMaterialDto = z.infer<typeof CreateRawMaterialSchema>['body']
export type UpdateRawMaterialDto = z.infer<typeof UpdateRawMaterialSchema>['body']
export type AdjustStockDto = z.infer<typeof AdjustStockSchema>['body']
export type CreateRecipeDto = z.infer<typeof CreateRecipeSchema>['body']
export type UpdateRecipeDto = z.infer<typeof UpdateRecipeSchema>['body']
export type CreateSupplierDto = z.infer<typeof CreateSupplierSchema>['body']
export type UpdateSupplierDto = z.infer<typeof UpdateSupplierSchema>['body']
export type CreatePurchaseOrderDto = z.infer<typeof CreatePurchaseOrderSchema>['body']
export type UpdatePurchaseOrderDto = z.infer<typeof UpdatePurchaseOrderSchema>['body']
export type ReceivePurchaseOrderDto = z.infer<typeof ReceivePurchaseOrderSchema>['body']
export type CreatePricingPolicyDto = z.infer<typeof CreatePricingPolicySchema>['body']
export type UpdatePricingPolicyDto = z.infer<typeof UpdatePricingPolicySchema>['body']

// NEW: Product Wizard type exports
export type ProductWizardStep1Dto = z.infer<typeof ProductWizardStep1Schema>['body']
export type ProductWizardStep2Dto = z.infer<typeof ProductWizardStep2Schema>['body']
export type ProductWizardStep3SimpleStockDto = z.infer<typeof ProductWizardStep3SimpleStockSchema>['body']
export type ProductWizardStep3RecipeDto = z.infer<typeof ProductWizardStep3RecipeSchema>['body']
export type CreateProductWithInventoryDto = z.infer<typeof CreateProductWithInventorySchema>['body']
