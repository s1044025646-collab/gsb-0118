export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ApiError('INVALID_PARAMETER', 400, `${field} is required`);
  return value;
}

export function requireNumber(value: unknown, field: string, { min = -Infinity, max = Infinity } = {}): number {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(numberValue) || numberValue < min || numberValue > max) {
    throw new ApiError('INVALID_PARAMETER', 400, `${field} must be a finite number in [${min}, ${max}]`);
  }
  return numberValue;
}

export function requireIsoDateTime(value: unknown, field: string): string {
  const text = requireString(value, field);
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw new ApiError('INVALID_PARAMETER', 400, `${field} must be ISO date-time`);
  return new Date(time).toISOString();
}

export function parsePagination(searchParams: URLSearchParams): { limit: number; offset: number } {
  const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit') ?? '50')));
  const page = Math.max(1, Number(searchParams.get('page') ?? '1'));
  if (!Number.isFinite(limit) || !Number.isFinite(page)) throw new ApiError('INVALID_PAGINATION', 400, 'limit and page must be numbers');
  return { limit, offset: (page - 1) * limit };
}
