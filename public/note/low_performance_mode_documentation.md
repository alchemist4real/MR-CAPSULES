# Low Performance Mode Walkthrough

This document summarizes the implementation of the "Low Performance Mode" feature requested for MR CAPSULES, including its UI redesign and rendering bugfixes.

## Changes Made

### 1. UI Redesign (Toggle Switch)
- Initially implemented as simple `ON`/`OFF` buttons, the setting was redesigned into a modern, native iOS-style toggle switch inside the **Settings Modal** (`index.html`), under the `APPEARANCE` section.
- Added custom CSS (`.toggle-switch`, `.slider`) specifically engineered to match the sleek dark/light minimal aesthetic of the application without relying on external libraries.

### 2. State & Core Logic
- Created a `isLowPerfMode` state variable, initially hydrated from `localStorage` (`mr_low_perf`).
- Updated the `loadCatalog` function so that when `isLowPerfMode` is enabled, `item.cover = ''` is assigned rather than fetching random cover images. This replaces all covers with a lightweight package icon (`📦`).
- Fixed a major routing bug where toggling the setting caused the app to drop out of nested directory views. The app now specifically invokes `loadCatalog(catalog, cur)` to instantly re-render the *current* view structure.

### 3. Rendering Optimizations for Low-End Devices
- Found and fixed a persistent bug where toggling "Low Performance Mode" back OFF would result in invisible/blank covers on low-end hardware.
- Removed the `decoding="async"` attribute from images (`.art-bg` and `.mini-thumb`), ensuring that slower WebKit/Blink engines don't indefinitely defer painting newly injected DOM nodes.
- Added a fallback `background-color: var(--border-light)` to the `.art-bg` cards, providing a clean gray skeleton layout if images take a moment to download over slow networks.

### 4. Cross-Device Sync (Supabase)
- Wired the toggle to the Supabase client (`window.supabaseClient`). When switched, if a user is logged in, the preference is written to their `user_metadata` under the key `low_perf_mode`.
- Updated both `supabase.auth.getSession()` and `supabase.auth.onAuthStateChange()` to read and apply the `low_perf_mode` variable automatically across devices.

## Testing & Verification
- **Visuals:** Turning the toggle ON correctly hides images and shows the box icon instantly. Turning it OFF instantly re-paints the images. 
- **Persistence:** Local settings persist on unauthenticated sessions, and authenticated users have their layout synchronized globally across devices.
