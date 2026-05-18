'use client';

import { useUser, SignIn } from '@clerk/nextjs';
import { usePathname } from 'next/navigation';

interface Props {
  children: React.ReactNode;
  feature?: string;
  description?: string;
}

export default function AuthGate({ children, feature, description }: Props) {
  const { isSignedIn, isLoaded } = useUser();
  const pathname = usePathname();

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center py-24 text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>
        <span className="animate-spin inline-block mr-2">⟳</span>
        Loading…
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="flex flex-col items-center gap-6 py-8">
        {/* Context banner */}
        <div className="text-center space-y-1.5 max-w-sm">
          <p
            className="text-base font-semibold"
            style={{
              fontFamily: 'var(--font-display), Georgia, serif',
              color: 'rgba(255,255,255,0.88)',
              letterSpacing: '-0.01em',
            }}
          >
            {feature ? `Access ${feature}` : 'Sign in to continue'}
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'rgba(255,255,255,0.38)' }}>
            {description ?? 'EarningsLens requires an account to access research tools and analytics.'}
          </p>
        </div>

        {/* Inline Clerk sign-in */}
        <SignIn
          routing="hash"
          forceRedirectUrl={pathname}
          appearance={{
            variables: {
              fontFamily:            'var(--font-inter), system-ui, sans-serif',
              fontFamilyButtons:     'var(--font-inter), system-ui, sans-serif',
              fontSize:              '14px',
              fontWeight:            { normal: 400, medium: 500, semibold: 600, bold: 700 },
              colorPrimary:          '#f59e0b',
              colorBackground:       '#0b0d18',
              colorText:             'rgba(255,255,255,0.86)',
              colorTextSecondary:    'rgba(255,255,255,0.42)',
              colorTextOnPrimaryBackground: '#111',
              colorInputBackground:  'rgba(255,255,255,0.05)',
              colorInputText:        'rgba(255,255,255,0.9)',
              colorDanger:           '#f87171',
              colorSuccess:          '#34d399',
              colorNeutral:          'rgba(255,255,255,0.08)',
              borderRadius:          '14px',
              spacingUnit:           '16px',
            },
            elements: {
              // Card shell
              card: {
                background:   'rgba(11,13,24,0.95)',
                border:       '1px solid rgba(255,255,255,0.09)',
                boxShadow:    '0 24px 64px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.07)',
                backdropFilter: 'blur(24px)',
                borderRadius: '20px',
                padding:      '28px',
              },

              // Header
              headerTitle: {
                fontFamily:    'var(--font-display), Georgia, serif',
                fontSize:      '22px',
                fontWeight:    '400',
                letterSpacing: '-0.01em',
                color:         '#f59e0b',
                lineHeight:    '1.2',
              },
              headerSubtitle: {
                fontSize:   '12px',
                fontWeight: '400',
                color:      'rgba(255,255,255,0.36)',
                marginTop:  '4px',
              },

              // Social buttons
              socialButtonsBlockButton: {
                background:   'rgba(255,255,255,0.05)',
                border:       '1px solid rgba(255,255,255,0.1)',
                color:        'rgba(255,255,255,0.75)',
                fontWeight:   '500',
                borderRadius: '12px',
                fontSize:     '13px',
                transition:   'all 0.15s ease',
              },
              socialButtonsBlockButtonText: {
                fontWeight: '500',
                fontSize:   '13px',
              },

              // Divider
              dividerLine: { background: 'rgba(255,255,255,0.07)' },
              dividerText: { color: 'rgba(255,255,255,0.25)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.08em' },

              // Form inputs
              formFieldLabel: {
                fontSize:      '11px',
                fontWeight:    '500',
                color:         'rgba(255,255,255,0.45)',
                textTransform: 'uppercase',
                letterSpacing: '0.07em',
              },
              formFieldInput: {
                background:   'rgba(255,255,255,0.04)',
                border:       '1px solid rgba(255,255,255,0.1)',
                color:        'rgba(255,255,255,0.9)',
                borderRadius: '10px',
                fontSize:     '14px',
                fontWeight:   '400',
                boxShadow:    'none',
              },

              // Primary button
              formButtonPrimary: {
                background:    '#f59e0b',
                color:         '#0b0d18',
                fontWeight:    '600',
                fontSize:      '14px',
                letterSpacing: '0.01em',
                borderRadius:  '10px',
                boxShadow:     '0 4px 16px rgba(245,158,11,0.35)',
                border:        'none',
                fontFamily:    'var(--font-inter), system-ui, sans-serif',
              },

              // Footer
              footerActionText:  { color: 'rgba(255,255,255,0.35)', fontSize: '12px' },
              footerActionLink:  { color: '#f59e0b', fontWeight: '500', fontSize: '12px' },

              // Misc
              identityPreviewText:      { color: 'rgba(255,255,255,0.65)' },
              identityPreviewEditButton: { color: '#f59e0b' },
              alertText:                { fontSize: '12px' },
              formFieldInputShowPasswordButton: { color: 'rgba(255,255,255,0.4)' },
            },
          }}
        />
      </div>
    );
  }

  return <>{children}</>;
}
