import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/AppError'
import { PresupuestoDeEspera, tomarCandado, transaccionConPresupuesto } from '../../../utils/esperaDeCandados'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { fechaMx } from '../export.helpers'
import { assertPermisoEnSedes, sedesConServicePay } from './acceso'
import type { Ventana } from './rangos'
import { lockPeriodosDeOrganizacion, nombreDelPeriodo } from './periodosGuardados'
import { dbDateComoFecha, diaCivilSiguiente, fechaComoDbDate, hoyLocal, sumarDias } from './periodos'

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
 * B10 preparó lo que lee y escribe la participación (`alcanceDelPeriodo`, `sedesConVentana`, `activarSede`, `desactivarSede`);
 * B11 lo conecta todo junto: rutas, MCP, el barrido de ventas, la valoración de clases y los alcances.
 */

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma
const TZ_DEFAULT = 'America/Mexico_City'

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

// ── B10: alcance y sedes con ventana (diseño r5.2, r4.2): viven en `alcance.ts` (sin ciclo con `periodosGuardados`). ──
export { alcanceDelPeriodo, sedesConVentana } from './alcance'

// ── Activar y desactivar UNA sede (diseño r3.3, r4.6, r4.7, r4.8, r5.3; públicas desde B11) ──

const SIN_PERMISO = 'Para activar o desactivar una sede necesitas el permiso de cerrar periodos en esa sede'
const SIN_PERMISO_LEER = 'Para ver qué entra al activar o desactivar una sede necesitas el permiso de ver pago al personal en esa sede'
const futura = (hoy: string) => `La fecha no puede ser futura: lo más adelante es hoy, ${fechaMx(hoy)}`
const fueraDeRango = (mensaje: string, rango: { desde: string; hasta: string }) =>
  new BadRequestError(mensaje, 'FECHA_FUERA_DE_RANGO', rango)

/** Una sede ya resuelta antes de la transacción (o de la foto): su organización, nombre y zona. */
export interface SedePreparada {
  organizationId: string
  nombre: string
  tz: string
}

/**
 * Lo que se resuelve ANTES de la transacción, con el cliente global: la sede es de la organización de quien pide (si no,
 * 404 como en los ajustes), el permiso EN ESA SEDE (cerrar periodos para escribir; ver, para la vista previa) y su zona. La
 * sede se lee UNA vez (B11, revisión de B10 #6); su «hoy» se resuelve después, bajo el candado (o en la foto).
 */
export async function prepararSede(
  input: { userId: string; venueId: string; sedeId: string },
  permiso: 'staffpay:close' | 'staffpay:read' = 'staffpay:close',
): Promise<SedePreparada> {
  const quien = await prisma.venue.findUnique({ where: { id: input.venueId }, select: { organizationId: true } })
  const sede = await prisma.venue.findUnique({ where: { id: input.sedeId }, select: { organizationId: true, name: true, timezone: true } })
  if (!quien || !sede || quien.organizationId !== sede.organizationId) throw new NotFoundError('Sede no encontrada')
  await assertPermisoEnSedes(input.userId, [input.sedeId], permiso, permiso === 'staffpay:close' ? SIN_PERMISO : SIN_PERMISO_LEER)
  return { organizationId: sede.organizationId, nombre: sede.name, tz: sede.timezone || TZ_DEFAULT }
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
export async function minimoDeLaOrganizacion(tx: Db, organizationId: string) {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { staffPayStartDate: true } })
  if (!org.staffPayStartDate) throw new ConflictError('Activa primero el pago al personal', 'NO_ACTIVADO')
  const startDate = dbDateComoFecha(org.staffPayStartDate)
  const ultimo = await tx.servicePayPeriod.findFirst({
    where: { organizationId, status: 'CLOSED' },
    orderBy: { periodEnd: 'desc' },
    select: { periodStart: true, periodEnd: true },
  })
  const tras = ultimo ? diaCivilSiguiente(dbDateComoFecha(ultimo.periodEnd)) : null
  if (!ultimo || !tras || tras <= startDate) return { startDate, minimo: startDate, porQue: 'Es antes del inicio de pago al personal' }
  const cerrado = nombreDelPeriodo(dbDateComoFecha(ultimo.periodStart), dbDateComoFecha(ultimo.periodEnd))
  return { startDate, minimo: tras, porQue: `${cerrado} ya se cerró` }
}

/**
 * Lo que se puede elegir al ACTIVAR (r3.3): ninguna ventana abierta (409 YA_ACTIVA) y `desde ∈ [mínimo', hoy]`, con
 * `mínimo'` = max(mínimo, día siguiente al `hasta` de su última ventana cerrada). `motivo`: por qué `rango.desde` es ése.
 * La MISMA regla para la escritura (bajo candado) y su vista previa (en la foto).
 */
async function reglaDeActivar(tx: Db, organizationId: string, sedeId: string, nombre: string, hoy: string) {
  const { startDate, minimo, porQue } = await minimoDeLaOrganizacion(tx, organizationId)
  const donde = { organizationId, venueId: sedeId }
  const abierta = await tx.staffPayVenueWindow.findFirst({ where: { ...donde, hasta: null }, select: { desde: true } })
  if (abierta) throw new ConflictError(`La sede ${nombre} ya está activa desde el ${fechaMx(dbDateComoFecha(abierta.desde))}`, 'YA_ACTIVA')
  const cerrada = await tx.staffPayVenueWindow.findFirst({
    where: { ...donde, hasta: { not: null } },
    orderBy: { hasta: 'desc' },
    select: { hasta: true },
  })
  const ultimoDia = cerrada?.hasta ? dbDateComoFecha(cerrada.hasta) : null
  const { desde, porLaVentana } = minimoEfectivo(minimo, ultimoDia)
  const rango = { desde, hasta: hoy }
  const motivo = porLaVentana && ultimoDia ? `La sede ya estuvo activa hasta el ${fechaMx(ultimoDia)}` : porQue
  return { startDate, minimo, rango, motivo }
}

/**
 * El mínimo EFECTIVO para activar una sede (r3.3): el de la organización o, si es posterior, el día siguiente al último de su
 * ventana cerrada más reciente. Pura: la comparten la regla de activar (bajo candado o en la foto) y la pantalla de sedes (B13).
 */
export function minimoEfectivo(minimo: string, ultimoDiaCerrado: string | null): { desde: string; porLaVentana: boolean } {
  const tras = ultimoDiaCerrado === null ? null : diaCivilSiguiente(ultimoDiaCerrado)
  return tras !== null && tras > minimo ? { desde: tras, porLaVentana: true } : { desde: minimo, porLaVentana: false }
}

/**
 * Lo que se puede elegir al DESACTIVAR (r3.3, r4.7): una ventana abierta (409 NO_ACTIVA) y `hasta ∈ [max(ventana.desde,
 * mínimo) − 1 día, hoy]`; `hasta = desde − 1` borra la ventana (sólo si nunca tocó un cerrado). No exige plan.
 */
async function reglaDeDesactivar(tx: Db, organizationId: string, sedeId: string, nombre: string, hoy: string) {
  const { startDate, minimo, porQue } = await minimoDeLaOrganizacion(tx, organizationId)
  const abierta = await tx.staffPayVenueWindow.findFirst({
    where: { organizationId, venueId: sedeId, hasta: null },
    select: { id: true, desde: true },
  })
  if (!abierta) throw new ConflictError(`La sede ${nombre} no está activa en pago al personal`, 'NO_ACTIVA')
  const desde = dbDateComoFecha(abierta.desde)
  const porElCierre = minimo > desde
  const rango = { desde: sumarDias(porElCierre ? minimo : desde, -1), hasta: hoy }
  const motivo = porElCierre ? porQue : `La sede se activó el ${fechaMx(desde)}`
  const borra = porElCierre ? '' : ' (así se borra la activación)'
  return { startDate, minimo, rango, motivo, borra, abierta: { id: abierta.id, desde } }
}

/** Una fecha elegida fuera de su rango ⇒ 400 FECHA_FUERA_DE_RANGO `{ desde, hasta }` con el porqué. */
function validarFecha(fecha: string, rango: { desde: string; hasta: string }, motivo: string, sufijo = ''): void {
  if (fecha < rango.desde) throw fueraDeRango(`${motivo}; lo más atrás es el ${fechaMx(rango.desde)}${sufijo}`, rango)
  if (fecha > rango.hasta) throw fueraDeRango(futura(rango.hasta), rango)
}

/**
 * El «hoy» de la sede bajo el candado (o en la foto). `fechaEsperada`: el que vio el dueño en la vista previa; si ya es otro
 * día (pasó la medianoche mientras confirmaba o esperaba el candado) ⇒ 409 FECHA_CAMBIO sin escribir: «hoy» no se
 * reinterpreta (Codex bloque B #3, la misma idea que `inicioEsperado` de la activación).
 */
function hoyBajoCandado(tz: string, ahora: Date | undefined, fechaEsperada: string | undefined): string {
  const hoy = hoyLocal(tz, ahora ?? new Date())
  if (fechaEsperada !== undefined && fechaEsperada !== hoy)
    throw new ConflictError(`La fecha de hoy cambió (ya es ${fechaMx(hoy)}): vuelve a revisar`, 'FECHA_CAMBIO', { hoy })
  return hoy
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
 * ventana abierta (409 YA_ACTIVA). `desde ∈ [mínimo', hoy]` (`reglaDeActivar`); fuera ⇒ 400 FECHA_FUERA_DE_RANGO.
 * `minimo`: el de la organización; `minimoEfectivo`: el de la sede (`mínimo'`, lo que el diálogo deja elegir).
 * 🔴 Carrera contra el cierre (revisión de B10 #1): en SERIALIZABLE la foto se toma en la PRIMERA sentencia (el candado de
 * periodos), ANTES de esperar, así que el mínimo que se lee aquí puede ser el de antes de un cierre que acaba de confirmar.
 * Lo que lo hace correcto es SSI, y SSI sólo ve el ciclo porque el cierre LEE las ventanas de TODA la organización dentro de
 * su transacción SERIALIZABLE (`cerrarPeriodo` relee `sedesConVentana`): una de las dos se repite con la foto nueva y nunca
 * queda una ventana dentro de un periodo ya cerrado.
 */
export async function activarSede(input: {
  userId: string
  venueId: string
  sedeId: string
  desde?: string
  fechaEsperada?: string
  ahora?: Date
}): Promise<{ ventana: Ventana; minimo: string; minimoEfectivo: string }> {
  if (input.desde !== undefined) fechaComoDbDate(input.desde) // la forma, antes de comparar como texto
  const { organizationId, nombre, tz } = await prepararSede(input)
  const activas = await sedesConServicePay(organizationId)
  return transaccionConPresupuesto(async (tx, presupuesto) => {
    await bloquearParaVentanas(tx, organizationId, input.sedeId, presupuesto)
    const hoy = hoyBajoCandado(tz, input.ahora, input.fechaEsperada)
    if (!activas.includes(input.sedeId)) {
      // Antes de la regla de fechas, como en B10: sin activar sigue siendo NO_ACTIVADO.
      await minimoDeLaOrganizacion(tx, organizationId)
      throw new ConflictError(`La sede ${nombre} no tiene Pago al personal en su plan: contrátalo para activarla`, 'SEDE_SIN_PLAN')
    }
    const { minimo, rango, motivo } = await reglaDeActivar(tx, organizationId, input.sedeId, nombre, hoy)
    const fecha = input.desde ?? hoy
    validarFecha(fecha, rango, motivo)
    const w = await sinTraslape(() =>
      tx.staffPayVenueWindow.create({
        data: { organizationId, venueId: input.sedeId, desde: fechaComoDbDate(fecha), activadaPor: input.userId },
        select: { id: true },
      }),
    )
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.userId,
      venueId: input.sedeId,
      action: 'SERVICE_PAY_VENUE_ACTIVATED',
      entity: 'StaffPayVenueWindow',
      entityId: w.id,
      data: { desde: fecha, minimo, minimoEfectivo: rango.desde },
    })
    return { ventana: { venueId: input.sedeId, desde: fecha, hasta: null }, minimo, minimoEfectivo: rango.desde }
  })
}

/**
 * Desactiva UNA sede «hasta» un día que todavía entra (r3.3; por defecto hoy). NO exige plan (r4.7: es la salida del
 * bloqueo de una sede activa sin plan). Exige una ventana abierta (409 NO_ACTIVA). `hasta ∈ [max(ventana.desde, mínimo) − 1
 * día, hoy]` (`reglaDeDesactivar`); fuera ⇒ 400 FECHA_FUERA_DE_RANGO. `hasta = desde − 1` BORRA la ventana; si no, la
 * cierra con `hasta` y `desactivadaPor`. `ventana`: la que quedó, o null si se borró. La misma carrera que `activarSede`.
 */
export async function desactivarSede(input: {
  userId: string
  venueId: string
  sedeId: string
  hasta?: string
  fechaEsperada?: string
  ahora?: Date
}): Promise<{ ventana: Ventana | null; minimo: string; minimoEfectivo: string }> {
  if (input.hasta !== undefined) fechaComoDbDate(input.hasta)
  const { organizationId, nombre, tz } = await prepararSede(input)
  return transaccionConPresupuesto(async (tx, presupuesto) => {
    await bloquearParaVentanas(tx, organizationId, input.sedeId, presupuesto)
    const hoy = hoyBajoCandado(tz, input.ahora, input.fechaEsperada)
    const { minimo, rango, motivo, borra, abierta } = await reglaDeDesactivar(tx, organizationId, input.sedeId, nombre, hoy)
    const fecha = input.hasta ?? hoy
    validarFecha(fecha, rango, motivo, borra)
    const borrada = fecha === sumarDias(abierta.desde, -1)
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
      data: { hasta: fecha, minimo, minimoEfectivo: rango.desde, borrada },
    })
    return {
      ventana: borrada ? null : { venueId: input.sedeId, desde: abierta.desde, hasta: fecha },
      minimo,
      minimoEfectivo: rango.desde,
    }
  })
}

/** Para la vista previa (`participacion.vistaPrevia.ts`): las MISMAS reglas, leídas en su foto. */
export const reglasDeSede = { activar: reglaDeActivar, desactivar: reglaDeDesactivar, validarFecha, hoyBajoCandado }
