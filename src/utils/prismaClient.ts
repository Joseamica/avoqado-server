import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

//Si quiero imprimir las actividades que hace prisma:
// const prisma = new PrismaClient({
//     log: [
//       {
//         emit: 'stdout',
//         level: 'query',
//       },
//       {
//         emit: 'stdout',
//         level: 'info',
//       },
//       {
//         emit: 'stdout',
//         level: 'warn',
//       },
//       {
//         emit: 'stdout',
//         level: 'error',
//       },
//     ],
//   });

export default prisma
