import type { Prisma, RawMaterialPresentation } from '@prisma/client'
import AppError from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { type PresentationSet, assertValidPresentations } from '../../utils/productPresentations'
import { logAction } from './activity-log.service'

/**
 * Presentaciones de compra/salida por insumo (CEDIS): "compro en caja, remisiono
 * en cono o kilos". Esta capa SÓLO lee/escribe la configuración; la aritmética
 * vive en `src/utils/productPresentations.ts` (puro, testeable).
 *
 * Invariante: el stock SIEMPRE se contabiliza en la unidad base del insumo
 * (`RawMaterial.unit`). Las presentaciones son un tema de ENTRADA/SALIDA — se
 * convierte a base antes de tocar `currentStock` o `StockBatch`. Un insumo sin
 * presentaciones se comporta byte-idéntico a hoy.
 */

export interface PresentationInput {
  name: string
  factorToBase: number | string
  isPurchase?: boolean
  isDefaultOut?: boolean
}

type Client = Prisma.TransactionClient | typeof prisma

/**
 * Carga el `PresentationSet` de un insumo para alimentar al resolver puro.
 * Devuelve `null` si el insumo no tiene presentaciones configuradas — el caller
 * debe entonces seguir el camino de hoy (`convertUnit`), sin cambio de conducta.
 */
export async function getPresentationSet(rawMaterialId: string, client: Client = prisma): Promise<PresentationSet | null> {
  const rawMaterial = await client.rawMaterial.findUnique({
    where: { id: rawMaterialId },
    select: { unit: true, presentations: { select: { name: true, factorToBase: true } } },
  })
  if (!rawMaterial || rawMaterial.presentations.length === 0) return null
  return {
    baseUnit: rawMaterial.unit,
    presentations: rawMaterial.presentations.map(p => ({ name: p.name, factorToBase: p.factorToBase })),
  }
}

/** Lista las presentaciones de un insumo (para pantallas de configuración). */
export async function listPresentations(venueId: string, rawMaterialId: string): Promise<RawMaterialPresentation[]> {
  await assertRawMaterialInVenue(venueId, rawMaterialId)
  return prisma.rawMaterialPresentation.findMany({
    where: { rawMaterialId, venueId },
    orderBy: [{ isPurchase: 'desc' }, { factorToBase: 'desc' }],
  })
}

/**
 * Reemplaza el conjunto completo de presentaciones de un insumo (patrón
 * replace-all, como el editor de horarios de staff): valida TODO antes de
 * borrar, así un input inválido nunca deja al insumo sin configuración.
 */
export async function setPresentations(
  venueId: string,
  rawMaterialId: string,
  presentations: PresentationInput[],
  staffId?: string,
): Promise<RawMaterialPresentation[]> {
  const rawMaterial = await assertRawMaterialInVenue(venueId, rawMaterialId)

  // Validar ANTES de tocar la base (nombres únicos, sin chocar con la unidad
  // base, factores finitos > 0). Los mensajes salen en español al usuario.
  try {
    assertValidPresentations({
      baseUnit: rawMaterial.unit,
      presentations: presentations.map(p => ({ name: p.name.trim(), factorToBase: p.factorToBase })),
    })
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : 'Presentaciones inválidas', 400)
  }

  const onePurchase = presentations.filter(p => p.isPurchase).length
  if (onePurchase > 1) throw new AppError('Sólo una presentación puede ser la unidad de compra', 400)
  const oneDefaultOut = presentations.filter(p => p.isDefaultOut).length
  if (oneDefaultOut > 1) throw new AppError('Sólo una presentación puede ser la unidad de salida por defecto', 400)

  const saved = await prisma.$transaction(async tx => {
    // Candado de fila sobre el insumo padre ANTES de borrar. Sin esto, dos
    // guardados simultáneos del MISMO insumo se intercalan en READ COMMITTED:
    // cada uno borra lo que alcanza a ver y luego inserta lo suyo, y el
    // resultado es la UNIÓN de ambos en vez del reemplazo que el usuario pidió
    // (una presentación borrada "revive"). Con nombres repetidos, además,
    // reventaba con P2002 en `createMany`. El lock serializa los replace-all
    // del mismo insumo; insumos distintos siguen en paralelo.
    await tx.$queryRaw`SELECT id FROM "RawMaterial" WHERE id = ${rawMaterialId} FOR UPDATE`

    await tx.rawMaterialPresentation.deleteMany({ where: { rawMaterialId, venueId } })
    if (presentations.length === 0) return []
    await tx.rawMaterialPresentation.createMany({
      data: presentations.map(p => ({
        rawMaterialId,
        venueId,
        name: p.name.trim(),
        factorToBase: p.factorToBase.toString(),
        isPurchase: p.isPurchase ?? false,
        isDefaultOut: p.isDefaultOut ?? false,
      })),
    })
    return tx.rawMaterialPresentation.findMany({
      where: { rawMaterialId, venueId },
      orderBy: [{ isPurchase: 'desc' }, { factorToBase: 'desc' }],
    })
  })

  // Fire-and-forget FUERA de la tx: una falla de auditoría no puede tumbar la
  // configuración recién guardada.
  void logAction({
    staffId,
    venueId,
    action: 'RAW_MATERIAL_PRESENTATIONS_UPDATED',
    entity: 'RawMaterial',
    entityId: rawMaterialId,
    data: {
      baseUnit: rawMaterial.unit,
      presentations: saved.map(p => ({ name: p.name, factorToBase: p.factorToBase.toString() })),
    },
  })

  return saved
}

/** Tenant isolation: el insumo DEBE pertenecer al venue del request. */
async function assertRawMaterialInVenue(venueId: string, rawMaterialId: string) {
  const rawMaterial = await prisma.rawMaterial.findFirst({
    where: { id: rawMaterialId, venueId },
    select: { id: true, unit: true },
  })
  if (!rawMaterial) throw new AppError('Insumo no encontrado', 404)
  return rawMaterial
}
