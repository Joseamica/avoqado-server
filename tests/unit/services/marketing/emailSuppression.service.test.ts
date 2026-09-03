// tests/unit/services/marketing/emailSuppression.service.test.ts
import { normalizeEmail, isSuppressed, recordSuppression, filtrarSuprimidos } from '@/services/marketing/emailSuppression.service'
import type { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { emailSuppression: { findUnique: jest.fn(), upsert: jest.fn() } },
}))

beforeEach(() => jest.clearAllMocks())

describe('normalizeEmail', () => {
  it('baja a minúsculas y recorta espacios', () => {
    expect(normalizeEmail('  Ana@Ejemplo.MX ')).toBe('ana@ejemplo.mx')
  })

  it('🔴 NO aplica trucos por proveedor: los puntos de Gmail se conservan', () => {
    // Quitarlos suprimiría a una persona DISTINTA de la que rebotó.
    expect(normalizeEmail('a.n.a@gmail.com')).toBe('a.n.a@gmail.com')
  })

  it('🔴 tampoco recorta la etiqueta de más', () => {
    expect(normalizeEmail('ana+promos@gmail.com')).toBe('ana+promos@gmail.com')
  })
})

describe('isSuppressed', () => {
  it('consulta con el email YA normalizado (forma del where)', async () => {
    ;(prisma.emailSuppression.findUnique as jest.Mock).mockResolvedValue(null)
    await isSuppressed('  Ana@Ejemplo.MX ')
    expect(prisma.emailSuppression.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { email: 'ana@ejemplo.mx' } }))
  })
})

describe('filtrarSuprimidos', () => {
  function crearTxMock() {
    return {
      emailSuppression: { findMany: jest.fn() },
    } as unknown as Prisma.TransactionClient & { emailSuppression: { findMany: jest.Mock } }
  }

  it('con lista vacía NO toca la base: encolar una campaña con audiencia vacía no cuesta una consulta', async () => {
    const tx = crearTxMock()
    const resultado = await filtrarSuprimidos(tx, [])
    expect(resultado).toEqual(new Set())
    expect(tx.emailSuppression.findMany).not.toHaveBeenCalled()
  })

  it('normaliza los emails de entrada ANTES de consultar (forma del where)', async () => {
    const tx = crearTxMock()
    tx.emailSuppression.findMany.mockResolvedValue([])
    await filtrarSuprimidos(tx, ['  Ana@Ejemplo.MX ', 'Beto@Otro.com'])
    expect(tx.emailSuppression.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { in: ['ana@ejemplo.mx', 'beto@otro.com'] } },
        select: { email: true },
      }),
    )
  })

  it('devuelve el conjunto de emails NORMALIZADOS suprimidos, en UNA sola consulta', async () => {
    const tx = crearTxMock()
    tx.emailSuppression.findMany.mockResolvedValue([{ email: 'ana@ejemplo.mx' }])
    const resultado = await filtrarSuprimidos(tx, ['Ana@Ejemplo.MX', 'beto@otro.com', 'carla@otro.com'])
    expect(resultado).toEqual(new Set(['ana@ejemplo.mx']))
    expect(tx.emailSuppression.findMany).toHaveBeenCalledTimes(1)
  })
})

describe('recordSuppression', () => {
  it('es idempotente: incrementa occurrences y mueve lastSeenAt', async () => {
    ;(prisma.emailSuppression.upsert as jest.Mock).mockResolvedValue({})
    await recordSuppression('Ana@Ejemplo.MX', 'HARD_BOUNCE')
    expect(prisma.emailSuppression.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'ana@ejemplo.mx' },
        update: expect.objectContaining({ occurrences: { increment: 1 } }),
      }),
    )
  })
})
