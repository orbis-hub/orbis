import { Suspense } from "react";
import { DashboardView } from "@/components/dashboard/DashboardView";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <DashboardView />
    </Suspense>
  );
}
