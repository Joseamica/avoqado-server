import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/reservationSettings.service', () => ({
  __esModule: true,
  getReservationSettings: jest.fn(async () => ({ scheduling: { noShowGraceMin: 10 } })),
}))
jest.mock('@/services/reservation/checkIn.service', () => {
  const real = jest.requireActual('@/services/reservation/checkIn.service')
  return { __esModule: true, ...real, checkInReservation: jest.fn(), venueOrganizationId: jest.fn(async () => 'org-1') }
})
jest.mock('@/services/reservation/undoNoShow.service', () => ({ __esModule: true, undoNoShow: jest.fn() }))
jest.mock('@/services/reservation/noShowNotices.service', () => ({
  __esModule: true,
  afterNoShowCorrection: jest.fn(async () => undefined),
  notifyNoShowNeedsReview: jest.fn(async () => undefined),
}))

import { ConflictError } from '@/errors/AppError'
import { checkInReservation } from '@/services/reservation/checkIn.service'
import { undoNoShow } from '@/services/reservation/undoNoShow.service'
import { afterNoShowCorrection } from '@/services/reservation/noShowNotices.service'
import {
  consumeKioskQr,
  issueKioskQrKey,
  KIOSK_QR_MAX_AGE_SECONDS,
  kioskQrSecret,
  signKioskQr,
} from '@/services/reservation/kioskQr.service'

/**
 * Asistencia verificada (16-nov-2026, spec D-A): el kiosco firma su QR con una llave propia y lo rota cada 30 s.
 *
 * 🔴 Lo que se protege: que nadie SIN el celular (la sesión) de la alumna marque su llegada «con celular». El QR sólo
 * prueba que alguien estuvo frente a la pantalla; quién llegó lo dice la sesión.
 */
const VENUE = 'cvenue000000000000000000a'
const KEY = 'ckey00000000000000000000a'
const NOW = new Date('2026-11-16T18:00:00Z')
const nowSec = Math.floor(NOW.getTime() / 1000)
const CLASE = new Date('2026-11-16T18:05:00Z') // empieza en 5 min: dentro de la ventana (20 min antes)

const SES = { tipo: 'SESION', contactos: [{ tipo: 'PHONE' as const, valor: '+525512345678', metodo: 'WHATSAPP' as const, probadoEn: 1 }] }

function qr(ts = nowSec, keyId = KEY, venueId = VENUE) {
  return { keyId, ts, sig: signKioskQr(kioskQrSecret(keyId), venueId, keyId, ts) }
}

describe('Asistencia verificada · QR firmado por el kiosco', () => {
  beforeAll(() => {
    process.env.OTP_PEPPER = process.env.OTP_PEPPER || 'pepper-de-prueba-largo'
  })
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
    prismaMock.kioskQrKey.findFirst.mockResolvedValue({ id: KEY } as any)
    prismaMock.kioskCheckInAttempt.upsert.mockResolvedValue({ count: 1 } as any)
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([])
    ;(prismaMock.$executeRaw as jest.Mock).mockResolvedValue(1)
    prismaMock.kioskCheckInOp.findUnique.mockResolvedValue(null)
    prismaMock.reservation.findMany.mockResolvedValue([{ id: 'res-1', status: 'CONFIRMED', startsAt: CLASE }] as any)
    ;(checkInReservation as jest.Mock).mockResolvedValue({ outcome: 'CHECKED_IN', reservation: {}, services: [] })
  })

  describe('Codex r5 #2: el MISMO QR presentado otra vez por la MISMA alumna', () => {
    it('contesta con la reserva de la primera vez y no marca otra clase', async () => {
      prismaMock.kioskCheckInOp.findUnique.mockResolvedValue({ reservationId: 'res-1', venueId: VENUE } as any)
      prismaMock.reservation.findMany.mockResolvedValue([{ id: 'res-2', status: 'CONFIRMED', startsAt: CLASE }] as any)
      const out = await consumeKioskQr({ venueId: VENUE, sesion: SES, ...qr(), customerId: 'cust-1', now: NOW })
      expect(out).toEqual({ outcome: 'ALREADY_CHECKED_IN', reservationId: 'res-1' })
      expect(checkInReservation).not.toHaveBeenCalled()
    })
    it('la primera vez deja su recibo en la misma transacción que la llegada', async () => {
      await consumeKioskQr({ venueId: VENUE, sesion: SES, ...qr(), customerId: 'cust-1', now: NOW })
      const [pedazos, ...valores] = (prismaMock.$executeRaw as jest.Mock).mock.calls[0] as [string[], ...unknown[]]
      expect(pedazos.join('?')).toMatch(/INSERT INTO "KioskCheckInOp"/)
      expect(String(valores[0])).toMatch(/^qr:[a-f0-9]{56}$/)
      expect(valores.slice(1)).toEqual([VENUE, 'res-1'])
    })
    it('🔴 Codex r6 #1: «ya estabas» también deja su recibo, ANTES de elegir reserva se consulta', async () => {
      prismaMock.reservation.findMany.mockResolvedValue([{ id: 'res-1', status: 'CHECKED_IN', startsAt: CLASE }] as any)
      prismaMock.kioskCheckInOp.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ reservationId: 'res-1' } as any)
      const out = await consumeKioskQr({ venueId: VENUE, sesion: SES, ...qr(), customerId: 'cust-1', now: NOW })
      expect(out).toEqual({ outcome: 'ALREADY_CHECKED_IN', reservationId: 'res-1' })
      const [pedazos, ...valores] = (prismaMock.$executeRaw as jest.Mock).mock.calls[0] as [string[], ...unknown[]]
      expect(pedazos.join('?')).toMatch(/INSERT INTO "KioskCheckInOp"/)
      expect(valores.slice(1)).toEqual([VENUE, 'res-1'])
      expect(prismaMock.kioskCheckInOp.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
        prismaMock.reservation.findMany.mock.invocationCallOrder[0],
      )
    })
    it('otra alumna con el mismo QR tiene su propio recibo (la fila de 8 sigue funcionando)', async () => {
      await consumeKioskQr({ venueId: VENUE, sesion: SES, ...qr(), customerId: 'alumna-a', now: NOW })
      await consumeKioskQr({ venueId: VENUE, sesion: SES, ...qr(), customerId: 'alumna-b', now: NOW })
      const ops = (prismaMock.$executeRaw as jest.Mock).mock.calls.map(c => String(c[1]))
      expect(new Set(ops).size).toBe(2)
    })
  })

  describe('emitir la llave', () => {
    it('revoca las llaves anteriores del mismo aparato, no guarda el secreto y deja rastro', async () => {
      prismaMock.kioskQrKey.updateMany.mockResolvedValue({ count: 1 } as any)
      prismaMock.kioskQrKey.create.mockResolvedValue({ id: KEY } as any)
      prismaMock.activityLog.create.mockResolvedValue({} as any)
      prismaMock.venue.findUniqueOrThrow.mockResolvedValue({ slug: 'mindform', organizationId: 'org-1' } as any)

      const out = await issueKioskQrKey({ venueId: VENUE, deviceKey: 'aparato-d3-123', staffId: 'staff-1', now: NOW })

      expect(prismaMock.kioskQrKey.updateMany).toHaveBeenCalledWith({
        where: { venueId: VENUE, deviceKey: 'aparato-d3-123', revokedAt: null },
        data: { revokedAt: NOW },
      })
      const creado = prismaMock.kioskQrKey.create.mock.calls[0][0].data
      expect(JSON.stringify(creado)).not.toContain(out.secret)
      expect(out.secret).toBe(kioskQrSecret(KEY).toString('hex'))
      expect(out.rotateSeconds).toBe(30)
      expect(out.checkInUrl).toMatch(/\/mindform\/checkin\/q$/)
      expect(prismaMock.activityLog.create.mock.calls[0][0].data).toMatchObject({ action: 'KIOSK_QR_KEY_ISSUED', entityId: KEY })
    })
  })

  describe('presentarlo desde el celular', () => {
    it.each([
      ['token de «tus reservas de hoy»', { tipo: 'RESERVAS_DE_HOY', contactos: [] }],
      ['contraseña (sin contacto probado)', { tipo: 'SESION', contactos: [] }],
    ])('🔴 %s ⇒ 401 «entra con tu código», sin marcar nada', async (_n, sesion) => {
      await expect(consumeKioskQr({ venueId: VENUE, ...qr(), sesion, customerId: 'cust-1', now: NOW })).rejects.toMatchObject({
        statusCode: 401,
        code: 'CHECK_IN_NEEDS_CODE',
      })
      expect(checkInReservation).not.toHaveBeenCalled()
    })

    it('🔴 el personal cambió el contacto con el que entró ⇒ cuenta, pero «a mano por» quien lo cambió', async () => {
      ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([{ staffId: 'gerente-1' }])
      await consumeKioskQr({ venueId: VENUE, sesion: SES, ...qr(), customerId: 'cust-1', now: NOW })
      expect((checkInReservation as jest.Mock).mock.calls[0][1]).toMatchObject({ method: 'STAFF', byStaffId: 'gerente-1' })
      // 🔴 Codex r2 #2: el filtro por campo va EN la consulta (antes del tope), no sobre los últimos N cambios.
      // Plantilla etiquetada: el 1.er argumento son los pedazos de texto y el resto, los valores.
      const [pedazos, ...valores] = (prismaMock.$queryRaw as jest.Mock).mock.calls[0] as [string[], ...unknown[]]
      const texto = pedazos.join('?')
      expect(texto).toMatch(/\?\| /)
      expect(texto).toMatch(/LIMIT 1/)
      expect(valores).toContainEqual(['phone'])
    })

    it('sin cambios de contacto por el personal ⇒ «con celular»', async () => {
      await consumeKioskQr({ venueId: VENUE, sesion: SES, ...qr(), customerId: 'cust-1', now: NOW })
      expect((checkInReservation as jest.Mock).mock.calls[0][1].method).toBe('QR')
    })

    it('QR genuino + reserva suya en ventana ⇒ llegada «con celular», con la hora del QR', async () => {
      const ts = nowSec - 120 // lo escaneó hace 2 min y tardó en entrar con su código
      const out = await consumeKioskQr({ venueId: VENUE, sesion: SES, ...qr(ts), customerId: 'cust-1', now: NOW })

      expect(out).toEqual({ outcome: 'CHECKED_IN', reservationId: 'res-1' })
      const cmd = (checkInReservation as jest.Mock).mock.calls[0][1]
      expect(cmd).toMatchObject({ reservationId: 'res-1', venueId: VENUE, source: 'KIOSK', method: 'QR' })
      expect(cmd.now.getTime()).toBe(ts * 1000)
      // Sólo SUS reservas: la sesión decide quién llegó.
      expect(prismaMock.reservation.findMany.mock.calls[0][0].where).toMatchObject({ venueId: VENUE, customerId: 'cust-1' })
    })

    it('🔴 la «coach» con SU sesión (sin reserva en esa clase) no marca a nadie', async () => {
      prismaMock.reservation.findMany.mockResolvedValue([])
      await expect(consumeKioskQr({ venueId: VENUE, sesion: SES, ...qr(), customerId: 'coach', now: NOW })).rejects.toMatchObject({
        statusCode: 404,
        code: 'CHECK_IN_NOT_FOUND',
      })
      expect(checkInReservation).not.toHaveBeenCalled()
    })

    it('dos alumnas con el MISMO QR: las dos llegan (la fila de 8 no se estorba)', async () => {
      const mismo = qr()
      await consumeKioskQr({ venueId: VENUE, sesion: SES, ...mismo, customerId: 'alumna-a', now: NOW })
      prismaMock.reservation.findMany.mockResolvedValue([{ id: 'res-2', status: 'CONFIRMED', startsAt: CLASE }] as any)
      await consumeKioskQr({ venueId: VENUE, sesion: SES, ...mismo, customerId: 'alumna-b', now: NOW })
      expect((checkInReservation as jest.Mock).mock.calls.map(c => c[1].reservationId)).toEqual(['res-1', 'res-2'])
    })

    it('ya había llegado ⇒ «ya estabas», sin escribir', async () => {
      prismaMock.reservation.findMany.mockResolvedValue([{ id: 'res-1', status: 'CHECKED_IN', startsAt: CLASE }] as any)
      const out = await consumeKioskQr({ venueId: VENUE, sesion: SES, ...qr(), customerId: 'cust-1', now: NOW })
      expect(out).toEqual({ outcome: 'ALREADY_CHECKED_IN', reservationId: 'res-1' })
      expect(checkInReservation).not.toHaveBeenCalled()
    })

    it.each([
      ['firma alterada', () => ({ ...qr(), sig: qr().sig.slice(0, -2) + 'xx' })],
      ['firma de otro negocio', () => qr(nowSec, KEY, 'cotrovenue00000000000000a')],
      ['hora cambiada (la firma ya no cuadra)', () => ({ ...qr(), ts: nowSec - 5 })],
    ])('🔴 %s ⇒ 404 genérico y se cuenta el intento', async (_n, mk) => {
      await expect(
        consumeKioskQr({ venueId: VENUE, sesion: SES, ...mk(), customerId: 'cust-1', now: NOW, ip: '1.2.3.4' }),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: 'CHECK_IN_NOT_FOUND',
      })
      expect(prismaMock.kioskCheckInAttempt.upsert).toHaveBeenCalled()
      expect(checkInReservation).not.toHaveBeenCalled()
    })

    it('🔴 llave revocada o de otro negocio ⇒ 404 genérico', async () => {
      prismaMock.kioskQrKey.findFirst.mockResolvedValue(null)
      await expect(consumeKioskQr({ venueId: VENUE, sesion: SES, ...qr(), customerId: 'cust-1', now: NOW })).rejects.toMatchObject({
        statusCode: 404,
      })
      expect(prismaMock.kioskQrKey.findFirst.mock.calls[0][0].where).toEqual({ id: KEY, venueId: VENUE, revokedAt: null })
    })

    it('QR genuino pero de hace más de 10 min ⇒ «venció»', async () => {
      await expect(
        consumeKioskQr({ venueId: VENUE, sesion: SES, ...qr(nowSec - KIOSK_QR_MAX_AGE_SECONDS - 1), customerId: 'cust-1', now: NOW }),
      ).rejects.toMatchObject({ statusCode: 410, code: 'CHECK_IN_CHALLENGE_EXPIRED' })
    })

    it('QR del futuro (reloj del aparato adelantado más de 2 min) ⇒ 404', async () => {
      await expect(
        consumeKioskQr({ venueId: VENUE, sesion: SES, ...qr(nowSec + 3 * 60), customerId: 'cust-1', now: NOW }),
      ).rejects.toMatchObject({
        statusCode: 404,
      })
    })

    it('reloj del aparato adelantado 1 min: vale, y la hora no queda en el futuro', async () => {
      await consumeKioskQr({ venueId: VENUE, sesion: SES, ...qr(nowSec + 60), customerId: 'cust-1', now: NOW })
      expect((checkInReservation as jest.Mock).mock.calls[0][1].now.getTime()).toBe(NOW.getTime())
    })

    it('el «No asistió» automático le ganó mientras entraba ⇒ se corrige con la hora del QR y se avisa', async () => {
      prismaMock.reservation.findMany.mockResolvedValue([{ id: 'res-1', status: 'NO_SHOW', startsAt: CLASE }] as any)
      ;(undoNoShow as jest.Mock).mockResolvedValue({ outcome: 'UNDONE', correction: { id: 'corr-1' } })
      const ts = nowSec - 60
      const out = await consumeKioskQr({ venueId: VENUE, sesion: SES, ...qr(ts), customerId: 'cust-1', now: NOW })

      expect(out).toEqual({ outcome: 'CHECKED_IN', reservationId: 'res-1', corrected: true })
      const cmd = (undoNoShow as jest.Mock).mock.calls[0][1]
      expect(cmd).toMatchObject({ reservationId: 'res-1', method: 'QR', source: 'KIOSK' })
      expect(cmd.arrivedAt.getTime()).toBe(ts * 1000)
      expect(afterNoShowCorrection).toHaveBeenCalledWith('corr-1')
    })

    it('carrera: el «No asistió» gana entre la lectura y el check-in ⇒ también se corrige', async () => {
      ;(checkInReservation as jest.Mock).mockRejectedValue(new ConflictError('cambió', 'RESERVATION_NOT_CHECKINABLE'))
      ;(undoNoShow as jest.Mock).mockResolvedValue({ outcome: 'UNDONE', correction: { id: 'corr-2' } })
      const out = await consumeKioskQr({ venueId: VENUE, sesion: SES, ...qr(), customerId: 'cust-1', now: NOW })
      expect(out.corrected).toBe(true)
    })
  })
})
