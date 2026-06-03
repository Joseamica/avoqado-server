const db = { staff: { findUnique: jest.fn(), update: jest.fn() } }
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: db }))
const bcrypt = { compare: jest.fn() }
jest.mock('bcrypt', () => bcrypt)

import { authenticateForMcp, McpLoginError } from '../../../src/mcp/oauth/credentials'

beforeEach(() => jest.clearAllMocks())

const baseStaff = { id: 's1', password: 'hash', active: true, emailVerified: true, lockedUntil: null, failedLoginAttempts: 0 }

it('returns staffId on a correct password', async () => {
  db.staff.findUnique.mockResolvedValue(baseStaff)
  bcrypt.compare.mockResolvedValue(true)
  expect(await authenticateForMcp('A@x.com', 'pw')).toBe('s1')
  expect(db.staff.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { email: 'a@x.com' } }))
})

it('rejects a wrong password and counts the attempt', async () => {
  db.staff.findUnique.mockResolvedValue(baseStaff)
  bcrypt.compare.mockResolvedValue(false)
  await expect(authenticateForMcp('a@x.com', 'pw')).rejects.toBeInstanceOf(McpLoginError)
  expect(db.staff.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ failedLoginAttempts: 1 }) }))
})

it('rejects an unknown email without leaking which part was wrong', async () => {
  db.staff.findUnique.mockResolvedValue(null)
  await expect(authenticateForMcp('a@x.com', 'pw')).rejects.toThrow(/incorrect/i)
})

it('rejects a locked account', async () => {
  db.staff.findUnique.mockResolvedValue({ ...baseStaff, lockedUntil: new Date(Date.now() + 60000) })
  await expect(authenticateForMcp('a@x.com', 'pw')).rejects.toThrow(/locked/i)
})

it('rejects an unverified account', async () => {
  db.staff.findUnique.mockResolvedValue({ ...baseStaff, emailVerified: false })
  bcrypt.compare.mockResolvedValue(true)
  await expect(authenticateForMcp('a@x.com', 'pw')).rejects.toThrow(/verify/i)
})
