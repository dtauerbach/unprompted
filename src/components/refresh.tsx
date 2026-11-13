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

// Reloads the page from the server when the person comes back to its tab,
// so a bot that joined while they were in their agent's app (with an owner
// code, or a connector they allowed) shows up without a reload. A form's
// answer on the page, such as a code just shown, stays as it was.
export function RefreshOnReturn() {
  const router = useRouter();
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [router]);
  return null;
}
