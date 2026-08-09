import { Component } from 'react';
import { Button } from './ui/index.jsx';

/**
 * Catches render-time crashes so a bug shows a recoverable screen instead of a
 * blank page. Stack details appear in development only.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Render error:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="center" style={{ flex: 1, padding: 'var(--space-6)' }}>
        <div style={{ textAlign: 'center', maxWidth: '32ch' }}>
          <div style={{ fontSize: '3.5rem', marginBottom: 'var(--space-4)' }}>🎲</div>
          <h2 style={{ marginBottom: 'var(--space-3)' }}>Something broke</h2>
          <p className="muted" style={{ marginBottom: 'var(--space-6)', fontSize: 'var(--text-sm)' }}>
            This screen hit an unexpected error.
          </p>
          {import.meta.env.DEV && (
            <pre
              className="mono"
              style={{
                textAlign: 'left',
                fontSize: '11px',
                background: 'rgb(0 0 0 / 0.4)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: 'var(--space-3)',
                marginBottom: 'var(--space-5)',
                overflowX: 'auto',
                color: 'var(--red-300)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {error.message}
            </pre>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <Button
              size="lg"
              full
              onClick={() => {
                this.setState({ error: null });
                this.props.onReset?.();
              }}
            >
              Back to Home
            </Button>
            <Button variant="ghost" size="lg" full onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
