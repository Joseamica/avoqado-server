jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import {
  resolveApprovalOnActivation,
  activateCustomerAccount,
  assertCustomerCanCreateReservation,
  decideCustomerApproval,
  CUSTOMER_APPROVAL_PENDING,
  CUSTOMER_APPROVAL_REJECTED,
  CUSTOMER_APPROVAL_CONFLICT,
} from '@/services/public/customerBookingAccess.service'

/**
 * Fase 1 — aprobación de clientes. Diseño v2 (auditado por Codex):
 *  · §3bis: el gate toma FOR UPDATE de la fila Customer; la decisión hace write-CAS. Leer no
 *    compite, escribir sí: sin el lock una reserva se colaba durante un rechazo.
 *  · §3ter: contacto de CRM (nunca activó) ≠ preaprobado explícito (approvalDecidedAt no nulo).
 *  · El switch apagado ⇒ el gate NI SIQUIERA lee el estado del cliente.
 */
const VENUE = 'v1'
const CUSTOMER = 'c1'

type LockedRow = {
  approvalStatus: string
  approvalVersion: number
  active?: boolean
  approvalDecidedAt?: Date | null
  accountActivatedAt?: Date | null
}

function mkTx(
  opts: {
    requireCustomerApproval?: boolean
    lockedRow?: LockedRow | null
    casCount?: number
  } = {},
) {
  const defaultRow: LockedRow = {
    approvalStatus: 'APPROVED',
    approvalVersion: 3,
    active: true,
    approvalDecidedAt: null,
    accountActivatedAt: null,
  }
  const tx: any = {
    reservationSettings: {
      findUnique: jest.fn(async () => ({ requireCustomerApproval: opts.requireCustomerApproval ?? true })),
    },
    // TODAS las lecturas de Customer del servicio van por SQL crudo, porque llevan lock.
    $queryRaw: jest.fn(async () => (opts.lockedRow === null ? [] : [{ ...defaultRow, ...(opts.lockedRow ?? {}) }])),
    customer: {
      update: jest.fn(async (args: any) => ({ id: CUSTOMER, approvalVersion: 1, ...args.data })),
      updateMany: jest.fn(async () => ({ count: opts.casCount ?? 1 })),
    },
    activityLog: { create: jest.fn(async () => ({})) },
    customerApprovalOutbox: { create: jest.fn(async () => ({})) },
  }
  return tx
}

describe('resolveApprovalOnActivation (pura) — §5.2 + §3ter', () => {
  const base = { accountActivatedAt: null, approvalDecidedAt: null, approvalStatus: 'APPROVED' as const }

  it('switch OFF → APPROVED sin pedir nada, venga de donde venga', () => {
    for (const origin of ['PASSWORD', 'OTP', 'CONSUMER'] as const) {
      expect(resolveApprovalOnActivation({ ...base, requireCustomerApproval: false, origin })).toEqual(
        expect.objectContaining({ approvalStatus: 'APPROVED', requestsApproval: false }),
      )
    }
  })

  it('🔴 switch ON + contacto de CRM (nunca activó, nadie decidió) → PENDING en los 3 orígenes públicos', () => {
    for (const origin of ['PASSWORD', 'OTP', 'CONSUMER'] as const) {
      expect(resolveApprovalOnActivation({ ...base, requireCustomerApproval: true, origin })).toEqual(
        expect.objectContaining({ approvalStatus: 'PENDING', requestsApproval: true }),
      )
    }
  })

  it('🔴 switch ON + PREAPROBADO explícito (approvalDecidedAt no nulo, sin cuenta) → conserva APPROVED', () => {
    expect(
      resolveApprovalOnActivation({
        ...base,
        approvalDecidedAt: new Date('2026-08-01'),
        requireCustomerApproval: true,
        origin: 'PASSWORD',
      }),
    ).toEqual(expect.objectContaining({ approvalStatus: 'APPROVED', requestsApproval: false }))
  })

  it('creado por STAFF → APPROVED aunque el switch esté ON (el staff ya decidió al crearlo)', () => {
    expect(resolveApprovalOnActivation({ ...base, requireCustomerApproval: true, origin: 'STAFF' })).toEqual(
      expect.objectContaining({ approvalStatus: 'APPROVED', requestsApproval: false }),
    )
  })

  it('🔴 cuenta YA activada (accountActivatedAt no nulo) → NO se recalcula nunca, conserva su estado', () => {
    expect(
      resolveApprovalOnActivation({
        accountActivatedAt: new Date('2026-01-01'),
        approvalDecidedAt: new Date('2026-01-01'),
        approvalStatus: 'REJECTED',
        requireCustomerApproval: true,
        origin: 'OTP',
      }),
    ).toEqual(expect.objectContaining({ approvalStatus: 'REJECTED', requestsApproval: false, alreadyActivated: true }))
  })
})

describe('assertCustomerCanCreateReservation — §3bis', () => {
  beforeEach(() => jest.clearAllMocks())

  it('switch OFF → pasa SIN leer el estado del cliente (ni lock ni consulta)', async () => {
    const tx = mkTx({ requireCustomerApproval: false })
    await expect(assertCustomerCanCreateReservation(tx, { customerId: CUSTOMER, venueId: VENUE })).resolves.toBeUndefined()
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })

  it('switch OFF + invitado → pasa: no hay switch ni a quién aprobar', async () => {
    const tx = mkTx({ requireCustomerApproval: false })
    await expect(assertCustomerCanCreateReservation(tx, { customerId: null, venueId: VENUE })).resolves.toBeUndefined()
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })

  // Auditoría 16 §1.2: con el switch ON el invitado NO puede colarse. El CHECK de la migración
  // garantiza requireAccount, así que llegar sin sesión aquí es un hueco, no un caso legítimo
  // (holds y checkout de paquetes eran justo esa puerta).
  it('🔴 switch ON + SIN customerId → 401 CUSTOMER_AUTH_REQUIRED (el invitado no burla la aprobación)', async () => {
    const tx = mkTx({ requireCustomerApproval: true })
    await expect(assertCustomerCanCreateReservation(tx, { customerId: null, venueId: VENUE })).rejects.toMatchObject({
      statusCode: 401,
      code: 'CUSTOMER_AUTH_REQUIRED',
    })
  })

  // Auditoría 16 §2: FOR UPDATE era el lock EQUIVOCADO. Bloquea también los FK KEY SHARE que
  // toman los INSERT de Reservation/CreditTransaction del lado staff ⇒ ciclo de deadlock
  // (pública: Customer→ClassSession; staff: ClassSession→FK Customer). FOR SHARE compite con
  // el UPDATE de la decisión y convive con los FK.
  it('🔴 switch ON → toma FOR SHARE (no FOR UPDATE: evita el ciclo con los FK KEY SHARE del staff)', async () => {
    const tx = mkTx({ requireCustomerApproval: true })
    await assertCustomerCanCreateReservation(tx, { customerId: CUSTOMER, venueId: VENUE })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    const sql = String(tx.$queryRaw.mock.calls[0][0]).toUpperCase()
    expect(sql).toContain('FOR SHARE')
    expect(sql).not.toContain('FOR UPDATE')
  })

  it('APPROVED → pasa', async () => {
    const tx = mkTx({ lockedRow: { approvalStatus: 'APPROVED', approvalVersion: 3, active: true } })
    await expect(assertCustomerCanCreateReservation(tx, { customerId: CUSTOMER, venueId: VENUE })).resolves.toBeUndefined()
  })

  it('PENDING → 403 CUSTOMER_APPROVAL_PENDING', async () => {
    const tx = mkTx({ lockedRow: { approvalStatus: 'PENDING', approvalVersion: 0, active: true } })
    await expect(assertCustomerCanCreateReservation(tx, { customerId: CUSTOMER, venueId: VENUE })).rejects.toMatchObject({
      statusCode: 403,
      code: CUSTOMER_APPROVAL_PENDING,
    })
  })

  it('REJECTED → 403 CUSTOMER_APPROVAL_REJECTED', async () => {
    const tx = mkTx({ lockedRow: { approvalStatus: 'REJECTED', approvalVersion: 2, active: true } })
    await expect(assertCustomerCanCreateReservation(tx, { customerId: CUSTOMER, venueId: VENUE })).rejects.toMatchObject({
      statusCode: 403,
      code: CUSTOMER_APPROVAL_REJECTED,
    })
  })

  it('customer inactivo → 401 CUSTOMER_INACTIVE (gana sobre la aprobación)', async () => {
    const tx = mkTx({ lockedRow: { approvalStatus: 'APPROVED', approvalVersion: 1, active: false } })
    await expect(assertCustomerCanCreateReservation(tx, { customerId: CUSTOMER, venueId: VENUE })).rejects.toMatchObject({
      statusCode: 401,
      code: 'CUSTOMER_INACTIVE',
    })
  })

  it('el customer no existe en ese venue → 404, sin dejar pasar', async () => {
    const tx = mkTx({ lockedRow: null })
    await expect(assertCustomerCanCreateReservation(tx, { customerId: CUSTOMER, venueId: VENUE })).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})

describe('decideCustomerApproval — write-CAS, idempotencia y rastro', () => {
  const decide = { decision: 'APPROVED' as const, expectedVersion: 3, actorStaffId: 's1', organizationId: 'org1' }

  beforeEach(() => jest.clearAllMocks())

  it('🔴 CAS: el UPDATE va condicionado a approvalVersion = expectedVersion', async () => {
    const tx = mkTx({ lockedRow: { approvalStatus: 'PENDING', approvalVersion: 3, active: true } })
    await decideCustomerApproval(tx, { customerId: CUSTOMER, venueId: VENUE, ...decide })
    expect(tx.customer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: CUSTOMER, venueId: VENUE, approvalVersion: 3 }) }),
    )
  })

  it('🔴 otro decidió primero (CAS count 0) → 409 CUSTOMER_APPROVAL_CONFLICT, sin audit ni outbox', async () => {
    const tx = mkTx({ lockedRow: { approvalStatus: 'PENDING', approvalVersion: 4, active: true }, casCount: 0 })
    await expect(decideCustomerApproval(tx, { customerId: CUSTOMER, venueId: VENUE, ...decide })).rejects.toMatchObject({
      statusCode: 409,
      code: CUSTOMER_APPROVAL_CONFLICT,
    })
    expect(tx.activityLog.create).not.toHaveBeenCalled()
    expect(tx.customerApprovalOutbox.create).not.toHaveBeenCalled()
  })

  it('🔴 repetir una decisión YA TOMADA es idempotente: no bumpea versión, no duplica audit ni correo', async () => {
    const tx = mkTx({
      lockedRow: { approvalStatus: 'APPROVED', approvalVersion: 3, active: true, approvalDecidedAt: new Date('2026-08-01') },
    })
    const r = await decideCustomerApproval(tx, { customerId: CUSTOMER, venueId: VENUE, ...decide })
    expect(r).toEqual(expect.objectContaining({ changed: false, approvalStatus: 'APPROVED', approvalVersion: 3 }))
    expect(tx.customer.updateMany).not.toHaveBeenCalled()
    expect(tx.activityLog.create).not.toHaveBeenCalled()
    expect(tx.customerApprovalOutbox.create).not.toHaveBeenCalled()
  })

  // Auditoría 16 §1.3: "mismo estado ⇒ no-op" se tragaba la PREAPROBACIÓN. Un contacto de CRM
  // está APPROVED por default SIN que nadie haya decidido: aprobarlo debe SELLAR la decisión,
  // porque es justo lo que lo protege de caer en PENDING cuando active su cuenta.
  it('🔴 APPROVED por DEFAULT (approvalDecidedAt null) → aprobar SÍ sella la decisión, no es no-op', async () => {
    const tx = mkTx({ lockedRow: { approvalStatus: 'APPROVED', approvalVersion: 0, active: true, approvalDecidedAt: null } })
    const r = await decideCustomerApproval(tx, { customerId: CUSTOMER, venueId: VENUE, ...decide, expectedVersion: 0 })

    expect(r.changed).toBe(true)
    expect(tx.customer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ approvalDecidedAt: expect.any(Date), approvalDecidedByStaffId: 's1' }) }),
    )
  })

  it('🔴 la decisión toma FOR NO KEY UPDATE (no FOR UPDATE): escribe pero no choca con los FK', async () => {
    const tx = mkTx({ lockedRow: { approvalStatus: 'PENDING', approvalVersion: 3, active: true, approvalDecidedAt: null } })
    await decideCustomerApproval(tx, { customerId: CUSTOMER, venueId: VENUE, ...decide })
    const sql = String(tx.$queryRaw.mock.calls[0][0]).toUpperCase()
    expect(sql).toContain('FOR NO KEY UPDATE')
  })

  it('ActivityLog DENTRO de la tx, con la org del venue y actorStaffId = staffId (constraint)', async () => {
    const tx = mkTx({ lockedRow: { approvalStatus: 'PENDING', approvalVersion: 3, active: true } })
    await decideCustomerApproval(tx, { customerId: CUSTOMER, venueId: VENUE, ...decide })
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'CUSTOMER_APPROVAL_APPROVED',
        entity: 'Customer',
        entityId: CUSTOMER,
        actorType: 'HUMAN',
        staffId: 's1',
        actorStaffId: 's1',
        organizationId: 'org1',
        venueId: VENUE,
      }),
    })
  })

  it('encola el correo en la MISMA tx, con dedupeKey evento:customer:versionNUEVA', async () => {
    const tx = mkTx({ lockedRow: { approvalStatus: 'PENDING', approvalVersion: 3, active: true } })
    await decideCustomerApproval(tx, { customerId: CUSTOMER, venueId: VENUE, ...decide })
    expect(tx.customerApprovalOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        event: 'APPROVED_CUSTOMER',
        customerId: CUSTOMER,
        approvalVersion: 4,
        dedupeKey: `APPROVED_CUSTOMER:${CUSTOMER}:4`,
      }),
    })
  })

  it('rechazo con razón → estado REJECTED, razón guardada y evento REJECTED_CUSTOMER', async () => {
    const tx = mkTx({ lockedRow: { approvalStatus: 'PENDING', approvalVersion: 3, active: true } })
    await decideCustomerApproval(tx, { customerId: CUSTOMER, venueId: VENUE, ...decide, decision: 'REJECTED', reason: 'No es socia' })
    expect(tx.customer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ approvalStatus: 'REJECTED', approvalDecisionReason: 'No es socia' }) }),
    )
    expect(tx.customerApprovalOutbox.create).toHaveBeenCalledWith({ data: expect.objectContaining({ event: 'REJECTED_CUSTOMER' }) })
  })

  it('🔴 preaprobación anticipada: un Customer SIN cuenta puede decidirse (sella approvalDecidedAt)', async () => {
    const tx = mkTx({ lockedRow: { approvalStatus: 'PENDING', approvalVersion: 0, active: true } })
    await decideCustomerApproval(tx, { customerId: CUSTOMER, venueId: VENUE, ...decide, expectedVersion: 0 })
    expect(tx.customer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ approvalDecidedAt: expect.any(Date), approvalDecidedByStaffId: 's1' }) }),
    )
  })
})

describe('activateCustomerAccount', () => {
  beforeEach(() => jest.clearAllMocks())

  // Auditoría 16 §1.1: la activación hacía read→update SIN lock, así que una preaprobación
  // concurrente se perdía (la lectura no veía la decisión y escribía PENDING encima).
  it('🔴 toma FOR NO KEY UPDATE de la fila antes de decidir: una preaprobación concurrente no se pierde', async () => {
    const tx = mkTx({ requireCustomerApproval: true })
    await activateCustomerAccount(tx, { customerId: CUSTOMER, venueId: VENUE, origin: 'PASSWORD' })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(String(tx.$queryRaw.mock.calls[0][0]).toUpperCase()).toContain('FOR NO KEY UPDATE')
  })

  it('switch ON + contacto nuevo → sella accountActivatedAt + approvalRequestedAt y encola los DOS eventos en la misma tx', async () => {
    const tx = mkTx({
      requireCustomerApproval: true,
      lockedRow: { approvalStatus: 'APPROVED', approvalVersion: 0, active: true, approvalDecidedAt: null, accountActivatedAt: null },
    })
    const r = await activateCustomerAccount(tx, { customerId: CUSTOMER, venueId: VENUE, origin: 'PASSWORD' })

    expect(r).toEqual(expect.objectContaining({ approvalStatus: 'PENDING', requestsApproval: true }))
    expect(tx.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          approvalStatus: 'PENDING',
          accountActivatedAt: expect.any(Date),
          approvalRequestedAt: expect.any(Date),
        }),
      }),
    )
    const eventos = tx.customerApprovalOutbox.create.mock.calls.map((c: any) => c[0].data.event)
    expect(eventos).toEqual(expect.arrayContaining(['REQUESTED_STAFF', 'PENDING_CUSTOMER']))
  })

  it('switch OFF → sella la activación pero NO encola nada', async () => {
    const tx = mkTx({ requireCustomerApproval: false })
    const r = await activateCustomerAccount(tx, { customerId: CUSTOMER, venueId: VENUE, origin: 'OTP' })
    expect(r.approvalStatus).toBe('APPROVED')
    expect(tx.customerApprovalOutbox.create).not.toHaveBeenCalled()
  })

  it('cuenta ya activada → no reescribe accountActivatedAt ni vuelve a pedir aprobación', async () => {
    const tx = mkTx({ requireCustomerApproval: true })
    tx.$queryRaw.mockResolvedValue([
      {
        accountActivatedAt: new Date('2026-01-01'),
        approvalDecidedAt: new Date('2026-01-01'),
        approvalStatus: 'APPROVED',
        approvalVersion: 2,
        active: true,
      },
    ])
    const r = await activateCustomerAccount(tx, { customerId: CUSTOMER, venueId: VENUE, origin: 'OTP' })
    expect(r.requestsApproval).toBe(false)
    expect(tx.customer.update).not.toHaveBeenCalled()
    expect(tx.customerApprovalOutbox.create).not.toHaveBeenCalled()
  })
})
