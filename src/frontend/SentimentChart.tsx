'use client';

import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from 'recharts';

interface DataPoint { quarter: string; sentiment: string; score: number }
interface Props { ticker: string; data: DataPoint[]; title?: string }

// FinBERT gives confidence 0–1 + a label. Convert to signed score so the chart has drama.
// positive → +confidence, negative → −confidence, neutral → 0
function toSigned(d: DataPoint): number {
  if (d.sentiment === 'positive') return +d.score;
  if (d.sentiment === 'negative') return -d.score;
  return 0;
}

function signedColor(v: number): string {
  if (v > 0.1)  return '#34d399';
  if (v < -0.1) return '#f87171';
  return '#94a3b8';
}

function CustomDot(props: { cx?: number; cy?: number; payload?: { signedScore: number } }) {
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined || !payload) return null;
  const color = signedColor(payload.signedScore);
  return (
    <g>
      <circle cx={cx} cy={cy} r={6}  fill={color} stroke="rgba(0,0,0,0.4)" strokeWidth={1.5} />
      <circle cx={cx} cy={cy} r={11} fill={color} fillOpacity={0.12} stroke="none" />
    </g>
  );
}

function CustomTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const v = payload[0].value;
  return (
    <div style={{
      background: 'rgba(6,8,20,0.97)', border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: 12, padding: '10px 14px',
    }}>
      <p style={{ color: '#f59e0b', fontWeight: 600, fontSize: 11, margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</p>
      <p style={{ color: signedColor(v), fontWeight: 700, fontSize: 22, margin: '0 0 2px', lineHeight: 1 }}>
        {v >= 0 ? '+' : ''}{v.toFixed(3)}
      </p>
      <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, margin: 0 }}>
        {v > 0.1 ? 'Positive' : v < -0.1 ? 'Negative' : 'Neutral'}
      </p>
    </div>
  );
}

export default function SentimentChart({ ticker, data, title }: Props) {
  if (data.length === 0) return null;

  const chartData = data.map(d => ({ ...d, signedScore: parseFloat(toSigned(d).toFixed(4)) }));
  const vals      = chartData.map(d => d.signedScore);
  const domainMin = Math.min(Math.min(...vals) - 0.08, -0.25);
  const domainMax = Math.max(Math.max(...vals) + 0.08,  0.25);
  const range     = domainMax - domainMin;

  // Gradient zero-crossing as a percentage from the top
  const zeroPct   = Math.round((domainMax / range) * 100);
  const gradId    = `grad-${ticker.replace(/\W/g, '')}`;

  const latest    = chartData[chartData.length - 1];
  const latColor  = signedColor(latest?.signedScore ?? 0);
  const chartTitle = title ?? `${ticker} — Sentiment Drift`;

  return (
    <div className="glass rounded-2xl p-5 space-y-1">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">{chartTitle}</p>
          <p className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.28)' }}>
            +1 = strongly positive · −1 = strongly negative
          </p>
        </div>
        {latest && (
          <div className="text-right ml-4 shrink-0">
            <span className="text-2xl font-bold" style={{ color: latColor }}>
              {latest.signedScore >= 0 ? '+' : ''}{latest.signedScore.toFixed(2)}
            </span>
            <p className="text-[10px] uppercase tracking-wider mt-0.5" style={{ color: 'rgba(255,255,255,0.3)' }}>latest</p>
          </div>
        )}
      </div>

      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={chartData} margin={{ top: 10, right: 6, left: -18, bottom: 4 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"             stopColor="#34d399" stopOpacity={0.5} />
              <stop offset={`${zeroPct}%`}  stopColor="#34d399" stopOpacity={0.03} />
              <stop offset={`${zeroPct}%`}  stopColor="#f87171" stopOpacity={0.03} />
              <stop offset="100%"           stopColor="#f87171" stopOpacity={0.5} />
            </linearGradient>
          </defs>

          <CartesianGrid strokeDasharray="2 4" stroke="rgba(255,255,255,0.04)" vertical={false} />
          <XAxis
            dataKey="quarter"
            tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 10 }}
            axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
            tickLine={false}
          />
          <YAxis
            domain={[domainMin, domainMax]}
            tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={v => (v >= 0 ? '+' : '') + v.toFixed(1)}
            width={38}
          />
          <Tooltip
            content={<CustomTooltip />}
            cursor={{ stroke: 'rgba(255,255,255,0.08)', strokeWidth: 1 }}
          />

          <ReferenceLine y={0}     stroke="rgba(255,255,255,0.18)" strokeWidth={1.5} />
          <ReferenceLine y={0.6}   stroke="#34d399" strokeDasharray="3 5" strokeOpacity={0.2} />
          <ReferenceLine y={-0.6}  stroke="#f87171" strokeDasharray="3 5" strokeOpacity={0.2} />

          <Area
            type="monotone"
            dataKey="signedScore"
            stroke="#f59e0b"
            strokeWidth={2.5}
            fill={`url(#${gradId})`}
            dot={<CustomDot />}
            activeDot={false}
            animationDuration={900}
          />
        </AreaChart>
      </ResponsiveContainer>

      <div className="flex items-center gap-4 pt-1">
        {[
          { label: 'Positive', color: '#34d399' },
          { label: 'Negative', color: '#f87171' },
          { label: 'Neutral',  color: '#94a3b8' },
        ].map(({ label, color }) => (
          <span key={label} className="flex items-center gap-1.5 text-xs" style={{ color: 'rgba(255,255,255,0.38)' }}>
            <span className="w-2 h-2 rounded-full" style={{ background: color }} />
            {label}
          </span>
        ))}
        <span className="ml-auto text-xs" style={{ color: 'rgba(255,255,255,0.2)' }}>
          {data.length} quarter{data.length !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
}
