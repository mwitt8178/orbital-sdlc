/**
 * Verify — confirms a Cognito sign-up with the 6-digit code emailed to the
 * user. Email is read from the ?email= query param. On success we send the
 * user back to /login (sign-in is a separate explicit step — we do NOT
 * persist the password from /signup).
 */

import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { confirmSignUp, describeCognitoError, resendConfirmationCode } from '../auth/cognito.js'
import { AuthLayout, Field } from './Login.js'

const schema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
})

type FormValues = z.infer<typeof schema>

export default function Verify() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const email = params.get('email') ?? ''
  const [serverError, setServerError] = useState<string | null>(null)
  const [resendStatus, setResendStatus] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { code: '' },
  })

  const onSubmit = async (values: FormValues) => {
    setServerError(null)
    if (!email) {
      setServerError('Missing email — start over from /signup.')
      return
    }
    try {
      await confirmSignUp(email, values.code)
      navigate(`/login`, { state: { justVerified: true } })
    } catch (err) {
      setServerError(describeCognitoError(err))
    }
  }

  const onResend = async () => {
    setResendStatus(null)
    setServerError(null)
    try {
      await resendConfirmationCode(email)
      setResendStatus('A new code has been sent.')
    } catch (err) {
      setServerError(describeCognitoError(err))
    }
  }

  return (
    <AuthLayout
      title="Verify your email"
      subtitle={email ? `We sent a 6-digit code to ${email}.` : 'Enter the code we sent you.'}
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

        {serverError && (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {serverError}
          </p>
        )}
        {resendStatus && (
          <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {resendStatus}
          </p>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? 'Verifying…' : 'Verify email'}
        </button>

        <div className="flex items-center justify-between pt-2 text-sm">
          <button type="button" onClick={onResend} className="text-brand-600 hover:underline">
            Resend code
          </button>
          <Link to="/login" className="text-brand-600 hover:underline">
            Back to sign in
          </Link>
        </div>
      </form>
    </AuthLayout>
  )
}
