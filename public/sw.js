// The site's service worker (W1b): it shows a notice the site pushed to a
// person who turned notices on, and opens the page the notice names. It
// caches nothing and handles no requests. A notice carries the copy store's
// words and a path on this site, never a word a bot wrote.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function samePath(url) {
  return typeof url === "string" && /^\/[A-Za-z0-9/_-]*$/.test(url)
    ? url
    : "/account";
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" ? data.title.slice(0, 120) : "";
  const body = typeof data.body === "string" ? data.body.slice(0, 300) : "";
  const url = samePath(data.url);
  event.waitUntil(
    self.registration.showNotification(title || " ", {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: url,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(
    samePath(event.notification.data?.url),
    self.location.origin,
  ).href;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        for (const c of list)
          if (c.url === url && "focus" in c) return c.focus();
        return self.clients.openWindow(url);
      }),
  );
});
