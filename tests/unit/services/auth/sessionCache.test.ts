// tests/unit/services/auth/sessionCache.test.ts
import { isSessionAliveCached } from '@/services/auth/sessionCache'
import * as sessionService from '@/services/auth/session.service'
import * as redis from '@/services/auth/redisClient'

jest.mock('@/services/auth/session.service')
jest.mock('@/services/auth/redisClient')

describe('sessionCache', () => {
  beforeEach(() => jest.clearAllMocks())

  it('con Redis caído consulta la base y NO acepta por defecto', async () => {
    ;(redis.get as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'))
    ;(sessionService.isSessionAlive as jest.Mock).mockResolvedValue(false)
    await expect(isSessionAliveCached('s1')).resolves.toBe(false)
    expect(sessionService.isSessionAlive).toHaveBeenCalledWith('s1')
  })

  it('si Redis Y la base fallan, la peticion falla (nunca abre)', async () => {
    ;(redis.get as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'))
    ;(sessionService.isSessionAlive as jest.Mock).mockRejectedValue(new Error('db down'))
    await expect(isSessionAliveCached('s1')).rejects.toThrow()
  })

  it('un tombstone gana sobre una lectura ACTIVE en vuelo', async () => {
    ;(redis.get as jest.Mock).mockResolvedValue('revoked')
    await expect(isSessionAliveCached('s1')).resolves.toBe(false)
    expect(sessionService.isSessionAlive).not.toHaveBeenCalled()
  })
})
