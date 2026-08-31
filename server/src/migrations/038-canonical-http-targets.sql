-- Give every HTTP check a target with a scheme.
--
-- A person types `link11.com`, which is a fine thing to monitor and is not a
-- URL. Two things added the scheme and they disagreed: the in-process probe
-- prepended `https://`, the Sensor Agent called fetch() straight and undici
-- answered `TypeError: Failed to parse URL from link11.com`. So one check was
-- green from Nuremberg and red from N. Virginia and Los Angeles, with a message
-- about OUR parser shown where the customer reads "is my site up?".
--
-- util.httpTarget is the single rule now and both writers go through it. This
-- backfill is what makes that true of rows written before it existed — and it
-- is also what fixes the sensors ALREADY DEPLOYED: they read the target out of
-- the work list, so a canonical row repairs them without waiting for an agent
-- to self-update.
--
-- Deliberately only the scheme, and only where one is missing. A target that is
-- broken in some other way (`https://` on its own, which parses to no host) is
-- left exactly as it is: it has been failing visibly all along, and silently
-- rewriting someone's check into a different one it might now pass is worse
-- than leaving a red row they can see and delete.
UPDATE synthetic_checks
   SET target = 'https://' || target
 WHERE type = 'http'
   AND target <> ''
   AND target !~* '^https?://';
