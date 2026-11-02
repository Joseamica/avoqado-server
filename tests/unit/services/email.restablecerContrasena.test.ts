import emailService from '../../../src/services/email.service'

// Sólo importa lo que sendPasswordResetEmail le pasa al transporte.
const sendSpy = jest.spyOn(emailService as any, 'sendEmail').mockResolvedValue(true)

// 1-nov: el correo de «¿Olvidaste tu contraseña?» llegaba como «Restablece tu contrasena», «expirara», «esta segura».
describe('sendPasswordResetEmail — el correo para cambiar la contraseña', () => {
  it('escribe con acentos, ñ y signos de apertura', async () => {
    await emailService.sendPasswordResetEmail('ana@example.com', {
      firstName: 'Ana',
      resetLink: 'https://dashboard.avoqado.io/auth/reset-password/abc',
      expiresInMinutes: 60,
    })

    const opts = sendSpy.mock.calls[0][0] as any
    expect(opts.subject).toBe('Restablece tu contraseña - Avoqado')
    const cuerpos = `${opts.html}\n${opts.text}`
    expect(cuerpos).toContain('Este enlace expirará en 60 minutos')
    expect(cuerpos).toContain('¿No solicitaste esto?')
    expect(cuerpos).toContain('Tu cuenta está segura.')
    expect(cuerpos).not.toMatch(/contrasena|Contrasena|expirara |esta segura|boton|Contactanos|Politica/)
  })
})
