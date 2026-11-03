/**
 * Zod del papel del aparato en los vales (D3). Sólo la forma: que el área sea del negocio y esté activa lo decide el
 * servicio (`assertArea` dentro de `updateTerminal`).
 */
import { z } from 'zod'

const DATO_DE_MAS = { message: 'El papel del aparato trae un dato de más.' }

/** PUT /mobile/venues/:venueId/terminals/:terminalId/area-role */
export const areaRoleSchema = z.object({
  body: z.discriminatedUnion(
    'role',
    [
      z.object({ role: z.literal('CHECKOUT') }).strict(DATO_DE_MAS),
      z
        .object({
          role: z.literal('ISSUE'),
          fulfillmentAreaId: z.string({ required_error: 'Elige el área del vale.' }).min(1, 'Elige el área del vale.'),
        })
        .strict(DATO_DE_MAS),
    ],
    { errorMap: () => ({ message: 'El papel del aparato no es válido.' }) },
  ),
})
