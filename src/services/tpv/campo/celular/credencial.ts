/**
 * La credencial del celular de campo: 64 hex que el celular manda en `X-Celular-Credencial`. En Postgres sólo vive su
 * sha256 (`CelularDeCampo.credencialHash`, único). Identifica al APARATO, no a la persona: entrar sigue pidiendo el PIN.
 */
import { createHash } from 'crypto'
import { NextFunction, Request, Response } from 'express'
import { UnauthorizedError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

export const CABECERA_CREDENCIAL = 'x-celular-credencial'

/** Etiqueta de la `Session` del celular. Sólo etiqueta: lo que prueba que una sesión es suya es `CelularDeCampo.sesionId`. */
export const deviceIdDelCelular = (celularId: string): string => `celular:${celularId}`

export const hashDeCredencial = (credencial: string): string => createHash('sha256').update(credencial).digest('hex')

/** Deja la fila en `res.locals.celular` en cualquier estado (vinculado o no): cada ruta decide qué hace con un desvinculado. */
export async function autenticarCelular(req: Request, res: Response, next: NextFunction) {
  try {
    const credencial = req.headers[CABECERA_CREDENCIAL]
    const celular =
      typeof credencial === 'string' && /^[a-f0-9]{64}$/.test(credencial)
        ? await prisma.celularDeCampo.findUnique({ where: { credencialHash: hashDeCredencial(credencial) } })
        : null
    if (!celular)
      return next(new UnauthorizedError('Este celular no está registrado. Actívalo con el código de tu supervisor.', 'CELULAR_DESCONOCIDO'))
    res.locals.celular = celular
    next()
  } catch (error) {
    next(error)
  }
}
