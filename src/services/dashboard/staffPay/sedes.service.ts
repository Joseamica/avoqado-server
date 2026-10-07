// src/services/dashboard/staffPay/sedes.service.ts — Configuración › Sedes (la pantalla 1): el estado de cada sede en pago al
// personal, desde y hasta cuándo, qué puede hacer el usuario y cuánto de lo vendido hoy no entra (fase 3, B13; diseño r3.7(1),
// r4.5, r4.7, r5.4; ruling de la revisión de B12). SÓLO LECTURA: no cambia qué se paga.
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { ConflictError, NotFoundError } from '../../../errors/AppError'
import { permisosPorSede, sedesConServicePay, TOPE_SEDES_CON_MODULO } from './acceso'
import { estadoDeSede, EstadoSede, SituacionDeSede, situacionDeLasSedes } from './estadoSede'
import { enUnaFoto } from './foto'
import { minimoDeLaOrganizacion, minimoEfectivo } from './participacion'
import { aCuenta, alActivar, cero, Cuenta, CuentaCruda, SedeQueSeActiva } from './participacion.vistaPrevia'
import { periodoQueContieneFecha } from './periodosGuardados'
import { dbDateComoFecha, hoyLocal, periodoQueContiene } from './periodos'

type Db = Prisma.TransactionClient | typeof prisma
const TZ_DEFAULT = 'America/Mexico_City'

export interface SedeEnPagoAlPersonal {
  venueId: string
  nombre: string
  /** Zona de la sede: todas sus fechas son días civiles de ahí. */
  zona: string
  tienePlan: boolean
  estado: EstadoSede
  /** La ventana que cubre hoy o, si ninguna, la última (YYYY-MM-DD en su zona); `hasta` null = sin fin; sin ventanas, null. */
  desde: string | null
  hasta: string | null
  /** Lo más atrás que se puede elegir al ACTIVARLA hoy (su mínimo efectivo); null si hoy no se puede activar. */
  minimo: string | null
  /** Ya con el permiso de cerrar periodos (`staffpay:close`) de quien pregunta en ESA sede. */
  puedeActivar: boolean
  puedeDesactivar: boolean
  /**
   * Lo vendido en periodos SIN CERRAR (desde el mínimo de la organización hasta hoy) que hoy NO entra: exactamente el `entran`
   * de activarla desde su mínimo efectivo (`alActivar`, la misma función que la vista previa de activar). Neto; una clase que
   * hoy no se puede valuar va en `pendientesDeValoracion`. Es lo que el dueño todavía puede hacer entrar.
   */
  fueraEstePeriodo: Cuenta
}
export interface EstadoSedes {
  activado: boolean
  startDate: string | null
  /** El periodo abierto de hoy (en la zona de la sede que pregunta); null sin activar. */
  periodo: { start: string; end: string } | null
  sedes: SedeEnPagoAlPersonal[]
}

const vacia = (): CuentaCruda => ({ clases: { ...cero(), pendientes: 0 }, comisiones: cero(), propinas: cero() })

/**
 * La pantalla 1 (r3.7(1)). Antes de la foto, con el cliente global: las sedes de la organización (con el tope de
 * `sedesConServicePay`: truena), filtradas por `soloSedes` (el alcance de una conexión MCP) y por el permiso de LEER de quien
 * pregunta; su permiso de cerrar en cada una y el plan. Todo lo demás en UNA foto (`enUnaFoto`), sólo con `tx`: las ventanas,
 * el estado (`estadoDeSede`, la misma definición que el cierre), el periodo abierto, los mínimos y lo que queda fuera. Sin
 * puerta de plan (la ruta va antes del gate): una sede sin el plan también se ve, para que diga qué le falta.
 * `ahora` y `entreLecturas`: SÓLO pruebas (el reloj; algo que cambia entre dos lecturas internas de la foto).
 */
export async function estadoSedes(input: {
  userId: string
  venueId: string
  soloSedes?: string[]
  ahora?: Date
  entreLecturas?: () => Promise<void>
}): Promise<EstadoSedes> {
  const ahora = input.ahora ?? new Date()
  const quien = await prisma.venue.findUnique({ where: { id: input.venueId }, select: { organizationId: true, timezone: true } })
  if (!quien) throw new NotFoundError('Sede no encontrada')
  const organizationId = quien.organizationId
  const todas = await prisma.venue.findMany({
    where: { organizationId },
    select: { id: true, name: true, timezone: true },
    orderBy: { id: 'asc' },
    take: TOPE_SEDES_CON_MODULO + 1,
  })
  if (todas.length > TOPE_SEDES_CON_MODULO) {
    // Ronda 1 (R2; ruling de B12 #6): un tope de volumen no es un error de quien pregunta ⇒ 409.
    throw new ConflictError(
      `Esta organización tiene más de ${TOPE_SEDES_CON_MODULO} sedes: no se pueden mostrar todas; contacta a Avoqado.`,
      'DEMASIADAS_SEDES',
    )
  }
  const pedidas = input.soloSedes ? todas.filter(v => input.soloSedes!.includes(v.id)) : todas
  const permisos = await permisosPorSede(
    input.userId,
    pedidas.map(v => v.id),
    ['staffpay:read', 'staffpay:close'],
  )
  const legibles = pedidas
    .filter(v => permisos.get(v.id)?.has('staffpay:read'))
    .map(v => ({ venueId: v.id, nombre: v.name, tz: v.timezone || TZ_DEFAULT, cierra: permisos.get(v.id)?.has('staffpay:close') ?? false }))
  const conPlan = new Set(await sedesConServicePay(organizationId))
  const tzQuien = quien.timezone || TZ_DEFAULT
  return enUnaFoto(tx => leer(tx, { organizationId, tzQuien, legibles, conPlan, ahora, entreLecturas: input.entreLecturas }))
}

type Legible = { venueId: string; nombre: string; tz: string; cierra: boolean }

async function leer(
  tx: Db,
  d: {
    organizationId: string
    tzQuien: string
    legibles: Legible[]
    conPlan: Set<string>
    ahora: Date
    entreLecturas?: () => Promise<void>
  },
): Promise<EstadoSedes> {
  const { organizationId, ahora } = d
  const org = await tx.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { staffPayStartDate: true, servicePayPeriodicity: true },
  })
  // SÓLO pruebas: tras la primera lectura (la que fija la foto), algo cambia afuera; todo lo que sigue lo debe ignorar.
  await d.entreLecturas?.()
  const situacion = await situacionDeLasSedes(tx, organizationId, d.legibles, ahora)
  const sit = (venueId: string): SituacionDeSede & { ventanas: SedeQueSeActiva['reales'] } =>
    situacion.get(venueId) ?? { abierta: false, cubreHoy: false, vigente: null, ultimoDiaCerrado: null, ventanas: [] }
  const startDate = org.staffPayStartDate ? dbDateComoFecha(org.staffPayStartDate) : null
  let periodo: EstadoSedes['periodo'] = null
  let minimoOrg: string | null = null
  const fuera = new Map<string, CuentaCruda>()
  if (startDate) {
    const hoy = hoyLocal(d.tzQuien, ahora)
    const fila = await periodoQueContieneFecha(tx, organizationId, hoy)
    periodo = fila
      ? { start: dbDateComoFecha(fila.periodStart), end: dbDateComoFecha(fila.periodEnd) }
      : periodoQueContiene(hoy, org.servicePayPeriodicity)
    minimoOrg = (await minimoDeLaOrganizacion(tx, organizationId)).minimo
    // «Fuera» = el `entran` de activar cada sede desde su mínimo efectivo, por grupos de sedes con el mismo «hoy».
    const porHoy = new Map<string, SedeQueSeActiva[]>()
    for (const s of d.legibles) {
      const hoyDeLaSede = hoyLocal(s.tz, ahora)
      const desde = minimoEfectivo(minimoOrg, sit(s.venueId).ultimoDiaCerrado).desde
      if (desde > hoyDeLaSede) continue // ya no queda ningún día sin cerrar que pueda entrar
      const grupo = porHoy.get(hoyDeLaSede) ?? []
      grupo.push({ venueId: s.venueId, tz: s.tz, fecha: desde, reales: sit(s.venueId).ventanas })
      porHoy.set(hoyDeLaSede, grupo)
    }
    for (const [hoyDeLaSede, grupo] of porHoy) {
      const r = await alActivar(tx, { organizationId, startDate, minimo: minimoOrg, hoy: hoyDeLaSede, ahora }, grupo)
      for (const [venueId, x] of r) fuera.set(venueId, x.entran)
    }
  }
  const sedes = d.legibles.map((s): SedeEnPagoAlPersonal => {
    const st = sit(s.venueId)
    const tienePlan = d.conPlan.has(s.venueId)
    const efectivo = minimoOrg === null ? null : minimoEfectivo(minimoOrg, st.ultimoDiaCerrado).desde
    // Se puede activar hoy: organización activada, con el plan, sin una ventana abierta y con algún día elegible.
    const minimo = efectivo !== null && tienePlan && !st.abierta && efectivo <= hoyLocal(s.tz, ahora) ? efectivo : null
    return {
      venueId: s.venueId,
      nombre: s.nombre,
      zona: s.tz,
      tienePlan,
      estado: estadoDeSede({ tienePlan, abierta: st.abierta, cubreHoy: st.cubreHoy }),
      desde: st.vigente?.desde ?? null,
      hasta: st.vigente?.hasta ?? null,
      minimo,
      puedeActivar: minimo !== null && s.cierra,
      puedeDesactivar: startDate !== null && st.abierta && s.cierra,
      fueraEstePeriodo: aCuenta(fuera.get(s.venueId) ?? vacia()),
    }
  })
  sedes.sort((x, y) => x.nombre.localeCompare(y.nombre, 'es') || (x.venueId < y.venueId ? -1 : x.venueId > y.venueId ? 1 : 0))
  return { activado: startDate !== null, startDate, periodo, sedes }
}
