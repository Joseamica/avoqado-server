// src/routes/index.ts
import express from 'express'
import dashboardRoutes from './dashboard.routes'
// import tpvRoutes from './tpv.routes';
import publicRoutes from './public.routes';

const router = express.Router()

router.use('/dashboard', dashboardRoutes) // All dashboard routes under /api/v1/dashboard
// router.use('/tpv', tpvRoutes);          // All TPV routes under /api/v1/tpv
router.use('/public', publicRoutes);       // All public routes under /api/v1/public

export default router
