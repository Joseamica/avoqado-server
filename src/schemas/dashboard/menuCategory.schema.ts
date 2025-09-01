import { z } from 'zod'

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/ // HH:mm format
const DAYS_OF_WEEK = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const

export const MenuCategorySchema = z.object({
  id: z.string().cuid(),
  venueId: z.string().cuid(),
  name: z.string().min(1, 'Name is required'),
  description: z.string().nullable().optional(),
  slug: z.string(),
  displayOrder: z.number().int().default(0),
  imageUrl: z.string().url().nullable().optional(),
  color: z.string().nullable().optional(), // Could add hex validation
  icon: z.string().nullable().optional(),
  parentId: z.string().cuid().nullable().optional(),
  active: z.boolean().default(true),
  availableFrom: z.string().regex(TIME_REGEX, 'Invalid time format. Expected HH:mm').nullable().optional(),
  availableUntil: z.string().regex(TIME_REGEX, 'Invalid time format. Expected HH:mm').nullable().optional(),
  availableDays: z.array(z.enum(DAYS_OF_WEEK)).nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const CreateMenuCategorySchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required'),
    description: z.string().optional().nullable(), // Ensure nullable aligns with Prisma optional strings
    displayOrder: z.number().int().optional(),
    imageUrl: z.string().url().optional().nullable(),
    color: z.string().optional().nullable(),
    icon: z.string().optional().nullable(),
    parentId: z.string().cuid().optional().nullable(), // This can be string (cuid) or null
    active: z.boolean().optional(),
    availableFrom: z.union([z.string().regex(TIME_REGEX, 'Invalid time format. Expected HH:mm'), z.null()]).optional(),
    availableUntil: z.union([z.string().regex(TIME_REGEX, 'Invalid time format. Expected HH:mm'), z.null()]).optional(),
    availableDays: z.array(z.enum(DAYS_OF_WEEK)).max(7).optional().nullable(),
    avoqadoMenus: z
      .array(
        z.object({
          value: z.string().cuid(),
          label: z.string(),
          disabled: z.boolean().optional(),
        }),
      )
      .optional(),
    avoqadoProducts: z
      .array(
        z.object({
          value: z.string().cuid(),
          label: z.string(),
          disabled: z.boolean().optional(),
        }),
      )
      .optional(),
  }),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
})
export type CreateMenuCategoryDto = z.infer<typeof CreateMenuCategorySchema>['body']

export const UpdateMenuCategorySchema = z.object({
  body: CreateMenuCategorySchema.shape.body.partial(), // All fields optional
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
    categoryId: z.string().cuid('Invalid category ID format'),
  }),
})
export type UpdateMenuCategoryDto = z.infer<typeof UpdateMenuCategorySchema>['body']

// Schema for validating just the parameters for routes like GET /:venueId/menucategories/:categoryId
export const GetMenuCategoryParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
    categoryId: z.string().cuid('Invalid category ID format'),
  }),
})

// Schema for validating venueId param, used in list or top-level POST for a venue
export const VenueIdParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
})

export const ReorderMenuCategoriesSchema = z.object({
  body: z
    .array(
      z.object({
        id: z.string().cuid(),
        displayOrder: z.number().int(),
      }),
    )
    .min(1, 'At least one category must be provided for reordering'),
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
})
export type ReorderMenuCategoriesDto = z.infer<typeof ReorderMenuCategoriesSchema>['body']
