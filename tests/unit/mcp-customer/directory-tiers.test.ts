import { DIRECTORY_TIERS, directoryToolsForTier, parseDirectoryTier } from '@/mcp/directory/catalog'

// El catálogo de directorio crece por tandas detrás de MCP_DIRECTORY_TIER: lo que ya está publicado no cambia
// hasta que se sube el nivel en el entorno, y bajarlo revierte sin cambiar código (Render reinicia el proceso).
describe('tandas del catálogo de directorio', () => {
  it('sin variable, vacía o inválida, sólo expone la tanda base', () => {
    for (const raw of [undefined, '', 'abc', '-1', '1.5']) expect(parseDirectoryTier(raw)).toBe(0)
  })

  it('un nivel mayor que las tandas existentes se acota a la última', () => {
    expect(parseDirectoryTier('99')).toBe(DIRECTORY_TIERS.length - 1)
  })

  it('cada nivel incluye las tandas anteriores completas y nada más', () => {
    expect([...directoryToolsForTier(0)].sort()).toEqual([...DIRECTORY_TIERS[0].tools].sort())
    for (let n = 1; n < DIRECTORY_TIERS.length; n++) {
      const expected = DIRECTORY_TIERS.slice(0, n + 1).flatMap(t => t.tools)
      expect([...directoryToolsForTier(n)].sort()).toEqual([...expected].sort())
    }
  })

  it('ninguna herramienta aparece en dos tandas', () => {
    const all = DIRECTORY_TIERS.flatMap(t => t.tools)
    expect(all.length).toBe(new Set(all).size)
  })

  it('la tanda base conserva las 33 herramientas publicadas', () => {
    expect(DIRECTORY_TIERS[0].tools.length).toBe(33)
  })
})
