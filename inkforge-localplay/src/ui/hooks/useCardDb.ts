import { useEffect, useState } from "react";
import { loadCardDb, type CardIndex } from "@/data/cards";

/** Loads (and memoises) the bundled card DB. Returns null until ready. */
export function useCardDb(): CardIndex | null {
  const [index, setIndex] = useState<CardIndex | null>(null);
  useEffect(() => {
    let alive = true;
    void loadCardDb().then((idx) => {
      if (alive) setIndex(idx);
    });
    return () => {
      alive = false;
    };
  }, []);
  return index;
}
