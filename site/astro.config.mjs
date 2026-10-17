import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://toolblox.dev",
  vite: { plugins: [tailwindcss()] },
  redirects: {
    "/privacy": "/legal/#privacy",
    "/security": "/legal/#security",
  },
  integrations: [
    react(),
    starlight({
      title: "Toolblox",
      logo: { src: "./public/logo.svg" },
      favicon: "/logo.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/BakedAleska/Toolblox" }],
      editLink: { baseUrl: "https://github.com/BakedAleska/Toolblox/edit/main/site/" },
      sidebar: [
        { label: "Introduction", link: "/docs/" },
        { label: "Install Toolblox", link: "/docs/install/" },
        { label: "Start here", items: [{ autogenerate: { directory: "docs/start" } }] },
        { label: "The app", items: [{ autogenerate: { directory: "docs/app" } }] },
        { label: "Widget tutorials", items: [{ autogenerate: { directory: "docs/widgets/tutorials" } }] },
        { label: "Widget reference", items: [{ autogenerate: { directory: "docs/widgets/reference" } }] },
        { label: "Publishing", items: [{ autogenerate: { directory: "docs/widgets/publishing" } }] },
      ],
    }),
  ],
});
