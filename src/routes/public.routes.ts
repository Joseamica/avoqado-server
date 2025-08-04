import { Router } from 'express';
import { getPublicReceipt } from '../controllers/public/receipt.public.controller';
import { 
  submitReviewFromReceipt, 
  checkReviewStatus, 
  getReviewForReceipt 
} from '../controllers/public/receiptReview.public.controller';

const router = Router();

// Digital Receipt routes
router.get('/receipt/:accessKey', getPublicReceipt);

// Receipt Review routes
router.post('/receipt/:accessKey/review', submitReviewFromReceipt);
router.get('/receipt/:accessKey/review/status', checkReviewStatus);
router.get('/receipt/:accessKey/review', getReviewForReceipt);

export default router;
