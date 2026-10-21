// src/services/shared/lockWait.ts
import { Prisma } from '@prisma/client'
import AppError from '@/errors/AppError'

/**
 * Cómo se reconoce «esperé un candado de más» y «me interbloqueé» en un error de Prisma. Módulo PURO: lo usan las
 * escrituras del diseño de la pantalla del cliente (409 `CUSTOMER_DISPLAY_BUSY`).
 */

function codigoDePostgres(error: unknown): string | undefined {
  const meta = (error as { meta?: { code?: unknown } } | null)?.meta
  return typeof meta?.code === 'string' ? meta.code : undefined
}

/** 40P01: Prisma lo da como P2034 en sus consultas y con el SQLSTATE en `meta.code` en SQL crudo. */
export function esInterbloqueo(error: unknown): boolean {
  if (error instanceof AppError) return false
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return true
  if (codigoDePostgres(error) === '40P01') return true
  return error instanceof Error && /40P01|deadlock/i.test(error.message)
}

/** 55P03 (venció `lock_timeout`) o P2028 (venció la transacción, o no hubo conexión a tiempo para abrirla). */
export function esEsperaVencida(error: unknown): boolean {
  if (error instanceof AppError) return false
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028') return true
  if (codigoDePostgres(error) === '55P03') return true
  return error instanceof Error && /55P03|lock timeout/i.test(error.message)
}

/** Una pausa corta y aleatoria antes de reintentar un interbloqueo: dos que chocaron no vuelven a chocar al mismo tiempo. */
export const esperaCortaAleatoria = (): Promise<void> => new Promise(r => setTimeout(r, 50 + Math.floor(Math.random() * 100)))
