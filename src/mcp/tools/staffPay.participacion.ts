// src/mcp/tools/staffPay.participacion.ts — `configure_service_pay`: activar la organización eligiendo sedes y activar o
// desactivar UNA sede «desde / hasta qué día», en dos pasos y con los montos de lo que entra (fase 3, B11; diseño r4.6, r7.3), y
// cambiar las propinas del recibo (B14-fix2 la trae aquí desde `staffPay.ts`, junto a sus hermanas).
import { createHash } from 'crypto'
import prisma from '@/utils/prismaClient'
import { assertPermisoEnTodasLasSedes } from '@/services/dashboard/staffPay/acceso'
import { COMO_SE_CONSIGUE_EL_PLAN } from '@/services/dashboard/staffPay/textos'
import {
  activarPagoAlPersonal,
  cambiarPropinas,
  previewActivacion,
  sedesParaActivar,
} from '@/services/dashboard/staffPay/activacion.service'
import { activarSede, desactivarSede } from '@/services/dashboard/staffPay/participacion'
import { vistaPreviaParticipacion, type Cuenta } from '@/services/dashboard/staffPay/participacion.vistaPrevia'
import { textoSedeActivaSinPlan, type Bloqueo } from '@/services/dashboard/staffPay/cierre.alcance'
import type { McpScope } from '../scope'
import type { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { conSigno, diaLegible, lista } from './staffPay.formato'
import {
  baseDeLaHuella,
  camposFuera,
  conAviso,
  huellaConFuera,
  huellaDePropinas,
  revisarConexion,
  sedesFueraCambiaron,
} from './staffPay.conexion'
import { sedesDeLasPropinas } from './staffPay.alcanceDeLaAccion'

type Respuesta = ReturnType<typeof text>
/** Lo que el registro de las herramientas ya tiene y estas acciones reusan (alcance de la conexión, permisos, errores). */
export interface Herramientas {
  scope: McpScope
  guard: ReturnType<typeof createGuard>
  puedeEscribir: (venueId: string, modulo?: 'sede' | 'organizacion' | 'ninguno', exigirActivacion?: boolean) => Promise<string | null>
  fallo: (e: unknown, extra?: string) => Respuesta
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
/**
 * La huella de activar la organización (r4.6): la fecha de inicio Y las sedes elegidas, ordenadas. 64 caracteres. B14-fix2: con
 * sedes fuera de la conexión lleva además su lista ordenada (sin ellas, la de siempre). Ronda 1 (M3): esa lista va APARTE, tras
 * `~` (`huellaConFuera`, como la del cierre), para que al confirmar se sepa QUÉ cambió: la fecha o las sedes con el plan
 * (INICIO_CAMBIO), o sólo las sedes fuera de la conexión (SEDES_FUERA_CAMBIARON).
 */
export const huellaDeActivar = (startDate: string, sedes: string[], fuera: ReadonlyArray<{ venueId: string }> = []) =>
  huellaConFuera(
    sha256(`activar|${startDate}|${[...sedes].sort().join(',')}`),
    [...fuera].sort((a, b) => (a.venueId < b.venueId ? -1 : a.venueId > b.venueId ? 1 : 0)),
  )
/** La huella de activar o desactivar UNA sede (r4.6): la sede, la acción y la fecha EXPLÍCITA (nunca «hoy»). */
export const huellaDeSede = (sede: string, activa: boolean, fecha: string) => sha256(`sede|${sede}|${activa}|${fecha}`)

/**
 * Un bloqueo del cierre en palabras para `close_service_pay_period`. `SEDE_ACTIVA_SIN_PLAN` dice lo MISMO que el cierre
 * (`textoSedeActivaSinPlan`, revisión de B11 #5), con los nombres de las sedes que trae la vista previa (`porSede`).
 * Ruling de B13 ronda 1: estos textos PUEDEN nombrar sedes del alcance del periodo que están fuera de la conexión (se les pasa la
 * vista previa completa, no la acotada): para verlos hay que tener `staffpay:close` en TODO el alcance, sus ids ya salían antes y
 * el cierre es de toda la organización. Lo que sí se acota a la conexión es `porSede`, las pendientes, el aviso y las sedes.
 */
export const motivoDeBloqueo = (b: Bloqueo, p: { porSede?: Array<{ venueId: string; nombre: string }> }): string =>
  b.codigo === 'NO_HA_TERMINADO'
    ? `el periodo termina el ${diaLegible(b.hasta)}`
    : b.codigo === 'CLASES_EN_CURSO'
      ? `${b.n} clase(s) en curso`
      : b.codigo === 'EXCEPCIONES'
        ? `${b.n} clase(s) con excepción por resolver`
        : b.codigo === 'SIN_PERMISO'
          ? 'te falta staffpay:close en alguna sede del periodo'
          : b.codigo === 'SEDE_ACTIVA_SIN_PLAN'
            ? `${textoSedeActivaSinPlan(
                b.venueIds.map(v => p.porSede?.find(x => x.venueId === v)?.nombre ?? v),
                b.otrasConPlan,
              )}${b.otrasConPlan ? ' (accion "sede" con activa:false)' : ''}`
            : 'ya está cerrado'

const nombrePeriodicidad = (p: 'MONTHLY' | 'SEMIMONTHLY') => (p === 'MONTHLY' ? 'mensual' : 'quincenal')
/** «2 clases ($1,000.00), 1 comisión ($100.00) y 0 propinas ($0.00)», más las clases que todavía no se pueden valorar. */
const cuentaLegible = (c: Cuenta) => {
  const partes = lista([
    `${c.clases.n} clase(s) (${conSigno(c.clases.total)})`,
    `${c.comisiones.n} comisión(es) (${conSigno(c.comisiones.total)})`,
    `${c.propinas.n} propina(s) (${conSigno(c.propinas.total)})`,
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
  SEDE_SIN_PLAN: `La sede necesita Pago al personal en su plan para activarla: ${COMO_SE_CONSIGUE_EL_PLAN}.`,
  VENTANA_SE_CRUZA:
    'Esas fechas se cruzan con días en que la sede ya estuvo activa (quizá cuando era de otra organización): elige otra fecha o pide ayuda a Avoqado.',
  CIERRE_EN_CURSO: 'Hay un cierre de periodo en curso: intenta de nuevo en un momento.',
  OPERACION_EN_CURSO: 'Otra operación está cambiando la sede o la organización: intenta de nuevo en un momento.',
  SEDE_EN_OTRA_ORGANIZACION: 'La sede ya es de otra organización: aquí no se activa ni se desactiva; revisa la lista de sedes.',
}
const conQueHacer = (h: Herramientas, e: unknown) => {
  const code = (e as { code?: string })?.code
  const rango = (e as { details?: { desde?: string; hasta?: string } })?.details
  const extra =
    code === 'FECHA_FUERA_DE_RANGO' && rango?.desde
      ? ` Rango: del ${diaLegible(rango.desde)} al ${diaLegible(rango.hasta ?? rango.desde)}.`
      : ''
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
      error: `Pago al personal ya está activado desde el ${actual.startDate ? diaLegible(actual.startDate) : 'su inicio'}: no hay nada que cambiar.`,
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
    // B14-fix2: sin `sedes` se activan TODAS las del plan, también las de fuera de esta conexión: aviso al dueño, negativa al resto.
    const rev = await revisarConexion(h.scope, 'activar', ids)
    if (rev.negada) return rev.negada
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
      ...camposFuera(rev),
      // El catálogo firma la fecha y la huella en el token: se confirma lo que se MOSTRÓ (Codex bloque B #3, r4.6). No quitar.
      fecha: plan.startDate,
      expectedSourceFingerprint: huellaDeActivar(plan.startDate, ids, rev.fuera),
      message: conAviso(
        rev,
        `Pago al personal: sin activar → activado (${nombrePeriodicidad(periodicidad)}${
          plan.periodicidadFija ? ', ya no cambia porque hay periodos guardados' : '; la periodicidad queda fija al activar'
        }). Desde el ${plan.startDate} se suman al recibo las comisiones${actual.propinasEncendidas ? ' y las propinas' : ''} de ${lista(
          ids.map(id => nombre.get(id) ?? id),
        )}; las anteriores no se suman: si debes alguna, agrégalo como ajuste.${
          fuera.length ? ` Quedan sin activar: ${lista(fuera)} (se activan después, sede por sede).` : ''
        }${sinElPlan}`,
      ),
    })
  }
  if (!args.expectedSourceFingerprint)
    return text({ ok: false, needsInput: true, field: 'expectedSourceFingerprint', question: 'Pide primero la vista previa.' })
  if (!args.fecha)
    return text({ ok: false, needsInput: true, field: 'fecha', question: 'Confirma con la fecha que devolvió la vista previa.' })
  const { ids, sinPlan } = await elegidas()
  // B14-fix2: se revalida quién pide y qué sedes quedan fuera AHORA; la huella lleva esa lista. Ronda 1 (M3): si cambió la fecha o
  // las sedes con el plan, INICIO_CAMBIO; si sólo cambiaron las sedes fuera de la conexión, SEDES_FUERA_CAMBIARON.
  const rev = await revisarConexion(h.scope, 'activar', ids)
  if (rev.negada) return rev.negada
  if (sinPlan.length || baseDeLaHuella(args.expectedSourceFingerprint) !== huellaDeActivar(args.fecha, ids))
    return text({
      ok: false,
      code: 'INICIO_CAMBIO',
      error: 'La fecha de inicio o las sedes con el plan cambiaron desde la vista previa. Pide una vista previa nueva (sin confirm).',
    })
  if (huellaDeActivar(args.fecha, ids, rev.fuera) !== args.expectedSourceFingerprint) return sedesFueraCambiaron(rev.fuera)
  try {
    const r = await activarPagoAlPersonal({ userId: h.scope.staffId, venueId, periodicidad, inicioEsperado: args.fecha, sedes: ids })
    if (!r.yaActivado)
      await auditMcpWrite(h.scope, {
        action: 'SERVICE_PAY_ACTIVATED',
        entity: 'Organization',
        entityId: organizationId,
        venueId,
        data: { startDate: r.startDate, periodicidad, sedes: ids, ...camposFuera(rev) },
      })
    return text({ ok: true, ...r })
  } catch (e) {
    return h.fallo(e, (e as { code?: string })?.code === 'INICIO_CAMBIO' ? ' Pide una vista previa nueva (sin confirm).' : '')
  }
}

/**
 * `accion: 'propinas'` (B9): si las propinas se pagan dentro del recibo. Es de TODA la organización: B14-fix2 (hermano de las tres
 * del founder) le aplica la misma regla que al cierre —con sedes con el plan fuera de esta conexión, aviso al dueño y la huella de
 * esa lista; negativa a los demás— y la revalida al confirmar. Sin sedes fuera, igual que antes (sin huella).
 */
export async function propinasDeLaOrganizacion(
  h: Herramientas,
  args: {
    venueId: string
    organizationId: string
    actual: { activado: boolean; startDate: string | null; propinasEncendidas: boolean }
    encender: boolean
    expectedSourceFingerprint?: string
    confirm?: boolean
  },
): Promise<Respuesta> {
  const { venueId, organizationId, actual, encender, expectedSourceFingerprint, confirm } = args
  if (!actual.activado) return text({ ok: false, actual, error: 'Activa primero el pago al personal (accion "activar").' })
  if (actual.propinasEncendidas === encender)
    return text({
      ok: false,
      sinCambios: true,
      actual,
      error: `Las propinas ya están ${encender ? 'encendidas' : 'apagadas'}: no hay nada que cambiar.`,
    })
  const de = (x: boolean) => (x ? 'encendidas' : 'apagadas')
  // B14-fix2 (hermano): las propinas son de toda la organización (las sedes con el plan, las del permiso del service).
  const revisar = async () => revisarConexion(h.scope, 'propinas', await sedesDeLasPropinas(organizationId))
  if (confirm !== true) {
    await assertPermisoEnTodasLasSedes(h.scope.staffId, organizationId, 'staffpay:close')
    const rev = await revisar()
    if (rev.negada) return rev.negada
    const huella = huellaDePropinas(encender, rev.fuera)
    return text({
      ok: false,
      requiresConfirmation: true,
      actual,
      ...camposFuera(rev),
      ...(huella ? { expectedSourceFingerprint: huella } : {}),
      message: conAviso(
        rev,
        `Propinas en el recibo: ${de(actual.propinasEncendidas)} → ${de(encender)}.${
          encender
            ? ' Si hoy las entregas aparte cada día, no las pagues dos veces.'
            : ' Lo que ya entró no se pierde; sólo los cobros nuevos dejan de sumarse.'
        }`,
      ),
    })
  }
  const rev = await revisar()
  if (rev.negada) return rev.negada
  if ((expectedSourceFingerprint ?? null) !== huellaDePropinas(encender, rev.fuera)) return sedesFueraCambiaron(rev.fuera)
  const r = await cambiarPropinas({ userId: h.scope.staffId, venueId, encender })
  // Si otra persona lo cambió entre la vista previa y el confirmar, aquí no se escribió nada: no se audita.
  if (r.cambio)
    await auditMcpWrite(h.scope, {
      action: 'SERVICE_PAY_TIPS_SET',
      entity: 'Organization',
      entityId: organizationId,
      venueId,
      data: { encender, ...camposFuera(rev) },
    })
  return text({ ok: true, ...r })
}

/**
 * `accion: 'sede'` (B11, r4.6, r4.7, r7.3): activar (`activa: true`, desde `fecha`) o desactivar (`activa: false`, hasta
 * `fecha`, incluido) UNA sede. La vista previa resuelve «hoy» a una fecha EXPLÍCITA, la devuelve en `fecha` y trae los
 * montos (los de la ruta `participation-preview`); la huella es `huellaDeSede`. Al confirmar se usa esa fecha (pasar la
 * medianoche no reinterpreta «hoy») y el service la revalida bajo candado. Exige `staffpay:close` en la sede; desactivar no
 * pide plan (`modulo: 'ninguno'`), activar sí (en la organización y, el service, en la sede). Ninguna de las dos pasa por la
 * puerta de activación (C2): si la organización no activó, el service responde NO_ACTIVADO y el agente lee «accion "activar"».
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
  const no = await h.puedeEscribir(args.venueId, activa ? 'organizacion' : 'ninguno', false)
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
          ? `${nombre} se activa en pago al personal desde el ${diaLegible(pv.fecha)} a las 00:00 (${pv.zona}). Entran, de los periodos sin cerrar: ${cuentaLegible(pv.entran)}. Quedan fuera: ${cuentaLegible(pv.quedanFuera)}; lo que quede fuera no se paga: si debes algo, agrégalo como ajuste.`
          : `${nombre} se desactiva: el ${diaLegible(pv.fecha)} es su último día en pago al personal. Dejan de entrar, de los periodos sin cerrar: ${cuentaLegible(pv.dejanDeEntrar)}. Siguen entrando: ${cuentaLegible(pv.permanecen)}.`
      return text({
        ok: false,
        requiresConfirmation: true,
        preview: pv,
        // El catálogo la firma en el token: se confirma la fecha que se MOSTRÓ, nunca «hoy» otra vez (r4.6). No quitar.
        fecha: pv.fecha,
        expectedSourceFingerprint: huellaDeSede(sede, activa, pv.fecha),
        message: `${message} Se puede elegir del ${diaLegible(pv.minimo)} al ${diaLegible(pv.maximo)}.`,
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
