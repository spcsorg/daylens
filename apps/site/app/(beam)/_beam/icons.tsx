type P = { className?: string };

export function ArrowRight({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 8h11.2M8.9 3.4 13.5 8l-4.6 4.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Check({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M1.6 7.6 5 11.6 12.4 1.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function XMark({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2.5 2.5l9 9M11.5 2.5l-9 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function Chevron({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 40 48" aria-hidden="true">
      <path
        d="M33.4688 23.7344C33.4688 23.0508 33.1953 22.4219 32.6758 21.9297L11.0195 0.710938C10.5273 0.246094 9.92578 0 9.21484 0C7.82031 0 6.72656 1.06641 6.72656 2.48828C6.72656 3.17188 7 3.80078 7.4375 4.26562L27.3438 23.7344L7.4375 43.2031C7 43.668 6.72656 44.2695 6.72656 44.9805C6.72656 46.4023 7.82031 47.4688 9.21484 47.4688C9.92578 47.4688 10.5273 47.2227 11.0195 46.7305L32.6758 25.5391C33.1953 25.0195 33.4688 24.418 33.4688 23.7344Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function Sun({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="2.6" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M7 .9v1.5M7 11.6v1.5M.9 7h1.5M11.6 7h1.5M2.7 2.7l1 1M10.3 10.3l1 1M2.7 11.3l1-1M10.3 3.7l1-1"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Moon({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 14 14" aria-hidden="true">
      <path d="M11.9 9.3A5.6 5.6 0 0 1 4.7 2.1 5.6 5.6 0 1 0 11.9 9.3Z" fill="currentColor" />
    </svg>
  );
}

export function Menu({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3.75 9h16.5M3.75 15h16.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Close({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 18 18 6M6 6l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Search({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="6.8" cy="6.8" r="5" stroke="currentColor" strokeWidth="1.4" />
      <path d="m10.6 10.6 3.9 3.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function OpenArrow({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 9 9 3M4.2 3H9v4.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
