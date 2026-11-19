# Product

<!-- impeccable:product-schema 1 -->

<!-- Drafted from README.md and AGENTS.md during a UI review, not from an interview. Correct anything that's off. -->

## Platform

web

## Users

One rider at a time, usually the owner, training indoors on a smart trainer (an Elite Rampa or any FTMS
trainer). The screen is a phone on the handlebars, a tablet or a laptop 1 to 2 m away. The rider is working
hard, sweating, and glances at the screen between pedal strokes. Taps come from a damp thumb, mid-effort.

## Product Purpose

Run structured ERG interval workouts: vigo sets the trainer's target power second by second, records the
ride, and exports a .FIT file for Strava, intervals.icu or Garmin Connect. Success is a workout ridden as
planned without touching the screen, and a ride that is never lost.

## Positioning

A free, installable web app with no account and no server: Web Bluetooth straight to the trainer, data kept
in the browser, optional sync to the rider's own Google Drive. Plain .erg/.mrc files instead of a workout
platform.

## Operating Context

- Before a ride: pair devices once (Settings), pick or upload a workout (Workouts), set FTP.
- During a ride: glance at the time left in the interval, the target, heart rate; react to the 5 s
  countdown before a power change; occasionally pause, skip, or nudge the intensity ±5%.
- After a ride: save, export .FIT, check History.
- Chrome or Edge only (Web Bluetooth); no iPhone or iPad.

## Capabilities and Constraints

- No build step, no dependencies, strict CSP (`'self'` only, no inline script or style).
- Dark theme only. Four tabs: Ride, Workouts, History, Settings; configuration goes in Settings.
- Must work at 390 px phone width with no horizontal scroll, and in phone landscape.
- Terms: ERG, FTP, target, interval, zone, NP / IF / TSS, .FIT.

## Product Principles

1. Readable at a glance from 1.5 m, mid-effort: one or two numbers matter at a time.
2. A ride is never lost and never ended or skipped by accident.
3. The trainer, not the rider, does the work of holding power; the screen says what's next.
4. Plain words for device and data handling; no raw browser internals in the main flow.

## Accessibility & Inclusion

State is never shown by colour alone. Tap targets at least 44 px, larger for ride controls.
