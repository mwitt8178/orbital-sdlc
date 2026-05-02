import { ReactNode, useEffect } from 'react'
import { TopBar } from './TopBar.js'
import { SideNav } from './SideNav.js'
import { initWebSocket } from '../../services/ws.js'

interface AppShellProps {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  useEffect(() => {
    const cleanup = initWebSocket()
    return cleanup
  }, [])

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <TopBar />
      <div className="flex flex-1 overflow-hidden" style={{ height: 'calc(100vh - 56px)' }}>
        <SideNav />
        <main className="scrollbar-thin flex-1 overflow-y-auto" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  )
}
