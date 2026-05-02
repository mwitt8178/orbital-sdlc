import { create } from 'zustand'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting'

interface ConnectionState {
  status: ConnectionStatus
  cursor: string | null
  reconnectAttempts: number
  setStatus: (status: ConnectionStatus) => void
  setCursor: (cursor: string | null) => void
  incrementReconnectAttempts: () => void
  resetReconnectAttempts: () => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  cursor: null,
  reconnectAttempts: 0,
  setStatus: (status) => set({ status }),
  setCursor: (cursor) => set({ cursor }),
  incrementReconnectAttempts: () =>
    set((state) => ({ reconnectAttempts: state.reconnectAttempts + 1 })),
  resetReconnectAttempts: () => set({ reconnectAttempts: 0 }),
}))
