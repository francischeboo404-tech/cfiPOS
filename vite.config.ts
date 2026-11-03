import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from 'vite-plugin-pwa';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: true,
    port: 8080,
    headers: mode === 'development' ? {} : {
      // Content Security Policy (CSP) for XSS protection - content-security-policy
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net 'wasm-unsafe-eval'",
        "worker-src 'self' blob:",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https: blob:",
        mode === 'production'
          ? "connect-src 'self' https: wss:"
          : "connect-src 'self' https: wss: http://localhost:3000 ws://localhost:3000 http://127.0.0.1:3000 ws://127.0.0.1:3000 http://localhost:8080 ws://localhost:8080 http://127.0.0.1:8080 ws://127.0.0.1:8080",
        "frame-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        mode === 'production' ? "upgrade-insecure-requests" : ""
      ].filter(Boolean).join('; '),
      // Additional security headers
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'X-XSS-Protection': '1; mode=block',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    }
  },
  /* Build optimizations for offline-first */
  build: {
    /* Inline small assets to reduce network requests */
    assetsInlineLimit: 4096,
    /* Generate source maps for debugging */
    sourcemap: mode === 'development',
    /* Optimize CSS */
    cssCodeSplit: false,
    /* Minify for production */
    minify: mode === 'production' ? 'esbuild' : false,
    rollupOptions: {
      output: {
        /* Consistent chunk naming for better chunking */
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-ui': ['@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', '@radix-ui/react-tabs'],
          'vendor-query': ['@tanstack/react-query'],
        },
      },
    },
  },
  plugins: [
    react(),
    mode === 'development' && componentTagger(),
    // Re-enable PWA with security hardening - Windows path issue resolved
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      includeAssets: ['cfi-pos-techiez-mark.png'],
      manifest: {
        name: 'CFI-POS Techiez',
        short_name: 'CFI POS',
        description: 'Smart point of sale for smart businesses, with sales, inventory, and reporting tools.',
        theme_color: '#0c234b',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait-primary',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallbackDenylist: [
          /^\/api(?:\/|$)/
        ]
      },
      devOptions: {
        enabled: false // Disable in development for security
      }
    })
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  /* Optimize dependencies */
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
  },
}));
