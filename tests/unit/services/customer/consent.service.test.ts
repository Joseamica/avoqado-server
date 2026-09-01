jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import { grantMarketingConsent, revokeMarketingConsent, getCurrentPrivacyNotice } from '@/services/customer/consent.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    privacyNoticeVersion: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}))

// tx falso que registra todas las llamadas — la FORMA de las consultas es lo que se prueba
function makeTx(overrides: Record<string, any> = {}) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'cust1', venueId: 'venueA' }]),
    privacyNoticeVersion: { findFirst: jest.fn().mockResolvedValue({ id: 'not1', venueId: 'venueA' }) },
    consentEvent: {
      findFirst: jest.fn().mockResolvedValue({ seq: 2 }),
      create: jest.fn().mockResolvedValue({}),
    },
    customer: { update: jest.fn().mockResolvedValue({}) },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    ...overrides,
  }
}

let makeTxDefault = makeTx()

beforeEach(() => {
  jest.clearAllMocks()
  makeTxDefault = makeTx()
  ;(prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(makeTxDefault))
})

describe('grantMarketingConsent', () => {
  it('escribe evento seq+1, cache y ActivityLog EN LA MISMA transacción', async () => {
    await grantMarketingConsent({ venueId: 'venueA', customerId: 'cust1', channel: 'FORM_STAFF', actorStaffId: 'staff1' })
    expect(makeTxDefault.consentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seq: 3, action: 'GRANTED', noticeVersionId: 'not1', venueId: 'venueA' }) }),
    )
    expect(makeTxDefault.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cust1' }, data: { marketingConsent: true } }),
    )
    // Hallazgo #5 de la ronda final: `noticeVersionId: 'not1'` sólo prueba lo que el mock
    // DEVUELVE — un mock que devuelve esa fila pase lo que se le pida sigue verde aunque se
    // quite el `where`. Se afirma la FORMA de la consulta que resuelve el aviso: debe filtrar
    // por el venueId del PARÁMETRO, no traer el aviso de cualquier otro venue.
    expect(makeTxDefault.privacyNoticeVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: 'venueA' }) }),
    )
    // dentro del tx: evidencia legal atómica — el payload completo, no sólo "se llamó"
    expect(makeTxDefault.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'MARKETING_CONSENT_GRANTED',
          entity: 'Customer',
          entityId: 'cust1',
          staffId: 'staff1',
          venueId: 'venueA',
          data: expect.objectContaining({ channel: 'FORM_STAFF', seq: 3 }),
        }),
      }),
    )
  })

  it('rechaza si el venue NO tiene aviso de privacidad', async () => {
    makeTxDefault = makeTx({ privacyNoticeVersion: { findFirst: jest.fn().mockResolvedValue(null) } })
    await expect(grantMarketingConsent({ venueId: 'venueA', customerId: 'cust1', channel: 'FORM_STAFF' })).rejects.toThrow(
      /aviso de privacidad/i,
    )
    expect(makeTxDefault.consentEvent.create).not.toHaveBeenCalled()
  })

  it('TENANT: rechaza un customer de otro venue (la forma de la consulta filtra)', async () => {
    makeTxDefault = makeTx({ $queryRaw: jest.fn().mockResolvedValue([]) }) // el SELECT ... FOR UPDATE filtra por venueId y no encuentra
    await expect(grantMarketingConsent({ venueId: 'venueB', customerId: 'cust1', channel: 'FORM_STAFF' })).rejects.toThrow()
  })

  it('la consulta del customer filtra por venueId (forma de la consulta, no sólo el resultado del mock)', async () => {
    await grantMarketingConsent({ venueId: 'venueA', customerId: 'cust1', channel: 'FORM_STAFF' })
    const [strings, ...values] = makeTxDefault.$queryRaw.mock.calls[0]
    const sql = strings.join('?')
    expect(sql).toMatch(/"venueId"\s*=/)
    expect(sql).toMatch(/FOR UPDATE/)
    expect(values).toContain('venueA')
    expect(values).toContain('cust1')
  })
})

describe('getCurrentPrivacyNotice', () => {
  it('el select incluye `content` (T10: el editor del dashboard precarga el texto, no sólo metadatos)', async () => {
    await getCurrentPrivacyNotice('venueA')
    expect(prisma.privacyNoticeVersion.findFirst as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: 'venueA' },
        select: expect.objectContaining({ content: true, id: true, contentHash: true, language: true, createdAt: true }),
      }),
    )
  })
})

describe('revokeMarketingConsent', () => {
  it('NO exige aviso, escribe REVOKED y apaga el cache', async () => {
    makeTxDefault = makeTx({ privacyNoticeVersion: { findFirst: jest.fn().mockResolvedValue(null) } })
    await revokeMarketingConsent({ venueId: 'venueA', customerId: 'cust1', channel: 'ONE_CLICK_UNSUBSCRIBE' })
    expect(makeTxDefault.consentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'REVOKED', noticeVersionId: null }) }),
    )
    expect(makeTxDefault.customer.update).toHaveBeenCalledWith(expect.objectContaining({ data: { marketingConsent: false } }))
    // Minor de T3: revocar no consulta el aviso de privacidad en absoluto (`action === 'GRANTED'`
    // guarda esa rama) — se afirma explícitamente para que quede fijado, no sólo implícito.
    expect(makeTxDefault.privacyNoticeVersion.findFirst).not.toHaveBeenCalled()
    expect(makeTxDefault.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'MARKETING_CONSENT_REVOKED',
          venueId: 'venueA',
          entityId: 'cust1',
        }),
      }),
    )
  })
})
