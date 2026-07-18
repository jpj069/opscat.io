// Users — admin user management: invite, edit, activate/deactivate, reset password.
import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useApp } from '../state';
import { alpha, initials, relTime } from '../format';
import { Avatar, GlowDot, Modal, Field } from '../ui';
import type { UserRow } from '../types';

const ROLES = ['admin', 'cto', 'lead', 'analyst'];
const ROLE_COLOR: Record<string, string> = {
  admin: '#f85149', cto: '#38b6ff', lead: '#bc8cff', analyst: '#388bfd',
};
const roleColor = (r: string) => ROLE_COLOR[r] || '#8b949e';
const GRID = '260px 220px 90px 90px 110px 170px';

interface Secret { title: string; hint: string; password: string; }

export default function Users() {
  const app = useApp();
  const isAdmin = app.user?.role === 'admin';
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState<UserRow | null>(null);
  const [invite, setInvite] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);

  const load = () => {
    api.get<UserRow[]>('/api/admin/users').then(setUsers)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'failed to load users'));
  };
  useEffect(load, []);

  const setActive = async (u: UserRow, active: boolean) => {
    try { await api.patch(`/api/admin/users/${u.id}`, { active }); load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'update failed'); }
  };
  const reset = async (u: UserRow) => {
    try {
      const r = await api.patch<{ initialPassword: string }>(`/api/admin/users/${u.id}`, { resetPassword: true });
      setSecret({
        title: `Password reset — ${u.name}`,
        hint: 'Shown only once. Give it to the user — it must be changed at first login.',
        password: r.initialPassword,
      });
      load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'reset failed'); }
  };

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 className="page-title">Users</h1>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setInvite(true)}>+ Invite user</button>
        )}
      </div>

      {err && <div className="card" style={{ color: '#f85149', fontSize: 12 }}>{err}</div>}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="tbl-head" style={{ gridTemplateColumns: GRID }}>
          <span>User</span><span>Email</span><span>Role</span>
          <span>Status</span><span>Last seen</span><span>Actions</span>
        </div>

        {users === null && (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}
            className="mono">loading…</div>
        )}
        {users !== null && users.length === 0 && (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
            No users yet.
          </div>
        )}

        {users?.map((u) => (
          <div key={u.id} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8,
            padding: 'var(--row-py) 16px', borderBottom: '1px solid var(--bg3)', alignItems: 'center',
            opacity: u.active ? 1 : 0.5 }}>
            {/* user */}
            <span className="row" style={{ gap: 8, minWidth: 0 }}>
              <Avatar i={initials(u.name)} c={u.color || roleColor(u.role)} size={28} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text0)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</span>
                <span className="mono" style={{ fontSize: 9, color: 'var(--text3)' }}>ID #{u.id}</span>
              </span>
            </span>
            {/* email */}
            <span className="mono" style={{ fontSize: 11, color: 'var(--text1)', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</span>
            {/* role pill */}
            <span className="pill" style={{ color: roleColor(u.role), fontSize: 10,
              background: alpha(roleColor(u.role), 0.12), border: `1px solid ${alpha(roleColor(u.role), 0.3)}` }}>
              {u.role}
            </span>
            {/* status */}
            <span className="row" style={{ gap: 5 }}>
              <GlowDot color={u.active ? '#3fb950' : '#8b949e'} />
              <span style={{ fontSize: 11 }}>{u.active ? 'Active' : 'Inactive'}</span>
            </span>
            {/* last seen */}
            <span className="mono" style={{ fontSize: 10, color: 'var(--text2)' }}>{relTime(u.lastSeenAt)}</span>
            {/* actions */}
            <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {isAdmin ? (
                <>
                  <button className="btn btn-sm" onClick={() => setEdit(u)}>Edit</button>
                  {u.id !== app.user?.id && (
                    u.active
                      ? <button className="btn btn-sm" style={{ color: '#f85149' }}
                          onClick={() => setActive(u, false)}>Deactivate</button>
                      : <button className="btn btn-sm" style={{ color: '#3fb950' }}
                          onClick={() => setActive(u, true)}>Activate</button>
                  )}
                  <button className="btn btn-sm" onClick={() => reset(u)}>Reset password</button>
                </>
              ) : <span style={{ fontSize: 10, color: 'var(--text3)' }}>view only</span>}
            </span>
          </div>
        ))}
      </div>

      {edit && <EditModal user={edit} onClose={() => setEdit(null)} onSaved={load} />}
      {invite && <InviteModal onClose={() => setInvite(false)} onSaved={load} onSecret={setSecret} />}
      {secret && <SecretModal {...secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- edit

function EditModal({ user, onClose, onSaved }:
  { user: UserRow; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState(user.role);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api.patch(`/api/admin/users/${user.id}`, { name, role }); onSaved(); onClose(); }
    catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'error'); setBusy(false); }
  };
  return (
    <Modal title={`Edit ${user.name}`} onClose={onClose}>
      <form onSubmit={save}>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
        {err && <div style={{ color: '#f85149', fontSize: 11, marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy}>{busy ? '…' : 'Save'}</button>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- invite

function InviteModal({ onClose, onSaved, onSecret }:
  { onClose: () => void; onSaved: () => void; onSecret: (s: Secret) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('analyst');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api.post<{ initialPassword: string }>('/api/admin/users', { email, name, role });
      onSecret({
        title: 'User invited',
        hint: 'Give this to the user — it must be changed at first login.',
        password: r.initialPassword,
      });
      onSaved(); onClose();
    } catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'error'); setBusy(false); }
  };
  return (
    <Modal title="Invite user" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="E-Mail">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com" />
        </Field>
        <Field label="Name">
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
        </Field>
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
        {err && <div style={{ color: '#f85149', fontSize: 11, marginBottom: 8 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy}>{busy ? '…' : 'Create user'}</button>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- one-time secret

function SecretModal({ title, hint, password, onClose }: Secret & { onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 10 }}>{hint}</div>
      <div className="mono" style={{ fontSize: 14, fontWeight: 600, color: 'var(--text0)',
        background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6,
        padding: '10px 12px', userSelect: 'all', wordBreak: 'break-all' }}>{password}</div>
      <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
        onClick={onClose}>Done</button>
    </Modal>
  );
}
