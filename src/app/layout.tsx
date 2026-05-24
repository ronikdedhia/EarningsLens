import type { Metadata } from 'next';
import './globals.css';
import { ClerkProvider } from '@clerk/nextjs';
import { Inter, DM_Serif_Display } from 'next/font/google';
import NavBar from '@/frontend/NavBar';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
  weight: ['300', '400', '500', '600', '700'],
});

const dmSerif = DM_Serif_Display({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  weight: '400',
  style: ['normal', 'italic'],
});

export const metadata: Metadata = {
  title: 'EarningsLens — NSE Earnings Intelligence',
  description: 'Cross-quarter CFO signal detector for Indian equities using temporal RAG',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${inter.variable} ${dmSerif.variable}`}>
        <body className="min-h-screen antialiased flex">
          <NavBar />
          <main className="flex-1 min-w-0 ml-56 px-8 py-8">
            <div className="max-w-5xl mx-auto">{children}</div>
          </main>
        </body>
      </html>
    </ClerkProvider>
  );
}
