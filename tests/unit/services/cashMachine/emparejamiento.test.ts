/**
 * Máquina de efectivo 1a (R4-3, R5#3): sólo la PC emparejada registra ventas de la máquina. Emparejar entrega UNA vez una
 * credencial aleatoria (la PC la guarda con DPAPI) y el servidor guarda sólo su hash. Cada máquina (IP del negocio) tiene un solo
 * emisor: emparejar otra PC le quita el control a la anterior. El aparato sale siempre del encabezado autenticado (`X-Device-ID`
 * → `Terminal`), nunca del cuerpo.
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
let folios: Record<string, Fila>

function coincide(fila: Fila, where: Fila = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Fila[]).some(w => coincide(fila, w))
    if (v && typeof v === 'object' && Array.isArray(v.in)) return v.in.includes(fila[k])
    return fila[k] === v
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  bindings = []
  candados = []
  folios = {}
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
  prismaMock.cashMachineClose.findUnique.mockImplementation(
    async ({ where }: any) => folios[where.venueId_referenceCC?.referenceCC] ?? null,
  )
  // Las dudas y los «no se pudo registrar» de cada folio (dueño = la PC que los subió).
  prismaMock.cashMachineIncident.findMany.mockImplementation(async ({ where }: any) => (incidenciasDe[where.referenceCC] ?? []) as any)
  incidenciasDe = {}
})
let incidenciasDe: Record<string, Fila[]> = {}

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
    // Candado del aparato y luego el de la máquina (siempre en ese orden: dos emparejamientos no se cruzan).
    expect(candados).toEqual([
      `avoqado:cash-machine-binding:v1:${VENUE}:aparato:terminal-1`,
      `avoqado:cash-machine-binding:v1:${VENUE}:ip:192.168.1.50`,
    ])
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
  const FOLIO = 'AQ0123456789AB'

  it('🔴 sin credencial, o con una que no es de nadie: 403 en español', async () => {
    await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    await expect(exigirAparatoEmparejado(VENUE, 'terminal-1', null)).rejects.toMatchObject(NO_EMPAREJADA)
    await expect(exigirAparatoEmparejado(VENUE, 'terminal-1', 'inventada')).rejects.toMatchObject(NO_EMPAREJADA)
    await expect(exigirAparatoEmparejado(VENUE, null, 'inventada')).rejects.toMatchObject(NO_EMPAREJADA)
  })

  it('la PC emparejada pasa con su credencial', async () => {
    const { credential } = await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    await expect(exigirAparatoEmparejado(VENUE, 'terminal-1', credential)).resolves.toEqual({ revocadaEn: null })
  })

  it('🔴 perfil restaurado: la MISMA credencial desde otra PC no sirve', async () => {
    const { credential } = await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    await expect(exigirAparatoEmparejado(VENUE, 'terminal-2', credential)).rejects.toMatchObject(NO_EMPAREJADA)
  })

  it('🔴 otra PC tomó la máquina: la anterior ya no registra folios NUEVOS', async () => {
    const vieja = await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    const nueva = await emparejarAparato(VENUE, autor('uid-pc-2'), '192.168.1.50')
    // Codex r1 #5 (decisión d): un folio NUEVO de la vieja ya no es 403; lleva la hora de la revocación para que la hora decida.
    const revocada = bindings.find(b => b.deviceId === 'terminal-1')!
    await expect(exigirAparatoEmparejado(VENUE, 'terminal-1', vieja.credential)).resolves.toEqual({
      revocadaEn: revocada.revokedAt,
    })
    expect(revocada.revokedAt).toBeInstanceOf(Date)
    await expect(exigirAparatoEmparejado(VENUE, 'terminal-2', nueva.credential)).resolves.toEqual({ revocadaEn: null })
  })

  it('🔴 Codex r2 #1: aquí sólo se mira la credencial; con ella revocada vuelve SIEMPRE su revokedAt (el folio lo decide bajo su candado)', async () => {
    const { credential } = await emparejarAparato(VENUE, autor('uid-pc-1'), '192.168.1.50')
    // Aunque la PC tenga cierre, duda o «no se pudo» de ese folio: antes eso le devolvía la autoridad entera (revocadaEn null).
    folios[FOLIO] = { deviceId: 'terminal-1' }
    incidenciasDe[FOLIO] = [{ kind: 'ESPERANDO', deviceId: 'terminal-1' }]
    await desemparejarAparato(VENUE, autor('uid-pc-1'))
    const revocada = bindings.find(b => b.deviceId === 'terminal-1')!
    await expect(exigirAparatoEmparejado(VENUE, 'terminal-1', credential)).resolves.toEqual({ revocadaEn: revocada.revokedAt })
    // Sin su credencial, nada.
    await expect(exigirAparatoEmparejado(VENUE, 'terminal-1', null)).rejects.toMatchObject(NO_EMPAREJADA)
  })
})
