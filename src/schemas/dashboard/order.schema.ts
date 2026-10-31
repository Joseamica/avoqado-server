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
 * Lo que Postgres no guarda en `jsonb` ni en `text`: el carácter nulo y una mitad de un par sustituto (un emoji partido). Es
 * TODA esa familia (Codex «Cancelar orden» código r1 #3 y r2 #1); los emojis enteros sí pasan.
 */
const NO_SE_PUEDE_GUARDAR = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * El motivo de «Cancelar orden» (panel y MCP): obligatorio, va a la bitácora. La cancelación se confirma ANTES de escribir la
 * bitácora y `logAction` se traga su error, así que un motivo que Postgres no guarda dejaría la cuenta sin autor ni motivo.
 */
export const motivoDeCancelacionSchema = z
  .string({ required_error: 'Escribe el motivo de la cancelación.' })
  .trim()
  .min(3, 'Escribe el motivo de la cancelación (al menos 3 letras).')
  .max(300, 'El motivo no puede pasar de 300 caracteres.')
  .refine(motivo => !NO_SE_PUEDE_GUARDAR.test(motivo), 'El motivo tiene un carácter que no se puede guardar.')

/** «Cancelar orden» del panel (`cancelarCuentaSinCobrar`). */
export const CancelarCuentaSinCobrarSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    orderId: z.string().cuid(),
  }),
  body: z.object({ reason: motivoDeCancelacionSchema }),
})
