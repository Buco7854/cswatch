import { z } from 'zod';

export const accountName = z.string().regex(/^[A-Za-z0-9_-]{3,32}$/);
export const accountPassword = z.string().min(12).max(128);
export const newCredentials = z
  .object({ username: accountName, password: accountPassword })
  .strict();
