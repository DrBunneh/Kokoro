import { useEffect, useState } from "react";
import { getImage, placeholder } from "@/data/images";
import type { ImageSize } from "@/data/images-core";
import type { PrintedCard } from "@/data/card-types";
import { cn } from "@/lib/cn";

/** Card image with offline placeholder fallback (spec §5.2). Never broken. */
export function CardThumb({
  card,
  size = "thumbnail",
  className,
}: {
  card: PrintedCard;
  size?: ImageSize;
  className?: string;
}) {
  const meta = { id: card.id, name: card.fullName, cost: card.cost, colors: card.colors };
  const fallback = placeholder(meta);
  const [src, setSrc] = useState(fallback);

  useEffect(() => {
    let alive = true;
    void getImage(card.id, size, { name: card.fullName, cost: card.cost, colors: card.colors }).then(
      (resolved) => {
        if (alive) setSrc(resolved);
      },
    );
    return () => {
      alive = false;
    };
  }, [card.id, size, card.fullName, card.cost, card.colors]);

  return (
    <img
      src={src}
      alt={card.fullName}
      loading="lazy"
      onError={() => setSrc(fallback)}
      className={cn("aspect-[5/7] w-full rounded-lg object-cover", className)}
    />
  );
}
