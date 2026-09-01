interface Props {
  /** Progress percentage 0–100.  Ignored when `indeterminate` is true. */
  value?:         number
  message?:       string
  /** Show an animated indeterminate bar (e.g. while waiting for an API call). */
  indeterminate?: boolean
  className?:     string
}

export function ProgressBar({ value = 0, message, indeterminate = false, className = '' }: Props) {
  return (
    <div className={`w-full space-y-1 ${className}`}>
      {message && (
        <p className="text-sm text-gray-600 truncate">{message}</p>
      )}
      <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden relative">
        {indeterminate ? (
          // Sliding bar animation — no custom keyframes needed
          <div
            className="absolute inset-y-0 w-2/5 rounded-full bg-[#0D9488]"
            style={{
              animation: 'indeterminate-progress 1.4s ease-in-out infinite',
            }}
          />
        ) : (
          <div
            className="h-2 rounded-full bg-[#0D9488] transition-all duration-300"
            style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
          />
        )}
      </div>
      {!indeterminate && (
        <p className="text-xs text-gray-500 text-right">{value}%</p>
      )}

      {/* keyframes injected inline — no globals.css change needed */}
      <style>{`
        @keyframes indeterminate-progress {
          0%   { left: -40%; }
          60%  { left: 100%; }
          100% { left: 100%; }
        }
      `}</style>
    </div>
  )
}