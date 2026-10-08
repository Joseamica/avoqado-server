/**
 * Campos que el cuerpo de «editar organización» o «editar sede» no puede traer (I4 de la revisión final, fase 3).
 *
 * `PUT /organizations/:orgId` y `PUT /dashboard/venues/:venueId` pasan `req.body` casi tal cual a `prisma.*.update`. Así un
 * OWNER podía mover `staffPayStartDate` (el «no vuelve a cambiar» del que dependen el barrido, ANTES_DEL_INICIO y el aborto
 * de la migración …000230), cambiar la periodicidad, escribir relaciones anidadas de Pago al personal (`staffPayLevels`,
 * `servicePayTables`…) o ponerse `seatCapExempt` y tener el plan entero gratis, SERVICE_PAY incluida. Cada uno tiene su
 * camino: Pago al personal (activar, periodicidad) y superadmin (la exención de plan).
 *
 * Arreglo MÍNIMO: esos campos responden 400 y nada se escribe. La lista blanca general de las dos rutas es aparte
 * (`task_370d0fa6`).
 */
import { BadRequestError } from '../../errors/AppError'

const RESERVADO = /^(staffPay|servicePay)|^seatCapExempt$/i

/** Devuelve el cuerpo tal cual si no trae campos reservados; si los trae, 400 `CAMPOS_RESERVADOS` con su lista. */
export function sinCamposReservados<T>(body: T): T {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body
  const campos = Object.keys(body).filter(campo => RESERVADO.test(campo))
  if (campos.length === 0) return body
  throw new BadRequestError(
    `Estos campos no se cambian desde aquí: ${campos.join(', ')}. La fecha de inicio y la periodicidad se configuran en Pago al personal, y la exención de plan sólo la cambia Avoqado.`,
    'CAMPOS_RESERVADOS',
    { campos },
  )
}
