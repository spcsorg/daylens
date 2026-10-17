import type { TicketSource } from "../_lib/exampleDay";

const PATHS: Record<TicketSource["kind"], React.ReactNode> = {
  page: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14C6.2 12.3 5.4 10.3 5.4 8S6.2 3.7 8 2Z" />
    </>
  ),
  file: (
    <>
      <path d="M4 1.5h5l3 3v10H4z" />
      <path d="M9 1.5v3h3M6 8h4M6 10.5h4" />
    </>
  ),
  chat: <path d="M2.5 3h11v7.5H7L4 13v-2.5H2.5z" />,
  excluded: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M3.8 3.8l8.4 8.4" />
    </>
  ),
};

export function SourceIcon({ kind }: { kind: TicketSource["kind"] }) {
  return (
    <svg
      className="source-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {PATHS[kind]}
    </svg>
  );
}
