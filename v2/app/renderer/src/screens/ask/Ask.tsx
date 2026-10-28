import { useState } from 'react'
import { Button } from '../../ui/controls.tsx'
import './ask.css'

const TRY = ['the pricing page i saw last week', 'the file about the autumn menu', 'where did i leave the order form', 'what did i finish yesterday']

const LATER = 'Ask comes in a later update. It will answer from the same record you see in Today.'

export function Ask() {
  const [text, setText] = useState('')
  const [asked, setAsked] = useState(false)
  return (
    <div className="ask">
      <div className="header">
        <h1 className="title">Ask</h1>
      </div>
      <div className="scroll">
        {asked ? (
          <p className="ask-later">{LATER}</p>
        ) : (
          <>
            <h2 className="section-label">Try</h2>
            <div className="ask-try">
              {TRY.map((t) => (
                <button type="button" key={t} className="ask-suggestion" onClick={() => (setText(t), setAsked(true))}>
                  {t}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          if (text.trim()) setAsked(true)
        }}
      >
        <input className="field grow" placeholder="Ask about any day" value={text} onChange={(e) => setText(e.target.value)} />
        <Button kind="primary" type="submit" size="regular" disabled={!text.trim()}>
          Ask
        </Button>
      </form>
    </div>
  )
}
