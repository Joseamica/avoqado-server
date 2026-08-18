import { Request, Response, NextFunction } from 'express'
import emailService from '../../services/email.service'
import logger from '../../config/logger'
import { BadRequestError } from '../../errors/AppError'
import { signupFromLanding } from '../../services/onboarding/signup.service'
import crypto from 'crypto'
import prisma from '../../utils/prismaClient'

const CONTACT_NOTIFY_EMAIL = process.env.CONTACT_NOTIFY_EMAIL || 'hola@avoqado.io'
// Onboarding recibe el mismo aviso que ventas: quien da de alta al cliente
// necesita el lead sin esperar un reenvio manual (founder, 2026-08-17).
const ONBOARDING_NOTIFY_EMAIL = process.env.ONBOARDING_NOTIFY_EMAIL || 'onboarding@avoqado.io'
const LABS_NOTIFY_EMAIL = process.env.LABS_NOTIFY_EMAIL || 'hola@avoqado.io'

const projectLabel: Record<string, string> = {
  'web-app': 'Web App',
  'mobile-app': 'App Móvil',
  dashboard: 'Dashboard',
  automation: 'Automatización',
  'ai-agent': 'Agente AI',
  integration: 'Integración',
  report: 'Reporte',
  other: 'Otro',
}

const urgencyLabel: Record<string, string> = {
  hoy: 'Hoy',
  'esta-semana': 'Esta semana',
  'este-mes': 'Este mes',
  'sin-prisa': 'Sin prisa',
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Catalogo de los modulos que se pueden marcar en el formulario de la landing.
 *
 * La landing manda los VALUES crudos (`mesas, cocina, qr`) porque es lo que trae
 * el checkbox. Traducirlos aqui y no alla es a proposito: el correo es del
 * server, y asi una landing nueva (retail, servicios) que reuse los mismos
 * values hereda las frases sin copiarlas. Un value que no este en el mapa NO se
 * pierde — cae al propio value, que es feo pero legible.
 *
 * `beneficio` es lo que el prospecto lee: no repetir la etiqueta, decirle que
 * gana. Toda frase de aqui tiene que ser cierta hoy — este correo es lo primero
 * que recibe de Avoqado, y una promesa de mas se paga en la primera llamada.
 */
const MODULOS: Record<string, { label: string; beneficio: string }> = {
  mesas: {
    label: 'Mesas y meseros',
    beneficio: 'Cada mesero abre, mueve y cobra su mesa desde su propio celular, sin hacer fila en la caja.',
  },
  cocina: {
    label: 'Pantalla de cocina',
    beneficio: 'La comanda entra al momento y cada estación ve solo lo suyo: cocina lo de cocina, barra lo de barra.',
  },
  qr: {
    label: 'Pago con QR en la mesa',
    beneficio: 'Tu cliente escanea, divide la cuenta entre sus amigos y paga sin esperar a que le lleven la terminal.',
  },
  propinas: {
    label: 'Propinas',
    beneficio: 'La propina se registra por mesero y sale sola en el corte, sin repartirla a mano al cierre.',
  },
  kiosko: {
    label: 'Kiosko de autoservicio',
    beneficio: 'El cliente ordena y paga solo en la pantalla; tu gente atiende en vez de capturar.',
  },
  terminal: {
    label: 'Terminal de cobro',
    beneficio: 'Terminal propia de Avoqado para cobrar con tarjeta en la mesa, sin mandar al cliente a la caja.',
  },
  reservas: {
    label: 'Reservas',
    beneficio: 'Tus clientes reservan desde Google o desde tu propia página, y la mesa se bloquea sola.',
  },
  pedidos: {
    label: 'Pedidos en línea propios',
    beneficio: 'Tu propia página de pedidos: sin comisión de app y con el cliente quedándose tuyo.',
  },
  delivery: {
    label: 'Apps de delivery',
    beneficio: 'Rappi, Uber Eats y DiDi Food entran al mismo lugar vía Deliverect; dejas de capturar la orden dos veces.',
  },
  lealtad: {
    label: 'Lealtad y promociones',
    beneficio: 'Puntos, cupones y promociones que se aplican solos al momento de cobrar.',
  },
  resenas: {
    label: 'Reseñas de Google',
    beneficio: 'Le pides la reseña justo cuando acaba de pagar, que es cuando de verdad la deja.',
  },
  cfdi: {
    label: 'Facturación CFDI',
    beneficio: 'CFDI 4.0 timbrado: tu cliente escanea el QR del ticket y se factura solo, sin ocuparte a ti.',
  },
  inventario: {
    label: 'Inventario y recetas',
    beneficio: 'Cada venta descuenta los ingredientes por receta y te avisa antes de que se te acabe algo.',
  },
  corte: {
    label: 'Corte de caja y turnos',
    beneficio: 'Cierras el turno cuadrado al centavo y ves la diferencia de caja en el momento, no al día siguiente.',
  },
  comisiones: {
    label: 'Comisiones a meseros',
    beneficio: 'La comisión de cada quien se calcula sola sobre lo que realmente vendió.',
  },
  sucursales: {
    label: 'Varias sucursales',
    beneficio: 'Todas tus sucursales en un solo tablero, cada una con su menú y sus precios.',
  },
}

/**
 * Numero listo para un enlace `wa.me`.
 *
 * 🔴 wa.me exige el numero en formato internacional: "a local number without
 * its international country code will usually be invalid for Click to Chat"
 * (docs de WhatsApp). El formulario de la landing pide el telefono con
 * placeholder `55 1234 5678` — 10 digitos, SIN lada de pais — asi que pegar el
 * valor tal cual producia un enlace muerto, y justo en el boton con el que
 * ventas atiende al lead.
 *
 * Se asume Mexico (52) solo cuando vienen exactamente 10 digitos, que es lo que
 * pide el formulario. Un numero que ya trae lada se respeta: nunca se le
 * anteponen dos ladas a un extranjero.
 */
function telefonoParaWhatsApp(raw: unknown): string {
  const d = String(raw ?? '').replace(/\D/g, '')
  if (!d) return ''
  if (d.length === 10) return `52${d}` // celular mexicano tal como lo pide la landing
  if (d.startsWith('00')) return d.slice(2) // 00 + internacional
  return d // ya trae lada (52…, 521…, o de otro pais)
}

/** Traduce el `modules` crudo del formulario a lo que se puede leer en un correo. */
function modulosElegidos(modules: unknown): Array<{ label: string; beneficio: string }> {
  if (typeof modules !== 'string' || !modules.trim()) return []
  return modules
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
    .map(v => MODULOS[v] || { label: v, beneficio: '' })
}

// ------------------------------------------------------------
// POST /api/v1/public/contact — landing demo request form
// ------------------------------------------------------------
/** Fila clave/valor del aviso interno, con el formato de tabla de EMAIL_STANDARDS. */
function fila(label: string, value: unknown): string {
  const v = value === undefined || value === null || String(value).trim() === '' ? '—' : String(value)
  return `
        <tr>
          <td style="width:160px;padding:10px 14px;border-bottom:1px solid #e5e7eb;color:#666;font-size:13px;">${escapeHtml(label)}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;color:#000;font-size:14px;">${escapeHtml(v)}</td>
        </tr>`
}

export async function submitContact(req: Request, res: Response, next: NextFunction) {
  try {
    const { firstName, lastName, phone, email, companyName, employees, revenue } = req.body || {}
    // Campos opcionales que manda la landing de sector (restaurantes): tipo de
    // negocio, módulos marcados en el formulario, origen y UTMs de la campaña.
    const { businessType, modules, source, utm } = req.body || {}

    if (!firstName || !lastName || !phone || !email || !companyName) {
      throw new BadRequestError('Todos los campos son requeridos')
    }

    const logoUrl = 'https://avoqado.io/isotipo.svg'
    const nombre = `${String(firstName)} ${String(lastName)}`.trim()

    // Crear la cuenta de verdad, no solo mandar un correo. El prospecto queda
    // registrado en la DB igual que si hubiera entrado por dashboard/signup;
    // la diferencia es que aqui no se le pidio contrasena — la define con el
    // magic link de abajo. Si esto falla NO se aborta el contacto: el lead
    // sigue valiendo aunque el alta no haya podido crearse.
    let magicLink: string | null = null
    let yaEsCliente = false
    // Que paso con el alta, para poder decirselo al equipo sin que lo adivine
    // del contenido del correo del cliente.
    let altaEstado: 'creada' | 'existente' | 'fallo' = 'fallo'
    try {
      const alta = await signupFromLanding({
        email: String(email),
        firstName: String(firstName),
        lastName: String(lastName),
        organizationName: String(companyName),
        phone: String(phone),
        source: source ? String(source) : undefined,
      })
      yaEsCliente = alta.yaEsCliente
      altaEstado = alta.yaEsCliente ? 'existente' : 'creada'
      if (alta.magicLinkToken) {
        // Pasa por el redirect propio para poder contar el clic (ver continuarOnboarding).
        const apiUrl = process.env.PUBLIC_API_URL || 'https://api.avoqado.io'
        magicLink = `${apiUrl}/api/v1/public/onboarding/continuar/${alta.magicLinkToken}`
      }
      logger.info('[CONTACT_SUBMIT] Alta desde landing', {
        staffId: alta.staff.id,
        organizationId: alta.organizationId,
        alreadyExisted: alta.alreadyExisted,
        yaEsCliente: alta.yaEsCliente,
        source,
      })
    } catch (err) {
      logger.error('[CONTACT_SUBMIT] No se pudo crear la cuenta; se continua solo con el lead', {
        email,
        companyName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    const utmTexto =
      utm && typeof utm === 'object' && Object.keys(utm as object).length > 0
        ? Object.entries(utm as Record<string, string>)
            .map(([k, v]) => `${k}=${v}`)
            .join(' · ')
        : ''

    // El CTA cambia segun quien recibe: alguien nuevo va al onboarding, un
    // cliente que ya tiene cuenta va a iniciar sesion (mandarlo a la landing
    // seria mandarlo a vender algo que ya compro).
    const dashboardUrl = process.env.FRONTEND_URL || 'https://dashboard.avoqado.io'
    const ctaUrl = magicLink || (yaEsCliente ? `${dashboardUrl}/login` : 'https://avoqado.io/restaurants')
    const ctaTexto = magicLink ? 'Continúa tu onboarding' : yaEsCliente ? 'Entrar a mi cuenta' : 'Ver cómo funciona'

    // Estado de la cuenta para el equipo. 🔴 Aqui NUNCA va el magic link: ese
    // enlace fija la contrasena de la cuenta del cliente, y este correo se
    // reenvia entre el equipo como cualquier otro. Lo que ventas y onboarding
    // necesitan es SABER que se le mando y en que quedo, no poder usarlo.
    const CUENTA: Record<typeof altaEstado, { titulo: string; nota: string }> = {
      creada: {
        titulo: 'Cuenta creada',
        nota: 'Ya está dada de alta y le llegó su enlace para elegir contraseña. Vence en 24 horas y sirve una sola vez.',
      },
      existente: {
        titulo: 'Ya era cliente',
        nota: 'Esta cuenta ya tiene contraseña y opera. No se le tocó nada: ni token ni datos. Ojo, un cliente que vuelve a llenar el formulario casi siempre trae un problema — vale la pena llamarle.',
      },
      fallo: {
        titulo: 'No se pudo crear la cuenta',
        nota: 'El lead SÍ está completo, pero el alta falló. Hay que darlo de alta a mano en el dashboard. Revisar el log del server por [CONTACT_SUBMIT].',
      },
    }
    const cuenta = CUENTA[altaEstado]

    // Lo que marco en el formulario. Es el dato mas util de todo el lead: dice
    // por donde abrir la llamada y que configurar primero en el alta.
    const elegidos = modulosElegidos(modules)

    // ---------- Aviso interno (ventas + onboarding) ----------
    const internalHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Nuevo prospecto</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.6;margin:0;padding:0;background-color:#ffffff;color:#000000;">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px;">
    <div style="padding-bottom:32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display:inline-block;vertical-align:middle;">
      <span style="font-size:18px;font-weight:700;color:#000;vertical-align:middle;margin-left:8px;">Avoqado</span>
    </div>
    <div style="padding-bottom:24px;">
      <h1 style="margin:0 0 8px 0;font-size:32px;font-weight:400;color:#000;">${yaEsCliente ? 'Cliente existente pidió información' : 'Nuevo prospecto'}</h1>
      <p style="margin:0;font-size:16px;color:#666;">${escapeHtml(String(companyName))}</p>
    </div>

    <h2 style="margin:0 0 12px 0;font-size:13px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Contacto</h2>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:24px;">
      ${fila('Nombre', nombre)}${fila('Negocio', companyName)}${fila('WhatsApp', phone)}${fila('Correo', email)}
    </table>

    <h2 style="margin:0 0 12px 0;font-size:13px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Calificación</h2>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:24px;">
      ${fila('Tipo de negocio', businessType)}${fila('Sucursales', employees)}${fila('Ventas al mes', revenue)}
    </table>

    <h2 style="margin:0 0 12px 0;font-size:13px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Qué pidió (${elegidos.length})</h2>
    ${
      elegidos.length
        ? `<div style="margin-bottom:24px;">
      ${elegidos
        .map(
          m =>
            `<span style="display:inline-block;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:999px;padding:6px 14px;margin:0 6px 8px 0;font-size:13px;color:#000;">${escapeHtml(m.label)}</span>`,
        )
        .join('')}
    </div>`
        : `<p style="margin:0 0 24px 0;font-size:14px;color:#666;">No marcó ninguno. Vale la pena preguntarle por dónde le urge empezar.</p>`
    }

    <h2 style="margin:0 0 12px 0;font-size:13px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Cuenta</h2>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:24px;">
      <div style="font-size:15px;font-weight:600;color:#000;">${escapeHtml(cuenta.titulo)}</div>
      <div style="font-size:14px;color:#666;margin-top:4px;">${escapeHtml(cuenta.nota)}</div>
    </div>

    <h2 style="margin:0 0 12px 0;font-size:13px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Origen</h2>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      ${fila('Página', source)}${fila('Campaña', utmTexto)}
    </table>

    <div style="padding:32px 0;text-align:center;">
      <a href="https://wa.me/${telefonoParaWhatsApp(phone)}" style="background-color:#000000;color:#fff;padding:14px 32px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;display:inline-block;">Escribirle por WhatsApp</a>
    </div>

    <hr style="border:none;border-top:1px solid #e0e0e0;margin:40px 0 24px 0;">
    <div>
      <div style="margin-bottom:16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display:inline-block;vertical-align:middle;">
        <span style="font-size:16px;font-weight:700;color:#000;vertical-align:middle;margin-left:8px;">Avoqado</span>
      </div>
      <p style="margin:0 0 16px 0;font-size:14px;color:#000;">Servicios Tecnológicos Avo S.A. de C.V.<br>Ciudad de México, México</p>
      <p style="margin:16px 0 0 0;font-size:14px;"><a href="https://avoqado.io/privacy" style="color:#000;text-decoration:none;font-weight:600;">Política de Privacidad</a></p>
    </div>
  </div>
</body></html>`

    const internalText = `${yaEsCliente ? 'Cliente existente pidió información' : 'Nuevo prospecto'} — ${String(companyName)}

CONTACTO
Nombre: ${nombre}
Negocio: ${String(companyName)}
WhatsApp: ${String(phone)}
Correo: ${String(email)}

CALIFICACIÓN
Tipo de negocio: ${businessType || '—'}
Sucursales: ${employees || '—'}
Ventas al mes: ${revenue || '—'}

QUÉ PIDIÓ (${elegidos.length})
${elegidos.length ? elegidos.map(m => `- ${m.label}`).join('\n') : '- No marcó ninguno. Preguntarle por dónde le urge empezar.'}

CUENTA
${cuenta.titulo}. ${cuenta.nota}

ORIGEN
Página: ${source || '—'}
Campaña: ${utmTexto || '—'}
`

    // ---------- Confirmacion al prospecto ----------
    const confirmHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Bienvenido a Avoqado</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.6;margin:0;padding:0;background-color:#ffffff;color:#000000;">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px;">
    <div style="padding-bottom:32px;">
      <img src="${logoUrl}" alt="Avoqado" width="32" height="32" style="display:inline-block;vertical-align:middle;">
      <span style="font-size:18px;font-weight:700;color:#000;vertical-align:middle;margin-left:8px;">Avoqado</span>
    </div>

    <div style="padding-bottom:24px;">
      <h1 style="margin:0 0 8px 0;font-size:32px;font-weight:400;color:#000;">${yaEsCliente ? `Hola ${escapeHtml(String(firstName))}, ya tienes cuenta con nosotros` : `Hola ${escapeHtml(String(firstName))}, ya quedó tu registro`}</h1>
    </div>

    <div style="padding-bottom:8px;">
      ${
      yaEsCliente
        ? `<p style="font-size:16px;margin:0 0 16px 0;color:#000;">Vimos que dejaste tus datos en nuestra página, pero <strong>${escapeHtml(String(companyName))}</strong> ya tiene cuenta con nosotros — no hace falta crear otra. Entra con tu correo de siempre; si no recuerdas la contraseña, usa "Olvidé mi contraseña" en la pantalla de acceso.</p>
      <p style="font-size:16px;margin:0 0 16px 0;color:#000;">Si necesitabas algo más, respóndenos este correo o <a href="https://avoqado.io/wa?utm_source=email&utm_medium=correo&utm_campaign=alta_landing" style="color:#000;font-weight:600;">escríbenos por WhatsApp</a> y te atendemos.</p>`
        : `<p style="font-size:16px;margin:0 0 16px 0;color:#000;">Recibimos los datos de <strong>${escapeHtml(String(companyName))}</strong>. Te escribimos por WhatsApp hoy mismo para ayudarte a cargar tu menú y dejarte cobrando.</p>`
    }
      ${
        yaEsCliente
          ? ''
          : elegidos.length
            ? `<p style="font-size:16px;margin:0 0 16px 0;color:#000;">Nos dijiste que te interesa esto, y ya viene incluido en tu cuenta:</p>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin:0 0 24px 0;">
        ${elegidos
          .map(
            m => `<tr>
          <td style="padding:14px;border-bottom:1px solid #e5e7eb;">
            <div style="font-size:15px;font-weight:600;color:#000;">${escapeHtml(m.label)}</div>
            ${m.beneficio ? `<div style="font-size:14px;color:#666;margin-top:4px;">${escapeHtml(m.beneficio)}</div>` : ''}
          </td>
        </tr>`,
          )
          .join('')}
      </table>`
            : `<p style="font-size:16px;margin:0 0 16px 0;color:#000;">Esto es lo que vas a poder hacer desde el primer día:</p>
      <ul style="font-size:15px;margin:0 0 24px 0;padding-left:24px;color:#000;">
        <li style="margin-bottom:8px;">Cobrar con tarjeta, efectivo o transferencia desde tu tablet, tu compu o el celular de tus meseros</li>
        <li style="margin-bottom:8px;">Llevar mesas, cuentas abiertas y división de cuenta sin papelitos</li>
        <li style="margin-bottom:8px;">Mandar las órdenes a cocina y a barra por separado, cada una a su impresora</li>
        <li style="margin-bottom:8px;">Cuadrar tu corte de caja al centavo al cerrar el turno</li>
        <li style="margin-bottom:8px;">Facturar CFDI 4.0: tu cliente escanea el QR del ticket y se factura solo</li>
      </ul>`
      }
      ${yaEsCliente ? '' : `<p style="font-size:16px;margin:0 0 8px 0;color:#000;">El plan inicial es <strong>gratis para siempre</strong> y no pedimos tarjeta. Puedes ir creciendo cuando tu negocio crezca.</p>`}
    </div>

    ${
      magicLink
        ? `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:24px;margin:8px 0 24px 0;text-align:center;">
      <p style="margin:0 0 4px 0;font-size:16px;font-weight:600;color:#000;">Tu cuenta ya está creada</p>
      <p style="margin:0 0 20px 0;font-size:14px;color:#666;">Solo falta que elijas tu contraseña para entrar.</p>
      <a href="${ctaUrl}" style="background-color:#000000;color:#fff;padding:14px 32px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;display:inline-block;">${ctaTexto}</a>
      <p style="margin:20px 0 0 0;font-size:13px;color:#666;">Este enlace sirve por 24 horas y una sola vez. Si vence, escríbenos y te mandamos otro.</p>
    </div>`
        : `<div style="padding:32px 0 8px;text-align:center;">
      <a href="${ctaUrl}" style="background-color:#000000;color:#fff;padding:14px 32px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;display:inline-block;">${ctaTexto}</a>
    </div>`
    }

    ${
      // A un cliente existente ya se lo dijimos arriba; repetirlo aqui suena a plantilla.
      yaEsCliente
        ? ''
        : `<div style="padding-bottom:24px;">
      <p style="font-size:14px;color:#666;margin:0;">Si prefieres adelantarte, respóndenos este correo o <a href="https://avoqado.io/wa?utm_source=email&utm_medium=correo&utm_campaign=alta_landing" style="color:#000;font-weight:600;">escríbenos por WhatsApp</a> y con gusto te atendemos.</p>
    </div>`
    }

    <hr style="border:none;border-top:1px solid #e0e0e0;margin:40px 0 24px 0;">
    <div>
      <div style="margin-bottom:16px;">
        <img src="${logoUrl}" alt="Avoqado" width="24" height="24" style="display:inline-block;vertical-align:middle;">
        <span style="font-size:16px;font-weight:700;color:#000;vertical-align:middle;margin-left:8px;">Avoqado</span>
      </div>
      <p style="margin:0 0 16px 0;font-size:14px;color:#000;">Servicios Tecnológicos Avo S.A. de C.V.<br>Ciudad de México, México</p>
      <p style="margin:0;font-size:12px;color:#666;">Recibes este correo porque dejaste tus datos en avoqado.io. Si no fuiste tú, puedes ignorarlo.</p>
      <p style="margin:16px 0 0 0;font-size:14px;"><a href="https://avoqado.io/privacy" style="color:#000;text-decoration:none;font-weight:600;">Política de Privacidad</a></p>
    </div>
  </div>
</body></html>`

    // El texto plano tiene que decir LO MISMO que el HTML: es lo que ve quien
    // bloquea imagenes, y contradecirlo ahi es la forma mas facil de mandarle a
    // un cliente de anos un correo de bienvenida.
    const confirmText = yaEsCliente
      ? `Hola ${String(firstName)}, ya tienes cuenta con nosotros.

Vimos que dejaste tus datos en nuestra página, pero ${String(companyName)} ya tiene cuenta con nosotros — no hace falta crear otra. Entra con tu correo de siempre; si no recuerdas la contraseña, usa "Olvidé mi contraseña" en la pantalla de acceso.

Si necesitabas algo más, respóndenos este correo o escríbenos por WhatsApp: https://avoqado.io/wa

${ctaTexto}: ${ctaUrl}

Servicios Tecnológicos Avo S.A. de C.V. — Ciudad de México, México
Política de Privacidad: https://avoqado.io/privacy
`
      : `Hola ${String(firstName)}, ya quedó tu registro.

Recibimos los datos de ${String(companyName)}. Te escribimos por WhatsApp hoy mismo para ayudarte a cargar tu menú y dejarte cobrando.

${
  elegidos.length
    ? `Nos dijiste que te interesa esto, y ya viene incluido en tu cuenta:
${elegidos.map(m => `- ${m.label}${m.beneficio ? `: ${m.beneficio}` : ''}`).join('\n')}`
    : `Esto es lo que vas a poder hacer desde el primer día:
- Cobrar con tarjeta, efectivo o transferencia desde tu tablet, tu compu o el celular de tus meseros
- Llevar mesas, cuentas abiertas y división de cuenta sin papelitos
- Mandar las órdenes a cocina y a barra por separado, cada una a su impresora
- Cuadrar tu corte de caja al centavo al cerrar el turno
- Facturar CFDI 4.0: tu cliente escanea el QR del ticket y se factura solo`
}

El plan inicial es gratis para siempre y no pedimos tarjeta.

${magicLink ? `Tu cuenta ya está creada; solo falta que elijas tu contraseña.\n${ctaTexto}: ${ctaUrl}\n(el enlace sirve 24 horas y una sola vez)` : `${ctaTexto}: ${ctaUrl}`}

Servicios Tecnológicos Avo S.A. de C.V. — Ciudad de México, México
Política de Privacidad: https://avoqado.io/privacy
`

    // El aviso interno va a ventas Y a onboarding, para que quien da de alta al
    // cliente reciba el lead sin depender de un reenvio manual.
    const internos = [...new Set([CONTACT_NOTIFY_EMAIL, ONBOARDING_NOTIFY_EMAIL].filter(Boolean))]

    const [internosOk, confirmSent] = await Promise.all([
      Promise.all(
        internos.map(to =>
          emailService.sendEmail({
            to,
            subject: `${yaEsCliente ? 'Cliente existente' : 'Nuevo prospecto'} - ${String(companyName)}`,
            html: internalHtml,
            text: internalText,
          }),
        ),
      ),
      emailService.sendEmail({
        to: String(email),
        subject: yaEsCliente ? 'Ya tienes cuenta en Avoqado' : 'Ya quedó tu registro en Avoqado',
        html: confirmHtml,
        text: confirmText,
      }),
    ])

    // Basta con que UNO de los internos llegue para no perder el lead.
    if (!internosOk.some(Boolean)) {
      logger.error('[CONTACT_SUBMIT] Internal notification failed', { email, companyName, internos })
      return res.status(502).json({ success: false, message: 'No se pudo notificar al equipo. Intenta de nuevo.' })
    }
    internos.forEach((to, i) => {
      if (!internosOk[i]) logger.warn('[CONTACT_SUBMIT] Internal notification failed for one recipient', { to, companyName })
    })
    if (!confirmSent) {
      logger.warn('[CONTACT_SUBMIT] Confirmation email failed (lead saved)', { email })
    }

    return res.status(200).json({ success: true, message: 'Demo solicitada exitosamente' })
  } catch (err) {
    return next(err)
  }
}

// ------------------------------------------------------------
// POST /api/v1/public/labs/submit — Avoqado Labs brief
// ------------------------------------------------------------
interface LabsContact {
  name: string
  email?: string
  whatsapp?: string
}

interface LabsSubmitPayload {
  sessionId: string
  fields: {
    projectType: string
    projectTypeFreeText?: string
    businessContext: string
    coreFunctionality: string
    integrations: string[]
    designReference: string
    urgency: string
    contact: LabsContact
  }
  additionalNotes?: string
  transcript: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validateLabsPayload(p: any): p is LabsSubmitPayload {
  if (!p || typeof p !== 'object') return false
  if (typeof p.sessionId !== 'string') return false
  const f = p.fields
  if (!f || typeof f !== 'object') return false
  if (typeof f.projectType !== 'string') return false
  if (typeof f.businessContext !== 'string' || !f.businessContext.trim()) return false
  if (typeof f.coreFunctionality !== 'string' || !f.coreFunctionality.trim()) return false
  if (!Array.isArray(f.integrations)) return false
  if (typeof f.designReference !== 'string') return false
  if (typeof f.urgency !== 'string') return false
  const c = f.contact
  if (!c || typeof c.name !== 'string' || !c.name.trim()) return false
  // Need at least one reachable channel: a valid email OR a non-empty whatsapp.
  const hasEmail = typeof c.email === 'string' && EMAIL_RE.test(c.email)
  const hasWhatsapp = typeof c.whatsapp === 'string' && c.whatsapp.trim().length > 0
  if (!hasEmail && !hasWhatsapp) return false
  // If email is present but invalid (truthy non-empty string that doesn't match), reject.
  // Empty / undefined email is fine as long as whatsapp is present.
  if (typeof c.email === 'string' && c.email.trim().length > 0 && !EMAIL_RE.test(c.email)) return false
  if (!Array.isArray(p.transcript)) return false
  return true
}

function renderLabsBriefHtml(payload: LabsSubmitPayload): string {
  const f = payload.fields
  const transcriptHtml = payload.transcript
    .map(
      m =>
        `<div style="margin:8px 0;padding:8px 12px;border-left:3px solid ${m.role === 'user' ? '#d97452' : '#888'};background:#fafafa;font-size:13px;">
          <strong>${m.role === 'user' ? 'Cliente' : 'Agente'}:</strong>
          <div style="white-space:pre-wrap;margin-top:4px;">${escapeHtml(m.content)}</div>
        </div>`,
    )
    .join('')

  const projectTypeLabel =
    f.projectType === 'other' && f.projectTypeFreeText
      ? `Otro: ${escapeHtml(f.projectTypeFreeText)}`
      : projectLabel[f.projectType] || f.projectType

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8" />
<style>
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #222; max-width: 720px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; color: #888; margin: 24px 0 8px; border-bottom: 1px solid #eee; padding-bottom: 4px; }
  .field { margin: 8px 0; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #999; }
  .value { font-size: 15px; line-height: 1.5; }
  .pill { display: inline-block; background: #f5e8df; color: #d97452; padding: 2px 10px; border-radius: 999px; font-size: 12px; margin: 0 4px 4px 0; }
  .meta { background: #fafafa; padding: 12px; border-radius: 8px; font-size: 12px; color: #666; margin-top: 24px; }
</style></head><body>
  <h1>Nuevo brief de Avoqado Labs</h1>
  <p style="color:#666;font-size:14px;margin:0 0 16px;">
    Sesión <code>${escapeHtml(payload.sessionId)}</code> · ${projectLabel[f.projectType] || f.projectType} · Urgencia: ${urgencyLabel[f.urgency] || f.urgency}
  </p>
  <h2>Contacto</h2>
  <div class="field"><div class="label">Nombre</div><div class="value">${escapeHtml(f.contact.name)}</div></div>
  ${f.contact.email ? `<div class="field"><div class="label">Email</div><div class="value"><a href="mailto:${escapeHtml(f.contact.email)}">${escapeHtml(f.contact.email)}</a></div></div>` : ''}
  ${f.contact.whatsapp ? `<div class="field"><div class="label">WhatsApp</div><div class="value">${escapeHtml(f.contact.whatsapp)}</div></div>` : ''}
  <h2>Proyecto</h2>
  <div class="field"><div class="label">Tipo</div><div class="value">${projectTypeLabel}</div></div>
  <div class="field"><div class="label">Contexto del negocio</div><div class="value">${escapeHtml(f.businessContext)}</div></div>
  <div class="field"><div class="label">Funcionalidad principal</div><div class="value">${escapeHtml(f.coreFunctionality)}</div></div>
  <div class="field"><div class="label">Integraciones</div><div class="value">
    ${f.integrations.length === 0 ? 'ninguna' : f.integrations.map(i => `<span class="pill">${escapeHtml(i)}</span>`).join('')}
  </div></div>
  <div class="field"><div class="label">Referencia de diseño</div><div class="value">${escapeHtml(f.designReference)}</div></div>
  <div class="field"><div class="label">Urgencia</div><div class="value">${urgencyLabel[f.urgency] || f.urgency}</div></div>
  ${payload.additionalNotes ? `<h2>Notas adicionales del cliente</h2><div class="value" style="white-space:pre-wrap;">${escapeHtml(payload.additionalNotes)}</div>` : ''}
  <h2>Transcripción</h2>
  ${transcriptHtml}
  <div class="meta">Enviado desde avoqado.io/labs · ${new Date().toISOString()}</div>
</body></html>`
}

export async function submitLabsBrief(req: Request, res: Response, next: NextFunction) {
  try {
    const payload = req.body
    if (!validateLabsPayload(payload)) {
      throw new BadRequestError('Faltan campos requeridos o son inválidos')
    }

    const html = renderLabsBriefHtml(payload)
    const subject = `[Labs] ${payload.fields.projectType} — ${payload.fields.contact.name} (${payload.fields.urgency})`

    // Internal notification with full brief as JSON attachment for archival
    const internalSent = await emailService.sendEmail({
      to: LABS_NOTIFY_EMAIL,
      subject,
      html,
      attachments: [
        {
          filename: `brief-${payload.sessionId}.json`,
          content: JSON.stringify(payload, null, 2),
          contentType: 'application/json',
        },
      ],
    })

    if (!internalSent) {
      // Always log the brief so we can recover the lead manually if email fails
      logger.error('[LABS_SUBMIT_FAILED]', {
        sessionId: payload.sessionId,
        contact: payload.fields.contact,
        projectType: payload.fields.projectType,
        coreFunctionality: payload.fields.coreFunctionality,
      })
      return res.status(502).json({
        success: false,
        message: 'El correo no se pudo enviar. Tu brief quedó registrado; Avoqado lo recupera manualmente.',
      })
    }

    // Confirmation to the lead — non-blocking quality.
    // Only sent if the lead provided an email. Whatsapp-only leads will be
    // contacted by Avoqado directly (no automated outbound on WA from this flow).
    if (payload.fields.contact.email) {
      const confirmSent = await emailService.sendEmail({
        to: payload.fields.contact.email,
        subject: 'Recibimos tu brief — Avoqado Labs',
        html: `
          <h2>Hola ${escapeHtml(payload.fields.contact.name)},</h2>
          <p>Recibimos tu brief para Avoqado Labs. Lo revisamos personalmente y te confirmamos timeline y costo en menos de 24 horas.</p>
          <p>Mientras tanto, si quieres agregar algo, responde a este correo.</p>
          <p style="color:#888;font-size:13px;">— El equipo de Avoqado Labs</p>
        `,
      })

      if (!confirmSent) {
        logger.warn('[LABS_SUBMIT] Confirmation email failed (brief delivered)', {
          sessionId: payload.sessionId,
          email: payload.fields.contact.email,
        })
      }
    }

    return res.status(200).json({ success: true, message: 'Brief enviado' })
  } catch (err) {
    return next(err)
  }
}

// ------------------------------------------------------------
// GET /api/v1/public/onboarding/continuar/:token
// ------------------------------------------------------------
/**
 * Salto medido del magic link del correo de bienvenida.
 *
 * El correo NO apunta directo al dashboard: pasa por aqui para poder registrar
 * que la persona SI hizo clic. Sin esto el embudo tiene un hueco ciego entre
 * "se mando el correo" y "fijo su contrasena", y no habria forma de distinguir
 * "nunca abrio el correo" de "entro pero se atoro eligiendo contrasena".
 *
 * No valida ni consume el token — de eso se encarga la pantalla de reset. Aqui
 * solo se cuenta el clic y se redirige. Un token invalido igual redirige, para
 * que sea la pantalla (que ya sabe hacerlo) quien explique el error.
 */
export async function continuarOnboarding(req: Request, res: Response, _next: NextFunction) {
  const token = String(req.params.token || '')
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'
  const destino = `${frontendUrl}/auth/reset-password/${encodeURIComponent(token)}`

  try {
    // El token viaja en claro en el correo; en la DB vive su hash SHA-256.
    const hashed = crypto.createHash('sha256').update(token).digest('hex')
    const staff = await prisma.staff.findFirst({
      where: { resetToken: hashed },
      select: { id: true, email: true, resetTokenExpiry: true, resetTokenUsedAt: true },
    })

    if (staff) {
      const vencido = staff.resetTokenExpiry ? staff.resetTokenExpiry < new Date() : true
      await prisma.activityLog.create({
        data: {
          staffId: staff.id,
          action: 'ONBOARDING_MAGIC_LINK_CLICKED',
          entity: 'Staff',
          entityId: staff.id,
          data: {
            source: 'landing_welcome_email',
            // Con estos dos se distingue "clic util" de "clic tardio o repetido",
            // que es justo donde se traba la gente.
            expired: vencido,
            alreadyUsed: Boolean(staff.resetTokenUsedAt),
            userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
          },
        },
      })
      logger.info('[ONBOARDING] Clic en el magic link', {
        staffId: staff.id,
        expired: vencido,
        alreadyUsed: Boolean(staff.resetTokenUsedAt),
      })
    } else {
      logger.warn('[ONBOARDING] Clic en magic link con token desconocido')
    }
  } catch (err) {
    // Medir jamas debe impedir que el usuario entre.
    logger.error('[ONBOARDING] No se pudo registrar el clic del magic link', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return res.redirect(302, destino)
}
