/**
 * POST /mobile/venues/:venueId/payments/:paymentId/refund — devolver con «Efectivo de la caja» pide
 * `payments:refund-to-cash` EN LUGAR de `payments:refund` (founder, 1-oct-2026; la dependencia refund-to-cash → refund
 * deja la autorización equivalente).
 *
 * 🔴 UNA sola revisión por petición: el código del encargado (`x-permission-override`) es de un solo uso y de UN permiso.
 * Con dos revisiones encadenadas, un mesero que escogía efectivo gastaba el código en `payments:refund` y la segunda
 * lo rechazaba — callejón sin salida y una bitácora `PERMISSION_OVERRIDE_USED` falsa.
 *
 * Corre el `checkPermission` REAL con los permisos de fábrica (sólo la base va simulada).
 */
const mockStaffVenueFindUnique = jest.fn()
const mockConsumeOverride = jest.fn()
/** Máquina de efectivo (Codex r1 #14): el cobro que se devuelve; con folio, es una venta de la QuickPay. */
const mockPaymentFindFirst = jest.fn()
/** Codex r2 #2: el vínculo del crédito de un Cambio con su raíz. */
const mockLinkFindFirst = jest.fn()
const mockPaymentFindUnique = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: async () => ({ active: true }) },
    staffVenue: { findFirst: async () => null, findUnique: (...a: unknown[]) => mockStaffVenueFindUnique(...a) },
    venue: { findUnique: async () => null },
    // Con una fila menor que OWNER, el resolutor pregunta en UNA consulta si es dueña de la org del venue (P2-6).
    staffOrganization: { findUnique: async () => null, findFirst: async () => null },
    venueRolePermission: { findUnique: async () => null },
    payment: {
      findFirst: (...a: unknown[]) => mockPaymentFindFirst(...a),
      // r3 #4: la devolución que ya se guardó con esa llave (la lee el núcleo antes de nada).
      findUnique: (...a: unknown[]) => mockPaymentFindUnique(...a),
    },
    exchangeCreditLink: { findFirst: (...a: unknown[]) => mockLinkFindFirst(...a) },
  },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({
  ...jest.requireActual('@/services/dashboard/activity-log.service'),
  logAction: jest.fn(),
}))
jest.mock('@/services/mobile/permission-override.mobile.service', () => ({
  ...jest.requireActual('@/services/mobile/permission-override.mobile.service'),
  consumePermissionOverride: (...a: unknown[]) => mockConsumeOverride(...a),
  isManagerPinOverrideEnabled: async () => true,
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { StaffRole } from '@prisma/client'
import mobileRouter, { permisoDeReembolso } from '@/routes/mobile.routes'
import dashboardRouter from '@/routes/dashboard.routes'
import tpvRouter from '@/routes/tpv.routes'
import { permisoConcedidoDe } from '@/middlewares/permisoDeReembolso.middleware'
import { issueAssociatedRefund } from '@/controllers/mobile/refund.mobile.controller'
import { operationHash } from '@/utils/operationHash'
import type { EntradaDelReembolso, OrigenDelDinero } from '@/services/shared/destinoDelReembolso'
import { MATRIZ_DEL_REEMBOLSO, MENSAJE_MISMO_MEDIO, MENSAJE_TPV_CREDITO, medioDelCuerpo } from '../../__helpers__/matrizDelReembolso'

async function correr(role: StaffRole, body: unknown, headers: Record<string, string> = {}, permiso: any = permisoDeReembolso) {
  mockStaffVenueFindUnique.mockResolvedValue({ role, active: true, permissionSetId: null, permissionSet: null })
  const req: any = {
    method: 'POST',
    originalUrl: '/api/v1/mobile/venues/v1/payments/p1/refund',
    params: { venueId: 'v1', paymentId: 'p1' },
    headers,
    body,
    authContext: { userId: 'u1', venueId: 'v1', role },
  }
  const out: { status?: number; json?: any; next: boolean; error?: any } = { next: false }
  const res: any = {
    status: (s: number) => ((out.status = s), res),
    json: (j: unknown) => ((out.json = j), res),
  }
  // D5: un rechazo de la entrada llega como `next(error)` (el manejador de errores lo vuelve 400), no como paso al controlador.
  await permiso(req, res, (error?: unknown) => {
    if (error) out.error = error
    else out.next = true
  })
  return out
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPaymentFindFirst.mockResolvedValue({ cashMachineRef: null })
  mockLinkFindFirst.mockResolvedValue(null)
})

describe('el reembolso móvil revisa UN permiso según «Devolver con»', () => {
  it('🔴 CASHIER con refundMethod CASH ⇒ 403 con el permiso nuevo (overridable por el código del encargado)', async () => {
    const out = await correr(StaffRole.CASHIER, { amount: 5000, refundMethod: 'CASH' })
    expect(out.next).toBe(false)
    expect(out.status).toBe(403)
    expect(out.json).toMatchObject({ required: 'payments:refund-to-cash', overridable: true })
  })

  it('🔴 WAITER (sin payments:refund) + CASH + código del encargado para refund-to-cash ⇒ pasa con UN solo consumo', async () => {
    mockConsumeOverride.mockResolvedValue({ authorizedById: 'sv-gerente' })
    const out = await correr(StaffRole.WAITER, { refundMethod: 'CASH' }, { 'x-permission-override': 'tok' })
    expect(out.next).toBe(true)
    expect(mockConsumeOverride).toHaveBeenCalledTimes(1)
    expect(mockConsumeOverride).toHaveBeenCalledWith(expect.objectContaining({ permission: 'payments:refund-to-cash', venueId: 'v1' }))
  })

  it('CASHIER con transferencia ⇒ pasa por payments:refund', async () => {
    expect(await correr(StaffRole.CASHIER, { amount: 5000, refundMethod: 'BANK_TRANSFER' })).toEqual({ next: true })
  })

  it('sin efectivo la revisión es payments:refund: el WAITER recibe ESE 403', async () => {
    const out = await correr(StaffRole.WAITER, { refundMethod: 'BANK_TRANSFER' })
    expect(out.status).toBe(403)
    expect(out.json).toMatchObject({ required: 'payments:refund' })
  })

  it('CASHIER sin refundMethod («por el mismo medio») ⇒ pasa', async () => {
    expect(await correr(StaffRole.CASHIER, { amount: 5000 })).toEqual({ next: true })
    expect(await correr(StaffRole.CASHIER, undefined)).toEqual({ next: true })
  })

  it('MANAGER con refundMethod CASH ⇒ pasa', async () => {
    expect(await correr(StaffRole.MANAGER, { amount: 5000, refundMethod: 'CASH' })).toEqual({ next: true })
  })

  it('🔴 saldo a favor (STORE_CREDIT) pide payments:refund, no payments:refund-to-cash: el CASHIER pasa y el WAITER recibe ESE 403', async () => {
    expect(await correr(StaffRole.CASHIER, { amount: 5000, refundMethod: 'STORE_CREDIT', customerId: 'c1' })).toEqual({ next: true })
    const out = await correr(StaffRole.WAITER, { amount: 5000, refundMethod: 'STORE_CREDIT', customerId: 'c1' })
    expect(out.status).toBe(403)
    expect(out.json).toMatchObject({ required: 'payments:refund' })
  })

  it('la ruta tiene UNA sola revisión de permiso, justo antes del controlador', () => {
    const capa = (mobileRouter as any).stack.find(
      (l: any) => l.route?.path === '/venues/:venueId/payments/:paymentId/refund' && l.route.methods.post,
    )
    const handlers = capa.route.stack.map((rl: any) => rl.handle)
    const conPermiso = handlers.filter((h: any) => typeof h.requiredPermission === 'string')
    expect(conPermiso).toEqual([permisoDeReembolso])
    expect((permisoDeReembolso as any).requiredPermission).toBe('payments:refund')
    expect(handlers.indexOf(permisoDeReembolso)).toBe(handlers.length - 2)
  })
})

describe('Codex r1 #14 (decisión c): devolver en efectivo una venta de la máquina pide payments:refund-to-cash', () => {
  const permisoDe = (router: any, ruta: string) => {
    const capa = router.stack.find((l: any) => l.route?.path === ruta && l.route.methods.post)
    return capa.route.stack.map((rl: any) => rl.handle).find((h: any) => typeof h.requiredPermission === 'string')
  }
  const PANEL = () => permisoDe(dashboardRouter, '/venues/:venueId/payments/:paymentId/refund')
  const TERMINAL = () => permisoDe(tpvRouter, '/venues/:venueId/refunds')

  beforeEach(() => mockPaymentFindFirst.mockResolvedValue({ cashMachineRef: 'AQ0123456789AB' }))

  it.each([
    ['sin refundMethod («por el mismo medio»)', { amount: 5000 }],
    ['con refundMethod CASH', { amount: 5000, refundMethod: 'CASH' }],
  ])('🔴 POS · CASHIER %s ⇒ 403 refund-to-cash (overridable)', async (_n, body) => {
    const out = await correr(StaffRole.CASHIER, body)
    expect(out.status).toBe(403)
    expect(out.json).toMatchObject({ required: 'payments:refund-to-cash', overridable: true })
  })

  it('el cobro se busca en ESTA sucursal', async () => {
    await correr(StaffRole.CASHIER, { amount: 5000 })
    expect(mockPaymentFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p1', venueId: 'v1' } }))
  })

  it('POS · por transferencia o a saldo a favor no sale de la gaveta: payments:refund (el CASHIER pasa)', async () => {
    expect(await correr(StaffRole.CASHIER, { refundMethod: 'BANK_TRANSFER' })).toEqual({ next: true })
    expect(await correr(StaffRole.CASHIER, { refundMethod: 'STORE_CREDIT', customerId: 'c1' })).toEqual({ next: true })
  })

  it('POS · MANAGER (tiene refund-to-cash) pasa con las dos formas', async () => {
    expect(await correr(StaffRole.MANAGER, { amount: 5000 })).toEqual({ next: true })
    expect(await correr(StaffRole.MANAGER, { amount: 5000, refundMethod: 'CASH' })).toEqual({ next: true })
  })

  it('🔴 POS · si no se puede leer el cobro: 503 reintentable, nunca un 403 por adivinar el origen ni acceso concedido', async () => {
    // Revisión de apps viejas (22-nov): suponer «máquina» le daba a una cajera con payments:refund un 403 falso de refund-to-cash.
    mockPaymentFindFirst.mockRejectedValue(new Error('db caída'))
    const out = await correr(StaffRole.CASHIER, { amount: 5000 })
    expect(out.next).toBe(false)
    expect(out.status).toBeUndefined()
    expect(out.error).toMatchObject({ statusCode: 503, code: 'REFUND_ORIGIN_UNAVAILABLE' })
    expect(mockConsumeOverride).not.toHaveBeenCalled()
  })

  it.each([
    ['sin refundMethod', { amount: 50 }],
    ['con refundMethod CASH', { amount: 50, refundMethod: 'CASH' }],
  ])('🔴 PANEL · CASHIER %s sobre una venta de la máquina ⇒ 403 refund-to-cash', async (_n, body) => {
    const out = await correr(StaffRole.CASHIER, body, {}, PANEL())
    expect(out.json).toMatchObject({ required: 'payments:refund-to-cash' })
  })

  it('PANEL · una venta que NO es de la máquina sigue como siempre (payments:refund)', async () => {
    mockPaymentFindFirst.mockResolvedValue({ cashMachineRef: null })
    expect(await correr(StaffRole.CASHIER, { amount: 50 }, {}, PANEL())).toEqual({ next: true })
  })

  it('🔴 TERMINAL · el cobro viene en el cuerpo (originalPaymentId): una venta de la máquina pide refund-to-cash', async () => {
    const out = await correr(StaffRole.CASHIER, { originalPaymentId: 'p1', amount: 50 }, {}, TERMINAL())
    expect(out.json).toMatchObject({ required: 'payments:refund-to-cash' })
    mockPaymentFindFirst.mockResolvedValue({ cashMachineRef: null })
    expect(await correr(StaffRole.CASHIER, { originalPaymentId: 'p1', amount: 50 }, {}, TERMINAL())).toEqual({ next: true })
  })
})

describe('Codex servidor r2 (familia B): la autorización usa LA decisión de destino del escritor', () => {
  const permisoDe = (router: any, ruta: string) => {
    const capa = router.stack.find((l: any) => l.route?.path === ruta && l.route.methods.post)
    return capa.route.stack.map((rl: any) => rl.handle).find((h: any) => typeof h.requiredPermission === 'string')
  }
  const PANEL = () => permisoDe(dashboardRouter, '/venues/:venueId/payments/:paymentId/refund')
  const TERMINAL = () => permisoDe(tpvRouter, '/venues/:venueId/refunds')
  const MAQUINA = 'AQ0123456789AB'
  /** El crédito de un Cambio (`p1`) cuya raíz (`raiz`) cobró la QuickPay. */
  const creditoDeLaMaquina = () => {
    mockPaymentFindFirst.mockImplementation(async (a: any) =>
      a.where.id === 'p1' ? { cashMachineRef: null, tenderType: { systemKind: 'EXCHANGE_CREDIT' } } : { cashMachineRef: MAQUINA },
    )
    mockLinkFindFirst.mockResolvedValue({ originPaymentId: 'raiz' })
  }

  it.each([
    ['POS', () => permisoDeReembolso],
    ['PANEL', PANEL],
  ])(
    '🔴 r2 #2 · %s: devolver el reemplazo de un Cambio de una venta de la máquina saca de la gaveta ⇒ refund-to-cash',
    async (_n, ruta) => {
      creditoDeLaMaquina()
      const out = await correr(StaffRole.CASHIER, { amount: 5000 }, {}, ruta())
      expect(out.status).toBe(403)
      expect(out.json).toMatchObject({ required: 'payments:refund-to-cash' })
      expect(mockLinkFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: 'v1', creditPaymentId: 'p1' } }))
    },
  )

  it('r2 #2 · el crédito de un Cambio de una venta ordinaria sigue con payments:refund', async () => {
    mockPaymentFindFirst.mockImplementation(async (a: any) =>
      a.where.id === 'p1' ? { cashMachineRef: null, tenderType: { systemKind: 'EXCHANGE_CREDIT' } } : { cashMachineRef: null },
    )
    mockLinkFindFirst.mockResolvedValue({ originPaymentId: 'raiz' })
    expect(await correr(StaffRole.CASHIER, { amount: 5000 })).toEqual({ next: true })
  })

  it.each([
    ['PANEL', PANEL, { amount: 50, refundMethod: 'BANK_TRANSFER' }],
    ['PANEL', PANEL, { amount: 50, refundMethod: 'STORE_CREDIT' }],
    ['TERMINAL', TERMINAL, { originalPaymentId: 'p1', amount: 50, refundMethod: 'BANK_TRANSFER' }],
  ])('🔴 r2 #3 · %s descarta el medio del cuerpo (%j): autoriza lo que de verdad hace el escritor, la gaveta', async (_n, ruta, body) => {
    mockPaymentFindFirst.mockResolvedValue({ cashMachineRef: MAQUINA })
    const out = await correr(StaffRole.CASHIER, body, {}, ruta())
    expect(out.json).toMatchObject({ required: 'payments:refund-to-cash' })
  })

  it('🔴 la decisión que autorizó queda en la petición para que el escritor la confirme (permisoConcedidoDe)', async () => {
    mockPaymentFindFirst.mockResolvedValue({ cashMachineRef: MAQUINA })
    const req: any = {
      params: { venueId: 'v1', paymentId: 'p1' },
      headers: {},
      body: { amount: 50 },
      originalUrl: '/x',
      method: 'POST',
      authContext: { userId: 'u1', venueId: 'v1', role: StaffRole.MANAGER },
    }
    mockStaffVenueFindUnique.mockResolvedValue({ role: StaffRole.MANAGER, active: true, permissionSetId: null, permissionSet: null })
    let siguio = false
    await PANEL()(req, { status: () => ({ json: () => undefined }) }, () => (siguio = true))
    expect(siguio).toBe(true)
    expect(permisoConcedidoDe(req)).toBe('payments:refund-to-cash')
    expect(req.destinoDelReembolso).toEqual({ admitido: true, destinoEfectivo: 'GAVETA', permisoRequerido: 'payments:refund-to-cash' })
  })
})

describe('🔴 D5 (r3 #12, r6 caso 7): la ruta dice lo que dice la matriz, y lo no admitido se contesta ANTES del permiso especial', () => {
  const permisoDe = (router: any, ruta: string) => {
    const capa = router.stack.find((l: any) => l.route?.path === ruta && l.route.methods.post)
    return capa.route.stack.map((rl: any) => rl.handle).find((h: any) => typeof h.requiredPermission === 'string')
  }
  const RUTAS: Record<Exclude<EntradaDelReembolso, 'MCP'>, () => any> = {
    POS: () => permisoDeReembolso,
    PANEL: () => permisoDe(dashboardRouter, '/venues/:venueId/payments/:paymentId/refund'),
    TPV: () => permisoDe(tpvRouter, '/venues/:venueId/refunds'),
  }
  const MAQUINA = 'AQ0123456789AB'
  /** El cobro `p1` tal como lo leen la autorización y el escritor, para cada origen que la lectura sí produce. */
  const cobro = (origen: OrigenDelDinero, esCreditoDeCambio: boolean) => {
    if (!esCreditoDeCambio) {
      mockPaymentFindFirst.mockResolvedValue({ cashMachineRef: origen === 'MAQUINA' ? MAQUINA : null })
      return
    }
    mockPaymentFindFirst.mockImplementation(async (a: any) =>
      a.where.id === 'p1'
        ? { cashMachineRef: null, tenderType: { systemKind: 'EXCHANGE_CREDIT' } }
        : { cashMachineRef: origen === 'CADENA_DE_MAQUINA' ? MAQUINA : null },
    )
    mockLinkFindFirst.mockResolvedValue({ originPaymentId: 'raiz' })
  }
  /** Una petición por la ruta: el cobro va en la ruta (POS, panel) o en el cuerpo (TPV); se ponen los dos. */
  const pasar = async (entrada: Exclude<EntradaDelReembolso, 'MCP'>, role: StaffRole, refundMethod: unknown, headers = {}) => {
    mockStaffVenueFindUnique.mockResolvedValue({ role, active: true, permissionSetId: null, permissionSet: null })
    const req: any = {
      method: 'POST',
      originalUrl: '/api/v1/x',
      params: { venueId: 'v1', paymentId: 'p1' },
      headers,
      body: { originalPaymentId: 'p1', amount: 5000, ...(refundMethod === undefined ? {} : { refundMethod }) },
      authContext: { userId: 'u1', venueId: 'v1', role },
    }
    const out: { status?: number; json?: any; next?: true; error?: any; req: any } = { req }
    const res: any = {
      status: (s: number) => ((out.status = s), res),
      json: (j: unknown) => ((out.json = j), res),
    }
    await RUTAS[entrada]()(req, res, (error?: unknown) => (error ? (out.error = error) : (out.next = true)))
    return out
  }

  /** Las celdas de las entradas con ruta, en los cuatro orígenes que la lectura produce (la cadena siempre es crédito de Cambio). */
  const CELDAS = MATRIZ_DEL_REEMBOLSO.filter(([o, c, e]) => e !== 'MCP' && (o === 'MAQUINA' ? !c : o === 'CADENA_DE_MAQUINA' ? c : true))

  it.each(CELDAS)(
    '%s · crédito de Cambio %s · %s · medio %s ⇒ la cajera (sólo payments:refund) recibe lo de la matriz',
    async (origen, credito, entrada, medio, esperado) => {
      cobro(origen, credito)
      const out = await pasar(entrada as Exclude<EntradaDelReembolso, 'MCP'>, StaffRole.CASHIER, medioDelCuerpo(medio))
      if (!esperado.admitido) {
        // 400 con a dónde ir; nunca un 403 primero (el PIN del encargado no serviría de nada).
        expect(out.status).toBeUndefined()
        expect(out.next).toBeUndefined()
        expect(out.error).toMatchObject({
          statusCode: 400,
          code: esperado.codigo,
          message: esperado.mensaje,
          details: { dondeIr: esperado.dondeIr },
        })
      } else if (esperado.permisoRequerido === 'payments:refund-to-cash') {
        expect(out.status).toBe(403)
        expect(out.json).toMatchObject({ required: 'payments:refund-to-cash' })
      } else {
        expect(out.next).toBe(true)
        expect(out.req.destinoDelReembolso).toEqual(esperado)
      }
    },
  )

  it('🔴 r3 #12 · TERMINAL: devolver el reemplazo de un Cambio de una venta de la máquina ⇒ 400 «desde el POS o el panel», sin 403', async () => {
    cobro('CADENA_DE_MAQUINA', true)
    const out = await pasar('TPV', StaffRole.CASHIER, undefined)
    expect(out.status).toBeUndefined()
    expect(out.error).toMatchObject({
      statusCode: 400,
      code: 'NO_ADMITIDO_EN_ESTA_ENTRADA',
      message: MENSAJE_TPV_CREDITO,
      details: { dondeIr: ['POS', 'PANEL'] },
    })
    expect(mockConsumeOverride).not.toHaveBeenCalled()
  })

  it.each([
    ['CADENA_DE_MAQUINA', 'CASH'],
    ['CADENA_DE_MAQUINA', 'BANK_TRANSFER'],
    ['ORDINARIO', 'CASH'],
    ['ORDINARIO', 'BANK_TRANSFER'],
  ] as const)('🔴 r3 #12 · POS: crédito de Cambio (raíz %s) con refundMethod %s ⇒ 400 sin pedir refund-to-cash', async (origen, medio) => {
    cobro(origen, true)
    const out = await pasar('POS', StaffRole.CASHIER, medio)
    expect(out.status).toBeUndefined()
    expect(out.error).toMatchObject({
      statusCode: 400,
      code: 'NO_ADMITIDO_EN_ESTA_ENTRADA',
      message: MENSAJE_MISMO_MEDIO,
      details: { dondeIr: ['MISMO_MEDIO', 'SALDO_A_FAVOR'] },
    })
    expect(mockConsumeOverride).not.toHaveBeenCalled()
  })

  it('la autorización básica sigue: sin payments:refund (WAITER) es el 403 de siempre por payments:refund, también en la TPV', async () => {
    cobro('CADENA_DE_MAQUINA', true)
    for (const [entrada, medio] of [
      ['TPV', undefined],
      ['POS', 'CASH'],
    ] as const) {
      const out = await pasar(entrada, StaffRole.WAITER, medio)
      expect(out.status).toBe(403)
      expect(out.json).toMatchObject({ required: 'payments:refund' })
      expect(out.error).toBeUndefined()
    }
  })

  it('🔴 con el código del encargado se gasta UNA vez y en payments:refund (nunca en refund-to-cash); luego el 400', async () => {
    cobro('CADENA_DE_MAQUINA', true)
    mockConsumeOverride.mockResolvedValue({ authorizedById: 'sv-gerente' })
    const out = await pasar('POS', StaffRole.WAITER, 'CASH', { 'x-permission-override': 'tok' })
    expect(mockConsumeOverride).toHaveBeenCalledTimes(1)
    expect(mockConsumeOverride).toHaveBeenCalledWith(expect.objectContaining({ permission: 'payments:refund' }))
    expect(out.error).toMatchObject({ statusCode: 400, code: 'NO_ADMITIDO_EN_ESTA_ENTRADA' })
  })
})

describe('🔴 F10 (Codex servidor r4): lo pagado con saldo no pide refund-to-cash para un medio que el escritor no admite', () => {
  it.each(['GIFT_CARD', 'STORE_CREDIT'])(
    'una cajera con payments:refund pide «Efectivo» sobre un cobro con saldo (%s) ⇒ 400 NO_ADMITIDO con a dónde ir, nunca el 403 del gerente',
    async kind => {
      mockPaymentFindFirst.mockResolvedValue({ cashMachineRef: null, tenderType: { systemKind: kind } })
      const out = await correr(StaffRole.CASHIER, { amount: 5000, refundMethod: 'CASH' })
      expect(out.status).toBeUndefined()
      expect(out.error).toMatchObject({ statusCode: 400, code: 'NO_ADMITIDO_EN_ESTA_ENTRADA', details: { dondeIr: ['MISMO_MEDIO'] } })
      expect(mockConsumeOverride).not.toHaveBeenCalled()
    },
  )

  it('sin medio (al mismo saldo) pasa con payments:refund', async () => {
    mockPaymentFindFirst.mockResolvedValue({ cashMachineRef: null, tenderType: { systemKind: 'GIFT_CARD' } })
    expect(await correr(StaffRole.CASHIER, { amount: 5000 })).toEqual({ next: true })
  })

  it.each([
    ['GIFT_CARD', 'Lo pagado con tarjeta de regalo regresa a su misma tarjeta.'],
    ['STORE_CREDIT', 'Esto ya es un saldo a favor.'],
  ])(
    '🔴 saldo a favor sobre lo pagado con saldo (%s) ⇒ 422 STORE_CREDIT_NOT_ALLOWED de siempre (las apps viejas lo reconocen), con a dónde ir',
    async (kind, mensaje) => {
      mockPaymentFindFirst.mockResolvedValue({ cashMachineRef: null, tenderType: { systemKind: kind } })
      const out = await correr(StaffRole.CASHIER, { amount: 5000, refundMethod: 'STORE_CREDIT', customerId: 'c1' })
      expect(out.status).toBeUndefined()
      expect(out.error).toMatchObject({
        statusCode: 422,
        code: 'STORE_CREDIT_NOT_ALLOWED',
        message: mensaje,
        details: { dondeIr: ['MISMO_MEDIO'] },
      })
      expect(mockConsumeOverride).not.toHaveBeenCalled()
    },
  )
})

describe('🔴 r3 #4: un reembolso guardado ANTES de esta rama recupera su acuse con la misma llave', () => {
  it('reembolso ordinario (sin máquina), respuesta perdida, reintento por la ruta del POS ⇒ el acuse original, no 409', async () => {
    mockPaymentFindFirst.mockResolvedValue({ cashMachineRef: null })
    mockStaffVenueFindUnique.mockResolvedValue({ role: StaffRole.CASHIER, active: true, permissionSetId: null, permissionSet: null })
    // La huella que guardó el servidor de antes: lo que su controlador le pasaba al núcleo, sin `permisoConcedido`.
    const huellaDeAntes = operationHash({
      venueId: 'v1',
      paymentId: 'p1',
      amount: 5000,
      reason: 'RETURNED_GOODS',
      staffId: 'u1',
      note: null,
    })
    mockPaymentFindUnique.mockResolvedValue({
      id: 'reembolso-de-antes',
      type: 'REFUND',
      amount: -50,
      tipAmount: 0,
      processorData: { originalPaymentId: 'p1', idempotencyRequestHash: huellaDeAntes, remainingAfterCents: 10000 },
    })
    const req: any = {
      method: 'POST',
      originalUrl: '/api/v1/mobile/venues/v1/payments/p1/refund',
      params: { venueId: 'v1', paymentId: 'p1' },
      headers: {},
      body: { amount: 5000, reason: 'RETURNED_GOODS', idempotencyKey: 'llave-de-antes-0001' },
      authContext: { userId: 'u1', venueId: 'v1', role: StaffRole.CASHIER },
    }
    const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) }
    const errores: unknown[] = []
    await permisoDeReembolso(req, res, (e?: unknown) => (e ? errores.push(e) : undefined))
    // La ruta de hoy sí le pasa al núcleo el permiso que concedió.
    expect(permisoConcedidoDe(req)).toBe('payments:refund')

    await issueAssociatedRefund(req, res, (e: unknown) => errores.push(e))

    expect(errores).toEqual([])
    expect(res.status).toHaveBeenLastCalledWith(201)
    expect(res.json).toHaveBeenLastCalledWith({
      success: true,
      data: expect.objectContaining({ refundId: 'reembolso-de-antes', amount: 50, remainingRefundable: 100, status: 'COMPLETED' }),
    })
  })
})
