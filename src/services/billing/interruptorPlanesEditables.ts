import type { Prisma } from '@prisma/client'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import AppError, { ConflictError } from '../../errors/AppError'
import { priceTransaction } from '../launchCampaigns/hybridProduct'
import { ofertaVigente, tomarCandadoDeLaOferta, type Periodicidad, type PlanPagado } from './planOffer'
import { cuponDeIntroduccionRetirado, SERVIDOR_LISTO_PARA_PLANES_EDITABLES } from './planesEditablesListos'

/**
 * Planes editables (B1): el INTERRUPTOR de plataforma `PLANES_EDITABLES` (patrón de `interruptorPausaSola.ts`).
 *
 * Prendido ⇔ `desde IS NOT NULL`; sin renglón, apagado. Se escribe con SQL crudo y `clock_timestamp()` bajo el candado de la
 * oferta (`plan-offer-publish`, el mismo de publicar): apagar espera a un movimiento en curso y uno que empieza después ya lo
 * ve apagado. Se lee con caché de 5 s, salvo con `sinCache` o con la transacción del candado (`db`).
 * Apagarlo bloquea editar y no revierte nada.
 */
export const CLAVE_PLANES_EDITABLES = 'PLANES_EDITABLES'
export const CACHE_MS = 5_000

export type RequisitoFaltante = 'VERSION_1' | 'CUPON_DE_INTRODUCCION' | 'SERVIDOR_LISTO'

const RANURAS: ReadonlyArray<[PlanPagado, Periodicidad]> = [
  ['PRO', 'monthly'],
  ['PRO', 'annual'],
  ['PREMIUM', 'monthly'],
  ['PREMIUM', 'annual'],
]

let leido: { prendido: boolean; hasta: number } | null = null
let enCurso: Promise<boolean> | null = null

/** Olvida lo leído: producción lo llama después de cada escritura del interruptor. */
export function invalidarCacheDelInterruptor(): void {
  leido = null
  enCurso = null
}

/** Alias para las pruebas. */
export const __resetInterruptorPlanesParaPruebas = invalidarCacheDelInterruptor

export async function planesEditablesPrendidos(opciones: { sinCache?: boolean; db?: Prisma.TransactionClient } = {}): Promise<boolean> {
  const leer = async (db: Pick<typeof prisma, 'interruptorDePlataforma'>) => {
    const fila = await db.interruptorDePlataforma.findUnique({ where: { clave: CLAVE_PLANES_EDITABLES }, select: { desde: true } })
    return fila?.desde != null
  }
  if (opciones.db) return leer(opciones.db)
  if (opciones.sinCache) {
    const prendido = await leer(prisma)
    leido = { prendido, hasta: Date.now() + CACHE_MS }
    return prendido
  }
  if (leido && Date.now() < leido.hasta) return leido.prendido
  if (!enCurso) {
    enCurso = leer(prisma)
      .then(prendido => {
        leido = { prendido, hasta: Date.now() + CACHE_MS }
        return prendido
      })
      .finally(() => {
        enCurso = null
      })
  }
  return enCurso
}

/** Lo que falta para prender. `VERSION_1` = sin vigente, con una vigente rota o con una ranura sin `stripePriceId`. */
export async function requisitosFaltantes(db?: Prisma.TransactionClient): Promise<RequisitoFaltante[]> {
  const faltan: RequisitoFaltante[] = []
  let versionValida = false
  try {
    const vigente = await ofertaVigente(db ?? prisma)
    versionValida = !vigente.respaldo && RANURAS.every(([tier, interval]) => Boolean(vigente.definition[tier][interval].stripePriceId))
  } catch (e) {
    // Sólo una vigente rota (503) cuenta como «falta la v1»; un error de la base se propaga.
    if (!(e instanceof AppError && e.code === 'PLAN_NOT_CONFIGURED')) throw e
    versionValida = false
  }
  if (!versionValida) faltan.push('VERSION_1')
  if (!cuponDeIntroduccionRetirado()) faltan.push('CUPON_DE_INTRODUCCION')
  if (!SERVIDOR_LISTO_PARA_PLANES_EDITABLES) faltan.push('SERVIDOR_LISTO')
  return faltan
}

export async function estadoDelInterruptor(): Promise<{
  prendido: boolean
  desde: Date | null
  actualizadoPor: string | null
  faltan: RequisitoFaltante[]
}> {
  const fila = await prisma.interruptorDePlataforma.findUnique({
    where: { clave: CLAVE_PLANES_EDITABLES },
    select: { desde: true, actualizadoPor: true },
  })
  return {
    prendido: fila?.desde != null,
    desde: fila?.desde ?? null,
    actualizadoPor: fila?.actualizadoPor ?? null,
    faltan: await requisitosFaltantes(),
  }
}

export async function prenderPlanesEditables(staffId: string): Promise<{ desde: Date }> {
  const desde = await priceTransaction(async tx => {
    await tomarCandadoDeLaOferta(tx)
    // Ya prendido: no se mueve «desde» ni se repite la bitácora.
    const actual = await tx.interruptorDePlataforma.findUnique({ where: { clave: CLAVE_PLANES_EDITABLES }, select: { desde: true } })
    if (actual?.desde) return actual.desde
    const faltan = await requisitosFaltantes(tx)
    if (faltan.length > 0) {
      throw new ConflictError('Todavía no se pueden prender los planes editables: faltan requisitos.', 'PLAN_EDIT_PREREQUISITE', { faltan })
    }
    const filas = await tx.$queryRaw<Array<{ desde: Date }>>`
      INSERT INTO "public"."InterruptorDePlataforma" ("clave", "desde", "actualizadoPor", "updatedAt")
      VALUES (${CLAVE_PLANES_EDITABLES}, (clock_timestamp() AT TIME ZONE 'UTC'), ${staffId}, (clock_timestamp() AT TIME ZONE 'UTC'))
      ON CONFLICT ("clave") DO UPDATE
        SET "desde" = (clock_timestamp() AT TIME ZONE 'UTC'), "actualizadoPor" = EXCLUDED."actualizadoPor",
            "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
      RETURNING "desde"`
    const escrito = filas[0]?.desde
    await tx.activityLog.create({
      data: { staffId, action: 'PLAN_OFFER_SWITCH_ON', entity: 'InterruptorDePlataforma', entityId: CLAVE_PLANES_EDITABLES, data: {} },
    })
    return escrito
  })
  invalidarCacheDelInterruptor()
  logger.info('[PlanOffer] planes editables PRENDIDOS', { por: staffId })
  return { desde }
}

export async function apagarPlanesEditables(staffId: string): Promise<void> {
  await priceTransaction(async tx => {
    await tomarCandadoDeLaOferta(tx)
    // Ya apagado (o sin renglón): nada que escribir ni que anotar.
    const actual = await tx.interruptorDePlataforma.findUnique({ where: { clave: CLAVE_PLANES_EDITABLES }, select: { desde: true } })
    if (!actual?.desde) return
    await tx.$executeRaw`
      INSERT INTO "public"."InterruptorDePlataforma" ("clave", "desde", "actualizadoPor", "updatedAt")
      VALUES (${CLAVE_PLANES_EDITABLES}, NULL, ${staffId}, (clock_timestamp() AT TIME ZONE 'UTC'))
      ON CONFLICT ("clave") DO UPDATE
        SET "desde" = NULL, "actualizadoPor" = EXCLUDED."actualizadoPor", "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')`
    await tx.activityLog.create({
      data: { staffId, action: 'PLAN_OFFER_SWITCH_OFF', entity: 'InterruptorDePlataforma', entityId: CLAVE_PLANES_EDITABLES, data: {} },
    })
  })
  invalidarCacheDelInterruptor()
  logger.info('[PlanOffer] planes editables APAGADOS', { por: staffId })
}
