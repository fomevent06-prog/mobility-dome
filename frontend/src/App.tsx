import "./App.css";
import { useMemo, useState } from "react";
import type { FormEvent } from "react";

type Snippet = {
  id: string;
  source: string;
  country?: string;
  score: number;
  text: string;
};

type RagResponse = {
  answer: string;
  snippets: Snippet[];
  country?: string;
  mode: "llm";
  documentsIndexed: number;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  metadata?: string;
  snippets?: Snippet[];
};

const SUGGESTED_QUESTIONS = [
  "What are the top mobility pain points globally?",
  "What should assignees know before relocating to Germany?",
  "Summarize key immigration and tax risks in India."
];

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

function App() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "Ask about mobility survey insights or EY country guidance.",
      metadata: "Connected to survey + EY guide RAG"
    }
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSend = useMemo(() => input.trim().length > 0 && !isLoading, [input, isLoading]);

  async function sendQuestion(question: string): Promise<void> {
    const clean = question.trim();
    if (!clean || isLoading) return;
    setError(null);
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text: clean }]);
    setInput("");
    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/rag/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: clean })
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `Request failed (${response.status})`);
      }
      const payload = (await response.json()) as RagResponse;
      const metadata = `${payload.mode.toUpperCase()} · ${payload.documentsIndexed} docs indexed${payload.country ? ` · ${payload.country}` : ""}`;
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          text: payload.answer,
          metadata,
          snippets: payload.snippets
        }
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch answer.";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void sendQuestion(input);
  }

  return (
    <div className="app">
      <div className="card headerCard">
        <h1>Mobility Demo</h1>
        <p className="subtitle">RAG chat over survey + EY guide data.</p>
      </div>

      <div className="card">
        <p className="sectionTitle">Suggested questions</p>
        <div className="suggestions">
          {SUGGESTED_QUESTIONS.map((question) => (
            <button key={question} type="button" className="chip" onClick={() => void sendQuestion(question)} disabled={isLoading}>
              {question}
            </button>
          ))}
        </div>
      </div>

      <div className="card chatCard">
        <div className="messages">
          {messages.map((message) => (
            <div key={message.id} className={`message ${message.role}`}>
              <p className="messageRole">{message.role === "user" ? "You" : "Assistant"}</p>
              <p className="messageText">{message.text}</p>
              {message.metadata ? <p className="messageMeta">{message.metadata}</p> : null}
              {message.snippets?.length ? (
                <details className="sources">
                  <summary>Sources ({message.snippets.length})</summary>
                  <ul>
                    {message.snippets.slice(0, 4).map((snippet) => (
                      <li key={snippet.id}>
                        <strong>{snippet.source}</strong>
                        {snippet.country ? ` · ${snippet.country}` : ""} · score {snippet.score.toFixed(3)}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ))}
          {isLoading ? <p className="loading">Thinking…</p> : null}
        </div>

        <form className="composer" onSubmit={onSubmit}>
          <input
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask a mobility question..."
            aria-label="Ask a mobility question"
          />
          <button type="submit" disabled={!canSend}>
            Send
          </button>
        </form>
        {error ? <p className="error">{error}</p> : null}
      </div>
    </div>
  );
}

export default App;
