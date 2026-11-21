/**
 * Máquina de efectivo 1a (R4-3, R5#3): sólo la PC emparejada registra ventas de la máquina. Emparejar entrega UNA vez una
 * credencial aleatoria (la PC la guarda con DPAPI) y el servidor guarda sólo su hash. Rediseño r3 (D3, r6-5): UNA sola PC habilitada
 * por negocio, con un solo candado por negocio; emparejar otra PC (con cualquier IP) revoca la anterior. r6-6: cada intento queda fijo a
 * su emparejamiento. El aparato sale siempre del encabezado autenticado (`X-Device-ID` → `Terminal`), nunca del cuerpo.
 */
import { createHash } from 'crypto'
import { logAction } from '@/services/dashboard/activity-log.service'
import { desemparejarAparato, emparejarAparato, exigirAparatoEmparejado } from '@/services/cashMachine/emparejamiento'
import { prismaMock } from '../../../__helpers__/setup'

type Fila = Record<string, any>
const VENUE = 'venue-1'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const sqlDe = (a: any): string => (Array.isArray(a) ? a.join('?') : String(a?.sql ?? a?.strings?.join('?') ?? ''))

/** Los aparatos del negocio por `deviceUid` (lo que deja `registerDevice`). */
const TERMINALES: Record<string, string> = { 'uid-pc-1': 'terminal-1', 'uid-pc-2': 'terminal-2' }
let bindings: Fila[]
let candados: string[]

function coincide(fila: Fila, where: Fila = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Fila[]).some(w => coincide(fila, w))
    if (k === 'id' && typeof v === 'object' && v && Array.isArray(v.in)) return v.in.includes(fila.id)
    if (v && typeof v === 'object' && Array.isArray(v.in)) return v.in.includes(fila[k])
    return fila[k] === v
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  bindings = []
  candados = []
  let n = 0
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.$queryRaw.mockImplementation(async (plantilla: any, ...valores: unknown[]) => {
    const sql = sqlDe(plantilla)
    if (sql.includes('pg_advisory_xact_lock')) {
      const v = Array.isArray(plantilla) ? valores : ((plantilla?.values ?? []) as unknown[])
      candados.push(String(v[0]))
      return [{ pg_advisory_xact_lock: '' }]
    }
    throw new Error(`SQL no esperado: ${sql}`)
  })
  prismaMock.terminal.findFirst.mockImplementation(async ({ where }: any) =>
    where.venueId === VENUE && TERMINALES[where.deviceUid] ? { id: TERMINALES[where.deviceUid] } : null,
  )
  prismaMock.cashMachineBinding.findFirst.mockImplementation(async ({ where }: any) => bindings.find(b => coincide(b, where)) ?? null)
  prismaMock.cashMachineBinding.findMany.mockImplementation(async ({ where }: any) => bindings.filter(b => coincide(b, where)))
  prismaMock.cashMachineBinding.updateMany.mockImplementation(async ({ where, data }: any) => {
    const tocadas = bindings.filter(b => coincide(b, where))
    tocadas.forEach(b => Object.assign(b, data))
    return { count: tocadas.length }
  })
  prismaMock.cashMachineBinding.create.mockImplementation(async ({ data }: any) => {
    const fila = { id: `binding-${++n}`, active: true, revokedAt: null, createdAt: new Date(), ...data }
    bindings.push(fila)
    return fila
  })
})

const autor = (deviceUid: string | null, userId = 'gerente-1') => ({ userId, deviceUid })
const acciones = () => (logAction as jest.Mock).mock.calls.map(c => c[0])

describe('emparejarAparato', () => {
  it('🔴 entrega la credencial UNA vez y guarda sólo su hash, con el aparato del encabezado', async () => {
    const r = await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    expect(r.credential).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 bytes aleatorios en base64url
    expect(bindings).toHaveLength(1)
    expect(bindings[0]).toMatchObject({
      id: r.bindingId,
      venueId: VENUE,
      deviceId: 'terminal-1',
      machineIp: '192.168.1.50',
      credentialHash: sha(r.credential),
      active: true,
      enabledByStaffId: 'gerente-1',
    })
    expect(JSON.stringify(bindings[0])).not.toContain(r.credential)
    // r6-5: UN candado con la clave del negocio (dos altas simultáneas se forman una detrás de la otra).
    expect(candados).toEqual([`avoqado:cash-machine-binding:v2:${VENUE}`])
    expect(acciones()).toEqual([
      expect.objectContaining({ action: 'CASH_MACHINE_PAIRED', entity: 'CashMachineBinding', entityId: r.bindingId, venueId: VENUE }),
    ])
    expect(JSON.stringify(acciones())).not.toContain(r.credential)
  })

  it('cada emparejamiento da una credencial distinta', async () => {
    const a = await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    const b = await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    expect(a.credential).not.toBe(b.credential)
  })

  it('🔴 otra PC para la MISMA máquina le quita el control a la anterior (y queda en la bitácora)', async () => {
    const primera = await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    const segunda = await emparejarAparato(VENUE, autor('uid-pc-2'), '192.168.1.50')
    expect(bindings.filter(b => b.active)).toEqual([expect.objectContaining({ id: segunda.bindingId, deviceId: 'terminal-2' })])
    expect(bindings.find(b => b.id === primera.bindingId)).toMatchObject({ active: false, revokedAt: expect.any(Date) })
    expect(acciones()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'CASH_MACHINE_UNPAIRED',
          entityId: primera.bindingId,
          data: expect.objectContaining({ motivo: 'OTRA_PC', deviceId: 'terminal-1', porBindingId: segunda.bindingId }),
        }),
      ]),
    )
  })

  it('🔴 D3 / r6-5: otra PC con OTRA IP también revoca la anterior (una sola por negocio), con el mismo candado; dice a quién relevó', async () => {
    const primera = await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    const segunda = await emparejarAparato(VENUE, autor('uid-pc-2'), '192.168.1.99')
    expect(bindings.filter(b => b.active).map(b => b.id)).toEqual([segunda.bindingId])
    expect(bindings.find(b => b.id === primera.bindingId)).toMatchObject({ active: false })
    expect(segunda.replaced).toEqual([{ deviceId: 'terminal-1', machineIp: '192.168.1.50' }])
    expect(new Set(candados)).toEqual(new Set([`avoqado:cash-machine-binding:v2:${VENUE}`]))
  })

  it('la misma PC con otra IP deja sólo la nueva activa', async () => {
    await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    const nueva = await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.60')
    expect(bindings.filter(b => b.active).map(b => b.id)).toEqual([nueva.bindingId])
  })

  it('sin X-Device-ID es 400; un aparato que el negocio no conoce es 409 (vuelve a iniciar sesión)', async () => {
    await expect(emparejarAparato(VENUE, autor(null), '192.168.1.50')).rejects.toMatchObject({
      statusCode: 400,
      code: 'DEVICE_ID_REQUIRED',
    })
    await expect(emparejarAparato(VENUE, autor('uid-ajeno'), '192.168.1.50')).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEVICE_NOT_REGISTERED',
    })
    expect(bindings).toHaveLength(0)
  })
})

describe('desemparejarAparato', () => {
  it('revoca la credencial activa de ESTE aparato y lo anota; repetirlo no hace nada', async () => {
    const r = await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    await expect(desemparejarAparato(VENUE, autor('uid-pc-1'))).resolves.toEqual({ revoked: true })
    expect(bindings[0]).toMatchObject({ active: false, revokedAt: expect.any(Date) })
    expect(acciones()).toContainEqual(
      expect.objectContaining({
        action: 'CASH_MACHINE_UNPAIRED',
        entityId: r.bindingId,
        data: expect.objectContaining({ motivo: 'MANUAL' }),
      }),
    )
    await expect(desemparejarAparato(VENUE, autor('uid-pc-1'))).resolves.toEqual({ revoked: false })
  })

  it('no toca la credencial de otra PC', async () => {
    await emparejarAparato(VENUE, autor('uid-pc-2'), '192.168.1.50')
    await expect(desemparejarAparato(VENUE, autor('uid-pc-1'))).resolves.toEqual({ revoked: false })
    expect(bindings[0].active).toBe(true)
  })
})

describe('exigirAparatoEmparejado (lo usa POST cash-machine/sales)', () => {
  const NO_EMPAREJADA = {
    statusCode: 403,
    code: 'CASH_MACHINE_NOT_PAIRED',
    message: 'Esta PC no está emparejada con la máquina de efectivo',
  }

  it('🔴 sin credencial, o con una que no es de nadie: 403 en español', async () => {
    await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    await expect(exigirAparatoEmparejado(VENUE, 'terminal-1', null)).rejects.toMatchObject(NO_EMPAREJADA)
    await expect(exigirAparatoEmparejado(VENUE, 'terminal-1', 'inventada')).rejects.toMatchObject(NO_EMPAREJADA)
    await expect(exigirAparatoEmparejado(VENUE, null, 'inventada')).rejects.toMatchObject(NO_EMPAREJADA)
  })

  it('la PC emparejada pasa con su credencial', async () => {
    const { credential } = await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    const r = await exigirAparatoEmparejado(VENUE, 'terminal-1', credential)
    expect(r).toEqual({ bindingId: bindings[0].id })
  })

  it('🔴 perfil restaurado: la MISMA credencial desde otra PC no sirve', async () => {
    const { credential } = await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    await expect(exigirAparatoEmparejado(VENUE, 'terminal-2', credential)).rejects.toMatchObject(NO_EMPAREJADA)
  })

  it('🔴 otra PC tomó la máquina: la anterior todavía ENTREGA lo suyo (su emparejamiento revocado decide bajo el candado del folio)', async () => {
    const vieja = await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    const nueva = await emparejarAparato(VENUE, autor('uid-pc-2'), '192.168.1.50')
    await expect(exigirAparatoEmparejado(VENUE, 'terminal-1', vieja.credential)).resolves.toEqual({ bindingId: vieja.bindingId })
    await expect(exigirAparatoEmparejado(VENUE, 'terminal-2', nueva.credential)).resolves.toEqual({ bindingId: nueva.bindingId })
  })

  it('🔴 r6-6: el intento fijo a su emparejamiento ANTERIOR (b1) llega con la credencial NUEVA de la misma PC: cuenta b1, no la nueva', async () => {
    const b1 = await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    await emparejarAparato(VENUE, autor('uid-pc-2'), '192.168.1.50')
    const b3 = await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    await expect(exigirAparatoEmparejado(VENUE, 'terminal-1', b3.credential, b1.bindingId)).resolves.toEqual({ bindingId: b1.bindingId })
    // Un emparejamiento de OTRO aparato no se puede reclamar.
    const deB = bindings.find(b => b.deviceId === 'terminal-2')!
    await expect(exigirAparatoEmparejado(VENUE, 'terminal-1', b3.credential, deB.id)).rejects.toMatchObject(NO_EMPAREJADA)
    // Sin credencial, nada.
    await expect(exigirAparatoEmparejado(VENUE, 'terminal-1', null, b1.bindingId)).rejects.toMatchObject(NO_EMPAREJADA)
  })
})
