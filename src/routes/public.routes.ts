import { Router } from 'express';
import { getPublicReceipt } from '../controllers/public/receipt.public.controller';

const router = Router();

// Digital Receipt routes
router.get('/receipts/:accessKey', getPublicReceipt);

export default router;
