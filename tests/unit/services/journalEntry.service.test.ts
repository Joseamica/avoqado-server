/**
 * Unit tests (mock-first) for the posting engine (JournalEntry). El corazón: el invariante
 * de doble partida (Σdebe == Σhaber), validación de líneas, idempotencia y validación de cuentas.
 */
import { JournalEntrySource, Prisma } from '@prisma/client'

import { BadRequestError } from '../../../src/errors/AppError'

jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    fiscalEmisor: { findFirst: jest.fn() },
    ledgerAccount: { findMany: jest.fn() },
    journalEntry: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}))

import prisma from '../../../src/utils/prismaClient'
import { createManualEntry, listEntries, postJournalEntry } from '../../../src/services/fiscal/journalEntry.service'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  fiscalEmisor: { findFirst: jest.Mock }
  ledgerAccount: { findMany: jest.Mock }
  journalEntry: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; findMany: jest.Mock }
  $transaction: jest.Mock
}

const L = (id: string, d: number, c: number) => ({ ledgerAccountId: id, debitCents: d, creditCents: c })
const POSTABLE = [
  { id: 'caja', isPostable: true, isActive: true },
  { id: 'ventas', isPostable: true, isActive: true },
]
/** Entrada balanceada por default. */
const balanced = { date: '2026-06-15', concept: 'Venta', lines: [L('caja', 11600, 0), L('ventas', 0, 11600)] }

function txMock() {
  const create = jest.fn().mockResolvedValue({ id: 'je-1' })
  const aggregate = jest.fn().mockResolvedValue({ _max: { folio: 7 } })
  return { tx: { journalEntry: { create, aggregate } }, create, aggregate }
}
const DTO = {
  id: 'je-1',
  date: new Date('2026-06-15T12:00:00Z'),
  period: '2026-06',
  folio: 8,
  type: 'DIARIO',
  source: 'MANUAL',
  status: 'POSTED',
  concept: 'Venta',
  totalDebitCents: 11600,
  totalCreditCents: 11600,
  lines: [
    {
      id: 'l1',
      ledgerAccountId: 'caja',
      debitCents: 11600,
      creditCents: 0,
      description: null,
      ledgerAccount: { code: '101.01', name: 'Caja' },
    },
    {
      id: 'l2',
      ledgerAccountId: 'ventas',
      debitCents: 0,
      creditCents: 11600,
      description: null,
      ledgerAccount: { code: '401.01', name: 'Ventas' },
    },
  ],
}

beforeEach(() => {
  jest.clearAllMocks()
  p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', rfc: 'TESC900101AAA', type: 'AUTO_SERVICE' })
  p.fiscalEmisor.findFirst.mockResolvedValue(null)
  p.ledgerAccount.findMany.mockResolvedValue(POSTABLE)
  p.journalEntry.findUnique.mockResolvedValue(null)
  p.journalEntry.findUniqueOrThrow.mockResolvedValue(DTO)
})

describe('postJournalEntry — invariante de doble partida', () => {
  it('Σdebe ≠ Σhaber → rechaza (no toca la DB)', async () => {
    await expect(
      createManualEntry('v1', { date: '2026-06-15', concept: 'x', lines: [L('caja', 100, 0), L('ventas', 0, 200)] }, { staffId: 's' }),
    ).rejects.toThrow(BadRequestError)
    expect(p.$transaction).not.toHaveBeenCalled()
  })

  it('línea con cargo Y abono → rechaza', async () => {
    await expect(
      createManualEntry('v1', { date: '2026-06-15', concept: 'x', lines: [L('caja', 100, 100), L('ventas', 0, 0)] }, { staffId: 's' }),
    ).rejects.toThrow(/cargo O abono/i)
  })

  it('menos de 2 líneas → rechaza', async () => {
    await expect(
      createManualEntry('v1', { date: '2026-06-15', concept: 'x', lines: [L('caja', 100, 0)] }, { staffId: 's' }),
    ).rejects.toThrow(/dos líneas/i)
  })

  it('póliza por cero → rechaza', async () => {
    await expect(
      createManualEntry('v1', { date: '2026-06-15', concept: 'x', lines: [L('caja', 0, 0), L('ventas', 0, 0)] }, { staffId: 's' }),
    ).rejects.toThrow(BadRequestError)
  })

  it('fecha inválida → rechaza', async () => {
    await expect(createManualEntry('v1', { date: '2026-13-40', concept: 'x', lines: balanced.lines }, { staffId: 's' })).rejects.toThrow(
      /fecha/i,
    )
  })

  it('fecha imposible con día desbordado (31-feb) → rechaza, NO la normaliza a marzo', async () => {
    // new Date('2026-02-31T12:00:00Z') NO es NaN: V8 la corre a 2026-03-03. Un asiento quedaría en
    // periodo '2026-02' con fecha marzo → póliza fuera de su mes declarado (inconsistencia SAT).
    await expect(createManualEntry('v1', { date: '2026-02-31', concept: 'x', lines: balanced.lines }, { staffId: 's' })).rejects.toThrow(
      /fecha/i,
    )
    expect(p.$transaction).not.toHaveBeenCalled()
  })
})

describe('postJournalEntry — validación de cuentas', () => {
  it('cuenta no afectable → rechaza', async () => {
    p.ledgerAccount.findMany.mockResolvedValue([
      { id: 'caja', isPostable: false, isActive: true },
      { id: 'ventas', isPostable: true, isActive: true },
    ])
    await expect(createManualEntry('v1', balanced, { staffId: 's' })).rejects.toThrow(/afectable/i)
  })

  it('cuenta de otro contribuyente (no encontrada) → rechaza', async () => {
    p.ledgerAccount.findMany.mockResolvedValue([{ id: 'ventas', isPostable: true, isActive: true }]) // falta 'caja'
    await expect(createManualEntry('v1', balanced, { staffId: 's' })).rejects.toThrow(/no pertenece/i)
  })
})

describe('postJournalEntry — idempotencia + happy', () => {
  it('idempotencyKey existente → devuelve la póliza, NO crea otra', async () => {
    p.journalEntry.findUnique.mockResolvedValue({ id: 'je-existing' })
    const { tx } = txMock()
    p.$transaction.mockImplementation(async (cb: any) => cb(tx))
    await postJournalEntry('v1', { ...balanced, source: JournalEntrySource.PAYMENT, idempotencyKey: 'k1' }, { staffId: 's' })
    expect(p.$transaction).not.toHaveBeenCalled() // no se postea de nuevo
  })

  it('póliza balanceada → crea, folio = max+1, devuelve DTO', async () => {
    const { tx, create, aggregate } = txMock()
    p.$transaction.mockImplementation(async (cb: any) => cb(tx))
    const e = await createManualEntry('v1', balanced, { staffId: 's' })
    expect(aggregate).toHaveBeenCalled()
    expect(create).toHaveBeenCalled()
    expect(create.mock.calls[0][0].data.folio).toBe(8) // 7 + 1
    expect(create.mock.calls[0][0].data.totalDebitCents).toBe(11600)
    expect(create.mock.calls[0][0].data.totalCreditCents).toBe(11600)
    expect(e.lines).toHaveLength(2)
    expect(e.totalDebitCents).toBe(e.totalCreditCents)
  })
})

describe('postJournalEntry — concurrencia (fix del review adversario)', () => {
  const p2002 = (target: string[]) =>
    new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x', meta: { target } } as any)

  it('carrera de idempotencia: la tx lanza P2002(idempotencyKey) → devuelve la existente, NO 500', async () => {
    p.journalEntry.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'je-race' }) // pre-check null, re-read tras P2002 = existente
    p.$transaction.mockRejectedValue(p2002(['organizationId', 'rfc', 'idempotencyKey']))
    const e = await postJournalEntry('v1', { ...balanced, source: JournalEntrySource.PAYMENT, idempotencyKey: 'k' }, { staffId: 's' })
    expect(e.id).toBe('je-1') // loadEntryDTO(je-race) → DTO mock
  })

  it('colisión de folio: P2002(folio) → reintenta y al 2º intento crea', async () => {
    const { tx } = txMock()
    p.$transaction.mockRejectedValueOnce(p2002(['organizationId', 'rfc', 'folio'])).mockImplementationOnce(async (cb: any) => cb(tx))
    const e = await createManualEntry('v1', balanced, { staffId: 's' })
    expect(p.$transaction).toHaveBeenCalledTimes(2) // 1 colisión + 1 éxito
    expect(e.totalDebitCents).toBe(e.totalCreditCents)
  })

  it('usa el nivel de aislamiento Serializable', async () => {
    const { tx } = txMock()
    p.$transaction.mockImplementation(async (cb: any) => cb(tx))
    await createManualEntry('v1', balanced, { staffId: 's' })
    expect(p.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  })
})

describe('listEntries', () => {
  it('sin RFC → needsFiscalSetup', async () => {
    p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', rfc: null, type: 'AUTO_SERVICE' })
    const r = await listEntries('v1', {})
    expect(r.needsFiscalSetup).toBe(true)
  })

  it('devuelve las pólizas con líneas', async () => {
    p.journalEntry.findMany.mockResolvedValue([DTO])
    const r = await listEntries('v1', { period: '2026-06' })
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0].lines[0].accountCode).toBe('101.01')
    expect(r.entries[0].totalDebitCents).toBe(r.entries[0].totalCreditCents)
  })
})
