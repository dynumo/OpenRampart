import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { api, getRecordOwner } from '../lib/api';
import { useAuth, useRecord, useSwitchRecord } from '../lib/auth';
import { useFocusMainOnNavigate } from '../lib/hooks';
import { Icon, Logo } from './Icon';

const NAV = [
  { to: '/', label: 'Timeline', icon: 'timeline', end: true },
  { to: '/incidents', label: 'Incidents', icon: 'incident' },
  { to: '/actors', label: 'Actors', icon: 'actors' },
  { to: '/search', label: 'Search', icon: 'search' },
];

export function Layout() {
  const { state } = useAuth();
  const record = useRecord();
  const switchRecord = useSwitchRecord();
  const navigate = useNavigate();
  const qc = useQueryClient();
  useFocusMainOnNavigate();
  const helperView = record.data?.role === 'helper';
  const canAdd = record.data?.capabilities.add ?? true;

  async function signOut() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    qc.clear();
    navigate('/login');
    window.location.reload();
  }

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="app-header">
        <div className="app-header__inner">
          <Link to="/" className="brand">
            <Logo />
            <span>OpenRampart</span>
          </Link>
          <nav className="primary-nav" aria-label="Main">
            <ul>
              {NAV.map((n) => (
                <li key={n.to}>
                  <NavLink to={n.to} end={n.end}>
                    {n.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <div className="header-actions">
            {canAdd ? (
              <Link to="/events/new" className="btn btn-primary add-event-header">
                <Icon name="plus" />
                Add Event
              </Link>
            ) : null}
            {state?.sharedRecords?.length ? (
              <RecordSwitcher
                current={getRecordOwner()}
                ownName={state.user?.displayName ?? 'My record'}
                shared={state.sharedRecords}
                onChange={(id) => {
                  switchRecord(id);
                  navigate('/');
                }}
              />
            ) : null}
            <Link to="/settings" className="btn btn-ghost btn-small">
              <Icon name="settings" />
              Settings
            </Link>
            <button type="button" className="btn btn-ghost btn-small" onClick={signOut}>
              <Icon name="logout" />
              Sign out
            </button>
          </div>
        </div>
      </header>
      {helperView ? (
        <div className="record-banner" role="note">
          <div className="record-banner__inner">
            You are helping with <strong>{record.data?.ownerName}</strong>’s record. You can see only what they have shared with you
            {record.data?.capabilities.add ? ', and add to it' : ''}.
          </div>
        </div>
      ) : null}
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
      <nav className="bottom-nav" aria-label="Main (mobile)">
        <ul>
          {NAV.slice(0, 2).map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} end={n.end}>
                <Icon name={n.icon} />
                {n.label}
              </NavLink>
            </li>
          ))}
          <li>
            {canAdd ? (
              <NavLink to="/events/new" className="bottom-nav__add" aria-label="Add Event">
                <Icon name="plus" />
              </NavLink>
            ) : (
              <span />
            )}
          </li>
          {NAV.slice(2).map((n) => (
            <li key={n.to}>
              <NavLink to={n.to}>
                <Icon name={n.icon} />
                {n.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

function RecordSwitcher(props: { current: string | null; ownName: string; shared: { ownerId: string; ownerName: string }[]; onChange: (id: string | null) => void }) {
  return (
    <label className="row small">
      <span>Record</span>
      <select value={props.current ?? ''} onChange={(e) => props.onChange(e.target.value || null)} style={{ width: 'auto', minWidth: '10rem' }}>
        <option value="">{props.ownName} (yours)</option>
        {props.shared.map((s) => (
          <option key={s.ownerId} value={s.ownerId}>
            {s.ownerName}
          </option>
        ))}
      </select>
    </label>
  );
}

export function PageHeader({ title, lede, actions }: { title: string; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}
