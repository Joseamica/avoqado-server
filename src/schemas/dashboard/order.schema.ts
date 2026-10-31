import { Order, Table } from '@prisma/client'
import { z } from 'zod'
import { StaffPublico } from '../../utils/staffPublicSelect'

export type PaginatedOrdersResponse = {
  data: (Order & {
    // Nunca `Staff` entero: la fila lleva el hash de la contraseña (30-sep).
    createdBy: StaffPublico | null
    servedBy: StaffPublico | null
    table: Table | null
  })[]
  meta: {
    total: number
    page: number
    pageSize: number
    pageCount: number
  }
}

/**
 * Schema for settling an order's pending balance
 */
export const SettleOrderSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    orderId: z.string().cuid(),
  }),
  body: z.object({
    notes: z.string().max(500).optional(),
  }),
})

/**
 * El motivo de «Cancelar orden» (panel y MCP): obligatorio, va a la bitácora. Sin el carácter nulo: Postgres lo rechaza en
 * `jsonb` y `logAction` se traga el error, así que la cancelación quedaría sin su autor ni su motivo (Codex código r1 #3).
 */
export const motivoDeCancelacionSchema = z
  .string({ required_error: 'Escribe el motivo de la cancelación.' })
  .trim()
  .min(3, 'Escribe el motivo de la cancelación (al menos 3 letras).')
  .max(300, 'El motivo no puede pasar de 300 caracteres.')
  .refine(motivo => !motivo.includes('\u0000'), 'El motivo tiene un carácter que no se puede guardar.')

/** «Cancelar orden» del panel (`cancelarCuentaSinCobrar`). */
export const CancelarCuentaSinCobrarSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    orderId: z.string().cuid(),
  }),
  body: z.object({ reason: motivoDeCancelacionSchema }),
})
