/**
 * Unit tests (mock-first) para Cuentas por pagar (antigüedad de saldos a proveedores, Capa B).
 *  - saldo pendiente = total − pagado; agrupa por proveedor; reparte por cubetas de antigüedad
 *    (0-30 / 31-60 / 61-90 / 90+) según días desde la emisión a la fecha de corte;
 *  - excluye PAID (no entran al query); fecha inválida → 400; sin RFC → needsFiscalSetup.
 */
import { BadRequestError } from '../../../src/errors/AppError'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { expense: { findMany: jest.fn() } },
}))
jest.mock('../../../src/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))

import prisma from '../../../src/utils/prismaClient'
import { resolveScopeOrNull } from '../../../src/services/fiscal/chartOfAccounts.service'
import { getAccountsPayableAging } from '../../../src/services/fiscal/accountsPayable.service'

const p = prisma as unknown as { expense: { findMany: jest.Mock } }
const mScope = resolveScopeOrNull as jest.Mock

const AS_OF = '2026-06-30' // corte fijo para que la antigüedad sea determinista

// Gasto: el saldo pendiente es total − paid; fechaEmision define la cubeta.
const exp = (over: Record<string, unknown> = {}) => ({
  proveedorRfc: 'AAA010101AAA',
  proveedorNombre: 'Proveedor SA',
  totalCents: 116_00,
  paidCents: 0,
  fechaEmision: new Date('2026-06-20T12:00:00Z'), // ~10 días → corriente
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  mScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', venueType: 'AUTO_SERVICE' })
  p.expense.findMany.mockResolvedValue([])
})

it('fecha inválida → BadRequestError', async () => {
  await expect(getAccountsPayableAging('v1', '2026-13-99')).rejects.toThrow(BadRequestError)
})

it('sin RFC → needsFiscalSetup', async () => {
  mScope.mockResolvedValue(null)
  const r = await getAccountsPayableAging('v1', AS_OF)
  expect(r.needsFiscalSetup).toBe(true)
  expect(p.expense.findMany).not.toHaveBeenCalled()
})

it('el query pide solo INGRESO + REGISTERED + UNPAID/PARTIALLY_PAID del RFC', async () => {
  await getAccountsPayableAging('v1', AS_OF)
  const where = p.expense.findMany.mock.calls[0][0].where
  expect(where).toMatchObject({
    organizationId: 'org1',
    rfc: 'EKU9003173C9',
    status: 'REGISTERED',
    comprobanteTipo: 'INGRESO',
    paymentStatus: { in: ['UNPAID', 'PARTIALLY_PAID'] },
  })
})

it('agrupa por proveedor y reparte por cubeta de antigüedad', async () => {
  p.expense.findMany.mockResolvedValue([
    exp({ totalCents: 100_00, fechaEmision: new Date('2026-06-20T12:00:00Z') }), // 10 días → corriente
    exp({ totalCents: 200_00, fechaEmision: new Date('2026-05-15T12:00:00Z') }), // ~46 días → 31-60
    exp({ proveedorRfc: 'BBB020202BB2', proveedorNombre: 'Otro', totalCents: 500_00, fechaEmision: new Date('2026-02-01T12:00:00Z') }), // ~149 días → 90+
  ])
  const r = await getAccountsPayableAging('v1', AS_OF)
  expect(r.asOf).toBe(AS_OF)
  expect(r.suppliers).toHaveLength(2)
  // ordenado por saldo desc → BBB (500) primero
  expect(r.suppliers[0].proveedorRfc).toBe('BBB020202BB2')
  expect(r.suppliers[0].mas90Cents).toBe(500_00)
  const aaa = r.suppliers.find(s => s.proveedorRfc === 'AAA010101AAA')!
  expect(aaa.comprobantes).toBe(2)
  expect(aaa.pendienteCents).toBe(300_00)
  expect(aaa.corrienteCents).toBe(100_00)
  expect(aaa.d31_60Cents).toBe(200_00)
  expect(r.totals.pendienteCents).toBe(800_00)
  expect(r.totals.mas90Cents).toBe(500_00)
  expect(r.totals.proveedores).toBe(2)
})

it('saldo pendiente = total − pagado (parcial)', async () => {
  p.expense.findMany.mockResolvedValue([exp({ totalCents: 100_00, paidCents: 40_00 })])
  const r = await getAccountsPayableAging('v1', AS_OF)
  expect(r.totals.pendienteCents).toBe(60_00)
})

it('ignora comprobantes cuyo pagado ya cubre el total (pendiente ≤ 0)', async () => {
  p.expense.findMany.mockResolvedValue([exp({ totalCents: 100_00, paidCents: 100_00 })])
  const r = await getAccountsPayableAging('v1', AS_OF)
  expect(r.suppliers).toHaveLength(0)
  expect(r.totals.pendienteCents).toBe(0)
})
