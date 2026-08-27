-- Who a session is really being driven by, when it is not its own user.
--
-- `POST /api/superadmin/orgs/:id/impersonate` mints a session for the target
-- org's owner and OVERWRITES the operator's cookie. Nothing recorded who had
-- been there a moment earlier, so there was no way back and — worse — no way to
-- tell from inside the app that you were impersonating at all. Every action
-- after that point audits as the customer.
--
-- ON DELETE SET NULL rather than CASCADE: deleting the operator's account must
-- not delete the customer sessions they once opened. The session simply loses
-- its way home, which is the correct degradation — `stop-impersonating` then
-- refuses because the row is NULL.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS impersonator_user_id UUID
  REFERENCES users(id) ON DELETE SET NULL;
