import './globals.css';
import React from 'react';

export const metadata = {
  title: 'Content Manager | MR CAPSULES',
  description: 'Admin Dashboard for MR CAPSULES',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark">
      <body>
        <div className="bg"></div>
        <div className="noise" style={{
          position: 'fixed', inset: 0, zIndex: 50, pointerEvents: 'none',
          opacity: 'var(--noise-op)', mixBlendMode: 'multiply',
          backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 200 200\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'3\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\'/%3E%3C/svg%3E")'
        }}></div>
        <div className="scanlines" style={{
          position: 'fixed', inset: 0, zIndex: 49, pointerEvents: 'none',
          background: 'repeating-linear-gradient(to bottom, var(--scanline-c) 0px, var(--scanline-c) 1px, transparent 1px, transparent 3px)'
        }}></div>
        {children}
      </body>
    </html>
  );
}
