// tests/unit/services/fiscal/cfdiCancel.service.test.ts

// Mock prisma and other heavy deps BEFORE importing the service
jest.mock('../../../../src/utils/prismaClient', () => ({ default: {} }))
jest.mock('../../../../src/services/fiscal/fiscalProvider.factory', () => ({
  resolveFiscalProvider: jest.fn(),
}))
jest.mock('../../../../src/config/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}))

import {
  cancelCfdi,
  getCfdiStatus,
  clasificarErrorDeCancelacion,
  traducirRechazoDeCancelacion,
  estadoDeCancelacion,
  refreshPendingCancellation,
  defaultRefreshDeps,
  syncPendingCancellations,
  sincronizarCancelacionExterna,
  desdeDondeSube,
  RANGO_DE_CANCELACION,
  INTENCION_ABANDONADA_MS,
  ENVIO_TERMINADO_MS,
  MARGEN_DE_ENVIO_MS,
  PLAZO_DE_LA_DUDA_MS,
  MOTIVO_SIN_SOLICITUD_EN_EL_PLAZO,
  dondeBuscarCierresRecientes,
  SUSTITUTA_ATORADA_MS,
  sustitutaAtorada,
  textoDeCancelacionPendienteAlSustituir,
  PRESUPUESTO_BARRIDO_CANCELACIONES_MS,
} from '../../../../src/services/fiscal/cfdi.service'
import type { CancelCfdiDeps, GetCfdiStatusDeps } from '../../../../src/services/fiscal/cfdi.service'
import {
  ProviderHttpError,
  TIEMPO_LIMITE_CONSULTA_MS,
  TIEMPO_LIMITE_ENVIO_MS,
} from '../../../../src/services/fiscal/providers/facturapi.provider'
import { ConflictError, ProviderUnavailableError } from '../../../../src/errors/AppError'
import logger from '../../../../src/config/logger'

// ──────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────

const stampedCfdi = {
  id: 'c1',
  attempts: 2,
  venueId: 'v1',
  status: 'STAMPED',
  uuid: 'U1',
  facturapiId: 'fa1',
  fiscalEmisor: { provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE' },
}

/** C2: el token del único envío del intento (lo que devuelve `tomarEnvio`). */
const TOKEN = new Date('2026-10-05T12:00:00Z')

function cancelDeps(over: Partial<CancelCfdiDeps> = {}): CancelCfdiDeps {
  return {
    loadCfdi: jest.fn().mockResolvedValue(stampedCfdi),
    resolveProvider: jest.fn().mockReturnValue({
      name: 'facturapi',
      cancelInvoice: jest.fn().mockResolvedValue({ status: 'accepted', cancelledAt: new Date() }),
    } as any),
    updateCfdi: jest.fn().mockImplementation(async (_id: string, data: Record<string, any>) => ({ ...stampedCfdi, ...data })),
    anotarIntencion: jest.fn().mockResolvedValue({ estado: 'ANOTADA', intento: 1 }),
    tomarEnvio: jest.fn().mockResolvedValue(TOKEN),
    dueno: jest.fn().mockResolvedValue(true),
    refresh: jest.fn(async (c: any) => c),
    ...over,
  }
}

// ──────────────────────────────────────────────────────────────────
// cancelCfdi
// ──────────────────────────────────────────────────────────────────

describe('cancelCfdi', () => {
  beforeEach(() => jest.clearAllMocks())

  // C2 (dorada que cambia a propósito): el motivo se escribe en la INTENCIÓN, antes del PAC; el desenlace sólo trae lo que el PAC dijo.
  it('cancels a STAMPED cfdi (motivo 02): el motivo va en la intención (antes del PAC) y el desenlace persiste el estado', async () => {
    const deps = cancelDeps()
    const res = await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)

    expect(deps.resolveProvider).toHaveBeenCalled()
    expect(deps.anotarIntencion).toHaveBeenCalledWith('c1', 2, { motivo: '02', substituteUuid: undefined })

    const update = (deps.updateCfdi as jest.Mock).mock.calls[0][1]
    expect(['ACCEPTED', 'CANCELLED', 'REQUESTED']).toContain(update.cancelStatus)
    expect(res.cancelStatus).toBeDefined()
  })

  // C2 (dorada que cambia a propósito): `updateCfdi` es `aplicarCancelacion` con el CAS del intento en el 5.º argumento. Quien envió es el
  // dueño único del intento: aunque su escritura pierda el CAS, reporta lo que quedó en la fila (releída), y fue él quien envió.
  it('captura la versión antes del PAC y, si su escritura pierde el CAS, devuelve el estado actual releído', async () => {
    const current = { ...stampedCfdi, status: 'CANCELLED', cancelStatus: 'ACCEPTED', cancelledAt: null }
    const deps = cancelDeps({
      loadCfdi: jest.fn().mockResolvedValueOnce(stampedCfdi).mockResolvedValue(current),
      updateCfdi: jest.fn().mockResolvedValue(null),
    })
    const result = await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    // Ronda 1 (I2 b, cambia a propósito): tras NUESTRO POST el hecho sube primero sólo desde REQUESTED del intento; si pierde, el dueño
    // relee (aquí la factura ya está cancelada por otro: no hay vía tardía) y no escribe nada más.
    expect(deps.updateCfdi).toHaveBeenCalledTimes(1)
    expect(deps.updateCfdi).toHaveBeenCalledWith('c1', expect.any(Object), 2, 'PENDIENTE', { cancelIntento: 1, cancelStatus: 'REQUESTED' })
    expect(result).toMatchObject({ cancelStatus: 'ACCEPTED', cfdi: current })
  })

  it('tenant isolation: throws (→404) when the cfdi belongs to another venue', async () => {
    const deps = cancelDeps()
    await expect(cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'OTHER' }, deps)).rejects.toThrow(/not found/i)
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('rejects motivo 01 without a substitute UUID', async () => {
    const deps = cancelDeps()
    await expect(cancelCfdi({ cfdiId: 'c1', motivo: '01', sandbox: true, expectedVenueId: 'v1' }, deps)).rejects.toThrow(
      /sustituci|substitut/i,
    )
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('rejects cancelling a cfdi that is not STAMPED', async () => {
    const deps = cancelDeps({
      loadCfdi: jest.fn().mockResolvedValue({ ...stampedCfdi, status: 'DRAFT' }),
    })
    await expect(cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)).rejects.toThrow(/timbrad|stamped/i)
  })

  // C2 (dorada que cambia a propósito): el sustituto se escribe en la intención (C2-22: siempre, también null).
  it('cancels a STAMPED cfdi (motivo 01) when substituteUuid is provided: el sustituto va en la intención', async () => {
    const deps = cancelDeps()
    const res = await cancelCfdi(
      { cfdiId: 'c1', motivo: '01', substituteUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', sandbox: true, expectedVenueId: 'v1' },
      deps,
    )
    expect(deps.anotarIntencion).toHaveBeenCalledWith('c1', 2, { motivo: '01', substituteUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
    expect(res.cancelStatus).toBeDefined()
  })

  it('maps provider status "canceled" → CANCELLED and sets cfdi status to CANCELLED', async () => {
    const deps = cancelDeps({
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        cancelInvoice: jest.fn().mockResolvedValue({ status: 'canceled', cancelledAt: new Date() }),
      } as any),
    })
    const res = await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)
    expect(res.cancelStatus).toBe('CANCELLED')
    const update = (deps.updateCfdi as jest.Mock).mock.calls[0][1]
    expect(update.status).toBe('CANCELLED')
  })

  // C2 (dorada que cambia a propósito): `REQUESTED` ya lo escribió la intención; un «en trámite» del PAC sólo ACUSA el intento.
  it('maps provider status "pending" → acuse del intento (REQUESTED ya está) and leaves cfdi status unchanged', async () => {
    const deps = cancelDeps({
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        cancelInvoice: jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null }),
      } as any),
    })
    const res = await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)
    const update = (deps.updateCfdi as jest.Mock).mock.calls[0][1]
    expect(update).toEqual({ cancelAcusadaAt: expect.any(Date) })
    expect(res.cancelStatus).toBe('REQUESTED')
  })

  // C2 (dorada que cambia a propósito): un `rejected` en la RESPUESTA del POST no prueba nada de ESTE intento (C2-24): queda EN DUDA y la
  // consulta (refresh/barrido) lo cierra con la respuesta del PAC. Un rechazo concluyente llega como error con su código (C2-25).
  it('maps provider status "rejected" in the POST response → EN DUDA (la consulta decide); nada se escribe', async () => {
    const deps = cancelDeps({
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        cancelInvoice: jest.fn().mockResolvedValue({ status: 'rejected', cancelledAt: null }),
      } as any),
    })
    expect(await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)).toMatchObject({ enDuda: true })
    expect(deps.updateCfdi).not.toHaveBeenCalled()
  })

  it('throws when cfdi is not found', async () => {
    const deps = cancelDeps({ loadCfdi: jest.fn().mockResolvedValue(null) })
    await expect(cancelCfdi({ cfdiId: 'missing', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)).rejects.toThrow(/not found/i)
  })
})

// ──────────────────────────────────────────────────────────────────
// getCfdiStatus
// ──────────────────────────────────────────────────────────────────

describe('getCfdiStatus', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns the cfdi scoped to the venue', async () => {
    const deps: GetCfdiStatusDeps = { loadCfdi: jest.fn().mockResolvedValue(stampedCfdi) }
    const res = await getCfdiStatus({ cfdiId: 'c1', expectedVenueId: 'v1' }, deps)
    expect(res.uuid).toBe('U1')
    expect(res.id).toBe('c1')
  })

  it('tenant isolation: throws when venue mismatches', async () => {
    const deps: GetCfdiStatusDeps = { loadCfdi: jest.fn().mockResolvedValue(stampedCfdi) }
    await expect(getCfdiStatus({ cfdiId: 'c1', expectedVenueId: 'OTHER' }, deps)).rejects.toThrow(/not found/i)
  })

  it('throws when cfdi is not found', async () => {
    const deps: GetCfdiStatusDeps = { loadCfdi: jest.fn().mockResolvedValue(null) }
    await expect(getCfdiStatus({ cfdiId: 'missing', expectedVenueId: 'v1' }, deps)).rejects.toThrow(/not found/i)
  })
})

// ─── R4: la cancelación nunca miente ────────────────────────────────────────────
// Codex (v4): el adaptador daba por cancelada cualquier respuesta que no fuera `canceled`. En una
// SUSTITUCIÓN eso deja dos facturas vigentes ante el SAT.
describe('cancelCfdi — sólo marca CANCELLED cuando consta', () => {
  const stampedCfdi = {
    id: 'c1',
    venueId: 'v1',
    status: 'STAMPED',
    facturapiId: 'fa1',
    uuid: 'UUID-1',
    fiscalEmisor: { id: 'e1', provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE' },
  }
  function cancelDeps(status: string, over: Record<string, any> = {}) {
    const updateCfdi = jest.fn().mockImplementation(async (_id, data) => ({ ...stampedCfdi, ...data }))
    return {
      deps: {
        loadCfdi: jest.fn().mockResolvedValue({ ...stampedCfdi, ...over }),
        resolveProvider: jest.fn().mockReturnValue({
          name: 'facturapi',
          cancelInvoice: jest
            .fn()
            .mockResolvedValue({ status, cancelledAt: status === 'canceled' || status === 'accepted' ? new Date() : null }),
        } as any),
        updateCfdi,
        anotarIntencion: jest.fn().mockResolvedValue({ estado: 'ANOTADA', intento: 1 }),
        tomarEnvio: jest.fn().mockResolvedValue(TOKEN),
        dueno: jest.fn().mockResolvedValue(true),
        refresh: jest.fn(async (c: any) => c),
      } as any,
      updateCfdi,
    }
  }

  it.each([
    ['canceled', 'CANCELLED', 'CANCELLED'],
    ['accepted', 'ACCEPTED', 'CANCELLED'],
  ])('%s ⇒ cancelStatus %s y el CFDI pasa a %s', async (provider, cancelStatus, cfdiStatus) => {
    const { deps, updateCfdi } = cancelDeps(provider)
    const res = await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)
    expect(res.cancelStatus).toBe(cancelStatus)
    expect(updateCfdi.mock.calls[0][1].status).toBe(cfdiStatus)
  })

  // C2 (dorada que cambia a propósito): `pending` sólo acusa; `rejected`/`expired`/`none` en la respuesta del POST quedan EN DUDA (C2-24) y
  // el PORQUÉ lo escribe la consulta (`porQueNoQuedoCancelada`, probado en «refreshPendingCancellation»). En ningún caso CANCELLED.
  // Ronda 1 (M5): sin pasar en vacío — `pending` exige el acuse; los negativos exigen EN DUDA y ninguna escritura.
  it('pending ⇒ cancelStatus REQUESTED: sólo el acuse, y el CFDI SIGUE STAMPED (no se inventa la cancelación)', async () => {
    const { deps, updateCfdi } = cancelDeps('pending')
    const res = await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)
    expect(res.cancelStatus).toBe('REQUESTED')
    expect(updateCfdi).toHaveBeenCalledTimes(1)
    expect(updateCfdi.mock.calls[0][1]).toEqual({ cancelAcusadaAt: expect.any(Date) })
  })
  it.each(['rejected', 'expired', 'none'])(
    '%s en la respuesta del POST ⇒ EN DUDA, nada se escribe y el CFDI SIGUE STAMPED (no se inventa la cancelación)',
    async provider => {
      const { deps, updateCfdi } = cancelDeps(provider)
      const res = await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)
      expect(res).toMatchObject({ enDuda: true, cancelStatus: 'REQUESTED' })
      expect(updateCfdi).not.toHaveBeenCalled()
    },
  )

  it('`none` y `expired` en la respuesta del POST no escriben un porqué falso: quedan EN DUDA', async () => {
    for (const provider of ['none', 'expired']) {
      const { updateCfdi, deps } = cancelDeps(provider)
      expect(await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)).toMatchObject({ enDuda: true })
      expect(updateCfdi).not.toHaveBeenCalled()
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// C2 · Tarea 2 (plan v7): la intención se anota antes del PAC; cada intento se envía UNA vez, por su dueño
// (`SELECT … FOR UPDATE` + token), con una consulta antes; lo incierto queda EN DUDA y sólo se CONSULTA.
// 🔴 El CAS es el QUINTO argumento de `updateCfdi`/`applyCancelOutcome`, como en `aplicarCancelacion` (C2-26).
// ════════════════════════════════════════════════════════════════════════════════════════════════════════

const err = (status: number, code: string) => new ProviderHttpError(status, code, code)

describe('C2 · cancelar: intención → dueño → consulta → POST UNA vez; lo incierto queda EN DUDA', () => {
  beforeEach(() => jest.clearAllMocks())
  const proveedor = (o: { consultas?: string[]; post?: jest.Mock } = {}) => {
    const getCancellationStatus = jest.fn()
    for (const s of o.consultas ?? ['none', 'none']) getCancellationStatus.mockResolvedValueOnce({ status: s, cancelledAt: null })
    return jest.fn().mockReturnValue({
      name: 'facturapi',
      getCancellationStatus,
      cancelInvoice: o.post ?? jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null }),
    } as any)
  }
  const cas = (d: any, i = 0) => (d.updateCfdi as jest.Mock).mock.calls[i][4]
  const datos = (d: any, i = 0) => (d.updateCfdi as jest.Mock).mock.calls[i][1]

  it('🔴 orden: intención → dueño (FOR UPDATE + token) → consulta → relectura → POST → acuse con CAS (intento, token) en el 5.º argumento', async () => {
    const orden: string[] = []
    const post = jest.fn(async () => (orden.push('post'), { status: 'pending', cancelledAt: null }))
    const p = proveedor({ post })
    const deps = cancelDeps({
      resolveProvider: p,
      anotarIntencion: jest.fn(async () => (orden.push('intencion'), { estado: 'ANOTADA' as const, intento: 7 })),
      tomarEnvio: jest.fn(async () => (orden.push('dueno'), TOKEN)),
      dueno: jest.fn(async () => (orden.push('relee'), true)),
      updateCfdi: jest.fn(async (_id: string, data: Record<string, any>) => (orden.push('desenlace'), { ...stampedCfdi, ...data })),
    })
    await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(orden).toEqual(['intencion', 'dueno', 'relee', 'post', 'desenlace'])
    // M5: `toHaveBeenCalledBefore` es de jest-extended (no instalado) ⇒ el orden de invocación de jest.
    expect((p() as any).getCancellationStatus.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0])
    expect(datos(deps)).toMatchObject({ cancelAcusadaAt: expect.any(Date) })
    expect(cas(deps)).toEqual({ cancelIntento: 7, cancelEnviadaAt: TOKEN })
  })

  it('🔴 la consulta previa ya ve la cancelación en trámite ⇒ NO hay POST; se acusa', async () => {
    const post = jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null }) // si se llama, cae la aserción
    const deps = cancelDeps({
      resolveProvider: proveedor({ consultas: ['pending'], post }),
      anotarIntencion: jest.fn().mockResolvedValue({ estado: 'ANOTADA', intento: 2 }),
    })
    await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(post).not.toHaveBeenCalled()
    expect(datos(deps)).toMatchObject({ cancelAcusadaAt: expect.any(Date) })
  })

  it('🔴 la consulta previa ya ve la factura cancelada ⇒ NO hay POST; se aplica el hecho con el CAS del intento', async () => {
    const post = jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null }) // si se llama, cae la aserción
    const deps = cancelDeps({
      resolveProvider: proveedor({ consultas: ['canceled'], post }),
      anotarIntencion: jest.fn().mockResolvedValue({ estado: 'ANOTADA', intento: 5 }),
    })
    const r = await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(post).not.toHaveBeenCalled()
    expect(datos(deps)).toMatchObject({ status: 'CANCELLED', cancelStatus: 'CANCELLED' })
    expect(cas(deps)).toEqual({ cancelIntento: 5 })
    expect(r).toMatchObject({ applied: true, cancelStatus: 'CANCELLED' })
  })

  it('🔴 no ganó la transición de dueño (o el intento ya tiene token): ni consulta previa ni POST; consulta el estado (refresh) y lo dice', async () => {
    const post = jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null }) // si se llama, cae la aserción
    const p = proveedor({ post })
    const deps = cancelDeps({
      resolveProvider: p,
      tomarEnvio: jest.fn().mockResolvedValue(null),
      refresh: jest.fn(async (c: any) => ({ ...c, cancelStatus: 'REQUESTED' })),
    })
    expect(await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)).toMatchObject({
      applied: false,
      cancelStatus: 'REQUESTED',
      enTramitePorOtro: true,
    })
    expect(post).not.toHaveBeenCalled()
    expect((p() as any).getCancellationStatus).not.toHaveBeenCalled()
    expect(deps.refresh).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), { sandbox: true })
  })

  it('🔴 justo antes del POST el dueño relee y ya no es dueño (el intento se cerró mientras dormía) ⇒ no manda nada', async () => {
    const post = jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null }) // si se llama, cae la aserción
    const deps = cancelDeps({ resolveProvider: proveedor({ post }), dueno: jest.fn().mockResolvedValue(false) })
    expect(await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)).toMatchObject({ applied: false })
    expect(post).not.toHaveBeenCalled()
    expect(deps.updateCfdi).not.toHaveBeenCalled()
  })

  it('🔴 el POST no contesta (red) ⇒ EN DUDA: nada se escribe y se dice; nunca se reenvía', async () => {
    const post = jest.fn().mockRejectedValue(new Error('timeout'))
    const deps = cancelDeps({ resolveProvider: proveedor({ post }) })
    expect(await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)).toMatchObject({
      applied: true,
      cancelStatus: 'REQUESTED',
      enDuda: true,
    })
    expect(post).toHaveBeenCalledTimes(1)
    expect(deps.updateCfdi).not.toHaveBeenCalled()
  })

  it('🔴 C2-25: invoice_cancellation_not_allowed (400) y la consulta de confirmación no ve trámite ⇒ REJECTED, CAS (intento, token, sin acuse); nunca «en duda»', async () => {
    const deps = cancelDeps({
      resolveProvider: proveedor({ post: jest.fn().mockRejectedValue(err(400, 'invoice_cancellation_not_allowed')) }),
      anotarIntencion: jest.fn().mockResolvedValue({ estado: 'ANOTADA', intento: 3 }),
    })
    expect(await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)).not.toHaveProperty('enDuda', true)
    expect(datos(deps)).toMatchObject({ cancelStatus: 'REJECTED' })
    expect(cas(deps)).toEqual({ cancelIntento: 3, cancelEnviadaAt: TOKEN, cancelAcusadaAt: null })
  })

  it('🔴 C2-25: 409 invoice_cancellation_in_progress ⇒ la consulta ve el trámite ⇒ se acusa, NO se cierra', async () => {
    const deps = cancelDeps({
      resolveProvider: proveedor({
        consultas: ['none', 'pending'],
        post: jest.fn().mockRejectedValue(err(409, 'invoice_cancellation_in_progress')),
      }),
    })
    await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(datos(deps)).toMatchObject({ cancelAcusadaAt: expect.any(Date) })
    expect(datos(deps)).not.toHaveProperty('cancelStatus')
  })

  it('🔴 C2-25: 409 en trámite y la consulta NO lo ve ⇒ EN DUDA (no se sabe): no se cierra ni se escribe', async () => {
    const deps = cancelDeps({
      resolveProvider: proveedor({
        consultas: ['none', 'none'],
        post: jest.fn().mockRejectedValue(err(409, 'invoice_cancellation_in_progress')),
      }),
    })
    expect(await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)).toMatchObject({ enDuda: true })
    expect(deps.updateCfdi).not.toHaveBeenCalled()
  })

  it('🔴 C2-25: un rechazo concluyente pero la consulta de confirmación ya ve el trámite ⇒ se acusa, NO se cierra', async () => {
    const deps = cancelDeps({
      resolveProvider: proveedor({ consultas: ['none', 'pending'], post: jest.fn().mockRejectedValue(err(400, 'invalid_request')) }),
    })
    await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(datos(deps)).toMatchObject({ cancelAcusadaAt: expect.any(Date) }) // ronda 1 (M5): exige el acuse, como su hermana del 409
    expect(datos(deps)).not.toHaveProperty('cancelStatus')
  })

  it('C2-25: clasificarErrorDeCancelacion — trámite existente, rechazo concluyente y todo lo demás en duda', () => {
    expect(clasificarErrorDeCancelacion(err(409, 'invoice_cancellation_in_progress'))).toBe('TRAMITE_EXISTENTE')
    for (const c of [
      'invoice_cancellation_not_allowed',
      'invoice_not_cancelable',
      'invoice_not_cancelable_by_sat',
      'invoice_cancellation_rfc_mismatch',
      'substitution_invoice_required',
      'substitution_invoice_not_found',
      'substitution_invoice_canceled',
      'substitution_invoice_status_not_allowed',
      'invalid_request',
    ])
      expect([c, clasificarErrorDeCancelacion(err(400, c))]).toEqual([c, 'RECHAZO'])
    for (const e of [
      err(503, 'invoice_cancellation_service_unavailable'),
      err(400, 'invoice_cancellation_failed'),
      err(500, 'x'),
      new Error('ECONNRESET'),
      err(422, 'invoice_stamping_validation_error'), // la lista de TIMBRADO no cuenta aquí
      err(400, 'product_key_not_found'),
    ])
      expect(clasificarErrorDeCancelacion(e)).toBe('EN_DUDA')
  })

  it('🔴 documentos relacionados vivos: ConflictError con el texto, sin PAC', async () => {
    const post = jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null }) // si se llama, cae la aserción
    const deps = cancelDeps({
      resolveProvider: proveedor({ post }),
      anotarIntencion: jest.fn().mockResolvedValue({
        conflicto: 'Esta factura tiene la nota de crédito A-3 en proceso; el SAT exige cancelar primero lo relacionado.',
      }),
    })
    const promesa = cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    await expect(promesa).rejects.toThrow(/A-3/)
    await expect(promesa).rejects.toBeInstanceOf(ConflictError)
    expect(post).not.toHaveBeenCalled()
    expect(deps.tomarEnvio).not.toHaveBeenCalled()
  })

  it('la intención se pierde (la factura cambió de versión o ya está cancelada) ⇒ no se toma el envío; se dice cómo quedó', async () => {
    const actual = { ...stampedCfdi, status: 'CANCELLED', cancelStatus: 'ACCEPTED', cancelledAt: null }
    const deps = cancelDeps({
      loadCfdi: jest.fn().mockResolvedValueOnce(stampedCfdi).mockResolvedValue(actual),
      anotarIntencion: jest.fn().mockResolvedValue({ estado: 'PERDIDA' }),
    })
    expect(await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)).toMatchObject({
      applied: false,
      cancelStatus: 'ACCEPTED',
      cfdi: actual,
    })
    expect(deps.tomarEnvio).not.toHaveBeenCalled()
  })

  it('🔴 una intención MISMA_EN_TRAMITE todavía sin token (el proceso que la anotó murió) la retoma quien gana el envío: UN POST', async () => {
    const post = jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null })
    const deps = cancelDeps({
      resolveProvider: proveedor({ post }),
      anotarIntencion: jest.fn().mockResolvedValue({ estado: 'MISMA_EN_TRAMITE', intento: 4 }),
    })
    await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(deps.tomarEnvio).toHaveBeenCalledWith('c1', 4, expect.any(Date))
    expect(post).toHaveBeenCalledTimes(1)
    expect(cas(deps)).toEqual({ cancelIntento: 4, cancelEnviadaAt: TOKEN })
  })

  it('el envío recibe el motivo y el sustituto de ESTA petición, y la intención también', async () => {
    const post = jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null })
    const deps = cancelDeps({ resolveProvider: proveedor({ post }) })
    await cancelCfdi({ cfdiId: 'c1', motivo: '01', substituteUuid: 'UUID-SUB', sandbox: true }, deps)
    expect(deps.anotarIntencion).toHaveBeenCalledWith('c1', 2, { motivo: '01', substituteUuid: 'UUID-SUB' })
    expect(post).toHaveBeenCalledWith({ providerInvoiceId: 'fa1', motivo: '01', substituteUuid: 'UUID-SUB' })
  })

  it('control — un proveedor sin consulta (la interfaz la hace opcional): se manda UNA vez sin consulta previa', async () => {
    const post = jest.fn().mockResolvedValue({ status: 'canceled', cancelledAt: new Date() })
    const deps = cancelDeps({ resolveProvider: jest.fn().mockReturnValue({ name: 'otro', cancelInvoice: post } as any) })
    expect(await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)).toMatchObject({
      applied: true,
      cancelStatus: 'CANCELLED',
    })
    expect(post).toHaveBeenCalledTimes(1)
  })

  // `applied` decide si el controlador audita CFDI_CANCELLED (liberarAlCancelar: «dos confirmaciones concurrentes auditan sólo al ganador»).
  it('🔴 auditoría: la consulta previa ve el hecho pero OTRA petición ya lo escribió (CAS perdido) y no salió POST ⇒ applied false', async () => {
    const post = jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null }) // si se llama, cae la aserción
    const deps = cancelDeps({
      resolveProvider: proveedor({ consultas: ['canceled'], post }),
      updateCfdi: jest.fn().mockResolvedValue(null),
      loadCfdi: jest
        .fn()
        .mockResolvedValueOnce(stampedCfdi)
        .mockResolvedValue({ ...stampedCfdi, status: 'CANCELLED', cancelStatus: 'CANCELLED' }),
    })
    expect(await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)).toMatchObject({
      applied: false,
      cancelStatus: 'CANCELLED',
    })
    expect(post).not.toHaveBeenCalled()
  })

  it('control — auditoría: el POST SÍ salió aunque su acuse pierda el CAS (una consulta acusó primero) ⇒ applied true: la solicitud se audita', async () => {
    const deps = cancelDeps({
      resolveProvider: proveedor({ post: jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null }) }),
      updateCfdi: jest.fn().mockResolvedValue(null),
    })
    expect(await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)).toMatchObject({ applied: true })
  })

  it('🔴 el resultado lleva el estado derivado de la fila RELEÍDA (C2: `estado`): enviada hace 2 min y sin acuse ⇒ CANCELACION_EN_DUDA', async () => {
    const releida = { ...stampedCfdi, cancelStatus: 'REQUESTED', cancelEnviadaAt: new Date(Date.now() - 2 * 60_000), cancelAcusadaAt: null }
    const deps = cancelDeps({
      loadCfdi: jest.fn().mockResolvedValueOnce(stampedCfdi).mockResolvedValue(releida),
      resolveProvider: proveedor({ post: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) }),
    })
    expect(await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)).toMatchObject({
      enDuda: true,
      cfdi: releida,
      estado: 'CANCELACION_EN_DUDA',
    })
  })
})

describe('C2 · traducirRechazoDeCancelacion (nace aquí; la Tarea 10 la amplía)', () => {
  it('🔴 si el PAC habla de documentos relacionados, dice qué hacer en palabras del dueño', () => {
    expect(traducirRechazoDeCancelacion(err(400, 'La factura tiene documentos relacionados vigentes; cancélalos primero') as Error)).toBe(
      'Esta factura ya tiene notas de crédito; cancélalas primero.',
    )
  })
  it('si no, el mensaje del PAC tal cual', () => {
    expect(traducirRechazoDeCancelacion(new ProviderHttpError(400, 'invoice_not_cancelable', 'La factura no se puede cancelar'))).toBe(
      'La factura no se puede cancelar',
    )
  })
  it('sin mensaje, un texto que dice que la factura sigue vigente', () => {
    expect(traducirRechazoDeCancelacion(new ProviderHttpError(400, 'invalid_request', ''))).toMatch(/sigue vigente/)
  })
})

describe('C2 · refreshPendingCancellation: SÓLO consulta; con el envío terminado, la respuesta del PAC manda', () => {
  const ahora = new Date('2026-10-05T12:00:00Z')
  const fila = (over: Record<string, any>) => ({
    ...stampedCfdi,
    cancelStatus: 'REQUESTED',
    cancelIntento: 4,
    cancelRequestedAt: new Date(ahora.getTime() - 60_000),
    cancelEnviadaAt: null,
    cancelAcusadaAt: null,
    ...over,
  })
  const deps = (status: string, over: Record<string, any> = {}) => ({
    loadEmisor: jest.fn(),
    resolveProvider: jest.fn().mockReturnValue({
      getCancellationStatus: jest.fn().mockResolvedValue({ status, cancelledAt: status === 'canceled' ? ahora : null }),
      cancelInvoice: jest.fn(),
    }),
    applyCancelOutcome: jest.fn(async (_id: string, data: any) => ({ ...stampedCfdi, ...data })),
    logAction: jest.fn(),
    now: () => ahora,
    ...over,
  })
  const cas = (d: any) => d.applyCancelOutcome.mock.calls[0][4]

  // C2 · OF-2 (T2 R1, cambia A PROPÓSITO): en el PRIMER intento. Desde el segundo, un «rechazada» en duda espera (puede ser del anterior).
  it('🔴 C2-24: enviado hace 2 min, sin acuse (EN DUDA), y el PAC dice «rechazada» (la respuesta se perdió y el receptor rechazó) ⇒ REJECTED; jamás un segundo DELETE', async () => {
    const d = deps('rejected')
    await refreshPendingCancellation(
      fila({ cancelIntento: 1, cancelEnviadaAt: new Date(ahora.getTime() - 2 * 60_000) }),
      { sandbox: true },
      d as any,
    )
    expect(d.applyCancelOutcome.mock.calls[0][1]).toMatchObject({ cancelStatus: 'REJECTED', lastError: expect.stringMatching(/rechaz/i) })
    expect(cas(d)).toEqual({ cancelIntento: 1, cancelEnviadaAt: new Date(ahora.getTime() - 2 * 60_000), cancelAcusadaAt: null }) // C2-28: la foto entera
    expect(d.resolveProvider().cancelInvoice).not.toHaveBeenCalled()
    expect(d.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CFDI_CANCEL_NOT_APPLIED',
        data: expect.objectContaining({ cancelIntento: 1, estadoPrevio: 'CANCELACION_EN_DUDA' }),
      }),
    )
  })

  // C2 ronda 2 (N1, cambia a propósito): un «sin solicitud» sobre un envío EN DUDA no prueba que no salió (Facturapi puede seguir
  // procesando el POST que cortamos): no cierra hasta `PLAZO_DE_LA_DUDA_MS`. El cierre a las 24 h, en las pruebas de la ronda 2.
  it('🔴 en duda (2 min) y el PAC NO tiene la solicitud ⇒ NO se cierra: sigue en duda (ronda 2, N1)', async () => {
    const d = deps('none')
    await refreshPendingCancellation(fila({ cancelEnviadaAt: new Date(ahora.getTime() - 2 * 60_000) }), { sandbox: true }, d as any)
    expect(d.resolveProvider().getCancellationStatus).toHaveBeenCalled()
    expect(d.applyCancelOutcome).not.toHaveBeenCalled()
  })

  it('control — en duda (primer intento; OF-2 T2 R1) y la solicitud caducó ⇒ REJECTED «caducó»', async () => {
    const d = deps('expired')
    await refreshPendingCancellation(
      fila({ cancelIntento: 1, cancelEnviadaAt: new Date(ahora.getTime() - 2 * 60_000) }),
      { sandbox: true },
      d as any,
    )
    expect(d.applyCancelOutcome.mock.calls[0][1]).toMatchObject({ cancelStatus: 'REJECTED', lastError: expect.stringMatching(/caduc/) })
  })

  it('🔴 C2-29: el envío sigue en vuelo (ENVIANDO) y el PAC ya dice «en trámite» ⇒ se acusa (la consulta también corre en ENVIANDO)', async () => {
    const token = new Date(ahora.getTime() - 30_000)
    const d = deps('pending')
    await refreshPendingCancellation(fila({ cancelEnviadaAt: token }), { sandbox: true }, d as any)
    expect(d.applyCancelOutcome).toHaveBeenCalledTimes(1)
    expect(d.applyCancelOutcome.mock.calls[0][1]).toMatchObject({ cancelAcusadaAt: ahora })
    expect(cas(d)).toEqual({ cancelIntento: 4, cancelEnviadaAt: token, cancelAcusadaAt: null })
    expect(d.resolveProvider().getCancellationStatus).toHaveBeenCalled()
  })

  it('el envío sigue en vuelo (token de 30 s, sin acuse) y el PAC no ve nada ⇒ no se toca (un negativo espera)', async () => {
    const d = deps('none')
    await refreshPendingCancellation(fila({ cancelEnviadaAt: new Date(ahora.getTime() - 30_000) }), { sandbox: true }, d as any)
    expect(d.applyCancelOutcome).not.toHaveBeenCalled()
  })

  it('🔴 acusado + «rechazada» ⇒ REJECTED con CAS (intento, token, acuse): un rechazo confirmado cierra', async () => {
    const acusada = new Date(ahora.getTime() - 3 * 60_000)
    const d = deps('rejected')
    await refreshPendingCancellation(fila({ cancelEnviadaAt: acusada, cancelAcusadaAt: acusada }), { sandbox: true }, d as any)
    expect(d.applyCancelOutcome.mock.calls[0][1]).toMatchObject({ cancelStatus: 'REJECTED' })
    expect(cas(d)).toEqual({ cancelIntento: 4, cancelEnviadaAt: acusada, cancelAcusadaAt: acusada })
  })

  it('control — acusado + «en trámite» ⇒ no escribe nada (el acuse ya está)', async () => {
    const acusada = new Date(ahora.getTime() - 3 * 60_000)
    const d = deps('pending')
    await refreshPendingCancellation(fila({ cancelEnviadaAt: acusada, cancelAcusadaAt: acusada }), { sandbox: true }, d as any)
    expect(d.applyCancelOutcome).not.toHaveBeenCalled()
  })

  it('🔴 nunca enviado: con 1 minuto no se toca; con 11 minutos se cierra con CAS (intento, sin envío)', async () => {
    const d1 = deps('none')
    await refreshPendingCancellation(fila({}), { sandbox: true }, d1 as any)
    expect(d1.applyCancelOutcome).not.toHaveBeenCalled()
    const d2 = deps('none')
    await refreshPendingCancellation(fila({ cancelRequestedAt: new Date(ahora.getTime() - 11 * 60_000) }), { sandbox: true }, d2 as any)
    expect(d2.applyCancelOutcome.mock.calls[0][1]).toMatchObject({
      cancelStatus: 'REJECTED',
      lastError: expect.stringMatching(/no se llegó a enviar/i),
    })
    expect(cas(d2)).toEqual({ cancelIntento: 4, cancelEnviadaAt: null, cancelAcusadaAt: null })
    expect(INTENCION_ABANDONADA_MS).toBe(10 * 60_000)
  })

  it('enviado sin acuse + «en trámite» (o «verifying») ⇒ se acusa (CAS intento, token)', async () => {
    for (const s of ['pending', 'verifying']) {
      const token = new Date(ahora.getTime() - 2 * 60_000)
      const d = deps(s)
      await refreshPendingCancellation(fila({ cancelEnviadaAt: token }), { sandbox: true }, d as any)
      expect([s, d.applyCancelOutcome.mock.calls.length]).toEqual([s, 1])
      expect(d.applyCancelOutcome.mock.calls[0][1]).toMatchObject({ cancelAcusadaAt: ahora })
      expect(cas(d)).toEqual({ cancelIntento: 4, cancelEnviadaAt: token, cancelAcusadaAt: null })
    }
  })

  it('🔴 «cancelada» es un hecho, de cualquier estado del intento (también ENVIANDO): CANCELLED con CAS sólo del intento', async () => {
    const d = deps('canceled')
    await refreshPendingCancellation(fila({ cancelEnviadaAt: new Date(ahora.getTime() - 30_000) }), { sandbox: true }, d as any)
    expect(d.applyCancelOutcome).toHaveBeenCalledTimes(1)
    expect(d.applyCancelOutcome.mock.calls[0][1]).toMatchObject({ status: 'CANCELLED', cancelStatus: 'CANCELLED' })
    expect(cas(d)).toEqual({ cancelIntento: 4 })
    expect(d.logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CFDI_CANCEL_CONFIRMED' }))
  })

  // Ronda 2 (N1, cambia a propósito): un «sin solicitud» en duda ya no escribe; la respuesta atrasada de esta prueba es un «rechazada».
  it('🔴 C2-28: una respuesta atrasada pierde su CAS ⇒ no escribe bitácora, lo registra y devuelve la fila releída', async () => {
    const releida = { ...fila({}), cancelAcusadaAt: ahora }
    const d = deps('rejected', { applyCancelOutcome: jest.fn().mockResolvedValue(null), loadCfdi: jest.fn().mockResolvedValue(releida) })
    const r = await refreshPendingCancellation(
      fila({ cancelIntento: 1, cancelEnviadaAt: new Date(ahora.getTime() - 2 * 60_000) }), // OF-2 (T2 R1): primer intento
      { sandbox: true },
      d as any,
    )
    expect(d.logAction).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/respuesta atrasada ignorada/),
      expect.objectContaining({ cfdiId: 'c1' }),
    )
    expect(r).toBe(releida)
  })

  it('control — estructural: el barrido no tiene con qué enviar', () => {
    expect(defaultRefreshDeps).not.toHaveProperty('enviar')
    expect(defaultRefreshDeps).not.toHaveProperty('tomarEnvio')
  })

  it('estadoDeCancelacion: anotada, enviando (< 60 s), en trámite, EN DUDA, y los cerrados', () => {
    const e = (over: any) => estadoDeCancelacion(fila(over), ahora)
    expect(e({})).toBe('ANOTADA')
    expect(e({ cancelEnviadaAt: new Date(ahora.getTime() - 30_000) })).toBe('ENVIANDO')
    expect(e({ cancelEnviadaAt: new Date(ahora.getTime() - ENVIO_TERMINADO_MS) })).toBe('CANCELACION_EN_DUDA')
    expect(e({ cancelEnviadaAt: new Date(ahora.getTime() - 2 * 60_000) })).toBe('CANCELACION_EN_DUDA')
    expect(e({ cancelEnviadaAt: ahora, cancelAcusadaAt: ahora })).toBe('EN_TRAMITE')
    expect(e({ cancelStatus: 'REJECTED' })).toBe('RECHAZADA')
    expect(e({ cancelStatus: 'CANCELLED' })).toBe('CANCELADA')
    expect(e({ cancelStatus: 'ACCEPTED' })).toBe('CANCELADA')
    expect(e({ cancelStatus: null })).toBeNull()
  })
})

describe('C2-32 · el rango explícito de la cancelación', () => {
  it('🔴 un hecho confirmado sube desde REQUESTED o REJECTED; el negativo y el acuse sólo desde REQUESTED', () => {
    expect(desdeDondeSube('CANCELLED')).toEqual(['REQUESTED', 'REJECTED'])
    expect(desdeDondeSube('ACCEPTED')).toEqual(['REQUESTED', 'REJECTED'])
    expect(desdeDondeSube('REJECTED')).toEqual(['REQUESTED'])
    expect(desdeDondeSube('REQUESTED')).toEqual(['REQUESTED'])
    expect(RANGO_DE_CANCELACION.CANCELLED).toBeGreaterThan(RANGO_DE_CANCELACION.REJECTED)
    expect(RANGO_DE_CANCELACION.REJECTED).toBeGreaterThan(RANGO_DE_CANCELACION.REQUESTED)
  })
})

describe('C2 · el barrido revisa a todas (cursor)', () => {
  it('🔴 51 en trámite, las 50 primeras siguen: la 51 se revisa en la pasada siguiente; al terminar, vuelve al principio', async () => {
    const filas = Array.from({ length: 51 }, (_, i) => ({
      id: `c${String(i).padStart(2, '0')}`,
      cancelRequestedAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
    }))
    const findPending = jest.fn(async (_cutoff: Date, cursor?: { requestedAt: Date; id: string } | null) =>
      filas
        .filter(
          f => !cursor || f.cancelRequestedAt > cursor.requestedAt || (+f.cancelRequestedAt === +cursor.requestedAt && f.id > cursor.id),
        )
        .slice(0, 50),
    )
    const refresh = jest.fn(async (f: any) => ({ ...f, cancelStatus: 'REQUESTED' }))
    const p1 = await syncPendingCancellations(
      { sandbox: true, now: new Date('2026-10-05T00:00:00Z'), cursor: null },
      { findPending, refresh },
    )
    expect(p1.revisadas).toBe(50)
    expect(p1.cursor).toEqual({ requestedAt: filas[49].cancelRequestedAt, id: 'c49' })
    const p2 = await syncPendingCancellations(
      { sandbox: true, now: new Date('2026-10-05T00:00:00Z'), cursor: p1.cursor },
      { findPending, refresh },
    )
    expect(refresh.mock.calls.map(c => c[0].id)).toContain('c50')
    expect(p2.revisadas).toBe(1)
    expect(p2.cursor).toBeNull()
  })
})

describe('C2 · lo detectado: un POST tardío (CFDI_CANCELACION_TARDIA)', () => {
  const ahora = new Date('2026-10-05T12:00:00Z')
  const rechazada = {
    ...stampedCfdi,
    fiscalEmisorId: 'e1',
    cancelStatus: 'REJECTED',
    cancelIntento: 1,
    lastError: 'El SAT no tiene la solicitud de cancelación…',
    cancelEnviadaAt: new Date(ahora.getTime() - 5 * 60_000),
  }
  const externa = (status: string, over: Record<string, any> = {}) => ({
    loadEmisor: jest.fn(),
    resolveProvider: jest.fn().mockReturnValue({ getCancellationStatus: jest.fn().mockResolvedValue({ status, cancelledAt: null }) }),
    applyExternalCancel: jest.fn(async (_id: string, data: any) => ({ ...rechazada, ...data })),
    logAction: jest.fn(),
    ...over,
  })

  it('🔴 la fila local está REJECTED y el PAC dice «en trámite» ⇒ vuelve a REQUESTED acusada, con CFDI_CANCELACION_TARDIA', async () => {
    const d = externa('pending')
    await sincronizarCancelacionExterna(rechazada, { sandbox: true }, d as any)
    expect(d.applyExternalCancel).toHaveBeenCalledTimes(1)
    expect(d.applyExternalCancel.mock.calls[0][1]).toMatchObject({ cancelStatus: 'REQUESTED', cancelAcusadaAt: expect.any(Date) })
    expect((d.applyExternalCancel.mock.calls[0] as any[])[3]).toEqual({ cancelStatus: 'REJECTED', cancelIntento: 1 })
    expect(d.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CFDI_CANCELACION_TARDIA',
        entityId: 'c1',
        data: expect.objectContaining({ cancelIntento: 1, lastError: rechazada.lastError, providerStatus: 'pending' }),
      }),
    )
  })

  it('🔴 la fila local está REJECTED y el PAC dice «cancelada» ⇒ CANCELLED, con CFDI_CANCELACION_TARDIA (y la confirmación de siempre)', async () => {
    const d = externa('canceled')
    await sincronizarCancelacionExterna(rechazada, { sandbox: true }, d as any)
    expect(d.applyExternalCancel.mock.calls[0][1]).toMatchObject({ status: 'CANCELLED', cancelStatus: 'CANCELLED' })
    expect(d.logAction.mock.calls.map((c: any[]) => c[0].action).sort()).toEqual(['CFDI_CANCELACION_TARDIA', 'CFDI_CANCEL_CONFIRMED'])
  })

  it('control — sin cancelación local, un «en trámite» del PAC no dice nada de una cancelación nuestra: no se escribe', async () => {
    const d = externa('pending')
    await sincronizarCancelacionExterna({ ...rechazada, cancelStatus: null }, { sandbox: true }, d as any)
    expect(d.applyExternalCancel).not.toHaveBeenCalled()
    expect(d.logAction).not.toHaveBeenCalled()
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// C2 · Tarea 2 · ronda de arreglos 1 (task-2-review.md): I1, I2, M1, M2, M3, M6.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════

describe('C2 · ronda 1 — la cancelación del dueño, con el tiempo de verdad', () => {
  beforeEach(() => jest.clearAllMocks())
  const proveedor = (o: { consultas?: Array<string | Error>; post?: jest.Mock } = {}) => {
    const getCancellationStatus = jest.fn()
    for (const s of o.consultas ?? ['none', 'none'])
      if (s instanceof Error) getCancellationStatus.mockRejectedValueOnce(s)
      else getCancellationStatus.mockResolvedValueOnce({ status: s, cancelledAt: s === 'canceled' ? new Date() : null })
    const post = o.post ?? jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null })
    return {
      resolveProvider: jest.fn().mockReturnValue({ name: 'facturapi', getCancellationStatus, cancelInvoice: post } as any),
      getCancellationStatus,
      post,
    }
  }

  it('🔴 I1: el POST no contesta con el token REAL recién tomado ⇒ el resultado dice CANCELACION_EN_DUDA (el dueño SABE que terminó sin respuesta)', async () => {
    let token!: Date
    const p = proveedor({ post: jest.fn().mockRejectedValue(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })) })
    const deps = cancelDeps({
      resolveProvider: p.resolveProvider,
      tomarEnvio: jest.fn(async (_id: string, _i: number, ahora: Date) => (token = ahora)),
      loadCfdi: jest
        .fn()
        .mockResolvedValueOnce(stampedCfdi)
        .mockImplementation(async () => ({
          ...stampedCfdi,
          cancelStatus: 'REQUESTED',
          cancelIntento: 1,
          cancelEnviadaAt: token,
          cancelAcusadaAt: null,
        })),
    })
    expect(await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)).toMatchObject({
      enDuda: true,
      estado: 'CANCELACION_EN_DUDA',
    })
  })

  it('🔴 I2: el umbral de «envío terminado» se DERIVA de los tiempos límite del proveedor: consulta previa + POST + margen', () => {
    expect(MARGEN_DE_ENVIO_MS).toBeGreaterThan(0)
    expect(ENVIO_TERMINADO_MS).toBe(TIEMPO_LIMITE_CONSULTA_MS + TIEMPO_LIMITE_ENVIO_MS + MARGEN_DE_ENVIO_MS)
    expect(ENVIO_TERMINADO_MS).toBeGreaterThan(TIEMPO_LIMITE_CONSULTA_MS + TIEMPO_LIMITE_ENVIO_MS)
  })

  const ahora = new Date('2026-10-05T12:00:00Z')
  const fila = (over: Record<string, any>) => ({
    ...stampedCfdi,
    cancelStatus: 'REQUESTED',
    cancelIntento: 4,
    cancelRequestedAt: new Date(ahora.getTime() - 70_000),
    cancelEnviadaAt: null,
    cancelAcusadaAt: null,
    ...over,
  })
  const consulta = (status: string) => ({
    loadEmisor: jest.fn(),
    resolveProvider: jest.fn().mockReturnValue({
      getCancellationStatus: jest.fn().mockResolvedValue({ status, cancelledAt: null }),
      cancelInvoice: jest.fn(),
    }),
    applyCancelOutcome: jest.fn(async (_id: string, data: any) => ({ ...stampedCfdi, ...data })),
    logAction: jest.fn(),
    now: () => ahora,
  })

  it('🔴 I2 (escenario de la revisión): una consulta concurrente a los 61 s del token, con el POST todavía en vuelo ⇒ ENVIANDO; un «sin solicitud» no cierra nada', async () => {
    const enVuelo = fila({ cancelEnviadaAt: new Date(ahora.getTime() - 61_000) })
    expect(estadoDeCancelacion(enVuelo, ahora)).toBe('ENVIANDO')
    const d = consulta('none')
    await refreshPendingCancellation(enVuelo, { sandbox: true }, d as any)
    expect(d.applyCancelOutcome).not.toHaveBeenCalled()
  })

  it('🔴 I2 (b): el POST del dueño aterriza «pending» pero una consulta ya cerró su intento (REJECTED) ⇒ relee y aplica la vía tardía: REQUESTED acusada + CFDI_CANCELACION_TARDIA', async () => {
    const p = proveedor({ consultas: ['none'], post: jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null }) })
    const cerrada = { ...stampedCfdi, cancelStatus: 'REJECTED', cancelIntento: 7, lastError: 'El SAT no tiene la solicitud…' }
    const updateCfdi = jest
      .fn()
      .mockResolvedValueOnce(null) // el acuse pierde el CAS: la consulta concurrente ya cerró el intento
      .mockImplementation(async (_id: string, data: any) => ({ ...cerrada, ...data }))
    const deps = cancelDeps({
      resolveProvider: p.resolveProvider,
      anotarIntencion: jest.fn().mockResolvedValue({ estado: 'ANOTADA', intento: 7 }),
      updateCfdi,
      loadCfdi: jest.fn().mockResolvedValueOnce(stampedCfdi).mockResolvedValue(cerrada),
      logAction: jest.fn(),
    })
    const r = await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(updateCfdi).toHaveBeenCalledTimes(2)
    expect(updateCfdi.mock.calls[1][1]).toMatchObject({ cancelStatus: 'REQUESTED', cancelAcusadaAt: expect.any(Date) })
    expect(updateCfdi.mock.calls[1][3]).toBe('EXTERNA')
    expect(updateCfdi.mock.calls[1][4]).toEqual({ cancelStatus: 'REJECTED', cancelIntento: 7 })
    expect(deps.logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CFDI_CANCELACION_TARDIA', entityId: 'c1', data: expect.objectContaining({ cancelIntento: 7 }) }),
    )
    expect(r).toMatchObject({ applied: true, cancelStatus: 'REQUESTED' })
  })

  it('🔴 I2 (b): ídem con «cancelada» ⇒ CANCELLED por la vía tardía, con la confirmación y CFDI_CANCELACION_TARDIA', async () => {
    const p = proveedor({ consultas: ['none'], post: jest.fn().mockResolvedValue({ status: 'canceled', cancelledAt: new Date() }) })
    const cerrada = { ...stampedCfdi, cancelStatus: 'REJECTED', cancelIntento: 7 }
    const updateCfdi = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockImplementation(async (_id: string, data: any) => ({ ...cerrada, ...data }))
    const deps = cancelDeps({
      resolveProvider: p.resolveProvider,
      anotarIntencion: jest.fn().mockResolvedValue({ estado: 'ANOTADA', intento: 7 }),
      updateCfdi,
      loadCfdi: jest.fn().mockResolvedValueOnce(stampedCfdi).mockResolvedValue(cerrada),
      logAction: jest.fn(),
    })
    await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(updateCfdi).toHaveBeenCalledTimes(2)
    expect(updateCfdi.mock.calls[1][1]).toMatchObject({ status: 'CANCELLED', cancelStatus: 'CANCELLED' })
    expect((deps.logAction as jest.Mock).mock.calls.map(c => c[0].action).sort()).toEqual([
      'CFDI_CANCELACION_TARDIA',
      'CFDI_CANCEL_CONFIRMED',
    ])
  })

  it('I2 (b): si la fila ya dice lo mismo o más (otra consulta acusó o canceló), no hay vía tardía: se registra en el log y no se escribe', async () => {
    const p = proveedor({ consultas: ['none'], post: jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null }) })
    const acusada = { ...stampedCfdi, cancelStatus: 'REQUESTED', cancelIntento: 7, cancelAcusadaAt: new Date() }
    const updateCfdi = jest.fn().mockResolvedValue(null)
    const deps = cancelDeps({
      resolveProvider: p.resolveProvider,
      anotarIntencion: jest.fn().mockResolvedValue({ estado: 'ANOTADA', intento: 7 }),
      updateCfdi,
      loadCfdi: jest.fn().mockResolvedValueOnce(stampedCfdi).mockResolvedValue(acusada),
      logAction: jest.fn(),
    })
    await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(updateCfdi).toHaveBeenCalledTimes(1)
    expect(deps.logAction).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/respuesta del POST/),
      expect.objectContaining({ cfdiId: 'c1', cancelIntento: 7 }),
    )
  })

  it('🔴 M1: la consulta previa FALLA ⇒ no sale POST; el intento se cierra «no se llegó a enviar» con CAS (intento, token, sin acuse) y se responde 502 (ProviderUnavailableError)', async () => {
    const p = proveedor({ consultas: [new Error('connect ETIMEDOUT')] })
    const deps = cancelDeps({
      resolveProvider: p.resolveProvider,
      anotarIntencion: jest.fn().mockResolvedValue({ estado: 'ANOTADA', intento: 3 }),
    })
    const promesa = cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    await expect(promesa).rejects.toBeInstanceOf(ProviderUnavailableError)
    await expect(promesa).rejects.toThrow(/no se envió nada/)
    expect(p.post).not.toHaveBeenCalled()
    expect(deps.updateCfdi).toHaveBeenCalledTimes(1)
    expect((deps.updateCfdi as jest.Mock).mock.calls[0][1]).toMatchObject({
      cancelStatus: 'REJECTED',
      lastError: expect.stringMatching(/no se llegó a enviar/i),
    })
    expect((deps.updateCfdi as jest.Mock).mock.calls[0][4]).toEqual({ cancelIntento: 3, cancelEnviadaAt: TOKEN, cancelAcusadaAt: null })
  })

  it('🔴 M3: 401/403 y 404 resource_missing cuentan como «no salió»; un 404 con otro código sigue en duda', () => {
    expect(clasificarErrorDeCancelacion(err(401, 'unauthorized'))).toBe('NO_SALIO')
    expect(clasificarErrorDeCancelacion(err(403, 'forbidden'))).toBe('NO_SALIO')
    expect(clasificarErrorDeCancelacion(new ProviderHttpError(401, null, 'Invalid API key'))).toBe('NO_SALIO')
    expect(clasificarErrorDeCancelacion(err(404, 'resource_missing'))).toBe('NO_SALIO')
    expect(clasificarErrorDeCancelacion(err(404, 'otra_cosa'))).toBe('EN_DUDA')
  })

  it('🔴 M3: el POST contesta 401 ⇒ el intento se cierra REJECTED con un texto claro y CAS (intento, token, sin acuse); nunca «en duda»', async () => {
    const p = proveedor({ consultas: ['none'], post: jest.fn().mockRejectedValue(new ProviderHttpError(401, null, 'Invalid API key')) })
    const deps = cancelDeps({
      resolveProvider: p.resolveProvider,
      anotarIntencion: jest.fn().mockResolvedValue({ estado: 'ANOTADA', intento: 5 }),
    })
    expect(await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)).not.toHaveProperty('enDuda', true)
    expect((deps.updateCfdi as jest.Mock).mock.calls[0][1]).toMatchObject({
      cancelStatus: 'REJECTED',
      lastError: expect.stringMatching(/no se envió/),
    })
    expect((deps.updateCfdi as jest.Mock).mock.calls[0][4]).toEqual({ cancelIntento: 5, cancelEnviadaAt: TOKEN, cancelAcusadaAt: null })
  })

  it('🔴 M2: REQUESTED con cancelIntento = 0 es LEGADO (enviado y acusado antes de C2) ⇒ EN_TRAMITE, nunca «anotada»', () => {
    expect(estadoDeCancelacion(fila({ cancelIntento: 0 }), ahora)).toBe('EN_TRAMITE')
  })

  it('🔴 M2: la consulta de un legado que el PAC no tiene ⇒ REJECTED con el porqué VERDADERO (no «no se llegó a enviar»)', async () => {
    const d = consulta('none')
    await refreshPendingCancellation(
      fila({ cancelIntento: 0, cancelRequestedAt: new Date(ahora.getTime() - 3 * 60 * 60_000) }),
      { sandbox: true },
      d as any,
    )
    expect(d.applyCancelOutcome).toHaveBeenCalledTimes(1)
    expect(d.applyCancelOutcome.mock.calls[0][1]).toMatchObject({
      cancelStatus: 'REJECTED',
      lastError: expect.stringMatching(/no tiene la solicitud/),
    })
  })

  it('🔴 M6: el resultado dice si ESTA petición anotó un intento nuevo (para registrar quién lo pidió)', async () => {
    expect(await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, cancelDeps())).toMatchObject({ intencionNueva: true })
    const misma = cancelDeps({
      anotarIntencion: jest.fn().mockResolvedValue({ estado: 'MISMA_EN_TRAMITE', intento: 1 }),
      tomarEnvio: jest.fn().mockResolvedValue(null),
    })
    expect(await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, misma)).toMatchObject({ intencionNueva: false })
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// C2 · Tarea 2 · ronda de arreglos 2 (task-2-rereview-1.md): N1, N2, N4, N6.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════

describe('C2 · ronda 2 — un «sin solicitud» temprano no cierra un envío en duda (N1)', () => {
  beforeEach(() => jest.clearAllMocks())
  const ahora = new Date('2026-10-05T12:00:00Z')
  const fila = (over: Record<string, any>) => ({
    ...stampedCfdi,
    cancelStatus: 'REQUESTED',
    cancelIntento: 4,
    cancelRequestedAt: new Date(ahora.getTime() - 3 * 60_000),
    cancelEnviadaAt: null,
    cancelAcusadaAt: null,
    ...over,
  })
  const consulta = (status: string) => ({
    loadEmisor: jest.fn(),
    resolveProvider: jest.fn().mockReturnValue({
      getCancellationStatus: jest.fn().mockResolvedValue({ status, cancelledAt: status === 'canceled' ? ahora : null }),
      cancelInvoice: jest.fn(),
    }),
    applyCancelOutcome: jest.fn(async (_id: string, data: any) => ({ ...stampedCfdi, ...data })),
    logAction: jest.fn(),
    now: () => ahora,
  })
  const hace = (ms: number) => new Date(ahora.getTime() - ms)

  it('control — N1: el plazo de la duda es de 24 h, con nombre', () => {
    expect(PLAZO_DE_LA_DUDA_MS).toBe(24 * 60 * 60_000)
    expect(PLAZO_DE_LA_DUDA_MS).toBeGreaterThan(ENVIO_TERMINADO_MS)
  })

  it('🔴 N1: consulta a los 91 s del token (EN DUDA) con «sin solicitud» ⇒ no se cierra', async () => {
    const d = consulta('none')
    const enDuda = fila({ cancelEnviadaAt: hace(91_000) })
    expect(estadoDeCancelacion(enDuda, ahora)).toBe('CANCELACION_EN_DUDA')
    await refreshPendingCancellation(enDuda, { sandbox: true }, d as any)
    expect(d.applyCancelOutcome).not.toHaveBeenCalled()
    expect(d.logAction).not.toHaveBeenCalled()
  })

  it('🔴 N1: a las 23 h 59 min sigue en duda; pasadas las 24 h con «sin solicitud» se cierra «no se llegó a cancelar», con CAS de la foto y ActivityLog', async () => {
    const d1 = consulta('none')
    await refreshPendingCancellation(fila({ cancelEnviadaAt: hace(PLAZO_DE_LA_DUDA_MS - 60_000) }), { sandbox: true }, d1 as any)
    expect(d1.applyCancelOutcome).not.toHaveBeenCalled()
    const d2 = consulta('none')
    const token = hace(PLAZO_DE_LA_DUDA_MS + 1_000)
    await refreshPendingCancellation(fila({ cancelEnviadaAt: token }), { sandbox: true }, d2 as any)
    expect(d2.applyCancelOutcome).toHaveBeenCalledTimes(1)
    expect(d2.applyCancelOutcome.mock.calls[0][1]).toEqual({ cancelStatus: 'REJECTED', lastError: MOTIVO_SIN_SOLICITUD_EN_EL_PLAZO })
    expect((d2.applyCancelOutcome.mock.calls[0] as any[])[4]).toEqual({ cancelIntento: 4, cancelEnviadaAt: token, cancelAcusadaAt: null })
    expect(d2.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CFDI_CANCEL_NOT_APPLIED',
        data: expect.objectContaining({ providerStatus: 'none', estadoPrevio: 'CANCELACION_EN_DUDA' }),
      }),
    )
  })

  // C2 · OF-2 (T2 R1, cambia A PROPÓSITO): sólo con el PRIMER intento. Con un intento anterior, el rechazo/caducidad puede ser el viejo (abajo).
  it('control — N1: en duda en el PRIMER intento y el SAT SÍ responde (rechazada/caducada) ⇒ se cierra al momento (es una respuesta sobre una solicitud registrada)', async () => {
    for (const s of ['rejected', 'expired']) {
      const d = consulta(s)
      await refreshPendingCancellation(fila({ cancelIntento: 1, cancelEnviadaAt: hace(91_000) }), { sandbox: true }, d as any)
      expect([s, d.applyCancelOutcome.mock.calls.length]).toEqual([s, 1])
      expect(d.applyCancelOutcome.mock.calls[0][1]).toMatchObject({ cancelStatus: 'REJECTED' })
    }
  })

  it('control — N1: un intento ACUSADO que el PAC ya no tiene se cierra como antes (el PAC sí lo había registrado)', async () => {
    const d = consulta('none')
    await refreshPendingCancellation(
      fila({ cancelEnviadaAt: hace(2 * 60_000), cancelAcusadaAt: hace(60_000) }),
      { sandbox: true },
      d as any,
    )
    expect(d.applyCancelOutcome).toHaveBeenCalledTimes(1)
    expect(d.applyCancelOutcome.mock.calls[0][1]).toMatchObject({
      cancelStatus: 'REJECTED',
      lastError: expect.stringMatching(/no tiene la solicitud/),
    })
  })

  it('🔴 N1: el filtro de cierres recientes — rechazados, enviados (token, intento > 0), cerrados desde «desde», en orden con cursor', () => {
    const desde = hace(PLAZO_DE_LA_DUDA_MS)
    expect(dondeBuscarCierresRecientes(desde, null)).toEqual({
      cancelStatus: 'REJECTED',
      status: 'STAMPED',
      cancelIntento: { gt: 0 },
      cancelEnviadaAt: { not: null },
      AND: [{ updatedAt: { gte: desde } }],
    })
    const cursor = { updatedAt: hace(60_000), id: 'c9' }
    expect(dondeBuscarCierresRecientes(desde, cursor).AND).toEqual([
      { updatedAt: { gte: desde } },
      { OR: [{ updatedAt: { gt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, id: { gt: 'c9' } }] },
    ])
  })

  it('🔴 N1: el barrido, además de los en trámite, vuelve a consultar los cierres recientes (24 h); uno que falla no detiene a los demás', async () => {
    const now = new Date('2026-10-05T00:00:00Z')
    const findPending = jest.fn().mockResolvedValue([])
    const cerradas = [
      { id: 'r1', updatedAt: new Date('2026-10-04T10:00:00Z') },
      { id: 'r2', updatedAt: new Date('2026-10-04T11:00:00Z') },
    ]
    const findRecentlyClosed = jest.fn().mockResolvedValue(cerradas)
    const recheckClosed = jest.fn().mockRejectedValueOnce(new Error('PAC caído')).mockResolvedValueOnce({ id: 'r2', status: 'CANCELLED' })
    const r = await syncPendingCancellations(
      { sandbox: true, now, cursor: null, cursorCerradas: null },
      { findPending, refresh: jest.fn(), findRecentlyClosed, recheckClosed },
    )
    expect(findRecentlyClosed).toHaveBeenCalledWith(new Date(now.getTime() - PLAZO_DE_LA_DUDA_MS), null)
    expect(recheckClosed.mock.calls.map(c => c[0].id)).toEqual(['r1', 'r2'])
    expect(r).toMatchObject({ cierresRevisados: 2, errores: 1, cursorCerradas: null })
  })

  it('🔴 N1: la fase de cierres recientes también recorre con cursor (página llena ⇒ la última fila)', async () => {
    const cerradas = Array.from({ length: 50 }, (_, i) => ({
      id: `r${String(i).padStart(2, '0')}`,
      updatedAt: new Date(Date.UTC(2026, 9, 4, 0, i)),
    }))
    const r = await syncPendingCancellations(
      { sandbox: true, now: new Date('2026-10-05T00:00:00Z') },
      {
        findPending: jest.fn().mockResolvedValue([]),
        refresh: jest.fn(),
        findRecentlyClosed: jest.fn().mockResolvedValue(cerradas),
        recheckClosed: jest.fn(),
      },
    )
    expect(r.cursorCerradas).toEqual({ updatedAt: cerradas[49].updatedAt, id: 'r49' })
  })
})

describe('C2 · ronda 2 — N2, N4 y N6', () => {
  beforeEach(() => jest.clearAllMocks())
  const proveedor = (post: jest.Mock, consultas: string[] = ['none']) => {
    const getCancellationStatus = jest.fn()
    for (const s of consultas) getCancellationStatus.mockResolvedValueOnce({ status: s, cancelledAt: null })
    return jest.fn().mockReturnValue({ name: 'facturapi', getCancellationStatus, cancelInvoice: post } as any)
  }

  it('🔴 N2: el POST quedó en duda pero, al releer, la fila ya está ACUSADA ⇒ sin `enDuda`; estado EN_TRAMITE', async () => {
    const deps = cancelDeps({
      resolveProvider: proveedor(jest.fn().mockRejectedValue(new Error('ETIMEDOUT'))),
      loadCfdi: jest
        .fn()
        .mockResolvedValueOnce(stampedCfdi)
        .mockResolvedValue({
          ...stampedCfdi,
          cancelStatus: 'REQUESTED',
          cancelIntento: 1,
          cancelEnviadaAt: TOKEN,
          cancelAcusadaAt: new Date(),
        }),
    })
    const r = await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(r).not.toHaveProperty('enDuda')
    expect(r.estado).toBe('EN_TRAMITE')
  })

  it('🔴 N2: ídem si al releer ya está RECHAZADA ⇒ sin `enDuda`; estado RECHAZADA', async () => {
    const deps = cancelDeps({
      resolveProvider: proveedor(jest.fn().mockRejectedValue(new Error('ETIMEDOUT'))),
      loadCfdi: jest
        .fn()
        .mockResolvedValueOnce(stampedCfdi)
        .mockResolvedValue({ ...stampedCfdi, cancelStatus: 'REJECTED', cancelIntento: 1 }),
    })
    const r = await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(r).not.toHaveProperty('enDuda')
    expect(r.estado).toBe('RECHAZADA')
  })

  it('🔴 N4 + N6: la vía tardía del dueño con «pending» limpia el lastError del cierre; las dos bitácoras dicen el MISMO origen', async () => {
    const cerrada = { ...stampedCfdi, cancelStatus: 'REJECTED', cancelIntento: 7, lastError: 'El SAT no tiene la solicitud…' }
    const updateCfdi = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockImplementation(async (_id: string, data: any) => ({ ...cerrada, ...data }))
    const deps = cancelDeps({
      resolveProvider: proveedor(jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null })),
      anotarIntencion: jest.fn().mockResolvedValue({ estado: 'ANOTADA', intento: 7 }),
      updateCfdi,
      loadCfdi: jest.fn().mockResolvedValueOnce(stampedCfdi).mockResolvedValue(cerrada),
      logAction: jest.fn(),
    })
    await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(updateCfdi).toHaveBeenCalledTimes(2)
    expect(updateCfdi.mock.calls[1][1]).toEqual({ cancelStatus: 'REQUESTED', cancelAcusadaAt: expect.any(Date), lastError: null })
    expect((deps.logAction as jest.Mock).mock.calls[0][0].data).toMatchObject({ origen: 'DUENO_TARDIO' })
  })

  it('🔴 N6: con «cancelada», confirmación y tardía llevan el MISMO origen', async () => {
    const cerrada = { ...stampedCfdi, cancelStatus: 'REJECTED', cancelIntento: 7 }
    const deps = cancelDeps({
      resolveProvider: proveedor(jest.fn().mockResolvedValue({ status: 'canceled', cancelledAt: new Date() })),
      anotarIntencion: jest.fn().mockResolvedValue({ estado: 'ANOTADA', intento: 7 }),
      updateCfdi: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockImplementation(async (_id: string, data: any) => ({ ...cerrada, ...data })),
      loadCfdi: jest.fn().mockResolvedValueOnce(stampedCfdi).mockResolvedValue(cerrada),
      logAction: jest.fn(),
    })
    await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    const origenes = (deps.logAction as jest.Mock).mock.calls.map(c => c[0].data.origen)
    expect(origenes).toHaveLength(2)
    expect(new Set(origenes)).toEqual(new Set(['DUENO_TARDIO']))
  })

  it('🔴 N4: la sincronización externa que reabre un REJECTED como en trámite también limpia el lastError', async () => {
    const rechazada = {
      ...stampedCfdi,
      fiscalEmisorId: 'e1',
      cancelStatus: 'REJECTED',
      cancelIntento: 1,
      lastError: 'El SAT no tiene la solicitud…',
    }
    const d = {
      loadEmisor: jest.fn(),
      resolveProvider: jest
        .fn()
        .mockReturnValue({ getCancellationStatus: jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null }) }),
      applyExternalCancel: jest.fn(async (_id: string, data: any) => ({ ...rechazada, ...data })),
      logAction: jest.fn(),
    }
    await sincronizarCancelacionExterna(rechazada, { sandbox: true }, d as any)
    expect(d.applyExternalCancel).toHaveBeenCalledTimes(1)
    expect(d.applyExternalCancel.mock.calls[0][1]).toEqual({
      cancelStatus: 'REQUESTED',
      cancelAcusadaAt: expect.any(Date),
      lastError: null,
    })
  })
})

// ─── C2 · Tarea 10 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('C2 · T10 — getCfdiStatus (el detalle, GET /cfdi/:id) dice `estadoCancelacion` en CADA consulta (C2-31)', () => {
  const T0 = new Date('2026-10-05T18:00:00.000Z')
  const fila = (over: Record<string, any> = {}) => ({
    ...stampedCfdi,
    cancelStatus: 'REQUESTED',
    cancelIntento: 1,
    cancelEnviadaAt: T0,
    cancelAcusadaAt: null,
    ...over,
  })
  afterEach(() => jest.useRealTimers())
  const consultar = async (ahora: Date, c: any) => {
    jest.useFakeTimers({ now: ahora, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
    const deps: GetCfdiStatusDeps = { loadCfdi: jest.fn().mockResolvedValue(c) }
    const r = await getCfdiStatus({ cfdiId: 'c1', expectedVenueId: 'v1' }, deps)
    jest.useRealTimers()
    return r
  }
  it('🔴 enviada hace 30 s sin acuse ⇒ ENVIANDO; una consulta NUEVA pasado el umbral ⇒ CANCELACION_EN_DUDA; con acuse ⇒ EN_TRAMITE', async () => {
    expect((await consultar(new Date(T0.getTime() + 30_000), fila())).estadoCancelacion).toBe('ENVIANDO')
    expect((await consultar(new Date(T0.getTime() + ENVIO_TERMINADO_MS + 1_000), fila())).estadoCancelacion).toBe('CANCELACION_EN_DUDA')
    const acusada = fila({ cancelAcusadaAt: new Date(T0.getTime() + 5_000) })
    expect((await consultar(new Date(T0.getTime() + ENVIO_TERMINADO_MS + 1_000), acusada)).estadoCancelacion).toBe('EN_TRAMITE')
  })
  it('🔴 no expone las dos fechas internas (sí lo demás de la fila)', async () => {
    const r = await consultar(new Date(T0.getTime() + 30_000), fila())
    expect(r).not.toHaveProperty('cancelEnviadaAt')
    expect(r).not.toHaveProperty('cancelAcusadaAt')
    expect(r).toMatchObject({ id: 'c1', uuid: 'U1', cancelStatus: 'REQUESTED' })
  })
  // T10 ronda 1 (M1): `cancelIntento` es columna nueva de C2 (no está en producción): tampoco sale. `lastError`, `facturapiId` e
  // `idempotencyKey` ya salían antes de C2: son contrato y se quedan.
  it('🔴 M1: tampoco expone `cancelIntento`; sí `lastError`, `facturapiId` e `idempotencyKey` (contrato de antes)', async () => {
    const r = await consultar(new Date(T0.getTime() + 30_000), fila({ lastError: 'algo', idempotencyKey: 'cfdi-order-o1' }))
    expect(r).not.toHaveProperty('cancelIntento')
    expect(r).toMatchObject({ lastError: 'algo', facturapiId: 'fa1', idempotencyKey: 'cfdi-order-o1' })
  })
  it('🔴 sin cancelación ⇒ `estadoCancelacion: null` (no se omite)', async () => {
    expect((await consultar(T0, { ...stampedCfdi, cancelStatus: null })).estadoCancelacion).toBeNull()
  })
})

describe('C2 · T10 — el PAC rechaza la cancelación porque la factura tiene CFDI relacionados (respuesta del controlador a P6)', () => {
  const RELACIONADOS = 'No se puede cancelar: el comprobante tiene CFDI relacionados vigentes.'
  const FRASE = 'Esta factura ya tiene notas de crédito; cancélalas primero.'
  const proveedor = (post: jest.Mock) => {
    const getCancellationStatus = jest.fn().mockResolvedValue({ status: 'none', cancelledAt: null })
    return jest.fn().mockReturnValue({ name: 'facturapi', getCancellationStatus, cancelInvoice: post } as any)
  }
  const escrito = (d: CancelCfdiDeps) => (d.updateCfdi as jest.Mock).mock.calls.map(c => c[1])
  it('🔴 un 4xx sin código de la lista que habla de CFDI relacionados es un rechazo: la fila queda REJECTED con la frase, no el texto crudo', async () => {
    const deps = cancelDeps({ resolveProvider: proveedor(jest.fn().mockRejectedValue(new ProviderHttpError(400, null, RELACIONADOS))) })
    const r = await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(escrito(deps)).toEqual([expect.objectContaining({ cancelStatus: 'REJECTED', lastError: FRASE })])
    expect(r).not.toHaveProperty('enDuda')
  })
  it('🔴 clasificarErrorDeCancelacion: 4xx con «relacionad»/«related» ⇒ RECHAZO, aunque el código no esté en la lista', () => {
    expect(clasificarErrorDeCancelacion(new ProviderHttpError(400, null, RELACIONADOS))).toBe('RECHAZO')
    expect(clasificarErrorDeCancelacion(new ProviderHttpError(422, 'unknown', 'The invoice has related documents'))).toBe('RECHAZO')
  })
  it('control — con un código de rechazo de la lista y el mismo texto, la misma frase', async () => {
    const deps = cancelDeps({
      resolveProvider: proveedor(jest.fn().mockRejectedValue(new ProviderHttpError(400, 'invoice_not_cancelable_by_sat', RELACIONADOS))),
    })
    await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(escrito(deps)).toEqual([expect.objectContaining({ cancelStatus: 'REJECTED', lastError: FRASE })])
  })
  it('control — un 5xx que dice lo mismo sigue EN DUDA (no se sabe si salió): no se escribe nada', async () => {
    const deps = cancelDeps({ resolveProvider: proveedor(jest.fn().mockRejectedValue(new ProviderHttpError(502, null, RELACIONADOS))) })
    expect(await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)).toMatchObject({ enDuda: true })
    expect(deps.updateCfdi).not.toHaveBeenCalled()
  })
  it('control — 401/404 siguen siendo «no salió», aunque el texto hable de relacionados', () => {
    expect(clasificarErrorDeCancelacion(new ProviderHttpError(401, null, RELACIONADOS))).toBe('NO_SALIO')
    expect(clasificarErrorDeCancelacion(new ProviderHttpError(404, 'resource_missing', RELACIONADOS))).toBe('NO_SALIO')
  })
})

describe('C2 · T10 — textos según el estado (M2 y N1 de la T3)', () => {
  const T = new Date('2026-10-05T18:00:00.000Z')
  it('control — sustitutaAtorada (su rojo es el del cargador de la nota): sólo si se ENVIÓ hace una hora o más y no se timbró', () => {
    const hora = SUSTITUTA_ATORADA_MS
    expect(sustitutaAtorada({ status: 'STAMPING', enviadoAt: new Date(T.getTime() - hora) }, T)).toBe(true)
    expect(sustitutaAtorada({ status: 'STAMP_FAILED', enviadoAt: new Date(T.getTime() - 2 * hora) }, T)).toBe(true)
    expect(sustitutaAtorada({ status: 'STAMPING', enviadoAt: new Date(T.getTime() - hora + 1) }, T)).toBe(false)
    expect(sustitutaAtorada({ status: 'STAMPING', enviadoAt: null }, T)).toBe(false)
    expect(sustitutaAtorada({ status: 'STAMPED', enviadoAt: new Date(T.getTime() - 2 * hora) }, T)).toBe(false)
    expect(sustitutaAtorada(null, T)).toBe(false)
    expect(SUSTITUTA_ATORADA_MS).toBe(60 * 60_000)
  })
  it('🔴 la sustitución que NO empieza por una cancelación pedida dice en qué va: enviándose · en duda (hasta 24 h) · en trámite', () => {
    const fila = (over: Record<string, unknown>) => ({ cancelStatus: 'REQUESTED', cancelIntento: 1, ...over })
    expect(textoDeCancelacionPendienteAlSustituir(fila({ cancelEnviadaAt: null, cancelAcusadaAt: null }), T)).toBe(
      'La cancelación de esta factura se está enviando al SAT; espera a que se resuelva antes de sustituirla.',
    )
    expect(
      textoDeCancelacionPendienteAlSustituir(fila({ cancelEnviadaAt: T, cancelAcusadaAt: null }), new Date(T.getTime() + 30_000)),
    ).toBe('La cancelación de esta factura se está enviando al SAT; espera a que se resuelva antes de sustituirla.')
    const duda = textoDeCancelacionPendienteAlSustituir(
      fila({ cancelEnviadaAt: T, cancelAcusadaAt: null }),
      new Date(T.getTime() + ENVIO_TERMINADO_MS + 1_000),
    )
    expect(duda).toMatch(/^La cancelación de esta factura está en duda/)
    expect(duda).toMatch(/hasta 24 horas/)
    expect(textoDeCancelacionPendienteAlSustituir(fila({ cancelEnviadaAt: T, cancelAcusadaAt: T }), T)).toBe(
      'Esta factura tiene una cancelación en trámite ante el SAT; espera a que se resuelva antes de sustituirla.',
    )
  })
})

// ─── C2 · Tarea 10, ronda 1 (I-1) ───────────────────────────────────────────────────────────────────────────────────────────────
describe('C2 · T10 ronda 1 (I-1) — «Consultar estado» (`soloConsultar`) nunca crea ni envía un intento', () => {
  beforeEach(() => jest.clearAllMocks())
  const T0 = new Date('2026-10-05T18:00:00.000Z')
  const conPac = () => {
    const cancelInvoice = jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null })
    const getCancellationStatus = jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null })
    return {
      cancelInvoice,
      getCancellationStatus,
      resolveProvider: jest.fn().mockReturnValue({ name: 'facturapi', cancelInvoice, getCancellationStatus } as any),
    }
  }
  const consultar = (fila: any, over: Partial<CancelCfdiDeps> = {}) => {
    const pac = conPac()
    const deps = cancelDeps({ loadCfdi: jest.fn().mockResolvedValue(fila), resolveProvider: pac.resolveProvider, ...over })
    // Con el MISMO motivo que pedía el botón viejo (C2-24): el defecto era justo ése, repetir la petición anotaba un intento nuevo.
    return { deps, pac, r: cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'v1', soloConsultar: true }, deps) }
  }
  const nadaSeMando = (deps: CancelCfdiDeps, pac: ReturnType<typeof conPac>) => {
    expect(deps.anotarIntencion).not.toHaveBeenCalled()
    expect(deps.tomarEnvio).not.toHaveBeenCalled()
    expect(deps.updateCfdi).not.toHaveBeenCalled()
    expect(pac.cancelInvoice).not.toHaveBeenCalled()
  }

  it('🔴 la fila ya está RECHAZADA (la lista no se refrescó): no anota, no toma el envío, no hace POST ni GET; dice RECHAZADA', async () => {
    const rechazada = { ...stampedCfdi, cancelStatus: 'REJECTED', cancelIntento: 1, cancelMotivo: '02', lastError: 'El receptor rechazó' }
    const { deps, pac, r } = consultar(rechazada)
    expect(await r).toMatchObject({ applied: false, intencionNueva: false, cancelStatus: 'REJECTED', estado: 'RECHAZADA' })
    nadaSeMando(deps, pac)
    expect(deps.refresh).not.toHaveBeenCalled()
  })

  it('🔴 en duda (REQUESTED, enviada hace más del umbral): SÓLO consulta (refresh = GET) y contesta cómo quedó', async () => {
    jest.useFakeTimers({
      now: new Date(T0.getTime() + ENVIO_TERMINADO_MS + 1_000),
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    })
    try {
      const enDuda = { ...stampedCfdi, cancelStatus: 'REQUESTED', cancelIntento: 1, cancelEnviadaAt: T0, cancelAcusadaAt: null }
      const acusada = { ...enDuda, cancelAcusadaAt: new Date(T0.getTime() + 5_000) }
      const refresh = jest.fn().mockResolvedValue(acusada)
      const { deps, pac, r } = consultar(enDuda, { refresh })
      expect(await r).toMatchObject({ applied: false, intencionNueva: false, cancelStatus: 'REQUESTED', estado: 'EN_TRAMITE' })
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(refresh).toHaveBeenCalledWith(enDuda, { sandbox: true })
      nadaSeMando(deps, pac)
    } finally {
      jest.useRealTimers()
    }
  })

  it('🔴 ya CANCELADA (status CANCELLED): no lanza «sólo se puede cancelar una timbrada»; dice CANCELADA sin escribir nada', async () => {
    const cancelada = { ...stampedCfdi, status: 'CANCELLED', cancelStatus: 'CANCELLED', cancelIntento: 1 }
    const { deps, pac, r } = consultar(cancelada)
    expect(await r).toMatchObject({ applied: false, cancelStatus: 'CANCELLED', estado: 'CANCELADA' })
    nadaSeMando(deps, pac)
    expect(deps.refresh).not.toHaveBeenCalled()
  })

  it('🔴 vigente y sin cancelación pedida: `cancelStatus: null` y `estado: null` (nunca «rechazada»); nada se escribe', async () => {
    const { deps, pac, r } = consultar({ ...stampedCfdi, cancelStatus: null })
    expect(await r).toMatchObject({ applied: false, cancelStatus: null, estado: null })
    nadaSeMando(deps, pac)
  })

  it('🔴 sin motivo y con un motivo 01 sin sustituto: no hace falta nada de eso para consultar', async () => {
    const rechazada = { ...stampedCfdi, cancelStatus: 'REJECTED', cancelIntento: 1 }
    const pac = conPac()
    const deps = cancelDeps({ loadCfdi: jest.fn().mockResolvedValue(rechazada), resolveProvider: pac.resolveProvider })
    await expect(cancelCfdi({ cfdiId: 'c1', motivo: '01', sandbox: true, soloConsultar: true }, deps)).resolves.toMatchObject({
      estado: 'RECHAZADA',
    })
    nadaSeMando(deps, pac)
  })

  it('🔴 en trámite y el PAC no contesta la consulta: dice cómo está la fila (no lanza) y no manda nada', async () => {
    const enTramite = { ...stampedCfdi, cancelStatus: 'REQUESTED', cancelIntento: 1, cancelEnviadaAt: T0, cancelAcusadaAt: T0 }
    const { deps, pac, r } = consultar(enTramite, { refresh: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) })
    expect(await r).toMatchObject({ applied: false, cancelStatus: 'REQUESTED', estado: 'EN_TRAMITE' })
    nadaSeMando(deps, pac)
  })

  it('control — tenant: otra sucursal ⇒ «not found» (también al consultar)', async () => {
    const pac = conPac()
    const deps = cancelDeps({ resolveProvider: pac.resolveProvider })
    await expect(cancelCfdi({ cfdiId: 'c1', sandbox: true, expectedVenueId: 'OTRA', soloConsultar: true }, deps)).rejects.toThrow(
      /not found/,
    )
    nadaSeMando(deps, pac)
  })

  it('control — sin `soloConsultar` y sin motivo: sigue exigiendo el motivo (no se manda nada)', async () => {
    const pac = conPac()
    const deps = cancelDeps({ resolveProvider: pac.resolveProvider })
    await expect(cancelCfdi({ cfdiId: 'c1', sandbox: true, expectedVenueId: 'v1' }, deps)).rejects.toThrow(
      /motivo de cancelación es requerido/,
    )
    nadaSeMando(deps, pac)
  })
})

// ─── C2 · Tarea 10, ronda 1 (M2): la regla «relacionados» con límites de palabra, y el texto según el código ─────────────────────
describe('C2 · T10 ronda 1 (M2) — «relacionados» con límites de palabra; la sustituta tiene su propio texto', () => {
  const FRASE = 'Esta factura ya tiene notas de crédito; cancélalas primero.'
  it('🔴 sonda 1: un 4xx con código desconocido que dice «unrelated» NO es «relacionados»: queda EN DUDA y no se traduce a la frase', () => {
    const err = new ProviderHttpError(400, 'some_new_code', 'The substitution invoice is unrelated to this customer')
    expect(clasificarErrorDeCancelacion(err)).toBe('EN_DUDA')
    expect(traducirRechazoDeCancelacion(err)).not.toBe(FRASE)
  })
  it('🔴 sonda 2: `substitution_invoice_not_found` aunque el texto diga «relacionado» ⇒ RECHAZO con un texto sobre la factura SUSTITUTA', () => {
    const err = new ProviderHttpError(400, 'substitution_invoice_not_found', 'El CFDI relacionado no existe')
    expect(clasificarErrorDeCancelacion(err)).toBe('RECHAZO')
    const texto = traducirRechazoDeCancelacion(err)
    expect(texto).not.toBe(FRASE)
    expect(texto).toMatch(/sustituta/)
    expect(texto).toMatch(/sigue vigente/)
  })
  it('🔴 cada código de sustitución habla de la sustituta, nunca de notas de crédito', () => {
    for (const code of [
      'substitution_invoice_required',
      'substitution_invoice_not_found',
      'substitution_invoice_canceled',
      'substitution_invoice_status_not_allowed',
      'substitution_invoice_otro_nuevo',
    ]) {
      const texto = traducirRechazoDeCancelacion(new ProviderHttpError(400, code, 'Has related documents'))
      expect([code, /sustitu/.test(texto), /notas de crédito/.test(texto)]).toEqual([code, true, false])
    }
  })
  it('control — sonda 3: un 4xx sin código y sin ese texto sigue EN DUDA (asimetría a propósito: no se sabe qué pasó)', () => {
    expect(clasificarErrorDeCancelacion(new ProviderHttpError(400, null, 'Bad request'))).toBe('EN_DUDA')
  })
  it('control — «relacionados» / «related» como palabra siguen siendo la frase (con o sin código de rechazo de la lista)', () => {
    expect(clasificarErrorDeCancelacion(new ProviderHttpError(400, null, 'El comprobante tiene CFDI relacionados vigentes'))).toBe(
      'RECHAZO',
    )
    expect(clasificarErrorDeCancelacion(new ProviderHttpError(422, 'unknown', 'The invoice has related documents'))).toBe('RECHAZO')
    expect(traducirRechazoDeCancelacion(new ProviderHttpError(400, 'invoice_not_cancelable_by_sat', 'Tiene CFDI relacionados'))).toBe(FRASE)
    expect(traducirRechazoDeCancelacion(new ProviderHttpError(400, null, 'The invoice has related documents'))).toBe(FRASE)
  })
})

// ─── OF-1 · T2 R3: con el PAC colgado, una pasada del barrido de cancelaciones no dura ~50 min (50 + 50 consultas de 30 s) ─────────────
describe('OF-1 · T2 R3 · el barrido de cancelaciones tiene presupuesto por pasada', () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-09T12:00:00Z') }))
  afterEach(() => jest.useRealTimers())
  const nunca = () => new Promise<any>(() => {})
  const pendientes = ['a', 'b', 'c'].map((id, i) => ({ id, cancelRequestedAt: new Date(Date.UTC(2026, 9, 9, 8, i)) }))
  const cursorDeCierres = { updatedAt: new Date('2026-10-09T09:00:00Z'), id: 'r9' }
  const enCurso = <T>(p: Promise<T>) => {
    const estado: { listo: boolean; valor?: T } = { listo: false }
    void p.then(v => Object.assign(estado, { listo: true, valor: v }))
    return estado
  }

  it('🔴 una consulta que nunca contesta: la pasada termina al agotar el presupuesto; el cursor queda en la última INTENTADA y la fase de cierres conserva el suyo', async () => {
    const refresh = jest.fn(nunca)
    const findRecentlyClosed = jest.fn(async () => [])
    const r = enCurso(
      syncPendingCancellations(
        { sandbox: true, now: new Date(), cursor: null, cursorCerradas: cursorDeCierres },
        { findPending: jest.fn(async () => pendientes), refresh, findRecentlyClosed, recheckClosed: jest.fn() },
      ),
    )
    await jest.advanceTimersByTimeAsync(PRESUPUESTO_BARRIDO_CANCELACIONES_MS - 1)
    expect(r.listo).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    expect(r.listo).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(1) // ni b ni c: no quedaba presupuesto
    expect(r.valor).toMatchObject({
      revisadas: 1,
      errores: 1,
      cursor: { requestedAt: pendientes[0].cancelRequestedAt, id: 'a' },
      cursorCerradas: cursorDeCierres,
    })
    expect(findRecentlyClosed).not.toHaveBeenCalled()
  })

  it('🔴 la fase de cierres también: una re-consulta colgada corta la pasada y su cursor queda en la última intentada', async () => {
    const cerradas = ['r1', 'r2'].map((id, i) => ({ id, updatedAt: new Date(Date.UTC(2026, 9, 9, 9, i)) }))
    const recheckClosed = jest.fn(nunca)
    const r = enCurso(
      syncPendingCancellations(
        { sandbox: true, now: new Date(), cursor: null, cursorCerradas: null },
        {
          findPending: jest.fn(async () => []),
          refresh: jest.fn(),
          findRecentlyClosed: jest.fn(async () => cerradas),
          recheckClosed,
        },
      ),
    )
    await jest.advanceTimersByTimeAsync(PRESUPUESTO_BARRIDO_CANCELACIONES_MS)
    expect(r.listo).toBe(true)
    expect(recheckClosed).toHaveBeenCalledTimes(1)
    expect(r.valor).toMatchObject({ cierresRevisados: 1, errores: 1, cursorCerradas: { updatedAt: cerradas[0].updatedAt, id: 'r1' } })
  })
})

// C2 · OF-2 (T2 R1 y R4, `task-2-rereview-2.md`).
describe('C2 · OF-2 · T2 R1 — un rechazo/caducidad de un intento ANTERIOR no cierra la duda del actual', () => {
  beforeEach(() => jest.clearAllMocks())
  const ahora = new Date('2026-10-05T12:00:00Z')
  const hace = (ms: number) => new Date(ahora.getTime() - ms)
  const fila = (over: Record<string, any>) => ({
    ...stampedCfdi,
    cancelStatus: 'REQUESTED',
    cancelIntento: 2,
    cancelRequestedAt: hace(3 * 60_000),
    cancelEnviadaAt: hace(91_000),
    cancelAcusadaAt: null,
    ...over,
  })
  const consulta = (status: string) => ({
    loadEmisor: jest.fn(),
    resolveProvider: jest.fn().mockReturnValue({
      getCancellationStatus: jest.fn().mockResolvedValue({ status, cancelledAt: null }),
      cancelInvoice: jest.fn(),
    }),
    applyCancelOutcome: jest.fn(async (_id: string, data: any) => ({ ...stampedCfdi, ...data })),
    logAction: jest.fn(),
    now: () => ahora,
  })

  it('🔴 intento 2 EN DUDA a los 91 s y el PAC dice «rechazada»/«caducada» (el estado es de la FACTURA: puede ser el del intento 1) ⇒ no se cierra', async () => {
    for (const s of ['rejected', 'expired']) {
      const d = consulta(s)
      await refreshPendingCancellation(fila({}), { sandbox: true }, d as any)
      expect([s, d.applyCancelOutcome.mock.calls.length]).toEqual([s, 0])
      expect(d.logAction).not.toHaveBeenCalled()
    }
  })
  it('control — pasadas las 24 h sigue «rechazada» ⇒ se cierra con el porqué del PAC (no con «no registró la solicitud»), CAS de la foto y bitácora', async () => {
    const d = consulta('rejected')
    const token = hace(PLAZO_DE_LA_DUDA_MS + 1_000)
    await refreshPendingCancellation(fila({ cancelEnviadaAt: token }), { sandbox: true }, d as any)
    expect(d.applyCancelOutcome).toHaveBeenCalledTimes(1)
    expect(d.applyCancelOutcome.mock.calls[0][1]).toEqual({
      cancelStatus: 'REJECTED',
      lastError: 'El receptor rechazó la cancelación ante el SAT: la factura sigue vigente.',
    })
    expect((d.applyCancelOutcome.mock.calls[0] as any[])[4]).toEqual({ cancelIntento: 2, cancelEnviadaAt: token, cancelAcusadaAt: null })
    expect(d.logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CFDI_CANCEL_NOT_APPLIED' }))
  })
  it('control — un intento ACUSADO (en trámite) del intento 2 con «rechazada» sí se cierra al momento (ya hay solicitud registrada de éste)', async () => {
    const d = consulta('rejected')
    await refreshPendingCancellation(fila({ cancelAcusadaAt: hace(60_000) }), { sandbox: true }, d as any)
    expect(d.applyCancelOutcome).toHaveBeenCalledTimes(1)
  })
})

describe('C2 · OF-2 · T2 R4 — cuando la petición del dueño termina en un desenlace al instante, la bitácora lo dice', () => {
  beforeEach(() => jest.clearAllMocks())
  const prov = (consultas: Array<{ status: string } | Error>, post?: jest.Mock) => {
    const getCancellationStatus = jest.fn()
    for (const c of consultas) {
      if (c instanceof Error) getCancellationStatus.mockRejectedValueOnce(c)
      else getCancellationStatus.mockResolvedValueOnce({ status: c.status, cancelledAt: null })
    }
    return jest.fn().mockReturnValue({
      name: 'facturapi',
      getCancellationStatus,
      cancelInvoice: post ?? jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null }),
    } as any)
  }
  const acciones = (deps: any) =>
    (deps.logAction as jest.Mock).mock.calls.map(c => [c[0].action, c[0].data.origen, c[0].data.cancelIntento])

  it('🔴 el POST contesta «cancelada» ⇒ CFDI_CANCEL_CONFIRMED (origen DUENO, su intento)', async () => {
    const deps = cancelDeps({
      resolveProvider: prov([{ status: 'none' }], jest.fn().mockResolvedValue({ status: 'canceled', cancelledAt: new Date() })),
      logAction: jest.fn(),
    })
    const r = await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(r.estado).toBe('CANCELADA')
    expect(acciones(deps)).toEqual([['CFDI_CANCEL_CONFIRMED', 'DUENO', 1]])
  })
  it('🔴 la consulta PREVIA ya la ve cancelada (sin POST) ⇒ CFDI_CANCEL_CONFIRMED', async () => {
    const post = jest.fn()
    const deps = cancelDeps({ resolveProvider: prov([{ status: 'canceled' }], post), logAction: jest.fn() })
    await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(post).not.toHaveBeenCalled()
    expect(acciones(deps)).toEqual([['CFDI_CANCEL_CONFIRMED', 'DUENO', 1]])
  })
  it('🔴 un rechazo concluyente del POST ⇒ CFDI_CANCEL_NOT_APPLIED; «no salió» (401) también', async () => {
    const rechazo = new ProviderHttpError(400, 'invoice_not_cancelable', 'La factura no se puede cancelar')
    const d1 = cancelDeps({
      resolveProvider: prov([{ status: 'none' }, { status: 'none' }], jest.fn().mockRejectedValue(rechazo)),
      logAction: jest.fn(),
    })
    await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, d1)
    expect(acciones(d1)).toEqual([['CFDI_CANCEL_NOT_APPLIED', 'DUENO', 1]])
    const d2 = cancelDeps({
      resolveProvider: prov([{ status: 'none' }], jest.fn().mockRejectedValue(new ProviderHttpError(401, null, 'unauthorized'))),
      logAction: jest.fn(),
    })
    await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, d2)
    expect(acciones(d2)).toEqual([['CFDI_CANCEL_NOT_APPLIED', 'DUENO', 1]])
  })
  it('🔴 la consulta previa falla ⇒ se cierra «no se llegó a enviar» con CFDI_CANCEL_NOT_APPLIED (y el 502 de siempre)', async () => {
    const deps = cancelDeps({ resolveProvider: prov([new Error('ECONNRESET')]), logAction: jest.fn() })
    await expect(cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)).rejects.toBeInstanceOf(ProviderUnavailableError)
    expect(acciones(deps)).toEqual([['CFDI_CANCEL_NOT_APPLIED', 'DUENO', 1]])
  })
  it('control — el acuse («pending») no es un desenlace: sin bitácora', async () => {
    const deps = cancelDeps({ resolveProvider: prov([{ status: 'none' }]), logAction: jest.fn() })
    await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(deps.logAction).not.toHaveBeenCalled()
  })
  it('control — audita sólo el ganador: si la escritura del dueño pierde (CAS), no escribe bitácora por esa vía', async () => {
    const deps = cancelDeps({
      resolveProvider: prov([{ status: 'canceled' }]),
      updateCfdi: jest.fn().mockResolvedValue(null),
      logAction: jest.fn(),
    })
    await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true }, deps)
    expect(deps.logAction).not.toHaveBeenCalled()
  })
})
