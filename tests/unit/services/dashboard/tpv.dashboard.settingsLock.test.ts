// tests/unit/services/dashboard/tpv.dashboard.settingsLock.test.ts
/**
 * S1 de F1 (Codex F1 r1 #2): `updateTpvSettings` toma el candado de la fila ANTES de leer, y lee y escribe por la
 * transacción. La transacción usa delegados PROPIOS: si alguien vuelve a leer o escribir con el cliente global, cae aquí.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { NotFoundError } from '@/errors/AppError'
import { updateTpvSettings, updateVenueTpvSettings } from '@/services/dashboard/tpv.dashboard.service'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const leida = {
  venueId: 'v1',
  config: { settings: { showTipScreen: true, showReviewScreen: true }, otra: 'se conserva' },
  configOverrides: null,
  venue: { organizationId: null },
}
function txPropia(venueBajoCandado = 'v1') {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 't1', venueId: venueBajoCandado }]),
    terminal: { findUnique: jest.fn().mockResolvedValue(leida), update: jest.fn().mockResolvedValue({}) },
    organizationAttendanceConfig: { findUnique: jest.fn().mockResolvedValue(null) },
  }
}

describe('updateTpvSettings bajo el candado de la fila', () => {
  it('🔴 toma el candado ANTES de leer, y lee y escribe por la transacción (nunca por el cliente global)', async () => {
    const tx = txPropia()
    prismaMock.$transaction.mockImplementation((cb: any) => cb(tx))
    await updateTpvSettings('t1', { showTipScreen: false }, { venueId: 'v1' })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.terminal.findUnique.mock.invocationCallOrder[0])
    expect(tx.terminal.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.terminal.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
  })

  it('la respuesta no cambia: los ajustes mezclados con lo pedido, y config conserva lo ajeno', async () => {
    const tx = txPropia()
    prismaMock.$transaction.mockImplementation((cb: any) => cb(tx))
    const r = await updateTpvSettings('t1', { showTipScreen: false }, { venueId: 'v1' })
    expect(r).toMatchObject({ showTipScreen: false, showReviewScreen: true })
    expect(tx.terminal.update.mock.calls[0][0].data.config).toMatchObject({ otra: 'se conserva' })
  })

  it('si bajo el candado la terminal ya es de otro negocio: el mismo 404 y no escribe', async () => {
    const tx = txPropia('otro-venue')
    prismaMock.$transaction.mockImplementation((cb: any) => cb(tx))
    await expect(updateTpvSettings('t1', { showTipScreen: false }, { venueId: 'v1' })).rejects.toBeInstanceOf(NotFoundError)
    expect(tx.terminal.update).not.toHaveBeenCalled()
  })

  it('si la terminal no existe: 404 sin leer ni escribir', async () => {
    const tx = txPropia()
    tx.$queryRaw.mockResolvedValue([])
    prismaMock.$transaction.mockImplementation((cb: any) => cb(tx))
    await expect(updateTpvSettings('t1', {}, {})).rejects.toBeInstanceOf(NotFoundError)
    expect(tx.terminal.findUnique).not.toHaveBeenCalled()
  })
})

describe('updateVenueTpvSettings bajo los candados de las terminales del negocio (Codex r2)', () => {
  const ids = ['t1', 't2']
  function txDelNegocio(bloqueadas = ids) {
    return {
      $queryRaw: jest.fn().mockResolvedValue(bloqueadas.map(id => ({ id }))),
      terminal: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            bloqueadas.map(id => ({ id, config: { settings: { showTipScreen: true }, otra: 'se conserva' }, configOverrides: null })),
          ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      venueSettings: { upsert: jest.fn().mockResolvedValue({}) },
    }
  }
  beforeEach(() => {
    // La lectura de la respuesta (getVenueTpvSettings) es la de siempre, fuera de la transacción.
    prismaMock.terminal.findFirst.mockResolvedValue(null)
    prismaMock.venueSettings.findFirst.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: null } as any)
    prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue(null)
  })

  it('🔴 toma los candados de TODAS sus terminales en UNA sentencia ordenada por id, ANTES de leerlas; lee y escribe por la transacción', async () => {
    const tx = txDelNegocio()
    prismaMock.$transaction.mockImplementation((cb: any) => cb(tx))
    await updateVenueTpvSettings('v1', { enableBarcodeScanner: false })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect((tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?')).toMatch(/WHERE "venueId" = \? ORDER BY id FOR UPDATE/)
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.terminal.findMany.mock.invocationCallOrder[0])
    expect(tx.terminal.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ids } } }))
    expect(tx.terminal.updateMany).toHaveBeenCalledTimes(2)
    expect(tx.terminal.updateMany.mock.calls[0][0].data.config).toMatchObject({
      otra: 'se conserva',
      settings: { showTipScreen: true, enableBarcodeScanner: false },
    })
    expect(prismaMock.terminal.findMany).not.toHaveBeenCalled()
    expect(prismaMock.terminal.updateMany).not.toHaveBeenCalled()
  })

  it('el horario del negocio se escribe DESPUÉS de los candados y en la misma transacción', async () => {
    const tx = txDelNegocio()
    prismaMock.$transaction.mockImplementation((cb: any) => cb(tx))
    await updateVenueTpvSettings('v1', { expectedCheckInTime: '09:30' })
    expect(tx.venueSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: 'v1' } }))
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.venueSettings.upsert.mock.invocationCallOrder[0])
    expect(prismaMock.venueSettings.upsert).not.toHaveBeenCalled()
  })

  it('sin terminales en el negocio: el mismo 404 de siempre, sin leer ni escribir', async () => {
    const tx = txDelNegocio([])
    prismaMock.$transaction.mockImplementation((cb: any) => cb(tx))
    await expect(updateVenueTpvSettings('v1', { enableBarcodeScanner: false })).rejects.toBeInstanceOf(NotFoundError)
    expect(tx.terminal.findMany).not.toHaveBeenCalled()
    expect(tx.venueSettings.upsert).not.toHaveBeenCalled()
  })

  it('la respuesta no cambia: los ajustes vigentes más terminalsUpdated/terminalsOmitted', async () => {
    const tx = txDelNegocio()
    tx.terminal.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    prismaMock.$transaction.mockImplementation((cb: any) => cb(tx))
    expect(await updateVenueTpvSettings('v1', { enableBarcodeScanner: false })).toMatchObject({ terminalsUpdated: 1, terminalsOmitted: 1 })
  })
})
