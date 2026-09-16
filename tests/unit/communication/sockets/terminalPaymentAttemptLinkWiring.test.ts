/**
 * S1 (checkpoint 1 del webhook): guardia a nivel de FUENTE del cableado de `terminal:payment_attempt_opened`.
 * Un `onWithContext` se cae de una línea sin que ninguna prueba de comportamiento lo note; y el orden importa:
 * la identidad del socket se comprueba ANTES de tocar el servicio, y el ack lleva el veredicto entero.
 */
import fs from 'node:fs'
import path from 'node:path'

const src = fs.readFileSync(path.join(process.cwd(), 'src', 'communication', 'sockets', 'managers', 'socketManager.ts'), 'utf8')

describe('S1 · cableado de terminal:payment_attempt_opened', () => {
  const inicio = src.indexOf("onWithContext(socket, 'terminal:payment_attempt_opened'")
  const fin = src.indexOf('onWithContext(socket,', inicio + 10)
  const bloque = src.slice(inicio, fin === -1 ? undefined : fin)

  it('registra el evento', () => {
    expect(inicio).toBeGreaterThan(-1)
  })

  it('exige terminal identificada del mismo venue ANTES de llamar al servicio', () => {
    expect(bloque).toContain('terminal.identityVerified')
    expect(bloque).toContain('terminal.venueId !== socket.authContext?.venueId')
    expect(bloque.indexOf('identityVerified')).toBeLessThan(bloque.indexOf('handleAttemptOpenedFromSocket'))
  })

  it('contesta con el veredicto entero del servicio, no con un booleano', () => {
    expect(bloque).toContain('const ack = await terminalPaymentService.handleAttemptOpenedFromSocket(')
    expect(bloque).toMatch(/callback\?\.\(ack\)/)
  })
})
