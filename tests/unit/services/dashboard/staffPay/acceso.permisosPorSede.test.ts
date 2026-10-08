// tests/unit/services/dashboard/staffPay/acceso.permisosPorSede.test.ts — fase 3, B13 ronda 1 (R4): `permisosPorSede` sólo trata
// como «sin permiso» un sin-acceso REAL (lo que contesta la resolución de acceso cuando la persona no está en la sede); un error
// de la base se propaga, para que una caída no se lea como «esta persona no ve nada».
const mockGetUserAccess = jest.fn()
jest.mock('@/services/access/access.service', () => ({
  getUserAccess: (...a: unknown[]) => mockGetUserAccess(...a),
  hasPermission: (access: { corePermissions: string[] }, p: string) => access.corePermissions.includes(p),
}))

import { permisosPorSede } from '@/services/dashboard/staffPay/acceso'

describe('permisosPorSede (R4)', () => {
  beforeEach(() => mockGetUserAccess.mockReset())

  it('cada sede con los permisos que tiene; sin acceso real (no está en la sede, o la sede no existe) ⇒ vacío', async () => {
    mockGetUserAccess.mockImplementation(async (_u: string, v: string) => {
      if (v === 'b') throw new Error('User u1 has no access to venue b')
      if (v === 'c') throw new Error('Venue c not found')
      return { corePermissions: ['staffpay:read'] }
    })
    const r = await permisosPorSede('u1', ['c', 'a', 'b'], ['staffpay:read', 'staffpay:close'])
    expect([...r.keys()]).toEqual(['a', 'b', 'c'])
    expect([...r.get('a')!]).toEqual(['staffpay:read'])
    expect(r.get('b')!.size).toBe(0)
    expect(r.get('c')!.size).toBe(0)
  })

  it('un error de la base (o cualquier otro que no sea «sin acceso») se propaga', async () => {
    const caida = Object.assign(new Error("Can't reach database server"), { code: 'P1001', name: 'PrismaClientInitializationError' })
    mockGetUserAccess.mockRejectedValue(caida)
    await expect(permisosPorSede('u1', ['a'], ['staffpay:read'])).rejects.toBe(caida)
    mockGetUserAccess.mockRejectedValue(new TypeError('x is undefined'))
    await expect(permisosPorSede('u1', ['a'], ['staffpay:read'])).rejects.toThrow('x is undefined')
  })
})
