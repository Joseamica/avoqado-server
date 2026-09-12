import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import { effectiveLayout, validateLayoutStrict, type Block } from '@/services/shared/receiptLayout'

export interface ReceiptLayoutRead {
  blocks: Block[]
  schemaVersion: number
  revision: number
  /** `custom` = hay fila y es íntegra. `default` = no hay fila, o la que hay no se pudo usar. */
  source: 'custom' | 'default'
  /** `null` cuando nadie ha guardado nunca: el diseñador lo enseña como «nunca se ha editado». */
  updatedAt: Date | null
}

/**
 * La receta VIGENTE de un venue (spec § 7.2). Sin fila, la canónica — ésa es la regla que
 * hace que un negocio que nunca abrió el diseñador imprima un ticket correcto.
 *
 * 🔴 Una fila ilegible NO es un error del endpoint: se cae a la canónica y se CONSERVA su
 * `revision`. Reportar 500 dejaría al negocio sin poder imprimir por una fila mal editada;
 * reportar revision 0 haría que el siguiente guardado del dashboard chocara para siempre.
 */
export async function getReceiptLayout(venueId: string): Promise<ReceiptLayoutRead> {
  const fila = await prisma.receiptLayout.findUnique({
    where: { venueId },
    select: { blocks: true, schemaVersion: true, revision: true, updatedAt: true },
  })

  if (!fila) {
    const { blocks } = effectiveLayout(null)
    return { blocks, schemaVersion: 1, revision: 0, source: 'default', updatedAt: null }
  }

  const { blocks, source } = effectiveLayout(fila.blocks)
  return {
    blocks,
    schemaVersion: fila.schemaVersion,
    revision: fila.revision,
    source: source === 'custom' ? 'custom' : 'default',
    updatedAt: fila.updatedAt,
  }
}

export interface PutReceiptLayoutParams {
  venueId: string
  blocks: unknown
  /** OBLIGATORIO. 0 = «sé que no hay fila». Sin él no hay forma de detectar una pisada. */
  expectedRevision: number
  updatedById?: string | null
}

/**
 * Valida la FORMA y después la INTEGRIDAD con `validateLayoutStrict` —la MISMA función que usa
 * el MCP— y sólo entonces escribe. El candado corre antes de tocar la base: una receta
 * rechazada no debe consumir una revisión.
 *
 * El 400 lleva en `details` la posición del bloque (y su tipo si se reconoce): el diseñador
 * puede señalar el renglón exacto en vez de decir «algo está mal».
 */
function validarOExplotar(blocks: unknown): Block[] {
  const r = validateLayoutStrict(blocks)
  if (r.ok) return r.blocks
  const { code, message, index, blockType } = r.problem
  const details = index === undefined ? undefined : { index, ...(blockType ? { blockType } : {}) }
  throw new BadRequestError(message, code, details)
}

/**
 * El 409 lleva SIEMPRE la revisión vigente: sin ella el dashboard sólo puede recargar a ciegas.
 *
 * Y lleva el NOMBRE de quien guardó (spec § 8), porque «alguien más guardó» no le dice a nadie a
 * quién preguntarle qué cambió. El nombre se resuelve SÓLO aquí —en el conflicto, que es raro— y
 * nunca en la lectura: cobrarle una consulta de `Staff` a cada carga de la pantalla para un dato
 * que casi nunca se usa sería pagar en el camino común por el caso excepcional.
 *
 * 🔴 La consulta del nombre va en try/catch: si falla, el conflicto SIGUE siendo un 409. Dejarla
 * propagar convertiría «alguien te ganó, recarga» en un 500 — y el usuario perdería su edición
 * creyendo que el sistema se rompió, cuando el CAS funcionó exactamente como debía.
 */
async function conflictoDeRevision(venueId: string): Promise<never> {
  const vigente = await prisma.receiptLayout.findUnique({ where: { venueId }, select: { revision: true, updatedById: true } })
  return lanzarConflicto(vigente)
}

async function lanzarConflicto(vigente: { revision: number; updatedById: string | null } | null): Promise<never> {
  const details: { currentRevision: number; updatedByName?: string } = { currentRevision: vigente?.revision ?? 0 }

  if (vigente?.updatedById) {
    try {
      const autor = await prisma.staff.findUnique({
        where: { id: vigente.updatedById },
        select: { firstName: true, lastName: true },
      })
      const nombre = [autor?.firstName, autor?.lastName].filter(Boolean).join(' ').trim()
      if (nombre) details.updatedByName = nombre
    } catch {
      // Sin nombre el aviso es peor, pero sigue siendo cierto y accionable ("recarga").
    }
  }

  throw new ConflictError('Alguien más guardó este diseño mientras lo editabas.', 'RECEIPT_LAYOUT_STALE', details)
}

/**
 * Guarda la receta de un venue con compare-and-swap sobre `revision` (spec § 7.2).
 *
 * 🔴 Nunca leer-comprobar-escribir: entre la lectura y la escritura cabe otro administrador.
 * La comparación y el incremento van en la MISMA sentencia (`updateMany` con `revision` en el
 * `where`), que es atómica; la creación la protege el índice único de `venueId`, no un
 * «¿existe?» previo. (P1-4 de la auditoría de Codex del 2-sep.)
 */
export async function putReceiptLayout(params: PutReceiptLayoutParams): Promise<ReceiptLayoutRead> {
  const { venueId, expectedRevision, updatedById } = params
  const blocks = validarOExplotar(params.blocks)

  if (expectedRevision === 0) {
    try {
      await prisma.receiptLayout.create({
        data: {
          venueId,
          blocks: blocks as unknown as Prisma.InputJsonValue,
          schemaVersion: 1,
          revision: 1,
          updatedById: updatedById ?? null,
        },
      })
    } catch (e) {
      // P2002 = el índice único de venueId. Otro administrador creó la fila primero.
      if ((e as { code?: string }).code === 'P2002') return conflictoDeRevision(venueId)
      throw e
    }
  } else {
    const { count } = await prisma.receiptLayout.updateMany({
      where: { venueId, revision: expectedRevision },
      data: {
        blocks: blocks as unknown as Prisma.InputJsonValue,
        revision: { increment: 1 },
        updatedById: updatedById ?? null,
      },
    })
    if (count === 0) return conflictoDeRevision(venueId)
  }

  // Se relee: lo guardado es la verdad, no el objeto que llegó por el cuerpo.
  return getReceiptLayout(venueId)
}

/**
 * «Restablecer»: borra la fila para que el venue vuelva a la canónica (spec § 7.2).
 *
 * 🔴 Con precondición: sin ella, tocar «Restablecer» sobre una pantalla vieja borraría el
 * diseño que otro administrador acaba de guardar. Es el mismo P1-4, en el otro sentido. Y el
 * 409 es el MISMO que al guardar, con el nombre de quien guardó.
 *
 * 🔴 Caso tranquilo, declarado: pedir restablecer cuando YA no hay fila no es un conflicto —
 * el negocio quería la canónica y la canónica es justo lo que tiene. `discardedRevision` sale
 * en `null` para que el controlador no audite algo que no pasó.
 */
export async function resetReceiptLayout(params: {
  venueId: string
  expectedRevision: number
}): Promise<{ layout: ReceiptLayoutRead; discardedRevision: number | null }> {
  const { venueId, expectedRevision } = params
  const { count } = await prisma.receiptLayout.deleteMany({ where: { venueId, revision: expectedRevision } })

  if (count === 0) {
    const vigente = await prisma.receiptLayout.findUnique({ where: { venueId }, select: { revision: true, updatedById: true } })
    if (vigente) return lanzarConflicto(vigente)
    return { layout: await getReceiptLayout(venueId), discardedRevision: null }
  }

  return { layout: await getReceiptLayout(venueId), discardedRevision: expectedRevision }
}
