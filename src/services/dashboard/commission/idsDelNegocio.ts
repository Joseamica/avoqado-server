/**
 * ¿Los ids que llegan en una escritura de comisiones son de ESTE negocio? (fase 3 de Pago al personal, FT-GRAVES T1-hermanos,
 * dentro del arreglo de seguridad que aprobó el founder el 8-oct).
 *
 * Varias escrituras guardaban ids de otras tablas sin mirar de quién eran:
 * - el producto o la categoría de un hito;
 * - la persona de una meta y las de una exclusión en lote;
 * - las categorías de un esquema;
 * - la orden o el turno de una comisión manual.
 * Con un id de otro negocio el hito contaba un producto ajeno, la comisión manual quedaba colgada de la orden de otro negocio, y
 * así. Ahora, antes de escribir nada, cada id tiene que ser de la sede (o, en un esquema de la organización, de alguna de sus
 * sedes). Si no, se responde 400 en español y no se escribe nada.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError } from '../../../errors/AppError'
import type { AlcanceDelEsquema } from './personasElegidas'

export interface IdsQueLlegan {
  productIds?: Array<string | null | undefined>
  categoryIds?: Array<string | null | undefined>
  /** Personas con una relación ACTIVA en la sede (u organización). */
  staffIds?: Array<string | null | undefined>
  orderIds?: Array<string | null | undefined>
  shiftIds?: Array<string | null | undefined>
}

const MENSAJES = {
  productIds: 'Uno de los productos elegidos no es de este negocio.',
  categoryIds: 'Una de las categorías elegidas no es de este negocio.',
  staffIds: 'Una de las personas elegidas no es del equipo de este negocio.',
  orderIds: 'La orden elegida no es de este negocio.',
  shiftIds: 'El turno elegido no es de este negocio.',
} as const

const unicos = (ids: Array<string | null | undefined> | undefined): string[] => [
  ...new Set((ids ?? []).filter((x): x is string => typeof x === 'string' && x.length > 0)),
]

/** 400 en español si alguno de los ids no es del negocio. No escribe nada; va ANTES de cualquier escritura. */
export async function asegurarIdsDelNegocio(
  alcance: AlcanceDelEsquema,
  ids: IdsQueLlegan,
  db: Pick<Prisma.TransactionClient, 'product' | 'menuCategory' | 'staffVenue' | 'order' | 'shift'> = prisma,
): Promise<void> {
  const deLaSede = 'venueId' in alcance ? { venueId: alcance.venueId } : { venue: { organizationId: alcance.organizationId } }
  const revisar = async (tipo: keyof IdsQueLlegan, contar: (lista: string[]) => Promise<number>) => {
    const lista = unicos(ids[tipo])
    if (lista.length > 0 && (await contar(lista)) !== lista.length) throw new BadRequestError(MENSAJES[tipo], 'ID_DE_OTRO_NEGOCIO')
  }
  await revisar('productIds', lista => db.product.count({ where: { id: { in: lista }, ...deLaSede } }))
  await revisar('categoryIds', lista => db.menuCategory.count({ where: { id: { in: lista }, ...deLaSede } }))
  await revisar('orderIds', lista => db.order.count({ where: { id: { in: lista }, ...deLaSede } }))
  await revisar('shiftIds', lista => db.shift.count({ where: { id: { in: lista }, ...deLaSede } }))
  await revisar('staffIds', async lista => {
    const filas = await db.staffVenue.findMany({
      where: { staffId: { in: lista }, active: true, ...deLaSede },
      select: { staffId: true },
      distinct: ['staffId'],
      take: lista.length,
    })
    return filas.length
  })
}
