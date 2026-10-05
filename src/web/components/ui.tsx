import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { Icon } from './Icon';

/** Form field with a programmatically associated label, hint and error. */
export function Field(props: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
  optional?: boolean;
}) {
  const id = useId();
  const hintId = props.hint ? `${id}-hint` : undefined;
  const errorId = props.error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>
        {props.label}
        {props.optional ? <span className="muted"> (optional)</span> : null}
      </label>
      {props.hint ? (
        <span className="hint" id={hintId}>
          {props.hint}
        </span>
      ) : null}
      {props.error ? (
        <span className="field-error" id={errorId}>
          {props.error}
        </span>
      ) : null}
      {props.children({ id, describedBy, invalid: Boolean(props.error) })}
    </div>
  );
}

export function TextField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  autoComplete?: string;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'email' | 'tel' | 'search';
  required?: boolean;
  multiline?: boolean;
  rows?: number;
  className?: string;
  autoFocus?: boolean;
  spellCheck?: boolean;
  maxLength?: number;
}) {
  return (
    <Field label={props.label} hint={props.hint} error={props.error} optional={props.optional}>
      {({ id, describedBy, invalid }) =>
        props.multiline ? (
          <textarea
            id={id}
            value={props.value}
            rows={props.rows ?? 5}
            onChange={(e) => props.onChange(e.target.value)}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            required={props.required}
            maxLength={props.maxLength}
          />
        ) : (
          <input
            id={id}
            type={props.type ?? 'text'}
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            autoComplete={props.autoComplete}
            inputMode={props.inputMode}
            required={props.required}
            className={props.className}
            // Only set by single-purpose screens (sign-in, code entry) where the field is the next thing the person does.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus={props.autoFocus}
            spellCheck={props.spellCheck}
            maxLength={props.maxLength}
          />
        )
      }
    </Field>
  );
}

export function SelectField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
}) {
  return (
    <Field label={props.label} hint={props.hint} error={props.error} optional={props.optional}>
      {({ id, describedBy, invalid }) => (
        <select
          id={id}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        >
          {props.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function Checkbox(props: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="choice">
      <input
        id={id}
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
        aria-describedby={props.hint ? `${id}-h` : undefined}
      />
      <div>
        <label htmlFor={id}>{props.label}</label>
        {props.hint ? (
          <span className="hint" id={`${id}-h`}>
            {props.hint}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function Radio(props: {
  name: string;
  label: ReactNode;
  value: string;
  checked: boolean;
  onChange: (v: string) => void;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="choice">
      <input
        id={id}
        type="radio"
        name={props.name}
        value={props.value}
        checked={props.checked}
        onChange={() => props.onChange(props.value)}
        aria-describedby={props.hint ? `${id}-h` : undefined}
      />
      <div>
        <label htmlFor={id}>{props.label}</label>
        {props.hint ? (
          <span className="hint" id={`${id}-h`}>
            {props.hint}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Error summary that receives focus so screen-reader and keyboard users notice it. */
export function ErrorSummary({ error }: { error: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) ref.current?.focus();
  }, [error]);
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  const fields = e ? Object.values(e.fields) : [];
  return (
    <div className="alert alert-error" role="alert" tabIndex={-1} ref={ref}>
      <span className="alert-title">
        {e?.message ?? (error as Error).message ?? 'Something went wrong'}
      </span>
      {fields.length > 1 ? (
        <ul>
          {fields.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : null}
      {e?.retryAfterSeconds ? (
        <p>Try again in about {Math.ceil(e.retryAfterSeconds / 60)} minute(s).</p>
      ) : null}
    </div>
  );
}

export function Alert({
  kind = 'info',
  title,
  children,
}: {
  kind?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {title ? <span className="alert-title">{title}</span> : null}
      {children}
    </div>
  );
}

export function fieldError(error: unknown, name: string): string | undefined {
  return error instanceof ApiError ? error.fields[name] : undefined;
}

/**
 * Accessible modal dialog built on the native <dialog> element, which provides
 * focus trapping, Escape to close and inert background content.
 */
export function Dialog(props: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
  describedBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) {
      opener.current = document.activeElement;
      d.showModal();
    } else if (!props.open && d.open) {
      d.close();
      (opener.current as HTMLElement | null)?.focus?.();
    }
  }, [props.open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={props.describedBy}
      onClose={props.onClose}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
    >
      <div className="dialog-body">
        <h2 id={titleId} style={{ marginTop: 0 }}>
          {props.title}
        </h2>
        {props.children}
      </div>
      <div className="dialog-actions">{props.actions}</div>
    </dialog>
  );
}

/** Strong confirmation for permanent or significant actions: type a word to enable. */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  danger?: boolean;
  typeToConfirm?: string;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const descId = useId();
  useEffect(() => {
    if (props.open) {
      setTyped('');
      setError(null);
    }
  }, [props.open]);
  const allowed =
    !props.typeToConfirm || typed.trim().toLowerCase() === props.typeToConfirm.toLowerCase();
  return (
    <Dialog
      open={props.open}
      title={props.title}
      onClose={props.onClose}
      describedBy={descId}
      actions={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={props.danger ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={!allowed || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await props.onConfirm();
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Working…' : props.confirmLabel}
          </button>
        </>
      }
    >
      <div id={descId}>{props.body}</div>
      <ErrorSummary error={error} />
      {props.typeToConfirm ? (
        <TextField
          label={`Type "${props.typeToConfirm}" to confirm`}
          value={typed}
          onChange={setTyped}
          autoComplete="off"
          spellCheck={false}
        />
      ) : null}
    </Dialog>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p role="status" className="muted">
      {label}
    </p>
  );
}

export function StatusLine({
  ok,
  warn,
  children,
}: {
  ok?: boolean;
  warn?: boolean;
  children: ReactNode;
}) {
  const cls = ok ? 'status-ok' : warn ? 'status-warn' : 'status-bad';
  return (
    <span className={`status-line ${cls}`}>
      <Icon name={ok ? 'check' : warn ? 'clock' : 'alert'} />
      {children}
    </span>
  );
}
