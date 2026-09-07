const CACHE_NAME = "pm-dispatch-shell-v5";
const APP_SHELL_PATHS = ["/offline", "/icon-192", "/icon", "/apple-icon", "/manifest.webmanifest"];

self.addEventListener("install", function (event) {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(function (cache) {
    return cache.addAll(APP_SHELL_PATHS);
  }));
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) {
        return key !== CACHE_NAME;
      }).map(function (key) {
        return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    }),
  );
});

self.addEventListener("fetch", function (event) {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkNavigationOrOffline(request));
    return;
  }

  if (APP_SHELL_PATHS.includes(url.pathname) || url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request));
  }
});

async function networkNavigationOrOffline(request) {
  try {
    // Authenticated pages are deliberately never cached. An offline cache of
    // dispatcher HTML could expose stale customer data on a shared computer.
    return await fetch(request);
  } catch {
    return (await caches.match("/offline")) || Response.error();
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("push", function (event) {
  // Always display a notification, including in the foreground. Silent push is
  // not supported on Safari and can cause the browser to revoke permission.
  event.waitUntil(showPushNotification(event));
});

async function showPushNotification(event) {
  let payload = {};
  try {
    const parsed = event.data ? event.data.json() : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
  } catch {
    // An invalid payload still produces a safe, useful notification.
  }
  const isCall = (payload.callKind === "incoming_call" || payload.callKind === "available_call") &&
    typeof payload.callSessionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.callSessionId);
  const expiredCall = isCall && typeof payload.expiresAt === "string" && Date.parse(payload.expiresAt) <= Date.now();
  const options = {
    body: expiredCall ? "Hovor už nemusí byť dostupný. Otvorte aplikáciu a skontrolujte jeho aktuálny stav."
      : typeof payload.body === "string" ? payload.body.slice(0, 300) : "V dispečingu máš nové upozornenie.",
    icon: "/icon-192",
    badge: "/icon-192",
    tag: typeof payload.tag === "string" ? payload.tag.slice(0, 150) : "pm-dispatch-notification",
    silent: payload.soundEnabled === false,
    data: { url: safeNotificationUrl(payload.url), ...(payload.mobileApp === true ? { mobileApp: true } : {}) },
  };
  // The Notifications API rejects a vibration pattern with silent: true.
  if (!options.silent) options.vibrate = [150, 70, 150];
  const title = typeof payload.title === "string" && payload.title.trim()
    ? payload.title.slice(0, 120)
    : "Pomoc Motoristom";
  await self.registration.showNotification(title, options);
}

function safeNotificationUrl(value) {
  const fallback = new URL("/", self.location.origin);
  try {
    const candidate = new URL(typeof value === "string" ? value : "/", self.location.origin);
    if (candidate.origin !== self.location.origin || candidate.pathname !== "/" || candidate.username || candidate.password) return fallback.href;
    // Only dispatch deep links are allowed: never navigate to APIs, external
    // pages, JavaScript URLs, login redirects or customer location links.
    const tasks = candidate.searchParams.getAll("task");
    const calls = candidate.searchParams.getAll("call");
    if (tasks.length && calls.length) return fallback.href;
    if (tasks.length === 1 && /^[a-zA-Z0-9_-]{1,100}$/.test(tasks[0])) fallback.searchParams.set("task", tasks[0]);
    if (calls.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(calls[0])) fallback.searchParams.set("call", calls[0].toLowerCase());
    return fallback.href;
  } catch {
    return fallback.href;
  }
}

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(openNotification(event.notification.data?.url, event.notification.data?.mobileApp === true));
});

async function openNotification(value, preferMobileApp = false) {
  const url = safeNotificationUrl(value);
  const isCall = new URL(url).searchParams.has("call");
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (preferMobileApp) {
    const mobile = new Set((await Promise.all(windows.filter((client) => new URL(client.url).origin === self.location.origin).map(async (client) => await isMobileClient(client) ? client.id : null))).filter(Boolean));
    windows.sort((a, b) => Number(mobile.has(b.id)) - Number(mobile.has(a.id)));
  }
  for (const client of windows) {
    const current = new URL(client.url);
    if (current.origin !== self.location.origin || current.pathname !== "/") continue;
    try {
      await client.focus();
      // The application uses its existing unsaved-work guard before opening
      // the task. A login screen or a page that has not hydrated cannot handle
      // this message, so preserve the task URL through normal navigation there.
      if (await requestNotificationOpen(client, url)) return;
      // An older app cannot understand call links. Do not navigate its live
      // call or draft away when the new message goes unacknowledged.
      if (isCall) continue;
      if (typeof client.navigate === "function" && await client.navigate(url)) return;
    } catch {
      // A window may close between enumeration and navigation; try the next one.
    }
  }
  await self.clients.openWindow(url);
}

function requestNotificationOpen(client, url) {
  return new Promise(function (resolve) {
    const channel = new MessageChannel();
    let settled = false;
    const timer = setTimeout(function () { finish(false); }, 1000);
    function finish(handled) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(handled);
    }
    channel.port1.onmessage = function (event) {
      // The console acknowledges receipt before showing its unsaved-work
      // dialog. Waiting for the user's decision must never trigger a reload.
      if (event.data?.handled === true) finish(true);
    };
    try {
      const type = new URL(url).searchParams.has("call") ? "PM_OPEN_CALL_NOTIFICATION" : "PM_OPEN_NOTIFICATION";
      client.postMessage({ type, url }, [channel.port2]);
    } catch {
      channel.port2.close();
      finish(false);
    }
  });
}


// A Chromium PWA and a browser tab may share the same push endpoint. Prefer
// the installed mobile client without guessing from its URL or viewport.
function isMobileClient(client) {
  return new Promise(function (resolve) {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (mobile) => {
      if (settled) return;
      settled = true; clearTimeout(timer); channel.port1.onmessage = null; channel.port1.close(); resolve(mobile);
    };
    const timer = setTimeout(() => finish(false), 250);
    channel.port1.onmessage = (event) => finish(event.data?.mobileApp === true);
    try { client.postMessage({ type: "PM_CLIENT_CONTEXT" }, [channel.port2]); }
    catch { channel.port2.close(); finish(false); }
  });
}
