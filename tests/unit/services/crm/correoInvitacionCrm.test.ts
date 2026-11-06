/**
 * D3 (hz:e0c38c0d:D3, 4-nov-2026): la invitación al CRM tenía el correo genérico de un negocio («como Observador…
 * gestionar órdenes y pagos, administrar el menú») y el botón llevaba al DASHBOARD del negocio interno vacío. Ahora
 * tiene su propio texto y su botón lleva al SUPERADMIN, donde «Continuar con Google» ya acepta la invitación.
 */
import { correoAccesoCrm, correoInvitacionCrm } from '../../../../src/services/crm/correoInvitacionCrm'

const DATOS = {
  inviterName: 'Jose Amieva',
  crmUrl: 'https://superadmin.avoqado.io/login',
  inviteLink: 'https://dashboard.avoqado.io/invite/tok-rafa',
  email: 'rafael@playtelecom.com',
}

describe('correo de invitación al CRM', () => {
  it('🔴 dice que es el CRM y lleva al SUPERADMIN, no habla de un negocio', () => {
    const correo = correoInvitacionCrm(DATOS)

    expect(correo.subject).toBe('Te invitaron al CRM de ventas de Avoqado')
    expect(correo.html).toContain('href="https://superadmin.avoqado.io/login"')
    expect(correo.html).toContain('rafael@playtelecom.com')
    for (const texto of ['Observador', 'órdenes y pagos', 'menú y productos', 'operaciones del negocio']) {
      expect(correo.html).not.toContain(texto)
      expect(correo.text).not.toContain(texto)
    }
  })

  it('a quien no usa Google le da la liga para crear su contraseña', () => {
    const correo = correoInvitacionCrm(DATOS)

    expect(correo.html).toContain('href="https://dashboard.avoqado.io/invite/tok-rafa"')
    expect(correo.text).toContain('https://superadmin.avoqado.io/login')
    expect(correo.text).toContain('https://dashboard.avoqado.io/invite/tok-rafa')
  })

  it('sigue el estándar de correos: dos logos, botón negro, sin emoji y con texto plano', () => {
    const correo = correoInvitacionCrm(DATOS)

    expect(correo.html.match(/isotipo\.svg/g)).toHaveLength(2)
    expect(correo.html).toContain('background-color:#000000')
    expect(correo.html).toContain('Servicios Tecnologicos Avo S.A. de C.V.')
    expect(correo.subject).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(correo.subject.length).toBeLessThan(60)
    expect(correo.text.trim().length).toBeGreaterThan(40)
  })

  it('escapa el nombre de quien invita', () => {
    const correo = correoInvitacionCrm({ ...DATOS, inviterName: '<b>Jose</b>' })

    expect(correo.html).not.toContain('<b>Jose</b>')
    expect(correo.html).toContain('&lt;b&gt;Jose&lt;/b&gt;')
  })
})

/**
 * D4 (hz:e0c38c0d:D4, 5-nov-2026): agregar al CRM a alguien que YA tiene cuenta le daba el acceso sin mandarle nada
 * (un vendedor, 4-nov: «dice que aún no recibe el correo»). Ahora le llega este aviso: sin liga de invitación ni plazo.
 */
describe('correo de acceso al CRM (ya tenía cuenta)', () => {
  const ACCESO = {
    inviterName: 'Jose Amieva',
    crmUrl: 'https://superadmin.avoqado.io/login',
    resetUrl: 'https://dashboard.avoqado.io/auth/forgot-password',
    email: 'vendedora@ejemplo.mx',
  }

  it('🔴 dice que ya tiene acceso y lleva al SUPERADMIN, sin invitación ni plazo', () => {
    const correo = correoAccesoCrm(ACCESO)

    expect(correo.subject).toBe('Ya tienes acceso al CRM de ventas de Avoqado')
    expect(correo.html).toContain('href="https://superadmin.avoqado.io/login"')
    expect(correo.html).toContain('vendedora@ejemplo.mx')
    expect(correo.html).toContain('Continuar con Google')
    for (const texto of ['/invite/', 'expira', 'Observador']) {
      expect(correo.html).not.toContain(texto)
      expect(correo.text).not.toContain(texto)
    }
  })

  it('a quien no tiene contraseña o la olvidó le da la liga para crearla', () => {
    const correo = correoAccesoCrm(ACCESO)

    expect(correo.html).toContain('href="https://dashboard.avoqado.io/auth/forgot-password"')
    expect(correo.text).toContain('https://superadmin.avoqado.io/login')
    expect(correo.text).toContain('https://dashboard.avoqado.io/auth/forgot-password')
  })

  it('sigue el estándar de correos y escapa el nombre de quien da el acceso', () => {
    const correo = correoAccesoCrm({ ...ACCESO, inviterName: '<b>Jose</b>' })

    expect(correo.html.match(/isotipo\.svg/g)).toHaveLength(2)
    expect(correo.html).toContain('background-color:#000000')
    expect(correo.html).toContain('Servicios Tecnologicos Avo S.A. de C.V.')
    expect(correo.subject).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(correo.subject.length).toBeLessThan(60)
    expect(correo.html).not.toContain('<b>Jose</b>')
    expect(correo.html).toContain('&lt;b&gt;Jose&lt;/b&gt;')
  })
})
