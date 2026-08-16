// Users — admin user management: invite, edit, activate/deactivate, reset password.
import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useApp } from '../state';
import { alpha, initials, relTime } from '../format';
import { Card, Button, Avatar, GlowDot, Modal, Field, TableScroll, TableSkeleton, PageHeader, Input, COL} from '../ui';
import { Select } from '../Select';
import type { UserRow } from '../types';
import { PlusIcon } from 'lucide-react';

const ROLES = ['admin', 'cto', 'lead', 'analyst'];
const ROLE_COLOR: Record<string, string> = {
  admin: '#f85149', cto: '#38b6ff', lead: '#bc8cff', analyst: '#388bfd',
};
const roleColor = (r: string) => ROLE_COLOR[r] || '#8b949e';
// User | Email | Role | Status | Last seen | Actions. Every track was fixed, so the
// table simply stopped at 940px and left the rest of a wide window empty.
const GRID = [COL.text, COL.textWide, COL.label, COL.status, COL.age, COL.actions].join(' ');

// Two possible outcomes of an invite or a reset, and the UI has to say WHICH.
// With a mail transport the colleague gets an activation link and no secret ever
// exists; without one the admin has to hand a password over, and then the dialog
// should say so instead of pretending an invitation went out.
interface Secret { title: string; hint: string; password?: string; sentTo?: string; }
// what the server answers for both routes
interface InviteResult { initialPassword?: string; invited?: boolean; email?: string; mailFailed?: boolean; }

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
      const r = await api.patch<InviteResult>(`/api/admin/users/${u.id}`, { resetPassword: true });
      const what = u.pending ? 'Invitation resent' : `Password reset — ${u.name}`;
      setSecret(r.invited
        ? { title: what,
            hint: u.pending
              ? 'A fresh activation link is on its way. The previous one no longer works.'
              : 'They can set a new password from the link. The old one no longer works and '
                + 'every session has been signed out.',
            sentTo: r.email }
        : { title: what,
            hint: r.mailFailed
              ? 'The reset mail could not be delivered, so here is a one-time password instead. '
                + 'Hand it over securely — it must be changed at first sign-in.'
              : 'No mail transport is configured, so here is a one-time password. Hand it over '
                + 'securely — it must be changed at first sign-in.',
            password: r.initialPassword });
      load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'reset failed'); }
  };

  return (
    <div className="page">
      <PageHeader title="Users">
        {isAdmin && (
          <Button variant="primary" onClick={() => setInvite(true)}><PlusIcon size={13} /> Invite user</Button>
        )}
      </PageHeader>

      {err && <Card className="text-base" style={{ color: '#f85149'}}>{err}</Card>}

      <Card style={{ padding: 0 }}>
        <TableScroll stickyFirst minWidth={960}>
        <div className="tbl-head" style={{ gridTemplateColumns: GRID }}>
          <span>User</span><span>Email</span><span>Role</span>
          <span>Status</span><span>Last seen</span><span>Actions</span>
        </div>

        {users === null && <TableSkeleton cols={GRID} rows={5} />}
        {users !== null && users.length === 0 && (
          <div className="text-text3 text-base" style={{ padding: 30, textAlign: 'center'}}>
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
                <span className="text-base font-semibold text-text0" style={{ display: 'block',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</span>
                <span className="mono text-2xs text-text3">ID #{u.id}</span>
              </span>
            </span>
            {/* email */}
            <span className="mono text-sm text-text1" style={{ overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</span>
            {/* role pill */}
            <span className="pill text-xs" style={{ color: roleColor(u.role),
              background: alpha(roleColor(u.role), 0.12), border: `1px solid ${alpha(roleColor(u.role), 0.3)}` }}>
              {u.role}
            </span>
            {/* status — "Invited" is its own state: the account exists but nobody
                has opened the activation link yet, which is invisible otherwise */}
            <span className="row" style={{ gap: 5 }}>
              <GlowDot color={!u.active ? '#8b949e' : u.pending ? '#e3b341' : '#3fb950'} />
              <span className="text-sm">{!u.active ? 'Inactive' : u.pending ? 'Invited' : 'Active'}</span>
            </span>
            {/* last seen */}
            <span className="mono text-xs text-text2">{relTime(u.lastSeenAt)}</span>
            {/* actions */}
            <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {isAdmin ? (
                <>
                  <Button size="sm" onClick={() => setEdit(u)}>Edit</Button>
                  {u.id !== app.user?.id && (
                    u.active
                      ? <Button size="sm" variant="danger"
 onClick={() => setActive(u, false)}>Deactivate</Button>
                      : <Button size="sm" style={{ color: '#3fb950' }}
 onClick={() => setActive(u, true)}>Activate</Button>
                  )}
                  <Button size="sm" onClick={() => reset(u)}>
                    {u.pending ? 'Resend invitation' : 'Reset password'}</Button>
                </>
              ) : <span className="text-xs text-text3">view only</span>}
            </span>
          </div>
        ))}
        </TableScroll>
      </Card>

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
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Role">
          <Select title="Role" value={role} onChange={setRole}
            options={ROLES.map((r) => ({ value: r, label: r }))} />
        </Field>
        {err && <div className="text-sm" style={{ color: '#f85149', marginBottom: 8 }}>{err}</div>}
        <Button variant="primary" block
 disabled={busy}>{busy ? '…' : 'Save'}</Button>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- invite

function InviteModal({ onClose, onSaved, onSecret }:
  { onClose: () => void; onSaved: () => void; onSecret: (s: Secret) => void }) {
  const app = useApp();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('analyst');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // The escape hatch is deliberately NOT a pair of radio buttons. A choice at
  // this moment makes the admin re-decide a security question on every invite,
  // and the convenient answer is the wrong one — so the mail path is the button
  // and handing a secret over is a second, plainer action you have to mean.
  const [manual, setManual] = useState(false);
  const byLink = app.mailConfigured && !manual;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api.post<InviteResult>('/api/admin/users',
        { email, name, role, ...(manual ? { manual: true } : null) });
      onSecret(r.invited
        ? { title: 'Invitation sent',
            hint: 'The link works once and expires in 7 days. Nothing to hand over — they '
              + 'activate the account themselves.',
            sentTo: r.email }
        : { title: 'User created',
            hint: r.mailFailed
              ? 'The invitation could not be delivered, so the account got a one-time password '
                + 'instead. Hand it over securely — it must be changed at first sign-in.'
              : 'No mail transport is configured, so the account got a one-time password. Hand '
                + 'it over securely — it must be changed at first sign-in.',
            password: r.initialPassword });
      onSaved(); onClose();
    } catch (ex) { setErr(ex instanceof ApiError ? ex.message : 'error'); setBusy(false); }
  };
  return (
    <Modal title={byLink ? 'Invite user' : 'Create user'} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="E-Mail">
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com" />
        </Field>
        <Field label="Name">
          <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
        </Field>
        <Field label="Role">
          <Select title="Role" value={role} onChange={setRole}
            options={ROLES.map((r) => ({ value: r, label: r }))} />
        </Field>
        <div className="text-sm text-text2" style={{ marginBottom: 10, lineHeight: 1.5 }}>
          {byLink
            ? 'They get an activation link by mail and choose their own password. '
              + 'Nothing to hand over.'
            : app.mailConfigured
              ? 'A one-time password is shown to you once. Hand it over securely — they must '
                + 'change it at first sign-in.'
              : 'No mail transport is configured, so a one-time password is shown to you once. '
                + 'Hand it over securely — they must change it at first sign-in.'}
        </div>
        {err && <div className="text-sm" style={{ color: '#f85149', marginBottom: 8 }}>{err}</div>}
        <Button variant="primary" block
 disabled={busy}>{busy ? '…' : byLink ? 'Send invitation' : 'Create user'}</Button>
        {app.mailConfigured && (
          <Button block type="button"
 style={{ marginTop: 8 }}
 onClick={() => setManual(!manual)}>
            {manual ? 'Send an invitation by mail instead'
              : 'No mailbox for them? Use a one-time password'}
          </Button>
        )}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- one-time secret

function SecretModal({ title, hint, password, sentTo, onClose }: Secret & { onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="text-sm text-text2" style={{ marginBottom: 10 }}>{hint}</div>
      <div className="mono text-lg font-semibold text-text0" style={{
        background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6,
        padding: '10px 12px', userSelect: 'all', wordBreak: 'break-all' }}>{password ?? sentTo}</div>
      <Button variant="primary" block style={{ marginTop: 12 }}
 onClick={onClose}>Done</Button>
    </Modal>
  );
}
