// src/schemas/dashboard/tenderType.schema.ts

/**
 * Zod schemas for the VenueTenderType catalog endpoints.
 * Shape/format only (Spanish messages — users see them raw); business rules
 * (system-row immutability, SAT whitelist, optimistic concurrency) live in
 * src/services/dashboard/tenderType.dashboard.service.ts.
 */

import { z } from 'zod'

export const tenderTypeVenueParamsSchema = z.object({
  venueId: z.string().min(1, 'El venue es requerido'),
})

export const tenderTypeParamsSchema = z.object({
  venueId: z.string().min(1, 'El venue es requerido'),
  tenderTypeId: z.string().min(1, 'El tipo de pago es requerido'),
})

const posSectionSchema = z.enum(['PRIMARY', 'MORE'], { errorMap: () => ({ message: 'La sección debe ser PRIMARY o MORE' }) })

export const createTenderTypeBodySchema = z.object({
  name: z.string().min(1, 'El nombre es requerido').max(80, 'El nombre no puede exceder 80 caracteres'),
  countsAsPhysicalCash: z.boolean().optional(),
  captureTip: z.boolean().optional(),
  showOnPos: z.boolean().optional(),
  posSection: posSectionSchema.optional(),
  commissionPercent: z.number({ invalid_type_error: 'La comisión debe ser un número' }).nullable().optional(),
  satFormaPago: z
    .string()
    .regex(/^\d{2}$/, 'La forma SAT debe ser una clave de dos dígitos')
    .nullable()
    .optional(),
  linkedOrderSource: z.string().max(40, 'Canal inválido').nullable().optional(),
})

export const updateTenderTypeBodySchema = z.object({
  // Optimistic concurrency: the money-semantic revision the editor was looking at.
  expectedRevision: z.number({ invalid_type_error: 'La revisión es requerida' }).int('La revisión debe ser un entero').min(1),
  name: z.string().min(1, 'El nombre es requerido').max(80, 'El nombre no puede exceder 80 caracteres').optional(),
  countsAsPhysicalCash: z.boolean().optional(),
  captureTip: z.boolean().optional(),
  showOnPos: z.boolean().optional(),
  posSection: posSectionSchema.optional(),
  displayOrder: z.number().int('El orden debe ser un entero').min(0).optional(),
  commissionPercent: z.number({ invalid_type_error: 'La comisión debe ser un número' }).nullable().optional(),
  satFormaPago: z
    .string()
    .regex(/^\d{2}$/, 'La forma SAT debe ser una clave de dos dígitos')
    .nullable()
    .optional(),
  linkedOrderSource: z.string().max(40, 'Canal inválido').nullable().optional(),
  active: z.boolean().optional(),
})
