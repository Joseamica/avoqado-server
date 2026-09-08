/**
 * Hallazgo #6 de la auditoría de Codex (29-ago-2026): **un token del MCP de sólo lectura podía
 * autorizar dinero de nómina.**
 *
 * El tool exigía `attendance:manage` (permiso de NEGOCIO) correctamente, pero el scope OAuth
 * `mcp:write` sólo se exige cuando `MCP_ENFORCE_WRITE_SCOPE=true`, y de fábrica está en
 * observar-y-permitir. Ese default es deliberado y correcto para el catálogo general — no para
 * nómina.
 */
import { requireWriteScopeAlways } from '@/mcp/requireWriteScopeAlways'
import { ScopeError } from '@/mcp/errors'
import type { McpScope } from '@/mcp/scope'

function scopeCon(scopes: string[] | undefined): McpScope {
  return {
    staffId: 'staff-1',
    activeOrg: 'org-1',
    allowedVenueIds: ['v1'],
    perVenueAccess: new Map(),
    scopes,
  } as unknown as McpScope
}

const ANTES = process.env.MCP_ENFORCE_WRITE_SCOPE
afterEach(() => {
  if (ANTES === undefined) delete process.env.MCP_ENFORCE_WRITE_SCOPE
  else process.env.MCP_ENFORCE_WRITE_SCOPE = ANTES
})

describe('requireWriteScopeAlways', () => {
  it('🔴 un token de SÓLO LECTURA se rechaza aunque el interruptor esté APAGADO', () => {
    delete process.env.MCP_ENFORCE_WRITE_SCOPE // el default de producción
    expect(() => requireWriteScopeAlways(scopeCon(['mcp:read']), 'attendance:manage')).toThrow(ScopeError)
  })

  it('…y también con el interruptor explícitamente en false', () => {
    process.env.MCP_ENFORCE_WRITE_SCOPE = 'false'
    expect(() => requireWriteScopeAlways(scopeCon(['mcp:read']), 'attendance:manage')).toThrow(ScopeError)
  })

  it('el mensaje dice POR QUÉ, no un código', () => {
    expect(() => requireWriteScopeAlways(scopeCon(['mcp:read']), 'attendance:manage')).toThrow(/solo lectura/i)
    // El motivo lo pone QUIEN LLAMA (7-sep-2026). Antes era un texto fijo sobre nómina dentro del
    // guard, y eso mentía en cuanto lo reusó otra tool: `terminals.ts` ya recibía "mueve dinero de
    // nómina" al cerrar sesiones de una terminal, y campañas iba a recibirlo al pausar una
    // felicitación de cumpleaños. Aquí se fija el mensaje REAL que produce la tool de nómina.
    expect(() => requireWriteScopeAlways(scopeCon(['mcp:read']), 'attendance:manage', 'mueve dinero de nómina')).toThrow(/nómina/i)
  })

  it('🔴 sin motivo el mensaje sigue explicando, no cae a un código — pero NO inventa que es nómina', () => {
    // El default es genérico A PROPÓSITO: un default que hablara de nómina volvería a mentirle al
    // siguiente que use este guard, que es exactamente el defecto que se corrigió.
    expect(() => requireWriteScopeAlways(scopeCon(['mcp:read']), 'tpv:update')).toThrow(/escritura sensible/i)
    expect(() => requireWriteScopeAlways(scopeCon(['mcp:read']), 'tpv:update')).not.toThrow(/nómina/i)
  })

  it('con mcp:write pasa', () => {
    expect(() => requireWriteScopeAlways(scopeCon(['mcp:read', 'mcp:write']), 'attendance:manage')).not.toThrow()
  })

  it('🔴 un token SIN scopes declarados conserva acceso (desarrollo y legacy) — igual que el guard general', () => {
    // Si esto cambiara, el servidor de desarrollo y las conexiones viejas dejarían de funcionar
    // de golpe. La excepción es la MISMA que hace `enforceWriteScope`, a propósito.
    expect(() => requireWriteScopeAlways(scopeCon(undefined), 'attendance:manage')).not.toThrow()
  })

  it('una lista de scopes VACÍA sí se rechaza (declaró scopes y no trae write)', () => {
    expect(() => requireWriteScopeAlways(scopeCon([]), 'attendance:manage')).toThrow(ScopeError)
  })
})

describe('el tool approve_overtime lo usa', () => {
  it('🔴 llama a requireWriteScopeAlways — prueba estática para que nadie lo quite', () => {
    // Es estática a propósito: montar el servidor MCP entero en una prueba unitaria costaría
    // más de lo que aporta, y lo que importa aquí es que la llamada NO desaparezca.
    const fs = require('fs')
    const path = require('path')
    const fuente = fs.readFileSync(path.join(__dirname, '../../../src/mcp/tools/staff.ts'), 'utf8')
    const bloque = fuente.slice(fuente.indexOf("'approve_overtime'"), fuente.indexOf("'venue_attendance'"))
    expect(bloque).toContain('requireWriteScopeAlways')
    expect(bloque).toContain("guard.requirePermission('attendance:manage'")
  })

  it('attendance_payroll_summary NO lo usa: leer sigue siendo lectura', () => {
    const fs = require('fs')
    const path = require('path')
    const fuente = fs.readFileSync(path.join(__dirname, '../../../src/mcp/tools/staff.ts'), 'utf8')
    const bloque = fuente.slice(fuente.indexOf("'attendance_payroll_summary'"), fuente.indexOf("'approve_overtime'"))
    expect(bloque).not.toContain('requireWriteScopeAlways')
  })
})
