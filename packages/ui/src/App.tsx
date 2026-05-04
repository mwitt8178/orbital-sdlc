import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, useEffect, type ReactNode } from 'react'
import { trpc, trpcHub, createTrpcClient, createTrpcHubClient } from './services/trpc.js'
// Round 7-04 — Hub WS connection lifecycle (mounts when ORBITAL_HUB_WS_URL is set)
import { initHubWs, stopHubWs } from './store/hubWs.js'
import { AppShell } from './components/layout/AppShell.js'
import Dashboard from './pages/Dashboard.js'
import Vision from './pages/Vision.js'
import Channels from './pages/Channels.js'
import Ceremonies from './pages/Ceremonies.js'
import UAT from './pages/UAT.js'
import Retro from './pages/Retro.js'
import Audit from './pages/Audit.js'
import Settings from './pages/Settings.js'
import Welcome from './pages/Welcome.js'
import Admin from './pages/Admin.js'
import Backlog from './pages/Backlog.js'
import Memory from './pages/Memory.js'
import AgentInspector from './pages/AgentInspector.js'
// Round 6 #5 — Cost Governance
// [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
import Cost from './pages/Cost.js'
// Round 7-07 — Hub Deployment + Operations
// [Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops]
import HubAdmin from './pages/HubAdmin.js'
// Orbital Review UI — reviewer queue + per-story detail
// [Engineer-Principal · Opus · run-orbital-review-ui]
import Stories from './pages/Stories.js'
import StoryDetail from './pages/StoryDetail.js'
// Phase D — first-class internal-ticket surface
// [Engineer-Principal · Opus · run-phase-d-internal-tickets]
import ProjectBacklog from './pages/ProjectBacklog.js'
import SprintBoard from './pages/SprintBoard.js'
import { ToastProvider } from './components/ui/ToastProvider.js'
import { CommandPalette } from './components/ui/CommandPalette.js'
// Round 7-06 — Offline Cache + Reconciliation
// [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
import { PendingMutationsPanel } from './components/features/hub/PendingMutationsPanel.js'

export default function App() {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: 30_000,
      },
    },
  }))

  const [trpcClient] = useState(() => createTrpcClient())
  // Round 7-02 — trpcHub Provider for hub-bound procedures (currently unused
  // by any UI component, but mounted so future direct-to-hub queries work
  // out of the box).
  const [trpcHubClient] = useState(() => createTrpcHubClient())

  // Round 7-04 — initialize hub WS connection when ORBITAL_HUB_WS_URL is set
  // at build/runtime via Vite env. No-op when unset (single-machine local mode).
  useEffect(() => {
    const hubWsUrl = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env
      ?.VITE_ORBITAL_HUB_WS_URL
    if (hubWsUrl) {
      initHubWs(hubWsUrl)
      return () => stopHubWs()
    }
    return undefined
  }, [])

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
     <trpcHub.Provider client={trpcHubClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/welcome" element={<Welcome />} />
            <Route path="/admin/*" element={<Admin />} />
            {/* Round 7-07 — Hub Admin (owner-only, hub mode) */}
            {/* [Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops] */}
            <Route path="/hub-admin/*" element={<HubAdmin />} />
            {/* Phase D — first-class internal-ticket surface, OUTSIDE SetupGate
                so it stays reachable post-onboarding without bouncing to /welcome.
                [Engineer-Principal · Opus · run-phase-d-internal-tickets] */}
            <Route
              path="/projects/:projectId/backlog"
              element={
                <AppShell>
                  <ProjectBacklog />
                </AppShell>
              }
            />
            <Route
              path="/projects/:projectId/sprints/:sprintId/board"
              element={
                <AppShell>
                  <SprintBoard />
                </AppShell>
              }
            />
            <Route
              path="/*"
              element={
                <SetupGate>
                  <AppShell>
                    <Routes>
                      <Route path="/" element={<Dashboard />} />
                      <Route path="/backlog" element={<Backlog />} />
                      <Route path="/vision" element={<Vision />} />
                      <Route path="/channels" element={<Channels />} />
                      <Route path="/ceremonies" element={<Ceremonies />} />
                      <Route path="/uat" element={<UAT />} />
                      <Route path="/retro" element={<Retro />} />
                      <Route path="/audit" element={<Audit />} />
                      <Route path="/memory" element={<Memory />} />
                      <Route path="/agents" element={<AgentInspector />} />
                      {/* Round 6 #5 — Cost Governance */}
                      {/* [Engineer-Sr · Sonnet · run-round6-05-cost-governance] */}
                      <Route path="/cost" element={<Cost />} />
                      {/* Orbital Review UI */}
                      {/* [Engineer-Principal · Opus · run-orbital-review-ui] */}
                      <Route path="/stories" element={<Stories />} />
                      <Route path="/stories/:storyId" element={<StoryDetail />} />
                      <Route path="/settings" element={<Settings />} />
                    </Routes>
                  </AppShell>
                </SetupGate>
              }
            />
          </Routes>
          <CommandPalette />
          <ToastProvider />
          {/* Round 7-06 — pending mutations panel (shown when OfflineBanner button clicked) */}
          <PendingMutationsPanel />
        </BrowserRouter>
      </QueryClientProvider>
     </trpcHub.Provider>
    </trpc.Provider>
  )
}

/**
 * SetupGate — if onboarding has not been completed, redirect to /welcome.
 * While the status query is loading, render nothing to avoid a flash of
 * the dashboard.
 *
 * navigate() is called inside a useEffect (not during render) to avoid the
 * "Cannot update a component while rendering a different component" warning
 * that <Navigate /> triggers by calling navigate() synchronously in render.
 */
function SetupGate({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const status = trpc.onboarding.status.useQuery(undefined, {
    staleTime: 60_000,
  })

  // BUG FIX: previous code did `?? undefined` which coerced the null API value
  // to undefined, then compared `=== null` which was always false → redirect
  // never fired and user was stuck on the FullScreenLoader. Read the raw value.
  const setupCompletedAt = status.data?.setupCompletedAt

  useEffect(() => {
    if (
      !status.isLoading &&
      !status.isError &&
      status.data &&
      status.data.setupCompletedAt === null &&
      location.pathname !== '/welcome'
    ) {
      navigate('/welcome', { replace: true, state: { from: location } })
    }
  }, [status.isLoading, status.isError, status.data, setupCompletedAt, location.pathname, navigate, location])

  if (status.isLoading) {
    return <FullScreenLoader />
  }

  // If the status query failed, fall through and let the app render — this
  // keeps the UI usable in misconfigured environments.
  if (status.isError) {
    return <>{children}</>
  }

  // While the effect hasn't fired yet (setup not complete), keep showing the
  // loader so there is no flash of the dashboard before the redirect lands.
  if (status.data && status.data.setupCompletedAt === null) {
    return <FullScreenLoader />
  }

  return <>{children}</>
}

function FullScreenLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="flex items-center gap-3 text-sm text-slate-500" role="status">
        <span
          className="h-2 w-2 animate-pulse-dot rounded-full bg-brand-500"
          aria-hidden="true"
        />
        Loading…
      </div>
    </div>
  )
}

