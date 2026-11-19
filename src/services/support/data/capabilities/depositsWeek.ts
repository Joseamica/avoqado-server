import { fromZonedTime } from 'date-fns-tz'
import { venueWeekBounds } from '@/services/dashboard/settlementCalendar.dashboard.service'
import { getSettlementWeekByGroups, type SettlementWeekByGroups } from '@/services/dashboard/settlementWeekByGroups.service'
import type { DataCapability } from '../catalog'
import { DataReadRefusal } from '../readRefusal'
import { template } from '../check'

/**
 * C6 · «Lo que cae en el banco esta semana»: lo que «Saldo Disponible» del panel estima que cae cada día de la semana en curso (lunes a
 * domingo de la sucursal, `venueWeekBounds` del panel con `scope.day`) por los cobros con tarjeta, y su total: el neto de cada día, con
 * las reglas de depósito de cada cuenta y la comisión con su IVA, como el panel (`getSettlementWeekByGroups`, que lo suma por grupos en
 * la base). Si no puede sumarla al centavo, no da la cifra (DEPOSITS_OVER_CAP). Nunca la cuenta, la CLABE ni la tarjeta. Permiso y
 * candados de la pantalla: `settlements:read`, ADVANCED_REPORTS (Pro) y la verificación aprobada (`KYCProtectedRoute`), sin puesto.
 */

type Week = Extract<SettlementWeekByGroups, { ok: true }>

export const depositsWeek: DataCapability<Record<string, never>, Week> = {
  key: 'deposits_week',
  label: 'lo que cae en el banco esta semana',
  object: 'lo que cae en el banco esta semana',
  aiHint: 'Cuánto se estima que cae en el banco esta semana por los cobros con tarjeta, día por día. Sólo la semana en curso.',
  permissions: ['settlements:read'],
  gate: { featureCode: 'ADVANCED_REPORTS', gateKind: 'FEATURE', refusal: 'PLAN_DEPOSITS' },
  // El panel la abre con la verificación aprobada (o un negocio de prueba); el servidor no lo revisa en su ruta, así que la B lo copia.
  notOffered: scope => (scope.kycVerified ? null : 'DEPOSITS_NEEDS_KYC'),
  params: request => (request.day === 'other' ? { ok: false, refusal: 'DEPOSITS_THIS_WEEK_ONLY' } : { ok: true, value: {} }),
  read: async scope => {
    // Con `scope.day`: sin él, la función lee el reloj del proceso (una sola hora por pregunta, D19)
    const { weekStart, weekEnd } = venueWeekBounds(scope.day, scope.timezone)
    const week = await getSettlementWeekByGroups(scope.venueId, weekStart, weekEnd, scope.timezone, {
      groups: scope.depositGroups,
      timeoutMs: scope.depositTimeoutMs,
    })
    if (!week.ok) throw new DataReadRefusal('OVER_CAP', 'DEPOSITS_OVER_CAP')
    return week
  },
  render: (scope, _params, week) => {
    const t = template(scope.timezone)
    const where = `en ${t.text(scope.venueName)} (corte ${t.time(scope.now)})`
    if (!week.days.length)
      return t.done(`No hay depósitos estimados para esta semana ${where}. Sólo cuenta cobros con tarjeta que procesó Avoqado.`)
    const lines = [`Lo que se estima que cae esta semana ${where}:`]
    // Todos los días en un renglón: el total tiene que cuadrar con lo listado. Cada día, el mediodía de su fecha en la sucursal.
    lines.push(week.days.map(d => `${t.shortDay(fromZonedTime(`${d.date}T12:00:00.000`, scope.timezone))} ${t.money(d.net)}`).join(' · '))
    lines.push(`Total de la semana: ${t.money(week.total.net)}.`)
    lines.push(
      'Son fechas estimadas, no depósitos confirmados por el banco. Sólo cuenta cobros con tarjeta que procesó Avoqado; el efectivo ya está en tu caja.',
    )
    return t.done(lines.join('\n'))
  },
}
