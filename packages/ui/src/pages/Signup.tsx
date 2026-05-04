/**
 * Signup — Cognito self-service registration. Pool sends a 6-digit confirmation
 * code by email; on success we redirect to /verify with the email as a query
 * param.
 */

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { describeCognitoError, signUp } from '../auth/cognito.js'
import { emailSchema, PASSWORD_RULES_HUMAN, passwordSchema } from '../auth/passwordRules.js'
import { AuthLayout, Field } from './Login.js'

const schema = z
  .object({
    name: z.string().min(1, 'Enter your name'),
    email: emailSchema,
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((d) => d.password === d.confirm, {
    path: ['confirm'],
    message: 'Passwords do not match',
  })

type FormValues = z.infer<typeof schema>

export default function Signup() {
  const navigate = useNavigate()
  const [serverError, setServerError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', email: '', password: '', confirm: '' },
  })

  const onSubmit = async (values: FormValues) => {
    setServerError(null)
    try {
      await signUp(values.email, values.password, { name: values.name })
      navigate(`/verify?email=${encodeURIComponent(values.email)}`)
    } catch (err) {
      setServerError(describeCognitoError(err))
    }
  }

  return (
    <AuthLayout title="Create your Orbital account">
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        <Field
          id="name"
          label="Name"
          autoComplete="name"
          {...register('name')}
          error={errors.name?.message}
        />
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
          autoComplete="new-password"
          {...register('password')}
          error={errors.password?.message}
        />
        <Field
          id="confirm"
          label="Confirm password"
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
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </button>

        <p className="pt-2 text-center text-sm text-slate-600">
          Already have an account?{' '}
          <Link to="/login" className="text-brand-600 hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  )
}
