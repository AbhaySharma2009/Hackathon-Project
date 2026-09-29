import { redirectUnlessRole } from "@/lib/auth";
import { PagePlaceholder } from "@/components/layout/page-placeholder";

export default async function TeamAvailabilityPage() {
  await redirectUnlessRole("manager", "hr");

  return (
    <PagePlaceholder
      title="Team Availability"
      description="Who in your team is away today, this week, and where the gaps are."
    />
  );
}
