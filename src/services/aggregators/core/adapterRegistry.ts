import { PassAdapter, Provider } from './types'
import { totalPassAdapter } from '../providers/totalpass/totalpass.adapter'

/** Único archivo del núcleo que nombra proveedores (guardia en adapterRegistry.test.ts). */
const ADAPTERS: Partial<Record<Provider, PassAdapter>> = {
  TOTALPASS: totalPassAdapter,
}

export function hasAdapter(p: Provider): boolean {
  return Boolean(ADAPTERS[p])
}

export function adapterFor(p: Provider): PassAdapter {
  const a = ADAPTERS[p]
  if (!a) throw new Error(`No hay adaptador para el proveedor "${p}" todavía`)
  return a
}
