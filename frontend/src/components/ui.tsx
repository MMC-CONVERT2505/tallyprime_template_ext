import { useState, type InputHTMLAttributes } from 'react';
import { IconCheck, IconCopy, IconEye, IconEyeOff } from './Icons';

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="password-field">
      <input {...props} type={visible ? 'text' : 'password'} />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setVisible((v) => !v)}
        tabIndex={-1}
        title={visible ? 'Hide password' : 'Show password'}
        aria-label={visible ? 'Hide password' : 'Show password'}
      >
        {visible ? <IconEyeOff /> : <IconEye />}
      </button>
    </div>
  );
}

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be unavailable (insecure context, permissions) — fail quietly, the value is still selectable/visible.
    }
  };

  return (
    <button type="button" className="copy-btn" onClick={() => void copy()} title="Copy to clipboard">
      {copied ? <IconCheck className="ok-color" /> : <IconCopy />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="empty-state">
      <div className="empty-state-dot" />
      <span>{message}</span>
    </div>
  );
}
