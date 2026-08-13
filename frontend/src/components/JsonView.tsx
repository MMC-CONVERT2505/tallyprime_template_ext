import { IconAlert } from './Icons';

export function JsonView({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;
  return <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>;
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="error-banner">
      <IconAlert />
      <span>{message}</span>
    </div>
  );
}
