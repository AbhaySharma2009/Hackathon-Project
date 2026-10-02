"use client";

/**
 * One in-flight request for the alerts feed, shared by everything that shows it.
 *
 * `AlertBell` sits in the topbar on every signed-in page and `AlertList` is the
 * alerts page itself, so that page used to ask for the same feed twice on mount:
 * two identical requests, two identical RLS-scoped reads, and two chances to
 * disagree. Mounting in strict mode doubles that again.
 *
 * This is a request-level cache, not a store: callers still receive the feed and
 * hold it in their own state, so nothing about the components' behaviour changes
 * except that they no longer each pay for their own download.
 *
 * Freshness is unchanged in the ways that matter. A mount within `FRESH_MS` of
 * the last load reuses it, which only collapses requests that would have been
 * issued milliseconds apart; every realtime signal and every mutation forces a
 * fresh load rather than reading the cache.
 */
import { apiFetch } from "@/shared/api-client";
import type { AlertsFeed } from "@/shared/types";

/**
 * How long a completed load is reusable by a later mount.
 *
 * Short enough that navigating to the alerts page a minute later still shows the
 * current state, long enough that the bell and the list mounting together share
 * one response.
 */
const FRESH_MS = 5_000;

let cached: { feed: AlertsFeed; at: number } | null = null;
let inFlight: Promise<AlertsFeed> | null = null;

/**
 * Loads the alerts feed, reusing an in-flight request or a just-completed one.
 *
 * Pass `force` after something has changed the alerts — a mark-as-read, a
 * generated alert — so the next caller re-reads rather than seeing the value
 * from before the change.
 */
export function loadAlertsFeed(options: { force?: boolean } = {}): Promise<AlertsFeed> {
  const now = Date.now();
  if (!options.force) {
    if (inFlight) return inFlight;
    if (cached && now - cached.at < FRESH_MS) return Promise.resolve(cached.feed);
  }

  const request = apiFetch<{ data: AlertsFeed }>("/api/alerts")
    .then((response) => {
      cached = { feed: response.data, at: Date.now() };
      return response.data;
    })
    .finally(() => {
      // Only this request may clear the slot; a `force` load that started later
      // owns it now.
      if (inFlight === request) inFlight = null;
    });

  inFlight = request;
  return request;
}

/** Drops the cached feed so the next load definitely re-reads. */
export function invalidateAlertsFeed() {
  cached = null;
}