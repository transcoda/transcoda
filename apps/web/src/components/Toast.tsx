import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Icon } from './Icon.tsx';

export type Toast = {
  id: number;
  tone: 'info' | 'success' | 'error';
  text: string;
  action?: { label: string; onClick(): void };
};

type ToastApi = {
  info(text: string): void;
  /** A finished change ("Library Movies created"): a check, the replaced green; leaves like info. */
  success(text: string): void;
  error(text: string, action?: Toast['action']): void;
  dismiss(id: number): void;
};

const INFO_MS = 4000;

const ToastContext = createContext<ToastApi | null>(null);

/** Info toasts leave after 4 s; error toasts stay until dismissed (or their action is used). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);

  const api = useMemo<ToastApi>(() => {
    const passing = (tone: 'info' | 'success', text: string) => {
      const id = nextId.current++;
      setToasts((all) => [...all, { id, tone, text }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), INFO_MS),
      );
    };
    return {
      info: (text) => passing('info', text),
      success: (text) => passing('success', text),
      error(text, action) {
        const id = nextId.current++;
        const toast: Toast = { id, tone: 'error', text };
        if (action) toast.action = action;
        setToasts((all) => [...all, toast]);
      },
      dismiss,
    };
  }, [dismiss]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const errors = toasts.filter((t) => t.tone === 'error');
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts">
        <div role="status" aria-live="polite" aria-atomic="false">
          {toasts
            .filter((t) => t.tone !== 'error')
            .map((t) => (
              <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
            ))}
        </div>
        {errors.length > 0 && (
          // Inserted with its content: an alert is announced when it appears.
          <div role="alert" aria-atomic="false">
            {errors.map((t) => (
              <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
            ))}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

const TOAST_ICON = { info: 'info', success: 'check-circle', error: 'alert' } as const;

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss(id: number): void }) {
  const { action } = toast;
  return (
    <div className={`toast toast-${toast.tone}`}>
      <Icon name={TOAST_ICON[toast.tone]} size={16} round />
      <span className="toast-text">{toast.text}</span>
      {action && (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => {
            onDismiss(toast.id);
            action.onClick();
          }}
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss"
        onClick={() => onDismiss(toast.id)}
      >
        <Icon name="cross" size={14} />
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast needs a ToastProvider');
  return api;
}
