/**
 * `getAngelPayUserAccountPin` — la ÚNICA vía por la que el PIN de una cuenta
 * AngelPay sale del backend (todas las demás respuestas lo borran en
 * `sanitize()`). Existe para que el superadmin pueda leerlo desde el editor
 * del merchant en vez de entrar a Postgres.
 */

import prisma from '@/utils/prismaClient'
import { getAngelPayUserAccountPin } from '@/services/superadmin/angelpayUserAccount.service'
import { decryptCredentials } from '@/services/superadmin/merchantAccount.service'
import { BadRequestError, NotFoundError } from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { angelPayUserAccount: { findUnique: jest.fn() } },
}))

jest.mock('@/services/superadmin/merchantAccount.service', () => ({
  encryptCredentials: jest.fn(),
  decryptCredentials: jest.fn(),
}))

const findUnique = (prisma as any).angelPayUserAccount.findUnique as jest.Mock
const mockedDecrypt = decryptCredentials as jest.Mock

beforeEach(() => jest.clearAllMocks())

describe('getAngelPayUserAccountPin', () => {
  it('devuelve el PIN en claro cuando existe', async () => {
    findUnique.mockResolvedValue({ pin: '123456', pinEncrypted: null })

    await expect(getAngelPayUserAccountPin('acc-1')).resolves.toBe('123456')
    expect(mockedDecrypt).not.toHaveBeenCalled()
  })

  it('cae al pinEncrypted legacy cuando el campo en claro está vacío', async () => {
    findUnique.mockResolvedValue({ pin: null, pinEncrypted: { encrypted: 'x', iv: 'y' } })
    mockedDecrypt.mockReturnValue('654321')

    await expect(getAngelPayUserAccountPin('acc-1')).resolves.toBe('654321')
  })

  it('devuelve null cuando la cuenta todavía no tiene PIN — no es un error', async () => {
    findUnique.mockResolvedValue({ pin: null, pinEncrypted: null })

    await expect(getAngelPayUserAccountPin('acc-1')).resolves.toBeNull()
  })

  it('404 cuando la cuenta no existe', async () => {
    findUnique.mockResolvedValue(null)

    await expect(getAngelPayUserAccountPin('nope')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('un PIN legacy ilegible NO se hace pasar por "sin PIN"', async () => {
    // Devolver null aquí mandaría al operador a teclear un PIN nuevo y a
    // tumbar la sesión AngelPay que sí está viva.
    findUnique.mockResolvedValue({ pin: null, pinEncrypted: { encrypted: 'roto', iv: 'z' } })
    mockedDecrypt.mockImplementation(() => {
      throw new Error('bad key')
    })

    await expect(getAngelPayUserAccountPin('acc-1')).rejects.toBeInstanceOf(BadRequestError)
  })
})
