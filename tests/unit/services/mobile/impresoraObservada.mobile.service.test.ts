/**
 * «La impresora que se encuentra sola» — lado servidor (Testarudo, 2-oct-2026).
 *
 * La ticketera de cocina tiene DHCP y el módem le cambió la dirección. La tablet la encuentra sola en la red y le
 * AVISA al servidor, para que el panel deje de mostrar la dirección vieja y las demás tablets la reciban.
 */
const mockPrisma: any = {
  printer: { findFirst: jest.fn(), updateMany: jest.fn() },
}
const mockLogAction = jest.fn()

jest.mock('../../../../src/utils/prismaClient', () => ({ __esModule: true, default: mockPrisma }))
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({ logAction: (...a: any[]) => mockLogAction(...a) }))
jest.mock('../../../../src/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

import * as svc from '../../../../src/services/mobile/print.mobile.service'

const VENUE = 'venue_testarudo'
const COCINA = 'pr_cocina'
const STAFF = 'staff_1'
const MAC = 'mac:02107B1A76FC'

const cocina = (o: any = {}) => ({
  id: COCINA,
  venueId: VENUE,
  connectionType: 'NETWORK',
  address: '192.168.1.64:9100',
  stableKey: null,
  ...o,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockPrisma.printer.findFirst.mockResolvedValue(cocina())
  mockPrisma.printer.updateMany.mockResolvedValue({ count: 1 })
})

describe('reportarImpresoraObservada', () => {
  it('actualiza la dirección conservando el puerto y aprende la identidad', async () => {
    const r = await svc.reportarImpresoraObservada(
      VENUE,
      COCINA,
      { previousAddress: '192.168.1.64', address: '192.168.1.67', stableKey: MAC },
      STAFF,
    )
    expect(r).toMatchObject({ updated: true, motivo: 'ACTUALIZADA', address: '192.168.1.67:9100', stableKey: MAC })
    // CAS: sólo si la dirección guardada sigue siendo la que la tablet vio — nunca pisa una corrección más nueva.
    expect(mockPrisma.printer.updateMany).toHaveBeenCalledWith({
      where: { id: COCINA, venueId: VENUE, address: '192.168.1.64:9100' },
      data: { address: '192.168.1.67:9100', stableKey: MAC },
    })
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: STAFF,
        venueId: VENUE,
        action: 'PRINTER_ADDRESS_AUTO_UPDATED',
        entity: 'Printer',
        entityId: COCINA,
      }),
    )
  })

  it('una dirección sin puerto se queda sin puerto', async () => {
    mockPrisma.printer.findFirst.mockResolvedValue(cocina({ address: '192.168.1.64' }))
    const r = await svc.reportarImpresoraObservada(VENUE, COCINA, { previousAddress: '192.168.1.64', address: '192.168.1.67' }, STAFF)
    expect(r.address).toBe('192.168.1.67')
  })

  it('P1 si alguien ya la corrigió en el panel, la tablet atrasada NO la pisa', async () => {
    mockPrisma.printer.findFirst.mockResolvedValue(cocina({ address: '192.168.1.90:9100' }))
    const r = await svc.reportarImpresoraObservada(VENUE, COCINA, { previousAddress: '192.168.1.64', address: '192.168.1.67' }, STAFF)
    expect(r).toMatchObject({ updated: false, motivo: 'DIRECCION_YA_CAMBIO', address: '192.168.1.90:9100' })
    expect(mockPrisma.printer.updateMany).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('P1 si el panel cambió entre la lectura y la escritura, tampoco la pisa', async () => {
    mockPrisma.printer.updateMany.mockResolvedValue({ count: 0 })
    const r = await svc.reportarImpresoraObservada(VENUE, COCINA, { previousAddress: '192.168.1.64', address: '192.168.1.67' }, STAFF)
    expect(r).toMatchObject({ updated: false, motivo: 'DIRECCION_YA_CAMBIO' })
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('P1 con OTRA identidad no la toca: es otra impresora', async () => {
    mockPrisma.printer.findFirst.mockResolvedValue(cocina({ stableKey: 'mac:AAAAAAAAAAAA' }))
    const r = await svc.reportarImpresoraObservada(
      VENUE,
      COCINA,
      { previousAddress: '192.168.1.64', address: '192.168.1.67', stableKey: MAC },
      STAFF,
    )
    expect(r).toMatchObject({ updated: false, motivo: 'OTRA_IDENTIDAD' })
    expect(mockPrisma.printer.updateMany).not.toHaveBeenCalled()
  })

  it('la identidad ya guardada no se reemplaza', async () => {
    mockPrisma.printer.findFirst.mockResolvedValue(cocina({ stableKey: MAC }))
    await svc.reportarImpresoraObservada(VENUE, COCINA, { previousAddress: '192.168.1.64', address: '192.168.1.67' }, STAFF)
    expect(mockPrisma.printer.updateMany.mock.calls[0][0].data).toEqual({ address: '192.168.1.67:9100', stableKey: MAC })
  })

  it('sólo aprender la identidad (misma dirección) se guarda', async () => {
    mockPrisma.printer.findFirst.mockResolvedValue(cocina({ address: '192.168.1.67:9100' }))
    const r = await svc.reportarImpresoraObservada(
      VENUE,
      COCINA,
      { previousAddress: '192.168.1.67', address: '192.168.1.67', stableKey: MAC },
      STAFF,
    )
    expect(r).toMatchObject({ updated: true, motivo: 'ACTUALIZADA', stableKey: MAC })
  })

  it('misma dirección y nada que aprender: sin cambios ni auditoría', async () => {
    mockPrisma.printer.findFirst.mockResolvedValue(cocina({ address: '192.168.1.67:9100', stableKey: MAC }))
    const r = await svc.reportarImpresoraObservada(
      VENUE,
      COCINA,
      { previousAddress: '192.168.1.67', address: '192.168.1.67', stableKey: MAC },
      STAFF,
    )
    expect(r).toMatchObject({ updated: false, motivo: 'SIN_CAMBIOS' })
    expect(mockPrisma.printer.updateMany).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('P1 una dirección fuera de la red local se rechaza', async () => {
    await expect(
      svc.reportarImpresoraObservada(VENUE, COCINA, { previousAddress: '192.168.1.64', address: '8.8.8.8' }, STAFF),
    ).rejects.toThrow('red local')
    expect(mockPrisma.printer.updateMany).not.toHaveBeenCalled()
  })

  it('una impresora de otro negocio no existe para este venue', async () => {
    mockPrisma.printer.findFirst.mockResolvedValue(null)
    await expect(
      svc.reportarImpresoraObservada(VENUE, 'pr_ajena', { previousAddress: '192.168.1.64', address: '192.168.1.67' }, STAFF),
    ).rejects.toThrow('Impresora no encontrada')
    expect(mockPrisma.printer.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'pr_ajena', venueId: VENUE } }))
  })

  it('una impresora que no es de red no cambia de dirección sola', async () => {
    mockPrisma.printer.findFirst.mockResolvedValue(cocina({ connectionType: 'POS_INTERNAL', address: null }))
    await expect(
      svc.reportarImpresoraObservada(VENUE, COCINA, { previousAddress: '192.168.1.64', address: '192.168.1.67' }, STAFF),
    ).rejects.toThrow('impresora de red')
  })
})
