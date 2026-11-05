/**
 * Correo de los anuncios: encolar, reclamar y mandar «a lo más una vez» con el tope del día.
 *
 * Aquí, con la base de mentiras, se fija la lógica de cada fila (qué escribe y si llama o no a Resend). Lo que depende
 * de Postgres de verdad —el SQL del encolado, `SKIP LOCKED` y el candado del tope con dos trabajadores— vive en
 * tests/integration/announcements/announcementEmail.integration.test.ts.
 */
import prisma from '@/utils/prismaClient'
import { env } from '@/config/env'
import emailService from '@/services/email.service'
import { isAnnouncementEmailOn } from '@/services/announcements/announcementEmailPreference.service'
import { campanasPausadasPorCupo } from '@/services/email/resendQuota'
import {
  claimAnnouncementEmails,
  enqueuePendingAnnouncementEmails,
  sendClaimedAnnouncementEmails,
} from '@/services/announcements/announcementEmail.service'

jest.mock('@/utils/prismaClient', () => {
  const client: Record<string, unknown> = {
    $queryRaw: jest.fn(),
    platformAnnouncementEmail: { findMany: jest.fn(), updateMany: jest.fn(), count: jest.fn(), createMany: jest.fn() },
  }
  // El tope se reserva en una transacción interactiva con candado: el doble le pasa el mismo cliente como `tx`.
  client.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(client))
  return { __esModule: true, default: client }
})
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmailWithResult: jest.fn() } }))
jest.mock('@/services/announcements/announcementEmailPreference.service', () => ({ isAnnouncementEmailOn: jest.fn() }))
jest.mock('@/services/email/resendQuota', () => ({
  ...jest.requireActual('@/services/email/resendQuota'),
  campanasPausadasPorCupo: jest.fn(),
}))
jest.mock('@/services/demo/candadoDemo', () => ({ conNegocio: (_v: string, fn: () => unknown) => fn() }))

const mockRaw = prisma.$queryRaw as unknown as jest.Mock
const mockFind = prisma.platformAnnouncementEmail.findMany as unknown as jest.Mock
const mockUpdate = prisma.platformAnnouncementEmail.updateMany as unknown as jest.Mock
const mockCount = prisma.platformAnnouncementEmail.count as unknown as jest.Mock
const mockCreate = prisma.platformAnnouncementEmail.createMany as unknown as jest.Mock
const mockSend = emailService.sendEmailWithResult as unknown as jest.Mock
const mockOn = isAnnouncementEmailOn as unknown as jest.Mock
const mockPausa = campanasPausadasPorCupo as unknown as jest.Mock

const AHORA = new Date('2026-11-04T12:00:00.000Z')
const LEASE = new Date('2026-11-04T12:05:00.000Z')
const HOY = '2026-11-04'
const REINICIO = new Date('2026-11-05T00:00:00.000Z')

const fila = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  announcementId: 'a1',
  staffId: 's1',
  venueId: 'v1',
  status: 'PENDING',
  attempts: 1,
  leaseUntil: LEASE,
  sendStartedAt: null,
  capDay: null,
  announcement: {
    id: 'a1',
    title: 'Terminal nueva',
    body: 'Dos pantallas',
    imageUrl: null,
    contentBlocks: null,
    actionLabel: null,
    actionUrl: null,
  },
  staff: { email: 's1@test.local' },
  ...over,
})

const mandar = (ids: string[], reloj: () => Date = () => AHORA) => sendClaimedAnnouncementEmails(ids, { now: AHORA, reloj, pausaMs: 0 })
/** El `data` de cada escritura, en orden. */
const escrituras = () => mockUpdate.mock.calls.map(c => c[0].data)
const ultima = () => escrituras()[escrituras().length - 1]

describe('announcementEmail.service', () => {
  const baseUrl = env.BASE_URL
  beforeEach(() => {
    jest.clearAllMocks()
    env.BASE_URL = 'https://api.test.local'
    env.FRONTEND_URL = 'https://dashboard.test.local'
    env.ANNOUNCEMENT_EMAIL_DAILY_CAP = 40
    process.env.CRM_CORREO_PRUEBAS = 's1@test.local,s2@test.local'
    mockUpdate.mockResolvedValue({ count: 1 })
    mockCount.mockResolvedValue(0)
    mockRaw.mockResolvedValue([])
    mockOn.mockResolvedValue(true)
    mockPausa.mockReturnValue(false)
    mockSend.mockResolvedValue({ ok: true, resendId: 'r1', transient: false })
    mockFind.mockResolvedValue([fila()])
  })
  afterAll(() => {
    env.BASE_URL = baseUrl
    delete process.env.CRM_CORREO_PRUEBAS
  })

  // ===== RECLAMAR =====
  describe('claimAnnouncementEmails', () => {
    it('con la pausa del cupo no reclama', async () => {
      mockPausa.mockReturnValue(true)
      await expect(claimAnnouncementEmails({ now: AHORA })).resolves.toEqual([])
      expect(mockRaw).not.toHaveBeenCalled()
      expect(mockUpdate).not.toHaveBeenCalled()
    })

    it('reclama con FOR UPDATE SKIP LOCKED y nunca una fila que ya empezó a mandarse', async () => {
      mockRaw.mockResolvedValue([{ id: 'e1' }])
      await expect(claimAnnouncementEmails({ limit: 20, now: AHORA })).resolves.toEqual(['e1'])
      const sql = mockRaw.mock.calls[0][0].text
      expect(sql).toContain('FOR UPDATE SKIP LOCKED')
      expect(sql).toContain('"sendStartedAt" IS NULL')
    })

    it('al reclamar, una fila con sendStartedAt y el lease vencido queda FAILED INCIERTO', async () => {
      await claimAnnouncementEmails({ now: AHORA })
      const incierta = mockUpdate.mock.calls.find(c => c[0].where.sendStartedAt?.not === null)
      expect(incierta?.[0].where).toMatchObject({ status: 'PENDING', leaseUntil: { lte: AHORA } })
      expect(incierta?.[0].data).toMatchObject({ status: 'FAILED', leaseUntil: null })
      expect(incierta?.[0].data.lastError).toContain('INCIERTO')
    })
  })

  // ===== MANDAR =====
  describe('sendClaimedAnnouncementEmails', () => {
    it('fila reclamada con sendStartedAt y sin SENT queda FAILED INCIERTO sin mandar', async () => {
      mockFind.mockResolvedValue([fila({ sendStartedAt: new Date('2026-11-04T11:00:00.000Z') })])
      await expect(mandar(['e1'])).resolves.toEqual({ sent: 0, skipped: 0, failed: 1 })
      expect(mockSend).not.toHaveBeenCalled()
      expect(ultima()).toMatchObject({ status: 'FAILED', leaseUntil: null })
      expect(ultima().lastError).toContain('INCIERTO')
    })

    it('manda con idempotencyKey y List-Unsubscribe', async () => {
      await expect(mandar(['e1'])).resolves.toEqual({ sent: 1, skipped: 0, failed: 0 })
      const opciones = mockSend.mock.calls[0][0]
      expect(opciones.to).toBe('s1@test.local')
      expect(opciones.idempotencyKey).toBe('announcement-email:a1:s1')
      expect(opciones.headers['List-Unsubscribe']).toMatch(/^<https:\/\/api\.test\.local\/api\/v1\/public\/unsubscribe\?token=[^>]+>$/)
      expect(opciones.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
      // La plantilla deja `href=""` si la liga no es http(s): aquí se fija que la liga de baja SÍ llegó al cuerpo.
      expect(opciones.html).toContain('https://api.test.local/api/v1/public/unsubscribe?token=')
      expect(opciones.html).toContain('https://dashboard.test.local')
      expect(ultima()).toMatchObject({ status: 'SENT', leaseUntil: null })
    })

    it('marca sendStartedAt y reserva el día ANTES de llamar a Resend, con CAS', async () => {
      mockSend.mockImplementation(async () => {
        // Cuando Resend recibe la llamada, la marca ya está escrita.
        expect(mockUpdate.mock.calls[0][0].where).toMatchObject({ id: 'e1', attempts: 1, leaseUntil: LEASE })
        expect(mockUpdate.mock.calls[0][0].data).toMatchObject({ capDay: HOY, sendStartedAt: AHORA })
        return { ok: true, transient: false }
      })
      await mandar(['e1'])
      expect(mockSend).toHaveBeenCalledTimes(1)
      expect(mockRaw.mock.calls.some(c => JSON.stringify(c).includes('pg_advisory_xact_lock'))).toBe(true)
    })

    it('application_error queda FAILED sin reintento', async () => {
      mockSend.mockResolvedValue({ ok: false, transient: false, errorCode: 'application_error' })
      await expect(mandar(['e1'])).resolves.toEqual({ sent: 0, skipped: 0, failed: 1 })
      expect(ultima()).toMatchObject({ status: 'FAILED', lastError: 'application_error', leaseUntil: null })
      expect(ultima().nextAttemptAt).toBeUndefined()
    })

    it('una excepción o un timeout del transporte queda FAILED: pudo haber salido', async () => {
      mockSend.mockRejectedValue(new Error('socket hang up'))
      await expect(mandar(['e1'])).resolves.toEqual({ sent: 0, skipped: 0, failed: 1 })
      expect(ultima()).toMatchObject({ status: 'FAILED', leaseUntil: null })
    })

    it('error de cupo vuelve a PENDING sin gastar intento y libera capDay', async () => {
      mockSend.mockResolvedValue({ ok: false, transient: true, errorCode: 'daily_quota_exceeded' })
      await mandar(['e1'])
      expect(ultima()).toEqual({
        status: 'PENDING',
        attempts: 0,
        sendStartedAt: null,
        capDay: null,
        leaseUntil: null,
        nextAttemptAt: REINICIO,
        lastError: 'daily_quota_exceeded',
      })
    })

    it('un 429 de cupo vuelve a PENDING sin gastar intento, hasta el reinicio', async () => {
      mockSend.mockResolvedValue({ ok: false, transient: true, errorCode: 'monthly_quota_exceeded' })
      await mandar(['e1'])
      expect(ultima()).toMatchObject({ status: 'PENDING', attempts: 0, nextAttemptAt: REINICIO, capDay: null })
    })

    it('cupo_en_pausa también', async () => {
      mockSend.mockResolvedValue({ ok: false, transient: true, errorCode: 'cupo_en_pausa' })
      await mandar(['e1'])
      expect(ultima()).toMatchObject({ status: 'PENDING', attempts: 0, sendStartedAt: null, capDay: null, nextAttemptAt: REINICIO })
    })

    it('le pasa a Resend la última pregunta de la pausa del cupo', async () => {
      await mandar(['e1'])
      const { antesDeMandar } = mockSend.mock.calls[0][0]
      mockPausa.mockReturnValue(true)
      expect(antesDeMandar()).toBe('cupo_en_pausa')
      mockPausa.mockReturnValue(false)
      expect(antesDeMandar()).toBeNull()
    })

    it('el límite de velocidad vuelve a PENDING en 1 min sin gastar intento', async () => {
      mockSend.mockResolvedValue({ ok: false, transient: true, errorCode: 'rate_limit_exceeded' })
      await mandar(['e1'])
      expect(ultima()).toMatchObject({
        status: 'PENDING',
        attempts: 0,
        capDay: null,
        sendStartedAt: null,
        nextAttemptAt: new Date(AHORA.getTime() + 60_000),
      })
    })

    it('con el tope del día alcanzado no manda', async () => {
      mockCount.mockResolvedValue(40)
      await mandar(['e1'])
      expect(mockSend).not.toHaveBeenCalled()
      expect(mockCount.mock.calls[0][0].where).toEqual({ capDay: HOY })
      expect(ultima()).toMatchObject({ status: 'PENDING', attempts: 0, capDay: null, leaseUntil: null, nextAttemptAt: REINICIO })
    })

    it('una fila que ya reservó hoy no se cuenta otra vez', async () => {
      mockFind.mockResolvedValue([fila({ capDay: HOY })])
      mockCount.mockResolvedValue(40)
      await mandar(['e1'])
      expect(mockCount).not.toHaveBeenCalled()
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('una reserva de otro día no cuenta: se cuenta de nuevo contra hoy', async () => {
      mockFind.mockResolvedValue([fila({ capDay: '2026-11-03' })])
      mockCount.mockResolvedValue(40)
      await mandar(['e1'])
      expect(mockCount).toHaveBeenCalledWith({ where: { capDay: HOY } })
      expect(mockSend).not.toHaveBeenCalled()
    })

    it('una tanda que cruza la medianoche cuenta los envíos de después en el día nuevo', async () => {
      const ANTES = new Date('2026-11-04T23:59:59.000Z')
      const DESPUES = new Date('2026-11-05T00:00:01.000Z')
      let yaSalio = false
      mockSend.mockImplementation(async () => {
        yaSalio = true
        return { ok: true, transient: false }
      })
      mockFind.mockResolvedValue([fila(), fila({ id: 'e2', staffId: 's2', staff: { email: 's2@test.local' } })])
      // El día nuevo ya tiene sus 40.
      mockCount.mockImplementation(async ({ where }: { where: { capDay: string } }) => (where.capDay === '2026-11-05' ? 40 : 0))

      await mandar(['e1', 'e2'], () => (yaSalio ? DESPUES : ANTES))

      expect(mockSend).toHaveBeenCalledTimes(1)
      expect(mockSend.mock.calls[0][0].to).toBe('s1@test.local')
      expect(ultima()).toMatchObject({ status: 'PENDING', capDay: null, nextAttemptAt: new Date('2026-11-06T00:00:00.000Z') })
    })

    it('si la medianoche cae entre reservar y mandar, se reserva otra vez en el día nuevo', async () => {
      const ANTES = new Date('2026-11-04T23:59:59.900Z')
      const DESPUES = new Date('2026-11-05T00:00:00.100Z')
      const reloj = jest.fn().mockReturnValueOnce(ANTES).mockReturnValue(DESPUES)

      await mandar(['e1'], reloj)

      expect(escrituras().slice(0, 3)).toEqual([
        { capDay: '2026-11-04', sendStartedAt: ANTES },
        { capDay: null, sendStartedAt: null },
        { capDay: '2026-11-05', sendStartedAt: DESPUES },
      ])
      expect(mockCount.mock.calls.map(c => c[0].where.capDay)).toEqual(['2026-11-04', '2026-11-05'])
      expect(mockSend).toHaveBeenCalledTimes(1)
      expect(ultima()).toMatchObject({ status: 'SENT' })
    })

    it('si la medianoche cae entre reservar y mandar y el día nuevo está lleno, espera su reinicio sin gastar intento', async () => {
      const reloj = jest
        .fn()
        .mockReturnValueOnce(new Date('2026-11-04T23:59:59.900Z'))
        .mockReturnValue(new Date('2026-11-05T00:00:00.100Z'))
      mockCount.mockImplementation(async ({ where }: { where: { capDay: string } }) => (where.capDay === '2026-11-05' ? 40 : 0))

      await mandar(['e1'], reloj)

      expect(mockSend).not.toHaveBeenCalled()
      expect(ultima()).toMatchObject({
        status: 'PENDING',
        attempts: 0,
        capDay: null,
        sendStartedAt: null,
        nextAttemptAt: new Date('2026-11-06T00:00:00.000Z'),
      })
    })

    it('se salta a quien se dio de baja y a quien no tiene correo, sin mandar', async () => {
      mockFind.mockResolvedValue([fila({ staff: { email: null } }), fila({ id: 'e2', staffId: 's2', staff: { email: 's2@test.local' } })])
      mockOn.mockImplementation(async (staffId: string) => staffId !== 's2')

      await expect(mandar(['e1', 'e2'])).resolves.toEqual({ sent: 0, skipped: 2, failed: 0 })

      expect(mockSend).not.toHaveBeenCalled()
      expect(escrituras()).toEqual([
        expect.objectContaining({ status: 'SENT', skippedReason: 'SIN_CORREO', leaseUntil: null }),
        expect.objectContaining({ status: 'SENT', skippedReason: 'BAJA', leaseUntil: null }),
      ])
    })

    it('fuera de producción no le escribe a quien no está en la lista de prueba', async () => {
      process.env.CRM_CORREO_PRUEBAS = ''
      await expect(mandar(['e1'])).resolves.toEqual({ sent: 0, skipped: 1, failed: 0 })
      expect(mockSend).not.toHaveBeenCalled()
      expect(ultima()).toMatchObject({ status: 'SENT', skippedReason: 'FUERA_DE_LA_LISTA' })
    })

    it('si el CAS no casa no marca nada (otro trabajador se quedó la fila)', async () => {
      mockUpdate.mockResolvedValueOnce({ count: 0 })
      await expect(mandar(['e1'])).resolves.toEqual({ sent: 0, skipped: 0, failed: 0 })
      expect(mockSend).not.toHaveBeenCalled()
      expect(mockUpdate).toHaveBeenCalledTimes(1)
    })

    it.each([[undefined], ['ftp://api.test.local'], ['/api']])(
      'sin BASE_URL http(s) absoluta (%s) no manda: es error de configuración y la fila se reintenta',
      async base => {
        env.BASE_URL = base
        await expect(mandar(['e1'])).resolves.toEqual({ sent: 0, skipped: 0, failed: 1 })
        expect(mockSend).not.toHaveBeenCalled()
        expect(ultima()).toMatchObject({ status: 'PENDING', leaseUntil: null })
        expect(ultima().lastError).toContain('BASE_URL')
        expect(ultima().nextAttemptAt.getTime()).toBeGreaterThan(AHORA.getTime())
      },
    )

    it('sin URL del DASHBOARD http(s) tampoco manda', async () => {
      env.FRONTEND_URL = 'javascript:alert(1)'
      await mandar(['e1'])
      expect(mockSend).not.toHaveBeenCalled()
      expect(ultima().lastError).toContain('FRONTEND_URL')
    })

    it('un error antes de la red en el 5º intento queda FAILED', async () => {
      mockFind.mockResolvedValue([fila({ attempts: 5 })])
      mockOn.mockRejectedValue(new Error('base caída'))
      await mandar(['e1'])
      expect(mockSend).not.toHaveBeenCalled()
      expect(ultima()).toMatchObject({ status: 'FAILED', lastError: 'base caída', leaseUntil: null })
    })
  })

  // ===== ENCOLAR =====
  describe('enqueuePendingAnnouncementEmails', () => {
    it('elige anuncios con correo, repartidos en las últimas 24 h y con entregas sin fila de correo', async () => {
      mockRaw.mockResolvedValueOnce([]) // ningún anuncio
      await expect(enqueuePendingAnnouncementEmails(AHORA)).resolves.toBe(0)
      const sql = mockRaw.mock.calls[0][0].text
      expect(sql).toContain('"sendEmail" = true')
      expect(sql).toContain("'PUBLISHED'")
      expect(sql).toContain('"deliveredAt" >')
      expect(sql).toContain('NOT EXISTS')
      expect(sql).toContain('LIMIT')
      expect(mockCreate).not.toHaveBeenCalled()
    })

    it('inserta una fila por persona con skipDuplicates', async () => {
      mockRaw.mockResolvedValueOnce([{ id: 'a1' }]).mockResolvedValueOnce([
        { staffId: 's1', venueId: 'v1' },
        { staffId: 's2', venueId: 'v2' },
      ])
      mockCreate.mockResolvedValue({ count: 2 })
      await expect(enqueuePendingAnnouncementEmails(AHORA)).resolves.toBe(2)
      expect(mockCreate).toHaveBeenCalledWith({
        data: [
          { announcementId: 'a1', staffId: 's1', venueId: 'v1' },
          { announcementId: 'a1', staffId: 's2', venueId: 'v2' },
        ],
        skipDuplicates: true,
      })
      expect(mockRaw.mock.calls[1][0].text).toContain('DISTINCT ON')
    })
  })
})
