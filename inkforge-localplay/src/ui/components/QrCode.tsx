import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** Renders a value as a QR image, with a graceful note if it's too dense. */
export function QrCode({ value, size = 240 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, { errorCorrectionLevel: "L", width: size, margin: 1 })
      .then((url) => { if (alive) { setDataUrl(url); setError(false); } })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [value, size]);

  if (error) {
    return <p className="text-xs text-amber-200">Code too large for one QR — use Copy/Paste below.</p>;
  }
  if (!dataUrl) return <div style={{ width: size, height: size }} className="animate-pulse rounded bg-white/10" />;
  return <img src={dataUrl} width={size} height={size} alt="pairing QR" className="rounded bg-white p-1" />;
}
