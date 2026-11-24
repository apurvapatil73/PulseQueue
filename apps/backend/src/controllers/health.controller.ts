import { Request, Response, NextFunction } from 'express';
import { healthService } from '../services/health.service.js';

export async function getHealth(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { statusCode, report } = await healthService.getHealth();
    res.status(statusCode).json(report);
  } catch (err) {
    next(err);
  }
}

export function getLiveness(_req: Request, res: Response, next: NextFunction): void {
  try {
    const { statusCode, report } = healthService.getLiveness();
    res.status(statusCode).json(report);
  } catch (err) {
    next(err);
  }
}

export async function getReadiness(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { statusCode, report } = await healthService.getReadiness();
    res.status(statusCode).json(report);
  } catch (err) {
    next(err);
  }
}
