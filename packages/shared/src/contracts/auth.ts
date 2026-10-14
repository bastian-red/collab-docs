import { z } from 'zod';

import { emailSchema, idSchema, nameSchema, passwordSchema } from './primitives';

export const signUpSchema = z.object({
  email: emailSchema,
  name: nameSchema,
  password: passwordSchema,
});

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

/**
 * The user shape the web app puts in its session and mints tokens from.
 *
 * Auth.js callbacks PARSE with this rather than casting. A drifted API response
 * then produces no session at all, which is a visible failure, instead of a
 * session whose `id` is `undefined` -- and in Prisma `undefined` is not "no
 * rows", it is "no filter", so that session would silently read somebody else's
 * document.
 */
export const sessionUserSchema = z.object({
  id: idSchema,
  email: emailSchema,
  name: nameSchema,
});

export type SignUpInput = z.infer<typeof signUpSchema>;
export type SignInInput = z.infer<typeof signInSchema>;
export type SessionUser = z.infer<typeof sessionUserSchema>;
