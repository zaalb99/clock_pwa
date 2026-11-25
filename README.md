# Clock PWA

An iOS-style clock as an installable web app: World Clock, Alarms, Stopwatch, Timers.

**The stopwatch runs faster than real time** (default ×1.25).
- Change it: long-press the stopwatch time → *Stopwatch Speed*, or open the app with `?speed=1.5`.
- The setting is saved; a change takes effect from the next Start (or immediately on Save while running).

Run locally: `python3 -m http.server` in this folder, then open http://localhost:8000.
Install: serve over HTTPS, open in Safari → Share → Add to Home Screen.

Limitation: browsers can't wake a closed web app, so alarms and timers ring only while the app is open
(a notification is shown if the app is in the background and notifications are allowed).
