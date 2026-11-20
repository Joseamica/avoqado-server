/**
 * Congela `value` y todo objeto o arreglo que cuelga de él, por sus propiedades de datos. Las funciones se quedan como están: no
 * guardan texto, y pueden ser de otro módulo o un `jest.fn`. Para constantes: una vez, al cargar o al registrar; nunca por petición.
 */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (property && 'value' in property) deepFreeze(property.value, seen)
  }
  Object.freeze(value)
  return value
}
