/**
 * D24, opción C (FLAUTAS_C, 21-nov): abrir un estado de cuenta GUARDA la decisión de las líneas que esperaban su comisión sólo si
 * quien lo abre tiene `accounting:reconcile` y no está en el modo de soporte de sólo lectura (que deja pasar los GET). Los demás la
 * ven calculada al vuelo. El servicio se prueba contra Postgres en `costoPendienteEnPolizasYConciliacion.integration.test.ts`.
 */
const mockDetail = jest.fn()
const mockPermiso = jest.fn()
jest.mock('../../../../src/services/dashboard/bankReconciliation.service', () => ({
  getStatementDetail: (...a: unknown[]) => mockDetail(...a),
}))
jest.mock('../../../../src/middlewares/permissionFlag.middleware', () => ({
  tienePermisoEnVenue: (...a: unknown[]) => mockPermiso(...a),
}))

import { getBankStatement } from '../../../../src/controllers/dashboard/bankReconciliation.controller'

const abrir = async (authContext: Record<string, unknown>) => {
  const req = { params: { venueId: 'v1', statementId: 's1' }, authContext } as never
  const json = jest.fn()
  const res = { status: jest.fn(() => ({ json })) } as never
  const next = jest.fn()
  await getBankStatement(req, res, next)
  expect(next).not.toHaveBeenCalled()
  return mockDetail.mock.calls[mockDetail.mock.calls.length - 1]
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDetail.mockResolvedValue({ id: 's1', lines: [] })
})

describe('getBankStatement · D24 opción C: quién guarda la decisión de las líneas que esperaban su comisión', () => {
  it('con accounting:reconcile: la guarda, a su nombre', async () => {
    mockPermiso.mockResolvedValue(true)
    expect(await abrir({ userId: 'staff-1' })).toEqual(['v1', 's1', { abiertoPor: 'staff-1', puedeGuardar: true }])
    expect(mockPermiso).toHaveBeenCalledWith(expect.anything(), 'accounting:reconcile')
  })

  it('sólo con accounting:read: la ve al vuelo, no la guarda', async () => {
    mockPermiso.mockResolvedValue(false)
    expect(await abrir({ userId: 'staff-2' })).toEqual(['v1', 's1', { abiertoPor: 'staff-2', puedeGuardar: false }])
  })

  it('soporte en modo de sólo lectura (impersonando): nunca guarda, aunque el rol efectivo tenga el permiso', async () => {
    mockPermiso.mockResolvedValue(true)
    expect(await abrir({ userId: 'superadmin-1', isImpersonating: true })).toEqual([
      'v1',
      's1',
      { abiertoPor: 'superadmin-1', puedeGuardar: false },
    ])
  })
})
