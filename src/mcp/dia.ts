import { z } from 'zod'

/**
 * Un día de calendario `AAAA-MM-DD`, como texto. Las herramientas le pegan la hora (`${dia}T00:00:00.000`) y lo leen en la
 * zona del negocio. Sin este freno, una fecha con hora (`2026-11-20T00:00:00Z`) quedaba `…ZT00:00:00.000` → Invalid Date →
 * Prisma tronaba (monitor de Render, 26-nov). Con él, el asistente recibe un error que entiende y corrige.
 */
export const DIA = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa el formato AAAA-MM-DD (sólo el día, sin hora)')
  // 2026-02-30 pasa el patrón y no es un día (se correría a marzo).
  .refine(d => {
    const t = new Date(`${d}T00:00:00Z`)
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d
  }, 'Esa fecha no existe')
