export function stableProfileIndex(identity: string, optionCount: number) {
  if (optionCount <= 1) return 0;
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % optionCount;
}
