# Quran Progress Tracker for GitHub Pages

This version is static and GitHub Pages-ready.

## What changed

- No Node.js
- No local server
- No `output.json` dependency at runtime
- Progress is saved in the browser on each user's own device
- Chart pages, tracker, and settings all read from the same browser-saved data

## Files

- `index.html` or `quran-progress-tracker.html`: main tracker
- `quran-progress-summary.html`: progress overview charts
- `quran-progress-trends.html`: daily and monthly trend charts
- `quran-reference-settings.html`: reference and column settings
- `quran-progress-guide.html`: usage guide
- `assets/quran-progress-seed.js`: initial seeded data
- `assets/quran-progress-store.js`: browser storage logic

## GitHub Pages setup

1. Create a GitHub repository.
2. Upload this folder's contents to the repository root.
3. In GitHub, open `Settings` > `Pages`.
4. Set the source to deploy from the main branch root.
5. Open the published site URL.

## Saving behavior

- `Save Progress` stores progress in the browser for that user.
- Each user keeps their own separate progress in their own browser.
- If browser storage is cleared, saved progress will reset to the original seeded data.

## Technical note

The verse dataset is too large for normal `localStorage` limits in many browsers, so the app stores the main data in browser `IndexedDB`. User settings and small pending-change state still use `localStorage`.
