import { Prisma } from '@prisma/client'

import { ConflictError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'

/**
 * Escribe un lote de terminales en UNA transacción.
 *
 * Quien llama escoge las terminales por su negocio (venue u organización) y acota cada escritura a ese
 * mismo negocio. Si alguna terminal se mudó entre la lectura y la escritura, Prisma responde P2025: el
 * lote entero se deshace y se contesta 409, para que el cliente vuelva a intentarlo con la lista vigente.
 * Así una terminal recién mudada nunca recibe los ajustes del dueño anterior (auditoría de Codex del spec
 * «pantalla del cliente», 3ª ronda, 2026-09-16).
 */
export async function runTerminalWritesOrConflict(writes: Prisma.PrismaPromise<unknown>[], conflictMessage: string): Promise<void> {
  try {
    await prisma.$transaction(writes)
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      throw new ConflictError(conflictMessage, 'TERMINAL_MOVED_DURING_UPDATE')
    }
    throw error
  }
}
