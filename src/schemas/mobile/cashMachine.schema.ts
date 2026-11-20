import { z } from 'zod'

import { CASH_MACHINE_REF, DESENLACES_DE_LA_MAQUINA } from '../../services/cashMachine/ventaDeLaMaquina'

/**
 * Máquina de efectivo (fase 1a, R4-1): la forma de lo que sube la PC. Sólo la forma: si los importes son POSIBLES lo decide el
 * servicio (`validarCierre`), que guarda lo imposible como incidencia (422) en vez de perderlo en un 400.
 */
const venueId = z
  .string({ required_error: 'El negocio es requerido', invalid_type_error: 'El negocio debe ser un texto' })
  .cuid('El identificador del negocio no es válido')

const referenceCC = z
  .string({ required_error: 'El folio de la máquina es requerido', invalid_type_error: 'El folio de la máquina debe ser un texto' })
  .regex(CASH_MACHINE_REF, 'El folio de la máquina debe ser AQ seguido de 12 letras mayúsculas o números')

const centavos = (campo: string) =>
  z
    .number({ required_error: `${campo} es requerido`, invalid_type_error: `${campo} debe ser un número de centavos` })
    .finite(`${campo} debe ser un número de centavos`)

const cierre = z
  .object({
    outcome: z.enum(DESENLACES_DE_LA_MAQUINA, {
      errorMap: () => ({ message: 'El desenlace de la máquina debe ser PAGADO, CANCELADO o GUARDADO' }),
    }),
    dueCents: centavos('El adeudo'),
    saleCents: centavos('La venta'),
    tipCents: centavos('La propina'),
    creditCents: centavos('Lo que entró'),
    changeDispensedCents: centavos('El cambio entregado'),
    occurredAt: z
      .string({ invalid_type_error: 'La hora del cierre debe ser texto' })
      .datetime({ offset: true, message: 'La hora del cierre debe ser una fecha ISO' })
      .nullable()
      .optional(),
    occurredAtKnown: z.boolean({
      required_error: 'Falta decir si se conoce la hora del cierre',
      invalid_type_error: 'occurredAtKnown debe ser verdadero o falso',
    }),
    saleShiftId: z
      .string({ invalid_type_error: 'El turno de la venta debe ser texto' })
      .max(64, 'El turno de la venta admite hasta 64 caracteres')
      .nullable()
      .optional(),
  })
  .refine(c => !c.occurredAtKnown || !!c.occurredAt, {
    message: 'Con la hora conocida, manda la hora del cierre',
    path: ['occurredAt'],
  })

export const registrarVentaDeLaMaquinaSchema = z.object({
  params: z.object({ venueId }),
  body: z
    .object({
      referenceCC,
      cierre,
      // El mismo JSON de creación de cuenta que manda hoy la cola; lo valida `leerVentaDeMostrador`, como `POST /orders`.
      pedido: z.record(z.unknown(), { invalid_type_error: 'El pedido debe ser un objeto' }).optional(),
    })
    .superRefine((b, ctx) => {
      if (b.cierre.outcome === 'PAGADO' && !b.pedido) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pedido'], message: 'Un cierre PAGADO lleva el pedido de la venta' })
      }
      if (b.cierre.outcome !== 'PAGADO' && b.pedido) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pedido'], message: 'Sólo un cierre PAGADO lleva pedido' })
      }
    }),
})

export const consultarVentaDeLaMaquinaSchema = z.object({
  params: z.object({ venueId, referenceCC }),
})
