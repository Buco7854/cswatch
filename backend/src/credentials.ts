import { z } from 'zod';

export const accountName = z.string().regex(/^[A-Za-z0-9_-]{3,32}$/);
export const accountPassword = z.string().min(12).max(128);
export const accountEmail = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .refine((value) => value.indexOf('@') <= 64)
  .transform((value) => value.toLowerCase());
export const accountDisplayName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u)
  .refine((value) =>
    /[\p{L}\p{N}\p{P}\p{S}]/u.test(value.replace(/\p{Default_Ignorable_Code_Point}/gu, '')),
  )
  .transform((value) => value.normalize('NFC'));
export const newCredentials = z
  .object({ username: accountName, password: accountPassword })
  .strict();
