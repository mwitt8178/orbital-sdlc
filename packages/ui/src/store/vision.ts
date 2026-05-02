/**
 * store/vision.ts — vision-intake view state.
 *
 * Holds the currently-active session/document selection and the typed message
 * draft. Locked + draft documents themselves come from vision.get/history.
 */

import { create } from 'zustand'

export interface VisionMessage {
  visionMessageId: string
  authorRole: 'user' | 'pm_persona'
  body: string
  postedAt: string
}

interface VisionState {
  currentSessionId: string | null
  currentDocumentId: string | null
  messages: VisionMessage[]
  composerDraft: string
  setSession: (sessionId: string | null, documentId: string | null) => void
  appendMessage: (msg: VisionMessage) => void
  setComposerDraft: (text: string) => void
  resetMessages: () => void
}

export const useVisionStore = create<VisionState>((set) => ({
  currentSessionId: null,
  currentDocumentId: null,
  messages: [],
  composerDraft: '',
  setSession: (sessionId, documentId) =>
    set({
      currentSessionId: sessionId,
      currentDocumentId: documentId,
      messages: [],
    }),
  appendMessage: (msg) =>
    set((state) => ({
      messages: [...state.messages, msg].slice(-200),
    })),
  setComposerDraft: (composerDraft) => set({ composerDraft }),
  resetMessages: () => set({ messages: [] }),
}))
