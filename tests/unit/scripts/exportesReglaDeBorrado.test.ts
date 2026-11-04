import { aplicarRegla, prefijoDeExportes, yaTraeLaRegla } from '../../../scripts/exportes-regla-de-borrado'

const P = 'private/test/exports/'
const nuestra = { action: { type: 'Delete' }, condition: { age: 8, matchesPrefix: [P] } }
const ajena = { action: { type: 'SetStorageClass', storageClass: 'COLDLINE' }, condition: { age: 30 } }

/** Bucket en memoria con la misma semántica que `addLifecycleRule` (append por default). */
function bucketFalso(reglas: any[] = []) {
  const b = {
    name: 'test-bucket',
    reglas,
    getMetadata: jest.fn(async () => [{ metageneration: '7', lifecycle: { rule: [...b.reglas] } }]),
    addLifecycleRule: jest.fn(async (r: any, o: any) => {
      b.reglas = o?.append === false ? [r] : [...b.reglas, r]
    }),
    setMetadata: jest.fn(),
  }
  return b
}
const log = () => ({ log: jest.fn(), error: jest.fn() })

describe('regla de borrado del bucket para los exportes (Codex r5 B1)', () => {
  it('reconoce la regla: Delete, age ≤ 8 y un prefijo que cubre exports/, sin otras condiciones que la estrechen', () => {
    expect(prefijoDeExportes('prod')).toBe('private/prod/exports/')
    expect(yaTraeLaRegla(undefined, P)).toBe(false)
    expect(yaTraeLaRegla([ajena, nuestra], P)).toBe(true)
    expect(yaTraeLaRegla([{ action: { type: 'Delete' }, condition: { age: 8, matchesPrefix: ['private/test/'] } }], P)).toBe(true) // más amplia: también cubre
    expect(yaTraeLaRegla([{ action: { type: 'Delete' }, condition: { age: 9, matchesPrefix: [P] } }], P)).toBe(false) // más tarde
    expect(yaTraeLaRegla([{ action: { type: 'Delete' }, condition: { age: 8, matchesPrefix: ['private/dev/exports/'] } }], P)).toBe(false) // otro entorno
    expect(yaTraeLaRegla([{ action: { type: 'Delete' }, condition: { age: 8, matchesPrefix: [P], matchesSuffix: ['.csv'] } }], P)).toBe(
      false,
    ) // estrechada
    expect(yaTraeLaRegla([{ action: { type: 'SetStorageClass' }, condition: { age: 8, matchesPrefix: [P] } }], P)).toBe(false)
  })
  it('si ya está, no escribe nada (idempotente) e imprime bucket y prefijo antes de actuar', async () => {
    const b = bucketFalso([ajena, nuestra])
    const l = log()
    expect(await aplicarRegla(b as any, P, false, l)).toBe(0)
    expect(b.addLifecycleRule).not.toHaveBeenCalled()
    expect(l.log.mock.calls[0][0]).toEqual(expect.stringContaining('test-bucket'))
    expect(l.log.mock.calls[0][0]).toEqual(expect.stringContaining(P))
  })
  it('--verificar sólo lee: si falta, sale con 1 sin escribir', async () => {
    const b = bucketFalso([ajena])
    expect(await aplicarRegla(b as any, P, true, log())).toBe(1)
    expect(b.addLifecycleRule).not.toHaveBeenCalled()
    expect(b.setMetadata).not.toHaveBeenCalled()
  })
  it('🔴 si falta, la AGREGA junto a las ajenas (append, con la metageneración leída), nunca con setMetadata; la segunda corrida no hace nada', async () => {
    const b = bucketFalso([ajena])
    expect(await aplicarRegla(b as any, P, false, log())).toBe(0)
    expect(b.addLifecycleRule).toHaveBeenCalledWith(nuestra, { append: true, ifMetagenerationMatch: '7' })
    expect(b.setMetadata).not.toHaveBeenCalled()
    expect(b.reglas).toEqual([ajena, nuestra]) // la ajena sigue
    expect(await aplicarRegla(b as any, P, false, log())).toBe(0)
    expect(b.addLifecycleRule).toHaveBeenCalledTimes(1)
  })
})
