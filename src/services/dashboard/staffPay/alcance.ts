// src/services/dashboard/staffPay/alcance.ts — el alcance de un periodo con participación por sede (fase 3, B10-B11).
import { Prisma } from '@prisma/client'
import { BadRequestError, ConflictError } from '../../../errors/AppError'
import { fechaMx } from '../export.helpers'
import { TOPE_SEDES_CON_MODULO } from './acceso'

type Tx = Prisma.TransactionClient

/**
 * El alcance de un periodo (diseño r5.2). PURA: lo que compara llega resuelto ANTES (dentro de la foto o la transacción sólo
 * se compara). CERRADO ⇒ su alcance congelado. Sin activar, o un periodo que termina antes del inicio ⇒ la regla D2 de la
 * fase 2 (`guardadas ∪ activas`), sin ampliar por historia. Desde el inicio ⇒ también las sedes con ventana: toda sede que
 * alguna vez estuvo en el sobre entra a cada cierre y sus devoluciones se descuentan solas (r4.2). Un periodo abierto que
 * CRUZA el inicio no debería existir (`startDate` es un inicio canónico y la periodicidad queda fija al activar): 409.
 */
export function alcanceDelPeriodo(input: {
  periodo: { start: string; end: string; estado: 'OPEN' | 'CLOSED' }
  guardadas: string[]
  activas: string[]
  conVentana: string[]
  startDate: string | null
}): string[] {
  const unir = (...listas: string[][]) => [...new Set(listas.flat())].sort()
  const { periodo: p, startDate } = input
  if (p.estado === 'CLOSED') return unir(input.guardadas)
  if (startDate === null || p.end < startDate) return unir(input.guardadas, input.activas)
  if (p.start >= startDate) return unir(input.guardadas, input.activas, input.conVentana)
  // B12 (revisión de B11 #2): 409 en español para el reporte, el recibo, la vista previa y el cierre; antes salía como 500.
  throw new ConflictError(
    `El periodo cruza el inicio de pago al personal; el periodo del ${fechaMx(p.start)} al ${fechaMx(p.end)} empieza antes del ${fechaMx(startDate)} y termina después. Pide ayuda a Avoqado para corregirlo.`,
    'STAFF_PAY_PERIODO_CRUZA_EL_INICIO',
    { periodo: { start: p.start, end: p.end }, inicio: startDate },
  )
}

/**
 * Las sedes con ALGUNA ventana (abierta o cerrada) en la organización (r4.2): su historia en el sobre. Con el mismo tope de
 * sedes que `sedesConServicePay`; pasado, truena (un recorte dejaría a la sede 501 fuera del alcance sin avisar).
 */
export async function sedesConVentana(db: Pick<Tx, '$queryRaw'>, organizationId: string): Promise<string[]> {
  const tope = TOPE_SEDES_CON_MODULO
  const filas = await db.$queryRaw<Array<{ venueId: string }>>(Prisma.sql`
    SELECT DISTINCT "venueId" FROM "StaffPayVenueWindow" WHERE "organizationId" = ${organizationId}
    ORDER BY "venueId" LIMIT ${tope + 1}`)
  if (filas.length > tope) {
    throw new BadRequestError(
      `Esta organización tiene más de ${tope} sedes con pago al personal: el cierre no puede continuar; contacta a Avoqado.`,
      'DEMASIADAS_SEDES',
    )
  }
  return filas.map(f => f.venueId)
}
