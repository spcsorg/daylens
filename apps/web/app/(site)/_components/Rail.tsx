"use client";

import { useRef, useState } from "react";
import { EXAMPLE_DAY, EXAMPLE_SEARCHES, searchDay, type TicketSource } from "../_lib/exampleDay";
import { SourceIcon } from "./SourceIcon";

type Result = ReturnType<typeof searchDay>;

export function Rail() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<Result | undefined>(undefined);
  const railRef = useRef<HTMLOListElement>(null);

  function run(nextQuery: string) {
    setQuery(nextQuery);
    const found = searchDay(nextQuery);
    setResult(found);
    if (!found || !railRef.current) return;
    const rail = railRef.current;
    const ticket = rail.querySelector<HTMLElement>(`[data-ticket="${found.ticket.number}"]`);
    if (ticket && rail.scrollWidth > rail.clientWidth) {
      rail.scrollTo({
        left: ticket.offsetLeft - (rail.clientWidth - ticket.offsetWidth) / 2,
        behavior: "smooth",
      });
    }
  }

  const matched = result?.ticket.number;

  return (
    <div className="rail-block">
      <form
        className="rail-search"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          run(query);
        }}
      >
        <label htmlFor="rail-query" className="rail-search-label">
          Search this example day the way you&rsquo;d remember it
        </label>
        <div className="rail-search-row">
          <input
            id="rail-query"
            type="search"
            value={query}
            placeholder="that bread pricing video i watched"
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              if (event.target.value === "") setResult(undefined);
            }}
          />
          <button type="submit" className="button button-quiet">
            Search
          </button>
        </div>
        <ul className="rail-examples" aria-label="Example searches">
          {EXAMPLE_SEARCHES.map((example) => (
            <li key={example}>
              <button type="button" onClick={() => run(example)} aria-pressed={query === example}>
                {example}
              </button>
            </li>
          ))}
        </ul>
      </form>

      <p className="rail-result" aria-live="polite">
        {result === undefined ? null : result === null ? (
          <>Nothing on this example day matches that. In Daylens, search covers every day you&rsquo;ve kept.</>
        ) : (
          <>
            Found in <strong>{result.ticket.time}</strong>
            {result.source ? (
              <>
                : <strong>{result.source.label}</strong>. In Daylens, it opens right there.
              </>
            ) : (
              "."
            )}
          </>
        )}
      </p>

      <div className="rail" data-searching={matched ? "true" : undefined}>
        <ol className="rail-tickets" ref={railRef} aria-label="An example morning, one ticket per hour">
          {EXAMPLE_DAY.map((ticket) => (
            <li
              key={ticket.number}
              className="ticket"
              data-ticket={ticket.number}
              data-live={ticket.live ? "true" : undefined}
              data-state={matched === undefined ? undefined : matched === ticket.number ? "match" : "dim"}
            >
              <span className="ticket-clip" aria-hidden="true" />
              <div className="ticket-head">
                <span className="ticket-number">No. {ticket.number}</span>
                <span className="ticket-time">{ticket.time}</span>
              </div>
              <h3 className="ticket-title">{ticket.live ? <span className="ticket-now">Now</span> : ticket.title}</h3>
              <p className="ticket-summary">{ticket.summary}</p>
              {ticket.leftOff ? (
                <p className="ticket-leftoff">
                  <span>Left off</span>
                  {ticket.leftOff}
                </p>
              ) : null}
              {ticket.sources.length > 0 ? (
                <ul className="ticket-sources">
                  {ticket.sources.map((source: TicketSource) => (
                    <li
                      key={source.label}
                      data-kind={source.kind}
                      data-hit={result?.source?.label === source.label && matched === ticket.number ? "true" : undefined}
                    >
                      <SourceIcon kind={source.kind} />
                      {source.label}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
