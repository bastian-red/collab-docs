'use server';

import { sessionUserSchema, signUpSchema } from '@docs/shared';
import { AuthError } from 'next-auth';

import { signIn } from '../../auth';
import { ApiError, apiFetch } from '../../lib/api';
import { safeNextPath } from '../../lib/next-path';

export interface AuthFormState {
  readonly error: string | null;
}

/**
 * Sign in, then go back where the reader came from.
 *
 * `signIn` redirects by THROWING Next's redirect signal, so the catch must let
 * anything that is not an `AuthError` through; swallowing it would turn every
 * successful sign-in into a form that just sits there.
 *
 * The message does not say which half was wrong. The API spends the same scrypt
 * time on an unknown address as on a wrong password so the answer cannot be read
 * off the clock; a friendlier sentence here would undo that at the last step.
 */
export async function signInAction(
  _previous: AuthFormState,
  form: FormData,
): Promise<AuthFormState> {
  try {
    await signIn('credentials', {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
      redirectTo: safeNextPath(String(form.get('next') ?? '')),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: 'That email address and password do not match.' };
    }
    throw error;
  }
  return { error: null };
}

/**
 * Create the account through the API, then sign in with the same credentials.
 *
 * Parsed with the shared `signUpSchema` first, so a 12-character password floor is
 * reported next to the field instead of as a round trip's 400.
 */
export async function signUpAction(
  _previous: AuthFormState,
  form: FormData,
): Promise<AuthFormState> {
  const parsed = signUpSchema.safeParse({
    email: form.get('email'),
    name: form.get('name'),
    password: form.get('password'),
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return {
      error:
        field === 'password'
          ? 'Use a password of at least 12 characters.'
          : field === 'email'
            ? 'That does not look like an email address.'
            : 'Enter your name.',
    };
  }

  try {
    await apiFetch(null, '/auth/sign-up', sessionUserSchema, { method: 'POST', body: parsed.data });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'CONFLICT') {
      return { error: 'That email address is already registered. Sign in instead.' };
    }
    if (error instanceof ApiError && error.status === 429) {
      return { error: 'Too many attempts. Wait a minute and try again.' };
    }
    console.error('[web] sign-up could not be completed:', error);
    return { error: 'The account could not be created. Try again in a moment.' };
  }

  return signInAction({ error: null }, form);
}
