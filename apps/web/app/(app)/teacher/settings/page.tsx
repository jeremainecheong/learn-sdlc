"use client";
import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ExperiencePage, LoadingState } from "@/components/experience/shared";
import { PresentationToggle } from "@/components/experience/PresentationToggle";
import { PortabilityPanel } from "@/components/staff/PortabilityPanel";
import { useSession } from "@/lib/session";
export default function ClassDataPage() {
  const user = useSession();
  const router = useRouter();
  useEffect(() => {
    if (user?.role === "LEARNER") router.replace("/dashboard");
  }, [user?.role, router]);
  return (
    <ExperiencePage
      title="Your class records"
      eyebrow="Keep the evidence connected"
      active="class"
      variant="account"
      actions={
        <>
          <Link className="exp-button" href="/teacher">
            <ArrowLeft size={15} />
            Teacher overview
          </Link>
          {/* Hides learners' addresses while the screen is shared. */}
          <PresentationToggle />
        </>
      }
    >
      {!user || user.role === "LEARNER" ? (
        <LoadingState />
      ) : (
        <div className="exp-account-settings exp-stack">
          <PortabilityPanel />
        </div>
      )}
    </ExperiencePage>
  );
}
