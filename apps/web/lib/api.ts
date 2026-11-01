export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const BASE = `${API}/api/v1`;

export type Role = 'admin' | 'operator' | 'viewer';
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export class ApiFail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// The access token lives in memory only. The refresh token is kept in sessionStorage so a page reload keeps you signed in
// for the tab. (For production, move the refresh token to an httpOnly cookie.)
let accessToken: string | null = null;
const KEY = 'gw_refresh';
const store = {
  get: () => {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      if (v) sessionStorage.setItem(KEY, v);
      else sessionStorage.removeItem(KEY);
    } catch {
      /* storage can be blocked: the app still works for this page load */
    }
  },
};

export const getAccessToken = () => accessToken;

async function request<T>(path: string, init: RequestInit = {}, token = accessToken): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiFail(res.status, body?.error?.code ?? 'ERROR', body?.error?.message ?? `Request failed (${res.status})`);
  return body as T;
}

async function refresh(): Promise<boolean> {
  const rt = store.get();
  if (!rt) return false;
  try {
    accessToken = (await request<{ accessToken: string }>('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: rt }) }, null)).accessToken;
    return true;
  } catch {
    accessToken = null;
    store.set(null);
    return false;
  }
}

/** Authenticated call. On a 401 it refreshes the token once and retries. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  try {
    return await request<T>(path, init);
  } catch (e) {
    if (e instanceof ApiFail && e.status === 401 && (await refresh())) return request<T>(path, init);
    throw e;
  }
}

export async function login(email: string, password: string): Promise<User> {
  const r = await request<{ accessToken: string; refreshToken: string; user: User }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }, null);
  accessToken = r.accessToken;
  store.set(r.refreshToken);
  return r.user;
}

/** Called on page load: resume the session from the refresh token, if there is one. */
export async function restoreSession(): Promise<User | null> {
  if (!(await refresh())) return null;
  try {
    return (await request<{ user: User }>('/auth/me')).user;
  } catch {
    return null;
  }
}

export function logout() {
  accessToken = null;
  store.set(null);
}
