import { resolveCommandTerminal, issueCommandCredential, llaveCoincide, veredictoPuerta } from '@/services/tpv/command-credential.service'
import prisma from '@/utils/prismaClient'
import { createHash } from 'crypto'
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { terminal: { findFirst: jest.fn(), update: jest.fn() }, tpvCommandQueue: { findFirst: jest.fn() } },
}))
const terminal = {
  id: 't1',
  venueId: 'v1',
  serialNumber: 'AVQD-123',
  type: 'TPV_ANDROID',
  commandTokenHash: createHash('sha256').update('a'.repeat(64)).digest('hex'),
}
beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.terminal.findFirst as jest.Mock).mockResolvedValue(terminal)
})
it('P1 serial alone never grants command access', async () => {
  expect(await resolveCommandTerminal({ headers: {} } as any, '123')).toBeNull()
})
it('device secret works independently of the employee PIN session and venue change', async () => {
  expect(await resolveCommandTerminal({ headers: { 'x-tpv-command-token': 'a'.repeat(64) } } as any, '123')).toEqual(terminal)
})
it('rejects a forged secret even with the correct serial', async () => {
  expect(await resolveCommandTerminal({ headers: { 'x-tpv-command-token': 'b'.repeat(64) } } as any, '123')).toBeNull()
})
it('legacy authenticated APK must match signed terminal serial and venue', async () => {
  expect(
    await resolveCommandTerminal({ headers: {}, authContext: { terminalSerialNumber: '999', venueId: 'v1' } } as any, '123'),
  ).toBeNull()
  expect(await resolveCommandTerminal({ headers: {}, authContext: { terminalSerialNumber: '123', venueId: 'v1' } } as any, '123')).toEqual(
    terminal,
  )
})
it('stores only the digest of an issued device credential', async () => {
  const token = await issueCommandCredential('t1')
  expect(token).toMatch(/^[a-f0-9]{64}$/)
  expect(prisma.terminal.update).toHaveBeenCalledWith({
    where: { id: 't1' },
    data: { commandTokenHash: createHash('sha256').update(token).digest('hex') },
  })
})

it('legacy signed origin session survives an active migration, but serial alone still does not', async () => {
  ;(prisma.tpvCommandQueue.findFirst as jest.Mock).mockResolvedValue({ id: 'migration1' })
  expect(await resolveCommandTerminal({ headers: {}, authContext: { terminalSerialNumber: '123', venueId: 'old' } } as any, '123')).toEqual(
    terminal,
  )
  ;(prisma.tpvCommandQueue.findFirst as jest.Mock).mockResolvedValue(null)
  expect(
    await resolveCommandTerminal({ headers: {}, authContext: { terminalSerialNumber: '123', venueId: 'old' } } as any, '123'),
  ).toBeNull()
})
it('enrollment retries keep the same device credential instead of rotating another request', async () => {
  expect(await issueCommandCredential('t1', 'a'.repeat(64))).toBe('a'.repeat(64))
  expect(prisma.terminal.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { commandTokenHash: terminal.commandTokenHash } })
})

// D32 etapa 1 (sombra): el veredicto de la puerta /config usa la MISMA regla de «llave válida» que los comandos.
describe('D32 · veredicto de la puerta /config (sólo se anota, nunca niega)', () => {
  const hash = terminal.commandTokenHash
  it('CON_LLAVE: trae la llave que coincide', () => {
    expect(veredictoPuerta(hash, 'a'.repeat(64))).toEqual({ veredicto: 'CON_LLAVE', habriaNegado: false, llaveSinAlta: false })
  })
  it('LLAVE_EQUIVOCADA: otra llave, mal formada, en mayúsculas, vacía o repetida', () => {
    for (const enc of ['b'.repeat(64), 'zz', 'A'.repeat(64), '', ['a'.repeat(64), 'a'.repeat(64)], 'a'.repeat(63)]) {
      expect(veredictoPuerta(hash, enc)).toEqual({ veredicto: 'LLAVE_EQUIVOCADA', habriaNegado: true, llaveSinAlta: false })
    }
  })
  it('SIN_LLAVE: la terminal tiene alta y no viene encabezado', () => {
    expect(veredictoPuerta(hash, undefined)).toEqual({ veredicto: 'SIN_LLAVE', habriaNegado: true, llaveSinAlta: false })
  })
  it('SIN_ALTA: la terminal no tiene llave guardada; nunca habría negado', () => {
    for (const h of [null, undefined, '']) {
      expect(veredictoPuerta(h, undefined)).toEqual({ veredicto: 'SIN_ALTA', habriaNegado: false, llaveSinAlta: false })
      expect(veredictoPuerta(h, 'a'.repeat(64))).toEqual({ veredicto: 'SIN_ALTA', habriaNegado: false, llaveSinAlta: true })
    }
  })
  it('un hash guardado corrupto no lanza: la llave no coincide', () => {
    expect(llaveCoincide('no-es-hex', 'a'.repeat(64))).toBe(false)
    expect(veredictoPuerta('no-es-hex', 'a'.repeat(64)).veredicto).toBe('LLAVE_EQUIVOCADA')
  })
  it('llaveCoincide es la misma regla que usa resolveCommandTerminal', async () => {
    expect(llaveCoincide(hash, 'a'.repeat(64))).toBe(true)
    expect(llaveCoincide(hash, 'b'.repeat(64))).toBe(false)
    expect(await resolveCommandTerminal({ headers: { 'x-tpv-command-token': 'a'.repeat(64) } } as any, '123')).toEqual(terminal)
    expect(await resolveCommandTerminal({ headers: { 'x-tpv-command-token': 'b'.repeat(64) } } as any, '123')).toBeNull()
  })
})
