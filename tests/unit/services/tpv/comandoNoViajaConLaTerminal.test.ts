/**
 * 🔴 Un comando NO viaja con la terminal a otro negocio (auditoría de Codex r2, 16-oct-2026, P1-2).
 *
 * Un comando se autoriza contra SU venue (`TpvCommandQueue.venueId`), pero la entrega (`sendCommandToTerminal`, el
 * latido `getPendingCommands`) y el permiso de ejecución (`updateCommandStatus` → EXECUTING) iban a la terminal donde
 * esté HOY. Dos vías reproducidas:
 *   1. Re-armar un comando con la terminal en A y trasladarla a B antes de la entrega: llegaba a B (FACTORY_RESET y LOCK).
 *   2. La migración DIFERIDA A→B (la terminal sigue en A hasta que ejecuta su borrado): un OWNER de A encola OTRO
 *      FACTORY_RESET mientras tanto; se ejecuta la migración; tras reiniciar en B, el latido le entregaba el segundo
 *      borrado (venue A) y el permiso lo autorizaba (`EXECUTING=true`).
 *
 * La regla, en el punto común: un comando cuyo `venueId` ya no es el venue actual de su terminal NO se entrega ni se
 * ejecuta; queda CANCELLED con `TERMINAL_MOVED` y deja `ActivityLog`. Y mientras una migración diferida no se ejecuta,
 * la terminal no acepta comandos nuevos (quedarían huérfanos al moverse).
 *
 * Todo corre REAL —encolar, latido, entrega por socket, permiso y la propia migración— sobre una «base» en memoria;
 * sólo se simulan Prisma (con estado), el socket (para ver a quién se emite) y la configuración de pago del destino.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'

const broadcastToTerminalMock = jest.fn()
const broadcastTpvCommandMock = jest.fn()
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: {
    getServer: () => ({}),
    broadcastToTerminal: (...args: unknown[]) => broadcastToTerminalMock(...args),
    broadcastToVenue: jest.fn(),
  },
  broadcastTpvCommand: (...args: unknown[]) => broadcastTpvCommandMock(...args),
  broadcastTpvStatusUpdate: jest.fn(),
  broadcastTpvCommandStatusChanged: jest.fn(),
  broadcastTpvCommandQueued: jest.fn(),
  broadcastSuperadminTerminalUpdate: jest.fn(),
}))
jest.mock('@/services/organization-payment-config.service', () => ({
  getEffectivePaymentConfig: jest.fn(async () => ({ config: { primaryAccount: { active: true, provider: { code: 'BLUMON' } } } })),
}))

import { tpvCommandQueueService } from '@/services/tpv/command-queue.service'
import { tpvHealthService } from '@/services/tpv/tpv-health.service'
import { tpvCommandExecutionService } from '@/services/tpv/command-execution.service'

const A = 'venue-a'
const B = 'venue-b'
const ORG = 'org-1'

type Fila = Record<string, any>
let terminal: Fila
let comandos: Fila[]
let siguiente = 0

// ── La «base» en memoria: lo justo de los `where` que usa este código ───────────────────────────────────────────
function vale(valor: any, filtro: any): boolean {
  if (filtro === undefined) return true
  if (filtro === null) return valor === null || valor === undefined
  if (filtro instanceof Date) return valor instanceof Date && valor.getTime() === filtro.getTime()
  if (typeof filtro !== 'object') return valor === filtro
  if ('in' in filtro && !filtro.in.includes(valor)) return false
  if ('not' in filtro && valor === filtro.not) return false
  if ('gt' in filtro && !(valor instanceof Date && valor > filtro.gt)) return false
  if ('lt' in filtro && !(valor instanceof Date && valor < filtro.lt)) return false
  if ('lte' in filtro && !(valor instanceof Date && valor <= filtro.lte)) return false
  return true
}
function cumple(c: Fila, where: any): boolean {
  if (!where) return true
  for (const [k, f] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(f as any[]).some(w => cumple(c, w))) return false
    } else if (k === 'AND') {
      if (!(f as any[]).every(w => cumple(c, w))) return false
    } else if (k === 'payload') {
      const p = f as { path: string[]; equals: unknown }
      if ((c.payload as any)?.[p.path[0]] !== p.equals) return false
    } else if (k === 'terminal') {
      const t = (f as any).is ?? f
      if (!vale(terminal.venueId, t.venueId)) return false // la terminal de HOY, como el subquery de Postgres
    } else if (!vale(c[k], f)) return false
  }
  return true
}
const PRIORIDAD: Record<string, number> = { LOW: 0, NORMAL: 1, HIGH: 2, CRITICAL: 3 }
function aplicar(c: Fila, data: any) {
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v === undefined) continue
    c[k] = v && typeof v === 'object' && 'increment' in (v as any) ? (c[k] ?? 0) + (v as any).increment : v
  }
}
const conTerminal = (c: Fila) => ({ ...c, terminal: { ...terminal }, venue: { name: c.venueId } })

function comando(id: string) {
  return comandos.find(c => c.id === id)!
}
function cancelacionesPorTraslado() {
  return (logAction as jest.Mock).mock.calls.map(([p]) => p).filter(p => p?.action === 'TPV_COMMAND_CANCELLED_TERMINAL_MOVED')
}

beforeEach(() => {
  jest.clearAllMocks()
  siguiente = 0
  comandos = []
  terminal = {
    id: 'terminal-1',
    venueId: A,
    name: 'Caja 1',
    serialNumber: 'AVQD-2840744167',
    type: 'TPV_ANDROID',
    brand: 'PAX',
    status: 'ACTIVE',
    isLocked: false,
    lastHeartbeat: new Date(),
    commandProtocolVersion: 2,
    commandSessionId: 'boot-1',
    venue: { name: 'Tienda A' },
  }

  prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
  ;(prismaMock as any).tpvCommandHistory = { create: jest.fn().mockResolvedValue({}) }
  prismaMock.terminal.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve(where?.id === terminal.id ? { ...terminal } : null)) as any)
  prismaMock.terminal.updateMany.mockImplementation((({ where, data }: any) => {
    if (where?.id !== terminal.id || (where.venueId && where.venueId !== terminal.venueId)) return Promise.resolve({ count: 0 })
    aplicar(terminal, data)
    return Promise.resolve({ count: 1 })
  }) as any)
  prismaMock.venue.findUnique.mockImplementation((({ where }: any) => Promise.resolve({ id: where?.id, organizationId: ORG })) as any)
  // Pantalla del cliente (F0-A): el permiso de la migración borra el diseño de la terminal ANTES de mudarla
  // (`borrarDisenoAlCambiarDeNegocio`): toma el candado de la fila con `SELECT … FOR UPDATE`, borra el diseño y limpia el
  // acuse. Aquí la terminal no tiene diseño; lo demás de `$queryRaw` sigue sin respuesta, como antes.
  prismaMock.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Array.isArray(strings) ? strings.join('?') : ''
    if (/FROM "Terminal"/.test(sql) && /FOR UPDATE/.test(sql))
      return Promise.resolve(values[0] === terminal.id ? [{ id: terminal.id, venueId: terminal.venueId }] : [])
    return Promise.resolve(undefined)
  }) as any)
  prismaMock.customerDisplayDesign.deleteMany.mockResolvedValue({ count: 0 } as any)
  prismaMock.terminal.update.mockImplementation((({ where }: any) => Promise.resolve({ id: where?.id })) as any)
  prismaMock.tpvCommandQueue.create.mockImplementation((({ data }: any) => {
    const fila = {
      id: `cmd-${++siguiente}`,
      correlationId: `corr-${siguiente}`,
      createdAt: new Date(Date.now() + siguiente),
      attempts: 0,
      ...data,
    }
    comandos.push(fila)
    return Promise.resolve({ ...fila })
  }) as any)
  prismaMock.tpvCommandQueue.findUnique.mockImplementation((({ where }: any) => {
    const c = comandos.find(x => x.id === where?.id)
    return Promise.resolve(c ? conTerminal(c) : null)
  }) as any)
  prismaMock.tpvCommandQueue.findFirst.mockImplementation((({ where }: any) => {
    const c = comandos.find(x => cumple(x, where))
    return Promise.resolve(c ? conTerminal(c) : null)
  }) as any)
  prismaMock.tpvCommandQueue.findMany.mockImplementation((({ where, take }: any) =>
    Promise.resolve(
      comandos
        .filter(c => cumple(c, where))
        .sort((x, y) => PRIORIDAD[y.priority] - PRIORIDAD[x.priority] || x.createdAt - y.createdAt)
        .slice(0, take ?? 1000)
        .map(c => ({ ...c })),
    )) as any)
  prismaMock.tpvCommandQueue.updateMany.mockImplementation((({ where, data }: any) => {
    const hits = comandos.filter(c => cumple(c, where))
    hits.forEach(c => aplicar(c, data))
    return Promise.resolve({ count: hits.length })
  }) as any)
  prismaMock.tpvCommandQueue.update.mockImplementation((({ where, data }: any) => {
    const c = comando(where.id)
    aplicar(c, data)
    return Promise.resolve({ ...c })
  }) as any)
})

/** Lo que hace `updateTerminal` del superadmin al empezar una migración DIFERIDA (protocolo 2): encolar su borrado. */
async function empezarMigracionDiferida() {
  const r = await tpvCommandQueueService.queueCommand({
    terminalId: terminal.id,
    venueId: A,
    migrationIntent: { toVenueId: B, assignedMerchantIds: [] },
    commandType: 'FACTORY_RESET',
    priority: 'CRITICAL',
    requestedBy: 'dueno-org',
    source: 'DASHBOARD',
    payload: { migration: { fromVenueId: A, previousMerchantIds: [], toVenueId: B } },
  })
  return r.commandId
}

/** El permiso de ejecución que pide la TPV (protocolo 2) con su sesión de app actual. */
function permiso(commandId: string) {
  return tpvCommandQueueService.updateCommandStatus(commandId, 'EXECUTING', undefined, undefined, terminal.id, {
    executionSessionId: terminal.commandSessionId,
  })
}

describe('regresión: la terminal que sigue en A recibe y ejecuta su comando', () => {
  it('el latido le entrega el LOCK de A y el permiso lo autoriza', async () => {
    const { commandId } = await tpvCommandQueueService.queueCommand({
      terminalId: terminal.id,
      venueId: A,
      commandType: 'LOCK',
      requestedBy: 'dueno-a',
    })

    const entregados = await tpvHealthService.getPendingCommands(terminal.id, true)

    expect(entregados.map(c => c.commandId)).toEqual([commandId])
    expect(await permiso(commandId)).toBe(true)
    expect(comando(commandId).status).toBe('EXECUTING')
    expect(cancelacionesPorTraslado()).toEqual([])
  })

  it('la entrega por socket va a A', async () => {
    terminal.commandProtocolVersion = null // TPV vieja: la entrega es el socket, no la sugerencia
    const { commandId } = await tpvCommandQueueService.queueCommand({
      terminalId: terminal.id,
      venueId: A,
      commandType: 'LOCK',
      requestedBy: 'dueno-a',
    })

    await tpvCommandExecutionService.sendCommandToTerminal(commandId)

    expect(broadcastToTerminalMock).toHaveBeenCalledWith(
      A,
      terminal.serialNumber,
      expect.anything(),
      expect.objectContaining({ commandId }),
    )
  })
})

describe.each(['FACTORY_RESET', 'LOCK'])('%s re-armado en A y la terminal se traslada a B ANTES de entregarlo', tipo => {
  function rearmadoYTrasladado(protocolo: number | null) {
    terminal.commandProtocolVersion = protocolo
    comandos.push({
      id: 'cmd-viejo',
      correlationId: 'corr-viejo',
      createdAt: new Date(),
      terminalId: terminal.id,
      venueId: A,
      commandType: tipo,
      status: 'PENDING', // re-armado por el reintento (ronda 7) con la terminal todavía en A
      priority: 'HIGH',
      attempts: 0,
      payload: protocolo === 2 ? { _deliveryProtocol: 2, _originCommandSessionId: 'boot-1' } : {},
      expiresAt: null,
      scheduledFor: null,
      requestedBy: 'dueno-a',
    })
    terminal.venueId = B // el traslado llega después del re-armado
  }

  it('🔴 la entrega por socket NO emite a B; el comando queda CANCELLED con TERMINAL_MOVED y en la bitácora', async () => {
    rearmadoYTrasladado(null)

    await tpvCommandExecutionService.sendCommandToTerminal('cmd-viejo')

    expect(broadcastToTerminalMock).not.toHaveBeenCalled()
    expect(broadcastTpvCommandMock).not.toHaveBeenCalled()
    expect(comando('cmd-viejo')).toMatchObject({ status: 'CANCELLED', resultMessage: expect.stringMatching(/^TERMINAL_MOVED/) })
    expect(cancelacionesPorTraslado()).toEqual([
      expect.objectContaining({
        venueId: A,
        entityId: 'cmd-viejo',
        data: expect.objectContaining({ terminalVenueId: B, commandType: tipo }),
      }),
    ])
  })

  it('🔴 el latido en B (TPV vieja) no lo entrega', async () => {
    rearmadoYTrasladado(null)

    const entregados = await tpvHealthService.getPendingCommands(terminal.id)

    expect(entregados).toEqual([])
    expect(comando('cmd-viejo').status).toBe('CANCELLED')
  })

  it('🔴 el latido durable en B (protocolo 2) no lo entrega, y el permiso tampoco lo autoriza', async () => {
    rearmadoYTrasladado(2)

    expect(await permiso('cmd-viejo')).toBe(false)
    expect(comando('cmd-viejo').status).toBe('CANCELLED')
    expect(await tpvHealthService.getPendingCommands(terminal.id, true)).toEqual([])
  })
})

describe('la secuencia de Codex: migración diferida A→B y OTRO borrado de A', () => {
  it('🔴 mientras la migración no se ejecuta, A no puede encolar otro comando (409 en español)', async () => {
    await empezarMigracionDiferida()

    await expect(
      tpvCommandQueueService.queueCommand({ terminalId: terminal.id, venueId: A, commandType: 'FACTORY_RESET', requestedBy: 'dueno-a' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'TERMINAL_MIGRATION_PENDING', message: expect.stringMatching(/migrando/) })
    expect(comandos).toHaveLength(1)
  })

  it('🔴 aunque el segundo borrado ya estuviera en la cola (p. ej. de antes de este arreglo): tras la migración NO se entrega ni se autoriza en B', async () => {
    const migracion = await empezarMigracionDiferida()
    comandos.push({
      id: 'cmd-segundo',
      correlationId: 'corr-2',
      createdAt: new Date(Date.now() + 100),
      terminalId: terminal.id,
      venueId: A,
      commandType: 'FACTORY_RESET',
      status: 'PENDING',
      priority: 'CRITICAL',
      attempts: 0,
      payload: { _deliveryProtocol: 2, _originCommandSessionId: 'boot-1' },
      expiresAt: null,
      scheduledFor: null,
      requestedBy: 'dueno-a',
    })

    // 1. Latido en A: la TPV recibe los dos (la terminal sigue en A: es legítimo).
    const enA = await tpvHealthService.getPendingCommands(terminal.id, true)
    expect(enA.map(c => c.commandId).sort()).toEqual([migracion, 'cmd-segundo'].sort())

    // 2. Permiso del borrado de MIGRACIÓN: se autoriza y la terminal pasa a B.
    expect(await permiso(migracion)).toBe(true)
    expect(terminal.venueId).toBe(B)
    expect(comando(migracion).venueId).toBe(B)

    // 3. La TPV se borra y reinicia en B (otra sesión de app) y pide el segundo: NO.
    terminal.commandSessionId = 'boot-2'
    expect(await permiso('cmd-segundo')).toBe(false)
    expect(comando('cmd-segundo')).toMatchObject({ status: 'CANCELLED', resultMessage: expect.stringMatching(/^TERMINAL_MOVED/) })
    expect(await tpvHealthService.getPendingCommands(terminal.id, true)).toEqual([])
    expect(cancelacionesPorTraslado()).toEqual([expect.objectContaining({ venueId: A, entityId: 'cmd-segundo' })])

    // 4. El borrado de la migración sí cierra con su resultado (la regla no bloquea resultados).
    await tpvCommandQueueService.handleCommandResult(migracion, terminal.id, 'SUCCESS')
    expect(comando(migracion).status).toBe('COMPLETED')
  })

  it('el latido en B tampoco lo entrega aunque nunca se haya pedido el permiso', async () => {
    const migracion = await empezarMigracionDiferida()
    comandos.push({
      id: 'cmd-segundo',
      correlationId: 'corr-2',
      createdAt: new Date(Date.now() + 100),
      terminalId: terminal.id,
      venueId: A,
      commandType: 'FACTORY_RESET',
      status: 'SENT', // la TPV lo recibió en A y no alcanzó a pedir permiso
      priority: 'CRITICAL',
      attempts: 1,
      payload: { _deliveryProtocol: 2, _originCommandSessionId: 'boot-1' },
      expiresAt: null,
      scheduledFor: null,
      nextAttemptAt: null,
      requestedBy: 'dueno-a',
    })
    expect(await permiso(migracion)).toBe(true)
    terminal.commandSessionId = 'boot-2'

    expect(await tpvHealthService.getPendingCommands(terminal.id, true)).toEqual([])
    expect(comando('cmd-segundo').status).toBe('CANCELLED')
  })

  it('regresión: después de ejecutada la migración, B sí puede mandarle comandos a SU terminal', async () => {
    const migracion = await empezarMigracionDiferida()
    expect(await permiso(migracion)).toBe(true)

    const { commandId } = await tpvCommandQueueService.queueCommand({
      terminalId: terminal.id,
      venueId: B,
      commandType: 'LOCK',
      requestedBy: 'dueno-b',
    })

    expect(comando(commandId).venueId).toBe(B)
  })
})

describe('migración SIN diferir (TPV vieja): la terminal ya está en B y su borrado va con B', () => {
  it('el latido en B entrega el borrado de la migración (venue B) y NO el LOCK viejo de A', async () => {
    terminal.commandProtocolVersion = null
    const { commandId: lockDeA } = await tpvCommandQueueService.queueCommand({
      terminalId: terminal.id,
      venueId: A,
      commandType: 'LOCK',
      requestedBy: 'dueno-a',
    })
    // Lo que hace `updateTerminal` sin diferir: mueve la terminal y encola su borrado con el venue NUEVO.
    terminal.venueId = B
    const { commandId: borrado } = await tpvCommandQueueService.queueCommand({
      terminalId: terminal.id,
      venueId: B,
      commandType: 'FACTORY_RESET',
      priority: 'CRITICAL',
      requestedBy: 'dueno-org',
      payload: { migration: { fromVenueId: A, previousMerchantIds: [], toVenueId: B } },
    })

    const entregados = await tpvHealthService.getPendingCommands(terminal.id)

    expect(entregados.map(c => c.commandId)).toEqual([borrado])
    expect(comando(lockDeA).status).toBe('CANCELLED')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Ronda 9 (Codex r3, 16-oct): una lectura VIEJA de la ubicación nunca basta para cancelar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * El latido lee el venue de la terminal al empezar. Si mientras corre una migración mueve la terminal (y su borrado, o
 * un comando nuevo del destino) a B, el mismo latido comparaba ese comando de B contra la «A» vieja y lo cancelaba:
 * la terminal quedaba trasladada SIN el borrado que exige el cambio de credenciales de cobro. Ahora el retiro vuelve a
 * exigir la discrepancia ACTUAL dentro de su propio UPDATE, y la entrega sólo ocurre si la terminal está HOY en el
 * venue del comando (el reclamo condicionado). No entregar de más está bien; cancelar de más, no.
 */
describe('Codex r3: el latido atrasado no cancela lo que sí es de la terminal', () => {
  it('🔴 migración SIN diferir a mitad del latido: el borrado de B se entrega (SENT) y NO se cancela', async () => {
    terminal.commandProtocolVersion = null // TPV vieja: la migración no se difiere
    prismaMock.terminal.findUnique.mockImplementationOnce((() => {
      const leida = { ...terminal } // el latido ve la terminal en A…
      // …y justo después, otra petición la migra: la mueve a B y encola su borrado con el venue B (como `updateTerminal`).
      terminal.venueId = B
      comandos.push({
        id: 'cmd-borrado-b',
        correlationId: 'corr-b',
        createdAt: new Date(),
        terminalId: terminal.id,
        venueId: B,
        commandType: 'FACTORY_RESET',
        status: 'QUEUED',
        priority: 'CRITICAL',
        attempts: 0,
        payload: { migration: { fromVenueId: A, previousMerchantIds: [], toVenueId: B } },
        expiresAt: null,
        scheduledFor: null,
        requestedBy: 'dueno-org',
      })
      return Promise.resolve(leida)
    }) as any)

    const entregados = await tpvHealthService.getPendingCommands(terminal.id)

    expect(comando('cmd-borrado-b').status).toBe('SENT')
    expect(entregados.map(c => c.commandId)).toEqual(['cmd-borrado-b'])
    expect(cancelacionesPorTraslado()).toEqual([])
  })

  it('🔴 variante durable: tras el permiso de la migración, un latido con la lectura vieja NO cancela el LOCK que B acaba de encolar', async () => {
    const migracion = await empezarMigracionDiferida()
    expect(await permiso(migracion)).toBe(true) // la terminal ya está en B
    const { commandId: lockDeB } = await tpvCommandQueueService.queueCommand({
      terminalId: terminal.id,
      venueId: B,
      commandType: 'LOCK',
      requestedBy: 'dueno-b',
    })
    // Un latido que leyó la terminal ANTES del traslado (todavía en A) llega tarde.
    prismaMock.terminal.findUnique.mockImplementationOnce((() => Promise.resolve({ ...terminal, venueId: A })) as any)

    const entregados = await tpvHealthService.getPendingCommands(terminal.id, true)

    expect(comando(lockDeB).status).not.toBe('CANCELLED')
    expect(entregados.map(c => c.commandId)).toContain(lockDeB)
    expect(cancelacionesPorTraslado()).toEqual([])
  })

  it('🔴 la entrega por socket con una lectura vieja tampoco cancela: no emite (la terminal ya no está donde leyó) y lo deja para el latido', async () => {
    terminal.commandProtocolVersion = null
    const { commandId } = await tpvCommandQueueService.queueCommand({
      terminalId: terminal.id,
      venueId: A,
      commandType: 'LOCK',
      requestedBy: 'dueno-a',
    })
    // `sendCommandToTerminal` leyó el comando con la terminal en B (lectura vieja de un traslado que se deshizo: la
    // migración se canceló y la terminal regresó a A).
    prismaMock.tpvCommandQueue.findUnique.mockImplementationOnce((({ where }: any) =>
      Promise.resolve({ ...conTerminal(comando(where.id)), terminal: { ...terminal, venueId: B } })) as any)

    await tpvCommandExecutionService.sendCommandToTerminal(commandId)

    expect(comando(commandId).status).not.toBe('CANCELLED')
    expect(cancelacionesPorTraslado()).toEqual([])
    // …y el siguiente latido, con la ubicación de HOY, sí se lo entrega.
    expect((await tpvHealthService.getPendingCommands(terminal.id)).map(c => c.commandId)).toEqual([commandId])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Ronda 10 (Codex r4, 16-oct): con la lectura vieja, un durable legítimo no puede quedar sin despertar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * En la ronda 9 el socket dejó de emitir con cualquier discrepancia LEÍDA (para no cancelar ni emitir a la sala de un
 * venue viejo), pero en el protocolo 2 eso también se saltaba la SUGERENCIA. Los latidos normales no entregan
 * durables (`heartbeat.tpv.controller.ts` los excluye), así que el comando quedaba PENDING, sin vencimiento y sin
 * aviso, hasta otro evento o una reconexión (Codex lo reprodujo con el reintento: 200 y cero avisos). Ahora, si no se
 * retiró, la TPV durable recibe la sugerencia «hay comandos»: sólo la despierta; lo que se entrega lo decide su pull
 * con la ubicación de HOY (reclamo condicionado y permiso).
 */
describe('Codex r4: un durable legítimo con la lectura vieja recibe la sugerencia y se entrega', () => {
  it('🔴 la secuencia de Codex: lectura vieja → NO se cancela, la TPV recibe la sugerencia y su pull lo entrega', async () => {
    const { commandId } = await tpvCommandQueueService.queueCommand({
      terminalId: terminal.id,
      venueId: A,
      commandType: 'LOCK',
      requestedBy: 'dueno-a',
    })
    broadcastTpvCommandMock.mockClear() // la sugerencia del encolado no cuenta: es la del reintento la que se medía
    prismaMock.tpvCommandQueue.findUnique.mockImplementationOnce((({ where }: any) =>
      Promise.resolve({ ...conTerminal(comando(where.id)), terminal: { ...terminal, venueId: B } })) as any)

    await tpvCommandExecutionService.sendCommandToTerminal(commandId)

    expect(comando(commandId).status).not.toBe('CANCELLED')
    expect(broadcastTpvCommandMock).toHaveBeenCalledTimes(1)
    expect(broadcastTpvCommandMock).toHaveBeenCalledWith(
      terminal.serialNumber,
      A,
      expect.objectContaining({ commandId, payload: { _deliveryProtocol: 2 } }),
    )
    // La sugerencia no lleva el comando: la TPV hace su pull durable, que decide con la ubicación de hoy.
    expect((await tpvHealthService.getPendingCommands(terminal.id, true)).map(c => c.commandId)).toEqual([commandId])
    expect(comando(commandId).status).toBe('SENT')
  })

  it('regresión: si la discrepancia es REAL (la terminal ya está en B), el durable de A se retira y NO hay sugerencia', async () => {
    const { commandId } = await tpvCommandQueueService.queueCommand({
      terminalId: terminal.id,
      venueId: A,
      commandType: 'LOCK',
      requestedBy: 'dueno-a',
    })
    broadcastTpvCommandMock.mockClear()
    terminal.venueId = B

    await tpvCommandExecutionService.sendCommandToTerminal(commandId)

    expect(comando(commandId).status).toBe('CANCELLED')
    expect(broadcastTpvCommandMock).not.toHaveBeenCalled()
  })
})
