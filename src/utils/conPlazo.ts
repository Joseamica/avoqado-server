/**
 * D661 (Ruling 73): NUESTRO plazo duro sobre una promesa que puede no terminar nunca (stripe-node 19.1.0 resuelve la petición HTTP al
 * llegar las cabeceras; si la conexión muere a medio cuerpo, su lector espera `end` sin manejar el cierre incompleto). Al cumplirse `ms`
 * se rechaza con `PlazoAgotado`. La promesa original no se cancela (su socket huérfano muere solo): sólo se deja de esperarla, y su
 * desenlace tardío lo recibe la carrera (nunca un rechazo sin atender).
 */
export class PlazoAgotado extends Error {
  constructor(readonly ms: number) {
    super(`Sin respuesta en ${ms} ms: se dejó de esperar (plazo propio)`)
    this.name = 'PlazoAgotado'
  }
}

export function conPlazo<T>(promesa: Promise<T>, ms: number): Promise<T> {
  let temporizador: ReturnType<typeof setTimeout> | undefined
  const plazo = new Promise<never>((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(new PlazoAgotado(ms)), ms)
  })
  return Promise.race([promesa, plazo]).finally(() => clearTimeout(temporizador))
}
