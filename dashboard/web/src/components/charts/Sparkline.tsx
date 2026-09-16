'use client';
export function Sparkline({ values, width = 120, height = 28, stroke = '#6ea8fe' }: { values: number[]; width?: number; height?: number; stroke?: string }) {
  if (values.length < 2) return <svg width={width} height={height} />;
  const max = Math.max(...values, 1e-9);
  const min = Math.min(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - ((v - min) / (max - min || 1)) * (height - 2) - 1}`).join(' ');
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
