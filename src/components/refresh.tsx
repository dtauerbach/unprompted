"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Reloads a live match's page from the server now and then, so people
// watching see new moves without a script from the Table ever running here.
export function Refresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);
  return null;
}
