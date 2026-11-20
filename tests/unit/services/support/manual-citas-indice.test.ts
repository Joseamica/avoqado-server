// El índice «archivo citado → páginas» del manual interno (T12-1 b). Lo lee el aviso al editar del workspace
// (scripts/aviso-manual-soporte.py): si alguien cambia una evidencia y no lo regenera, la primera prueba se pone roja.
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  CITATION_INDEX_FILE,
  CITATION_INDEX_NOTE,
  buildCitationIndex,
  citationIndexText,
  readAllEvidence,
} from '../../../../scripts/support-eval/manual/citas-indice'
import type { ManualEvidence } from '../../../../scripts/support-eval/manual/esquema'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

const REF_A = 'a'.repeat(40)
const REF_B = 'b'.repeat(40)
const at = (archivo: string) => ({ archivo, linea: 1 })
const evidence = (pagina: string, sourceRepo: ManualEvidence['sourceRepo'], sourceRef: string, archivos: string[]): ManualEvidence => ({
  pagina,
  sourceRepo,
  sourceRef,
  version: '1.0.0',
  pasos: archivos.map((a, i) => ({ paso: i + 1, ...at(a), cita: 'x' })),
  permisos: [{ permiso: 'payments:create', ...at(archivos[0]) }],
  plan: [],
  sinInternet: [],
  rutas: [],
  aparato: { estado: 'NO APLICA', fotos: [], filasCreadas: [] },
  codex: { lote: 1, ronda: 0, veredicto: 'PENDIENTE' },
})

describe('manual citation index (citas-indice.json)', () => {
  it('the committed index is, byte for byte, the one regenerated from evidencia/ (after changing an evidence, regenerate it)', () => {
    const committed = fs.readFileSync(CITATION_INDEX_FILE, 'utf8')
    expect(committed).toBe(citationIndexText(buildCitationIndex(readAllEvidence())))
    expect(Object.keys(JSON.parse(committed).porArchivo).length).toBeGreaterThan(0)
  })

  it('the text is JSON with 2 spaces and a final newline, so a reordered or reformatted file turns the check red', () => {
    const index = buildCitationIndex([evidence('tpv/cobro/uno', 'avoqado-tpv', REF_A, ['app/B.kt', 'app/A.kt'])])
    expect(citationIndexText(index)).toBe(`${JSON.stringify(index, null, 2)}\n`)
    const reordered = { porArchivo: index.porArchivo, generado: index.generado }
    expect(`${JSON.stringify(reordered, null, 2)}\n`).not.toBe(citationIndexText(index))
  })

  it('groups every cited file by sourceRepo:archivo, one entry per page, keys and pages sorted', () => {
    const index = buildCitationIndex([
      evidence('tpv/cobro/zeta', 'avoqado-tpv', REF_A, ['app/B.kt', 'app/A.kt']),
      evidence('android/cobro/uno', 'avoqado-android', REF_B, ['app/A.kt']),
      evidence('tpv/caja/alfa', 'avoqado-tpv', REF_A, ['app/A.kt', 'app/A.kt']),
    ])
    expect(index).toEqual({
      generado: CITATION_INDEX_NOTE,
      porArchivo: {
        'avoqado-android:app/A.kt': [{ pagina: 'android/cobro/uno', sourceRef: REF_B }],
        'avoqado-tpv:app/A.kt': [
          { pagina: 'tpv/caja/alfa', sourceRef: REF_A },
          { pagina: 'tpv/cobro/zeta', sourceRef: REF_A },
        ],
        'avoqado-tpv:app/B.kt': [{ pagina: 'tpv/cobro/zeta', sourceRef: REF_A }],
      },
    })
    expect(Object.keys(index.porArchivo)).toEqual(['avoqado-android:app/A.kt', 'avoqado-tpv:app/A.kt', 'avoqado-tpv:app/B.kt'])
  })

  it('reads every evidence file under evidencia/<app>/<categoría>/, validated by the schema', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citas-indice-'))
    try {
      const write = (e: ManualEvidence) => {
        const file = path.join(root, 'evidencia', `${e.pagina}.json`)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify(e))
      }
      const uno = evidence('tpv/cobro/uno', 'avoqado-tpv', REF_A, ['app/A.kt'])
      const dos = evidence('android/caja/dos', 'avoqado-android', REF_B, ['app/C.kt'])
      write(uno)
      write(dos)
      expect(readAllEvidence(root)).toEqual([dos, uno])
      fs.writeFileSync(path.join(root, 'evidencia', 'tpv', 'cobro', 'mala.json'), JSON.stringify({ pagina: 'tpv/cobro/mala' }))
      expect(() => readAllEvidence(root)).toThrow()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
