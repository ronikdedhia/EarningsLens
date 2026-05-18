'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useUser, UserButton, SignInButton } from '@clerk/nextjs';

interface NavItem { href: string; label: string; icon: string; requiresAuth: boolean }

const NAV: NavItem[] = [
  { href: '/',           label: 'Overview',   icon: '▦', requiresAuth: false },
  { href: '/research',   label: 'Research',   icon: '⌕', requiresAuth: true  },
  { href: '/sentiment',  label: 'Sentiment',  icon: '↗', requiresAuth: true  },
  { href: '/keywords',   label: 'Keywords',   icon: '⌇', requiresAuth: true  },
  { href: '/pipeline',   label: 'Coverage',   icon: '⊕', requiresAuth: true  },
  { href: '/management', label: 'Management', icon: '⬡', requiresAuth: true  },
  { href: '/promises',   label: 'Promises',   icon: '◎', requiresAuth: true  },
  { href: '/diff',       label: 'Diff',       icon: '⟺', requiresAuth: true  },
  { href: '/redflags',   label: 'Red Flags',  icon: '⚑', requiresAuth: true  },
  { href: '/sector',     label: 'Sector Pulse', icon: '◈', requiresAuth: true  },
];

export default function NavBar() {
  const pathname          = usePathname();
  const { isSignedIn, isLoaded } = useUser();

  return (
    <header className="glass-header sticky top-0 z-50 px-4 py-3 flex items-center justify-between gap-3">
      {/* Brand */}
      <Link href="/" className="flex items-center gap-2 shrink-0">
        <span className="text-amber-400 font-bold text-xl tracking-tight">EarningsLens</span>
        <span className="hidden md:block text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>
          NSE Earnings Intelligence
        </span>
      </Link>

      {/* Tab nav */}
      <nav className="glass rounded-2xl p-1 flex gap-0.5 overflow-x-auto">
        {NAV.map(item => {
          const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
          const locked   = item.requiresAuth && isLoaded && !isSignedIn;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-xl whitespace-nowrap transition-all duration-200 ${
                isActive
                  ? 'bg-amber-400/15 text-amber-400 border border-amber-400/25 shadow-[0_0_16px_rgba(245,158,11,0.15)]'
                  : locked
                  ? 'opacity-50 cursor-default'
                  : 'text-white/40 hover:text-white/70 hover:bg-white/5'
              }`}
            >
              <span className="leading-none">{item.icon}</span>
              <span className="hidden sm:inline">{item.label}</span>
              {locked && <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.3)' }}>🔒</span>}
            </Link>
          );
        })}
      </nav>

      {/* Auth */}
      <div className="shrink-0">
        {isLoaded && (
          isSignedIn
            ? <UserButton afterSignOutUrl="/" />
            : (
              <SignInButton mode="modal">
                <button
                  className="px-4 py-1.5 text-sm font-semibold rounded-xl transition-all"
                  style={{ background: 'rgba(245,158,11,0.9)', color: '#111' }}
                >
                  Sign in
                </button>
              </SignInButton>
            )
        )}
      </div>
    </header>
  );
}
