// Ejemplo: src/routes/index.ts
import express from 'express'
import dashboardRoutes from './dashboard.routes'
// import tpvRoutes from './tpv.routes';
// import publicRoutes from './public.routes';
// ...

const router = express.Router()

router.use('/dashboard', dashboardRoutes) // Todas las rutas del dashboard bajo /api/v1/dashboard
// router.use('/tpv', tpvRoutes);             // Todas las rutas TPV bajo /api/v1/tpv
// router.use('/public', publicRoutes);       // Todas las rutas públicas bajo /api/v1/public
// ...

export default router
