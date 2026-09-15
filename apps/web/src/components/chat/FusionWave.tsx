import { useId } from "react";

// Two streams skirt the controls, then meet in the reserved space at the right.
// The dither is generated once and stays static.
const wavePaths = [0, 1, 2].map((tone) => {
  const upper: string[] = [];
  const lower: string[] = [];
  for (let column = 0; column < 100; column++) {
    const x = column * 4;
    const merge = Math.min(1, Math.max(0, (x - 330) / 45));
    const spread =
      (36 + 14 * Math.pow(Math.max(0, 1 - x / 100), 2)) * (1 - merge * merge * (3 - 2 * merge));
    for (let row = 0; row < 30; row++) {
      const y = row * 4;
      if (x < 330 && y > 33 && y < 87) continue;
      const distance = Math.abs(Math.abs(y - 60) - spread);
      const density = Math.max(0, 1 - distance / 10);
      const noise = ((column * 73 + row * 37 + column * row * 11) % 101) / 101;
      if (noise < density && (column + row * 2) % 3 === tone) {
        (y < 60 ? upper : lower).push(`M${x} ${y}h2v2h-2z`);
      }
    }
  }
  return { upper: upper.join(""), lower: lower.join(""), tone, opacity: [0.12, 0.24, 0.4][tone] };
});

export function FusionWave() {
  const gradientId = useId();
  const upperFill = `url(#${gradientId}-upper)`;
  const lowerFill = `url(#${gradientId}-lower)`;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 400 120"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 size-full"
    >
      <defs>
        <linearGradient
          id={`${gradientId}-upper`}
          gradientUnits="userSpaceOnUse"
          x1="330"
          y1="0"
          x2="375"
          y2="0"
        >
          <stop stopColor="#3969CA" />
          <stop offset="1" stopColor="#0294DE" />
        </linearGradient>
        <linearGradient
          id={`${gradientId}-lower`}
          gradientUnits="userSpaceOnUse"
          x1="330"
          y1="0"
          x2="375"
          y2="0"
        >
          <stop stopColor="#21C19A" />
          <stop offset="1" stopColor="#0294DE" />
        </linearGradient>
      </defs>
      {wavePaths.map((path) => (
        <g key={path.tone} opacity={path.opacity}>
          <path d={path.upper} fill={upperFill} />
          <path d={path.lower} fill={lowerFill} />
        </g>
      ))}
    </svg>
  );
}
