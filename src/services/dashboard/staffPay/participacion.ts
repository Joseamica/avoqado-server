import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/AppError'
import { PresupuestoDeEspera, tomarCandado, transaccionConPresupuesto } from '../../../utils/esperaDeCandados'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { fechaMx } from '../export.helpers'
import { assertPermisoEnSedes, sedesConServicePay, TOPE_SEDES_CON_MODULO } from './acceso'
import type { Ventana } from './fuentesVenta'
import { hoyDeLaSede, lockPeriodosDeOrganizacion, nombreDelPeriodo } from './periodosGuardados'
import { dbDateComoFecha, diaCivilAnterior, diaCivilSiguiente, fechaComoDbDate } from './periodos'

/**
 * Participación por sede (fase 3, B9; diseño r7.1 + r6.3): el dueño activa «Pago al personal» POR SEDE y elige desde qué
 * día (`StaffPayVenueWindow`). Aquí viven los candados de FILA de la sede y la historia de pago al personal.
 *
 * Dos lados sobre la MISMA fila de `Venue`:
 * - **Escritores** (los únicos que insertan `ServiceEarning` —cierre, ajuste manual, liquidación— y las escrituras de
 *   ventanas): `FOR KEY SHARE` de cada sede a la que le van a escribir, una por una por id, y revalidan bajo el candado que
 *   sigue siendo de la organización. `FOR KEY SHARE` no estorba a un cambio normal de la sede (nombre, horario): sólo a
 *   los cambios de una columna LLAVE de `Venue` —`organizationId` (índice único `Venue(id, organizationId)`), y también
 *   `slug`, `liveDemoSessionId` y `stripeCustomerId`, que son únicos (p. ej. el UPDATE condicional de
 *   `stripe.service.ts:133`)— y al DELETE. Esos cambios esperan al escritor (que toma las sedes al final, justo antes de
 *   escribir); y uno CONFIRMADO después de la foto de un escritor SERIALIZABLE (el cierre) le da 40001 al tomar la fila: el
 *   escritor se repite entero con `withSerializableRetry`. Es correcto y raro.
 * - **Exclusivos** (traslado, `deleteVenue`, limpieza de demos): `FOR UPDATE` de la sede ANTES de mirar la historia, y la
 *   historia es OTRA sentencia, después: en READ COMMITTED ve lo que confirmó el escritor al que esperó.
 *
 * Orden de candados (sin ciclos, Codex r7 #23): cierre y ajuste, periodo → Venue; liquidación, periodo destino → clase →
 * Venue; escrituras de ventanas, candado de periodos de la organización → fila de `Organization` → Venue; traslado,
 * `Organization` (por id) → Venue. Todos con el presupuesto ÚNICO de su transacción (`PresupuestoDeEspera`).
 *
 * B10 prepara, SIN CONECTAR, lo que lee y escribe la participación (`alcanceDelPeriodo`, `sedesConVentana`, `activarSede`,
 * `desactivarSede`): ningún camino de producción —ruta, MCP o lector de dinero— los usa todavía (eso llega en B11-B13).
 */

type Tx = Prisma.TransactionClient

/**
 * La fila de la organización, `FOR NO KEY UPDATE` (r5.3 paso 2): la toman las escrituras de ventanas y el traslado (éste las
 * dos organizaciones, por id), así que activar y trasladar se ordenan aquí y nunca se cruzan en la sede.
 */
export async function bloquearOrganizacion(tx: Tx, organizationId: string, presupuesto: PresupuestoDeEspera): Promise<void> {
  await tomarCandado(
    tx,
    () => tx.$queryRaw(Prisma.sql`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR NO KEY UPDATE /* B9:organizacion */`),
    { presupuesto },
  )
}

/**
 * Lado ESCRITOR (r7.1): `FOR KEY SHARE` de cada sede a la que se le va a escribir historia de pago al personal (devengos o
 * ventanas), UNA POR UNA por id ascendente —nunca un solo `SELECT … ANY …`: `lock_timeout` vale por adquisición y varias
 * esperas en una sentencia se suman (Codex r7 #24)—, con el presupuesto de la transacción. Bajo el candado revalida que la
 * sede existe y sigue siendo de `organizationId`, también si ya está en el alcance del periodo: si no, 409
 * `SEDE_EN_OTRA_ORGANIZACION` y no se escribe nada.
 */
export async function bloquearSedesDeLaOrganizacion(
  tx: Tx,
  organizationId: string,
  venueIds: Iterable<string>,
  presupuesto: PresupuestoDeEspera,
): Promise<void> {
  for (const venueId of [...new Set(venueIds)].sort()) {
    const [fila] = await tomarCandado(
      tx,
      () =>
        tx.$queryRaw<Array<{ id: string; organizationId: string; name: string }>>(
          Prisma.sql`SELECT id, "organizationId", name FROM "Venue" WHERE id = ${venueId} FOR KEY SHARE /* B9:sede:escritor */`,
        ),
      { presupuesto },
    )
    if (!fila || fila.organizationId !== organizationId) {
      throw new ConflictError(`La sede ${fila?.name ?? venueId} ya no pertenece a esta organización`, 'SEDE_EN_OTRA_ORGANIZACION')
    }
  }
}

/**
 * Lado EXCLUSIVO (r7.1): `FOR UPDATE` de la sede, ANTES de mirar su historia. Devuelve su organización, o null si ya no
 * existe. Quien lo llama compara y luego pregunta `historiaDeSede` en otra sentencia.
 */
export async function bloquearSedeExclusiva(
  tx: Tx,
  venueId: string,
  presupuesto: PresupuestoDeEspera,
): Promise<{ organizationId: string } | null> {
  const [fila] = await tomarCandado(
    tx,
    () =>
      tx.$queryRaw<Array<{ organizationId: string }>>(
        Prisma.sql`SELECT "organizationId" FROM "Venue" WHERE id = ${venueId} FOR UPDATE /* B9:sede:exclusivo */`,
      ),
    { presupuesto },
  )
  return fila ?? null
}

/**
 * ¿La sede tiene historia de pago al personal? Alguna ventana (activa o ya cerrada) o algún devengo. Va SIEMPRE después del
 * `FOR UPDATE` de la sede, en otra sentencia. Con historia, la sede no se traslada ni se borra, y la limpieza de demos la
 * omite completa.
 */
export async function historiaDeSede(tx: Tx, venueId: string): Promise<boolean> {
  const [r] = await tx.$queryRaw<Array<{ hay: boolean }>>(Prisma.sql`
    SELECT (EXISTS (SELECT 1 FROM "StaffPayVenueWindow" WHERE "venueId" = ${venueId})
         OR EXISTS (SELECT 1 FROM "ServiceEarning" WHERE "venueId" = ${venueId})) AS hay`)
  return r?.hay === true
}

/** 409 de la barrera: una sede con historia de pago al personal no se traslada ni se borra (r5.3, r6.7). */
export function sedeConPagoAlPersonalError(accion: 'trasladar' | 'borrar'): ConflictError {
  const que = accion === 'trasladar' ? 'trasladar a otra organización' : 'borrar'
  return new ConflictError(`Esta sede tiene historial de pago al personal; no se puede ${que}`, 'SEDE_CON_PAGO_AL_PERSONAL')
}

/** La limpieza de demos omite completa una demo con historia de pago al personal (la transacción se revierte entera). */
export const LIVE_DEMO_CON_PAGO_AL_PERSONAL = 'LIVE_DEMO_CON_PAGO_AL_PERSONAL'
export const demoConPagoAlPersonalError = (): ConflictError =>
  new ConflictError('Esta sucursal demo tiene historial de pago al personal: la limpieza la omite completa', LIVE_DEMO_CON_PAGO_AL_PERSONAL)

// ── B10: alcance y sedes con ventana (diseño r5.2, r4.2) ──

/**
 * El alcance de un periodo (diseño r5.2). PURA: lo que compara llega resuelto ANTES (dentro de la foto o la transacción sólo
 * se compara). CERRADO ⇒ su alcance congelado. Sin activar, o un periodo que termina antes del inicio ⇒ la regla D2 de la
 * fase 2 (`guardadas ∪ activas`), sin ampliar por historia. Desde el inicio ⇒ también las sedes con ventana: toda sede que
 * alguna vez estuvo en el sobre entra a cada cierre y sus devoluciones se descuentan solas (r4.2). Un periodo abierto que
 * CRUZA el inicio no debería existir (`startDate` es un inicio canónico y la periodicidad queda fija al activar): truena.
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
  throw new Error(`STAFF_PAY_PERIODO_CRUZA_EL_INICIO: el periodo ${p.start} a ${p.end} cruza el inicio ${startDate}`)
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

// ── B10: activar y desactivar UNA sede (diseño r3.3, r4.6, r4.7, r4.8, r5.3) — servicios SIN rutas ni MCP hasta B11 ──

const SIN_PERMISO = 'Para activar o desactivar una sede necesitas el permiso de cerrar periodos en esa sede'
const futura = (hoy: string) => `La fecha no puede ser futura: lo más adelante es hoy, ${fechaMx(hoy)}`
const fueraDeRango = (mensaje: string, rango: { desde: string; hasta: string }) =>
  new BadRequestError(mensaje, 'FECHA_FUERA_DE_RANGO', rango)

/**
 * Lo que se resuelve ANTES de la transacción, con el cliente global: la sede es de la organización de quien pide (si no,
 * 404 como en los ajustes), el permiso de cerrar periodos EN ESA SEDE y su «hoy». Dentro sólo se bloquea y se compara.
 */
async function prepararSede(input: { userId: string; venueId: string; sedeId: string; ahora?: Date }) {
  const quien = await prisma.venue.findUnique({ where: { id: input.venueId }, select: { organizationId: true } })
  const sede = await prisma.venue.findUnique({ where: { id: input.sedeId }, select: { organizationId: true, name: true } })
  if (!quien || !sede || quien.organizationId !== sede.organizationId) throw new NotFoundError('Sede no encontrada')
  await assertPermisoEnSedes(input.userId, [input.sedeId], 'staffpay:close', SIN_PERMISO)
  return { organizationId: sede.organizationId, nombre: sede.name, hoy: await hoyDeLaSede(input.sedeId, input.ahora) }
}

/** El orden de las escrituras de ventanas (r5.3, el de la activación): periodos de la organización → su fila → la sede. */
async function bloquearParaVentanas(tx: Tx, organizationId: string, sedeId: string, presupuesto: PresupuestoDeEspera) {
  await lockPeriodosDeOrganizacion(tx, organizationId, presupuesto)
  await bloquearOrganizacion(tx, organizationId, presupuesto)
  await bloquearSedesDeLaOrganizacion(tx, organizationId, [sedeId], presupuesto)
}

/**
 * `mínimo` (r3.3, r4): el mayor entre `staffPayStartDate` y el día siguiente al MAYOR `periodEnd` CERRADO de la organización
 * (aunque se haya cerrado fuera de orden: nunca se toca un cerrado ni lo anterior a uno). Se lee DENTRO de la transacción,
 * después de los candados: con SERIALIZABLE, un cierre que confirmó mientras se esperaba hace repetir la transacción (SSI).
 * `porQue`: por qué ése es el mínimo (el periodo cerrado que lo fija, o el inicio). Sin activar ⇒ 409 NO_ACTIVADO.
 */
async function minimoDeLaOrganizacion(tx: Tx, organizationId: string) {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { staffPayStartDate: true } })
  if (!org.staffPayStartDate) throw new ConflictError('Activa primero el pago al personal', 'NO_ACTIVADO')
  const startDate = dbDateComoFecha(org.staffPayStartDate)
  const ultimo = await tx.servicePayPeriod.findFirst({
    where: { organizationId, status: 'CLOSED' },
    orderBy: { periodEnd: 'desc' },
    select: { periodStart: true, periodEnd: true },
  })
  const tras = ultimo ? diaCivilSiguiente(dbDateComoFecha(ultimo.periodEnd)) : null
  if (!ultimo || !tras || tras <= startDate) return { minimo: startDate, porQue: 'Es antes del inicio de pago al personal' }
  return { minimo: tras, porQue: `${nombreDelPeriodo(dbDateComoFecha(ultimo.periodStart), dbDateComoFecha(ultimo.periodEnd))} ya se cerró` }
}

/** El `EXCLUDE` de la tabla (23P01) como 409: un traslape que aun así llegue (otra organización, datos viejos) nunca es un 500. */
async function sinTraslape<T>(escribir: () => Promise<T>): Promise<T> {
  try {
    return await escribir()
  } catch (e) {
    const x = e as { code?: string; meta?: { code?: string }; message?: string } | null
    const traslape =
      x?.code === '23P01' || x?.meta?.code === '23P01' || /23P01|StaffPayVenueWindow_sin_traslape/.test(String(x?.message ?? ''))
    if (traslape)
      throw new ConflictError('Esas fechas se cruzan con otros días activos de la sede; revisa y vuelve a intentar', 'VENTANA_SE_CRUZA')
    throw e
  }
}

/**
 * Activa UNA sede «desde» un día (r3.3; por defecto hoy en su zona). Exige `staffpay:close` en la sede, la organización
 * activada (409 NO_ACTIVADO), el plan HOY en la sede (`sedesConServicePay`, resuelto antes; 409 SEDE_SIN_PLAN) y ninguna
 * ventana abierta (409 YA_ACTIVA). `desde ∈ [mínimo', hoy]`, con `mínimo'` = max(mínimo, día siguiente al `hasta` de su
 * última ventana cerrada); fuera ⇒ 400 FECHA_FUERA_DE_RANGO `{ desde, hasta }` con el porqué. `minimo`: el de la organización.
 */
export async function activarSede(input: {
  userId: string
  venueId: string
  sedeId: string
  desde?: string
  ahora?: Date
}): Promise<{ ventana: Ventana; minimo: string }> {
  if (input.desde !== undefined) fechaComoDbDate(input.desde) // la forma, antes de comparar como texto
  const { organizationId, nombre, hoy } = await prepararSede(input)
  const activas = await sedesConServicePay(organizationId)
  return transaccionConPresupuesto(async (tx, presupuesto) => {
    await bloquearParaVentanas(tx, organizationId, input.sedeId, presupuesto)
    const { minimo, porQue } = await minimoDeLaOrganizacion(tx, organizationId)
    if (!activas.includes(input.sedeId)) {
      throw new ConflictError(`La sede ${nombre} no tiene Pago al personal en su plan: contrátalo para activarla`, 'SEDE_SIN_PLAN')
    }
    const donde = { organizationId, venueId: input.sedeId }
    const abierta = await tx.staffPayVenueWindow.findFirst({ where: { ...donde, hasta: null }, select: { desde: true } })
    if (abierta) {
      throw new ConflictError(`La sede ${nombre} ya está activa desde el ${fechaMx(dbDateComoFecha(abierta.desde))}`, 'YA_ACTIVA')
    }
    const cerrada = await tx.staffPayVenueWindow.findFirst({
      where: { ...donde, hasta: { not: null } },
      orderBy: { hasta: 'desc' },
      select: { hasta: true },
    })
    const ultimoDia = cerrada?.hasta ? dbDateComoFecha(cerrada.hasta) : null
    const porLaVentana = ultimoDia !== null && diaCivilSiguiente(ultimoDia) > minimo
    const rango = { desde: porLaVentana ? diaCivilSiguiente(ultimoDia) : minimo, hasta: hoy }
    const fecha = input.desde ?? hoy
    if (fecha < rango.desde) {
      const motivo = porLaVentana ? `La sede ya estuvo activa hasta el ${fechaMx(ultimoDia)}` : porQue
      throw fueraDeRango(`${motivo}; lo más atrás es el ${fechaMx(rango.desde)}`, rango)
    }
    if (fecha > hoy) throw fueraDeRango(futura(hoy), rango)
    const w = await sinTraslape(() =>
      tx.staffPayVenueWindow.create({ data: { ...donde, desde: fechaComoDbDate(fecha), activadaPor: input.userId }, select: { id: true } }),
    )
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.userId,
      venueId: input.sedeId,
      action: 'SERVICE_PAY_VENUE_ACTIVATED',
      entity: 'StaffPayVenueWindow',
      entityId: w.id,
      data: { desde: fecha, minimo },
    })
    return { ventana: { venueId: input.sedeId, desde: fecha, hasta: null }, minimo }
  })
}

/**
 * Desactiva UNA sede «hasta» un día que todavía entra (r3.3; por defecto hoy). NO exige plan (r4.7: es la salida del
 * bloqueo de una sede activa sin plan). Exige una ventana abierta (409 NO_ACTIVA). `hasta ∈ [max(ventana.desde, mínimo) − 1
 * día, hoy]`; fuera ⇒ 400 FECHA_FUERA_DE_RANGO. `hasta = desde − 1` BORRA la ventana (sólo si nunca tocó un cerrado);
 * si no, la cierra con `hasta` y `desactivadaPor`. `ventana`: la que quedó, o null si se borró.
 */
export async function desactivarSede(input: {
  userId: string
  venueId: string
  sedeId: string
  hasta?: string
  ahora?: Date
}): Promise<{ ventana: Ventana | null; minimo: string }> {
  if (input.hasta !== undefined) fechaComoDbDate(input.hasta)
  const { organizationId, nombre, hoy } = await prepararSede(input)
  return transaccionConPresupuesto(async (tx, presupuesto) => {
    await bloquearParaVentanas(tx, organizationId, input.sedeId, presupuesto)
    const { minimo, porQue } = await minimoDeLaOrganizacion(tx, organizationId)
    const abierta = await tx.staffPayVenueWindow.findFirst({
      where: { organizationId, venueId: input.sedeId, hasta: null },
      select: { id: true, desde: true },
    })
    if (!abierta) throw new ConflictError(`La sede ${nombre} no está activa en pago al personal`, 'NO_ACTIVA')
    const desde = dbDateComoFecha(abierta.desde)
    const porElCierre = minimo > desde
    const rango = { desde: diaCivilAnterior(porElCierre ? minimo : desde), hasta: hoy }
    const fecha = input.hasta ?? hoy
    if (fecha < rango.desde) {
      throw fueraDeRango(
        porElCierre
          ? `${porQue}; lo más atrás es el ${fechaMx(rango.desde)}`
          : `La sede se activó el ${fechaMx(desde)}; lo más atrás es el ${fechaMx(rango.desde)} (así se borra la activación)`,
        rango,
      )
    }
    if (fecha > hoy) throw fueraDeRango(futura(hoy), rango)
    const borrada = fecha === diaCivilAnterior(desde)
    if (borrada) await tx.staffPayVenueWindow.delete({ where: { id: abierta.id } })
    else {
      await tx.staffPayVenueWindow.update({
        where: { id: abierta.id },
        data: { hasta: fechaComoDbDate(fecha), desactivadaPor: input.userId },
      })
    }
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.userId,
      venueId: input.sedeId,
      action: 'SERVICE_PAY_VENUE_DEACTIVATED',
      entity: 'StaffPayVenueWindow',
      entityId: abierta.id,
      data: { hasta: fecha, minimo, borrada },
    })
    return { ventana: borrada ? null : { venueId: input.sedeId, desde, hasta: fecha }, minimo }
  })
}
