/**
 * ResetPassword — completes the Cognito ForgotPassword flow.
 * Email is read from the ?email= query param.
 */

import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { confirmForgotPassword, describeCognitoError } from '../auth/cognito.js'
import { PASSWORD_RULES_HUMAN, passwordSchema } from '../auth/passwordRules.js'
import { AuthLayout, Field } from './Login.js'

const schema = z
  .object({
    code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((d) => d.password === d.confirm, {
    path: ['confirm'],
    message: 'Passwords do not match',
  })

type FormValues = z.infer<typeof schema>

export default function ResetPassword() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const email = params.get('email') ?? ''
  const [serverError, setServerError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { code: '', password: '', confirm: '' },
  })

  const onSubmit = async (values: FormValues) => {
    setServerError(null)
    if (!email) {
      setServerError('Missing email — start over from /forgot-password.')
      return
    }
    try {
      await confirmForgotPassword(email, values.code, values.password)
      navigate('/login', { state: { justReset: true } })
    } catch (err) {
      setServerError(describeCognitoError(err))
    }
  }

  return (
    <AuthLayout
      title="Set a new password"
      subtitle={email ? `For ${email}.` : 'Enter the code we emailed you.'}
    >
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        <Field
          id="code"
          label="Verification code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          {...register('code')}
          error={errors.code?.message}
        />
        <Field
          id="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          {...register('password')}
          error={errors.password?.message}
        />
        <Field
          id="confirm"
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          {...register('confirm')}
          error={errors.confirm?.message}
        />

        <ul className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          <li className="mb-1 font-medium text-slate-700">Password requirements</li>
          {PASSWORD_RULES_HUMAN.map((rule) => (
            <li key={rule}>• {rule}</li>
          ))}
        </ul>

        {serverError && (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {serverError}
          </p>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? 'Updating…' : 'Set new password'}
        </button>

        <p className="pt-2 text-center text-sm text-slate-600">
          <Link to="/login" className="text-brand-600 hover:underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  )
}
