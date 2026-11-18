/**
 * 🔴 hz:nube0000:na7ab987 — un ingreso o retiro que la cajera A hizo SIN RED se quedaba en la cola; si la sesión de A se cerraba
 * sola y entraba B, la pasada de B lo subía y el servidor lo firmaba A NOMBRE DE B (`staffId` de la sesión). Contrato: el cuerpo
 * trae `staffId` (quien lo hizo) y el servidor lo acepta sólo si lo puede comprobar: con la llave de la cola, A activa en el
 * negocio y con una sesión en ESE MISMO aparato viva durante esa caja. Si no, como hoy (a nombre de quien sube) y la bitácora
 * dice a quién declaró el aparato y por qué no se aceptó. Nunca se rechaza: el dinero ya entró o salió del cajón.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
import { payIn, payOut } from '@/services/mobile/cash-drawer.mobile.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const ANA = 'staff-ana'
const BETO = 'staff-beto'
const ABIERTA = new Date('2026-11-17T15:00:00Z')
const CERRADA = new Date('2026-11-17T23:00:00Z')

let createMany: jest.Mock
let sesionDeAna: jest.Mock

function montar({ caja = { id: 'caja-1', status: 'OPEN', openedAt: ABIERTA, closedAt: null as Date | null } } = {}) {
  ;(prismaMock as any).$transaction = jest.fn((fn: any) => fn(prismaMock))
  ;(prismaMock as any).staff = {
    findUnique: jest.fn(async ({ where }: any) =>
      where.id === ANA ? { firstName: 'Ana', lastName: 'M' } : { firstName: 'Beto', lastName: 'R' },
    ),
  }
  ;(prismaMock as any).cashDrawerSession = {
    findFirst: jest.fn().mockResolvedValue(caja),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
  }
  createMany = jest.fn().mockResolvedValue({ count: 1 })
  ;(prismaMock as any).cashDrawerEvent = {
    createMany,
    create: jest.fn(async ({ data }: any) => ({ id: 'e-sin-llave', ...data, createdAt: new Date() })),
    findFirst: jest.fn(async () => ({
      id: 'e-1',
      sessionId: caja.id,
      venueId: VENUE,
      type: 'PAY_IN',
      amount: 100,
      staffId: createMany.mock.calls[0]?.[0].data[0].staffId,
      staffName: createMany.mock.calls[0]?.[0].data[0].staffName,
      note: null,
      createdAt: new Date(),
      localId: 'loc-1',
      orderId: null,
    })),
  }
  // La sesión que sube (Beto) vive en la tablet T-1. Ana tuvo una sesión en T-1 durante la caja.
  sesionDeAna = jest.fn().mockResolvedValue({ id: 'ses-ana' })
  ;(prismaMock as any).session = {
    findUnique: jest.fn().mockResolvedValue({ deviceId: 'T-1' }),
    findFirst: sesionDeAna,
  }
  ;(prismaMock as any).staffVenue = { findFirst: jest.fn().mockResolvedValue({ id: 'sv-ana' }), findUnique: jest.fn() }
}

const subir = (extra: Record<string, unknown> = {}) =>
  payIn({ venueId: VENUE, staffId: BETO, staffName: 'Beto R', amount: 100, localId: 'loc-1', sid: 'ses-beto', ...extra } as any)

const filaGuardada = () => createMany.mock.calls[0][0].data[0]
const bitacora = () => (logAction as jest.Mock).mock.calls.find(([a]) => a.action === 'CASH_DRAWER_PAY_IN')?.[0]
/** La bitácora escrita DENTRO de la transacción (`writeLegacyActivityAuditTx` → `activityLog.create`). */
const bitacoraEnLaTx = (action: string) =>
  ((prismaMock as any).activityLog.create as jest.Mock).mock.calls.map(([a]) => a.data).find(d => d.action === action)
const CINCO_MIN = 5 * 60 * 1000

beforeEach(() => {
  jest.clearAllMocks()
  montar()
})

it('🔴 el ingreso sin red de Ana que sube Beto queda a nombre de Ana, con su nombre, y la bitácora dice que lo subió Beto', async () => {
  const r = await subir({ autorDelAparato: ANA })
  expect(r.created).toBe(true)
  expect(filaGuardada()).toMatchObject({ staffId: ANA, staffName: 'Ana M' })
  // Codex r2 #1 y #4: con autor ajeno la bitácora va DENTRO de la transacción (una caída no pierde quién lo subió) y su actor es
  // quien sube (la llave foránea no depende de la autora declarada).
  expect(bitacoraEnLaTx('CASH_DRAWER_PAY_IN')).toMatchObject({
    staffId: BETO,
    data: expect.objectContaining({ autor: ANA, subidoPor: BETO }),
  })
  expect(bitacora()).toBeUndefined()
  // Codex r2 #2: también la CUENTA activa, no sólo la sucursal.
  expect((prismaMock as any).staffVenue.findFirst.mock.calls[0][0].where).toMatchObject({ active: true, staff: { active: true } })
  // Se cotejó contra el aparato de la sesión que sube y la vida de esa caja (con el margen de la petición).
  expect(sesionDeAna).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        staffId: ANA,
        deviceId: 'T-1',
        OR: [{ revokedAt: null }, { revokedAt: { gte: new Date(ABIERTA.getTime() - CINCO_MIN) } }],
      }),
    }),
  )
})

it('🔴 en una caja ya CERRADA sin hora del aparato, la ventana es la vida de esa caja', async () => {
  montar({ caja: { id: 'caja-1', status: 'CLOSED', openedAt: ABIERTA, closedAt: CERRADA } })
  ;(prismaMock as any).cashDrawerSession.findUnique.mockResolvedValue({ actualAmount: null })
  await subir({ autorDelAparato: ANA, sessionId: 'caja-1' })
  expect(filaGuardada().staffId).toBe(ANA)
  expect(sesionDeAna.mock.calls[0][0].where).toMatchObject({
    createdAt: { lte: CERRADA },
    OR: [{ revokedAt: null }, { revokedAt: { gte: new Date(ABIERTA.getTime() - CINCO_MIN) } }],
  })
})

it('🔴 Codex r1 #1: con la hora del aparato, la sesión de Ana tuvo que estar viva A ESA HORA', async () => {
  const llegada = new Date('2026-11-17T20:00:00Z')
  await subir({ autorDelAparato: ANA, edadMs: 60 * 60 * 1000, llegada })
  const hora = new Date('2026-11-17T19:00:00Z')
  expect(sesionDeAna.mock.calls[0][0].where).toMatchObject({
    createdAt: { lte: hora },
    // Codex r2 #3: la hora reconstruida sale tarde por lo que tardó la petición; la revocación se coteja con 5 min de margen.
    OR: [{ revokedAt: null }, { revokedAt: { gte: new Date(hora.getTime() - CINCO_MIN) } }],
  })
})

describe('si no se puede comprobar: a nombre de quien sube (como hoy) y la bitácora lo dice', () => {
  it.each([
    ['Ana no tuvo sesión en ESTE aparato durante la caja', () => sesionDeAna.mockResolvedValue(null), 'SIN_SESION_EN_EL_APARATO'],
    [
      'Ana ya no está activa en el negocio (o su cuenta está desactivada)',
      () => (prismaMock as any).staffVenue.findFirst.mockResolvedValue(null),
      'NO_ACTIVO_EN_EL_NEGOCIO',
    ],
    [
      'la sesión que sube no tiene aparato',
      () => (prismaMock as any).session.findUnique.mockResolvedValue({ deviceId: null }),
      'SESION_SIN_APARATO',
    ],
  ])('%s', async (_caso, preparar, motivo) => {
    preparar()
    await subir({ autorDelAparato: ANA })
    expect(filaGuardada().staffId).toBe(BETO)
    expect(bitacora()).toMatchObject({ staffId: BETO, data: expect.objectContaining({ autorDelAparato: ANA, autorNoAceptado: motivo }) })
  })

  it('sin la llave de la cola no se acepta y ni se consulta la sesión', async () => {
    await subir({ autorDelAparato: ANA, localId: undefined })
    expect((prismaMock as any).cashDrawerEvent.create.mock.calls[0][0].data.staffId).toBe(BETO)
    expect(sesionDeAna).not.toHaveBeenCalled()
    expect(bitacora().data).toMatchObject({ autorDelAparato: ANA, autorNoAceptado: 'SIN_LLAVE' })
  })

  it('token viejo sin sesión (sin `sid`)', async () => {
    await subir({ autorDelAparato: ANA, sid: undefined })
    expect(filaGuardada().staffId).toBe(BETO)
    expect(bitacora().data).toMatchObject({ autorDelAparato: ANA, autorNoAceptado: 'SESION_SIN_APARATO' })
  })
})

it('sin `staffId` en el cuerpo, vacío, o igual a la sesión: exactamente como hoy, sin consultas de más', async () => {
  for (const autorDelAparato of [undefined, null, '', '  ', BETO]) {
    jest.clearAllMocks()
    montar()
    await subir({ autorDelAparato })
    expect(filaGuardada()).toMatchObject({ staffId: BETO, staffName: 'Beto R' })
    expect(sesionDeAna).not.toHaveBeenCalled()
    expect(bitacora().data.autorNoAceptado).toBeUndefined()
  }
})

it('`staffId` que no es texto o pasa de 64 caracteres ⇒ 400 y nada se escribe', async () => {
  await expect(subir({ autorDelAparato: 42 })).rejects.toMatchObject({ statusCode: 400 })
  await expect(subir({ autorDelAparato: 'x'.repeat(65) })).rejects.toMatchObject({ statusCode: 400 })
  expect(createMany).not.toHaveBeenCalled()
})

it('🔴 el retiro sigue la misma regla', async () => {
  await payOut({
    venueId: VENUE,
    staffId: BETO,
    staffName: 'Beto R',
    amount: 50,
    localId: 'loc-1',
    sid: 'ses-beto',
    autorDelAparato: ANA,
  } as any)
  expect(filaGuardada().staffId).toBe(ANA)
})
