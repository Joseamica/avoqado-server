// tests/unit/services/dashboard/staffPay/foto.test.ts — fase 3, B13 (revisión de B12 #1): la foto de una lectura lleva el
// timeout que le pide quien la usa (la vista previa del cierre, el de su cierre) y un vencimiento sale como 409 con texto en
// español, nunca como el P2028 crudo (un 500).
import { prismaMock } from '@tests/__helpers__/setup'
import { enUnaFoto, MENSAJE_LECTURA_VENCIDA } from '@/services/dashboard/staffPay/foto'

const tx = { $executeRaw: jest.fn().mockResolvedValue(0), $executeRawUnsafe: jest.fn().mockResolvedValue(0) }

describe('enUnaFoto: timeout y vencimiento', () => {
  beforeEach(() => {
    prismaMock.$transaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) as any
  })

  it('sin pedir otro, 60 s; con `timeoutMs`, ése (REPEATABLE READ de sólo lectura en los dos)', async () => {
    await enUnaFoto(async () => 1)
    expect(prismaMock.$transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'RepeatableRead', timeout: 60_000 }),
    )
    await enUnaFoto(async () => 1, { timeoutMs: 120_000 })
    expect(prismaMock.$transaction).toHaveBeenLastCalledWith(expect.any(Function), expect.objectContaining({ timeout: 120_000 }))
  })

  it('una foto vencida (P2028) es 409 LECTURA_VENCIDA en español; cualquier otro error pasa tal cual', async () => {
    const vencida = Object.assign(new Error('Transaction already closed: A query cannot be executed on an expired transaction'), {
      code: 'P2028',
    })
    prismaMock.$transaction = jest.fn().mockRejectedValue(vencida) as any
    await expect(enUnaFoto(async () => 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'LECTURA_VENCIDA',
      message: MENSAJE_LECTURA_VENCIDA,
    })
    expect(MENSAJE_LECTURA_VENCIDA).toMatch(/^La consulta tardó demasiado/)
    const otro = Object.assign(new Error('otra cosa'), { code: 'P2034' })
    prismaMock.$transaction = jest.fn().mockRejectedValue(otro) as any
    await expect(enUnaFoto(async () => 1)).rejects.toBe(otro)
  })
})
