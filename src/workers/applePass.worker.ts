import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { PKPass } from 'passkit-generator'

/**
 * Arma y firma el .pkpass de Apple Wallet fuera del hilo que atiende los cobros (D5, 4-nov-2026).
 * passkit-generator firma con node-forge, en JavaScript puro: 0.3-0.9 s de hilo retenido por credencial en
 * Render (1.4-1.9 s el 2-nov). Aquí ese costo no detiene a nadie.
 */
export const APPLE_PASS_TASK = 'build-apple-pass'

export interface CertificadosDelPase {
  wwdr: Buffer
  signerCert: Buffer
  signerKey: Buffer
  signerKeyPassphrase?: string
}

if (!isMainThread && parentPort && workerData?.task === APPLE_PASS_TASK) {
  const port = parentPort
  try {
    // Lo que cruza el hilo llega como Uint8Array: PKPass necesita Buffer.
    const comoBuffer = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength)
    const archivos: Record<string, Buffer> = {}
    for (const [nombre, bytes] of Object.entries(workerData.archivos as Record<string, Uint8Array>)) archivos[nombre] = comoBuffer(bytes)
    const c = workerData.certificados as Record<string, Uint8Array | string | undefined>
    const pase = new PKPass(archivos, {
      wwdr: comoBuffer(c.wwdr as Uint8Array),
      signerCert: comoBuffer(c.signerCert as Uint8Array),
      signerKey: comoBuffer(c.signerKey as Uint8Array),
      signerKeyPassphrase: c.signerKeyPassphrase as string | undefined,
    }).getAsBuffer()
    // Copia de tamaño exacto para TRANSFERIRLA en vez de clonarla en el hilo principal.
    const bytes = new ArrayBuffer(pase.length)
    new Uint8Array(bytes).set(pase)
    port.postMessage({ ok: true, bytes }, [bytes])
  } catch (error) {
    // El mensaje de passkit-generator dice qué falló (certificado, tipo de pase); no trae la llave.
    port.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
}
