import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type {
  ActorDTO,
  EventSummaryDTO,
  GrantDTO,
  HelperDTO,
  IncidentDTO,
} from '../../shared/types';
import { SCOPE_DESCRIPTIONS, type OAuthScope } from '../../shared/scopes';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/Layout';
import { useToast } from '../components/Toasts';
import {
  Alert,
  Checkbox,
  ConfirmDialog,
  ErrorSummary,
  fieldError,
  Loading,
  Radio,
  SelectField,
  StatusLine,
  TextField,
} from '../components/ui';
import { api, apiUrl, getRecordOwner } from '../lib/api';
import { useAuth, useRecord, useSwitchRecord } from '../lib/auth';
import { bytes, formatDate, formatDateTime } from '../lib/format';
import { usePageTitle } from '../lib/hooks';
import { RecoveryCodesList, TotpEnrolment } from './Auth';

function SettingsLink({ to, title, children }: { to: string; title: string; children: ReactNode }) {
  return (
    <li className="card">
      <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>
        <Link to={to}>{title}</Link>
      </h2>
      <p className="muted small" style={{ margin: 0 }}>
        {children}
      </p>
    </li>
  );
}

export function SettingsIndexPage() {
  usePageTitle('Settings');
  const { state } = useAuth();
  return (
    <>
      <PageHeader title="Settings" />
      <ul className="grid-2 plain-list" style={{ listStyle: 'none', padding: 0 }}>
        <SettingsLink to="/settings/account" title="Account">
          Your name, email, time zone and password.
        </SettingsLink>
        <SettingsLink to="/settings/security" title="Security">
          Two-step sign-in, recovery codes, signed-in devices and the Audit Log.
        </SettingsLink>
        <SettingsLink to="/settings/helpers" title="Helpers">
          Invite trusted people to see or add to parts of your record.
        </SettingsLink>
        {state?.sharedRecords?.length ? (
          <SettingsLink to="/settings/shared" title="Shared with you">
            Records other people have asked you to help with.
          </SettingsLink>
        ) : null}
        <SettingsLink to="/settings/connections" title="MCP Connections">
          AI assistants and other applications you have connected through OAuth.
        </SettingsLink>
        <SettingsLink to="/settings/storage" title="Storage and trash">
          Space used, document processing, and items waiting to be permanently deleted.
        </SettingsLink>
        <SettingsLink to="/settings/export" title="Export your data">
          Download everything, including original files, in ordinary formats.
        </SettingsLink>
        {state?.user?.isAdmin ? (
          <SettingsLink to="/settings/system" title="System settings">
            Administration: accounts, registration, Event types and server status.
          </SettingsLink>
        ) : null}
      </ul>
    </>
  );
}

const TIMEZONES = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf(
      'timeZone',
    );
  } catch {
    return ['Europe/London', 'Europe/Dublin', 'UTC'];
  }
})();

export function AccountSettingsPage() {
  usePageTitle('Account settings');
  const { state, refresh } = useAuth();
  const toast = useToast();
  const [displayName, setDisplayName] = useState(state?.user?.displayName ?? '');
  const [email, setEmail] = useState(state?.user?.email ?? '');
  const [timezone, setTimezone] = useState(state?.user?.timezone ?? 'Europe/London');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pwError, setPwError] = useState<unknown>(null);
  return (
    <>
      <PageHeader title="Account" />
      <section className="card" aria-labelledby="profile-h">
        <h2 id="profile-h">Profile</h2>
        <form
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await api('/auth/profile', {
                method: 'PATCH',
                body: { displayName, email: email || null, timezone },
              });
              await refresh();
              toast('Profile saved');
            } catch (err) {
              setError(err);
            }
          }}
        >
          <ErrorSummary error={error} />
          <p className="small muted">Username: {state?.user?.username}</p>
          <TextField
            label="Name"
            value={displayName}
            onChange={setDisplayName}
            error={fieldError(error, 'displayName')}
          />
          <TextField
            label="Email"
            type="email"
            optional
            value={email}
            onChange={setEmail}
            hint="Used for password reset and security notices."
            error={fieldError(error, 'email')}
          />
          <SelectField
            label="Time zone"
            value={timezone}
            onChange={setTimezone}
            hint="Dates in your record are shown and filtered in this time zone."
            options={TIMEZONES.map((t) => ({ value: t, label: t }))}
          />
          <button className="btn btn-primary" type="submit">
            Save profile
          </button>
        </form>
      </section>
      <section className="card" aria-labelledby="pw-h" style={{ marginTop: '1rem' }}>
        <h2 id="pw-h">Change password</h2>
        <form
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setPwError(null);
            try {
              await api('/auth/password', {
                method: 'POST',
                body: { currentPassword: current, newPassword: next },
              });
              setCurrent('');
              setNext('');
              await refresh();
              toast('Password changed. Other devices have been signed out.');
            } catch (err) {
              setPwError(err);
            }
          }}
        >
          <ErrorSummary error={pwError} />
          <TextField
            label="Current password"
            type="password"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
            error={fieldError(pwError, 'currentPassword')}
          />
          <TextField
            label="New password"
            type="password"
            value={next}
            onChange={setNext}
            autoComplete="new-password"
            hint="At least 12 characters."
            error={fieldError(pwError, 'password')}
          />
          <button className="btn btn-primary" type="submit">
            Change password
          </button>
        </form>
      </section>
    </>
  );
}

interface SessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
  mfaMethod: string | null;
}

function describeDevice(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Firefox\//.test(ua)
    ? 'Firefox'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}

export function SecuritySettingsPage() {
  usePageTitle('Security');
  const { state, refresh } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api<{ sessions: SessionRow[] }>('/auth/sessions'),
  });
  const [replacing, setReplacing] = useState(false);
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const tz = state?.user?.timezone;
  return (
    <>
      <PageHeader
        title="Security"
        lede={<Link to="/settings/security/audit">View the Audit Log</Link>}
      />
      {state?.user?.previousLoginAt ? (
        <Alert kind="info">
          Before this session, you last signed in on{' '}
          {formatDateTime(state.user.previousLoginAt, tz)}
          {state.user.previousLoginIp ? ` from ${state.user.previousLoginIp}` : ''}. If that was not
          you, change your password and sign out other devices.
        </Alert>
      ) : null}
      <section className="card" aria-labelledby="totp-h">
        <h2 id="totp-h">Two-step sign-in</h2>
        <p>
          {state?.user?.totpEnabled ? (
            <StatusLine ok>An authenticator app is set up.</StatusLine>
          ) : (
            <StatusLine warn>Not set up.</StatusLine>
          )}
        </p>
        {replacing ? (
          <TotpEnrolment
            replacing={state?.user?.totpEnabled}
            onDone={async () => {
              setReplacing(false);
              await refresh();
              await qc.invalidateQueries({ queryKey: ['sessions'] });
            }}
          />
        ) : (
          <button type="button" className="btn" onClick={() => setReplacing(true)}>
            {state?.user?.totpEnabled
              ? 'Move to a new authenticator app'
              : 'Set up an authenticator app'}
          </button>
        )}
      </section>
      <section className="card" aria-labelledby="rc-h" style={{ marginTop: '1rem' }}>
        <h2 id="rc-h">Recovery codes</h2>
        <p>
          {state?.recoveryCodesRemaining ?? 0} unused recovery code(s) remaining. Each code can be
          used once if you lose your authenticator app.
        </p>
        {codes ? (
          <>
            <Alert kind="success" title="New recovery codes">
              Your old codes no longer work. Save these now; they will not be shown again.
            </Alert>
            <RecoveryCodesList codes={codes} />
          </>
        ) : (
          <form
            noValidate
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                const r = await api<{ recoveryCodes: string[] }>('/auth/recovery-codes', {
                  method: 'POST',
                  body: { password },
                });
                setCodes(r.recoveryCodes);
                setPassword('');
                await refresh();
              } catch (err) {
                setError(err);
              }
            }}
          >
            <ErrorSummary error={error} />
            <TextField
              label="Your password"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              hint="Needed to create new recovery codes."
              error={fieldError(error, 'currentPassword')}
            />
            <button className="btn" type="submit">
              Create new recovery codes
            </button>
          </form>
        )}
      </section>
      <section className="card" aria-labelledby="sess-h" style={{ marginTop: '1rem' }}>
        <h2 id="sess-h">Signed-in devices</h2>
        {sessions.data ? (
          <>
            <ul className="plain-list">
              {sessions.data.sessions.map((s) => (
                <li key={s.id} className="row" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <strong>{describeDevice(s.userAgent)}</strong>{' '}
                    {s.current ? <span className="badge badge-success">This device</span> : null}
                    <div className="small muted">
                      Signed in {formatDateTime(s.createdAt, tz)} · last active{' '}
                      {formatDateTime(s.lastSeenAt, tz)}
                      {s.ip ? ` · ${s.ip}` : ''}
                      {s.mfaMethod === 'recovery_code' ? ' · used a recovery code' : ''}
                    </div>
                  </div>
                  {!s.current ? (
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={async () => {
                        await api(`/auth/sessions/${s.id}`, { method: 'DELETE' });
                        await qc.invalidateQueries({ queryKey: ['sessions'] });
                        toast('Device signed out');
                      }}
                    >
                      Sign out
                      <span className="visually-hidden"> {describeDevice(s.userAgent)}</span>
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {sessions.data.sessions.length > 1 ? (
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  await api('/auth/sessions/revoke-others', { method: 'POST' });
                  await qc.invalidateQueries({ queryKey: ['sessions'] });
                  toast('All other devices signed out');
                }}
              >
                Sign out all other devices
              </button>
            ) : null}
          </>
        ) : (
          <Loading />
        )}
      </section>
    </>
  );
}

interface AuditEntry {
  id: number;
  occurredAt: string;
  action: string;
  outcome: string;
  targetType: string | null;
  targetId: string | null;
  via: string;
  oauthClientId: string | null;
  ip: string | null;
  userAgent: string | null;
  ownRecord: boolean;
  actorUserId: string | null;
  metadata: Record<string, unknown>;
}

const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'auth.totp_failed': 'Wrong authentication code',
  'auth.recovery_code_used': 'Recovery code used',
  'auth.logout': 'Signed out',
  'auth.account_created': 'Account created',
  'auth.password_changed': 'Password changed',
  'auth.password_reset_requested': 'Password reset requested',
  'auth.password_reset': 'Password reset',
  'auth.totp_enabled': 'Authenticator set up',
  'auth.totp_reset': 'Authenticator replaced',
  'auth.recovery_codes_regenerated': 'Recovery codes replaced',
  'auth.locked': 'Sign-in temporarily blocked',
  'session.created': 'Session started',
  'session.revoked': 'Session signed out',
  'helper.invited': 'Helper invited',
  'helper.invitation_revoked': 'Invitation withdrawn',
  'helper.accepted': 'Helper accepted invitation',
  'helper.ended': 'Helper access ended',
  'grant.created': 'Helper access granted',
  'grant.updated': 'Helper access changed',
  'grant.revoked': 'Helper access revoked',
  'event.created': 'Event added',
  'event.updated': 'Event edited',
  'event.deleted': 'Event moved to trash',
  'event.restored': 'Event restored',
  'event.purged': 'Event permanently deleted',
  'event.linked': 'Events related',
  'event.unlinked': 'Event relationship removed',
  'actor.created': 'Actor added',
  'actor.updated': 'Actor edited',
  'actor.archived': 'Actor archived',
  'actor.deleted': 'Actor deleted',
  'actor.restored': 'Actor restored',
  'actor.merged': 'Actors merged',
  'incident.created': 'Incident created',
  'incident.updated': 'Incident edited',
  'incident.deleted': 'Incident deleted',
  'incident.restored': 'Incident restored',
  'incident.event_added': 'Event added to Incident',
  'incident.event_removed': 'Event removed from Incident',
  'attachment.uploaded': 'Attachment uploaded',
  'attachment.downloaded': 'Attachment opened or downloaded',
  'attachment.deleted': 'Attachment deleted',
  'attachment.restored': 'Attachment restored',
  'attachment.ocr_corrected': 'Document text corrected',
  'attachment.integrity_checked': 'Integrity checked',
  'export.created': 'Data exported',
  'oauth.granted': 'Application connected',
  'oauth.revoked': 'Application disconnected',
  'oauth.denied': 'Application request declined',
  'mcp.access': 'Connected application used the record',
  'admin.action': 'Administrative action',
};

export function AuditLogPage() {
  usePageTitle('Audit Log');
  const { state } = useAuth();
  const [action, setAction] = useState('');
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const q = useInfiniteQuery({
    queryKey: ['audit', action],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) =>
      api<{ entries: AuditEntry[]; nextBefore: number | null }>('/settings/audit', {
        query: { before: pageParam ?? undefined, action: action || undefined, limit: 100 },
      }),
    getNextPageParam: (p) => p.nextBefore,
  });
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <>
      <PageHeader
        title="Audit Log"
        lede="Security and account activity. This is separate from your Event timeline; nothing here becomes an Event unless you choose to record it."
      />
      <ErrorSummary error={error} />
      <div style={{ maxWidth: '22rem' }}>
        <SelectField
          label="Show"
          value={action}
          onChange={setAction}
          options={[
            { value: '', label: 'All activity' },
            { value: 'auth', label: 'Sign-ins and security' },
            { value: 'session', label: 'Sessions' },
            { value: 'helper', label: 'Helpers' },
            { value: 'grant', label: 'Helper access' },
            { value: 'oauth', label: 'Connected applications' },
            { value: 'mcp', label: 'Connected application use' },
            { value: 'event', label: 'Events' },
            { value: 'attachment', label: 'Attachments' },
            { value: 'export', label: 'Exports' },
            { value: 'admin', label: 'Administration' },
          ]}
        />
      </div>
      <div className="table-wrap">
        <table>
          <caption className="visually-hidden">Audit Log entries, newest first</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Activity</th>
              <th scope="col">Details</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{formatDateTime(e.occurredAt, state?.user?.timezone)}</td>
                <td>
                  {ACTION_LABELS[e.action] ?? e.action}
                  {e.outcome === 'failure' ? (
                    <span className="badge badge-risk-high"> failed</span>
                  ) : null}
                  {e.via === 'mcp' ? (
                    <div className="small muted">through a connected application</div>
                  ) : null}
                  {e.actorUserId && e.actorUserId !== state?.user?.id && e.ownRecord ? (
                    <div className="small muted">by a Helper or another account</div>
                  ) : null}
                </td>
                <td className="small">
                  {[
                    e.ip,
                    e.userAgent ? describeDevice(e.userAgent) : null,
                    typeof e.metadata.client === 'string' ? e.metadata.client : null,
                    typeof e.metadata.method === 'string' ? `method: ${e.metadata.method}` : null,
                    e.targetType ? `${e.targetType}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </td>
                <td>
                  {e.ownRecord ? (
                    <button
                      type="button"
                      className="btn btn-small btn-ghost"
                      onClick={async () => {
                        setError(null);
                        try {
                          const ev = await api<{ id: string }>(`/settings/audit/${e.id}/event`, {
                            method: 'POST',
                            body: {},
                          });
                          navigate(`/events/${ev.id}`);
                        } catch (err) {
                          setError(err);
                        }
                      }}
                    >
                      Record as Event
                      <span className="visually-hidden">
                        : {ACTION_LABELS[e.action] ?? e.action} at {formatDateTime(e.occurredAt)}
                      </span>
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.hasNextPage ? (
        <button type="button" className="btn" onClick={() => q.fetchNextPage()}>
          Show older entries
        </button>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------ Helpers

interface GrantDraft {
  scopeType: 'all' | 'actors' | 'incidents';
  actorIds: string[];
  incidentIds: string[];
  dateFrom: string;
  dateTo: string;
  canAdd: boolean;
  canExport: boolean;
  coActorVisibility: 'redacted' | 'name';
  note: string;
}

const emptyGrant: GrantDraft = {
  scopeType: 'actors',
  actorIds: [],
  incidentIds: [],
  dateFrom: '',
  dateTo: '',
  canAdd: false,
  canExport: false,
  coActorVisibility: 'redacted',
  note: '',
};

function grantToPayload(g: GrantDraft) {
  return { ...g, dateFrom: g.dateFrom || null, dateTo: g.dateTo || null, note: g.note || null };
}

function GrantEditor({
  value,
  onChange,
  error,
}: {
  value: GrantDraft;
  onChange: (g: GrantDraft) => void;
  error?: unknown;
}) {
  const actors = useQuery({
    queryKey: ['actors', 'grant'],
    queryFn: () => api<{ items: ActorDTO[] }>('/actors', { query: { limit: 500 } }),
  });
  const incidents = useQuery({
    queryKey: ['incidents', 'grant'],
    queryFn: () => api<{ items: IncidentDTO[] }>('/incidents'),
  });
  const set = (patch: Partial<GrantDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="stack">
      <fieldset>
        <legend>What can they see?</legend>
        <Radio
          name="scope"
          value="actors"
          checked={value.scopeType === 'actors'}
          onChange={() => set({ scopeType: 'actors', coActorVisibility: 'redacted' })}
          label="Events involving particular Actors"
          hint="For example, only your dealings with your landlord."
        />
        <Radio
          name="scope"
          value="incidents"
          checked={value.scopeType === 'incidents'}
          onChange={() => set({ scopeType: 'incidents', coActorVisibility: 'name' })}
          label="Particular Incidents"
          hint="Only the Events grouped in the Incidents you choose."
        />
        <Radio
          name="scope"
          value="all"
          checked={value.scopeType === 'all'}
          onChange={() => set({ scopeType: 'all' })}
          label="All records"
          hint="Everything in your record (within the dates below, if any)."
        />
      </fieldset>
      {value.scopeType === 'actors' ? (
        <fieldset>
          <legend>Actors</legend>
          {fieldError(error, 'actorIds') ? (
            <span className="field-error">{fieldError(error, 'actorIds')}</span>
          ) : null}
          {(actors.data?.items ?? []).map((a) => (
            <Checkbox
              key={a.id}
              label={a.name}
              checked={value.actorIds.includes(a.id)}
              onChange={(c) =>
                set({
                  actorIds: c
                    ? [...value.actorIds, a.id]
                    : value.actorIds.filter((x) => x !== a.id),
                })
              }
            />
          ))}
          {actors.data && !actors.data.items.length ? (
            <p className="muted">You have no Actors yet.</p>
          ) : null}
        </fieldset>
      ) : null}
      {value.scopeType === 'incidents' ? (
        <fieldset>
          <legend>Incidents</legend>
          {fieldError(error, 'incidentIds') ? (
            <span className="field-error">{fieldError(error, 'incidentIds')}</span>
          ) : null}
          {(incidents.data?.items ?? []).map((i) => (
            <Checkbox
              key={i.id}
              label={i.title}
              checked={value.incidentIds.includes(i.id)}
              onChange={(c) =>
                set({
                  incidentIds: c
                    ? [...value.incidentIds, i.id]
                    : value.incidentIds.filter((x) => x !== i.id),
                })
              }
            />
          ))}
          {incidents.data && !incidents.data.items.length ? (
            <p className="muted">You have no Incidents yet.</p>
          ) : null}
        </fieldset>
      ) : null}
      <fieldset>
        <legend>Which dates?</legend>
        <span className="hint">
          Optional. Limit access to Events that happened within these dates, so a Helper on a
          current matter does not see unrelated history.
        </span>
        <div className="row">
          <TextField
            label="From"
            optional
            type="date"
            value={value.dateFrom}
            onChange={(v) => set({ dateFrom: v })}
          />
          <TextField
            label="To"
            optional
            type="date"
            value={value.dateTo}
            onChange={(v) => set({ dateTo: v })}
            error={fieldError(error, 'dateTo')}
          />
        </div>
      </fieldset>
      <fieldset>
        <legend>What can they do?</legend>
        <Checkbox
          label="View"
          checked
          disabled
          onChange={() => undefined}
          hint="Always included."
        />
        <Checkbox
          label="Add"
          checked={value.canAdd}
          onChange={(c) => set({ canAdd: c })}
          hint="Record new Events and attachments within this access. They cannot change or delete your records."
        />
        <Checkbox
          label="Export"
          checked={value.canExport}
          onChange={(c) => set({ canExport: c })}
          hint="Download a copy of what this access covers, including original files."
        />
      </fieldset>
      {value.scopeType !== 'all' ? (
        <fieldset>
          <legend>Other Actors on shared Events</legend>
          <span className="hint">
            An Event can involve Actors outside this access. Seeing their name never gives access to
            their other Events or details.
          </span>
          <Radio
            name="coactor"
            value="redacted"
            checked={value.coActorVisibility === 'redacted'}
            onChange={() => set({ coActorVisibility: 'redacted' })}
            label="Hide them (shown as “another Actor”)"
          />
          <Radio
            name="coactor"
            value="name"
            checked={value.coActorVisibility === 'name'}
            onChange={() => set({ coActorVisibility: 'name' })}
            label="Show their names"
          />
        </fieldset>
      ) : null}
      <TextField
        label="Note for yourself"
        optional
        value={value.note}
        onChange={(v) => set({ note: v })}
      />
    </div>
  );
}

function grantSummary(g: GrantDTO): string {
  const what =
    g.scopeType === 'all'
      ? 'All records'
      : g.scopeType === 'actors'
        ? `Actors: ${g.actors.map((a) => a.name).join(', ')}`
        : `Incidents: ${g.incidents.map((i) => i.title).join(', ')}`;
  const when =
    g.dateFrom || g.dateTo
      ? ` · ${g.dateFrom ? `from ${formatDate(g.dateFrom)}` : ''}${g.dateFrom && g.dateTo ? ' ' : ''}${g.dateTo ? `to ${formatDate(g.dateTo)}` : ''}`
      : '';
  const caps = ['View', g.canAdd ? 'Add' : null, g.canExport ? 'Export' : null]
    .filter(Boolean)
    .join(', ');
  return `${what}${when} · ${caps}`;
}

export function HelpersPage() {
  usePageTitle('Helpers');
  const qc = useQueryClient();
  const toast = useToast();
  const { state } = useAuth();
  const list = useQuery({
    queryKey: ['helpers'],
    queryFn: () => api<{ items: HelperDTO[] }>('/settings/helpers'),
  });
  const [inviting, setInviting] = useState(false);
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [grant, setGrant] = useState<GrantDraft>(emptyGrant);
  const [error, setError] = useState<unknown>(null);
  const [link, setLink] = useState<{ url: string; emailed: boolean } | null>(null);
  const [ending, setEnding] = useState<HelperDTO | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);

  async function invite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ url: string; emailed: boolean }>('/settings/helpers', {
        method: 'POST',
        body: { label, email: email || null, sendEmail, grant: grantToPayload(grant) },
      });
      setLink(r);
      setInviting(false);
      setLabel('');
      setEmail('');
      setGrant(emptyGrant);
      await qc.invalidateQueries({ queryKey: ['helpers'] });
    } catch (err) {
      setError(err);
    }
  }

  return (
    <>
      <PageHeader
        title="Helpers"
        lede="Helpers are people you trust — family, an advocate, a support worker — who can see, and optionally add to, the parts of your record you choose. They are not administrators."
        actions={
          !inviting ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setInviting(true);
                setLink(null);
              }}
            >
              <Icon name="plus" /> Invite a Helper
            </button>
          ) : null
        }
      />
      {link ? (
        <Alert kind="success" title="Invitation created">
          <p>
            {link.emailed
              ? 'We have emailed the invitation. You can also share this link yourself:'
              : 'Send this link to the person you are inviting. It works once and expires after a few days:'}
          </p>
          <p className="mono">{link.url}</p>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => void navigator.clipboard?.writeText(link.url)}
          >
            Copy link
          </button>
          <p className="small">
            For your security this link will not be shown again. You can create a new one at any
            time.
          </p>
        </Alert>
      ) : null}
      {inviting ? (
        <section className="card" aria-labelledby="invite-h">
          <h2 id="invite-h">Invite a Helper</h2>
          <form onSubmit={invite} noValidate className="stack">
            <ErrorSummary error={error} />
            <TextField
              label="Who are they?"
              hint="For example “Sam (support worker)”."
              value={label}
              onChange={setLabel}
              error={fieldError(error, 'label')}
            />
            <TextField
              label="Their email"
              optional
              type="email"
              value={email}
              onChange={setEmail}
              error={fieldError(error, 'email')}
              hint={
                state?.mailConfigured
                  ? undefined
                  : 'Email is not set up on this server, so you will need to send the link yourself.'
              }
            />
            {email && state?.mailConfigured ? (
              <Checkbox
                label="Email the invitation to them"
                checked={sendEmail}
                onChange={setSendEmail}
              />
            ) : null}
            <GrantEditor value={grant} onChange={setGrant} error={error} />
            <div className="row">
              <button className="btn btn-primary" type="submit">
                Create invitation
              </button>
              <button className="btn btn-ghost" type="button" onClick={() => setInviting(false)}>
                Cancel
              </button>
            </div>
          </form>
        </section>
      ) : null}
      {list.isLoading ? <Loading /> : null}
      {list.data && !list.data.items.length && !inviting ? (
        <div className="empty">You have not invited any Helpers.</div>
      ) : null}
      <ul className="plain-list">
        {list.data?.items.map((h) => (
          <li key={h.id} className="card" style={{ marginBottom: '1rem' }}>
            <h2 style={{ marginTop: 0, fontSize: '1.15rem' }}>
              {h.label}{' '}
              {h.status === 'pending' ? (
                <span className="badge">Invitation pending</span>
              ) : h.status === 'ended' ? (
                <span className="badge">Ended</span>
              ) : (
                <span className="badge badge-success">Active</span>
              )}
            </h2>
            {h.helper ? (
              <p className="small muted">
                Account: {h.helper.displayName} ({h.helper.username})
              </p>
            ) : null}
            {h.pendingInvitation ? (
              <p className="small muted">
                Invitation expires {formatDateTime(h.pendingInvitation.expiresAt)}
              </p>
            ) : null}
            <h3>Access</h3>
            <ul>
              {h.grants
                .filter((g) => !g.revokedAt)
                .map((g) => (
                  <li key={g.id}>
                    {grantSummary(g)}
                    {g.scopeType !== 'all' ? (
                      <span className="small muted">
                        {' '}
                        · other Actors {g.coActorVisibility === 'name' ? 'shown by name' : 'hidden'}
                      </span>
                    ) : null}{' '}
                    {h.status !== 'ended' ? (
                      <button
                        type="button"
                        className="link-button small"
                        onClick={async () => {
                          await api(`/settings/grants/${g.id}`, { method: 'DELETE' });
                          await qc.invalidateQueries({ queryKey: ['helpers'] });
                          toast('Access removed');
                        }}
                      >
                        Remove this access
                      </button>
                    ) : null}
                  </li>
                ))}
            </ul>
            {addingTo === h.id ? (
              <AddGrant
                helperId={h.id}
                onDone={async () => {
                  setAddingTo(null);
                  await qc.invalidateQueries({ queryKey: ['helpers'] });
                }}
              />
            ) : null}
            {h.status !== 'ended' ? (
              <div className="row">
                {addingTo !== h.id ? (
                  <button type="button" className="btn btn-small" onClick={() => setAddingTo(h.id)}>
                    Give more access
                  </button>
                ) : null}
                {h.status === 'pending' ? (
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={async () => {
                      const r = await api<{ url: string; emailed: boolean }>(
                        `/settings/helpers/${h.id}/reinvite`,
                        { method: 'POST', body: {} },
                      );
                      setLink(r);
                      await qc.invalidateQueries({ queryKey: ['helpers'] });
                    }}
                  >
                    New invitation link
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-small btn-danger"
                  onClick={() => setEnding(h)}
                >
                  {h.status === 'pending' ? 'Withdraw invitation' : 'End access'}
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={Boolean(ending)}
        title={`End access for ${ending?.label}?`}
        body={
          <p>
            They will immediately stop being able to see your record, and any applications they
            connected to it will be disconnected. Records they added stay in your record.
          </p>
        }
        confirmLabel="End access"
        danger
        onClose={() => setEnding(null)}
        onConfirm={async () => {
          await api(`/settings/helpers/${ending!.id}`, { method: 'DELETE' });
          setEnding(null);
          await qc.invalidateQueries({ queryKey: ['helpers'] });
          toast('Access ended');
        }}
      />
    </>
  );
}

function AddGrant({ helperId, onDone }: { helperId: string; onDone: () => void }) {
  const [grant, setGrant] = useState<GrantDraft>(emptyGrant);
  const [error, setError] = useState<unknown>(null);
  return (
    <form
      noValidate
      className="panel-muted stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api(`/settings/helpers/${helperId}/grants`, {
            method: 'POST',
            body: grantToPayload(grant),
          });
          onDone();
        } catch (err) {
          setError(err);
        }
      }}
    >
      <ErrorSummary error={error} />
      <GrantEditor value={grant} onChange={setGrant} error={error} />
      <div className="row">
        <button className="btn btn-primary" type="submit">
          Add access
        </button>
        <button className="btn btn-ghost" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function SharedWithMePage() {
  usePageTitle('Shared with you');
  const { state, refresh } = useAuth();
  const switchRecord = useSwitchRecord();
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState<{ ownerId: string; ownerName: string } | null>(null);
  return (
    <>
      <PageHeader
        title="Shared with you"
        lede="Records other people have invited you to help with."
      />
      {!state?.sharedRecords?.length ? (
        <div className="empty">No records are shared with you.</div>
      ) : null}
      <ul className="plain-list">
        {state?.sharedRecords?.map((r) => (
          <li key={r.ownerId} className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              <strong>{r.ownerName}</strong>{' '}
              <span className="muted small">— you are “{r.label}”</span>
            </span>
            <span className="row">
              <button
                type="button"
                className="btn btn-small"
                onClick={() => {
                  switchRecord(r.ownerId);
                  navigate('/');
                }}
              >
                Open record
              </button>
              <button
                type="button"
                className="btn btn-small btn-ghost"
                onClick={() => setLeaving(r)}
              >
                Stop helping
              </button>
            </span>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={Boolean(leaving)}
        title={`Stop helping ${leaving?.ownerName}?`}
        body={
          <p>You will no longer be able to see their record. They can invite you again later.</p>
        }
        confirmLabel="Stop helping"
        onClose={() => setLeaving(null)}
        onConfirm={async () => {
          await api(`/settings/shared/${leaving!.ownerId}`, { method: 'DELETE' });
          if (getRecordOwner() === leaving!.ownerId) switchRecord(null);
          setLeaving(null);
          await refresh();
        }}
      />
    </>
  );
}

interface Connection {
  grantId: string;
  clientId: string;
  clientName: string | null;
  clientUri: string | null;
  redirectHost: string | null;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  userName: string;
  authorisedByYou: boolean;
  onYourRecord: boolean;
}

export function ConnectionsPage() {
  usePageTitle('MCP Connections');
  const qc = useQueryClient();
  const toast = useToast();
  const { state } = useAuth();
  const list = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<{ items: Connection[] }>('/settings/connections'),
  });
  const [revoking, setRevoking] = useState<Connection | null>(null);
  const mcpUrl = `${window.location.origin}/mcp`;
  return (
    <>
      <PageHeader
        title="MCP Connections"
        lede="Applications such as AI assistants that you have allowed to use your record through the Model Context Protocol."
      />
      <section className="card" aria-labelledby="connect-h">
        <h2 id="connect-h">Connect an application</h2>
        <p>
          Add this server address in your MCP client (for example as a “custom connector”):{' '}
          <span className="mono">{mcpUrl}</span>
        </p>
        <p className="small muted">
          The application will send you here to sign in and choose exactly what it may do. It never
          receives your password or authenticator codes.
        </p>
      </section>
      {list.isLoading ? <Loading /> : null}
      {list.data && !list.data.items.length ? (
        <div className="empty" style={{ marginTop: '1rem' }}>
          No applications are connected.
        </div>
      ) : null}
      <ul className="plain-list">
        {list.data?.items.map((c) => (
          <li key={c.grantId} className="card" style={{ marginTop: '1rem' }}>
            <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>{c.clientName ?? c.clientId}</h2>
            <p className="small muted">
              Connected {formatDateTime(c.createdAt, state?.user?.timezone)}
              {c.authorisedByYou ? '' : ` by ${c.userName} (a Helper)`} · returns to{' '}
              {c.redirectHost} · last used{' '}
              {c.lastUsedAt ? formatDateTime(c.lastUsedAt, state?.user?.timezone) : 'never'}
              {!c.onYourRecord ? ' · on a record shared with you' : ''}
            </p>
            <h3>Allowed to</h3>
            <ul>
              {c.scopes.map((s) => (
                <li key={s}>{SCOPE_DESCRIPTIONS[s as OAuthScope]?.label ?? s}</li>
              ))}
            </ul>
            <button
              type="button"
              className="btn btn-danger btn-small"
              onClick={() => setRevoking(c)}
            >
              Disconnect
            </button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={Boolean(revoking)}
        title={`Disconnect ${revoking?.clientName ?? 'this application'}?`}
        body={
          <p>It will immediately lose access. To use it again you will need to connect it again.</p>
        }
        confirmLabel="Disconnect"
        danger
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          await api(`/settings/connections/${revoking!.grantId}`, { method: 'DELETE' });
          setRevoking(null);
          await qc.invalidateQueries({ queryKey: ['connections'] });
          toast('Application disconnected');
        }}
      />
    </>
  );
}

interface StorageInfo {
  usage: {
    files: number;
    bytes: number;
    deleted_files: number;
    ocr_done: number;
    ocr_pending: number;
    ocr_failed: number;
    integrity_failures: number;
  };
  timestamps: { complete: number; pending: number; failed: number };
  settings: {
    bucket: string;
    endpointHost: string;
    region: string;
    maxUploadMb: number;
    retentionDays: number;
    ocrEnabled: boolean;
    ocrLanguages: string;
    timestampProvider: string;
  };
}

interface Trash {
  events: (EventSummaryDTO & { purgeAfter: string | null })[];
  incidents: IncidentDTO[];
  attachments: { id: string; filename: string; deletedAt: string; purgeAfter: string | null }[];
  actors: { id: string; name: string; deletedAt: string; purgeAfter: string | null }[];
}

export function StoragePage() {
  usePageTitle('Storage and trash');
  const qc = useQueryClient();
  const toast = useToast();
  const info = useQuery({
    queryKey: ['storage'],
    queryFn: () => api<StorageInfo>('/settings/storage'),
  });
  const trash = useQuery({ queryKey: ['trash'], queryFn: () => api<Trash>('/trash') });
  const restore = async (path: string, what: string) => {
    await api(path, { method: 'POST' });
    await qc.invalidateQueries();
    toast(`${what} restored`);
  };
  const s = info.data;
  return (
    <>
      <PageHeader title="Storage and trash" />
      {s ? (
        <div className="grid-2">
          <section className="card">
            <h2>Your files</h2>
            <dl className="details">
              <dt>Files</dt>
              <dd>
                {s.usage.files} ({bytes(Number(s.usage.bytes))})
              </dd>
              <dt>Text read</dt>
              <dd>
                {s.usage.ocr_done} done, {s.usage.ocr_pending} waiting, {s.usage.ocr_failed} not
                readable
              </dd>
              <dt>Integrity</dt>
              <dd>
                {s.usage.integrity_failures ? (
                  <StatusLine>{s.usage.integrity_failures} file(s) failed a check</StatusLine>
                ) : (
                  <StatusLine ok>No problems found</StatusLine>
                )}
              </dd>
              <dt>Timestamps</dt>
              <dd>
                {s.settings.timestampProvider === 'none'
                  ? 'Not enabled on this server'
                  : `${s.timestamps.complete} verified, ${s.timestamps.pending} pending`}
              </dd>
            </dl>
          </section>
          <section className="card">
            <h2>Server storage settings</h2>
            <dl className="details">
              <dt>Storage</dt>
              <dd>
                {s.settings.endpointHost} / {s.settings.bucket}
              </dd>
              <dt>Largest file</dt>
              <dd>{s.settings.maxUploadMb} MB</dd>
              <dt>Trash kept for</dt>
              <dd>{s.settings.retentionDays} days</dd>
              <dt>Text recognition</dt>
              <dd>{s.settings.ocrEnabled ? `On (${s.settings.ocrLanguages})` : 'Off'}</dd>
            </dl>
          </section>
        </div>
      ) : (
        <Loading />
      )}
      <h2>Trash</h2>
      <p className="muted">
        Deleted items are kept for {s?.settings.retentionDays ?? 30} days and then permanently
        removed. Restore anything deleted by mistake.
      </p>
      {trash.data ? (
        trash.data.events.length +
          trash.data.incidents.length +
          trash.data.attachments.length +
          trash.data.actors.length ===
        0 ? (
          <div className="empty">The trash is empty.</div>
        ) : (
          <ul className="plain-list">
            {trash.data.events.map((e) => (
              <li key={e.id} className="row" style={{ justifyContent: 'space-between' }}>
                <span>
                  Event: {e.displayTitle}{' '}
                  <span className="small muted">
                    — removed permanently {e.purgeAfter ? formatDate(e.purgeAfter) : 'later'}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => restore(`/events/${e.id}/restore`, 'Event')}
                >
                  Restore<span className="visually-hidden"> {e.displayTitle}</span>
                </button>
              </li>
            ))}
            {trash.data.incidents.map((i) => (
              <li key={i.id} className="row" style={{ justifyContent: 'space-between' }}>
                <span>Incident: {i.title}</span>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => restore(`/incidents/${i.id}/restore`, 'Incident')}
                >
                  Restore<span className="visually-hidden"> {i.title}</span>
                </button>
              </li>
            ))}
            {trash.data.attachments.map((a) => (
              <li key={a.id} className="row" style={{ justifyContent: 'space-between' }}>
                <span>
                  Attachment: {a.filename}{' '}
                  <span className="small muted">
                    — removed permanently {a.purgeAfter ? formatDate(a.purgeAfter) : 'later'}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => restore(`/attachments/${a.id}/restore`, 'Attachment')}
                >
                  Restore<span className="visually-hidden"> {a.filename}</span>
                </button>
              </li>
            ))}
            {trash.data.actors.map((a) => (
              <li key={a.id} className="row" style={{ justifyContent: 'space-between' }}>
                <span>Actor: {a.name}</span>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => restore(`/actors/${a.id}/restore`, 'Actor')}
                >
                  Restore<span className="visually-hidden"> {a.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <Loading />
      )}
    </>
  );
}

export function ExportPage() {
  usePageTitle('Export your data');
  const record = useRecord();
  const allowed = record.data?.capabilities.export;
  return (
    <>
      <PageHeader
        title="Export your data"
        lede="Your record belongs to you. Download a complete copy at any time."
      />
      <section className="card">
        <p>The export is a ZIP file containing:</p>
        <ul>
          <li>your Events, Actors, Incidents and relationships as JSON files</li>
          <li>every original attachment, exactly as uploaded</li>
          <li>the text read from each document</li>
          <li>SHA-256 hashes, revision history and timestamp proofs</li>
          <li>a README explaining the files, and a readable timeline</li>
        </ul>
        <p className="small muted">No OpenRampart software is needed to read it.</p>
        {record.data?.role === 'helper' ? (
          <Alert kind="info">
            This export contains only what {record.data.ownerName} has shared with you for export.
          </Alert>
        ) : null}
        {allowed ? (
          <a className="btn btn-primary" href={apiUrl('/export')} download>
            <Icon name="download" /> Download export
          </a>
        ) : (
          <Alert kind="warning">Your access to this record does not include exporting.</Alert>
        )}
      </section>
    </>
  );
}

interface SystemInfo {
  settings: { registrationMode: 'first-user' | 'open' | 'closed' };
  environment: Record<string, string | boolean>;
  tools: Record<string, string | null>;
  counts: { users: number; events: number; attachments: number };
}

interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  isAdmin: boolean;
  totpEnabledAt: string | null;
  lastLoginAt: string | null;
  disabledAt: string | null;
}

export function SystemPage() {
  usePageTitle('System settings');
  const qc = useQueryClient();
  const toast = useToast();
  const { state } = useAuth();
  const sys = useQuery({
    queryKey: ['system'],
    queryFn: () => api<SystemInfo>('/settings/admin/system'),
  });
  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api<{ items: AdminUser[] }>('/settings/admin/users'),
  });
  const types = useQuery({
    queryKey: ['event-types'],
    queryFn: () =>
      api<{
        items: { id: string; key: string; label: string; isBuiltin: boolean; archived: boolean }[];
      }>('/event-types'),
  });
  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [testTo, setTestTo] = useState(state?.user?.email ?? '');
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<{ user: AdminUser; action: string; label: string } | null>(
    null,
  );
  if (!state?.user?.isAdmin) return <Alert kind="warning">Administrators only.</Alert>;
  return (
    <>
      <PageHeader title="System settings" />
      <ErrorSummary error={error} />
      {sys.data ? (
        <div className="grid-2">
          <section className="card">
            <h2>Registration</h2>
            <SelectField
              label="Who can create accounts?"
              value={sys.data.settings.registrationMode}
              onChange={async (v) => {
                await api('/settings/admin/settings', {
                  method: 'PATCH',
                  body: { registrationMode: v },
                });
                await qc.invalidateQueries({ queryKey: ['system'] });
                toast('Registration setting saved');
              }}
              options={[
                { value: 'first-user', label: 'Only the first account (then invitations only)' },
                { value: 'closed', label: 'Invitations only' },
                { value: 'open', label: 'Anyone who can reach this server' },
              ]}
            />
          </section>
          <section className="card">
            <h2>Server</h2>
            <dl className="details">
              {Object.entries(sys.data.environment).map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd className="small">{String(v)}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="card">
            <h2>Document tools</h2>
            <ul className="plain-list">
              {Object.entries(sys.data.tools).map(([k, v]) => (
                <li key={k}>
                  {v ? (
                    <StatusLine ok>
                      {k} {v}
                    </StatusLine>
                  ) : (
                    <StatusLine>{k} not found</StatusLine>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section className="card">
            <h2>Email</h2>
            <form
              noValidate
              onSubmit={async (e) => {
                e.preventDefault();
                setError(null);
                try {
                  await api('/settings/admin/test-email', { method: 'POST', body: { to: testTo } });
                  toast('Test email sent');
                } catch (err) {
                  setError(err);
                }
              }}
            >
              <TextField
                label="Send a test email to"
                type="email"
                value={testTo}
                onChange={setTestTo}
              />
              <button className="btn" type="submit">
                Send test email
              </button>
            </form>
          </section>
        </div>
      ) : (
        <Loading />
      )}
      <h2>Accounts</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Two-step</th>
              <th scope="col">Last sign-in</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.data?.items.map((u) => (
              <tr key={u.id}>
                <th scope="row">
                  {u.displayName} <span className="muted small">({u.username})</span>{' '}
                  {u.isAdmin ? <span className="badge">Administrator</span> : null}
                </th>
                <td>{u.totpEnabledAt ? 'Set up' : 'Not set up'}</td>
                <td>{formatDateTime(u.lastLoginAt)}</td>
                <td>{u.disabledAt ? 'Disabled' : 'Active'}</td>
                <td>
                  {u.id !== state.user!.id ? (
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() =>
                          setConfirm({
                            user: u,
                            action: u.disabledAt ? 'enable' : 'disable',
                            label: u.disabledAt ? 'Enable account' : 'Disable account',
                          })
                        }
                      >
                        {u.disabledAt ? 'Enable' : 'Disable'}
                      </button>
                      {u.totpEnabledAt ? (
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() =>
                            setConfirm({
                              user: u,
                              action: 'reset-totp',
                              label: 'Reset two-step sign-in',
                            })
                          }
                        >
                          Reset two-step
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() =>
                          setConfirm({
                            user: u,
                            action: u.isAdmin ? 'remove-admin' : 'make-admin',
                            label: u.isAdmin ? 'Remove administrator' : 'Make administrator',
                          })
                        }
                      >
                        {u.isAdmin ? 'Remove admin' : 'Make admin'}
                      </button>
                    </div>
                  ) : (
                    <span className="muted small">You</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Administrators manage the server. They cannot see other people’s records through the
        interface.
      </p>
      <h2>Event types</h2>
      <ul className="plain-list">
        {types.data?.items.map((t) => (
          <li key={t.id} className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              {t.label} <span className="mono muted">{t.key}</span>{' '}
              {t.archived ? <span className="badge">Archived</span> : null}
            </span>
            <button
              type="button"
              className="btn btn-small"
              onClick={async () => {
                await api(`/settings/admin/event-types/${t.id}`, {
                  method: 'PATCH',
                  body: { archived: !t.archived },
                });
                await qc.invalidateQueries({ queryKey: ['event-types'] });
              }}
            >
              {t.archived ? 'Restore' : 'Archive'}
              <span className="visually-hidden"> {t.label}</span>
            </button>
          </li>
        ))}
      </ul>
      <form
        noValidate
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await api('/settings/admin/event-types', {
              method: 'POST',
              body: { key: newKey, label: newLabel },
            });
            setNewKey('');
            setNewLabel('');
            await qc.invalidateQueries({ queryKey: ['event-types'] });
            toast('Event type added');
          } catch (err) {
            setError(err);
          }
        }}
      >
        <h3 style={{ marginTop: 0 }}>Add an Event type</h3>
        <TextField
          label="Label"
          value={newLabel}
          onChange={setNewLabel}
          hint="For example “Court hearing”."
        />
        <TextField
          label="Key"
          value={newKey}
          onChange={(v) => setNewKey(v.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
          hint="Lower-case identifier used in exports and MCP, e.g. court_hearing."
        />
        <button className="btn" type="submit">
          Add type
        </button>
      </form>
      <ConfirmDialog
        open={Boolean(confirm)}
        title={`${confirm?.label}?`}
        body={
          <p>
            This affects {confirm?.user.displayName}’s account and is recorded in the Audit Log.
          </p>
        }
        confirmLabel={confirm?.label ?? 'Confirm'}
        danger={confirm?.action === 'disable' || confirm?.action === 'reset-totp'}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await api(`/settings/admin/users/${confirm!.user.id}/${confirm!.action}`, {
            method: 'POST',
          });
          setConfirm(null);
          await qc.invalidateQueries({ queryKey: ['admin-users'] });
        }}
      />
    </>
  );
}
