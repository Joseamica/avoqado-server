/**
 * D9 (tablero hz:fa2343a0:D9): «cerrar la llave» de una «Pagar después».
 *
 * Cuando el SERVIDOR rechaza el REENVÍO de una «Pagar después» (por ejemplo, el producto se apagó mientras el POS estaba sin red),
 * el POS quiere devolver la venta a «Carritos guardados». Sólo es seguro si la cuenta NO existe y nunca va a existir: un envío
 * anterior pudo crearla y perder la respuesta (un 403 del permiso llega ANTES de buscar la cuenta por su llave; D3, Codex r4), o
 * todavía estar en vuelo. Por eso el POS no adivina: pide `release` y el SERVIDOR, bajo el MISMO candado con que
 * `crearVentaDeMostradorEnTx` busca la cuenta por su llave, o la encuentra o deja la llave cerrada (`OrderKeyRelease`). Una creación
 * que llegue después con esa llave da 409 `ORDER_KEY_RELEASED`. El candado ordena las dos operaciones: la segunda ve lo que hizo la
 * primera (Codex plan r1 #1).
 *
 * La llave `pay-later:` es SÓLO de este circuito (ANDROID e iOS, por `/mobile`): las otras entradas que aceptan una llave de la app
 * (TPV y la sincronización de SoftRestaurant) la rechazan, igual que `exchange:` (Codex plan r2 #1).
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError, ConflictError } from '@/errors/AppError'

type Tx = Prisma.TransactionClient

/** La llave de una «Pagar después» de ANDROID e iOS: `pay-later:<uuid>`. */
export const PREFIJO_DE_PAGAR_DESPUES = 'pay-later:'
const LARGO_MAXIMO = 128

/** EL candado de la llave de una cuenta de `/mobile`: crear la cuenta y cerrar su llave toman este mismo. */
export function candadoDeLaLlave(venueId: string, externalId: string): Prisma.Sql {
  return Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`avoqado:order-mobile-external:v1:${venueId}:${externalId}`}, 0))::text`
}

/** Para las entradas que NO son `/mobile`: una llave de «Pagar después» no se acepta ahí. */
export function rechazarLlaveDePagarDespues(externalId: string | null | undefined): void {
  if (externalId?.trim().startsWith(PREFIJO_DE_PAGAR_DESPUES))
    throw new BadRequestError('Ese identificador de cuenta está reservado para «Pagar después».')
}

/** Dentro del candado de la llave: si el POS ya la cerró, la cuenta no se crea. */
export async function rechazarSiLaLlaveSeCerroEnTx(tx: Tx, venueId: string, externalId: string): Promise<void> {
  const cerrada = await tx.orderKeyRelease.findUnique({
    where: { venueId_externalId: { venueId, externalId } },
    select: { id: true },
  })
  if (cerrada) {
    throw new ConflictError(
      'Esta venta ya regresó a «Carritos guardados» en el aparato: cóbrala desde ahí.',
      'ORDER_KEY_RELEASED',
    )
  }
}

export type ResultadoDeCerrarLaLlave =
  | { released: true }
  | { released: false; order: { id: string; total: number; status: string; paymentStatus: string } }

/** Cierra la llave si su cuenta no existe (idempotente); si existe, la devuelve sin cerrar nada. */
export async function liberarLlaveDePagarDespues(
  venueId: string,
  externalId: string,
  staffId: string | null,
): Promise<ResultadoDeCerrarLaLlave> {
  const llave = externalId.trim()
  if (!llave.startsWith(PREFIJO_DE_PAGAR_DESPUES) || llave.length > LARGO_MAXIMO) {
    throw new BadRequestError('Esa llave no es de una venta de «Pagar después».')
  }
  return prisma.$transaction(async tx => {
    await tx.$queryRaw(candadoDeLaLlave(venueId, llave))
    const cuenta = await tx.order.findUnique({
      where: { venueId_externalId: { venueId, externalId: llave } },
      select: { id: true, total: true, status: true, paymentStatus: true },
    })
    if (cuenta) {
      return {
        released: false as const,
        order: { id: cuenta.id, total: Number(cuenta.total), status: cuenta.status, paymentStatus: cuenta.paymentStatus },
      }
    }
    await tx.orderKeyRelease.upsert({
      where: { venueId_externalId: { venueId, externalId: llave } },
      update: {},
      create: { venueId, externalId: llave, staffId },
    })
    return { released: true as const }
  })
}
