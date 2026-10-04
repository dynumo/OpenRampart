import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Icon, Logo } from '../components/Icon';
import { Alert, ErrorSummary, fieldError, Loading, TextField } from '../components/ui';
import { api, setRecordOwner } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePageTitle } from '../lib/hooks';

function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  usePageTitle(title);
  return (
    <div className="auth-shell">
      <main id="main" className="auth-card card" tabIndex={-1} style={{ padding: '1.5rem' }}>
        <div className="brand">
          <Logo />
          <span>OpenRampart</span>
        </div>
        <h1>{title}</h1>
        {children}
      </main>
    </div>
  );
}

function safeReturnTo(value: string | null): string {
  // Only same-origin paths; never an absolute URL (open redirect protection).
  if (value && value.startsWith('/') && !value.startsWith('//')) return value;
  return '/';
}

export function LoginPage() {
  const { state, refresh } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (state?.stage === 'active') navigate(returnTo, { replace: true });
    if (state?.stage === 'totp_setup') navigate(`/setup/authenticator?returnTo=${encodeURIComponent(returnTo)}`, { replace: true });
  }, [state?.stage, navigate, returnTo]);

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login', { method: 'POST', body: { login, password } });
      setPassword('');
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ usedRecoveryCode: boolean; remainingRecoveryCodes: number | null }>('/auth/mfa', { method: 'POST', body: { code } });
      if (r.usedRecoveryCode) setNotice(`You used a recovery code. ${r.remainingRecoveryCodes} remain.`);
      await refresh();
    } catch (err) {
      setError(err);
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (!state) return <AuthShell title="Sign in"><Loading /></AuthShell>;

  if (state.stage === 'mfa') {
    return (
      <AuthShell title="Enter your authentication code">
        {notice ? <Alert kind="info">{notice}</Alert> : null}
        <ErrorSummary error={error} />
        <form onSubmit={submitCode} noValidate>
          <TextField
            label="Code from your authenticator app"
            hint="Open your authenticator app and enter the 6-digit code for OpenRampart. If you cannot use your app, enter one of your recovery codes instead."
            value={code}
            onChange={setCode}
            autoComplete="one-time-code"
            inputMode="text"
            className="input-code"
            error={fieldError(error, 'code')}
            autoFocus
            spellCheck={false}
          />
          <button className="btn btn-primary" type="submit" disabled={busy || !code.trim()}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
        </form>
        <p style={{ marginTop: '1.5rem' }}>
          <button
            type="button"
            className="link-button"
            onClick={async () => {
              await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
              await refresh();
            }}
          >
            Start again with a different account
          </button>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Sign in">
      {params.get('reset') ? <Alert kind="success">Your password has been changed. Sign in with your new password.</Alert> : null}
      <ErrorSummary error={error} />
      <form onSubmit={submitPassword} noValidate>
        <TextField label="Username or email" value={login} onChange={setLogin} autoComplete="username" error={fieldError(error, 'login')} autoFocus spellCheck={false} />
        <TextField label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" error={fieldError(error, 'password')} />
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Continue'}
        </button>
      </form>
      <ul className="plain-list" style={{ marginTop: '1.5rem' }}>
        {state.mailConfigured ? (
          <li>
            <Link to="/reset-password">Forgotten your password?</Link>
          </li>
        ) : null}
        {state.registration.open ? (
          <li>
            <Link to="/register">{state.registration.firstUser ? 'Set up OpenRampart (create the first account)' : 'Create an account'}</Link>
          </li>
        ) : null}
      </ul>
    </AuthShell>
  );
}

export function AccountForm({ onSubmit, busy, error, submitLabel, intro }: { onSubmit: (v: { username: string; displayName: string; email: string; password: string; timezone: string }) => void; busy: boolean; error: unknown; submitLabel: string; intro?: ReactNode }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London';
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (password !== confirm) {
          setMismatch(true);
          return;
        }
        setMismatch(false);
        onSubmit({ username, displayName, email, password, timezone });
      }}
    >
      {intro}
      <ErrorSummary error={error} />
      <TextField label="Your name" hint="How you would like to be shown, for example to people helping you." value={displayName} onChange={setDisplayName} autoComplete="name" error={fieldError(error, 'displayName')} />
      <TextField label="Username" hint="Letters, numbers, dots, hyphens or underscores." value={username} onChange={setUsername} autoComplete="username" error={fieldError(error, 'username')} spellCheck={false} />
      <TextField label="Email" type="email" optional hint="Used for account recovery and security notices. Never shared." value={email} onChange={setEmail} autoComplete="email" error={fieldError(error, 'email')} />
      <TextField label="Password" type="password" hint="At least 12 characters. A phrase of several unrelated words works well." value={password} onChange={setPassword} autoComplete="new-password" error={fieldError(error, 'password')} />
      <TextField label="Confirm password" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" error={mismatch ? 'The passwords do not match.' : undefined} />
      <p className="small muted">Your time zone is set to {timezone}. You can change it later in Settings.</p>
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? 'Creating account…' : submitLabel}
      </button>
    </form>
  );
}

export function RegisterPage() {
  const { state, refresh } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!state) return <AuthShell title="Create an account"><Loading /></AuthShell>;
  if (!state.registration.open) {
    return (
      <AuthShell title="Create an account">
        <p>New accounts on this server can only be created with an invitation. If someone has invited you to help them, use the link in their invitation.</p>
        <p>
          <Link to="/login">Sign in</Link>
        </p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={state.registration.firstUser ? 'Set up OpenRampart' : 'Create an account'}>
      {state.registration.firstUser ? <Alert kind="info">This is the first account on this server, so it will also be the administrator.</Alert> : null}
      <AccountForm
        busy={busy}
        error={error}
        submitLabel="Create account"
        onSubmit={async (v) => {
          setBusy(true);
          setError(null);
          try {
            await api('/auth/register', { method: 'POST', body: v });
            await refresh();
            navigate('/setup/authenticator');
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      />
      <p style={{ marginTop: '1.5rem' }}>
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </AuthShell>
  );
}

export function RecoveryCodesList({ codes }: { codes: string[] }) {
  return (
    <>
      <ol className="recovery-codes" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="row no-print">
        <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}>
          Copy codes
        </button>
        <button type="button" className="btn" onClick={() => window.print()}>
          Print codes
        </button>
        <a className="btn" href={`data:text/plain;charset=utf-8,${encodeURIComponent(`OpenRampart recovery codes\nEach code works once.\n\n${codes.join('\n')}\n`)}`} download="openrampart-recovery-codes.txt">
          Download codes
        </a>
      </div>
    </>
  );
}

/** TOTP enrolment: QR code, manual secret, confirmation, recovery codes. */
export function TotpEnrolment({ onDone, replacing }: { onDone: () => void; replacing?: boolean }) {
  const [setup, setSetup] = useState<{ qrSvg: string; secretDisplay: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [currentCode, setCurrentCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api<{ qrSvg: string; secretDisplay: string; uri: string }>('/auth/totp/begin', { method: 'POST' }).then(setSetup, setError);
  }, []);
  if (codes) {
    return (
      <div className="stack">
        <Alert kind="success" title="Your authenticator app is set up">
          From now on you will enter a code from the app when you sign in.
        </Alert>
        <h2>Save your recovery codes</h2>
        <p>If you lose your phone, each of these codes lets you sign in once. Keep them somewhere safe and private, such as printed in a drawer or in a password manager. They will not be shown again.</p>
        <RecoveryCodesList codes={codes} />
        <div className="choice">
          <input id="saved-codes" type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <label htmlFor="saved-codes">I have saved my recovery codes</label>
        </div>
        <button type="button" className="btn btn-primary" disabled={!saved} onClick={onDone}>
          Continue
        </button>
      </div>
    );
  }
  return (
    <div className="stack">
      <ErrorSummary error={error} />
      <ol>
        <li>Install an authenticator app on your phone if you do not have one (for example the one built into your password manager, or Google Authenticator, Microsoft Authenticator, 2FAS or Aegis).</li>
        <li>In the app, add an account and scan this QR code.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      {setup ? (
        <>
          {/* The QR SVG is generated by the server from a fixed template, not user content. */}
          <div className="qr" role="img" aria-label="QR code for your authenticator app. If you cannot scan it, use the setup key below." dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
          <details>
            <summary>Cannot scan the code? Enter the setup key instead</summary>
            <p>
              Setup key: <span className="mono">{setup.secretDisplay}</span>
            </p>
            <p className="small muted">Choose “time-based”, 6 digits, every 30 seconds.</p>
          </details>
        </>
      ) : (
        <Loading label="Preparing your setup code…" />
      )}
      <form
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await api<{ recoveryCodes: string[] }>('/auth/totp/confirm', { method: 'POST', body: { code, currentCode: replacing ? currentCode : undefined } });
            setCodes(r.recoveryCodes);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        {replacing ? <TextField label="Code from your current authenticator" value={currentCode} onChange={setCurrentCode} autoComplete="one-time-code" inputMode="numeric" className="input-code" error={fieldError(error, 'currentCode')} /> : null}
        <TextField label={replacing ? 'Code from the new authenticator' : 'Code from the app'} value={code} onChange={setCode} autoComplete="one-time-code" inputMode="numeric" className="input-code" error={fieldError(error, 'code')} />
        <button className="btn btn-primary" type="submit" disabled={busy || !setup}>
          {busy ? 'Checking…' : 'Confirm'}
        </button>
      </form>
    </div>
  );
}

export function SetupAuthenticatorPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  return (
    <AuthShell title="Set up two-step sign-in">
      <p>Your record holds personal information, so OpenRampart asks for a code from an authenticator app as well as your password.</p>
      <TotpEnrolment
        onDone={async () => {
          await refresh();
          navigate(safeReturnTo(params.get('returnTo')), { replace: true });
        }}
      />
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (token) {
    return (
      <AuthShell title="Choose a new password">
        <ErrorSummary error={error} />
        <form
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api('/auth/password-reset/complete', { method: 'POST', body: { token, password } });
              navigate('/login?reset=1');
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <TextField label="New password" type="password" hint="At least 12 characters." value={password} onChange={setPassword} autoComplete="new-password" error={fieldError(error, 'password')} />
          <button className="btn btn-primary" type="submit" disabled={busy}>
            Save new password
          </button>
        </form>
        <p className="small muted" style={{ marginTop: '1rem' }}>
          You will still need your authenticator app or a recovery code to sign in.
        </p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Reset your password">
      {sent ? (
        <Alert kind="success" title="Check your email">
          If an account with an email address matches, we have sent a link to reset the password. The link works once and expires in an hour.
        </Alert>
      ) : (
        <form
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await api('/auth/password-reset/request', { method: 'POST', body: { login } });
              setSent(true);
            } catch (err) {
              setError(err);
            }
          }}
        >
          <ErrorSummary error={error} />
          <TextField label="Username or email" value={login} onChange={setLogin} autoComplete="username" />
          <button className="btn btn-primary" type="submit">
            Send reset link
          </button>
        </form>
      )}
      <p style={{ marginTop: '1rem' }}>
        <Link to="/login">Back to sign in</Link>
      </p>
    </AuthShell>
  );
}

interface InvitationView {
  state: 'valid' | 'expired' | 'used' | 'revoked' | 'invalid';
  ownerName?: string;
  label?: string;
  expiresAt?: string;
  summary?: string[];
}

export function InvitationPage() {
  const { token } = useParams();
  const { state, refresh } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [invite, setInvite] = useState<InvitationView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<InvitationView>(`/invitations/${token}`).then(setInvite, setError);
  }, [token]);
  if (!invite) return <AuthShell title="Invitation">{error ? <ErrorSummary error={error} /> : <Loading />}</AuthShell>;
  if (invite.state !== 'valid') {
    const reason = { expired: 'has expired', used: 'has already been used', revoked: 'has been withdrawn', invalid: 'is not valid' }[invite.state];
    return (
      <AuthShell title="This invitation cannot be used">
        <p>This invitation link {reason}. Invitation links work once and expire after a few days. Ask the person who invited you to send a new one.</p>
        <p>
          <Link to="/login">Go to sign in</Link>
        </p>
      </AuthShell>
    );
  }
  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ ownerId: string }>(`/invitations/${token}/accept`, { method: 'POST' });
      setRecordOwner(r.ownerId);
      qc.clear();
      await refresh();
      navigate('/');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title={`Help ${invite.ownerName} with their record`}>
      <p>
        <strong>{invite.ownerName}</strong> has invited you to be a Helper (“{invite.label}”). Being a Helper lets you see, and if allowed add to, part of their OpenRampart record. It does not make you an administrator.
      </p>
      <div className="panel-muted">
        <p style={{ marginBottom: '0.25rem' }}>
          <strong>Access offered</strong>
        </p>
        <ul>
          {invite.summary?.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        <p className="small" style={{ margin: 0 }}>
          This invitation works once and expires on {new Date(invite.expiresAt!).toLocaleString('en-GB')}.
        </p>
      </div>
      <ErrorSummary error={error} />
      {state?.stage === 'active' ? (
        <div className="stack" style={{ marginTop: '1rem' }}>
          <p>You are signed in as {state.user?.displayName}. Accepting links this access to your account.</p>
          <button type="button" className="btn btn-primary" onClick={accept} disabled={busy}>
            <Icon name="check" />
            Accept invitation
          </button>
        </div>
      ) : (
        <>
          <h2>New to OpenRampart?</h2>
          <AccountForm
            busy={busy}
            error={error}
            submitLabel="Create account and accept"
            onSubmit={async (v) => {
              setBusy(true);
              setError(null);
              try {
                const r = await api<{ ownerId: string | null }>(`/invitations/${token}/register`, { method: 'POST', body: v });
                if (r.ownerId) setRecordOwner(r.ownerId);
                await refresh();
                navigate('/setup/authenticator');
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          />
          <h2>Already have an account?</h2>
          <p>
            <Link to={`/login?returnTo=${encodeURIComponent(`/invite/${token}`)}`}>Sign in to accept</Link>
          </p>
        </>
      )}
    </AuthShell>
  );
}
