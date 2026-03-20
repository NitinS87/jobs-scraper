# BUG-004: Category mappings inserted after failed delete, creating duplicates

## Severity
High

## Layer
Database

## Reproduction
In `lib/uploader.js` lines 236-243, if the category mapping delete fails, the error is logged but execution continues to the shared category insert block (line 266). This means new mappings are inserted on top of old (undeleteted) ones, creating duplicate associations.

## Root Cause
The `deleteError` check at line 241 only logs a warning. It does not skip the subsequent insert or set a flag to prevent it. The shared category insert code at line 266 runs unconditionally.

## Impact
Jobs accumulate duplicate category mappings over repeated scraper runs whenever the delete operation fails. This corrupts category-based queries and UI displays.

## Fix
Skip category insert when delete fails:

```js
if (deleteError) {
  console.warn(`Failed to delete old category mappings for "${job.title}": ${deleteError.message}`);
  // Skip re-insert to avoid duplicates
} else if (categoryIds.length > 0) {
  // insert mappings...
}
```

Since the category insert is now in a shared block (after the if/else), this requires restructuring — either move it back into the update branch, or use a flag variable.
