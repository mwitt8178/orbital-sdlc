/**
 * ForgotPassword — initiates the Cognito ForgotPassword flow. Cognito emails
 * a 6-digit code; we redirect to /reset-password with the email as a query
 * param to complete the reset.
 */

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { describeCognitoError, forgotPassword } from '../auth/cognito.js'
import { emailSchema } from '../auth/passwordRules.js'
import { AuthLayout, Field } from './Login.js'

const schema = z.object({ email: emailSchema })
type FormValues = z.infer<typeof schema>

export default function ForgotPassword() {
  const navigate = useNavigate()
  const [serverError, setServerError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  })

  const onSubmit = async (values: FormValues) => {
    setServerError(null)
    try {
      await forgotPassword(values.email)
      navigate(`/reset-password?email=${encodeURIComponent(values.email)}`)
    } catch (err) {
      setServerError(describeCognitoError(err))
    }
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="We'll email you a 6-digit code to set a new password."
    >
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          {...register('email')}
          error={errors.email?.message}
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
        >
          {isSubmitting ? 'Sending…' : 'Send reset code'}
        </button>

        <p className="pt-2 text-center text-sm text-slate-600">
          Remembered it?{' '}
          <Link to="/login" className="text-brand-600 hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  )
}
