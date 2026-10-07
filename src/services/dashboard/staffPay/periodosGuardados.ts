import { Prisma, ServicePayPeriod } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/AppError'
import { PresupuestoDeEspera, tomarCandado, transaccionConPresupuesto } from '../../../utils/esperaDeCandados'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { assertPermisoEnSedes, assertPermisoEnTodasLasSedes, exigirPermisoEnSedes, sedesConServicePay, sedesLegiblesDe } from './acceso'
import { fechaMx } from '../export.helpers'
import { alcanceDelPeriodo, sedesConVentana } from './alcance'
import {
  dbDateComoFecha,
  diaCivilSiguiente,
  fechaComoDbDate,
  hoyLocal,
  MESES_LARGOS,
  Periodicidad,
  periodoQueContiene,
  sumarMeses,
} from './periodos'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma

/** Los dos candados que retiene un CIERRE (el de periodos de la organización y la fila de su periodo): quien los espera y
 *  agota su presupuesto contesta 409 CIERRE_EN_CURSO (B7 r1-r2). Los demás candados usan `OPERACION_EN_CURSO`. */
export const MENSAJE_CIERRE_EN_CURSO = 'Hay un cierre de periodo en curso; intenta de nuevo en un momento'
const CIERRE_EN_CURSO = { codigo: 'CIERRE_EN_CURSO', mensaje: MENSAJE_CIERRE_EN_CURSO }

/**
 * Candado por organización para crear periodos y cambiar la periodicidad (spec §5.7), también de activar y de las propinas.
 * Con el presupuesto de la transacción (B9: también el cierre, que ya no espera sin tope).
 */
export async function lockPeriodosDeOrganizacion(tx: Tx, organizationId: string, presupuesto: PresupuestoDeEspera): Promise<void> {
  const key = `avoqado:service-pay-periods:v1:${organizationId}`
  await tomarCandado(tx, () => tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`), {
    presupuesto,
    ...CIERRE_EN_CURSO,
  })
}

export async function periodoQueContieneFecha(db: Db, organizationId: string, fecha: string): Promise<ServicePayPeriod | null> {
  const d = fechaComoDbDate(fecha)
  return db.servicePayPeriod.findFirst({ where: { organizationId, periodStart: { lte: d }, periodEnd: { gte: d } } })
}

/**
 * El periodo que contiene `fecha`; si no existe, se deriva de la periodicidad y se crea. Con SERIALIZABLE la foto se toma en la
 * primera sentencia, antes de esperar el candado: lo que hace correcta la carrera es SSI + el índice único
 * (organizationId, periodStart) + el reintento de `withSerializableRetry`, no el candado.
 * `presupuesto`: el de la transacción que lo llama (B9). `activas`: las sedes con el módulo, ya resueltas ANTES de la
 * transacción (el cierre las pasa para no consultar el cliente global aquí dentro). Sin ellas se consultan, como siempre.
 */
export async function asegurarPeriodo(
  tx: Tx,
  organizationId: string,
  fecha: string,
  presupuesto: PresupuestoDeEspera,
  activas?: string[],
): Promise<ServicePayPeriod> {
  const existente = await periodoQueContieneFecha(tx, organizationId, fecha)
  if (existente) return existente
  await lockPeriodosDeOrganizacion(tx, organizationId, presupuesto)
  const ganador = await periodoQueContieneFecha(tx, organizationId, fecha)
  if (ganador) return ganador
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { servicePayPeriodicity: true } })
  const p = periodoQueContiene(fecha, org.servicePayPeriodicity)
  const traslape = await tx.servicePayPeriod.findFirst({
    where: { organizationId, periodStart: { lte: fechaComoDbDate(p.end) }, periodEnd: { gte: fechaComoDbDate(p.start) } },
    select: { id: true },
  })
  if (traslape) throw new ConflictError('Ya hay un periodo guardado que se cruza con estas fechas')
  return tx.servicePayPeriod.create({
    data: {
      organizationId,
      periodStart: fechaComoDbDate(p.start),
      periodEnd: fechaComoDbDate(p.end),
      venueIds: [...(activas ?? (await sedesConServicePay(organizationId)))].sort(),
    },
  })
}

/**
 * Candado de UNA clase (spec §5 paso 2), compartido por el ajuste de clase y la liquidación (Codex R1-6). El cierre NO lo
 * toma (serían 50,000 candados): el cierre se protege con el candado del periodo —o el de la organización mientras crea
 * el periodo—, que el ajuste toma ANTES que éste. Orden único: periodo (u organización) → clase.
 */
export async function lockClase(tx: Tx, classSessionId: string, presupuesto: PresupuestoDeEspera): Promise<void> {
  const key = `avoqado:service-pay-class:v1:${classSessionId}`
  // B9: antes sin tope; ahora con el presupuesto de la transacción (lo retiene otro ajuste o una liquidación, no un cierre).
  await tomarCandado(tx, () => tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`), {
    presupuesto,
  })
}

/**
 * Candado del periodo (spec §5 paso 2). Sólo bloquea: ampliar el alcance es `ampliarAlcance`, con permiso (Codex R1-9).
 * `FOR NO KEY UPDATE` y no `FOR UPDATE`: sigue serializando a todos los escritores del periodo entre sí (choca con otro
 * NO KEY UPDATE y con el `UPDATE status` del cierre), pero NO con el `FOR KEY SHARE` que toma la llave foránea de quien
 * sólo apunta al periodo (anclar una clase, un devengo). Con `FOR UPDATE`, un ajuste con el periodo tomado esperando la
 * clase y una liquidación con la clase tomada anclándola en el periodo se bloqueaban mutuamente (40P01, sin reintento).
 */
export async function bloquearPeriodo(tx: Tx, periodId: string, presupuesto: PresupuestoDeEspera): Promise<ServicePayPeriod> {
  // B7 r2 / B9: con el presupuesto de la transacción (el cierre retiene esta fila todo lo que dura).
  const filas = await tomarCandado(
    tx,
    () => tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM "ServicePayPeriod" WHERE id = ${periodId} FOR NO KEY UPDATE`),
    { presupuesto, ...CIERRE_EN_CURSO },
  )
  if (!filas.length) throw new NotFoundError('Periodo no encontrado')
  return tx.servicePayPeriod.findUniqueOrThrow({ where: { id: periodId } })
}

/**
 * Amplía el alcance de un periodo OPEN ya bloqueado (spec §5.6, §5.7; D2). Exige `staffpay:close` del actor en TODA la
 * unión —las sedes que el periodo ya tiene más las nuevas—, no sólo en las nuevas (Codex R2-R1-9): con permiso sólo en
 * BSF nadie amplía un periodo de PN a PN+BSF. `exigirModulo` (default true) pide que la sede tenga hoy el módulo; la
 * liquidación lo apaga para que la deuda de una sede que se desactivó tenga dónde caer (spec §5.6).
 * `activas` y `permitidas` (opcionales): módulos y permisos ya resueltos ANTES de la transacción; con ellos no se consulta
 * el cliente global aquí dentro (lo usa el cierre). Sin ellos se consultan, como siempre.
 */
export async function ampliarAlcance(
  tx: Tx,
  p: ServicePayPeriod,
  venueIds: string[],
  userId: string,
  o: { exigirModulo?: boolean; activas?: string[]; permitidas?: ReadonlySet<string> } = {},
): Promise<ServicePayPeriod> {
  const nuevas = [...new Set(venueIds)].filter(v => !p.venueIds.includes(v)).sort()
  if (!nuevas.length) return p
  if (p.status !== 'OPEN') throw new ConflictError('Ese periodo ya está cerrado: su alcance no cambia', 'PERIODO_CERRADO')
  const deLaOrg = await tx.venue.count({ where: { id: { in: nuevas }, organizationId: p.organizationId } })
  if (deLaOrg !== nuevas.length) throw new NotFoundError('Sede no encontrada')
  if (o.exigirModulo !== false) {
    const activas = o.activas ?? (await sedesConServicePay(p.organizationId))
    if (nuevas.some(v => !activas.includes(v))) throw new BadRequestError('Esa sede no tiene Pago por servicio activo', 'SEDE_SIN_MODULO')
  }
  const union = [...p.venueIds, ...nuevas].sort()
  const explicacion = 'Para sumar una sede al periodo necesitas el permiso de cerrar periodos en todas sus sedes'
  if (o.permitidas) exigirPermisoEnSedes(o.permitidas, union, explicacion)
  else await assertPermisoEnSedes(userId, union, 'staffpay:close', explicacion)
  return tx.servicePayPeriod.update({ where: { id: p.id }, data: { venueIds: union } })
}

/**
 * Alcance LEGIBLE de un periodo, el MISMO para el reporte y el recibo (Codex R1-1, R3-Nuevo 2): uno CERRADO se lee sobre
 * SU alcance guardado; uno ABIERTO (o aún sin guardar) sobre sus sedes guardadas ∪ las que hoy tienen el módulo —así una
 * diferencia liquidada desde una sede que ya lo apagó no desaparece del reporte— y, desde el inicio de pago al personal,
 * ∪ las sedes con alguna ventana (B11, `alcanceDelPeriodo`). Siempre filtrado por el permiso de quien lee y, si viene, por
 * `sede` (si no es legible: vacío y `parcial`). `o.periodo`: el canónico (guardado o no); `o.startDate`: el inicio.
 */
export async function alcanceLegibleDelPeriodo(
  userId: string,
  organizationId: string,
  fila: { status: 'OPEN' | 'CLOSED'; venueIds: string[] } | null,
  sede: string | undefined,
  o: { periodo: { start: string; end: string }; startDate: string | null },
): Promise<{ venueIds: string[]; parcial: boolean }> {
  const alcance = alcanceDelPeriodo({
    periodo: { ...o.periodo, estado: fila?.status ?? 'OPEN' },
    guardadas: fila?.venueIds ?? [],
    activas: fila?.status === 'CLOSED' ? [] : await sedesConServicePay(organizationId),
    conVentana: fila?.status === 'CLOSED' ? [] : await sedesConVentana(prisma, organizationId),
    startDate: o.startDate,
  })
  const legibles = await sedesLegiblesDe(userId, alcance)
  const venueIds = sede ? legibles.venueIds.filter(id => id === sede) : legibles.venueIds
  return { venueIds, parcial: legibles.parcial || (sede !== undefined && venueIds.length === 0) }
}

/**
 * Una fecha de negocio dentro de un rango razonable (full-testing A6/A11): fuera ⇒ 400 `FECHA_FUERA_DE_RANGO` con
 * `details { desde, hasta }` ('YYYY-MM-DD'), ANTES de crear o simular nada. `que`: «La fecha del ajuste», «La fecha de inicio»…
 */
export function assertFechaEnRango(fecha: string, rango: { desde: string; hasta: string }, que: string): void {
  fechaComoDbDate(fecha) // la forma, antes de comparar como texto
  if (fecha < rango.desde || fecha > rango.hasta) {
    throw new BadRequestError(`${que} debe estar entre ${fechaMx(rango.desde)} y ${fechaMx(rango.hasta)}`, 'FECHA_FUERA_DE_RANGO', rango)
  }
}

/** Vigencia de una tabla o un nivel (y la fecha de archivo de una tabla): de hoy − 24 meses a hoy + 24 meses. */
export const rangoDeVigencia = (hoy: string) => ({ desde: sumarMeses(hoy, -24), hasta: sumarMeses(hoy, 24) })

/** «Hoy» en la zona de la sede (`ahora`: sólo pruebas). */
export async function hoyDeLaSede(venueId: string, ahora?: Date): Promise<string> {
  const v = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  if (!v) throw new NotFoundError('Sede no encontrada')
  return hoyLocal(v.timezone || 'America/Mexico_City', ahora)
}

/** «Septiembre» si es el mes completo; si no, «La quincena del 1 sep 2026 al 15 sep 2026». */
export function nombreDelPeriodo(start: string, end: string): string {
  const mes = MESES_LARGOS[Number(start.slice(5, 7)) - 1]
  return start.endsWith('-01') && diaCivilSiguiente(end).endsWith('-01')
    ? `${mes[0].toUpperCase()}${mes.slice(1)}`
    : `La quincena del ${fechaMx(start)} al ${fechaMx(end)}`
}

/**
 * Spec §5.2 y §5.3: una vigencia (o un archivo) dentro de un periodo cerrado no se acepta. `details.primeraFechaPermitida`:
 * el primer día después de los periodos cerrados seguidos que contienen la fecha. Con `accion` («la tabla no puede empezar»)
 * el mensaje lo dice así y remite a «Ajustar monto» (revisión final, I-2); sin ella, el genérico de siempre.
 */
export async function assertFechaNoCerrada(db: Db, organizationId: string, fecha: string, accion?: string): Promise<void> {
  const p = await periodoQueContieneFecha(db, organizationId, fecha)
  if (p?.status !== 'CLOSED') return
  const start = dbDateComoFecha(p.periodStart)
  const end = dbDateComoFecha(p.periodEnd)
  let primera = diaCivilSiguiente(end)
  // ponytail: un paso por periodo cerrado seguido; con más de 120 (10 años mensuales) se queda en el que llegó.
  for (let i = 0; i < 120; i++) {
    const siguiente = await periodoQueContieneFecha(db, organizationId, primera)
    if (siguiente?.status !== 'CLOSED') break
    primera = diaCivilSiguiente(dbDateComoFecha(siguiente.periodEnd))
  }
  const mensaje = accion
    ? `${nombreDelPeriodo(start, end)} ya se cerró: ${accion} antes del ${fechaMx(primera)}. Para una clase de un mes cerrado usa «Ajustar monto» en la clase`
    : `El periodo del ${start} al ${end} ya está cerrado: elige una fecha posterior`
  throw new BadRequestError(mensaje, 'FECHA_EN_PERIODO_CERRADO', { primeraFechaPermitida: primera })
}

export interface PeriodoListado {
  id: string | null
  start: string
  end: string
  estado: 'OPEN' | 'CLOSED'
  personas: number
  pagadas: number
  total: string
}
export interface ListaPeriodos {
  periodicidad: Periodicidad
  puedeCambiarPeriodicidad: boolean
  items: PeriodoListado[]
  /** Para «Cargar más» del historial guardado: periodos que empiezan antes de esta fecha. */
  antesDe: string | null
}

const PERIODOS_CANONICOS = 12

/** Los últimos N periodos canónicos hasta el actual (D1: no hace falta guardarlos para poder cerrarlos — Codex R1-16). */
function canonicosHastaHoy(hoy: string, periodicidad: Periodicidad, n: number) {
  const out = [periodoQueContiene(hoy, periodicidad)]
  while (out.length < n) {
    const previo = new Date(`${out[out.length - 1].start}T12:00:00Z`)
    previo.setUTCDate(previo.getUTCDate() - 1)
    out.push(periodoQueContiene(previo.toISOString().slice(0, 10), periodicidad))
  }
  return out
}

/**
 * Lista de periodos (spec §7.3). La primera página mezcla los últimos 12 periodos canónicos (aunque no estén guardados:
 * septiembre se puede cerrar el 1 de octubre sin que nadie lo haya «creado») con los guardados; las siguientes traen
 * sólo guardados más viejos. Los números salen de las sedes del alcance de cada periodo que el usuario puede leer.
 */
export async function listarPeriodos(input: { userId: string; venueId: string; antesDe?: string; limit: number }): Promise<ListaPeriodos> {
  const v = await prisma.venue.findUniqueOrThrow({
    where: { id: input.venueId },
    select: { organizationId: true, timezone: true, organization: { select: { servicePayPeriodicity: true, staffPayStartDate: true } } },
  })
  const limit = Math.min(Math.max(input.limit, 1), 60)
  const periodicidad = v.organization.servicePayPeriodicity
  const filas = await prisma.servicePayPeriod.findMany({
    where: { organizationId: v.organizationId, ...(input.antesDe ? { periodStart: { lt: fechaComoDbDate(input.antesDe) } } : {}) },
    orderBy: { periodStart: 'desc' },
    take: limit + 1,
  })
  const hayMas = filas.length > limit
  const guardados = filas.slice(0, limit)
  const alcance = [...new Set(guardados.flatMap(f => f.venueIds))]
  const { venueIds } = await sedesLegiblesDe(input.userId, alcance)
  const resumen =
    guardados.length && venueIds.length
      ? await prisma.$queryRaw<Array<{ periodId: string; personas: number; pagadas: number; total: Prisma.Decimal | null }>>`
        SELECT e."periodId", COUNT(DISTINCT e."staffId")::int AS personas,
               COUNT(DISTINCT e."staffId") FILTER (WHERE st."paidAt" IS NOT NULL)::int AS pagadas,
               SUM(e.amount) AS total
        FROM "ServiceEarning" e
        LEFT JOIN "StaffPayStatement" st ON st."periodId" = e."periodId" AND st."staffId" = e."staffId"
        WHERE e."periodId" IN (${Prisma.join(guardados.map(f => f.id))}) AND e."venueId" IN (${Prisma.join(venueIds)})
        GROUP BY e."periodId"`
      : []
  const porId = new Map(resumen.map(r => [r.periodId, r]))
  const items: PeriodoListado[] = guardados.map(f => ({
    id: f.id,
    start: dbDateComoFecha(f.periodStart),
    end: dbDateComoFecha(f.periodEnd),
    estado: f.status,
    personas: porId.get(f.id)?.personas ?? 0,
    pagadas: porId.get(f.id)?.pagadas ?? 0,
    total: (porId.get(f.id)?.total ?? new Prisma.Decimal(0)).toFixed(2),
  }))
  if (!input.antesDe) {
    for (const c of canonicosHastaHoy(hoyLocal(v.timezone || 'America/Mexico_City'), periodicidad, PERIODOS_CANONICOS)) {
      const cubierto = guardados.some(f => dbDateComoFecha(f.periodStart) <= c.end && dbDateComoFecha(f.periodEnd) >= c.start)
      if (!cubierto) items.push({ id: null, start: c.start, end: c.end, estado: 'OPEN', personas: 0, pagadas: 0, total: '0.00' })
    }
    items.sort((x, y) => y.start.localeCompare(x.start))
  }
  const totalGuardados = input.antesDe ? 1 : await prisma.servicePayPeriod.count({ where: { organizationId: v.organizationId } })
  return {
    periodicidad,
    // B9 (diseño r6.4): tampoco después de activar el pago al personal, aunque no haya ningún periodo guardado.
    puedeCambiarPeriodicidad: !input.antesDe && totalGuardados === 0 && v.organization.staffPayStartDate === null,
    items,
    antesDe: hayMas ? dbDateComoFecha(guardados[guardados.length - 1].periodStart) : null,
  }
}

/**
 * D3: mensual o quincenal, sólo mientras no haya ningún periodo guardado (spec §5.7) y —B9, diseño r6.4— mientras no se
 * haya activado el pago al personal: `staffPayStartDate` es el inicio de un periodo canónico y ningún periodo puede cruzarlo.
 * Las dos cosas se miran bajo el candado de la organización (activar también lo toma).
 */
export async function cambiarPeriodicidad(input: { userId: string; venueId: string; periodicidad: Periodicidad }) {
  if (input.periodicidad !== 'MONTHLY' && input.periodicidad !== 'SEMIMONTHLY') throw new BadRequestError('Periodicidad inválida')
  const v = await prisma.venue.findUniqueOrThrow({ where: { id: input.venueId }, select: { organizationId: true } })
  await assertPermisoEnTodasLasSedes(input.userId, v.organizationId, 'staffpay:close')
  return transaccionConPresupuesto(async (tx, presupuesto) => {
    await lockPeriodosDeOrganizacion(tx, v.organizationId, presupuesto)
    const antes = await tx.organization.findUniqueOrThrow({
      where: { id: v.organizationId },
      select: { servicePayPeriodicity: true, staffPayStartDate: true },
    })
    if (antes.staffPayStartDate) {
      throw new ConflictError(
        `La periodicidad quedó fija al activar el pago al personal (${antes.servicePayPeriodicity === 'SEMIMONTHLY' ? 'quincenal' : 'mensual'})`,
        'PERIODICIDAD_FIJA',
      )
    }
    if ((await tx.servicePayPeriod.count({ where: { organizationId: v.organizationId } })) > 0) {
      throw new ConflictError('La periodicidad ya no se puede cambiar: ya hay periodos guardados')
    }
    await tx.organization.update({ where: { id: v.organizationId }, data: { servicePayPeriodicity: input.periodicidad } })
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.userId,
      venueId: input.venueId,
      action: 'SERVICE_PAY_PERIODICITY_SET',
      entity: 'Organization',
      entityId: v.organizationId,
      data: { antes: antes.servicePayPeriodicity, despues: input.periodicidad },
    })
    return { periodicidad: input.periodicidad }
  })
}
