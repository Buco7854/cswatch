export const passkeyNameMaxLength = 64;
export const passkeyNamePattern = /^[^\p{Cc}\p{Cf}]+$/u;

export function passkeyNameIssue(value) {
  const name = value.trim();
  if (!name) return 'required';
  if (name.length > passkeyNameMaxLength) return 'length';
  if (!passkeyNamePattern.test(name)) return 'characters';
}
