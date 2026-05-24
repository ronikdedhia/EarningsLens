export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { init } = await import('@sentry/nextjs');
    init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    const { init } = await import('@sentry/nextjs');
    init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
  }
}
