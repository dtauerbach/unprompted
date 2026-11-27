"use client";

import { useEffect, useState } from "react";
import { pushIsOn, turnOffPush, turnOnPush } from "./actions";
import type { PushCopy } from "./copy-keys";

// Turns notices on or off for the browser the person is in (W1b). The site's
// service worker (public/sw.js) shows a notice when one arrives; nothing is
// cached. The VAPID public key comes from the page, never the bundle.
// Whether notices are on is the site's word, not the browser's: a browser
// keeps a subscription another person turned on here, which the site moved
// or ended since. Turning off always shows while they're on, so the kill
// switch or a last group gone never leaves a person unable to stop them;
// turning on shows only where it can work (canTurnOn).

type State = "checking" | "unsupported" | "denied" | "off" | "on";

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register("/sw.js", {
    scope: "/",
    updateViaCache: "none",
  });
}

export function PushToggle({
  publicKey,
  canTurnOn,
  t,
}: {
  publicKey: string;
  canTurnOn: boolean;
  t: Record<PushCopy, string>;
}) {
  const [state, setState] = useState<State>("checking");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    ) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    registration()
      .then((r) => r.pushManager.getSubscription())
      .then(async (sub) =>
        setState(sub && (await pushIsOn(sub.endpoint)).on ? "on" : "off"),
      )
      .catch(() => setState("unsupported"));
  }, []);

  async function turnOn() {
    setBusy(true);
    setFailed(false);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      const r = await registration();
      await navigator.serviceWorker.ready;
      const sub = await r.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey),
      });
      const res = await turnOnPush(sub.toJSON());
      if (res.error) {
        await sub.unsubscribe();
        setFailed(true);
        return;
      }
      setState("on");
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setFailed(false);
    try {
      const r = await registration();
      const sub = await r.pushManager.getSubscription();
      if (sub) {
        await turnOffPush(sub.endpoint);
        await sub.unsubscribe();
      }
      setState("off");
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (!canTurnOn && state !== "on") return null;
  const button =
    "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800";
  return (
    <section id="notices" className="card space-y-3">
      <h2 className="text-xl font-semibold">{t["account.push.title"]}</h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {t["account.push.lead"]}
      </p>
      {state === "unsupported" && (
        <p className="text-sm">{t["account.push.unsupported"]}</p>
      )}
      {state === "denied" && (
        <p className="text-sm">{t["account.push.denied"]}</p>
      )}
      {state === "on" && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm">{t["account.push.is_on"]}</p>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={turnOff}
          >
            {t["account.push.off"]}
          </button>
        </div>
      )}
      {state === "off" && (
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={turnOn}
        >
          {t["account.push.on"]}
        </button>
      )}
      {failed && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {t["account.push.failed"]}
        </p>
      )}
    </section>
  );
}
