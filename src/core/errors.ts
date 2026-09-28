export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function requiredString(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new AppError('VALIDATION_ERROR', `${field} must be a non-empty string`, 400, { field });
  }
  return value;
}

export function requiredNumber(value: unknown, field: string, min = -1_000_000, max = 1_000_000): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new AppError('VALIDATION_ERROR', `${field} must be a finite number in allowed range`, 400, { field, min, max });
  }
  return value;
}

export function optionalIso(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    throw new AppError('VALIDATION_ERROR', `${field} must be ISO timestamp or null`, 400, { field });
  }
  return value;
}
