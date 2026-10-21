/**
 * IVA por producto, plan 6b (Codex código r1 #8, Ruling CX-8): el `catch` exterior de la puesta al día no imprime el objeto del error.
 * `new URL(DATABASE_URL)` lanza con la URL entera en `input` (usuario y contraseña): la salida lleva un mensaje fijo y el nombre/código.
 */
import { inspect } from 'util'

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { $queryRaw: jest.fn(), $disconnect: jest.fn() } }))

import { ejecutar } from '../../../../scripts/iva/puesta-al-dia-6b'

it('CX-8 · una DATABASE_URL inválida con contraseña: la salida no la contiene y dice el código', async () => {
  const antes = { url: process.env.DATABASE_URL, argv: process.argv, exitCode: process.exitCode }
  process.env.DATABASE_URL = 'postgres://dueno:S3cretaFicticia@ho st:5432/base' // el espacio la hace inválida: `new URL` lanza
  process.argv = ['node', 'puesta-al-dia-6b.ts', '--dry-run']
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
  try {
    await ejecutar()
    const impreso = [...error.mock.calls, ...log.mock.calls].map(args => args.map(a => inspect(a, { depth: 5 })).join(' ')).join('\n')
    expect(error).toHaveBeenCalled() // sin esto, «no la contiene» pasaría en vacío
    expect(impreso).not.toContain('S3cretaFicticia')
    expect(impreso).not.toContain('dueno')
    expect(impreso).toContain('ERR_INVALID_URL')
    expect(process.exitCode).toBe(1)
  } finally {
    error.mockRestore()
    log.mockRestore()
    process.env.DATABASE_URL = antes.url
    process.argv = antes.argv
    process.exitCode = antes.exitCode
  }
})
