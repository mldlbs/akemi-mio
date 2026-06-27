export function MainArea({ children }: { children: React.ReactNode }) {
  return (
    <main className="main-area">
      <div className="main-area-inner">{children}</div>
    </main>
  )
}
