import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="workflow-empty" style={{ padding: '60px 0' }}>
            <div className="workflow-empty-icon">
              <i className="ri-error-warning-line" />
            </div>
            <div className="workflow-empty-text">组件渲染异常</div>
            <div className="workflow-empty-sub">点击顶栏按钮重新打开</div>
          </div>
        )
      )
    }
    return this.props.children
  }
}
