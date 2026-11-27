/** Una sola regla para ligar una cuenta con Google (hz:6bfcd3a1:D1). */
const updateMany = jest.fn()
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { staff: { updateMany: (...a: any[]) => updateMany(...a) } },
}))
const logAction = jest.fn()
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({ logAction: (...a: any[]) => logAction(...a) }))
const warn = jest.fn()
jest.mock('../../../../src/config/logger', () => ({ __esModule: true, default: { warn: (...a: any[]) => warn(...a), info: jest.fn() } }))

import { ligarCuentaConGoogle, type CuentaParaLigar } from '../../../../src/services/auth/google/ligarCuentaConGoogle'

const cuenta = (o: Partial<CuentaParaLigar> = {}): CuentaParaLigar => ({
  id: 'staff-1',
  email: 'ana@gmail.com',
  active: true,
  googleId: null,
  photoUrl: null,
  emailVerified: true,
  password: 'hash',
  ...o,
})

describe('ligarCuentaConGoogle', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    updateMany.mockResolvedValue({ count: 1 })
  })

  it('liga googleId vacío y no pisa uno existente', async () => {
    await ligarCuentaConGoogle(cuenta(), { sub: 'g-1' }, 'org-1')
    expect(updateMany.mock.calls[0][0].data).toEqual(expect.objectContaining({ googleId: 'g-1' }))

    updateMany.mockClear()
    await ligarCuentaConGoogle(cuenta({ googleId: 'g-viejo' }), { sub: 'g-2' }, 'org-1')
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('pone la foto sólo si no hay', async () => {
    await ligarCuentaConGoogle(cuenta({ googleId: 'g-1' }), { sub: 'g-1', picture: 'https://x.test/a.png' }, null)
    expect(updateMany.mock.calls[0][0].data).toEqual(expect.objectContaining({ photoUrl: 'https://x.test/a.png' }))

    updateMany.mockClear()
    await ligarCuentaConGoogle(
      cuenta({ googleId: 'g-1', photoUrl: 'https://x.test/propia.png' }),
      { sub: 'g-1', picture: 'https://x.test/a.png' },
      null,
    )
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('cuenta sin verificar con contraseña: verifica, anula y registra con organizationId', async () => {
    const r = await ligarCuentaConGoogle(cuenta({ emailVerified: false, password: 'hash-intruso' }), { sub: 'g-1' }, 'org-1')
    expect(r).toEqual({ aplicada: true, contrasenaAnulada: true })
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'staff-1', googleId: null, emailVerified: false, password: 'hash-intruso', email: 'ana@gmail.com', active: true },
      data: expect.objectContaining({ googleId: 'g-1', emailVerified: true, password: null, lastLoginAt: expect.any(Date) }),
    })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'STAFF_PASSWORD_INVALIDATED_BY_GOOGLE',
        organizationId: 'org-1',
        entityId: 'staff-1',
        data: { reason: 'unverified_account_verified_by_google' },
      }),
    )
    expect(warn).toHaveBeenCalled()
  })

  it('con googleId existente y sin verificar: verifica y anula la contraseña, sin pisar el googleId', async () => {
    const r = await ligarCuentaConGoogle(
      cuenta({ googleId: 'g-viejo', emailVerified: false, password: 'hash' }),
      { sub: 'g-otro' },
      'org-1',
    )
    expect(r).toEqual({ aplicada: true, contrasenaAnulada: true })
    const { data } = updateMany.mock.calls[0][0]
    expect(data.googleId).toBeUndefined()
    expect(data).toEqual(expect.objectContaining({ emailVerified: true, password: null }))
  })

  it('ya ligada y verificada: no escribe', async () => {
    const r = await ligarCuentaConGoogle(cuenta({ googleId: 'g-1' }), { sub: 'g-1' }, 'org-1')
    expect(r).toEqual({ aplicada: true, contrasenaAnulada: false })
    expect(updateMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('la cuenta cambió entre la lectura y la escritura (count 0): aplicada false y sin registro', async () => {
    updateMany.mockResolvedValue({ count: 0 })
    const r = await ligarCuentaConGoogle(cuenta({ emailVerified: false }), { sub: 'g-1' }, 'org-1')
    expect(r).toEqual({ aplicada: false, contrasenaAnulada: false })
    expect(logAction).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('el correo cambió entre la lectura y la escritura: la escritura condiciona el correo leído y que siga activa', async () => {
    updateMany.mockResolvedValue({ count: 0 })
    const r = await ligarCuentaConGoogle(cuenta({ emailVerified: false }), { sub: 'g-1' }, 'org-1')
    expect(updateMany.mock.calls[0][0].where).toEqual(expect.objectContaining({ email: 'ana@gmail.com', active: true }))
    expect(r).toEqual({ aplicada: false, contrasenaAnulada: false })
  })

  it('siempreEscribir: ya ligada y verificada igual pasa por el candado (sólo lastLoginAt)', async () => {
    const r = await ligarCuentaConGoogle(cuenta({ googleId: 'g-1' }), { sub: 'g-1' }, 'org-1', { siempreEscribir: true })
    expect(r).toEqual({ aplicada: true, contrasenaAnulada: false })
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'staff-1', googleId: 'g-1', emailVerified: true, password: 'hash', email: 'ana@gmail.com', active: true },
      data: { lastLoginAt: expect.any(Date) },
    })

    updateMany.mockResolvedValue({ count: 0 })
    await expect(ligarCuentaConGoogle(cuenta({ googleId: 'g-1' }), { sub: 'g-1' }, 'org-1', { siempreEscribir: true })).resolves.toEqual({
      aplicada: false,
      contrasenaAnulada: false,
    })
  })
})
