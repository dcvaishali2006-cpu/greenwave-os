import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'GreenWave OS',
  description: 'Traffic control room that explains every signal decision, lets you rewind time, and compares adaptive against fixed-time control.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
