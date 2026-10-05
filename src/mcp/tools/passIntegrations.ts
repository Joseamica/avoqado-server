/**
 * Conector de pases (TotalPass / Wellhub) — función AGGREGATOR_PASSES (Pro).
 *
 * 4 tools: estado de la conexión (read) · check-ins de socios (read) · lugares para pases (read) · cambiar los lugares
 * (WRITE, dos pasos con vista previa actual → nuevo). Nunca devuelven la credencial ni el token del webhook: los servicios
 * ya no los seleccionan. No están en el directorio público (`directory/*`) todavía.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { formatInTimeZone } from 'date-fns-tz'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { getPassIntegrationsOverview } from '@/services/aggregators/passIntegrations.service'
import { listPassVisits, localDayRange } from '@/services/aggregators/passVisits.service'
import {
  deletePassCapRule,
  getPassCapacity,
  getPassCapacityRules,
  getSessionPassCap,
  setDefaultPassCap,
  setSessionPassCap,
  upsertWeeklyPassCap,
} from '@/services/aggregators/passCapacity.service'
import { getVenueTimezone } from '@/services/dashboard/commission/commission-utils'
import { auditMcpWrite } from '../audit'
import { createGuard } from '../guard'
import { planGateMessage } from '../planGate'
import { text } from '../respond'
import type { McpScope } from '../scope'

const FEATURE = 'AGGREGATOR_PASSES'
const CAPABILITY = 'Los pases de TotalPass y Wellhub'
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/
const SESSION_FALLBACK = 'se usa la del día y hora, o la general'
const hhmm = (min: number | null) =>
  min === null ? 'todo el día' : `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const spotsText = (n: number | null) => (n === null ? 'sin tope (todos los lugares libres)' : `${n} lugar(es)`)
const NO_SESSION = 'No encontré esa clase en este negocio. Búscala con list_class_sessions y usa su id.'

// Mensajes de validación en español (zod responde en inglés si no se le dan).
// `what` lleva su artículo en minúscula («el límite», «la hora»): «Falta el límite», «El límite mínimo es 1».
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
// Misma firma que `z.enum` para que conserve los literales («PENDING» | …), no `string`.
const enumOf = <U extends string, T extends Readonly<[U, ...U[]]>>(values: T, what: string) =>
  z.enum(values, { errorMap: () => ({ message: `${cap(what)} debe ser uno de: ${values.join(', ')}` }) })
const intField = (what: string, min: number, max: number) =>
  z
    .number({ required_error: `Falta ${what}`, invalid_type_error: `${cap(what)} debe ser un número` })
    .int(`${cap(what)} debe ser un número entero`)
    .min(min, `${cap(what)} mínimo es ${min}`)
    .max(max, `${cap(what)} máximo es ${max}`)
const textField = (what: string) => z.string({ required_error: `Falta ${what}`, invalid_type_error: `${cap(what)} va como texto` })
const venueIdField = () => textField('el local').describe('Local (debe estar en tu alcance)')
const localDayField = () => z.string({ invalid_type_error: 'La fecha va como AAAA-MM-DD' }).regex(LOCAL_DAY, 'La fecha va como AAAA-MM-DD')

export function registerPassIntegrationTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'aggregator_connection_status',
    'Estado de la conexión del local con TotalPass y Wellhub (pases de socios): si está conectada, la sucursal, el modo de confirmación de asistencia y qué clases están ligadas a qué plan.',
    { venueId: venueIdField() },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('reservations:read', venueId)
      // Sin candado de plan (pausa suave, como el resumen HTTP): quien lo perdió ve `planActive: false` y por qué.
      const o = await getPassIntegrationsOverview(venueId)
      return text({ ok: true, venueId, planActive: o.planActive, connections: o.connections })
    },
  )

  server.tool(
    'list_aggregator_visits',
    'Check-ins de socios de TotalPass o Wellhub en el local: pendientes de confirmar (con su plazo), confirmados, ya confirmados en el portal del proveedor, vencidos y rechazados. Paginado; el filtro de fechas va por días del local.',
    {
      venueId: venueIdField(),
      status: enumOf(['PENDING', 'CONFIRMED', 'ALREADY_CONFIRMED', 'EXPIRED', 'REJECTED'], 'el estado').optional(),
      provider: enumOf(['TOTALPASS', 'WELLHUB'], 'el proveedor').optional(),
      from: localDayField().optional().describe('Desde este día del local, "AAAA-MM-DD"'),
      to: localDayField().optional().describe('Hasta este día del local, "AAAA-MM-DD", incluido completo'),
      limit: intField('el límite', 1, 100).optional(),
      offset: intField('el desplazamiento', 0, Number.MAX_SAFE_INTEGER).optional(),
    },
    async ({ venueId, status, provider, from, to, limit, offset }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('reservations:read', venueId)
      // Sin candado de plan (pausa suave): los check-ins que ya existen se siguen viendo y resolviendo.
      // Las horas de la respuesta van en UTC; la zona del local acompaña para leerlas en hora local.
      const timezone = await getVenueTimezone(venueId)
      const range = localDayRange(from, to, timezone)
      const r = await listPassVisits(venueId, { status, provider, from: range.from, to: range.to, limit, offset })
      return text({ ok: true, venueId, timezone, count: r.items.length, ...r })
    },
  )

  server.tool(
    'aggregator_capacity_rules',
    'Cuántos lugares por clase se ofrecen a socios de TotalPass y Wellhub: el tope general, las excepciones por día y hora, y las sugerencias basadas en cómo se llenan las clases con clientes propios.',
    { venueId: venueIdField() },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('reservations:read', venueId)
      const gate = await planGateMessage(venueId, FEATURE, CAPABILITY)
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      return text({ ok: true, venueId, ...(await getPassCapacity(venueId)) })
    },
  )

  server.tool(
    'set_aggregator_capacity_rule',
    'Cambia cuántos lugares se ofrecen a socios de TotalPass y Wellhub: el tope general (scope DEFAULT), una excepción por día de la semana y hora (WEEKLY, weekday 0=domingo, startTime "HH:mm" u omitido = todo el día) o una sola sesión (SESSION con classSessionId). maxSpots null quita esa regla y vuelve a aplicar la siguiente (sesión → día y hora → general → todos los lugares libres). Primero muestra el cambio (actual → nuevo); se guarda al llamar de nuevo con confirm:true.',
    {
      venueId: venueIdField(),
      scope: enumOf(['DEFAULT', 'WEEKLY', 'SESSION'], 'el alcance'),
      weekday: z
        .number({ invalid_type_error: 'El día va de 0 (domingo) a 6 (sábado)' })
        .int('El día va de 0 (domingo) a 6 (sábado)')
        .min(0, 'El día va de 0 (domingo) a 6 (sábado)')
        .max(6, 'El día va de 0 (domingo) a 6 (sábado)')
        .optional(),
      startTime: textField('la hora')
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'La hora va en formato HH:MM de 24 horas (ej. 09:00).')
        .optional()
        .describe('Hora local de inicio de la clase, "HH:mm"'),
      classSessionId: textField('el id de la clase').optional().describe('id de la clase (de list_class_sessions)'),
      maxSpots: z
        .number({
          required_error: 'Indica los lugares (o null para quitar la regla)',
          invalid_type_error: 'Los lugares deben ser un número (o null para quitar la regla)',
        })
        .int('Los lugares deben ser un número entero')
        .min(0, 'Los lugares van de 0 a 500')
        .max(500, 'Los lugares van de 0 a 500')
        .nullable(),
      confirm: z
        .boolean({ invalid_type_error: 'confirm va como true o false' })
        .optional()
        .describe('true para guardar; sin esto sólo muestra el cambio'),
    },
    async ({ venueId, scope: ruleScope, weekday, startTime, classSessionId, maxSpots, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('reservations:manage-passes', venueId)
      const gate = await planGateMessage(venueId, FEATURE, CAPABILITY)
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      if (ruleScope === 'WEEKLY' && weekday === undefined)
        return text({ ok: false, error: 'Para una excepción por día indica weekday (0=domingo … 6=sábado).' })
      if (ruleScope === 'SESSION' && !classSessionId) return text({ ok: false, error: 'Para una sola sesión indica classSessionId.' })
      // Día y hora sólo cuentan para una excepción semanal: lo que el modelo mande de más en otro scope no se guarda ni se audita.
      const ruleWeekday = ruleScope === 'WEEKLY' ? (weekday as number) : null
      const startMinute = ruleScope === 'WEEKLY' && startTime ? Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3)) : null

      // Sólo las reglas (barato): las sugerencias no hacen falta para mostrar ni guardar un cambio.
      const rules = await getPassCapacityRules(venueId)
      const general = `el tope general (${spotsText(rules.defaultMaxSpots)})`
      const weeklyRule =
        ruleScope === 'WEEKLY' ? rules.weekly.find(w => w.weekday === ruleWeekday && w.startMinute === startMinute) : undefined
      let target: string
      let actual: string
      let nuevo: string
      if (ruleScope === 'DEFAULT') {
        target = 'Tope general'
        if (maxSpots === null && rules.defaultMaxSpots === null)
          return text({ ok: false, error: 'No hay tope general: nada que quitar (ya se ofrecen todos los lugares libres).' })
        actual = spotsText(rules.defaultMaxSpots)
        nuevo = spotsText(maxSpots)
      } else if (ruleScope === 'WEEKLY') {
        target = `${DAYS[ruleWeekday as number]} ${hhmm(startMinute)}`
        if (maxSpots === null && !weeklyRule) return text({ ok: false, error: `No hay excepción para ${target}: nada que quitar.` })
        actual = weeklyRule ? spotsText(weeklyRule.maxSpots) : `sin excepción (se usa ${general})`
        nuevo = maxSpots === null ? `se quita la excepción (se usa ${general})` : spotsText(maxSpots)
      } else {
        // Se busca ANTES de la vista previa: nadie confirma un id opaco ni una clase que no es de este negocio.
        const session = await prisma.classSession.findFirst({
          where: { id: classSessionId as string, venueId },
          select: { startsAt: true, product: { select: { name: true } } },
        })
        if (!session) return text({ ok: false, error: NO_SESSION })
        const tz = await getVenueTimezone(venueId)
        const dow = Number(formatInTimeZone(session.startsAt, tz, 'i')) % 7 // ISO: 7 = domingo
        target = `${session.product.name} · ${DAYS[dow]} ${formatInTimeZone(session.startsAt, tz, 'yyyy-MM-dd HH:mm')}`
        const current = await getSessionPassCap(venueId, classSessionId as string)
        if (maxSpots === null && current === null) return text({ ok: false, error: `${target} no tiene regla propia: nada que quitar.` })
        actual = current === null ? `sin regla propia (${SESSION_FALLBACK})` : spotsText(current)
        nuevo = maxSpots === null ? `se quita la regla propia (${SESSION_FALLBACK})` : spotsText(maxSpots)
      }
      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { regla: target, actual, nuevo },
          instruccion: 'Llama de nuevo con confirm:true para guardar.',
        })
      }
      if (ruleScope === 'DEFAULT') await setDefaultPassCap(venueId, maxSpots, scope.staffId)
      else if (ruleScope === 'WEEKLY') {
        if (maxSpots === null) await deletePassCapRule(venueId, (weeklyRule as { id: string }).id, scope.staffId)
        else await upsertWeeklyPassCap(venueId, { weekday: ruleWeekday as number, startMinute, maxSpots }, scope.staffId)
      } else await setSessionPassCap(venueId, classSessionId as string, maxSpots, scope.staffId)
      await auditMcpWrite(scope, {
        action: 'MCP_PASS_CAPACITY_RULE_SET',
        entity: 'AggregatorCapacityRule',
        entityId: ruleScope === 'SESSION' ? (classSessionId as string) : `${ruleScope}:${ruleWeekday ?? ''}:${startMinute ?? ''}`,
        venueId,
        data: { scope: ruleScope, weekday: ruleWeekday, startMinute, maxSpots, ...(ruleScope === 'SESSION' ? { classSessionId } : {}) },
      })
      return text({ ok: true, regla: target, resultado: nuevo })
    },
  )
}
