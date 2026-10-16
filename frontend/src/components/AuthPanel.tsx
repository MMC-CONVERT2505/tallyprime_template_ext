import { useState, type FormEvent } from 'react';
import { useAuth } from '../AuthContext';
import { ApiError, authApi } from '../api';
import { ErrorBanner } from './JsonView';
import { IconLock } from './Icons';
import { PasswordInput, Spinner } from './ui';

/** "Forgot password" is entirely inline on this screen — no clickable
 *  link/landing page, since the backend now emails a short OTP instead (in
 *  local dev, always "0000" — see backend AuthService.DEV_FIXED_OTP).
 *  `request` -> enter email, `verify` -> enter the code + new password,
 *  `done` -> confirmation. */
type ForgotStep = 'request' | 'verify' | 'done';

export function AuthPanel() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [forgotStep, setForgotStep] = useState<ForgotStep>('request');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [requestMessage, setRequestMessage] = useState<string | null>(null);

  const switchMode = (next: typeof mode) => {
    setMode(next);
    setError(null);
    setForgotStep('request');
    setOtp('');
    setNewPassword('');
    setConfirmPassword('');
    setRequestMessage(null);
  };

  const requestOtp = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await authApi.requestPasswordReset(email);
      setRequestMessage(result.message);
      setForgotStep('verify');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const verifyOtpAndReset = async () => {
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await authApi.resetPassword({ email, otp, newPassword });
      setForgotStep('done');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'forgot') {
      if (forgotStep === 'request') await requestOtp();
      else if (forgotStep === 'verify') await verifyOtpAndReset();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await register(email, password, name, orgName);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="brand-mark">
          <IconLock />
        </div>
        <h1>Tally Connector</h1>
        <span className="muted">
          A simple UI over every endpoint in the backend, for end-to-end testing. Mirrors the Postman collection in
          <code> postman/</code>.
        </span>
        {mode !== 'forgot' && (
          <div className="tabs tabs-small">
            <button className={mode === 'login' ? 'active' : ''} onClick={() => switchMode('login')} type="button">
              Login
            </button>
            <button
              className={mode === 'register' ? 'active' : ''}
              onClick={() => switchMode('register')}
              type="button"
            >
              Register
            </button>
          </div>
        )}
        {mode === 'forgot' ? (
          <>
            <h2 style={{ fontSize: 16, marginBottom: 10 }}>Reset your password</h2>
            {forgotStep === 'done' ? (
              <p className="muted" style={{ marginBottom: 16 }}>
                Password reset — you can now log in with your new password.
              </p>
            ) : (
              <form onSubmit={submit} className="form">
                <label>
                  Email
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={forgotStep === 'verify'}
                    required
                  />
                </label>
                {forgotStep === 'verify' && (
                  <>
                    {requestMessage && (
                      <p className="muted" style={{ margin: '-4px 0 4px', fontSize: 13 }}>
                        {requestMessage}
                      </p>
                    )}
                    <label>
                      4-digit code
                      <input
                        value={otp}
                        onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 4))}
                        inputMode="numeric"
                        pattern="\d{4}"
                        maxLength={4}
                        placeholder="0000"
                        required
                      />
                    </label>
                    <label>
                      New password
                      <PasswordInput
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        required
                        minLength={8}
                      />
                    </label>
                    <label>
                      Confirm new password
                      <PasswordInput
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        required
                        minLength={8}
                      />
                    </label>
                  </>
                )}
                <button type="submit" disabled={busy}>
                  {busy && <Spinner />}
                  {busy ? 'Working…' : forgotStep === 'request' ? 'Send code' : 'Reset password'}
                </button>
                {forgotStep === 'verify' && (
                  <button type="button" className="link-button" onClick={() => void requestOtp()} disabled={busy}>
                    Resend code
                  </button>
                )}
              </form>
            )}
            <button type="button" className="link-button" onClick={() => switchMode('login')}>
              ← Back to login
            </button>
          </>
        ) : (
          <form onSubmit={submit} className="form">
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label>
              Password
              <PasswordInput
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
              />
            </label>
            {mode === 'login' && (
              <button
                type="button"
                className="link-button"
                onClick={() => switchMode('forgot')}
                style={{ alignSelf: 'flex-end' }}
              >
                Forgot password?
              </button>
            )}
            {mode === 'register' && (
              <>
                <label>
                  Name
                  <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
                </label>
                <label>
                  Org name
                  <input type="text" value={orgName} onChange={(e) => setOrgName(e.target.value)} required />
                </label>
              </>
            )}
            <button type="submit" disabled={busy}>
              {busy && <Spinner />}
              {busy ? 'Working…' : mode === 'login' ? 'Log in' : 'Register'}
            </button>
          </form>
        )}
        <ErrorBanner message={error} />
      </div>
    </div>
  );
}
