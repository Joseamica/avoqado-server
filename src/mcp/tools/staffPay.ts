import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { hasPermission } from '@/services/access/access.service'
import { organizacionTieneServicePay, venueHasServicePayAccess } from '@/services/dashboard/staffPay/acceso'
import { detallePersona, reportePeriodo } from '@/services/dashboard/staffPay/reporte.service'
import { listarNiveles, nivelesVigentes } from '@/services/dashboard/staffPay/niveles.service'
import { listarTablas } from '@/services/dashboard/staffPay/tablas.service'
import { hoyLocal } from '@/services/dashboard/staffPay/periodos'
import { cerrarPeriodo, previewCierre, type Bloqueo } from '@/services/dashboard/staffPay/cierre.service'
import { agregarAjusteManual, previewAjusteManual } from '@/services/dashboard/staffPay/ajustesManuales.service'
import { marcarPagado, previewPagado, reciboDePersona } from '@/services/dashboard/staffPay/recibos.service'
import { periodoQueContieneFecha } from '@/services/dashboard/staffPay/periodosGuardados'
import { liquidarDiferencia, previewLiquidacion } from '@/services/dashboard/staffPay/liquidacion.service'
import { diferenciasDelPeriodo } from '@/services/dashboard/staffPay/diferencias.service'
import type { MotivoExcepcion } from '@/services/dashboard/staffPay/valoracion'
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
/** Qué hacer ante cada rechazo de «liquidar diferencia» (spec §6.4): el agente lo sigue sin adivinar. */
const QUE_HACER_LIQUIDAR: Record<string, string> = {
  HUELLA_CAMBIO: 'Pide de nuevo la vista previa (sin confirm) y muéstrasela al usuario antes de confirmar.',
  ORIGEN_CAMBIO:
    'Pide de nuevo la vista previa: si la clase se movió a un periodo abierto, ya no hay diferencia que liquidar (se paga al cerrar ese periodo).',
  PERIODO_CERRADO: 'Pide la vista previa sin destinoFecha (o con un día del periodo abierto) para liquidar en el periodo abierto.',
  CLAVE_REUTILIZADA: 'Usa una idempotencyKey nueva para esta liquidación.',
  CLASE_EN_EXCEPCION: 'Resuelve la clase (coach, nivel, tabla o monto) y vuelve a pedir la vista previa.',
  SEDE_FUERA_DEL_PERIODO: 'Si el usuario quiere sumar la sede al periodo, repite la vista previa con ampliarAlcance: true.',
}
/** La clave de «liquidar diferencia» viaja en `solicitudId` (`mcp-` + ella): 4 a 96, sin «:» (cabe en la clave del service). */
const CLAVE_LIQUIDACION = /^[A-Za-z0-9_.-]{4,96}$/
/** La del ajuste manual viaja en `clientKey` (`mcp-` + ella): 4 a 100, cabe en la clave del service (8 a 120). */
const CLAVE_AJUSTE = /^[A-Za-z0-9_.-]{4,100}$/
/** `YYYY-MM-DD` (fecha local) como fecha UTC: sólo para darle formato, nunca como instante. */
const diaUTC = (f: string) => {
  const [y, m, d] = f.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}
const diaLegible = (f: string) =>
  diaUTC(f).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
/** «de septiembre de 2026» si es el mes completo; si no, «del 1 sep 2026 al 15 sep 2026». */
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
    'Pay-per-service earnings for the current (open) pay period of a venue you can access: total, classes paid, staff count, exceptions (classes that cannot be valued yet and why) and a per-person total. Amounts in Mexican pesos. Covers every venue of the organization you can read; partial=true means some venues were left out for lack of permission. Requires staffpay:read.',
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
    'Class-by-class breakdown of one staff member pay in a pay period: date, venue, class, seats counted, how they were counted, level, amount, or the exception that blocks it. For a closed period it returns the frozen receipt (classes, differences, adjustments, total for the whole receipt, paid date) with the same cursor, limit and venue filter. Paginated with a cursor. Amounts in Mexican pesos. Requires staffpay:read.',
    {
      venueId: z.string().min(1).max(64).describe('Venue in your scope'),
      staffId: z.string().min(1).max(64).describe('Staff member to break down'),
      fecha,
      sede: sedeArg,
      cursor: z.string().optional().describe('nextCursor (open period) or siguiente (closed receipt) from the previous page'),
      limit: z.number().int().positive().max(100).optional().describe('Max rows (default 50)'),
    },
    async ({ venueId, staffId, fecha: f, sede, cursor, limit }) => {
      // PRIMERO el alcance de la CONEXIÓN (sede incluida), también para un periodo cerrado: `reciboDePersona` sólo conoce
      // al usuario.
      if (sede) guard.venueFilter(sede)
      const no = await puedeLeer(venueId)
      if (no) return text({ ok: false, error: no })
      const v = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true, timezone: true } })
      if (!v) return text({ ok: false, error: 'Sede no encontrada' })
      const dia = f ?? hoyLocal(v.timezone || 'America/Mexico_City')
      // El recibo congelado respeta cursor, límite y sede (Codex R2-R1-21).
      const recibo = async () => {
        try {
          return text({
            cerrado: true,
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
      if ((await periodoQueContieneFecha(prisma, v.organizationId, dia))?.status === 'CLOSED') return recibo()
      try {
        return text(
          await detallePersona({ userId: scope.staffId, venueId, staffId, fecha: dia, sede, despuesDe: cursor, limit: limit ?? 50 }),
        )
      } catch (e) {
        // Se cerró entre la consulta y el desglose: el server responde PERIODO_CERRADO y se lee lo congelado.
        if ((e as { code?: string })?.code === 'PERIODO_CERRADO') return recibo()
        throw e
      }
    },
  )

  server.tool(
    'staff_service_pay_config',
    'How pay-per-service is configured: the pay levels of the organization, which level each person has and since when, and the pay tables of the venue (seats occupied × level = amount) with the version in force on the given date. Requires staffpay:read.',
    { venueId: z.string().min(1).max(64).describe('Venue in your scope'), fecha },
    async ({ venueId, fecha: f }) => {
      const no = await puedeLeer(venueId)
      if (no) return text({ ok: false, error: no })
      const v = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true, timezone: true } })
      if (!v) return text({ ok: false, error: 'Sede no encontrada' })
      const dia = f ?? hoyLocal(v.timezone || 'America/Mexico_City')
      const [niveles, asignaciones, tablas] = await Promise.all([
        listarNiveles(v.organizationId),
        nivelesVigentes(v.organizationId, dia),
        listarTablas(venueId, dia),
      ])
      return text({ fecha: dia, niveles, asignaciones, tablas })
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
    'Close a pay-per-service period for the whole organization: freezes the pay of every finished class into one receipt per person. Two steps: call without confirm to get the preview (classes, people, total, blockers) and its expectedSourceFingerprint; then call again with confirm:true and that fingerprint. If numbers changed in between it returns the new preview instead of closing. Requires staffpay:close in every venue of the period.',
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
          return text({
            ok: false,
            requiresConfirmation: true,
            preview: p,
            expectedSourceFingerprint: p.huella,
            message: `Se congelan ${p.clases} clases de ${p.personas} personas, $${pesos(p.total)}.${
              p.huerfanas > 0 ? ` ${p.huerfanas} reserva(s) de clase sin horario no cuentan para ningún pago.` : ''
            } Lo que cambie después aparecerá como diferencia pendiente.`,
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
    'Pending pay differences of a CLOSED pay-per-service period: classes whose pay changed after closing (corrected head count, substitute coach, cancellation, a class that arrived late). One row per class and person: what corresponds today, what was frozen at closing, what was already settled and what is pending (positive or negative), or the exception that blocks it. Paginated with a cursor; partial=true means some venues were left out for lack of permission. Settle a class with settle_service_pay_difference. Requires staffpay:read.',
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
}
