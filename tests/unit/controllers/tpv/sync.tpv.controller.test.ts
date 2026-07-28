/**
 * sync.tpv.controller — el TPV está aislado a /api/v1/tpv/* y nunca llama a /mobile
 * (Plan B Task 3, 2026-07-27). El reducer de intents offline (sync.mobile.service.ts)
 * es la ÚNICA fuente de verdad del replay: si /tpv tuviera su propia copia del
 * controller/handler, los dos namespaces divergirían en silencio (P1 real class of bug
 * — ver .claude/rules/offline-first-y-hub-lan.md). Este test pin-ea la reexportación
 * literal, no una reimplementación con el mismo comportamiento superficial.
 */
import * as syncTpvController from '../../../../src/controllers/tpv/sync.tpv.controller'
import * as syncMobileController from '../../../../src/controllers/mobile/sync.mobile.controller'

describe('sync.tpv.controller', () => {
  // NEW FEATURE TEST
  it('delega en el MISMO reducer que /mobile (reexportación, no una copia)', () => {
    // El reducer es la unica fuente de verdad del replay offline. Si /tpv tuviera
    // su propia copia, los dos namespaces divergirian en silencio.
    expect(syncTpvController.syncIntents).toBe(syncMobileController.syncIntents)
  })

  // REGRESSION TEST — evita un import roto o un default-export accidental que
  // pasaría la comparación `.toBe` de arriba solo si ambos lados quedaran `undefined`.
  it('el handler exportado es una función real (no undefined)', () => {
    expect(typeof syncTpvController.syncIntents).toBe('function')
  })
})
