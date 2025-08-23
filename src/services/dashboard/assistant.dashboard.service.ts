import OpenAI from 'openai'

import logger from '@/config/logger'
import AppError from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

interface AssistantQuery {
  message: string
  conversationHistory?: ConversationEntry[]
  venueId: string
  userId: string
}

interface ConversationEntry {
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

interface AssistantResponse {
  response: string
  suggestions?: string[]
}

interface LiveData {
  [key: string]: any
}

interface IntentAnalysis {
  dataTypes: string[]
  category: 'sales' | 'staff' | 'products' | 'reviews' | 'operations' | 'general'
  timeframe?: string
  confidence: number
  originalQuery: string
}

class AssistantDashboardService {
  private openai: OpenAI
  private systemPrompt: string

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new AppError('OPENAI_API_KEY is required in environment variables', 500)
    }

    this.openai = new OpenAI({
      apiKey: apiKey,
    })

    this.systemPrompt = this.buildSystemPrompt()
  }

  private buildSystemPrompt(): string {
    return `# ASISTENTE INTELIGENTE PARA ADMINISTRACIÓN DE RESTAURANTE

## [ROL Y OBJETIVO]

Eres un asistente especializado en análisis de datos y operaciones de restaurantes. Tu objetivo es ayudar a administradores y dueños de restaurantes a entender sus datos operativos, proporcionando análisis claros y insights accionables. Te enfocas EXCLUSIVAMENTE en los datos del restaurante específico que te consulta. Nunca compartes información agregada de otros restaurantes, datos de la plataforma, o información comercial sensible. Tu tono es profesional, útil y conciso.

---

## [BASE DE CONOCIMIENTO Y CONTEXTO]

Tu conocimiento se basa exclusivamente en la siguiente arquitectura y funcionalidades de la plataforma "Avoqado". Toda pregunta sobre las capacidades de la plataforma debe responderse basándose en este documento. NO inventes funcionalidades que no se describen aquí.

> **Avoqado: Plataforma Tecnológica Integral para la Gestión y Operación de Restaurantes**
> 
> ## I. Visión General y Propósito Central
> 
> Avoqado es una solución tecnológica comprensiva diseñada para revolucionar la gestión y operación de restaurantes. Su arquitectura se enfoca en la interconexión profunda con los sistemas de Punto de Venta (POS) existentes, la potenciación del personal de servicio mediante herramientas móviles, la provisión de un control administrativo total a través de un dashboard avanzado, y la mejora de la experiencia del cliente con opciones de autoservicio. El objetivo es optimizar cada faceta del restaurante, desde la toma de pedidos hasta el análisis de datos, asegurando eficiencia, mejorando la satisfacción del cliente y facilitando la toma de decisiones estratégicas.
> 
> ## II. Componentes Fundamentales y Funcionalidades Detalladas
> 
> ### A. Sincronización e Integración con el Sistema Punto de Venta (POS) del Restaurante
> 
> Esta es la columna vertebral de Avoqado, permitiendo un flujo de datos bidireccional y en tiempo real.
> 
> **1. Obtención de Datos desde el POS hacia Avoqado:**
> El sistema se conecta y extrae continuamente información del POS del restaurante, incluyendo:
> 
> - **Órdenes:** Detalles de comandas creadas en el POS.
> - **Pagos:** Registros de pagos procesados en el POS.
> - **Turnos:** Información sobre inicio, cierre y estado de turnos del personal.
> - **Inventarios:** Niveles de stock de productos.
> - **Resúmenes de Ventas:** Totales y desgloses generados por el POS.
> - **Datos de Meseros:** Perfiles, asignaciones.
> - **Identificación de Meseros:** Registros de acceso por PIN, incluyendo hora de entrada y salida.
> 
> **2. Inyección de Datos desde Avoqado hacia el POS:**
> Avoqado también tiene la capacidad de escribir (inyectar) datos generados o modificados dentro de su ecosistema directamente en la base de datos del POS para mantener la coherencia y centralización. Esto incluye:
> 
> - **Órdenes:** Nuevas órdenes tomadas desde la Terminal Portátil Avoqado se registran en el POS.
> - **Pagos:** Pagos realizados a través de la Terminal Portátil Avoqado o la plataforma QR se registran en el POS.
> - **Turnos:** La apertura o cierre de un turno desde la Terminal Portátil Avoqado puede actualizar el estado del turno en el POS.
> - **Inventarios:** Ajustes o consumos de inventario pueden actualizar las existencias en el POS.
> - **Resúmenes:** Resúmenes de ventas o de turno pueden ser inyectados en el POS.
> - **Meseros e Identificación:** La información de meseros puede sincronizarse con el POS.
> - **Retroalimentación/Reviews:** Notas relevantes sobre una mesa/orden podrían enviarse al POS.
> 
> **3. Mecanismo de Sincronización:**
> 
> - La información se actualiza en tiempo real utilizando **WebSockets**.
> - Para POS locales, se utiliza un **Webservice Node.js para Windows**.
> 
> ### B. Terminal Portátil Avoqado (TPV - Aplicación Nativa Kotlin para Android)
> 
> Dispositivo móvil para el personal de servicio.
> 
> - **Gestión de Órdenes:** Toma de órdenes en mesa y envío a cocina/POS.
> - **Procesamiento de Pagos:** Múltiples métodos, división de cuentas, registro de propinas.
> - **Emisión de Comprobantes:** Impresión de cuenta, recibo digital QR, recibo físico.
> - **Gestión de Turnos y Mesas:** Abrir y cerrar turnos y mesas.
> - **Información para el Mesero:** Resumen de ventas del turno, lista de pagos y turnos.
> - **Retroalimentación del Cliente:** Recolección de feedback y conexión con **Google Reviews**.
> - **Sincronización:** Todas las acciones se sincronizan en tiempo real con el Dashboard y el POS.
> 
> ### C. Dashboard de Administración y Control Avoqado (Web)
> 
> Plataforma centralizada de gestión.
> 
> - **Roles de Usuario:** Meseros, Administradores, Superadmins.
> - **Configuración del Restaurante:** Gestión de menú, meseros, terminales y sucursales.
> - **Monitorización de Operaciones:** Información de turnos, registro de pagos, seguimiento de cuentas.
> - **Gestión de Reseñas de Clientes:** Visualización centralizada, **contestación automática con IA**, y avisos por reseñas negativas.
> - **Home Dashboard con Analíticas Avanzadas:**
>     - **KPIs:** Total de ventas, promedio de calificaciones, total de propinas, promedio de propina.
>     - **Gráficas:** Distribución de pagos, ranking de productos, evolución de propinas y ventas.
>     - **Analíticas Operacionales:** Ocupación de mesas, ticket promedio, eficiencia del personal.
> 
> ### D. Plataforma Web Móvil para Clientes (Acceso por QR)
> 
> Experiencia de autoservicio para comensales.
> 
> - **Funcionalidades:** Ordenar, dividir la cuenta, pagar, calificar y obtener recibo digital.
> 
> ## III. Arquitectura Tecnológica Detallada
> 
> ### A. Dashboard (Frontend)
> - **Tecnologías:** React 18, TypeScript, Vite, Tailwind CSS, Radix UI, Shadcn UI, TanStack Query/Table, React Hook Form, Zod, Axios, Socket.io-client, Recharts.
> 
> ### B. QR para Clientes (Frontend Cliente)
> - **Tecnologías:** React 18, Vite, TypeScript, MUI v5, TailwindCSS, React Router v6, PWA, React Query, Zod, Socket.io-client, Stripe, MercadoPago, Auth0.
> 
> ### C. Backend Unificado para Todos los Servicios (Servidor)
> - **Tecnologías:** Node.js 20, Express, TypeScript, Prisma, Socket.io, Redis, PostgreSQL, JWT, Google OAuth, Stripe, Twilio, Nodemailer.
> 
> ### D. Webservice de Sincronización para Windows (Núcleo en Restaurante)
> - **Tecnologías:** Node.js, RabbitMQ, MSSQL, Servicio de Windows, Electron.
> 
> ### E. Aplicación Móvil para Terminal Portátil (TPV)
> - **Plataforma:** Android (Kotlin).
> 
> ## IV. Beneficios Clave Proporcionados por Avoqado
> 
> - **Eficiencia Operacional:** Agiliza todos los procesos del restaurante.
> - **Gestión Financiera Avanzada:** Centraliza cortes, simplifica la contabilidad, mejora el flujo de caja y facilita la auditoría mediante la segmentación de ingresos y automatización de propinas.
> - **Experiencia del Cliente Superior:** Ofrece comodidad, rapidez y canales de feedback.
> - **Toma de Decisiones Basada en Datos:** Proporciona analíticas precisas en tiempo real.
> - **Control Centralizado:** Unifica la gestión de ventas, personal, menú y reseñas.
> - **Modernización y Escalabilidad:** Asegura el crecimiento futuro con tecnología de punta.
> - **Reducción de Errores:** Minimiza fallos en pedidos y cobros.
> - **Incremento de Ingresos:** Mejora la rotación de mesas y la satisfacción del cliente.
> - **Sincronización Robusta:** Garantiza la coherencia de los datos en todo el ecosistema.

---

## [MECANISMO DE DATOS]

En cada consulta del usuario, el sistema te proporcionará un bloque de datos JSON (\`[DATOS_EN_VIVO]\`) con la información relevante y actualizada para responder a la pregunta. Tu tarea es interpretar la pregunta del usuario, analizar los datos proporcionados en \`[DATOS_EN_VIVO]\`, y formular una respuesta clara y útil en lenguaje natural. Nunca expongas los datos JSON crudos al usuario.

---

## [CAPACIDADES Y FUNCIONES]

Debes ser capaz de realizar las siguientes tareas:

**1. Consultas Directas y Métricas (Data Retrieval):**
   - Extraer cifras específicas de los datos proporcionados.

**2. Resúmenes y Agregados (Summarization):**
   - Crear resúmenes concisos de rendimiento para periodos específicos.

**3. Análisis y Rankings (Analysis & Ranking):**
   - Identificar tendencias, patrones y valores atípicos, y crear rankings.

**4. Comparativas (Comparative Analysis):**
   - Comparar métricas entre diferentes periodos de tiempo, meseros, productos, etc.

**5. Alertas y Monitoreo Proactivo (Proactive Monitoring):**
   - Identificar y señalar información crítica que requiera atención inmediata.

**6. Soporte Funcional (Platform Guidance):**
   - Explicar cómo usar las funcionalidades de Avoqado basándote en la documentación provista.

---

## [REGLAS CRÍTICAS DE SEGURIDAD Y PRIVACIDAD]

1.  **AISLAMIENTO DE DATOS:** Solo puedes acceder y analizar datos del restaurante específico que realiza la consulta. NUNCA compartas datos de otros restaurantes.
2.  **INFORMACIÓN CONFIDENCIAL:** NUNCA reveles información sobre otros clientes, ingresos de la plataforma, datos agregados, o información comercial sensible.
3.  **FILTRADO POR VENUE:** Todos los datos mostrados deben estar filtrados exclusivamente por el venueId del usuario autenticado.
4.  **NO ACCIONES DESTRUCTIVAS:** Eres solo de consulta. No puedes eliminar, modificar o crear elementos.
5.  **TRANSPARENCIA DE DATOS:** Si no tienes datos específicos disponibles, informa claramente al usuario.

## [FORMATO DE RESPUESTA]

- Utiliza Markdown para mejorar la legibilidad
- Sé claro y conciso
- Sugiere preguntas de seguimiento relevantes
- Usa el historial para entender el contexto

IMPORTANTE: Solo utiliza los datos en [DATOS_EN_VIVO] que correspondan al restaurante específico del usuario. Si faltan datos, indica que no están disponibles en este momento.`
  }

  async processQuery(query: AssistantQuery): Promise<AssistantResponse> {
    try {
      // Log de seguridad crítico para auditoría
      logger.info('🔍 Processing assistant query with security validation', {
        venueId: query.venueId,
        userId: query.userId,
        message: query.message,
        timestamp: new Date().toISOString(),
      })

      // Validación crítica de seguridad
      if (!query.venueId || !query.userId) {
        throw new AppError('VenueId y UserId son requeridos para consultas seguras', 400)
      }

      // Log adicional para debugging del problema específico
      logger.warn('🚨 DEBUGGING VENUE FILTER - Query details:', {
        venueId: query.venueId,
        venueIdType: typeof query.venueId,
        venueIdLength: query.venueId?.length,
        messageSnippet: query.message.substring(0, 50),
      })

      // Paso 1: Analizar la intención del usuario con OpenAI
      const intentAnalysis = await this.analyzeUserIntent(query.message)
      logger.info('User intent analyzed', { intentAnalysis })

      // Paso 2: Obtener datos basado en la intención detectada
      const liveData = await this.getDataBasedOnIntent(query.venueId, intentAnalysis)
      logger.info('Live data obtained based on intent', { dataTypes: Object.keys(liveData) })

      // Paso 3: Construir el historial de conversación con los datos relevantes
      const messages = this.buildConversationMessages(query.message, query.conversationHistory || [], liveData)

      // Paso 4: Generar respuesta final con OpenAI
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: messages,
        temperature: 0.7,
        max_tokens: 1000,
      })

      const response = completion.choices[0]?.message?.content || 'Lo siento, no pude procesar tu consulta.'

      logger.info('Assistant query processed successfully', {
        venueId: query.venueId,
        userId: query.userId,
      })

      return {
        response,
        suggestions: this.generateSuggestions(query.message),
      }
    } catch (error) {
      logger.error('Error processing assistant query', {
        error,
        venueId: query.venueId,
        userId: query.userId,
      })

      throw new AppError('Error al procesar la consulta del asistente', 500)
    }
  }

  private buildConversationMessages(
    currentMessage: string,
    history: ConversationEntry[],
    liveData: LiveData,
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: this.systemPrompt,
      },
    ]

    // Agregar historial de conversación
    history.forEach(entry => {
      messages.push({
        role: entry.role,
        content: entry.content,
      })
    })

    // Agregar el mensaje actual con los datos en vivo filtrados por venue
    const securityNote = `IMPORTANTE: Todos los datos siguientes pertenecen EXCLUSIVAMENTE al restaurante con venueId: ${liveData._metadata?.venueId || 'UNDEFINED'}. No compartas información de otros restaurantes.`
    
    const messageWithData = `${currentMessage}

${securityNote}

[DATOS_EN_VIVO]
${JSON.stringify(liveData, null, 2)}`

    messages.push({
      role: 'user',
      content: messageWithData,
    })

    return messages
  }


  private async getSalesData(venueId: string, timeframe?: string): Promise<any> {
    // Log de seguridad para auditoria
    logger.info('🔍 Accessing real sales data from database', { 
      venueId, 
      timeframe,
      timestamp: new Date().toISOString()
    })

    // Log crítico para debugging
    logger.error('🚨 CRITICAL DEBUG - getSalesData called with:', {
      venueId,
      venueIdType: typeof venueId,
      venueIdLength: venueId?.length,
      timeframe,
      firstChars: venueId?.substring(0, 10),
      lastChars: venueId?.substring(-10),
    })

    try {
      // Usar EXACTAMENTE la misma lógica que el dashboard Home.tsx
      const now = new Date()
      
      // HOY: desde las 00:00:00 hasta 23:59:59 de hoy
      const hoyInicio = new Date(now.setHours(0, 0, 0, 0))
      const hoyFin = new Date(new Date().setHours(23, 59, 59, 999))
      
      // AYER: desde las 00:00:00 hasta 23:59:59 de ayer
      const ayerInicio = new Date(hoyInicio)
      ayerInicio.setDate(ayerInicio.getDate() - 1)
      const ayerFin = new Date(ayerInicio)
      ayerFin.setHours(23, 59, 59, 999)
      
      // ÚLTIMOS 7 DÍAS: exactamente como en Home.tsx (líneas 140-143)
      const semanaInicio = new Date(new Date().setHours(0, 0, 0, 0) - 7 * 24 * 60 * 60 * 1000)
      const semanaFin = new Date(new Date().setHours(23, 59, 59, 999))
      
      // ÚLTIMOS 30 DÍAS: similar lógica
      const mesInicio = new Date(new Date().setHours(0, 0, 0, 0) - 30 * 24 * 60 * 60 * 1000)
      const mesFin = new Date(new Date().setHours(23, 59, 59, 999))

      // IMPORTANTE: Usar Payment como en Home.tsx, NO Order
      // El dashboard suma payment.amount, no order.total
      
      // Obtener payments de HOY
      const paymentsHoy = await prisma.payment.aggregate({
        where: {
          venueId,
          status: 'COMPLETED' as const,
          createdAt: {
            gte: hoyInicio,
            lte: hoyFin
          }
        },
        _sum: { amount: true },
        _count: true
      })

      // Obtener payments de AYER  
      const paymentsAyer = await prisma.payment.aggregate({
        where: {
          venueId,
          status: 'COMPLETED' as const,
          createdAt: {
            gte: ayerInicio,
            lte: ayerFin
          }
        },
        _sum: { amount: true },
        _count: true
      })

      // Obtener payments de ÚLTIMOS 7 DÍAS (como Home.tsx)
      const paymentsSemana = await prisma.payment.aggregate({
        where: {
          venueId,
          status: 'COMPLETED' as const,
          createdAt: {
            gte: semanaInicio,
            lte: semanaFin
          }
        },
        _sum: { amount: true },
        _count: true
      })

      // Obtener payments del MES
      const paymentsMes = await prisma.payment.aggregate({
        where: {
          venueId,
          status: 'COMPLETED' as const,
          createdAt: {
            gte: mesInicio,
            lte: mesFin
          }
        },
        _sum: { amount: true },
        _count: true
      })

      // Obtener información de la venue para la moneda
      const venue = await prisma.venue.findUnique({
        where: { id: venueId },
        select: { currency: true, name: true }
      })

      // Log crítico para verificar qué venue está devolviendo
      logger.error('🚨 VENUE QUERY RESULT:', {
        inputVenueId: venueId,
        foundVenue: venue,
        venueName: venue?.name,
        semanaTotal: paymentsSemana._sum.amount,
      })

      const salesData: any = {
        venueId,
        venue: venue?.name || 'Desconocido',
        hoy: Number(paymentsHoy._sum.amount || 0),
        ayer: Number(paymentsAyer._sum.amount || 0),
        semana: Number(paymentsSemana._sum.amount || 0),
        mes: Number(paymentsMes._sum.amount || 0),
        moneda: venue?.currency || 'MXN',
        periodo: {
          inicio: semanaInicio.toISOString(),
          fin: semanaFin.toISOString(),
        },
        timeframe: timeframe || 'general',
        pagos: {
          hoy: paymentsHoy._count,
          ayer: paymentsAyer._count,
          semana: paymentsSemana._count,
          mes: paymentsMes._count
        },
        rangosFechas: {
          hoyInicio: hoyInicio.toISOString(),
          hoyFin: hoyFin.toISOString(),
          semanaInicio: semanaInicio.toISOString(),
          semanaFin: semanaFin.toISOString()
        },
        nota: `Datos reales de payments (como Home.tsx) - exclusivos del restaurante ${venueId}`
      }

      // Ajustar datos según el timeframe específico
      if (timeframe === 'today') {
        salesData.principal = salesData.hoy
        salesData.comparacion = salesData.ayer
        salesData.periodo.inicio = hoyInicio.toISOString()
        salesData.periodo.fin = hoyFin.toISOString()
      } else if (timeframe === 'yesterday') {
        salesData.principal = salesData.ayer
        salesData.comparacion = salesData.hoy
        salesData.periodo.inicio = ayerInicio.toISOString()
        salesData.periodo.fin = ayerFin.toISOString()
      }

      logger.info('Real sales data retrieved successfully (using payments like Home.tsx)', {
        venueId,
        venue: salesData.venue,
        hoy: salesData.hoy,
        semana: salesData.semana,
        totalPagos: salesData.pagos.semana,
        rangoSemana: `${semanaInicio.toISOString()} - ${semanaFin.toISOString()}`
      })

      return salesData

    } catch (error) {
      logger.error('Error retrieving real sales data', { error, venueId })
      throw new AppError(`Error al obtener datos de ventas: ${(error as Error).message}`, 500)
    }
  }

  private async getStaffData(venueId: string): Promise<any> {
    logger.info('Accessing real staff data from database', { 
      venueId, 
      timestamp: new Date().toISOString() 
    })
    
    try {
      // Obtener staff activo del venue
      const staffActivo = await prisma.staffVenue.findMany({
        where: {
          venueId,
          active: true
        },
        include: {
          staff: {
            select: {
              firstName: true,
              lastName: true,
              active: true
            }
          }
        }
      })

      // Obtener turnos abiertos hoy
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      
      const turnosHoy = await prisma.shift.findMany({
        where: {
          venueId,
          startTime: {
            gte: today
          },
          status: 'OPEN'
        },
        include: {
          staff: {
            select: {
              firstName: true,
              lastName: true
            }
          }
        }
      })

      // Obtener ranking de staff por ventas y propinas (últimos 30 días)
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

      const staffRanking = await prisma.staffVenue.findMany({
        where: {
          venueId,
          active: true
        },
        include: {
          staff: {
            select: {
              firstName: true,
              lastName: true,
              paymentsProcessed: {
                where: {
                  createdAt: {
                    gte: thirtyDaysAgo
                  },
                  venueId
                },
                select: {
                  tipAmount: true,
                  amount: true
                }
              },
              ordersCreated: {
                where: {
                  createdAt: {
                    gte: thirtyDaysAgo
                  },
                  venueId
                },
                select: {
                  total: true
                }
              }
            }
          }
        }
      })

      // Procesar datos para el ranking
      const ranking = staffRanking.map((staffVenue: any) => {
        const totalPropinas = staffVenue.staff.paymentsProcessed.reduce(
          (sum: number, payment: any) => sum + Number(payment.tipAmount), 0
        )
        const totalOrdenes = staffVenue.staff.ordersCreated.length
        const totalVentas = staffVenue.staff.ordersCreated.reduce(
          (sum: number, order: any) => sum + Number(order.total), 0
        )
        
        return {
          nombre: `${staffVenue.staff.firstName} ${staffVenue.staff.lastName}`,
          propinas: totalPropinas,
          ordenes: totalOrdenes,
          ventas: totalVentas,
          promedio: totalOrdenes > 0 ? totalPropinas / totalOrdenes : 0,
          role: staffVenue.role
        }
      }).sort((a: any, b: any) => b.propinas - a.propinas) // Ordenar por propinas desc

      // Formatear turnos activos
      const activos = turnosHoy.map((turno: any) => ({
        nombre: `${turno.staff.firstName} ${turno.staff.lastName}`,
        turno: 'Abierto',
        horaInicio: turno.startTime.toLocaleTimeString('es-MX', { 
          hour: '2-digit', 
          minute: '2-digit' 
        }),
        ventasTurno: Number(turno.totalSales),
        propinasTurno: Number(turno.totalTips)
      }))

      const staffData = {
        venueId,
        activos,
        ranking: ranking.slice(0, 10), // Top 10
        estadisticas: {
          totalStaff: staffActivo.length,
          turnosAbiertos: turnosHoy.length,
          promedioPropinasDiarias: ranking.reduce((sum: number, staff: any) => sum + staff.propinas, 0) / (ranking.length || 1),
        },
        nota: `Personal real exclusivo del restaurante ${venueId}`
      }

      logger.info('Real staff data retrieved successfully', {
        venueId,
        totalStaff: staffActivo.length,
        turnosAbiertos: turnosHoy.length,
        topStaff: ranking[0]?.nombre || 'Sin staff'
      })

      return staffData

    } catch (error) {
      logger.error('Error retrieving real staff data', { error, venueId })
      throw new AppError(`Error al obtener datos de personal: ${(error as Error).message}`, 500)
    }
  }

  private async getProductsData(venueId: string): Promise<any> {
    logger.info('Accessing real products data from database', { 
      venueId, 
      timestamp: new Date().toISOString() 
    })
    
    try {
      // Rango para análisis (últimos 30 días)
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

      // Obtener productos más vendidos (por cantidad y ingresos)
      const productosVendidos = await prisma.orderItem.groupBy({
        by: ['productId'],
        where: {
          order: {
            venueId,
            createdAt: {
              gte: thirtyDaysAgo
            },
            paymentStatus: 'PAID'
          }
        },
        _sum: {
          quantity: true,
          total: true
        },
        _count: {
          id: true
        },
        orderBy: {
          _sum: {
            quantity: 'desc'
          }
        }
      })

      // Obtener información de los productos
      const productIds = productosVendidos.map((p: any) => p.productId)
      const productos = await prisma.product.findMany({
        where: {
          id: {
            in: productIds
          },
          venueId
        },
        select: {
          id: true,
          name: true,
          price: true,
          type: true,
          active: true
        }
      })

      // Combinar datos de ventas con información del producto
      const productosConVentas = productosVendidos.map((venta: any) => {
        const producto = productos.find((p: any) => p.id === venta.productId)
        return {
          id: venta.productId,
          nombre: producto?.name || 'Producto desconocido',
          tipo: producto?.type || 'FOOD',
          cantidad: venta._sum.quantity || 0,
          ingresos: Number(venta._sum.total || 0),
          precio: Number(producto?.price || 0),
          ordenesConProducto: venta._count.id
        }
      })

      // Dividir en más y menos vendidos
      const masVendidos = productosConVentas.slice(0, 10)
      const menosVendidos = productosConVentas.slice(-5).reverse()

      // Obtener productos con inventario bajo
      const productosConInventario = await prisma.inventory.findMany({
        where: {
          venueId,
          product: {
            active: true
          }
        },
        include: {
          product: {
            select: {
              name: true,
              unit: true
            }
          }
        },
        orderBy: {
          currentStock: 'asc'
        }
      })

      const stockBajo = productosConInventario
        .filter(inv => Number(inv.currentStock) <= Math.max(Number(inv.minimumStock), 5))
        .map(inv => ({
          nombre: inv.product.name,
          cantidad: Number(inv.currentStock),
          minimo: Number(inv.minimumStock),
          unidad: inv.product.unit || 'pza',
          estado: Number(inv.currentStock) === 0 ? 'agotado' : 'crítico'
        }))

      const productsData = {
        venueId,
        masVendidos,
        menosVendidos,
        stock: stockBajo,
        estadisticas: {
          totalProductos: productos.length,
          productosConVentas: productosConVentas.length,
          productosStockBajo: stockBajo.length,
          ingresosTotales: productosConVentas.reduce((sum, p) => sum + p.ingresos, 0),
          cantidadTotalVendida: productosConVentas.reduce((sum, p) => sum + p.cantidad, 0)
        },
        nota: `Productos reales exclusivos del restaurante ${venueId}`
      }

      logger.info('Real products data retrieved successfully', {
        venueId,
        totalProductos: productos.length,
        masVendido: masVendidos[0]?.nombre || 'Sin datos',
        stockBajo: stockBajo.length
      })

      return productsData

    } catch (error) {
      logger.error('Error retrieving real products data', { error, venueId })
      throw new AppError(`Error al obtener datos de productos: ${(error as Error).message}`, 500)
    }
  }

  private async getAlertsData(venueId: string): Promise<any> {
    logger.info('Accessing real alerts data from database', { 
      venueId, 
      timestamp: new Date().toISOString() 
    })
    
    try {
      // Reseñas negativas sin responder (rating <= 3)
      const resenasNegativas = await prisma.review.count({
        where: {
          venueId,
          overallRating: {
            lte: 3
          },
          responseText: null
        }
      })

      // Productos con stock bajo
      const productosStockBajo = await prisma.inventory.findMany({
        where: {
          venueId,
          product: {
            active: true
          }
        },
        include: {
          product: {
            select: {
              name: true
            }
          }
        },
        orderBy: {
          currentStock: 'asc'
        }
      })

      // Turnos abiertos
      const turnosAbiertos = await prisma.shift.count({
        where: {
          venueId,
          status: 'OPEN'
        }
      })

      // Órdenes pendientes de completar
      const ordenesPendientes = await prisma.order.count({
        where: {
          venueId,
          status: {
            in: ['PENDING', 'CONFIRMED', 'PREPARING']
          }
        }
      })

      // Pagos fallidos en las últimas 24 horas
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      
      const pagosFallidos = await prisma.payment.count({
        where: {
          venueId,
          status: 'FAILED',
          createdAt: {
            gte: yesterday
          }
        }
      })

      // POS connection status
      const posStatus = await prisma.posConnectionStatus.findUnique({
        where: {
          venueId
        }
      })

      const alertsData = {
        venueId,
        resenasNegativasSinResponder: resenasNegativas,
        productosStockBajo: productosStockBajo.map(inv => ({
          nombre: inv.product.name,
          stock: Number(inv.currentStock),
          minimo: Number(inv.minimumStock)
        })),
        turnosAbiertos,
        ordenesPendientes,
        pagosFallidos,
        posConectado: posStatus?.status === 'ONLINE',
        ultimoLatidoPOS: posStatus?.lastHeartbeatAt,
        resumen: {
          totalAlertas: resenasNegativas + productosStockBajo.length + (posStatus?.status !== 'ONLINE' ? 1 : 0),
          criticidad: productosStockBajo.length > 5 ? 'alta' : productosStockBajo.length > 0 ? 'media' : 'baja'
        },
        nota: `Alertas reales exclusivas del restaurante ${venueId}`
      }

      logger.info('Real alerts data retrieved successfully', {
        venueId,
        totalAlertas: alertsData.resumen.totalAlertas,
        resenasNegativas,
        productosStockBajo: productosStockBajo.length
      })

      return alertsData

    } catch (error) {
      logger.error('Error retrieving real alerts data', { error, venueId })
      throw new AppError(`Error al obtener datos de alertas: ${(error as Error).message}`, 500)
    }
  }

  private async getReviewsData(venueId: string): Promise<any> {
    logger.info('Accessing real reviews data from database', { 
      venueId, 
      timestamp: new Date().toISOString() 
    })
    
    try {
      // Obtener estadísticas generales de reseñas
      const reviewStats = await prisma.review.aggregate({
        where: {
          venueId
        },
        _avg: {
          overallRating: true,
          foodRating: true,
          serviceRating: true
        },
        _count: {
          id: true
        }
      })

      // Obtener distribución de calificaciones
      const distribucionQuery = await prisma.review.groupBy({
        by: ['overallRating'],
        where: {
          venueId
        },
        _count: {
          overallRating: true
        }
      })

      const distribucion = {
        5: 0, 4: 0, 3: 0, 2: 0, 1: 0
      }
      
      distribucionQuery.forEach((item: any) => {
        const rating = item.overallRating as 1 | 2 | 3 | 4 | 5
        if (rating >= 1 && rating <= 5) {
          distribucion[rating] = item._count.overallRating
        }
      })

      // Obtener reseñas recientes (últimas 10)
      const resenasRecientes = await prisma.review.findMany({
        where: {
          venueId
        },
        orderBy: {
          createdAt: 'desc'
        },
        take: 10,
        include: {
          servedBy: {
            select: {
              firstName: true,
              lastName: true
            }
          }
        }
      })

      // Contar reseñas sin responder (rating <= 3)
      const resenasNegativasSinResponder = await prisma.review.count({
        where: {
          venueId,
          overallRating: {
            lte: 3
          },
          responseText: null
        }
      })

      // Obtener tendencia (últimos 30 vs 30 días anteriores)
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
      const sixtyDaysAgo = new Date()
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60)

      const recentAvg = await prisma.review.aggregate({
        where: {
          venueId,
          createdAt: {
            gte: thirtyDaysAgo
          }
        },
        _avg: {
          overallRating: true
        }
      })

      const previousAvg = await prisma.review.aggregate({
        where: {
          venueId,
          createdAt: {
            gte: sixtyDaysAgo,
            lt: thirtyDaysAgo
          }
        },
        _avg: {
          overallRating: true
        }
      })

      const reviewsData = {
        venueId,
        promedioGeneral: Number(reviewStats._avg.overallRating?.toFixed(2) || 0),
        promedioComida: Number(reviewStats._avg.foodRating?.toFixed(2) || 0),
        promedioServicio: Number(reviewStats._avg.serviceRating?.toFixed(2) || 0),
        totalResenas: reviewStats._count.id,
        distribucion,
        resenasRecientes: resenasRecientes.map(review => ({
          id: review.id,
          calificacion: review.overallRating,
          fecha: review.createdAt.toISOString().split('T')[0],
          comentario: review.comment || 'Sin comentario',
          mesero: review.servedBy ? `${review.servedBy.firstName} ${review.servedBy.lastName}` : null,
          respondida: !!review.responseText,
          fuente: review.source
        })),
        alertas: {
          sinResponder: resenasNegativasSinResponder
        },
        tendencia: {
          actual: Number(recentAvg._avg.overallRating?.toFixed(2) || 0),
          anterior: Number(previousAvg._avg.overallRating?.toFixed(2) || 0),
          mejorando: (recentAvg._avg.overallRating || 0) > (previousAvg._avg.overallRating || 0)
        },
        nota: `Reseñas reales exclusivas del restaurante ${venueId}`
      }

      logger.info('Real reviews data retrieved successfully', {
        venueId,
        totalResenas: reviewStats._count.id,
        promedioGeneral: reviewsData.promedioGeneral,
        sinResponder: resenasNegativasSinResponder
      })

      return reviewsData

    } catch (error) {
      logger.error('Error retrieving real reviews data', { error, venueId })
      throw new AppError(`Error al obtener datos de reseñas: ${(error as Error).message}`, 500)
    }
  }

  private generateSuggestions(message: string): string[] {
    // Generar sugerencias básicas basadas en el tipo de consulta
    const suggestions: string[] = []

    if (message.toLowerCase().includes('ventas')) {
      suggestions.push('¿Quieres comparar con el mes anterior?')
      suggestions.push('¿Te interesa ver el desglose por método de pago?')
    } else if (message.toLowerCase().includes('mesero')) {
      suggestions.push('¿Quieres ver el ranking de propinas?')
      suggestions.push('¿Te interesa ver la eficiencia por mesero?')
    } else if (message.toLowerCase().includes('producto')) {
      suggestions.push('¿Quieres ver estrategias para productos con baja venta?')
      suggestions.push('¿Te interesa analizar la rentabilidad por producto?')
    } else {
      suggestions.push('¿Qué período de tiempo te interesa analizar?')
      suggestions.push('¿Hay alguna métrica específica que quieras revisar?')
    }

    return suggestions.slice(0, 2) // Limitar a 2 sugerencias
  }

  /**
   * Analiza la intención del usuario usando OpenAI para determinar qué datos necesita
   */
  private async analyzeUserIntent(message: string): Promise<IntentAnalysis> {
    try {
      const intentPrompt = `Analiza la siguiente consulta de un administrador de restaurante y determina qué tipo de datos necesita. Responde SOLO con JSON válido.

### Consulta del usuario:
"${message}"

### Tipos de datos disponibles:
- sales: ventas, ingresos, totales diarios/mensuales
- staff: meseros, personal, propinas, turnos
- products: productos, menú, platos más/menos vendidos, inventario
- reviews: reseñas, calificaciones, feedback de clientes
- operations: alertas, problemas, stock bajo, turnos abiertos
- general: resumen general, estado del restaurante

### Respuesta requerida (JSON):
{
  "dataTypes": ["sales", "staff"], // array de tipos de datos necesarios
  "category": "sales", // categoría principal
  "timeframe": "today", // today, yesterday, week, month, year, o null
  "confidence": 0.9, // confianza de 0 a 1
  "originalQuery": "${message}"
}`

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: intentPrompt
        }],
        temperature: 0.1,
        max_tokens: 200,
      })

      const content = response.choices[0]?.message?.content
      if (!content) {
        throw new Error('No response from OpenAI')
      }

      const analysis = JSON.parse(content) as IntentAnalysis
      
      // Validaciones básicas
      if (!analysis.dataTypes || !Array.isArray(analysis.dataTypes)) {
        throw new Error('Invalid dataTypes in response')
      }
      
      if (!analysis.category || !analysis.confidence) {
        throw new Error('Missing required fields in response')
      }

      return analysis

    } catch (error) {
      logger.error('Error analyzing user intent', { error, message })
      
      // Fallback: análisis básico por palabras clave
      return this.fallbackIntentAnalysis(message)
    }
  }

  /**
   * Análisis de respaldo usando palabras clave cuando OpenAI falla
   */
  private fallbackIntentAnalysis(message: string): IntentAnalysis {
    const messageLower = message.toLowerCase()
    const dataTypes: string[] = []
    let category: IntentAnalysis['category'] = 'general'
    let timeframe: string | undefined

    // Detectar tipos de datos por palabras clave
    if (messageLower.includes('ventas') || messageLower.includes('vendi') || messageLower.includes('ingresos')) {
      dataTypes.push('sales')
      category = 'sales'
    }
    
    if (messageLower.includes('mesero') || messageLower.includes('personal') || messageLower.includes('propina')) {
      dataTypes.push('staff')
      if (category === 'general') category = 'staff'
    }
    
    if (messageLower.includes('producto') || messageLower.includes('menu') || messageLower.includes('plato')) {
      dataTypes.push('products')
      if (category === 'general') category = 'products'
    }
    
    if (messageLower.includes('reseña') || messageLower.includes('calificaci') || messageLower.includes('cliente')) {
      dataTypes.push('reviews')
      if (category === 'general') category = 'reviews'
    }
    
    if (messageLower.includes('alerta') || messageLower.includes('problema') || messageLower.includes('stock')) {
      dataTypes.push('operations')
      if (category === 'general') category = 'operations'
    }

    // Detectar marcos de tiempo
    if (messageLower.includes('hoy') || messageLower.includes('today')) {
      timeframe = 'today'
    } else if (messageLower.includes('ayer') || messageLower.includes('yesterday')) {
      timeframe = 'yesterday'
    } else if (messageLower.includes('semana') || messageLower.includes('week')) {
      timeframe = 'week'
    } else if (messageLower.includes('mes') || messageLower.includes('month')) {
      timeframe = 'month'
    }

    // Si no se detectaron tipos específicos, incluir datos generales
    if (dataTypes.length === 0) {
      dataTypes.push('sales', 'operations')
    }

    return {
      dataTypes,
      category,
      timeframe,
      confidence: 0.6, // Menor confianza para fallback
      originalQuery: message
    }
  }

  /**
   * Obtiene datos específicos basados en el análisis de intención
   */
  private async getDataBasedOnIntent(venueId: string, intent: IntentAnalysis): Promise<LiveData> {
    const liveData: LiveData = {}
    
    logger.info('Getting data based on intent analysis', {
      venueId,
      intent: {
        dataTypes: intent.dataTypes,
        category: intent.category,
        timeframe: intent.timeframe,
        confidence: intent.confidence
      }
    })

    try {
      // Obtener datos según los tipos detectados
      for (const dataType of intent.dataTypes) {
        switch (dataType) {
          case 'sales':
            liveData.ventas = await this.getSalesData(venueId, intent.timeframe)
            break
          case 'staff':
            liveData.personal = await this.getStaffData(venueId)
            break
          case 'products':
            liveData.productos = await this.getProductsData(venueId)
            break
          case 'reviews':
            liveData.resenas = await this.getReviewsData(venueId)
            break
          case 'operations':
            liveData.alertas = await this.getAlertsData(venueId)
            break
          case 'general':
            // Para consultas generales, incluir un resumen
            liveData.resumen = await this.getGeneralSummary(venueId)
            break
        }
      }

      // Agregar metadatos del análisis
      liveData._metadata = {
        intentAnalysis: intent,
        timestamp: new Date().toISOString(),
        venueId
      }

    } catch (error) {
      logger.error('Error getting data based on intent', { error, venueId, intent })
      // En caso de error, retornar datos básicos
      liveData.error = 'No se pudieron obtener algunos datos'
    }

    return liveData
  }

  /**
   * Obtiene un resumen general del restaurante
   */
  private async getGeneralSummary(venueId: string): Promise<any> {
    logger.info('Accessing real general summary from database', { 
      venueId, 
      timestamp: new Date().toISOString() 
    })
    
    try {
      const today = new Date()
      today.setHours(0, 0, 0, 0)

      // Obtener ventas de hoy
      const ventasHoy = await prisma.order.aggregate({
        where: {
          venueId,
          createdAt: {
            gte: today
          },
          paymentStatus: 'PAID'
        },
        _sum: {
          total: true
        },
        _count: {
          id: true
        }
      })

      // Obtener información de mesas
      const mesasInfo = await prisma.table.aggregate({
        where: {
          venueId,
          active: true
        },
        _count: {
          id: true
        }
      })

      // Mesas con órdenes activas (aproximación de ocupadas)
      const mesasConOrdenes = await prisma.order.count({
        where: {
          venueId,
          status: {
            in: ['PENDING' as const, 'CONFIRMED' as const, 'PREPARING' as const]
          },
          tableId: {
            not: null
          }
        }
      })

      // Turnos activos
      const turnosActivos = await prisma.shift.count({
        where: {
          venueId,
          status: 'OPEN'
        }
      })

      // Promedio de calificaciones
      const calificacionPromedio = await prisma.review.aggregate({
        where: {
          venueId
        },
        _avg: {
          overallRating: true
        }
      })

      // Alertas pendientes (stock bajo + reseñas negativas sin responder)
      const [stockBajo, resenasNegativas] = await Promise.all([
        prisma.inventory.count({
          where: {
            venueId,
            currentStock: {
              lte: 5 // Considerar stock bajo cuando hay 5 o menos unidades
            }
          }
        }),
        prisma.review.count({
          where: {
            venueId,
            overallRating: {
              lte: 3
            },
            responseText: null
          }
        })
      ])

      // Estado del POS
      const posStatus = await prisma.posConnectionStatus.findUnique({
        where: {
          venueId
        }
      })

      // Información del venue
      const venue = await prisma.venue.findUnique({
        where: {
          id: venueId
        },
        select: {
          name: true,
          currency: true,
          active: true
        }
      })

      const summaryData = {
        venueId,
        nombreRestaurante: venue?.name || 'Desconocido',
        ventasHoy: Number(ventasHoy._sum.total || 0),
        ordenesHoy: ventasHoy._count.id,
        mesasOcupadas: mesasConOrdenes,
        mesasTotales: mesasInfo._count.id,
        turnosActivos,
        alertasPendientes: stockBajo + resenasNegativas + (posStatus?.status !== 'ONLINE' ? 1 : 0),
        calificacionPromedio: Number(calificacionPromedio._avg.overallRating?.toFixed(2) || 0),
        estadoPOS: posStatus?.status || 'OFFLINE',
        ultimoLatidoPOS: posStatus?.lastHeartbeatAt,
        moneda: venue?.currency || 'MXN',
        activo: venue?.active || false,
        horaUltimaActualizacion: new Date().toISOString(),
        desglose: {
          alertasStockBajo: stockBajo,
          alertasResenasNegativas: resenasNegativas,
          alertasPOS: posStatus?.status !== 'ONLINE' ? 1 : 0
        },
        nota: `Resumen real exclusivo del restaurante ${venueId}`
      }

      logger.info('Real general summary retrieved successfully', {
        venueId,
        ventasHoy: summaryData.ventasHoy,
        turnosActivos,
        alertasPendientes: summaryData.alertasPendientes
      })

      return summaryData

    } catch (error) {
      logger.error('Error retrieving real general summary', { error, venueId })
      throw new AppError(`Error al obtener resumen general: ${(error as Error).message}`, 500)
    }
  }
}

export default new AssistantDashboardService()
