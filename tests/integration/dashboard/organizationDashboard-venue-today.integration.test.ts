/**
 * Integration tests: "hoy" del dashboard de organización = día civil del VENUE (REAL PostgreSQL).
 *
 * 2026-09-01. Seis funciones de organizationDashboard.service calculaban "hoy" con
 * `new Date(); setHours(0,0,0,0)` (o `new Date(y, m, 1)`): la medianoche del HOST. En
 * producción (Render, sin TZ ⇒ UTC) "hoy" arrancaba a las 18:00 de AYER hora de México,
 * así que "personal en línea hoy", "top promotor de hoy", "peor asistencia de hoy" y
 * "ventas de hoy por gerente" mezclaban la tarde-noche de ayer. Los dos heatmaps, además,
 * etiquetaban los días con `eachDayOfInterval(new Date('YYYY-MM-DD'))`: bien en un host
 * UTC, corrido un día en un host en México. Misma familia que la regla "A bare
 * YYYY-MM-DD is a RUNTIME-TZ trap" de `.claude/rules/critical-warnings.md`.
 *
 * Todo aquí se siembra RELATIVO a la medianoche del venue (America/Mexico_City, UTC-6
 * fijo) para que el archivo sea válido a cualquier hora y en cualquier día del mes:
 *
 *   hoy     = medianoche del venue + 1 h   → siempre es "hoy" en su zona
 *   anoche  = medianoche del venue − 4 h   → 20:00 de AYER en México = 02:00Z de hoy:
 *                                            un host UTC lo mete en "hoy"; el venue no
 *   tarde   = medianoche del venue + 19 h  → 19:00 de HOY en México = 01:00Z de mañana:
 *                                            en UTC es "mañana"; en el venue sigue siendo hoy
 *
 * Hay DOS relojes que difieren entre local y producción, y los dos se prueban:
 *   · el HOST de Node (local America/Mexico_City, Render UTC)   → `TZ=UTC`
 *   · la SESIÓN de Postgres (local America/Mexico_City, Render UTC) → `?options=-c%20TimeZone%3DUTC`
 *     en la URL (Prisma la honra; `SHOW timezone` devuelve UTC). Los binds (`utcTs`) y los
 *     buckets (`localWallClock`, doble AT TIME ZONE) son independientes de la sesión; esta
 *     corrida lo demuestra en vez de suponerlo.
 *
 * Run with — las cuatro combinaciones (la última es producción exacta):
 *   TEST_DATABASE_URL='postgresql://…/av-db-25-test' \
 *     npx jest --selectProjects integration --testPathPattern organizationDashboard-venue-today
 *   TZ=UTC TEST_DATABASE_URL='postgresql://…/av-db-25-test' \
 *     npx jest --selectProjects integration --testPathPattern organizationDashboard-venue-today
 *   TEST_DATABASE_URL='postgresql://…/av-db-25-test?options=-c%20TimeZone%3DUTC' \
 *     npx jest --selectProjects integration --testPathPattern organizationDashboard-venue-today
 *   TZ=UTC TEST_DATABASE_URL='postgresql://…/av-db-25-test?options=-c%20TimeZone%3DUTC' \
 *     npx jest --selectProjects integration --testPathPattern organizationDashboard-venue-today
 */

import { toZonedTime } from 'date-fns-tz'
import { organizationDashboardService as svc } from '@/services/organization-dashboard/organizationDashboard.service'
import { venueStartOfDay } from '@/utils/datetime'
import prisma from '@/utils/prismaClient'

const TZ = 'America/Mexico_City'
const HORA = 60 * 60 * 1000
const MIN = 60 * 1000
const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
const pad2 = (n: number): string => String(n).padStart(2, '0')
/** yyyy-MM-dd del instante en la zona del venue, sin depender de la zona del host. */
const venueYmd = (d: Date): string => {
  const z = toZonedTime(d, TZ)
  return `${z.getFullYear()}-${pad2(z.getMonth() + 1)}-${pad2(z.getDate())}`
}

const suffix = `od-hoy-${Date.now()}`
const round2 = (n: number): number => Math.round(n * 100) / 100

let orgId: string
let v1: string
let v2: string
let ana: string
let beto: string
let carla: string
let mario: string

const medianoche = venueStartOfDay(TZ)
const hoy = new Date(medianoche.getTime() + 1 * HORA)
const anoche = new Date(medianoche.getTime() - 4 * HORA)
const tarde = new Date(medianoche.getTime() + 19 * HORA)
const min = (base: Date, n: number) => new Date(base.getTime() + n * MIN)

let orderSeq = 0
async function order(venueId: string, createdById: string, createdAt: Date, total: number) {
  orderSeq += 1
  return prisma.order.create({
    data: {
      venueId,
      orderNumber: `OH-${orderSeq}-${suffix}`,
      createdAt,
      createdById,
      type: 'DINE_IN',
      subtotal: total,
      discountAmount: 0,
      taxAmount: 0,
      total,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      items: { create: [{ productName: 'SIM Bait 100', quantity: 1, unitPrice: total, discountAmount: 0, taxAmount: 0, total }] },
    },
    select: { id: true },
  })
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `OrgDashboard hoy ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id

  const mkVenue = (name: string, slug: string) =>
    prisma.venue.create({
      data: { organizationId: orgId, name: `${name} ${suffix}`, slug: `${slug}-${suffix}`, timezone: TZ, status: 'ACTIVE' },
      select: { id: true },
    })
  v1 = (await mkVenue('BAE Norte', 'bae-norte')).id
  v2 = (await mkVenue('BAE Sur', 'bae-sur')).id

  const mkStaff = (first: string, last: string) =>
    prisma.staff.create({
      data: { email: `${first.toLowerCase()}-${suffix}@example.test`, firstName: first, lastName: last },
      select: { id: true },
    })
  ana = (await mkStaff('Ana', 'Promotora')).id
  beto = (await mkStaff('Beto', 'Nocturno')).id
  carla = (await mkStaff('Carla', 'Sur')).id
  mario = (await mkStaff('Mario', 'Gerente')).id
  await prisma.staffOrganization.create({ data: { staffId: mario, organizationId: orgId, role: 'ADMIN' } })
  await prisma.staffVenue.createMany({
    data: [
      { staffId: ana, venueId: v1, role: 'CASHIER' },
      { staffId: beto, venueId: v1, role: 'WAITER' },
      { staffId: carla, venueId: v2, role: 'CASHIER' },
      { staffId: mario, venueId: v1, role: 'MANAGER' },
      { staffId: mario, venueId: v2, role: 'MANAGER' },
    ],
  })

  // Ventas de HOY (venue): Ana 2 en Norte, Carla 1 en Sur.
  await order(v1, ana, min(hoy, 1), 40)
  await order(v1, ana, min(hoy, 2), 25)
  await order(v2, carla, min(hoy, 3), 30)
  // Beto vendió 3 ANOCHE a las 20:00 locales: en un host UTC son "de hoy" y lo harían top.
  await order(v1, beto, min(anoche, 0), 100)
  await order(v1, beto, min(anoche, 1), 100)
  await order(v1, beto, min(anoche, 2), 100)

  await prisma.timeEntry.createMany({
    data: [
      // Ana y Carla checaron hoy y siguen dentro.
      { staffId: ana, venueId: v1, clockInTime: hoy, status: 'CLOCKED_IN' },
      { staffId: carla, venueId: v2, clockInTime: hoy, status: 'CLOCKED_IN' },
      // Beto entró ANOCHE a las 20:00 y no ha salido: no es "personal en línea HOY".
      { staffId: beto, venueId: v1, clockInTime: anoche, status: 'CLOCKED_IN' },
      // Ana, segundo turno de HOY a las 19:00 locales (= 01:00Z de mañana), cerrado.
      { staffId: ana, venueId: v1, clockInTime: tarde, clockOutTime: new Date(tarde.getTime() + 1 * HORA), status: 'CLOCKED_OUT' },
    ],
  })
})

afterAll(async () => {
  const venueIds = [v1, v2].filter(Boolean)
  await prisma.order.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.timeEntry.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.staffVenue.deleteMany({ where: { venueId: { in: venueIds } } })
  await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
  await prisma.staffOrganization.deleteMany({ where: { organizationId: orgId } })
  await prisma.staff.deleteMany({ where: { id: { in: [ana, beto, carla, mario].filter(Boolean) } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('"hoy" = medianoche del venue, no del host', () => {
  it('getOnlineStaff: quien entró anoche a las 20:00 locales no está "en línea hoy"', async () => {
    const online = await svc.getOnlineStaff(orgId)
    expect(online.onlineStaff.map(s => s.staffId).sort()).toEqual([ana, carla].sort())
    expect(online.onlineCount).toBe(2)
    expect(online.totalCount).toBe(3)
    expect(online.percentageOnline).toBe(67)
    expect(online.byVenue.find(v => v.venueId === v1)).toMatchObject({ onlineCount: 1, totalCount: 2 })
    expect(online.byVenue.find(v => v.venueId === v2)).toMatchObject({ onlineCount: 1, totalCount: 1 })
  })

  it('getWorstAttendance: la checada de anoche no cuenta como asistencia de hoy', async () => {
    const worst = (await svc.getWorstAttendance(orgId))!
    // Norte: Ana, Beto y Mario = 3; sólo Ana entró hoy → 33.3 %. Sur: Carla y Mario = 2; Carla entró → 50 %.
    expect(worst.venueId).toBe(v1)
    expect(worst).toMatchObject({ totalStaff: 3, activeStaff: 1, absences: 2, attendanceRate: 33.3 })
  })

  it('getOrgManagers: las ventas de hoy del gerente no incluyen las de anoche', async () => {
    const managers = await svc.getOrgManagers(orgId)
    const m = managers.find(x => x.id === mario)!
    expect(round2(m.todaySales)).toBe(95) // 40 + 25 (Norte) + 30 (Sur); los 300 de anoche NO
    expect(m.activeStores).toBe(2)
    expect(m.storeCount).toBe(2)
  })

  it('getTopPromoter: gana quien más vendió HOY en el venue, no desde las 18:00 de ayer', async () => {
    const top = (await svc.getTopPromoter(orgId))!
    expect(top.staffId).toBe(ana) // 2 hoy; Beto lleva 3 pero de anoche
    expect(top.venueId).toBe(v1)
    expect(top.salesCount).toBe(2)
  })
})

describe('getStaffSalesTrend: el día de la semana es el del venue', () => {
  it('la venta de las 20:00 locales cae en el día de AYER, y las etiquetas son los últimos 7 días del venue', async () => {
    const { salesData } = await svc.getStaffSalesTrend(orgId, beto)
    const hoyDow = toZonedTime(medianoche, TZ).getDay()
    const esperadas = Array.from({ length: 7 }, (_, i) => dayNames[(hoyDow - 6 + i + 7) % 7])
    expect(salesData.map(d => d.day)).toEqual(esperadas)

    const ayer = dayNames[(hoyDow + 6) % 7]
    const hoyNombre = dayNames[hoyDow]
    expect(salesData.find(d => d.day === ayer)!.sales).toBe(300)
    expect(salesData.find(d => d.day === hoyNombre)!.sales).toBe(0)
  })
})

describe('getStaffAttendanceCalendar: el mes y el día son los del venue', () => {
  it('las dos checadas de hoy (01:00 y 19:00 locales) quedan en el día de hoy, con fechas del mes del venue', async () => {
    const { calendar, stats } = await svc.getStaffAttendanceCalendar(orgId, ana)
    const hoyVenue = toZonedTime(medianoche, TZ)
    const diasDelMes = new Date(hoyVenue.getFullYear(), hoyVenue.getMonth() + 1, 0).getDate()
    expect(calendar).toHaveLength(diasDelMes)
    expect(calendar.map(d => d.date)).toEqual(calendar.map(d => `${venueYmd(medianoche).slice(0, 7)}-${pad2(d.day)}`))

    const today = calendar.find(d => d.isToday)!
    expect(today.day).toBe(hoyVenue.getDate())
    expect(today.date).toBe(venueYmd(medianoche))
    expect(today.isPresent).toBe(true)
    expect(today.timeEntries).toHaveLength(2) // la de las 19:00 locales NO es de mañana
    expect(today.isFutureDay).toBe(false)
    expect(calendar.filter(d => d.isFutureDay).map(d => d.day)).toEqual(calendar.filter(d => d.day > hoyVenue.getDate()).map(d => d.day))
    expect(stats.present).toBe(1)
  })

  it('la checada de anoche a las 20:00 locales es de AYER (o de otro mes), nunca de hoy', async () => {
    const { calendar } = await svc.getStaffAttendanceCalendar(orgId, beto)
    const today = calendar.find(d => d.isToday)!
    expect(today.isPresent).toBe(false)

    const ayerFecha = venueYmd(anoche)
    const ayer = calendar.find(d => d.date === ayerFecha)
    if (ayerFecha.slice(0, 7) === venueYmd(medianoche).slice(0, 7)) {
      expect(ayer!.isPresent).toBe(true)
      expect(ayer!.timeEntries).toHaveLength(1)
    } else {
      // Hoy es día 1: ayer pertenece al mes anterior y no aparece en este calendario.
      expect(ayer).toBeUndefined()
      expect(calendar.some(d => d.isPresent)).toBe(false)
    }
  })
})

describe('Heatmaps: las etiquetas de día son exactamente el rango pedido, en cualquier host', () => {
  const RANGO = ['2025-03-10', '2025-03-11', '2025-03-12', '2025-03-13']

  it('asistencia', async () => {
    const { staff, summary } = await svc.getAttendanceHeatmap(orgId, '2025-03-10', '2025-03-13', 'OWNER', mario)
    expect(summary.byDay.map(d => d.date)).toEqual(RANGO)
    expect(staff.length).toBeGreaterThan(0)
    for (const row of staff) expect(row.days.map(d => d.date)).toEqual(RANGO)
  })

  it('ventas', async () => {
    const { staff, summary } = await svc.getSalesHeatmap(orgId, '2025-03-10', '2025-03-13', 'OWNER', mario)
    expect(summary.byDay.map(d => d.date)).toEqual(RANGO)
    expect(staff.length).toBeGreaterThan(0)
    for (const row of staff) expect(row.days.map(d => d.date)).toEqual(RANGO)
    for (const v of summary.byVenue) expect(v.byDay.map(d => d.date)).toEqual(RANGO)
  })
})
