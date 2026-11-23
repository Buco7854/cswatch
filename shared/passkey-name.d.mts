export const passkeyNameMaxLength: number;
export const passkeyNamePattern: RegExp;
export function passkeyNameIssue(value: string): 'required' | 'length' | 'characters' | undefined;
