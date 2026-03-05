interface MetricPoint {
  timestamp: number
  value: number
}

export function Sparkline({
  data,
  color = '#3b82f6',
  width = 200,
  height = 40,
}: {
  data: MetricPoint[]
  color?: string
  width?: number
  height?: number
}) {
  if (data.length < 2) return <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>No data</span>

  const values = data.map((d) => d.value)
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const range = max - min || 1

  const points = data
    .map((d, i) => {
      const x = (i / (data.length - 1)) * width
      const y = height - ((d.value - min) / range) * height
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
    </svg>
  )
}
