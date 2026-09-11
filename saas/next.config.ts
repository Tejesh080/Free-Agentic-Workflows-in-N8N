import type { NextConfig } from 'next';

const dev = process.env.NODE_ENV !== 'production';

// React's development build uses eval() to reconstruct stack frames. It does not
// in production, and it says so itself. Allowing it in dev only keeps the
// production policy strict while removing a console error that would otherwise
// train everyone to ignore CSP failures.
const scriptSrc = dev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

const config: NextConfig = {
  // PGlite ships a wasm bundle. It is only reached by the local development
  // driver, so it must not be traced into a server bundle for deployment.
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Evidence and outreach text are attacker-influenced. React escapes
          // them; this is the second layer.
          //
          // Known weakening, recorded rather than hidden: 'unsafe-inline' is
          // present because the App Router emits inline hydration scripts. The
          // fix is a per-request nonce from middleware, which is tracked in
          // docs/SECURITY.md as an open MEDIUM finding rather than claimed here.
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              scriptSrc,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'none'",
              "form-action 'self'",
              "object-src 'none'",
            ].join('; '),
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default config;
