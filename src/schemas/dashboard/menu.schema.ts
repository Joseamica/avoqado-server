import { z } from 'zod'
import { MenuType, ProductType } from '@prisma/client'

// Common patterns and constants
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/ // HH:mm format
const DAYS_OF_WEEK = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const
const SKU_REGEX = /^[A-Za-z0-9_-]+$/ // Alphanumeric (both cases), underscores, hyphens
const HEX_COLOR_REGEX = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/

// ==========================================
// MENU SCHEMAS
// ==========================================

export const MenuSchema = z.object({
  id: z.string().cuid(),
  venueId: z.string().cuid(),
  name: z.string().min(1, 'Name is required').max(255),
  description: z.string().nullable().optional(),
  type: z.nativeEnum(MenuType),
  displayOrder: z.number().int().min(0).default(0),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
  startDate: z.date().nullable().optional(),
  endDate: z.date().nullable().optional(),
  availableFrom: z.string().regex(TIME_REGEX, 'Invalid time format. Expected HH:mm').nullable().optional(),
  availableUntil: z.string().regex(TIME_REGEX, 'Invalid time format. Expected HH:mm').nullable().optional(),
  availableDays: z.array(z.enum(DAYS_OF_WEEK)).max(7).default([]),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const CreateMenuSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(255),
    description: z.string().optional().nullable(),
    type: z.nativeEnum(MenuType).default(MenuType.REGULAR),
    displayOrder: z.number().int().min(0).optional(),
    isDefault: z.boolean().optional(),
    active: z.boolean().optional(),
    startDate: z.string().datetime().optional().nullable(),
    endDate: z.string().datetime().optional().nullable(),
    availableFrom: z.string().regex(TIME_REGEX, 'Invalid time format. Expected HH:mm').optional().nullable(),
    availableUntil: z.string().regex(TIME_REGEX, 'Invalid time format. Expected HH:mm').optional().nullable(),
    availableDays: z.array(z.enum(DAYS_OF_WEEK)).max(7).optional(),
    categoryIds: z.array(z.string().cuid()).optional(), // Categories to assign to menu
  }),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
})
export type CreateMenuDto = z.infer<typeof CreateMenuSchema>['body']

export const UpdateMenuSchema = z.object({
  body: CreateMenuSchema.shape.body.partial(),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
    menuId: z.string().cuid('Invalid menu ID format'),
  }),
})
export type UpdateMenuDto = z.infer<typeof UpdateMenuSchema>['body']

export const GetMenuParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
    menuId: z.string().cuid('Invalid menu ID format'),
  }),
})

export const CloneMenuSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(255),
    copyCategories: z.boolean().default(true),
    copyProducts: z.boolean().default(true),
    copyModifiers: z.boolean().default(true),
  }),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
    menuId: z.string().cuid('Invalid menu ID format'),
  }),
})
export type CloneMenuDto = z.infer<typeof CloneMenuSchema>['body']

// ==========================================
// PRODUCT SCHEMAS
// ==========================================

export const createProductSchema = z.object({
  body: z.object({
    name: z.string().min(3, 'Product name must be at least 3 characters long'),
    price: z.number().positive('Price must be a positive number'),
    description: z.string().optional(),
    // Add other product fields as necessary
  }),
})

export const ProductSchema = z.object({
  id: z.string().cuid(),
  venueId: z.string().cuid(),
  sku: z.string().regex(SKU_REGEX, 'SKU must contain only letters, numbers, underscores, and hyphens'),
  name: z.string().min(1, 'Name is required').max(255),
  description: z.string().nullable().optional(),
  categoryId: z.string().cuid(),
  type: z.nativeEnum(ProductType),
  price: z.number().positive('Price must be positive').multipleOf(0.01),
  cost: z.number().positive('Cost must be positive').multipleOf(0.01).nullable().optional(),
  taxRate: z.number().min(0).max(1).default(0.16), // 16% default tax
  imageUrl: z.string().url().nullable().optional(),
  displayOrder: z.number().int().min(0).default(0),
  featured: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  allergens: z.array(z.string()).default([]),
  calories: z.number().int().positive().nullable().optional(),
  prepTime: z.number().int().positive().nullable().optional(), // minutes
  cookingNotes: z.string().nullable().optional(),
  trackInventory: z.boolean().default(false),
  unit: z.string().nullable().optional(),
  active: z.boolean().default(true),
  availableFrom: z.date().nullable().optional(),
  availableUntil: z.date().nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const CreateProductSchema = z.object({
  body: z.object({
    sku: z.string().regex(SKU_REGEX, 'SKU must contain only letters, numbers, underscores, and hyphens'),
    name: z.string().min(1, 'Name is required').max(255),
    description: z.string().optional().nullable(),
    categoryId: z.string().cuid('Invalid category ID format'),
    type: z.nativeEnum(ProductType).default(ProductType.FOOD),
    price: z.number().positive('Price must be positive').multipleOf(0.01),
    cost: z.number().positive('Cost must be positive').multipleOf(0.01).optional().nullable(),
    taxRate: z.number().min(0).max(1).optional(),
    imageUrl: z.string().url().nullable().optional(),
    displayOrder: z.number().int().min(0).optional(),
    featured: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    allergens: z.array(z.string()).optional(),
    calories: z.number().int().positive().optional().nullable(),
    prepTime: z.number().int().positive().optional().nullable(),
    cookingNotes: z.string().optional().nullable(),
    trackInventory: z.boolean().optional(),
    unit: z.string().optional().nullable(),
    active: z.boolean().optional(),
    availableFrom: z.string().datetime().optional().nullable(),
    availableUntil: z.string().datetime().optional().nullable(),
    modifierGroupIds: z.array(z.string().cuid()).optional(), // Modifier groups to assign
  }),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
})
export type CreateProductDto = z.infer<typeof CreateProductSchema>['body']

export const UpdateProductSchema = z.object({
  body: CreateProductSchema.shape.body.partial(),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
    productId: z.string().cuid('Invalid product ID format'),
  }),
})
export type UpdateProductDto = z.infer<typeof UpdateProductSchema>['body']

export const GetProductParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
    productId: z.string().cuid('Invalid product ID format'),
  }),
})

// ==========================================
// MODIFIER SCHEMAS
// ==========================================

export const ModifierGroupSchema = z.object({
  id: z.string().cuid(),
  venueId: z.string().cuid(),
  name: z.string().min(1, 'Name is required').max(255),
  description: z.string().nullable().optional(),
  required: z.boolean().default(false),
  allowMultiple: z.boolean().default(false),
  minSelections: z.number().int().min(0).default(0),
  maxSelections: z.number().int().positive().nullable().optional(),
  displayOrder: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const CreateModifierGroupSchema = z.object({
  body: z
    .object({
      name: z.string().min(1, 'Name is required').max(255),
      description: z.string().optional().nullable(),
      required: z.boolean().optional(),
      allowMultiple: z.boolean().optional(),
      minSelections: z.number().int().min(0).optional(),
      maxSelections: z.number().int().positive().optional().nullable(),
      displayOrder: z.number().int().min(0).optional(),
      active: z.boolean().optional(),
      modifiers: z
        .array(
          z.object({
            name: z.string().min(1, 'Modifier name is required').max(255),
            price: z.number().min(0).multipleOf(0.01).default(0),
            active: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .refine(
      data => {
        // Validation: if maxSelections is provided, it should be >= minSelections
        if (data.maxSelections && data.minSelections) {
          return data.maxSelections >= data.minSelections
        }
        return true
      },
      {
        message: 'maxSelections must be greater than or equal to minSelections',
      },
    ),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
})
export type CreateModifierGroupDto = z.infer<typeof CreateModifierGroupSchema>['body']

export const UpdateModifierGroupSchema = z.object({
  body: z
    .object({
      name: z.string().min(1, 'Name is required').max(255).optional(),
      description: z.string().nullable().optional(),
      required: z.boolean().optional(),
      allowMultiple: z.boolean().optional(),
      minSelections: z.number().int().min(0).optional(),
      maxSelections: z.number().int().min(1).nullable().optional(),
      displayOrder: z.number().int().min(0).optional(),
      active: z.boolean().optional(),
      modifiers: z
        .array(
          z.object({
            name: z.string().min(1, 'Modifier name is required').max(255),
            price: z.number().min(0).multipleOf(0.01).default(0),
            active: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .refine(
      data => {
        // Validation: if maxSelections is provided, it should be >= minSelections
        if (data.maxSelections && data.minSelections) {
          return data.maxSelections >= data.minSelections
        }
        return true
      },
      {
        message: 'maxSelections must be greater than or equal to minSelections',
      },
    ),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
    modifierGroupId: z.string().cuid('Invalid modifier group ID format'),
  }),
})
export type UpdateModifierGroupDto = z.infer<typeof UpdateModifierGroupSchema>['body']

export const ModifierSchema = z.object({
  id: z.string().cuid(),
  groupId: z.string().cuid(),
  name: z.string().min(1, 'Name is required').max(255),
  price: z.number().min(0).multipleOf(0.01).default(0),
  active: z.boolean().default(true),
})

export const CreateModifierSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(255),
    price: z.number().min(0).multipleOf(0.01).default(0),
    active: z.boolean().optional(),
  }),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
    modifierGroupId: z.string().cuid('Invalid modifier group ID format'),
  }),
})
export type CreateModifierDto = z.infer<typeof CreateModifierSchema>['body']

export const UpdateModifierSchema = z.object({
  body: CreateModifierSchema.shape.body.partial(),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
    modifierGroupId: z.string().cuid('Invalid modifier group ID format'),
    modifierId: z.string().cuid('Invalid modifier ID format'),
  }),
})
export type UpdateModifierDto = z.infer<typeof UpdateModifierSchema>['body']

// ==========================================
// ASSIGNMENT SCHEMAS
// ==========================================

export const MenuCategoryAssignmentSchema = z.object({
  id: z.string().cuid(),
  menuId: z.string().cuid(),
  categoryId: z.string().cuid(),
  displayOrder: z.number().int().min(0).default(0),
})

export const AssignCategoryToMenuSchema = z.object({
  body: z.object({
    categoryId: z.string().cuid('Invalid category ID format'),
    displayOrder: z.number().int().min(0).optional(),
  }),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
    menuId: z.string().cuid('Invalid menu ID format'),
  }),
})
export type AssignCategoryToMenuDto = z.infer<typeof AssignCategoryToMenuSchema>['body']

export const ProductModifierGroupAssignmentSchema = z.object({
  id: z.string().cuid(),
  productId: z.string().cuid(),
  groupId: z.string().cuid(),
  displayOrder: z.number().int().min(0).default(0),
})

export const AssignModifierGroupToProductSchema = z.object({
  body: z.object({
    modifierGroupId: z.string().cuid('Invalid modifier group ID format'),
    displayOrder: z.number().int().min(0).optional(),
  }),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
    productId: z.string().cuid('Invalid product ID format'),
  }),
})
export type AssignModifierGroupToProductDto = z.infer<typeof AssignModifierGroupToProductSchema>['body']

// Params schema for removing a modifier group assignment from a product
export const RemoveModifierGroupFromProductParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
    productId: z.string().cuid('Invalid product ID format'),
    modifierGroupId: z.string().cuid('Invalid modifier group ID format'),
  }),
})

// ==========================================
// QUERY SCHEMAS
// ==========================================

export const MenuQuerySchema = z.object({
  query: z.object({
    page: z
      .string()
      .transform(val => parseInt(val, 10))
      .pipe(z.number().int().min(1))
      .optional(),
    limit: z
      .string()
      .transform(val => parseInt(val, 10))
      .pipe(z.number().int().min(1).max(100))
      .optional(),
    search: z.string().optional(),
    active: z
      .string()
      .transform(val => val === 'true')
      .pipe(z.boolean())
      .optional(),
    type: z.nativeEnum(MenuType).optional(),
    sortBy: z.enum(['name', 'displayOrder', 'createdAt', 'updatedAt']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  }),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
})

export const ProductQuerySchema = z.object({
  query: z.object({
    page: z
      .string()
      .transform(val => parseInt(val, 10))
      .pipe(z.number().int().min(1))
      .optional(),
    limit: z
      .string()
      .transform(val => parseInt(val, 10))
      .pipe(z.number().int().min(1).max(100))
      .optional(),
    search: z.string().optional(),
    active: z
      .string()
      .transform(val => val === 'true')
      .pipe(z.boolean())
      .optional(),
    categoryId: z.string().cuid().optional(),
    type: z.nativeEnum(ProductType).optional(),
    featured: z
      .string()
      .transform(val => val === 'true')
      .pipe(z.boolean())
      .optional(),
    sortBy: z.enum(['name', 'price', 'displayOrder', 'createdAt', 'updatedAt']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  }),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
})

export const ModifierGroupQuerySchema = z.object({
  query: z.object({
    page: z
      .string()
      .transform(val => parseInt(val, 10))
      .pipe(z.number().int().min(1))
      .optional(),
    limit: z
      .string()
      .transform(val => parseInt(val, 10))
      .pipe(z.number().int().min(1).max(100))
      .optional(),
    search: z.string().optional(),
    active: z
      .string()
      .transform(val => val === 'true')
      .pipe(z.boolean())
      .optional(),
    sortBy: z.enum(['name', 'displayOrder', 'createdAt', 'updatedAt']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  }),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
})

// ==========================================
// BULK OPERATIONS SCHEMAS
// ==========================================

export const ReorderMenusSchema = z.object({
  body: z
    .array(
      z.object({
        id: z.string().cuid(),
        displayOrder: z.number().int().min(0),
      }),
    )
    .min(1, 'At least one menu must be provided for reordering'),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
})
export type ReorderMenusDto = z.infer<typeof ReorderMenusSchema>['body']

export const ReorderProductsSchema = z.object({
  body: z
    .array(
      z.object({
        id: z.string().cuid(),
        displayOrder: z.number().int().min(0),
      }),
    )
    .min(1, 'At least one product must be provided for reordering'),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
})
export type ReorderProductsDto = z.infer<typeof ReorderProductsSchema>['body']

export const BulkUpdateProductsSchema = z.object({
  body: z.object({
    productIds: z.array(z.string().cuid()).min(1, 'At least one product ID is required'),
    updates: z
      .object({
        active: z.boolean().optional(),
        categoryId: z.string().cuid().optional(),
        price: z.number().positive().multipleOf(0.01).optional(),
        featured: z.boolean().optional(),
      })
      .refine(data => Object.keys(data).length > 0, {
        message: 'At least one field must be provided for bulk update',
      }),
  }),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
})
export type BulkUpdateProductsDto = z.infer<typeof BulkUpdateProductsSchema>['body']

// ==========================================
// COMMON PARAMETER SCHEMAS
// ==========================================

export const VenueIdParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
})

export const GetModifierGroupParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
    modifierGroupId: z.string().cuid('Invalid modifier group ID format'),
  }),
})

export const GetModifierParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
    modifierGroupId: z.string().cuid('Invalid modifier group ID format'),
    modifierId: z.string().cuid('Invalid modifier ID format'),
  }),
})
