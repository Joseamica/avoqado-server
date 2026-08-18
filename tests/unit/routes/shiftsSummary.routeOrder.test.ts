/**
 * `GET /venues/:venueId/shifts/summary` must not be shadowed by `/venues/:venueId/shifts/:shiftId`.
 *
 * Bug (VIVO hasta 2026-08-17): en `src/routes/dashboard.routes.ts` la ruta paramétrica `:shiftId`
 * se registraba ANTES que la literal `summary`. Express recorre el stack EN ORDEN DE REGISTRO, así
 * que `/venues/X/shifts/summary` casaba con `:shiftId`, `getShift` llamaba
 * `getShiftById(venueId, 'summary')` y respondía **404 "Shift not found"**. `getShiftsSummary` era
 * código muerto por la vía del dashboard, aunque el endpoint está publicado en el OpenAPI.
 *
 * No se prueba con supertest a propósito: la propiedad que se rompió es de ROUTING puro (qué layer
 * casa primero), así que se interroga el stack real del router con el mismo `Layer.match` que usa
 * Express en producción. Sin mocks, sin red, sin DB.
 *
 * ⚠️ La ruta gemela del TPV es `/venues/:venueId/shifts-summary` (con guion, `tpv.routes.ts`) — NO
 * es un segmento hijo y NUNCA estuvo afectada.
 */
import express from 'express'

import router from '@/routes/dashboard.routes'

const VENUE_ID = 'cme1qzg6o02jxi32bkm2ta66g'

/** El path registrado del PRIMER layer GET que casa con `url` — o sea, el que Express ejecutaría. */
function firstGetMatch(r: any, url: string): string | undefined {
  for (const layer of r.stack ?? []) {
    if (!layer.route || !layer.route.methods?.get) continue
    if (layer.match(url)) return layer.route.path
  }
  return undefined
}

describe('dashboard.routes — orden de registro de shifts/summary', () => {
  it('GET /venues/:venueId/shifts/summary lo atiende la ruta literal, no :shiftId', () => {
    expect(firstGetMatch(router, `/venues/${VENUE_ID}/shifts/summary`)).toBe('/venues/:venueId/shifts/summary')
  })

  it('un shiftId real sigue cayendo en la ruta paramétrica (no se rompió lo que ya servía)', () => {
    expect(firstGetMatch(router, `/venues/${VENUE_ID}/shifts/cshift000000000000000001`)).toBe('/venues/:venueId/shifts/:shiftId')
  })

  it('la ruta literal está registrada ANTES que la paramétrica en el stack', () => {
    const paths = ((router as any).stack ?? []).filter((l: any) => l.route?.methods?.get).map((l: any) => l.route.path)
    const summaryIdx = paths.indexOf('/venues/:venueId/shifts/summary')
    const shiftIdIdx = paths.indexOf('/venues/:venueId/shifts/:shiftId')

    expect(summaryIdx).toBeGreaterThanOrEqual(0)
    expect(shiftIdIdx).toBeGreaterThanOrEqual(0)
    expect(summaryIdx).toBeLessThan(shiftIdIdx)
  })

  // Grupo de control: prueba que la aserción de arriba SÍ detecta el bug. Un router con el orden
  // viejo debe hacer que `summary` caiga en `:shiftId`; si esto dejara de fallar, las aserciones
  // reales no probarían nada.
  it('control: con el orden invertido, summary SÍ queda sombreada', () => {
    const legacy = express.Router()
    legacy.get('/venues/:venueId/shifts/:shiftId', (_req, _res) => undefined)
    legacy.get('/venues/:venueId/shifts/summary', (_req, _res) => undefined)

    expect(firstGetMatch(legacy, `/venues/${VENUE_ID}/shifts/summary`)).toBe('/venues/:venueId/shifts/:shiftId')
  })
})
