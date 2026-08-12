/**
 * Zod del cobro externo (settlementRoute EXTERNAL) para el namespace /mobile.
 * Shape/formato aquí, en español; las reglas de negocio (¿ya está confirmado?,
 * ¿es un vale de ruta EXTERNAL?, ¿ya se declaró "no cobrado"?) viven en
 * `areaTicketExternal.mobile.service.ts` y no se duplican aquí.
 */
import { z } from 'zod'

/**
 * Importes que cruzan esta ruta viajan como decimal string de dos posiciones,
 * en pesos 1:1 (`.claude/rules/critical-warnings.md`). Sin signo a propósito:
 * un cobro real en la caja externa nunca es negativo, así que "-168.00" se
 * rechaza aquí en vez de colarse.
 *
 * Este regex es el hueco que dejó abierto la revisión de la Task 7: sin él, un
 * `externalAmount` basura ("abc", "Infinity", "-50.00", "168.000") llega hasta
 * `new Prisma.Decimal(...)` dentro del servicio y revienta con un
 * `[DecimalError]` crudo → 500 en inglés. Esto no sustituye la cuantización a
 * 2 decimales que YA hace el servicio (`confirmExternalSettlement`,
 * `ROUND_HALF_UP`) — la complementa, cortando la basura en la puerta antes de
 * que llegue ahí.
 */
const decimalPesos = z.string().regex(/^\d+\.\d{2}$/, 'El importe debe ser un número positivo con dos decimales, por ejemplo "168.00".')

/**
 * `idempotencyKey` es requerida en las tres mutaciones (handoff, confirm,
 * not-charged) — mismo límite que la columna `AreaTicketExternalSettlement.idempotencyKey`
 * (`@db.VarChar(64)`, `prisma/schema.prisma:13579`).
 *
 * 🔴 `required_error` es necesario, no decorativo: sin él, un body sin la
 * llave (`{}`) dispara el mensaje EN INGLÉS por default de Zod ("Required")
 * porque falta el chequeo de tipo pasa ANTES que `.min()` — `.min()` sólo
 * corre si el valor ya es un string. Verificado corriendo Zod directo:
 * `z.string().min(1, 'mensaje').safeParse({}).error` devuelve
 * `{ message: 'Required' }`, no el mensaje en español del `.min()`.
 */
const idempotencyKeySchema = z
  .string({ required_error: 'La llave de idempotencia es requerida.' })
  .min(1, 'La llave de idempotencia es requerida.')
  .max(64, 'La llave de idempotencia no puede exceder 64 caracteres.')

/** POST /mobile/venues/:venueId/area-tickets/:ticketId/external-settlement/handoff */
export const handoffSchema = z.object({
  body: z.object({
    idempotencyKey: idempotencyKeySchema,
  }),
})

/** POST /mobile/venues/:venueId/area-tickets/:ticketId/external-settlement/confirm */
export const confirmExternalSettlementSchema = z.object({
  body: z.object({
    idempotencyKey: idempotencyKeySchema,
    externalAmount: decimalPesos.optional().nullable(),
    externalReference: z.string().max(120, 'La referencia no puede exceder 120 caracteres.').optional().nullable(),
    notes: z.string().max(500, 'Las notas no pueden exceder 500 caracteres.').optional().nullable(),
  }),
})

/** POST /mobile/venues/:venueId/area-tickets/:ticketId/external-settlement/not-charged */
export const notChargedSchema = z.object({
  body: z.object({
    idempotencyKey: idempotencyKeySchema,
    // Igual que `idempotencyKey`: `required_error` para que un body sin `reason`
    // caiga en español, no en el "Required" default de Zod. El servicio vuelve a
    // validar esto (`REASON_REQUIRED`) porque es una afirmación que alguien va a
    // auditar — la doble verificación aquí sólo evita el viaje redondo a la capa
    // de servicio para el caso más común (campo vacío u omitido).
    reason: z
      .string({ required_error: 'Escribe por qué este vale no se cobró en la caja externa.' })
      .min(1, 'Escribe por qué este vale no se cobró en la caja externa.')
      .max(500, 'El motivo no puede exceder 500 caracteres.'),
  }),
})
