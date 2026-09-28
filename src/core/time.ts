export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export function toIso(date: Date): string {
  return date.toISOString();
}

export function parseIso(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw Object.assign(new Error('Invalid ISO timestamp'), { code: 'INVALID_TIME' });
  }
  return date;
}

export function ms(value: string): number {
  return parseIso(value).getTime();
}

export function addMinutes(value: string, minutes: number): string {
  return new Date(ms(value) + minutes * 60_000).toISOString();
}
