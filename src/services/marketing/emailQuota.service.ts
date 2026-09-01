// src/services/marketing/emailQuota.service.ts
import { Prisma } from '@prisma/client'
import { DateTime } from 'luxon'
import { BadRequestError } from '@/errors/AppError'

/**
 * Ledger de cuota mensual de correos de campaña por venue (Fase 1A, Task 4).
 *
 * Es el mecanismo que impide que un negocio mande más correos de los que su cuota
 * mensual permite — y tiene que ser correcto bajo CONCURRENCIA: dos encolados
 * simultáneos no pueden pasar el chequeo por separado. `reservarCuota` y
 * `devolverCuota` corren DENTRO de la transacción de encolado (Task 5): reciben el
 * `tx` de esa transacción, nunca importan `prisma` global.
 */

/**
 * Período civil `YYYY-MM` del ENVÍO, en la zona del VENUE — nunca en UTC.
 *
 * 🔴 La trampa de siempre: `fecha.toISOString().slice(0, 7)` da el mes en UTC, y un
 * envío de madrugada puede caer en el mes SIGUIENTE del calendario del venue (a las
 * 04:00 UTC del 1-sep, en México todavía son las 22:00 del 31-ago). Usar el mes
 * equivocado le resta cuota al período que no es, o le regala un correo gratis al
 * que sí es.
 */
export function periodoDeEnvio(fecha: Date, venueTimeZone: string): string {
  const dt = DateTime.fromJSDate(fecha, { zone: venueTimeZone })
  // 🔴 Fix loop 1 / Hallazgo 3: una zona nula o inválida no da un error de Luxon —
  // produce silenciosamente la CADENA `'Invalid DateTime'`. `reservarCuota` la
  // guardaría tal cual como `period`, una fila de cuota basura. Regla del workspace
  // (ya aplicada en la alerta de asistencia): una zona mal configurada REVIENTA, nunca
  // cae a nada en silencio. Es un `Error` normal, no `BadRequestError`: no es una
  // entrada del usuario, es un dato del VENUE mal configurado.
  if (!dt.isValid) {
    throw new Error(`Zona horaria inválida para calcular el período de envío: "${venueTimeZone}"`)
  }
  return dt.toFormat('yyyy-MM')
}

export interface ReservarCuotaParams {
  venueId: string
  period: string
  cantidad: number
  topeMensual: number
}

/**
 * Reserva `cantidad` correos contra la cuota de `venueId` en `period`. Lanza
 * `BadRequestError` si excede `topeMensual`.
 *
 * 🔴 La atomicidad DEL CONTADOR es este único `updateMany` condicional. Leer
 * `reserved`, compararlo contra el tope en JS y sólo entonces escribir permitiría que
 * dos encolados concurrentes VIERAN el mismo valor viejo y los DOS pasaran el chequeo
 * por separado — exactamente lo que la reserva existe para impedir. El `WHERE` con el
 * tope YA restado (`reserved <= topeMensual - cantidad`) es lo que hace que sólo uno
 * de los dos pase cuando el margen no alcanza para ambos: Postgres evalúa esa
 * condición contra el valor QUE HAY en ese instante, no contra el que alguien leyó
 * antes.
 *
 * La CREACIÓN idempotente de la fila es un mecanismo aparte: `createMany({
 * skipDuplicates: true })`, que emite `INSERT … ON CONFLICT DO NOTHING` (Fix loop 1 /
 * Hallazgo 1). El `upsert` de Prisma NO es atómico bajo concurrencia — hace un SELECT
 * y luego un INSERT/UPDATE — así que dos `$transaction` concurrentes reservando la
 * PRIMERA cuota del mes de un venue (fila que todavía no existe) hacen que uno pase y
 * el otro reviente con `P2002`. 🔴 NO se atrapa ese `P2002` con try/catch: dentro de
 * una transacción de Postgres una violación de unique ABORTA la transacción entera, y
 * el `updateMany` siguiente fallaría con `25P02` (transacción ya abortada). Mismo
 * patrón que `referralQualification.service.ts:229-245`.
 */
export async function reservarCuota(
  tx: Prisma.TransactionClient,
  { venueId, period, cantidad, topeMensual }: ReservarCuotaParams,
): Promise<void> {
  // 🔴 Fix loop 1 / Hallazgo 2: sin esto, `cantidad: -1000000` hace que el `lte` de
  // abajo pase SIEMPRE (comparar contra un tope gigante) y el `increment` negativo
  // deja `reserved` muy negativo — cuota infinita regalada. Se valida ANTES de tocar
  // la base. `cantidad = 0` también se rechaza aquí: reservar 0 es un no-op que
  // esconde un llamador con la audiencia vacía, y ESE debe cortar antes de llegar a
  // reservar, no aquí.
  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    throw new BadRequestError('La cantidad de correos a reservar debe ser un entero positivo.')
  }
  // `topeMensual = 0` SÍ es legítimo (un plan que rechaza todo el envío) — sólo se
  // rechazan valores negativos o no enteros.
  if (!Number.isInteger(topeMensual) || topeMensual < 0) {
    throw new BadRequestError('El tope mensual de correos debe ser un entero mayor o igual a cero.')
  }

  await tx.emailQuotaLedger.createMany({
    data: [{ venueId, period, reserved: 0 }],
    skipDuplicates: true,
  })

  const reservado = await tx.emailQuotaLedger.updateMany({
    where: { venueId, period, reserved: { lte: topeMensual - cantidad } },
    data: { reserved: { increment: cantidad } },
  })

  if (reservado.count === 0) {
    throw new BadRequestError(`Se alcanzó el tope de ${topeMensual} correos de campaña para este período (se pedían ${cantidad}).`)
  }
}

export interface DevolverCuotaParams {
  venueId: string
  period: string
  cantidad: number
}

/**
 * Devuelve `cantidad` a la cuota reservada (falló el envío, se descartó el
 * destinatario, etc.). Nunca deja `reserved` negativo, e IDEMPOTENTE ante dobles
 * devoluciones de la MISMA cantidad.
 *
 * Decisión de idempotencia: el `WHERE` exige `reserved >= cantidad` — el mismo tipo
 * de guarda condicional que `reservarCuota`, en dirección opuesta. Una primera
 * devolución de 5 sobre `reserved=5` lo deja en 0; una SEGUNDA devolución idéntica ya
 * no encuentra fila que cumpla `reserved >= 5` (quedó en 0) y el `updateMany` no hace
 * nada — `count: 0`, sin lanzar. Se eligió NO lanzar en ese caso a propósito: una
 * devolución tardía o duplicada (reintento del job de encolado, doble entrega) no es
 * un error del llamador — es exactamente el escenario que la idempotencia existe
 * para tolerar en silencio. La alternativa (`Math.max(0, reserved - cantidad)`)
 * exigiría leer antes de escribir, reabriendo la misma ventana de carrera que
 * `reservarCuota` evita con su `updateMany` condicional.
 */
export async function devolverCuota(tx: Prisma.TransactionClient, { venueId, period, cantidad }: DevolverCuotaParams): Promise<void> {
  // 🔴 Fix loop 1 / Hallazgo 2: sin esto, `devolverCuota(cantidad: -5)` INCREMENTA en
  // vez de devolver (`decrement: -5` es matemáticamente `increment: 5`). Se valida
  // ANTES de tocar la base.
  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    throw new BadRequestError('La cantidad de correos a devolver debe ser un entero positivo.')
  }

  await tx.emailQuotaLedger.updateMany({
    where: { venueId, period, reserved: { gte: cantidad } },
    data: { reserved: { decrement: cantidad } },
  })
}
