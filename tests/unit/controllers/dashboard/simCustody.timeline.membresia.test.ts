/**
 * Codex ronda 4 (25-sep): el timeline de custodia de SIMs caía, cuando la sesión no es superadmin real, a
 * `requireOrgMembership`, que NO exigía asignación ni persona activas. Una fila SUPERADMIN (o de gerente)
 * dada de baja volvía a autorizar la lectura. Además decía devolver «el rol más alto» y devolvía el más viejo.
 */
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/serialized-inventory/custody.service', () => ({
  ...jest.requireActual('@/services/serialized-inventory/custody.service'),
}))

import { listEvents } from '@/controllers/dashboard/simCustody.dashboard.controller'

const ORG = 'org-1'

function correr(authContext: Record<string, unknown>) {
  const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) }
  const next = jest.fn()
  const req: any = { authContext, params: { orgId: ORG, serialNumber: '8952' }, query: {} }
  return Promise.resolve(listEvents(req, res, next)).then(() => ({ res, next }))
}
const prohibido = (r: { res: any }) => r.res.status.mock.calls.some((c: unknown[]) => c[0] === 403)

beforeEach(() => jest.clearAllMocks())

// La base de este caso: la persona sólo tiene filas DADAS DE BAJA en la organización. Los dobles honran el
// `where`: una consulta que no exija `active: true` las encuentra; una que lo exija, no.
function soloFilasDadasDeBaja(rolHistorico: string) {
  const filas = [{ role: rolHistorico, active: false }]
  const honra = (where: any) => (where?.active === true ? [] : filas)
  prismaMock.staffVenue.findFirst.mockImplementation((({ where }: any) =>
    Promise.resolve(where?.role === 'SUPERADMIN' ? null : (honra(where)[0] ?? null))) as any)
  prismaMock.staffVenue.findMany.mockImplementation((({ where }: any) => Promise.resolve(honra(where))) as any)
}

it('🔴 una fila de GERENTE dada de baja no deja leer el timeline', async () => {
  soloFilasDadasDeBaja('MANAGER')
  expect(prohibido(await correr({ userId: 'ex', orgId: ORG, role: 'MANAGER' }))).toBe(true)
})

it('🔴 una fila SUPERADMIN dada de baja tampoco (no es superadmin real ni membresía vigente)', async () => {
  soloFilasDadasDeBaja('SUPERADMIN')
  expect(prohibido(await correr({ userId: 'ex-sa', orgId: ORG, role: 'MANAGER' }))).toBe(true)
})

it('usa el rol MÁS ALTO de las asignaciones activas (un gerente que también es cajero entra)', async () => {
  prismaMock.staffVenue.findFirst.mockResolvedValue(null as never)
  prismaMock.staffVenue.findMany.mockResolvedValue([{ role: 'CASHIER' }, { role: 'MANAGER' }] as never)
  const r = await correr({ userId: 'u', orgId: ORG, role: 'CASHIER' })
  expect(prohibido(r)).toBe(false)
  expect(prismaMock.staffVenue.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ active: true, staff: { active: true } }) }),
  )
})
