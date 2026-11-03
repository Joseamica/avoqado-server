import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { ConflictError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import { ProviderHttpError } from '@/services/fiscal/providers/facturapi.provider'
import {
  cancelPlatformCfdi,
  discardFailedPlatformCfdi,
  issuePlatformCfdi,
  refreshPlatformCfdi,
} from '@/services/superadmin/platform-billing/platformCfdi.service'
import { PlatformBillingError } from '@/services/superadmin/platform-billing/platformEmisor.service'

/**
 * «Facturas CFDI» sólo dice lo que el proveedor confirmó (D1): una respuesta sin timbre o cortada no es «Timbrada», «Cancelada» sólo si
 * el SAT la canceló, y antes de reintentar o descartar se le pregunta. El PAC es la frontera; las tablas, un doble en memoria.
 */

type Fila = Record<string, any>
const hace = (minutos: number) => new Date(Date.now() - minutos * 60_000)
const mockLog = logAction as jest.Mock

const LINEAS = [
  { description: 'Mensualidad', satProductKey: '81161700', satUnitKey: 'E48', quantity: 1, unitPriceCents: 159900, taxRate: 0.16 },
]
const PERFIL = {
  id: 'p1',
  rfc: 'XAXX010101000',
  razonSocial: 'CLIENTE DEMO',
  regimenFiscal: '601',
  codigoPostal: '06000',
  defaultUsoCfdi: 'G03',
  email: null,
  organizationId: 'org1',
  venueId: null,
}
const EMISOR = { id: 'em1', provider: 'FACTURAPI', providerKeyEnc: 'enc', csdStatus: 'ACTIVE', serie: 'A', defaultUsoCfdi: null }
const ENTRADA = {
  billingTaxProfileId: 'p1',
  lines: LINEAS,
  formaPago: '03',
  metodoPago: 'PUE' as const,
  idempotencyKey: 'llave-1',
  performedById: 'staff-1',
}
const DOC = {
  providerInvoiceId: 'fa-1',
  uuid: 'UUID-1',
  serie: 'A',
  folio: '118',
  totalCents: 185484,
  stampedAt: new Date('2026-11-03T12:00:00Z'),
  status: 'valid' as const,
}

function fila(over: Fila = {}): Fila {
  return {
    id: 'c1',
    type: 'INGRESO',
    platformEmisorId: 'em1',
    billingTaxProfileId: 'p1',
    platformChargeOccurrenceId: null,
    organizationId: 'org1',
    venueId: null,
    status: 'STAMPING',
    facturapiId: null,
    uuid: null,
    serie: 'A',
    folio: null,
    idempotencyKey: 'llave-1',
    receptorRfc: PERFIL.rfc,
    receptorNombre: PERFIL.razonSocial,
    receptorRegimen: PERFIL.regimenFiscal,
    receptorCp: PERFIL.codigoPostal,
    usoCfdi: 'G03',
    formaPago: '03',
    metodoPago: 'PUE',
    lines: LINEAS,
    totalCents: 185484,
    lastError: null,
    cancelStatus: null,
    cancelledAt: null,
    createdAt: hace(3),
    updatedAt: hace(3),
    ...over,
  }
}

let filas: Fila[]
let pac: Record<string, jest.Mock>

beforeEach(() => {
  filas = []
  mockLog.mockReset()
  pac = {
    createInvoice: jest.fn().mockResolvedValue(DOC),
    getInvoice: jest.fn(),
    findByExternalId: jest.fn().mockResolvedValue(null),
    getCancellationStatus: jest.fn(),
    cancelInvoice: jest.fn(),
  }
  ;(resolveFiscalProvider as jest.Mock).mockReturnValue(pac)
  prismaMock.platformEmisor.findFirst.mockResolvedValue(EMISOR)
  prismaMock.platformEmisor.findUnique.mockResolvedValue(EMISOR)
  prismaMock.billingTaxProfile.findUnique.mockResolvedValue(PERFIL)
  prismaMock.platformCfdi.count.mockResolvedValue(0)
  prismaMock.platformCfdi.findUnique.mockImplementation(async ({ where }: any) => {
    const f = where.id ? filas.find(x => x.id === where.id) : filas.find(x => x.idempotencyKey === where.idempotencyKey)
    return f ? { ...f } : null
  })
  prismaMock.platformCfdi.updateMany.mockImplementation(async ({ where, data }: any) => {
    const f = filas.find(
      x =>
        x.id === where.id &&
        (where.status?.in ? where.status.in.includes(x.status) : x.status === where.status) &&
        (!where.updatedAt || +x.updatedAt === +where.updatedAt),
    )
    if (!f) return { count: 0 }
    Object.assign(f, data, { updatedAt: new Date() })
    return { count: 1 }
  })
  prismaMock.platformCfdi.update.mockImplementation(async ({ where, data }: any) => {
    const f = filas.find(x => x.id === where.id)
    if (!f) throw new Error('sin fila')
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in (v as object)) continue
      f[k] = v
    }
    return { ...f }
  })
  prismaMock.platformCfdi.create.mockImplementation(async ({ data }: any) => {
    const f = { id: `nueva-${filas.length}`, createdAt: new Date(), ...data }
    filas.push(f)
    return { ...f }
  })
  prismaMock.platformCfdi.delete.mockImplementation(async ({ where }: any) => {
    const i = filas.findIndex(x => x.id === where.id)
    return { ...filas.splice(i, 1)[0] }
  })
  prismaMock.platformCfdi.deleteMany.mockImplementation(async ({ where }: any) => {
    const i = filas.findIndex(x => x.id === where.id && x.status === where.status)
    if (i < 0) return { count: 0 }
    filas.splice(i, 1)
    return { count: 1 }
  })
  prismaMock.platformCfdi.findUniqueOrThrow.mockImplementation(async ({ where }: any) => ({ ...filas.find(x => x.id === where.id) }))
  prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock))
})

describe('timbrar: lo que el PAC no confirmó no se da por hecho', () => {
  it.each([
    ['pending sin UUID', { ...DOC, status: 'pending', uuid: null }],
    ['valid sin UUID', { ...DOC, status: 'valid', uuid: null }],
  ])('%s: la fila se queda STAMPING con su id, nunca «Timbrada»', async (_n, respuesta) => {
    pac.createInvoice.mockResolvedValue(respuesta)

    const cfdi = await issuePlatformCfdi(ENTRADA)

    expect(cfdi).toMatchObject({ status: 'STAMPING', facturapiId: 'fa-1' })
    expect(filas[0].uuid ?? null).toBeNull()
  })

  it('un corte de red deja la fila STAMPING y dice que pudo quedar en camino, marcado para conservar la llave', async () => {
    pac.createInvoice.mockRejectedValue(new Error('ETIMEDOUT'))

    const error = await issuePlatformCfdi(ENTRADA).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(PlatformBillingError)
    expect(error).toMatchObject({ code: 'PROVIDER', attempt: { inFlight: true, cfdiId: 'nueva-0' } })
    expect((error as Error).message).toMatch(/^La factura pudo quedar en camino/)
    expect(filas[0]).toMatchObject({ status: 'STAMPING', lastError: 'ETIMEDOUT' })
  })

  it('un rechazo confirmado es STAMP_FAILED y no está en camino: se puede corregir con otra llave', async () => {
    pac.createInvoice.mockRejectedValue(new ProviderHttpError(400, 'invoice_stamping_validation_error', 'Clave inexistente'))

    const error = await issuePlatformCfdi(ENTRADA).catch((e: unknown) => e)

    expect((error as PlatformBillingError).attempt).toEqual({ inFlight: false, cfdiId: 'nueva-0' })
    expect(filas[0].status).toBe('STAMP_FAILED')
  })

  it('🔴 un rechazo sin confirmar que parece un dato malo tampoco libera la llave: la fila sigue en camino', async () => {
    pac.createInvoice.mockRejectedValue(new ProviderHttpError(400, 'codigo_nuevo', 'El campo Nombre del receptor no coincide'))

    const error = await issuePlatformCfdi(ENTRADA).catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'VALIDATION', attempt: { inFlight: true } })
    expect(filas[0].status).toBe('STAMPING')
  })
})

describe('la misma llave es el mismo intento', () => {
  it('con los mismos datos regresa la fila y no timbra', async () => {
    filas.push(fila({ status: 'STAMPED', uuid: 'UUID-1', facturapiId: 'fa-1' }))

    await expect(issuePlatformCfdi(ENTRADA)).resolves.toMatchObject({ id: 'c1', status: 'STAMPED' })

    expect(pac.createInvoice).not.toHaveBeenCalled()
  })

  it('el orden de los campos guardados no la vuelve otra', async () => {
    const [l] = LINEAS
    const guardadas = [
      {
        taxRate: l.taxRate,
        quantity: l.quantity,
        satUnitKey: l.satUnitKey,
        description: l.description,
        satProductKey: l.satProductKey,
        unitPriceCents: l.unitPriceCents,
      },
    ]
    filas.push(fila({ status: 'STAMPED', uuid: 'UUID-1', lines: guardadas }))

    await expect(issuePlatformCfdi(ENTRADA)).resolves.toMatchObject({ id: 'c1' })
  })

  it.each([
    ['otro monto', () => ({ ...ENTRADA, lines: [{ ...LINEAS[0], unitPriceCents: 1 }] })],
    ['otra forma de pago', () => ({ ...ENTRADA, formaPago: '04' })],
  ])('🔴 con %s es 409: no regresa la factura vieja como si fuera ésta', async (_n, entrada) => {
    filas.push(fila({ status: 'STAMPED', uuid: 'UUID-1' }))

    await expect(issuePlatformCfdi(entrada())).rejects.toMatchObject({ code: 'PLATFORM_CFDI_OTHER_DATA' })

    expect(pac.createInvoice).not.toHaveBeenCalled()
  })

  it('🔴 con el perfil corregido en la misma fila también es 409', async () => {
    filas.push(fila({ status: 'STAMPED', uuid: 'UUID-1' }))
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue({ ...PERFIL, codigoPostal: '11000' })

    await expect(issuePlatformCfdi(ENTRADA)).rejects.toBeInstanceOf(ConflictError)
  })
})

describe('«Consultar estado»: le pregunta al PAC y nunca emite', () => {
  afterEach(() => expect(pac.createInvoice).not.toHaveBeenCalled())

  it('STAMPING de menos de 2 min: 409 sin preguntar', async () => {
    filas.push(fila({ createdAt: hace(1) }))

    await expect(refreshPlatformCfdi('c1')).rejects.toMatchObject({ code: 'PLATFORM_CFDI_STAMPING' })

    expect(pac.findByExternalId).not.toHaveBeenCalled()
  })

  it('STAMPING vieja y el PAC la tiene: la adopta, deja rastro y manda el correo que se debía', async () => {
    filas.push(fila({ lastError: 'ETIMEDOUT' }))
    pac.findByExternalId.mockResolvedValue({ ...DOC, customerTaxId: PERFIL.rfc, isGlobal: false })
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue({ ...PERFIL, email: 'a@b.mx' })
    pac.sendInvoiceByEmail = jest.fn().mockResolvedValue(undefined)

    await expect(refreshPlatformCfdi('c1', 'staff-1')).resolves.toMatchObject({
      status: 'STAMPED',
      uuid: 'UUID-1',
      folio: '118',
      lastError: null,
    })

    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PLATFORM_CFDI_ISSUED', staffId: 'staff-1' }))
  })

  it('STAMPING vieja y el PAC no tiene nada: pasa a fallida, y ahora sí se puede reintentar o descartar', async () => {
    filas.push(fila())

    await expect(refreshPlatformCfdi('c1')).resolves.toMatchObject({ status: 'STAMP_FAILED' })
  })

  it('en camino: guarda el id, sigue STAMPING y la próxima pregunta por ese id', async () => {
    filas.push(fila())
    pac.findByExternalId.mockResolvedValue({ ...DOC, status: 'pending', uuid: null })

    await expect(refreshPlatformCfdi('c1')).resolves.toMatchObject({ status: 'STAMPING', facturapiId: 'fa-1' })

    pac.getInvoice.mockResolvedValue(DOC)
    await expect(refreshPlatformCfdi('c1')).resolves.toMatchObject({ status: 'STAMPED', uuid: 'UUID-1' })
    expect(pac.getInvoice).toHaveBeenCalledWith('fa-1')
  })

  it('el documento está cancelado: la fila es su rastro, con su UUID', async () => {
    filas.push(fila({ facturapiId: 'fa-1' }))
    pac.getInvoice.mockResolvedValue({ ...DOC, status: 'canceled' })

    await expect(refreshPlatformCfdi('c1')).resolves.toMatchObject({ status: 'CANCELLED', uuid: 'UUID-1', cancelStatus: 'canceled' })
  })

  it('el PAC no contesta: 409 y nada cambia', async () => {
    filas.push(fila())
    pac.findByExternalId.mockRejectedValue(new Error('caído'))

    await expect(refreshPlatformCfdi('c1')).rejects.toMatchObject({ code: 'PLATFORM_CHARGE_INVOICE_UNCONFIRMED' })

    expect(filas[0].status).toBe('STAMPING')
  })

  it('una factura ya confirmada se regresa sin preguntar', async () => {
    filas.push(fila({ status: 'STAMPED', uuid: 'UUID-1', facturapiId: 'fa-1' }))

    await expect(refreshPlatformCfdi('c1')).resolves.toMatchObject({ status: 'STAMPED' })

    expect(pac.getInvoice).not.toHaveBeenCalled()
  })

  it('🔴 una fila vieja «Timbrada» sin UUID también se puede consultar, y queda como es', async () => {
    filas.push(fila({ status: 'STAMPED', uuid: null, facturapiId: 'fa-1' }))
    pac.getInvoice.mockResolvedValue({ ...DOC, status: 'pending', uuid: null })

    await expect(refreshPlatformCfdi('c1')).resolves.toMatchObject({ status: 'STAMPING' })
  })

  it.each([
    ['canceled', 'CANCELLED'],
    ['accepted', 'CANCELLED'],
    ['pending', 'CANCEL_REQUESTED'],
    ['rejected', 'STAMPED'],
    ['expired', 'STAMPED'],
    ['none', 'STAMPED'],
  ])('cancelación en trámite y el SAT dice %s: queda %s', async (respuesta, estado) => {
    filas.push(fila({ status: 'CANCEL_REQUESTED', cancelStatus: 'pending', uuid: 'UUID-1', facturapiId: 'fa-1' }))
    pac.getCancellationStatus.mockResolvedValue({ status: respuesta, cancelledAt: null })

    await expect(refreshPlatformCfdi('c1')).resolves.toMatchObject({ status: estado })
  })

  it('🔴 una respuesta vieja no pisa una cancelación NUEVA, aunque la fila haya vuelto al mismo estado', async () => {
    filas.push(fila({ status: 'CANCEL_REQUESTED', cancelStatus: 'pending', uuid: 'UUID-1', facturapiId: 'fa-1' }))
    pac.getCancellationStatus.mockImplementationOnce(async () => {
      // Mientras esta consulta espera, otra pestaña consultó (no procedió) y volvió a cancelar: otro trámite, con el mismo estado.
      filas[0].updatedAt = new Date()
      return { status: 'rejected', cancelledAt: null }
    })

    await expect(refreshPlatformCfdi('c1')).rejects.toMatchObject({ code: 'PLATFORM_CFDI_CHANGED' })

    expect(filas[0].status).toBe('CANCEL_REQUESTED')
  })

  it('🔴 recién pedida (menos de 2 min) y el PAC dice «none»: la petición puede seguir en vuelo, no se regresa a timbrada', async () => {
    filas.push(fila({ status: 'CANCEL_REQUESTED', cancelStatus: 'pending', uuid: 'UUID-1', facturapiId: 'fa-1', updatedAt: hace(1) }))
    pac.getCancellationStatus.mockResolvedValue({ status: 'none', cancelledAt: null })

    await expect(refreshPlatformCfdi('c1')).resolves.toMatchObject({ status: 'CANCEL_REQUESTED' })

    filas[0].updatedAt = hace(3)
    await expect(refreshPlatformCfdi('c1')).resolves.toMatchObject({ status: 'STAMPED' })
  })

  it('🔴 una fila vieja «Cancelada» con la cancelación sin confirmar se corrige; una confirmada no se pregunta', async () => {
    filas.push(fila({ status: 'CANCELLED', cancelStatus: 'pending', uuid: 'UUID-1', facturapiId: 'fa-1' }))
    pac.getCancellationStatus.mockResolvedValue({ status: 'rejected', cancelledAt: null })
    await expect(refreshPlatformCfdi('c1')).resolves.toMatchObject({ status: 'STAMPED', cancelledAt: null })

    filas[0] = fila({ status: 'CANCELLED', cancelStatus: 'canceled', uuid: 'UUID-1', facturapiId: 'fa-1' })
    pac.getCancellationStatus.mockClear()
    await expect(refreshPlatformCfdi('c1')).resolves.toMatchObject({ status: 'CANCELLED' })
    expect(pac.getCancellationStatus).not.toHaveBeenCalled()
  })

  it('una fila de «Por cobrar» en camino se consulta allá; su cancelación sí aquí, que es la salida de «Deshacer»', async () => {
    filas.push(fila({ platformChargeOccurrenceId: 'occ-1' }))
    await expect(refreshPlatformCfdi('c1')).rejects.toMatchObject({ code: 'PLATFORM_CFDI_OF_A_CHARGE' })

    filas[0] = fila({ platformChargeOccurrenceId: 'occ-1', status: 'CANCEL_REQUESTED', uuid: 'UUID-1', facturapiId: 'fa-1' })
    pac.getCancellationStatus.mockResolvedValue({ status: 'accepted', cancelledAt: null })
    await expect(refreshPlatformCfdi('c1')).resolves.toMatchObject({ status: 'CANCELLED' })
  })

  it('el timbre de un complemento de pago no se consulta aquí: adoptarlo también tendría que mover el saldo del padre', async () => {
    filas.push(fila({ type: 'PAGO' }))

    await expect(refreshPlatformCfdi('c1')).rejects.toMatchObject({ code: 'VALIDATION' })

    expect(pac.findByExternalId).not.toHaveBeenCalled()
  })

  it('🔴 su cancelación sí: sin esto quedaba en trámite para siempre', async () => {
    filas.push(fila({ type: 'PAGO', status: 'CANCEL_REQUESTED', cancelStatus: 'pending', uuid: 'U', facturapiId: 'fa-1' }))
    pac.getCancellationStatus.mockResolvedValue({ status: 'accepted', cancelledAt: null })

    await expect(refreshPlatformCfdi('c1')).resolves.toMatchObject({ status: 'CANCELLED' })
  })
})

describe('«Descartar» pregunta antes de borrar', () => {
  const fallida = () => fila({ status: 'STAMP_FAILED', lastError: 'ETIMEDOUT' })

  it('el PAC no tiene nada: borra', async () => {
    filas.push(fallida())

    await expect(discardFailedPlatformCfdi('c1', 'staff-1')).resolves.toMatchObject({ id: 'c1' })

    expect(filas).toHaveLength(0)
  })

  it('🔴 sí se timbró: la adopta, no la borra y lo dice', async () => {
    filas.push(fallida())
    pac.findByExternalId.mockResolvedValue({ ...DOC, customerTaxId: PERFIL.rfc, isGlobal: false })

    const error = await discardFailedPlatformCfdi('c1', 'staff-1').catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'PLATFORM_CFDI_NOT_RETRYABLE' })
    expect((error as Error).message).toMatch(/sí se timbró \(A-118\).*No se descartó/)
    expect(filas[0]).toMatchObject({ status: 'STAMPED', uuid: 'UUID-1' })
  })

  it('sigue en camino: no borra', async () => {
    filas.push(fallida())
    pac.findByExternalId.mockResolvedValue({ ...DOC, status: 'pending', uuid: null })

    await expect(discardFailedPlatformCfdi('c1')).rejects.toMatchObject({ code: 'PLATFORM_CFDI_NOT_RETRYABLE' })

    expect(filas[0]).toMatchObject({ status: 'STAMPING', facturapiId: 'fa-1' })
  })

  it('el PAC no contesta: no autoriza nada', async () => {
    filas.push(fallida())
    pac.findByExternalId.mockRejectedValue(new Error('caído'))

    await expect(discardFailedPlatformCfdi('c1')).rejects.toBeInstanceOf(ConflictError)

    expect(filas).toHaveLength(1)
  })

  it('🔴 otra pestaña la adoptó mientras se preguntaba: no se borra una factura viva', async () => {
    filas.push(fallida())
    const borrar = prismaMock.platformCfdi.deleteMany.getMockImplementation()
    prismaMock.platformCfdi.deleteMany.mockImplementation(async (args: any) => {
      filas[0].status = 'STAMPED' // la otra pestaña llega justo antes del borrado
      return borrar!(args)
    })

    await expect(discardFailedPlatformCfdi('c1')).rejects.toMatchObject({ code: 'PLATFORM_CFDI_CHANGED' })

    expect(filas[0].status).toBe('STAMPED')
  })

  it('un complemento de pago fallido se descarta como siempre, sin preguntar', async () => {
    filas.push(fila({ type: 'PAGO', status: 'STAMP_FAILED' }))

    await expect(discardFailedPlatformCfdi('c1')).resolves.toMatchObject({ id: 'c1' })

    expect(pac.findByExternalId).not.toHaveBeenCalled()
    expect(filas).toHaveLength(0)
  })
})

describe('«Reintentar» consulta y reemplaza de un jalón', () => {
  const fallida = () => fila({ id: 'vieja', idempotencyKey: 'llave-vieja', status: 'STAMP_FAILED', lastError: 'ETIMEDOUT' })
  const REINTENTO = { ...ENTRADA, retryOfId: 'vieja' }

  it('el PAC no tiene la vieja: en la misma transacción la quita y reserva la nueva, y luego timbra', async () => {
    filas.push(fallida())
    const orden: string[] = []
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      orden.push('tx:inicio')
      const r = await fn(prismaMock)
      orden.push(`tx:fin filas=${filas.map(f => f.id).join(',')}`)
      return r
    })
    pac.createInvoice.mockImplementation(async () => {
      orden.push('timbrar')
      return DOC
    })

    await expect(issuePlatformCfdi(REINTENTO)).resolves.toMatchObject({ status: 'STAMPED', uuid: 'UUID-1' })

    expect(orden).toEqual(['tx:inicio', 'tx:fin filas=nueva-0', 'timbrar'])
    expect(pac.findByExternalId).toHaveBeenCalledWith('llave-vieja')
    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PLATFORM_CFDI_DISCARDED', entityId: 'vieja' }))
  })

  it('🔴 la vieja sí se timbró: la adopta y no timbra otra', async () => {
    filas.push(fallida())
    pac.findByExternalId.mockResolvedValue({ ...DOC, customerTaxId: PERFIL.rfc, isGlobal: false })

    const error = await issuePlatformCfdi(REINTENTO).catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'PLATFORM_CFDI_NOT_RETRYABLE' })
    expect((error as Error).message).toMatch(/sí se timbró \(A-118\).*No se timbró otra/)
    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(filas.map(f => [f.id, f.status])).toEqual([['vieja', 'STAMPED']])
  })

  it('la vieja sigue en camino: no timbra otra', async () => {
    filas.push(fallida())
    pac.findByExternalId.mockResolvedValue({ ...DOC, status: 'pending', uuid: null })

    await expect(issuePlatformCfdi(REINTENTO)).rejects.toMatchObject({ code: 'PLATFORM_CFDI_NOT_RETRYABLE' })

    expect(pac.createInvoice).not.toHaveBeenCalled()
  })

  it('🔴 otra pestaña adoptó la vieja justo antes de la transacción: no la borra ni timbra otra', async () => {
    filas.push(fallida())
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      filas[0].status = 'STAMPED'
      return fn(prismaMock)
    })

    await expect(issuePlatformCfdi(REINTENTO)).rejects.toMatchObject({ code: 'PLATFORM_CFDI_CHANGED' })

    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(filas.map(f => f.status)).toEqual(['STAMPED'])
  })

  it('🔴 la nueva también la rechaza el PAC: el error trae su id, para que corregir la reemplace a ella', async () => {
    filas.push(fallida())
    pac.createInvoice.mockRejectedValueOnce(new ProviderHttpError(400, 'invoice_stamping_validation_error', 'Clave inexistente'))

    const error = await issuePlatformCfdi(REINTENTO).catch((e: unknown) => e)

    expect(error).toMatchObject({ attempt: { inFlight: false, cfdiId: 'nueva-0' } })
    expect(filas.map(f => [f.id, f.status])).toEqual([['nueva-0', 'STAMP_FAILED']])

    await expect(issuePlatformCfdi({ ...ENTRADA, idempotencyKey: 'llave-2', retryOfId: 'nueva-0' })).resolves.toMatchObject({
      status: 'STAMPED',
    })
    expect(filas).toHaveLength(1)
  })

  it('🔴 se perdió la respuesta y se repite con la misma llave: regresa la nueva, sin una tercera', async () => {
    filas.push(fallida())
    await issuePlatformCfdi(REINTENTO)
    pac.createInvoice.mockClear()
    pac.findByExternalId.mockClear()

    await expect(issuePlatformCfdi(REINTENTO)).resolves.toMatchObject({ status: 'STAMPED' })

    expect(pac.createInvoice).not.toHaveBeenCalled()
    expect(filas).toHaveLength(1)
  })
})

describe('«Cancelar» dice lo que dijo el SAT', () => {
  const timbrada = () => fila({ status: 'STAMPED', uuid: 'UUID-1', facturapiId: 'fa-1' })

  it.each(['canceled', 'accepted'])('%s: queda «Cancelada»', async respuesta => {
    filas.push(timbrada())
    pac.cancelInvoice.mockResolvedValue({ status: respuesta, cancelledAt: null })

    await expect(cancelPlatformCfdi('c1', '02')).resolves.toMatchObject({ status: 'CANCELLED', cancelMotivo: '02' })
  })

  it('🔴 en trámite: CANCEL_REQUESTED, sin fecha de cancelación', async () => {
    filas.push(timbrada())
    pac.cancelInvoice.mockResolvedValue({ status: 'pending', cancelledAt: null })

    await expect(cancelPlatformCfdi('c1', '02')).resolves.toMatchObject({
      status: 'CANCEL_REQUESTED',
      cancelStatus: 'pending',
      cancelledAt: null,
    })
  })

  it('🔴 se apunta antes de llamar: si la respuesta se pierde, queda en trámite y se puede consultar', async () => {
    filas.push(timbrada())
    pac.cancelInvoice.mockImplementation(async () => {
      expect(filas[0].status).toBe('CANCEL_REQUESTED') // ya quedó escrito antes de llamar
      throw new Error('ETIMEDOUT')
    })

    await expect(cancelPlatformCfdi('c1', '02')).rejects.toMatchObject({ code: 'PROVIDER', attempt: { inFlight: true } })

    expect(filas[0]).toMatchObject({ status: 'CANCEL_REQUESTED', cancelMotivo: '02' })
    pac.getCancellationStatus.mockResolvedValue({ status: 'canceled', cancelledAt: null })
    await expect(refreshPlatformCfdi('c1')).resolves.toMatchObject({ status: 'CANCELLED' })
  })

  it('🔴 otra pestaña consulta a media cancelación y el PAC todavía dice «none»: no se pierde el trámite', async () => {
    filas.push(timbrada())
    pac.getCancellationStatus.mockResolvedValue({ status: 'none', cancelledAt: null })
    pac.cancelInvoice.mockImplementation(async () => {
      filas[0].updatedAt = new Date() // lo escribió la cancelación hace un instante
      await expect(refreshPlatformCfdi('c1')).resolves.toMatchObject({ status: 'CANCEL_REQUESTED' })
      return { status: 'pending', cancelledAt: null }
    })

    await expect(cancelPlatformCfdi('c1', '02')).resolves.toMatchObject({ status: 'CANCEL_REQUESTED' })
    expect(filas[0].status).toBe('CANCEL_REQUESTED')
  })

  it('🔴 aunque la consulta la haya regresado a timbrada, la respuesta de la cancelación manda: en trámite', async () => {
    filas.push(timbrada())
    pac.cancelInvoice.mockImplementation(async () => {
      filas[0].status = 'STAMPED'
      return { status: 'pending', cancelledAt: null }
    })

    await expect(cancelPlatformCfdi('c1', '02')).resolves.toMatchObject({ status: 'CANCEL_REQUESTED', cancelStatus: 'pending' })
  })

  it.each(['4xx', 'rejected'])('🔴 un %s tardío no pisa una cancelación que otra pestaña ya confirmó', async caso => {
    filas.push(timbrada())
    pac.cancelInvoice.mockImplementation(async () => {
      filas[0].status = 'CANCELLED'
      filas[0].cancelStatus = 'canceled'
      if (caso === '4xx') throw new ProviderHttpError(400, 'invalid_request', 'Ya estaba cancelada')
      return { status: 'rejected', cancelledAt: null }
    })

    await expect(cancelPlatformCfdi('c1', '02')).rejects.toBeDefined()

    expect(filas[0]).toMatchObject({ status: 'CANCELLED', cancelStatus: 'canceled' })
  })

  it('el proveedor contesta que no (4xx): no pasó nada y sigue timbrada', async () => {
    filas.push(timbrada())
    pac.cancelInvoice.mockRejectedValue(new ProviderHttpError(400, 'invalid_request', 'No se puede cancelar'))

    await expect(cancelPlatformCfdi('c1', '02')).rejects.toMatchObject({ code: 'PROVIDER' })

    expect(filas[0]).toMatchObject({ status: 'STAMPED' })
  })

  it('otra pestaña ya la está cancelando: 409, y no se llama al proveedor dos veces', async () => {
    filas.push(timbrada())
    prismaMock.platformCfdi.updateMany.mockResolvedValueOnce({ count: 0 })

    await expect(cancelPlatformCfdi('c1', '02')).rejects.toMatchObject({ code: 'PLATFORM_CFDI_CHANGED' })

    expect(pac.cancelInvoice).not.toHaveBeenCalled()
  })

  it.each(['rejected', 'expired', 'none'])('🔴 %s: sigue timbrada y lo dice', async respuesta => {
    filas.push(timbrada())
    pac.cancelInvoice.mockResolvedValue({ status: respuesta, cancelledAt: null })

    const error = await cancelPlatformCfdi('c1', '02').catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'PLATFORM_CFDI_CANCEL_NOT_DONE' })
    expect((error as Error).message).toMatch(/A-.*no procedió: sigue vigente|no procedió: sigue vigente/)
    expect(filas[0]).toMatchObject({ status: 'STAMPED', cancelStatus: respuesta })
  })
})
