import { Prisma } from '@prisma/client'
import crypto from 'crypto'
import prisma from '@/utils/prismaClient'

/** SHA-256 en hex. El token en claro NUNCA se guarda. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export async function issueGrant(sessionId: string, familyId: string, token: string, expiresAt: Date) {
  return prisma.refreshGrant.create({
    data: { sessionId, familyId, tokenHash: hashToken(token), expiresAt },
  })
}

export type ResultadoRotacion = { sucesor: string; sessionId: string; familyId: string } | { reutilizado: true }

const REUTILIZADO: ResultadoRotacion = { reutilizado: true }

/**
 * Consume el grant y crea su sucesor en UNA transacción.
 *
 * 🔴 El consumo es un UPDATE CONDICIONAL (`consumedAt: null` en el `where`) y se exige
 * exactamente una fila: es lo único que impide que dos refresh concurrentes consuman
 * el mismo grant y acuñen dos sucesores distintos.
 *
 * Orden deliberado — CONSUME primero, CREA después (al revés del snippet de referencia
 * del brief, que creaba el sucesor antes de consumir):
 *
 *   1. findUnique de sólo lectura, para validar existencia/estado/vigencia.
 *   2. updateMany condicional que consume el grant viejo — aquí se decide la carrera.
 *   3. Sólo si esa fila fue nuestra (count === 1) se crea el sucesor y se enlaza
 *      `rotatedToId` de vuelta al original.
 *
 * Si se creara el sucesor ANTES del updateMany (como en la referencia) y el updateMany
 * devolviera 0 porque otro refresh concurrente ganó la carrera, ese sucesor quedaría
 * huérfano: nadie puede llegar a él (el `rotatedToId` del original nunca se escribe,
 * porque el original ya no es nuestro para actualizarlo) y nadie lo va a consumir jamás.
 * Revertir la transacción entera con un throw evitaría el huérfano en la base de datos
 * real, pero un `create` que ya se ejecutó (aunque luego se revierta) sigue siendo un
 * `create` que se intentó — y el requisito duro es que un refresh perdedor no acuñe
 * sucesor. Consumir primero hace que esa fila jamás llegue a intentarse: no hay nada que
 * revertir porque no hay nada que crear hasta que ya ganamos la carrera.
 */
export async function rotateGrant(token: string, nuevoToken: string, nuevoExpiresAt: Date): Promise<ResultadoRotacion> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const grant = await tx.refreshGrant.findUnique({ where: { tokenHash: hashToken(token) } })
    if (!grant || grant.revokedAt || grant.consumedAt || grant.expiresAt <= new Date()) {
      return REUTILIZADO
    }

    const consumo = await tx.refreshGrant.updateMany({
      where: { tokenHash: hashToken(token), consumedAt: null, revokedAt: null },
      data: { consumedAt: new Date() },
    })
    if (consumo.count !== 1) {
      // Otro refresh concurrente (o un reintento) ganó la carrera entre el findUnique y
      // aquí. No se acuña sucesor: sería un grant sin dueño, porque el original ya no es
      // nuestro para enlazarlo con `rotatedToId`.
      return REUTILIZADO
    }

    const sucesor = await tx.refreshGrant.create({
      data: { sessionId: grant.sessionId, familyId: grant.familyId, tokenHash: hashToken(nuevoToken), expiresAt: nuevoExpiresAt },
    })

    // Enlaza el original con su sucesor. Seguro por `id` (clave única): ya ganamos la
    // única carrera que importaba en el paso anterior, así que esta escritura no compite
    // con nadie — es contabilidad, no concurrencia.
    await tx.refreshGrant.updateMany({
      where: { id: grant.id },
      data: { rotatedToId: sucesor.id },
    })

    return { sucesor: nuevoToken, sessionId: grant.sessionId, familyId: grant.familyId }
  })
}
