# BUG-002: Company lookup with `.ilike().single()` fails silently on multiple matches

## Severity
Medium

## Layer
Database

## Reproduction
If the `companies` table has two rows with names that differ only in case (e.g., "Google" and "google"), `.ilike('name', 'google').single()` returns an error (PGRST116 for multiple rows) and `data: null`. The error is not destructured, so `existing` becomes `null` and a duplicate company is inserted.

## Root Cause
`lib/uploader.js` line 51-55:
```js
const { data: existing } = await supabase
  .from('companies')
  .select('id, logo_url, website, location, industry, country_code, description')
  .ilike('name', key)
  .single();
```
The `error` return is discarded. When `.single()` finds 0 or 2+ rows, it returns an error, but the code only reads `data`.

## Impact
Duplicate company records accumulate in the DB. Each time a scraper provides a company name that matches multiple existing rows, a new duplicate is created.

## Fix
Destructure the error. On "multiple rows" error, use `.limit(1)` instead of `.single()`, or use `.eq()` instead of `.ilike()` if exact match suffices. Same pattern affects `getOrCreateSource` (line 13-17).

```js
const { data: existing, error: lookupError } = await supabase
  .from('companies')
  .select('id, logo_url, website, location, industry, country_code, description')
  .ilike('name', key)
  .limit(1)
  .maybeSingle();
```
