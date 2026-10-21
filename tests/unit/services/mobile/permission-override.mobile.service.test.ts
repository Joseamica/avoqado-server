import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as permisos from '@/lib/permissions'
import {
  createPermissionOverride,
  consumePermissionOverride,
  isManagerPinOverrideEnabled,
  OverrideInvalidPinError,
  OverrideInsufficientError,
  OverrideDisabledError,
  OVERRIDE_TTL_MS,
} from '@/services/mobile/permission-override.mobile.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: { findFirst: jest.fn() },
    venueRolePermission: { findUnique: jest.fn() },
    venueSettings: { findUnique: jest.fn() },
    permissionOverride: { create: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const VENUE = 'venue_1'
const NOW = new Date('2026-08-15T18:00:00.000Z')

const managerStaffVenue = {
  id: 'sv_manager',
  role: StaffRole.MANAGER,
  permissionSetId: null,
  permissionSet: null,
  staff: { firstName: 'Laura', lastName: 'Méndez' },
}

const waiterStaffVenue = {
  ...managerStaffVenue,
  id: 'sv_waiter',
  role: StaffRole.WAITER,
  staff: { firstName: 'Beto', lastName: 'Cruz' },
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue(null)
  ;(prisma.permissionOverride.create as jest.Mock).mockImplementation(async ({ data }: any) => data)
  // El switch del venue ENCENDIDO es la precondición de todo el flujo. Los casos
  // con el switch apagado lo sobreescriben explícitamente.
  ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({ managerPinOverrideEnabled: true })
})

/**
 * 🔴 El switch NO es una pista para el cliente: es la puerta.
 *
 * Antes sólo se consultaba para adornar el 403 con `overridable`, así que un
 * venue con la función APAGADA seguía emitiendo y aceptando tokens para quien
 * mandara la petición a mano. "Apagado" tiene que significar apagado en el
 * server, no sólo que el POS deje de ofrecer el teclado.
 */
describe('el switch del venue manda (apagado = apagado)', () => {
  it('con el switch APAGADO no se emite token, aunque el PIN sea de alguien con el permiso', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({ managerPinOverrideEnabled: false })
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(managerStaffVenue)

    await expect(createPermissionOverride({ venueId: VENUE, pin: '1234', permission: 'orders:merge', now: NOW })).rejects.toBeInstanceOf(
      OverrideDisabledError,
    )
    expect(prisma.permissionOverride.create).not.toHaveBeenCalled()
  })

  it('con el switch APAGADO un token ya emitido tampoco se consume', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({ managerPinOverrideEnabled: false })
    ;(prisma.permissionOverride.updateMany as jest.Mock).mockResolvedValue({ count: 1 })

    const result = await consumePermissionOverride({
      token: 'tok_1',
      venueId: VENUE,
      permission: 'orders:merge',
      route: 'POST /api/v1/mobile/venues/:venueId/orders/:orderId/merge',
      now: NOW,
    })

    expect(result).toBeNull()
    // No basta con devolver null: el token NO puede quedar marcado como usado,
    // o apagar el switch quemaría los tokens vivos de quien sí los pidió antes.
    expect(prisma.permissionOverride.updateMany).not.toHaveBeenCalled()
  })

  /**
   * 🔴 "Este PIN es de alguien que TODAVÍA trabaja aquí" tiene que significar lo
   * mismo aquí que en el reloj checador. `time-entry.mobile.service.ts` exige
   * las DOS banderas (StaffVenue.active y staff.active) en sus cinco búsquedas;
   * si aquí sólo se mira la primera, a un gerente dado de baja a nivel Staff se
   * le impide checar entrada pero su código sigue autorizando reembolsos.
   */
  it('el PIN sólo cuenta si la persona sigue activa TAMBIÉN como empleado', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(managerStaffVenue)

    await createPermissionOverride({ venueId: VENUE, pin: '1234', permission: 'orders:merge', now: NOW })

    expect(prisma.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          venueId: VENUE,
          pin: '1234',
          active: true,
          staff: { active: true },
        }),
      }),
    )
  })

  it('si la lectura del switch falla, se cierra la puerta (fail-closed)', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockRejectedValue(new Error('db caída'))
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(managerStaffVenue)

    await expect(createPermissionOverride({ venueId: VENUE, pin: '1234', permission: 'orders:merge', now: NOW })).rejects.toBeInstanceOf(
      OverrideDisabledError,
    )
  })
})

describe('createPermissionOverride', () => {
  // 1. NUEVO
  it('PIN que no existe en el venue → OverrideInvalidPinError', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(null)
    await expect(createPermissionOverride({ venueId: VENUE, pin: '9999', permission: 'orders:merge', now: NOW })).rejects.toBeInstanceOf(
      OverrideInvalidPinError,
    )
    expect(prisma.permissionOverride.create).not.toHaveBeenCalled()
  })

  it('PIN correcto pero SIN ese permiso → OverrideInsufficientError', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(waiterStaffVenue)
    await expect(createPermissionOverride({ venueId: VENUE, pin: '1234', permission: 'orders:merge', now: NOW })).rejects.toBeInstanceOf(
      OverrideInsufficientError,
    )
    expect(prisma.permissionOverride.create).not.toHaveBeenCalled()
  })

  it('🔴 el rechazo por insuficiencia dice de QUIÉN era el código — es lo que se audita', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(waiterStaffVenue)
    await expect(createPermissionOverride({ venueId: VENUE, pin: '1234', permission: 'orders:merge', now: NOW })).rejects.toMatchObject({
      code: 'OVERRIDE_INSUFFICIENT',
      authorizer: { staffVenueId: 'sv_waiter', role: StaffRole.WAITER },
    })
  })

  it('PIN correcto CON el permiso → token de 60 s atado a ese permiso y venue', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(managerStaffVenue)
    const result = await createPermissionOverride({
      venueId: VENUE,
      pin: '1234567890',
      permission: 'orders:merge',
      requestedById: 'sv_waiter',
      now: NOW,
    })
    expect(result.token).toEqual(expect.any(String))
    expect(result.token.length).toBeGreaterThan(20)
    expect(result.expiresAt.getTime()).toBe(NOW.getTime() + OVERRIDE_TTL_MS)
    expect(result.authorizedBy).toEqual({ id: 'sv_manager', name: 'Laura Méndez' })
    expect(prisma.permissionOverride.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        venueId: VENUE,
        permission: 'orders:merge',
        authorizedById: 'sv_manager',
        requestedById: 'sv_waiter',
      }),
    })
  })

  it('busca sólo empleados ACTIVOS de ESE venue', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(managerStaffVenue)
    await createPermissionOverride({ venueId: VENUE, pin: '1234', permission: 'orders:merge', now: NOW })
    expect(prisma.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: VENUE, pin: '1234', active: true }) }),
    )
  })

  it('respeta un permissionSet asignado en vez del rol', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({
      ...waiterStaffVenue,
      permissionSetId: 'ps_1',
      permissionSet: { permissions: ['orders:read', 'orders:update', 'orders:merge'] },
    })
    const result = await createPermissionOverride({ venueId: VENUE, pin: '1111', permission: 'orders:merge', now: NOW })
    expect(result.authorizedBy.id).toBe('sv_waiter')
    // El permissionSet MANDA: ni siquiera se consulta VenueRolePermission.
    expect(prisma.venueRolePermission.findUnique).not.toHaveBeenCalled()
  })

  it('un permissionSet SIN el permiso sigue siendo insuficiente', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({
      ...waiterStaffVenue,
      permissionSetId: 'ps_1',
      permissionSet: { permissions: ['orders:read', 'orders:update'] },
    })
    await expect(createPermissionOverride({ venueId: VENUE, pin: '1111', permission: 'orders:merge', now: NOW })).rejects.toBeInstanceOf(
      OverrideInsufficientError,
    )
  })

  it('🔴 un VenueRolePermission del venue que SÍ concede el permiso alcanza — mismo camino que checkPermission', async () => {
    // Sin conjunto asignado, la puerta mira VenueRolePermission + rol. Un venue
    // que le dio orders:merge a sus meseros debe poder autorizar con ese PIN:
    // si aquí resolviéramos distinto, el PIN se aceptaría (o se rechazaría) y
    // luego la acción haría lo contrario.
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(waiterStaffVenue)
    ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue({
      permissions: ['orders:read', 'orders:update', 'orders:merge'],
    })
    const result = await createPermissionOverride({ venueId: VENUE, pin: '1234', permission: 'orders:merge', now: NOW })
    expect(result.authorizedBy.id).toBe('sv_waiter')
    expect(prisma.venueRolePermission.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId_role: { venueId: VENUE, role: StaffRole.WAITER } } }),
    )
  })

  /**
   * 🔴 Codex (B3b, código r1, P1 #2): el negocio le puede QUITAR a un rol un permiso de fábrica
   * (`VenueRolePermission.deniedPermissions`). `checkPermission` respeta esa exclusión, así que el ADMIN recibe 403
   * sin PIN. Si aquí se ignorara, ese mismo ADMIN tecleaba SU PROPIO PIN, obtenía un token del permiso que le
   * quitaron y pasaba el middleware con él: el PIN devolvía lo que el dueño retiró a propósito.
   */
  describe('respeta lo que el negocio le QUITÓ al rol (deniedPermissions)', () => {
    const adminStaffVenue = {
      ...managerStaffVenue,
      id: 'sv_admin',
      role: StaffRole.ADMIN,
      staff: { firstName: 'Ana', lastName: 'Admin' },
    }

    it('🔴 un ADMIN al que le quitaron cfdi:configure NO emite un token de ese permiso con su propio PIN', async () => {
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(adminStaffVenue)
      ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue({ permissions: [], deniedPermissions: ['cfdi:configure'] })

      await expect(createPermissionOverride({ venueId: VENUE, pin: '4321', permission: 'cfdi:configure', now: NOW })).rejects.toMatchObject(
        { code: 'OVERRIDE_INSUFFICIENT', authorizer: { staffVenueId: 'sv_admin', role: StaffRole.ADMIN } },
      )
      expect(prisma.permissionOverride.create).not.toHaveBeenCalled()
    })

    it('la exclusión de UN permiso no le quita al ADMIN los demás: su PIN sigue autorizando lo que conserva', async () => {
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(adminStaffVenue)
      ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue({ permissions: [], deniedPermissions: ['cfdi:configure'] })

      const result = await createPermissionOverride({ venueId: VENUE, pin: '4321', permission: 'cfdi:issue', now: NOW })
      expect(result.authorizedBy.id).toBe('sv_admin')
    })

    it('un ADMIN SIN exclusiones sí emite el token de cfdi:configure (control: el rechazo de arriba es la exclusión)', async () => {
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(adminStaffVenue)
      ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue({ permissions: [], deniedPermissions: [] })

      const result = await createPermissionOverride({ venueId: VENUE, pin: '4321', permission: 'cfdi:configure', now: NOW })
      expect(result.authorizedBy.id).toBe('sv_admin')
      expect(prisma.permissionOverride.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ permission: 'cfdi:configure', authorizedById: 'sv_admin' }),
      })
    })

    /**
     * 🔴 Codex (B3b, código r2, N1): aplicar exclusiones re-resuelve dependencias, así que la lectura CON exclusiones
     * podía conceder algo que la lectura SIN ellas negaba. El caso real: excluir `scale:use` abría el comodín `scale:*`
     * del ADMIN y la dependencia de `scale:configure` le AGREGABA `tpv-settings:*`, que entonces no tenía.
     *
     * Ese camino ya no existe en el catálogo: desde el 15-oct el ADMIN trae `tpv-settings` de fábrica (decisión del
     * founder), y `tests/unit/lib/permissions.tpvSettingsAdmin.test.ts` cuida que ninguna exclusión vuelva a habilitar
     * nada en ningún rol. Pero el PIN sigue exigiendo las DOS lecturas (sin y con exclusiones), y esa defensa se prueba
     * aquí simulando que divergen: si un cambio futuro del catálogo reabre un camino así, el PIN no lo convierte en token.
     */
    describe('el PIN exige las dos lecturas (sin y con exclusiones)', () => {
      afterEach(() => jest.restoreAllMocks())

      it('🔴 si sólo la lectura CON exclusiones concede, NO se emite token', async () => {
        ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(adminStaffVenue)
        ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue({ permissions: [], deniedPermissions: ['scale:use'] })
        const leeConExclusiones = jest
          .spyOn(permisos, 'hasPermission')
          .mockImplementation((_rol, _custom, _permiso, excluidos) => Boolean(excluidos && excluidos.length > 0))

        await expect(
          createPermissionOverride({ venueId: VENUE, pin: '4321', permission: 'cfdi:configure', now: NOW }),
        ).rejects.toBeInstanceOf(OverrideInsufficientError)
        expect(leeConExclusiones).toHaveBeenCalledWith(StaffRole.ADMIN, [], 'cfdi:configure')
        expect(prisma.permissionOverride.create).not.toHaveBeenCalled()
      })

      it('🔴 si sólo la lectura SIN exclusiones concede, tampoco', async () => {
        ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(adminStaffVenue)
        ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue({ permissions: [], deniedPermissions: ['scale:use'] })
        jest.spyOn(permisos, 'hasPermission').mockImplementation((_rol, _custom, _permiso, excluidos) => !excluidos)

        await expect(
          createPermissionOverride({ venueId: VENUE, pin: '4321', permission: 'cfdi:configure', now: NOW }),
        ).rejects.toBeInstanceOf(OverrideInsufficientError)
        expect(prisma.permissionOverride.create).not.toHaveBeenCalled()
      })

      it('control: si las dos conceden, se emite', async () => {
        ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(adminStaffVenue)
        ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue({ permissions: [], deniedPermissions: ['scale:use'] })
        jest.spyOn(permisos, 'hasPermission').mockReturnValue(true)

        const result = await createPermissionOverride({ venueId: VENUE, pin: '4321', permission: 'cfdi:configure', now: NOW })
        expect(result.authorizedBy.id).toBe('sv_admin')
      })
    })

    it.each(['tpv-settings:read', 'tpv-settings:update'])(
      'el ADMIN ya trae %s de fábrica (15-oct): su PIN lo autoriza, con o sin la exclusión de scale:use',
      async permiso => {
        for (const deniedPermissions of [[], ['scale:use']]) {
          jest.clearAllMocks()
          ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(adminStaffVenue)
          ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue({ permissions: [], deniedPermissions })
          ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({ managerPinOverrideEnabled: true })
          ;(prisma.permissionOverride.create as jest.Mock).mockImplementation(async ({ data }: any) => data)

          const result = await createPermissionOverride({ venueId: VENUE, pin: '4321', permission: permiso, now: NOW })
          expect(result.authorizedBy.id).toBe('sv_admin')
        }
      },
    )
  })
})

describe('consumePermissionOverride', () => {
  it('consume con un update ATÓMICO que exige sin usar y sin expirar', async () => {
    ;(prisma.permissionOverride.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prisma.permissionOverride.findUnique as jest.Mock).mockResolvedValue({ authorizedById: 'sv_manager' })

    const result = await consumePermissionOverride({
      token: 'tok_1',
      venueId: VENUE,
      permission: 'orders:merge',
      route: 'POST /api/v1/mobile/venues/:venueId/orders/:orderId/merge',
      now: NOW,
    })

    expect(result).toEqual({ authorizedById: 'sv_manager' })
    expect(prisma.permissionOverride.updateMany).toHaveBeenCalledWith({
      where: {
        token: 'tok_1',
        venueId: VENUE,
        permission: 'orders:merge',
        consumedAt: null,
        expiresAt: { gt: NOW },
      },
      data: { consumedAt: NOW, consumedRoute: 'POST /api/v1/mobile/venues/:venueId/orders/:orderId/merge' },
    })
  })

  it('🔴 A3 (cierre): consumedRoute se guarda SIN query string (un código de tarjeta en la URL no llega a la base)', async () => {
    ;(prisma.permissionOverride.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prisma.permissionOverride.findUnique as jest.Mock).mockResolvedValue({ authorizedById: 'sv_manager' })
    await consumePermissionOverride({
      token: 'tok_q',
      venueId: VENUE,
      permission: 'giftCards:read',
      route: 'GET /api/v1/mobile/venues/v1/gift-cards/lookup?code=K7QZ-ABCD-EFGH-JKMN-P',
      now: NOW,
    })
    expect((prisma.permissionOverride.updateMany as jest.Mock).mock.calls[0][0].data.consumedRoute).toBe(
      'GET /api/v1/mobile/venues/v1/gift-cards/lookup',
    )
  })

  it('🔴 segundo consumo del MISMO token → null (count 0 = otro ganó la carrera)', async () => {
    ;(prisma.permissionOverride.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
    const result = await consumePermissionOverride({
      token: 'tok_1',
      venueId: VENUE,
      permission: 'orders:merge',
      route: 'r',
      now: NOW,
    })
    expect(result).toBeNull()
    expect(prisma.permissionOverride.findUnique).not.toHaveBeenCalled()
  })

  it('un token de OTRO permiso no sirve', async () => {
    ;(prisma.permissionOverride.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
    const result = await consumePermissionOverride({
      token: 'tok_1',
      venueId: VENUE,
      permission: 'payments:refund',
      route: 'r',
      now: NOW,
    })
    expect(result).toBeNull()
  })

  it('un token de OTRO venue no sirve', async () => {
    ;(prisma.permissionOverride.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
    const result = await consumePermissionOverride({
      token: 'tok_1',
      venueId: 'venue_2',
      permission: 'orders:merge',
      route: 'r',
      now: NOW,
    })
    expect(result).toBeNull()
  })

  it('nunca lanza si la base falla al consumir — el 403 de siempre gana', async () => {
    ;(prisma.permissionOverride.updateMany as jest.Mock).mockRejectedValue(new Error('db down'))
    await expect(
      consumePermissionOverride({ token: 'tok_1', venueId: VENUE, permission: 'orders:merge', route: 'r', now: NOW }),
    ).resolves.toBeNull()
  })
})

describe('isManagerPinOverrideEnabled', () => {
  it('true cuando el switch del venue está ON', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({ managerPinOverrideEnabled: true })
    await expect(isManagerPinOverrideEnabled(VENUE)).resolves.toBe(true)
  })

  it('false cuando está OFF', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({ managerPinOverrideEnabled: false })
    await expect(isManagerPinOverrideEnabled(VENUE)).resolves.toBe(false)
  })

  it('false — y NUNCA lanza — si el venue no tiene fila de settings', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue(null)
    await expect(isManagerPinOverrideEnabled(VENUE)).resolves.toBe(false)
  })

  it('false — y NUNCA lanza — si la consulta revienta', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockRejectedValue(new Error('db down'))
    await expect(isManagerPinOverrideEnabled(VENUE)).resolves.toBe(false)
  })
})
