import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getImage, placeholder } from "@/data/images";
import type { ImageSize } from "@/data/images-core";
import type { PrintedCard } from "@/data/card-types";
import { cn } from "@/lib/cn";

/** Resolve a card image to a data/URL, falling back to the offline placeholder. */
function useCardImage(card: PrintedCard, size: ImageSize): string {
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
  return src;
}

/** Full-screen overlay showing a large card + its rules text, for long-press reading. */
export function CardZoom({ card, onClose }: { card: PrintedCard; onClose: () => void }) {
  const src = useCardImage(card, "full");
  const fallback = placeholder({ id: card.id, name: card.fullName, cost: card.cost, colors: card.colors });
  return createPortal(
    <div
      onPointerDown={onClose}
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-black/80 p-4"
    >
      <img
        src={src}
        alt={card.fullName}
        onError={(e) => ((e.currentTarget as HTMLImageElement).src = fallback)}
        className="max-h-[70vh] w-auto rounded-2xl object-contain shadow-2xl"
      />
      {card.rulesText && (
        <div className="max-h-[20vh] max-w-md overflow-y-auto rounded-lg bg-slate-900/90 p-3 text-center text-xs leading-relaxed text-slate-100">
          {card.rulesText}
        </div>
      )}
      <p className="text-[10px] text-slate-400">Tap anywhere to close</p>
    </div>,
    document.body,
  );
}

/** Card image with offline placeholder fallback (spec §5.2). Never broken. */
export function CardThumb({
  card,
  size = "thumbnail",
  className,
  zoomable = true,
}: {
  card: PrintedCard;
  size?: ImageSize;
  className?: string;
  /** Long-press (hold) to enlarge the card so it can be read. */
  zoomable?: boolean;
}) {
  const fallback = placeholder({ id: card.id, name: card.fullName, cost: card.cost, colors: card.colors });
  const src = useCardImage(card, size);
  const [zoom, setZoom] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);

  const cancel = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const start = () => {
    if (!zoomable) return;
    suppressClick.current = false;
    cancel();
    timer.current = setTimeout(() => {
      suppressClick.current = true;
      setZoom(true);
    }, 450);
  };

  return (
    <>
      <img
        src={src}
        alt={card.fullName}
        loading="lazy"
        onError={(e) => ((e.currentTarget as HTMLImageElement).src = fallback)}
        onPointerDown={start}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(e) => e.preventDefault()}
        // Swallow the click that follows a long-press so the wrapping button
        // (ink/play/select/target) doesn't also fire.
        onClickCapture={(e) => {
          if (suppressClick.current) {
            e.preventDefault();
            e.stopPropagation();
            suppressClick.current = false;
          }
        }}
        className={cn("aspect-[5/7] w-full select-none rounded-lg object-cover", className)}
        draggable={false}
      />
      {zoom && <CardZoom card={card} onClose={() => setZoom(false)} />}
    </>
  );
}
