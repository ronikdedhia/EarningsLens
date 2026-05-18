import { clerkMiddleware } from '@clerk/nextjs/server';

// No route protection — auth gating is handled client-side via AuthGate component.
// Middleware runs solely so Clerk can inject auth state into every request.
export default clerkMiddleware();

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
  ],
};
