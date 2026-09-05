import { z } from 'zod'

/**
 * 🔴 CORREGIR UN TURNO NO ES CAMBIARLE EL CICLO DE VIDA.
 *
 * `PUT /dashboard/venues/:venueId/shifts/:shiftId` es el back-office del gerente: sirve para
 * corregir NÚMEROS de un corte, no para reabrirlo, moverle las horas ni reasignarlo. Hasta el
 * 4-sep-2026 la ruta no llevaba `validateRequest` y el servicio copiaba `status`, `endTime`,
 * `startTime` y `staffId` verbatim del cuerpo, con dos consecuencias medidas:
 *
 *   · `{"status":"OPEN"}` sobre un turno cerrado deja `status='OPEN'` **con `endTime` puesto**.
 *     Las tres lecturas del turno vivo exigen `endTime: null`, así que nadie lo ve — pero el único
 *     parcial `Shift(venueId) WHERE status='OPEN'` sí: abrir turno o caja devuelve **409
 *     `CASH_SHIFT_ALREADY_OPEN` para siempre**. El negocio se queda sin poder abrir caja.
 *   · `{"endTime": null}` sobre un turno cerrado de hoy lo hace pasar por abierto ante la PAX
 *     mientras `turnoAbiertoDelNegocio` sigue devolviendo `null` ⇒ el día entero cobra sin turno.
 *
 * 🔴 SE RECHAZA CON 400, NO SE DESCARTA EN SILENCIO. Un `strip` devolvería 200 sobre una
 * reapertura que nunca ocurrió, y quien la pidió se iría creyendo que funcionó. Se puede hacer
 * porque **ningún cliente manda esos campos**: los dos únicos consumidores de esta ruta son
 * `avoqado-web-dashboard` (`src/pages/Shift/ShiftId.tsx:686` y `src/pages/Shift/Shifts.tsx:151`),
 * y los dos mandan exactamente `{ totalSales, totalTips }`.
 *
 * Lo desconocido sí se descarta (Zod hace `strip` por defecto): una llave de más de un cliente
 * futuro no puede tumbar una corrección legítima.
 *
 * 🔴 Zod es la FORMA. La REGLA («nunca reabrir») vive además en `updateShift`, porque a un
 * servicio se le llama sin pasar por la ruta.
 */

/** Un campo que esta ruta NO acepta: presente con cualquier valor (incluido `null`) ⇒ 400. */
const rechazado = (mensaje: string) => z.undefined({ invalid_type_error: mensaje, required_error: mensaje }).optional()

/** Dinero en PESOS, 1:1. `finite()` corta NaN/Infinity antes de que envenenen un `Decimal`. */
const pesos = () => z.number({ invalid_type_error: 'El importe debe ser un número' }).finite('El importe debe ser un número válido')

export const UpdateShiftSchema = z.object({
  body: z.object({
    // ── Lo que un gerente corrige de verdad ────────────────────────────────────────────────
    startingCash: pesos().optional(),
    /** `null` = «se borra el conteo», que es lo que hoy pone `cashDifference` en NULL. */
    endingCash: pesos().nullable().optional(),
    totalSales: pesos().optional(),
    totalTips: pesos().optional(),
    totalOrders: z
      .number({ invalid_type_error: 'El número de órdenes debe ser un número' })
      .int('El número de órdenes debe ser entero')
      .optional(),
    /**
     * A quién se le atribuye el corte. La FK sólo exige que el `Staff` exista, así que la
     * pertenencia al negocio la comprueba `updateShift` contra `StaffVenue` (P2.3).
     */
    staffId: z.string().min(1, 'El identificador del empleado no puede ir vacío').optional(),

    // ── Ciclo de vida: NO se toca desde aquí ───────────────────────────────────────────────
    status: rechazado('No se puede cambiar el estado del turno desde aquí: ciérralo o ábrelo desde la caja'),
    endTime: rechazado('No se puede cambiar la hora de cierre del turno desde aquí'),
    startTime: rechazado('No se puede cambiar la hora de apertura del turno desde aquí'),
  }),
})
