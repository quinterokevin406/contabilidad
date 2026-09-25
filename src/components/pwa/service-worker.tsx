"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (point 62).
 *
 * Registration is deliberately skipped in development: a worker that survives
 * a hot reload will serve yesterday's bundle and send you hunting a bug that
 * does not exist.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // An unregistrable worker costs nothing: the app is fully functional
        // online, which is where it is used.
      });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  return null;
}
