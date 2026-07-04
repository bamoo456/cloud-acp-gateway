import { useEffect, useState } from "react";
const WORDS = ["Working", "Thinking", "Pondering", "Crunching", "Reasoning", "Cooking"];
export function Working() {
  const [t0] = useState(() => Date.now());
  const [, force] = useState(0);
  useEffect(() => { const id = setInterval(() => force((n) => n + 1), 1000); return () => clearInterval(id); }, []);
  const secs = Math.round((Date.now() - t0) / 1000);
  const word = WORDS[Math.floor(secs / 3) % WORDS.length];
  return (
    <div className="working">
      <span className="wspin" /><span className="wtxt">{word}</span>
      <span className="wdots"><i /><i /><i /></span>
      <span className="wsec">{secs ? " · " + secs + "s" : ""}</span>
    </div>
  );
}
