'use client';

import { useActionState } from 'react';

import type { AuthFormState } from '../app/(auth)/actions';

interface AuthFormProps {
  readonly mode: 'sign-in' | 'sign-up';
  readonly next: string;
  readonly action: (previous: AuthFormState, form: FormData) => Promise<AuthFormState>;
}

/**
 * The credentials form for both sign-in and sign-up.
 *
 * A server action through `useActionState`, so the form works before JavaScript
 * loads (a plain POST) and the error renders in place afterwards. The error is a
 * `role="alert"` so a screen reader is told the attempt failed; without it the
 * only signal is text appearing somewhere the reader is not.
 */
export function AuthForm({ mode, next, action }: AuthFormProps) {
  const [state, formAction, pending] = useActionState(action, { error: null });

  return (
    <form className="auth-form" action={formAction}>
      <input type="hidden" name="next" value={next} />
      {mode === 'sign-up' ? (
        <label className="field">
          <span className="field-label">Name</span>
          <input className="field-input" name="name" type="text" required autoComplete="name" />
        </label>
      ) : null}
      <label className="field">
        <span className="field-label">Email</span>
        <input className="field-input" name="email" type="email" required autoComplete="username" />
      </label>
      <label className="field">
        <span className="field-label">Password</span>
        <input
          className="field-input"
          name="password"
          type="password"
          required
          minLength={mode === 'sign-up' ? 12 : 1}
          autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
        />
      </label>
      {state.error === null ? null : (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button className="button button-primary" type="submit" disabled={pending}>
        {mode === 'sign-up'
          ? pending
            ? 'Creating account'
            : 'Create account'
          : pending
            ? 'Signing in'
            : 'Sign in'}
      </button>
    </form>
  );
}
