import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toasts';
import { Loading } from './components/ui';
import { ApiError } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import {
  ActorDetailPage,
  ActorsPage,
  EditActorPage,
  MergeActorsPage,
  NewActorPage,
} from './pages/Actors';
import { AddEventPage, CaptureLetterPage, EditEventPage, NewEventPage } from './pages/AddEvent';
import {
  InvitationPage,
  LoginPage,
  RegisterPage,
  ResetPasswordPage,
  SetupAuthenticatorPage,
} from './pages/Auth';
import { EventDetailPage } from './pages/EventDetail';
import {
  EditIncidentPage,
  IncidentDetailPage,
  IncidentsPage,
  NewIncidentPage,
} from './pages/Incidents';
import { SearchPage } from './pages/Search';
import { TimelinePage } from './pages/Timeline';

// Less frequently used screens load on demand to keep the capture path light.
const settings = () => import('./pages/Settings');
const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));
const AccountSettingsPage = page(settings, 'AccountSettingsPage');
const AuditLogPage = page(settings, 'AuditLogPage');
const ConnectionsPage = page(settings, 'ConnectionsPage');
const ExportPage = page(settings, 'ExportPage');
const HelpersPage = page(settings, 'HelpersPage');
const SecuritySettingsPage = page(settings, 'SecuritySettingsPage');
const SettingsIndexPage = page(settings, 'SettingsIndexPage');
const SharedWithMePage = page(settings, 'SharedWithMePage');
const StoragePage = page(settings, 'StoragePage');
const SystemPage = page(settings, 'SystemPage');
const AttachmentViewPage = page(() => import('./pages/AttachmentView'), 'AttachmentViewPage');
const ConsentPage = page(() => import('./pages/Consent'), 'ConsentPage');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) =>
        !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

/** Redirect to sign-in or enrolment until the session is fully active. */
function RequireSession({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (!state) return <Loading />;
  const returnTo = encodeURIComponent(location.pathname + location.search);
  if (state.stage === 'totp_setup')
    return <Navigate to={`/setup/authenticator?returnTo=${returnTo}`} replace />;
  if (state.stage !== 'active') return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
  return <>{children}</>;
}

function NotFound() {
  useEffect(() => {
    document.title = 'Not found — OpenRampart';
  }, []);
  return (
    <>
      <h1>Page not found</h1>
      <p>This page does not exist, or you do not have access to it.</p>
    </>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <BrowserRouter>
            <Suspense fallback={<Loading />}>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/setup/authenticator" element={<SetupAuthenticatorPage />} />
                <Route path="/reset-password" element={<ResetPasswordPage />} />
                <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
                <Route path="/invite/:token" element={<InvitationPage />} />
                <Route path="/oauth/interaction/:uid" element={<ConsentPage />} />
                <Route
                  element={
                    <RequireSession>
                      <Layout />
                    </RequireSession>
                  }
                >
                  <Route index element={<TimelinePage />} />
                  <Route path="events/new" element={<AddEventPage />} />
                  <Route path="events/new/letter" element={<CaptureLetterPage />} />
                  <Route path="events/new/:typeKey" element={<NewEventPage />} />
                  <Route path="events/:id" element={<EventDetailPage />} />
                  <Route path="events/:id/edit" element={<EditEventPage />} />
                  <Route path="attachments/:id" element={<AttachmentViewPage />} />
                  <Route path="incidents" element={<IncidentsPage />} />
                  <Route path="incidents/new" element={<NewIncidentPage />} />
                  <Route path="incidents/:id" element={<IncidentDetailPage />} />
                  <Route path="incidents/:id/edit" element={<EditIncidentPage />} />
                  <Route path="actors" element={<ActorsPage />} />
                  <Route path="actors/new" element={<NewActorPage />} />
                  <Route path="actors/merge" element={<MergeActorsPage />} />
                  <Route path="actors/:id" element={<ActorDetailPage />} />
                  <Route path="actors/:id/edit" element={<EditActorPage />} />
                  <Route path="search" element={<SearchPage />} />
                  <Route path="settings" element={<SettingsIndexPage />} />
                  <Route path="settings/account" element={<AccountSettingsPage />} />
                  <Route path="settings/security" element={<SecuritySettingsPage />} />
                  <Route path="settings/security/audit" element={<AuditLogPage />} />
                  <Route path="settings/helpers" element={<HelpersPage />} />
                  <Route path="settings/shared" element={<SharedWithMePage />} />
                  <Route path="settings/connections" element={<ConnectionsPage />} />
                  <Route path="settings/storage" element={<StoragePage />} />
                  <Route path="settings/export" element={<ExportPage />} />
                  <Route path="settings/system" element={<SystemPage />} />
                  <Route path="*" element={<NotFound />} />
                </Route>
              </Routes>
            </Suspense>
          </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
