/**
 * Tope de usuarios del Plan Básico (Task 3). Una base de juguete en memoria —sólo el equipo de UNA sucursal, sus
 * invitaciones y los grants del Básico— detrás del `prismaMock` global, para que los números del brief salgan de las
 * funciones reales: los dos lectores del tope, la conciliación que apaga, la que regresa y el barrido diario.
 */
import { StaffRole } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  getVenueBaseTier: jest.fn().mockResolvedValue(null), // sin plan Pro/Premium: el Básico o Gratis deciden
}))

import {
  assertCanAddSeat,
  assertCanAddSeatsBulk,
  getVenueSeatCap,
  lockSeatCap,
  SEAT_CAP_REACHED_CODE,
} from '@/services/access/seatCap.service'
import { activeBasicSeatCaps } from '@/services/launchCampaigns/basicPlanAccess'
import { executeSeatReconciliation, reactivateSeatCapDeactivatedUpTo } from '@/services/dashboard/seatReconciliation.service'
import { endLapsedHybridContracts, restoreBasicSeats, sweepLapsedBasicSeats, SWEEP_MAX_PAGES } from '@/services/launchCampaigns/hybridSeats'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'

const VENUE = 'venue_basico'
const DAY = 24 * 3600 * 1000
const now = () => new Date()

type Seat = {
  id: string
  staffId: string
  venueId: string
  role: StaffRole
  active: boolean
  deactivatedBySeatCap: boolean
  startDate: Date
  endDate: Date | null
  staff: { firstName: string; lastName: string; email: string; lastLoginAt: Date | null }
}
type Grant = { venueId: string; startsAt: Date; endsAt: Date; revokedAt: Date | null; seatCap: number | null | undefined }

let seats: Seat[]
let grants: Grant[]
let exempt: { venue: boolean; org: boolean }
type Invite = { id: string; venueId: string; role: StaffRole; status: string; createdAt: Date }
let invites: Invite[]

function team(active: number, off = 0) {
  seats = []
  for (let i = 0; i < active + off; i++)
    seats.push({
      id: `sv_${String(i).padStart(2, '0')}`,
      staffId: `st_${i}`,
      venueId: VENUE,
      role: i === 0 ? StaffRole.OWNER : StaffRole.WAITER,
      active: i < active,
      deactivatedBySeatCap: i >= active,
      startDate: new Date(2026, 0, 1 + i),
      // Los apagados más recientes tienen el índice más alto.
      endDate: i >= active ? new Date(Date.UTC(2026, 9, 1 + i)) : null,
      staff: { firstName: `P${i}`, lastName: 'X', email: `p${i}@x.mx`, lastLoginAt: new Date(2026, 9, 1 + i) },
    })
}
const covering = (seatCap: number | null | undefined): Grant => ({
  venueId: VENUE,
  startsAt: new Date(Date.now() - 10 * DAY),
  endsAt: new Date(Date.now() + 20 * DAY),
  revokedAt: null,
  seatCap,
})
const lapsed = (seatCap: number | null): Grant => ({
  venueId: VENUE,
  startsAt: new Date(Date.now() - 32 * DAY),
  endsAt: new Date(Date.now() - 2 * DAY),
  revokedAt: null,
  seatCap,
})
const activeCount = () => seats.filter(s => s.active && s.role !== StaffRole.SUPERADMIN).length

function matches(row: Record<string, any>, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(row[key])
      if ('notIn' in cond) return !cond.notIn.includes(row[key])
      if ('not' in cond) return row[key] !== cond.not
      return true
    }
    return row[key] === cond
  })
}
function sortBy<T extends Record<string, any>>(rows: T[], orderBy: any): T[] {
  const keys: Array<[string, 'asc' | 'desc']> = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).map(
    (o: any) => Object.entries(o)[0] as [string, 'asc' | 'desc'],
  )
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = a[k] instanceof Date ? a[k].getTime() : a[k]
      const y = b[k] instanceof Date ? b[k].getTime() : b[k]
      if (x === y) continue
      return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1)
    }
    return 0
  })
}
// La regla de «cubre ahora» que lee activeBasicSeatCaps: revokedAt null, startsAt <= t < endsAt.
const covers = (g: Grant, w: any) => g.revokedAt === null && g.startsAt <= w.startsAt.lte && g.endsAt > w.endsAt.gt

beforeEach(() => {
  exempt = { venue: false, org: false }
  grants = []
  prismaMock.venue.findUnique.mockImplementation(async (a: any) =>
    a.where.id === VENUE
      ? { seatCapExempt: exempt.venue, organization: { seatCapExempt: exempt.org }, pendingSeatReconciliation: null }
      : null,
  )
  prismaMock.venue.findMany.mockImplementation(async (a: any) =>
    a.where.id.in.includes(VENUE) ? [{ id: VENUE, seatCapExempt: exempt.venue, organization: { seatCapExempt: exempt.org } }] : [],
  )
  prismaMock.venueFeature.findMany.mockResolvedValue([])
  prismaMock.staffVenue.count.mockImplementation(async (a: any) => seats.filter(s => matches(s, a.where)).length)
  prismaMock.staffVenue.findMany.mockImplementation(async (a: any) =>
    sortBy(
      seats.filter(s => matches(s, a.where)),
      a.orderBy,
    ).slice(0, a.take ?? Infinity),
  )
  prismaMock.staffVenue.updateMany.mockImplementation(async (a: any) => {
    const hit = seats.filter(s => matches(s, a.where))
    hit.forEach(s => Object.assign(s, a.data))
    return { count: hit.length }
  })
  prismaMock.staffVenue.updateManyAndReturn.mockImplementation(async (a: any) => {
    const hit = seats.filter(s => matches(s, a.where))
    hit.forEach(s => Object.assign(s, a.data))
    return hit.map(s => ({ id: s.id }))
  })
  prismaMock.staffVenue.groupBy.mockImplementation(async (a: any) => {
    const n = seats.filter(s => matches(s, { ...a.where, venueId: VENUE }) && a.where.venueId.in.includes(VENUE)).length
    return n ? [{ venueId: VENUE, _count: { _all: n } }] : []
  })
  invites = []
  // Las invitaciones de juguete honran status, role {not}, id {not}/{notIn} (expiresAt: todas vigentes).
  prismaMock.invitation.count.mockImplementation(async (a: any) => invites.filter(i => matches(i, a.where)).length)
  prismaMock.invitation.groupBy.mockImplementation(async (a: any) => {
    const n = invites.filter(i => matches(i, { ...a.where, venueId: VENUE }) && a.where.venueId.in.includes(VENUE)).length
    return n ? [{ venueId: VENUE, _count: { _all: n } }] : []
  })
  prismaMock.invitation.findMany.mockImplementation(async (a: any) =>
    sortBy(
      invites.filter(i => matches(i, a.where)),
      a.orderBy,
    ).slice(0, a.take ?? Infinity),
  )
  prismaMock.invitation.updateMany.mockImplementation(async (a: any) => {
    const hit = invites.filter(i => matches(i, a.where))
    hit.forEach(i => Object.assign(i, a.data))
    return { count: hit.length }
  })
  prismaMock.activityLog.create.mockResolvedValue({})
  prismaMock.hybridContract.findMany.mockImplementation(async (a: any) => {
    const w = a.where.grants?.some
    if (!w) return [] // otras lecturas de contratos (los vencidos de endLapsedHybridContracts se ponen por prueba)
    return grants
      .filter(g => a.where.venueId.in.includes(g.venueId) && covers(g, w))
      .map(g => ({ venueId: g.venueId, publication: { definition: { kind: 'FEATURES', basicPlan: true, seatCap: g.seatCap } } }))
      .slice(0, a.take)
  })
  prismaMock.capabilityGrant.groupBy.mockImplementation(async (a: any) => {
    const ids = new Set(
      grants
        .filter(g => g.endsAt <= a.where.endsAt.lte && g.endsAt > a.where.endsAt.gt && (!a.where.venueId || g.venueId > a.where.venueId.gt))
        .map(g => g.venueId),
    )
    return [...ids]
      .sort()
      .slice(0, a.take)
      .map(venueId => ({ venueId }))
  })
})

describe('los dos lectores del tope honran un Básico vigente', () => {
  it('Básico sin tope → el 3.er usuario pasa en los dos caminos y vuelven los que apagó Gratis', async () => {
    team(2, 3)
    grants = [covering(null)]
    expect(await getVenueSeatCap(VENUE)).toBeNull()
    await expect(assertCanAddSeat(VENUE)).resolves.toBeUndefined()
    await expect(assertCanAddSeatsBulk([VENUE])).resolves.toBeUndefined()
    expect(await restoreBasicSeats(VENUE)).toBe(3)
    expect(activeCount()).toBe(5)
  })

  it('seatCap:5 con 7 activos → quedan 5 al entregar y el 6.º choca en los dos caminos (los dos dan la misma respuesta)', async () => {
    team(7)
    grants = [covering(5)]
    expect(await getVenueSeatCap(VENUE)).toBe(5)
    await restoreBasicSeats(VENUE)
    expect(activeCount()).toBe(5)
    expect(seats.find(s => s.role === StaffRole.OWNER)!.active).toBe(true)
    await expect(assertCanAddSeat(VENUE)).rejects.toMatchObject({ code: SEAT_CAP_REACHED_CODE })
    await expect(assertCanAddSeatsBulk([VENUE])).rejects.toMatchObject({ code: SEAT_CAP_REACHED_CODE })
    await expect(assertCanAddSeat(VENUE)).rejects.toThrow('Llegaste al límite de 5 usuarios de tu Plan Básico')
  })

  it('con 4 de 5 los dos caminos dejan pasar al 5.º', async () => {
    team(4)
    grants = [covering(5)]
    await expect(assertCanAddSeat(VENUE)).resolves.toBeUndefined()
    await expect(assertCanAddSeatsBulk([VENUE])).resolves.toBeUndefined()
  })

  it('exento por organización sigue exento aunque tenga un Básico con tope', async () => {
    team(7)
    exempt.org = true
    grants = [covering(5)]
    expect(await getVenueSeatCap(VENUE)).toBeNull()
    await restoreBasicSeats(VENUE)
    expect(await executeSeatReconciliation(VENUE)).toBe(0)
    expect(activeCount()).toBe(7)
    await expect(assertCanAddSeat(VENUE)).resolves.toBeUndefined()
    await expect(assertCanAddSeatsBulk([VENUE])).resolves.toBeUndefined()
  })

  it('si dos Básicos cubren (no debería pasar), gana el más permisivo', async () => {
    grants = [covering(3), covering(8)]
    expect((await activeBasicSeatCaps([VENUE], now())).get(VENUE)).toBe(8)
    grants = [covering(3), covering(null)]
    expect((await activeBasicSeatCaps([VENUE], now())).get(VENUE)).toBeNull()
  })

  it('una sola consulta con take acotado, por contrato y con la misma regla de «cubre ahora» que hasCapabilityGrant', async () => {
    const t = now()
    await activeBasicSeatCaps(['a', 'b', 'a'], t)
    expect(prismaMock.hybridContract.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.hybridContract.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          venueId: { in: ['a', 'b'] },
          grants: { some: { revokedAt: null, startsAt: { lte: t }, endsAt: { gt: t } } },
          publication: { definition: { path: ['basicPlan'], equals: true } },
        },
        take: 4,
      }),
    )
    expect(await activeBasicSeatCaps([], t)).toEqual(new Map())
  })
})

describe('el Básico deja de cubrir → vuelve el tope de Gratis', () => {
  it('contrato terminado con 5 → quedan 2 (endLapsedHybridContracts concilia un contrato del Básico)', async () => {
    team(5)
    grants = [{ ...covering(5), endsAt: new Date(Date.now() - 1000) }] // el periodo pagado se acabó con la cancelación
    prismaMock.hybridContract.findMany.mockImplementationOnce(async () => [
      { id: 'c_basico', planTier: null, publication: { definition: { kind: 'FEATURES', basicPlan: true, seatCap: 5 } } },
    ])
    prismaMock.hybridContract.updateMany.mockResolvedValue({ count: 1 })
    await endLapsedHybridContracts(VENUE, 'purchase')
    expect(activeCount()).toBe(2)
  })

  it('grants revocados por devolución → quedan 2', async () => {
    team(5)
    grants = [{ ...covering(5), revokedAt: new Date() }]
    await executeSeatReconciliation(VENUE)
    expect(activeCount()).toBe(2)
  })

  it('renovación past_due pasado el periodo → el barrido deja 2 y el invitador ya choca; Stripe recupera ese pago → vuelven los 5', async () => {
    team(5)
    grants = [lapsed(5)]
    const first = await sweepLapsedBasicSeats(now())
    expect(first).toMatchObject({ checked: 1, failed: 0 })
    expect(activeCount()).toBe(2)
    await expect(assertCanAddSeat(VENUE)).rejects.toMatchObject({ code: SEAT_CAP_REACHED_CODE })
    // Idempotente: otra pasada no cambia nada.
    await sweepLapsedBasicSeats(now())
    expect(activeCount()).toBe(2)
    expect(seats.filter(s => s.deactivatedBySeatCap)).toHaveLength(3)

    grants.push(covering(5)) // la factura recuperada entrega su periodo
    expect(await restoreBasicSeats(VENUE)).toBe(3)
    expect(activeCount()).toBe(5)
  })

  it('el barrido no toca una sucursal que ya renovó su Básico', async () => {
    team(5)
    grants = [lapsed(5), covering(5)]
    expect(await sweepLapsedBasicSeats(now())).toMatchObject({ checked: 1, reconciled: 0 })
    expect(activeCount()).toBe(5)
  })

  it('el barrido lee por páginas de 200 con la lectura de entrada reintentable', async () => {
    team(2)
    await sweepLapsedBasicSeats(now())
    expect(prismaMock.capabilityGrant.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ['venueId'], orderBy: { venueId: 'asc' }, take: 200 }),
    )
  })
})

describe('🔴 el barrido recorre TODAS las páginas en la misma corrida (revisión final #7)', () => {
  // Muchas sucursales con un Básico vencido en la ventana; todas «cubiertas» para no conciliar 20 mil equipos de juguete.
  const sintetico = (total: number) => {
    const ids = Array.from({ length: total }, (_, i) => `v_${String(i).padStart(6, '0')}`)
    prismaMock.capabilityGrant.groupBy.mockImplementation(async (a: any) =>
      ids
        .filter(id => !a.where.venueId || id > a.where.venueId.gt)
        .slice(0, a.take)
        .map(venueId => ({ venueId })),
    )
    prismaMock.hybridContract.findMany.mockImplementation(async (a: any) =>
      a.where.venueId.in.map((venueId: string) => ({ venueId, publication: { definition: { basicPlan: true, seatCap: 3 } } })),
    )
  }

  it('con 2,400 candidatas revisa las 2,400 (antes paraba en 2,000 y la siguiente corrida volvía a empezar)', async () => {
    sintetico(2400)
    const warn = jest.spyOn(logger, 'warn')
    expect(await sweepLapsedBasicSeats(now())).toMatchObject({ checked: 2400 })
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('safety cap'), expect.anything())
  })

  it('si llega al tope de seguridad lo dice con cuántas quedaron (nada se trunca en silencio)', async () => {
    sintetico(200 * SWEEP_MAX_PAGES + 37)
    const warn = jest.spyOn(logger, 'warn')
    expect(await sweepLapsedBasicSeats(now())).toMatchObject({ checked: 200 * SWEEP_MAX_PAGES })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('safety cap'), expect.objectContaining({ remainingVenues: 37 }))
  })
})

describe('volver a cubrir', () => {
  it('D19 (Codex r1 #1): alguien que el dueño ya reactivó con el switch (activo, con la marca del tope) no se lleva un lugar al recuperar', async () => {
    team(2, 7)
    // sv_08 era el apagado más reciente; el dueño lo prendió a mano y conserva la marca del tope.
    Object.assign(seats.find(s => s.id === 'sv_08')!, { active: true })
    grants = [covering(5)]
    expect(await restoreBasicSeats(VENUE)).toBe(2)
    expect(activeCount()).toBe(5)
    expect(seats.filter(s => s.active).map(s => s.id)).toEqual(['sv_00', 'sv_01', 'sv_06', 'sv_07', 'sv_08'])
  })

  it('con seatCap:5 y 7 apagados, recuperar regresa sólo 5, del más reciente al más viejo', async () => {
    team(2, 7)
    grants = [covering(5)]
    expect(await restoreBasicSeats(VENUE)).toBe(3)
    expect(activeCount()).toBe(5)
    // Los tres apagados más recientes (endDate mayor = índices 6, 7, 8) son los que volvieron.
    expect(seats.filter(s => s.active).map(s => s.id)).toEqual(['sv_00', 'sv_01', 'sv_06', 'sv_07', 'sv_08'])
    expect(seats.filter(s => s.deactivatedBySeatCap)).toHaveLength(4)
  })

  describe('🔴 la selección vieja de una baja de Pro no apaga a los del Básico pagado (revisión final #4)', () => {
    let pending: { keepStaffVenueIds: string[] } | null
    beforeEach(() => {
      // El Pro terminó con «se quedan el dueño y sv_01» guardado; su webhook todavía no llega.
      pending = { keepStaffVenueIds: ['sv_00', 'sv_01'] }
      prismaMock.venue.findUnique.mockImplementation(async (a: any) =>
        a.where.id === VENUE ? { seatCapExempt: false, organization: { seatCapExempt: false }, pendingSeatReconciliation: pending } : null,
      )
      prismaMock.venue.update.mockImplementation(async (a: any) => {
        if ('pendingSeatReconciliation' in a.data) pending = a.data.pendingSeatReconciliation
        return {}
      })
    })

    it('entregar el Básico (tope 3) borra la selección y la baja tardía del Pro deja 3, no 2', async () => {
      team(4)
      grants = [covering(3)]
      await restoreBasicSeats(VENUE)
      expect(pending).toBeNull()
      // El tope del Básico recorta por actividad reciente (sv_01 es el menos reciente), no por la selección de la baja.
      expect(seats.filter(s => s.active).map(s => s.id)).toEqual(['sv_00', 'sv_02', 'sv_03'])
      // Llega tarde customer.subscription.deleted del Pro → runSeatReconciliation.
      await executeSeatReconciliation(VENUE)
      expect(seats.filter(s => s.active).map(s => s.id)).toEqual(['sv_00', 'sv_02', 'sv_03'])
    })

    it('un Básico sin tope también borra la selección vieja al entregarse (no queda esperando al siguiente paso a Gratis)', async () => {
      team(2, 2)
      grants = [covering(null)]
      await restoreBasicSeats(VENUE)
      expect(pending).toBeNull()
      expect(activeCount()).toBe(4)
    })

    it('si la selección sigue ahí cuando llega la baja del Pro, con un Básico vigente se usa su tope y no la selección', async () => {
      team(4)
      grants = [covering(3)]
      await executeSeatReconciliation(VENUE)
      expect(activeCount()).toBe(3)
      expect(pending).toBeNull() // se limpia igual: ya se atendió
    })

    it('sin Básico vigente, la selección del dueño sigue mandando (el paso a Gratis de hoy)', async () => {
      team(4)
      await executeSeatReconciliation(VENUE)
      expect(seats.filter(s => s.active).map(s => s.id)).toEqual(['sv_00', 'sv_01'])
    })
  })

  it('🔴 regresar usuarios deja su ActivityLog SEAT_CAP_RESTORED con quiénes, el tope y la razón (revisión final #9)', async () => {
    team(2, 7)
    grants = [covering(5)]
    await restoreBasicSeats(VENUE)
    expect(logAction).toHaveBeenCalledWith({
      venueId: VENUE,
      action: 'SEAT_CAP_RESTORED',
      entity: 'Venue',
      entityId: VENUE,
      data: { restored: ['sv_06', 'sv_07', 'sv_08'], cap: 5, reason: 'BASIC_PLAN' },
    })
    // Un Básico sin tope también lo deja.
    ;(logAction as jest.Mock).mockClear()
    team(2, 2)
    grants = [covering(null)]
    await restoreBasicSeats(VENUE)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SEAT_CAP_RESTORED', data: { restored: ['sv_02', 'sv_03'], cap: null, reason: 'BASIC_PLAN' } }),
    )
  })

  it('sin nadie que regresar no escribe auditoría; si la auditoría falla, la restauración ya quedó', async () => {
    team(5)
    grants = [covering(5)]
    await restoreBasicSeats(VENUE)
    expect(logAction).not.toHaveBeenCalled()
    team(2, 3)
    ;(logAction as jest.Mock).mockRejectedValueOnce(new Error('audit down'))
    await expect(reactivateSeatCapDeactivatedUpTo(VENUE, 5)).resolves.toBe(3)
    expect(activeCount()).toBe(5) // committed before the audit, and the audit never fails the restore
  })

  it('repetir la notificación de una factura vieja sin grant vigente no regresa a nadie', async () => {
    team(2, 3)
    grants = [lapsed(5)]
    expect(await restoreBasicSeats(VENUE)).toBe(0)
    expect(activeCount()).toBe(2)
    expect(prismaMock.staffVenue.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 las invitaciones pendientes ocupan lugar: la renovación no regresa a nadie encima de las invitaciones del dueño', async () => {
    team(2, 7)
    grants = [covering(5)]
    await restoreBasicSeats(VENUE) // 5 activos + 4 apagados
    expect(activeCount()).toBe(5)
    // El dueño da de baja a 2 (bajas reales, no del tope) e invita a 2: 3 activos + 2 pendientes = 5.
    for (const id of ['sv_07', 'sv_08']) Object.assign(seats.find(s => s.id === id)!, { active: false, deactivatedBySeatCap: false })
    for (const id of ['inv_1', 'inv_2']) {
      await assertCanAddSeat(VENUE)
      invites.push({ id, venueId: VENUE, role: StaffRole.WAITER, status: 'PENDING', createdAt: new Date() })
    }
    await expect(assertCanAddSeat(VENUE)).rejects.toMatchObject({ code: SEAT_CAP_REACHED_CODE })

    // Renovación: nadie regresa y nadie pierde su invitación.
    expect(await restoreBasicSeats(VENUE)).toBe(0)
    expect(activeCount()).toBe(3)
    expect(invites.filter(i => i.status === 'PENDING')).toHaveLength(2)
    // Los dos invitados pueden aceptar (el que acepta no se cuenta dos veces).
    await expect(assertCanAddSeat(VENUE, { excludeInvitationId: 'inv_1' })).resolves.toBeUndefined()
    await expect(assertCanAddSeatsBulk([VENUE], { primaryVenueId: VENUE, excludeInvitationId: 'inv_2' })).resolves.toBeUndefined()
  })

  it('reactivateSeatCapDeactivatedUpTo cuenta las invitaciones pendientes y toma el mismo candado de invitaciones', async () => {
    team(2, 3)
    invites.push({ id: 'inv_1', venueId: VENUE, role: StaffRole.WAITER, status: 'PENDING', createdAt: new Date() })
    invites.push({ id: 'inv_sa', venueId: VENUE, role: StaffRole.SUPERADMIN, status: 'PENDING', createdAt: new Date() })
    expect(await reactivateSeatCapDeactivatedUpTo(VENUE, 5)).toBe(2) // 5 − 2 activos − 1 pendiente (soporte no cuenta)
    const locks = prismaMock.$queryRaw.mock.calls.map((c: any[]) => c[0].join('?'))
    expect(locks.some((sql: string) => sql.includes('FROM "Invitation"') && sql.includes('FOR UPDATE'))).toBe(true)
    // 🔴 Revisión final #8: el MISMO candado por negocio que crear y aceptar invitaciones (`lockSeatCap`).
    const advisory = prismaMock.$queryRaw.mock.calls.find((c: any[]) => c[0].join('?').includes('pg_advisory_xact_lock'))
    expect(advisory?.slice(1)).toEqual([[`seat-cap:${VENUE}`]])
  })

  it('lockSeatCap: una sola consulta para todas las sucursales, en orden fijo y sin repetir', async () => {
    await lockSeatCap(prismaMock, ['v_b', 'v_a', 'v_b'])
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    expect(prismaMock.$queryRaw.mock.calls[0].slice(1)).toEqual([['seat-cap:v_a', 'seat-cap:v_b']])
    await lockSeatCap(prismaMock, [])
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('reactivateSeatCapDeactivatedUpTo no pasa del tope ni toca a quien no apagó el tope', async () => {
    team(5, 2)
    seats.push({ ...seats[1], id: 'sv_baja', active: false, deactivatedBySeatCap: false, endDate: new Date() })
    expect(await reactivateSeatCapDeactivatedUpTo(VENUE, 5)).toBe(0)
    expect(await reactivateSeatCapDeactivatedUpTo(VENUE, 6)).toBe(1)
    expect(await reactivateSeatCapDeactivatedUpTo(VENUE, 50)).toBe(1)
    expect(seats.find(s => s.id === 'sv_baja')!.active).toBe(false)
  })
})
