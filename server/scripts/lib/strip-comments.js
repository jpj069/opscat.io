'use strict';
/* Comments out of a JS source, for the CI guards that COUNT things in code.
 *
 * Both callers grep for a literal that also appears in prose — `router.post(`
 * in a doc comment, `Action: 'DescribeVolumes'` in an example — and both are
 * silently wrong if they count it. The direction of the damage differs
 * (check-api-schema seeds a too-low baseline, i.e. permissive; check-cloud-policy
 * demands a grant nothing needs, i.e. a spurious red build) but the parser is
 * the same, and a second copy is how the two would drift.
 *
 * Line by line, and LINE comments before BLOCK comments, because a line comment
 * may itself contain "/*". A naive block-comment regex reading such a "/*" as
 * an opener swallows everything to the next close — measured: 12 KB of real
 * code and eleven real routes.
 */
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (let line of src.split('\n')) {
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      line = line.slice(end + 2);
      inBlock = false;
    }
    const lineComment = line.match(/(^|[^:])\/\//);   // [^:] keeps "https://…" intact
    if (lineComment) line = line.slice(0, lineComment.index + (lineComment[1] ? 1 : 0));
    line = line.replace(/\/\*.*?\*\//g, '');
    const open = line.indexOf('/*');
    if (open !== -1) { line = line.slice(0, open); inBlock = true; }
    out.push(line);
  }
  return out.join('\n');
}

module.exports = { stripComments };
