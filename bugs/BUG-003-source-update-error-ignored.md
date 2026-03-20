# BUG-003: Source and company update errors silently ignored

## Severity
Medium

## Layer
Database

## Reproduction
If the `job_sources.update({ last_synced_at })` call fails (network error, RLS policy, etc.), the error is completely discarded. Same for company backfill updates.

## Root Cause
`lib/uploader.js`:
- Line 20-23: `await supabase.from('job_sources').update(...)` — no error handling at all
- Line 73-77: `await supabase.from('companies').update(updates)` — no error handling at all
- Line 13-17: Source lookup `.single()` — error discarded

These are fire-and-forget writes with no error capture or logging.

## Impact
- `last_synced_at` could be perpetually stale if updates consistently fail, giving the false impression that a source hasn't been synced recently.
- Company backfill data (website, location, industry) silently fails to persist.
- A genuine source lookup failure (network) silently inserts a duplicate source.

## Fix
Add minimal error logging:

```js
const { error: updateError } = await supabase
  .from('job_sources')
  .update({ last_synced_at: new Date().toISOString() })
  .eq('id', existing.id);
if (updateError) console.warn(`Failed to update source last_synced_at for ${name}: ${updateError.message}`);
```

Same pattern for company backfill update and source lookup.
