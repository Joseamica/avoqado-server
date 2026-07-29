import { DeviceFormFactor } from '@prisma/client'

import { DEVICE_CATALOG, resolveBrand, resolveDeviceModel } from '../../../src/config/deviceCatalog'

describe('deviceCatalog', () => {
  // ── FEATURE: resolución por catálogo ──────────────────────────────────────────
  describe('resolveDeviceModel — dispositivos catalogados', () => {
    it('traduce un identificador de iPhone a su nombre comercial', () => {
      expect(resolveDeviceModel('Apple', 'iPhone16,2')).toEqual({
        brand: 'Apple',
        model: 'iPhone 15 Pro Max',
        formFactor: DeviceFormFactor.PHONE,
      })
    })

    it('marca un iPad como TABLET, no como PHONE', () => {
      const result = resolveDeviceModel('Apple', 'iPad14,1')
      expect(result.model).toBe('iPad mini (6ª gen)')
      expect(result.formFactor).toBe(DeviceFormFactor.TABLET)
    })

    it('reconoce la PAX A910S como POS de mano', () => {
      expect(resolveDeviceModel('PAX', 'A910S')).toEqual({
        brand: 'PAX',
        model: 'PAX A910S',
        formFactor: DeviceFormFactor.HANDHELD_POS,
      })
    })

    it('reconoce el Sunmi D3 Mini como POS de mostrador', () => {
      const result = resolveDeviceModel('SUNMI', 'D3_MINI')
      expect(result.model).toBe('Sunmi D3 Mini')
      expect(result.formFactor).toBe(DeviceFormFactor.COUNTERTOP_POS)
    })

    it('ignora mayúsculas, guiones y underscores al buscar en el catálogo', () => {
      const canonical = resolveDeviceModel('SUNMI', 'D3_MINI')
      expect(resolveDeviceModel('sunmi', 'd3-mini')).toEqual(canonical)
      expect(resolveDeviceModel('  Sunmi  ', 'D3 MINI')).toEqual(canonical)
    })
  })

  // ── FEATURE: fallback (el caso que más se va a dar en Android) ─────────────────
  describe('resolveDeviceModel — fallback para modelos no catalogados', () => {
    it('arma un nombre legible con fabricante + identificador crudo', () => {
      const result = resolveDeviceModel('samsung', 'SM-X710')
      expect(result.brand).toBe('Samsung')
      expect(result.model).toBe('Samsung SM-X710')
    })

    it('NUNCA devuelve un modelo vacío, ni sin fabricante ni sin identificador', () => {
      expect(resolveDeviceModel('', '').model).not.toBe('')
      expect(resolveDeviceModel(null, null).model).not.toBe('')
      expect(resolveDeviceModel(undefined, undefined).model).not.toBe('')
      expect(resolveDeviceModel('Xiaomi', '').model).toBe('Xiaomi')
      expect(resolveDeviceModel('', 'SM-X710').model).toBe('SM-X710')
    })

    it('no repite la marca cuando el identificador ya la trae', () => {
      // Un fabricante que reporta "Sunmi V3" como model no debe salir "Sunmi Sunmi V3".
      expect(resolveDeviceModel('Sunmi', 'Sunmi V3').model).toBe('Sunmi V3')
    })

    it('usa el form factor que manda el cliente cuando el modelo no está catalogado', () => {
      const result = resolveDeviceModel('samsung', 'SM-X710', DeviceFormFactor.TABLET)
      expect(result.formFactor).toBe(DeviceFormFactor.TABLET)
    })

    it('cae a UNKNOWN si no hay catálogo, ni pista del cliente, ni default por marca', () => {
      expect(resolveDeviceModel('MarcaRara', 'MODELO-999').formFactor).toBe(DeviceFormFactor.UNKNOWN)
    })

    it('un Sunmi no catalogado sigue siendo POS, no un teléfono cualquiera', () => {
      // Esto es lo que evita que hardware POS nuevo aparezca como "desconocido".
      expect(resolveDeviceModel('SUNMI', 'MODELO-QUE-NO-EXISTE-AUN').formFactor).toBe(DeviceFormFactor.COUNTERTOP_POS)
      expect(resolveDeviceModel('PAX', 'A77').formFactor).toBe(DeviceFormFactor.HANDHELD_POS)
    })

    it('la pista del cliente gana sobre el default por fabricante', () => {
      const result = resolveDeviceModel('SUNMI', 'MODELO-NUEVO', DeviceFormFactor.HANDHELD_POS)
      expect(result.formFactor).toBe(DeviceFormFactor.HANDHELD_POS)
    })

    it('el catálogo gana sobre la pista del cliente (lo específico manda)', () => {
      // Si el cliente se equivoca al detectar, la entrada catalogada corrige.
      const result = resolveDeviceModel('Apple', 'iPad14,1', DeviceFormFactor.PHONE)
      expect(result.formFactor).toBe(DeviceFormFactor.TABLET)
    })
  })

  // ── FEATURE: nombre presentable del fabricante ────────────────────────────────
  describe('resolveBrand', () => {
    it('normaliza fabricantes que el SO reporta en minúsculas', () => {
      expect(resolveBrand('samsung')).toBe('Samsung')
      expect(resolveBrand('motorola')).toBe('Motorola')
    })

    it('respeta el capitalizado propio de la marca', () => {
      expect(resolveBrand('NEXGO')).toBe('NexGo')
      expect(resolveBrand('PAX')).toBe('PAX')
      expect(resolveBrand('oneplus')).toBe('OnePlus')
    })

    it('capitaliza marcas desconocidas en vez de dejarlas gritando', () => {
      expect(resolveBrand('MARCARARA')).toBe('Marcarara')
    })
  })

  // ── REGRESIÓN / integridad del catálogo ───────────────────────────────────────
  describe('integridad del catálogo', () => {
    it('ninguna entrada tiene brand o model vacío', () => {
      for (const [key, entry] of Object.entries(DEVICE_CATALOG)) {
        expect(entry.brand.length).toBeGreaterThan(0)
        expect(entry.model.length).toBeGreaterThan(0)
        expect(key).toContain('|')
      }
    })

    it('ninguna entrada usa UNKNOWN — si está catalogado, sabemos qué es', () => {
      for (const entry of Object.values(DEVICE_CATALOG)) {
        expect(entry.formFactor).not.toBe(DeviceFormFactor.UNKNOWN)
      }
    })

    it('todo form factor del catálogo es un valor válido del enum de Prisma', () => {
      const valid = Object.values(DeviceFormFactor)
      for (const entry of Object.values(DEVICE_CATALOG)) {
        expect(valid).toContain(entry.formFactor)
      }
    })
  })
})
