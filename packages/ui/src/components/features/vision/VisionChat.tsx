/**
 * VisionChat — PM intake chat panel.
 *
 * Shows messages from the vision store, an input box that fires
 * vision.sendMessage, and a "Start session" button when no session is live.
 *
 * Changes (Round 4 — PM stub UX):
 *   - Optimistic user message render: user message appears immediately in the
 *     list on submit, before the mutation resolves. On error the optimistic
 *     message is removed and an error shown.
 *   - PMThinkingIndicator: shown after the user sends a message, hidden when
 *     a PM message arrives via WS or next refetch.
 *   - Demo-mode notice: when onboarding status shows no Anthropic token or
 *     mode='demo', a small banner informs the user that PM responses are
 *     stubbed.
 */

import { useState, useRef } from 'react'
import { trpc } from '../../../services/trpc.js'
import { useVisionStore, type VisionMessage } from '../../../store/vision.js'
import { buildAuditMetadata } from '../../../services/audit-metadata.js'
import { Button } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { PMThinkingIndicator } from './PMThinkingIndicator.js'

export function VisionChat() {
  const sessionId = useVisionStore((s) => s.currentSessionId)
  const messages = useVisionStore((s) => s.messages)
  const draft = useVisionStore((s) => s.composerDraft)
  const setComposerDraft = useVisionStore((s) => s.setComposerDraft)
  const setSession = useVisionStore((s) => s.setSession)
  const appendMessage = useVisionStore((s) => s.appendMessage)
  const [error, setError] = useState<string | null>(null)
  const [startTitle, setStartTitle] = useState('')
  const [initialPrompt, setInitialPrompt] = useState('')
  // Tracks the locally-optimistic user message id — used to avoid duplicating
  // it when the mutation onSuccess also appends the confirmed message.
  const optimisticIdRef = useRef<string | null>(null)
  // Tracks whether we're waiting for a PM reply (shows the thinking indicator).
  const [awaitingPMReply, setAwaitingPMReply] = useState(false)

  const onboardingStatus = trpc.onboarding.status.useQuery(undefined, {
    // Stale time 60s — this rarely changes during a session
    staleTime: 60_000,
  })

  const isDemoMode =
    onboardingStatus.data?.mode === 'demo' || !onboardingStatus.data?.hasAnthropicToken

  // Poll listMessages every 3 seconds while a session is active. This ensures
  // PM stub replies appear even if the WS subscription misses the event (e.g.
  // connection not yet established on first load). The poll is the safety net;
  // the WS dispatchVisionEvent handler is the fast path.
  const messagesQuery = trpc.vision.listMessages.useQuery(
    sessionId ? { vision_session_id: sessionId } : (undefined as never),
    {
      enabled: !!sessionId,
      refetchInterval: 3_000,
      staleTime: 1_000,
    },
  )

  // Sync polled messages into the Zustand store, de-duplicating against what
  // WS may have already delivered. We only sync once per poll result.
  const lastPollResultRef = useRef<string | null>(null)
  if (messagesQuery.data) {
    const dataKey = JSON.stringify(messagesQuery.data.items.map((m) => m.vision_message_id))
    if (dataKey !== lastPollResultRef.current) {
      lastPollResultRef.current = dataKey
      const store = useVisionStore.getState()
      const existingIds = new Set(store.messages.map((m) => m.visionMessageId))
      for (const item of messagesQuery.data.items) {
        if (!existingIds.has(item.vision_message_id)) {
          appendMessage({
            visionMessageId: item.vision_message_id,
            authorRole: item.author_type === 'user' ? 'user' : 'pm_persona',
            body: item.body,
            postedAt: item.posted_at,
          })
        }
      }
    }
  }

  const startMutation = trpc.vision.start.useMutation({
    onSuccess: (data) => {
      setSession(data.vision_session_id, data.vision_document_id)
      // The server auto-persisted `initial_prompt` as the first user message
      // and the PM stub will reply within ~1.2s. Render the user message
      // immediately + show the thinking indicator so the chat feels active
      // from the moment the session opens (no "Type your first message" gap).
      const firstPrompt = initialPrompt.trim()
      if (firstPrompt) {
        appendMessage({
          visionMessageId: `optimistic-start-${Date.now()}`,
          authorRole: 'user',
          body: firstPrompt,
          postedAt: new Date().toISOString(),
        })
        setAwaitingPMReply(true)
      }
      setStartTitle('')
      setInitialPrompt('')
      setError(null)
    },
    onError: (err) => setError(err.message),
  })

  const sendMutation = trpc.vision.sendMessage.useMutation({
    onMutate: () => {
      // Optimistically append the user's message so the UI feels instant.
      const tempId = `optimistic-${Date.now()}`
      optimisticIdRef.current = tempId
      const optimisticMsg: VisionMessage = {
        visionMessageId: tempId,
        authorRole: 'user',
        body: draft.trim(),
        postedAt: new Date().toISOString(),
      }
      appendMessage(optimisticMsg)
      // Show PM thinking indicator
      setAwaitingPMReply(true)
    },

    onSuccess: (data) => {
      // The optimistic message is already in the list. Replace it with the
      // server-confirmed version by removing the temp entry and appending the
      // real one. We use the Zustand store's replaceOptimistic helper if
      // available; if not, appendMessage with the real id is idempotent given
      // the 200-message cap.
      //
      // NOTE: replaceOptimistic is a deferred enhancement. For now we simply
      // let the confirmed version coexist — the store deduplicates by id so
      // we patch the message list manually.
      const store = useVisionStore.getState()
      const currentMessages = store.messages
      const filtered = currentMessages.filter(
        (m) => m.visionMessageId !== optimisticIdRef.current,
      )
      const confirmedMsg: VisionMessage = {
        visionMessageId: data.vision_message_id,
        authorRole: 'user',
        body: filtered.find((m) => m.visionMessageId === data.vision_message_id)?.body ?? draft.trim(),
        postedAt: data.posted_at,
      }
      // Reset messages to filtered list + confirmed message (avoid duplicate)
      const alreadyPresent = filtered.some((m) => m.visionMessageId === data.vision_message_id)
      useVisionStore.setState({
        messages: alreadyPresent ? filtered : [...filtered, confirmedMsg],
      })
      optimisticIdRef.current = null
      setComposerDraft('')
      setError(null)
      // awaitingPMReply stays true — cleared when PM message arrives below
    },

    onError: (err) => {
      // Roll back optimistic message
      if (optimisticIdRef.current) {
        useVisionStore.setState((s) => ({
          messages: s.messages.filter((m) => m.visionMessageId !== optimisticIdRef.current),
        }))
        optimisticIdRef.current = null
      }
      setAwaitingPMReply(false)
      setError(err.message)
    },
  })

  // When a new PM message arrives in the store, hide the thinking indicator
  const lastMsg = messages[messages.length - 1]
  if (awaitingPMReply && lastMsg?.authorRole === 'pm_persona') {
    setAwaitingPMReply(false)
  }

  const handleStart = () => {
    if (!startTitle.trim() || !initialPrompt.trim()) return
    startMutation.mutate({
      title: startTitle.trim(),
      initial_prompt: initialPrompt.trim(),
      audit_metadata: buildAuditMetadata('User started a vision intake session'),
    })
  }

  const handleSend = () => {
    if (!sessionId || !draft.trim()) return
    sendMutation.mutate({
      vision_session_id: sessionId,
      body: draft.trim(),
      audit_metadata: buildAuditMetadata('User sent a message in vision intake session', {
        linked_artifacts: [{ type: 'vision_session', id: sessionId }],
      }),
    })
  }

  return (
    <div
      className="flex flex-col rounded-lg border border-slate-200 bg-white"
      style={{ height: 'calc(100vh - 200px)' }}
    >
      {/* Demo-mode notice */}
      {sessionId && isDemoMode && (
        <div className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-700">
          Demo mode — PM responses are stubbed. Connect an Anthropic key in{' '}
          <a href="/welcome" className="underline hover:text-amber-900">
            /welcome
          </a>{' '}
          for real persona responses.
        </div>
      )}

      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-[10px] font-bold text-white">
            PM
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">Product Manager</div>
            <div className="text-xs text-slate-500">Elicitation interview</div>
          </div>
        </div>
        {sessionId && (
          <div
            className="font-mono text-[10px] text-slate-400"
            title={sessionId}
          >
            session {sessionId.slice(0, 8)}
          </div>
        )}
      </div>

      <div
        className="scrollbar-thin flex-1 overflow-y-auto px-4 py-3"
        role="log"
        aria-label="Vision chat messages"
      >
        {!sessionId ? (
          <div className="space-y-3 py-6">
            <EmptyState
              title="Define your vision"
              description="Tell the PM persona what you're building. They'll ask 3–5 questions, then draft a vision document you can lock."
            />
            <div className="space-y-2 px-6">
              <input
                type="text"
                value={startTitle}
                onChange={(e) => setStartTitle(e.target.value)}
                placeholder="Working title (e.g. Customer billing v2)"
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                aria-label="Vision title"
              />
              <textarea
                value={initialPrompt}
                onChange={(e) => setInitialPrompt(e.target.value)}
                placeholder="In one paragraph: what are you building, and why? (e.g. 'A recipe app where families save and share heirloom recipes; offline-first, ad-free, monetized via a printable cookbook upsell.')"
                rows={4}
                className="w-full resize-none rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                aria-label="What are you building"
              />
              <Button
                onClick={handleStart}
                disabled={
                  !startTitle.trim() || !initialPrompt.trim() || startMutation.isPending
                }
              >
                {startMutation.isPending ? 'Starting…' : 'Start vision'}
              </Button>
              <p className="text-xs text-slate-500">
                You only need one vision per project. Revise the existing one
                if your direction shifts; create a new one only if you&apos;re
                starting a different product.
              </p>
            </div>
          </div>
        ) : messages.length === 0 && !awaitingPMReply ? (
          <EmptyState
            title="Session started"
            description="Type your first message below to begin."
          />
        ) : (
          <ol className="space-y-3">
            {messages.map((msg) => (
              <li
                key={msg.visionMessageId}
                className={`flex gap-2 ${msg.authorRole === 'user' ? 'justify-end' : ''} animate-stream-in`}
              >
                {msg.authorRole === 'pm_persona' && (
                  <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-[9px] font-bold text-white">
                    PM
                  </div>
                )}
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                    msg.authorRole === 'user'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-100 text-slate-900'
                  } ${msg.visionMessageId.startsWith('optimistic-') ? 'opacity-70' : ''}`}
                >
                  {msg.body}
                </div>
              </li>
            ))}
            {awaitingPMReply && <PMThinkingIndicator showModeHint={isDemoMode} />}
          </ol>
        )}
      </div>

      <div className="border-t border-slate-100 p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSend()
          }}
        >
          <div className="flex items-end gap-2">
            <textarea
              className="flex-1 resize-none rounded-md border border-slate-200 px-3 py-2 text-sm placeholder-slate-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-50 disabled:opacity-60"
              rows={2}
              placeholder={sessionId ? 'Type a reply…' : 'Start a session first…'}
              value={draft}
              disabled={!sessionId || sendMutation.isPending}
              onChange={(e) => setComposerDraft(e.target.value)}
              aria-label="Vision message input"
            />
            <Button
              type="submit"
              disabled={!sessionId || !draft.trim() || sendMutation.isPending}
              aria-label="Send vision message"
            >
              {sendMutation.isPending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </form>
        {error && (
          <p className="mt-2 text-xs text-rose-600" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
