import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { OAUTH_SCOPES, SCOPE_DESCRIPTIONS, type OAuthScope } from '../../shared/scopes';
import { Icon, Logo } from '../components/Icon';
import { Alert, Checkbox, ErrorSummary, Loading, Radio } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePageTitle } from '../lib/hooks';

interface InteractionView {
  uid: string;
  client: { id: string; name: string; uri: string | null; registration: 'metadata_document' | 'dynamic' | 'static' };
  redirectUri: string;
  redirectHost: string;
  redirectIsLocalhost: boolean;
  resource: string;
  requestedScopes: OAuthScope[];
  records: { ownerId: string; name: string; relationship: 'own' | 'helper' }[];
}

/**
 * OAuth consent screen for MCP clients. The user signs in with OpenRampart's
 * own account (password + TOTP) before this page is shown; the client never
 * sees those credentials. Each requested permission can be unticked.
 */
export function ConsentPage() {
  usePageTitle('Authorise a connection');
  const { uid } = useParams();
  const { state } = useAuth();
  const navigate = useNavigate();
  const details = useQuery({
    queryKey: ['interaction', uid],
    queryFn: () => api<InteractionView>(`/interaction/${uid}/details`, { base: '/oauth' }),
    enabled: state?.stage === 'active',
    retry: false,
  });
  const [scopes, setScopes] = useState<OAuthScope[]>([]);
  const [ownerId, setOwnerId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state && state.stage !== 'active') navigate(`/login?returnTo=${encodeURIComponent(`/oauth/interaction/${uid}`)}`, { replace: true });
  }, [state, uid, navigate]);
  useEffect(() => {
    if (details.data) {
      // Contents of documents and the ability to write are opt-in even when requested.
      setScopes(details.data.requestedScopes.filter((s) => !['attachments:read', 'export:read'].includes(s) && !s.endsWith(':write')));
      setOwnerId(details.data.records[0]!.ownerId);
    }
  }, [details.data]);

  const finish = async (path: 'approve' | 'deny') => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ redirectTo: string }>(`/interaction/${uid}/${path}`, { method: 'POST', base: '/oauth', body: path === 'approve' ? { ownerId, scopes } : {} });
      window.location.assign(r.redirectTo);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="auth-shell">
      <main id="main" className="auth-card card" tabIndex={-1} style={{ padding: '1.5rem', width: 'min(40rem, 100%)' }}>
        <div className="brand">
          <Logo />
          <span>OpenRampart</span>
        </div>
        {children}
      </main>
    </div>
  );

  if (!state || (state.stage === 'active' && details.isLoading)) return shell(<Loading />);
  if (details.error) {
    const expired = details.error instanceof ApiError && (details.error.status === 400 || details.error.status === 404);
    return shell(
      <>
        <h1>This request has expired</h1>
        <p>{expired ? 'The authorisation request is no longer valid. Return to the application and try connecting again.' : (details.error as Error).message}</p>
      </>,
    );
  }
  const d = details.data!;
  return shell(
    <>
      <h1>
        {d.client.name} is requesting access to OpenRampart
      </h1>
      <dl className="details">
        <dt>Application</dt>
        <dd>
          {d.client.name}
          {d.client.uri ? (
            <span className="muted small">
              {' '}
              ({new URL(d.client.uri).host})
            </span>
          ) : null}
        </dd>
        <dt>Will return to</dt>
        <dd>
          <strong>{d.redirectHost}</strong>
        </dd>
      </dl>
      {d.redirectIsLocalhost ? (
        <Alert kind="warning" title="This application runs on your own device">
          It returns to an address on this computer (“{d.redirectHost}”). Only continue if you started this connection yourself just now, from an application you trust.
        </Alert>
      ) : null}
      {d.client.registration === 'dynamic' ? <p className="small muted">This application registered itself automatically. OpenRampart cannot confirm who made it; the name above is the one it gave.</p> : null}
      <ErrorSummary error={error} />
      {d.records.length > 1 ? (
        <fieldset>
          <legend>Which record?</legend>
          {d.records.map((r) => (
            <Radio key={r.ownerId} name="record" value={r.ownerId} checked={ownerId === r.ownerId} onChange={setOwnerId} label={r.relationship === 'own' ? `${r.name} (your own record)` : `${r.name} (shared with you)`} />
          ))}
        </fieldset>
      ) : null}
      <fieldset>
        <legend>Allow it to</legend>
        <span className="hint">Untick anything you do not want to allow. Reading document contents and making changes are off unless you choose them.</span>
        {OAUTH_SCOPES.filter((s) => d.requestedScopes.includes(s)).map((s) => (
          <Checkbox
            key={s}
            label={
              <>
                <Icon name={scopes.includes(s) ? 'check' : 'x'} /> {SCOPE_DESCRIPTIONS[s].label}
              </>
            }
            hint={SCOPE_DESCRIPTIONS[s].detail}
            checked={scopes.includes(s)}
            onChange={(c) => setScopes(c ? [...scopes, s] : scopes.filter((x) => x !== s))}
          />
        ))}
      </fieldset>
      <p className="small muted">The application never receives your password, authenticator codes or recovery codes. You can disconnect it at any time in Settings → MCP Connections.</p>
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy || !scopes.length} onClick={() => finish('approve')}>
          Allow access
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => finish('deny')}>
          Deny
        </button>
      </div>
    </>,
  );
}
