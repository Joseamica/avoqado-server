/**
 * D662 v5 (encargo 64fabe, tarjeta 62937a87): el socket del panel recibe los avisos de la tienda en línea de OTRA sucursal (canal propio,
 * sin datos) sólo si el SERVIDOR comprueba con el usuario su permiso en esa sucursal. Toca la seguridad del socket de todo el panel: cada camino de acceso y de negación tiene su prueba.
 */
import { RoomManagerService } from '@/communication/sockets/services/roomManager.service'
import {
  avisoDeTiendaSinDatos,
  CuartosDeOtraSucursal,
  EVENTO_ENTRAR,
  EVENTO_SALIR,
} from '@/communication/sockets/services/cuartosDeOtraSucursal'

const A = 'cvenueaaaaaaaaaaaaaaaaaaa' // la del token
const B = 'cvenuebbbbbbbbbbbbbbbbbbb' // otra sucursal

type Manejador = (...args: any[]) => unknown
const socketFalso = (id: string, ctx: Record<string, unknown> = {}) => {
  const manejadores: Record<string, Manejador> = {}
  const socket: any = {
    id,
    connected: true,
    correlationId: 'c',
    authContext: { socketId: id, userId: 'cstaff1', venueId: A, role: 'MANAGER', orgId: 'o', ...ctx },
    on: (evento: string, h: Manejador) => (manejadores[evento] = h),
    emit: jest.fn(),
  }
  return { socket, manejadores }
}

/** ¿Recibe los avisos de la tienda de [venueId] por el canal de otra sucursal? */
const enCuarto = (rm: RoomManagerService, venueId: string, socketId: string) =>
  rm.getOnlineStoreChannelSockets(venueId).some(s => s.id === socketId)

describe('cuartos de otra sucursal (socket del panel)', () => {
  let rm: RoomManagerService
  let resolver: jest.Mock
  let cuartos: CuartosDeOtraSucursal
  beforeEach(() => {
    rm = new RoomManagerService()
    // Con `orders:read` en B (como la Bandeja por HTTP); nada en otras.
    resolver = jest.fn(
      async ({ venueId, permission }: { venueId: string; permission: string }) => venueId === B && permission === 'orders:read',
    )
    cuartos = new CuartosDeOtraSucursal(rm, resolver as any, 60_000)
  })

  const conectar = (ctx: Record<string, unknown> = {}, id = 's1') => {
    const f = socketFalso(id, ctx)
    rm.registerSocket(f.socket)
    cuartos.registrar(f.socket)
    return f
  }

  it('con acceso verificado con EL USUARIO (no con el token) entra al cuarto de B y recibe lo de B', async () => {
    const { socket } = conectar()
    await expect(cuartos.entrar(socket, { venueId: B })).resolves.toBe(true)
    expect(resolver).toHaveBeenCalledWith({ staffId: 'cstaff1', venueId: B, permission: 'orders:read' })
    expect(enCuarto(rm, B, 's1')).toBe(true)
    // 🔴 NO entra al cuarto general de B (facturas, logs y comandos de terminal; Codex p2v5-r1 #4/#5).
    expect(rm.getVenueSockets(B)).toHaveLength(0)
    expect(rm.getVenueSockets(A).map(s => s.id)).toEqual(['s1'])
  })

  it('con sólo `online-orders:manage` (Configuración) también entra; sin ninguno de los dos permisos en B, no', async () => {
    resolver.mockImplementation(async ({ permission }: { permission: string }) => permission === 'online-orders:manage')
    const { socket } = conectar()
    await expect(cuartos.entrar(socket, { venueId: B })).resolves.toBe(true)
    resolver.mockResolvedValue(false)
    const otro = conectar({}, 's9').socket
    await expect(cuartos.entrar(otro, { venueId: B })).resolves.toBe(false)
    expect(enCuarto(rm, B, 's9')).toBe(false)
  })

  it('una sesión de SUPLANTACIÓN no entra a otra sucursal, ni consulta', async () => {
    const { socket } = conectar({ isImpersonating: true })
    await expect(cuartos.entrar(socket, { venueId: B })).resolves.toBe(false)
    expect(resolver).not.toHaveBeenCalled()
  })

  it('sin el permiso (sin fila, dado de baja, dueño de OTRA organización, permiso quitado) no entra y no recibe nada de B', async () => {
    resolver.mockResolvedValue(false)
    const { socket } = conectar()
    const cb = jest.fn()
    await expect(cuartos.entrar(socket, { venueId: B }, cb)).resolves.toBe(false)
    expect(cb).toHaveBeenCalledWith({ success: false, error: 'Sin acceso a esta sucursal' })
    expect(enCuarto(rm, B, 's1')).toBe(false)
  })

  it('si la base falla al verificar, NO entra (falla cerrado)', async () => {
    resolver.mockRejectedValue(new Error('db caída'))
    const { socket } = conectar()
    await expect(cuartos.entrar(socket, { venueId: B })).resolves.toBe(false)
    expect(enCuarto(rm, B, 's1')).toBe(false)
  })

  it('una TERMINAL (token con serial) nunca entra a otra sucursal, ni consulta', async () => {
    const { socket } = conectar({ terminalSerialNumber: 'AVQD-123' })
    await expect(cuartos.entrar(socket, { venueId: B })).resolves.toBe(false)
    expect(resolver).not.toHaveBeenCalled()
    expect(enCuarto(rm, B, 's1')).toBe(false)
  })

  it('un id raro o sin usuario no se consulta', async () => {
    const { socket } = conectar()
    for (const p of [null, {}, { venueId: 5 }, { venueId: "x' OR 1=1" }, { venueId: ['a'] }]) {
      await expect(cuartos.entrar(socket, p)).resolves.toBe(false)
    }
    const sinUsuario = conectar({ userId: undefined }, 's2').socket
    await expect(cuartos.entrar(sinUsuario, { venueId: B })).resolves.toBe(false)
    expect(resolver).not.toHaveBeenCalled()
  })

  it('la del token responde bien sin consultar y salir de ella NO la saca (como hoy)', async () => {
    const { socket } = conectar()
    await expect(cuartos.entrar(socket, { venueId: A })).resolves.toBe(true)
    cuartos.salir(socket, { venueId: A })
    expect(resolver).not.toHaveBeenCalled()
    expect(rm.getVenueSockets(A).map(s => s.id)).toEqual(['s1'])
    expect(rm.getOnlineStoreChannelSockets(A)).toHaveLength(0)
  })

  it('salir de B lo saca; y un salir que llega MIENTRAS se verificaba el entrar gana (no entra)', async () => {
    const { socket } = conectar()
    await cuartos.entrar(socket, { venueId: B })
    cuartos.salir(socket, { venueId: B })
    expect(enCuarto(rm, B, 's1')).toBe(false)

    let soltar!: () => void
    resolver.mockImplementationOnce(() => new Promise(r => (soltar = () => r(true))))
    const p = cuartos.entrar(socket, { venueId: B })
    cuartos.salir(socket, { venueId: B })
    soltar()
    await expect(p).resolves.toBe(false)
    expect(enCuarto(rm, B, 's1')).toBe(false)
  })

  it('si se desconecta mientras se verificaba, no queda colgado en el cuarto; al desconectarse sale de todos', async () => {
    const { socket } = conectar()
    let soltar!: () => void
    resolver.mockImplementationOnce(() => new Promise(r => (soltar = () => r(true))))
    const p = cuartos.entrar(socket, { venueId: B })
    socket.connected = false
    rm.unregisterSocket(socket)
    soltar()
    await expect(p).resolves.toBe(false)
    expect(rm.getVenueSockets(B)).toHaveLength(0)

    const otro = conectar({}, 's3').socket
    await cuartos.entrar(otro, { venueId: B })
    rm.unregisterSocket(otro)
    expect(enCuarto(rm, B, 's3')).toBe(false)
  })

  it('la revalidación lo saca si le quitaron el permiso (aunque conserve su rol) o si la base falla; con permiso, se queda', async () => {
    const { socket } = conectar()
    await cuartos.entrar(socket, { venueId: B })
    await cuartos.revalidar(socket)
    expect(enCuarto(rm, B, 's1')).toBe(true)
    resolver.mockResolvedValue(false)
    await cuartos.revalidar(socket)
    expect(enCuarto(rm, B, 's1')).toBe(false)

    resolver.mockImplementation(async ({ permission }: { permission: string }) => permission === 'orders:read')
    await cuartos.entrar(socket, { venueId: B })
    resolver.mockRejectedValue(new Error('db'))
    await cuartos.revalidar(socket)
    expect(enCuarto(rm, B, 's1')).toBe(false)
  })

  it('el canal de B no da cuartos de rol, usuario, mesa u orden de B: siguen atados al token', async () => {
    const { socket } = conectar()
    await cuartos.entrar(socket, { venueId: B })
    expect(rm.getRoleSockets('MANAGER' as any, B)).toHaveLength(0)
    expect(rm.getTableSockets(B, 't1')).toHaveLength(0)
    expect(rm.getUserSockets('cstaff1').map(s => s.id)).toEqual(['s1'])
  })

  it('el aviso que reciben los de otra sucursal sólo trae el negocio y la hora (nunca la carga del cuarto general)', () => {
    const now = new Date('2026-11-20T18:00:00.000Z')
    expect(avisoDeTiendaSinDatos(B, now)).toEqual({ venueId: B, timestamp: now.toISOString() })
  })

  it('se registra en los eventos que manda el DASHBOARD (joinVenueRoom / leaveVenueRoom)', async () => {
    const { socket, manejadores } = conectar()
    expect(Object.keys(manejadores)).toEqual(expect.arrayContaining([EVENTO_ENTRAR, EVENTO_SALIR, 'disconnect']))
    const cb = jest.fn()
    manejadores[EVENTO_ENTRAR]({ venueId: B }, cb)
    await new Promise(r => setImmediate(r))
    expect(cb).toHaveBeenCalledWith({ success: true })
    expect(enCuarto(rm, B, socket.id)).toBe(true)
  })

  it('🔴 Codex p2v5-r2 #1: una confirmación que no es función, o que lanza, nunca tumba al SERVIDOR', async () => {
    const { manejadores } = conectar()
    for (const raro of [42, 'x', { a: 1 }, true]) {
      expect(() => manejadores[EVENTO_ENTRAR]({ venueId: B }, raro)).not.toThrow()
      expect(() => manejadores[EVENTO_SALIR]({ venueId: B }, raro)).not.toThrow()
    }
    const lanza = () => {
      throw new Error('del cliente')
    }
    expect(() => manejadores[EVENTO_SALIR]({ venueId: B }, lanza)).not.toThrow()
    resolver.mockRejectedValue(new Error('db'))
    manejadores[EVENTO_ENTRAR]({ venueId: B }, lanza)
    // Ningún rechazo sin atender (jest falla la prueba si uno se escapa).
    await new Promise(r => setImmediate(r))
  })

  it('🔴 Codex p2v5-r2 #2: si le quitaron el permiso y vuelve a pedir, el alta negada también lo SACA (no espera a la revalidación)', async () => {
    const { socket } = conectar()
    await cuartos.entrar(socket, { venueId: B })
    expect(enCuarto(rm, B, 's1')).toBe(true)
    resolver.mockResolvedValue(false)
    await expect(cuartos.entrar(socket, { venueId: B })).resolves.toBe(false)
    expect(enCuarto(rm, B, 's1')).toBe(false)
    // Y si la base falla en esa alta, también sale (falla cerrado).
    resolver.mockImplementation(async ({ permission }: { permission: string }) => permission === 'orders:read')
    await cuartos.entrar(socket, { venueId: B })
    resolver.mockRejectedValue(new Error('db'))
    await cuartos.entrar(socket, { venueId: B })
    expect(enCuarto(rm, B, 's1')).toBe(false)
  })

  it('Codex p2v5-r2 #3: no recuerda nada de las altas ya terminadas ni de las bajas (la memoria no crece con las sucursales visitadas)', async () => {
    const { socket } = conectar()
    for (let i = 0; i < 50; i++) {
      const v = `cvenue${String(i).padStart(19, '0')}`
      await cuartos.entrar(socket, { venueId: v })
      cuartos.salir(socket, { venueId: v })
    }
    expect((cuartos as unknown as { pendientes: Map<string, number> }).pendientes.size).toBe(0)
  })

  it('Codex p2v5-r2 #3: una revalidación no se encima con otra del mismo socket', async () => {
    const { socket } = conectar()
    await cuartos.entrar(socket, { venueId: B })
    resolver.mockClear()
    let soltar!: () => void
    resolver.mockImplementationOnce(() => new Promise(r => (soltar = () => r(true))))
    const primera = cuartos.revalidar(socket)
    await cuartos.revalidar(socket)
    expect(resolver).toHaveBeenCalledTimes(1)
    soltar()
    await primera
  })
})
