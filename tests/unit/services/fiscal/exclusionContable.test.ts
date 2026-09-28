/**
 * IVA por producto, plan 4 · Tarea 1 — la contabilidad se pausa y lo dice (unitarias, sin base).
 *
 *  - `conReintentoContable` (Ruling R11): transacción Serializable de 15 s con candados de 5 s. 40001, 55P03 y 40P01
 *    se reintentan y, agotados, salen como 409 `CONTABILIDAD_OCUPADA`; P2028 (transacción vencida) también, sin
 *    reintento; cualquier otro error pasa tal cual.
 *  - `postJournalEntry`: el mismo contrato con su propio ciclo (colisión de folio y carrera de idempotencia), y la
 *    marca se lee DENTRO de la transacción, después de la re-comprobación de idempotencia (Review Focus 3).
 *  - autoPosting: el `catch` del COGS ya no se traga la pausa, y sigue tragando lo demás.
 *
 * Contra la base real (candados, carreras, catálogo): `tests/integration/fiscal/exclusionContable.integration.test.ts`.
 */
import { JournalEntrySource, Prisma } from '@prisma/client'

import logger from '@/config/logger'
import { ConflictError } from '@/errors/AppError'
import { getMappings } from '@/services/fiscal/accountMapping.service'
import { generatePoliciesForVenue } from '@/services/fiscal/autoPosting.service'
import { resolveScopeOrNull } from '@/services/fiscal/chartOfAccounts.service'
import { generateCogsPolicyForVenue } from '@/services/fiscal/cogs.service'
import { postJournalEntry } from '@/services/fiscal/journalEntry.service'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))
jest.mock('@/services/fiscal/accountMapping.service', () => ({ getMappings: jest.fn() }))
jest.mock('@/services/fiscal/cogs.service', () => ({ generateCogsPolicyForVenue: jest.fn() }))

const MOTIVO =
  'La contabilidad de Avoqado todavía no maneja ventas con IVA distinto de 16 %. Como esta organización ya tuvo productos con otra tasa, las pólizas y el cierre de periodo están pausados. Escríbenos a hola@avoqado.io si lo necesitas.'
const OCUPADA = {
  statusCode: 409,
  code: 'CONTABILIDAD_OCUPADA',
  message: 'La contabilidad está ocupada en este momento. Vuelve a intentarlo en unos segundos.',
}

// El mock global enumera sus modelos; los de la contabilidad se declaran aquí (sólo para este archivo).
const pm = prismaMock as any
pm.journalEntry = { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), findMany: jest.fn() }
pm.ledgerAccount = { findMany: jest.fn() }
pm.accountingPeriodLock = { findUnique: jest.fn() }
pm.fiscalEmisor = { findFirst: jest.fn() }

const p2010 = (sqlState: string) =>
  new Prisma.PrismaClientKnownRequestError(`Raw query failed. Code: \`${sqlState}\`.`, {
    code: 'P2010',
    clientVersion: 'test',
    meta: { code: sqlState, message: 'conflicto de prueba' },
  })
/** Forma MEDIDA (28-sep, Prisma 6.19.3): lock_timeout vencido en una consulta de modelo — sin `code` ni `meta`. */
const candadoDeModelo = (sqlState = '55P03', mensaje = 'canceling statement due to lock timeout') =>
  new Prisma.PrismaClientUnknownRequestError(
    '\nInvalid `prisma.journalEntry.create()` invocation:\n\n\nError occurred during query execution:\n' +
      `ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${sqlState}", message: "${mensaje}", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
    { clientVersion: '6.19.3' },
  )
const p2028 = () =>
  new Prisma.PrismaClientKnownRequestError('Transaction already closed: la transacción venció.', { code: 'P2028', clientVersion: 'test' })

const L = (ledgerAccountId: string, debitCents: number, creditCents: number) => ({ ledgerAccountId, debitCents, creditCents })
const POLIZA = {
  date: '2026-06-15',
  concept: 'Venta',
  source: JournalEntrySource.MANUAL,
  lines: [L('caja', 11600, 0), L('ventas', 0, 11600)],
}
const FILA = {
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
  lines: [],
}

/** Cliente de la transacción de la póliza: la marca y el negocio se leen con `$queryRaw` (FOR SHARE). */
function txDePoliza({ marcada = false, existente = null as string | null } = {}) {
  return {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn((sql: TemplateStringsArray) =>
      Promise.resolve(sql.join('?').includes('"Organization"') ? [{ ivaMixtoAlgunaVez: marcada }] : [{ organizationId: 'org1' }]),
    ),
    journalEntry: {
      findUnique: jest.fn().mockResolvedValue(existente ? { id: existente } : null),
      aggregate: jest.fn().mockResolvedValue({ _max: { folio: 7 } }),
      create: jest.fn().mockResolvedValue({ id: 'je-1' }),
    },
    accountingPeriodLock: { findUnique: jest.fn().mockResolvedValue(null) },
  }
}

beforeEach(() => {
  ;(resolveScopeOrNull as jest.Mock).mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', venueType: 'RESTAURANT' })
  pm.journalEntry.findUnique.mockResolvedValue(null)
  pm.journalEntry.findUniqueOrThrow.mockResolvedValue(FILA)
  pm.journalEntry.findMany.mockResolvedValue([])
  pm.ledgerAccount.findMany.mockResolvedValue([
    { id: 'caja', isPostable: true, isActive: true },
    { id: 'ventas', isPostable: true, isActive: true },
  ])
  pm.accountingPeriodLock.findUnique.mockResolvedValue(null)
  // Sin restos de `mockImplementationOnce` de otra prueba: cada caso arma su propia secuencia.
  prismaMock.$transaction.mockReset()
})

describe('conReintentoContable (Ruling R11)', () => {
  let conReintentoContable: typeof import('@/services/fiscal/exclusionContable').conReintentoContable

  beforeAll(async () => {
    ;({ conReintentoContable } = await import('@/services/fiscal/exclusionContable'))
  })

  it('abre una transacción Serializable de 15 s (5 s para conseguir conexión) y fija lock_timeout de 5 s antes de trabajar', async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(0) }
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx))
    const trabajo = jest.fn().mockResolvedValue('hecho')

    await expect(conReintentoContable(trabajo)).resolves.toBe('hecho')

    expect(prismaMock.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 15_000,
      maxWait: 5_000,
    })
    expect((tx.$executeRaw.mock.calls[0][0] as string[]).join('')).toContain("lock_timeout = '5s'")
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(trabajo.mock.invocationCallOrder[0])
    expect(trabajo).toHaveBeenCalledWith(tx)
  })

  it('un 40001 se reintenta y el segundo intento devuelve su resultado', async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(0) }
    prismaMock.$transaction.mockRejectedValueOnce(p2010('40001')).mockImplementationOnce(async (cb: any) => cb(tx))

    await expect(conReintentoContable(async () => 'hecho')).resolves.toBe('hecho')
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
  })

  it.each(['40001', '55P03', '40P01'])('%s hasta agotar los 5 intentos ⇒ 409 CONTABILIDAD_OCUPADA, no el error crudo', async sqlState => {
    prismaMock.$transaction.mockRejectedValue(p2010(sqlState))

    const error = await conReintentoContable(async () => 'nunca').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject(OCUPADA)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(5)
  })

  it('un 55P03 de consulta de MODELO (sin código de Prisma) hasta agotar ⇒ 409 CONTABILIDAD_OCUPADA', async () => {
    prismaMock.$transaction.mockRejectedValue(candadoDeModelo())

    await expect(conReintentoContable(async () => 'nunca')).rejects.toMatchObject(OCUPADA)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(5)
  })

  it('otro error desconocido de Prisma pasa tal cual, sin reintentar', async () => {
    const otro = candadoDeModelo('57014', 'canceling statement due to statement timeout')
    prismaMock.$transaction.mockRejectedValue(otro)

    await expect(conReintentoContable(async () => 'nunca')).rejects.toBe(otro)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('P2028 (transacción vencida) ⇒ 409 CONTABILIDAD_OCUPADA sin reintentar', async () => {
    prismaMock.$transaction.mockRejectedValue(p2028())

    await expect(conReintentoContable(async () => 'nunca')).rejects.toMatchObject(OCUPADA)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('cualquier otro error pasa tal cual, sin reintentar (la pausa incluida)', async () => {
    const pausa = new ConflictError(MOTIVO, 'CONTABILIDAD_IVA_MIXTO')
    prismaMock.$transaction.mockRejectedValue(pausa)

    await expect(conReintentoContable(async () => 'nunca')).rejects.toBe(pausa)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })
})

describe('postJournalEntry — reintento y agotamiento (Ruling R11)', () => {
  it.each(['40001', '55P03', '40P01'])('P2010 con %s: reintenta y acaba en la póliza', async sqlState => {
    const tx = txDePoliza()
    prismaMock.$transaction.mockRejectedValueOnce(p2010(sqlState)).mockImplementation(async (cb: any) => cb(tx))

    const poliza = await postJournalEntry('v1', POLIZA, { staffId: 's1' })

    expect(poliza.id).toBe('je-1')
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    expect(tx.journalEntry.create).toHaveBeenCalledTimes(1)
  })

  it('con los reintentos agotados lanza 409 CONTABILIDAD_OCUPADA, no el error crudo', async () => {
    prismaMock.$transaction.mockRejectedValue(p2010('40001'))

    const error = await postJournalEntry('v1', POLIZA, { staffId: 's1' }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject(OCUPADA)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(6) // el intento original + 5 reintentos
  })

  it('un 55P03 de consulta de MODELO (el INSERT de las líneas) hasta agotar ⇒ 409 CONTABILIDAD_OCUPADA, no el error crudo', async () => {
    prismaMock.$transaction.mockRejectedValue(candadoDeModelo())

    const error = await postJournalEntry('v1', POLIZA, { staffId: 's1' }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject(OCUPADA)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(6)
  })

  it('otro error desconocido de Prisma pasa tal cual, sin reintentar', async () => {
    const otro = candadoDeModelo('57014', 'canceling statement due to statement timeout')
    prismaMock.$transaction.mockRejectedValue(otro)

    await expect(postJournalEntry('v1', POLIZA, { staffId: 's1' })).rejects.toBe(otro)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('P2028 (transacción vencida) lanza 409 CONTABILIDAD_OCUPADA sin reintentar', async () => {
    prismaMock.$transaction.mockRejectedValue(p2028())

    await expect(postJournalEntry('v1', POLIZA, { staffId: 's1' })).rejects.toMatchObject(OCUPADA)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('la marca leída bajo candado DENTRO de la transacción sale 409 CONTABILIDAD_IVA_MIXTO, sin reintento y sin crear nada', async () => {
    const tx = txDePoliza({ marcada: true })
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx))

    const error = await postJournalEntry('v1', POLIZA, { staffId: 's1' }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject({ statusCode: 409, code: 'CONTABILIDAD_IVA_MIXTO', message: MOTIVO })
    expect(tx.journalEntry.create).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('la re-comprobación de idempotencia va ANTES de la pausa: una clave ya posteada devuelve su póliza aunque haya marca (Review Focus 3)', async () => {
    const tx = txDePoliza({ marcada: true, existente: 'je-existente' })
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx))

    const poliza = await postJournalEntry(
      'v1',
      { ...POLIZA, source: JournalEntrySource.PAYMENT, idempotencyKey: 'pay:x:v1' },
      { staffId: 's1' },
    )

    expect(poliza.id).toBe('je-1') // la fila existente, releída
    expect(pm.journalEntry.findUniqueOrThrow).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'je-existente' } }))
    expect(tx.$queryRaw).not.toHaveBeenCalled()
    expect(tx.journalEntry.create).not.toHaveBeenCalled()
  })
})

describe('autoPosting — el catch del COGS', () => {
  const REQUERIDOS = ['SALES_REVENUE', 'SALES_RETURN', 'IVA_OUTPUT', 'CASH_RECEIPT', 'BANK_RECEIPT', 'TIPS_PAYABLE', 'PROCESSOR_FEE']

  beforeEach(() => {
    prismaMock.organization.findUnique.mockResolvedValue({ ivaMixtoAlgunaVez: false })
    ;(getMappings as jest.Mock).mockResolvedValue({ mappings: REQUERIDOS.map(m => ({ movementType: m, account: { id: `acc:${m}` } })) })
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
    pm.fiscalEmisor.findFirst.mockResolvedValue(null)
    prismaMock.payment.findMany.mockResolvedValue([])
  })

  it('vuelve a lanzar la pausa por IVA mixto (la corrida lo dice, no lo esconde)', async () => {
    const pausa = new ConflictError(MOTIVO, 'CONTABILIDAD_IVA_MIXTO')
    ;(generateCogsPolicyForVenue as jest.Mock).mockRejectedValue(pausa)

    await expect(generatePoliciesForVenue('v1', { period: '2026-06' })).rejects.toBe(pausa)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('y sigue tragando cualquier otro fallo del COGS (best-effort, sólo avisa)', async () => {
    ;(generateCogsPolicyForVenue as jest.Mock).mockRejectedValue(new Error('sin inventario valuado'))

    await expect(generatePoliciesForVenue('v1', { period: '2026-06' })).resolves.toMatchObject({ posted: 0 })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('COGS falló'))
  })
})
