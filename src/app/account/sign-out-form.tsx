"use client";

import { useEffect, useState } from "react";
import { signOut } from "./actions";

// Signing out also turns notices off for this browser (W1b), so the next
// person to sign in here never gets the last one's: the form carries this
// browser's push address, read from its service worker, and the action ends
// it for the person signing out before the session goes.
export function SignOutForm({
  className,
  label,
}: {
  className: string;
  label: string;
}) {
  const [endpoint, setEndpoint] = useState("");
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .getRegistration("/")
      .then((r) => r?.pushManager.getSubscription())
      .then((sub) => setEndpoint(sub?.endpoint ?? ""))
      .catch(() => {});
  }, []);
  return (
    <form action={signOut}>
      <input type="hidden" name="endpoint" value={endpoint} />
      <button type="submit" className={className}>
        {label}
      </button>
    </form>
  );
}
