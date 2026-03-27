## 2025-05-14 - [Settings Caching & O(n) Duplicate Detection]
**Learning:** Sequential asynchronous storage lookups during high-frequency events (like `onUpdated` or when checking 50+ tabs) cause significant lag. Moving settings to a `Set` and `Boolean` cache in `background.js` and updating it via `onChanged` makes the extension's core logic instantaneous.
**Action:** Always prefer a synchronous cache for extension settings that are read frequently in event listeners.
