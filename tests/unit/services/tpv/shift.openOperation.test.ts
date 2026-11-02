jest.mock('@/services/shared/turnoDeCaja', () => ({ abrirTurnoDeCaja: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn() } }))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import socketManager from '@/communication/sockets'
import { abrirTurnoDeCaja } from '@/services/shared/turnoDeCaja'
import { openShiftForVenue } from '@/services/tpv/shift.tpv.service'

const m = prisma as any
const operation = {
  operationId: 'cm00000000000000000000003',
  localId: 'cm00000000000000000000003',
  terminalSerial: 'AVQD-123',
  isOfflineReplay: true,
}
const original = {
  shiftId: 'shift-A',
  cashDrawerSessionId: 'drawer-A',
  shiftCreado: false,
  cajaCreada: false,
  reintento: false,
  openingDisposition: 'ADOPTED',
  localId: 'original-open',
  fondoAplicado: '2000',
  staffName: 'Original',
}

beforeEach(() => {
  m.shift.findUnique.mockResolvedValue({ id: 'shift-A', venueId: 'venue-1', status: 'OPEN', startingCash: new Prisma.Decimal(300) })
  ;(abrirTurnoDeCaja as jest.Mock).mockResolvedValue(original)
})

describe('TPV opening result projection', () => {
  it('exposes the effective drawer fund separately from the historical Shift fund, including a replay', async () => {
    const first = await openShiftForVenue('venue-1', 'staff-current', 500, undefined, undefined, operation)
    expect(first).toMatchObject({ id: 'shift-A', fondoAplicado: '2000', openingDisposition: 'ADOPTED', localId: 'original-open' })
    expect(first.startingCash.toString()).toBe('300')
    ;(abrirTurnoDeCaja as jest.Mock).mockResolvedValue({ ...original, reintento: true })
    await expect(openShiftForVenue('venue-1', 'another-actor', 500, undefined, undefined, operation)).resolves.toMatchObject({
      fondoAplicado: '2000',
      reintento: true,
    })
    expect(m.shift.updateMany).not.toHaveBeenCalled()
  })

  it('replaying OWN does not broadcast another opening even when the stored original says it created the shift', async () => {
    ;(abrirTurnoDeCaja as jest.Mock).mockResolvedValue({
      ...original,
      shiftCreado: true,
      cajaCreada: true,
      openingDisposition: 'OWN',
      reintento: true,
    })
    await openShiftForVenue('venue-1', 'staff-current', 500, undefined, undefined, operation)
    expect(socketManager.getBroadcastingService).not.toHaveBeenCalled()
  })

  it('REGRESSION: legacy callers do not receive any operation metadata', async () => {
    const response = await openShiftForVenue('venue-1', 'staff-current', 500)
    expect(response).not.toHaveProperty('fondoAplicado')
    expect(response).not.toHaveProperty('openingDisposition')
    expect(response).toMatchObject({ id: 'shift-A', cashDrawerSessionId: 'drawer-A' })
  })
})
