import { useSlots } from '../slots/SlotContext'

export function MainArea({ children }: { children: React.ReactNode }) {
  const { uiState } = useSlots()

  return (
    <main className="main-area">
      <div className="main-area-inner" key={uiState.activeSlot}>
        <div className="slot-enter">
          {children}
        </div>
      </div>
    </main>
  )
}
