/**
 * SimCustodyService.accept / reject con `versionEsperada` opcional (App de campo, Codex C3).
 *
 * Sin ella (TPV, dashboard) el comportamiento es el de siempre: mismas escrituras y mismos eventos. Con ella, la versión se
 * exige DENTRO de la transacción, después de reconocer lo ya hecho y antes de escribir: una reasignación entre la lectura del
 * celular y la escritura sale ASIGNACION_CAMBIO sin tocar nada. DB-free, mocks en línea (patrón de custody.reassign).
 */
import { SimCustodyService } from '@/services/serialized-inventory/custody.service'
import { SimCustodyError } from '@/lib/sim-custody-error-codes'

jest.mock('@/services/serialized-inventory/custody.notifications', () => ({ notifySimCustody: jest.fn() }))

const ORG = 'org_1'
const PROMOTOR = 'staff_promotor'
const ACTOR = { staffId: PROMOTOR, organizationId: ORG, role: 'WAITER' as const }

const makeItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'item_1',
  venueId: null,
  organizationId: ORG,
  serialNumber: 'SIM-X',
  status: 'AVAILABLE',
  custodyState: 'PROMOTER_PENDING',
  assignedSupervisorId: null,
  assignedSupervisorAt: null,
  assignedPromoterId: PROMOTOR,
  assignedPromoterAt: new Date('2026-11-08T10:00:00Z'),
  promoterAcceptedAt: null,
  promoterRejectedAt: null,
  custodyVersion: 5, // ya la recolectaron y se la volvieron a asignar (el celular vio la 3)
  requiresOwnerApproval: false,
  sellingVenueId: null,
  registeredFromVenueId: null,
  ...overrides,
})

function makeService(item: ReturnType<typeof makeItem>) {
  const tx = {
    serializedItem: { findFirst: jest.fn().mockResolvedValue(item) },
    $queryRaw: jest.fn().mockResolvedValue([{ ...item, custodyVersion: item.custodyVersion + 1 }]),
    serializedItemCustodyEvent: { create: jest.fn().mockResolvedValue({ id: 'evt_1' }) },
  }
  const db = { $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) }
  return { service: new SimCustodyService(db as any), tx }
}

/** Lo que el servicio escribió: el UPDATE (estado y la versión que fija el CAS) y el evento. */
const escrituras = (tx: ReturnType<typeof makeService>['tx']) => ({
  updates: tx.$queryRaw.mock.calls.map(c => ({ custodyState: c[1], id: c[8], casVersion: c[9] })),
  eventos: tx.serializedItemCustodyEvent.create.mock.calls.map(c => {
    const { serializedItemId, eventType, fromState, toState, actorStaffId } = c[0].data
    return { serializedItemId, eventType, fromState, toState, actorStaffId }
  }),
})

beforeEach(() => jest.clearAllMocks())

describe('accept', () => {
  it('sin versionEsperada: lo de siempre (UPDATE con su CAS y el evento ACCEPTED_BY_PROMOTER), igual que con la versión correcta', async () => {
    const sin = makeService(makeItem())
    const con = makeService(makeItem())

    const r1 = await sin.service.accept({ actor: ACTOR, serialNumbers: ['SIM-X'], idempotencyRequestId: null })
    const r2 = await con.service.accept({
      actor: ACTOR,
      serialNumbers: ['SIM-X'],
      idempotencyRequestId: null,
      versionEsperada: { 'SIM-X': 5 },
    })

    expect(r1).toEqual({
      summary: { total: 1, succeeded: 1, failed: 0 },
      results: [{ serialNumber: 'SIM-X', status: 'ok', event: 'ACCEPTED_BY_PROMOTER' }],
    })
    expect(r2).toEqual(r1)
    expect(escrituras(sin.tx)).toEqual({
      updates: [{ custodyState: 'PROMOTER_HELD', id: 'item_1', casVersion: 5 }],
      eventos: [
        {
          serializedItemId: 'item_1',
          eventType: 'ACCEPTED_BY_PROMOTER',
          fromState: 'PROMOTER_PENDING',
          toState: 'PROMOTER_HELD',
          actorStaffId: PROMOTOR,
        },
      ],
    })
    expect(escrituras(con.tx)).toEqual(escrituras(sin.tx))
  })

  it('con otra versión (reasignada entre la lectura del celular y la escritura) → fila ASIGNACION_CAMBIO, sin UPDATE ni evento', async () => {
    const { service, tx } = makeService(makeItem())

    const r = await service.accept({ actor: ACTOR, serialNumbers: ['SIM-X'], idempotencyRequestId: null, versionEsperada: { 'SIM-X': 3 } })

    expect(r.results).toEqual([
      { serialNumber: 'SIM-X', status: 'error', code: 'ASIGNACION_CAMBIO', message: new SimCustodyError('ASIGNACION_CAMBIO').message },
    ])
    expect(tx.$queryRaw).not.toHaveBeenCalled()
    expect(tx.serializedItemCustodyEvent.create).not.toHaveBeenCalled()
  })

  it('su propia aceptación ya aplicada se reconoce antes que la versión: ALREADY_ACCEPTED aunque la versión haya subido', async () => {
    const { service, tx } = makeService(makeItem({ custodyState: 'PROMOTER_HELD', custodyVersion: 4 }))

    const r = await service.accept({ actor: ACTOR, serialNumbers: ['SIM-X'], idempotencyRequestId: null, versionEsperada: { 'SIM-X': 3 } })

    expect(r.results[0]).toMatchObject({ status: 'error', code: 'ALREADY_ACCEPTED' })
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })
})

describe('reject', () => {
  it('sin versionEsperada: lo de siempre (UPDATE y evento REJECTED_BY_PROMOTER), igual que con la versión correcta', async () => {
    const sin = makeService(makeItem())
    const con = makeService(makeItem())

    expect(await sin.service.reject({ actor: ACTOR, serialNumber: 'SIM-X' })).toEqual({ custodyState: 'PROMOTER_REJECTED' })
    expect(await con.service.reject({ actor: ACTOR, serialNumber: 'SIM-X', versionEsperada: 5 })).toEqual({
      custodyState: 'PROMOTER_REJECTED',
    })
    expect(escrituras(sin.tx)).toEqual({
      updates: [{ custodyState: 'PROMOTER_REJECTED', id: 'item_1', casVersion: 5 }],
      eventos: [
        {
          serializedItemId: 'item_1',
          eventType: 'REJECTED_BY_PROMOTER',
          fromState: 'PROMOTER_PENDING',
          toState: 'PROMOTER_REJECTED',
          actorStaffId: PROMOTOR,
        },
      ],
    })
    expect(escrituras(con.tx)).toEqual(escrituras(sin.tx))
  })

  it('con otra versión → ASIGNACION_CAMBIO (409), sin UPDATE ni evento', async () => {
    const { service, tx } = makeService(makeItem())

    const error = await service.reject({ actor: ACTOR, serialNumber: 'SIM-X', versionEsperada: 3 }).catch(e => e)

    expect(error).toBeInstanceOf(SimCustodyError)
    expect(error).toMatchObject({ code: 'ASIGNACION_CAMBIO', httpStatus: 409 })
    expect(tx.$queryRaw).not.toHaveBeenCalled()
    expect(tx.serializedItemCustodyEvent.create).not.toHaveBeenCalled()
  })

  it('su propio rechazo ya aplicado se reconoce antes que la versión: ALREADY_REJECTED', async () => {
    const { service } = makeService(makeItem({ custodyState: 'PROMOTER_REJECTED', custodyVersion: 4 }))

    await expect(service.reject({ actor: ACTOR, serialNumber: 'SIM-X', versionEsperada: 3 })).rejects.toMatchObject({
      code: 'ALREADY_REJECTED',
    })
  })
})
