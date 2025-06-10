// controllers/public/receipt.public.controller.ts
import { NextFunction, Request, Response } from 'express';
import { getReceiptByAccessKey } from '../../services/dashboard/receipt.dashboard.service';
import AppError from '../../errors/AppError';

// Public route to get a receipt by its access key
// GET /api/public/receipts/:accessKey
export async function getPublicReceipt(
  req: Request<{ accessKey: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { accessKey } = req.params;
    
    // Get the receipt using the service
    const receipt = await getReceiptByAccessKey(accessKey);
    
    // Return only the data snapshot to avoid exposing internal IDs
    res.status(200).json({
      success: true,
      data: receipt.dataSnapshot
    });
  } catch (error) {
    next(error);
  }
}
