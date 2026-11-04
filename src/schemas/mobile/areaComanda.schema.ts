/**
 * D2 de vales (3-nov-2026): el POS apaga o prende la comanda del área que este aparato emite, desde «Impresoras y cajón».
 * Va aparte del papel del aparato (Codex r1 #2–#4): son dos decisiones distintas y un guardado no debe pisar la otra.
 */
import { z } from 'zod'

/** PUT /mobile/venues/:venueId/fulfillment-areas/:areaId/comanda */
export const areaComandaSchema = z.object({
  params: z.object({ venueId: z.string().min(1), areaId: z.string().min(1, 'El área es requerida') }),
  body: z
    .object({ sendsComanda: z.boolean({ required_error: 'Dime si manda comanda.', invalid_type_error: 'Dime si manda comanda.' }) })
    .strict({ message: 'La comanda del área trae un dato de más.' }),
})
