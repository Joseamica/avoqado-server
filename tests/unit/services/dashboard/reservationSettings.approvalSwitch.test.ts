import { updateReservationSettingsBodySchema } from '@/schemas/dashboard/reservation.schema'

/**
 * Fase 1 — 🔴 P1 de la auditoría de Codex: el switch se DEVOLVÍA en el GET pero el PUT lo
 * ignoraba, así que la única forma de prenderlo era un UPDATE a mano en Postgres.
 *
 * Eso viola la regla del founder tal cual está escrita: *"Nunca solo en la DB: un feature
 * cuyo único switch es un UPDATE en Postgres está incompleto y deja al founder de switch
 * humano."* Mindform no podía activar la función.
 *
 * Aquí se prueba el CONTRATO del PUT: que acepte los dos campos, que rechace prender la
 * aprobación sin exigir cuenta (sin cuenta no hay a quién aprobar — el CHECK de la migración
 * lo impediría a nivel base, pero con un 500 en vez de un mensaje que se entienda), y que no
 * deje la lista de avisos vacía.
 */
describe('PUT de ajustes de reservación — switch de aprobación', () => {
  it('🔴 acepta requireCustomerApproval junto a requireAccount', () => {
    const r = updateReservationSettingsBodySchema.safeParse({
      publicBooking: { requireAccount: true, requireCustomerApproval: true },
    })

    expect(r.success).toBe(true)
  })

  it('🔴 acepta la lista de roles que reciben el aviso', () => {
    const r = updateReservationSettingsBodySchema.safeParse({
      publicBooking: { customerApprovalNotificationRoles: ['OWNER', 'ADMIN'] },
    })

    expect(r.success).toBe(true)
  })

  it('🔴 prender la aprobación SIN cuenta se rechaza con un mensaje que dice qué hacer', () => {
    const r = updateReservationSettingsBodySchema.safeParse({
      publicBooking: { requireAccount: false, requireCustomerApproval: true },
    })

    expect(r.success).toBe(false)
    if (!r.success) {
      const msg = r.error.issues.map(i => i.message).join(' ')
      expect(msg).toMatch(/cuenta/i)
    }
  })

  it('🔴 prender la aprobación sin MENCIONAR requireAccount también se rechaza: el server no adivina', () => {
    // Se rechaza a propósito en vez de asumir que ya estaba prendido: asumirlo dejaría pasar
    // un payload que la base rechaza con un 500 incomprensible.
    const r = updateReservationSettingsBodySchema.safeParse({ publicBooking: { requireCustomerApproval: true } })

    expect(r.success).toBe(false)
  })

  it('apagar la aprobación nunca exige cuenta', () => {
    const r = updateReservationSettingsBodySchema.safeParse({ publicBooking: { requireCustomerApproval: false } })

    expect(r.success).toBe(true)
  })

  it('🔴 una lista de roles VACÍA se rechaza: prender el switch sin avisarle a nadie es el bug silencioso', () => {
    const r = updateReservationSettingsBodySchema.safeParse({ publicBooking: { customerApprovalNotificationRoles: [] } })

    expect(r.success).toBe(false)
  })

  it('🔴 sólo se admiten roles reales del venue', () => {
    const r = updateReservationSettingsBodySchema.safeParse({ publicBooking: { customerApprovalNotificationRoles: ['DUEÑO'] } })

    expect(r.success).toBe(false)
  })
})

describe('normalización a columnas', () => {
  // El normalizador es privado; se prueba a través del mapeo observable que hace el update.
  it('🔴 los dos campos llegan a la fila (antes se perdían en silencio)', async () => {
    const mod = await import('@/services/dashboard/reservationSettings.service')
    const normalize = (mod as any).normalizeReservationSettingsUpdate

    expect(typeof normalize).toBe('function')
    const out = normalize({
      publicBooking: { requireAccount: true, requireCustomerApproval: true, customerApprovalNotificationRoles: ['OWNER'] },
    })

    expect(out).toMatchObject({
      requireAccount: true,
      requireCustomerApproval: true,
      customerApprovalNotificationRoles: ['OWNER'],
    })
  })
})
