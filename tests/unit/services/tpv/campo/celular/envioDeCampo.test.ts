/**
 * Un envío del celular aplicado fuera de su ruta (App de campo, bloque 1, Tarea 7): la gracia y «Aplicar» llaman a los
 * MISMOS servicios con los MISMOS esquemas. Los servicios van mockeados; aquí se prueba la huella, la validación, el acomodo
 * de argumentos y cómo se normaliza el desenlace (aplicado, rechazo definitivo o reintentable que se lanza).
 */
import { createHash, randomUUID } from 'crypto'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { resolveUserRoleForVenue } from '@/middlewares/checkPermission.middleware'
import { registrarVentaDeCampo } from '@/services/tpv/campo/ventaDeCampo.service'
import { registrarEntradaDeCampo, registrarSalidaDeCampo } from '@/services/tpv/campo/checadaDeCampo.service'
import { aceptarCustodiaDeCampo, rechazarCustodiaDeCampo } from '@/services/tpv/campo/custodiaDeCampo.service'
import { createOrUpdateProofOfSale } from '@/services/tpv/sale-verification.service'
import { aplicarEnvio, cuerpoValido, efectoYaHecho, huellaDelEnvio, permisosDelEnvio } from '@/services/tpv/campo/celular/envioDeCampo'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    ventaDeCampo: { findUnique: jest.fn() },
    timeEntry: { findUnique: jest.fn() },
    serializedItemCustodyEvent: { findMany: jest.fn() },
    saleVerification: { findUnique: jest.fn() },
  },
}))
jest.mock('@/middlewares/checkPermission.middleware', () => ({ resolveUserRoleForVenue: jest.fn() }))
jest.mock('@/services/tpv/campo/ventaDeCampo.service', () => ({ registrarVentaDeCampo: jest.fn() }))
jest.mock('@/services/tpv/campo/checadaDeCampo.service', () => ({ registrarEntradaDeCampo: jest.fn(), registrarSalidaDeCampo: jest.fn() }))
jest.mock('@/services/tpv/campo/custodiaDeCampo.service', () => ({ aceptarCustodiaDeCampo: jest.fn(), rechazarCustodiaDeCampo: jest.fn() }))
jest.mock('@/services/tpv/sale-verification.service', () => ({ createOrUpdateProofOfSale: jest.fn() }))

const db = prisma as any
const venta = registrarVentaDeCampo as jest.Mock
const entrada = registrarEntradaDeCampo as jest.Mock
const salida = registrarSalidaDeCampo as jest.Mock
const aceptar = aceptarCustodiaDeCampo as jest.Mock
const rechazar = rechazarCustodiaDeCampo as jest.Mock
const evidencia = createOrUpdateProofOfSale as jest.Mock
const ctx = { venueId: 'v1', orgId: 'o1', staffId: 's1', celularId: 'cel1' }
const llave = randomUUID()
const cuerpoVenta = { llave, serialNumber: '8952 0001', precioVisto: 0 }

beforeEach(() => {
  jest.resetAllMocks()
  ;(resolveUserRoleForVenue as jest.Mock).mockResolvedValue({ role: 'CASHIER', source: 'staffVenue' })
})

describe('huellaDelEnvio', () => {
  it('es el sha256 hex de tipo, sucursal y cuerpo separados por salto de línea, y cambia con un solo carácter del cuerpo', () => {
    const cuerpo = '{"llave":"x","precioVisto":0}'
    const h = huellaDelEnvio('VENTA', 'v1', cuerpo)
    expect(h).toBe(createHash('sha256').update(`VENTA\nv1\n${cuerpo}`).digest('hex'))
    expect(h).toMatch(/^[a-f0-9]{64}$/)
    expect(huellaDelEnvio('VENTA', 'v1', '{"llave":"x","precioVisto":1}')).not.toBe(h)
    expect(huellaDelEnvio('ENTRADA', 'v1', cuerpo)).not.toBe(h)
    expect(huellaDelEnvio('VENTA', 'v2', cuerpo)).not.toBe(h)
  })
})

describe('permisosDelEnvio', () => {
  it('los mismos permisos que la ruta normal de cada tipo', () => {
    expect(permisosDelEnvio('VENTA')).toEqual(['serialized-inventory:sell', 'payments:create'])
    expect(permisosDelEnvio('CUSTODIA_ACEPTAR')).toEqual(['tpv-sim-custody:accept'])
    expect(permisosDelEnvio('CUSTODIA_RECHAZAR')).toEqual(['tpv-sim-custody:reject'])
    expect(permisosDelEnvio('EVIDENCIA')).toEqual(['payments:create'])
    expect(permisosDelEnvio('ENTRADA')).toEqual([])
    expect(permisosDelEnvio('SALIDA')).toEqual([])
  })
})

describe('aplicarEnvio', () => {
  it('VENTA: valida con el esquema de la ruta (normaliza la serie) y llama al MISMO servicio con el celular', async () => {
    const r = { orderId: 'o', paymentId: 'p', saleVerificationId: 'sv', repetida: false, precio: '0.00', hora: 'h' }
    venta.mockResolvedValue(r)
    expect(await aplicarEnvio(ctx, 'VENTA', cuerpoVenta)).toEqual({ tipo: 'APLICADO', status: 201, body: r })
    expect(venta).toHaveBeenCalledWith(
      { venueId: 'v1', orgId: 'o1', staffId: 's1', celularId: 'cel1' },
      expect.objectContaining({ llave, serialNumber: '89520001', precioVisto: 0 }),
    )
    venta.mockResolvedValue({ ...r, repetida: true })
    expect(await aplicarEnvio(ctx, 'VENTA', cuerpoVenta)).toMatchObject({ tipo: 'APLICADO', status: 200 })
  })

  it('un cuerpo que el esquema rechaza → RECHAZADO CUERPO_INVALIDO sin llamar al servicio', async () => {
    const r = await aplicarEnvio(ctx, 'VENTA', { llave: 'no-uuid', serialNumber: 'X', precioVisto: 0 })
    expect(r).toMatchObject({ tipo: 'RECHAZADO', rechazo: { code: 'CUERPO_INVALIDO' } })
    expect(venta).not.toHaveBeenCalled()
  })

  it('un 4xx definitivo (SIM_YA_VENDIDA) → RECHAZADO con su code, message y detalle', async () => {
    venta.mockRejectedValue(new ConflictError('Esta SIM ya se vendió.', 'SIM_YA_VENDIDA'))
    expect(await aplicarEnvio(ctx, 'VENTA', cuerpoVenta)).toEqual({
      tipo: 'RECHAZADO',
      rechazo: { code: 'SIM_YA_VENDIDA', message: 'Esta SIM ya se vendió.' },
    })
    venta.mockRejectedValue(new ConflictError('cambió', 'PRECIO_CAMBIO', { precioActual: '100.00' }))
    expect(await aplicarEnvio(ctx, 'VENTA', cuerpoVenta)).toEqual({
      tipo: 'RECHAZADO',
      rechazo: { code: 'PRECIO_CAMBIO', message: 'cambió', detalle: { precioActual: '100.00' } },
    })
  })

  it('lo reintentable se LANZA tal cual: VENTA_EN_PROCESO, CHECADA_EN_PROCESO, 429 y 5xx', async () => {
    const enProceso = new ConflictError('procesando', 'VENTA_EN_PROCESO')
    venta.mockRejectedValue(enProceso)
    await expect(aplicarEnvio(ctx, 'VENTA', cuerpoVenta)).rejects.toBe(enProceso)
    const checada = new ConflictError('cambió', 'CHECADA_EN_PROCESO')
    salida.mockRejectedValue(checada)
    await expect(aplicarEnvio(ctx, 'SALIDA', { llave, llaveEntrada: randomUUID() })).rejects.toBe(checada)
    const caida = new Error('se cayó la base')
    entrada.mockRejectedValue(caida)
    await expect(aplicarEnvio(ctx, 'ENTRADA', { llave })).rejects.toBe(caida)
  })

  it('ENTRADA y SALIDA: el mismo servicio con la sucursal y la persona; 201 nueva / 200 repetida, salida 200', async () => {
    entrada.mockResolvedValue({ timeEntryId: 't', repetida: false, hora: 'h' })
    expect(await aplicarEnvio(ctx, 'ENTRADA', { llave })).toMatchObject({ tipo: 'APLICADO', status: 201 })
    expect(entrada).toHaveBeenCalledWith({ venueId: 'v1', staffId: 's1' }, { llave })
    salida.mockResolvedValue({ timeEntryId: 't', repetida: true })
    expect(await aplicarEnvio(ctx, 'SALIDA', { llave, timeEntryId: 't' })).toMatchObject({ tipo: 'APLICADO', status: 200 })
    // La salida con las dos llaves no pasa el esquema (su refine).
    expect(await aplicarEnvio(ctx, 'SALIDA', { llave, timeEntryId: 't', llaveEntrada: randomUUID() })).toMatchObject({
      tipo: 'RECHAZADO',
      rechazo: { code: 'CUERPO_INVALIDO' },
    })
  })

  it('CUSTODIA_ACEPTAR: el servicio de custodia con el rol de la persona en ESA sucursal; todo bien → APLICADO', async () => {
    const body = { summary: { total: 1, succeeded: 1, failed: 0 }, results: [{ serialNumber: 'A', status: 'ok', repetida: false }] }
    aceptar.mockResolvedValue({ status: 200, body })
    const sims = [{ serialNumber: 'A', custodyVersion: 1 }]
    expect(await aplicarEnvio(ctx, 'CUSTODIA_ACEPTAR', { sims })).toEqual({ tipo: 'APLICADO', status: 200, body })
    expect(resolveUserRoleForVenue).toHaveBeenCalledWith({ userId: 's1', targetVenueId: 'v1' })
    expect(aceptar).toHaveBeenCalledWith({ venueId: 'v1', staffId: 's1', role: 'CASHIER' }, { sims })
  })

  it('custodia con summary.failed = 1 → RECHAZADO con la fila fallida (y el resumen) en detalle', async () => {
    const fallida = { serialNumber: 'B', status: 'error', code: 'NOT_IN_YOUR_CUSTODY', message: 'no es tuya' }
    const body = {
      summary: { total: 2, succeeded: 1, failed: 1 },
      results: [{ serialNumber: 'A', status: 'ok', repetida: false }, fallida],
    }
    aceptar.mockResolvedValue({ status: 200, body })
    const r = await aplicarEnvio(ctx, 'CUSTODIA_ACEPTAR', {
      sims: [
        { serialNumber: 'A', custodyVersion: 1 },
        { serialNumber: 'B', custodyVersion: 1 },
      ],
    })
    expect(r).toEqual({
      tipo: 'RECHAZADO',
      rechazo: { code: 'CUSTODIA_INCOMPLETA', message: expect.any(String), detalle: { summary: body.summary, fallidas: [fallida] } },
    })
  })

  it('custodia: CUSTODIA_EN_PROCESO se lanza; un status ≥ 400 definitivo → RECHAZADO con su código', async () => {
    aceptar.mockResolvedValue({ status: 409, body: { code: 'CUSTODIA_EN_PROCESO', message: 'reintenta', summary: {}, results: [] } })
    await expect(aplicarEnvio(ctx, 'CUSTODIA_ACEPTAR', { sims: [{ serialNumber: 'A', custodyVersion: 1 }] })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CUSTODIA_EN_PROCESO',
    })
    rechazar.mockResolvedValue({ status: 409, body: { code: 'CUSTODIA_EN_PROCESO', message: 'reintenta' } })
    await expect(aplicarEnvio(ctx, 'CUSTODIA_RECHAZAR', { serialNumber: 'A', custodyVersion: 1 })).rejects.toMatchObject({
      code: 'CUSTODIA_EN_PROCESO',
    })
    rechazar.mockResolvedValue({ status: 404, body: { code: 'NOT_FOUND', message: 'no existe' } })
    expect(await aplicarEnvio(ctx, 'CUSTODIA_RECHAZAR', { serialNumber: 'A', custodyVersion: 1 })).toEqual({
      tipo: 'RECHAZADO',
      rechazo: { code: 'NOT_FOUND', message: 'no existe' },
    })
    rechazar.mockResolvedValue({ status: 200, body: { custodyState: 'PROMOTER_REJECTED', repetida: false } })
    expect(await aplicarEnvio(ctx, 'CUSTODIA_RECHAZAR', { serialNumber: 'A', custodyVersion: 1 })).toMatchObject({
      tipo: 'APLICADO',
      status: 200,
    })
  })

  describe('EVIDENCIA nombra su venta con ventaLlave', () => {
    const captura = { captureSeq: 1, captureDeviceId: 'cel', idempotencyKey: 'k1', capturedAt: '2026-11-09T10:00:00.000Z' }
    const fotos = { ventaLlave: llave, photoUrls: ['https://example.test/a.jpg'], photoLabel: 'Vinculacion', ...captura }
    const fichaCompleta = { estado: 'COMPLETA', staffId: 's1', celularId: 'cel1', paymentId: 'ckpago000000000000000000a' }

    it('de una venta COMPLETA de esa persona y ese celular → el servicio de la TPV con el paymentId de la ficha', async () => {
      db.ventaDeCampo.findUnique.mockResolvedValue(fichaCompleta)
      evidencia.mockResolvedValue({ verificationId: 'sv', status: 'PENDING' })
      const r = await aplicarEnvio(ctx, 'EVIDENCIA', {
        ...fotos,
        captureSeq: 3,
        captureDeviceId: 'cel',
        idempotencyKey: 'k',
        capturedAt: '2026-11-09T10:00:00.000Z',
      })
      expect(db.ventaDeCampo.findUnique).toHaveBeenCalledWith({ where: { venueId_llave: { venueId: 'v1', llave } } })
      expect(evidencia).toHaveBeenCalledWith(
        'v1',
        'ckpago000000000000000000a',
        ['https://example.test/a.jpg'],
        's1',
        undefined,
        undefined,
        'Vinculacion',
        {
          orgId: 'o1',
          capture: { seq: 3, deviceId: 'cel', idempotencyKey: 'k', capturedAt: new Date('2026-11-09T10:00:00.000Z') },
          linkingNumber: undefined,
          portedNumber: undefined,
        },
      )
      expect(r).toEqual({
        tipo: 'APLICADO',
        status: 200,
        body: { success: true, message: 'Proof-of-sale photo uploaded successfully', verificationId: 'sv', status: 'PENDING' },
      })
    })

    it('sin ficha, con la ficha EN_CURSO, de otra persona o de OTRO celular (el nuevo de la persona) → RECHAZADO VENTA_PENDIENTE', async () => {
      for (const ficha of [
        null,
        { ...fichaCompleta, estado: 'EN_CURSO', paymentId: null },
        { ...fichaCompleta, staffId: 'otra' },
        { ...fichaCompleta, celularId: 'celNuevo' },
      ]) {
        db.ventaDeCampo.findUnique.mockResolvedValue(ficha)
        expect(await aplicarEnvio(ctx, 'EVIDENCIA', fotos)).toMatchObject({ tipo: 'RECHAZADO', rechazo: { code: 'VENTA_PENDIENTE' } })
      }
      expect(evidencia).not.toHaveBeenCalled()
    })

    it('sin ventaLlave o con fotos inválidas → CUERPO_INVALIDO antes de buscar la venta', async () => {
      expect(await aplicarEnvio(ctx, 'EVIDENCIA', { photoUrls: ['https://example.test/a.jpg'] })).toMatchObject({
        rechazo: { code: 'CUERPO_INVALIDO' },
      })
      expect(await aplicarEnvio(ctx, 'EVIDENCIA', { ventaLlave: llave, photoUrls: [] })).toMatchObject({
        rechazo: { code: 'CUERPO_INVALIDO' },
      })
      expect(db.ventaDeCampo.findUnique).not.toHaveBeenCalled()
    })

    it('S9 · sin los campos de captura → CUERPO_INVALIDO antes de buscar la venta (repetir «Aplicar» no duplica fotos)', async () => {
      for (const falta of ['captureSeq', 'captureDeviceId', 'idempotencyKey', 'capturedAt']) {
        const sinUno: Record<string, unknown> = { ...fotos }
        delete sinUno[falta]
        expect(await aplicarEnvio(ctx, 'EVIDENCIA', sinUno)).toMatchObject({ tipo: 'RECHAZADO', rechazo: { code: 'CUERPO_INVALIDO' } })
      }
      expect(db.ventaDeCampo.findUnique).not.toHaveBeenCalled()
      expect(evidencia).not.toHaveBeenCalled()
    })

    it('T3 · sin destino estable (ni photoLabel ni replaceIndex) → CUERPO_INVALIDO: repetir la agregaría al final otra vez', async () => {
      const alFinal: Record<string, unknown> = { ...fotos }
      delete alFinal.photoLabel
      expect(await aplicarEnvio(ctx, 'EVIDENCIA', alFinal)).toMatchObject({ tipo: 'RECHAZADO', rechazo: { code: 'CUERPO_INVALIDO' } })
      expect(cuerpoValido('EVIDENCIA', alFinal)).toBe(false)
      expect(db.ventaDeCampo.findUnique).not.toHaveBeenCalled()
      expect(evidencia).not.toHaveBeenCalled()
      // Con replaceIndex también hay destino.
      db.ventaDeCampo.findUnique.mockResolvedValue(fichaCompleta)
      evidencia.mockResolvedValue({ verificationId: 'sv' })
      expect(await aplicarEnvio(ctx, 'EVIDENCIA', { ...alFinal, replaceIndex: 1 })).toMatchObject({ tipo: 'APLICADO' })
    })

    it('VERIFICATION_MOVED (la venta cambió de tienda, «vuelve a intentarlo») se lanza: es reintentable', async () => {
      db.ventaDeCampo.findUnique.mockResolvedValue(fichaCompleta)
      const movida = new ConflictError('La venta cambió de tienda mientras se guardaba; vuelve a intentarlo', 'VERIFICATION_MOVED')
      evidencia.mockRejectedValue(movida)
      await expect(aplicarEnvio(ctx, 'EVIDENCIA', fotos)).rejects.toBe(movida)
    })

    it('el 404 o el 400 del servicio son definitivos (RECHAZADO con su código)', async () => {
      db.ventaDeCampo.findUnique.mockResolvedValue(fichaCompleta)
      evidencia.mockRejectedValue(new BadRequestError('número sin captura', 'CAPTURE_REQUIRED'))
      expect(await aplicarEnvio(ctx, 'EVIDENCIA', fotos)).toMatchObject({ tipo: 'RECHAZADO', rechazo: { code: 'CAPTURE_REQUIRED' } })
      evidencia.mockRejectedValue(new NotFoundError('no está'))
      expect(await aplicarEnvio(ctx, 'EVIDENCIA', fotos)).toMatchObject({ tipo: 'RECHAZADO', rechazo: { message: 'no está' } })
    })
  })
})

describe('cuerpoValido (S7, S9): el mismo esquema que aplicarEnvio, sin tocar la base', () => {
  const captura = { captureSeq: 1, captureDeviceId: 'cel', idempotencyKey: 'k1', capturedAt: '2026-11-09T10:00:00.000Z' }
  it('cada tipo con su esquema', () => {
    expect(cuerpoValido('VENTA', cuerpoVenta)).toBe(true)
    expect(cuerpoValido('VENTA', { serialNumber: '1', precioVisto: 0 })).toBe(false)
    expect(cuerpoValido('ENTRADA', { llave })).toBe(true)
    expect(cuerpoValido('ENTRADA', { llave: 'no-uuid' })).toBe(false)
    expect(cuerpoValido('SALIDA', { llave, llaveEntrada: randomUUID() })).toBe(true)
    expect(cuerpoValido('SALIDA', { llave })).toBe(false)
    expect(cuerpoValido('CUSTODIA_ACEPTAR', { sims: [{ serialNumber: 'A', custodyVersion: 1 }] })).toBe(true)
    expect(cuerpoValido('CUSTODIA_ACEPTAR', { sims: [] })).toBe(false)
    expect(cuerpoValido('CUSTODIA_RECHAZAR', { serialNumber: 'A', custodyVersion: 1 })).toBe(true)
    expect(cuerpoValido('CUSTODIA_RECHAZAR', { serialNumber: 'A' })).toBe(false)
    const foto = { ventaLlave: llave, photoUrls: ['https://example.test/a.jpg'], ...captura }
    expect(cuerpoValido('EVIDENCIA', { ...foto, photoLabel: 'Vinculacion' })).toBe(true)
    expect(cuerpoValido('EVIDENCIA', { ...foto, replaceIndex: 0 })).toBe(true)
    expect(cuerpoValido('EVIDENCIA', { ventaLlave: llave, photoUrls: ['https://example.test/a.jpg'], photoLabel: 'Vinculacion' })).toBe(
      false,
    )
    expect(cuerpoValido('VENTA', null)).toBe(false)
    expect(db.ventaDeCampo.findUnique).not.toHaveBeenCalled()
  })
})

describe('efectoYaHecho (T1): ¿lo que pide este cuerpo ya está en la base?', () => {
  const H = 3600_000
  const LIMITE = new Date('2026-11-09T12:00:00.000Z')
  const antes = (h: number) => new Date(LIMITE.getTime() - h * H)

  describe('VENTA', () => {
    const ficha = { estado: 'COMPLETA', staffId: 's1', serialNumber: '89520001', orderId: 'o', paymentId: 'p', saleVerificationId: 'sv' }
    it('ficha COMPLETA de la misma persona y la misma SIM → hecho con orderId, paymentId y saleVerificationId', async () => {
      db.ventaDeCampo.findUnique.mockResolvedValue(ficha)
      expect(await efectoYaHecho('VENTA', ctx, cuerpoVenta, LIMITE)).toEqual({
        hecho: true,
        resultado: { orderId: 'o', paymentId: 'p', saleVerificationId: 'sv', recuperado: true },
      })
      expect(db.ventaDeCampo.findUnique).toHaveBeenCalledWith({ where: { venueId_llave: { venueId: 'v1', llave } } })
    })
    it('EN_CURSO (el servicio la retoma por llave), de otra persona, de otra SIM o sin ficha → no hecho', async () => {
      for (const f of [{ ...ficha, estado: 'EN_CURSO' }, { ...ficha, staffId: 'otra' }, { ...ficha, serialNumber: '1' }, null]) {
        db.ventaDeCampo.findUnique.mockResolvedValue(f)
        expect(await efectoYaHecho('VENTA', ctx, cuerpoVenta, LIMITE)).toEqual({ hecho: false })
      }
      expect(await efectoYaHecho('VENTA', ctx, { llave: 'no' }, LIMITE)).toEqual({ hecho: false })
    })
  })

  describe('ENTRADA / SALIDA', () => {
    it('la checada de la persona con esa llave, en esa sucursal → hecho con su timeEntryId; en otra sucursal o sin checada → no', async () => {
      db.timeEntry.findUnique.mockResolvedValue({ id: 't1', venueId: 'v1' })
      expect(await efectoYaHecho('ENTRADA', ctx, { llave }, LIMITE)).toEqual({
        hecho: true,
        resultado: { timeEntryId: 't1', recuperado: true },
      })
      expect(db.timeEntry.findUnique).toHaveBeenLastCalledWith({
        where: { staffId_llaveEntrada: { staffId: 's1', llaveEntrada: llave } },
        select: { id: true, venueId: true },
      })
      expect(await efectoYaHecho('SALIDA', ctx, { llave, llaveEntrada: randomUUID() }, LIMITE)).toMatchObject({ hecho: true })
      expect(db.timeEntry.findUnique).toHaveBeenLastCalledWith({
        where: { staffId_llaveSalida: { staffId: 's1', llaveSalida: llave } },
        select: { id: true, venueId: true },
      })
      db.timeEntry.findUnique.mockResolvedValue({ id: 't1', venueId: 'otra' })
      expect(await efectoYaHecho('ENTRADA', ctx, { llave }, LIMITE)).toEqual({ hecho: false })
      db.timeEntry.findUnique.mockResolvedValue(null)
      expect(await efectoYaHecho('ENTRADA', ctx, { llave }, LIMITE)).toEqual({ hecho: false })
    })
  })

  describe('CUSTODIA: por SIM, en la bitácora de custodia, desde la asignación que dio la versión', () => {
    /** La bitácora en memoria, filtrada como la consulta: tipo, persona, fecha, serie (sin mayúsculas). */
    let eventos: any[]
    beforeEach(() => {
      eventos = []
      db.serializedItemCustodyEvent.findMany.mockImplementation(async ({ where }: any) => {
        const tipos = typeof where.eventType === 'string' ? [where.eventType] : where.eventType.in
        const series = where.serialNumber.in.map((x: string) => x.toLowerCase())
        return eventos
          .filter(e => tipos.includes(e.eventType) && series.includes(e.serialNumber.toLowerCase()))
          .filter(e => !where.actorStaffId || e.actorStaffId === where.actorStaffId)
          .filter(e => !where.toStaffId || e.toStaffId === where.toStaffId)
          .filter(e => !where.createdAt?.lte || e.createdAt <= where.createdAt.lte)
          .sort((a, b) => b.createdAt - a.createdAt)
      })
    })
    const asignada = (serialNumber: string, h: number, toStaffId = 's1') =>
      eventos.push({ serialNumber, eventType: 'ASSIGNED_TO_PROMOTER', toStaffId, actorStaffId: 'sup', createdAt: antes(h) })
    const decidio = (serialNumber: string, h: number, eventType = 'ACCEPTED_BY_PROMOTER', actorStaffId = 's1') =>
      eventos.push({ serialNumber, eventType, toStaffId: actorStaffId, actorStaffId, createdAt: antes(h) })
    const aceptar1 = (serialNumber = 'SIM-A') => ({ sims: [{ serialNumber, custodyVersion: 2 }] })

    it('R2-1 · aceptada por la ruta normal ANTES de que naciera el retenido (respuesta perdida) → hecho', async () => {
      asignada('SIM-A', 10)
      decidio('SIM-A', 5) // antes del límite (el retenido nació después)
      expect(await efectoYaHecho('CUSTODIA_ACEPTAR', ctx, aceptar1(), LIMITE)).toEqual({
        hecho: true,
        resultado: { recuperadoDeLaBitacora: true, eventos: [{ serialNumber: 'SIM-A', at: antes(5).toISOString() }] },
      })
      // Sólo de la organización de la sucursal.
      expect(db.serializedItemCustodyEvent.findMany.mock.calls[0][0].where.serializedItem).toEqual({
        OR: [{ organizationId: 'o1' }, { venue: { organizationId: 'o1' } }],
      })
    })

    it('la aceptación de una entrega ANTERIOR (antes de la asignación que vio el celular) no cuenta', async () => {
      asignada('SIM-A', 20)
      decidio('SIM-A', 15) // aceptó la primera entrega
      asignada('SIM-A', 8) // se la recolectaron y se la volvieron a asignar: ésa es la versión del cuerpo
      expect(await efectoYaHecho('CUSTODIA_ACEPTAR', ctx, aceptar1(), LIMITE)).toEqual({ hecho: false })
      // Una asignación DESPUÉS del límite no es la que vio el celular.
      asignada('SIM-A', -1)
      decidio('SIM-A', 4)
      expect(await efectoYaHecho('CUSTODIA_ACEPTAR', ctx, aceptar1(), LIMITE)).toMatchObject({ hecho: true })
    })

    it('la decisión de OTRA persona no cuenta; sin asignación en la bitácora (alta directa), cualquier decisión suya cuenta', async () => {
      decidio('SIM-A', 3, 'ACCEPTED_BY_PROMOTER', 'otra')
      expect(await efectoYaHecho('CUSTODIA_ACEPTAR', ctx, aceptar1(), LIMITE)).toEqual({ hecho: false })
      decidio('sim-a', 2) // la serie sin distinguir mayúsculas
      expect(await efectoYaHecho('CUSTODIA_ACEPTAR', ctx, aceptar1(), LIMITE)).toMatchObject({ hecho: true })
    })

    it('algunas sí y otras no → hecho parcial, con las que faltan en el resultado; ninguna → no hecho', async () => {
      asignada('A', 10)
      asignada('B', 10)
      decidio('A', 1)
      const dos = {
        sims: [
          { serialNumber: 'A', custodyVersion: 1 },
          { serialNumber: 'B', custodyVersion: 1 },
        ],
      }
      expect(await efectoYaHecho('CUSTODIA_ACEPTAR', ctx, dos, LIMITE)).toEqual({
        hecho: true,
        resultado: { recuperadoDeLaBitacora: true, eventos: [{ serialNumber: 'A', at: antes(1).toISOString() }], faltan: ['B'] },
      })
      expect(await efectoYaHecho('CUSTODIA_ACEPTAR', ctx, { sims: [{ serialNumber: 'B', custodyVersion: 1 }] }, LIMITE)).toEqual({
        hecho: false,
      })
    })

    it('RECHAZAR busca el rechazo de esa persona (no la aceptación)', async () => {
      asignada('SIM-C', 10)
      decidio('SIM-C', 2, 'ACCEPTED_BY_PROMOTER')
      expect(await efectoYaHecho('CUSTODIA_RECHAZAR', ctx, { serialNumber: 'SIM-C', custodyVersion: 1 }, LIMITE)).toEqual({ hecho: false })
      decidio('SIM-C', 1, 'REJECTED_BY_PROMOTER')
      expect(await efectoYaHecho('CUSTODIA_RECHAZAR', ctx, { serialNumber: 'SIM-C', custodyVersion: 1 }, LIMITE)).toMatchObject({
        hecho: true,
      })
    })
  })

  describe('EVIDENCIA: la foto de esa captura ya está en la verificación', () => {
    const fichaCompleta = { estado: 'COMPLETA', staffId: 's1', celularId: 'cel1', paymentId: 'ckpago000000000000000000a' }
    const foto = (extra: object) => ({
      ventaLlave: llave,
      photoUrls: ['https://example.test/a.jpg'],
      captureSeq: 5,
      captureDeviceId: 'cel',
      idempotencyKey: 'k',
      capturedAt: '2026-11-09T10:00:00.000Z',
      ...extra,
    })
    beforeEach(() => db.ventaDeCampo.findUnique.mockResolvedValue(fichaCompleta))
    const conSeqs = (appliedCaptureSeqs: object) => db.saleVerification.findUnique.mockResolvedValue({ id: 'sv1', appliedCaptureSeqs })

    it('su captura aplicada en su ranura → hecho; una más nueva del mismo aparato en su ranura también (la reemplazó)', async () => {
      conSeqs({ PHOTO_VINCULACION: { cel: 5 } })
      expect(await efectoYaHecho('EVIDENCIA', ctx, foto({ photoLabel: 'Vinculacion' }), LIMITE)).toEqual({
        hecho: true,
        resultado: { verificationId: 'sv1', paymentId: 'ckpago000000000000000000a', recuperado: true },
      })
      expect(db.saleVerification.findUnique).toHaveBeenCalledWith({
        where: { paymentId: 'ckpago000000000000000000a' },
        select: { id: true, appliedCaptureSeqs: true },
      })
      conSeqs({ PHOTO_VINCULACION: { cel: 9 } })
      expect(await efectoYaHecho('EVIDENCIA', ctx, foto({ replaceIndex: 0 }), LIMITE)).toMatchObject({ hecho: true })
    })

    it('replaceIndex 1 sobre una verificación vacía cae en la ranura 0: esa misma captura ahí también es hecho', async () => {
      conSeqs({ PHOTO_VINCULACION: { cel: 5 } })
      expect(await efectoYaHecho('EVIDENCIA', ctx, foto({ replaceIndex: 1 }), LIMITE)).toMatchObject({ hecho: true })
    })

    it('una captura anterior, otro aparato, una más nueva en la OTRA ranura, sin verificación o sin ficha → no hecho', async () => {
      for (const seqs of [{ PHOTO_VINCULACION: { cel: 4 } }, { PHOTO_VINCULACION: { otro: 5 } }, { PHOTO_PORTABILIDAD: { cel: 6 } }, {}]) {
        conSeqs(seqs)
        expect(await efectoYaHecho('EVIDENCIA', ctx, foto({ photoLabel: 'Vinculacion' }), LIMITE)).toEqual({ hecho: false })
      }
      db.saleVerification.findUnique.mockResolvedValue(null)
      expect(await efectoYaHecho('EVIDENCIA', ctx, foto({ photoLabel: 'Vinculacion' }), LIMITE)).toEqual({ hecho: false })
      db.ventaDeCampo.findUnique.mockResolvedValue({ ...fichaCompleta, celularId: 'otro' })
      expect(await efectoYaHecho('EVIDENCIA', ctx, foto({ photoLabel: 'Vinculacion' }), LIMITE)).toEqual({ hecho: false })
    })
  })
})
