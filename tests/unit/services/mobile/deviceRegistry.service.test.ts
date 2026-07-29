import { DeviceFormFactor, TerminalStatus, TerminalType } from '@prisma/client'

import prisma from '../../../../src/utils/prismaClient'
import { registerDeviceSeen, resolveDeviceName } from '../../../../src/services/mobile/deviceRegistry.service'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'

jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn().mockResolvedValue(undefined),
}))

const prismaMock = prisma as any
const VENUE = 'venue_1'
const STAFF = 'staff_1'

const iphoneIdentity = {
  deviceUid: 'device-abc',
  platform: 'IOS' as const,
  manufacturer: 'Apple',
  modelIdentifier: 'iPhone16,1',
  osVersion: 'iOS 17.2',
  appVersion: '1.4.0',
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.terminal.findFirst.mockReset()
  prismaMock.terminal.create.mockReset()
  prismaMock.terminal.update.mockReset()
  prismaMock.terminal.count.mockReset()
})

describe('deviceRegistry.service', () => {
  // ── FEATURE: nombre con consecutivo por venue ─────────────────────────────────
  describe('resolveDeviceName', () => {
    it('el primer dispositivo de un modelo lleva el nombre limpio', async () => {
      prismaMock.terminal.count.mockResolvedValue(0)
      await expect(resolveDeviceName(prismaMock, VENUE, 'iPhone 15 Pro')).resolves.toBe('iPhone 15 Pro')
    })

    it('el segundo lleva sufijo (2)', async () => {
      prismaMock.terminal.count.mockResolvedValue(1)
      await expect(resolveDeviceName(prismaMock, VENUE, 'iPhone 15 Pro')).resolves.toBe('iPhone 15 Pro (2)')
    })

    it('el tercero lleva sufijo (3)', async () => {
      prismaMock.terminal.count.mockResolvedValue(2)
      await expect(resolveDeviceName(prismaMock, VENUE, 'iPhone 15 Pro')).resolves.toBe('iPhone 15 Pro (3)')
    })

    it('cuenta también los retirados, para no reusar un número ya usado', async () => {
      // Si el (2) se dio de baja, el siguiente debe ser (4), NUNCA (2) otra vez:
      // dos aparatos distintos con el mismo nombre en el histórico es peor que un hueco.
      prismaMock.terminal.count.mockResolvedValue(3)
      await expect(resolveDeviceName(prismaMock, VENUE, 'iPhone 15 Pro')).resolves.toBe('iPhone 15 Pro (4)')

      expect(prismaMock.terminal.count).toHaveBeenCalledWith({
        where: { venueId: VENUE, model: 'iPhone 15 Pro' },
      })
    })

    it('el conteo está acotado al venue (aislamiento de tenant)', async () => {
      prismaMock.terminal.count.mockResolvedValue(0)
      await resolveDeviceName(prismaMock, VENUE, 'Sunmi D3 Mini')
      expect(prismaMock.terminal.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ venueId: VENUE }) }),
      )
    })

    it('maneja modelos que ya traen paréntesis sin romperse', async () => {
      prismaMock.terminal.count.mockResolvedValue(1)
      await expect(resolveDeviceName(prismaMock, VENUE, 'iPad Air (5ª gen)')).resolves.toBe('iPad Air (5ª gen) (2)')
    })
  })

  // ── FEATURE: alta de dispositivo nuevo ────────────────────────────────────────
  describe('registerDeviceSeen — alta', () => {
    it('crea el renglón con modelo resuelto, marca, form factor y selfRegistered', async () => {
      prismaMock.terminal.findFirst.mockResolvedValue(null)
      prismaMock.terminal.count.mockResolvedValue(0)
      prismaMock.terminal.create.mockResolvedValue({ id: 'term_1', name: 'iPhone 15 Pro' })

      const result = await registerDeviceSeen({ venueId: VENUE, staffId: STAFF, identity: iphoneIdentity })

      expect(result).toEqual({ terminalId: 'term_1', created: true, name: 'iPhone 15 Pro' })

      const data = prismaMock.terminal.create.mock.calls[0][0].data
      expect(data).toMatchObject({
        venueId: VENUE,
        name: 'iPhone 15 Pro',
        type: TerminalType.POS_IOS,
        status: TerminalStatus.ACTIVE,
        brand: 'Apple',
        model: 'iPhone 15 Pro',
        modelIdentifier: 'iPhone16,1',
        formFactor: DeviceFormFactor.PHONE,
        deviceUid: 'device-abc',
        selfRegistered: true,
        lastStaffId: STAFF,
      })
      expect(data.firstSeenAt).toBeInstanceOf(Date)
    })

    it('mapea la plataforma al TerminalType correcto', async () => {
      prismaMock.terminal.findFirst.mockResolvedValue(null)
      prismaMock.terminal.count.mockResolvedValue(0)
      prismaMock.terminal.create.mockResolvedValue({ id: 't', name: 'x' })

      await registerDeviceSeen({
        venueId: VENUE,
        staffId: STAFF,
        identity: { ...iphoneIdentity, platform: 'ANDROID', manufacturer: 'SUNMI', modelIdentifier: 'D3_MINI' },
      })

      expect(prismaMock.terminal.create.mock.calls[0][0].data).toMatchObject({
        type: TerminalType.POS_ANDROID,
        model: 'Sunmi D3 Mini',
        formFactor: DeviceFormFactor.COUNTERTOP_POS,
      })
    })

    it('audita el ALTA en ActivityLog', async () => {
      prismaMock.terminal.findFirst.mockResolvedValue(null)
      prismaMock.terminal.count.mockResolvedValue(0)
      prismaMock.terminal.create.mockResolvedValue({ id: 'term_1', name: 'iPhone 15 Pro' })

      await registerDeviceSeen({ venueId: VENUE, staffId: STAFF, identity: iphoneIdentity })

      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'DEVICE_REGISTERED', entity: 'Terminal', entityId: 'term_1', venueId: VENUE, staffId: STAFF }),
      )
    })

    it('un modelo Android no catalogado se registra igual, con nombre legible', async () => {
      prismaMock.terminal.findFirst.mockResolvedValue(null)
      prismaMock.terminal.count.mockResolvedValue(0)
      prismaMock.terminal.create.mockResolvedValue({ id: 't', name: 'Samsung SM-X710' })

      await registerDeviceSeen({
        venueId: VENUE,
        staffId: STAFF,
        identity: {
          deviceUid: 'd',
          platform: 'ANDROID',
          manufacturer: 'samsung',
          modelIdentifier: 'SM-X710',
          formFactor: DeviceFormFactor.TABLET,
        },
      })

      expect(prismaMock.terminal.create.mock.calls[0][0].data).toMatchObject({
        brand: 'Samsung',
        model: 'Samsung SM-X710',
        formFactor: DeviceFormFactor.TABLET,
      })
    })
  })

  // ── FEATURE: dispositivo ya conocido ──────────────────────────────────────────
  describe('registerDeviceSeen — refresco', () => {
    it('actualiza última conexión y último staff sin crear renglón nuevo', async () => {
      prismaMock.terminal.findFirst.mockResolvedValue({ id: 'term_1', name: 'iPhone 15 Pro' })
      prismaMock.terminal.update.mockResolvedValue({})

      const result = await registerDeviceSeen({ venueId: VENUE, staffId: 'staff_2', identity: iphoneIdentity })

      expect(result).toEqual({ terminalId: 'term_1', created: false, name: 'iPhone 15 Pro' })
      expect(prismaMock.terminal.create).not.toHaveBeenCalled()
      expect(prismaMock.terminal.update.mock.calls[0][0].data).toMatchObject({ lastStaffId: 'staff_2' })
    })

    it('un segundo staff en el MISMO teléfono NO duplica el renglón', async () => {
      // Dispositivo y staff son ejes separados: 3 meseros en un teléfono = 1 renglón.
      prismaMock.terminal.findFirst.mockResolvedValue({ id: 'term_1', name: 'iPhone 15 Pro' })
      prismaMock.terminal.update.mockResolvedValue({})

      await registerDeviceSeen({ venueId: VENUE, staffId: 'staff_2', identity: iphoneIdentity })
      await registerDeviceSeen({ venueId: VENUE, staffId: 'staff_3', identity: iphoneIdentity })

      expect(prismaMock.terminal.create).not.toHaveBeenCalled()
      expect(prismaMock.terminal.update).toHaveBeenCalledTimes(2)
    })

    it('NO pisa el nombre que el dueño puso', async () => {
      prismaMock.terminal.findFirst.mockResolvedValue({ id: 'term_1', name: 'Caja de la entrada' })
      prismaMock.terminal.update.mockResolvedValue({})

      await registerDeviceSeen({ venueId: VENUE, staffId: STAFF, identity: iphoneIdentity })

      expect(prismaMock.terminal.update.mock.calls[0][0].data).not.toHaveProperty('name')
    })

    it('NO reclasifica el tipo ni el form factor de un dispositivo ya conocido', async () => {
      prismaMock.terminal.findFirst.mockResolvedValue({ id: 'term_1', name: 'x' })
      prismaMock.terminal.update.mockResolvedValue({})

      await registerDeviceSeen({ venueId: VENUE, staffId: STAFF, identity: iphoneIdentity })

      const data = prismaMock.terminal.update.mock.calls[0][0].data
      expect(data).not.toHaveProperty('type')
      expect(data).not.toHaveProperty('formFactor')
    })

    it('NO audita el refresco — sería inundar la bitácora con heartbeats', async () => {
      prismaMock.terminal.findFirst.mockResolvedValue({ id: 'term_1', name: 'x' })
      prismaMock.terminal.update.mockResolvedValue({})

      await registerDeviceSeen({ venueId: VENUE, staffId: STAFF, identity: iphoneIdentity })

      expect(logAction).not.toHaveBeenCalled()
    })

    it('busca acotado por venue: el mismo aparato en otro venue es otro renglón', async () => {
      prismaMock.terminal.findFirst.mockResolvedValue(null)
      prismaMock.terminal.count.mockResolvedValue(0)
      prismaMock.terminal.create.mockResolvedValue({ id: 't', name: 'x' })

      await registerDeviceSeen({ venueId: 'venue_2', staffId: STAFF, identity: iphoneIdentity })

      expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith({
        where: { venueId: 'venue_2', deviceUid: 'device-abc' },
        select: { id: true, name: true },
      })
    })
  })

  // ── FEATURE: enganche a terminal provisionada por serial ──────────────────────
  describe('registerDeviceSeen — terminal provisionada', () => {
    it('engancha el deviceUid a la terminal que un admin ya dio de alta con ese serial', async () => {
      // Sin esto, comprar una PAX y luego instalarle la app crearía DOS renglones
      // para el mismo aparato físico.
      prismaMock.terminal.findFirst
        .mockResolvedValueOnce(null) // no hay match por deviceUid
        .mockResolvedValueOnce({ id: 'term_pax', name: 'Terminal 1' }) // sí por serial
      prismaMock.terminal.update.mockResolvedValue({})

      const result = await registerDeviceSeen({
        venueId: VENUE,
        staffId: STAFF,
        identity: { ...iphoneIdentity, platform: 'ANDROID', manufacturer: 'PAX', modelIdentifier: 'A910S', serialNumber: 'PAX123' },
      })

      expect(result).toEqual({ terminalId: 'term_pax', created: false, name: 'Terminal 1' })
      expect(prismaMock.terminal.create).not.toHaveBeenCalled()
      expect(prismaMock.terminal.update.mock.calls[0][0].data).toMatchObject({ deviceUid: 'device-abc' })
    })

    it('el enganche NO marca la terminal como auto-registrada', async () => {
      prismaMock.terminal.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'term_pax', name: 'Terminal 1' })
      prismaMock.terminal.update.mockResolvedValue({})

      await registerDeviceSeen({
        venueId: VENUE,
        staffId: STAFF,
        identity: { ...iphoneIdentity, serialNumber: 'PAX123' },
      })

      expect(prismaMock.terminal.update.mock.calls[0][0].data).not.toHaveProperty('selfRegistered')
    })

    it('crea renglón nuevo si el serial no corresponde a ninguna terminal provisionada', async () => {
      prismaMock.terminal.findFirst.mockResolvedValue(null)
      prismaMock.terminal.count.mockResolvedValue(0)
      prismaMock.terminal.create.mockResolvedValue({ id: 't', name: 'x' })

      await registerDeviceSeen({ venueId: VENUE, staffId: STAFF, identity: { ...iphoneIdentity, serialNumber: 'DESCONOCIDO' } })

      expect(prismaMock.terminal.create).toHaveBeenCalled()
    })
  })

  // ── FEATURE: nunca bloquea (lo más importante del servicio) ───────────────────
  describe('registerDeviceSeen — jamás rompe el camino del cobro', () => {
    it('devuelve null sin lanzar si la base falla', async () => {
      prismaMock.terminal.findFirst.mockRejectedValue(new Error('conexión perdida'))
      await expect(registerDeviceSeen({ venueId: VENUE, staffId: STAFF, identity: iphoneIdentity })).resolves.toBeNull()
    })

    it('devuelve null sin lanzar si dos requests concurrentes chocan en el índice único', async () => {
      prismaMock.terminal.findFirst.mockResolvedValue(null)
      prismaMock.terminal.count.mockResolvedValue(0)
      prismaMock.terminal.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))

      await expect(registerDeviceSeen({ venueId: VENUE, staffId: STAFF, identity: iphoneIdentity })).resolves.toBeNull()
    })

    it('sin deviceUid no hace nada y no toca la base', async () => {
      const result = await registerDeviceSeen({ venueId: VENUE, staffId: STAFF, identity: { ...iphoneIdentity, deviceUid: '' } })

      expect(result).toBeNull()
      expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
      expect(prismaMock.terminal.create).not.toHaveBeenCalled()
    })

    it('sin venueId no hace nada y no toca la base', async () => {
      const result = await registerDeviceSeen({ venueId: '', staffId: STAFF, identity: iphoneIdentity })

      expect(result).toBeNull()
      expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
    })
  })
})
