// src/mcp/tools/staffPay.participacion.ts — `configure_service_pay`: activar la organización eligiendo sedes y activar o
// desactivar UNA sede «desde / hasta qué día», en dos pasos y con los montos de lo que entra (fase 3, B11; diseño r4.6, r7.3).
import { createHash } from 'crypto'
import prisma from '@/utils/prismaClient'
import { assertPermisoEnTodasLasSedes } from '@/services/dashboard/staffPay/acceso'
import { activarPagoAlPersonal, previewActivacion, sedesParaActivar } from '@/services/dashboard/staffPay/activacion.service'
import { activarSede, desactivarSede } from '@/services/dashboard/staffPay/participacion'
import { vistaPreviaParticipacion, type Cuenta } from '@/services/dashboard/staffPay/participacion.vistaPrevia'
import type { McpScope } from '../scope'
import type { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'

type Respuesta = ReturnType<typeof text>
/** Lo que el registro de las herramientas ya tiene y estas acciones reusan (alcance de la conexión, permisos, errores). */
export interface Herramientas {
  scope: McpScope
  guard: ReturnType<typeof createGuard>
  puedeEscribir: (venueId: string, modulo?: 'sede' | 'organizacion' | 'ninguno') => Promise<string | null>
  fallo: (e: unknown, extra?: string) => Respuesta
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
/** La huella de activar la organización (r4.6): la fecha de inicio Y las sedes elegidas, ordenadas. 64 caracteres. */
export const huellaDeActivar = (startDate: string, sedes: string[]) => sha256(`activar|${startDate}|${[...sedes].sort().join(',')}`)
/** La huella de activar o desactivar UNA sede (r4.6): la sede, la acción y la fecha EXPLÍCITA (nunca «hoy»). */
export const huellaDeSede = (sede: string, activa: boolean, fecha: string) => sha256(`sede|${sede}|${activa}|${fecha}`)

const pesos = (s: string) => Number(s).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const dia = (f: string) => {
  const [y, m, d] = f.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}
const lista = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`)
const nombrePeriodicidad = (p: 'MONTHLY' | 'SEMIMONTHLY') => (p === 'MONTHLY' ? 'mensual' : 'quincenal')
/** «2 clases ($1,000.00), 1 comisión ($100.00) y 0 propinas ($0.00)», más las clases que todavía no se pueden valorar. */
const cuentaLegible = (c: Cuenta) => {
  const partes = lista([
    `${c.clases.n} clase(s) ($${pesos(c.clases.total)})`,
    `${c.comisiones.n} comisión(es) ($${pesos(c.comisiones.total)})`,
    `${c.propinas.n} propina(s) ($${pesos(c.propinas.total)})`,
  ])
  const pendientes = c.clases.pendientesDeValoracion
  return pendientes ? `${partes}; además ${pendientes} clase(s) que todavía no se pueden valorar` : partes
}

/** Qué hacer ante cada rechazo de activar o desactivar una sede, en palabras del dueño (E repite el mismo texto). */
const QUE_HACER_SEDE: Record<string, string> = {
  FECHA_FUERA_DE_RANGO: 'Elige una fecha dentro del rango que dice el error y pide la vista previa de nuevo (sin confirm).',
  FECHA_CAMBIO: 'Pide una vista previa nueva (sin confirm) y muéstrasela al usuario antes de confirmar.',
  YA_ACTIVA: 'La sede ya está activa: para cambiar su fecha, desactívala primero indicando su último día.',
  NO_ACTIVA: 'La sede no está activa: no hay nada que desactivar.',
  NO_ACTIVADO: 'Activa primero el pago al personal de la organización (accion "activar").',
  SEDE_SIN_PLAN: 'La sede necesita el plan con Pago al personal para activarla; pídelo a Avoqado.',
  VENTANA_SE_CRUZA:
    'Esas fechas se cruzan con días en que la sede ya estuvo activa (quizá cuando era de otra organización): elige otra fecha o pide ayuda a Avoqado.',
  CIERRE_EN_CURSO: 'Hay un cierre de periodo en curso: intenta de nuevo en un momento.',
  OPERACION_EN_CURSO: 'Otra operación está cambiando la sede o la organización: intenta de nuevo en un momento.',
}
const conQueHacer = (h: Herramientas, e: unknown) => {
  const code = (e as { code?: string })?.code
  const rango = (e as { details?: { desde?: string; hasta?: string } })?.details
  const extra = code === 'FECHA_FUERA_DE_RANGO' && rango?.desde ? ` Rango: del ${rango.desde} al ${rango.hasta}.` : ''
  return h.fallo(e, code && QUE_HACER_SEDE[code] ? `.${extra} ${QUE_HACER_SEDE[code]}` : '')
}

/**
 * `accion: 'activar'` (B9 + B11, r3.3, r4.6): la vista previa dice desde cuándo, la periodicidad y QUÉ sedes entran (por
 * defecto todas las que tienen el plan; también lista las que no lo tienen). La huella cubre la fecha y las sedes
 * (`huellaDeActivar`) y la `fecha` va firmada en el token: al confirmar se usa esa fecha y, si ya no coincide (pasó la
 * medianoche del cambio de periodo o cambiaron las sedes con plan), INICIO_CAMBIO sin escribir.
 */
export async function activarOrganizacion(
  h: Herramientas,
  args: {
    venueId: string
    organizationId: string
    actual: { activado: boolean; startDate: string | null; propinasEncendidas: boolean }
    periodicidad: 'MONTHLY' | 'SEMIMONTHLY'
    sedes?: string[]
    fecha?: string
    expectedSourceFingerprint?: string
    confirm?: boolean
  },
): Promise<Respuesta> {
  const { venueId, organizationId, actual, periodicidad } = args
  if (actual.activado)
    return text({
      ok: false,
      sinCambios: true,
      actual,
      error: `Pago al personal ya está activado desde el ${actual.startDate}: no hay nada que cambiar.`,
    })
  // Cada sede elegida, por el alcance de la conexión antes de consultar nada.
  for (const s of args.sedes ?? []) h.guard.venueFilter(s)
  if (args.sedes !== undefined && !args.sedes.length)
    return text({ ok: false, code: 'FALTA_SEDE', needsInput: true, field: 'sedes', question: 'Elige al menos una sede para activar.' })
  const elegidas = async () => {
    const l = await sedesParaActivar(organizationId)
    const conPlan = l.conPlan.map(x => x.venueId)
    const ids = args.sedes ? [...new Set(args.sedes)].sort() : conPlan
    const sinPlan = ids.filter(id => !conPlan.includes(id))
    return { l, ids, sinPlan }
  }
  if (args.confirm !== true) {
    // La vista previa ya rechaza lo que el confirmar rechazaría: el permiso en TODAS las sedes y la periodicidad fija.
    await assertPermisoEnTodasLasSedes(h.scope.staffId, organizationId, 'staffpay:close')
    const plan = await previewActivacion({ venueId, periodicidad })
    const conPlan = { ...actual, periodicidad: plan.periodicidad, periodicidadFija: plan.periodicidadFija }
    if (plan.periodicidadFija && plan.periodicidad !== periodicidad)
      return text({
        ok: false,
        code: 'PERIODICIDAD_FIJA',
        actual: conPlan,
        error: `La periodicidad ya no se puede cambiar: ya hay periodos guardados. Activa con la que ya tienes (${nombrePeriodicidad(plan.periodicidad)}).`,
      })
    const { l, ids, sinPlan } = await elegidas()
    if (sinPlan.length)
      return text({
        ok: false,
        code: 'SEDE_SIN_PLAN',
        sedes: l,
        error: `Estas sedes no tienen Pago al personal en su plan y no se pueden activar: ${sinPlan.join(', ')}. Elige sólo sedes con el plan.`,
      })
    const nombre = new Map(l.conPlan.map(x => [x.venueId, x.nombre]))
    const fuera = l.conPlan.filter(x => !ids.includes(x.venueId)).map(x => x.nombre)
    const sinElPlan = l.sinPlanTotal
      ? ` ${l.sinPlanTotal} sede(s) no tienen el plan: ${lista(l.sinPlan.map(x => x.nombre))}${l.sinPlanTotal > l.sinPlan.length ? ' y otras' : ''}.`
      : ''
    return text({
      ok: false,
      requiresConfirmation: true,
      actual: conPlan,
      nuevo: {
        activado: true,
        periodicidad,
        startDate: plan.startDate,
        sedes: ids.map(id => ({ venueId: id, nombre: nombre.get(id) ?? id })),
      },
      sedes: l,
      // El catálogo firma la fecha y la huella en el token: se confirma lo que se MOSTRÓ (Codex bloque B #3, r4.6). No quitar.
      fecha: plan.startDate,
      expectedSourceFingerprint: huellaDeActivar(plan.startDate, ids),
      message: `Pago al personal: sin activar → activado (${nombrePeriodicidad(periodicidad)}${
        plan.periodicidadFija ? ', ya no cambia porque hay periodos guardados' : '; la periodicidad queda fija al activar'
      }). Desde el ${plan.startDate} se suman al recibo las comisiones${actual.propinasEncendidas ? ' y las propinas' : ''} de ${lista(
        ids.map(id => nombre.get(id) ?? id),
      )}; las anteriores no se suman: si debes alguna, agrégalo como ajuste.${
        fuera.length ? ` Quedan sin activar: ${lista(fuera)} (se activan después, sede por sede).` : ''
      }${sinElPlan}`,
    })
  }
  if (!args.expectedSourceFingerprint)
    return text({ ok: false, needsInput: true, field: 'expectedSourceFingerprint', question: 'Pide primero la vista previa.' })
  if (!args.fecha)
    return text({ ok: false, needsInput: true, field: 'fecha', question: 'Confirma con la fecha que devolvió la vista previa.' })
  const { ids, sinPlan } = await elegidas()
  if (sinPlan.length || huellaDeActivar(args.fecha, ids) !== args.expectedSourceFingerprint)
    return text({
      ok: false,
      code: 'INICIO_CAMBIO',
      error: 'La fecha de inicio o las sedes con el plan cambiaron desde la vista previa. Pide una vista previa nueva (sin confirm).',
    })
  try {
    const r = await activarPagoAlPersonal({ userId: h.scope.staffId, venueId, periodicidad, inicioEsperado: args.fecha, sedes: ids })
    if (!r.yaActivado)
      await auditMcpWrite(h.scope, {
        action: 'SERVICE_PAY_ACTIVATED',
        entity: 'Organization',
        entityId: organizationId,
        venueId,
        data: { startDate: r.startDate, periodicidad, sedes: ids },
      })
    return text({ ok: true, ...r })
  } catch (e) {
    return h.fallo(e, (e as { code?: string })?.code === 'INICIO_CAMBIO' ? ' Pide una vista previa nueva (sin confirm).' : '')
  }
}

/**
 * `accion: 'sede'` (B11, r4.6, r4.7, r7.3): activar (`activa: true`, desde `fecha`) o desactivar (`activa: false`, hasta
 * `fecha`, incluido) UNA sede. La vista previa resuelve «hoy» a una fecha EXPLÍCITA, la devuelve en `fecha` y trae los
 * montos (los de la ruta `participation-preview`); la huella es `huellaDeSede`. Al confirmar se usa esa fecha (pasar la
 * medianoche no reinterpreta «hoy») y el service la revalida bajo candado. Exige `staffpay:close` en la sede; desactivar no
 * pide plan (`modulo: 'ninguno'`), activar sí (en la organización y, el service, en la sede).
 */
export async function participacionDeSede(
  h: Herramientas,
  args: { venueId: string; sede?: string; activa?: boolean; fecha?: string; expectedSourceFingerprint?: string; confirm?: boolean },
): Promise<Respuesta> {
  const sede = args.sede ?? args.venueId
  h.guard.venueFilter(sede) // la sede que se cambia, por el alcance de la conexión antes de consultar nada
  if (args.activa === undefined)
    return text({
      ok: false,
      needsInput: true,
      field: 'activa',
      question: '¿Activar la sede en pago al personal (true, desde qué día) o desactivarla (false, hasta qué día entra)?',
    })
  const activa = args.activa
  const no = await h.puedeEscribir(args.venueId, activa ? 'organizacion' : 'ninguno')
  if (no) return text({ ok: false, error: no })
  if (!h.guard.tienePermiso('staffpay:close', sede)) return text({ ok: false, error: 'Necesitas el permiso staffpay:close en esa sede.' })
  try {
    if (args.confirm !== true) {
      const pv = await vistaPreviaParticipacion({
        userId: h.scope.staffId,
        venueId: args.venueId,
        sedeId: sede,
        accion: activa ? 'activar' : 'desactivar',
        fecha: args.fecha,
      })
      const nombre = (await prisma.venue.findUnique({ where: { id: sede }, select: { name: true } }))?.name ?? sede
      const message =
        pv.accion === 'activar'
          ? `${nombre} se activa en pago al personal desde el ${dia(pv.fecha)} a las 00:00 (${pv.zona}). Entran, de los periodos sin cerrar: ${cuentaLegible(pv.entran)}. Quedan fuera: ${cuentaLegible(pv.quedanFuera)}; lo que quede fuera no se paga: si debes algo, agrégalo como ajuste.`
          : `${nombre} se desactiva: el ${dia(pv.fecha)} es su último día en pago al personal. Dejan de entrar, de los periodos sin cerrar: ${cuentaLegible(pv.dejanDeEntrar)}. Siguen entrando: ${cuentaLegible(pv.permanecen)}.`
      return text({
        ok: false,
        requiresConfirmation: true,
        preview: pv,
        // El catálogo la firma en el token: se confirma la fecha que se MOSTRÓ, nunca «hoy» otra vez (r4.6). No quitar.
        fecha: pv.fecha,
        expectedSourceFingerprint: huellaDeSede(sede, activa, pv.fecha),
        message: `${message} Se puede elegir del ${dia(pv.minimo)} al ${dia(pv.maximo)}.`,
      })
    }
    if (!args.fecha)
      return text({ ok: false, needsInput: true, field: 'fecha', question: 'Confirma con la fecha que devolvió la vista previa.' })
    if (!args.expectedSourceFingerprint)
      return text({ ok: false, needsInput: true, field: 'expectedSourceFingerprint', question: 'Pide primero la vista previa.' })
    if (huellaDeSede(sede, activa, args.fecha) !== args.expectedSourceFingerprint)
      return text({ ok: false, code: 'FECHA_CAMBIO', error: `La sede, la acción o la fecha cambiaron. ${QUE_HACER_SEDE.FECHA_CAMBIO}` })
    const base = { userId: h.scope.staffId, venueId: args.venueId, sedeId: sede }
    const r = activa ? await activarSede({ ...base, desde: args.fecha }) : await desactivarSede({ ...base, hasta: args.fecha })
    await auditMcpWrite(h.scope, {
      action: activa ? 'SERVICE_PAY_VENUE_ACTIVATED' : 'SERVICE_PAY_VENUE_DEACTIVATED',
      entity: 'Venue',
      entityId: sede,
      venueId: sede,
      data: { fecha: args.fecha, ventana: r.ventana },
    })
    return text({ ok: true, ...r })
  } catch (e) {
    return conQueHacer(h, e)
  }
}
