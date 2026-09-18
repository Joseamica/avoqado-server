/**
 * La declaración del CAJERO «ya revisé la terminal: no se cobró» (plan 18-sep, Task 3).
 *
 * Hermana de `resolveNoInstrument` y deliberadamente SEPARADA: aquélla la hace la TERMINAL sobre un INTENTO
 * ligado y afirma que nadie presentó tarjeta; ésta la hace el POS sobre una SOLICITUD —que puede no tener
 * intento, y las filas legacy del incidente no lo tienen— y afirma que una persona miró la pantalla del
 * aparato y no hubo cobro. Escriben el mismo desenlace porque es el que libera los dos candados.
 *
 * 1. NEW FEATURE — camino feliz, autorización, cada veto, idempotencia
 * 2. REGRESIÓN — la identidad nunca sale del cuerpo; `reason`/`confirm` no son una declaración
 */
import prisma from '@/utils/prismaClient'
import {
  UnchargedReconciliationError,
  readUnchargedReconciliation,
  reconcileUncharged,
} from '@/services/tpv/uncharged-reconciliation.service'

const prismaMock = prisma as any

const venueId = 'v1'
const requestId = 'req-1'
const resolutionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const identidad = { venueId, requestId, actorStaffId: 'staff-cashier', source: 'MOBILE' as const }
const declaracion = () => ({ requestId, resolutionId, statement: 'UNCHARGED_VERIFIED', statementVersion: 1 })

/** La fila del incidente de Testarudo: UNKNOWN, la terminal ya volvió, sin pago y sin evidencia. */
function filaDelIncidente(over: Record<string, unknown> = {}) {
  const ahora = new Date()
  return {
    id: 'row-1',
    requestId,
    venueId,
    terminalId: 'n860w173397',
    orderId: 'order-1',
    amountCents: 6500,
    tipCents: 975,
    status: 'UNKNOWN',
    failureCode: null,
    cancelDisposition: null,
    paymentId: null,
    closedVia: null,
    lateResult: false,
    terminalReturnedAt: ahora,
    operatorReconciliation: null,
    resultJson: { requestId, status: 'timeout' },
    createdAt: ahora,
    updatedAt: ahora,
    ...over,
  }
}

const CAJERO = { id: 'sv-cashier', staffId: 'staff-cashier', role: 'CASHIER', permissionSetId: null, permissionSet: null }
const MESERO = { id: 'sv-waiter', staffId: 'staff-waiter', role: 'WAITER', permissionSetId: null, permissionSet: null }

function montar(fila = filaDelIncidente(), miembro: unknown = CAJERO) {
  prismaMock.$transaction.mockImplementation((fn: any) => fn(prismaMock))
  prismaMock.$queryRaw.mockResolvedValue([{ id: 'order-1' }])
  prismaMock.$executeRaw.mockResolvedValue(1)
  prismaMock.$executeRawUnsafe.mockResolvedValue(0)
  prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(fila)
  prismaMock.payment.findFirst.mockResolvedValue(null)
  prismaMock.activityLog.create.mockResolvedValue({})
  prismaMock.staffVenue.findFirst.mockResolvedValue(miembro)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
}

beforeEach(() => {
  jest.clearAllMocks()
  montar()
})

describe('readUnchargedReconciliation', () => {
  it('reconoce una declaración guardada', () => {
    expect(readUnchargedReconciliation({ id: 'a1', kind: 'UNCHARGED_VERIFIED' })?.id).toBe('a1')
  })

  it('🔴 NO confunde la declaración de gerencia «no se presentó tarjeta» con ésta', () => {
    expect(readUnchargedReconciliation({ id: 'a1', kind: 'NO_INSTRUMENT_PRESENTED' })).toBeNull()
  })

  it('un valor que no es objeto es null, nunca una excepción', () => {
    for (const v of [null, undefined, 'x', 3, ['a']]) expect(readUnchargedReconciliation(v)).toBeNull()
  })
})

describe('reconcileUncharged — camino feliz', () => {
  it('acepta, escribe el desenlace que libera y deja UN asiento de auditoría', async () => {
    const r = await reconcileUncharged(identidad, declaracion())
    expect(r.kind).toBe('UNCHARGED_VERIFIED')
    expect(r.id).toBe(resolutionId)
    expect(r.staffId).toBe('staff-cashier')
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create.mock.calls[0][0].data.action).toBe(
      'TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED',
    )
  })

  it('🔴 el CAS escribe EXACTAMENTE el desenlace que sale de los dos candados', async () => {
    await reconcileUncharged(identidad, declaracion())
    const sql = JSON.stringify(prismaMock.$executeRaw.mock.calls[0])
    expect(sql).toContain('FAILED')
    expect(sql).toContain('OPERATOR_RECONCILED_NO_CHARGE')
    expect(sql).toContain('cancelDisposition')
  })

  it('también acepta una fila TIMED_OUT sin desenlace acreditado (las legacy del incidente)', async () => {
    montar(filaDelIncidente({ status: 'TIMED_OUT' }))
    await expect(reconcileUncharged(identidad, declaracion())).resolves.toMatchObject({ kind: 'UNCHARGED_VERIFIED' })
  })
})

describe('reconcileUncharged — lo que VETA la declaración', () => {
  it('rechaza si hay un Payment por cualquiera de las identidades', async () => {
    prismaMock.payment.findFirst.mockResolvedValue({ id: 'pay-1' })
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
  })

  it('rechaza si la fila ya tiene paymentId', async () => {
    montar(filaDelIncidente({ paymentId: 'pay-9' }))
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
  })

  it('🔴 rechaza si la SONDA dijo hace poco que el cobro sigue corriendo', async () => {
    montar(filaDelIncidente({ resultJson: { requestId, probeActiveAt: new Date().toISOString() } }))
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ code: 'EXECUTION_STILL_ACTIVE' })
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
  })

  it('🔴 rechaza si la terminal TODAVÍA no ha vuelto', async () => {
    montar(filaDelIncidente({ terminalReturnedAt: null }))
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ code: 'TERMINAL_NOT_BACK' })
  })

  it('🔴 rechaza una fila RETENIDA por el banco', async () => {
    montar(filaDelIncidente({ status: 'TIMED_OUT', failureCode: 'BANK_APPROVED_AWAITING_PAYMENT' }))
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
  })

  it('🔴 rechaza una fila con señal positiva en el sobre de la terminal', async () => {
    montar(filaDelIncidente({ resultJson: { requestId, status: 'success', authorizationCode: '103520' } }))
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
  })

  it('🔴 rechaza una fila PENDING: el cobro ni siquiera salió', async () => {
    montar(filaDelIncidente({ status: 'PENDING' }))
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ code: 'ATTEMPT_NOT_ELIGIBLE' })
  })

  it('🔴 un CAS que devuelve 0 NO declara nada ni audita', async () => {
    prismaMock.$executeRaw.mockResolvedValue(0)
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toThrow(UnchargedReconciliationError)
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('🔴 una solicitud de OTRO negocio no existe para este cajero', async () => {
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(null)
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({
      code: 'ATTEMPT_NOT_FOUND',
      statusCode: 404,
    })
  })
})

describe('reconcileUncharged — autorización', () => {
  it('🔴 sin el permiso efectivo no se acepta, aunque el cuerpo venga perfecto', async () => {
    montar(filaDelIncidente(), MESERO)
    await expect(
      reconcileUncharged({ ...identidad, actorStaffId: 'staff-waiter' }, declaracion()),
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
  })

  it('🔴 quien no es miembro ACTIVO del venue no declara', async () => {
    montar(filaDelIncidente(), null)
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ statusCode: 403 })
  })

  it('🔴 la autorización se comprueba ANTES que la elegibilidad: no filtra el estado del cobro', async () => {
    montar(filaDelIncidente({ paymentId: 'pay-9' }), MESERO)
    await expect(
      reconcileUncharged({ ...identidad, actorStaffId: 'staff-waiter' }, declaracion()),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('reconcileUncharged — idempotencia', () => {
  it('🔴 el replay con el MISMO resolutionId y cuerpo devuelve la guardada SIN reescribir', async () => {
    const primera = await reconcileUncharged(identidad, declaracion())
    jest.clearAllMocks()
    montar(filaDelIncidente({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE', operatorReconciliation: primera }))
    const segunda = await reconcileUncharged(identidad, declaracion())
    expect(segunda.id).toBe(primera.id)
    expect(segunda.acceptedAt).toBe(primera.acceptedAt)
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('🔴 OTRO cuerpo bajo el mismo resolutionId es RESOLUTION_CONFLICT', async () => {
    const primera = await reconcileUncharged(identidad, declaracion())
    jest.clearAllMocks()
    montar(filaDelIncidente({ status: 'FAILED', operatorReconciliation: { ...primera, bodyHash: 'otro' } }))
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ code: 'RESOLUTION_CONFLICT' })
  })
})

describe('REGRESIÓN — la identidad nunca sale del cuerpo', () => {
  it('🔴 un staffId en el cuerpo NO se obedece', async () => {
    await expect(
      reconcileUncharged(identidad, { ...declaracion(), staffId: 'staff-owner' } as unknown),
    ).rejects.toThrow(UnchargedReconciliationError)
  })

  it('🔴 `reason` y `confirm` NO son una declaración', async () => {
    await expect(
      reconcileUncharged(identidad, { requestId, reason: 'la PAX se reinició', confirm: true } as unknown),
    ).rejects.toThrow(UnchargedReconciliationError)
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
  })
})
