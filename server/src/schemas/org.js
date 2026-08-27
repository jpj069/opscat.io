'use strict';
/* Shapes for the organisation's own identity (routes/admin.js, routes/public.js).
 *
 * Written under the rule the rest of /api was converted under and stated in
 * docs/API-CONTRACT.md: **the schema describes; the handler keeps deciding.**
 * The upload body is the clearest case — `putAvatar` sniffs magic bytes, caps
 * at 512 KB and answers a specific 400 for each ("unsupported image format",
 * "image larger than 512 KB"). Re-expressing those as zod constraints would
 * replace messages the UI shows verbatim with a generic validation error, so
 * the body declares a string and the guards stay where they are.
 */
const { z } = require('zod');

const ErrorResponse = z.object({ error: z.string() })
  .describe('Error envelope: {"error": "message"}.');

const OrgAvatarUploadBody = z.object({
  data: z.string().describe(
    'The image as base64, or a `data:<mime>;base64,` URI as a browser FileReader produces. '
    + 'PNG, JPEG, WebP or ICO, up to 512 KB. The declared type is ignored — the bytes are '
    + 'sniffed, so an SVG is refused whatever it calls itself.'),
});

const OrgAvatarResponse = z.object({
  name: z.string().describe('The organisation name the initials are derived from.'),
  initials: z.string().describe('One or two characters. Never empty — a name with no letters gives "?".'),
  color: z.string().describe('Hex colour derived from the organisation id, stable across renames.'),
  url: z.string().nullable().describe(
    'Path to the uploaded image, cache-busted with `?v=`. `null` means the organisation has '
    + 'uploaded nothing — which is not a missing value: initials on `color` ARE the default.'),
  mime: z.string().nullable(),
  bytes: z.number().int().nullable(),
});

const OrgAvatarParam = z.object({
  orgId: z.string().describe('The organisation uuid.'),
});

// The avatar endpoint answers BYTES, not JSON. The registrar's escape hatch
// (a handler that writes the response and returns undefined) skips response
// validation, so these two exist to describe the endpoint in the spec rather
// than to check anything at runtime.
const OrgAvatarBinary = z.string()
  .describe('The image bytes, served as the sniffed content type (PNG/JPEG/WebP/ICO).');
const NotFoundText = z.string()
  .describe('`not found` — the organisation has uploaded no avatar. Its default is initials, '
    + 'derived by the caller rather than rendered here.');

module.exports = {
  ErrorResponse, OrgAvatarUploadBody, OrgAvatarResponse, OrgAvatarParam,
  OrgAvatarBinary, NotFoundText,
};
