import { useState, useEffect, useRef } from "react";
import { searchCards, type CardSearchResult } from "../api";

interface Props {
  value: string;
  game: string;
  onChange: (cardName: string, setName?: string) => void;
  placeholder?: string;
}

export function CardAutocomplete({ value, game, onChange, placeholder }: Props) {
  const [results, setResults] = useState<CardSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      if (value.length < 2) { setResults([]); return; }
      const res = await searchCards(value, game).catch(() => []);
      setResults(res);
      setOpen(res.length > 0);
    }, 300);
  }, [value, game]);

  return (
    <div style={{ position: "relative" }}>
      <input
        type="text"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder ?? "Card name…"}
        style={{ width: "100%", padding: "6px 8px", boxSizing: "border-box" }}
      />
      {open && results.length > 0 && (
        <ul style={{
          position: "absolute", top: "100%", left: 0, right: 0,
          background: "#fff", border: "1px solid #ccc", margin: 0,
          padding: 0, listStyle: "none", zIndex: 100, maxHeight: 200, overflowY: "auto",
        }}>
          {results.map((r) => (
            <li
              key={`${r.cardName}||${r.setName}`}
              onMouseDown={() => { onChange(r.cardName, r.setName); setOpen(false); }}
              style={{ padding: "6px 8px", cursor: "pointer" }}
            >
              <strong>{r.cardName}</strong> <small style={{ color: "#666" }}>{r.setName}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
