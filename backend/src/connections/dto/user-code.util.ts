/** Normalizes the human-typed code: trim, uppercase, tolerate a missing/extra dash. */
export const normalizeUserCode = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export const USER_CODE_PATTERN = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/;
