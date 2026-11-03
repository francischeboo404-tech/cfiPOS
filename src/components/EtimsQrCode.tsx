import { useMemo } from "react";
import {
  BarcodeFormat,
  EncodeHintType,
  QRCodeWriter,
  WriterException,
} from "@zxing/library";

interface EtimsQrCodeProps {
  value: string;
  size?: number;
  label: string;
}

const MAX_QR_PAYLOAD_BYTES = 2900;

export function EtimsQrCode({
  value,
  size = 110,
  label,
}: EtimsQrCodeProps) {
  const encodedQr = useMemo(() => {
    if (new TextEncoder().encode(value).length > MAX_QR_PAYLOAD_BYTES) {
      return { error: "QR payload is too large to display." };
    }

    try {
      const matrix = new QRCodeWriter().encode(
        value,
        BarcodeFormat.QR_CODE,
        size,
        size,
        new Map([[EncodeHintType.CHARACTER_SET, "UTF-8"]]),
      );
      const width = matrix.getWidth();
      const height = matrix.getHeight();
      let path = "";

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (matrix.get(x, y)) path += `M${x},${y}h1v1h-1z`;
        }
      }

      return { path, width, height };
    } catch (error) {
      if (error instanceof WriterException) {
        return { error: "QR code could not be generated." };
      }
      throw error;
    }
  }, [size, value]);

  if ("error" in encodedQr) {
    return (
      <p role="status" className="text-xs text-destructive">
        {encodedQr.error}
      </p>
    );
  }

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${encodedQr.width} ${encodedQr.height}`}
      className="h-24 w-24 border bg-white p-1"
      shapeRendering="crispEdges"
    >
      <rect width="100%" height="100%" fill="white" />
      <path d={encodedQr.path} fill="black" />
    </svg>
  );
}
