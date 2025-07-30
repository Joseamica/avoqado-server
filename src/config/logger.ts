import winston from 'winston'
import path from 'path'

const { combine, timestamp, printf, colorize, json, splat } = winston.format

const LOG_DIR = process.env.LOG_DIR || 'logs'
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'

// Asegurarse de que el directorio de logs exista (Winston lo crea si no existe para los transportes de archivo)

const baseFormat = combine(
  timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  splat(), // Permite usar logger.info('mensaje %s', variable)
)

const consoleFormat = printf(info => {
  let msg = `${info.timestamp} ${info.level}: ${info.message}`
  if (info.correlationId) {
    msg += ` [correlationId: ${info.correlationId}]`
  }
  // Incluir el stack trace para errores
  if (info.stack) {
    msg += `\n${info.stack}`
  }
  // Incluir metadata adicional si existe y no es un error (ya que el stack se maneja arriba)
  const metadata = Object.keys(info).reduce(
    (acc, key) => {
      if (
        ![
          'level',
          'message',
          'timestamp',
          'correlationId',
          'stack',
          Symbol.for('level'),
          Symbol.for('message'),
          Symbol.for('splat'),
        ].includes(key) &&
        info[key] !== undefined
      ) {
        acc[key] = info[key]
      }
      return acc
    },
    {} as Record<string, any>,
  )

  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata)}`
  }
  return msg
})

const transports: winston.transport[] = []

if (process.env.NODE_ENV !== 'production') {
  transports.push(
    new winston.transports.Console({
      level: LOG_LEVEL === 'debug' ? 'debug' : 'info', // Permite 'debug' en desarrollo si LOG_LEVEL lo indica
      format: combine(colorize(), baseFormat, consoleFormat),
    }),
    // Log de desarrollo a archivo
    new winston.transports.File({
      level: LOG_LEVEL, // O 'debug' si quieres todo en el archivo de desarrollo
      filename: path.join(LOG_DIR, 'development.log'),
      format: combine(baseFormat, consoleFormat), // Formato legible para desarrollo
      maxsize: 5242880, // 5MB
      maxFiles: 3,
    }),
  )
} else {
  // En producción, loguear a la consola en formato JSON para sistemas de recolección de logs
  transports.push(
    new winston.transports.Console({
      level: LOG_LEVEL,
      format: combine(baseFormat, json()), // JSON para producción en consola
    }),
  )
  // Logs de errores en un archivo separado
  transports.push(
    new winston.transports.File({
      level: 'error',
      filename: path.join(LOG_DIR, 'error.log'),
      format: combine(baseFormat, json()),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  )
  // Todos los logs (desde el nivel configurado) en un archivo combinado
  transports.push(
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      format: combine(baseFormat, json()),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  )
  // Nota: Para una gestión de rotación de archivos más avanzada en producción,
  // considera usar 'winston-daily-rotate-file'. La configuración actual
  // usa la rotación básica de Winston por tamaño y cantidad de archivos.
}

const logger = winston.createLogger({
  level: LOG_LEVEL,
  transports,
  exitOnError: false, // No salir en excepciones manejadas por Winston
})

// Manejar excepciones no capturadas
process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught Exception:', { message: error.message, stack: error.stack })
  // Es crítico salir del proceso después de una excepción no capturada
  // pero asegúrate de que el log se haya escrito.
  logger.on('finish', () => process.exit(1))
  logger.end()
})

// Manejar promesas rechazadas no manejadas
process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  logger.error('Unhandled Rejection at:', { promiseDetails: promise, reason })
})

logger.info(`Logger initialized. Log level: ${LOG_LEVEL}. NODE_ENV: ${process.env.NODE_ENV}. Log directory: ${path.resolve(LOG_DIR)}`)

export default logger
