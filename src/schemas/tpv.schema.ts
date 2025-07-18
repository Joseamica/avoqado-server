import { z } from 'zod'

export const venueIdParamSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
})

export const serialNumberParamSchema = z.object({
  params: z.object({
    serialNumber: z.string().min(1, { message: 'El número de serie es requerido.' }),
  }),
})

export const orderParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    orderId: z.string().cuid({ message: 'El ID del order debe ser un CUID válido.' }),
  }),
})

// Payments schemas
export const paymentsQuerySchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  query: z.object({
    pageSize: z.string().optional().default('10'),
    pageNumber: z.string().optional().default('1'),
  }),
  body: z.object({
    fromDate: z.string().datetime().optional(),
    toDate: z.string().datetime().optional(),
    waiterId: z.string().optional(),
  }).optional(),
})

// Shifts schemas
export const shiftQuerySchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  query: z.object({
    pos_name: z.string().optional(),
  }),
})

export const shiftsQuerySchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  query: z.object({
    pageSize: z.string().optional().default('10'),
    pageNumber: z.string().optional().default('1'),
    waiterId: z.string().optional(),
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional(),
  }),
})

export const shiftsSummaryQuerySchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
  query: z.object({
    waiterId: z.string().optional(),
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional(),
  }),
})
