// tests/unit/services/customer-display/customerDisplayVenueChange.test.ts
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import * as cacheDeLaFicha from '@/services/customer-display/customerDisplayCache'
import { borrarDisenoAlCambiarDeNegocio, invalidateCustomerDisplayCache } from '@/services/customer-display/customerDisplayVenueChange'

/**
 * La integración demuestra el comportamiento contra Postgres; ésta fija la FORMA: qué sentencias, en qué orden y por qué
 * cliente. El `tx` lleva delegados PROPIOS, independientes de los de `prismaMock` (Codex r2, #3): un `{ ...prismaMock }`
 * compartiría las mismas funciones y no distinguiría un cambio de `tx` por el cliente global.
 */
function nuevoTx(opciones: { fila?: { id: string; venueId: string } | null; borrados?: number } = {}) {
  const fila = opciones.fila === undefined ? { id: 't1', venueId: 'vA' } : opciones.fila
  const delegados = {
    $queryRaw: jest.fn().mockResolvedValue(fila ? [fila] : []),
    customerDisplayDesign: { deleteMany: jest.fn().mockResolvedValue({ count: opciones.borrados ?? 1 }) },
    terminal: { update: jest.fn().mockResolvedValue({ id: 't1' }) },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
  }
  return { delegados, tx: delegados as unknown as Prisma.TransactionClient }
}

const LIMPIEZA_DEL_REPORTE = {
  customerDisplayAck: Prisma.DbNull,
  customerDisplayInstallationId: null,
  customerDisplayInstallationSince: null,
  customerDisplayInstallationSwitches: Prisma.DbNull,
  customerDisplayDesignVersion: null,
}

function nadaPorElClienteGlobal() {
  expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  expect(prismaMock.customerDisplayDesign.deleteMany).not.toHaveBeenCalled()
  expect(prismaMock.terminal.update).not.toHaveBeenCalled()
  expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  // El asiento es parte del cambio: nunca por `logAction`, que escribe fuera de la transacción.
  expect(logAction).not.toHaveBeenCalled()
}

describe('borrarDisenoAlCambiarDeNegocio', () => {
  it('cambio real: bloquea, borra el diseño, limpia el reporte y deja el asiento, en ESE orden y todo por `tx`', async () => {
    const { tx, delegados } = nuevoTx()

    const r = await borrarDisenoAlCambiarDeNegocio(tx, { terminalId: 't1', toVenueId: 'vB', reason: 'terminal_moved', staffId: 's1' })

    expect(r).toEqual({ cambio: true, disenoBorrado: true, fromVenueId: 'vA' })

    // La PRIMERA sentencia es el candado de la fila, con el id de la terminal.
    expect(delegados.$queryRaw).toHaveBeenCalledTimes(1)
    const [sql, ...valores] = delegados.$queryRaw.mock.calls[0]
    expect((sql as string[]).join('?')).toMatch(/FROM "Terminal" WHERE id = \? FOR UPDATE/)
    expect(valores).toEqual(['t1'])

    const orden = [
      delegados.$queryRaw.mock.invocationCallOrder[0],
      delegados.customerDisplayDesign.deleteMany.mock.invocationCallOrder[0],
      delegados.terminal.update.mock.invocationCallOrder[0],
      delegados.activityLog.create.mock.invocationCallOrder[0],
    ]
    expect(orden.every(n => typeof n === 'number')).toBe(true)
    expect([...orden].sort((a, b) => a - b)).toEqual(orden)

    expect(delegados.customerDisplayDesign.deleteMany).toHaveBeenCalledWith({ where: { terminalId: 't1' } })
    expect(delegados.terminal.update).toHaveBeenCalledTimes(1)
    const { where, data } = delegados.terminal.update.mock.calls[0][0]
    expect(where).toEqual({ id: 't1' })
    expect(data).toEqual(LIMPIEZA_DEL_REPORTE) // exactamente las 5 columnas: ni una más, ni una menos
    expect(Object.keys(data)).toHaveLength(5)

    expect(delegados.activityLog.create).toHaveBeenCalledTimes(1)
    expect(delegados.activityLog.create.mock.calls[0][0].data).toMatchObject({
      staffId: 's1',
      venueId: 'vB',
      action: 'CUSTOMER_DISPLAY_DESIGN_RESET',
      entity: 'Terminal',
      entityId: 't1',
      data: { reason: 'terminal_moved', fromVenueId: 'vA', toVenueId: 'vB' },
    })
    expect(delegados.activityLog.create.mock.calls[0][0].data.data).toEqual({
      reason: 'terminal_moved',
      fromVenueId: 'vA',
      toVenueId: 'vB',
    })

    nadaPorElClienteGlobal()
  })

  it('al MISMO negocio sólo bloquea: no borra ni escribe', async () => {
    const { tx, delegados } = nuevoTx({ fila: { id: 't1', venueId: 'vB' } })

    const r = await borrarDisenoAlCambiarDeNegocio(tx, { terminalId: 't1', toVenueId: 'vB', reason: 'migration_reverted' })

    expect(r).toEqual({ cambio: false, disenoBorrado: false, fromVenueId: 'vB' })
    expect(delegados.$queryRaw).toHaveBeenCalledTimes(1)
    expect(delegados.customerDisplayDesign.deleteMany).not.toHaveBeenCalled()
    expect(delegados.terminal.update).not.toHaveBeenCalled()
    expect(delegados.activityLog.create).not.toHaveBeenCalled()
    nadaPorElClienteGlobal()
  })

  it('una terminal que no existe: no escribe nada', async () => {
    const { tx, delegados } = nuevoTx({ fila: null })

    const r = await borrarDisenoAlCambiarDeNegocio(tx, { terminalId: 't1', toVenueId: 'vB', reason: 'terminal_moved' })

    expect(r).toEqual({ cambio: false, disenoBorrado: false, fromVenueId: null })
    expect(delegados.$queryRaw).toHaveBeenCalledTimes(1)
    expect(delegados.customerDisplayDesign.deleteMany).not.toHaveBeenCalled()
    expect(delegados.terminal.update).not.toHaveBeenCalled()
    expect(delegados.activityLog.create).not.toHaveBeenCalled()
    nadaPorElClienteGlobal()
  })

  it('sin diseño que borrar: limpia el reporte del aparato, pero NO deja asiento', async () => {
    const { tx, delegados } = nuevoTx({ borrados: 0 })

    const r = await borrarDisenoAlCambiarDeNegocio(tx, { terminalId: 't1', toVenueId: 'vB', reason: 'terminal_moved', staffId: 's1' })

    expect(r).toEqual({ cambio: true, disenoBorrado: false, fromVenueId: 'vA' })
    expect(delegados.customerDisplayDesign.deleteMany).toHaveBeenCalledTimes(1)
    expect(delegados.terminal.update).toHaveBeenCalledTimes(1)
    expect(delegados.terminal.update.mock.calls[0][0].data).toEqual(LIMPIEZA_DEL_REPORTE)
    expect(delegados.activityLog.create).not.toHaveBeenCalled()
    nadaPorElClienteGlobal()
  })

  it('con el staffId de la sesión maestra: el asiento va sin FK y conserva quién fue en `data.unknownStaffId`', async () => {
    const { tx, delegados } = nuevoTx()

    await borrarDisenoAlCambiarDeNegocio(tx, { terminalId: 't1', toVenueId: 'vB', reason: 'terminal_moved', staffId: 'MASTER_ADMIN' })

    expect(delegados.activityLog.create).toHaveBeenCalledTimes(1)
    const asiento = delegados.activityLog.create.mock.calls[0][0].data
    expect(asiento.staffId).toBeNull()
    expect(asiento.data).toEqual({ reason: 'terminal_moved', fromVenueId: 'vA', toVenueId: 'vB', unknownStaffId: 'MASTER_ADMIN' })
    nadaPorElClienteGlobal()
  })

  it('re-exporta la MISMA invalidación de la caché de la ficha (la usan los escritores después del commit)', () => {
    expect(invalidateCustomerDisplayCache).toBe(cacheDeLaFicha.invalidateCustomerDisplayCache)
  })
})
