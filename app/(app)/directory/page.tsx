"use client";

import { useEmployee } from "@/components/providers/session-provider";
import dynamic from "next/dynamic";
import { LoadingRegion } from "@/components/design/loaders";

const DirectoryClient = dynamic(
  () => import("@/components/features/directory/directory-client").then((m) => m.DirectoryClient),
  {
    loading: () => <LoadingRegion label="Loading directory" />,
    ssr: false,
  },
);


export default function DirectoryPage() {
  const employee = useEmployee();

  if (!employee) return null;

  return <DirectoryClient isHr={employee.app_role === "hr"} selfId={employee.id} />;
}