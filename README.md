# RMP Helper – Schedule Booster (HackHer)

Chrome MV3 extension that overlays RateMyProfessors ratings on your school’s Schedule Builder and recommends better‑rated professors on demand.

## Quick Start
1) Load in Chrome: open `chrome://extensions` → toggle Developer mode → Load unpacked → select the `extension/` folder.
2) Open the extension’s Options:
   - Set Schedule Builder domain (e.g., `schedule.example.edu`)
   - Set your RateMyProfessors School ID
3) Visit your Schedule Builder page — badges appear next to professor names.
4) Click the extension button → “Are there better professors?” (or press Alt+R) to open recommendations.

## Features
- Inline badges: Overall ⭐, Difficulty, (#ratings)
- Recommendation drawer: top 3 alternatives per course, “Find on page”
- Preferences: adjustable weights for overall vs difficulty
- Options: domain/SchoolID, manual name→RMP mappings, clear cache
- Caching: 7‑day TTL to keep it fast and friendly

## Build/Packaging
```
bash scripts/pack.sh
```
Outputs `build/rmp-helper.zip` for packaging.

## Notes
- Works on a single configured Schedule Builder domain first.
- If a name doesn’t match, add a Manual Mapping in Options (schedule name → RMP teacher ID).
- If RMP changes its GraphQL, the UI degrades to “n/a”.

## License
MIT – see `LICENSE`.

