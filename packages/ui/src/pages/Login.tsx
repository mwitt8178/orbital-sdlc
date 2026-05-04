/**
 * Login — email + password against Cognito (SRP).
 *
 * Pool config: us-east-1_R89dMIxXb (orbital-mwitt). Self-signup allowed,
 * so the "Create account" link is always shown.
 */

import { forwardRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useAuth } from '../auth/AuthContext.js'
import { describeCognitoError } from '../auth/cognito.js'
import { emailSchema } from '../auth/passwordRules.js'

const schema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
})

type FormValues = z.infer<typeof schema>

interface LocationState {
  from?: { pathname?: string }
}

export default function Login() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [serverError, setServerError] = useState<string | null>(null)

  const from = (location.state as LocationState | null)?.from?.pathname ?? '/welcome'

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  })

  const onSubmit = async (values: FormValues) => {
    setServerError(null)
    try {
      await signIn(values.email, values.password)
      navigate(from, { replace: true })
    } catch (err) {
      const e = err as { name?: string; message?: string }
      if (e?.name === 'UserNotConfirmedException') {
        navigate(`/verify?email=${encodeURIComponent(values.email)}`)
        return
      }
      if (e?.name === 'PasswordResetRequiredException') {
        navigate(`/reset-password?email=${encodeURIComponent(values.email)}`)
        return
      }
      setServerError(describeCognitoError(err))
    }
  }

  return (
    <AuthLayout title="Sign in to Orbital" subtitle="Enter your credentials to continue.">
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4" data-testid="login-form">
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          {...register('email')}
          error={errors.email?.message}
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          {...register('password')}
          error={errors.password?.message}
        />

        {serverError && (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {serverError}
          </p>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="login-submit"
        >
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </button>

        <div className="flex items-center justify-between pt-2 text-sm">
          <Link to="/forgot-password" className="text-brand-600 hover:underline">
            Forgot password?
          </Link>
          <Link to="/signup" className="text-brand-600 hover:underline">
            Create account
          </Link>
        </div>
      </form>
    </AuthLayout>
  )
}

// ---------------------------------------------------------------------------
// Shared layout + field primitives for all auth pages.
// Co-located until a second use case shows they need their own files.
// ---------------------------------------------------------------------------

export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-600">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2a10 10 0 0 1 8.66 5" />
              <path d="M22 12a10 10 0 0 1-5 8.66" />
              <path d="M12 22a10 10 0 0 1-8.66-5" />
              <path d="M2 12a10 10 0 0 1 5-8.66" />
            </svg>
          </div>
          <span className="text-lg font-semibold text-slate-900">Orbital</span>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-card">
          <h1 className="mb-1 text-xl font-semibold text-slate-900">{title}</h1>
          {subtitle && <p className="mb-5 text-sm text-slate-500">{subtitle}</p>}
          {children}
        </div>
      </div>
    </div>
  )
}

interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  id: string
  label: string
  error?: string
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { id, label, error, ...rest },
  ref,
) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        {...rest}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:cursor-not-allowed disabled:opacity-60"
      />
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  )
})
