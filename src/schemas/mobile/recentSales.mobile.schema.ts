import { z } from 'zod'

export const RECENT_SALES_PAGE_MAX = 100
export const RECENT_SALES_COPY_VERSION = 1

export interface SalesSince {
  v: number
  w: number
  ws: number
}

export interface SalesCursor {
  v: number
  m: 'F' | 'D'
  t0: number
  ws: number
  w: number | null
  ws0: number | null
  total: number
  at: number
  id: string
}

const sinceTokenSchema = z.object({
  v: z.number().finite(),
  w: z.number().finite(),
  ws: z.number().finite(),
})

const cursorTokenSchema = z.object({
  v: z.literal(RECENT_SALES_COPY_VERSION),
  m: z.enum(['F', 'D']),
  t0: z.number().finite(),
  ws: z.number().finite(),
  w: z.number().finite().nullable(),
  ws0: z.number().finite().nullable(),
  total: z.number().finite(),
  at: z.number().finite(),
  id: z.string().max(64),
})

export function encodeSalesSince(s: SalesSince): string {
  return Buffer.from(JSON.stringify(s)).toString('base64url')
}

export function decodeSalesSince(token: string): SalesSince | null {
  try {
    const result = sinceTokenSchema.safeParse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export function encodeSalesCursor(c: SalesCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url')
}

export function decodeSalesCursor(token: string): SalesCursor | null {
  try {
    const result = cursorTokenSchema.safeParse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

const SINCE_MESSAGE = 'El sello no es válido.'
const CURSOR_MESSAGE = 'El cursor no es válido.'
const LIMIT_MESSAGE = 'El límite debe ser un número entero positivo.'

export const recentSalesQuerySchema = z.object({
  params: z.object({
    venueId: z
      .string({
        required_error: 'El identificador de la sucursal no es válido.',
        invalid_type_error: 'El identificador de la sucursal no es válido.',
      })
      .cuid('El identificador de la sucursal no es válido.'),
  }),
  query: z
    .object({
      since: z.string({ invalid_type_error: SINCE_MESSAGE }).max(512, SINCE_MESSAGE).optional(),
      cursor: z
        .string({ invalid_type_error: CURSOR_MESSAGE })
        .max(512, CURSOR_MESSAGE)
        .refine(value => decodeSalesCursor(value) !== null, CURSOR_MESSAGE)
        .optional(),
      limit: z.coerce
        .number({ invalid_type_error: LIMIT_MESSAGE })
        .finite(LIMIT_MESSAGE)
        .int(LIMIT_MESSAGE)
        .min(1, LIMIT_MESSAGE)
        .default(RECENT_SALES_PAGE_MAX)
        .transform(value => Math.min(value, RECENT_SALES_PAGE_MAX)),
    })
    .refine(value => value.since === undefined || value.cursor === undefined, 'Manda since o cursor, no los dos.'),
})

export type RecentSalesQuery = z.infer<typeof recentSalesQuerySchema>['query']
