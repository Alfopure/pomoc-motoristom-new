#!/usr/bin/env bash
# Keep the old entry point inert so bookmarks and automation cannot recreate it.
printf '%s\n' 'Retired: the standalone AI demo was removed on 2026-10-18.' 'AI demo now belongs to this application. See docs/operations/ai-demo-veronika.md.' 'No credentials were loaded and no resources were changed.' >&2
exit 1
