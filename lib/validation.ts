export function isValidWholeUsdcAmount(value: string | number): boolean {
  if (value === "" || value === null || value === undefined) return false;
  return /^\d+$/.test(String(value).trim()) && Number(value) > 0;
}

export function isValidUrl(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

type Check<T> = [keyof T, (value: unknown, all: T) => boolean, string];

export function validate<T extends object>(values: T, checks: Check<T>[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [key, predicate, message] of checks) {
    if (!predicate(values[key], values)) {
      errors[key as string] = message;
    }
  }
  return errors;
}
