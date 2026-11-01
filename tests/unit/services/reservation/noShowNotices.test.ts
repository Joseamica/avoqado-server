/**
 * D4, Task 4 — avisos durables de «No asistió» (correcciones, revisión del kiosco y resumen por clase).
 *
 * Reglas que se fijan aquí:
 *  - destinatarios: OWNER/ADMIN/MANAGER activos de la sucursal con `reservations:read` EFECTIVO (el resolver de
 *    `checkPermission`); sin EMAIL en su preferencia, sólo campanita;
 *  - el CORREO va primero y la CAMPANITA (sólo IN_APP) después: la campanita es la marca de «ya se mandó». Si el
 *    proveedor falla no hay campanita y se reintenta; `noticeSentAt` sólo cuando todos tienen la suya;
 *  - el resumen sale cuando la clase pasó su corte hace ≥ 5 min y no le quedan PENDING/CONFIRMED, con las NO_SHOW que
 *    siguen así, una vez por (destinatario, clase).
 */
import { NotificationChannel, NotificationType, OrgRole, StaffRole } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { verifyUnsubscribeToken } from '@/utils/unsubscribeToken'
import { FRONTEND_URL } from '@/config/env'
import logger from '@/config/logger'

const mockEmail = jest.fn()
jest.mock('@/services/resend.service', () => ({ sendNotificationEmail: (...a: unknown[]) => mockEmail(...a) }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn().mockReturnValue(null) } }))
const mockSettings = jest.fn()
jest.mock('@/services/dashboard/reservationSettings.service', () => ({ getReservationSettings: (...a: unknown[]) => mockSettings(...a) }))

import {
  afterNoShowCorrection,
  flushPendingCorrectionNotices,
  notifyNoShowNeedsReview,
  sendClassNoShowSummaries,
} from '@/services/reservation/noShowNotices.service'

const P = prismaMock
const MODELOS = [
  P.reservationNoShowCorrection,
  P.staffVenue,
  P.staffOrganization,
  P.venueRolePermission,
  P.notificationPreference,
  P.notification,
  P.classSession,
  P.reservation,
  P.activityLog,
]

const DUENA = { staffId: 's-duena', role: StaffRole.OWNER, permissionSet: null, staff: { email: 'ana.duena@gmail.com' } }
const GERENTE = { staffId: 's-gerente', role: StaffRole.MANAGER, permissionSet: null, staff: { email: 'luis.gerente@gmail.com' } }
const VENUE = { name: 'Mindform', slug: 'mindform', timezone: 'America/Mexico_City' }

// 16:00Z = 10:00 en Ciudad de México.
const reserva = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  venueId: 'v1',
  startsAt: new Date('2026-10-28T16:00:00Z'),
  checkedInAt: new Date('2026-10-28T16:07:00Z'),
  guestName: null,
  customer: { firstName: 'Ana', lastName: 'gómez' },
  product: { name: 'Yoga' },
  classSession: { startsAt: new Date('2026-10-28T16:00:00Z'), product: { name: 'Yoga' } },
  venue: VENUE,
  ...over,
})
const correccion = (over: Record<string, unknown> = {}) => ({
  id: 'corr1',
  venueId: 'v1',
  reservationId: 'r1',
  source: 'DASHBOARD',
  pending: ['CLASS_UNPAID'],
  noticeSentAt: null,
  resolvedAt: null,
  reservation: reserva(),
  ...over,
})

/** La tabla de campanitas como la vería la base: filtra por `entityId` (uno o `in`) y por `recipientId` (`in`). */
const campanitasEnBase = (filas: Array<{ entityId: string; recipientId: string }>) =>
  P.notification.findMany.mockImplementation(async ({ where }: any) =>
    filas.filter(
      f =>
        (typeof where.entityId === 'string' ? f.entityId === where.entityId : where.entityId.in.includes(f.entityId)) &&
        (!where.recipientId || where.recipientId.in.includes(f.recipientId)),
    ),
  )

const emailsA = () => mockEmail.mock.calls.map(c => c[0])
const campanitas = () => P.notification.create.mock.calls.map((c: any) => c[0].data)

beforeEach(() => {
  for (const m of MODELOS) for (const fn of Object.values(m)) (fn as jest.Mock).mockReset()
  mockEmail.mockReset().mockResolvedValue(true)
  mockSettings.mockReset().mockResolvedValue({ scheduling: { noShowGraceMin: 15 } })
  process.env.RESEND_API_KEY = 're_test'
  P.staffVenue.findMany.mockResolvedValue([DUENA, GERENTE])
  P.staffOrganization.findMany.mockResolvedValue([])
  P.venueRolePermission.findUnique.mockResolvedValue(null)
  P.notificationPreference.findMany.mockResolvedValue([])
  P.notification.findMany.mockResolvedValue([])
  P.notification.create.mockImplementation(async ({ data }: any) => ({ id: `n-${data.recipientId}`, isRead: false, ...data }))
  P.reservationNoShowCorrection.updateMany.mockResolvedValue({ count: 1 })
  P.activityLog.groupBy.mockResolvedValue([])
  P.activityLog.create.mockResolvedValue({})
})

/** Corre `p` con el reloj falso hasta que termine (los reintentos del correo esperan segundos de verdad). */
const conReloj = async <T>(p: Promise<T>): Promise<T> => {
  let fin = false
  void p.then(() => (fin = true))
  while (!fin) await jest.advanceTimersByTimeAsync(500)
  return p
}
afterAll(() => {
  delete process.env.RESEND_API_KEY
})

describe('afterNoShowCorrection — a quién y por dónde', () => {
  it('busca OWNER/ADMIN/MANAGER activos de ESA sucursal (personas activas) y con tope', async () => {
    P.reservationNoShowCorrection.findUnique.mockResolvedValue(correccion())

    await afterNoShowCorrection('corr1')

    const args = P.staffVenue.findMany.mock.calls[0][0]
    expect(args.where).toEqual({
      venueId: 'v1',
      active: true,
      role: { in: [StaffRole.OWNER, StaffRole.ADMIN, StaffRole.MANAGER] },
      staff: { active: true },
    })
    expect(args.take).toBeGreaterThan(0)
    expect(emailsA()).toEqual(['ana.duena@gmail.com', 'luis.gerente@gmail.com'])
  })

  it('un gerente cuyo Conjunto de Permisos no trae reservations:read no recibe nada', async () => {
    P.reservationNoShowCorrection.findUnique.mockResolvedValue(correccion())
    P.staffVenue.findMany.mockResolvedValue([DUENA, { ...GERENTE, permissionSet: { permissions: ['orders:read'] } }])

    await afterNoShowCorrection('corr1')

    expect(emailsA()).toEqual(['ana.duena@gmail.com'])
    expect(campanitas().map((d: any) => d.recipientId)).toEqual(['s-duena'])
  })

  it('un MANAGER al que el negocio le quitó las reservaciones (rol personalizado) no recibe nada', async () => {
    // Negar sólo `reservations:read` no basta: lo vuelven a dar los permisos que lo implican (`reservations:update`,
    // `staffpay:read`…) — regla de `getEffectiveRolePermissions`. Se quitan todos, como lo haría la pantalla de roles.
    P.reservationNoShowCorrection.findUnique.mockResolvedValue(correccion())
    P.venueRolePermission.findUnique.mockImplementation(async ({ where }: any) =>
      where.venueId_role.role === StaffRole.MANAGER
        ? {
            permissions: [],
            deniedPermissions: [
              'reservations:read',
              'reservations:create',
              'reservations:update',
              'reservations:cancel',
              'reservations:manage-passes',
              'staffpay:read',
              'staffpay:manage',
            ],
          }
        : null,
    )

    await afterNoShowCorrection('corr1')

    expect(campanitas().map((d: any) => d.recipientId)).toEqual(['s-duena'])
  })

  describe('🔴 Codex r4 #2: el DUEÑO DE LA ORGANIZACIÓN también se entera (opera como OWNER, igual que `checkPermission`)', () => {
    type Dueno = { staffId: string; email: string; isActive?: boolean; fila?: Record<string, unknown> | null }
    /** Las membresías como las vería la base: filtra con el `where` que manda el servicio; `fila` = su StaffVenue en v1. */
    const duenosEnBase = (duenos: Dueno[]) =>
      P.staffOrganization.findMany.mockImplementation(async ({ where }: any) =>
        duenos
          .filter(
            d =>
              where.role === OrgRole.OWNER &&
              where.isActive === (d.isActive ?? true) &&
              where.staff?.active === true &&
              where.organization?.venues?.some?.id === 'v1',
          )
          .map(d => ({ staffId: d.staffId, staff: { email: d.email, venues: d.fila ? [d.fila] : [] } })),
      )
    const quienes = () => campanitas().map((d: any) => d.recipientId)
    const sinReservaciones = {
      permissions: [],
      deniedPermissions: [
        'reservations:read',
        'reservations:create',
        'reservations:update',
        'reservations:cancel',
        'reservations:manage-passes',
        'staffpay:read',
        'staffpay:manage',
      ],
    }

    beforeEach(() => P.reservationNoShowCorrection.findUnique.mockResolvedValue(correccion()))

    it('dueño de la organización SIN fila en la sucursal ⇒ recibe correo y campanita (consulta acotada)', async () => {
      P.staffVenue.findMany.mockResolvedValue([GERENTE])
      duenosEnBase([{ staffId: 's-org', email: 'carla.org@gmail.com' }])

      await afterNoShowCorrection('corr1')

      expect(emailsA()).toEqual(['luis.gerente@gmail.com', 'carla.org@gmail.com'])
      expect(quienes()).toEqual(['s-gerente', 's-org'])
      expect(P.staffOrganization.findMany.mock.calls[0][0].take).toBeGreaterThan(0)
    })

    it('dueño de la organización con fila CASHIER ⇒ recibe como OWNER (lo que el negocio le quitó al cajero no cuenta)', async () => {
      P.staffVenue.findMany.mockResolvedValue([])
      duenosEnBase([
        { staffId: 's-org', email: 'carla.org@gmail.com', fila: { role: StaffRole.CASHIER, active: true, permissionSet: null } },
      ])
      P.venueRolePermission.findUnique.mockImplementation(async ({ where }: any) =>
        where.venueId_role.role === StaffRole.CASHIER ? sinReservaciones : null,
      )

      await afterNoShowCorrection('corr1')

      expect(quienes()).toEqual(['s-org'])
      expect(P.venueRolePermission.findUnique.mock.calls.map((c: any) => c[0].where.venueId_role.role)).toEqual([StaffRole.OWNER])
    })

    it('a un dueño de la organización le aplica lo que el negocio le quitó al OWNER y el Conjunto de Permisos de su fila', async () => {
      P.staffVenue.findMany.mockResolvedValue([])
      duenosEnBase([
        { staffId: 's-org-a', email: 'a@gmail.com' },
        {
          staffId: 's-org-b',
          email: 'b@gmail.com',
          fila: { role: StaffRole.WAITER, active: false, permissionSet: { permissions: ['orders:read'] } },
        },
      ])

      await afterNoShowCorrection('corr1')
      expect(quienes()).toEqual(['s-org-a']) // el Conjunto de Permisos de su fila (aunque esté apagada) manda

      // Al OWNER también hay que quitarle `staffpay:close`, que implica `reservations:read`.
      P.notification.create.mockClear()
      P.venueRolePermission.findUnique.mockImplementation(async ({ where }: any) =>
        where.venueId_role.role === StaffRole.OWNER
          ? { ...sinReservaciones, deniedPermissions: [...sinReservaciones.deniedPermissions, 'staffpay:close'] }
          : null,
      )
      await afterNoShowCorrection('corr1')
      expect(quienes()).toEqual([])
    })

    it('dueño de la organización INACTIVO ⇒ no recibe', async () => {
      P.staffVenue.findMany.mockResolvedValue([GERENTE])
      duenosEnBase([{ staffId: 's-org', email: 'carla.org@gmail.com', isActive: false }])

      await afterNoShowCorrection('corr1')

      expect(emailsA()).toEqual(['luis.gerente@gmail.com'])
      expect(quienes()).toEqual(['s-gerente'])
    })

    it('dueña con fila OWNER y además dueña de la organización ⇒ una sola vez', async () => {
      duenosEnBase([
        { staffId: 's-duena', email: 'ana.duena@gmail.com', fila: { role: StaffRole.OWNER, active: true, permissionSet: null } },
      ])

      await afterNoShowCorrection('corr1')

      expect(emailsA()).toEqual(['ana.duena@gmail.com', 'luis.gerente@gmail.com'])
      expect(quienes()).toEqual(['s-duena', 's-gerente'])
    })
  })

  it('sin EMAIL en su preferencia ⇒ sólo campanita; con el aviso apagado ⇒ nada', async () => {
    P.reservationNoShowCorrection.findUnique.mockResolvedValue(correccion())
    P.notificationPreference.findMany.mockResolvedValue([
      { staffId: 's-duena', enabled: true, channels: [NotificationChannel.IN_APP] },
      { staffId: 's-gerente', enabled: false, channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL] },
    ])

    await afterNoShowCorrection('corr1')

    expect(mockEmail).not.toHaveBeenCalled()
    expect(campanitas().map((d: any) => d.recipientId)).toEqual(['s-duena'])
    expect(P.notificationPreference.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ venueId: 'v1', type: NotificationType.RESERVATION_NEEDS_REVIEW }),
    )
    expect(P.reservationNoShowCorrection.updateMany).toHaveBeenCalled()
  })

  it('el correo trae la baja en un clic con token RESERVATIONS de ESA persona y ESA sucursal, y liga a la reserva', async () => {
    P.reservationNoShowCorrection.findUnique.mockResolvedValue(correccion())

    await afterNoShowCorrection('corr1')

    const [to, subject, title, message, actionUrl, actionLabel, opts] = mockEmail.mock.calls[0]
    expect(to).toBe('ana.duena@gmail.com')
    expect(subject).toContain('Mindform')
    expect(title).toBe('Ana G. sí llegó a Yoga de las 10:00: falta resolver algo')
    expect(message).toContain('Esta clase no estaba pagada: cóbrala en caja')
    expect(actionUrl).toBe(`${FRONTEND_URL}/venues/mindform/reservations/r1`)
    expect(actionLabel).toBe('Ver reserva')
    const token = new URL(opts.unsubscribeUrl).searchParams.get('token')
    expect(new URL(opts.unsubscribeUrl).pathname).toBe('/api/v1/public/unsubscribe')
    expect(verifyUnsubscribeToken(token)).toEqual({ staffId: 's-duena', venueId: 'v1', category: 'RESERVATIONS' })
  })

  it('la campanita va SÓLO por IN_APP, con liga relativa a la reserva, y después del correo', async () => {
    P.reservationNoShowCorrection.findUnique.mockResolvedValue(correccion())

    await afterNoShowCorrection('corr1')

    expect(campanitas()[0]).toEqual(
      expect.objectContaining({
        recipientId: 's-duena',
        venueId: 'v1',
        type: NotificationType.RESERVATION_NEEDS_REVIEW,
        channels: [NotificationChannel.IN_APP],
        entityType: 'ReservationNoShowCorrection',
        entityId: 'corr1',
        actionUrl: 'reservations/r1',
      }),
    )
    expect(mockEmail.mock.invocationCallOrder[0]).toBeLessThan(P.notification.create.mock.invocationCallOrder[0])
  })

  it('marca noticeSentAt con CAS y una segunda llamada no reenvía', async () => {
    P.reservationNoShowCorrection.findUnique.mockResolvedValueOnce(correccion())
    await afterNoShowCorrection('corr1')
    expect(P.reservationNoShowCorrection.updateMany).toHaveBeenCalledWith({
      where: { id: 'corr1', noticeSentAt: null },
      data: { noticeSentAt: expect.any(Date) },
    })

    mockEmail.mockClear()
    P.notification.create.mockClear()
    P.reservationNoShowCorrection.findUnique.mockResolvedValueOnce(correccion({ noticeSentAt: new Date() }))
    await afterNoShowCorrection('corr1')
    expect(mockEmail).not.toHaveBeenCalled()
    expect(P.notification.create).not.toHaveBeenCalled()
  })

  it('una corrección a mano SIN pendientes no avisa a nadie, pero queda marcada para que el barrido no la tome', async () => {
    P.reservationNoShowCorrection.findUnique.mockResolvedValue(correccion({ pending: [] }))

    await afterNoShowCorrection('corr1')

    expect(mockEmail).not.toHaveBeenCalled()
    expect(P.notification.create).not.toHaveBeenCalled()
    expect(P.reservationNoShowCorrection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'corr1', noticeSentAt: null } }),
    )
  })

  it('una corrección del KIOSCO siempre se avisa, aunque no deje pendientes', async () => {
    P.reservationNoShowCorrection.findUnique.mockResolvedValue(correccion({ source: 'KIOSK', pending: [] }))

    await afterNoShowCorrection('corr1')

    expect(mockEmail.mock.calls[0][2]).toBe('Se corrigió sola por el kiosco: Ana G. llegó a las 10:07 a Yoga')
    expect(campanitas()[0].title).toBe('Se corrigió sola por el kiosco: Ana G. llegó a las 10:07 a Yoga')
  })

  it('falla del proveedor ⇒ sin campanita para esa persona y SIN noticeSentAt (el barrido reintenta)', async () => {
    P.reservationNoShowCorrection.findUnique.mockResolvedValue(correccion())
    mockEmail.mockImplementation(async (to: string) => to !== 'luis.gerente@gmail.com')

    await afterNoShowCorrection('corr1')

    expect(campanitas().map((d: any) => d.recipientId)).toEqual(['s-duena'])
    expect(P.reservationNoShowCorrection.updateMany).not.toHaveBeenCalled()
  })

  it('quien ya tiene su campanita no recibe otro correo ni otra campanita', async () => {
    P.reservationNoShowCorrection.findUnique.mockResolvedValue(correccion())
    P.notification.findMany.mockResolvedValue([{ recipientId: 's-duena' }])

    await afterNoShowCorrection('corr1')

    expect(emailsA()).toEqual(['luis.gerente@gmail.com'])
    expect(campanitas().map((d: any) => d.recipientId)).toEqual(['s-gerente'])
    expect(P.notification.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        type: NotificationType.RESERVATION_NEEDS_REVIEW,
        entityType: 'ReservationNoShowCorrection',
        entityId: 'corr1',
      }),
    )
    expect(P.reservationNoShowCorrection.updateMany).toHaveBeenCalled()
  })

  it('un nombre con etiquetas no se cuela como HTML en el correo (la campanita lo guarda tal cual)', async () => {
    P.reservationNoShowCorrection.findUnique.mockResolvedValue(
      correccion({ reservation: reserva({ customer: null, guestName: '<a href=x>Pirata</a> Uno' }) }),
    )

    await afterNoShowCorrection('corr1')

    expect(mockEmail.mock.calls[0][2]).not.toMatch(/[<>]/)
  })

  it('nunca lanza: si la base falla, lo deja para el barrido', async () => {
    P.reservationNoShowCorrection.findUnique.mockRejectedValue(new Error('P1001'))
    await expect(afterNoShowCorrection('corr1')).resolves.toBeUndefined()
  })

  it('nunca lanza, tampoco si lo que se lanza no es un Error (null): se llama sin await', async () => {
    P.reservationNoShowCorrection.findUnique.mockRejectedValue(null)
    await expect(afterNoShowCorrection('corr1')).resolves.toBeUndefined()
  })
})

describe('flushPendingCorrectionNotices', () => {
  it('toma las que siguen con noticeSentAt null (con ventana y tope) y las avisa', async () => {
    const now = new Date('2026-10-28T17:00:00Z')
    P.reservationNoShowCorrection.findMany.mockResolvedValue([{ id: 'corr1' }, { id: 'corr2' }])
    P.reservationNoShowCorrection.findUnique.mockImplementation(async ({ where }: any) => correccion({ id: where.id }))

    const n = await flushPendingCorrectionNotices(now)

    expect(n).toBe(2)
    const args = P.reservationNoShowCorrection.findMany.mock.calls[0][0]
    expect(args.where.noticeSentAt).toBeNull()
    // No pisa a `afterNoShowCorrection`, que corre justo al corregir.
    expect(args.where.createdAt.lte.getTime()).toBeLessThan(now.getTime())
    expect(args.take).toBeGreaterThan(0)
    // Se LEEN de la más nueva a la más vieja (que una cola de reintentos no tape a las nuevas).
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
    expect(campanitas().map((d: any) => d.entityId)).toEqual(['corr1', 'corr1', 'corr2', 'corr2'])
  })

  it('una corrección que lanza algo que no es un Error (null) no corta el barrido', async () => {
    P.reservationNoShowCorrection.findMany.mockResolvedValue([{ id: 'corr-rota' }, { id: 'corr2' }])
    P.reservationNoShowCorrection.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === 'corr-rota') throw null
      return correccion({ id: where.id })
    })

    await expect(flushPendingCorrectionNotices(new Date('2026-10-28T17:00:00Z'))).resolves.toBe(1)
  })

  it('20 correcciones que reintentan a un correo que siempre falla no tapan a una nueva: va primero en el mismo tick', async () => {
    const now = new Date('2026-10-28T17:00:00Z')
    const viejas = Array.from({ length: 20 }, (_, i) => `corr-vieja-${String(i).padStart(2, '0')}`)
    // La base las devuelve de la más nueva a la más vieja.
    P.reservationNoShowCorrection.findMany.mockResolvedValue([{ id: 'corr-nueva' }, ...[...viejas].reverse().map(id => ({ id }))])
    P.reservationNoShowCorrection.findUnique.mockImplementation(async ({ where }: any) => correccion({ id: where.id }))
    // La dueña ya tiene la suya en todas las viejas; el correo del gerente siempre falla.
    campanitasEnBase(viejas.map(id => ({ entityId: id, recipientId: 's-duena' })))
    mockEmail.mockImplementation(async (to: string) => to !== 'luis.gerente@gmail.com')

    await flushPendingCorrectionNotices(now)

    const atendidas = P.reservationNoShowCorrection.findUnique.mock.calls.map((c: any) => c[0].where.id)
    expect(atendidas.length).toBeLessThanOrEqual(20)
    expect(atendidas[0]).toBe('corr-nueva')
    expect(campanitas()).toEqual([expect.objectContaining({ entityId: 'corr-nueva', recipientId: 's-duena' })])
    // Los reintentos van de la más vieja a la más nueva.
    expect(atendidas.slice(1, 3)).toEqual(['corr-vieja-00', 'corr-vieja-01'])
  })
})

describe('notifyNoShowNeedsReview', () => {
  it('avisa con el texto de la razón y deduplica por reserva', async () => {
    P.reservation.findFirst.mockResolvedValue(reserva())
    P.notification.findMany.mockResolvedValue([{ recipientId: 's-gerente' }])

    await notifyNoShowNeedsReview({ venueId: 'v1', reservationId: 'r1', reason: 'KIOSK_TOO_OLD' })

    expect(P.reservation.findFirst.mock.calls[0][0].where).toEqual({ id: 'r1', venueId: 'v1' })
    expect(emailsA()).toEqual(['ana.duena@gmail.com'])
    expect(mockEmail.mock.calls[0][3]).toContain('Llegada del kiosco de hace más de 3 días: revisa si sí llegó')
    expect(campanitas()[0]).toEqual(
      expect.objectContaining({
        type: NotificationType.RESERVATION_NEEDS_REVIEW,
        entityType: 'Reservation',
        entityId: 'r1',
        actionUrl: 'reservations/r1',
        channels: [NotificationChannel.IN_APP],
      }),
    )
  })

  it('nunca lanza', async () => {
    P.reservation.findFirst.mockRejectedValue(new Error('boom'))
    await expect(notifyNoShowNeedsReview({ venueId: 'v1', reservationId: 'r1', reason: 'KIOSK_UNVERIFIED' })).resolves.toBeUndefined()
  })

  it('nunca lanza, tampoco con algo que no es un Error (undefined)', async () => {
    P.reservation.findFirst.mockRejectedValue(undefined)
    await expect(notifyNoShowNeedsReview({ venueId: 'v1', reservationId: 'r1', reason: 'KIOSK_UNVERIFIED' })).resolves.toBeUndefined()
  })

  describe('🔴 Codex r3 #2: un fallo pasajero del correo no pierde el aviso (no hay barrido que lo reintente)', () => {
    beforeEach(() => {
      jest.useFakeTimers()
      P.reservation.findFirst.mockResolvedValue(reserva())
      P.staffVenue.findMany.mockResolvedValue([DUENA])
    })
    afterEach(() => jest.useRealTimers())
    const avisar = () => notifyNoShowNeedsReview({ venueId: 'v1', reservationId: 'r1', reason: 'KIOSK_TOO_OLD' })

    it('falla 2 veces y a la 3.ª sale ⇒ un solo correo entregado y una campanita, después del correo bueno', async () => {
      mockEmail.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true)

      await conReloj(avisar())

      expect(emailsA()).toEqual(['ana.duena@gmail.com', 'ana.duena@gmail.com', 'ana.duena@gmail.com'])
      expect(campanitas().map((d: any) => d.recipientId)).toEqual(['s-duena'])
      expect(mockEmail.mock.invocationCallOrder[2]).toBeLessThan(P.notification.create.mock.invocationCallOrder[0])
      expect(logger.error).not.toHaveBeenCalled()
    })

    it('falla las 3 veces ⇒ igual deja la campanita (el gerente lo ve) y un error con la reserva y el motivo', async () => {
      mockEmail.mockResolvedValue(false)

      await conReloj(avisar())

      expect(mockEmail).toHaveBeenCalledTimes(3)
      expect(campanitas().map((d: any) => d.recipientId)).toEqual(['s-duena'])
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('[no-show-notices]'),
        expect.objectContaining({ reservationId: 'r1', reason: 'KIOSK_TOO_OLD' }),
      )
    })

    it('con el proveedor caído y varios destinatarios, los reintentos paran a los ~15 s y todos quedan con su campanita', async () => {
      const seis = Array.from({ length: 6 }, (_, i) => ({ ...DUENA, staffId: `s-${i}`, staff: { email: `persona${i}@gmail.com` } }))
      P.staffVenue.findMany.mockResolvedValue(seis)
      mockEmail.mockResolvedValue(false)
      const inicio = Date.now()

      await conReloj(avisar())

      expect(campanitas()).toHaveLength(6)
      expect(mockEmail.mock.calls.length).toBeGreaterThan(6) // sí reintentó
      expect(mockEmail.mock.calls.length).toBeLessThan(18) // pero no 3 por persona
      expect(Date.now() - inicio).toBeLessThan(25_000)
    })

    it('un toque repetido mientras el correo se reintenta no manda un segundo aviso', async () => {
      mockEmail.mockResolvedValueOnce(false).mockResolvedValue(true)

      await conReloj(Promise.all([avisar(), avisar()]))

      expect(campanitas()).toHaveLength(1)
      expect(mockEmail).toHaveBeenCalledTimes(2)
    })
  })
})

describe('sendClassNoShowSummaries', () => {
  const now = new Date('2026-10-28T17:00:00Z') // 11:00 CDMX
  const clase = (id: string, startsAt: string) => ({
    id,
    venueId: 'v1',
    startsAt: new Date(startsAt),
    product: { name: 'Yoga' },
    venue: { ...VENUE, organizationId: 'org1' },
  })

  it('sólo clases cuyo corte (inicio + tolerancia) pasó hace ≥ 5 min y sin PENDING/CONFIRMED, con las NO_SHOW que siguen así', async () => {
    P.classSession.findMany.mockResolvedValue([
      clase('cs-lista', '2026-10-28T16:00:00Z'), // corte 16:15 ≤ 16:55
      clase('cs-temprana', '2026-10-28T16:45:00Z'), // corte 17:00 > 16:55: la falta se marcó a mano antes del corte
    ])
    P.reservation.findMany.mockResolvedValue([
      { id: 'r1', classSessionId: 'cs-lista', guestName: null, customer: { firstName: 'Ana', lastName: 'Gómez' } },
      { id: 'r2', classSessionId: 'cs-lista', guestName: 'Beto Ruiz', customer: null },
    ])

    const n = await sendClassNoShowSummaries(now)

    expect(n).toBe(1)
    const where = P.classSession.findMany.mock.calls[0][0].where
    expect(where.reservations).toEqual({
      some: { status: 'NO_SHOW' },
      none: { status: { in: ['PENDING', 'CONFIRMED'] } },
    })
    expect(where.startsAt.lte.getTime()).toBeLessThanOrEqual(now.getTime() - 5 * 60_000)
    expect(P.classSession.findMany.mock.calls[0][0].take).toBeGreaterThan(0)

    // Las faltas se leen POR CLASE (una clase con muchas no tapa a las demás), con tope por correo.
    const rWhere = P.reservation.findMany.mock.calls[0][0].where
    expect(rWhere).toEqual({ classSessionId: 'cs-lista', status: 'NO_SHOW' })
    expect(P.reservation.findMany.mock.calls[0][0].take).toBe(100)
    expect(P.reservation.count).not.toHaveBeenCalled() // la lista no llegó al tope: ya es el total

    const [to, , title, message, , , opts] = mockEmail.mock.calls[0]
    expect(to).toBe('ana.duena@gmail.com')
    expect(title).toBe('2 personas no asistieron a Yoga de las 10:00')
    // Una liga por persona.
    expect(message).toContain(`Ana G.: ${FRONTEND_URL}/venues/mindform/reservations/r1`)
    expect(message).toContain(`Beto R.: ${FRONTEND_URL}/venues/mindform/reservations/r2`)
    expect(verifyUnsubscribeToken(new URL(opts.unsubscribeUrl).searchParams.get('token'))?.category).toBe('RESERVATIONS')

    expect(campanitas().map((d: any) => [d.recipientId, d.entityType, d.entityId, d.type])).toEqual([
      ['s-duena', 'ClassSession', 'cs-lista', NotificationType.RESERVATION_NO_SHOW_SUMMARY],
      ['s-gerente', 'ClassSession', 'cs-lista', NotificationType.RESERVATION_NO_SHOW_SUMMARY],
    ])
    expect(campanitas()[0].channels).toEqual([NotificationChannel.IN_APP])
    // Sin punto doble tras «Beto R.».
    expect(campanitas()[0].message).toBe('Ana G., Beto R. Si alguien sí llegó, abre su reserva y toca «Sí llegó».')
  })

  it('una sola persona: la campanita lleva a su reserva', async () => {
    P.classSession.findMany.mockResolvedValue([clase('cs-1', '2026-10-28T16:00:00Z')])
    P.reservation.findMany.mockResolvedValue([
      { id: 'r1', classSessionId: 'cs-1', guestName: null, customer: { firstName: 'Ana', lastName: 'Gómez' } },
    ])

    await sendClassNoShowSummaries(now)

    expect(mockEmail.mock.calls[0][2]).toBe('Ana G. no asistió a Yoga de las 10:00')
    expect(campanitas()[0].actionUrl).toBe('reservations/r1')
  })

  it('dedupe por (destinatario, clase): quien ya tiene la campanita de esa clase no recibe otra', async () => {
    P.classSession.findMany.mockResolvedValue([clase('cs-1', '2026-10-28T16:00:00Z')])
    P.notification.findMany.mockResolvedValue([{ entityId: 'cs-1', recipientId: 's-duena' }])
    P.reservation.findMany.mockResolvedValue([
      { id: 'r1', classSessionId: 'cs-1', guestName: null, customer: { firstName: 'Ana', lastName: 'Gómez' } },
    ])

    await sendClassNoShowSummaries(now)

    expect(emailsA()).toEqual(['luis.gerente@gmail.com'])
    expect(campanitas().map((d: any) => d.recipientId)).toEqual(['s-gerente'])
  })

  it('una clase que ya tiene a todos avisados no vuelve a leer sus reservas', async () => {
    P.classSession.findMany.mockResolvedValue([clase('cs-1', '2026-10-28T16:00:00Z')])
    P.notification.findMany.mockResolvedValue([
      { entityId: 'cs-1', recipientId: 's-duena' },
      { entityId: 'cs-1', recipientId: 's-gerente' },
    ])

    expect(await sendClassNoShowSummaries(now)).toBe(0)
    expect(P.reservation.findMany).not.toHaveBeenCalled()
    expect(mockEmail).not.toHaveBeenCalled()
    // El proceso murió entre la última campanita y la marca: se sella ahora, sin reenviar.
    expect(P.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'RESERVATION_NO_SHOW_SUMMARY_SENT', entity: 'ClassSession', entityId: 'cs-1' }),
    })
  })

  it('si ya nadie sigue en NO_SHOW (se corrigió antes del envío), no manda nada', async () => {
    P.classSession.findMany.mockResolvedValue([clase('cs-1', '2026-10-28T16:00:00Z')])
    P.reservation.findMany.mockResolvedValue([])

    expect(await sendClassNoShowSummaries(now)).toBe(0)
    expect(mockEmail).not.toHaveBeenCalled()
    expect(P.notification.create).not.toHaveBeenCalled()
  })

  it('un nombre sin apellido sí lleva su punto', async () => {
    P.classSession.findMany.mockResolvedValue([clase('cs-1', '2026-10-28T16:00:00Z')])
    P.reservation.findMany.mockResolvedValue([{ id: 'r1', classSessionId: 'cs-1', guestName: 'Carla', customer: null }])

    await sendClassNoShowSummaries(now)

    expect(campanitas()[0].message).toBe('Carla. Si alguien sí llegó, abre su reserva y toca «Sí llegó».')
  })

  describe('🔴 hallazgo #3: más faltas que el tope del correo (100) no se presentan como lista completa', () => {
    /** La base con `n` faltas en una clase: respeta `take` como lo haría Postgres. */
    const conFaltas = (n: number) =>
      P.reservation.findMany.mockImplementation(async ({ take }: any) =>
        Array.from({ length: n }, (_, i) => ({
          id: `r-${i}`,
          classSessionId: 'cs-1',
          guestName: `Persona${i} Prueba`,
          customer: null,
        })).slice(0, take),
      )

    it('101 faltas: lista las primeras 100, dice «y 1 más» con liga a la clase, y el título cuenta las 101', async () => {
      P.classSession.findMany.mockResolvedValue([clase('cs-1', '2026-10-28T16:00:00Z')])
      conFaltas(101)
      P.reservation.count.mockResolvedValue(101)

      await sendClassNoShowSummaries(now)

      expect(P.reservation.findMany.mock.calls[0][0].take).toBe(100)
      expect(P.reservation.count).toHaveBeenCalledWith({ where: { classSessionId: 'cs-1', status: 'NO_SHOW' } })
      const claseLink = `${FRONTEND_URL}/venues/mindform/reservations/calendar?clase=cs-1`

      // Correo: el TOTAL en asunto y título, las 100 ligas, y el resto con la liga a la clase.
      const [, subject, title, message, link] = mockEmail.mock.calls[0]
      expect(title).toBe('101 personas no asistieron a Yoga de las 10:00')
      expect(subject).toBe('Mindform: 101 personas no asistieron a Yoga de las 10:00')
      expect(message).toContain(`Persona99 P.: ${FRONTEND_URL}/venues/mindform/reservations/r-99`)
      expect(message).not.toContain('/reservations/r-100')
      expect(message).toContain('y 1 más: ábrelas en el panel')
      expect(message).toContain(claseLink)
      expect(link).toBe(claseLink) // el botón del correo lleva a la clase, no a una lista genérica

      // Campanita: mismo título, mismo «y 1 más», y toca para abrir la clase.
      const bell = campanitas()[0]
      expect(bell.title).toBe('101 personas no asistieron a Yoga de las 10:00')
      expect(bell.message).toMatch(/Persona99 P\. y 1 más: ábrelas en el panel\. Si alguien sí llegó/)
      expect(bell.actionUrl).toBe('reservations/calendar?clase=cs-1')
      expect(bell.metadata).toMatchObject({ classSessionId: 'cs-1', noShowsTotal: 101 })
      expect(bell.metadata.reservationIds).toHaveLength(100)
    })

    it('el «y N más» es el total menos las listadas (250 ⇒ «y 150 más»)', async () => {
      P.classSession.findMany.mockResolvedValue([clase('cs-1', '2026-10-28T16:00:00Z')])
      conFaltas(250)
      P.reservation.count.mockResolvedValue(250)

      await sendClassNoShowSummaries(now)

      expect(mockEmail.mock.calls[0][2]).toBe('250 personas no asistieron a Yoga de las 10:00')
      expect(mockEmail.mock.calls[0][3]).toContain('y 150 más: ábrelas en el panel')
    })

    it('exactamente 100 faltas: lista completa, sin «y N más» y con las ligas por persona de siempre', async () => {
      P.classSession.findMany.mockResolvedValue([clase('cs-1', '2026-10-28T16:00:00Z')])
      conFaltas(100)
      P.reservation.count.mockResolvedValue(100)

      await sendClassNoShowSummaries(now)

      const [, , title, message, link] = mockEmail.mock.calls[0]
      expect(title).toBe('100 personas no asistieron a Yoga de las 10:00')
      expect(message).not.toContain('más')
      expect(message).toContain('/reservations/r-99')
      expect(link).toBe(`${FRONTEND_URL}/venues/mindform/reservations`)
      expect(campanitas()[0].actionUrl).toBe('reservations')
    })

    it('una clase con muchas faltas no deja a la otra sin su resumen', async () => {
      P.classSession.findMany.mockResolvedValue([clase('cs-grande', '2026-10-28T16:00:00Z'), clase('cs-chica', '2026-10-28T16:10:00Z')])
      P.reservation.findMany.mockImplementation(async ({ where, take }: any) =>
        where.classSessionId === 'cs-grande'
          ? Array.from({ length: 300 }, (_, i) => ({
              id: `g-${i}`,
              classSessionId: 'cs-grande',
              guestName: 'Gran Fan',
              customer: null,
            })).slice(0, take)
          : [{ id: 'c-0', classSessionId: 'cs-chica', guestName: 'Carla', customer: null }],
      )
      P.reservation.count.mockResolvedValue(300)

      await sendClassNoShowSummaries(now)

      const porClase = campanitas().map((d: any) => d.entityId)
      expect(porClase).toContain('cs-chica')
      expect(porClase).toContain('cs-grande')
    })
  })

  describe('🔴 Codex r3 #3: la marca de «resumen enviado» es una que el gerente no puede borrar', () => {
    /** ActivityLog como la vería la base: `create` guarda, `groupBy` devuelve las clases distintas que tienen la marca. */
    let sellos: any[]
    beforeEach(() => {
      sellos = []
      P.activityLog.create.mockImplementation(async ({ data }: any) => (sellos.push(data), data))
      P.activityLog.groupBy.mockImplementation(async ({ where }: any) =>
        [
          ...new Set(
            sellos
              .filter(s => s.action === where.action && s.entity === where.entity && where.entityId.in.includes(s.entityId))
              .map(s => s.entityId),
          ),
        ].map(entityId => ({ entityId })),
      )
      P.classSession.findMany.mockResolvedValue([clase('cs-1', '2026-10-28T16:00:00Z')])
      P.reservation.findMany.mockResolvedValue([
        { id: 'r1', classSessionId: 'cs-1', guestName: null, customer: { firstName: 'Ana', lastName: 'Gómez' } },
      ])
    })

    it('entregado a todos ⇒ marca con actor SERVICE; borrar las campanitas NO hace que el siguiente tick reenvíe', async () => {
      expect(await sendClassNoShowSummaries(now)).toBe(1)
      expect(emailsA()).toEqual(['ana.duena@gmail.com', 'luis.gerente@gmail.com'])
      expect(sellos).toEqual([
        {
          action: 'RESERVATION_NO_SHOW_SUMMARY_SENT',
          entity: 'ClassSession',
          entityId: 'cs-1',
          venueId: 'v1',
          // Lo que pide `ActivityLog_actor_identity_check` para SERVICE.
          actorType: 'SERVICE',
          organizationId: 'org1',
          staffId: null,
          actorStaffId: null,
          servicePrincipalId: expect.stringMatching(/\S/),
        },
      ])

      // Los dos borran su campanita («Vaciar buzón»): la tabla de campanitas sigue vacía para el siguiente tick.
      mockEmail.mockClear()
      P.notification.create.mockClear()
      expect(await sendClassNoShowSummaries(now)).toBe(0)
      expect(mockEmail).not.toHaveBeenCalled()
      expect(P.notification.create).not.toHaveBeenCalled()
      // Una lectura acotada a los ids del lote (índice `entity, entityId`).
      expect(P.activityLog.groupBy.mock.calls[1][0]).toEqual({
        by: ['entityId'],
        where: { action: 'RESERVATION_NO_SHOW_SUMMARY_SENT', entity: 'ClassSession', entityId: { in: ['cs-1'] } },
      })
    })

    it('entrega parcial ⇒ sin marca; cuando le llega al que faltaba, entonces sí se marca', async () => {
      mockEmail.mockImplementation(async (to: string) => to !== 'luis.gerente@gmail.com')

      await sendClassNoShowSummaries(now)

      expect(campanitas().map((d: any) => d.recipientId)).toEqual(['s-duena'])
      expect(sellos).toEqual([])

      // Siguiente tick: la dueña ya tiene la suya (residual: si la borra antes, se le reenvía) y el correo ya sale.
      campanitasEnBase([{ entityId: 'cs-1', recipientId: 's-duena' }])
      mockEmail.mockReset().mockResolvedValue(true)
      await sendClassNoShowSummaries(now)

      expect(emailsA()).toEqual(['luis.gerente@gmail.com'])
      expect(sellos.map(s => s.entityId)).toEqual(['cs-1'])
    })

    it('si escribir la marca falla, el resumen igual cuenta como enviado y el tick no truena', async () => {
      P.activityLog.create.mockRejectedValue(new Error('P1001'))

      await expect(sendClassNoShowSummaries(now)).resolves.toBe(1)
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('cs-1'))
    })
  })

  describe('una dirección que siempre falla no tapa a las clases nuevas', () => {
    // 20 clases viejas (10:00-10:19 CDMX) y una nueva (10:30), la base las devuelve de la más nueva a la más vieja.
    const viejas = Array.from({ length: 20 }, (_, i) =>
      clase(`cs-vieja-${String(i).padStart(2, '0')}`, `2026-10-28T16:${String(i).padStart(2, '0')}:00Z`),
    )
    const nueva = clase('cs-nueva', '2026-10-28T16:30:00Z')
    beforeEach(() => {
      P.classSession.findMany.mockResolvedValue([nueva, ...[...viejas].reverse()])
      P.reservation.findMany.mockImplementation(async ({ where }: any) => [
        { id: `r-${where.classSessionId}`, classSessionId: where.classSessionId, guestName: 'Beto Ruiz', customer: null },
      ])
      mockEmail.mockImplementation(async (to: string) => to !== 'luis.gerente@gmail.com')
    })

    it('reintentos parciales (la dueña ya tiene la suya): la clase nueva sale en el mismo tick y primero', async () => {
      campanitasEnBase(viejas.map(cs => ({ entityId: cs.id, recipientId: 's-duena' })))

      await sendClassNoShowSummaries(now)

      expect(campanitas()).toEqual([expect.objectContaining({ entityId: 'cs-nueva', recipientId: 's-duena' })])
      expect(mockEmail.mock.calls[0][3]).toContain('/reservations/r-cs-nueva')
      // Después, los reintentos de la más vieja a la más nueva, sin pasar del tope.
      expect(mockEmail.mock.calls[2][3]).toContain('/reservations/r-cs-vieja-00')
      expect(P.reservation.findMany.mock.calls.length).toBeLessThanOrEqual(20)
    })

    it('único destinatario con el correo roto (ninguna clase tiene campanita): la nueva igual sale en el mismo tick', async () => {
      P.staffVenue.findMany.mockResolvedValue([GERENTE])

      await sendClassNoShowSummaries(now)

      expect(mockEmail.mock.calls.some(c => String(c[3]).includes('/reservations/r-cs-nueva'))).toBe(true)
    })
  })
})
