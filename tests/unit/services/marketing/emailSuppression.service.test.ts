// tests/unit/services/marketing/emailSuppression.service.test.ts
import { normalizeEmail, isSuppressed, recordSuppression } from '@/services/marketing/emailSuppression.service'
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
