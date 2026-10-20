type P = { className?: string };

export function SunIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 1a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V2a1 1 0 0 1 1-1ZM4.222 4.222a1 1 0 0 1 1.414 0L7.05 5.636A1 1 0 0 1 5.636 7.05L4.222 5.636a1 1 0 0 1 0-1.414Zm15.556 0a1 1 0 0 1 0 1.414L18.364 7.05a1 1 0 1 1-1.414-1.414l1.414-1.414a1 1 0 0 1 1.414 0ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm-5 3a5 5 0 1 1 10 0 5 5 0 0 1-10 0Zm-6 0a1 1 0 0 1 1-1h2a1 1 0 1 1 0 2H2a1 1 0 0 1-1-1Zm18 0a1 1 0 0 1 1-1h2a1 1 0 1 1 0 2h-2a1 1 0 0 1-1-1ZM7.05 16.95a1 1 0 0 1 0 1.414l-1.414 1.414a1 1 0 1 1-1.414-1.414l1.414-1.414a1 1 0 0 1 1.414 0Zm9.9 0a1 1 0 0 1 1.414 0l1.414 1.414a1 1 0 0 1-1.414 1.414l-1.414-1.414a1 1 0 0 1 0-1.414ZM12 19a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1Z"
      />
    </svg>
  );
}

export function MoonIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12.784 2.47a1 1 0 0 1 .047.975A9.96 9.96 0 0 0 12 7a8 8 0 0 0 8 8h.058a1 1 0 0 1 .902 1.445A10 10 0 0 1 12 22C6.477 22 2 17.523 2 12c0-5.499 4.438-9.961 9.928-10a1 1 0 0 1 .856.47ZM10.41 4.158A8.002 8.002 0 0 0 12 20a7.99 7.99 0 0 0 6.352-3.135C13.613 16.079 10 11.961 10 7c0-.986.143-1.94.41-2.842Z" />
    </svg>
  );
}

export function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 8a1 1 0 0 1 1-1h16a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1Zm0 8a1 1 0 0 1 1-1h10a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1Z" />
    </svg>
  );
}

export function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M13 12a1 1 0 1 0-2 0v4a1 1 0 1 0 2 0v-4Zm-1-2.5A1.25 1.25 0 1 0 12 7a1.25 1.25 0 0 0 0 2.5Z" />
      <path fillRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2ZM4 12a8 8 0 1 1 16 0 8 8 0 0 1-16 0Z" clipRule="evenodd" />
    </svg>
  );
}

export function ChevronDownIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path fillRule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clipRule="evenodd" />
    </svg>
  );
}

export function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.293 5.707a4.657 4.657 0 0 0-6.586 0l-1 1a1 1 0 0 1-1.414-1.414l1-1a6.657 6.657 0 0 1 9.414 9.414l-1 1a1 1 0 0 1-1.414-1.414l1-1a4.657 4.657 0 0 0 0-6.586Zm-2.586 2.586a1 1 0 0 1 0 1.414l-6 6a1 1 0 0 1-1.414-1.414l6-6a1 1 0 0 1 1.414 0Zm-9 1a1 1 0 0 1 0 1.414l-1 1a4.657 4.657 0 0 0 6.586 6.586l1-1a1 1 0 0 1 1.414 1.414l-1 1a6.657 6.657 0 0 1-9.414-9.414l1-1a1 1 0 0 1 1.414 0Z" />
    </svg>
  );
}
