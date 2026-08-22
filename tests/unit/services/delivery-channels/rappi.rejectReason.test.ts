/**
 * Nuestro motivo de rechazo → el de Rappi.
 *
 * El hallazgo que originó este módulo: el catálogo de Rappi es sobre el PEDIDO estando mal, no
 * sobre la tienda no pudiendo. No hay "estoy saturado".
 */
import { aMotivoRappi } from '../../../../src/services/delivery-channels/providers/rappi/rappi.rejectReason'

describe('aMotivoRappi', () => {
  // ── Lo que Rappi simplemente NO admite ────────────────────────────────────────────
  it.each(['TOO_BUSY', 'STORE_CLOSED'] as const)('🔴 "%s" NO es un rechazo en Rappi: se pausa la tienda', motivo => {
    const r = aMotivoRappi(motivo)
    expect(r.rechazable).toBe(false)
    if (!r.rechazable) {
      expect(r.motivo).toBe('PAUSAR_EN_VEZ_DE_RECHAZAR')
      // El texto tiene que explicar el PORQUÉ, no sólo negar: quien lo lee está decidiendo
      // qué hacer con un pedido que ya tiene el reloj corriendo.
      expect(r.explicacion).toMatch(/pausa/i)
    }
  })

  // Rechazar cuenta contra la tasa de éxito del 98% que Rappi exige; pausar no. Mapear
  // "estoy saturado" a la fuerza ensuciaría justo la métrica con la que deciden si nos
  // dejan seguir conectados.
  it('🔴 no inventa un motivo falso para poder rechazar de todos modos', () => {
    expect(aMotivoRappi('TOO_BUSY', { itemIds: ['1'] }).rechazable).toBe(false)
  })

  // ── Lo que sí se traduce ──────────────────────────────────────────────────────────
  it('"se acabó" → ITEM_OUT_OF_STOCK, señalando cuáles renglones', () => {
    expect(aMotivoRappi('OUT_OF_ITEMS', { itemIds: ['2089918083'], itemSkus: ['1234'] })).toMatchObject({
      rechazable: true,
      cuerpo: { cancel_type: 'ITEM_OUT_OF_STOCK', items_ids: ['2089918083'], items_skus: ['1234'] },
    })
  })

  // ── El guardrail que evita un 400 ─────────────────────────────────────────────────
  // Los tres motivos ITEM_* EXIGEN señalar los renglones. Mandarlos sin items da 400 — y un
  // rechazo que falla deja el pedido VIVO, con su reloj corriendo, mientras la cocina cree
  // que ya lo soltó.
  it('🔴 sin renglones que señalar DEGRADA el motivo en vez de mandar una llamada que falla', () => {
    const r = aMotivoRappi('OUT_OF_ITEMS')
    expect(r.rechazable).toBe(true)
    if (r.rechazable) {
      expect(r.cuerpo.cancel_type).toBe('ORDER_MISSING_INFORMATION')
      expect(r.cuerpo.items_ids).toBeUndefined()
    }
  })

  it('con un solo tipo de identificador basta', () => {
    const soloIds = aMotivoRappi('OUT_OF_ITEMS', { itemIds: ['1'] })
    if (soloIds.rechazable) expect(soloIds.cuerpo.cancel_type).toBe('ITEM_OUT_OF_STOCK')
    const soloSkus = aMotivoRappi('OUT_OF_ITEMS', { itemSkus: ['abc'] })
    if (soloSkus.rechazable) expect(soloSkus.cuerpo.cancel_type).toBe('ITEM_OUT_OF_STOCK')
  })

  it('ignora identificadores vacíos: una lista de basura no cuenta como señalar', () => {
    const r = aMotivoRappi('OUT_OF_ITEMS', { itemIds: ['', ''] })
    if (r.rechazable) expect(r.cuerpo.cancel_type).toBe('ORDER_MISSING_INFORMATION')
  })

  it('"otro" y sin motivo caen a ORDER_MISSING_INFORMATION, que no exige renglones', () => {
    for (const m of ['OTHER', undefined] as const) {
      const r = aMotivoRappi(m)
      if (r.rechazable) expect(r.cuerpo.cancel_type).toBe('ORDER_MISSING_INFORMATION')
    }
  })

  // `reason` lo lee una PERSONA del otro lado.
  it('el texto libre nunca sale vacío ni con el nombre del enum', () => {
    const r = aMotivoRappi('OUT_OF_ITEMS', { itemIds: ['1'] })
    if (r.rechazable) {
      expect(r.cuerpo.reason.length).toBeGreaterThan(3)
      expect(r.cuerpo.reason).not.toMatch(/^[A-Z_]+$/)
    }
  })

  it('respeta un texto propio cuando quien llama lo da', () => {
    const r = aMotivoRappi('OUT_OF_ITEMS', { itemIds: ['1'], texto: 'Se acabó el pastor' })
    if (r.rechazable) expect(r.cuerpo.reason).toBe('Se acabó el pastor')
  })
})
