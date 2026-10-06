import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { hasPermission } from '@/services/access/access.service'
import { assertPermisoEnTodasLasSedes, organizacionTieneServicePay, venueHasServicePayAccess } from '@/services/dashboard/staffPay/acceso'
import { detallePersona, reportePeriodo } from '@/services/dashboard/staffPay/reporte.service'
import { listarNiveles, nivelesVigentes } from '@/services/dashboard/staffPay/niveles.service'
import { listarTablas } from '@/services/dashboard/staffPay/tablas.service'
import { hoyLocal } from '@/services/dashboard/staffPay/periodos'
import { cerrarPeriodo, previewCierre, type Bloqueo } from '@/services/dashboard/staffPay/cierre.service'
import { agregarAjusteManual, previewAjusteManual } from '@/services/dashboard/staffPay/ajustesManuales.service'
import { marcarPagado, previewPagado, reciboDePersona } from '@/services/dashboard/staffPay/recibos.service'
import { periodoQueContieneFecha } from '@/services/dashboard/staffPay/periodosGuardados'
import {
  activarPagoAlPersonal,
  cambiarPropinas,
  estadoActivacion,
  previewActivacion,
  ventanasDePropinas,
} from '@/services/dashboard/staffPay/activacion.service'
import { liquidarDiferencia, previewLiquidacion } from '@/services/dashboard/staffPay/liquidacion.service'
import { diferenciasDelPeriodo, FilaDiferencia } from '@/services/dashboard/staffPay/diferencias.service'
import {
  guardarAjusteDeClase,
  pagoDeClase,
  previewAjusteDeClase,
  type PagoDeClase,
} from '@/services/dashboard/staffPay/ajustesClase.service'
import { textoDeRegla, type MotivoExcepcion } from '@/services/dashboard/staffPay/valoracion'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import { auditMcpWrite } from '../audit'

const sedeArg = z.string().min(1).max(64).optional().describe('Only this venue of the organization (default: all venues you can read)')
const fecha = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe('Any day inside the pay period, YYYY-MM-DD venue-local (default: today)')

/** Las mismas palabras que el dashboard (`staffPay.json`): el agente se lo repite al dueño. */
const MOTIVOS: Record<MotivoExcepcion, string> = {
  SIN_COACH: 'La clase no tiene coach',
  COACH_SIN_NIVEL: 'La coach no tiene nivel',
  SIN_TABLA: 'No hay tabla de pagos para esta clase',
  SIN_MONTO_PARA_ESE_CONTEO: 'Falta el monto para ese número de lugares',
}
/** Por qué existe cada diferencia, con las mismas palabras que el dashboard (QA bloque B, defecto 4). */
function causaSinRegla(f: Pick<FilaDiferencia, 'causa' | 'conteo' | 'conteoCongelado' | 'coachActualNombre'>): string | null {
  switch (f.causa) {
    case 'CONTEO':
      return `Conteo corregido: ${f.conteoCongelado} → ${f.conteo}`
    case 'COACH_SALE':
      return f.coachActualNombre ? `Ya no da esta clase (ahora: ${f.coachActualNombre})` : 'Ya no da esta clase'
    case 'COACH_ENTRA':
      return 'Ahora da esta clase'
    case 'CANCELADA':
      return 'Clase cancelada después del cierre'
    case 'EXCLUIDA':
      return 'Clase excluida del pago'
    case 'TARDIA':
      return 'Clase registrada después del cierre'
    case 'REINCLUIDA':
      return 'Clase que no se pagaba al cerrar y ahora sí'
    case 'MONTO':
      return 'Monto de la clase corregido'
    default:
      return null
  }
}
/** La causa más la regla de clase que movió el monto (spec fase 3 §6.6): «Clase cancelada… · Cancelada 1 h antes: …». */
function causaLegible(f: Pick<FilaDiferencia, 'causa' | 'conteo' | 'conteoCongelado' | 'coachActualNombre' | 'regla'>): string | null {
  const causa = causaSinRegla(f)
  return causa && f.regla ? `${causa} · ${textoDeRegla(f.regla)}` : causa
}
/** Las dos reglas de clase de la versión vigente (spec fase 3 §6.6, §12), en palabras. El MCP sólo las lee. */
const reglasDeTabla = (r?: { coverBonusHours: number | null; coverBonusAmount: number | null; lateCancelHours: number | null }) => {
  const out: string[] = []
  if (r?.coverBonusHours != null && r.coverBonusAmount != null)
    out.push(
      `Suplencia asignada con menos de ${r.coverBonusHours} h antes de la clase: su nivel + $${r.coverBonusAmount.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    )
  if (r?.lateCancelHours != null)
    out.push(`Clase cancelada con menos de ${r.lateCancelHours} h antes: se paga el sueldo base (la celda de 0 lugares)`)
  return out
}
/** Qué hacer ante cada rechazo de «liquidar diferencia» (spec §6.4): el agente lo sigue sin adivinar. */
const QUE_HACER_LIQUIDAR: Record<string, string> = {
  HUELLA_CAMBIO: 'Pide de nuevo la vista previa (sin confirm) y muéstrasela al usuario antes de confirmar.',
  ORIGEN_CAMBIO:
    'Pide de nuevo la vista previa: si la clase se movió a un periodo abierto, ya no hay diferencia que liquidar (se paga al cerrar ese periodo).',
  PERIODO_CERRADO: 'Pide la vista previa sin destinoFecha (o con un día del periodo abierto) para liquidar en el periodo abierto.',
  CLAVE_REUTILIZADA:
    'Usa una idempotencyKey nueva para esta liquidación: pide la vista previa con ella, muéstrasela al usuario y confirma con la misma.',
  CLASE_EN_EXCEPCION:
    'Resuelve la clase (coach, nivel, tabla o monto; con adjust_service_pay_class puedes ajustar su monto o corregir su conteo) y vuelve a pedir la vista previa.',
  SEDE_FUERA_DEL_PERIODO: 'Si el usuario quiere sumar la sede al periodo, repite la vista previa con ampliarAlcance: true.',
}
/** Qué hacer ante cada rechazo de «ajustar una clase». */
const QUE_HACER_AJUSTE_CLASE: Record<string, string> = {
  HUELLA_CAMBIO: 'Pide de nuevo la vista previa (sin confirm) y muéstrasela al usuario antes de confirmar.',
  CLAVE_REUTILIZADA:
    'Usa una idempotencyKey nueva para este ajuste: pide la vista previa con ella, muéstrasela al usuario y confirma con la misma.',
}
/** La clave de «liquidar diferencia» viaja en `solicitudId` (`mcp-` + ella): 4 a 96, sin «:» (cabe en la clave del service). */
const CLAVE_LIQUIDACION = /^[A-Za-z0-9_.-]{4,96}$/
/** La del ajuste manual viaja en `clientKey` (`mcp-` + ella): 4 a 100, cabe en la clave del service (8 a 120). */
const CLAVE_AJUSTE = /^[A-Za-z0-9_.-]{4,100}$/
/** `YYYY-MM-DD` (fecha local) como fecha UTC: sólo para darle formato, nunca como instante. */
/** Cuántas ventanas del interruptor de propinas enseña la configuración (las más nuevas). */
const VENTANAS = 20
const diaUTC = (f: string) => {
  const [y, m, d] = f.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}
const diaLegible = (f: string) =>
  diaUTC(f).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
/** «de septiembre de 2026» si es el mes completo; si no, «del 1 sep 2026 al 15 sep 2026». */
const nombrePeriodicidad = (p: 'MONTHLY' | 'SEMIMONTHLY') => (p === 'MONTHLY' ? 'mensual' : 'quincenal')
const periodoLegible = (p: { start: string; end: string }) =>
  p.start.endsWith('-01') &&
  p.start.slice(0, 7) === p.end.slice(0, 7) &&
  diaUTC(p.end).getUTCMonth() !== new Date(diaUTC(p.end).getTime() + 86_400_000).getUTCMonth()
    ? `de ${diaUTC(p.start).toLocaleDateString('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`
    : `del ${diaLegible(p.start)} al ${diaLegible(p.end)}`

export function registerStaffPayTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  const puedeLeer = async (venueId: string): Promise<string | null> => {
    guard.venueFilter(venueId) // lanza si la sede está fuera del alcance
    const access = scope.perVenueAccess.get(venueId)
    if (!access || !hasPermission(access, 'staffpay:read')) return 'Necesitas el permiso staffpay:read en esta sede.'
    if (!(await venueHasServicePayAccess(venueId))) return 'Pago por servicio no está activo en este negocio; pídelo a Avoqado.'
    return null
  }

  server.tool(
    'staff_service_pay_summary',
    'Pay-per-service earnings for a pay period of a venue you can access (open: live; closed: frozen): total, classes paid, the sales commissions and tips that go into the pay receipt, staff count, exceptions (classes that cannot be valued yet and why) and a per-person total with its classes, commissions and tips. Amounts in Mexican pesos. Covers every venue of the organization you can read; partial=true means some venues were left out for lack of permission. This is what the business OWES each person this period. Requires staffpay:read.',
    {
      venueId: z.string().min(1).max(64).describe('Venue in your scope'),
      fecha,
      sede: sedeArg,
      offset: z.number().int().min(0).optional().describe('Offset for the per-person list'),
      limit: z.number().int().positive().max(100).optional().describe('Max people (default 50)'),
    },
    async ({ venueId, fecha: f, sede, offset, limit }) => {
      // PRIMERO el alcance de la CONEXIÓN para la sede del filtro, antes de consultar nada (como el desglose y las escrituras).
      if (sede) guard.venueFilter(sede)
      const no = await puedeLeer(venueId)
      if (no) return text({ ok: false, error: no })
      return text(await reportePeriodo({ userId: scope.staffId, venueId, fecha: f, sede, offset: offset ?? 0, limit: limit ?? 50 }))
    },
  )

  server.tool(
    'staff_service_pay_detail',
    'Line-by-line pay receipt of one staff member in a pay period: classes (date, venue, seats, level, amount or the exception that blocks it), sales commissions (one per sale), tips (grouped by day), refunds, voided commissions and manual adjustments, with the total of the whole receipt. For a closed period it returns the frozen receipt; for an open period it returns the class-by-class breakdown, or the live receipt with commissions and tips if you pass vista:"recibo". Use it to answer "¿cuánto se le debe a X?" or "¿cuánta propina le toca a X?". Paginated with a cursor. Amounts in Mexican pesos. Requires staffpay:read.',
    {
      venueId: z.string().min(1).max(64).describe('Venue in your scope'),
      staffId: z.string().min(1).max(64).describe('Staff member to break down'),
      fecha,
      sede: sedeArg,
      cursor: z.string().optional().describe('nextCursor (open period) or siguiente (closed receipt) from the previous page'),
      limit: z.number().int().positive().max(100).optional().describe('Max rows (default 50)'),
      vista: z
        .enum(['clases', 'recibo'])
        .optional()
        .describe('Open period only: "recibo" returns the live receipt with commissions and tips instead of the class-by-class breakdown'),
    },
    async ({ venueId, staffId, fecha: f, sede, cursor, limit, vista }) => {
      // PRIMERO el alcance de la CONEXIÓN (sede incluida), también para un periodo cerrado: `reciboDePersona` sólo conoce
      // al usuario.
      if (sede) guard.venueFilter(sede)
      const no = await puedeLeer(venueId)
      if (no) return text({ ok: false, error: no })
      const v = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true, timezone: true } })
      if (!v) return text({ ok: false, error: 'Sede no encontrada' })
      const dia = f ?? hoyLocal(v.timezone || 'America/Mexico_City')
      // El recibo congelado respeta cursor, límite y sede (Codex R2-R1-21).
      const recibo = async (cerrado: boolean) => {
        try {
          return text({
            cerrado,
            recibo: await reciboDePersona({ userId: scope.staffId, venueId, staffId, fecha: dia, sede, cursor, limit: limit ?? 50 }),
          })
        } catch (e) {
          // Codex R3-Nuevo 3: el cursor es de antes de un cierre (o del desglose en vivo): se pide de nuevo SIN cursor.
          if ((e as { code?: string })?.code !== 'RECIBO_CAMBIO') throw e
          return text({
            ok: false,
            code: 'RECIBO_CAMBIO',
            reiniciar: true,
            error: (e as Error).message,
            message: 'El periodo cambió mientras leías: vuelve a pedir este desglose SIN cursor para leer el recibo desde el principio.',
          })
        }
      }
      if ((await periodoQueContieneFecha(prisma, v.organizationId, dia))?.status === 'CLOSED') return recibo(true)
      // Fase 3 §12: el recibo en vivo de un periodo abierto (clases + comisiones + propinas), lo que se le debe hoy.
      if (vista === 'recibo') return recibo(false)
      try {
        return text(
          await detallePersona({ userId: scope.staffId, venueId, staffId, fecha: dia, sede, despuesDe: cursor, limit: limit ?? 50 }),
        )
      } catch (e) {
        // Se cerró entre la consulta y el desglose: el server responde PERIODO_CERRADO y se lee lo congelado.
        if ((e as { code?: string })?.code === 'PERIODO_CERRADO') return recibo(true)
        throw e
      }
    },
  )

  server.tool(
    'staff_service_pay_config',
    'How pay-per-service is configured: whether pay for staff is turned on and since when, whether tips are paid inside the receipt (and the latest 20 on/off windows as UTC instants, with the venue timezone to show them locally; ventanasTruncadas=true means there are older ones), the pay levels of the organization, which level each person has and since when, and the pay tables of the venue (seats occupied × level = amount) with the version in force on the given date. Each table also lists its two class rules (reglasDeClase, read-only; they are edited in the dashboard): a bonus for a substitute assigned with short notice, and the base pay (the 0-seat cell) for a late cancellation. Requires staffpay:read.',
    { venueId: z.string().min(1).max(64).describe('Venue in your scope'), fecha },
    async ({ venueId, fecha: f }) => {
      const no = await puedeLeer(venueId)
      if (no) return text({ ok: false, error: no })
      const v = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true, timezone: true } })
      if (!v) return text({ ok: false, error: 'Sede no encontrada' })
      const dia = f ?? hoyLocal(v.timezone || 'America/Mexico_City')
      const [niveles, asignaciones, tablas, estado, ventanas] = await Promise.all([
        listarNiveles(v.organizationId),
        nivelesVigentes(v.organizationId, dia),
        listarTablas(venueId, dia),
        estadoActivacion(prisma, v.organizationId),
        // Una de más: así se sabe si hay más ventanas de las que se devuelven.
        ventanasDePropinas(v.organizationId, VENTANAS + 1),
      ])
      return text({
        fecha: dia,
        activacion: {
          ...estado,
          ventanasDePropinas: ventanas.slice(0, VENTANAS),
          ventanasTruncadas: ventanas.length > VENTANAS,
          timezone: v.timezone || 'America/Mexico_City',
        },
        niveles,
        asignaciones,
        tablas: tablas.map(t => ({ ...t, reglasDeClase: reglasDeTabla(t.vigente?.reglas) })),
      })
    },
  )

  // ── Fase 2: escritura. Dos pasos (el catálogo emite y valida el confirmationToken). ──
  // `modulo: 'organizacion'` (sólo liquidar, Codex R2-R1-1, spec §5.6): la sede de la clase pudo apagar el módulo; basta con
  // que alguna sede de la organización lo tenga. Las demás escrituras lo exigen en su sede.
  const puedeEscribir = async (venueId: string, modulo: 'sede' | 'organizacion' = 'sede'): Promise<string | null> => {
    guard.venueFilter(venueId) // lanza si la sede está fuera del alcance
    requireWriteScopeAlways(scope, 'staffpay:close', 'registra pagos al staff')
    if (!guard.tienePermiso('staffpay:close', venueId)) return 'Necesitas el permiso staffpay:close en esta sede.'
    if (modulo === 'sede') {
      if (!(await venueHasServicePayAccess(venueId))) return 'Pago por servicio no está activo en este negocio; pídelo a Avoqado.'
    } else if (!(await organizacionTieneServicePay(venueId))) {
      return 'Pago por servicio no está activo en ninguna sede de este negocio; pídelo a Avoqado.'
    }
    return null
  }
  // Un 4xx del service (huella cambió, periodo cerrado, sin permiso…) es una respuesta, no un 500.
  const fallo = (e: unknown, extra = '') => {
    const err = e as { statusCode?: number; message?: string; code?: string; details?: { preview?: unknown } }
    if (!err?.statusCode || err.statusCode >= 500) throw e
    return text({ ok: false, error: `${err.message}${extra}`, code: err.code ?? null, preview: err.details?.preview ?? null })
  }
  const pesos = (s: string) => Number(s).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const conSigno = (s: string, moneda: string) => `${Number(s) < 0 ? '-' : '+'}$${pesos(String(Math.abs(Number(s))))} ${moneda}`
  const motivo = (b: Bloqueo) =>
    b.codigo === 'NO_HA_TERMINADO'
      ? `el periodo termina el ${b.hasta}`
      : b.codigo === 'CLASES_EN_CURSO'
        ? `${b.n} clase(s) en curso`
        : b.codigo === 'EXCEPCIONES'
          ? `${b.n} clase(s) con excepción por resolver`
          : b.codigo === 'SIN_PERMISO'
            ? 'te falta staffpay:close en alguna sede del periodo'
            : 'ya está cerrado'

  server.tool(
    'close_service_pay_period',
    'Close a pay-per-service period for the whole organization: freezes into one receipt per person the pay of every finished class, the sales commissions and (if the business pays them in the receipt) the tips that are due. Two steps: call without confirm to get the preview (classes, commissions, tips, people, total, blockers, tips without a person, sales or refunds whose commission is pending review) and its expectedSourceFingerprint; then call again with confirm:true and that fingerprint. If numbers changed in between it returns the new preview instead of closing. Requires staffpay:close in every venue of the period.',
    {
      venueId: z.string().min(1).max(64).describe('Venue in your scope'),
      fecha: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Any day inside the period to close, YYYY-MM-DD venue-local'),
      confirmarHuerfanas: z.boolean().optional().describe('Confirm that class bookings without a schedule do not count for any pay'),
      expectedSourceFingerprint: z.string().max(128).optional().describe('Fingerprint from the preview'),
      confirm: z.boolean().optional(),
    },
    async ({ venueId, fecha: f, confirmarHuerfanas, expectedSourceFingerprint, confirm }) => {
      const no = await puedeEscribir(venueId)
      if (no) return text({ ok: false, error: no })
      try {
        if (confirm !== true) {
          const p = await previewCierre({ userId: scope.staffId, venueId, fecha: f })
          // Cerrado o bloqueado: no se ofrece confirmar (su huella es '' o no cerraría).
          if (!p.puedeCerrar) {
            const yaCerrado = p.bloqueos.some(b => b.codigo === 'YA_CERRADO')
            return text({
              ok: false,
              preview: p,
              error: yaCerrado
                ? `Este periodo ya está cerrado: ${p.personas} recibo(s) por $${pesos(p.total)}.`
                : `Todavía no se puede cerrar: ${p.bloqueos.map(motivo).join('; ')}.`,
            })
          }
          // La confirmación de las huérfanas entra a la huella (D7): se pide aquí, para que el token ya la lleve.
          if (p.huerfanas > 0 && confirmarHuerfanas !== true) {
            return text({
              ok: false,
              needsInput: true,
              field: 'confirmarHuerfanas',
              preview: p,
              question: `Hay ${p.huerfanas} reserva(s) de clase sin horario que no cuentan para ningún pago. Si el usuario lo acepta, vuelve a pedir la vista previa con confirmarHuerfanas:true.`,
            })
          }
          // Fase 3 §12: el cierre nombra lo que congela (clases, comisiones, propinas), lo que descuenta y lo que deja fuera.
          const lista = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`)
          const que = lista([
            `${p.clases} clases`,
            ...(p.comisiones ? [`${p.comisiones} comisiones`] : []),
            ...(p.propinas ? [`${p.propinas} propinas`] : []),
          ])
          const anulaciones = p.reversos ? ` Se descuentan ${p.reversos} anulación(es) de comisiones ya pagadas.` : ''
          const sinDueno = p.propinasSinDueno.n
            ? ` ${p.propinasSinDueno.n} propina(s) sin persona ($${pesos(p.propinasSinDueno.total)}) no entran al recibo: asigna quién atendió la orden y entrarán en el siguiente cierre.`
            : ''
          // Resolución 16: efectos de comisión en revisión de cobros o devoluciones. Avisa, no bloquea.
          const porRevisar = p.comisionesPorRevisar
            ? ` ${p.comisionesPorRevisar} cobro(s) o devolución(es) con comisión por revisar: su comisión no se aplicó todavía.`
            : ''
          return text({
            ok: false,
            requiresConfirmation: true,
            preview: p,
            expectedSourceFingerprint: p.huella,
            message: `Se congelan ${que} de ${p.personas} personas, $${pesos(p.total)}.${anulaciones}${sinDueno}${porRevisar}${
              p.huerfanas > 0 ? ` ${p.huerfanas} reserva(s) de clase sin horario no cuentan para ningún pago.` : ''
            } Lo que cambie después aparecerá como diferencia pendiente; una devolución o anulación de una venta entra sola en el siguiente recibo.`,
          })
        }
        const r = await cerrarPeriodo({
          userId: scope.staffId,
          venueId,
          fecha: f,
          huellaEsperada: expectedSourceFingerprint ?? '',
          confirmarHuerfanas: confirmarHuerfanas ?? false,
        })
        if (!r.yaCerrado) {
          await auditMcpWrite(scope, {
            action: 'SERVICE_PAY_PERIOD_CLOSED',
            entity: 'ServicePayPeriod',
            entityId: r.periodId,
            venueId,
            data: { total: r.total, personas: r.personas },
          })
        }
        return text({ ok: true, ...r })
      } catch (e) {
        return fallo(e)
      }
    },
  )

  server.tool(
    'configure_service_pay',
    'Turn on pay for staff (pay-per-service) for the whole organization, or choose whether tips are paid inside the pay receipt. accion "activar": sales commissions (and tips, if on) start adding to the receipts from the start of the current period, and it fixes the period length (periodicidad MONTHLY or SEMIMONTHLY, ask the owner); earlier commissions are not added. accion "propinas": encender true pays tips inside the receipt, false hands them out separately; turning them off only affects future payments. Two steps: call without confirm to show current → new (for activar: the start date it would get and whether the period length is already fixed by saved periods; offer only that one); then confirm:true (for activar, with the expectedSourceFingerprint the preview returned: it is that start date, and if it changed in between —for example the period changed at midnight— nothing is activated and it asks for a new preview). Requires staffpay:close in every venue of the organization.',
    {
      venueId: z.string().min(1).max(64).describe('Venue in your scope'),
      accion: z.enum(['activar', 'propinas']).describe('activar | propinas'),
      periodicidad: z.enum(['MONTHLY', 'SEMIMONTHLY']).optional().describe('For activar: MONTHLY or SEMIMONTHLY'),
      encender: z.boolean().optional().describe('For propinas: true = tips inside the receipt; false = handed out separately'),
      expectedSourceFingerprint: z.string().max(128).optional().describe('For activar: the start date from the preview'),
      confirm: z.boolean().optional(),
    },
    async ({ venueId, accion, periodicidad, encender, expectedSourceFingerprint, confirm }) => {
      // El motivo de esta escritura (puedeEscribir lo repite con el de los pagos, que aquí no aplica).
      requireWriteScopeAlways(scope, 'staffpay:close', 'configura el pago al personal')
      const no = await puedeEscribir(venueId)
      if (no) return text({ ok: false, error: no })
      if (accion === 'activar' && !periodicidad)
        return text({
          ok: false,
          needsInput: true,
          field: 'periodicidad',
          question: '¿El pago al personal se cierra cada mes (MONTHLY) o cada quincena (SEMIMONTHLY)?',
        })
      if (accion === 'propinas' && encender === undefined)
        return text({
          ok: false,
          needsInput: true,
          field: 'encender',
          question: '¿Las propinas se pagan dentro del recibo (true) o se entregan aparte (false)?',
        })
      try {
        const v = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
        if (!v) return text({ ok: false, error: 'Sede no encontrada' })
        const actual = await estadoActivacion(prisma, v.organizationId)
        if (accion === 'activar') {
          if (actual.activado)
            return text({
              ok: false,
              sinCambios: true,
              actual,
              error: `Pago al personal ya está activado desde el ${actual.startDate}: no hay nada que cambiar.`,
            })
          if (confirm !== true) {
            // La vista previa ya rechaza lo que el confirmar rechazaría: el permiso en TODAS las sedes y la periodicidad fija.
            await assertPermisoEnTodasLasSedes(scope.staffId, v.organizationId, 'staffpay:close')
            const plan = await previewActivacion({ venueId, periodicidad: periodicidad! })
            const conPlan = { ...actual, periodicidad: plan.periodicidad, periodicidadFija: plan.periodicidadFija }
            if (plan.periodicidadFija && plan.periodicidad !== periodicidad)
              return text({
                ok: false,
                code: 'PERIODICIDAD_FIJA',
                actual: conPlan,
                error: `La periodicidad ya no se puede cambiar: ya hay periodos guardados. Activa con la que ya tienes (${nombrePeriodicidad(plan.periodicidad)}).`,
              })
            return text({
              ok: false,
              requiresConfirmation: true,
              actual: conPlan,
              nuevo: { activado: true, periodicidad, startDate: plan.startDate },
              // El catálogo la firma en el token: se confirma la fecha que se MOSTRÓ (Codex bloque B #3). No quitar.
              expectedSourceFingerprint: plan.startDate,
              message: `Pago al personal: sin activar → activado (${nombrePeriodicidad(periodicidad!)}${
                plan.periodicidadFija ? ', ya no cambia porque hay periodos guardados' : ''
              }). Desde el ${plan.startDate} se suman al recibo las comisiones${actual.propinasEncendidas ? ' y las propinas' : ''}; las anteriores no se suman: si debes alguna, agrégalo como ajuste.`,
            })
          }
          if (!expectedSourceFingerprint)
            return text({ ok: false, needsInput: true, field: 'expectedSourceFingerprint', question: 'Pide primero la vista previa.' })
          const r = await activarPagoAlPersonal({
            userId: scope.staffId,
            venueId,
            periodicidad: periodicidad!,
            inicioEsperado: expectedSourceFingerprint,
          })
          if (!r.yaActivado)
            await auditMcpWrite(scope, {
              action: 'SERVICE_PAY_ACTIVATED',
              entity: 'Organization',
              entityId: v.organizationId,
              venueId,
              data: { startDate: r.startDate, periodicidad },
            })
          return text({ ok: true, ...r })
        }
        if (!actual.activado) return text({ ok: false, actual, error: 'Activa primero el pago al personal (accion "activar").' })
        if (actual.propinasEncendidas === encender)
          return text({
            ok: false,
            sinCambios: true,
            actual,
            error: `Las propinas ya están ${encender ? 'encendidas' : 'apagadas'}: no hay nada que cambiar.`,
          })
        const de = (x: boolean) => (x ? 'encendidas' : 'apagadas')
        if (confirm !== true) {
          await assertPermisoEnTodasLasSedes(scope.staffId, v.organizationId, 'staffpay:close')
          return text({
            ok: false,
            requiresConfirmation: true,
            actual,
            message: `Propinas en el recibo: ${de(actual.propinasEncendidas)} → ${de(encender!)}.${
              encender
                ? ' Si hoy las entregas aparte cada día, no las pagues dos veces.'
                : ' Lo que ya entró no se pierde; sólo los cobros nuevos dejan de sumarse.'
            }`,
          })
        }
        const r = await cambiarPropinas({ userId: scope.staffId, venueId, encender: encender! })
        // Si otra persona lo cambió entre la vista previa y el confirmar, aquí no se escribió nada: no se audita.
        if (r.cambio)
          await auditMcpWrite(scope, {
            action: 'SERVICE_PAY_TIPS_SET',
            entity: 'Organization',
            entityId: v.organizationId,
            venueId,
            data: { encender },
          })
        return text({ ok: true, ...r })
      } catch (e) {
        return fallo(e, (e as { code?: string })?.code === 'INICIO_CAMBIO' ? ' Pide una vista previa nueva (sin confirm).' : '')
      }
    },
  )

  server.tool(
    'add_service_pay_adjustment',
    'Add a bonus (positive) or a deduction (negative) to one person in an open pay-per-service period, always tied to a venue and with a reason. Two steps: call without confirm to see which period it lands in and its expectedSourceFingerprint; then confirm:true with that fingerprint and the fecha the preview returned (if the period changed in between, it asks you to review again). idempotencyKey is required so a retry never adds it twice. Requires staffpay:close in that venue.',
    {
      venueId: z.string().min(1).max(64).describe('Venue in your scope'),
      sede: z.string().min(1).max(64).optional().describe('Venue the adjustment belongs to (default: venueId)'),
      staffId: z.string().min(1).max(64).describe('Person who receives the adjustment'),
      amount: z.number().describe('Pesos; negative for a deduction; never 0'),
      reason: z.string().min(3).max(300).describe('Why (shown on the receipt)'),
      fecha: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Any day inside the target open period (default: today); the preview returns the one to confirm with'),
      // Sin .regex() de zod: su error sale en inglés y antes del handler. Se valida abajo y se responde en español (needsInput).
      idempotencyKey: z
        .string()
        .optional()
        .describe(
          'Required. Unique key for this adjustment (4-100 letters, digits, - _ .); use the same one in the preview and when confirming',
        ),
      expectedSourceFingerprint: z.string().max(128).optional().describe('Fingerprint from the preview'),
      confirm: z.boolean().optional(),
    },
    async ({ venueId, sede, staffId, amount, reason, fecha: f, idempotencyKey, expectedSourceFingerprint, confirm }) => {
      if (sede) guard.venueFilter(sede) // la sede de la línea, por el alcance de la conexión antes de consultar nada
      const no = await puedeEscribir(venueId)
      if (no) return text({ ok: false, error: no })
      if (!idempotencyKey || !CLAVE_AJUSTE.test(idempotencyKey))
        return text({
          ok: false,
          needsInput: true,
          field: 'idempotencyKey',
          question:
            'idempotencyKey es obligatoria: de 4 a 100 caracteres, sólo letras, números, guion, guion bajo y punto; usa la misma en la vista previa y al confirmar.',
        })
      try {
        if (confirm !== true) {
          const pv = await previewAjusteManual({ userId: scope.staffId, venueId, sede: sede ?? venueId, staffId, amount, reason, fecha: f })
          if (pv.periodo.estado === 'CLOSED') {
            return text({
              ok: false,
              preview: pv,
              error: `El periodo del ${pv.periodo.start} al ${pv.periodo.end} ya está cerrado: elige una fecha del periodo abierto.`,
            })
          }
          return text({
            ok: false,
            requiresConfirmation: true,
            preview: pv,
            expectedSourceFingerprint: pv.huella,
            // El catálogo la liga a la confirmación: un reintento tras la medianoche del cambio de periodo sigue cayendo
            // en ESTE periodo (con «hoy» respondería CLAVE_REUTILIZADA y el humano recapturaría un bono doble).
            fecha: f ?? pv.periodo.start,
            // A quién y en qué sede: con dos «Ana» en el estudio, esta pantalla es lo que evita pagarle a la equivocada.
            message: `${amount >= 0 ? 'Se agrega un bono de' : 'Se descuentan'} $${pesos(String(Math.abs(amount)))} a ${pv.persona} en ${pv.sedeNombre} con el motivo «${reason}» al periodo del ${pv.periodo.start} al ${pv.periodo.end}.`,
          })
        }
        if (!expectedSourceFingerprint)
          return text({ ok: false, needsInput: true, field: 'expectedSourceFingerprint', question: 'Pide primero la vista previa.' })
        if (!f)
          return text({ ok: false, needsInput: true, field: 'fecha', question: 'Confirma con la fecha que devolvió la vista previa.' })
        const r = await agregarAjusteManual({
          userId: scope.staffId,
          venueId,
          sede: sede ?? venueId,
          staffId,
          amount,
          reason,
          fecha: f,
          clientKey: `mcp-${idempotencyKey}`,
          huellaEsperada: expectedSourceFingerprint,
        })
        if (!r.yaExistia) {
          await auditMcpWrite(scope, {
            action: 'SERVICE_PAY_MANUAL_ADJUSTMENT',
            entity: 'ServiceEarning',
            entityId: r.id,
            venueId,
            data: { amount: r.amount, staffId },
          })
        }
        return text({ ok: true, ...r })
      } catch (e) {
        return fallo(e)
      }
    },
  )

  server.tool(
    'mark_service_pay_paid',
    'Record that closed pay-per-service receipts were paid outside Avoqado (Avoqado does not move money). With staffId marks that person; without it marks everyone still pending in the period. Two steps: the preview lists exactly which receipts and totals will be marked and returns expectedSourceFingerprint; confirm:true with it. Requires staffpay:close in every venue of those receipts.',
    {
      venueId: z.string().min(1).max(64).describe('Venue in your scope'),
      periodId: z.string().min(1).max(64).describe('Closed period'),
      staffId: z.string().min(1).max(64).optional().describe('Only this person (default: everyone pending)'),
      nota: z.string().max(200).optional(),
      expectedSourceFingerprint: z.string().max(128).optional().describe('Fingerprint from the preview'),
      confirm: z.boolean().optional(),
    },
    async ({ venueId, periodId, staffId, nota, expectedSourceFingerprint, confirm }) => {
      const no = await puedeEscribir(venueId)
      if (no) return text({ ok: false, error: no })
      try {
        if (confirm !== true) {
          const pv = await previewPagado({ userId: scope.staffId, venueId, periodId, staffId })
          if (pv.periodo.estado !== 'CLOSED') {
            return text({ ok: false, preview: pv, error: 'Ese periodo todavía está abierto: sólo se marca pagado un periodo cerrado.' })
          }
          if (pv.cantidad === 0) return text({ ok: false, preview: pv, error: 'No hay recibos pendientes de pago en ese periodo.' })
          const nombres = pv.recibos.map(r => `${r.nombre} $${pesos(r.total)}`).join(', ')
          const resto = pv.cantidad > pv.recibos.length ? ` y ${pv.cantidad - pv.recibos.length} más` : ''
          return text({
            ok: false,
            requiresConfirmation: true,
            preview: pv,
            expectedSourceFingerprint: pv.huella,
            message: `Se registran como pagados ${pv.cantidad} recibo(s) (${staffId ? 'esa persona' : 'todos los pendientes'}) por $${pesos(pv.total)}: ${nombres}${resto}.`,
          })
        }
        if (!expectedSourceFingerprint)
          return text({ ok: false, needsInput: true, field: 'expectedSourceFingerprint', question: 'Pide primero la vista previa.' })
        const r = await marcarPagado({ userId: scope.staffId, venueId, periodId, staffId, nota, huellaEsperada: expectedSourceFingerprint })
        if (r.marcados) {
          await auditMcpWrite(scope, {
            action: 'SERVICE_PAY_MARKED_PAID',
            entity: 'ServicePayPeriod',
            entityId: periodId,
            venueId,
            data: { staffId: staffId ?? 'todos', marcados: r.marcados },
          })
        }
        return text({ ok: true, ...r })
      } catch (e) {
        const cambio = (e as { code?: string })?.code === 'HUELLA_CAMBIO'
        return fallo(e, cambio ? ' Revisa el preview: puede que ya se haya registrado.' : '')
      }
    },
  )

  server.tool(
    'staff_service_pay_differences',
    'Pending pay differences of a CLOSED pay-per-service period: classes whose pay changed after closing (corrected head count, substitute coach, cancellation, a class that arrived late). One row per class and person: why it exists (causa, in Spanish), what corresponds today, what was frozen at closing, what was already settled and what is pending (positive or negative), or the exception that blocks it. Paginated with a cursor; partial=true means some venues were left out for lack of permission. Settle a class with settle_service_pay_difference. Requires staffpay:read.',
    {
      venueId: z.string().min(1).max(64).describe('Venue in your scope'),
      periodId: z.string().min(1).max(64).describe('Closed period'),
      cursor: z.string().max(200).optional().describe('nextCursor from the previous page'),
      limit: z.number().int().positive().max(100).optional().describe('Max rows (default 50)'),
    },
    async ({ venueId, periodId, cursor, limit }) => {
      const no = await puedeLeer(venueId)
      if (no) return text({ ok: false, error: no })
      try {
        const r = await diferenciasDelPeriodo({ userId: scope.staffId, venueId, periodId, cursor, limit: limit ?? 50 })
        const ids = [...new Set(r.items.map(f => f.venueId))]
        const sedes = new Map(
          (
            await prisma.venue.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, currency: true }, take: ids.length })
          ).map(v => [v.id, v]),
        )
        return text({
          items: r.items.map(f => ({
            classSessionId: f.classSessionId,
            clase: f.productName,
            fecha: f.fechaLocal,
            venueId: f.venueId,
            sede: sedes.get(f.venueId)?.name ?? null,
            staffId: f.persona,
            persona: f.personaNombre,
            corresponde: f.corresponde,
            congelado: f.congelado,
            conciliado: f.conciliado,
            pendiente: f.pendiente,
            moneda: sedes.get(f.venueId)?.currency ?? 'MXN',
            enExcepcion: f.pendiente === null,
            motivo: f.motivo ? MOTIVOS[f.motivo] : null,
            causa: causaLegible(f),
          })),
          nextCursor: r.nextCursor,
          parcial: r.parcial,
          ...(r.parcial ? { message: 'Vista parcial: faltan sedes del periodo donde no tienes staffpay:read.' } : {}),
        })
      } catch (e) {
        return fallo(e)
      }
    },
  )

  server.tool(
    'settle_service_pay_difference',
    'Settle the pending pay difference of one class that belongs to an already closed period (a corrected head count, a substitute coach, a cancellation after closing, a class that arrived late). The difference is added once to an open period; the closed receipt never changes. Works even if the class venue later turned pay-per-service off, as long as some venue of the organization has it. Two steps: preview (who receives how much, the class, the venue and the period it lands in, and expectedSourceFingerprint), then confirm:true with that fingerprint. If the class venue is not in the open period it asks for ampliarAlcance:true to add it. idempotencyKey is required so a retry never pays twice. Requires staffpay:close in the class venue and in every venue of the open period.',
    {
      venueId: z.string().min(1).max(64).describe('Venue of the class'),
      classSessionId: z.string().min(1).max(64).describe('Class with a pending difference'),
      destinoFecha: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Any day inside the open period that receives it (default: today); the preview returns the one to confirm with'),
      // Sin .regex() de zod: su error sale en inglés y antes del handler. Se valida abajo y se responde en español (needsInput).
      idempotencyKey: z
        .string()
        .optional()
        .describe(
          'Required. Unique key for this settlement (4-96 letters, digits, - _ .); use the same one in the preview and when confirming',
        ),
      ampliarAlcance: z
        .boolean()
        .optional()
        .describe('Add the class venue to the open period when it is not there (e.g. the venue turned the feature off)'),
      expectedSourceFingerprint: z.string().max(128).optional().describe('Fingerprint from the preview'),
      confirm: z.boolean().optional(),
    },
    async ({ venueId, classSessionId, destinoFecha, idempotencyKey, ampliarAlcance, expectedSourceFingerprint, confirm }) => {
      // El módulo se exige en la ORGANIZACIÓN, no en la sede de la clase (Codex R2-R1-1, spec §5.6).
      const no = await puedeEscribir(venueId, 'organizacion')
      if (no) return text({ ok: false, error: no })
      if (!idempotencyKey || !CLAVE_LIQUIDACION.test(idempotencyKey))
        return text({
          ok: false,
          needsInput: true,
          field: 'idempotencyKey',
          question:
            'idempotencyKey es obligatoria: de 4 a 96 caracteres, sólo letras, números, guion, guion bajo y punto; usa la misma en la vista previa y al confirmar.',
        })
      try {
        if (confirm !== true) {
          const pv = await previewLiquidacion({ userId: scope.staffId, venueId, classSessionId, destinoFecha })
          if (!pv.periodoOrigen) {
            return text({
              ok: false,
              preview: pv,
              error: 'Esta clase no pertenece a un periodo cerrado: no tiene diferencia que liquidar (se paga al cerrar su periodo).',
            })
          }
          if (pv.bloqueada) {
            const motivos = [...new Set(pv.filas.flatMap(f => (f.motivo ? [MOTIVOS[f.motivo]] : [])))].join('; ')
            return text({
              ok: false,
              preview: pv,
              error: `La clase tiene algo sin resolver (${motivos || 'coach, nivel, tabla o monto'}): resuélvela antes de liquidar.`,
            })
          }
          const conMonto = pv.filas.filter(f => f.pendiente !== null && Number(f.pendiente) !== 0)
          if (!conMonto.length)
            return text({ ok: false, preview: pv, error: 'Esta clase no tiene diferencia pendiente: no hay nada que liquidar.' })
          const sede = await prisma.venue.findUnique({ where: { id: venueId }, select: { name: true, currency: true } })
          const sedeNombre = sede?.name ?? venueId
          const moneda = sede?.currency ?? 'MXN'
          const periodo = periodoLegible(pv.destino)
          // La deuda de una sede fuera del periodo entra sólo con ampliación explícita (spec §5.6): se pide aquí, para que
          // el token ya la lleve (como las huérfanas del cierre).
          if (!pv.sedeEnDestino && ampliarAlcance !== true) {
            return text({
              ok: false,
              needsInput: true,
              field: 'ampliarAlcance',
              preview: pv,
              question: `${sedeNombre} no está en el periodo ${periodo}. Si el usuario quiere sumarla para liquidar, vuelve a pedir la vista previa con ampliarAlcance:true.`,
            })
          }
          // A quién, cuánto, de qué clase y en qué sede: con dos «Ana» en el estudio, esto evita pagarle a la equivocada (A12).
          const c = conMonto[0]
          const quien = conMonto.map(f => `${conSigno(f.pendiente!, moneda)} a ${f.personaNombre ?? 'una persona sin nombre'}`).join(', ')
          const varias = conMonto.length > 1
          return text({
            ok: false,
            requiresConfirmation: true,
            preview: pv,
            expectedSourceFingerprint: pv.huella,
            // El catálogo la liga a la confirmación: se liquida en el periodo que se VIO, aunque pase la medianoche.
            destinoFecha: destinoFecha ?? pv.destino.start,
            moneda,
            message: `Se liquida${varias ? 'n diferencias' : ' una diferencia'} de ${quien} por ${c.productName} del ${diaLegible(c.fechaLocal)} en ${sedeNombre}; ${varias ? 'caen' : 'cae'} en el periodo ${periodo}.${
              pv.sedeEnDestino ? '' : ` ${sedeNombre} se suma a ese periodo.`
            }`,
          })
        }
        if (!expectedSourceFingerprint)
          return text({ ok: false, needsInput: true, field: 'expectedSourceFingerprint', question: 'Pide primero la vista previa.' })
        // El origen sale de un preview DENTRO de esta llamada; la huella, del argumento: si la clase se movió, la huella (que
        // cubre el origen) ya no coincide y el service responde HUELLA_CAMBIO u ORIGEN_CAMBIO.
        const pv = await previewLiquidacion({ userId: scope.staffId, venueId, classSessionId, destinoFecha })
        if (!pv.periodoOrigen) {
          return text({
            ok: false,
            code: 'ORIGEN_CAMBIO',
            error: `La clase ya no pertenece a un periodo cerrado. ${QUE_HACER_LIQUIDAR.ORIGEN_CAMBIO}`,
          })
        }
        const r = await liquidarDiferencia({
          userId: scope.staffId,
          venueId,
          classSessionId,
          destinoFecha,
          ampliarAlcance,
          periodoOrigenId: pv.periodoOrigen.id,
          huellaEsperada: expectedSourceFingerprint,
          solicitudId: `mcp-${idempotencyKey}`,
        })
        if (!r.yaLiquidada) {
          await auditMcpWrite(scope, {
            action: 'SERVICE_PAY_DIFFERENCE_SETTLED',
            entity: 'ClassSession',
            entityId: classSessionId,
            venueId,
            data: { lineas: r.lineas },
          })
        }
        return text({ ok: true, ...r })
      } catch (e) {
        const code = (e as { code?: string })?.code
        return fallo(e, code && QUE_HACER_LIQUIDAR[code] ? `. ${QUE_HACER_LIQUIDAR[code]}` : '')
      }
    },
  )

  // Revisión final, M-1: lo que la ruta `PUT /class-sessions/:id/pay-adjustments` hace, sobre la MISMA función.
  /** Cómo se lee el pago de la clase en un estado: monto, o por qué no tiene. */
  const pagoLegible = (c: PagoDeClase) =>
    c.monto !== null
      ? `$${pesos(c.monto)}${c.regla ? ` (${textoDeRegla(c.regla)})` : ''}`
      : c.estado === 'EXCLUIDA'
        ? 'excluida ($0.00)'
        : c.estado === 'CANCELADA'
          ? 'cancelada ($0.00)'
          : c.estado === 'NO_TERMINADA'
            ? 'sin pago todavía (no ha terminado)'
            : `sin pago (${c.motivo ? MOTIVOS[c.motivo as MotivoExcepcion] : 'algo sin resolver'})`

  server.tool(
    'adjust_service_pay_class',
    'Correct the pay of ONE class: fix the seats counted (payCountOverride), set an agreed amount in pesos (payAmountOverride) or leave it out of pay (payExcluded). Fields you omit keep their current value; null goes back to the calculated value. Use it to resolve a class blocked by an exception before settling its difference. Two steps: the preview says what changes in money and, if the class belongs to an already closed period, the difference left to settle with settle_service_pay_difference, plus expectedSourceFingerprint; then confirm:true with it. idempotencyKey is required. Works even if the class venue turned pay-per-service off, as long as some venue of the organization has it. Requires staffpay:manage in the class venue, and staffpay:close if the class was already counted in a closed period.',
    {
      venueId: z.string().min(1).max(64).describe('Venue of the class'),
      classSessionId: z.string().min(1).max(64).describe('Class to correct'),
      // Sin reglas de zod (su error sale en inglés): el service valida y responde en español.
      payCountOverride: z.number().nullable().optional().describe('Seats to pay instead of the count (0-500); null: back to the count'),
      payAmountOverride: z.number().nullable().optional().describe('Agreed amount in pesos instead of the table; null: back to the table'),
      payExcluded: z.boolean().optional().describe('true: this class is not paid; false: include it again'),
      reason: z.string().describe('Why (3-300 characters; kept in the audit log)'),
      idempotencyKey: z
        .string()
        .optional()
        .describe(
          'Required. Unique key for this correction (4-100 letters, digits, - _ .); use the same one in the preview and when confirming',
        ),
      expectedSourceFingerprint: z.string().max(128).optional().describe('Fingerprint from the preview'),
      confirm: z.boolean().optional(),
    },
    async ({
      venueId,
      classSessionId,
      payCountOverride,
      payAmountOverride,
      payExcluded,
      reason,
      idempotencyKey,
      expectedSourceFingerprint,
      confirm,
    }) => {
      guard.venueFilter(venueId) // lanza si la sede está fuera del alcance, antes de consultar nada
      requireWriteScopeAlways(scope, 'staffpay:manage', 'corrige el pago de una clase')
      if (!guard.tienePermiso('staffpay:manage', venueId))
        return text({ ok: false, error: 'Necesitas el permiso staffpay:manage en esta sede.' })
      // Como la ruta (M-2): el módulo en la ORGANIZACIÓN, para que una sede que lo apagó pueda resolver sus clases (spec §5.6).
      if (!(await organizacionTieneServicePay(venueId)))
        return text({ ok: false, error: 'Pago por servicio no está activo en ninguna sede de este negocio; pídelo a Avoqado.' })
      if (!idempotencyKey || !CLAVE_AJUSTE.test(idempotencyKey))
        return text({
          ok: false,
          needsInput: true,
          field: 'idempotencyKey',
          question:
            'idempotencyKey es obligatoria: de 4 a 100 caracteres, sólo letras, números, guion, guion bajo y punto; usa la misma en la vista previa y al confirmar.',
        })
      try {
        const card = await pagoDeClase(venueId, classSessionId)
        // El mismo permiso que el service exige a la ruta: una clase ya contabilizada sólo la corrige quien puede cerrar.
        if (card.anclada && !guard.tienePermiso('staffpay:close', venueId))
          return text({
            ok: false,
            error: 'Esta clase ya se contabilizó en un periodo cerrado: corregirla necesita el permiso staffpay:close.',
          })
        // Lo que no se manda conserva su valor actual; null vuelve al cálculo.
        const a = card.ajuste
        const cambio = {
          payCountOverride: payCountOverride !== undefined ? payCountOverride : (a?.payCountOverride ?? null),
          payAmountOverride:
            payAmountOverride !== undefined ? payAmountOverride : a?.payAmountOverride != null ? Number(a.payAmountOverride) : null,
          payExcluded: payExcluded ?? a?.payExcluded ?? false,
        }
        const entrada = { venueId, classSessionId, ...cambio, reason, actorId: scope.staffId }
        if (confirm !== true) {
          const igual =
            cambio.payCountOverride === (a?.payCountOverride ?? null) &&
            cambio.payAmountOverride === (a?.payAmountOverride != null ? Number(a.payAmountOverride) : null) &&
            cambio.payExcluded === (a?.payExcluded ?? false)
          if (igual) return text({ ok: false, error: 'La clase ya tiene esos valores: no hay nada que cambiar.' })
          const pv = await previewAjusteDeClase(entrada)
          const sede = await prisma.venue.findUnique({ where: { id: venueId }, select: { currency: true } })
          const moneda = sede?.currency ?? 'MXN'
          const quien = pv.despues.staffName ?? pv.antes.staffName
          const cerrado = pv.periodoCerrado ? `el periodo ${periodoLegible(pv.periodoCerrado)}` : null
          const resto = !cerrado
            ? ''
            : pv.pendiente === null
              ? `; ${cerrado} ya se cerró y la clase sigue sin resolver: todavía no se puede liquidar`
              : Number(pv.pendiente) !== 0
                ? `; como ${cerrado} ya se cerró, queda una diferencia de ${conSigno(pv.pendiente, moneda)} por liquidar (settle_service_pay_difference)`
                : `; ${cerrado} ya se cerró y no queda diferencia por liquidar`
          return text({
            ok: false,
            requiresConfirmation: true,
            preview: pv,
            expectedSourceFingerprint: pv.huella,
            message: `La clase ${pv.clase.productName} del ${diaLegible(pv.clase.fechaLocal)}${quien ? ` de ${quien}` : ''} pasa de ${pagoLegible(pv.antes)} a ${pagoLegible(pv.despues)}${resto}.`,
          })
        }
        if (!expectedSourceFingerprint)
          return text({ ok: false, needsInput: true, field: 'expectedSourceFingerprint', question: 'Pide primero la vista previa.' })
        const r = await guardarAjusteDeClase({
          ...entrada,
          clientKey: `mcp-${idempotencyKey}`,
          huellaEsperada: expectedSourceFingerprint,
        })
        if (!r.yaAplicado && !r.sinCambios) {
          await auditMcpWrite(scope, {
            action: 'SERVICE_PAY_CLASS_ADJUSTED',
            entity: 'ClassSession',
            entityId: classSessionId,
            venueId,
            data: { ...cambio, monto: r.monto },
          })
        }
        return text({ ok: true, ...r })
      } catch (e) {
        const code = (e as { code?: string })?.code
        return fallo(e, code && QUE_HACER_AJUSTE_CLASE[code] ? `. ${QUE_HACER_AJUSTE_CLASE[code]}` : '')
      }
    },
  )
}
