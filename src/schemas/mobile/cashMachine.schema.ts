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

/** R4-3: la IP de la QuickPay en la red del negocio (su WebSocket es `ws://<ip>:8080/`). El aparato sale del encabezado, nunca de aquí. */
export const emparejarAparatoSchema = z.object({
  params: z.object({ venueId }),
  body: z.object({
    machineIp: z
      .string({ required_error: 'La IP de la máquina es requerida', invalid_type_error: 'La IP de la máquina debe ser texto' })
      .trim()
      .ip({ version: 'v4', message: 'La IP de la máquina debe ser una IPv4, por ejemplo 192.168.1.50' }),
  }),
})

export const desemparejarAparatoSchema = z.object({
  params: z.object({ venueId }),
})

/** R4-2: el MISMO cuerpo que `POST /orders` de una venta de mostrador; lo valida `leerVentaDeMostrador`. */
export const cotizarParaLaMaquinaSchema = z.object({
  params: z.object({ venueId }),
  body: z.record(z.unknown(), { invalid_type_error: 'El carrito debe ser un objeto' }),
})

/** Centavos enteros ≥ 0 (lo que teclea el gerente o fija la duda; si son POSIBLES lo decide `validarCierre`). */
const centavosEnteros = (campo: string) =>
  z
    .number({ required_error: `${campo} es requerido`, invalid_type_error: `${campo} debe ser un número de centavos` })
    .int(`${campo} debe ser un número entero de centavos`)
    .min(0, `${campo} no puede ser negativo`)

/** ponytail: 16 KB de «lo último que vio la PC» bastan para que el gerente entienda; más es una PC que manda de más. */
const LAST_SEEN_MAX = 16_384

/** R4-4, R5#6: la duda que sube la PC (no sabe cómo terminó la operación). Importes en centavos, como la venta. */
export const subirDudaDeLaMaquinaSchema = z.object({
  params: z.object({ venueId }),
  body: z.object({
    referenceCC,
    dueCents: centavosEnteros('El adeudo'),
    saleCents: centavosEnteros('La venta'),
    tipCents: centavosEnteros('La propina'),
    // El MISMO carrito que la venta; lo valida `leerVentaDeMostrador`, como `POST /orders`.
    pedido: z.record(z.unknown(), { required_error: 'Falta el carrito de la venta', invalid_type_error: 'El pedido debe ser un objeto' }),
    startedAt: z
      .string({ required_error: 'Falta la hora en que empezó el cobro', invalid_type_error: 'La hora de inicio debe ser texto' })
      .datetime({ offset: true, message: 'La hora de inicio debe ser una fecha ISO' }),
    lastSeen: z
      .unknown()
      .refine(v => v === undefined || JSON.stringify(v).length <= LAST_SEEN_MAX, 'Lo último que vio la PC es demasiado largo (máx. 16 KB)')
      .optional(),
    saleShiftId: z
      .string({ invalid_type_error: 'El turno de la venta debe ser texto' })
      .max(64, 'El turno de la venta admite hasta 64 caracteres')
      .nullable()
      .optional(),
  }),
})

export const consultarDudaDeLaMaquinaSchema = z.object({
  params: z.object({ venueId, referenceCC }),
})

export const listarDudasDeLaMaquinaSchema = z.object({
  params: z.object({ venueId }),
  query: z.object({
    status: z
      .enum(['ABIERTO', 'RESUELTO'], { errorMap: () => ({ message: 'El estado de la duda debe ser ABIERTO o RESUELTO' }) })
      .optional(),
    cursor: z.string({ invalid_type_error: 'El cursor no es válido' }).max(200, 'El cursor no es válido').optional(),
    // Un límite hostil no se rechaza: el servicio lo recorta a 100.
    limit: z.coerce
      .number({ invalid_type_error: 'El límite debe ser un número' })
      .int('El límite debe ser un número entero')
      .positive('El límite debe ser mayor que cero')
      .optional(),
  }),
})

/** R4-4, R5#5, R5#8: lo que el gerente lee en la máquina. Quién resuelve sale de la sesión, nunca de aquí. */
export const resolverDudaDeLaMaquinaSchema = z.object({
  params: z.object({ venueId, referenceCC }),
  body: z.object({
    outcome: z.enum(DESENLACES_DE_LA_MAQUINA, {
      errorMap: () => ({ message: 'El desenlace de la máquina debe ser PAGADO, CANCELADO o GUARDADO' }),
    }),
    creditCents: centavosEnteros('Lo que entró'),
    changeDispensedCents: centavosEnteros('El cambio entregado'),
    occurredAt: z
      .string({ invalid_type_error: 'La hora del comprobante debe ser texto' })
      .datetime({ offset: true, message: 'La hora del comprobante debe ser una fecha ISO' })
      .nullable()
      .optional(),
    evidence: z
      .string({ required_error: 'Escribe lo que viste en la máquina', invalid_type_error: 'Lo que viste en la máquina debe ser texto' })
      .trim()
      .min(1, 'Escribe lo que viste en la máquina')
      .max(500, 'Lo que viste en la máquina admite hasta 500 caracteres'),
  }),
})
