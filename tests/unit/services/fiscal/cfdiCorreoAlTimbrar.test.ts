/**
 * 🔴 H24 (auditoría 2026-09-30, ronda 1 de Codex del plan): el correo se manda desde el ÚNICO punto donde una factura pasa a
 * timbrada — no desde cada pantalla —. Así llega una sola vez venga del dashboard, la autofactura, una sustitución o una nota
 * de crédito, y una repetición que encuentra el timbre ya hecho no lo duplica.
 */
const mockSendNew = jest.fn()
jest.mock('@/services/fiscal/cfdiEmail.service', () => ({ sendNewCfdiByEmail: (...a: unknown[]) => mockSendNew(...a) }))

import { finalizarEmision } from '@/services/fiscal/cfdi.service'
import type { StampedInvoice } from '@/services/fiscal/providers/fiscal-provider.interface'

const reserva = { id: 'c1', venueId: 'v1', idempotencyKey: 'k1', attempts: 2, status: 'STAMPING' }
const timbre: StampedInvoice = {
  status: 'valid',
  providerInvoiceId: 'fa_1',
  uuid: 'U1',
  serie: 'A',
  folio: '36',
  totalCents: 308200,
  stampedAt: new Date(),
}
// Los archivos son best-effort: que fallen aquí no cambia el desenlace del timbre.
const provider = {
  downloadXml: jest.fn().mockRejectedValue(new Error('sin archivos')),
  downloadPdf: jest.fn().mockRejectedValue(new Error('sin archivos')),
  sendInvoiceByEmail: jest.fn(),
}
const deps = (actualizadas: number, actual: object | null = null) => ({
  runInTransaction: (work: any) =>
    work({
      cfdi: { updateMany: jest.fn().mockResolvedValue({ count: actualizadas }), findUnique: jest.fn().mockResolvedValue(actual) },
    }),
  findExistingCfdi: jest.fn().mockResolvedValue({ ...reserva, status: 'STAMPED', uuid: 'U1', facturapiId: 'fa_1' }),
  storeArtifact: jest.fn(),
  persistArtifacts: jest.fn(),
})

beforeEach(() => mockSendNew.mockClear())

it('quien finaliza el timbre solicita el envío del correo, una vez, con el proveedor que timbró', async () => {
  const r = await finalizarEmision(reserva, timbre, provider, 'mi-cafe', deps(1))

  expect(r.status).toBe('STAMPED')
  expect(mockSendNew).toHaveBeenCalledTimes(1)
  expect(mockSendNew).toHaveBeenCalledWith({ cfdiId: 'c1', venueId: 'v1', provider })
})

it('🔴 una repetición que encuentra el timbre ya finalizado no lo manda otra vez', async () => {
  const yaTimbrada = { status: 'STAMPED', attempts: 2, idempotencyKey: 'k1', uuid: 'U1', facturapiId: 'fa_1', venueId: 'v1' }

  const r = await finalizarEmision(reserva, timbre, provider, 'mi-cafe', deps(0, yaTimbrada))

  expect(r.status).toBe('STAMPED')
  expect(mockSendNew).not.toHaveBeenCalled()
})
