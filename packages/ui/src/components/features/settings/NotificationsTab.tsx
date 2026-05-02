/**
 * NotificationsTab — opt-in for browser desktop notifications.
 *
 * Wraps the Notification permissions API. Stores the user's intent in
 * localStorage so the orchestrator and dashboard can know whether to dispatch
 * a system notification on long-running events.
 */

import { useEffect, useState } from 'react'
import { Button } from '../../ui/Button.js'
import { Badge } from '../../ui/Badge.js'
import { useToast } from '../../../services/use-toast.js'

const PREF_KEY = 'orbital.notifications.enabled'

type Permission = 'default' | 'granted' | 'denied' | 'unsupported'

interface NotificationLike {
  permission: 'default' | 'granted' | 'denied'
  requestPermission: () => Promise<'default' | 'granted' | 'denied'>
}

function getNotificationApi(): NotificationLike | null {
  if (typeof window === 'undefined') return null
  const ctor = (window as unknown as { Notification?: NotificationLike & { new (title: string, opts?: Record<string, unknown>): unknown } }).Notification
  return ctor ?? null
}

function readPermission(): Permission {
  const ctor = getNotificationApi()
  if (!ctor) return 'unsupported'
  return ctor.permission as Permission
}

export function NotificationsTab() {
  const [permission, setPermission] = useState<Permission>('default')
  const [enabled, setEnabled] = useState<boolean>(false)
  const toast = useToast()

  useEffect(() => {
    setPermission(readPermission())
    if (typeof localStorage !== 'undefined') {
      setEnabled(localStorage.getItem(PREF_KEY) === 'true')
    }
  }, [])

  const requestPermission = async () => {
    const api = getNotificationApi()
    if (!api) return
    try {
      const result = await api.requestPermission()
      setPermission(result as Permission)
      if (result === 'granted') {
        setEnabled(true)
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(PREF_KEY, 'true')
        }
        toast.success('Notifications enabled', {
          description: 'You will receive desktop notifications for sprint events.',
        })
        try {
          const Ctor = api as unknown as new (
            title: string,
            opts?: Record<string, unknown>,
          ) => unknown
          new Ctor('Orbital notifications enabled', {
            body: 'We will surface sprint-level events here.',
          })
        } catch {
          // Some browsers throw when constructing during a permission grant; ignore.
        }
      } else if (result === 'denied') {
        toast.warn('Notifications blocked', {
          description: 'Re-enable from your browser site settings.',
        })
      }
    } catch (err) {
      toast.error('Could not request permission', {
        description: (err as Error).message,
      })
    }
  }

  const toggleEnabled = () => {
    const next = !enabled
    setEnabled(next)
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PREF_KEY, next ? 'true' : 'false')
    }
  }

  if (permission === 'unsupported') {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        Browser notifications are not supported in this environment.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-slate-900">Desktop notifications</p>
            <p className="mt-1 text-xs text-slate-500">
              Receive a system notification when a sprint completes, an escalation opens, or a
              UAT decision is required.
            </p>
            <div className="mt-2">
              <Badge
                color={
                  permission === 'granted'
                    ? 'emerald'
                    : permission === 'denied'
                      ? 'rose'
                      : 'slate'
                }
              >
                Permission · {permission}
              </Badge>
            </div>
          </div>
          {permission === 'granted' ? (
            <Button variant="secondary" onClick={toggleEnabled}>
              {enabled ? 'Disable' : 'Enable'}
            </Button>
          ) : (
            <Button onClick={requestPermission} disabled={permission === 'denied'}>
              {permission === 'denied' ? 'Blocked' : 'Request permission'}
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <p className="text-sm font-semibold text-slate-900">In-app toasts</p>
        <p className="mt-1 text-xs text-slate-500">
          Stack at the top right of the app for transient feedback. Always on; auto-dismiss
          after 5 seconds.
        </p>
        <Button
          className="mt-2"
          variant="secondary"
          size="sm"
          onClick={() =>
            toast.info('Test toast', {
              description: 'This is a sample notification. Click ✕ to dismiss.',
            })
          }
        >
          Send test toast
        </Button>
      </div>
    </div>
  )
}
