# 2026-11-15T15:42+08:00 — Review the daemon stderr fix and cover the actual unbind request

Third-party review of the daemon stderr/EPIPE fix and demo replacement found no production-code defects. The end-to-end regression initially triggered the logging path with `watch` only; it now also sends the actual `unwatch` request, verifies the daemon keeps the same pid, and asserts that `web.log` contains both scaffold and unbind entries.

The demo image was also replaced with the operator-supplied WebP byte-for-byte (1600×900, 76,928 bytes). Because the commits were not pushed, the intermediate 543 KB PNG was removed by rewriting the two local commits rather than adding a deletion commit; `git rev-list --objects --all` confirms no reachable PNG object remains.

Verification: focused daemon-log tests pass, `pnpm check` clean, full `pnpm test` 34 files / 440 tests pass.
