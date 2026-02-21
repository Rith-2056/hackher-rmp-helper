# Demo Script (2–3 minutes)

## Setup (before demo)
- Load the unpacked extension: chrome://extensions → Developer mode → Load unpacked → select `extension/`.
- Open options and set:
  - Schedule Builder domain: your school’s domain (e.g., `schedule.example.edu`)
  - RMP School ID (copy from RMP)
- Open the school’s Schedule Builder page (sections list visible).

## Live Demo
1) Badges appear automatically
   - Point to a professor name showing: “⭐ 4.5 · Diff 2.3 (120)”
   - Hover: tooltip shows rating/difficulty/count.

2) “Are there better professors?”
   - Click the extension → button to open the drawer (or press Alt+R).
   - Show top 3 per course; click “Find on page” to scroll/highlight.

3) Adjust preferences
   - In popup, change weights; Save; re-open to see re-ranking.

4) Fix an ambiguous name
   - In Options, add Manual Mapping (schedule name → RMP teacher ID).
   - Refresh; show updated badge.

## Wrap-up
- Caching (7 days), disambiguation (heuristics + overrides), single-school focus first.

# Demo Script (2–3 minutes)

## Setup (before demo)
- Load the packed zip: chrome://extensions → Developer mode → Load unpacked → select `extension/` folder (or use `build/rmp-helper.zip` to pack).
- Open options page and set:
  - Schedule Builder domain: your school’s domain (e.g., `schedule.example.edu`)
  - RMP School ID (paste for your school)
- Open the school’s Schedule Builder page (sections list visible).

## Live Demo
1) Badges appear automatically
   - Point to a professor name showing a blue badge like: “⭐ 4.5 · Diff 2.3 (120)”
   - Hover to show tooltip with details.

2) “Are there better professors?”
   - Click the extension icon → “Are there better professors?”
   - Right-side drawer opens with per-course recommendations and top 3 options.
   - Click “Find on page” to scroll to a recommended section.

3) Adjust preferences
   - In the popup, slide “Overall weight” and “Difficulty weight”, click Save.
   - Reopen recommendations to see re-ranked results.

4) Fix an ambiguous name (edge case)
   - Open Options → add a Manual Mapping for a tricky display name → paste RMP teacher ID.
   - Refresh the schedule page and show updated badge.

## Talking Points
- Caching with 7-day TTL to avoid rate limits and speed up.
- Name disambiguation: heuristics + manual overrides.
- Works with a single school first; can add more by updating domain/school ID.

## Close
- 10s recap: “Ratings inline, quick better-professor suggestions, adjustable preferences, manual fixes.” 

