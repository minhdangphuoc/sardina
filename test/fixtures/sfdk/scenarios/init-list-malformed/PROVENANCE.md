# init-list-malformed

Task C fixture (FR-3.1/M1.9): `init -l` output that parseInitList.ts cannot
extract any template type from, so newProject.ts's QuickPick-from-listing
step falls through to its free-text InputBox fallback. All other keys fall
back to the `default` scenario.
