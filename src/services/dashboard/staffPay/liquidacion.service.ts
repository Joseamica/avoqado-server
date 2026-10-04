import { createHash } from 'crypto'
import { Prisma, ServicePayCountMode, ServicePayPeriod } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/AppError'
import { withSerializableRetry } from '../../../utils/serializableRetry'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { exigirPermisoEnSedes, sedesConPermiso, sedesConServicePay } from './acceso'
import { ampliarAlcance, asegurarPeriodo, bloquearPeriodo, lockClase, periodoQueContieneFecha } from './periodosGuardados'
import { dbDateComoFecha, hoyLocal, periodoQueContiene } from './periodos'
import { anclarClases, descriptorDeClase } from './cierre.service'
import { diferenciasDeClase, FilaDiferencia } from './diferencias.service'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma
const TZ_DEFAULT = 'America/Mexico_City'
/** Sin `:`: la clave de cada línea es `${solicitudId}:${persona}` y el prefijo tiene que ser inequívoco. */
const CLAVE = /^[A-Za-z0-9_.-]{8,100}$/
const SIN_PERMISO = 'Para liquidar necesitas el permiso de cerrar periodos en la sede de la clase y en todas las del periodo destino'

export interface PreviewLiquidacion {
  periodoOrigen: { id: string; start: string; end: string } | null
  destino: Destino
  filas: FilaDiferencia[]
  total: string
  bloqueada: boolean
  huella: string
}
export interface ResultadoLiquidacion {
  lineas: Array<{ staffId: string; amount: string }>
  yaLiquidada: boolean
}

type Destino = { start: string; end: string; venueIds: string[] }
type Previa = { id: string; periodId: string; staffId: string; concept: string; amount: Prisma.Decimal }

/**
 * TODOS los devengos previos de la clase, por cursor (`id` ascendente, lotes de 1,000) y SIN tope total (Codex R1-7 /
 * R2-R1-7): un +$40/−$40 más allá de cualquier tope también cambia la huella. El preview y la liquidación llaman a esta
 * MISMA función: mismo recorrido, mismo orden.
 */
async function devengosDeClase(db: Db, organizationId: string, classSessionId: string): Promise<Previa[]> {
  const todos: Previa[] = []
  let despuesDe: string | undefined
  for (;;) {
    const page = await db.serviceEarning.findMany({
      where: { organizationId, sourceType: 'CLASS_SESSION', sourceId: classSessionId, ...(despuesDe ? { id: { gt: despuesDe } } : {}) },
      select: { id: true, periodId: true, staffId: true, concept: true, amount: true },
      orderBy: { id: 'asc' },
      take: 1000,
    })
    if (!page.length) return todos
    todos.push(...page)
    despuesDe = page[page.length - 1].id
  }
}

/**
 * Huella de la liquidación (spec §6.4 paso 5): clase, origen, destino y su alcance, cada persona con sus montos y cada
 * devengo previo. Las filas van en el orden de la consulta (clase, persona), el mismo en el preview y al liquidar.
 * Un solo `digest()`.
 */
function huellaLiquidacion(p: {
  classSessionId: string
  origenId: string | null
  destino: Destino
  filas: FilaDiferencia[]
  previas: Previa[]
}) {
  const h = createHash('sha256')
  const linea = (xs: Array<string | number | null>) => h.update(`${xs.map(x => x ?? '∅').join('|')}\n`)
  linea(['L', p.classSessionId, p.origenId, p.destino.start, p.destino.end, [...p.destino.venueIds].sort().join(',')])
  for (const f of p.filas) {
    linea([
      'D',
      f.persona,
      f.estadoClase,
      f.corresponde,
      f.congelado,
      f.conciliado,
      f.pendiente,
      f.tableVersionId,
      f.payLevelId,
      f.countMode,
      f.conteo,
    ])
  }
  for (const e of p.previas) linea(['E', e.id, e.periodId, e.staffId, e.concept, e.amount.toFixed(2)])
  return h.digest('hex')
}

const destinoDe = (p: ServicePayPeriod): Destino => ({
  start: dbDateComoFecha(p.periodStart),
  end: dbDateComoFecha(p.periodEnd),
  venueIds: [...p.venueIds].sort(),
})

async function contextoClase(venueId: string, classSessionId: string) {
  const cs = await prisma.classSession.findFirst({
    where: { id: classSessionId, venueId },
    select: { venue: { select: { organizationId: true, timezone: true, name: true } } },
  })
  if (!cs) throw new NotFoundError('Clase no encontrada')
  return { organizationId: cs.venue.organizationId, tz: cs.venue.timezone || TZ_DEFAULT, nombreSede: cs.venue.name }
}

/** El destino como lo verá la liquidación al bloquearlo: el guardado tal cual (bloquear NO amplía), o el que nacería. */
async function destinoSinCandado(organizationId: string, fecha: string): Promise<Destino> {
  const fila = await periodoQueContieneFecha(prisma, organizationId, fecha)
  if (fila) return destinoDe(fila)
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { servicePayPeriodicity: true } })
  return { ...periodoQueContiene(fecha, org.servicePayPeriodicity), venueIds: [...(await sedesConServicePay(organizationId))].sort() }
}

/** Lo que se liquidaría (no escribe). El permiso de leer lo pone la ruta (`staffpay:read`). */
export async function previewLiquidacion(input: {
  userId: string
  venueId: string
  classSessionId: string
  destinoFecha?: string
  ahora?: Date
}): Promise<PreviewLiquidacion> {
  const ctx = await contextoClase(input.venueId, input.classSessionId)
  const ahora = input.ahora ?? new Date()
  const destino = await destinoSinCandado(ctx.organizationId, input.destinoFecha ?? hoyLocal(ctx.tz, ahora))
  const { origen, filas } = await diferenciasDeClase(prisma, { venueId: input.venueId, classSessionId: input.classSessionId }, { ahora })
  const previas = await devengosDeClase(prisma, ctx.organizationId, input.classSessionId)
  return {
    periodoOrigen: origen ? { id: origen.id, start: dbDateComoFecha(origen.periodStart), end: dbDateComoFecha(origen.periodEnd) } : null,
    destino,
    filas,
    total: filas.reduce((a, f) => (f.pendiente === null ? a : a.plus(f.pendiente)), new Prisma.Decimal(0)).toFixed(2),
    bloqueada: filas.some(f => f.pendiente === null),
    huella: huellaLiquidacion({ classSessionId: input.classSessionId, origenId: origen?.id ?? null, destino, filas, previas }),
  }
}

/** Nivel de la PRIMERA línea de la persona en la clase, aunque haya sido NULL (Codex R1-5). */
async function nivelDePrimeraLinea(tx: Tx, organizationId: string, classSessionId: string, staffId: string) {
  return tx.serviceEarning.findFirst({
    where: { organizationId, sourceType: 'CLASS_SESSION', sourceId: classSessionId, staffId, concept: { in: ['SERVICE', 'RECONCILE'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { payLevelId: true, payLevelName: true },
  })
}

/** Centinela: la huella cambió. Se convierte en `ConflictError HUELLA_CAMBIO` FUERA de la transacción (ya revertida). */
class HuellaCambio extends Error {}

/**
 * «Liquidar diferencia» de UNA clase (spec §6.4), una sola vez, con el protocolo único (§5): SERIALIZABLE → candado del
 * periodo DESTINO → candado de la CLASE → releer y decidir dentro. El periodo de ORIGEN sólo se lee, nunca se bloquea: el
 * ajuste de clase toma origen → clase, y destino → clase → origen sería un ciclo (40P01, que no se reintenta). Anclar la
 * clase en el origen sólo toma `FOR KEY SHARE` por la llave foránea, compatible con el `FOR NO KEY UPDATE` del ajuste.
 */
export async function liquidarDiferencia(input: {
  userId: string
  venueId: string
  classSessionId: string
  periodoOrigenId: string
  huellaEsperada: string
  solicitudId: string
  destinoFecha?: string
  ampliarAlcance?: boolean
  ahora?: Date
}): Promise<ResultadoLiquidacion> {
  if (typeof input.solicitudId !== 'string' || !CLAVE.test(input.solicitudId)) throw new BadRequestError('Clave de solicitud inválida')
  const ctx = await contextoClase(input.venueId, input.classSessionId)
  const { organizationId } = ctx
  const ahora = input.ahora ?? new Date()
  const fecha = input.destinoFecha ?? hoyLocal(ctx.tz, ahora)
  const prefijo = `${input.solicitudId}:`
  // Módulos y permisos con el cliente GLOBAL, ANTES de la transacción (regla del Bloque A, como el cierre): dentro
  // retendrían su conexión mientras piden otra. Candidatas: la sede de la clase ∪ el destino como está ahora ∪ las sedes con
  // el módulo (el destino que nazca las toma) ∪ los destinos ya guardados de esta solicitud. Dentro sólo se COMPARA; una
  // sede que entró entretanto no tiene permiso resuelto y se niega (conservador).
  const activas = await sedesConServicePay(organizationId)
  const destinoAntes = await periodoQueContieneFecha(prisma, organizationId, fecha)
  const guardadosAntes = await prisma.servicePayPeriod.findMany({
    where: { organizationId, earnings: { some: { organizationId, clientKey: { startsWith: prefijo } } } },
    select: { venueIds: true },
    take: 100,
  })
  const candidatas = [input.venueId, ...(destinoAntes?.venueIds ?? []), ...activas, ...guardadosAntes.flatMap(p => p.venueIds)]
  const permitidas = new Set(await sedesConPermiso(input.userId, candidatas, 'staffpay:close'))
  try {
    return await withSerializableRetry(async tx => {
      // 0) Idempotencia PRIMERO (Codex R2-R1-4 / R2-Nuevo 4), por organización (la clave es única por organización): una
      // repetición se reconoce aunque su destino ya se haya cerrado. La restricción única sigue siendo la red ante la carrera.
      const previas = await tx.serviceEarning.findMany({
        where: { organizationId, clientKey: { startsWith: prefijo } },
        select: { staffId: true, amount: true, sourceId: true, periodId: true },
        orderBy: { staffId: 'asc' },
        take: 1000,
      })
      if (previas.length) {
        // La clave es de ESTA clase o es un error, no el éxito de otra (Codex R1-4).
        if (previas.some(p => p.sourceId !== input.classSessionId)) {
          throw new ConflictError('Esa clave ya se usó para otra liquidación', 'CLAVE_REUTILIZADA')
        }
        // Permiso sobre el destino YA GUARDADO (puede estar cerrado): la respuesta repetida no regala montos.
        const guardados = await tx.servicePayPeriod.findMany({
          where: { id: { in: [...new Set(previas.map(p => p.periodId))] }, organizationId },
          select: { venueIds: true },
          take: previas.length,
        })
        exigirPermisoEnSedes(permitidas, [input.venueId, ...guardados.flatMap(g => g.venueIds)], SIN_PERMISO)
        return { lineas: previas.map(p => ({ staffId: p.staffId, amount: p.amount.toFixed(2) })), yaLiquidada: true }
      }
      // 1) Periodo destino (por default el de hoy): sólo una inserción NUEVA exige que esté abierto.
      const fila = await asegurarPeriodo(tx, organizationId, fecha, activas)
      let destino = await bloquearPeriodo(tx, fila.id)
      if (destino.status !== 'OPEN') {
        throw new ConflictError('El periodo destino ya está cerrado: liquida en el periodo abierto', 'PERIODO_CERRADO')
      }
      // 2) Candado de la clase (el mismo que el ajuste de clase — Codex R1-6).
      await lockClase(tx, input.classSessionId)
      // 3) Permisos, ANTES de calcular o devolver cualquier cosa.
      exigirPermisoEnSedes(permitidas, [input.venueId, ...destino.venueIds], SIN_PERMISO)
      // 5) y 6) Revalidar la fuente y recalcular TODO dentro: el origen de hoy es el del preview y está cerrado. Una clase
      // movida a un periodo abierto nunca se ancla sola en otro.
      const { origen, filas } = await diferenciasDeClase(tx, { venueId: input.venueId, classSessionId: input.classSessionId }, { ahora })
      if (!origen || origen.id !== input.periodoOrigenId || origen.status !== 'CLOSED') {
        throw new ConflictError('La clase cambió de periodo desde que la revisaste: revisa de nuevo', 'ORIGEN_CAMBIO')
      }
      if (filas.some(f => f.pendiente === null)) {
        throw new BadRequestError(
          'Esta clase no se puede pagar todavía: resuélvela primero (coach, nivel, tabla o monto)',
          'CLASE_EN_EXCEPCION',
        )
      }
      // 7) Huella, con el destino tal como quedó bloqueado y cada devengo previo.
      const huella = huellaLiquidacion({
        classSessionId: input.classSessionId,
        origenId: origen.id,
        destino: destinoDe(destino),
        filas,
        previas: await devengosDeClase(tx, organizationId, input.classSessionId),
      })
      if (huella !== input.huellaEsperada) throw new HuellaCambio()
      // 8) Alcance (spec §5.6): la deuda de una sede que ya no está en el destino entra sólo con ampliación explícita.
      if (!destino.venueIds.includes(input.venueId)) {
        if (!input.ampliarAlcance) {
          throw new BadRequestError('Esa sede no está en el periodo destino: súmala al periodo para liquidar', 'SEDE_FUERA_DEL_PERIODO')
        }
        destino = await ampliarAlcance(tx, destino, [input.venueId], input.userId, { exigirModulo: false, activas, permitidas })
      }
      // 9) Los RECONCILE ≠ 0, juntos, uno por persona, con su clave derivada y su foto. La foto lleva el nivel de hoy si la
      // clase es suya, y el de su PRIMERA línea si ya no lo es (spec §6.1).
      const conMonto = filas.filter(f => f.persona !== null && !new Prisma.Decimal(f.pendiente!).isZero())
      const lineas: Prisma.ServiceEarningCreateManyInput[] = []
      for (const f of conMonto) {
        const persona = f.persona!
        const nivel =
          persona === f.coachActual
            ? { payLevelId: f.payLevelId, payLevelName: f.payLevelName }
            : await nivelDePrimeraLinea(tx, organizationId, f.classSessionId, persona)
        lineas.push({
          organizationId,
          venueId: input.venueId,
          periodId: destino.id,
          staffId: persona,
          concept: 'RECONCILE',
          sourceType: 'CLASS_SESSION',
          sourceId: f.classSessionId,
          occurredAt: f.startsAt,
          payLevelId: nivel?.payLevelId ?? null,
          payLevelName: nivel?.payLevelName ?? null,
          tableVersionId: f.tableVersionId,
          countMode: f.countMode as ServicePayCountMode | null,
          count: f.conteo,
          amount: new Prisma.Decimal(f.pendiente!),
          reason: 'Diferencia de una clase ya cerrada',
          descriptor: {
            ...descriptorDeClase({ ...f, staffName: f.personaNombre }, { nombre: ctx.nombreSede, tz: ctx.tz }),
            periodoOrigen: { start: dbDateComoFecha(origen.periodStart), end: dbDateComoFecha(origen.periodEnd) },
          },
          clientKey: `${prefijo}${persona}`,
          createdById: input.userId,
        })
      }
      if (lineas.length) await tx.serviceEarning.createMany({ data: lineas })
      // 10) Ancla: si no tenía, en el origen revalidado; si tenía sin versión y hoy hay regla, la versión UNA vez.
      const clase = filas[0]
      if (clase && !clase.periodoOrigenId) {
        await anclarClases(tx, origen.id, [
          { classSessionId: input.classSessionId, fechaValoracion: clase.fechaValoracion, tableVersionId: clase.tableVersionId },
        ])
      } else if (clase?.tableVersionId) {
        await tx.classSessionPayState.updateMany({
          where: { classSessionId: input.classSessionId, valuationVersionId: null },
          data: { valuationVersionId: clase.tableVersionId },
        })
      }
      const resultado = conMonto.map(f => ({ staffId: f.persona!, amount: new Prisma.Decimal(f.pendiente!).toFixed(2) }))
      // 11) Rastro, en el mismo tx.
      if (resultado.length) {
        await writeLegacyActivityAuditTx(tx, {
          staffId: input.userId,
          venueId: input.venueId,
          action: 'SERVICE_PAY_DIFFERENCE_SETTLED',
          entity: 'ClassSession',
          entityId: input.classSessionId,
          data: { origen: origen.id, destino: destino.id, solicitudId: input.solicitudId, lineas: resultado, huella },
        })
      }
      return { lineas: resultado, yaLiquidada: resultado.length === 0 }
    })
  } catch (e) {
    if (!(e instanceof HuellaCambio)) throw e
    // Fuera de la transacción (ya revertida y sin candados), como el cierre: el preview nuevo muestra el estado real.
    throw new ConflictError('Los montos cambiaron desde que los revisaste: revisa de nuevo', 'HUELLA_CAMBIO', {
      preview: await previewLiquidacion({
        userId: input.userId,
        venueId: input.venueId,
        classSessionId: input.classSessionId,
        destinoFecha: input.destinoFecha,
        ahora,
      }),
    })
  }
}
