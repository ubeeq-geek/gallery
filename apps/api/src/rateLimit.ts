const attempts = new Map<string, number[]>();

export const checkRateLimit = (key: string, windowMs: number, maxAttempts: number): boolean => {
  const now = Date.now();
  const existing = attempts.get(key) || [];
  const valid = existing.filter((time) => now - time < windowMs);
  if (valid.length >= maxAttempts) {
    attempts.set(key, valid);
    return false;
  }
  valid.push(now);
  attempts.set(key, valid);
  return true;
};
