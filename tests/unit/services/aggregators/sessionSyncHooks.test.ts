import fs from 'node:fs'
import path from 'node:path'
import { prismaMock } from '@tests/__helpers__/setup'
import { enqueuePassSessionSync } from '@/services/aggregators/core/sessionSync.service'

describe('enqueuePassSessionSync', () => {
  // nuevo
  it('sin conexiones activas no escribe nada (cero costo para quien no usa pases)', async () => {
    prismaMock.aggregatorConnection.findMany.mockResolvedValueOnce([])
    await enqueuePassSessionSync(prismaMock as any, 'v1', 's1')
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
  })
  // nuevo
  it('con una conexión activa encola un SYNC_SESSION', async () => {
    prismaMock.aggregatorConnection.findMany.mockResolvedValueOnce([{ id: 'c1' }] as any)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(null)
    await enqueuePassSessionSync(prismaMock as any, 'v1', 's1')
    expect(prismaMock.aggregatorOutbox.create.mock.calls[0][0].data).toMatchObject({
      operation: 'SYNC_SESSION',
      classSessionId: 's1',
      coalesceKey: 'SYNC_SESSION:c1:s1',
    })
  })
})

/**
 * Guardia de fuente: cada sitio que encola un `UPDATE_ROSTER` de Google Calendar (la lista de la clase cambió) tiene
 * que avisar también al conector de pases, y la creación, edición y cancelación de sesiones igual. Una lista que
 * cambia sin avisar deja publicados en el proveedor lugares que ya no existen.
 */
describe('ganchos de sincronización de sesiones de pases', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../../../', rel), 'utf8')
  const count = (src: string, re: RegExp) => (src.match(re) ?? []).length
  const HOOK = /await enqueuePassSessionSync\(tx, /g

  // nuevo
  it.each([
    ['src/controllers/public/reservation.public.controller.ts', 1],
    ['src/services/dashboard/reservation.dashboard.service.ts', 2],
  ])('%s: un gancho por cada UPDATE_ROSTER', (file, rosterSites) => {
    const src = read(file)
    expect(count(src, /operation: 'UPDATE_ROSTER'/g)).toBe(rosterSites)
    expect(count(src, HOOK)).toBe(rosterSites)
  })

  // nuevo
  it('classSession.dashboard.service: alta, alta por lote, edición, cancelación y los dos UPDATE_ROSTER', () => {
    const src = read('src/services/dashboard/classSession.dashboard.service.ts')
    expect(count(src, /operation: 'UPDATE_ROSTER'/g)).toBe(2)
    expect(src).toMatch(/await enqueuePassSessionSync\(tx, venueId, session\.id\)/)
    expect(src).toMatch(/for \(const row of created\) await enqueuePassSessionSync\(tx, venueId, row\.id\)/)
    expect(src).toMatch(/await enqueuePassSessionSync\(tx, venueId, updated\.id\)/)
    expect(src).toMatch(/await enqueuePassSessionSync\(tx, venueId, cancelled\.id\)/)
    expect(count(src, /await enqueuePassSessionSync\(tx, venueId, sessionId\)/g)).toBe(2)
  })

  // nuevo — revisión final I3: cancelar o quitar a un socio de pase desde Avoqado avisa al proveedor
  it.each([['src/services/dashboard/reservation.dashboard.service.ts'], ['src/services/dashboard/classSession.dashboard.service.ts']])(
    '%s: la cancelación del estudio avisa al conector dentro de la misma transacción',
    file => {
      const src = read(file)
      expect(count(src, /await cancelPassBookingFromVenue\(tx, reservationId\)/g)).toBe(1)
    },
  )
})
