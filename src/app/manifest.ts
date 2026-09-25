import type { MetadataRoute } from "next";

/**
 * Installable app manifest (point 62).
 *
 * `display: standalone` matters more than it looks: collectors use this on a
 * phone all day, and losing the browser chrome removes the address bar they
 * would otherwise be one stray tap away from.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Capital Control",
    short_name: "Capital",
    description:
      "Administración de préstamos, cartera, caja y resultados del negocio.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#0a0b0d",
    theme_color: "#0a0b0d",
    lang: "es-CO",
    dir: "ltr",
    categories: ["business", "finance", "productivity"],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      { name: "Cobros de hoy", url: "/cobros" },
      { name: "Caja", url: "/caja" },
      { name: "Préstamos", url: "/prestamos" },
    ],
  };
}
