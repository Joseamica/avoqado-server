import { terminalRegistry } from '@/communication/sockets/terminal-registry'

/**
 * 🔴 Un socket desplazado que sigue resolviendo a la entrada de su reemplazo hereda su
 * identidad verificada — y con ella la capacidad de aceptar o cancelar el cobro VIVO de otro.
 */
describe('TerminalRegistry — identidad desplazada', () => {
  afterEach(() => {
    terminalRegistry.unregisterBySocketId('sock-U')
    terminalRegistry.unregisterBySocketId('sock-S')
  })

  it('P1 un socket desplazado no hereda la identidad verificada de su reemplazo', () => {
    // U, sin firmar, se registra para la terminal A.
    terminalRegistry.register('A', 'sock-U', 'venue-1')
    // Un heartbeat HTTP de A cambia de venue y la deja SIN socket. El mapa directo se limpia;
    // el INVERSO de U seguía apuntando a A, que es la puerta que abre este defecto.
    terminalRegistry.register('A', null, 'venue-2')
    // Ahora S se registra FIRMADO para A.
    terminalRegistry.register('A', 'sock-S', 'venue-2', undefined, 1, 1, 'A')

    expect(terminalRegistry.getTerminalBySocketId('sock-U')).toBeNull()
    expect(terminalRegistry.getTerminalBySocketId('sock-S')?.socketId).toBe('sock-S')
  })

  it('P1 el emisor debe coincidir con el socket de la entrada, no sólo existir en el mapa', () => {
    // Defensa en profundidad: aunque un mapping inverso sobreviva por cualquier vía, resolver
    // exige que la entrada devuelta pertenezca AL socket que pregunta.
    terminalRegistry.register('A', 'sock-S', 'venue-2', undefined, 1, 1, 'A')
    expect(terminalRegistry.getTerminalBySocketId('sock-U')).toBeNull()
  })
})
