'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useUser, UserButton, SignInButton } from '@clerk/nextjs';

interface NavItem { href: string; label: string; icon: string; requiresAuth: boolean }

const NAV: NavItem[] = [
  { href: '/',           label: 'Overview',     icon: '▦', requiresAuth: false },
  { href: '/research',   label: 'Research',     icon: '⌕', requiresAuth: true  },
  { href: '/sentiment',  label: 'Sentiment',    icon: '↗', requiresAuth: true  },
  { href: '/keywords',   label: 'Keywords',     icon: '⌇', requiresAuth: true  },
  { href: '/pipeline',   label: 'Coverage',     icon: '⊕', requiresAuth: true  },
  { href: '/management', label: 'Management',   icon: '⬡', requiresAuth: true  },
  { href: '/promises',   label: 'Promises',     icon: '◎', requiresAuth: true  },
  { href: '/diff',       label: 'Diff',         icon: '⟺', requiresAuth: true  },
  { href: '/redflags',   label: 'Red Flags',    icon: '⚑', requiresAuth: true  },
  { href: '/sector',      label: 'Sector Pulse', icon: '◈', requiresAuth: true  },
  { href: '/daily-feed',  label: 'Daily Feed',   icon: '◉', requiresAuth: true  },
];

export default function NavBar() {
  const pathname = usePathname();
  const { isSignedIn, isLoaded } = useUser();

  return (
    <aside className="glass-sidebar fixed left-0 top-0 h-screen w-56 flex flex-col z-50">
      {/* Brand */}
      <Link href="/" className="flex flex-col gap-0.5 px-5 py-5 border-b border-white/[0.06]">
        <span className="text-amber-400 font-bold text-lg tracking-tight">EarningsLens</span>
        <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.35)' }}>NSE Earnings Intelligence</span>
      </Link>

      {/* Nav items */}
      <nav className="flex-1 px-3 py-4 flex flex-col gap-0.5 overflow-y-auto">
        {NAV.map(item => {
          const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
          const locked   = process.env.NODE_ENV !== 'development' && item.requiresAuth && isLoaded && !isSignedIn;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-xl transition-all duration-150 ${
                isActive
                  ? 'bg-amber-400/12 text-amber-400 border border-amber-400/20 shadow-[0_0_12px_rgba(245,158,11,0.1)] cursor-default'
                  : locked
                  ? 'opacity-40 cursor-pointer'
                  : 'text-white/50 hover:text-white/80 hover:bg-white/[0.05] cursor-pointer'
              }`}
            >
              <span className="text-base leading-none w-4 text-center">{item.icon}</span>
              <span>{item.label}</span>
              {locked && <span className="ml-auto text-[10px] opacity-60">🔒</span>}
            </Link>
          );
        })}
      </nav>

      {/* Auth */}
      <div className="px-4 py-4 border-t border-white/[0.06]">
        {isLoaded && (
          isSignedIn
            ? (
              <div className="flex items-center gap-3">
                <UserButton afterSignOutUrl="/" />
                <span className="text-xs text-white/40">Account</span>
              </div>
            )
            : (
              <SignInButton mode="modal">
                <button
                  className="w-full px-4 py-2 text-sm font-semibold rounded-xl transition-all"
                  style={{ background: 'rgba(245,158,11,0.9)', color: '#111' }}
                >
                  Sign in
                </button>
              </SignInButton>
            )
        )}
      </div>
    </aside>
  );
}
