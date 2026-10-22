import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/** In-app dialogs in the app style, replacing the browser's confirm()/alert() popups. */
export interface DialogOptions {
  title: string;
  message: ReactNode;
  /** Highlighted note under the message, e.g. a risk to be aware of. */
  warning?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Colour of the confirm button: primary (blue), danger (red). */
  tone?: 'primary' | 'danger';
  /** Small label above the title. */
  eyebrow?: string;
  /** Information only: a single OK button. */
  alertOnly?: boolean;
}

interface DialogApi {
  confirm: (o: DialogOptions) => Promise<boolean>;
  alert: (o: Omit<DialogOptions, 'alertOnly' | 'cancelLabel'>) => Promise<void>;
}

const Ctx = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useDialog must be used inside <DialogProvider>');
  return api;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<(DialogOptions & { resolve: (ok: boolean) => void }) | null>(null);

  const confirm = useCallback(
    (o: DialogOptions) => new Promise<boolean>((resolve) => setCurrent({ ...o, resolve })),
    [],
  );
  const alert = useCallback(
    (o: Omit<DialogOptions, 'alertOnly' | 'cancelLabel'>) =>
      new Promise<void>((resolve) => setCurrent({ ...o, alertOnly: true, resolve: () => resolve() })),
    [],
  );

  const close = (ok: boolean) => {
    current?.resolve(ok);
    setCurrent(null);
  };

  return (
    <Ctx.Provider value={{ confirm, alert }}>
      {children}
      {current && <Dialog options={current} onClose={close} />}
    </Ctx.Provider>
  );
}

function Dialog({ options: o, onClose }: { options: DialogOptions; onClose: (ok: boolean) => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Enter confirms, Esc cancels; focus the main button.
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}>
      <div className={`dialog tone-${o.tone ?? 'primary'}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        {o.eyebrow && <div className="dialog-eyebrow">{o.eyebrow}</div>}
        <h2 id="dialog-title">{o.title}</h2>
        <div className="dialog-message">{o.message}</div>
        {o.warning && <div className="dialog-warning">{o.warning}</div>}
        <div className="dialog-actions">
          {!o.alertOnly && (
            <button className="dialog-cancel" onClick={() => onClose(false)}>
              {o.cancelLabel ?? 'Cancel'}
            </button>
          )}
          <button ref={confirmRef} className="dialog-confirm" onClick={() => onClose(true)}>
            {o.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
