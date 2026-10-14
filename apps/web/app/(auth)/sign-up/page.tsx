import Link from 'next/link';

import { AuthForm } from '../../../components/auth-form';
import { safeNextPath } from '../../../lib/next-path';
import { signUpAction } from '../actions';

export const metadata = { title: 'Create an account' };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);
  return (
    <main id="main" className="auth-page">
      <div className="auth-card">
        <p className="brand">collab-docs</p>
        <h1 className="auth-title">Create an account</h1>
        <AuthForm mode="sign-up" next={next} action={signUpAction} />
        <p className="auth-switch">
          Already have one? <Link href={`/sign-in?next=${encodeURIComponent(next)}`}>Sign in</Link>
        </p>
      </div>
    </main>
  );
}
