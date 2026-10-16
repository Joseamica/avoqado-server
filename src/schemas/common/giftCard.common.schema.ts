/**
 * Tarjetas de regalo — piezas de forma que comparten el POS (`/mobile`) y el dashboard. Sólo forma: topes, plan, saldo e
 * idempotencia viven en los servicios. Mensajes en español: `validateRequest` los muestra tal cual.
 */
import { Prisma } from '@prisma/client'
import { z } from 'zod'

export const CAMPO_DE_MAS = 'Hay un campo que no se esperaba'
export const DIA = /^\d{4}-\d{2}-\d{2}$/
/** Pesos con hasta 2 decimales y a lo más 7 enteros. Se valida sobre el TEXTO del número: nunca multiplicando por 100. */
const DOS_DECIMALES = /^\d{1,7}(\.\d{1,2})?$/
/** La de A5 (`createGiftCardOrder`) y la de `Payment.idempotencyKey`: letras, números, guion y guion bajo. */
const LLAVE_DE_VENTA = /^[A-Za-z0-9_-]+$/
/** La de A4 (`operarSobreDeGerenteEnTx`, `LLAVE_DE_OPERACION`): además, dos puntos. */
const LLAVE_DE_OPERACION = /^[A-Za-z0-9_:-]+$/

export const mayuscula = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Un monto en pesos (`150.5` = $150.50) que se queda como NÚMERO: para los servicios que validan números ellos mismos
 * (A5: ajustes y venta de tarjetas). `que` lleva su artículo: «el monto», «la propina».
 */
export function montoEnPesos(que: string) {
  return z
    .number({ required_error: `Falta ${que}`, invalid_type_error: `${mayuscula(que)} debe ser un número` })
    .refine(v => Number.isFinite(v) && DOS_DECIMALES.test(String(v)), `${mayuscula(que)} debe ser un monto en pesos con hasta 2 decimales`)
}

/** Lo mismo, mayor a cero. */
export function montoPositivo(que: string) {
  return montoEnPesos(que).refine(v => v > 0, `${mayuscula(que)} debe ser mayor a $0`)
}

/** Un monto en pesos → `Prisma.Decimal` exacto (desde su texto): para los servicios que reciben Decimal (A4, A8). */
export function pesos(que: string) {
  return montoEnPesos(que).transform(v => new Prisma.Decimal(String(v)))
}

/** Lo mismo, mayor a cero. */
export function pesosPositivos(que: string) {
  return pesos(que).refine(d => d.gt(0), `${mayuscula(que)} debe ser mayor a $0`)
}

export const venueParams = z.object({ venueId: z.string().min(1, 'Falta el negocio').max(64, 'El negocio no es válido') }).passthrough()
export const ordenParams = venueParams.extend({ orderId: z.string().min(1, 'Falta la cuenta').max(64, 'La cuenta no es válida') })

function llave(maximo: number, forma: RegExp, permitidos: string) {
  return z
    .string({ required_error: 'Falta la llave de la operación', invalid_type_error: 'La llave de la operación debe ser texto' })
    .trim()
    .min(8, 'La llave de la operación debe tener al menos 8 caracteres')
    .max(maximo, `La llave de la operación no puede pasar de ${maximo} caracteres`)
    .regex(forma, `La llave de la operación sólo lleva ${permitidos}`)
}

/** Vender la cuenta de tarjetas y cobrar con saldo: 8–64, como `Payment.idempotencyKey` (`VarChar(64)`) y A5. */
export const idempotencyKey = llave(64, LLAVE_DE_VENTA, 'letras, números, guion y guion bajo')
/** Operaciones de gerente y de cancelación (`GiftCardActivity.operationKey`): 8–128, como A4. */
export const operationKey = llave(128, LLAVE_DE_OPERACION, 'letras, números, guion, guion bajo y dos puntos')

export const soloVenueSchema = z.object({ params: venueParams, body: z.any().optional(), query: z.any().optional() })

/** `{ operationKey }` sobre una cuenta: regresar saldo y cancelar, o iniciar la cancelación de una venta. */
export const operationKeyOnOrderSchema = z.object({
  params: ordenParams,
  body: z.object({ operationKey }, { required_error: 'Falta la llave de la operación' }),
  query: z.any().optional(),
})

/** F6 (auditoría r1 B-5): un timeout de la terminal NO prueba que el dinero no salió. Liberar exige que el gerente lo comprobó. */
export const MENSAJE_CONFIRMAR_NO_DEVUELTO =
  'Para liberar confirma que comprobaste que la devolución NO se hizo. Si no lo sabes, la tarjeta se queda bloqueada.'

/** Liberar la cancelación de una venta (POS y dashboard): `{ operationKey, confirmacionNoDevuelto: true }`. */
export const liberarCancelacionSchema = z.object({
  params: ordenParams,
  body: z.object(
    {
      operationKey,
      confirmacionNoDevuelto: z.literal(true, { errorMap: () => ({ message: MENSAJE_CONFIRMAR_NO_DEVUELTO }) }),
    },
    { required_error: 'Falta la llave de la operación' },
  ),
  query: z.any().optional(),
})
