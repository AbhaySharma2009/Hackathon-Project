import { redirectUnlessRole } from "@/server/auth";
import { AvailabilityClient } from "@/components/features/availability/availability-client";

export const metadata = { title: "Team Availability" };

/**
 * Manager and HR only. The gate mirrors the API's, which scopes the data to the
 * caller's own reporting line — the page check is a convenience, RLS and the
 * route gate are the enforcement.
 */
export default async function TeamAvailabilityPage() {
  await redirectUnlessRole("manager", "hr", "admin", "super_admin");

  return <AvailabilityClient />;
}
