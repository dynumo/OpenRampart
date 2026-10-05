import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { api, getRecordOwner, setCsrfToken, setRecordOwner } from './api';

export interface AuthState {
  registration: { open: boolean; firstUser: boolean };
  mailConfigured: boolean;
  requireTotp: boolean;
  maxUploadMb: number;
  stage: null | 'mfa' | 'totp_setup' | 'active';
  csrfToken?: string;
  user?: {
    id: string;
    username: string;
    email: string | null;
    displayName: string;
    isAdmin: boolean;
    timezone: string;
    totpEnabled: boolean;
    lastLoginAt: string | null;
    previousLoginAt: string | null;
    previousLoginIp: string | null;
  };
  sharedRecords?: { ownerId: string; ownerName: string; relationshipId: string; label: string }[];
  recoveryCodesRemaining?: number | null;
}

export interface RecordInfo {
  ownerId: string;
  ownerName: string;
  timezone: string;
  role: 'owner' | 'helper';
  capabilities: { add: boolean; export: boolean; organise: boolean };
  grants: {
    scopeType: string;
    dateFrom: string | null;
    dateTo: string | null;
    canAdd: boolean;
    canExport: boolean;
  }[];
  counts: { events: number; incidents: number; open_incidents: number };
}

const AuthContext = createContext<{
  state: AuthState | undefined;
  refresh: () => Promise<unknown>;
}>({ state: undefined, refresh: async () => undefined });

export function AuthProvider({ children }: { children: ReactNode }) {
  const q = useQuery({
    queryKey: ['auth'],
    queryFn: () => api<AuthState>('/auth/state'),
    staleTime: 60_000,
  });
  useEffect(() => {
    setCsrfToken(q.data?.csrfToken);
    // Drop a stale record selection the user no longer has access to.
    const selected = getRecordOwner();
    if (
      q.data?.stage === 'active' &&
      selected &&
      !q.data.sharedRecords?.some((r) => r.ownerId === selected)
    )
      setRecordOwner(null);
  }, [q.data]);
  return (
    <AuthContext.Provider value={{ state: q.data, refresh: () => q.refetch() }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

export function useRecord() {
  const { state } = useAuth();
  return useQuery({
    queryKey: ['record', getRecordOwner()],
    queryFn: () => api<RecordInfo>('/record'),
    enabled: state?.stage === 'active',
    staleTime: 30_000,
  });
}

export function useSwitchRecord() {
  const qc = useQueryClient();
  return (ownerId: string | null) => {
    setRecordOwner(ownerId);
    qc.clear();
  };
}
